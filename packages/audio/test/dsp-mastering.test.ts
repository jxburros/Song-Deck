import { describe, expect, it } from 'vitest';
import type { MasteringTarget } from '@songdeck/core';
import { MASTERING_PRESETS, masterAudio, measureLoudness, renderSong } from '../src/dsp';
import type { AudioData } from '../src/types';
import { bandSong, hasNonFinite, peak } from './dsp-helpers';

const SR = 44100;

let mix: AudioData | null = null;
function getMix(): AudioData {
  if (!mix) mix = renderSong(bandSong(4), { sampleRate: SR, applyMaster: false, tailSeconds: 1 });
  return mix;
}

describe('mastering', () => {
  it('defines the six presets with their loudness / true-peak targets', () => {
    const expected: Record<MasteringTarget, [number, number]> = {
      streaming: [-14, -1],
      cd: [-9, -0.3],
      'loud-rock': [-8, -0.5],
      dynamic: [-18, -1],
      podcast: [-16, -1],
      demo: [-12, -1],
    };
    for (const [k, [lufs, tp]] of Object.entries(expected) as [MasteringTarget, [number, number]][]) {
      expect(MASTERING_PRESETS[k].targetLufs).toBe(lufs);
      expect(MASTERING_PRESETS[k].truePeakDb).toBe(tp);
      expect(MASTERING_PRESETS[k].id).toBe(k);
      expect(MASTERING_PRESETS[k].name.length).toBeGreaterThan(0);
    }
  });

  for (const target of Object.keys(MASTERING_PRESETS) as MasteringTarget[]) {
    it(`hits the ${target} target within ±0.5 LU with true peak ≤ ceiling`, () => {
      const input = getMix();
      const progress: number[] = [];
      const { output, report } = masterAudio(input, { method: 'builtin', target, tone: 0, width: 1 }, { onProgress: (p) => progress.push(p) });
      const preset = MASTERING_PRESETS[target];
      const m = measureLoudness(output);
      expect(Math.abs(m.integratedLufs - preset.targetLufs)).toBeLessThanOrEqual(0.5);
      expect(m.truePeakDb).toBeLessThanOrEqual(preset.truePeakDb + 1e-6);
      expect(report.postLufs).toBeCloseTo(m.integratedLufs, 6);
      expect(report.truePeakDb).toBeCloseTo(m.truePeakDb, 6);
      expect(report.target).toBe(target);
      expect(report.preLufs).toBeCloseTo(measureLoudness(input).integratedLufs, 6);
      expect(output.channels[0].length).toBe(input.channels[0].length);
      expect(progress[progress.length - 1]).toBe(1);
      expect(hasNonFinite(output)).toBe(false);
    });
  }

  it('applies tone tilt and width, keeps mono input mono, and passes through with method none', () => {
    const input = getMix();
    const dark = masterAudio(input, { method: 'builtin', target: 'demo', tone: -1, width: 1 }).output;
    const bright = masterAudio(input, { method: 'builtin', target: 'demo', tone: 1, width: 1 }).output;
    // compare high-frequency energy via first difference RMS
    const hf = (x: Float32Array) => {
      let s = 0;
      for (let i = 1; i < x.length; i++) s += (x[i] - x[i - 1]) ** 2;
      return s;
    };
    expect(hf(bright.channels[0])).toBeGreaterThan(hf(dark.channels[0]) * 1.2);
    const narrow = masterAudio(input, { method: 'builtin', target: 'demo', tone: 0, width: 0 }).output;
    let side = 0;
    for (let i = 0; i < narrow.channels[0].length; i++) side += Math.abs(narrow.channels[0][i] - narrow.channels[1][i]);
    expect(side / narrow.channels[0].length).toBeLessThan(1e-6);
    const mono = masterAudio({ sampleRate: SR, channels: [input.channels[0]] }, { method: 'builtin', target: 'streaming', tone: 0, width: 1 });
    expect(mono.output.channels.length).toBe(1);
    expect(Math.abs(mono.report.postLufs - -14)).toBeLessThanOrEqual(0.5);
    const none = masterAudio(input, { method: 'none', target: 'streaming', tone: 0, width: 1 });
    let same = none.output.channels[0].length === input.channels[0].length;
    for (let i = 0; same && i < input.channels[0].length; i++) same = none.output.channels[0][i] === input.channels[0][i];
    expect(same).toBe(true);
    expect(none.report.gainDb).toBe(0);
  });

  it('handles silence without NaN', () => {
    const silent: AudioData = { sampleRate: SR, channels: [new Float32Array(SR), new Float32Array(SR)] };
    const { output, report } = masterAudio(silent, { method: 'builtin', target: 'streaming', tone: 0, width: 1 });
    expect(report.postLufs).toBe(-144);
    expect(peak(output.channels[0])).toBe(0);
    expect(peak(output.channels[1])).toBe(0);
  });
});
