/**
 * Bass generator (spec §16 "Bass"): chord roots on changes, rhythmic locking with the generated
 * kick (drums are generated first), diatonic or chromatic approach tones into the next chord,
 * octave jumps, root–fifth patterns (country/folk), driving eighths (punk), walking lines (jazz),
 * off-beat house bass, rolling trance 16ths, long 808s, sustained roots for ballads. Monophonic.
 * Genre idioms (`genre.rhythm.bassStyle`): disco octaves, funk 16ths with dead notes and octave
 * pops, blues boogie, reggae one-drop lines, salsa tumbao, bossa nova and samba surdo figures, the
 * amapiano log drum and dubstep wobbles.
 */
import type { BassPattern, ChordEvent } from '../../ir/types';
import { PPQ } from '../../ir/types';
import { mod12 } from '../../theory/pitch';
import { CHORD_INTERVALS, chordPitchClasses } from '../../theory/chords';
import { isInScale, scalePitchClasses } from '../../theory/scales';
import type { Cell } from '../context';
import { baseDrumStyle } from '../styles';
import { applySwing, chordAtIn, clamp, humanize, metricWeight, toVelocity, type RawNote } from '../util';

type BassStyle = BassPattern;

/** Patterns written out as 16-step bars (see IDIOMS). */
type IdiomStyle =
  'octave' | 'funk' | 'boogie' | 'reggae' | 'tumbao' | 'bossa' | 'samba' | 'log-drum' | 'wobble';
const IDIOM_STYLES: readonly string[] = [
  'octave',
  'funk',
  'boogie',
  'reggae',
  'tumbao',
  'bossa',
  'samba',
  'log-drum',
  'wobble',
];

function styleFor(c: Cell): BassStyle {
  const d = baseDrumStyle(c.g.drumStyle);
  const e = c.intensity;
  const chorusy = c.kind === 'chorus' || c.kind === 'final-chorus' || c.kind === 'drop' || c.kind === 'solo';
  if ((c.kind === 'intro' || c.kind === 'outro' || c.kind === 'breakdown') && e < 0.4) return 'sustain';
  if (c.feel === 'half-time' && e < 0.6) return 'sustain';
  if (c.inst.id === 'log-drum') return 'log-drum';
  const idiom = c.g.genre.rhythm.bassStyle;
  if (idiom) return idiom;
  if (
    c.inst.id === '808-bass' &&
    (d === 'hip-hop' ||
      d === 'trap' ||
      d === 'rnb' ||
      d === 'four-on-floor' ||
      d === 'synth-pop' ||
      d === 'pop')
  )
    return 'eight-o-eight';
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
      return c.inst.id === 'synth-bass' || c.inst.id === '808-bass' ? 'eight-o-eight' : 'kick-lock';
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

const IDIOM_FALLBACK: Record<IdiomStyle, BassStyle> = {
  octave: 'eighths',
  funk: 'kick-lock',
  boogie: 'walking',
  reggae: 'root-fifth',
  tumbao: 'root-fifth',
  bossa: 'root-fifth',
  samba: 'root-fifth',
  'log-drum': 'kick-lock',
  wobble: 'eighths',
};

/*
 * One-bar (16-step) figures per idiom, calm and busy. Degrees: R root, 5 fifth, O octave above the
 * root, 3 third, 6 sixth, 7 seventh, N the root of the harmony one beat ahead (anticipation), T the
 * harmony one beat ahead's root if it changes there, else the fifth; x a dead note. '-' holds the
 * previous note (held to the bar line it ties into the next onset), '.' is silence.
 */
const IDIOMS: Record<IdiomStyle, { calm: string[]; busy: string[] }> = {
  // Disco: octave-jumping eighths.
  octave: { calm: ['R.O.R.O.R.O.R.O.'], busy: ['R.O.R.O.R.O.R.O.', 'R.ORR.O.R.O.5.O.'] },
  // Funk: "the one" held, syncopated 16ths, dead notes and octave pops.
  funk: {
    calm: ['R-.R..O.x.R.5.7.', 'R-...R.O..5.R...'],
    busy: ['R-.R..O.x.R.5.7O', 'R-..xRO..R.x5-O.', 'R.xR.xO.R..R.57O'],
  },
  // Boogie-woogie / shuffle: R-3-5-6-b7-6-5-3 in (swung) eighths.
  boogie: { calm: ['R.3.5.6.7.6.5.3.'], busy: ['R.3.5.6.7.6.5.3.'] },
  // Reggae: melodic lines that leave space around beat 1 and lock with the drop on 3.
  reggae: { calm: ['R-----R.5---3.5.', '....R-R.5---O-5.'], busy: ['R---..3.5-..R-5.', 'R-R.5.R.O-5-3-R.'] },
  // Salsa tumbao: anticipated root on the "and" of 2, beat 4 belongs to the next harmony; beat 1 is tied over.
  tumbao: { calm: ['......N-----T---'], busy: ['......N-----T---'] },
  // Bossa nova: dotted-quarter root, fifth, anticipation of the next root.
  bossa: { calm: ['R-----5.5-----N.'], busy: ['R-----5.5-----N.'] },
  // Samba: surdo-like "1 . . a 2" figure.
  samba: { calm: ['R..R5---R..R5---'], busy: ['R..R5---R..R5---', 'R.RR5-.5R.RR5-.N'] },
  // Amapiano log drum: syncopated, percussive hits with octave leaps.
  'log-drum': {
    calm: ['R..R..O.........', 'R.....R..R......'],
    busy: ['R..R..O.R.5..R..', '...R..R...O..5R.', 'R.....R..R..O...'],
  },
  // Dubstep wobble: held, re-triggered sub notes.
  wobble: { calm: ['R-------R---O---'], busy: ['R-R-RRR-R-O-RR5-', 'R---RRR-O-O-R-5-'] },
};

function idiomaticBass(c: Cell, style: IdiomStyle): RawNote[] {
  const lo = c.range.low;
  const hi = Math.max(lo + 12, Math.min(c.range.high, c.range.comfortableHigh));
  const pool = IDIOMS[style];
  const changes = new Set(c.chords.map((ch) => ch.tick));
  const fifthBelow = style === 'bossa' || style === 'samba' || style === 'tumbao';
  const evs: { tick: number; end: number | null; deg: string; step: number }[] = [];
  for (const bar of c.bars) {
    const busy = c.energyAt(bar.tick) >= 0.62 || c.macros.density > 0.72;
    const rows = busy ? pool.busy : pool.calm;
    const base = c.rng.fork('idiom', busy ? 1 : 0).int(0, rows.length - 1);
    // The fourth bar of each phrase varies the figure.
    const row = rows[(base + (bar.index % 4 === 3 ? 1 : 0)) % rows.length];
    const step = bar.meter.barTicks / 16;
    for (let i = 0; i < 16; i++) {
      const ch = row[i];
      if (ch === '.' || ch === '-') continue;
      let j = i + 1;
      while (j < 16 && row[j] === '-') j++;
      const tied = j === 16 && j > i + 1;
      evs.push({
        tick: bar.tick + Math.round(i * step),
        end: tied ? null : bar.tick + Math.round(j * step),
        deg: ch,
        step: i,
      });
    }
  }
  const notes: RawNote[] = [];
  let prevRoot = lo + 9;
  for (let k = 0; k < evs.length; k++) {
    const ev = evs[k];
    if (ev.tick >= c.span.endTick) continue;
    const nextTick = k + 1 < evs.length ? Math.min(evs[k + 1].tick, c.span.endTick) : c.span.endTick;
    const chord = chordAtIn(c.chords, ev.tick);
    const aheadTick = Math.min(ev.tick + PPQ, c.span.endTick - 1);
    const ahead = chordAtIn(c.chords, aheadTick);
    let deg = ev.deg;
    let target = chord;
    if (deg === 'N' || deg === 'T') {
      target = ahead;
      const same = ahead.root === chord.root && ahead.quality === chord.quality && ahead.bass === chord.bass;
      deg = deg === 'T' && same ? '5' : 'R';
    } else if (changes.has(ev.tick) && deg !== 'x') deg = 'R';
    const ivs = CHORD_INTERVALS[target.quality] ?? [0, 4, 7];
    const third = ivs.includes(3) && !ivs.includes(4) ? 3 : 4;
    const fifth = ivs.includes(7) ? 7 : ivs.includes(6) ? 6 : ivs.includes(8) ? 8 : 7;
    const seventh = ivs.includes(11) ? 11 : 10;
    // Roots stay around one register (no drift) so octave leaps stay in range.
    const root = placeBass(target.bass ?? target.root, Math.round((prevRoot + lo + 10) / 2), lo, hi);
    let pitch = root;
    switch (deg) {
      case 'O':
        pitch = root + 12 <= c.range.high ? root + 12 : root;
        break;
      case '5':
        pitch = placeBass(target.root + fifth, fifthBelow ? root - 5 : root + 7, lo, c.range.high);
        break;
      case '3':
        pitch = root + third;
        break;
      case '6':
        pitch = root + 9;
        break;
      case '7':
        pitch = root + seventh;
        break;
    }
    while (pitch > c.range.high) pitch -= 12;
    while (pitch < lo) pitch += 12;
    prevRoot = root;
    const step = c.meterAt(ev.tick).meter.barTicks / 16;
    let dur = ev.end === null ? nextTick - ev.tick - 10 : Math.min(ev.end, nextTick) - ev.tick - 15;
    if (style === 'octave') dur = Math.min(dur, Math.round(step * 1.6));
    if (style === 'log-drum') dur = Math.max(dur, Math.round(step * 1.5));
    dur = Math.max(40, Math.min(dur, nextTick - ev.tick - 5));
    const e = c.energyAt(ev.tick);
    const base = ev.step % 4 === 0 ? 102 : ev.step % 2 === 0 ? 94 : 88;
    let vel = toVelocity((base * (0.72 + 0.32 * e) - 88) * (0.65 + 0.7 * c.macros.dynamics) + 88);
    let articulation: RawNote['articulation'];
    if (deg === 'x') {
      vel = 46;
      dur = 40;
      articulation = 'ghost';
    } else if (style === 'log-drum' && deg === 'O') articulation = 'slide';
    else if (style === 'wobble' && k > 0 && ev.end === null) articulation = 'legato';
    else if (style === 'octave' || style === 'funk')
      articulation = dur <= step * 1.7 ? 'staccato' : undefined;
    notes.push({
      pitch,
      tick: ev.tick,
      duration: dur,
      velocity: vel,
      ...(articulation ? { articulation } : {}),
    });
  }
  return notes;
}

export function generateBass(c: Cell): RawNote[] {
  let style = styleFor(c);
  if (IDIOM_STYLES.includes(style)) {
    if (c.bars.every((b) => b.meter.common))
      return finishBass(c, idiomaticBass(c, style as IdiomStyle), style);
    style = IDIOM_FALLBACK[style as IdiomStyle];
  }
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
      addBeatsPattern((t, m) =>
        style === 'walking'
          ? m.beats.map((b) => t + b)
          : m.strong.length > 1
            ? m.strong.map((b) => t + b)
            : m.beats.filter((_, i) => i % 2 === 0).map((b) => t + b),
      );
      break;
    case 'offbeat':
      addBeatsPattern((t, m) => m.beats.map((b) => t + b + Math.round(m.beatTicks / 2)));
      break;
    case 'rolling':
      addBeatsPattern((t, m) =>
        m.beats.flatMap((b) => [1, 2, 3].map((k) => t + b + Math.round((m.beatTicks * k) / 4))),
      );
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
          if (c.rng.chance(0.3 + c.macros.syncopation * 0.4))
            out.push(t + m.barTicks - Math.round(m.beatTicks / 2));
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
        const opts = pcs
          .map((pc) => placeBass(pc, prev + (rng.chance(0.5) ? 3 : -3), lo, hiComfort))
          .filter((p) => p !== prev);
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
        if (
          weak &&
          pitch + 12 <= c.range.high &&
          (style === 'eighths' || style === 'offbeat' || style === 'eight-o-eight')
        )
          pitch += 12; // octave pop
        else if (pcs.includes(fifthPc)) pitch = placeBass(fifthPc, pitch + 4, lo, hiComfort);
      }
    }
    if (noChromatic && !isInScale(pitch, c.key) && !pcs.includes(mod12(pitch)))
      pitch = placeBass(rootPc, prev, lo, hiComfort);
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
      if (i > 0 && pitch !== notes[notes.length - 1]?.pitch && rng.chance(0.15 + complexity * 0.3))
        articulation = 'slide';
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
      if (notes.length && notes[notes.length - 1].tick + notes[notes.length - 1].duration > start)
        notes[notes.length - 1].duration = Math.max(30, start - notes[notes.length - 1].tick);
      const scale = scalePitchClasses(c.key);
      let p = target - dir * 4;
      for (let t = start, k = 0; t < start + beat - 1; t += step, k++) {
        while (!scale.includes(mod12(p))) p += dir;
        notes.push({
          pitch: clamp(p, lo, c.range.high),
          tick: Math.round(t),
          duration: Math.round(step - 10),
          velocity: toVelocity(88 + k * 4),
        });
        p += dir;
      }
    }
  }

  return finishBass(c, notes, style);
}

/** Swing the off-beats like the drums (kick-locked onsets are already swung by the drums), then humanize. */
function finishBass(c: Cell, notes: RawNote[], style: BassStyle): RawNote[] {
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
  humanize(notes, c.macros.humanization * 0.8, c.vrng.fork('humanize'), {
    start: c.span.startTick,
    end: c.span.endTick,
    maxTicks: 6,
    maxVelocity: 7,
  });
  return notes;
}
