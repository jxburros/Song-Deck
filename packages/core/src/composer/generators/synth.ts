/**
 * Synthesizer textures (spec §16 "Synthesizers"): arpeggiators (up / down / up-down / converge /
 * random, rate by genre and energy, gated plucks with beat accents) and rhythmic sequences
 * (16th-note pulses on root / fifth / octave with gating patterns).
 */
import { PPQ, type ChordQuality } from '../../ir/types';
import { chordPitchClasses } from '../../theory/chords';
import { mod12 } from '../../theory/pitch';
import { voiceChord } from '../../theory/voicing';
import type { Cell } from '../context';
import { drumStyleInfo } from '../styles';
import { chordAtIn, clamp, humanize, toVelocity, type RawNote } from '../util';

type ArpMode = 'up' | 'down' | 'updown' | 'converge' | 'random' | 'pinky';

function arpRate(c: Cell, m: Cell['meter']): number {
  const d = c.g.drumStyle;
  if (m.compound || m.denominator >= 8) return m.unitTicks / (c.intensity > 0.7 ? 2 : 1);
  const electronic = d === 'trance' || d === 'four-on-floor' || d === 'synth-pop' || d === 'trap' || (drumStyleInfo(d).electronic && d !== 'hip-hop');
  let rate = electronic || (c.bpm < 110 && c.macros.density > 0.5) ? PPQ / 4 : PPQ / 2;
  if (c.intensity < 0.3) rate *= 2;
  if (c.bpm > 160 && rate < PPQ / 2) rate = PPQ / 2;
  return rate;
}

function tonesFor(c: Cell, chord: { root: number; quality: ChordQuality }, octaves: number, center: number): number[] {
  const base = voiceChord(chord, { low: center - 7, high: center + 9, voices: 3, center });
  const out: number[] = [];
  for (let o = 0; o < octaves; o++) for (const p of base) out.push(p + 12 * o);
  return [...new Set(out)].filter((p) => p >= c.range.low && p <= c.range.high).sort((a, b) => a - b);
}

function arpIndex(mode: ArpMode, i: number, n: number, rnd: () => number): number {
  if (n <= 1) return 0;
  switch (mode) {
    case 'up':
      return i % n;
    case 'down':
      return n - 1 - (i % n);
    case 'updown': {
      const period = 2 * n - 2;
      const k = i % period;
      return k < n ? k : period - k;
    }
    case 'converge': {
      const k = i % n;
      return k % 2 === 0 ? k / 2 : n - 1 - (k - 1) / 2;
    }
    case 'pinky':
      return i % 2 === 0 ? Math.floor((i / 2) % Math.max(1, n - 1)) : n - 1;
    case 'random':
      return Math.floor(rnd() * n);
  }
}

export function generateArp(c: Cell): RawNote[] {
  const out: RawNote[] = [];
  const mode = c.rng.pick(['up', 'updown', 'up', 'down', 'converge', 'pinky', 'random'] as ArpMode[]);
  const octaves = c.intensity > 0.65 ? 2 : 1;
  const center = Math.round(c.range.comfortableLow + (c.range.comfortableHigh - c.range.comfortableLow) * 0.45);
  const gate = 0.5 + (1 - c.intensity) * 0.3;
  let i = 0;
  for (const bar of c.bars) {
    const rate = arpRate(c, bar.meter);
    const barRng = c.rng.fork('arp', bar.index % c.rootBars);
    for (let t = bar.tick; t < bar.tick + bar.meter.barTicks; t += rate, i++) {
      const ch = chordAtIn(c.chords, t);
      const tones = tonesFor(c, ch, octaves, center);
      if (!tones.length) continue;
      const idx = arpIndex(mode, i, tones.length, () => barRng.next());
      const onBeat = bar.meter.beats.includes(t - bar.tick);
      const e = c.energyAt(t);
      out.push({ pitch: tones[idx], tick: t, duration: Math.max(30, Math.round(rate * gate)), velocity: toVelocity((onBeat ? 92 : 74) * (0.7 + 0.35 * e)) });
    }
  }
  humanize(out, c.macros.humanization * 0.15, c.vrng.fork('humanize'), { start: c.span.startTick, end: c.span.endTick, maxTicks: 4, maxVelocity: 5 });
  return out;
}

export function generateSeq(c: Cell): RawNote[] {
  const out: RawNote[] = [];
  const shapes = [
    ['R', 'R', '8', 'R', '5', 'R', '8', '5'],
    ['R', '.', 'R', 'R', '.', 'R', '8', '.'],
    ['R', '8', 'R', '5', 'R', '8', 'R', 'b'],
    ['R', 'R', 'R', '8', 'R', 'R', '5', 'R'],
  ];
  const shape = c.rng.pick(shapes);
  const low = clamp(c.range.comfortableLow, c.range.low, c.range.high - 12);
  for (const bar of c.bars) {
    const e = c.energyAt(bar.tick);
    const rate = bar.meter.compound || bar.meter.denominator >= 8 ? bar.meter.unitTicks / 2 : c.bpm > 150 || e < 0.35 ? PPQ / 2 : PPQ / 4;
    let k = 0;
    for (let t = bar.tick; t < bar.tick + bar.meter.barTicks; t += rate, k++) {
      const sym = shape[k % shape.length];
      if (sym === '.') continue;
      const ch = chordAtIn(c.chords, t);
      let root = low;
      while (mod12(root) !== mod12(ch.bass ?? ch.root)) root++;
      const pcs = chordPitchClasses(ch);
      let p = root;
      if (sym === '8') p = root + 12;
      else if (sym === '5') p = root + (pcs.includes(mod12(ch.root + 7)) ? 7 : 6);
      else if (sym === 'b') p = root + (pcs.includes(mod12(ch.root + 3)) ? 3 : 4);
      if (p > c.range.high) p -= 12;
      const onBeat = bar.meter.beats.includes(t - bar.tick);
      out.push({ pitch: p, tick: t, duration: Math.round(rate * 0.6), velocity: toVelocity((onBeat ? 96 : 80) * (0.7 + 0.35 * e)), articulation: 'staccato' });
    }
  }
  return out;
}
