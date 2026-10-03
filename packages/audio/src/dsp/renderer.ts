/**
 * Guide rendering (spec §28): the streaming SongRenderer and the offline renderSong / renderTrack /
 * renderStems helpers.
 *
 * Pipeline per internal block (64 frames, aligned to the render position so output is identical
 * for any host block size): track sources (instruments / singer / clips) → channel strips →
 * reverb & delay buses → master bus (EQ, glue comp, width, volume, lookahead limiter) → output
 * FIFO. The limiter's 64-frame lookahead is latency-compensated (pre-roll after every seek), so
 * frame N of the output always corresponds to song frame N.
 */
import type { ChannelStrip, InstrumentProfile, MixerState, Song, Track } from '@songdeck/core';
import { barToTick, createTimeMap, defaultChannelStrip, defaultMixer, meterAtBar, songLengthTicks, ticksPerBeat, type TimeMap } from '@songdeck/core';
import type { AssetResolver, AudioData } from '../types';
import { createAudio } from '../types';
import { AP_COUNT, type LaneEval, buildLanes } from './automation';
import { StereoDelay } from './effects/delay';
import { Reverb } from './effects/reverb';
import { BlockSmoother } from './envelopes';
import { ClipPlayer, PolyInstrument, type TrackSource, VocalInstrument, buildNoteEvents } from './instrument';
import { type Meter, MasterProcessor, StripProcessor } from './mixer';
import { PATCHES, type PatchDefinition, resolveInstrumentPatch } from './patches';
import type { SampleInstrument } from './sampler';
import { BLOCK, MIN_DB, clampNum, dbToGain, num } from './utils';

export interface RenderOptions {
  /** Default 44100. */
  sampleRate?: number;
  /** Render range (default: whole song). Frame 0 of the output corresponds to `startTick`. */
  startTick?: number;
  endTick?: number;
  /** Extra time after `endTick` for reverb/delay tails (default 2 s). */
  tailSeconds?: number;
  /** Render only these tracks (mute/solo still evaluated over the whole song). */
  trackIds?: string[];
  ignoreMuteSolo?: boolean;
  /** Master EQ / compressor / width / volume / limiter (default true). */
  applyMaster?: boolean;
  /** Reverb and delay buses (default true). */
  includeSends?: boolean;
  metronome?: boolean;
  /** Audio clip assets (stems, recordings, produced audio). */
  assets?: AssetResolver;
  /** trackId → patch id. */
  patchOverrides?: Record<string, string>;
  /** patch id → user sample instrument (SFZ-like); overrides the built-in patch of that id. */
  sampleInstruments?: Record<string, SampleInstrument>;
  /** Stock singing voice for vocal tracks (default: by voice type / range). */
  vocalVoiceId?: string;
  /** Instrument profiles (built-in + custom) used to resolve `track.instrumentId` → patch id. */
  instruments?: InstrumentProfile[];
  seed?: number;
}

export interface RenderMeters {
  tracks: Record<string, Meter>;
  master: Meter;
}

class SilentSource implements TrackSource {
  readonly idle = true;
  render(): void {}
  seek(): void {}
  loopTo(): void {}
}

interface TrackState {
  id: string;
  track: Track;
  key: string;
  patch: PatchDefinition | null;
  source: TrackSource;
  poly: PolyInstrument | null;
  vocal: VocalInstrument | null;
  clips: ClipPlayer | null;
  retired: PolyInstrument | null;
  retiredLeft: number;
  strip: StripProcessor;
  stripData: ChannelStrip;
  L: Float64Array;
  R: Float64Array;
  auto: Float64Array;
  lanes: LaneEval[];
  render: boolean;
  idleBlocks: number;
}

const CLICK_MS = 30;

/** Streaming, allocation-free (in process()) song renderer. */
export class SongRenderer {
  readonly sampleRate: number;
  private song!: Song;
  private readonly opts: RenderOptions;
  private tm!: TimeMap;
  private startTick = 0;
  private startSec = 0;
  private endFrame = 0;
  private _totalFrames = 0;
  private tracks: TrackState[] = [];
  private readonly trackMap = new Map<string, TrackState>();
  private masterLanes: LaneEval[] = [];
  private readonly masterAuto = new Float64Array(AP_COUNT);
  private readonly master: MasterProcessor;
  private readonly reverb: Reverb;
  private readonly delay: StereoDelay;
  private readonly revReturn = new BlockSmoother(0);
  private readonly dlyReturn = new BlockSmoother(0);
  private readonly mL = new Float64Array(BLOCK);
  private readonly mR = new Float64Array(BLOCK);
  private readonly rvL = new Float64Array(BLOCK);
  private readonly rvR = new Float64Array(BLOCK);
  private readonly dlL = new Float64Array(BLOCK);
  private readonly dlR = new Float64Array(BLOCK);
  private readonly wetL = new Float64Array(BLOCK);
  private readonly wetR = new Float64Array(BLOCK);
  private readonly tmpL = new Float64Array(BLOCK);
  private readonly tmpR = new Float64Array(BLOCK);
  private readonly ringL = new Float64Array(512);
  private readonly ringR = new Float64Array(512);
  private ringRead = 0;
  private ringCount = 0;
  private discard = 0;
  private readonly latency: number;
  private srcPos = 0;
  private outPos = 0;
  private loop: { start: number; end: number } | null = null;
  private readonly applyMaster: boolean;
  private readonly includeSends: boolean;
  private readonly seed: number;
  private mixer!: MixerState;
  private readonly assetCache = new Map<string, AudioData | undefined>();
  // metronome
  private clicks = new Float64Array(0);
  private clickAccent = new Uint8Array(0);
  private clickCur = 0;
  private readonly clickHi: Float32Array;
  private readonly clickLo: Float32Array;
  private readonly stripIdleBlocks: number;
  private peakDecay = 1;
  private rmsCoef = 1;
  private outPeak = 0;
  private outMs = 0;
  /** Asset ids referenced by clips that could not be resolved. */
  missingAssets: string[] = [];

  constructor(song: Song, opts: RenderOptions = {}) {
    this.opts = { ...opts };
    const sr = Math.round(num(opts.sampleRate, 44100));
    if (!(sr >= 8000 && sr <= 384000)) throw new Error(`SongRenderer: unsupported sample rate ${opts.sampleRate}`);
    this.sampleRate = sr;
    this.applyMaster = opts.applyMaster !== false;
    this.includeSends = opts.includeSends !== false;
    this.seed = Math.round(num(opts.seed, song.generation?.seed ?? 1));
    this.latency = this.applyMaster ? BLOCK : 0;
    this.master = new MasterProcessor(sr);
    this.reverb = new Reverb(sr);
    this.delay = new StereoDelay(sr);
    const bps = sr / BLOCK;
    this.peakDecay = Math.pow(10, -20 / 20 / bps);
    this.stripIdleBlocks = Math.ceil(0.5 * bps);
    this.rmsCoef = Math.exp(-BLOCK / (0.3 * sr));
    this.revReturn.setTime(0.03, bps);
    this.dlyReturn.setTime(0.03, bps);
    const clen = Math.round((CLICK_MS / 1000) * sr);
    this.clickHi = new Float32Array(clen);
    this.clickLo = new Float32Array(clen);
    for (let i = 0; i < clen; i++) {
      const env = Math.exp(-i / (0.006 * sr)) * Math.min(1, i / (0.0008 * sr));
      this.clickHi[i] = 0.5 * env * Math.sin((2 * Math.PI * 1760 * i) / sr);
      this.clickLo[i] = 0.35 * env * Math.sin((2 * Math.PI * 1175 * i) / sr);
    }
    this.applySong(song, true);
    this.seekFrame(0);
  }

  get totalFrames(): number {
    return this._totalFrames;
  }

  get positionFrames(): number {
    return this.outPos;
  }

  get positionSeconds(): number {
    return this.outPos / this.sampleRate;
  }

  // -------------------------------------------------------------------------
  // Song / mixer updates
  // -------------------------------------------------------------------------

  private resolvePatch(track: Track): { id: string; patch: PatchDefinition } {
    const o = this.opts.patchOverrides?.[track.id];
    let id = o ?? this.opts.instruments?.find((i) => i.id === track.instrumentId)?.patchId ?? resolveInstrumentPatch(track.instrumentId) ?? '';
    if (!id) {
      const byRole: Partial<Record<Track['role'], string>> = {
        drums: 'drums-acoustic',
        percussion: 'percussion',
        bass: 'bass-electric',
        'rhythm-guitar': 'guitar-distorted',
        'lead-guitar': 'guitar-lead',
        keys: 'piano',
        strings: 'strings-ensemble',
        'synth-pad': 'pad-warm',
        'synth-arp': 'pluck',
        'synth-lead': 'lead-saw',
        'synth-seq': 'pluck',
        vocal: 'vocal-placeholder',
      };
      id = byRole[track.role] ?? (track.midiChannel === 9 ? 'drums-acoustic' : 'sine');
    }
    const si = this.opts.sampleInstruments?.[id];
    if (si) {
      return {
        id,
        patch: {
          id,
          name: si.name ?? id,
          description: 'User sample instrument',
          engine: 'sampler',
          stemGroup: track.stemGroup,
          polyphony: Math.max(1, si.polyphony ?? 32),
          stereo: true,
          sustained: si.zones.some((z) => z.loopMode === 'loop_continuous' || z.loopMode === 'loop_sustain'),
          gainDb: 0,
          range: [0, 127],
        },
      };
    }
    return { id, patch: PATCHES[id] ?? PATCHES.sine };
  }

  private songEndTick(song: Song): number {
    let end = songLengthTicks(song);
    for (const t of song.tracks) {
      for (const n of t.notes) end = Math.max(end, n.tick + n.duration);
    }
    return end;
  }

  private applySong(song: Song, initial: boolean): void {
    const prevTm = this.tm;
    const prevStartSec = this.startSec;
    const sr = this.sampleRate;
    this.song = song;
    const tm = createTimeMap(song);
    this.tm = tm;
    const startTick = Math.max(0, num(this.opts.startTick, 0));
    let endTick = num(this.opts.endTick, NaN);
    if (!Number.isFinite(endTick)) {
      endTick = this.songEndTick(song);
      for (const t of song.tracks) {
        for (const c of t.clips ?? []) {
          if (c.muted) continue;
          const s = tm.tickToSeconds(c.tick) + Math.max(0, num(c.durationSeconds, 0));
          endTick = Math.max(endTick, Math.ceil(tm.secondsToTick(s)));
        }
      }
    }
    endTick = Math.max(startTick, endTick);
    this.startTick = startTick;
    this.startSec = tm.tickToSeconds(startTick);
    this.endFrame = Math.max(0, Math.round((tm.tickToSeconds(endTick) - this.startSec) * sr));
    this._totalFrames = this.endFrame + Math.round(Math.max(0, num(this.opts.tailSeconds, 2)) * sr);

    // keep the musical position on live edits
    let frame = this.srcPos;
    let needSeek = false;
    if (!initial && prevTm) {
      const tick = prevTm.secondsToTick(prevStartSec + this.outPos / sr);
      const nf = Math.round((tm.tickToSeconds(tick) - this.startSec) * sr);
      if (nf !== this.outPos) {
        frame = nf;
        needSeek = true;
      }
    }

    const ctx = { timeMap: tm, ppq: song.ppq || 480, startSec: this.startSec, sampleRate: sr, seed: this.seed };
    const wanted = this.opts.trackIds ? new Set(this.opts.trackIds) : null;
    const next: TrackState[] = [];
    const seen = new Set<string>();
    for (const track of song.tracks) {
      if (!track || seen.has(track.id)) continue;
      seen.add(track.id);
      const isAudio = track.kind === 'audio';
      const { id: patchId, patch } = isAudio ? { id: 'audio', patch: null as PatchDefinition | null } : this.resolvePatch(track);
      const vocalMode = track.vocal?.mode ?? song.vocals?.mode;
      const silent = !isAudio && patch?.engine === 'vocal' && vocalMode === 'none';
      const render = !wanted || wanted.has(track.id);
      const key = !render ? 'skip' : isAudio ? 'audio' : `${patchId}|${patch!.engine}|${silent ? 'silent' : ''}|${this.opts.vocalVoiceId ?? ''}|${track.vocal?.voiceId ?? ''}|${track.vocal?.voiceType ?? ''}`;
      let ts = this.trackMap.get(track.id);
      if (ts && ts.key === key) {
        ts.track = track;
        ts.render = render;
        if (ts.poly) ts.poly.setEvents(buildNoteEvents(track, ts.patch!, ctx), frame);
        else if (ts.vocal) ts.vocal.update(song, track, this.startSec, frame);
        else if (ts.clips) ts.clips.build(track, tm, this.startSec, this.opts.assets);
      } else {
        const old = ts;
        let source: TrackSource;
        let poly: PolyInstrument | null = null;
        let vocal: VocalInstrument | null = null;
        let clips: ClipPlayer | null = null;
        if (!render) {
          source = new SilentSource();
        } else if (isAudio) {
          clips = new ClipPlayer(track, tm, this.startSec, sr, this.opts.assets, this.assetCache);
          source = clips;
        } else if (silent) {
          source = new SilentSource();
        } else if (patch!.engine === 'vocal') {
          vocal = new VocalInstrument(song, track, sr, this.startSec, this.opts.vocalVoiceId, this.seed, patch!.gainDb);
          source = vocal;
        } else {
          const pizz = patch!.articulationPatches?.pizzicato ? PATCHES[patch!.articulationPatches.pizzicato] : undefined;
          poly = new PolyInstrument(patch!, sr, { sampleInstrument: this.opts.sampleInstruments?.[patchId], pizzPatch: pizz });
          poly.setEvents(buildNoteEvents(track, patch!, ctx), frame);
          source = poly;
        }
        ts = {
          id: track.id,
          track,
          key,
          patch,
          source,
          poly,
          vocal,
          clips,
          retired: null,
          retiredLeft: 0,
          strip: old?.strip ?? new StripProcessor(sr),
          stripData: old?.stripData ?? defaultChannelStrip(),
          L: old?.L ?? new Float64Array(BLOCK),
          R: old?.R ?? new Float64Array(BLOCK),
          auto: old?.auto ?? new Float64Array(AP_COUNT),
          lanes: [],
          render,
          idleBlocks: 0,
        };
        if (old?.poly && !initial) {
          old.poly.killAll();
          ts.retired = old.poly;
          ts.retiredLeft = 6;
        }
        if (!initial && !needSeek) ts.source.seek(frame);
        this.trackMap.set(track.id, ts);
      }
      next.push(ts);
    }
    for (const id of [...this.trackMap.keys()]) if (!seen.has(id)) this.trackMap.delete(id);
    this.tracks = next;
    this.missingAssets = next.flatMap((t) => t.clips?.missing ?? []);

    // automation
    const toFrame = (tick: number) => Math.round((tm.tickToSeconds(tick) - this.startSec) * sr);
    const lanes = buildLanes(song.automation ?? [], toFrame);
    for (const ts of this.tracks) ts.lanes = lanes.filter((l) => l.target === ts.id);
    this.masterLanes = lanes.filter((l) => l.target === 'master');

    this.buildClicks(song, startTick, endTick);
    this.applyMixer(song.mixer ?? defaultMixer(), initial);
    if (needSeek) this.seekFrame(frame);
  }

  private buildClicks(song: Song, startTick: number, endTick: number): void {
    if (!this.opts.metronome) {
      this.clicks = new Float64Array(0);
      this.clickAccent = new Uint8Array(0);
      return;
    }
    const frames: number[] = [];
    const accent: number[] = [];
    const sr = this.sampleRate;
    for (let bar = 0; bar < 100000; bar++) {
      const t0 = barToTick(song, bar);
      if (t0 >= endTick) break;
      const m = meterAtBar(song, bar);
      const tpb = ticksPerBeat(m.denominator, song.ppq || 480);
      for (let b = 0; b < m.numerator; b++) {
        const tick = t0 + b * tpb;
        if (tick < startTick || tick >= endTick) continue;
        frames.push(Math.round((this.tm.tickToSeconds(tick) - this.startSec) * sr));
        accent.push(b === 0 ? 1 : 0);
      }
    }
    this.clicks = Float64Array.from(frames);
    this.clickAccent = Uint8Array.from(accent);
  }

  private applyMixer(mixer: MixerState, snap: boolean): void {
    this.mixer = mixer;
    const anySolo = this.tracks.some((t) => !!(mixer.channels?.[t.id]?.solo));
    for (const ts of this.tracks) {
      const s = mixer.channels?.[ts.id] ?? defaultChannelStrip();
      ts.stripData = s;
      ts.strip.setStrip(s, snap);
      const audible = this.opts.ignoreMuteSolo ? true : !s.mute && (!anySolo || !!s.solo);
      ts.strip.setAudible(audible, snap);
    }
    const def = defaultMixer();
    this.master.setMaster(mixer.master ?? def.master, snap);
    this.reverb.configure(mixer.reverb ?? def.reverb);
    this.delay.configure(mixer.delay ?? def.delay, this.tm.bpmAt(this.startTick), snap);
    const rr = dbToGain(clampNum(num((mixer.reverb ?? def.reverb).returnDb, -4), -120, 12));
    const dr = dbToGain(clampNum(num((mixer.delay ?? def.delay).returnDb, -8), -120, 12));
    if (snap) {
      this.revReturn.snap(rr);
      this.dlyReturn.snap(dr);
    } else {
      this.revReturn.target = rr;
      this.dlyReturn.target = dr;
    }
  }

  /** Live edit while playing: keeps the musical position, releases voices whose notes disappeared. */
  updateSong(song: Song): void {
    this.applySong(song, false);
  }

  /** Smooth mixer changes (no zipper noise). */
  updateMixer(mixer: MixerState): void {
    this.applyMixer(mixer, false);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  seekSeconds(s: number): void {
    this.seekFrame(Math.round(num(s, 0) * this.sampleRate));
  }

  seekFrame(frame: number): void {
    const f = Math.max(0, Math.min(this._totalFrames, Math.round(num(frame, 0))));
    this.outPos = f;
    this.srcPos = f;
    this.ringRead = 0;
    this.ringCount = 0;
    this.discard = this.latency;
    for (const ts of this.tracks) {
      ts.source.seek(f);
      ts.strip.reset();
      ts.retired = null;
      ts.retiredLeft = 0;
      ts.idleBlocks = 0;
    }
    this.reverb.reset();
    this.delay.reset();
    this.master.reset();
    this.revReturn.snap(this.revReturn.target);
    this.dlyReturn.snap(this.dlyReturn.target);
    this.clickCur = lowerBoundF(this.clicks, f - this.clickHi.length);
    this.outPeak = 0;
    this.outMs = 0;
  }

  /** Loop playback between frames (null disables). */
  setLoop(startFrame: number | null, endFrame?: number): void {
    if (startFrame === null || startFrame === undefined || endFrame === undefined) {
      this.loop = null;
      return;
    }
    const s = Math.max(0, Math.round(num(startFrame, 0)));
    const e = Math.min(this._totalFrames, Math.round(num(endFrame, 0)));
    if (e - s < BLOCK) {
      this.loop = null;
      return;
    }
    this.loop = { start: s, end: e };
    if (this.outPos >= e || this.outPos < s) this.seekFrame(s);
  }

  getMeters(): RenderMeters {
    const tracks: Record<string, Meter> = {};
    for (const ts of this.tracks) tracks[ts.id] = ts.strip.meter.read();
    return {
      tracks,
      master: {
        peakDb: this.outPeak > 6.31e-8 ? 20 * Math.log10(this.outPeak) : MIN_DB,
        rmsDb: this.outMs > 4e-15 ? 10 * Math.log10(this.outMs) : MIN_DB,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private renderSourceBlock(): void {
    let n = BLOCK;
    const pos = this.srcPos;
    if (this.loop && pos < this.loop.end) n = Math.min(n, this.loop.end - pos);
    const mL = this.mL, mR = this.mR, rvL = this.rvL, rvR = this.rvR, dlL = this.dlL, dlR = this.dlR;
    mL.fill(0, 0, n);
    mR.fill(0, 0, n);
    const sends = this.includeSends;
    if (sends) {
      rvL.fill(0, 0, n);
      rvR.fill(0, 0, n);
      dlL.fill(0, 0, n);
      dlR.fill(0, 0, n);
    }
    for (let t = 0; t < this.tracks.length; t++) {
      const ts = this.tracks[t];
      if (!ts.render) continue;
      const L = ts.L, R = ts.R;
      L.fill(0, 0, n);
      R.fill(0, 0, n);
      ts.source.render(L, R, pos, n);
      if (ts.retired) {
        const tL = this.tmpL, tR = this.tmpR;
        tL.fill(0, 0, n);
        tR.fill(0, 0, n);
        ts.retired.render(tL, tR, pos, n);
        for (let i = 0; i < n; i++) {
          L[i] += tL[i];
          R[i] += tR[i];
        }
        if (--ts.retiredLeft <= 0) ts.retired = null;
      }
      // idle tracks: once the strip's filters/compressor have settled, skip strip + sends entirely
      if (ts.source.idle && !ts.retired) {
        if (++ts.idleBlocks > this.stripIdleBlocks && !ts.lanes.length) {
          ts.strip.meter.push(0, 0, n);
          continue;
        }
      } else ts.idleBlocks = 0;
      // NaN / Inf guard (a diverging voice shows up at the block edges; full scan every 32 blocks)
      let acc = L[0] + R[0] + L[n - 1] + R[n - 1];
      if ((pos & 2047) < n) for (let i = 0; i < n; i++) acc += L[i] + R[i];
      if (!Number.isFinite(acc)) {
        L.fill(0, 0, n);
        R.fill(0, 0, n);
        ts.source.seek(pos + n);
      }
      let auto: Float64Array | null = null;
      if (ts.lanes.length) {
        auto = ts.auto;
        auto.fill(NaN);
        const lanes = ts.lanes;
        for (let k = 0; k < lanes.length; k++) auto[lanes[k].paramIndex] = lanes[k].valueAt(pos);
      }
      ts.strip.process(L, R, n, auto, mL, mR, sends ? rvL : null, sends ? rvR : null, sends ? dlL : null, sends ? dlR : null);
    }
    if (sends) {
      const wL = this.wetL, wR = this.wetR;
      const r0 = this.revReturn.current;
      const r1 = this.revReturn.step();
      this.reverb.process(rvL, rvR, wL, wR, 0, n);
      for (let i = 0; i < n; i++) {
        const g = r0 + ((r1 - r0) * (i + 1)) / n;
        mL[i] += wL[i] * g;
        mR[i] += wR[i] * g;
      }
      const tick = this.tm.secondsToTick(this.startSec + pos / this.sampleRate);
      this.delay.setBpm(this.tm.bpmAt(tick));
      const d0 = this.dlyReturn.current;
      const d1 = this.dlyReturn.step();
      this.delay.process(dlL, dlR, wL, wR, 0, n);
      for (let i = 0; i < n; i++) {
        const g = d0 + ((d1 - d0) * (i + 1)) / n;
        mL[i] += wL[i] * g;
        mR[i] += wR[i] * g;
      }
    }
    if (this.applyMaster) {
      let auto: Float64Array | null = null;
      if (this.masterLanes.length) {
        auto = this.masterAuto;
        auto.fill(NaN);
        const lanes = this.masterLanes;
        for (let k = 0; k < lanes.length; k++) auto[lanes[k].paramIndex] = lanes[k].valueAt(pos);
      }
      this.master.process(mL, mR, n, auto);
    }
    this.meterBlock(mL, mR, n);
    // push into the output FIFO (dropping the limiter pre-roll)
    const ringL = this.ringL, ringR = this.ringR;
    let w = (this.ringRead + this.ringCount) & 511;
    let i0 = 0;
    if (this.discard > 0) {
      i0 = Math.min(n, this.discard);
      this.discard -= i0;
    }
    for (let i = i0; i < n; i++) {
      ringL[w] = mL[i];
      ringR[w] = mR[i];
      w = (w + 1) & 511;
    }
    this.ringCount += n - i0;
    this.srcPos = pos + n;
    if (this.loop && this.srcPos >= this.loop.end) {
      this.srcPos = this.loop.start;
      for (let t = 0; t < this.tracks.length; t++) this.tracks[t].source.loopTo(this.loop.start);
    }
  }

  /**
   * Render the next `frames` (default outL.length) into outL/outR. Returns the number of frames
   * written (0 at the end of the song unless looping); the rest of the buffers is zeroed.
   */
  process(outL: Float32Array, outR: Float32Array, frames?: number): number {
    const want = Math.max(0, Math.min(frames ?? outL.length, outL.length, outR.length));
    let written = 0;
    const ringL = this.ringL, ringR = this.ringR;
    const clicks = this.clicks;
    const clen = this.clickHi.length;
    while (written < want) {
      if (!this.loop && this.outPos >= this._totalFrames) break;
      if (this.ringCount === 0) {
        this.renderSourceBlock();
        continue;
      }
      let n = Math.min(want - written, this.ringCount);
      if (this.loop && this.outPos < this.loop.end) n = Math.min(n, this.loop.end - this.outPos);
      else if (!this.loop) n = Math.min(n, this._totalFrames - this.outPos);
      let r = this.ringRead;
      if (clicks.length) {
        for (let i = 0; i < n; i++) {
          let l = ringL[r];
          let rr = ringR[r];
          r = (r + 1) & 511;
          const f = this.outPos + i;
          while (this.clickCur < clicks.length && clicks[this.clickCur] + clen <= f) this.clickCur++;
          if (this.clickCur < clicks.length) {
            const c0 = clicks[this.clickCur];
            if (c0 <= f) {
              const v = (this.clickAccent[this.clickCur] ? this.clickHi : this.clickLo)[f - c0];
              l += v;
              rr += v;
            }
          }
          outL[written + i] = l === l ? (l > 8 ? 8 : l < -8 ? -8 : l) : 0;
          outR[written + i] = rr === rr ? (rr > 8 ? 8 : rr < -8 ? -8 : rr) : 0;
        }
      } else {
        for (let i = 0; i < n; i++) {
          const l = ringL[r];
          const rr = ringR[r];
          r = (r + 1) & 511;
          outL[written + i] = l === l ? (l > 8 ? 8 : l < -8 ? -8 : l) : 0;
          outR[written + i] = rr === rr ? (rr > 8 ? 8 : rr < -8 ? -8 : rr) : 0;
        }
      }
      this.ringRead = r;
      this.ringCount -= n;
      written += n;
      this.outPos += n;
      if (this.loop && this.outPos >= this.loop.end) {
        this.outPos = this.loop.start;
        this.clickCur = lowerBoundF(clicks, this.outPos - clen);
      }
    }
    for (let i = written; i < want; i++) {
      outL[i] = 0;
      outR[i] = 0;
    }
    return written;
  }

  private meterBlock(L: Float64Array, R: Float64Array, n: number): void {
    let pk = 0, s = 0;
    for (let i = 0; i < n; i++) {
      const a = L[i] < 0 ? -L[i] : L[i];
      const b = R[i] < 0 ? -R[i] : R[i];
      if (a > pk) pk = a;
      if (b > pk) pk = b;
      s += L[i] * L[i] + R[i] * R[i];
    }
    if (!(pk === pk) || !(s === s)) return;
    this.outPeak = Math.max(pk, this.outPeak * this.peakDecay);
    const c = Math.pow(this.rmsCoef, n / BLOCK);
    this.outMs = this.outMs * c + (s / (2 * n)) * (1 - c);
  }
}

function lowerBoundF(a: Float64Array, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Offline helpers
// ---------------------------------------------------------------------------

/** Offline full mix (stereo). */
export function renderSong(song: Song, opts: RenderOptions = {}): AudioData {
  const r = new SongRenderer(song, opts);
  const out = createAudio(r.sampleRate, r.totalFrames, 2);
  const L = out.channels[0], R = out.channels[1];
  const chunk = 8192;
  for (let f = 0; f < r.totalFrames; f += chunk) {
    const n = Math.min(chunk, r.totalFrames - f);
    r.process(L.subarray(f, f + n), R.subarray(f, f + n), n);
  }
  return out;
}

/** One track through its channel strip (+ its reverb/delay sends), unmastered, mute/solo ignored. */
export function renderTrack(song: Song, trackId: string, opts: RenderOptions = {}): AudioData {
  if (!song.tracks.some((t) => t.id === trackId)) throw new Error(`renderTrack: unknown track ${trackId}`);
  return renderSong(song, { applyMaster: false, ignoreMuteSolo: true, ...opts, trackIds: [trackId] });
}

/**
 * Guide stems (spec §28: drums_reference.wav …). Keys are stem groups (by: 'stemGroup', default) or
 * track ids (by: 'track'). Unmastered by default so the stems sum to the unmastered mix.
 */
export function renderStems(song: Song, opts: RenderOptions & { by?: 'stemGroup' | 'track' } = {}): Record<string, AudioData> {
  const by = opts.by ?? 'stemGroup';
  const groups = new Map<string, string[]>();
  const wanted = opts.trackIds ? new Set(opts.trackIds) : null;
  for (const t of song.tracks) {
    if (wanted && !wanted.has(t.id)) continue;
    const key = by === 'track' ? t.id : t.stemGroup || 'others';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t.id);
  }
  const out: Record<string, AudioData> = {};
  const { by: _by, ...rest } = opts;
  void _by;
  for (const [key, ids] of groups) out[key] = renderSong(song, { applyMaster: false, ...rest, trackIds: ids });
  return out;
}
