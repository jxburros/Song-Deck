/**
 * Built-in DSP mastering (spec §42). Chain:
 *   loudness pre-normalization → DC/subsonic high-pass (4th order) → tone tilt (settings.tone) →
 *   glue compression → M/S width (settings.width) → [gain → soft clip → true-peak-aware lookahead
 *   limiter (4× oversampled detection)] iterated (secant search) until the integrated loudness is
 *   within ±0.5 LU of the preset target (typically ±0.1) with true peak ≤ the preset ceiling.
 */
import type { MasteringSettings, MasteringTarget } from '@songdeck/core';
import type { AudioData } from '../types';
import { Compressor } from './effects/compressor';
import { LookaheadLimiter } from './effects/limiter';
import { Biquad } from './filters';
import { integratedLoudness, measureLoudness, truePeakEnvelope, truePeakLinear } from './loudness';
import { MIN_DB, clampNum, num } from './utils';

export interface MasteringPreset {
  id: MasteringTarget;
  name: string;
  description: string;
  /** Integrated loudness target (LUFS). */
  targetLufs: number;
  /** True-peak ceiling (dBTP). */
  truePeakDb: number;
  /** Subsonic high-pass (Hz). */
  lowCutHz: number;
  /** Glue compressor (threshold relative to a -18 LUFS-normalized program). */
  glue: { thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; kneeDb: number };
  /** Soft-clip knee as a fraction of the ceiling (1 = off). */
  softClipKnee: number;
  limiterLookaheadMs: number;
  limiterReleaseMs: number;
  /** Max stereo width allowed (podcast: mono-safe). */
  maxWidth: number;
}

export const MASTERING_PRESETS: Record<MasteringTarget, MasteringPreset> = {
  streaming: {
    id: 'streaming',
    name: 'Streaming',
    description: '-14 LUFS integrated, -1 dBTP: matches Spotify / YouTube / Apple Music normalization without extra limiting.',
    targetLufs: -14,
    truePeakDb: -1,
    lowCutHz: 25,
    glue: { thresholdDb: -14, ratio: 1.8, attackMs: 30, releaseMs: 200, kneeDb: 6 },
    softClipKnee: 0.9,
    limiterLookaheadMs: 3,
    limiterReleaseMs: 120,
    maxWidth: 2,
  },
  cd: {
    id: 'cd',
    name: 'CD / Loud master',
    description: '-9 LUFS, -0.3 dBTP: competitive loudness for CD and downloads.',
    targetLufs: -9,
    truePeakDb: -0.3,
    lowCutHz: 25,
    glue: { thresholdDb: -16, ratio: 2.2, attackMs: 20, releaseMs: 150, kneeDb: 6 },
    softClipKnee: 0.75,
    limiterLookaheadMs: 2.5,
    limiterReleaseMs: 90,
    maxWidth: 2,
  },
  'loud-rock': {
    id: 'loud-rock',
    name: 'Loud Rock',
    description: '-8 LUFS, -0.5 dBTP: dense, saturated rock/metal master.',
    targetLufs: -8,
    truePeakDb: -0.5,
    lowCutHz: 30,
    glue: { thresholdDb: -17, ratio: 2.5, attackMs: 15, releaseMs: 120, kneeDb: 6 },
    softClipKnee: 0.65,
    limiterLookaheadMs: 2,
    limiterReleaseMs: 70,
    maxWidth: 2,
  },
  dynamic: {
    id: 'dynamic',
    name: 'Dynamic',
    description: '-18 LUFS, -1 dBTP: preserves dynamics (classical, jazz, film).',
    targetLufs: -18,
    truePeakDb: -1,
    lowCutHz: 20,
    glue: { thresholdDb: -10, ratio: 1.4, attackMs: 40, releaseMs: 300, kneeDb: 8 },
    softClipKnee: 1,
    limiterLookaheadMs: 4,
    limiterReleaseMs: 200,
    maxWidth: 2,
  },
  podcast: {
    id: 'podcast',
    name: 'Podcast / Spoken',
    description: '-16 LUFS, -1 dBTP, mono-compatible width, rumble filter.',
    targetLufs: -16,
    truePeakDb: -1,
    lowCutHz: 70,
    glue: { thresholdDb: -16, ratio: 2.5, attackMs: 15, releaseMs: 150, kneeDb: 6 },
    softClipKnee: 0.9,
    limiterLookaheadMs: 3,
    limiterReleaseMs: 120,
    maxWidth: 1,
  },
  demo: {
    id: 'demo',
    name: 'Demo',
    description: '-12 LUFS, -1 dBTP: balanced loudness for sharing demos.',
    targetLufs: -12,
    truePeakDb: -1,
    lowCutHz: 25,
    glue: { thresholdDb: -15, ratio: 2, attackMs: 25, releaseMs: 180, kneeDb: 6 },
    softClipKnee: 0.85,
    limiterLookaheadMs: 3,
    limiterReleaseMs: 100,
    maxWidth: 2,
  },
};

export interface MasteringReport {
  preLufs: number;
  postLufs: number;
  truePeakDb: number;
  /** Total gain change at the loudness stage (dB). */
  gainDb: number;
  lra: number;
  target: MasteringTarget;
  /** Iterations of the loudness search. */
  iterations: number;
}

export interface MasteringResult {
  output: AudioData;
  report: MasteringReport;
}

function toF64(buf: AudioData): Float64Array[] {
  return buf.channels.slice(0, 2).map((c) => Float64Array.from(c));
}

function toAudio(chs: Float64Array[], sr: number): AudioData {
  return {
    sampleRate: sr,
    channels: chs.map((c) => {
      const f = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) {
        const v = c[i];
        f[i] = Number.isFinite(v) ? v : 0;
      }
      return f;
    }),
  };
}

function stereoPairs(chs: Float64Array[]): [Float64Array, Float64Array] {
  return chs.length > 1 ? [chs[0], chs[1]] : [chs[0], chs[0]];
}

/** Master `input` towards the preset of `settings.target`. */
export function masterAudio(input: AudioData, settings: MasteringSettings, opts: { onProgress?(p: number): void } = {}): MasteringResult {
  const target: MasteringTarget = MASTERING_PRESETS[settings?.target] ? settings.target : 'streaming';
  const preset = MASTERING_PRESETS[target];
  const sr = input.sampleRate;
  const pre = measureLoudness(input);
  opts.onProgress?.(0.05);
  if (settings?.method === 'none' || !input.channels.length || !input.channels[0].length) {
    const out = { sampleRate: sr, channels: input.channels.map((c) => new Float32Array(c)) };
    return { output: out, report: { preLufs: pre.integratedLufs, postLufs: pre.integratedLufs, truePeakDb: pre.truePeakDb, gainDb: 0, lra: pre.lra, target, iterations: 0 } };
  }
  const chs = toF64(input);
  const n = chs[0].length;
  const isStereo = chs.length > 1;
  // 1) pre-normalize to -18 LUFS so the glue compressor thresholds are program-relative
  const preGainDb = pre.integratedLufs > MIN_DB + 1 ? clampNum(-18 - pre.integratedLufs, -40, 40) : 0;
  const pg = Math.pow(10, preGainDb / 20);
  for (const c of chs) for (let i = 0; i < n; i++) c[i] *= pg;
  // 2) DC / subsonic high-pass (Butterworth 4th order)
  const hp1 = new Biquad().design('highpass', preset.lowCutHz, 0.5412, 0, sr);
  const hp2 = new Biquad().design('highpass', preset.lowCutHz, 1.3066, 0, sr);
  // 3) tone tilt around ~1 kHz
  const tone = clampNum(num(settings.tone, 0), -1, 1);
  const ls = new Biquad().design('lowshelf', 250, 0.8, -tone * 2.5, sr);
  const hs = new Biquad().design('highshelf', 4000, 0.8, tone * 3, sr);
  const [L, R] = stereoPairs(chs);
  if (isStereo) {
    hp1.processStereo(L, R, 0, n);
    hp2.processStereo(L, R, 0, n);
    if (tone !== 0) {
      ls.processStereo(L, R, 0, n);
      hs.processStereo(L, R, 0, n);
    }
  } else {
    hp1.processMono(L, 0, n);
    hp2.processMono(L, 0, n);
    if (tone !== 0) {
      ls.processMono(L, 0, n);
      hs.processMono(L, 0, n);
    }
  }
  // 4) glue compression (stereo linked)
  const comp = new Compressor(sr);
  comp.configure({ ...preset.glue, makeupDb: 0 });
  if (isStereo) comp.process(L, R, 0, n);
  else {
    const dup = Float64Array.from(L);
    comp.process(L, dup, 0, n);
  }
  // 5) width
  const width = Math.min(preset.maxWidth, clampNum(num(settings.width, 1), 0, 2));
  if (isStereo && width !== 1) {
    for (let i = 0; i < n; i++) {
      const m = (L[i] + R[i]) * 0.5;
      const s = (L[i] - R[i]) * 0.5 * width;
      L[i] = m + s;
      R[i] = m - s;
    }
  }
  opts.onProgress?.(0.2);
  const base = { sampleRate: sr, channels: chs.map((c) => c as unknown as Float32Array) } as AudioData;
  const baseLufs = integratedLoudness(base);
  if (baseLufs <= MIN_DB + 1) {
    const out = toAudio(chs, sr);
    const m = measureLoudness(out);
    return { output: out, report: { preLufs: pre.integratedLufs, postLufs: m.integratedLufs, truePeakDb: m.truePeakDb, gainDb: preGainDb, lra: m.lra, target, iterations: 0 } };
  }
  // 6) loudness search: gain → soft clip → true-peak limiter
  const ceilDb = preset.truePeakDb - 0.12;
  const ceil = Math.pow(10, ceilDb / 20);
  const work = chs.map((c) => new Float64Array(c.length));
  const tpEnv = new Float64Array(n);
  const tpTmp = new Float64Array(n);
  const la = Math.max(16, Math.round((preset.limiterLookaheadMs / 1000) * sr));
  const knee = preset.softClipKnee;
  const run = (gainDb: number): number => {
    const g = Math.pow(10, gainDb / 20);
    const t = knee * ceil * 1.12; // soft clip slightly above the limiter ceiling
    const span = ceil * 1.12 - t;
    for (let c = 0; c < chs.length; c++) {
      const src = chs[c], dst = work[c];
      for (let i = 0; i < n; i++) {
        let x = src[i] * g;
        if (knee < 1) {
          const a = x < 0 ? -x : x;
          if (a > t) {
            const y = t + span * Math.tanh((a - t) / span);
            x = x < 0 ? -y : y;
          }
        }
        dst[i] = x;
      }
    }
    // true-peak detector (max over channels)
    truePeakEnvelope(work[0], tpEnv);
    for (let c = 1; c < work.length; c++) {
      truePeakEnvelope(work[c], tpTmp);
      for (let i = 0; i < n; i++) if (tpTmp[i] > tpEnv[i]) tpEnv[i] = tpTmp[i];
    }
    const lim = new LookaheadLimiter(sr, la);
    lim.configure(ceilDb, preset.limiterReleaseMs);
    lim.processOffline(work, tpEnv);
    return integratedLoudness({ sampleRate: sr, channels: work as unknown as Float32Array[] });
  };
  let g0 = preset.targetLufs - baseLufs;
  let l0 = run(g0);
  let iterations = 1;
  let bestG = g0, bestErr = Math.abs(preset.targetLufs - l0);
  let g1 = g0 + (preset.targetLufs - l0);
  for (let it = 0; it < 8 && bestErr > 0.1; it++) {
    const l1 = run(g1);
    iterations++;
    const err = Math.abs(preset.targetLufs - l1);
    if (err < bestErr) {
      bestErr = err;
      bestG = g1;
    }
    opts.onProgress?.(0.2 + 0.7 * Math.min(1, (it + 1) / 6));
    if (err <= 0.1) break;
    const slope = Math.abs(g1 - g0) > 1e-6 ? (l1 - l0) / (g1 - g0) : 1;
    const next = g1 + (preset.targetLufs - l1) / clampNum(slope, 0.15, 1.5);
    g0 = g1;
    l0 = l1;
    g1 = clampNum(next, g1 - 12, g1 + 12);
  }
  // final render at the best gain (if the last run was not the best)
  if (bestG !== g1 || bestErr > 0.1) run(bestG);
  let out = toAudio(work, sr);
  // guarantee the ceiling on the float32 result
  let tp = 0;
  for (const c of out.channels) tp = Math.max(tp, truePeakLinear(c));
  const limitLin = Math.pow(10, preset.truePeakDb / 20);
  if (tp > limitLin) {
    const trim = (limitLin / tp) * 0.9995;
    out = { sampleRate: sr, channels: out.channels.map((c) => Float32Array.from(c, (v) => v * trim)) };
  }
  opts.onProgress?.(0.97);
  const post = measureLoudness(out);
  opts.onProgress?.(1);
  return {
    output: out,
    report: {
      preLufs: pre.integratedLufs,
      postLufs: post.integratedLufs,
      truePeakDb: post.truePeakDb,
      gainDb: preGainDb + bestG,
      lra: post.lra,
      target,
      iterations,
    },
  };
}
