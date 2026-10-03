/** Shared fixtures and signal measurements for the dsp tests. */
import { createEmptySong, defaultChannelStrip, GM_DRUM } from '@songdeck/core';
import type { ChannelStrip, Note, Song, Track } from '@songdeck/core';
import type { AudioData } from '../src/types';

let counter = 0;

export function mkNote(
  pitch: number,
  tick: number,
  duration: number,
  velocity = 96,
  extra: Partial<Note> = {},
): Note {
  return { id: `n${++counter}`, pitch, tick, duration, velocity, ...extra };
}

export function mkTrack(id: string, instrumentId: string, notes: Note[], extra: Partial<Track> = {}): Track {
  return {
    id,
    name: id,
    kind: 'midi',
    role: 'keys',
    instrumentId,
    constraints: {},
    notes,
    clips: [],
    color: '#888888',
    stemGroup: 'keys',
    ...extra,
  };
}

/** Empty song with `bars` bars of 4/4 at `bpm`. */
export function mkSong(bars = 2, bpm = 120): Song {
  const song = createEmptySong({ title: 'Test', bpm, seed: 3, id: 'test-song' });
  song.sections = [{ id: 'sec', name: 'A', kind: 'verse', bars, energy: 60 }];
  return song;
}

export function setStrip(song: Song, trackId: string, s: Partial<ChannelStrip>): void {
  song.mixer.channels[trackId] = defaultChannelStrip({ reverbSend: 0, ...s });
}

/** A small band: drums, bass, chords, lead (all within `bars`). */
export function bandSong(bars = 2, bpm = 120): Song {
  const song = mkSong(bars, bpm);
  const bar = 1920;
  const drums: Note[] = [],
    bass: Note[] = [],
    keys: Note[] = [],
    lead: Note[] = [];
  for (let b = 0; b < bars; b++) {
    const t = b * bar;
    drums.push(
      mkNote(GM_DRUM.KICK, t, 120, 110),
      mkNote(GM_DRUM.SNARE, t + 480, 120, 100),
      mkNote(GM_DRUM.KICK, t + 960, 120, 105),
      mkNote(GM_DRUM.SNARE, t + 1440, 120, 100),
    );
    for (let e = 0; e < 8; e++) drums.push(mkNote(GM_DRUM.HIHAT_CLOSED, t + e * 240, 100, e % 2 ? 70 : 90));
    for (let e = 0; e < 4; e++) bass.push(mkNote(40 + (b % 2) * 5, t + e * 480, 440, 95));
    for (const p of [64, 67, 71]) keys.push(mkNote(p + (b % 2) * 5, t, bar - 60, 80));
    for (let q = 0; q < 4; q++) lead.push(mkNote(76 + q * 2, t + q * 480, 460, 90));
  }
  song.tracks = [
    mkTrack('drums', 'drum-kit', drums, { role: 'drums', stemGroup: 'drums' }),
    mkTrack('bass', 'electric-bass', bass, { role: 'bass', stemGroup: 'bass' }),
    mkTrack('keys', 'piano', keys, { role: 'keys', stemGroup: 'keys' }),
    mkTrack('lead', 'synth-lead', lead, { role: 'synth-lead', stemGroup: 'others' }),
  ];
  for (const t of song.tracks) song.mixer.channels[t.id] = defaultChannelStrip();
  return song;
}

export function rms(x: ArrayLike<number>, start = 0, end = x.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

export function peak(x: ArrayLike<number>, start = 0, end = x.length): number {
  let m = 0;
  for (let i = start; i < end; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}

export function db(x: number): number {
  return 20 * Math.log10(Math.max(1e-12, x));
}

export function hasNonFinite(buf: AudioData): boolean {
  for (const c of buf.channels) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) return true;
  return false;
}

/** YIN fundamental estimate (Hz) of x[start .. start+win). */
export function yinF0(
  x: ArrayLike<number>,
  sr: number,
  start = 0,
  win = 4096,
  fmin = 40,
  fmax = 2000,
): number {
  const minLag = Math.floor(sr / fmax);
  const maxLag = Math.ceil(sr / fmin);
  const d = new Float64Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i < win; i++) {
      const e = x[start + i] - x[start + i + lag];
      s += e * e;
    }
    d[lag] = s;
  }
  const cm = new Float64Array(maxLag + 2);
  cm[0] = 1;
  let run = 0;
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    run += d[lag];
    cm[lag] = (d[lag] * lag) / (run || 1);
  }
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cm[lag] < 0.15) {
      while (lag + 1 <= maxLag && cm[lag + 1] < cm[lag]) lag++;
      best = lag;
      break;
    }
  }
  if (best < 0) {
    let m = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++)
      if (cm[lag] < m) {
        m = cm[lag];
        best = lag;
      }
  }
  const a = cm[best - 1],
    b = cm[best],
    c = cm[best + 1];
  const den = a - 2 * b + c;
  const off = den !== 0 ? (0.5 * (a - c)) / den : 0;
  return sr / (best + off);
}

export function cents(f: number, ref: number): number {
  return 1200 * Math.log2(f / ref);
}

/** Magnitude of the DFT of a Hann-windowed segment at frequency f (Goertzel). */
export function toneMag(x: ArrayLike<number>, sr: number, f: number, start = 0, n = 8192): number {
  const w = (2 * Math.PI * f) / sr;
  const c = 2 * Math.cos(w);
  let s1 = 0,
    s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = x[start + i] * win + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / n;
}

/** Energy in [f0, f1] Hz via a coarse DFT scan (step `df`). */
export function bandEnergy(
  x: ArrayLike<number>,
  sr: number,
  f0: number,
  f1: number,
  start = 0,
  n = 8192,
  df = 10,
): number {
  let e = 0;
  for (let f = f0; f <= f1; f += df) {
    const m = toneMag(x, sr, f, start, n);
    e += m * m;
  }
  return e;
}

export function sine(freq: number, seconds: number, sr: number, amp = 0.5, channels = 1): AudioData {
  const n = Math.round(seconds * sr);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return { sampleRate: sr, channels: Array.from({ length: channels }, () => new Float32Array(ch)) };
}

/** Deterministic LCG for tests. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
