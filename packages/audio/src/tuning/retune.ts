/**
 * Pitch correction ("autotune") of a monophonic recording towards target notes: the recording's
 * pitch is tracked (YIN), each note's sung pitch centre and drift are measured, a correction
 * curve is planned from the note targets and the tuning settings, and the audio is resynthesised
 * with that curve (TD-PSOLA). Timing is never changed: notes only say which pitch the audio
 * under them should have.
 */
import type { AudioData } from '../types';
import { trackPitch, type PitchTrack } from '../analysis/pitch-yin';
import { pitchMarks, psolaResynthesize } from './psola';

export interface RetuneNote {
  startSeconds: number;
  endSeconds: number;
  /** Target MIDI pitch. */
  pitch: number;
}

export interface RetuneSettings {
  /** 0..1 pull of each note's pitch centre onto its exact target (whole-semitone moves always apply). */
  amount: number;
  /** 0..1 flattening of drift and vibrato around each note's centre. */
  flatten: number;
  /** Glide time of the correction in ms (0 = instant). */
  speedMs: number;
}

export interface RetuneOptions extends Partial<RetuneSettings> {
  /** Pitch search range (Hz); default from the target notes (an octave either side). */
  minHz?: number;
  maxHz?: number;
  /** Pitch analysis hop (s), default 0.005. */
  hopSeconds?: number;
}

export interface RetuneReport {
  /** Notes whose audio was corrected. */
  tunedNotes: number;
  /** Notes left alone: too little pitched sound under them. */
  skippedNotes: number;
  /** Mean correction of the tuned notes' pitch centres, in cents. */
  meanCorrectionCents: number;
  /** Largest shift applied anywhere, in semitones. */
  maxShiftSemitones: number;
}

export interface RetunePlan {
  /** Correction in semitones per pitch-track frame. */
  shift: Float32Array;
  report: RetuneReport;
}

/** Deviation from a note centre counted as drift (larger deviations are tracking errors or slides). */
const MAX_DRIFT = 2;
/** Fewest voiced frames under a note for it to be tuned. */
const MIN_VOICED_FRAMES = 3;

const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const unit = (v: number | undefined, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? clampNum(v, 0, 1) : d;

function medianOf(values: number[]): number {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[n >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

/** Forward-backward one-pole smoothing (zero phase, so glides are centred on note changes). */
function smooth(x: Float32Array, frames: number): void {
  if (!(frames > 0.5) || x.length < 2) return;
  const a = Math.exp(-1 / frames);
  let y = x[0];
  for (let i = 0; i < x.length; i++) x[i] = y = a * y + (1 - a) * x[i];
  y = x[x.length - 1];
  for (let i = x.length - 1; i >= 0; i--) x[i] = y = a * y + (1 - a) * x[i];
}

/**
 * The correction curve (semitones per pitch frame) that moves the tracked pitch towards the
 * notes. Per note, with sung centre c (median pitch) and target p:
 * shift = (p − round(c)) + amount·(round(c) − c) − flatten·(pitch − c).
 * Frames outside notes are not corrected; overlapping notes resolve to the later one.
 */
export function planRetune(
  track: PitchTrack,
  notes: RetuneNote[],
  settings: Partial<RetuneSettings> = {},
): RetunePlan {
  const amount = unit(settings.amount, 1);
  const flatten = unit(settings.flatten, 0);
  const speedMs = clampNum(Number.isFinite(settings.speedMs) ? settings.speedMs! : 0, 0, 1000);
  const hop = track.hopSeconds;
  const n = track.f0.length;
  const shift = new Float32Array(n);
  const owner = new Int32Array(n).fill(-1);
  const sorted = notes
    .map((note, i) => ({ note, i }))
    .filter(({ note }) => note.endSeconds > note.startSeconds && Number.isFinite(note.pitch))
    .sort((a, b) => a.note.startSeconds - b.note.startSeconds);
  for (const { note, i } of sorted) {
    const a = Math.max(0, Math.ceil(note.startSeconds / hop));
    const b = Math.min(n, Math.ceil(note.endSeconds / hop));
    for (let t = a; t < b; t++) owner[t] = i;
  }
  const pitch = new Float32Array(n);
  for (let t = 0; t < n; t++) pitch[t] = track.f0[t] > 0 ? hzToMidi(track.f0[t]) : NaN;
  const framesOf = new Map<number, number[]>();
  for (let t = 0; t < n; t++) {
    if (owner[t] < 0) continue;
    const list = framesOf.get(owner[t]);
    if (list) list.push(t);
    else framesOf.set(owner[t], [t]);
  }
  let tuned = 0;
  let skipped = 0;
  let correction = 0;
  for (const { note, i } of sorted) {
    const frames = framesOf.get(i) ?? [];
    const sung = frames.map((t) => pitch[t]).filter((v) => !Number.isNaN(v));
    if (sung.length < MIN_VOICED_FRAMES) {
      skipped++;
      continue;
    }
    const centre = medianOf(sung);
    const base = Math.round(centre);
    const delta = note.pitch - base + amount * (base - centre);
    tuned++;
    correction += Math.abs(delta) * 100;
    for (const t of frames) {
      const p = pitch[t];
      shift[t] = Number.isNaN(p) ? delta : delta - flatten * clampNum(p - centre, -MAX_DRIFT, MAX_DRIFT);
    }
  }
  smooth(shift, speedMs / 1000 / hop);
  let maxShift = 0;
  for (let t = 0; t < n; t++) maxShift = Math.max(maxShift, Math.abs(shift[t]));
  return {
    shift,
    report: {
      tunedNotes: tuned,
      skippedNotes: skipped,
      meanCorrectionCents: tuned ? Math.round(correction / tuned) : 0,
      maxShiftSemitones: Math.round(maxShift * 100) / 100,
    },
  };
}

function monoOf(buf: AudioData): Float32Array {
  const chs = buf.channels;
  if (chs.length === 1) return chs[0];
  const n = chs[0]?.length ?? 0;
  const out = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) out[i] += c[i] / chs.length;
  return out;
}

/** Pitch search range for the notes: an octave either side of the lowest and highest target. */
function rangeFor(notes: RetuneNote[], opts: RetuneOptions): { minHz: number; maxHz: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of notes) {
    lo = Math.min(lo, n.pitch);
    hi = Math.max(hi, n.pitch);
  }
  const minHz = opts.minHz ?? (Number.isFinite(lo) ? clampNum(midiToHz(lo - 12), 30, 800) : 50);
  const maxHz = opts.maxHz ?? (Number.isFinite(hi) ? clampNum(midiToHz(hi + 12), minHz * 2, 1600) : 1000);
  return { minHz, maxHz };
}

/**
 * Pitch-correct a monophonic recording towards `notes` (seconds from the start of `buf`). Returns
 * the corrected audio (same length, rate and channels) and what was done. Audio with nothing to
 * correct is returned as an unchanged copy.
 */
export function retuneAudio(
  buf: AudioData,
  notes: RetuneNote[],
  opts: RetuneOptions = {},
): { audio: AudioData; report: RetuneReport; plan: RetunePlan; track: PitchTrack } {
  const sr = buf.sampleRate;
  const { minHz, maxHz } = rangeFor(notes, opts);
  const track = trackPitch(buf, { minHz, maxHz, hopSeconds: opts.hopSeconds ?? 0.005 });
  const plan = planRetune(track, notes, opts);
  const copy = (): AudioData => ({ sampleRate: sr, channels: buf.channels.map((c) => Float32Array.from(c)) });
  if (!(plan.report.maxShiftSemitones > 1e-3) || !buf.channels.length)
    return { audio: copy(), report: plan.report, plan, track };
  const marks = pitchMarks(monoOf(buf), sr, { hopSeconds: track.hopSeconds, f0: track.f0 });
  const frameRate = 1 / track.hopSeconds;
  const shift = plan.shift;
  const ratioAt = (sample: number) => {
    const f = (sample / sr) * frameRate;
    const i = Math.floor(f);
    if (i < 0) return Math.pow(2, shift[0] / 12);
    if (i >= shift.length - 1) return Math.pow(2, shift[shift.length - 1] / 12);
    const semis = shift[i] + (shift[i + 1] - shift[i]) * (f - i);
    return Math.pow(2, semis / 12);
  };
  const channels = psolaResynthesize(buf.channels, marks, ratioAt);
  return { audio: { sampleRate: sr, channels }, report: plan.report, plan, track };
}
