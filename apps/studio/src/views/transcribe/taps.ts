import { PPQ, type KeySignature, type Note } from '@songdeck/core';
import { tapsToNotes } from '@songdeck/audio';
import type { TranscriptionView } from './model';

export interface TapOptions {
  bpm: number;
  bpmSource: TranscriptionView['bpmSource'];
  /** Quantize grid in beats. */
  gridBeats: number;
  pitch: number;
  drums: boolean;
  meter: { numerator: number; denominator: number };
  key?: KeySignature;
}

/**
 * Tapped rhythm → notes (spec §27 "tap a rhythm") via the engine's `tapsToNotes`. The first tap is
 * bar 1, beat 1. The engine treats taps as certain; here each note's confidence reflects how far
 * the tap was from its grid line (near the line = certain, halfway between two lines = a coin toss),
 * and "rhythm on one note" taps are held until the next tap (up to a beat).
 */
export function tapNotes(taps: number[], o: TapOptions): Note[] {
  if (!taps.length) return [];
  const notes = tapsToNotes(taps, {
    bpm: o.bpm,
    drum: o.pitch,
    quantizeBeats: o.gridBeats,
    ppq: PPQ,
    offsetSeconds: taps[0],
    velocities: taps.map((_, i) => (i === 0 ? 112 : 100)),
    durationBeats: o.drums ? 0.25 : Math.max(0.25, o.gridBeats),
  });
  const grid = Math.max(1, Math.round(o.gridBeats * PPQ));
  const raw = taps.map((t) => ((t - taps[0]) * o.bpm * PPQ) / 60);
  return notes.map((n, i) => {
    let best = Infinity;
    for (const r of raw) best = Math.min(best, Math.abs(r - n.tick));
    // Normal tapping jitter (a few tens of ms) stays confident; a tap halfway between two grid
    // lines is a coin toss (0.5).
    const dev = Math.min(1, best / (grid / 2));
    const out: Note = { ...n, confidence: Math.round((1 - 0.5 * dev * dev) * 100) / 100 };
    if (!o.drums) {
      const next = notes[i + 1];
      out.duration = Math.max(n.duration, Math.min(PPQ, (next ? next.tick : n.tick + PPQ) - n.tick));
    }
    return out;
  });
}

export function tapsToTranscription(taps: number[], o: TapOptions): TranscriptionView {
  const notes = tapNotes(taps, o);
  const barTicks = (o.meter.numerator * 4 * PPQ) / o.meter.denominator;
  const last = notes.reduce((m, n) => Math.max(m, n.tick + n.duration), 0);
  const conf = notes.length ? notes.reduce((a, n) => a + (n.confidence ?? 1), 0) / notes.length : 0;
  const warnings: string[] = [];
  if (notes.length < taps.length) warnings.push(`${taps.length - notes.length} tap(s) landed on the same grid position and were merged — try a finer grid.`);
  return {
    notes,
    drums: o.drums,
    ppq: PPQ,
    bpm: o.bpm,
    bpmSource: o.bpmSource,
    bpmConfidence: o.bpmSource === 'taps' ? (taps.length >= 6 ? 0.75 : 0.5) : undefined,
    key: o.key,
    keySource: o.key ? 'project' : 'none',
    meter: o.meter,
    confidence: conf,
    method: 'Tap rhythm (timing quantized to the grid)',
    warnings,
    suggestedInstrumentId: o.drums ? 'drum-kit' : 'piano',
    role: o.drums ? 'drums' : 'keys',
    bars: Math.max(1, Math.ceil(last / barTicks - 1e-9)),
    offsetSeconds: taps[0] ?? 0,
    raw: { taps },
  };
}
