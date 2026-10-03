import type { ChordSpec, KeySignature, ModeName, MusicOperation, Song } from '../ir/types';
import { sectionLayout, keyAtTick } from '../timing';
import { isChordSectionLocked } from '../locks';
import { chordPitchClasses, chordTones, diatonicChord, isDiatonic, isDominantQuality, triadQuality } from '../theory/chords';
import { chordDegree } from '../theory/roman';
import { MODE_COLOR_NOTE, chordFunction } from '../theory/analysis';
import { isMinorMode } from '../theory/scales';
import { mod12, spellPitchClass } from '../theory/pitch';
import { deriveRng } from '../util/random';
import {
  type ChordSlot,
  chordOpsFromSlots,
  chordSlots,
  chordSpecOf,
  emitNoteOps,
  isDrumTrack,
  isPitchedTrack,
  lockChecker,
  toWork,
  trackPitchRange,
  isBassTrack,
  isVocalTrack,
  isMelodicTrack,
  type WorkNote,
} from './op-helpers';
import {
  MODE_LABEL,
  brightenChord,
  brighterMode,
  chooseModalColour,
  darkenChord,
  darkerMode,
  modalChord,
  relaxChord,
  romanOf,
  sameChord,
  scaleMapFn,
  spellChord,
  tenseChord,
  unconventionalChord,
} from './harmony';
import { refitNotes } from './transforms';
import { sectionAnalysisKey } from './theory-explain';
import type { ChordSuggestion, EditInterpretation, TheoryControl } from './types';
import { listJoin } from './nlp';

/**
 * §43 Theory View controls ("Make darker", "Increase tension", "Make less conventional",
 * "Try modal harmony", …) and chord-substitution suggestions. Controls return `set_chords`
 * plus note fixes so melody, bass and accompaniment agree with the new harmony.
 */

const CONTROL_LABEL: Record<TheoryControl, string> = {
  darker: 'Make darker',
  brighter: 'Make brighter',
  'more-tension': 'Increase tension',
  'less-tension': 'Reduce tension',
  'less-conventional': 'Make less conventional',
  modal: 'Try modal harmony',
  simplify: 'Simplify harmony',
};

interface ChordChange {
  from: ChordSpec;
  to: ChordSpec[];
  note?: string;
}

export function applyTheoryControl(song: Song, sectionId: string, control: TheoryControl, opts: { seed: number }): EditInterpretation {
  const span = sectionLayout(song).find((s) => s.section.id === sectionId || s.section.name === sectionId);
  const label = CONTROL_LABEL[control];
  if (!span) return { operations: [], explanation: `There is no section "${sectionId}".`, intents: [control], understood: false };
  const sec = span.section;
  if (isChordSectionLocked(song, sec.id)) {
    return {
      operations: [],
      explanation: `${label}: the chords of ${sec.name} are locked, so the harmony was left unchanged. Unlock "${sec.name}" chords to try this.`,
      intents: [control],
      understood: true,
    };
  }
  const rng = deriveRng(opts.seed, 'theory-control', control, sec.id);
  const key = sectionAnalysisKey(song, sec.id);
  const slots = chordSlots(song);
  const inSec = slots.filter((s) => s.tick >= span.startTick && s.tick < span.endTick);
  if (!inSec.length) return { operations: [], explanation: `${label}: ${sec.name} has no chords to change.`, intents: [control], understood: true };

  const changes: ChordChange[] = [];
  let why = '';
  let scaleTarget: ModeName | null = null;
  const replaced = new Map<ChordSlot, ChordSlot[]>();
  const put = (s: ChordSlot, specs: ChordSpec[], note?: string) => {
    if (specs.length === 1 && sameChord(specs[0], s.spec)) return;
    const n = specs.length;
    const each = Math.floor(s.duration / n);
    replaced.set(
      s,
      specs.map((spec, i) => ({ tick: s.tick + i * each, duration: i === n - 1 ? s.duration - each * (n - 1) : each, spec, sourceId: s.sourceId })),
    );
    changes.push({ from: s.spec, to: specs, note });
  };

  switch (control) {
    case 'darker': {
      scaleTarget = darkerMode(key.mode);
      let keptDominant: ChordSpec | null = null;
      for (const s of inSec) {
        const nxt = slots[slots.indexOf(s) + 1]?.spec;
        const dark = darkenChord(s.spec, key, nxt);
        if (sameChord(dark, s.spec) && !sameChord(darkenChord(s.spec, key), s.spec)) keptDominant = s.spec;
        put(s, [dark]);
      }
      why = isMinorMode(key.mode)
        ? `Phrygian colour: the lowered 2nd (and natural-minor 6th/7th) push the harmony further into shadow while keeping the same roots and phrase rhythm.`
        : `Modal interchange with ${spellPitchClass(key.tonic, key)} minor: bright major thirds become minor and the 6th/7th degrees are lowered — same roots and phrase rhythm, but a shadowed, bittersweet colour.`;
      if (keptDominant)
        why += ` ${spellChord(keptDominant, key)} (${romanOf(keptDominant, key)}) keeps its major third because it resolves to the tonic — the harmonic-minor dominant keeps the pull home.`;
      break;
    }
    case 'brighter': {
      scaleTarget = brighterMode(key.mode);
      for (const s of inSec) put(s, [brightenChord(s.spec, key)]);
      why = scaleTarget
        ? `Borrowing from the parallel major raises the 3rd/6th/7th degrees: minor chords turn major and the leading tone returns, lifting the mood without moving the bass roots.`
        : `Raising the thirds of the minor chords (ii → II, iii → III, vi → VI) adds secondary-dominant brightness and forward motion while the roots stay put.`;
      break;
    }
    case 'more-tension': {
      inSec.forEach((s, i) => {
        const next = inSec[i + 1];
        const beats = s.duration / song.ppq;
        const t = tenseChord(s.spec, key, rng);
        const isV = mod12(s.spec.root - key.tonic) === 7;
        if (i === inSec.length - 1 && isV && beats >= 2) {
          put(s, [{ root: s.spec.root, quality: '7sus4' }, { root: s.spec.root, quality: isMinorMode(key.mode) ? '7b9' : '7' }], 'dominant suspension before the next section');
        } else if (next && beats >= 4 && !isDominantQuality(t.quality) && mod12(next.spec.root - key.tonic) !== 7 && rng.chance(0.6)) {
          // Approach the next chord through its own dominant in the last half of this chord.
          const secDom: ChordSpec = { root: mod12(next.spec.root + 7), quality: '7' };
          put(s, [t, secDom], `secondary dominant leading into ${spellChord(next.spec, key)}`);
        } else put(s, [t]);
      });
      {
        const hasSus = changes.some((c) => c.to.some((t) => t.quality === '7sus4'));
        const hasSec = changes.some((c) => c.note?.startsWith('secondary dominant'));
        why = [
          'Sevenths and ninths add friction',
          hasSec ? 'secondary dominants point at the chord that follows' : '',
          hasSus ? 'and the closing dominant suspension (7sus4 → 7) delays the resolution so the next section lands harder' : '',
        ]
          .filter(Boolean)
          .join(', ')
          .replace(/, and/, ' and') + '.';
      }
      break;
    }
    case 'less-tension': {
      for (const s of inSec) put(s, [relaxChord(s.spec, key)]);
      why = 'Sevenths, suspensions, secondary dominants and borrowed colours are replaced by plain diatonic triads, so every chord sits comfortably in the key.';
      break;
    }
    case 'simplify': {
      // Merge passing chords shorter than a beat into the previous chord, then strip colour.
      const kept: ChordSlot[] = [];
      for (const s of inSec) {
        const last = kept[kept.length - 1];
        if (last && s.duration < song.ppq) {
          replaced.set(s, []);
          const prevRepl = replaced.get(last);
          const target = prevRepl && prevRepl.length ? prevRepl[prevRepl.length - 1] : undefined;
          if (target) target.duration += s.duration;
          else {
            replaced.set(last, [{ ...last, duration: last.duration + s.duration, spec: relaxChord(last.spec, key) }]);
          }
          changes.push({ from: s.spec, to: [], note: 'passing chord removed' });
          continue;
        }
        kept.push(s);
        const simple = relaxChord(s.spec, key);
        if (!sameChord(simple, s.spec)) put(s, [simple]);
      }
      why = 'Extensions, slash basses and passing chords are removed so the progression is easier to play and the melody carries the colour.';
      break;
    }
    case 'less-conventional': {
      const candidates = inSec.length >= 3 ? inSec.slice(1) : inSec;
      let changed = 0;
      candidates.forEach((s, i) => {
        if (changed >= Math.ceil(candidates.length / 2) || (!rng.chance(0.55) && !(i === candidates.length - 1 && changed === 0))) return;
        const u = unconventionalChord(s.spec, key, rng);
        if (u && !sameChord(u.spec, s.spec)) {
          put(s, [u.spec], u.label);
          changed++;
        }
      });
      why = 'Chromatic mediants, tritone substitutions and borrowed or inverted chords keep the phrase structure (and the first chord as an anchor) but steer the ear somewhere it does not expect.';
      break;
    }
    case 'modal': {
      const mode = chooseModalColour(key, rng);
      scaleTarget = mode;
      for (const s of inSec) put(s, [modalChord(s.spec, key, mode)]);
      const colour = MODE_COLOR_NOTE[mode];
      why = `${spellPitchClass(key.tonic, key)} ${MODE_LABEL[mode]} colour${colour ? ` — its characteristic ${colour.description}` : ''}: ${
        mode === 'mixolydian'
          ? 'the leading-tone dominant (V) becomes a minor v and vii° becomes bVII, a rock/folk sound with no strong pull back to I.'
          : mode === 'lydian'
            ? 'the IV chord becomes a major II, giving a floating, dreamy lift.'
            : mode === 'dorian'
              ? 'the minor iv becomes a major IV, a brighter, soulful minor.'
              : 'the supertonic becomes a major bII, a dark, Spanish-tinged colour.'
      }`;
      break;
    }
  }

  if (!replaced.size) {
    return { operations: [], explanation: `${label}: the chords of ${sec.name} already fit this colour — nothing to change.`, intents: [control], understood: true };
  }
  const finalSlots: ChordSlot[] = [];
  for (const s of slots) {
    const r = replaced.get(s);
    if (r) finalSlots.push(...r);
    else finalSlots.push(s);
  }
  const reason = `${label} (${sec.name})`;
  const chordRes = chordOpsFromSlots(song, finalSlots, reason);
  const ops: MusicOperation[] = [...chordRes.ops];

  // Fit notes of every unlocked pitched track in the section to the new chords.
  const scaleMap = scaleTarget && scaleTarget !== key.mode ? scaleMapFn(key, { tonic: key.tonic, mode: scaleTarget }) : undefined;
  const fitted: string[] = [];
  const skipped: string[] = [];
  for (const track of song.tracks) {
    if (track.kind !== 'midi' || !isPitchedTrack(track)) continue;
    const isL = lockChecker(song, track);
    const work: WorkNote[] = track.notes.map(toWork);
    const editable = work.filter((n, i) => n.tick >= span.startTick && n.tick < span.endTick && !isL(track.notes[i]));
    const lockedHere = track.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick && isL(n)).length;
    if (lockedHere) skipped.push(`${track.name} (${lockedHere} locked note${lockedHere === 1 ? '' : 's'})`);
    if (!editable.length) continue;
    const { low, high } = trackPitchRange(track);
    const res = refitNotes(
      {
        song,
        track,
        rng,
        ranges: [{ startTick: span.startTick, endTick: span.endTick }],
        context: work,
        chords: finalSlots,
        isDrums: isDrumTrack(track),
        isBass: isBassTrack(track),
        isVocal: isVocalTrack(track),
        isMelodic: isMelodicTrack(track),
        low,
        high,
        amount: 1,
      },
      editable,
      slots,
      finalSlots,
      scaleMap ? () => scaleMap : undefined,
    );
    if (!res.summary) continue;
    const set = new Set(editable);
    const finalNotes = [...work.filter((n) => !set.has(n)), ...res.notes];
    const emitted = emitNoteOps(song, track, track.notes, finalNotes, { reason });
    if (emitted.ops.length) {
      ops.push(...emitted.ops);
      fitted.push(`${track.name} (${emitted.modified} note${emitted.modified === 1 ? '' : 's'})`);
    }
  }

  const changeText = changes
    .slice(0, 8)
    .map((c) =>
      c.to.length
        ? `${spellChord(c.from, key)} → ${c.to.map((t) => spellChord(t, key)).join(' → ')} (${romanOf(c.from, key)} → ${c.to.map((t) => romanOf(t, key)).join(' → ')})${c.note ? ` — ${c.note}` : ''}`
        : `${spellChord(c.from, key)} removed (${c.note})`,
    )
    .join('; ');
  const parts = [`${label} — ${sec.name} (in ${spellPitchClass(key.tonic, key)} ${MODE_LABEL[key.mode]}): ${changeText}${changes.length > 8 ? '; …' : ''}.`, why];
  if (fitted.length) parts.push(`Adjusted ${listJoin(fitted)} so they agree with the new chords.`);
  if (skipped.length) parts.push(`Locked material was skipped: ${listJoin(skipped)} — check those notes against the new harmony.`);
  return { operations: ops, explanation: parts.join(' '), intents: [control], understood: true };
}

// ---------------------------------------------------------------------------
// Chord substitutions
// ---------------------------------------------------------------------------

export function suggestChordSubstitutions(song: Song, chordId: string): ChordSuggestion[] {
  const ev = song.chords.find((c) => c.id === chordId);
  if (!ev) return [];
  const spec = chordSpecOf(ev);
  const sec = sectionLayout(song).find((s) => ev.tick >= s.startTick && ev.tick < s.endTick);
  const key: KeySignature = sec ? sectionAnalysisKey(song, sec.section.id) : keyAtTick(song, ev.tick);
  const sorted = [...song.chords].sort((a, b) => a.tick - b.tick);
  const idx = sorted.findIndex((c) => c.id === chordId);
  const prev = idx > 0 ? chordSpecOf(sorted[idx - 1]) : undefined;
  const next = idx >= 0 && idx + 1 < sorted.length ? chordSpecOf(sorted[idx + 1]) : undefined;
  const out: ChordSuggestion[] = [];
  const seen = new Set<string>([spellChord(spec, key)]);
  const add = (s: ChordSpec, reason: string) => {
    const symbol = spellChord(s, key);
    if (seen.has(symbol)) return;
    seen.add(symbol);
    out.push({ symbol, roman: romanOf(s, key), reason });
  };
  const name = spellChord(spec, key);
  const tq = triadQuality(spec.quality);
  const deg = chordDegree(spec, key);
  const fn = chordFunction(spec, key);
  const nextName = next ? spellChord(next, key) : '';

  // 1) Relatives sharing two notes (same function family).
  const relatives: ChordSpec[] =
    tq === 'maj'
      ? [
          { root: mod12(spec.root - 3), quality: 'min' },
          { root: mod12(spec.root + 4), quality: 'min' },
        ]
      : tq === 'min'
        ? [
            { root: mod12(spec.root + 3), quality: 'maj' },
            { root: mod12(spec.root - 4), quality: 'maj' },
          ]
        : [];
  for (const r of relatives) {
    if (!isDiatonic(r, key)) continue;
    const shared = chordPitchClasses(r).filter((pc) => chordPitchClasses({ root: spec.root, quality: tq === 'min' ? 'min' : 'maj' }).includes(pc)).length;
    add(r, `Shares ${shared} notes with ${name}, so the melody still fits; a ${chordFunction(r, key)}-function substitute with a ${triadQuality(r.quality) === 'min' ? 'softer, darker' : 'brighter, more open'} colour.`);
  }
  // 2) Same-function diatonic substitutes.
  for (let d = 0; d < 7; d++) {
    const c = diatonicChord(key, d);
    if (c.root === spec.root || chordFunction(c, key) !== fn || triadQuality(c.quality) === 'dim') continue;
    add(c, `Another ${fn} chord: keeps the progression's direction while changing the colour.`);
  }
  // 3) Modal interchange.
  const parallelMinor = !isMinorMode(key.mode);
  if (deg >= 0) {
    const borrowed: ChordSpec[] = [];
    if (parallelMinor) {
      if (deg === 3 && tq === 'maj') borrowed.push({ root: spec.root, quality: 'min' });
      if (deg === 5) borrowed.push({ root: mod12(key.tonic + 8), quality: 'maj' });
      if (deg === 4) borrowed.push({ root: mod12(key.tonic + 10), quality: 'maj' });
      if (deg === 0) borrowed.push({ root: spec.root, quality: 'min' });
      if (deg === 2) borrowed.push({ root: mod12(key.tonic + 3), quality: 'maj' });
      if (deg === 1) borrowed.push({ root: spec.root, quality: 'm7b5' });
    } else {
      if (deg === 3 && tq === 'min') borrowed.push({ root: spec.root, quality: 'maj' });
      if (deg === 4 && tq === 'min') borrowed.push({ root: spec.root, quality: '7' });
      if (deg === 0 && tq === 'min') borrowed.push({ root: spec.root, quality: 'maj' });
    }
    for (const b of borrowed)
      add(b, parallelMinor ? `Borrowed from ${spellPitchClass(key.tonic, key)} minor (modal interchange): a bittersweet shade over the same bass motion.` : `Borrowed from ${spellPitchClass(key.tonic, key)} major/Dorian: lifts the minor key with a brighter chord.`);
  }
  // 4) Secondary dominant of the next chord.
  if (next && mod12(next.root - key.tonic) !== 0 && triadQuality(next.quality) !== 'dim') {
    add({ root: mod12(next.root + 7), quality: '7' }, `Secondary dominant (V7 of ${nextName}): points strongly at the next chord and adds forward pull.`);
  }
  if (next && mod12(next.root - key.tonic) === 0) add({ root: mod12(key.tonic + 7), quality: '7' }, `The dominant seventh sets up a strong V7 → I arrival on ${nextName}.`);
  // 5) Tritone substitution.
  if (isDominantQuality(spec.quality) || (deg === 4 && tq === 'maj')) {
    add({ root: mod12(spec.root + 6), quality: '7' }, `Tritone substitution: keeps the same tritone (3rd and 7th) but the bass slides chromatically${nextName ? ` into ${nextName}` : ''} — a jazzy, sophisticated colour.`);
  } else if (next && mod12(next.root - key.tonic) === 0) {
    add({ root: mod12(next.root + 1), quality: '7' }, `Tritone-substitute dominant (bII7) resolving down a half step into ${nextName}.`);
  }
  // 6) Suspensions.
  if (tq === 'maj' || tq === 'min') {
    add({ root: spec.root, quality: 'sus4' }, 'Suspended 4th: removes the third for an open, unresolved sound that wants to fall back to the triad.');
    add({ root: spec.root, quality: 'sus2' }, 'Suspended 2nd: a hollow, modern sound — neither major nor minor.');
    if (fn === 'dominant') add({ root: spec.root, quality: '7sus4' }, 'Dominant 7sus4: classic gospel/pop pre-chorus tension before the V7.');
  }
  // 7) Extensions.
  const ext: ChordSpec[] =
    tq === 'min'
      ? [{ root: spec.root, quality: 'min7' }, { root: spec.root, quality: 'min9' }]
      : isDominantQuality(spec.quality) || (fn === 'dominant' && tq === 'maj')
        ? [{ root: spec.root, quality: '9' }, { root: spec.root, quality: '13' }]
        : tq === 'maj'
          ? [{ root: spec.root, quality: 'maj7' }, { root: spec.root, quality: 'add9' }]
          : [];
  for (const e of ext) add(e, 'Extension: same function and bass, with added colour (lush rather than plain).');
  // 8) Inversion for a smoother bass line.
  if (tq === 'maj' || tq === 'min') {
    const tones = chordTones({ root: spec.root, quality: tq });
    const third = tones.find((t) => t.role === 'third')!.pc;
    const fifth = tones.find((t) => t.role === 'fifth')!.pc;
    const prevBass = prev ? (prev.bass ?? prev.root) : undefined;
    const nextBass = next ? (next.bass ?? next.root) : undefined;
    const stepwise = (pc: number) => [prevBass, nextBass].filter((b) => b !== undefined).some((b) => Math.min(mod12(pc - b!), mod12(b! - pc)) <= 2);
    add({ root: spec.root, quality: tq, bass: third }, `First inversion (third in the bass)${stepwise(third) ? ': makes the bass line move by step' : ': a lighter, less grounded sound'}.`);
    if (fn === 'tonic' && next && chordFunction(next, key) === 'dominant')
      add({ root: spec.root, quality: tq, bass: fifth }, 'Second inversion (cadential 6/4): the classic set-up for the dominant that follows.');
  }
  // 9) Passing diminished chord.
  if (next && mod12(next.root - spec.root) === 2) {
    add({ root: mod12(spec.root + 1), quality: 'dim7' }, `Passing diminished 7th: use it for the last beat to walk chromatically from ${name} up to ${nextName}.`);
  }
  // 10) Deceptive resolutions.
  if (prev && mod12(prev.root - key.tonic) === 7 && deg === 0) {
    add({ root: mod12(key.tonic + 9), quality: 'min' }, 'Deceptive resolution: after the dominant the ear expects I, and vi side-steps it.');
    add({ root: mod12(key.tonic + 8), quality: 'maj' }, 'Deceptive resolution to bVI: a dramatic, cinematic surprise.');
  }
  // 11) Pedal point.
  if (deg !== 0 && spec.root !== key.tonic) add({ root: spec.root, quality: tq === 'min' ? 'min' : 'maj', bass: key.tonic }, 'Over a tonic pedal: keeps the bass on the home note for a floating, cinematic feel.');
  return out.slice(0, 14);
}

/** Exposed for the assistant: chord-locked check for a section. */
export function sectionChordsLocked(song: Song, sectionId: string): boolean {
  return isChordSectionLocked(song, sectionId);
}
