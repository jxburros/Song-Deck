/**
 * Melodic instrument lines (spec §16 "Lead Guitar", "Strings" counterpoint, "Synthesizers" leads):
 *  - hook: the chorus/intro hook (Motif B) re-placed over the harmony, never doubling the vocal;
 *  - counter-melody: answers the vocal in its rests (Motif C), sustains soaring chord tones under
 *    choruses, stays out of the way in verses;
 *  - solo: pentatonic/scale phrases that climb and get busier, bends on long notes;
 *  - fills: short licks in vocal gaps; harmony: one voice-led chord tone per chord;
 *  - rhythm: ostinatos (cinematic cello), accompaniment: broken chords for mono instruments;
 *  - melody: the principal melody in instrumental pieces (or a doubling when asked).
 */
import type { MotifNote, Note } from '../../ir/types';
import { PPQ } from '../../ir/types';
import { chordPitchClasses } from '../../theory/chords';
import { mod12 } from '../../theory/pitch';
import {
  BLUES_SCALE,
  PENTATONIC_MAJOR,
  PENTATONIC_MINOR,
  isMinorMode,
  scalePitchClasses,
} from '../../theory/scales';
import type { Cell } from '../context';
import {
  abstractPhrase,
  anchorNear,
  findSongMotif,
  phraseBarsFor,
  phraseRhythm,
  realizePhrase,
} from '../motifs';
import { chordAtIn, clamp, clamp01, humanize, metricWeight, toVelocity, type RawNote } from '../util';
import { generateBass } from './bass';
import { mainMelody } from './vocal';
import type { GenOutput } from './types';

interface Gap {
  start: number;
  end: number;
}

/** Rests of the principal melody inside the section (≥ minLen). */
export function melodyGaps(c: Cell, notes: Note[], minLen: number): Gap[] {
  const gaps: Gap[] = [];
  let cursor = c.span.startTick;
  for (const n of [...notes].sort((a, b) => a.tick - b.tick)) {
    if (n.tick - cursor >= minLen) gaps.push({ start: cursor, end: n.tick });
    cursor = Math.max(cursor, n.tick + n.duration);
  }
  if (c.span.endTick - cursor >= minLen) gaps.push({ start: cursor, end: c.span.endTick });
  return gaps;
}

/** True when `pitch` would double (unison/octave) a melody note sounding at that time. */
function doublesMelody(melody: Note[], tick: number, duration: number, pitch: number): boolean {
  for (const n of melody) {
    if (n.tick < tick + duration && n.tick + n.duration > tick && mod12(n.pitch) === mod12(pitch))
      return true;
  }
  return false;
}

function registerCenter(c: Cell, bias = 0.55): number {
  return Math.round(c.range.comfortableLow + (c.range.comfortableHigh - c.range.comfortableLow) * bias);
}

/** Place a motif repeatedly from `start` to `end` (truncating the last placement). */
function placeMotifRepeated(
  c: Cell,
  notes: MotifNote[],
  lengthTicks: number,
  start: number,
  end: number,
  center: number,
  motifId: string | undefined,
  melody: Note[],
): RawNote[] {
  const out: RawNote[] = [];
  let t = start;
  let k = 0;
  while (t < end - PPQ / 2 && k < 64) {
    const chord = chordAtIn(c.chords, t);
    const anchor = anchorNear(chord, center, c.key);
    const avail = end - t;
    const part = notes
      .filter((n) => n.offset < avail)
      .map((n) => ({ ...n, duration: Math.min(n.duration, avail - n.offset) }));
    const realized = realizePhrase(part, {
      start: t,
      anchor,
      key: c.key,
      chords: c.chords,
      low: c.range.low,
      high: c.range.high,
      meterAt: c.meterAt,
      strongFit: true,
      motifId,
      avoid:
        c.avoid.has('double-vocal') || melody.length
          ? (tick, dur, p) => doublesMelody(melody, tick, dur, p)
          : undefined,
    });
    out.push(...realized);
    t += Math.max(PPQ, lengthTicks);
    k++;
  }
  return out;
}

function hookLine(c: Cell, melody: Note[]): RawNote[] {
  const motif = findSongMotif(c.song, 'hook');
  const center = registerCenter(c, 0.62);
  if (!motif) return counterMelody(c, melody);
  const out = placeMotifRepeated(
    c,
    motif.notes,
    motif.lengthTicks,
    c.span.startTick,
    c.span.endTick,
    center,
    motif.id,
    melody,
  );
  const e = c.intensity;
  for (const n of out) n.velocity = toVelocity(n.velocity * (0.72 + 0.32 * e));
  // Under a busy vocal, thin the hook so it sits in the gaps.
  if (melody.length && c.kind !== 'drop') {
    return out.filter(
      (n) =>
        !melody.some((m) => Math.abs(m.tick - n.tick) < PPQ / 4 && m.duration < PPQ) ||
        metricWeight(n.tick - c.meterAt(n.tick).barStart, c.meterAt(n.tick).meter) >= 0.9,
    );
  }
  return out;
}

function counterMelody(c: Cell, melody: Note[]): RawNote[] {
  const out: RawNote[] = [];
  const motif = findSongMotif(c.song, 'answer');
  const above = c.range.comfortableHigh >= 72;
  const center = registerCenter(c, above ? 0.62 : 0.45);
  const chorusy =
    c.kind === 'chorus' || c.kind === 'final-chorus' || c.kind === 'post-chorus' || c.kind === 'bridge';
  const busyVerse = c.kind === 'verse' && !c.avoid.has('busy-verses');
  const gaps = melody.length
    ? melodyGaps(c, melody, c.meter.beatTicks)
    : [{ start: c.span.startTick, end: c.span.endTick }];
  // 1. Answer phrases in the vocal's rests (Motif C).
  for (const gap of gaps) {
    const len = gap.end - gap.start;
    if (len < c.meter.beatTicks) continue;
    if (!melody.length && motif) {
      out.push(
        ...placeMotifRepeated(
          c,
          motif.notes,
          Math.max(motif.lengthTicks, c.meter.barTicks),
          gap.start,
          gap.end,
          center,
          motif.id,
          melody,
        ),
      );
      continue;
    }
    if (!busyVerse && c.kind === 'verse' && !c.vrng.fork('gap', gap.start).chance(0.6)) continue;
    const startT = gap.start + (gap.start === c.span.startTick ? 0 : Math.round(PPQ / 4));
    const avail = gap.end - startT - Math.round(PPQ / 4);
    if (avail < PPQ) continue;
    const abstract = motif
      ? motif.notes
          .filter((n) => n.offset < avail)
          .map((n) => ({ ...n, duration: Math.min(n.duration, avail - n.offset) }))
      : abstractPhrase(
          c.rng.fork('answer', Math.floor((gap.start - c.span.startTick) / PPQ)),
          { lengthTicks: avail, barOffset: 0, meter: c.meter, grid: PPQ / 2, density: 0.4, syncopation: 0.3 },
          { contour: 'answer', movement: c.macros.melodicMovement, span: 4 },
        );
    if (!abstract.length) continue;
    const melodyNear = melody.filter((n) => Math.abs(n.tick - gap.start) < PPQ * 8);
    const melTop = melodyNear.length ? Math.max(...melodyNear.map((n) => n.pitch)) : center;
    const target = above ? Math.max(center, melTop + 4) : Math.min(center, melTop - 7);
    const anchor = anchorNear(
      chordAtIn(c.chords, startT),
      clamp(target, c.range.low + 3, c.range.high - 5),
      c.key,
    );
    out.push(
      ...realizePhrase(abstract, {
        start: startT,
        anchor,
        key: c.key,
        chords: c.chords,
        low: c.range.low,
        high: c.range.high,
        meterAt: c.meterAt,
        strongFit: true,
        motifId: motif?.id,
        avoid: (tick, dur, p) => doublesMelody(melody, tick, dur, p),
      }),
    );
  }
  // 2. Under choruses: long, soaring chord tones (more emotional), voice-led, never doubling.
  if (melody.length && chorusy) {
    let prev = clamp(center + (above ? 4 : 0), c.range.low, c.range.high);
    for (const ch of c.chords) {
      const pcs = chordPitchClasses(ch);
      const segs = ch.duration > c.meter.barTicks * 1.5 ? Math.round(ch.duration / c.meter.barTicks) : 1;
      for (let s = 0; s < segs; s++) {
        const t = ch.tick + Math.round((ch.duration * s) / segs);
        const dur = Math.round(ch.duration / segs) - 20;
        if (out.some((n) => n.tick < t + dur && n.tick + n.duration > t)) continue;
        let best = -1;
        let bestScore = Infinity;
        for (let p = c.range.low; p <= c.range.high; p++) {
          if (!pcs.includes(mod12(p)) || doublesMelody(melody, t, dur, p)) continue;
          const third = mod12(p - ch.root) === 3 || mod12(p - ch.root) === 4;
          const score = Math.abs(p - prev) + (third ? -1.5 : 0) + (p < center - 5 ? 4 : 0);
          if (score < bestScore) {
            bestScore = score;
            best = p;
          }
        }
        if (best < 0) continue;
        prev = best;
        out.push({ pitch: best, tick: t, duration: Math.max(60, dur), velocity: 90, articulation: 'legato' });
      }
    }
  }
  const e = c.intensity;
  for (const n of out) n.velocity = toVelocity(n.velocity * (0.7 + 0.35 * e));
  return out;
}

function scaleSet(c: Cell, blues: boolean): number[] {
  const minor = isMinorMode(c.key.mode);
  const base = blues && minor ? BLUES_SCALE : minor ? PENTATONIC_MINOR : PENTATONIC_MAJOR;
  return base.map((i) => mod12(c.key.tonic + i));
}

/** Guitar/synth solo: phrases that climb and get busier, chord tones on strong beats, bends. */
function soloLine(c: Cell): RawNote[] {
  const out: RawNote[] = [];
  const pcs = scaleSet(c, c.macros.complexity > 0.6 && !c.avoid.has('chromaticism'));
  const pool: number[] = [];
  for (let p = c.range.low; p <= c.range.high; p++) if (pcs.includes(mod12(p))) pool.push(p);
  if (!pool.length) return out;
  const phraseBars = Math.max(1, Math.min(c.bars.length, phraseBarsFor(c.meter, c.bpm)));
  const phrases = Math.max(1, Math.floor(c.bars.length / phraseBars));
  let idx = Math.floor(pool.length * 0.35);
  for (let ph = 0; ph < phrases; ph++) {
    const rng = c.rng.fork('solo', ph);
    const bar = c.bars[ph * phraseBars];
    const lastBar = c.bars[Math.min(c.bars.length - 1, (ph + 1) * phraseBars - 1)];
    const start = bar.tick;
    const end = ph === phrases - 1 ? c.span.endTick : lastBar.tick + lastBar.meter.barTicks;
    const progress = phrases > 1 ? ph / (phrases - 1) : 1;
    const grid = progress > 0.6 && c.bpm < 150 ? PPQ / 4 : PPQ / 2;
    const rhythm = phraseRhythm(rng, {
      lengthTicks: end - start - PPQ / 2,
      barOffset: 0,
      meter: bar.meter,
      grid,
      density: clamp01(0.45 + progress * 0.45 + c.macros.density * 0.15),
      syncopation: c.macros.syncopation,
      minFinal: PPQ,
    });
    // Register climbs through the solo.
    const targetIdx = Math.floor(pool.length * (0.3 + 0.5 * progress));
    for (let k = 0; k < rhythm.length; k++) {
      const s = rhythm[k];
      const t = start + s.offset;
      const step = rng.chance(0.15 + c.macros.melodicMovement * 0.2)
        ? rng.pick([-3, 3, 4, -2])
        : rng.pick([-1, 1, 1, -1, 2, -2]);
      idx = clamp(idx + step + Math.sign(targetIdx - idx) * (rng.chance(0.3) ? 1 : 0), 0, pool.length - 1);
      let p = pool[idx];
      const { meter, barStart } = c.meterAt(t);
      if (metricWeight(t - barStart, meter) >= 0.75 || s.duration >= PPQ) {
        const cp = chordPitchClasses(chordAtIn(c.chords, t));
        if (!cp.includes(mod12(p))) {
          const alt = pool
            .filter((q) => cp.includes(mod12(q)))
            .sort((a, b) => Math.abs(a - p) - Math.abs(b - p))[0];
          if (alt !== undefined) {
            p = alt;
            idx = pool.indexOf(alt);
          }
        }
      }
      const final = ph === phrases - 1 && k === rhythm.length - 1;
      if (final) {
        const tonic = pool
          .filter((q) => mod12(q) === c.key.tonic)
          .sort((a, b) => Math.abs(a - p) - Math.abs(b - p))[0];
        if (tonic !== undefined) p = tonic;
      }
      const bend = s.duration >= PPQ && rng.chance(0.4);
      out.push({
        pitch: p,
        tick: t,
        duration: s.duration,
        velocity: toVelocity((90 + progress * 18 + (bend ? 6 : 0)) * (0.75 + 0.3 * c.energyAt(t))),
        ...(bend
          ? { articulation: 'bend' as const }
          : s.duration < PPQ / 2 && rng.chance(0.1)
            ? { articulation: 'slide' as const }
            : {}),
      });
    }
  }
  return out;
}

/** Short licks in the melody's rests. */
function fillsLine(c: Cell, melody: Note[]): RawNote[] {
  const out: RawNote[] = [];
  const pcs = scaleSet(c, false);
  const pool: number[] = [];
  for (let p = c.range.comfortableLow; p <= c.range.comfortableHigh; p++)
    if (pcs.includes(mod12(p))) pool.push(p);
  if (!pool.length) return out;
  for (const gap of melodyGaps(c, melody, c.meter.beatTicks * 1.5)) {
    const rng = c.rng.fork('lick', Math.floor((gap.start - c.span.startTick) / PPQ));
    if (!rng.chance(0.4 + c.macros.density * 0.5)) continue;
    const step = c.bpm >= 140 ? PPQ / 2 : PPQ / 4;
    const n = clamp(Math.floor((gap.end - gap.start - PPQ / 2) / step), 2, 6);
    let idx = rng.int(Math.floor(pool.length * 0.3), Math.floor(pool.length * 0.8));
    const dir = rng.chance(0.5) ? -1 : 1;
    for (let k = 0; k < n; k++) {
      const t = gap.start + Math.round(PPQ / 4) + k * step;
      idx = clamp(idx + dir * (rng.chance(0.75) ? 1 : 2), 0, pool.length - 1);
      out.push({
        pitch: pool[idx],
        tick: t,
        duration: k === n - 1 ? step * 2 : step - 10,
        velocity: toVelocity(80 + k * 3),
      });
    }
  }
  return out;
}

/** One voice-led chord tone per chord (mono harmony instruments: viola, horn, trombone, clarinet). */
function harmonyLine(c: Cell, melody: Note[], sustainBars = 1): RawNote[] {
  const out: RawNote[] = [];
  let prev = registerCenter(c, 0.45);
  for (const ch of c.chords) {
    const pcs = chordPitchClasses(ch);
    const segs = Math.max(1, Math.round(ch.duration / (c.meter.barTicks * sustainBars)));
    for (let s = 0; s < segs; s++) {
      const t = ch.tick + Math.round((ch.duration * s) / segs);
      const dur = Math.round(ch.duration / segs) - 20;
      let best = prev;
      let bestScore = Infinity;
      for (let p = c.range.comfortableLow; p <= c.range.comfortableHigh; p++) {
        if (!pcs.includes(mod12(p))) continue;
        const guide =
          mod12(p - ch.root) === 3 ||
          mod12(p - ch.root) === 4 ||
          mod12(p - ch.root) === 10 ||
          mod12(p - ch.root) === 11;
        const score = Math.abs(p - prev) + (guide ? -1 : 0) + (doublesMelody(melody, t, dur, p) ? 6 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = p;
        }
      }
      prev = best;
      const e = c.energyAt(t);
      out.push({
        pitch: best,
        tick: t,
        duration: Math.max(60, dur),
        velocity: toVelocity(62 + 40 * e),
        articulation: 'legato',
      });
    }
  }
  // Swell into a bigger next section.
  if (out.length && c.next && (c.next.section.energy ?? 0) > (c.section.energy ?? 0) + 10)
    out[out.length - 1].velocity = toVelocity(out[out.length - 1].velocity + 14);
  return out;
}

/** Ostinato (cinematic low strings): driving eighths on root/fifth/octave with accents. */
function ostinatoLine(c: Cell): RawNote[] {
  const out: RawNote[] = [];
  const shapes = [
    [0, 0, 7, 0, 12, 0, 7, 0],
    [0, 0, 0, 7, 0, 0, 12, 7],
    [0, 12, 0, 7, 0, 12, 0, 7],
  ];
  const shape = c.rng.pick(shapes);
  for (const bar of c.bars) {
    const e = c.energyAt(bar.tick);
    const step =
      e < 0.4
        ? bar.meter.barTicks / 4
        : e > 0.8 && c.bpm < 120
          ? bar.meter.barTicks / 16
          : bar.meter.barTicks / 8;
    const n = Math.round(bar.meter.barTicks / step);
    for (let i = 0; i < n; i++) {
      const t = bar.tick + Math.round(i * step);
      const ch = chordAtIn(c.chords, t);
      let root = c.range.low;
      while (mod12(root) !== mod12(ch.bass ?? ch.root)) root++;
      const p = root + shape[i % shape.length];
      const accent = i % 4 === 0 || (i % 8 === 3 && e > 0.6);
      out.push({
        pitch: p > c.range.comfortableHigh ? p - 12 : p,
        tick: t,
        duration: Math.round(step * 0.7),
        velocity: toVelocity((accent ? 100 : 80) * (0.72 + 0.32 * e)),
        articulation: accent ? 'accent' : 'staccato',
      });
    }
  }
  return out;
}

/** Broken chords for single-line instruments. */
function brokenChords(c: Cell): RawNote[] {
  const out: RawNote[] = [];
  for (const bar of c.bars) {
    const step = c.bpm > 130 ? bar.meter.barTicks / 4 : bar.meter.barTicks / 8;
    const n = Math.round(bar.meter.barTicks / step);
    for (let i = 0; i < n; i++) {
      const t = bar.tick + Math.round(i * step);
      const ch = chordAtIn(c.chords, t);
      const pcs = chordPitchClasses(ch).slice(0, 4);
      const order = [0, 1, 2, 1, 0, 2, 1, 2];
      const pc = pcs[order[i % order.length] % pcs.length];
      let p = registerCenter(c, 0.4);
      while (mod12(p) !== pc) p++;
      out.push({
        pitch: p,
        tick: t,
        duration: Math.round(step * 0.9),
        velocity: toVelocity(72 + 26 * c.energyAt(t)),
      });
    }
  }
  return out;
}

/** Dispatch a melodic instrument by its musical function and the section's role in the song. */
export function generateMelodicLine(c: Cell): GenOutput {
  const melody = c.melodyNotes();
  const isPrincipal = c.g.principalMelodyId === c.track.id;
  const vocalSings = melody.length > 0;
  let fn = c.fn;
  if (fn === 'melody') {
    if (isPrincipal || !vocalSings) return { notes: mainMelody(c, { vocal: false }).notes };
    if (c.avoid.has('double-vocal')) fn = 'counter-melody';
    else {
      // Doubling the vocal line (an octave away when needed), as asked.
      const notes = melody.map((n) => {
        let p = n.pitch;
        while (p < c.range.low) p += 12;
        while (p > c.range.high) p -= 12;
        return {
          pitch: p,
          tick: n.tick,
          duration: n.duration,
          velocity: toVelocity(n.velocity - 8),
        } as RawNote;
      });
      return { notes };
    }
  }
  if (fn === 'bass-line') return { notes: generateBass(c) };
  // Lead guitars & synth leads follow the song form: hooks in intros/choruses, solos, fills in verses.
  const leadRole = c.track.role === 'lead-guitar' || c.track.role === 'synth-lead';
  const userFn = c.track.constraints?.function !== undefined;
  if (leadRole && !userFn) {
    if (c.kind === 'solo' || (c.kind === 'bridge' && !vocalSings)) fn = 'solo';
    else if (
      c.kind === 'intro' ||
      c.kind === 'post-chorus' ||
      c.kind === 'drop' ||
      c.kind === 'interlude' ||
      c.kind === 'outro'
    )
      fn = 'hook';
    else if (c.kind === 'chorus' || c.kind === 'final-chorus')
      fn = c.fn === 'counter-melody' ? 'counter-melody' : 'hook';
    else if (c.kind === 'verse' || c.kind === 'pre-chorus') fn = vocalSings ? 'fills' : 'hook';
    else if (c.kind === 'bridge') fn = 'counter-melody';
  }
  let notes: RawNote[];
  switch (fn) {
    case 'hook':
      notes = hookLine(c, melody);
      break;
    case 'counter-melody':
      notes = counterMelody(c, melody);
      break;
    case 'solo':
      notes = vocalSings ? counterMelody(c, melody) : soloLine(c);
      break;
    case 'fills':
      notes = fillsLine(c, melody);
      break;
    case 'rhythm':
      notes = ostinatoLine(c);
      break;
    case 'accompaniment':
      notes = brokenChords(c);
      break;
    case 'pad':
    case 'texture':
      notes = harmonyLine(c, melody, 2);
      break;
    default:
      notes = harmonyLine(c, melody, 1);
  }
  const lowEnergyStrings = c.inst.family === 'strings' && c.intensity < 0.35 && fn !== 'rhythm';
  for (const n of notes) {
    if (!n.articulation && lowEnergyStrings) n.articulation = 'legato';
    if (c.inst.id === 'pizzicato-strings') n.articulation = 'pizzicato';
  }
  humanize(notes, c.macros.humanization * 0.7, c.vrng.fork('humanize'), {
    start: c.span.startTick,
    end: c.span.endTick,
    maxTicks: 9,
    maxVelocity: 7,
  });
  return { notes };
}

export function scaleOfKey(c: Cell): number[] {
  return scalePitchClasses(c.key);
}
