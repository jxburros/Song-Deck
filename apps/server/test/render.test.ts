import { decodeWav, encodeWav, type AudioData } from '@songdeck/audio';
import { createEmptySong, type Note, type Song, type Track } from '@songdeck/core';
import { afterEach, describe, expect, it } from 'vitest';
import { json, startServer, type TestServer } from './helpers';

let srv: TestServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const PPQ = 480;

function notes(pitches: number[], durationTicks = PPQ): Note[] {
  return pitches.map((pitch, i) => ({ id: `n${pitch}_${i}`, pitch, tick: i * durationTicks, duration: durationTicks, velocity: 96 }));
}

function track(id: string, instrumentId: string, role: Track['role'], stemGroup: Track['stemGroup'], ns: Note[]): Track {
  return { id, name: id, kind: 'midi', role, instrumentId, constraints: {}, notes: ns, clips: [], color: '#8888ff', stemGroup };
}

/** Two bars of 4/4 at 120 bpm (4 s) with piano and bass. */
function tinySong(bars = 2): Song {
  const song = createEmptySong({ title: 'Render test', bpm: 120, id: 'song_render' });
  song.sections.push({ id: 'sec_a', name: 'Verse', kind: 'verse', bars, energy: 60 } as Song['sections'][number]);
  const beats = bars * 4;
  song.tracks.push(
    track('trk_piano', 'piano', 'keys', 'keys', notes(Array.from({ length: beats }, (_, i) => [60, 64, 67, 72][i % 4]))),
    track('trk_bass', 'electric-bass', 'bass', 'bass', notes(Array.from({ length: beats / 2 }, (_, i) => [36, 43][i % 2]), PPQ * 2)),
  );
  return song;
}

function render(url: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${url}/api/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init });
}

function peak(buf: AudioData): number {
  let p = 0;
  for (const ch of buf.channels) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]));
  return p;
}

async function waitForBusy(url: string, busyJobs: number, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const info = await json(await fetch(`${url}/api/node/info`));
    if (info.busyJobs === busyJobs) return;
    if (Date.now() > until) throw new Error(`node never reached busyJobs=${busyJobs} (is ${info.busyJobs}, queued ${info.queuedJobs})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function wav(res: Response): Promise<{ bytes: Uint8Array; audio: AudioData }> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, audio: decodeWav(bytes) };
}

describe('render node', () => {
  it('advertises its capabilities', async () => {
    srv = await startServer({ render: { workers: 2 }, nodeName: 'test-node' });
    const info = await json(await fetch(`${srv.url}/api/node/info`));
    expect(info).toMatchObject({
      id: expect.stringMatching(/^node_/),
      name: 'test-node',
      version: expect.any(String),
      cpuCores: expect.any(Number),
      loadAvg: expect.any(Array),
      busyJobs: 0,
      maxJobs: 2,
      capabilities: ['render-mix', 'render-stems', 'render-track', 'master', 'loudness'],
    });
    expect((await json(await fetch(`${srv.url}/api/health`))).features).toContain('render-node');
    // The node id is stable across restarts.
    const dataDir = srv.dataDir;
    await srv.close({ keepData: true });
    srv = await startServer({ dataDir });
    expect((await json(await fetch(`${srv.url}/api/node/info`))).id).toBe(info.id);
  });

  it('renders a tiny song to a valid WAV in a worker thread', async () => {
    srv = await startServer({ render: { workers: 2 } });
    const res = await render(srv.url, { kind: 'mix', song: tinySong(), options: { sampleRate: 22050 } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('x-songdeck-node')).toMatch(/^node_/);
    const { bytes, audio } = await wav(res);
    const ascii = (a: number, b: number) => String.fromCharCode(...bytes.subarray(a, b));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 12)).toBe('WAVE');
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true)).toBe(bytes.length - 8);
    expect(audio.sampleRate).toBe(22050);
    expect(audio.channels).toHaveLength(2);
    const seconds = audio.channels[0].length / audio.sampleRate;
    expect(seconds).toBeGreaterThanOrEqual(4); // 2 bars at 120 bpm
    expect(seconds).toBeLessThanOrEqual(4 + 2.5); // + reverb/delay tail
    expect(Number(res.headers.get('x-songdeck-duration'))).toBeCloseTo(seconds, 2);
    expect(peak(audio)).toBeGreaterThan(0.01);
    expect(srv.app.services.renderNode.pool.mode).toBe('workers');
  });

  it('is deterministic and splits stem renders across nodes', async () => {
    srv = await startServer({ render: { workers: 2 } });
    const song = tinySong();
    const opts = { sampleRate: 16000, by: 'track' };
    const all = await json(await render(srv.url, { kind: 'stems', song, options: opts }));
    expect(Object.keys(all.stems).sort()).toEqual(['trk_bass', 'trk_piano']);
    // Two "nodes" each render half of the tracks: identical stems.
    const [a, b] = await Promise.all([
      render(srv.url, { kind: 'stems', song, options: { ...opts, trackIds: ['trk_piano'] } }).then(json),
      render(srv.url, { kind: 'stems', song, options: { ...opts, trackIds: ['trk_bass'] } }).then(json),
    ]);
    expect(a.stems.trk_piano).toBe(all.stems.trk_piano);
    expect(b.stems.trk_bass).toBe(all.stems.trk_bass);
    const piano = decodeWav(Buffer.from(all.stems.trk_piano, 'base64'));
    expect(piano.sampleRate).toBe(16000);
    expect(peak(piano)).toBeGreaterThan(0.01);
    const groups = await json(await render(srv.url, { kind: 'stems', song, options: { sampleRate: 16000 } }));
    expect(Object.keys(groups.stems).sort()).toEqual(['bass', 'keys']);
    const mix1 = new Uint8Array(await (await render(srv.url, { kind: 'mix', song, options: { sampleRate: 16000 } })).arrayBuffer());
    const mix2 = new Uint8Array(await (await render(srv.url, { kind: 'mix', song, options: { sampleRate: 16000 } })).arrayBuffer());
    expect(Buffer.from(mix1).equals(Buffer.from(mix2))).toBe(true);
  });

  it('renders single tracks, masters audio and measures loudness', async () => {
    srv = await startServer({ render: { workers: 1 } });
    const song = tinySong();
    const track = await render(srv.url, { kind: 'track', song, trackId: 'trk_bass', options: { sampleRate: 16000, bitDepth: 16 } });
    expect(track.status).toBe(200);
    expect((await wav(track)).audio.sampleRate).toBe(16000);

    const mix = await wav(await render(srv.url, { kind: 'mix', song, options: { sampleRate: 22050, applyMaster: false } }));
    const audio = Buffer.from(mix.bytes).toString('base64');
    const mastered = await render(srv.url, { kind: 'master', audio, mastering: { method: 'builtin', target: 'streaming', tone: 0, width: 1 } });
    expect(mastered.status).toBe(200);
    expect(mastered.headers.get('content-type')).toBe('audio/wav');
    const report = JSON.parse(mastered.headers.get('x-songdeck-report') ?? '{}');
    expect(report).toMatchObject({ target: 'streaming', preLufs: expect.any(Number), postLufs: expect.any(Number), truePeakDb: expect.any(Number) });
    const masteredAudio = (await wav(mastered)).audio;
    expect(masteredAudio.channels[0].length).toBe(mix.audio.channels[0].length);

    const loud = await json(await render(srv.url, { kind: 'loudness', audio }));
    expect(loud).toMatchObject({ integratedLufs: expect.any(Number), truePeakDb: expect.any(Number), lra: expect.any(Number), sampleRate: 22050 });
    const loudSong = await json(await render(srv.url, { kind: 'loudness', song, options: { sampleRate: 16000 } }));
    expect(loudSong.integratedLufs).toBeLessThan(0);
  });

  it('resolves audio clip assets sent with the job', async () => {
    srv = await startServer({ render: { workers: 1 } });
    const song = tinySong(1);
    const sr = 16000;
    const tone: AudioData = { sampleRate: sr, channels: [0, 1].map(() => Float32Array.from({ length: sr }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr))) };
    song.tracks.push({
      ...track('trk_audio', 'audio', 'custom', 'others', []),
      kind: 'audio',
      clips: [{ id: 'clip1', assetId: 'asset_tone', tick: 0, offsetSeconds: 0, durationSeconds: 1, gainDb: 0, fadeInSeconds: 0, fadeOutSeconds: 0 }],
    });
    const assets = { asset_tone: Buffer.from(encodeWav(tone, { bitDepth: 16 })).toString('base64') };
    const res = await render(srv.url, { kind: 'track', song, trackId: 'trk_audio', assets, options: { sampleRate: sr } });
    expect(res.status).toBe(200);
    expect(peak((await wav(res)).audio)).toBeGreaterThan(0.05);
    const badAsset = await render(srv.url, { kind: 'mix', song, assets: { asset_tone: 'bm90IGEgd2F2' } });
    expect(badAsset.status).toBe(400);
    expect((await json(badAsset)).code).toBe('invalid-audio');
  });

  it('validates render requests', async () => {
    srv = await startServer({ render: { workers: 1 } });
    const song = tinySong();
    const cases: [unknown, number, string][] = [
      [{ kind: 'karaoke', song }, 400, 'invalid-kind'],
      [{ kind: 'mix' }, 400, 'invalid-song'],
      [{ kind: 'mix', song: { tracks: [] } }, 400, 'invalid-song'],
      [{ kind: 'track', song, trackId: 'nope' }, 400, 'unknown-track'],
      [{ kind: 'stems', song, options: { trackIds: ['nope'] } }, 400, 'unknown-track'],
      [{ kind: 'mix', song, options: { sampleRate: 3 } }, 400, 'bad-request'],
      [{ kind: 'stems', song, options: { by: 'color' } }, 400, 'bad-request'],
      [{ kind: 'master' }, 400, 'invalid-audio'],
      [{ kind: 'master', audio: 'AAAA' }, 400, 'invalid-audio'],
      [{ kind: 'mix', song: tinySong(2000) }, 413, 'render-too-long'],
      [{ kind: 'mix', song: tinySong(600), options: { sampleRate: 192000 } }, 413, 'render-too-large'],
    ];
    for (const [body, status, code] of cases) {
      const res = await render(srv.url, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(status);
      expect((await json(res)).code).toBe(code);
    }
    const notJson = await fetch(`${srv.url}/api/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(notJson.status).toBe(400);
  });

  it('answers 429 when the queue is full and keeps serving', async () => {
    srv = await startServer({ render: { workers: 1, maxQueue: 0 } });
    const long = render(srv.url, { kind: 'mix', song: tinySong(48), options: { sampleRate: 44100 } });
    // Wait until the long render occupies the only worker (the worker may still be booting).
    await waitForBusy(srv.url, 1);
    const busy = await render(srv.url, { kind: 'mix', song: tinySong(), options: { sampleRate: 16000 } });
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('2');
    expect((await json(busy)).code).toBe('busy');
    // The event loop stays responsive while the worker renders.
    const t0 = Date.now();
    expect((await fetch(`${srv.url}/api/health`)).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(500);
    const done = await long;
    expect(done.status).toBe(200);
    await done.arrayBuffer();
    expect((await render(srv.url, { kind: 'mix', song: tinySong(), options: { sampleRate: 16000 } })).status).toBe(200);
  });

  it('cancels a running render when the client disconnects', async () => {
    srv = await startServer({ render: { workers: 1 } });
    const ctrl = new AbortController();
    const pending = render(srv.url, { kind: 'mix', song: tinySong(200), options: { sampleRate: 44100 } }, { signal: ctrl.signal }).catch((e: unknown) => e);
    await waitForBusy(srv.url, 1);
    ctrl.abort();
    expect(((await pending) as Error).name).toBe('AbortError');
    await waitForBusy(srv.url, 0);
    // A replacement worker serves the next job.
    expect((await render(srv.url, { kind: 'mix', song: tinySong(), options: { sampleRate: 16000 } })).status).toBe(200);
  });

  it('requires the token when one is configured', async () => {
    srv = await startServer({ token: 'node-secret', render: { workers: 1 } });
    expect((await render(srv.url, { kind: 'mix', song: tinySong() })).status).toBe(401);
    const ok = await render(srv.url, { kind: 'mix', song: tinySong(), options: { sampleRate: 16000 } }, { headers: { 'content-type': 'application/json', authorization: 'Bearer node-secret' } });
    expect(ok.status).toBe(200);
  });
});
