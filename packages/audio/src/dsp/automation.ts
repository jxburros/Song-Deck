/**
 * Automation lanes (spec §40): every AutomationParam, linear or step interpolation between points,
 * evaluated per render block (≤ 64 samples). Track lanes target a track id, master lanes "master".
 */
import type { AutomationLane, AutomationParam } from '@songdeck/core';

export const AUTO_PARAMS: AutomationParam[] = [
  'volumeDb',
  'pan',
  'reverbSend',
  'delaySend',
  'width',
  'drive',
  'eq.lowShelfDb',
  'eq.lowMidDb',
  'eq.highMidDb',
  'eq.highShelfDb',
  'eq.lowpassHz',
  'eq.highpassHz',
];

export const AP_VOLUME = 0;
export const AP_PAN = 1;
export const AP_REVERB = 2;
export const AP_DELAY = 3;
export const AP_WIDTH = 4;
export const AP_DRIVE = 5;
export const AP_LOWSHELF = 6;
export const AP_LOWMID = 7;
export const AP_HIGHMID = 8;
export const AP_HIGHSHELF = 9;
export const AP_LOWPASS = 10;
export const AP_HIGHPASS = 11;
export const AP_COUNT = 12;

export class LaneEval {
  readonly frames: Float64Array;
  readonly values: Float64Array;
  readonly step: Uint8Array;
  private cur = 0;

  constructor(
    readonly target: string,
    readonly paramIndex: number,
    points: { frame: number; value: number; step: boolean }[],
  ) {
    const pts = [...points].sort((a, b) => a.frame - b.frame);
    this.frames = Float64Array.from(pts, (p) => p.frame);
    this.values = Float64Array.from(pts, (p) => p.value);
    this.step = Uint8Array.from(pts, (p) => (p.step ? 1 : 0));
  }

  valueAt(frame: number): number {
    const fr = this.frames;
    const n = fr.length;
    if (n === 0) return NaN;
    if (frame <= fr[0]) {
      this.cur = 0;
      return this.values[0];
    }
    if (frame >= fr[n - 1]) {
      this.cur = n - 1;
      return this.values[n - 1];
    }
    let c = this.cur;
    if (c >= n - 1 || fr[c] > frame) c = 0;
    while (c + 1 < n && fr[c + 1] <= frame) c++;
    this.cur = c;
    const v0 = this.values[c];
    if (this.step[c]) return v0;
    const f0 = fr[c], f1 = fr[c + 1];
    const t = f1 > f0 ? (frame - f0) / (f1 - f0) : 0;
    return v0 + (this.values[c + 1] - v0) * t;
  }
}

/** Build evaluators from lanes; `toFrame` maps ticks to render frames. */
export function buildLanes(lanes: AutomationLane[], toFrame: (tick: number) => number): LaneEval[] {
  const out: LaneEval[] = [];
  for (const lane of lanes ?? []) {
    if (!lane || lane.enabled === false || !lane.points?.length) continue;
    const idx = AUTO_PARAMS.indexOf(lane.param);
    if (idx < 0) continue;
    const pts = lane.points
      .filter((p) => Number.isFinite(p.tick) && Number.isFinite(p.value))
      .map((p) => ({ frame: toFrame(p.tick), value: p.value, step: p.curve === 'step' }));
    if (!pts.length) continue;
    out.push(new LaneEval(lane.target, idx, pts));
  }
  return out;
}
