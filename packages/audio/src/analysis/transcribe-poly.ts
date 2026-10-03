/**
 * Polyphonic transcription (piano, guitar, pads, "other" stems).
 *
 * Per frame: interpolated spectral peaks on a tuning-corrected log-frequency (MIDI) axis →
 * harmonic-summation salience for every candidate semitone → iterative estimation and
 * cancellation (Klapuri 2006): pick the most salient F0, subtract its partials limited by a
 * spectral-smoothness envelope (so shared partials stay available to other notes), repeat
 * until the salience drops or `maxPolyphony` is reached. Note tracking with hysteresis per
 * pitch, re-strike splitting, harmonic-ghost removal, and onset snapping to a spectral-flux
 * onset detector (the long analysis window smears attacks).
 */
import type { AudioData } from '../types';
import { estimateTuning, framePeaks } from './chroma';
import { onsetEnvelopeFromSignal, pickOnsetPeaks } from './onsets';
import { forEachStftFrame } from './stft';
import type { TranscribedNote } from './types';
import { clamp, clamp01, linToDb, percentile, pow2ForDuration, prepareMono, throwIfAborted } from './util';

export interface PolyphonicOptions {
  /** Lowest MIDI pitch considered (default 36). */
  minPitch?: number;
  /** Highest MIDI pitch considered (default 96). */
  maxPitch?: number;
  /** Maximum simultaneous notes per frame (default 6). */
  maxPolyphony?: number;
  /** Frame hop (default ≈ 23 ms). */
  hopSeconds?: number;
  /** Minimum note duration (default 0.07 s). */
  minNoteSeconds?: number;
  /** Relative activation to start a note (default 0.16). */
  onsetThreshold?: number;
  /** Relative activation to sustain a note (default 0.07). */
  frameThreshold?: number;
  signal?: AbortSignal;
}

export interface PolyphonicResult {
  notes: TranscribedNote[];
  confidence: number;
  /** Mean number of simultaneous notes over active frames. */
  meanPolyphony: number;
  tuningCents: number;
}

interface PeakFrame {
  pitch: Float32Array;
  amp: Float32Array;
}

const SLOT_RES = 10; // slots per semitone

export function transcribePolyphonic(buf: AudioData, opts: PolyphonicOptions = {}): PolyphonicResult {
  const { x, sr } = prepareMono(buf);
  return transcribePolyphonicSignal(x, sr, opts);
}

export function transcribePolyphonicSignal(x: Float32Array, sr: number, opts: PolyphonicOptions = {}): PolyphonicResult {
  const minPitch = Math.max(12, Math.round(opts.minPitch ?? 36));
  const maxPitch = Math.min(120, Math.round(opts.maxPitch ?? 96));
  const maxPoly = Math.max(1, opts.maxPolyphony ?? 6);
  const empty: PolyphonicResult = { notes: [], confidence: 0, meanPolyphony: 0, tuningCents: 0 };
  if (x.length < sr * 0.1 || maxPitch <= minPitch) return empty;
  const fftSize = pow2ForDuration(0.186, sr, 1024, 16384);
  const hop = Math.max(1, Math.round((opts.hopSeconds ?? 0.0232) * sr));
  const hopSec = hop / sr;
  const nb = (fftSize >> 1) + 1;
  const binHz = sr / fftSize;
  const fMin = Math.max(25, 440 * Math.pow(2, (minPitch - 1 - 69) / 12));
  const fMax = Math.min(sr * 0.45, 6000);
  const kMin = Math.floor(fMin / binHz);
  const kMax = Math.ceil(fMax / binHz);

  // ---- pass 1: spectral peaks -----------------------------------------------------------------
  const frames: PeakFrame[] = [];
  let globalMax = 0;
  const mag = new Float32Array(nb);
  forEachStftFrame(x, { fftSize, hop }, (t, re, im) => {
    if ((t & 255) === 0) throwIfAborted(opts.signal);
    let fmax = 0;
    for (let k = 0; k < nb; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      if (k >= kMin && k <= kMax && mag[k] > fmax) fmax = mag[k];
    }
    if (fmax > globalMax) globalMax = fmax;
    const pk = framePeaks(mag, 0, nb, binHz, kMin, kMax, fmax * 0.003, 80);
    const pitch = new Float32Array(pk.freq.length);
    for (let i = 0; i < pitch.length; i++) pitch[i] = 69 + 12 * Math.log2(pk.freq[i] / 440);
    frames.push({ pitch, amp: Float32Array.from(pk.amp) });
  });
  const T = frames.length;
  const absThr = globalMax * 10 ** (-60 / 20);
  // tuning
  let tuningCents = 0;
  {
    const ps: number[] = [];
    const ws: number[] = [];
    for (const f of frames) {
      let m = 0;
      for (let i = 0; i < f.amp.length; i++) if (f.amp[i] > m) m = f.amp[i];
      for (let i = 0; i < f.amp.length; i++) {
        if (f.amp[i] > m * 0.15 && f.amp[i] > absThr * 10) {
          ps.push(f.pitch[i]);
          ws.push(f.amp[i]);
        }
      }
    }
    const tun = estimateTuning(ps, ws);
    const delta = tun.strength > 0.25 ? tun.offset : 0;
    if (delta !== 0) for (const f of frames) for (let i = 0; i < f.pitch.length; i++) f.pitch[i] -= delta;
    tuningCents = Math.round(delta * 100);
  }

  // ---- pass 2: iterative estimation & cancellation per frame --------------------------------
  const P = maxPitch - minPitch + 1;
  const H = 12;
  const lo = minPitch - 1;
  const hiPitch = maxPitch + 12 * Math.log2(H) + 1;
  const numSlots = Math.ceil((hiPitch - lo) * SLOT_RES) + 1;
  const slotPeak = new Int32Array(numSlots);
  const harmOffset: number[] = [];
  const harmWeight: number[] = [];
  for (let h = 1; h <= H; h++) {
    harmOffset.push(12 * Math.log2(h));
    harmWeight.push(1 / Math.pow(h, 0.8));
  }
  const act = new Float32Array(T * P); // salience of detected pitches
  const energyAct = new Float32Array(T * P); // summed partial amplitude of detected pitches
  const sal = new Float32Array(P);
  const partialPeak = new Int32Array(H);
  const partialAmp = new Float32Array(H);
  let activeFrames = 0;
  let polySum = 0;
  for (let t = 0; t < T; t++) {
    if ((t & 511) === 0) throwIfAborted(opts.signal);
    const f = frames[t];
    const np = f.pitch.length;
    if (np === 0) continue;
    const resid = Float32Array.from(f.amp);
    slotPeak.fill(-1);
    for (let i = 0; i < np; i++) {
      if (f.amp[i] <= absThr) continue;
      const s = Math.round((f.pitch[i] - lo) * SLOT_RES);
      if (s < 0 || s >= numSlots) continue;
      if (slotPeak[s] < 0 || f.amp[i] > f.amp[slotPeak[s]]) slotPeak[s] = i;
    }
    const findPeak = (q: number, tolSlots: number): number => {
      const c = Math.round((q - lo) * SLOT_RES);
      let best = -1;
      let bv = 0;
      for (let s = Math.max(0, c - tolSlots); s <= Math.min(numSlots - 1, c + tolSlots); s++) {
        const i = slotPeak[s];
        if (i < 0) continue;
        const w = 1 - Math.abs(s - c) / (tolSlots + 1);
        const v = resid[i] * w;
        if (v > bv) {
          bv = v;
          best = i;
        }
      }
      return best;
    };
    const detected: number[] = [];
    let firstSal = 0;
    for (let iter = 0; iter < maxPoly; iter++) {
      // salience of every candidate
      let bestP = -1;
      let bestV = 0;
      for (let pi = 0; pi < P; pi++) {
        if (detected.includes(pi)) {
          sal[pi] = 0;
          continue;
        }
        const p0 = minPitch + pi;
        const f0 = 440 * Math.pow(2, (p0 - 69) / 12);
        const hMax = Math.min(H, Math.floor(fMax / f0));
        let s = 0;
        let strongest = 0;
        let fund = 0;
        for (let h = 0; h < hMax; h++) {
          const tol = h < 4 ? 4 : 5; // ±0.4–0.5 semitone (inharmonicity)
          const i = findPeak(p0 + harmOffset[h], tol);
          if (i < 0) continue;
          const a = resid[i];
          if (a <= 0) continue;
          s += harmWeight[h] * Math.sqrt(a);
          if (a > strongest) strongest = a;
          if (h === 0) fund = a;
        }
        // A candidate whose own fundamental is missing is most likely a "virtual pitch" below a
        // chord (C3 under C-E-G). Very low notes are allowed weaker fundamentals.
        if (strongest > 0 && fund < (p0 < 48 ? 0.03 : 0.07) * strongest) s *= 0.25;
        sal[pi] = s;
        if (s > bestV) {
          bestV = s;
          bestP = pi;
        }
      }
      if (bestP < 0) break;
      if (iter === 0) firstSal = bestV;
      else if (bestV < 0.3 * firstSal) break;
      // estimate partial amplitudes and subtract with spectral smoothness
      const p0 = minPitch + bestP;
      const f0 = 440 * Math.pow(2, (p0 - 69) / 12);
      const hMax = Math.min(H, Math.floor(fMax / f0));
      for (let h = 0; h < hMax; h++) {
        const i = findPeak(p0 + harmOffset[h], h < 4 ? 4 : 5);
        partialPeak[h] = i;
        partialAmp[h] = i >= 0 ? resid[i] : 0;
      }
      let energy = 0;
      for (let h = 0; h < hMax; h++) {
        const i = partialPeak[h];
        if (i < 0) continue;
        // spectral smoothness: a partial much stronger than its neighbours is shared with
        // another note, so only the "smooth" part is attributed to this F0
        const a0 = h > 0 ? partialAmp[h - 1] : Infinity;
        const a2 = h + 1 < hMax && partialPeak[h + 1] >= 0 ? partialAmp[h + 1] : Infinity;
        let lim = Math.min(a0, a2);
        if (!Number.isFinite(lim)) lim = partialAmp[h];
        const smooth = Math.max(lim, (partialAmp[0] || partialAmp[h]) * Math.pow(h + 1, -0.8));
        const sub = Math.min(partialAmp[h], 1.35 * smooth);
        resid[i] = Math.max(0, resid[i] - sub);
        energy += sub;
      }
      detected.push(bestP);
      act[t * P + bestP] = bestV;
      energyAct[t * P + bestP] = energy;
    }
    if (detected.length) {
      activeFrames++;
      polySum += detected.length;
    }
  }

  // ---- note tracking ------------------------------------------------------------------------------
  const nonzero: number[] = [];
  for (let i = 0; i < act.length; i++) if (act[i] > 0) nonzero.push(act[i]);
  if (!nonzero.length) return { ...empty, tuningCents };
  const ref = percentile(nonzero, 98) || 1;
  const onThr = opts.onsetThreshold ?? 0.16;
  const offThr = opts.frameThreshold ?? 0.07;
  const minLen = Math.max(2, Math.round((opts.minNoteSeconds ?? 0.07) / hopSec));
  type Raw = { pi: number; a: number; b: number; peak: number; sum: number; energy: number };
  const raws: Raw[] = [];
  const v = new Float32Array(T);
  for (let pi = 0; pi < P; pi++) {
    for (let t = 0; t < T; t++) v[t] = act[t * P + pi] / ref;
    let t = 0;
    let lastEnd = 0;
    while (t < T) {
      if (v[t] < onThr) {
        t++;
        continue;
      }
      // the attack may start a little before the first strong frame
      let a = t;
      while (a > lastEnd && v[a - 1] >= offThr && v[a - 1] < v[a]) a--;
      let b = t;
      let gap = 0;
      let peak = 0;
      let runMin = Infinity;
      let sum = 0;
      let energy = 0;
      let lastActive = t;
      while (b < T) {
        const cur = v[b];
        if (cur >= offThr) {
          // re-strike of the same pitch: strong rise after a clear dip
          if (b - a >= minLen && cur > onThr && runMin < 0.5 * peak && cur > 2.5 * runMin) break;
          gap = 0;
          if (cur > peak) {
            peak = cur;
            runMin = cur;
          } else runMin = Math.min(runMin, cur);
          sum += cur;
          energy = Math.max(energy, energyAct[b * P + pi]);
          lastActive = b;
        } else {
          gap++;
          runMin = Math.min(runMin, cur);
          if (gap > 2) break;
        }
        b++;
      }
      const end = lastActive + 1;
      if (end - a >= minLen) raws.push({ pi, a, b: end, peak, sum, energy });
      lastEnd = end;
      t = Math.max(b, t + 1);
    }
  }
  // harmonic-ghost removal: a weak note fully covered by a strong note 12/19/24 semitones below
  const ghost = new Set<Raw>();
  for (const r of raws) {
    for (const o of raws) {
      if (o === r) continue;
      const iv = r.pi - o.pi;
      if (iv !== 12 && iv !== 19 && iv !== 24) continue;
      const overlap = Math.min(r.b, o.b) - Math.max(r.a, o.a);
      if (overlap >= 0.8 * (r.b - r.a) && r.peak < 0.35 * o.peak) ghost.add(r);
    }
  }
  const kept = raws.filter((r) => !ghost.has(r));
  // onset snapping
  const env = onsetEnvelopeFromSignal(x, sr);
  const onsetFrames = pickOnsetPeaks(env.envelope, env.hopSeconds, { delta: 0.05, floor: 0.03 });
  const onsets = onsetFrames.map((f) => f * env.hopSeconds);
  const energies = kept.map((r) => linToDb(r.energy));
  const refDb = percentile(energies, 90);
  const notes: TranscribedNote[] = kept.map((r, i) => {
    // The long analysis window sees a note ≈ half a window early and lets it ring ≈ that long
    // after it stops: snap starts to the nearest flux onset (usually later) and trim the tail.
    let start = Math.max(0, r.a * hopSec);
    let best = Infinity;
    for (const o of onsets) {
      const d = o - start;
      if (d >= -0.06 && d <= 0.13 && Math.abs(d - 0.03) < Math.abs(best - 0.03)) best = d;
    }
    if (Number.isFinite(best)) start = Math.max(0, start + best);
    const end = Math.max(start + Math.max(hopSec, 0.05), r.b * hopSec - 0.04);
    const dur = end - start;
    const meanAct = r.sum / Math.max(1, r.b - r.a);
    const conf = clamp01((0.25 + 0.65 * Math.tanh(meanAct / 0.35)) * Math.sqrt(Math.min(1, dur / 0.15)) * 0.9);
    return {
      pitch: minPitch + r.pi,
      startSeconds: Math.round(start * 1e4) / 1e4,
      endSeconds: Math.round(end * 1e4) / 1e4,
      velocity: Math.round(clamp(96 + 1.8 * (energies[i] - refDb), 15, 127)),
      confidence: Math.round(conf * 1000) / 1000,
    };
  });
  notes.sort((a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch);
  let wsum = 0;
  let csum = 0;
  for (const n of notes) {
    const d = n.endSeconds - n.startSeconds;
    wsum += d;
    csum += d * n.confidence;
  }
  return {
    notes,
    confidence: wsum > 0 ? Math.round((csum / wsum) * 1000) / 1000 : 0,
    meanPolyphony: activeFrames ? polySum / activeFrames : 0,
    tuningCents,
  };
}
