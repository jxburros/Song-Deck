import type { ChordQuality, ChordSpec, MidiPitch } from '../ir/types';
import { CHORD_INTERVALS, chordTones } from './chords';
import { mod12 } from './pitch';

export interface VoicingOptions {
  low: MidiPitch;
  high: MidiPitch;
  /** Number of voices (default 4). */
  voices?: number;
  /** Previous voicing for voice leading (minimize total movement). */
  previous?: readonly MidiPitch[];
  /** Close (within an octave where possible) or open (drop-2). */
  spread?: 'close' | 'open';
  /** Force the chord's bass (root or slash bass) as the lowest note. */
  bassInVoicing?: boolean;
  /** Preferred centre pitch when there is no previous voicing. */
  center?: MidiPitch;
}

function movement(a: readonly number[], b: readonly number[]): number {
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  const n = Math.min(sa.length, sb.length);
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.abs(sa[i] - sb[i]);
  // Penalize voice-count mismatches.
  total += Math.abs(sa.length - sb.length) * 6;
  return total;
}

/**
 * Voice a chord within a range, minimizing movement from the previous voicing
 * (voice leading) or centring in the range. Searches all combinations of chord-tone
 * pitches in range that cover the essential tones (root, 3rd/sus, 7th).
 */
export function voiceChord(chord: ChordSpec, opts: VoicingOptions): MidiPitch[] {
  const voices = Math.max(1, opts.voices ?? 4);
  const tones = chordTones({ root: chord.root, quality: chord.quality });
  const pcs = Array.from(new Set(tones.map((t) => t.pc)));
  const essentialAll = tones.filter((t) => t.role === 'root' || t.role === 'third' || t.role === 'sus' || t.role === 'seventh').map((t) => t.pc);
  const essential = Array.from(new Set(essentialAll.length ? essentialAll : pcs)).slice(0, voices);
  const thirdPcs = tones.filter((t) => t.role === 'third').map((t) => t.pc);
  const bassPc = chord.bass ?? chord.root;
  const pool: MidiPitch[] = [];
  for (let p = Math.ceil(opts.low); p <= opts.high; p++) if (pcs.includes(mod12(p))) pool.push(p);
  const center = opts.center ?? (opts.low + opts.high) / 2;
  const maxSpan = opts.spread === 'open' ? 30 : voices <= 3 ? 14 : voices === 4 ? 17 : 24;

  let best: MidiPitch[] | null = null;
  let bestScore = Infinity;
  const combo: MidiPitch[] = [];
  const consider = () => {
    const covered = new Set(combo.map(mod12));
    for (const e of essential) if (!covered.has(e)) return;
    if (opts.bassInVoicing && mod12(combo[0]) !== bassPc) return;
    let score: number;
    const mean = combo.reduce((s, p) => s + p, 0) / combo.length;
    const span = combo[combo.length - 1] - combo[0];
    if (opts.previous && opts.previous.length) score = movement(combo, opts.previous) + Math.abs(mean - center) * 0.1;
    else score = Math.abs(mean - center) + span * 0.08;
    // Voicing quality: avoid doubled thirds, prefer covering all tones, avoid low-register clutter.
    const thirdCount = combo.filter((p) => thirdPcs.includes(mod12(p))).length;
    if (thirdCount > 1) score += 2 * (thirdCount - 1);
    score += (pcs.length - covered.size) * 0.75;
    for (let i = 1; i < combo.length; i++) {
      if (combo[i] < 52 && combo[i] - combo[i - 1] < 5) score += 1.5;
    }
    if (score < bestScore) {
      bestScore = score;
      best = combo.slice();
    }
  };
  const recurse = (start: number) => {
    if (combo.length === voices) {
      consider();
      return;
    }
    for (let i = start; i < pool.length; i++) {
      if (combo.length && pool[i] - combo[0] > maxSpan) break;
      combo.push(pool[i]);
      recurse(i + 1);
      combo.pop();
    }
  };
  recurse(0);
  if (best) return best;

  // Fallback: fold each tone into range independently.
  return pcs
    .slice(0, voices)
    .map((pc) => {
      let p = Math.round(center) - mod12(Math.round(center) - pc);
      while (p < opts.low) p += 12;
      while (p > opts.high) p -= 12;
      return p;
    })
    .sort((a, b) => a - b);
}

/** Root + fifth + octave power chord with the root placed in [low, low+11]. */
export function powerChord(rootPc: number, low: MidiPitch = 40): MidiPitch[] {
  let root = low;
  while (mod12(root) !== mod12(rootPc)) root++;
  return [root, root + 7, root + 12];
}

/** Standard guitar tuning (low E to high E). */
export const GUITAR_STANDARD_TUNING: readonly MidiPitch[] = [40, 45, 50, 55, 59, 64];

const E_SHAPES: Partial<Record<ChordQuality, number[]>> = {
  maj: [0, 7, 12, 16, 19, 24],
  min: [0, 7, 12, 15, 19, 24],
  '7': [0, 7, 10, 16, 19, 24],
  min7: [0, 7, 10, 15, 19, 24],
  maj7: [0, 7, 11, 16, 19],
  sus4: [0, 7, 12, 17, 19, 24],
  '5': [0, 7, 12],
  add9: [0, 7, 12, 16, 19, 26],
};

const A_SHAPES: Partial<Record<ChordQuality, number[]>> = {
  maj: [0, 7, 12, 16, 19],
  min: [0, 7, 12, 15, 19],
  '7': [0, 7, 10, 16, 19],
  min7: [0, 7, 10, 15, 19],
  maj7: [0, 7, 11, 16, 19],
  sus2: [0, 7, 12, 14, 19],
  sus4: [0, 7, 12, 17, 19],
  dim: [0, 6, 12, 15],
  m7b5: [0, 6, 10, 15],
  '5': [0, 7, 12],
  add9: [0, 7, 14, 16, 19],
};

/**
 * Playable guitar voicing using E-shape (root on 6th string) or A-shape (root on 5th string)
 * barre templates; falls back to a generic close voicing for exotic qualities.
 */
export function guitarVoicing(chord: ChordSpec, style: 'power' | 'barre' | 'open' = 'barre'): MidiPitch[] {
  if (style === 'power') return powerChord(chord.root, 40);
  const eFret = mod12(chord.root - 40);
  const aFret = mod12(chord.root - 45);
  const eShape = E_SHAPES[chord.quality];
  const aShape = A_SHAPES[chord.quality];
  let voicing: MidiPitch[] | null = null;
  // Prefer the shape with the lower fret position (more "open" sounding).
  if (eShape && (!aShape || eFret <= aFret || style === 'open')) voicing = eShape.map((i) => 40 + eFret + i);
  else if (aShape) voicing = aShape.map((i) => 45 + aFret + i);
  if (!voicing) {
    voicing = voiceChord(chord, { low: 40, high: 76, voices: Math.min(5, CHORD_INTERVALS[chord.quality].length + 1) });
  }
  if (chord.bass !== undefined && chord.bass !== chord.root) {
    // Put the slash bass under the shape.
    let b = voicing[0] - 1;
    while (mod12(b) !== chord.bass) b--;
    if (b < 40) b += 12;
    voicing = [b, ...voicing.filter((p) => p > b)];
  }
  return voicing;
}

/** Piano accompaniment voicing: left hand root (+octave), right hand close voicing. */
export function pianoVoicing(
  chord: ChordSpec,
  previousRightHand?: readonly MidiPitch[],
  opts: { leftLow?: MidiPitch; rightLow?: MidiPitch; rightHigh?: MidiPitch; octaveBass?: boolean } = {},
): { left: MidiPitch[]; right: MidiPitch[] } {
  const leftLow = opts.leftLow ?? 36;
  let bass = leftLow;
  const bassPc = chord.bass ?? chord.root;
  while (mod12(bass) !== bassPc) bass++;
  const left = opts.octaveBass ? [bass, bass + 12] : [bass];
  const right = voiceChord(
    { root: chord.root, quality: chord.quality },
    { low: opts.rightLow ?? 55, high: opts.rightHigh ?? 79, voices: 3, previous: previousRightHand, center: 66 },
  );
  return { left, right };
}
