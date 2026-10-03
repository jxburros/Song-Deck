import type { EditSelection, LyricLine, MusicOperation, Note, Song, Track, VocalExpression } from '../ir/types';
import { findTrack } from '../ir/song-utils';
import { sectionLayout, tickToMusical } from '../timing';
import { isTrackSectionLocked } from '../locks';
import { chordPitchClasses } from '../theory/chords';
import { midiToNoteNameInKey, mod12 } from '../theory/pitch';
import { transposeDiatonic } from '../theory/scales';
import { deriveRng } from '../util/random';
import { amountOf, extractQuoted, findSectionMentions, listJoin, normalizeText, parseTranspose } from './nlp';
import {
  type TickRange,
  type WorkNote,
  beatTicks,
  chordSpecAt,
  clamp01,
  clampVel,
  describeRanges,
  emitNoteOps,
  foldPitch,
  keyAt,
  lockChecker,
  mergeRanges,
  rangeToRegion,
  round2,
  sectionRanges,
  selectionRanges,
  sortWork,
  toWork,
  trackPitchRange,
} from './op-helpers';
import { groupNotesByLine, provisionalSyllables } from './lyrics/align';
import { splitPhrases } from './transforms';
import { interpretMixInstruction } from './mix-assistant';
import type { VocalInterpretation } from './types';

/**
 * §37 Independent vocal regeneration — performance-level commands on a vocal track
 * ("Make the final line more aggressive", "Add vibrato here", "Sing this note more softly",
 * "Change the melody on the word 'fire'", "Regenerate only the second chorus vocal").
 * Expression changes become `set_expression` (+ `transform_notes` for velocity/pitch/length);
 * regeneration becomes a `regenerate` op plus the tick range to re-render.
 */

type VocalIntent =
  | 'regenerate'
  | 'change-melody'
  | 'aggressive'
  | 'softer'
  | 'louder'
  | 'less-vibrato'
  | 'vibrato'
  | 'less-breathy'
  | 'breathier'
  | 'legato'
  | 'staccato'
  | 'scoop'
  | 'release-falling'
  | 'release-rising'
  | 'release-breathy'
  | 'release-cut'
  | 'hard-onset'
  | 'soft-onset'
  | 'emotional'
  | 'relaxed'
  | 'tense'
  | 'hold'
  | 'transpose'
  | 'higher'
  | 'lower';

const V_RULES: { id: VocalIntent; re: RegExp }[] = [
  { id: 'regenerate', re: /\bre-?generate\b|\bregen\b|\bredo\b|\bnew (?:take|version|vocal)\b|\brewrite the (?:vocal|melody)\b|\btry (?:again|another)\b|\bre-?sing\b/ },
  { id: 'release-breathy', re: /\bbreathy release\b|\bsigh(?:ing)? (?:at the end|off)\b|\bexhale\b/ },
  { id: 'release-falling', re: /\bfall(?:ing)?[\s-]?(?:off|release)s?\b|\bfalling release\b|\bdrop off\b|\bfall at the end\b/ },
  { id: 'release-rising', re: /\brising release\b|\bflip up\b|\binflect(?:ion)? up\b|\brise at the end\b/ },
  { id: 'release-cut', re: /\bcut (?:off|the ends?)\b|\babrupt(?:ly)?\b|\bshort endings?\b/ },
  { id: 'hard-onset', re: /\bhard (?:onset|attack)s?\b|\bpunchier attack\b/ },
  { id: 'soft-onset', re: /\bsoft (?:onset|attack)s?\b/ },
  { id: 'change-melody', re: /\b(?:change|alter|rewrite|vary|new|different)\b[^,]*\b(?:melody|notes?|pitch(?:es)?|tune)\b/ },
  {
    id: 'aggressive',
    re: /\baggressive\b|\bangr(?:y|ier)\b|\bfierce(?:r)?\b|\bmore intense\b|\bintense\b|\bpowerful\b|\bbelt(?:ed|ing)?\b|\bmore edge\b|\bedgier\b|\bgritt(?:y|ier)\b|\bmore attitude\b|\bshout(?:y|ier|ed)?\b|\bmore energ(?:y|etic)\b|\bharder\b|\bpunch(?:y|ier)\b/,
  },
  { id: 'less-vibrato', re: /\b(?:less|no|without|remove(?: the)?|reduce(?: the)?)\s+(?:the\s+)?vibrato\b|\bstraight(?:er)? tone\b|\bvibrato off\b/ },
  { id: 'vibrato', re: /\bvibrato\b|\bwobble\b/ },
  { id: 'less-breathy', re: /\bless breath(?:y|iness)\b|\bclearer tone\b|\bless air(?:y)?\b|\bcleaner tone\b|\bmore focused tone\b/ },
  { id: 'breathier', re: /\bbreath(?:y|ier|iness)\b|\bairy\b|\bairier\b|\bmore air\b/ },
  { id: 'emotional', re: /\bmore (?:emotional|emotion|feeling|expressive|heartfelt|passionate)\b|\bemotional\b|\bwith (?:more )?feeling\b/ },
  { id: 'softer', re: /\bsoft(?:er|ly)?\b|\bgentl(?:e|er|y)\b|\bquiet(?:er|ly)?\b|\btender(?:ly)?\b|\bdelicate(?:ly)?\b|\bwhisper(?:ed|y)?\b|\bintimate\b|\bless loud\b|\bmore restrained\b|\blighter\b|\bhushed\b/ },
  { id: 'louder', re: /\blouder\b|\bstronger\b|\bmore projection\b|\bproject more\b|\bmore power\b/ },
  { id: 'legato', re: /\blegato\b|\bsmooth(?:er|ly)?\b|\bconnect(?:ed)?\b|\bslur(?:red)?\b|\bflowing\b/ },
  { id: 'staccato', re: /\bstaccato\b|\bdetached\b|\bchoppy\b|\bclipped\b/ },
  { id: 'scoop', re: /\bscoop(?:s|ed|ing)?\b|\bslide (?:up )?into\b|\bbend (?:up )?into\b/ },
  { id: 'relaxed', re: /\brelax(?:ed)?\b|\beffortless\b|\bless (?:strain(?:ed)?|tense|tension)\b/ },
  { id: 'tense', re: /\bmore (?:tension|strain|effort)\b|\bstrained\b|\btense\b/ },
  { id: 'hold', re: /\bhold\b[^,]*\blonger\b|\bsustain\b|\blonger\b|\bstretch (?:it|the note)\b/ },
  {
    id: 'transpose',
    re: /\b(?:up|down)\b[^,]*\b(?:octave|semi-?tones?|half[\s-]?steps?|whole[\s-]?steps?|third|fifth|step)\b|\btranspose\b|\b(?:an?|one|\d+)\s+(?:octaves?|semi-?tones?|half[\s-]?steps?|whole[\s-]?steps?|third|fourth|fifth)\s+(?:higher|lower|up|down)\b/,
  },
  { id: 'higher', re: /\bhigher\b/ },
  { id: 'lower', re: /\blower\b/ },
];

const MIX_RE = /\b(?:dr(?:y|ier)|wet(?:ter)?|reverb|delay|echo|eq|equali[sz]e|compress(?:ion|or)?|pan(?:ned)?|in the mix|mixer|mudd(?:y|iness)|harsh(?:ness)?|presence|sibilan(?:t|ce)|de-?ess)\b/;

const HELP =
  'For a vocal I can: make a line or note more aggressive/intense, softer/gentler, louder; add or remove vibrato; make it breathier or clearer; legato or staccato; scoop into notes; falling/rising/breathy/cut releases at phrase ends; hard or soft onsets; more emotional; relaxed or tense; hold notes longer; move notes up/down; change the melody on a word ("change the melody on the word \'fire\'"); or regenerate a section ("regenerate only the second chorus vocal"). Target "the final line", "the second line", "this note", "the word \'…\'", or a section.';

interface Scope {
  notes: Note[];
  label: string;
  ranges: TickRange[];
  sectionIds: string[];
  error?: string;
}

interface LineInfo {
  line?: LyricLine;
  notes: Note[];
}

function linesFor(song: Song, track: Track, notes: Note[]): LineInfo[] {
  const out: LineInfo[] = [];
  const ids = new Set(notes.map((n) => n.id));
  for (const span of sectionLayout(song)) {
    const secNotes = track.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick).sort((a, b) => a.tick - b.tick);
    if (!secNotes.some((n) => ids.has(n.id))) continue;
    const lines = song.lyrics.filter((l) => l.sectionId === span.section.id && (!l.trackId || l.trackId === track.id));
    if (lines.length) {
      const groups = groupNotesByLine(song, secNotes, lines);
      groups.forEach((g, i) => {
        const inScope = g.filter((n) => ids.has(n.id));
        if (inScope.length) out.push({ line: lines[i], notes: inScope });
      });
    } else {
      const beat = beatTicks(song, span.startTick);
      for (const ph of splitPhrases(secNotes, beat)) {
        const inScope = ph.filter((n) => ids.has(n.id));
        if (inScope.length) out.push({ notes: inScope });
      }
    }
  }
  return out;
}

function ordinalIndex(word: string, count: number): number {
  const map: Record<string, number> = { first: 0, '1st': 0, opening: 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4 };
  if (word === 'last' || word === 'final' || word === 'closing') return count - 1;
  if (/^\d+$/.test(word)) return parseInt(word, 10) - 1;
  return map[word] ?? -1;
}

function wordNotes(song: Song, track: Track, notes: Note[], word: string): Note[] {
  const target = word.toLowerCase().replace(/[^a-z']/g, '');
  const lines = song.lyrics.filter((l) => !l.trackId || l.trackId === track.id);
  const syl = new Map<string, string>();
  for (const span of sectionLayout(song)) {
    const secNotes = track.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick).sort((a, b) => a.tick - b.tick);
    const secLines = lines.filter((l) => l.sectionId === span.section.id);
    for (const [k, v] of provisionalSyllables(song, track, secNotes, secLines)) syl.set(k, v);
  }
  const out: Note[] = [];
  let cur: Note[] = [];
  let text = '';
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    const s = (syl.get(n.id) ?? '').trim();
    if (!s) continue;
    if (s === '_') {
      if (out.length && out[out.length - 1] === sorted[i - 1]) out.push(n);
      continue;
    }
    cur.push(n);
    text += s.replace(/-$/, '');
    if (!s.endsWith('-')) {
      if (text.toLowerCase().replace(/[^a-z']/g, '') === target) out.push(...cur);
      cur = [];
      text = '';
    }
  }
  return out;
}

function resolveScope(song: Song, track: Track, text: string, raw: string, selection: EditSelection): Scope {
  const all = [...track.notes].sort((a, b) => a.tick - b.tick);
  const secM = findSectionMentions(song, text).filter((m) => m.sections.length);
  let notes = all;
  let label = `the whole ${track.name}`;
  let sectionIds: string[] = [];
  let ranges: TickRange[] = all.length ? [{ startTick: all[0].tick, endTick: Math.max(...all.map((n) => n.tick + n.duration)) }] : [];
  const selR = selectionRanges(song, selection);
  if (secM.length) {
    sectionIds = [...new Set(secM.flatMap((m) => m.sections.map((s) => s.id)))];
    ranges = sectionRanges(song, sectionIds);
    notes = all.filter((n) => ranges.some((r) => n.tick >= r.startTick && n.tick < r.endTick));
    label = listJoin(secM.flatMap((m) => m.sections.map((s) => s.name)));
  } else if (selection.noteIds?.length) {
    const ids = new Set(selection.noteIds);
    notes = all.filter((n) => ids.has(n.id));
    label = notes.length === 1 ? 'the selected note' : 'the selected notes';
    ranges = selR ?? ranges;
  } else if (selR) {
    notes = all.filter((n) => selR.some((r) => n.tick >= r.startTick && n.tick < r.endTick));
    ranges = selR;
    label = selection.sectionIds?.length ? listJoin(song.sections.filter((s) => selection.sectionIds!.includes(s.id)).map((s) => s.name)) : describeRanges(song, selR);
    if (selection.sectionIds?.length) sectionIds = [...selection.sectionIds];
  }
  // The word 'fire'.
  const quoted = extractQuoted(raw);
  const wm = /\bword\s+"?'?([a-z][a-z']*)/.exec(text);
  const word = quoted[0] ?? wm?.[1];
  if (word && (quoted.length || wm)) {
    const wn = wordNotes(song, track, notes, word);
    if (!wn.length) return { notes: [], label, ranges, sectionIds, error: `I couldn't find the word "${word}" in ${label} (attach lyrics to the vocal notes first, or select the notes).` };
    return { notes: wn, label: `the word "${word}"${wn.length > 1 ? ` (${wn.length} notes)` : ''}`, ranges: mergeRanges(wn.map((n) => ({ startTick: n.tick, endTick: n.tick + n.duration }))), sectionIds };
  }
  // The final line / the second phrase / line 3.
  const lm = /\b(first|1st|opening|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final|closing)\s+(?:lyric\s+)?(?:line|phrase|lyric)\b/.exec(text) ?? /\b(?:line|phrase)\s+(\d+)\b/.exec(text);
  if (lm) {
    const lines = linesFor(song, track, notes);
    const idx = ordinalIndex(lm[1], lines.length);
    const li = lines[idx];
    if (!li) return { notes: [], label, ranges, sectionIds, error: `There is no ${lm[1]} line in ${label}.` };
    const lineLabel = li.line ? `the ${lm[1]} line ("${li.line.text}")` : `the ${lm[1]} phrase`;
    return { notes: li.notes, label: lineLabel, ranges: mergeRanges([{ startTick: li.notes[0].tick, endTick: Math.max(...li.notes.map((n) => n.tick + n.duration)) }]), sectionIds };
  }
  return { notes, label, ranges: mergeRanges(ranges), sectionIds };
}

interface Effective {
  breathiness: number;
  tension: number;
  vibrato: number;
  energy: number;
}

function effective(song: Song, n: WorkNote): Effective {
  const d = song.vocals?.defaultExpression ?? {};
  const e = n.expression ?? {};
  return {
    breathiness: e.breathiness ?? d.breathiness ?? 0.2,
    tension: e.tension ?? d.tension ?? 0.4,
    vibrato: e.vibrato ?? d.vibrato ?? 0.3,
    energy: e.energy ?? d.energy ?? 0.5,
  };
}

function patch(n: WorkNote, p: Partial<VocalExpression>): void {
  const merged: VocalExpression = { ...(n.expression ?? {}), ...p };
  for (const k of Object.keys(merged) as (keyof VocalExpression)[]) {
    const v = merged[k];
    if (typeof v === 'number') (merged as Record<string, number>)[k] = round2(v);
  }
  n.expression = merged;
}

export function interpretVocalInstruction(song: Song, trackId: string, instruction: string, selection: EditSelection = {}, opts: { seed?: number } = {}): VocalInterpretation {
  const track = song.tracks.find((t) => t.id === trackId) ?? findTrack(song, trackId);
  if (!track) return { operations: [], explanation: `There is no track "${trackId}".`, intents: [], understood: false };
  const text = normalizeText(instruction);
  const seed = opts.seed ?? song.generation?.seed ?? 1;
  const reason = instruction.trim();

  // Mix-type requests ("make the vocal drier") are mixer changes, not performance changes.
  const intentsFound = V_RULES.filter((r) => r.re.test(text));
  if (MIX_RE.test(text) && !intentsFound.some((r) => r.id !== 'louder' && r.id !== 'softer')) {
    const mix = interpretMixInstruction(song, instruction, { selection: { ...selection, trackIds: [track.id] } });
    if (mix.understood) {
      return { ...mix, intents: mix.intents.map((i) => `mix:${i}`), explanation: `That's a mix change rather than a change to the performance: ${mix.explanation}` };
    }
  }

  const scope = resolveScope(song, track, text, instruction, selection);
  if (scope.error) return { operations: [], explanation: scope.error, intents: [], understood: true };

  // Detect intents (consuming text so "less vibrato" does not also read as "vibrato").
  const intents: VocalIntent[] = [];
  let work = text;
  for (const r of V_RULES) {
    const m = r.re.exec(work);
    if (!m) continue;
    if ((r.id === 'higher' || r.id === 'lower') && intents.includes('transpose')) continue;
    intents.push(r.id);
    work = work.slice(0, m.index) + ' '.repeat(m[0].length) + work.slice(m.index + m[0].length);
  }
  if (!intents.length) return { operations: [], explanation: `I couldn't map "${reason}" to a vocal change. ${HELP}`, intents: [], understood: false };

  const regenRange = scope.ranges.length ? { startTick: scope.ranges[0].startTick, endTick: scope.ranges[scope.ranges.length - 1].endTick } : undefined;

  // Regeneration of a section/range.
  if (intents.includes('regenerate')) {
    const secIds = scope.sectionIds;
    const lockedSecs = sectionLayout(song).filter((s) => secIds.includes(s.section.id) && isTrackSectionLocked(song, track.id, s.section.id));
    if (lockedSecs.length && lockedSecs.length === secIds.length) {
      return {
        operations: [],
        explanation: `${track.name} is locked in ${listJoin(lockedSecs.map((s) => s.section.name))} — unlock it to regenerate.`,
        intents: ['regenerate'],
        understood: true,
      };
    }
    const okSecs = secIds.filter((id) => !lockedSecs.some((s) => s.section.id === id));
    // A fresh pass (no variation level): variation levels keep the song's principal melody, which
    // here is the very vocal line being regenerated.
    const op: MusicOperation = okSecs.length
      ? { op: 'regenerate', track: track.id, sections: okSecs, seed: seed + 1, reason }
      : { op: 'regenerate', track: track.id, region: rangeToRegion(song, regenRange ?? { startTick: 0, endTick: 1 }), seed: seed + 1, reason };
    const where = okSecs.length ? listJoin(song.sections.filter((s) => okSecs.includes(s.id)).map((s) => s.name)) : scope.label;
    const ranges = okSecs.length ? sectionRanges(song, okSecs) : scope.ranges;
    return {
      operations: [op],
      explanation: `Regenerate the ${track.name} in ${where} only (${describeRanges(song, ranges)}) with a new seed; the instrumentation and every other section stay exactly as they are.${lockedSecs.length ? ` Skipped locked: ${listJoin(lockedSecs.map((s) => s.section.name))}.` : ''}`,
      intents: ['regenerate'],
      understood: true,
      regenerateRange: ranges.length ? { startTick: ranges[0].startTick, endTick: ranges[ranges.length - 1].endTick } : regenRange,
    };
  }

  const isL = lockChecker(song, track);
  const lockedIds = new Set(track.notes.filter((n) => isL(n)).map((n) => n.id));
  const targetIds = new Set(scope.notes.filter((n) => !lockedIds.has(n.id)).map((n) => n.id));
  const lockedInScope = scope.notes.filter((n) => lockedIds.has(n.id)).length;
  const work2: WorkNote[] = track.notes.map(toWork);
  const targets = sortWork(work2.filter((n) => n.id && targetIds.has(n.id)));
  if (!targets.length) {
    return {
      operations: [],
      explanation: lockedInScope ? `All ${lockedInScope} notes of ${scope.label} are locked — nothing was changed.` : `There are no ${track.name} notes in ${scope.label}.`,
      intents,
      understood: true,
    };
  }
  const amount = amountOf(text);
  const rng = deriveRng(seed, 'vocal-command', track.id, scope.label);
  const { low, high } = trackPitchRange(track);
  const beat = beatTicks(song, targets[0].tick);
  const phrases = splitPhrases(targets, Math.round(beat / 2));
  const phraseEnds = new Set(phrases.map((p) => p[p.length - 1]));
  const lines: string[] = [];
  const all = sortWork(work2);
  const nextOnset = (n: WorkNote) => all.find((m) => m.tick > n.tick)?.tick;

  for (const intent of intents) {
    switch (intent) {
      case 'aggressive':
        for (const n of targets) {
          const e = effective(song, n);
          patch(n, { tension: clamp01(e.tension + 0.35 * amount), energy: clamp01(e.energy + 0.3 * amount), breathiness: clamp01(e.breathiness - 0.15), onset: 'hard' });
          n.velocity = clampVel(n.velocity + 14 * amount);
        }
        lines.push(`more aggressive: higher vocal tension and energy, hard onsets, less breath, velocity +${Math.round(14 * amount)}`);
        break;
      case 'softer':
        for (const n of targets) {
          const e = effective(song, n);
          patch(n, { breathiness: clamp01(e.breathiness + 0.2 * amount), tension: clamp01(e.tension - 0.2), energy: clamp01(e.energy - 0.25), onset: 'soft' });
          n.velocity = clampVel(n.velocity - 15 * amount);
        }
        lines.push(`softer: velocity −${Math.round(15 * amount)}, more breath, less tension, soft onsets`);
        break;
      case 'louder':
        for (const n of targets) {
          const e = effective(song, n);
          patch(n, { energy: clamp01(e.energy + 0.2) });
          n.velocity = clampVel(n.velocity + 10 * amount);
        }
        lines.push(`louder: velocity +${Math.round(10 * amount)} and more vocal energy`);
        break;
      case 'vibrato':
        for (const n of targets) {
          const e = effective(song, n);
          const long = n.duration >= beat;
          patch(n, { vibrato: clamp01(Math.max(e.vibrato + (long ? 0.3 : 0.15) * amount, long ? 0.55 : 0.4)), vibratoRate: n.expression?.vibratoRate ?? song.vocals?.defaultExpression?.vibratoRate ?? 5.5 });
        }
        lines.push('added vibrato (deeper on the sustained notes)');
        break;
      case 'less-vibrato': {
        const none = /\b(no|without|remove|straight)\b/.test(text);
        for (const n of targets) patch(n, { vibrato: none ? 0 : clamp01(effective(song, n).vibrato - 0.25 * amount) });
        lines.push(none ? 'straight tone (vibrato removed)' : 'less vibrato');
        break;
      }
      case 'breathier':
        for (const n of targets) {
          const e = effective(song, n);
          patch(n, { breathiness: clamp01(e.breathiness + 0.3 * amount), tension: clamp01(e.tension - 0.1) });
        }
        lines.push('breathier tone');
        break;
      case 'less-breathy':
        for (const n of targets) patch(n, { breathiness: clamp01(effective(song, n).breathiness - 0.25 * amount) });
        lines.push('clearer, less breathy tone');
        break;
      case 'legato': {
        let c = 0;
        for (const n of targets) {
          const nx = nextOnset(n);
          if (nx !== undefined && nx - (n.tick + n.duration) > beat / 16 && nx - (n.tick + n.duration) <= beat) {
            n.duration = nx - n.tick - Math.round(beat / 32);
            c++;
          }
          n.articulation = 'legato';
        }
        lines.push(c ? `legato: connected ${c} note${c === 1 ? '' : 's'} into the next` : 'legato articulation (the notes were already connected)');
        break;
      }
      case 'staccato':
        for (const n of targets) {
          n.duration = Math.max(Math.round(beat / 8), Math.round(n.duration * 0.5));
          n.articulation = 'staccato';
        }
        lines.push('detached (staccato) delivery');
        break;
      case 'scoop':
        for (const n of targets) patch(n, { onset: 'scoop' });
        lines.push('scoop into each note');
        break;
      case 'release-falling':
      case 'release-rising':
      case 'release-breathy':
      case 'release-cut': {
        const kind = intent.replace('release-', '') as VocalExpression['release'];
        const ends = targets.length === 1 ? targets : targets.filter((n) => phraseEnds.has(n));
        for (const n of ends) patch(n, { release: kind });
        lines.push(`${kind} release on ${ends.length} phrase-ending note${ends.length === 1 ? '' : 's'}`);
        break;
      }
      case 'hard-onset':
        for (const n of targets) patch(n, { onset: 'hard' });
        lines.push('hard onsets');
        break;
      case 'soft-onset':
        for (const n of targets) patch(n, { onset: 'soft' });
        lines.push('soft onsets');
        break;
      case 'emotional':
        for (const ph of phrases) {
          ph.forEach((n, i) => {
            const arc = Math.sin((Math.PI * (i + 0.5)) / ph.length);
            n.velocity = clampVel(n.velocity + Math.round((arc - 0.45) * 20 * amount));
            const e = effective(song, n);
            patch(n, { vibrato: clamp01(e.vibrato + (n.duration >= beat ? 0.25 : 0.1)), breathiness: clamp01(e.breathiness + 0.05) });
          });
        }
        lines.push(`more emotional: phrase-shaped dynamics across ${phrases.length} phrase${phrases.length === 1 ? '' : 's'} and vibrato on the held notes`);
        break;
      case 'relaxed':
        for (const n of targets) {
          const e = effective(song, n);
          patch(n, { tension: clamp01(e.tension - 0.25 * amount), energy: clamp01(e.energy - 0.1) });
        }
        lines.push('relaxed, less strained delivery');
        break;
      case 'tense':
        for (const n of targets) patch(n, { tension: clamp01(effective(song, n).tension + 0.25 * amount) });
        lines.push('more vocal tension/effort');
        break;
      case 'hold': {
        let c = 0;
        for (const n of targets.length === 1 ? targets : targets.filter((x) => phraseEnds.has(x))) {
          const nx = nextOnset(n);
          const limit = (nx ?? n.tick + n.duration + 2 * beat) - Math.round(beat / 8);
          const want = Math.min(limit, n.tick + n.duration + 2 * beat) - n.tick;
          if (want > n.duration) {
            n.duration = want;
            c++;
          }
        }
        lines.push(`held ${c} phrase-ending note${c === 1 ? '' : 's'} longer`);
        break;
      }
      case 'transpose':
      case 'higher':
      case 'lower': {
        const spec = intent === 'transpose' ? parseTranspose(text) : null;
        for (const n of targets) {
          const key = keyAt(song, n.tick);
          if (spec?.semitones) n.pitch += spec.semitones;
          else if (spec?.steps) n.pitch = transposeDiatonic(n.pitch, spec.steps, key);
          else n.pitch = transposeDiatonic(n.pitch, intent === 'lower' ? -2 : 2, key);
        }
        lines.push(spec ? `moved ${spec.label}` : `moved ${intent === 'lower' ? 'down' : 'up'} a diatonic third`);
        const outOfRange = targets.filter((n) => n.pitch < low || n.pitch > high).length;
        if (outOfRange) {
          const key = keyAt(song, targets[0].tick);
          lines.push(`note: ${outOfRange} note${outOfRange === 1 ? ' is' : 's are'} now outside the ${track.vocal?.voiceType ?? 'vocal'} range (${midiToNoteNameInKey(low, key)}–${midiToNoteNameInKey(high, key)})`);
        }
        break;
      }
      case 'change-melody': {
        const changes: string[] = [];
        let prev: number | undefined;
        for (const n of targets) {
          const chord = chordSpecAt(song, n.tick);
          const key = keyAt(song, n.tick);
          const pcs = chord ? chordPitchClasses(chord) : [];
          const cands: number[] = [];
          for (let p = Math.max(low, n.pitch - 7); p <= Math.min(high, n.pitch + 7); p++) if (p !== n.pitch && (pcs.length ? pcs.includes(mod12(p)) : true)) cands.push(p);
          if (!cands.length) continue;
          const ref = prev ?? n.pitch;
          const p = rng.weighted(cands, cands.map((c) => 1 / (1 + Math.abs(c - ref))));
          if (targets.length <= 4) {
            const pos = tickToMusical(song, n.tick);
            changes.push(`${n.syllable && n.syllable !== '_' ? `"${n.syllable.replace(/-$/, '')}" ` : ''}(bar ${pos.bar} beat ${round2(pos.beat)}): ${midiToNoteNameInKey(n.pitch, key)} → ${midiToNoteNameInKey(p, key)}`);
          }
          n.pitch = foldPitch(p, low, high);
          prev = n.pitch;
        }
        lines.push(changes.length ? `new pitches on chord tones — ${changes.join(', ')}` : `new chord-tone pitches for ${targets.length} notes (rhythm and syllables kept)`);
        break;
      }
      case 'regenerate':
        break;
    }
  }

  const res = emitNoteOps(song, track, track.notes, work2, { reason });
  const changed = targets.filter((n) => n.id);
  const range = changed.length ? { startTick: Math.min(...changed.map((n) => n.tick)), endTick: Math.max(...changed.map((n) => n.tick + n.duration)) } : regenRange;
  const parts = [`${track.name}, ${scope.label}: ${lines.join('; ')}.`];
  if (lockedInScope) parts.push(`${lockedInScope} locked note${lockedInScope === 1 ? ' was' : 's were'} skipped.`);
  parts.push('Only the vocal changes; re-render this range with the singing engine to hear it.');
  return { operations: res.ops, explanation: parts.join(' '), intents, understood: true, regenerateRange: range };
}
