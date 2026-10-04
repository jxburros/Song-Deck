/**
 * Vocal melody (spec §16 "Vocal Melody"): voice-type ranges, 2/4-bar phrases with breathing rests,
 * motif-based verses (Motif A) and chorus hooks (Motif D), contour arcs (choruses sit higher than
 * verses), chord tones on strong beats, stepwise motion with filled-in leaps, repetition across
 * repeated sections (modulo the repetition macro), syllable-matched rhythms when lyrics exist,
 * Phrase records, and vocal expression. Also backing-vocal harmonies and choir pads.
 *
 * `mainMelody` doubles as the principal-melody generator for instruments in instrumental pieces.
 */
import type { LyricLine, MotifNote, VocalExpression } from '../../ir/types';
import { PPQ } from '../../ir/types';
import { chordPitchClasses } from '../../theory/chords';
import { mod12 } from '../../theory/pitch';
import { transposeDiatonic } from '../../theory/scales';
import { voiceChord } from '../../theory/voicing';
import type { Cell } from '../context';
import {
  MOTIF_DESCRIPTIONS,
  abstractPhrase,
  adaptMotifToCount,
  alignStressToMeter,
  anchorNear,
  findSongMotif,
  phraseBarsFor,
  realizePhrase,
  vocalGrid,
  type Contour,
} from '../motifs';
import { drumStyleInfo } from '../styles';
import { lineStresses, lineSyllables } from '../syllables';
import { chordAtIn, clamp, clamp01, humanize, toVelocity, type RawNote } from '../util';
import type { GenOutput, PhraseDraft } from './types';

interface PhraseSlot {
  start: number;
  end: number;
  lines: LyricLine[];
}

/** Phrase boundaries for a section: one per lyric line when lyrics exist, else 1/2/4-bar phrases. */
function layoutPhrases(c: Cell, lines: LyricLine[], bars: number): PhraseSlot[] {
  const barTick = (b: number) => c.bars[Math.min(b, c.bars.length - 1)]?.tick ?? c.span.startTick;
  const endTick = c.span.endTick;
  const at = (barPos: number) => {
    const b = Math.floor(barPos);
    if (b >= c.bars.length) return endTick;
    const frac = barPos - b;
    return Math.round(barTick(b) + frac * c.bars[b].meter.barTicks);
  };
  const slots: PhraseSlot[] = [];
  if (lines.length) {
    const L = lines.length;
    if (L <= bars * 2) {
      const unit = L <= bars ? 1 : 0.5;
      const units = bars / unit;
      for (let i = 0; i < L; i++) {
        const a = Math.round((i * units) / L) * unit;
        const b = Math.round(((i + 1) * units) / L) * unit;
        slots.push({ start: at(a), end: at(b), lines: [lines[i]] });
      }
    } else {
      const per = Math.ceil(L / bars);
      for (let i = 0; i < bars; i++) {
        const group = lines.slice(i * per, (i + 1) * per);
        if (group.length) slots.push({ start: at(i), end: at(i + 1), lines: group });
      }
    }
    return slots.filter((s) => s.end > s.start);
  }
  const pb = Math.min(bars, phraseBarsFor(c.meter, c.bpm));
  const count = Math.max(1, Math.floor(bars / pb));
  for (let i = 0; i < count; i++) {
    const a = i * pb;
    const b = i === count - 1 ? bars : (i + 1) * pb;
    slots.push({ start: at(a), end: at(b), lines: [] });
  }
  return slots;
}

function registerFraction(kind: Cell['kind']): number {
  switch (kind) {
    case 'verse':
      return 0.36;
    case 'pre-chorus':
      return 0.5;
    case 'chorus':
    case 'drop':
      return 0.62;
    case 'post-chorus':
      return 0.6;
    case 'final-chorus':
      return 0.66;
    case 'bridge':
      return 0.56;
    default:
      return 0.45;
  }
}

function vary(notes: MotifNote[], rng: Cell['rng'], amount: number): MotifNote[] {
  const out = notes.map((n) => ({ ...n }));
  if (out.length < 3) return out;
  const changes = Math.max(1, Math.round(amount * 3));
  for (let k = 0; k < changes; k++) {
    const i = rng.int(1, out.length - 2);
    out[i].degree += rng.pick([-1, 1, 2, -2]);
  }
  return out;
}

export function mainMelody(c: Cell, opts: { vocal: boolean }): GenOutput {
  const isVocal = opts.vocal;
  const lines = isVocal
    ? c.song.lyrics.filter((l) => l.sectionId === c.section.id && (!l.trackId || l.trackId === c.track.id))
    : [];
  const bars = c.bars.length;
  const slots = layoutPhrases(c, lines, bars);
  if (!slots.length) return { notes: [] };
  const rootSlots =
    c.isRepeat && c.rootBars !== bars
      ? Math.max(
          1,
          layoutPhrases(
            { ...c, bars: c.bars.slice(0, Math.min(c.rootBars, bars)) } as Cell,
            [],
            Math.min(c.rootBars, bars),
          ).length,
        )
      : slots.length;
  const r = c.range;
  const cl = r.comfortableLow;
  const ch = r.comfortableHigh;
  const frac = registerFraction(c.kind);
  const center = Math.round(cl + (ch - cl) * frac);
  const low = Math.max(r.low, c.kind === 'verse' ? cl - 1 : cl);
  const high =
    c.kind === 'final-chorus'
      ? Math.min(r.high, ch + 2)
      : c.kind === 'verse'
        ? Math.round(cl + (ch - cl) * 0.8)
        : ch;
  const grid = vocalGrid(c.meter, c.bpm);
  const style = c.g.drumStyle;
  // Rap-led grooves (hip-hop, trap, boom-bap, drill, phonk, baile funk) rap their verses.
  const rap = isVocal && !!drumStyleInfo(style).rap && c.kind === 'verse';
  const chorusy =
    c.kind === 'chorus' || c.kind === 'final-chorus' || c.kind === 'post-chorus' || c.kind === 'drop';
  const motifA = findSongMotif(c.song, 'verse');
  const motifD = findSongMotif(c.song, 'chorusVocal');
  const movement = c.avoid.has('large-leaps')
    ? Math.min(0.3, c.macros.melodicMovement)
    : c.macros.melodicMovement;
  const notes: RawNote[] = [];
  const phrases: PhraseDraft[] = [];
  let prevEnd: number | null = null;
  const motifAnchors = new Map<string, { anchor: number; chordKey: string }>();

  slots.forEach((slot, i) => {
    const contentIdx = i % rootSlots;
    const prng = c.rng.fork('phrase', contentIdx);
    const len = slot.end - slot.start;
    const beat = c.meterAt(slot.start).meter.beatTicks;
    const breath = Math.min(
      len - grid,
      chorusy ? beat : Math.round(Math.max(beat, Math.round((len * 0.2) / grid) * grid)),
    );
    const sung = Math.max(grid * 2, len - breath);
    const syllables = slot.lines.flatMap((l) => lineSyllables(l.text));
    const count = syllables.length || undefined;
    const last = i === slots.length - 1;
    const hookPhrase = chorusy && contentIdx % 2 === 0;
    const versePhrase = c.kind === 'verse' && contentIdx % 2 === 0;
    let abstract: MotifNote[];
    let motifId: string | undefined;
    const fit = (m: MotifNote[]) =>
      m
        .filter((n) => n.offset < sung)
        .map((n) => ({ ...n, duration: Math.min(n.duration, sung - n.offset) }));
    if (hookPhrase && motifD && !rap) {
      abstract = fit(motifD.notes);
      motifId = motifD.id;
      if (contentIdx >= 2 && prng.chance(0.2 + c.macros.repetition * 0.4))
        abstract = vary(abstract, prng.fork('hookvar'), c.macros.repetition);
    } else if (versePhrase && motifA && !rap) {
      abstract = fit(motifA.notes);
      motifId = motifA.id;
      if (contentIdx >= 2 && prng.chance(0.25 + c.macros.repetition * 0.5))
        abstract = vary(abstract, prng.fork('versevar'), c.macros.repetition);
    } else {
      // New material: answers, pre-chorus climbs, bridge contrast, cadences.
      let contour: Contour = 'arch';
      if (c.kind === 'pre-chorus' || c.kind === 'build') contour = 'ascending';
      else if (c.kind === 'bridge') contour = prng.pick(['wave', 'arch'] as Contour[]);
      else if (chorusy) contour = 'descending';
      else if (c.kind === 'verse') contour = 'answer';
      const source = c.kind === 'verse' ? motifA : chorusy ? motifD : undefined;
      if (source && !rap && prng.chance(0.6)) {
        // Answer phrase: keep the motif's rhythm, write a new contour over it.
        const rhythm = fit(source.notes);
        const degs = abstractPhrase(
          prng.fork('answer'),
          {
            lengthTicks: sung,
            barOffset: 0,
            meter: c.meter,
            grid,
            count: rhythm.length,
            density: 0.5,
            syncopation: c.macros.syncopation,
          },
          { contour, movement, span: 4, endDegree: last ? 0 : undefined },
        ).map((n) => n.degree);
        abstract = rhythm.map((n, k) => ({ ...n, degree: degs[k] ?? n.degree }));
      } else {
        abstract = abstractPhrase(
          prng,
          {
            lengthTicks: sung,
            barOffset: 0,
            meter: c.meter,
            grid: rap ? PPQ / 4 : grid,
            density: rap ? 0.85 : clamp01(c.macros.density * (chorusy ? 0.75 : 1)),
            syncopation: c.avoid.has('syncopation') ? 0 : c.macros.syncopation,
            count,
            lateStart: c.kind === 'verse' ? 0.3 : 0.12,
          },
          {
            contour: rap ? 'flat' : contour,
            movement,
            span: rap ? 2 : c.kind === 'bridge' ? 5 : 4,
            flat: rap,
            endDegree: last ? 0 : c.kind === 'pre-chorus' ? 4 : undefined,
            avoidLeaps: c.avoid.has('large-leaps'),
          },
          84,
        );
      }
    }
    if (count !== undefined) {
      abstract = adaptMotifToCount(abstract, count);
      // Prosody: stressed syllables on strong beats where the phrase has room.
      const stress = slot.lines.flatMap((l) => lineStresses(l.text));
      if (stress.length === abstract.length) {
        const at = c.meterAt(slot.start);
        abstract = alignStressToMeter(abstract, stress, {
          grid: rap ? PPQ / 4 : grid,
          barOffset: slot.start - at.barStart,
          meter: at.meter,
          lengthTicks: sung,
        });
      }
    }
    if (!abstract.length) return;
    // Repeated sections mostly repeat; the repetition macro adds small changes.
    if (c.isRepeat && c.vrng.fork('pv', i).chance(c.macros.repetition * 0.45))
      abstract = vary(abstract, c.vrng.fork('pvd', i), c.macros.repetition);
    // Final chorus climax: lift the peak of the closing phrases.
    if (c.kind === 'final-chorus' && i >= Math.max(1, slots.length - 2)) {
      const peak = abstract.reduce((best, n, k) => (n.degree > abstract[best].degree ? k : best), 0);
      if (peak > 0 && peak < abstract.length - 1)
        abstract[peak] = {
          ...abstract[peak],
          degree: abstract[peak].degree + 2,
          duration: Math.max(abstract[peak].duration, beat),
        };
    }
    const startTick = slot.start + abstract[0].offset;
    const chord = chordAtIn(c.chords, startTick);
    const chordKey = `${chord.root}:${chord.quality}`;
    const placed = motifId ? motifAnchors.get(motifId) : undefined;
    let anchor: number;
    if (placed && placed.chordKey === chordKey) {
      // The hook comes back over the same chord: sing it exactly as before.
      anchor = placed.anchor;
    } else {
      const target =
        prevEnd === null
          ? hookPhrase
            ? center + 2
            : center
          : clamp(prevEnd + (hookPhrase ? 2 : 0), low + 2, high - 2);
      // Keep the whole phrase inside the register (≈1.7 semitones per scale step).
      const degs = abstract.map((n) => n.degree);
      const lowT = low + Math.ceil(-Math.min(0, ...degs) * 1.7);
      const highT = high - Math.ceil(Math.max(0, ...degs) * 1.7);
      const t2 = lowT <= highT ? clamp(target, lowT, highT) : Math.round((lowT + highT) / 2);
      anchor = anchorNear(chord, t2, c.key);
      if (motifId && !placed) motifAnchors.set(motifId, { anchor, chordKey });
    }
    const realized = realizePhrase(abstract, {
      start: slot.start,
      anchor,
      key: c.key,
      chords: c.chords,
      low,
      high,
      meterAt: c.meterAt,
      strongFit: true,
      motifId,
    });
    // Cadence: the closing note of the section resolves to a stable chord tone.
    if (last && realized.length) {
      const tail = realized[realized.length - 1];
      const tc = chordAtIn(c.chords, tail.tick);
      const pcs = chordPitchClasses(tc);
      const prefer = c.next ? pcs.slice(0, 3) : [c.key.tonic, ...pcs];
      let best = tail.pitch;
      let bestD = Infinity;
      for (let d = -5; d <= 5; d++) {
        const p = tail.pitch + d;
        if (!prefer.includes(mod12(p)) || p < low || p > high) continue;
        const score = Math.abs(d) + (mod12(p) === c.key.tonic && !c.next ? -1 : 0);
        if (score < bestD) {
          bestD = score;
          best = p;
        }
      }
      tail.pitch = best;
    }
    const key = `p${i}`;
    const e = c.energyAt(slot.start);
    realized.forEach((n, k) => {
      n.velocity = toVelocity((n.velocity * (0.72 + 0.34 * e) - 85) * (0.65 + 0.7 * c.macros.dynamics) + 85);
      n.phraseId = key;
      if (isVocal) {
        const expr: VocalExpression = {};
        const longNote = n.duration >= beat * 1.5;
        if (longNote) {
          expr.vibrato = Math.round((0.35 + 0.25 * e) * 100) / 100;
          if (k === realized.length - 1) expr.release = c.kind === 'verse' ? 'falling' : 'normal';
        }
        if (k === 0)
          expr.onset = c.kind === 'verse' && e < 0.55 ? 'soft' : chorusy && e > 0.85 ? 'hard' : 'normal';
        expr.breathiness = Math.round((c.kind === 'verse' ? 0.32 : chorusy ? 0.14 : 0.22) * 100) / 100;
        expr.tension = Math.round(clamp(0.3 + e * 0.45, 0, 1) * 100) / 100;
        n.expression = expr;
        if (syllables.length) {
          n.syllable = syllables[k] ?? '_';
          // Lyric line of this syllable.
          let acc = 0;
          for (const l of slot.lines) {
            acc += lineSyllables(l.text).length;
            if (k < acc) {
              n.lyricLineId = l.id;
              break;
            }
          }
        }
      }
      notes.push(n);
    });
    if (realized.length) {
      const lastNote = realized[realized.length - 1];
      prevEnd = lastNote.pitch;
      const label = hookPhrase ? `${c.section.name} hook` : `${c.section.name} phrase ${i + 1}`;
      const draft: PhraseDraft = {
        key,
        startTick: realized[0].tick,
        endTick: lastNote.tick + lastNote.duration,
        label,
      };
      if (motifId) draft.motifId = motifId;
      if (slot.lines[0]) draft.lyricLineId = slot.lines[0].id;
      phrases.push(draft);
    }
  });
  humanize(notes, c.macros.humanization * 0.6, c.vrng.fork('humanize'), {
    start: c.span.startTick,
    end: c.span.endTick,
    maxTicks: 10,
    maxVelocity: 6,
  });
  return { notes, phrases: isVocal ? phrases : undefined };
}

/** Backing vocals: a third above (or below) the lead in choruses; soft "oohs" elsewhere. */
function backingVocal(c: Cell): GenOutput {
  const lead = c.melodyNotes();
  const notes: RawNote[] = [];
  const r = c.range;
  const chorusy =
    c.kind === 'chorus' || c.kind === 'final-chorus' || c.kind === 'post-chorus' || c.kind === 'drop';
  if (lead.length && chorusy) {
    for (const n of lead) {
      const ch = chordAtIn(c.chords, n.tick);
      const pcs = chordPitchClasses(ch);
      const options = [2, -2, -5, 4].map((steps) => transposeDiatonic(n.pitch, steps, c.key));
      let pitch =
        options.find((p) => p >= r.low && p <= r.high && pcs.includes(mod12(p))) ??
        options.find((p) => p >= r.low && p <= r.high) ??
        n.pitch;
      if (pitch === n.pitch) pitch = clamp(n.pitch - 12, r.low, r.high);
      const out: RawNote = {
        pitch,
        tick: n.tick,
        duration: n.duration,
        velocity: toVelocity(n.velocity - 14),
      };
      if (n.syllable) out.syllable = n.syllable;
      if (n.lyricLineId) out.lyricLineId = n.lyricLineId;
      notes.push(out);
    }
    return { notes };
  }
  // "Oohs": one sustained, voice-led chord tone per chord.
  let prev = Math.round((r.comfortableLow + r.comfortableHigh) / 2);
  for (const ch of c.chords) {
    const pcs = chordPitchClasses(ch);
    let best = prev;
    let bestD = Infinity;
    for (let p = r.comfortableLow; p <= r.comfortableHigh; p++) {
      if (!pcs.includes(mod12(p))) continue;
      const d = Math.abs(p - prev) + (mod12(p) === ch.root ? 1 : 0);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    prev = best;
    notes.push({
      pitch: best,
      tick: ch.tick,
      duration: Math.max(60, ch.duration - 30),
      velocity: toVelocity(58 + 30 * c.energyAt(ch.tick)),
      syllable: 'ooh',
      articulation: 'legato',
    });
  }
  return { notes };
}

/** Choir pad: SATB-style voice-led chords. */
function choirPad(c: Cell): GenOutput {
  const notes: RawNote[] = [];
  let prev: number[] | undefined;
  const r = c.range;
  for (const ch of c.chords) {
    const v = voiceChord(
      { root: ch.root, quality: ch.quality },
      {
        low: Math.max(r.low, 45),
        high: Math.min(r.high, 79),
        voices: c.inst.polyphony === 'mono' ? 1 : 4,
        previous: prev,
        center: 62,
      },
    );
    prev = v;
    const e = c.energyAt(ch.tick);
    for (const p of v)
      notes.push({
        pitch: p,
        tick: ch.tick,
        duration: Math.max(60, ch.duration - 20),
        velocity: toVelocity(54 + 46 * e),
        articulation: 'legato',
        syllable: 'aah',
      });
  }
  return { notes };
}

export function generateVocal(c: Cell): GenOutput {
  if (c.fn === 'pad' || c.fn === 'texture' || c.inst.id === 'choir') return choirPad(c);
  if (c.fn === 'harmony' || c.fn === 'accompaniment') {
    if (c.melodyNotes().length || c.g.principalMelodyId) return backingVocal(c);
    return choirPad(c);
  }
  return mainMelody(c, { vocal: true });
}

export const VOCAL_MOTIFS = MOTIF_DESCRIPTIONS;
