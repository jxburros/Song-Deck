/**
 * Piano: an additive physical-ish model (inharmonic partials f_k = k·f0·√(1+Bk²), velocity-dependent
 * hammer spectrum, strike-position comb, frequency-dependent per-partial T60, two detuned strings
 * per partial for beating / double decay, hammer noise and soundboard thump) is rendered ONCE per
 * (sample rate, zone, velocity layer) into a deterministic multisample cache, then played by the
 * sampler voice. That keeps the expensive model out of the real-time loop (≈ sampler cost/voice).
 */
import type { AudioData } from '../../types';
import type { SampleZone } from '../sampler';
import { midiToHz, seedState, xorshift } from '../utils';

export interface PianoParams {
  engine: 'piano';
  /** Velocity layers (render velocities) — ascending. */
  layers: number[];
  /** Spacing between sampled keys (semitones). */
  zoneStep: number;
  brightness: number;
  decayScale: number;
  hammer: number;
  gain?: number;
}

const cache = new Map<string, Float32Array>();
const CACHE_MAX = 160;

function cacheKey(sr: number, pitch: number, vel: number, p: PianoParams): string {
  return `${sr}|${pitch}|${vel}|${p.brightness}|${p.decayScale}|${p.hammer}`;
}

/** Render one piano note (mono) with the additive model. Deterministic. */
export function renderPianoNote(sr: number, pitch: number, velocity: number, p: PianoParams): Float32Array {
  const f0 = midiToHz(pitch);
  const v = Math.max(0.05, Math.min(1, velocity / 127));
  const dur = Math.max(2.2, Math.min(8, 9 * Math.pow(2, -(pitch - 21) / 30)));
  const n = Math.round(dur * sr);
  const out = new Float64Array(n);
  const B = Math.max(3e-5, Math.min(3e-3, 1.4e-4 * Math.pow(2, (pitch - 48) / 18)));
  const t60f = Math.max(0.7, Math.min(25, 25 * Math.pow(2, -(pitch - 21) / 17))) * p.decayScale;
  const fc = (420 + 3800 * v * v) * (1 + (pitch - 21) / 70) * (0.6 + 0.8 * p.brightness);
  const beta = 0.12; // strike position
  const fmax = Math.min(0.45 * sr, 16000);
  let rng = seedState(pitch * 131 + Math.round(velocity) * 7919 + 17);
  const nextU = (): number => {
    rng = xorshift(rng);
    return (rng >>> 0) / 4294967296;
  };
  for (let k = 1; k <= 64; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k);
    if (fk >= fmax) break;
    const hammer = 1 / (1 + Math.pow(fk / fc, 2));
    const comb = Math.pow(Math.abs(Math.sin(Math.PI * k * beta)) + 0.05, 0.7);
    const amp = (hammer * comb) / Math.pow(k, 0.85);
    if (amp < 1e-4) continue;
    const df = fk - f0;
    const t60 = 1 / (1 / t60f + 1.04e-7 * df * df + 0.02 * (k - 1));
    for (let sIdx = 0; sIdx < 2; sIdx++) {
      const cents = (sIdx === 0 ? -1 : 1) * (0.25 + 0.9 * nextU()) * (pitch < 33 ? 0.3 : 1);
      const f = fk * Math.pow(2, cents / 1200);
      const w = (2 * Math.PI * f) / sr;
      const tt = t60 * (sIdx === 0 ? 1 : 0.82);
      const d = Math.exp(-6.907755 / (tt * sr));
      const len = Math.min(n, Math.ceil(tt * sr * 1.4));
      const cr = Math.cos(w) * d,
        ci = Math.sin(w) * d;
      let re = amp * 0.5,
        im = 0;
      for (let t = 0; t < len; t++) {
        out[t] += im;
        const nr = re * cr - im * ci;
        im = re * ci + im * cr;
        re = nr;
      }
    }
  }
  // hammer contact attack
  const ta = Math.max(8, Math.round((0.0045 - 0.003 * v) * sr));
  for (let t = 0; t < ta && t < n; t++) {
    const x = t / ta;
    out[t] *= x * x * (3 - 2 * x);
  }
  // hammer noise + soundboard thump
  const nLen = Math.min(n, Math.round(0.06 * sr));
  const nDecay = Math.exp(-6.9 / (0.035 * sr));
  const lpA = 1 - Math.exp((-2 * Math.PI * (900 + 2500 * v)) / sr);
  let lp = 0;
  let g = (0.02 + 0.06 * v) * p.hammer;
  const thumpW = (2 * Math.PI * 92) / sr;
  const thumpD = Math.exp(-6.9 / (0.07 * sr));
  let tg = 0.03 * v * p.hammer;
  for (let t = 0; t < nLen; t++) {
    lp += lpA * (nextU() * 2 - 1 - lp);
    out[t] += lp * g + Math.sin(thumpW * t) * tg;
    g *= nDecay;
    tg *= thumpD;
  }
  // loudness normalization (RMS of the first 400 ms) so layers/pitches sit at a consistent level
  const rl = Math.min(n, Math.round(0.4 * sr));
  let e = 0;
  for (let t = 0; t < rl; t++) e += out[t] * out[t];
  const rms = Math.sqrt(e / Math.max(1, rl));
  const norm = rms > 0 ? 0.18 / rms : 1;
  // fade the last 60 ms
  const fl = Math.round(0.06 * sr);
  const res = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let x = out[t] * norm;
    const r = n - t;
    if (r < fl) x *= r / fl;
    res[t] = x;
  }
  return res;
}

/** Zone (lazily rendered) covering `pitch` at `velocity`. */
export function pianoZone(sr: number, pitch: number, velocity: number, p: PianoParams): SampleZone {
  const step = Math.max(1, Math.round(p.zoneStep));
  const center = Math.max(21, Math.min(108, 21 + Math.round((Math.round(pitch) - 21) / step) * step));
  const layers = p.layers;
  let li = 0;
  for (let i = 0; i < layers.length; i++) {
    const lo = i === 0 ? 1 : Math.floor((layers[i - 1] + layers[i]) / 2) + 1;
    if (velocity >= lo) li = i;
  }
  const lv = layers[li];
  const key = cacheKey(sr, center, lv, p);
  let data = cache.get(key);
  if (!data) {
    data = renderPianoNote(sr, center, lv, p);
    if (cache.size >= CACHE_MAX) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    cache.set(key, data);
  }
  const sample: AudioData = { sampleRate: sr, channels: [data] };
  const lovel = li === 0 ? 1 : Math.floor((layers[li - 1] + layers[li]) / 2) + 1;
  const hivel = li === layers.length - 1 ? 127 : Math.floor((layers[li] + layers[li + 1]) / 2);
  const damper = pitch >= 89 ? 1.2 : Math.max(0.12, Math.min(0.5, 0.45 * Math.pow(2, -(pitch - 30) / 30)));
  return {
    sample,
    lokey: center - Math.floor(step / 2),
    hikey: center + Math.ceil(step / 2) - 1,
    pitchKeycenter: center,
    lovel,
    hivel,
    loopMode: 'no_loop',
    ampegAttack: 0.001,
    ampegRelease: damper,
    ampVeltrack: 80,
    volume: 0,
  };
}
