/**
 * Bass generator (spec §16 "Bass"): chord roots on changes, rhythmic locking with the generated
 * kick (drums are generated first), diatonic or chromatic approach tones into the next chord,
 * octave jumps, root–fifth patterns (country/folk), driving eighths (punk), walking lines (jazz),
 * off-beat house bass, rolling trance 16ths, long 808s, sustained roots for ballads. Monophonic.
 */
import type { ChordEvent } from '../../ir/types';
import { PPQ } from '../../ir/types';
import { mod12 } from '../../theory/pitch';
import { chordPitchClasses } from '../../theory/chords';
import { isInScale, scalePitchClasses } from '../../theory/scales';
import type { Cell } from '../context';
import { applySwing, chordAtIn, clamp, humanize, metricWeight, toVelocity, type RawNote } from '../util';

type BassStyle = 'kick-lock' | 'eighths' | 'root-fifth' | 'walking' | 'offbeat' | 'rolling' | 'sustain' | 'eight-o-eight' | 'pulse';

function styleFor(c: Cell): BassStyle {
  const d = c.g.drumStyle;
  const e = c.intensity;
  const chorusy = c.kind === 'chorus' || c.kind === 'final-chorus' || c.kind === 'drop' || c.kind === 'solo';
  if ((c.kind === 'intro' || c.kind === 'outro' || c.kind === 'breakdown') && e < 0.4) return 'sustain';
  if (c.feel === 'half-time' && e < 0.6) return 'sustain';
  switch (d) {
    case 'punk':
      return 'eighths';
    case 'pop-punk':
    case 'emo':
      return chorusy || c.kind === 'pre-chorus' ? 'eighths' : 'kick-lock';
    case 'metal':
      return e > 0.7 ? 'eighths' : 'kick-lock';
    case 'country':
    case 'folk':
      return e < 0.3 ? 'sustain' : 'root-fifth';
    case 'jazz-swing':
      return e < 0.3 ? 'sustain' : 'walking';
    case 'four-on-floor':
      return 'offbeat';
    case 'trance':
      return e >= 0.5 ? 'rolling' : 'sustain';
    case 'trap':
    case 'hip-hop':
      return c.inst.id === 'synth-bass' ? 'eight-o-eight' : 'kick-lock';
    case 'orchestral':
    case 'cinematic':
      return e >= 0.65 ? 'pulse' : 'sustain';
    default:
      return 'kick-lock';
  }
}

/** Place a pitch class in the bass register, near the previous note. */
function placeBass(pc: number, near: number, low: number, high: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let p = low; p <= high; p++) {
    if (mod12(p) !== mod12(pc)) continue;
    const d = Math.abs(p - near);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best >= 0 ? best : clamp(near, low, high);
}

function approachTo(target: number, chromatic: boolean, fromAbove: boolean, c: Cell): number {
  if (chromatic) return target + (fromAbove ? 1 : -1);
  // Diatonic neighbour (scale step above/below the target).
  const scale = scalePitchClasses(c.key);
  for (let d = 1; d <= 2; d++) {
    const p = fromAbove ? target + d : target - d;
    if (scale.includes(mod12(p))) return p;
  }
  return fromAbove ? target + 2 : target - 2;
}

export function generateBass(c: Cell): RawNote[] {
  const style = styleFor(c);
  const lo = c.range.low;
  const hiComfort = Math.max(lo + 12, Math.min(c.range.high, c.range.comfortableHigh));
  const heavy = ['punk', 'pop-punk', 'metal', 'emo', 'rock'].includes(c.g.drumStyle);
  let center = heavy ? lo + 7 : lo + 10;
  if (style === 'walking') center = lo + 12;
  const complexity = c.macros.complexity;
  const density = c.macros.density;
  const noChromatic = c.avoid.has('chromaticism');
  const chromaticApproach = !noChromatic && (complexity >= 0.6 || c.g.drumStyle === 'jazz-swing');
  const end = c.span.endTick;

  // 1. Onsets: `t` is when the note sounds (kick-locked onsets keep the drummer's feel), `q` is the
  // musical grid position used for harmonic decisions.
  const grid16 = PPQ / 4;
  const quant = (t: number) => {
    const { barStart } = c.meterAt(t);
    const q = barStart + Math.round((t - barStart) / grid16) * grid16;
    return Math.abs(q - t) <= 30 ? q : t;
  };
  const raw: { t: number; q: number }[] = [];
  const changes = c.chords.map((ch) => ch.tick);
  const addBeatsPattern = (fn: (barTick: number, m: Cell['meter']) => number[]) => {
    for (const bar of c.bars) for (const t of fn(bar.tick, bar.meter)) if (t < end) raw.push({ t, q: t });
  };
  switch (style) {
    case 'eighths':
      addBeatsPattern((t, m) => {
        const step = m.denominator >= 8 ? m.unitTicks : m.unitTicks / 2;
        const out: number[] = [];
        for (let x = 0; x < m.barTicks; x += step) out.push(t + x);
        return out;
      });
      break;
    case 'root-fifth':
    case 'walking':
      addBeatsPattern((t, m) => (style === 'walking' ? m.beats.map((b) => t + b) : m.strong.length > 1 ? m.strong.map((b) => t + b) : m.beats.filter((_, i) => i % 2 === 0).map((b) => t + b)));
      break;
    case 'offbeat':
      addBeatsPattern((t, m) => m.beats.map((b) => t + b + Math.round(m.beatTicks / 2)));
      break;
    case 'rolling':
      addBeatsPattern((t, m) => m.beats.flatMap((b) => [1, 2, 3].map((k) => t + b + Math.round((m.beatTicks * k) / 4))));
      break;
    case 'sustain':
      for (const ch of changes) raw.push({ t: ch, q: ch });
      break;
    case 'pulse':
      addBeatsPattern((t, m) => m.beats.map((b) => t + b));
      break;
    case 'kick-lock':
    case 'eight-o-eight': {
      const kicks = c.kickTicks();
      if (kicks.length) {
        // Thin very dense kick patterns (double kick) to an eighth-note grid.
        let lastQ = -Infinity;
        for (const k of kicks) {
          const q = quant(k);
          if (q - lastQ < PPQ / 2 - 10 && style === 'kick-lock') continue;
          raw.push({ t: k, q });
          lastQ = q;
        }
      } else {
        addBeatsPattern((t, m) => {
          const out = [t];
          for (const s2 of m.strong.slice(1)) out.push(t + s2);
          if (c.rng.chance(0.3 + c.macros.syncopation * 0.4)) out.push(t + m.barTicks - Math.round(m.beatTicks / 2));
          return out;
        });
      }
      break;
    }
  }
  // Every chord change gets a note (unless something already lands there).
  if (style !== 'offbeat' && style !== 'rolling') {
    for (const ch of changes) if (!raw.some((o) => Math.abs(o.q - ch) <= PPQ / 8)) raw.push({ t: ch, q: ch });
  }
  // Busy players add pickups before strong beats.
  if ((style === 'kick-lock' || style === 'pulse') && density > 0.6 && complexity > 0.45) {
    for (const bar of c.bars) {
      if (c.rng.fork('push', bar.index % c.rootBars).chance((density - 0.5) * 0.8)) {
        const t = bar.tick + bar.meter.barTicks - Math.round(bar.meter.beatTicks / 2);
        if (t < end && !raw.some((o) => Math.abs(o.q - t) < PPQ / 4)) raw.push({ t, q: t });
      }
    }
  }
  raw.sort((a, b) => a.t - b.t);
  const onsetList: { t: number; q: number }[] = [];
  for (const o of raw) {
    if (o.t < c.span.startTick || o.t >= end) continue;
    const prevO = onsetList[onsetList.length - 1];
    if (prevO && (o.q === prevO.q || o.t - prevO.t < 40)) continue;
    onsetList.push(o);
  }
  if (!onsetList.length) return [];

  // 2. Pitches.
  const notes: RawNote[] = [];
  let prev = center;
  const nextChangeAfter = (t: number) => changes.find((x) => x > t) ?? end;
  for (let i = 0; i < onsetList.length; i++) {
    const { t, q } = onsetList[i];
    const next = i + 1 < onsetList.length ? onsetList[i + 1].t : end;
    const nextQ = i + 1 < onsetList.length ? onsetList[i + 1].q : end;
    const chord = chordAtIn(c.chords, q);
    const rootPc = chord.bass ?? chord.root;
    const isChange = changes.includes(q);
    const rng = c.rng.fork('n', i % 64, Math.floor((q - c.span.startTick) / (c.rootBars * c.meter.barTicks)));
    let pitch = placeBass(rootPc, prev, lo, hiComfort);
    const change = nextChangeAfter(q);
    const lastBeforeChange = nextQ >= change && change < end && !isChange;
    const nextChord: ChordEvent | undefined = change < end ? chordAtIn(c.chords, change) : undefined;
    const pcs = chordPitchClasses(chord);
    const fifthPc = mod12(chord.root + 7);
    if (style === 'walking') {
      // Beat 1 of a chord: root; then chord tones; last beat: approach the next root.
      if (lastBeforeChange && nextChord) {
        const target = placeBass(nextChord.bass ?? nextChord.root, prev, lo, hiComfort);
        pitch = approachTo(target, chromaticApproach || rng.chance(0.5), rng.chance(0.5), c);
      } else if (!isChange) {
        const opts = pcs.map((pc) => placeBass(pc, prev + (rng.chance(0.5) ? 3 : -3), lo, hiComfort)).filter((p) => p !== prev);
        pitch = opts.length ? rng.pick(opts) : pitch;
      }
    } else if (style === 'root-fifth') {
      if (!isChange) pitch = placeBass(rng.chance(0.75) ? fifthPc : rootPc, prev - 5, lo, hiComfort);
      if (lastBeforeChange && nextChord && rng.chance(complexity)) {
        const target = placeBass(nextChord.bass ?? nextChord.root, prev, lo, hiComfort);
        pitch = approachTo(target, chromaticApproach, pitch > target, c);
      }
    } else if (style !== 'sustain') {
      const gap = nextQ - q;
      if (lastBeforeChange && nextChord && gap <= PPQ && rng.chance(0.2 + complexity * 0.55)) {
        const target = placeBass(nextChord.bass ?? nextChord.root, prev, lo, hiComfort);
        pitch = approachTo(target, chromaticApproach && rng.chance(0.6), rng.chance(0.5), c);
      } else if (!isChange && rng.chance(complexity * (style === 'eighths' ? 0.25 : 0.35))) {
        const { meter, barStart } = c.meterAt(q);
        const weak = metricWeight(q - barStart, meter) <= 0.5;
        if (weak && pitch + 12 <= c.range.high && (style === 'eighths' || style === 'offbeat' || style === 'eight-o-eight')) pitch += 12; // octave pop
        else if (pcs.includes(fifthPc)) pitch = placeBass(fifthPc, pitch + 4, lo, hiComfort);
      }
    }
    if (noChromatic && !isInScale(pitch, c.key) && !pcs.includes(mod12(pitch))) pitch = placeBass(rootPc, prev, lo, hiComfort);
    const { meter, barStart } = c.meterAt(q);
    const w = metricWeight(q - barStart, meter);
    const e = c.energyAt(t);
    let dur = next - t;
    let articulation: RawNote['articulation'];
    if (style === 'offbeat') {
      dur = Math.max(60, Math.round(dur * 0.5));
      articulation = 'staccato';
    } else if (style === 'eighths' || style === 'rolling') dur = Math.max(60, dur - 25);
    else if (style === 'walking') dur = Math.max(60, dur - 15);
    else if (style === 'eight-o-eight') {
      dur = Math.max(PPQ / 2, dur - 5);
      if (i > 0 && pitch !== notes[notes.length - 1]?.pitch && rng.chance(0.15 + complexity * 0.3)) articulation = 'slide';
    } else dur = Math.max(60, dur - 12);
    const base = style === 'sustain' ? 84 : 92 + (w >= 0.9 ? 10 : w >= 0.75 ? 4 : 0);
    const vel = toVelocity((base * (0.72 + 0.32 * e) - 88) * (0.65 + 0.7 * c.macros.dynamics) + 88);
    notes.push({ pitch, tick: t, duration: dur, velocity: vel, ...(articulation ? { articulation } : {}) });
    prev = pitch;
  }

  // 3. Fill into a bigger next section: walk up/down the scale in the last beat.
  if (c.next && complexity >= 0.42 && c.e1 >= 0.5 && style !== 'sustain' && !c.isLast) {
    const nextE = (c.next.section.energy ?? 50) / 100;
    if (nextE >= c.e1 - 0.05 && c.vrng.chance(0.35 + complexity * 0.4)) {
      const bar = c.bars[c.bars.length - 1];
      const beat = bar.meter.beatTicks;
      const start = bar.tick + bar.meter.barTicks - beat;
      const step = c.bpm >= 150 ? beat / 2 : beat / 4;
      const target = notes.length ? notes[notes.length - 1].pitch : center;
      const dir = c.vrng.chance(0.5) ? 1 : -1;
      for (let i = notes.length - 1; i >= 0; i--) if (notes[i].tick >= start) notes.splice(i, 1);
      if (notes.length && notes[notes.length - 1].tick + notes[notes.length - 1].duration > start) notes[notes.length - 1].duration = Math.max(30, start - notes[notes.length - 1].tick);
      const scale = scalePitchClasses(c.key);
      let p = target - dir * 4;
      for (let t = start, k = 0; t < start + beat - 1; t += step, k++) {
        while (!scale.includes(mod12(p))) p += dir;
        notes.push({ pitch: clamp(p, lo, c.range.high), tick: Math.round(t), duration: Math.round(step - 10), velocity: toVelocity(88 + k * 4) });
        p += dir;
      }
    }
  }

  // Swing the off-beats like the drums (kick-locked onsets are already swung by the drums).
  if ((c.swing8 > 0 || c.swing16 > 0) && style !== 'kick-lock' && style !== 'eight-o-eight') {
    for (const n of notes) {
      const { meter, barStart } = c.meterAt(n.tick);
      if (meter.compound || meter.denominator > 4) continue;
      const off = n.tick - barStart;
      const sw = c.swing8 > 0 ? applySwing(off, PPQ, c.swing8) : applySwing(off, PPQ / 2, c.swing16);
      const shift = sw - off;
      n.tick += shift;
      n.duration = Math.max(30, n.duration - Math.max(0, shift));
    }
  }
  humanize(notes, c.macros.humanization * 0.8, c.vrng.fork('humanize'), { start: c.span.startTick, end, maxTicks: 6, maxVelocity: 7 });
  return notes;
}
