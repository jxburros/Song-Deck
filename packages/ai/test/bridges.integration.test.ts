/**
 * End-to-end integration of the REAL bridge adapters with the reference mock bridge
 * (`bridges/mock_bridge.py`, Python stdlib only) over HTTP on 127.0.0.1.
 *
 * The suite spawns `python3 bridges/mock_bridge.py --role all --base-port <free port>` (one
 * process, six bridges on base+0 … base+5 in Song Deck preset order), waits for its ready line,
 * then drives `createProvider(configFromPreset(<local preset>, { baseUrl }), { transport: new
 * DirectTransport() })` for every contract: music (info, generate, transform, inpaint, extend,
 * cancel), singing (voices, synthesize, regenerate phrase), transcription, separation, voice
 * conversion (consent rules) and mastering, plus bearer auth and abort → job cancellation.
 *
 * Skipped cleanly when python3 (3.9+) is not installed. Set SONGDECK_PYTHON to use another
 * interpreter.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildMusicGenerationRequest,
  buildSingingRequest,
  configFromPreset,
  ConsentRequiredError,
  createProvider,
  type CreateProviderDeps,
  DirectTransport,
  type EncodedAudio,
  type MasteringRequest,
  MemoryCredentialStore,
  type MusicGenerationRequest,
  ProviderError,
  type ProviderInstance,
  type SingingRequest,
} from '../src';
import { makeSong } from './helpers';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MOCK_BRIDGE = resolve(REPO_ROOT, 'bridges/mock_bridge.py');
const PYTHON = process.env.SONGDECK_PYTHON || 'python3';
const HAS_PYTHON = (() => {
  try {
    const r = spawnSync(PYTHON, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
})();

/** Role offsets of `--role all` (they mirror the preset ports 8810…8815). */
const ROLE = {
  music: 0,
  singing: 1,
  separation: 2,
  transcription: 3,
  voiceConversion: 4,
  mastering: 5,
  lyrics: 6,
  instruments: 7,
} as const;

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface RunningBridge {
  urls: string[];
  stderr(): string;
  stop(): Promise<void>;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const srv = createServer();
    srv.once('error', () => done(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => done(true)));
  });
}

/** A random base port with `count` consecutive free ports. */
async function freePortBase(count: number): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = 20_000 + Math.floor(Math.random() * 40_000);
    let ok = true;
    for (let i = 0; i < count && ok; i++) ok = await portFree(base + i);
    if (ok) return base;
  }
  throw new Error('no free port range found');
}

async function startBridge(args: string[], env: Record<string, string> = {}): Promise<RunningBridge> {
  const proc: ChildProcess = spawn(PYTHON, [MOCK_BRIDGE, ...args, '--log-level', 'warning'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout!.setEncoding('utf8');
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (d: string) => {
    err += d;
  });
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((done) => proc.once('exit', () => done()));
    proc.kill('SIGTERM');
    const killer = setTimeout(() => proc.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(killer);
  };
  const PREFIX = 'songdeck-bridge ready ';
  try {
    const ready = await new Promise<{ bridges: { url: string; role: string }[] }>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`mock bridge not ready after 20 s\n${err}`)), 20_000);
      proc.stdout!.on('data', (d: string) => {
        out += d;
        const line = out.split('\n').find((l) => l.startsWith(PREFIX));
        if (line) {
          clearTimeout(timer);
          done(JSON.parse(line.slice(PREFIX.length)) as { bridges: { url: string; role: string }[] });
        }
      });
      proc.once('error', (e) => {
        clearTimeout(timer);
        fail(e);
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`mock bridge exited with code ${code}\n${err}`));
      });
    });
    const urls = ready.bridges.map((b) => b.url);
    for (const u of urls) {
      const res = await fetch(`${u}/health`);
      if (!res.ok) throw new Error(`${u}/health answered ${res.status}`);
    }
    return { urls, stderr: () => err, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

interface Health {
  status: string;
  jobs: {
    running: number;
    queued: number;
    completed: number;
    cancelled: number;
    failed: number;
    rejected: number;
  };
}

async function health(baseUrl: string): Promise<Health> {
  return (await (await fetch(`${baseUrl}/health`)).json()) as Health;
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// WAV helpers (independent of the bridge's Python codec)
// ---------------------------------------------------------------------------

interface ParsedWav {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  frames: number;
  duration: number;
  samples: Float64Array[];
}

/** Strict RIFF/WAVE parse: header sizes must be consistent; PCM 16/24/32 and float 32 are decoded. */
function parseWav(bytes: Uint8Array): ParsedWav {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  if (dv.getUint32(4, true) !== bytes.length - 8)
    throw new Error(`RIFF size ${dv.getUint32(4, true)} != ${bytes.length - 8}`);
  let o = 12;
  let fmt:
    { format: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | undefined;
  let dataOff = -1;
  let dataLen = 0;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        blockAlign: dv.getUint16(body + 12, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (body + size > bytes.length) throw new Error('data chunk is truncated');
      dataOff = body;
      dataLen = size;
      break;
    }
    o = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('missing fmt or data chunk');
  if (fmt.blockAlign !== fmt.channels * (fmt.bits / 8)) throw new Error('inconsistent block align');
  const frames = Math.floor(dataLen / fmt.blockAlign);
  const samples = Array.from({ length: fmt.channels }, () => new Float64Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const p = dataOff + i * fmt.blockAlign + c * (fmt.bits / 8);
      let v: number;
      if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(p, true);
      else if (fmt.format === 1 && fmt.bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (fmt.format === 1 && fmt.bits === 24)
        v = (((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8) >> 8) / 8388608;
      else if (fmt.format === 1 && fmt.bits === 32) v = dv.getInt32(p, true) / 2147483648;
      else throw new Error(`unsupported WAV encoding ${fmt.format}/${fmt.bits}`);
      samples[c][i] = v;
    }
  }
  return {
    format: fmt.format,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bits,
    frames,
    duration: frames / fmt.sampleRate,
    samples,
  };
}

/** 16-bit PCM WAV from float channels. */
function encodeWav(channels: Float64Array[], sampleRate: number): Uint8Array {
  const nch = channels.length;
  const frames = channels[0].length;
  const out = new Uint8Array(44 + frames * nch * 2);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  put(0, 'RIFF');
  dv.setUint32(4, out.length - 8, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nch * 2, true);
  dv.setUint16(32, nch * 2, true);
  dv.setUint16(34, 16, true);
  put(36, 'data');
  dv.setUint32(40, frames * nch * 2, true);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++)
      dv.setInt16(
        44 + (i * nch + c) * 2,
        Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767))),
        true,
      );
  }
  return out;
}

const wavAudio = (data: Uint8Array): EncodedAudio => ({ mimeType: 'audio/wav', data });

/** Sine tones (+ a weak 2nd harmonic) at MIDI pitches with short fades. */
function tones(
  notes: { midi: number; start: number; dur: number }[],
  sampleRate: number,
  totalSeconds: number,
  amp = 0.5,
): Float64Array {
  const out = new Float64Array(Math.round(totalSeconds * sampleRate));
  for (const n of notes) {
    const f = 440 * 2 ** ((n.midi - 69) / 12);
    const a = Math.round(n.start * sampleRate);
    const len = Math.round(n.dur * sampleRate);
    const fade = Math.round(0.01 * sampleRate);
    for (let i = 0; i < len && a + i < out.length; i++) {
      const env = Math.min(1, i / fade, (len - i) / fade);
      const t = i / sampleRate;
      out[a + i] += amp * env * (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t));
    }
  }
  return out;
}

function rms(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return x.length ? Math.sqrt(s / x.length) : 0;
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`length mismatch ${a.length} vs ${b.length}`);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function peakOf(chans: Float64Array[]): number {
  let m = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) m = Math.max(m, Math.abs(ch[i]));
  return m;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_PYTHON)('reference bridges: mock bridge end-to-end through the real adapters', () => {
  let bridge: RunningBridge | undefined;
  let base = 0;
  const url = (offset: number) => `http://127.0.0.1:${base + offset}`;
  const deps: CreateProviderDeps = {
    transport: new DirectTransport(),
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  };
  /** A provider from a LOCAL preset with only the base URL changed. */
  const provider = (presetId: string, offset: number): ProviderInstance =>
    createProvider(configFromPreset(presetId, { baseUrl: url(offset) }), deps);

  beforeAll(async () => {
    base = await freePortBase(8);
    bridge = await startBridge(['--role', 'all', '--base-port', String(base)]);
    expect(bridge.urls).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(url));
  }, 40_000);

  afterAll(async () => {
    await bridge?.stop();
  });

  describe('music bridge (ace-step-local preset)', () => {
    it('GET /info: models and the contract capabilities (discoverModels / getCapabilities)', async () => {
      const ag = provider('ace-step-local', ROLE.music).audioGeneration!;
      const models = await ag.discoverModels();
      expect(models.map((m) => m.id)).toEqual(['mock-additive', 'mock-additive-lofi']);
      expect(await ag.getCapabilities()).toEqual(
        expect.arrayContaining([
          'TEXT_TO_MUSIC',
          'AUDIO_TO_AUDIO',
          'LYRIC_CONDITIONING',
          'INPAINTING',
          'OUTPAINTING',
        ]),
      );
    });

    it('generate: valid WAV of the requested duration, X-Seed/X-Model, deterministic per seed', async () => {
      const ag = provider('ace-step-local', ROLE.music).audioGeneration!;
      const req: MusicGenerationRequest = {
        prompt: 'warm synth pop',
        durationSeconds: 4,
        seed: 42,
        bpm: 96,
        key: 'E minor',
        instrumental: false,
        sections: [
          { name: 'Intro', kind: 'intro', startSeconds: 0, endSeconds: 1.5 },
          {
            name: 'Chorus 1',
            kind: 'chorus',
            startSeconds: 1.5,
            endSeconds: 4,
            lines: ['Fire in the sky', 'Carry me home'],
          },
        ],
      };
      const res = await ag.generateMusic(req);
      expect(res.audio.mimeType).toBe('audio/wav');
      const wav = parseWav(res.audio.data);
      expect(wav).toMatchObject({ format: 1, channels: 2, sampleRate: 44100, bitsPerSample: 16 });
      expect(wav.duration).toBeCloseTo(4, 3);
      expect(rms(wav.samples[0])).toBeGreaterThan(0.01);
      expect(res.seed).toBe(42);
      expect(res.model).toBe('mock-additive');
      expect(res.durationSeconds).toBe(4);
      expect(res.costUsd).toBe(0);

      expect(sameBytes((await ag.generateMusic(req)).audio.data, res.audio.data)).toBe(true);
      expect(sameBytes((await ag.generateMusic({ ...req, seed: 43 })).audio.data, res.audio.data)).toBe(
        false,
      );
      const lofi = await ag.generateMusic({ ...req, model: 'mock-additive-lofi' });
      expect(lofi.model).toBe('mock-additive-lofi');
      const unseeded = await ag.generateMusic({ prompt: 'ambient pad', durationSeconds: 1 });
      expect(Number.isInteger(unseeded.seed)).toBe(true); // the bridge picked a seed and reported it in X-Seed
    });

    it('generates from a request built from a Song (buildMusicGenerationRequest)', async () => {
      const req = buildMusicGenerationRequest(makeSong(), { seed: 7, sectionIds: ['sec_intro'] });
      expect(req.durationSeconds).toBe(8);
      const res = await provider('ace-step-local', ROLE.music).audioGeneration!.generateMusic(req);
      expect(parseWav(res.audio.data).duration).toBeCloseTo(8, 3);
      expect(res.seed).toBe(7);
    });

    it('transform keeps the length; inpaint changes only the requested range; extend appends', async () => {
      const ag = provider('ace-step-local', ROLE.music).audioGeneration!;
      const src = await ag.generateMusic({ prompt: 'test source', durationSeconds: 3, seed: 1 });
      const input = parseWav(src.audio.data);
      const sr = input.sampleRate;

      const tr = await ag.transformAudio({ audio: src.audio, prompt: 'brighter', strength: 0.3, seed: 2 });
      const t = parseWav(tr.audio.data);
      expect([t.frames, t.channels, t.sampleRate]).toEqual([input.frames, input.channels, sr]);
      expect(maxAbsDiff(t.samples[0], input.samples[0])).toBeGreaterThan(0.01);
      expect(tr.seed).toBe(2);

      const ip = await ag.inpaintAudio!({
        audio: src.audio,
        startSeconds: 1,
        endSeconds: 2,
        prompt: 'variation',
        seed: 3,
      });
      const p = parseWav(ip.audio.data);
      expect(p.frames).toBe(input.frames);
      expect(ip.durationSeconds).toBe(1);
      for (let c = 0; c < input.channels; c++) {
        expect(maxAbsDiff(p.samples[c].subarray(0, sr), input.samples[c].subarray(0, sr))).toBe(0);
        expect(maxAbsDiff(p.samples[c].subarray(2 * sr), input.samples[c].subarray(2 * sr))).toBe(0);
        expect(
          maxAbsDiff(p.samples[c].subarray(sr, 2 * sr), input.samples[c].subarray(sr, 2 * sr)),
        ).toBeGreaterThan(0.01);
      }

      const ex = await ag.extendAudio!({
        audio: src.audio,
        prompt: 'keep going',
        durationSeconds: 1.5,
        seed: 4,
      });
      const e = parseWav(ex.audio.data);
      expect(e.duration).toBeCloseTo(4.5, 3);
      expect(maxAbsDiff(e.samples[0].subarray(0, input.frames), input.samples[0])).toBe(0);
      expect(rms(e.samples[0].subarray(input.frames))).toBeGreaterThan(0.005);

      await expect(ag.cancel!()).resolves.toBeUndefined(); // POST /cancel → 204
    });

    it('maps bridge errors to ProviderError (404 unknown model, 400 invalid input)', async () => {
      const ag = provider('ace-step-local', ROLE.music).audioGeneration!;
      const err = await ag
        .generateMusic({ prompt: 'x', durationSeconds: 1, model: 'no-such-model' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ kind: 'bad-request', status: 404 });
      expect((err as Error).message).toContain('no-such-model');
      await expect(ag.generateMusic({ prompt: 'x', durationSeconds: 0 })).rejects.toMatchObject({
        kind: 'bad-request',
        status: 400,
      });
      await expect(
        ag.generateMusic({ prompt: 'x', durationSeconds: 1, key: 'H minor' }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        ag.inpaintAudio!({
          audio: wavAudio(new Uint8Array([1, 2, 3])),
          startSeconds: 0,
          endSeconds: 1,
          prompt: 'x',
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('aborting the request (Song Deck cancel) stops the job on the bridge', async () => {
      const ag = provider('ace-step-local', ROLE.music).audioGeneration!;
      const before = await health(url(ROLE.music));
      const controller = new AbortController();
      const pending = ag.generateMusic({
        prompt: 'a long render',
        durationSeconds: 120,
        seed: 9,
        signal: controller.signal,
      });
      await waitFor(async () => (await health(url(ROLE.music))).jobs.running === 1, 5000, 'the job to start');
      controller.abort();
      await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
      await waitFor(
        async () => {
          const h = await health(url(ROLE.music));
          return h.jobs.running === 0 && h.jobs.cancelled === before.jobs.cancelled + 1;
        },
        5000,
        'the bridge to cancel the job after the client disconnected',
      );
    });
  });

  describe('singing bridge (diffsinger-local preset)', () => {
    const notes: SingingRequest['notes'] = [
      { pitch: 60, startSeconds: 0.5, durationSeconds: 0.5, lyric: 'la', velocity: 100 },
      {
        pitch: 64,
        startSeconds: 1.0,
        durationSeconds: 0.5,
        lyric: 'li',
        velocity: 90,
        expression: { vibrato: 0.3, vibratoRate: 5.5 },
      },
      {
        pitch: 67,
        startSeconds: 1.5,
        durationSeconds: 0.75,
        lyric: 'lo',
        velocity: 90,
        expression: { breathiness: 0.2, release: 'falling' },
      },
    ];
    const req: SingingRequest = {
      voiceId: 'mock-tenor',
      tempoBpm: 120,
      sampleRate: 32000,
      seed: 7,
      notes,
      language: 'en',
    };

    it('lists the two stock voices', async () => {
      const voices = await provider('diffsinger-local', ROLE.singing).singing!.listVoices();
      expect(voices).toEqual([
        {
          id: 'mock-soprano',
          name: 'Mock Soprano (sine)',
          voiceType: 'soprano',
          language: 'en',
          kind: 'stock',
        },
        {
          id: 'mock-tenor',
          name: 'Mock Tenor (sawtooth)',
          voiceType: 'tenor',
          language: 'en',
          kind: 'stock',
        },
      ]);
    });

    it('synthesize covers 0 … end of the last note; regenerate_phrase covers exactly [start, end]', async () => {
      const singing = provider('diffsinger-local', ROLE.singing).singing!;
      const full = await singing.synthesizeSinging(req);
      const fw = parseWav(full.audio.data);
      expect([fw.sampleRate, fw.channels]).toEqual([32000, 1]);
      expect(Math.abs(fw.duration - 2.25)).toBeLessThanOrEqual(1 / 32000);
      expect(rms(fw.samples[0].subarray(0, 0.45 * 32000))).toBe(0); // silence before the first note
      expect(full).toMatchObject({ voiceId: 'mock-tenor', model: 'mock-singer', seed: 7, costUsd: 0 });

      const phrase = await singing.regeneratePhrase!({ ...req, startSeconds: 1, endSeconds: 1.75 });
      const pw = parseWav(phrase.audio.data);
      expect(pw.frames).toBe(0.75 * 32000);
      // Same seed → the regenerated phrase is that slice of the full render.
      expect(maxAbsDiff(pw.samples[0], fw.samples[0].subarray(32000, 32000 + pw.frames))).toBeLessThan(1e-4);

      await expect(singing.synthesizeSinging({ ...req, voiceId: 'nobody' })).rejects.toMatchObject({
        kind: 'bad-request',
        status: 404,
      });
    });

    it('sings a vocal track built from a Song (buildSingingRequest) and the transcription bridge hears the pitches', async () => {
      const song = makeSong();
      const sreq = buildSingingRequest(song, 'trk_vox', {
        voiceId: 'mock-soprano',
        seed: 3,
        startTick: 4 * 1920,
        endTick: 5 * 1920,
      });
      const res = await provider('diffsinger-local', ROLE.singing).singing!.synthesizeSinging(sreq);
      const w = parseWav(res.audio.data);
      const end = Math.max(...sreq.notes.map((n) => n.startSeconds + n.durationSeconds));
      expect(Math.abs(w.duration - end)).toBeLessThanOrEqual(1 / 44100);

      const sung = await provider('diffsinger-local', ROLE.singing).singing!.synthesizeSinging(req);
      const heard = await provider('basic-pitch-local', ROLE.transcription).transcription!.transcribeNotes({
        audio: sung.audio,
        source: 'vocals',
      });
      expect(heard.notes.map((n) => n.pitch)).toEqual([60, 64, 67]);
    });
  });

  describe('transcription bridge (basic-pitch-local preset)', () => {
    it('transcribes a monophonic melody into timed notes with confidence', async () => {
      const sr = 44100;
      const melody = [
        { midi: 57, start: 0.1, dur: 0.4 },
        { midi: 60, start: 0.6, dur: 0.4 },
        { midi: 64, start: 1.1, dur: 0.4 },
        { midi: 69, start: 1.6, dur: 0.6 },
      ];
      const audio = wavAudio(encodeWav([tones(melody, sr, 2.4)], sr));
      const res = await provider('basic-pitch-local', ROLE.transcription).transcription!.transcribeNotes({
        audio,
        source: 'melody',
      });
      expect(res.notes.map((n) => n.pitch)).toEqual([57, 60, 64, 69]);
      res.notes.forEach((n, i) => {
        expect(Math.abs(n.start - melody[i].start)).toBeLessThan(0.06);
        expect(Math.abs(n.end - (melody[i].start + melody[i].dur))).toBeLessThan(0.06);
        expect(n.confidence).toBeGreaterThan(0.6);
        expect(n.velocity).toBeGreaterThanOrEqual(1);
      });
      expect(res.confidence).toBeGreaterThan(0.6);
      expect(res.key).toMatch(/ (major|minor)$/);
    });
  });

  describe('separation bridge (demucs-local preset)', () => {
    it('returns the requested stems as WAVs that sum back to the input', async () => {
      const src = await provider('ace-step-local', ROLE.music).audioGeneration!.generateMusic({
        prompt: 'mix to split',
        durationSeconds: 2,
        seed: 5,
      });
      const input = parseWav(src.audio.data);
      const sep = provider('demucs-local', ROLE.separation).separation!;
      const res = await sep.separateStems({ audio: src.audio });
      expect(Object.keys(res.stems)).toEqual(['drums', 'bass', 'vocals', 'other', 'guitar', 'piano']);
      expect(res.model).toBe('mock-bandsplit-6');
      const stems = Object.values(res.stems).map((a) => parseWav(a.data));
      for (const s of stems)
        expect([s.frames, s.channels, s.sampleRate]).toEqual([
          input.frames,
          input.channels,
          input.sampleRate,
        ]);
      for (let c = 0; c < input.channels; c++) {
        let maxErr = 0;
        for (let i = 0; i < input.frames; i++) {
          let sum = 0;
          for (const s of stems) sum += s.samples[c][i];
          maxErr = Math.max(maxErr, Math.abs(sum - input.samples[c][i]));
        }
        expect(maxErr).toBeLessThan(1e-4);
      }
      const six = await sep.separateStems({ audio: src.audio, stems: ['vocals', 'guitar', 'piano'] });
      expect(Object.keys(six.stems)).toEqual(['vocals', 'guitar', 'piano']);
      expect(six.model).toBe('mock-bandsplit-6');
      await expect(sep.separateStems({ audio: src.audio, stems: ['kazoo'] })).rejects.toMatchObject({
        kind: 'bad-request',
        status: 400,
      });
    });
  });

  describe('voice-conversion bridge (rvc-local preset)', () => {
    const sr = 44100;
    const audio = wavAudio(encodeWav([tones([{ midi: 69, start: 0, dur: 1 }], sr, 1)], sr));

    it('lists voices and converts to a stock voice without an attestation (pitch shift is audible)', async () => {
      const vc = provider('rvc-local', ROLE.voiceConversion).voiceConversion!;
      expect((await vc.listVoices!()).map((v) => [v.id, v.kind])).toEqual([
        ['mock-alto', 'stock'],
        ['mock-baritone', 'stock'],
        ['mock-user-voice', 'user-trained'],
      ]);
      const res = await vc.convertVoice({
        audio,
        targetVoice: { id: 'mock-alto', kind: 'stock' },
        pitchShift: 12,
      });
      expect(res).toMatchObject({ voiceId: 'mock-alto', model: 'mock-voice-conversion' });
      expect(parseWav(res.audio.data).frames).toBe(sr);
      const transcriber = provider('basic-pitch-local', ROLE.transcription).transcription!;
      const heard = await transcriber.transcribeNotes({ audio: res.audio, source: 'vocals' });
      expect(heard.notes.map((n) => n.pitch)).toEqual([81]); // A4 + 12 semitones
      const down = await vc.convertVoice({
        audio,
        targetVoice: { id: 'mock-baritone', kind: 'stock' },
        pitchShift: -5,
      });
      expect(parseWav(down.audio.data).frames).toBe(sr); // duration is preserved
      expect(
        (await transcriber.transcribeNotes({ audio: down.audio, source: 'vocals' })).notes.map(
          (n) => n.pitch,
        ),
      ).toEqual([64]);
    });

    it('refuses a non-stock voice without consent before anything is sent (ConsentRequiredError)', async () => {
      const vc = provider('rvc-local', ROLE.voiceConversion).voiceConversion!;
      const before = await health(url(ROLE.voiceConversion));
      await expect(
        vc.convertVoice({ audio, targetVoice: { id: 'mock-user-voice', kind: 'user-trained' } }),
      ).rejects.toBeInstanceOf(ConsentRequiredError);
      const after = await health(url(ROLE.voiceConversion));
      expect(after.jobs).toEqual(before.jobs); // the bridge never saw the request
      const ok = await vc.convertVoice({
        audio,
        targetVoice: { id: 'mock-user-voice', kind: 'user-trained' },
        consent: {
          attestedBy: 'Test Singer',
          rightsHolder: 'Test Singer',
          basis: 'own-voice',
          attestedAt: '2026-10-01T00:00:00Z',
        },
      });
      expect(ok.voiceId).toBe('mock-user-voice');
      await expect(
        vc.convertVoice({ audio, targetVoice: { id: 'nobody', kind: 'stock' } }),
      ).rejects.toMatchObject({ kind: 'bad-request', status: 404 });
    });
  });

  describe('lyrics bridge (whisper-local preset)', () => {
    it('transcribes sung phrases into words with timings; the prompt supplies the words', async () => {
      const sr = 22050;
      const sung = tones(
        [
          { midi: 64, start: 0.2, dur: 0.4 },
          { midi: 67, start: 0.8, dur: 0.4 },
          { midi: 69, start: 2.2, dur: 0.5 },
        ],
        sr,
        3.2,
      );
      const audio = wavAudio(encodeWav([sung], sr));
      const lt = provider('whisper-local', ROLE.lyrics).lyricTranscription!;
      const res = await lt.transcribeLyrics({ audio, prompt: 'hello there friend', language: 'en-US' });
      expect(res.model).toBe('mock-whisper');
      expect(res.language).toBe('en');
      expect(res.wordTimestamps).toBe(true);
      const words = res.segments.flatMap((s) => s.words ?? []);
      expect(words.length).toBeGreaterThan(0);
      expect(words[0].word.toLowerCase()).toContain('hello');
      for (let i = 1; i < words.length; i++)
        expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start);
      const plain = await lt.transcribeLyrics({ audio, wordTimestamps: false });
      expect(plain.wordTimestamps).toBe(false);
      await expect(lt.transcribeLyrics({ audio, model: 'nope' })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('instrument plugin host (plugin-host-local preset)', () => {
    it('lists plugins, describes one, renders MIDI to a WAV of the requested length, round-trips state', async () => {
      const h = provider('plugin-host-local', ROLE.instruments).instrumentHost!;
      const status = await h.status();
      expect(status.formats.find((f) => f.format === 'vst3')?.available).toBe(true);
      const plugins = await h.listPlugins();
      expect(plugins.map((p) => p.id)).toEqual(
        expect.arrayContaining(['mock:sine-synth', 'mock:square-bass']),
      );
      const d = await h.describePlugin('mock:sine-synth');
      expect(d.parameters.map((p) => p.id)).toEqual(expect.arrayContaining(['gain', 'waveform']));
      const state = await h.captureState!('mock:sine-synth', { parameters: { gain: 0.5 } });
      expect(state.parameters.gain).toBeCloseTo(0.5, 6);
      expect(state.stateBase64).toBeTruthy();
      const sr = 22050;
      const r = await h.renderInstrument({
        pluginId: 'mock:sine-synth',
        state,
        sampleRate: sr,
        channels: 2,
        durationSeconds: 1.5,
        events: [
          { time: 0, data: [0x90, 69, 100] },
          { time: 0.5, data: [0x80, 69, 64] },
        ],
      });
      const w = parseWav(r.audio.data);
      expect([w.channels, w.sampleRate, w.frames]).toEqual([2, sr, 1.5 * sr]);
      expect(rms(w.samples[0].subarray(0, Math.round(0.4 * sr)))).toBeGreaterThan(0.01);
      expect(rms(w.samples[0].subarray(Math.round(1.2 * sr)))).toBeLessThan(0.01);
      await expect(
        h.renderInstrument({ pluginId: 'mock:nothing', sampleRate: sr, durationSeconds: 1, events: [] }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('mastering bridge (mastering-local preset)', () => {
    it('raises a quiet mix to the target loudness under the ceiling; cd → 16-bit; invalid target → 400', async () => {
      const sr = 44100;
      const quiet = tones([{ midi: 57, start: 0, dur: 2 }], sr, 2, 0.03);
      const audio = wavAudio(encodeWav([quiet, quiet], sr));
      const m = provider('mastering-local', ROLE.mastering).mastering!;
      const res = await m.master({ audio, target: 'streaming' });
      expect(res.model).toBe('mock-mastering');
      const w = parseWav(res.audio.data);
      expect([w.bitsPerSample, w.channels, w.frames]).toEqual([24, 2, 2 * sr]);
      expect(20 * Math.log10(rms(w.samples[0]) / rms(quiet))).toBeGreaterThan(10);
      expect(peakOf(w.samples)).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-4);

      const reference = await provider('ace-step-local', ROLE.music).audioGeneration!.generateMusic({
        prompt: 'reference',
        durationSeconds: 2,
        seed: 11,
      });
      const cd = await m.master({ audio, target: 'cd', reference: reference.audio });
      expect(parseWav(cd.audio.data).bitsPerSample).toBe(16);
      await expect(
        m.master({ audio, target: 'radio' as unknown as MasteringRequest['target'] }),
      ).rejects.toMatchObject({ kind: 'bad-request', status: 400 });
    });
  });

  describe('bearer token', () => {
    const TOKEN = 'test-bridge-token-0f3c9a';
    let secured: RunningBridge | undefined;

    beforeAll(async () => {
      const port = await freePortBase(1);
      // The token comes from the environment (keeps it out of `ps` output), as the README recommends.
      secured = await startBridge(['--role', 'mastering', '--port', String(port)], {
        SONGDECK_BRIDGE_TOKEN: TOKEN,
      });
    }, 40_000);

    afterAll(async () => {
      await secured?.stop();
    });

    it('accepts Authorization: Bearer <token>; a missing token is an auth error; /health stays open', async () => {
      const baseUrl = secured!.urls[0];
      const sr = 22050;
      const audio = wavAudio(encodeWav([tones([{ midi: 60, start: 0, dur: 0.5 }], sr, 0.5, 0.1)], sr));
      const authed = createProvider(
        configFromPreset('mastering-local', {
          baseUrl,
          auth: { type: 'bearer' },
          credentialRef: 'provider:mastering-local',
        }),
        {
          transport: new DirectTransport(new MemoryCredentialStore({ 'provider:mastering-local': TOKEN })),
          retry: { baseDelayMs: 0, maxDelayMs: 0 },
        },
      );
      const res = await authed.mastering!.master({ audio, target: 'demo' });
      expect(parseWav(res.audio.data).frames).toBe(0.5 * sr);
      const anonymous = createProvider(configFromPreset('mastering-local', { baseUrl }), deps);
      await expect(anonymous.mastering!.master({ audio, target: 'demo' })).rejects.toMatchObject({
        kind: 'auth',
        status: 401,
      });
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/info`)).status).toBe(401);
    });
  });
});
