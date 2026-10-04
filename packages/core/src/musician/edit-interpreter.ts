import type {
  ChordSpec,
  EditSelection,
  KeySignature,
  MusicOperation,
  Note,
  NoteTransform,
  Song,
  Track,
} from '../ir/types';
import { deriveRng, type Rng } from '../util/random';
import { barToTick, musicalToTick, sectionLayout, type SectionSpan } from '../timing';
import { LockKeys, isChordSectionLocked, isLocked } from '../locks';
import { keyName } from '../theory/scales';
import { mod12, spellPitchClass } from '../theory/pitch';
import {
  amountOf,
  findBarSpec,
  findSectionMentions,
  findTrackMentions,
  normalizeText,
  parseTranspose,
  splitClauses,
  type TrackMention,
} from './nlp';
import * as T from './transforms';
import {
  type ChordSlot,
  type TickRange,
  type WorkNote,
  chordOpsFromSlots,
  describeRanges,
  emitNoteOps,
  findMelodyTrack,
  inRanges,
  isBassTrack,
  isDrumTrack,
  isMelodicTrack,
  isPitchedTrack,
  isVocalTrack,
  keyAt,
  lockChecker,
  lockedRanges,
  lockedSectionNames,
  mergeRanges,
  rangesLength,
  sectionRanges,
  sectionsOverlapping,
  selectionRanges,
  selectionTracks,
  songEndTick,
  sortWork,
  toOpNote,
  toWork,
  trackPitchRange,
  uniformTransformOps,
  chordSlots,
  barIndex,
} from './op-helpers';
import {
  ambiguousChord,
  brightenChord,
  chordChangeText,
  darkenChord,
  darkerMode,
  relaxChord,
  romanOf,
  sameChord,
  scaleMapFn,
  spellChord,
  tenseChord,
} from './harmony';
import type { EditInterpretation } from './types';
import { sectionAnalysisKey } from './theory-explain';

/**
 * §20 AI MIDI editing — offline, rule-based interpreter of natural-language edits on a
 * selection. Produces structured operations (§46); never mutates the song.
 */

export type EditIntentId =
  | 'repitch'
  | 'rerhythm'
  | 'answer'
  | 'double-octave'
  | 'harmonize'
  | 'ambiguous'
  | 'half-time'
  | 'double-time'
  | 'less-tension'
  | 'tension'
  | 'simplify'
  | 'busier'
  | 'darker'
  | 'brighter'
  | 'expressive'
  | 'flatten-dynamics'
  | 'crescendo'
  | 'decrescendo'
  | 'accent'
  | 'transpose'
  | 'louder'
  | 'softer'
  | 'staccato'
  | 'legato'
  | 'quantize'
  | 'humanize'
  | 'straighten'
  | 'swing'
  | 'less-syncopation'
  | 'syncopate'
  | 'shorter'
  | 'longer'
  | 'invert'
  | 'reverse'
  | 'fill'
  | 'delete'
  | 'register-up'
  | 'register-down';

/** Ordered: earlier rules consume their text so later, more generic rules cannot re-match it. */
const INTENT_RULES: { id: EditIntentId; re: RegExp }[] = [
  {
    id: 'repitch',
    re: /\bkeep (?:the )?(?:same )?rhythm\b.*?\b(?:change|new|different|other)\b.*?\b(?:pitch(?:es)?|notes|melody)\b|\bsame rhythm\b.*?\b(?:different|new|other)\b(?: (?:pitch(?:es)?|notes))?|\b(?:different|new) (?:pitches|notes)\b|\bchange (?:the )?(?:pitches|notes)\b|\bre-?pitch\b/,
  },
  {
    id: 'rerhythm',
    re: /\bkeep (?:the )?(?:same )?(?:pitches|notes)\b.*?\bchange (?:the )?rhythm\b|\b(?:new|different) rhythm\b|\bchange the rhythm\b/,
  },
  {
    id: 'answer',
    re: /\banswer(?:s|ing)?\b|\bcall-and-response\b|\brespond(?:s|ing)? to\b|\b(?:instead of|rather than|stop|without) doubl(?:e|es|ing)\b/,
  },
  {
    id: 'double-octave',
    re: /\bdoubl(?:e|ed|ing)\b.*?\boctaves?(?: (?:higher|lower|up|down|above|below))?\b|\boctave doubl(?:e|ing)\b|\badd (?:an )?octave (?:above|below|higher|lower|up|down)\b/,
  },
  {
    id: 'harmonize',
    re: /\bharmoni[sz](?:e|ed|ation)\b(?:[^,]*?\b(?:thirds?|sixths?|tenths?)(?: (?:above|below|higher|lower|up|down))?\b)?|\badd (?:a )?harmony(?: line)?(?:[^,]*?\b(?:third|sixth|tenth)(?: (?:above|below|higher|lower|up|down))?\b)?|\bin (?:parallel )?(?:thirds|sixths|tenths)(?: (?:above|below))?\b/,
  },
  {
    id: 'ambiguous',
    re: /\bambigu(?:ous|ity)\b|\bless (?:obvious|predictable|resolved|clear[\s-]?cut)\b|\bsus(?:pended)? chords?\b|\bquartal\b|\bopen(?:er)?(?: sounding)? chords\b|\b(?:no|without (?:the )?)thirds?\b|\bvague(?:r)?\b|\bfloat(?:y|ier|ing)\b/,
  },
  { id: 'half-time', re: /\bhalf[\s-]?time\b|\bhalf speed\b/ },
  { id: 'double-time', re: /\bdouble[\s-]?time\b|\btwice as fast\b|\bdouble speed\b/ },
  {
    id: 'less-tension',
    re: /\bless (?:tension|tense|dissonant|dissonance)\b|\b(?:release|resolve|reduce) (?:the )?tension\b|\bmore (?:stable|consonant|resolved)\b|\brelax(?:ed)?\b/,
  },
  {
    id: 'tension',
    re: /\b(?:add|more|build|increase|create|adding)\b[^,]*?\btension\b|\btense(?:r)?\b|\bsuspense(?:ful)?\b|\bmore dissonan(?:t|ce)\b|\bunresolved\b|\brestless\b|\bmore urgent\b|\bbuild(?:[\s-]?up| it up)\b|\btension\b/,
  },
  {
    id: 'simplify',
    re: /\bsimplif(?:y|ied|ication)\b|\bsimpler\b|\bless (?:busy|active|dense|cluttered|complex|complicated|notes|movement|going on)\b|\bnot as busy\b|\btoo (?:busy|dense|cluttered|crowded|many notes)\b|\bsparser\b|\bmore sparse\b|\bsparse\b|\bthin(?:ner)?(?: it)? out\b|\bstrip(?: it)? (?:back|down)\b|\bfewer notes\b|\breduce (?:the )?(?:notes|density|busyness)\b|\bdeclutter\b|\bcalm(?: it)? down\b|\bminimal\b/,
  },
  {
    id: 'busier',
    re: /\bbusier\b|\bmore (?:busy|active|movement|motion|notes|intricate|complex|going on|interesting|rhythmic)\b|\bdenser\b|\bmore dense\b|\bfill(?: it)? (?:out|in)\b|\bliven(?: it)? up\b|\bwalking\b|\bactive\b|\bbusy\b/,
  },
  {
    id: 'darker',
    re: /\bsad(?:der)?\b|\bdark(?:er)?\b|\bmelanchol(?:y|ic)\b|\bgloom(?:y|ier)\b|\bmood(?:y|ier)\b|\bsomb(?:er|re)\b|\bbleak(?:er)?\b|\btragic\b|\bdepressing\b|\bominous\b|\bmore minor\b|\bminor (?:key|feel|mode)\b|\bin minor\b|\bbittersweet\b|\bmournful\b/,
  },
  {
    id: 'brighter',
    re: /\bhapp(?:y|ier)\b|\bbright(?:er)?\b|\buplifting\b|\bcheerful\b|\bjoyful\b|\bmore (?:hopeful|positive|optimistic)\b|\bsunn(?:y|ier)\b|\bmore major\b|\bmajor (?:key|feel|mode)\b|\bin major\b|\bupbeat\b/,
  },
  {
    id: 'expressive',
    re: /\bmore (?:emotional|expressive|dynamic|feeling|emotion|passionate|heartfelt|musical)\b|\bwith (?:more )?(?:feeling|emotion|expression)\b|\bemotional\b|\bexpressive\b/,
  },
  {
    id: 'flatten-dynamics',
    re: /\bless dynamic\b|\beven out (?:the )?(?:velocit(?:y|ies)|dynamics)\b|\bmore (?:even|consistent)(?: velocit(?:y|ies)| dynamics)?\b|\bflatten (?:the )?dynamics\b|\bsame velocity\b/,
  },
  {
    id: 'crescendo',
    re: /\bcrescendo\b|\bget(?:ting)? louder\b|\bswell\b|\bfade[\s-]?in\b|\bramp up\b|\bbuild in volume\b/,
  },
  {
    id: 'decrescendo',
    re: /\bdecrescendo\b|\bdiminuendo\b|\bfade[\s-]?(?:out|away)\b|\bget(?:ting)? quieter\b|\bdie (?:down|away)\b/,
  },
  {
    id: 'accent',
    re: /\baccent(?:uate)? (?:the )?(?:downbeats?|beats?|first beat|ones)\b|\bemphasi[sz]e the (?:downbeats?|beat)\b|\baccents\b/,
  },
  { id: 'double-octave', re: /\boctave (?:doubling|double)\b/ },
  {
    id: 'transpose',
    re: /\btranspose\b|\b(?:up|down|raise|lower|drop|shift|move)\b[^,]*?\b(?:\d+\s*)?(?:octaves?|semi-?tones?|half[\s-]?steps?|whole[\s-]?steps?|scale steps?|steps?|tones?|second|third|fourth|fifth|sixth|seventh)\b|\b(?:an? )?octave (?:up|down|higher|lower)\b|\ban octave\b/,
  },
  {
    id: 'louder',
    re: /\blouder\b|\bmore (?:volume|forceful|powerful|aggressive|intense)\b|\bstronger\b|\bharder\b|\bincrease (?:the )?velocit(?:y|ies)\b|\bturn(?: it)? up\b|\bboost\b|\bforte\b|\baggressive\b|\bintense\b|\bpunch(?:y|ier)\b/,
  },
  {
    id: 'softer',
    re: /\bsofter\b|\bquieter\b|\bgentler\b|\bmore (?:gentle|gently|delicate|subtle)\b|\breduce (?:the )?velocit(?:y|ies)\b|\bdecrease (?:the )?velocit(?:y|ies)\b|\bless loud\b|\bturn(?: it)? down\b|\bpianissimo\b|\bsoft\b|\bquiet\b|\bgentle\b|\bgently\b/,
  },
  { id: 'staccato', re: /\bstaccato\b|\bdetached\b|\bchoppy\b|\bplucky\b|\bspiccato\b|\bshort and punchy\b/ },
  {
    id: 'legato',
    re: /\blegato\b|\bsmooth(?:er)?\b|\bconnected\b|\bconnect the notes\b|\bflowing\b|\bslurred\b|\bsustain(?:ed)?\b|\btie the notes\b/,
  },
  {
    id: 'quantize',
    re: /\bquanti[sz](?:e|ed|ation)\b|\btight(?:en|er)\b|\bon the grid\b|\bfix the timing\b|\bmore precise\b|\bless sloppy\b|\bstraighten (?:up )?the timing\b|\bin time\b/,
  },
  {
    id: 'humanize',
    re: /\bhumani[sz](?:e|ed)\b|\bmore human\b|\bloos(?:e|en|er)\b|\bless (?:robotic|mechanical|quantized|stiff|rigid)\b|\bmore natural\b|\bsloppier\b|\blaid[\s-]?back\b/,
  },
  {
    id: 'straighten',
    re: /\bstraighten\b|\bless swing(?:y)?\b|\bno swing\b|\bremove (?:the )?swing\b|\bunswing\b|\bstraight(?:er)? (?:eighths|8ths|feel|rhythm|time|sixteenths|16ths)\b|\bstraight\b/,
  },
  { id: 'swing', re: /\bswing(?:ing|y|ier)?\b|\bshuffle\b|\bswung\b|\btriplet feel\b/ },
  {
    id: 'less-syncopation',
    re: /\bless syncopat(?:ed|ion)\b|\bon the beat\b|\bsquare(?:r)?\b|\bstraightforward rhythm\b|\bno syncopation\b/,
  },
  {
    id: 'syncopate',
    re: /\bsyncopat(?:ed|e|ion)\b|\bfunk(?:y|ier)\b|\bpush(?:es|ed)? (?:the )?(?:beat|downbeats|chords)\b|\banticipat(?:e|ions?)\b|\boff[\s-]?beats?\b|\bgroov(?:y|ier)\b|\bmore groove\b/,
  },
  {
    id: 'invert',
    re: /\binvert(?:ed)?\b|\bupside[\s-]?down\b|\bmirror(?:ed)?\b|\bflip the (?:melody|contour|line)\b|\bmelodic inversion\b/,
  },
  { id: 'reverse', re: /\brevers(?:e|ed)\b|\bretrograde\b|\bbackwards?\b/ },
  {
    id: 'fill',
    re: /\b(?:add|put|insert|more) (?:a |some )?(?:drum |tom )?fills?\b|\bfill at the end\b|\bfills?\b/,
  },
  {
    id: 'delete',
    re: /\bremove\b|\bdelete\b|\bclear\b|\berase\b|\bget rid of\b|\bcut out\b|\btake out\b|\bdrop (?:the|these|all)\b|\bmute (?:these|the selected)\b/,
  },
  {
    id: 'shorter',
    re: /\bshort(?:er)?(?: notes)?\b|\bclip (?:the )?notes\b|\bcut (?:the )?notes short\b|\btrim (?:the )?notes\b/,
  },
  {
    id: 'longer',
    re: /\blong(?:er)?(?: notes)?\b|\bhold (?:the )?notes(?: longer)?\b|\blet (?:the )?notes ring\b/,
  },
  { id: 'register-up', re: /\bhigher(?: register)?\b|\bup (?:higher|in register)\b/ },
  { id: 'register-down', re: /\blower(?: register)?\b/ },
];

const INTENT_LABEL: Record<EditIntentId, string> = {
  repitch: 'keep the rhythm, change the pitches',
  rerhythm: 'keep the pitches, change the rhythm',
  answer: 'answer instead of doubling',
  'double-octave': 'octave doubling',
  harmonize: 'harmony line',
  ambiguous: 'more harmonically ambiguous chords',
  'half-time': 'half-time',
  'double-time': 'double-time',
  'less-tension': 'less tension',
  tension: 'add tension',
  simplify: 'simplify',
  busier: 'busier',
  darker: 'darker / sadder (modal interchange)',
  brighter: 'brighter / happier',
  expressive: 'more expressive dynamics',
  'flatten-dynamics': 'even dynamics',
  crescendo: 'crescendo',
  decrescendo: 'decrescendo',
  accent: 'accent downbeats',
  transpose: 'transpose',
  louder: 'louder',
  softer: 'softer',
  staccato: 'staccato',
  legato: 'legato',
  quantize: 'quantize / tighten',
  humanize: 'humanize',
  straighten: 'straighten swing',
  swing: 'more swing',
  'less-syncopation': 'less syncopation',
  syncopate: 'more syncopation',
  shorter: 'shorter notes',
  longer: 'longer notes',
  invert: 'melodic inversion',
  reverse: 'retrograde (reverse)',
  fill: 'drum fills',
  delete: 'remove notes',
  'register-up': 'higher register',
  'register-down': 'lower register',
};

export const EDIT_HELP =
  'I can: make a part busier or simpler/sparser; darker/sadder or brighter/happier; half-time or double-time; add (or release) tension over a range; make one instrument answer another instead of doubling it; keep the rhythm but change the pitches (or keep the pitches, change the rhythm); make chords more harmonically ambiguous; transpose (semitones, whole steps, octaves, diatonic thirds…); louder/softer, crescendo/decrescendo, more expressive or even dynamics, accent the downbeats; staccato/legato, shorter/longer notes; humanize, tighten/quantize, more swing or straighten, more or less syncopation; remove notes (e.g. "remove the hi-hats" or "remove ghost notes"); double the melody an octave higher/lower, harmonize in thirds or sixths; invert or reverse a melody; add drum fills. Name an instrument ("the bass") or section ("in the chorus", "bars 5-8"), or select notes first.';

const NO_CHORDS_RE =
  /\b(?:do not|not|without|never|no) (?:change|changing|touch|touching|alter|altering|modify|modifying|messing with)\b[^,]*?\b(?:chords|harmony|progression)\b|\bkeep (?:the )?(?:same )?(?:chords|harmony|progression)\b|\bsame chords\b|\b(?:chords|harmony) (?:stay|stays|unchanged|the same)\b/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface ParsedIntent {
  id: EditIntentId;
  /** Index of the matched text in the clause. */
  index: number;
  match: string;
}

interface ParsedClause {
  text: string;
  intents: ParsedIntent[];
}

export function detectEditIntents(clause: string): ParsedIntent[] {
  let work = clause;
  const found: ParsedIntent[] = [];
  for (const rule of INTENT_RULES) {
    if (found.some((f) => f.id === rule.id)) continue;
    const m = rule.re.exec(work);
    if (!m || !m[0].trim()) continue;
    found.push({ id: rule.id, index: m.index, match: m[0] });
    work = work.slice(0, m.index) + ' '.repeat(m[0].length) + work.slice(m.index + m[0].length);
  }
  // Transposition implies no register intent from the same words.
  if (found.some((f) => f.id === 'transpose'))
    return found
      .filter((f) => f.id !== 'register-up' && f.id !== 'register-down')
      .sort((a, b) => a.index - b.index);
  return found.sort((a, b) => a.index - b.index);
}

function parseClauses(text: string): ParsedClause[] {
  // Multi-clause idioms are detected on the whole text first, so "keep the rhythm but change the pitches" stays one intent.
  const whole =
    /\bkeep (?:the )?(?:same )?rhythm\b.*?\b(?:change|new|different)\b.*?\b(?:pitch(?:es)?|notes|melody)\b|\bkeep (?:the )?(?:same )?(?:pitches|notes)\b.*?\bchange (?:the )?rhythm\b/.exec(
      text,
    );
  const clauses: ParsedClause[] = [];
  let rest = text;
  if (whole) {
    clauses.push({ text: whole[0], intents: detectEditIntents(whole[0]) });
    rest = text.slice(0, whole.index) + ' , ' + text.slice(whole.index + whole[0].length);
  }
  for (const c of splitClauses(rest)) {
    if (NO_CHORDS_RE.test(c)) continue;
    clauses.push({ text: c, intents: detectEditIntents(c) });
  }
  // Scope-only clauses ("…, in the chorus") attach to the previous clause.
  const merged: ParsedClause[] = [];
  for (const c of clauses) {
    if (!c.intents.length && merged.length) merged[merged.length - 1].text += ` ${c.text}`;
    else merged.push(c);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

interface ResolvedScope {
  tracks: Track[];
  trackLabel: string;
  ranges: TickRange[];
  rangeLabel: string;
  noteIds?: Set<string>;
  drumPitches?: number[];
  mentions: TrackMention[];
  explicitTracks: boolean;
  missingInstrument?: string;
  chordsMentioned: boolean;
  wholeSong: boolean;
  sectionIds: string[];
}

function defaultTracksFor(song: Song, intent: EditIntentId, melody?: Track): Track[] {
  const midi = song.tracks.filter((t) => t.kind === 'midi');
  const pitched = midi.filter(isPitchedTrack);
  switch (intent) {
    case 'repitch':
    case 'rerhythm':
    case 'invert':
    case 'reverse':
    case 'harmonize':
    case 'double-octave':
    case 'register-up':
    case 'register-down':
      return melody ? [melody] : pitched.slice(0, 1);
    case 'fill':
      return midi.filter(isDrumTrack);
    case 'ambiguous':
    case 'answer':
      return [];
    case 'darker':
    case 'brighter':
    case 'less-tension':
    case 'transpose':
      return pitched;
    default:
      return midi.filter((t) => t.notes.length > 0);
  }
}

function buildRange(song: Song): TickRange[] {
  const layout = sectionLayout(song);
  const pre =
    layout.find((s) => s.section.kind === 'pre-chorus' || s.section.kind === 'build') ??
    layout.find((s) => s.section.kind === 'bridge');
  if (pre) return [{ startTick: pre.startTick, endTick: pre.endTick }];
  return [{ startTick: 0, endTick: songEndTick(song) }];
}

function takeBars(song: Song, ranges: TickRange[], n: number, fromEnd: boolean): TickRange[] {
  const merged = mergeRanges(ranges);
  if (!merged.length) return merged;
  if (fromEnd) {
    const last = merged[merged.length - 1];
    const endBar = barIndex(song, last.endTick - 1) + 1;
    const startBar = Math.max(barIndex(song, merged[0].startTick), endBar - n);
    return [{ startTick: barToTick(song, startBar), endTick: last.endTick }];
  }
  const first = merged[0];
  const startBar = barIndex(song, first.startTick);
  return [
    {
      startTick: first.startTick,
      endTick: Math.min(barToTick(song, startBar + n), merged[merged.length - 1].endTick),
    },
  ];
}

function resolveScope(
  song: Song,
  clause: ParsedClause,
  selection: EditSelection,
  prev: ResolvedScope | undefined,
  melody: Track | undefined,
): ResolvedScope {
  const primary = clause.intents[0]?.id ?? 'busier';
  const mentions = findTrackMentions(song, clause.text, { melodyTrack: melody });
  const specific = mentions.filter((m) => !m.generic || m.generic === 'melody' || m.generic === 'all');
  const chordsMentioned = mentions.some((m) => m.generic === 'chords');
  const selTracks = selectionTracks(song, selection);
  let tracks: Track[];
  let trackLabel: string;
  let explicitTracks = false;
  let missingInstrument: string | undefined;
  let drumPitches: number[] | undefined;
  if (specific.length) {
    const first = specific[0];
    explicitTracks = true;
    if (first.generic === 'melody' && selTracks.length) tracks = selTracks;
    else tracks = first.tracks;
    if (!tracks.length) missingInstrument = first.label;
    drumPitches = first.drumPitches;
    trackLabel = tracks.map((t) => t.name).join(', ');
  } else if (prev && prev.explicitTracks) {
    tracks = prev.tracks;
    trackLabel = prev.trackLabel;
    explicitTracks = true;
    drumPitches = prev.drumPitches;
  } else if (selTracks.length) {
    tracks = selTracks;
    trackLabel = selTracks.map((t) => t.name).join(', ');
    explicitTracks = true;
  } else {
    tracks = defaultTracksFor(song, primary, melody);
    trackLabel =
      tracks.length === song.tracks.filter((t) => t.kind === 'midi').length && tracks.length > 1
        ? 'all tracks'
        : tracks.map((t) => t.name).join(', ');
  }

  // Time ranges.
  const secMentions = findSectionMentions(song, clause.text).filter((m) => m.sections.length);
  const bar = findBarSpec(clause.text);
  const selR = selectionRanges(song, selection);
  const whole: TickRange[] = [{ startTick: 0, endTick: songEndTick(song) }];
  let sectionIds: string[] = [];
  let base: TickRange[] | null = null;
  if (secMentions.length) {
    sectionIds = [...new Set(secMentions.flatMap((m) => m.sections.map((s) => s.id)))];
    base = sectionRanges(song, sectionIds);
  }
  let ranges: TickRange[];
  let fromSelection = false;
  if (bar?.kind === 'range') {
    ranges = [
      { startTick: musicalToTick(song, bar.startBar, 1), endTick: musicalToTick(song, bar.endBar + 1, 1) },
    ];
  } else if (bar && (bar.kind === 'last' || bar.kind === 'first' || bar.kind === 'count')) {
    const within =
      base ??
      selR ??
      (prev && prev.rangeLabel !== 'the whole song' ? prev.ranges : null) ??
      (bar.kind === 'count' && primary === 'tension' ? buildRange(song) : whole);
    if (!base && selR && within === selR) fromSelection = true;
    ranges = takeBars(song, within, bar.bars, bar.kind !== 'first');
  } else if (base) ranges = base;
  else if (prev && prev.rangeLabel !== 'the whole song') ranges = prev.ranges;
  else if (selR) {
    ranges = selR;
    fromSelection = true;
  } else ranges = whole;
  ranges = mergeRanges(ranges);
  const wholeSong =
    ranges.length === 1 && ranges[0].startTick === 0 && ranges[0].endTick >= songEndTick(song);
  let rangeLabel = wholeSong ? 'the whole song' : describeRanges(song, ranges);
  const named = sectionsOverlapping(song, ranges).filter((s) =>
    ranges.some((r) => r.startTick <= s.startTick && r.endTick >= s.endTick),
  );
  if (
    !wholeSong &&
    named.length &&
    rangesLength(ranges) === named.reduce((n, s) => n + (s.endTick - s.startTick), 0)
  ) {
    rangeLabel = `${named.map((s) => s.section.name).join(', ')} (${describeRanges(song, ranges)})`;
    if (!sectionIds.length) sectionIds = named.map((s) => s.section.id);
  }
  const noteIds =
    !secMentions.length && !bar && selection.noteIds?.length && (fromSelection || !selR)
      ? new Set(selection.noteIds)
      : undefined;
  return {
    tracks,
    trackLabel,
    ranges,
    rangeLabel,
    noteIds,
    drumPitches,
    mentions,
    explicitTracks,
    missingInstrument,
    chordsMentioned,
    wholeSong,
    sectionIds,
  };
}

// ---------------------------------------------------------------------------
// Edit state
// ---------------------------------------------------------------------------

interface TrackWork {
  track: Track;
  work: WorkNote[];
  lockedIds: Set<string>;
  locked: TickRange[];
  /** Uniform transform (only while every applied intent was uniform over the same notes). */
  uniform?: NoteTransform;
  uniformIds?: string[];
  uniformRanges?: TickRange[];
  nonUniform: boolean;
  intents: number;
}

class EditState {
  readonly tracks = new Map<string, TrackWork>();
  slots: ChordSlot[];
  readonly lines: string[] = [];
  readonly chordLines: string[] = [];
  readonly lockNotes = new Set<string>();
  readonly extraOps: MusicOperation[] = [];
  readonly intents: string[] = [];
  readonly original: Map<string, Note>;
  /** Clauses actually applied (not skipped for a missing instrument). */
  appliedClauses = 0;
  private readonly layout: SectionSpan[];
  private readonly keyCache = new Map<string, KeySignature>();

  constructor(
    readonly song: Song,
    readonly seed: number,
    readonly noChords: boolean,
  ) {
    this.slots = chordSlots(song);
    this.original = new Map(song.tracks.flatMap((t) => t.notes.map((n) => [n.id, n] as [string, Note])));
    this.layout = sectionLayout(song);
  }

  /**
   * The key the harmony is heard in at a tick: the section's analysis key (its relative minor/major
   * when the section centres there), exactly as the Theory View analyses it.
   */
  harmonicKey(tick: number): KeySignature {
    const span = this.layout.find((sp) => tick >= sp.startTick && tick < sp.endTick);
    if (!span) return keyAt(this.song, tick);
    let k = this.keyCache.get(span.section.id);
    if (!k) {
      k = sectionAnalysisKey(this.song, span.section.id);
      this.keyCache.set(span.section.id, k);
    }
    return k;
  }

  /** Distinct harmonic keys of the sections a set of ranges touches (in order). */
  harmonicKeys(ranges: TickRange[]): KeySignature[] {
    const out: KeySignature[] = [];
    const ticks = ranges.length
      ? this.layout
          .filter((sp) => ranges.some((r) => r.startTick < sp.endTick && r.endTick > sp.startTick))
          .map((sp) => Math.max(sp.startTick, ranges[0].startTick))
      : [0];
    for (const t of ticks.length ? ticks : [ranges[0]?.startTick ?? 0]) {
      const k = this.harmonicKey(t);
      if (!out.some((x) => x.tonic === k.tonic && x.mode === k.mode)) out.push(k);
    }
    return out;
  }

  tw(track: Track): TrackWork {
    let w = this.tracks.get(track.id);
    if (!w) {
      const isL = lockChecker(this.song, track);
      w = {
        track,
        work: track.notes.map(toWork),
        lockedIds: new Set(track.notes.filter((n) => isL(n)).map((n) => n.id)),
        locked: lockedRanges(this.song, track),
        nonUniform: false,
        intents: 0,
      };
      this.tracks.set(track.id, w);
    }
    return w;
  }

  rng(...keys: (string | number)[]): Rng {
    return deriveRng(this.seed, 'musician-edit', ...keys);
  }
}

function scopeNotes(
  st: EditState,
  w: TrackWork,
  scope: ResolvedScope,
  opts: { drumPitches?: number[] } = {},
): { notes: WorkNote[]; locked: number } {
  const out: WorkNote[] = [];
  let locked = 0;
  const drum = opts.drumPitches ?? (isDrumTrack(w.track) ? scope.drumPitches : undefined);
  for (const n of w.work) {
    if (!inRanges(scope.ranges, n.tick)) continue;
    if (scope.noteIds && n.id && !scope.noteIds.has(n.id)) continue;
    if (drum && !drum.includes(n.pitch)) continue;
    if (n.id && w.lockedIds.has(n.id)) {
      locked++;
      continue;
    }
    out.push(n);
  }
  return { notes: out, locked };
}

function commit(st: EditState, w: TrackWork, before: WorkNote[], after: WorkNote[]) {
  const replaced = new Set(before);
  const rest = w.work.filter((n) => !replaced.has(n));
  const byId = new Map(before.filter((n) => n.id).map((n) => [n.id!, n]));
  const accepted: WorkNote[] = [];
  for (const n of after) {
    const inLocked = w.locked.some((r) => n.tick >= r.startTick && n.tick < r.endTick);
    if (n.duration <= 0 || n.pitch < 0 || n.pitch > 127 || n.tick < 0) {
      if (n.id && byId.has(n.id)) accepted.push(byId.get(n.id)!);
      continue;
    }
    if (inLocked) {
      if (n.id && byId.has(n.id)) accepted.push(byId.get(n.id)!);
      continue;
    }
    accepted.push(n);
  }
  w.work = sortWork([...rest, ...accepted]);
}

function ctxFor(
  st: EditState,
  w: TrackWork,
  scope: ResolvedScope,
  key: string,
  amount: number,
): T.TransformContext {
  const { low, high } = trackPitchRange(w.track);
  return {
    song: st.song,
    track: w.track,
    rng: st.rng(key, w.track.id, scope.rangeLabel),
    ranges: scope.ranges,
    context: w.work,
    chords: st.slots,
    isDrums: isDrumTrack(w.track),
    isBass: isBassTrack(w.track),
    isVocal: isVocalTrack(w.track),
    isMelodic: isMelodicTrack(w.track),
    low,
    high,
    amount,
  };
}

interface PerTrackOptions {
  pitchedOnly?: boolean;
  drumsOnly?: boolean;
  uniform?: NoteTransform;
  label: string;
  silentSummary?: string;
}

/** Apply a transform to each scope track (editable notes only) and record the explanation. */
function perTrack(
  st: EditState,
  scope: ResolvedScope,
  intent: EditIntentId,
  amount: number,
  fn: (ctx: T.TransformContext, notes: WorkNote[], w: TrackWork) => T.TransformResult,
  opts: PerTrackOptions,
): number {
  let applied = 0;
  for (const track of scope.tracks) {
    if (track.kind !== 'midi') continue;
    if (opts.pitchedOnly && isDrumTrack(track)) {
      st.lines.push(`${track.name}: skipped — drum parts have no pitches for "${opts.label}".`);
      continue;
    }
    if (opts.drumsOnly && !isDrumTrack(track)) continue;
    const w = st.tw(track);
    const { notes, locked } = scopeNotes(st, w, scope);
    if (locked) {
      const secs = lockedSectionNames(st.song, track, scope.ranges);
      st.lockNotes.add(
        `${track.name}${secs.length ? ` (${secs.join(', ')})` : ''}: ${locked} locked note${locked === 1 ? '' : 's'} left untouched`,
      );
    }
    if (
      !notes.length &&
      !(
        intent === 'fill' ||
        (intent === 'busier' && isDrumTrack(track)) ||
        (intent === 'tension' && isDrumTrack(track))
      )
    ) {
      if (!locked && scope.explicitTracks)
        st.lines.push(`${track.name} (${scope.rangeLabel}): no notes to change.`);
      continue;
    }
    const ctx = ctxFor(st, w, scope, intent, amount);
    const res = fn(ctx, notes, w);
    commit(st, w, notes, res.notes);
    w.intents++;
    if (opts.uniform && !w.nonUniform) {
      const ids = notes.filter((n) => n.id).map((n) => n.id!);
      if (!w.uniform) {
        w.uniform = { ...opts.uniform };
        w.uniformIds = ids;
        w.uniformRanges = scope.noteIds ? undefined : scope.ranges;
      } else if (
        w.uniformIds &&
        w.uniformIds.length === ids.length &&
        ids.every((id) => w.uniformIds!.includes(id))
      ) {
        w.uniform = mergeUniform(w.uniform, opts.uniform);
      } else w.nonUniform = true;
      if (notes.some((n) => !n.id)) w.nonUniform = true;
    } else w.nonUniform = true;
    const summary = res.summary || opts.silentSummary || opts.label;
    st.lines.push(`${track.name} (${scope.rangeLabel}): ${summary}.`);
    applied++;
  }
  return applied;
}

function mergeUniform(a: NoteTransform, b: NoteTransform): NoteTransform {
  const out: NoteTransform = { ...a };
  for (const [k, v] of Object.entries(b) as [keyof NoteTransform, number & string][]) {
    const cur = out[k];
    if (
      typeof cur === 'number' &&
      typeof v === 'number' &&
      (k === 'transpose' || k === 'transpose_diatonic' || k === 'velocity_add' || k === 'time_shift_beats')
    )
      (out[k] as number) = cur + v;
    else if (
      typeof cur === 'number' &&
      typeof v === 'number' &&
      (k === 'velocity_scale' || k === 'duration_scale')
    )
      (out[k] as number) = cur * v;
    else (out[k] as unknown) = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Harmonic intents
// ---------------------------------------------------------------------------

function chordLockedAt(song: Song, tick: number): string | null {
  if (isLocked(song.locks, LockKeys.chords)) return 'song';
  const sec = sectionLayout(song).find((s) => tick >= s.startTick && tick < s.endTick);
  if (sec && isChordSectionLocked(song, sec.section.id)) return sec.section.name;
  return null;
}

type HarmonicKind = 'darker' | 'brighter' | 'ambiguous' | 'tension' | 'relax' | 'simplify';

/** Rewrite the chords whose onset lies in the scope; returns the old timeline. */
function rewriteChords(
  st: EditState,
  scope: ResolvedScope,
  kind: HarmonicKind,
): { old: ChordSlot[]; changed: number; lines: string[] } {
  const old = st.slots.map((s) => ({ ...s }));
  if (st.noChords) return { old, changed: 0, lines: [] };
  const firstLine = st.chordLines.length;
  const rng = st.rng('chords', kind, scope.rangeLabel);
  const next: ChordSlot[] = [];
  let changed = 0;
  const lockedNames = new Set<string>();
  const affected = old.filter((s) => inRanges(scope.ranges, s.tick));
  const lastAffected = affected[affected.length - 1];
  for (const s of old) {
    if (!inRanges(scope.ranges, s.tick)) {
      next.push(s);
      continue;
    }
    const lockName = chordLockedAt(st.song, s.tick);
    if (lockName) {
      lockedNames.add(lockName);
      next.push(s);
      continue;
    }
    const key = st.harmonicKey(s.tick);
    let spec = s.spec;
    let label = '';
    if (kind === 'darker') {
      const nxt = old[old.indexOf(s) + 1]?.spec;
      spec = darkenChord(s.spec, key, nxt);
      if (sameChord(spec, s.spec) && !sameChord(darkenChord(s.spec, key), s.spec))
        st.chordLines.push(
          `${spellChord(s.spec, key)} (${romanOf(s.spec, key)}) kept major — it resolves down a fifth to ${spellChord(nxt!, key)}, so the cadence still lands`,
        );
    } else if (kind === 'brighter') spec = brightenChord(s.spec, key);
    else if (kind === 'ambiguous') {
      const a = ambiguousChord(s.spec, key, rng);
      spec = a.spec;
      label = a.label;
    } else if (kind === 'tension') spec = tenseChord(s.spec, key, rng);
    else if (kind === 'relax' || kind === 'simplify') spec = relaxChord(s.spec, key);
    if (
      kind === 'tension' &&
      s === lastAffected &&
      s.duration >= 2 * (st.song.ppq ?? 480) &&
      (spec.quality === '7' || spec.quality === '9' || spec.quality === '7b9')
    ) {
      const half = Math.round(s.duration / 2);
      next.push({
        tick: s.tick,
        duration: half,
        spec: { root: spec.root, quality: '7sus4' },
        sourceId: s.sourceId,
      });
      next.push({
        tick: s.tick + half,
        duration: s.duration - half,
        spec: { root: spec.root, quality: '7' },
        sourceId: s.sourceId,
      });
      const susSpec: ChordSpec = { root: spec.root, quality: '7sus4' };
      const domSpec: ChordSpec = { root: spec.root, quality: '7' };
      st.chordLines.push(
        `${spellChord(s.spec, key)} → ${spellChord(susSpec, key)} → ${spellChord(domSpec, key)} (${romanOf(s.spec, key)} → ${romanOf(susSpec, key)} → ${romanOf(domSpec, key)}: a 4–3 suspension that delays the resolution into the next section)`,
      );
      changed++;
      continue;
    }
    if (!sameChord(spec, s.spec)) {
      changed++;
      st.chordLines.push(`${chordChangeText(s.spec, spec, key)}${label ? ` — ${label}` : ''}`);
    }
    next.push({ ...s, spec });
  }
  if (kind === 'simplify') {
    // Merge passing chords shorter than a beat into their predecessor.
    const merged: ChordSlot[] = [];
    for (const s of next) {
      const last = merged[merged.length - 1];
      if (
        last &&
        inRanges(scope.ranges, s.tick) &&
        s.duration < st.song.ppq &&
        last.tick + last.duration === s.tick &&
        !chordLockedAt(st.song, s.tick)
      ) {
        last.duration += s.duration;
        changed++;
        st.chordLines.push(
          `removed passing chord at ${describeRanges(st.song, [{ startTick: s.tick, endTick: s.tick + 1 }])}`,
        );
        continue;
      }
      merged.push({ ...s });
    }
    st.slots = merged;
  } else st.slots = next;
  for (const n of lockedNames)
    st.lockNotes.add(`Chords${n === 'song' ? '' : ` in ${n}`} are locked — harmony left unchanged there`);
  return { old, changed, lines: st.chordLines.slice(firstLine) };
}

/** Refit every unlocked pitched track (optionally restricted) to the new chord timeline within the scope. */
function refitTracks(
  st: EditState,
  scope: ResolvedScope,
  old: ChordSlot[],
  filter: (t: Track) => boolean,
  scaleMapAt?: (tick: number) => ((pc: number) => number) | undefined,
): string[] {
  const touched: string[] = [];
  for (const track of st.song.tracks) {
    if (track.kind !== 'midi' || !isPitchedTrack(track) || !filter(track)) continue;
    const w = st.tw(track);
    const { notes } = scopeNotes(st, w, { ...scope, noteIds: undefined, drumPitches: undefined });
    if (!notes.length) continue;
    const ctx = ctxFor(st, w, scope, 'refit', 1);
    const res = T.refitNotes(ctx, notes, old, st.slots, scaleMapAt);
    if (res.summary) {
      commit(st, w, notes, res.notes);
      w.nonUniform = true;
      touched.push(`${track.name} (${res.summary.replace('re-pitched ', '')})`);
    }
  }
  return touched;
}

function harmonicShade(
  st: EditState,
  scope: ResolvedScope,
  mood: 'darker' | 'brighter',
  amount: number,
  explicitTracks: boolean,
) {
  const targets = scope.tracks.filter((t) => t.kind === 'midi');
  const affectsTexture =
    !explicitTracks ||
    scope.chordsMentioned ||
    targets.filter(isPitchedTrack).length >= st.song.tracks.filter(isPitchedTrack).length;
  const { old, changed, lines: chordLines } = rewriteChords(st, scope, mood);
  // Darker maps passing tones onto the darker mode; brighter is chord-local (no scale map).
  const targetOf = (k: KeySignature) => (mood === 'darker' ? darkerMode(k.mode) : null);
  const scaleMapAt = (tick: number) => {
    const k = st.harmonicKey(tick);
    const m = targetOf(k);
    return m && m !== k.mode ? scaleMapFn(k, { tonic: k.tonic, mode: m }) : undefined;
  };
  // "G minor", or "E Phrygian / G minor" when the scope spans sections heard in different keys.
  const modeLabels = st
    .harmonicKeys(scope.ranges)
    .map((k) => ({ k, m: targetOf(k) }))
    .filter((x) => x.m && x.m !== x.k.mode)
    .map(
      (x) =>
        `${spellPitchClass(x.k.tonic, x.k)} ${x.m === 'minor' || x.m === 'major' ? x.m : `${x.m![0].toUpperCase()}${x.m!.slice(1)}`}`,
    );
  const modeText = modeLabels.length ? [...new Set(modeLabels)].join(' / ') : null;
  if (changed) {
    const others = refitTracks(st, scope, old, (t) => !targets.includes(t), scaleMapAt);
    st.lines.push(
      `Harmony (${scope.rangeLabel}): ${mood === 'darker' ? `borrowed from the parallel ${modeText ?? 'minor'} (modal interchange)` : modeText ? `brightened toward ${modeText}` : 'minor chords turned major (raised thirds)'}: ${chordLines.slice(0, 6).join('; ')}${chordLines.length > 6 ? '; …' : ''}.`,
    );
    if (others.length)
      st.lines.push(`Adjusted other parts so they agree with the new chords: ${others.join(', ')}.`);
  } else if (!st.noChords && affectsTexture && !modeText)
    st.lines.push(
      `Harmony (${scope.rangeLabel}): no chords to ${mood === 'darker' ? 'darken' : 'brighten'}.`,
    );
  else if (st.noChords)
    st.lines.push('Chords left unchanged as requested — only the selected part was re-coloured.');
  perTrack(
    st,
    scope,
    mood,
    amount,
    (ctx, notes) => {
      if (ctx.isDrums) return T.shadeExpression(ctx, notes, mood);
      const fitted = T.refitNotes(
        ctx,
        notes,
        old,
        st.slots,
        changed
          ? scaleMapAt
          : (tick) => {
              // Chords unchanged (locked or kept): only colour passing tones so they don't fight the harmony.
              const map = scaleMapAt(tick);
              return map;
            },
      );
      const shaded =
        ctx.isMelodic || !affectsTexture
          ? T.shadeExpression(ctx, fitted.notes, mood)
          : { notes: fitted.notes, summary: '' };
      const parts = [
        fitted.summary &&
          `${mood === 'darker' ? fitted.summary.replace('re-pitched', 'lowered the 3rd/6th/7th degrees on') : fitted.summary}${modeText ? ` (${modeText})` : ''}`,
        shaded.summary,
      ].filter(Boolean);
      return { notes: shaded.notes, summary: parts.join('; ') || 'no notes needed to change' };
    },
    { label: mood },
  );
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface EditInterpreterOptions {
  seed?: number;
}

export function interpretEditInstruction(
  song: Song,
  instruction: string,
  selection: EditSelection = {},
  opts: EditInterpreterOptions = {},
): EditInterpretation {
  const seed = opts.seed ?? song.generation?.seed ?? 1;
  const text = normalizeText(instruction);
  const clauses = parseClauses(text);
  const intents = clauses.flatMap((c) => c.intents.map((i) => i.id));
  if (!intents.length) {
    return {
      operations: [],
      explanation: `I couldn't map "${instruction.trim()}" to a MIDI edit. ${EDIT_HELP}`,
      intents: [],
      understood: false,
    };
  }
  const melody = findMelodyTrack(song);
  const st = new EditState(song, seed, NO_CHORDS_RE.test(text));
  let prev: ResolvedScope | undefined;
  for (const clause of clauses) {
    if (!clause.intents.length) continue;
    const scope = resolveScope(song, clause, selection, prev, melody);
    if (scope.missingInstrument && !scope.tracks.length) {
      st.lines.push(
        `There is no ${scope.missingInstrument} track in this song, so "${clause.text}" was skipped.`,
      );
      for (const i of clause.intents) st.intents.push(i.id);
      prev = scope;
      continue;
    }
    st.appliedClauses++;
    for (const intent of clause.intents) {
      st.intents.push(intent.id);
      applyIntent(st, intent.id, clause.text, scope, melody, selection);
    }
    prev = scope;
  }
  return finish(st, instruction);
}

function applyIntent(
  st: EditState,
  id: EditIntentId,
  clause: string,
  scope: ResolvedScope,
  melody: Track | undefined,
  selection: EditSelection,
) {
  const song = st.song;
  const amount = amountOf(clause);
  const label = INTENT_LABEL[id];
  switch (id) {
    case 'busier': {
      const s =
        scope.chordsMentioned && !scope.explicitTracks
          ? {
              ...scope,
              tracks: song.tracks.filter((t) => isPitchedTrack(t) && !isMelodicTrack(t) && !isBassTrack(t)),
            }
          : scope;
      perTrack(st, s, id, amount, (ctx, notes) => T.busier(ctx, notes), { label });
      return;
    }
    case 'simplify': {
      if (scope.chordsMentioned && !scope.explicitTracks) {
        const { old, changed, lines: chordLines } = rewriteChords(st, scope, 'simplify');
        if (changed) {
          st.lines.push(
            `Chords (${scope.rangeLabel}): simplified to plain diatonic triads — ${chordLines.slice(0, 6).join('; ')}${chordLines.length > 6 ? '; …' : ''}.`,
          );
          const others = refitTracks(st, scope, old, (t) => !isMelodicTrack(t));
          if (others.length)
            st.lines.push(`Accompaniment adjusted to the simpler chords: ${others.join(', ')}.`);
        } else st.lines.push(`Chords (${scope.rangeLabel}): already simple triads.`);
        return;
      }
      perTrack(st, scope, id, amount, (ctx, notes) => T.simplify(ctx, notes), { label });
      return;
    }
    case 'darker':
    case 'brighter':
      harmonicShade(st, scope, id, amount, scope.explicitTracks && !scope.chordsMentioned);
      return;
    case 'half-time':
    case 'double-time': {
      perTrack(
        st,
        scope,
        id,
        amount,
        (ctx, notes) => (id === 'half-time' ? T.halfTime(ctx, notes) : T.doubleTime(ctx, notes)),
        { label },
      );
      const coversDrums = scope.tracks.some(isDrumTrack) || !scope.explicitTracks;
      if (coversDrums && !isLocked(song.locks, LockKeys.structure)) {
        for (const sp of sectionLayout(song)) {
          if (!scope.ranges.some((r) => r.startTick <= sp.startTick && r.endTick >= sp.endTick)) continue;
          if (isLocked(song.locks, LockKeys.section(sp.section.id))) continue;
          st.extraOps.push({
            op: 'update_section',
            section: sp.section.id,
            changes: { feel: id },
            reason: `${label} feel`,
          });
        }
      }
      return;
    }
    case 'tension': {
      const harmonic = !scope.explicitTracks || scope.chordsMentioned;
      if (harmonic) {
        const { old, changed, lines: chordLines } = rewriteChords(st, scope, 'tension');
        if (changed) {
          st.lines.push(
            `Chords (${scope.rangeLabel}): added extensions and suspensions — ${chordLines.slice(0, 6).join('; ')}${chordLines.length > 6 ? '; …' : ''}.`,
          );
          const others = refitTracks(st, scope, old, (t) => !isMelodicTrack(t));
          if (others.length) st.lines.push(`Parts adjusted for the suspensions: ${others.join(', ')}.`);
        }
      }
      const s = scope.tracks.length
        ? scope
        : { ...scope, tracks: song.tracks.filter((t) => t.kind === 'midi') };
      perTrack(st, s, id, amount, (ctx, notes) => T.addTension(ctx, notes), { label });
      return;
    }
    case 'less-tension': {
      const { old, changed, lines: chordLines } = rewriteChords(st, scope, 'relax');
      if (changed) {
        st.lines.push(
          `Chords (${scope.rangeLabel}): back to stable diatonic triads — ${chordLines.slice(0, 6).join('; ')}${chordLines.length > 6 ? '; …' : ''}.`,
        );
        const others = refitTracks(st, scope, old, (t) => !isMelodicTrack(t));
        if (others.length) st.lines.push(`Accompaniment adjusted: ${others.join(', ')}.`);
      }
      const s = scope.explicitTracks
        ? scope
        : { ...scope, tracks: song.tracks.filter((t) => t.kind === 'midi') };
      perTrack(st, s, id, amount, (ctx, notes) => T.velocityRamp(ctx, notes, -4, -10), {
        label,
        silentSummary: 'eased the dynamics back (gentle decrescendo)',
      });
      return;
    }
    case 'ambiguous': {
      const { old, changed, lines: chordLines } = rewriteChords(st, scope, 'ambiguous');
      if (!changed) {
        st.lines.push(
          st.noChords
            ? 'Chords were not changed (you asked to keep them).'
            : `Chords (${scope.rangeLabel}): nothing to change (no chords, or they are locked/already suspended).`,
        );
        return;
      }
      st.lines.push(
        `Chords (${scope.rangeLabel}): removed or blurred the defining thirds — ${chordLines.slice(0, 8).join('; ')}${chordLines.length > 8 ? '; …' : ''}.`,
      );
      const others = refitTracks(st, scope, old, (t) => !isMelodicTrack(t));
      if (others.length)
        st.lines.push(
          `Accompaniment voicings follow the new chords: ${others.join(', ')}. The melody was left as is.`,
        );
      return;
    }
    case 'answer': {
      const specific = scope.mentions.filter(
        (m) => (!m.generic || m.generic === 'melody') && m.tracks.length,
      );
      const answerIdx = clause.search(/\banswer|\brespond|call-and-response|rather than|instead of/);
      let target: Track | undefined =
        specific.find((m) => m.index < answerIdx)?.tracks[0] ??
        selectionTracks(song, selection)[0] ??
        specific[0]?.tracks[0];
      let reference: Track | undefined = specific.find((m) => m.index > answerIdx)?.tracks[0];
      if (!reference || reference === target)
        reference =
          melody && melody !== target ? melody : song.tracks.find((t) => isVocalTrack(t) && t !== target);
      if (target && reference && target.id === reference.id) target = undefined;
      if (!target || !reference) {
        st.lines.push(
          'Tell me which instrument should answer which part (e.g. "make the violin answer the vocal").',
        );
        return;
      }
      const refNotes = st.tw(reference).work;
      perTrack(
        st,
        { ...scope, tracks: [target] },
        id,
        amount,
        (ctx, notes) => T.answerPhrases(ctx, notes, refNotes),
        { label: `${label} (${reference.name})` },
      );
      st.lines.push(
        `${target.name} now responds in the gaps of the ${reference.name} instead of doubling it.`,
      );
      return;
    }
    case 'repitch':
      perTrack(st, scope, id, amount, (ctx, notes) => T.newPitchesSameRhythm(ctx, notes), {
        label,
        pitchedOnly: true,
      });
      return;
    case 'rerhythm':
      perTrack(st, scope, id, amount, (ctx, notes) => newRhythmSamePitches(ctx, notes), { label });
      return;
    case 'transpose': {
      const spec = parseTranspose(clause) ?? {
        semitones: 12 * (/\b(down|lower)\b/.test(clause) ? -1 : 1),
        label: 'an octave',
      };
      const allPitched = song.tracks.filter(isPitchedTrack);
      if (
        scope.wholeSong &&
        !scope.explicitTracks &&
        spec.semitones &&
        !spec.steps &&
        scope.tracks.length >= allPitched.length &&
        !isLocked(song.locks, LockKeys.key)
      ) {
        const k = keyAt(song, 0);
        const tonic = spellPitchClass(mod12(k.tonic + spec.semitones), k);
        st.extraOps.push({
          op: 'set_key',
          tonic,
          mode: k.mode,
          at_bar: 1,
          transpose_notes: true,
          reason: `transpose ${spec.label}`,
        });
        st.lines.push(
          `Whole song: changed key ${keyName(k)} → ${tonic} ${k.mode} and transposed all pitched notes and chords ${spec.label} (drums unchanged).`,
        );
        return;
      }
      const transform: NoteTransform = spec.steps
        ? { transpose_diatonic: spec.steps }
        : { transpose: spec.semitones };
      perTrack(st, scope, id, amount, (ctx, notes) => T.transposeNotes(ctx, notes, spec), {
        label,
        pitchedOnly: true,
        uniform: transform,
        silentSummary: `transposed ${spec.label}`,
      });
      return;
    }
    case 'register-up':
    case 'register-down':
      perTrack(
        st,
        scope,
        id,
        amount,
        (ctx, notes) => T.registerShift(ctx, notes, id === 'register-up' ? 1 : -1),
        { label, pitchedOnly: true },
      );
      return;
    case 'louder':
    case 'softer': {
      const add = Math.round((id === 'louder' ? 12 : -12) * amount);
      perTrack(st, scope, id, amount, (ctx, notes) => T.velocityChange(ctx, notes, add), {
        label,
        uniform: { velocity_add: add },
        silentSummary: `velocity ${add > 0 ? '+' : ''}${add}`,
      });
      return;
    }
    case 'expressive':
      perTrack(st, scope, id, amount, (ctx, notes) => T.expressiveDynamics(ctx, notes), { label });
      return;
    case 'flatten-dynamics':
      perTrack(st, scope, id, amount, (ctx, notes) => T.flattenDynamics(ctx, notes), { label });
      return;
    case 'crescendo':
    case 'decrescendo':
      perTrack(
        st,
        scope,
        id,
        amount,
        (ctx, notes) =>
          id === 'crescendo' ? T.velocityRamp(ctx, notes, -14, 18) : T.velocityRamp(ctx, notes, 10, -22),
        {
          label,
          silentSummary:
            id === 'crescendo'
              ? 'velocities ramp up across the range (crescendo)'
              : 'velocities fall away across the range (decrescendo)',
        },
      );
      return;
    case 'accent':
      perTrack(st, scope, id, amount, (ctx, notes) => T.accentDownbeats(ctx, notes), { label });
      return;
    case 'staccato':
      perTrack(st, scope, id, amount, (ctx, notes) => T.staccatoNotes(ctx, notes), {
        label,
        uniform: { duration_scale: 0.5, articulation: 'staccato' },
        silentSummary: 'halved note lengths with staccato articulation',
      });
      return;
    case 'legato':
      perTrack(st, scope, id, amount, (ctx, notes) => T.legatoNotes(ctx, notes), { label });
      return;
    case 'shorter': {
      const f = amount < 1 ? 0.85 : amount > 1 ? 0.5 : 0.7;
      perTrack(st, scope, id, amount, (ctx, notes) => T.scaleDurations(ctx, notes, f), {
        label,
        uniform: { duration_scale: f },
        silentSummary: `note lengths ×${f}`,
      });
      return;
    }
    case 'longer': {
      const f = amount < 1 ? 1.25 : amount > 1 ? 2 : 1.5;
      perTrack(st, scope, id, amount, (ctx, notes) => T.lengthen(ctx, notes, f), {
        label,
        silentSummary: `lengthened notes up to ×${f} (without overlapping the next note)`,
      });
      return;
    }
    case 'quantize': {
      const grid = parseGrid(clause);
      const pct = /(\d+)\s*%/.exec(clause);
      const strength = pct
        ? Math.min(1, parseInt(pct[1], 10) / 100)
        : /\bquanti[sz]/.test(clause)
          ? amount < 1
            ? 0.5
            : 1
          : amount < 1
            ? 0.35
            : amount > 1
              ? 0.9
              : 0.6;
      perTrack(st, scope, id, amount, (ctx, notes) => T.quantizeNotes(ctx, notes, grid.beats, strength), {
        label,
        uniform: { quantize_beats: grid.beats, quantize_strength: strength },
        silentSummary: `quantized to ${grid.label} at ${Math.round(strength * 100)}% strength`,
      });
      return;
    }
    case 'humanize': {
      const amt = Math.min(1, 0.3 * amount);
      perTrack(st, scope, id, amount, (ctx, notes) => T.humanizeNotes(ctx, notes, amt), {
        label,
        uniform: { humanize: amt },
        silentSummary: `humanized timing and velocity (amount ${amt.toFixed(2)})`,
      });
      return;
    }
    case 'swing':
      perTrack(st, scope, id, amount, (ctx, notes) => T.swingNotes(ctx, notes), { label });
      return;
    case 'straighten':
      perTrack(st, scope, id, amount, (ctx, notes) => T.straightenNotes(ctx, notes), { label });
      return;
    case 'syncopate':
      perTrack(st, scope, id, amount, (ctx, notes) => T.syncopateNotes(ctx, notes), { label });
      return;
    case 'less-syncopation':
      perTrack(st, scope, id, amount, (ctx, notes) => T.desyncopateNotes(ctx, notes), { label });
      return;
    case 'invert':
      perTrack(st, scope, id, amount, (ctx, notes) => T.invertMelody(ctx, notes), {
        label,
        pitchedOnly: true,
      });
      return;
    case 'reverse':
      perTrack(st, scope, id, amount, (ctx, notes) => T.reverseNotes(ctx, notes), { label });
      return;
    case 'fill': {
      const every = /\bevery (\d+) bars\b/.exec(clause);
      const n = every ? parseInt(every[1], 10) : /\bend\b|\blast\b/.test(clause) ? 10_000 : 4;
      const tracks = scope.tracks.filter(isDrumTrack);
      const s = tracks.length ? { ...scope, tracks } : { ...scope, tracks: song.tracks.filter(isDrumTrack) };
      if (!s.tracks.length) {
        st.lines.push('There is no drum track to add fills to.');
        return;
      }
      perTrack(st, s, id, amount, (ctx, notes) => T.addDrumFills(ctx, notes, n), { label });
      return;
    }
    case 'delete': {
      const ghost = /\bghost(?: notes)?\b/.test(clause);
      const high = /\b(?:high(?:est)?|top) notes\b/.test(clause);
      const low = /\b(?:low(?:est)?|bottom) notes\b/.test(clause);
      perTrack(
        st,
        { ...scope, drumPitches: undefined },
        id,
        amount,
        (ctx, notes) =>
          T.removeNotes(ctx, notes, {
            drumPitches: ctx.isDrums ? scope.drumPitches : undefined,
            ghost,
            high,
            low,
          }),
        { label },
      );
      return;
    }
    case 'double-octave':
    case 'harmonize': {
      const mentionsWithTracks = scope.mentions.filter(
        (m) => (!m.generic || m.generic === 'melody') && m.tracks.length,
      );
      const withIdx = clause.search(/\b(?:with|on|using|in|to|for|into) (?:the|a)\b/);
      const targetMention = withIdx >= 0 ? mentionsWithTracks.find((m) => m.index > withIdx) : undefined;
      const selTracks = selectionTracks(song, selection);
      const sourceTracks =
        mentionsWithTracks.length && mentionsWithTracks[0] !== targetMention
          ? mentionsWithTracks[0].generic === 'melody' && selTracks.length
            ? selTracks
            : mentionsWithTracks[0].tracks
          : selTracks.length
            ? selTracks
            : melody
              ? [melody]
              : [];
      const source = sourceTracks.filter(isPitchedTrack)[0];
      if (!source) {
        st.lines.push(
          'Select or name the part to double/harmonize (e.g. "double the melody an octave higher").',
        );
        return;
      }
      const srcNotes = st
        .tw(source)
        .work.filter(
          (n) => inRanges(scope.ranges, n.tick) && (!scope.noteIds || !n.id || scope.noteIds.has(n.id)),
        );
      let steps = 2;
      if (id === 'harmonize') {
        if (/\bsixths?\b/.test(clause)) steps = 5;
        else if (/\btenths?\b/.test(clause)) steps = 9;
        if (/\bbelow\b|\bunder\b|\blower\b|\bdown\b/.test(clause)) steps = -steps;
      }
      const semis = /\b(lower|below|down|beneath)\b/.test(clause) ? -12 : 12;
      let target = targetMention?.tracks[0] ?? source;
      if (target === source && !isVocalTrack(source) && MONOPHONIC.has(source.instrumentId)) {
        // A monophonic instrument cannot play its own harmony: give the new line its own track.
        const name = uniqueTrackName(song, `${source.name} ${id === 'double-octave' ? 'Octave' : 'Harmony'}`);
        const virtual: Track = { ...source, id: name, name, notes: [] };
        const ctx = ctxFor(
          st,
          { track: virtual, work: [], lockedIds: new Set(), locked: [], nonUniform: true, intents: 0 },
          scope,
          id,
          amount,
        );
        const res =
          id === 'double-octave'
            ? T.octaveDoubling(ctx, srcNotes, semis)
            : T.harmonizeNotes(ctx, srcNotes, steps);
        st.extraOps.push({
          op: 'add_track',
          name,
          instrument_id: source.instrumentId,
          role: source.role,
          function: 'harmony',
          reason: `${INTENT_LABEL[id]} for ${source.name}`,
        });
        st.extraOps.push({
          op: 'add_notes',
          track: name,
          notes: sortWork(res.notes).map((n) => toOpNote(song, n)),
          reason: INTENT_LABEL[id],
        });
        st.lines.push(
          `New track "${name}" (${source.instrumentId}, ${scope.rangeLabel}): ${res.summary} from the ${source.name} — a ${source.instrumentId.replace(/-/g, ' ')} plays one note at a time, so the new line gets its own part.`,
        );
        return;
      }
      if (target === source && isVocalTrack(source)) {
        const backing = song.tracks.find(
          (t) =>
            t !== source && isVocalTrack(t) && /backing|harmony|double/i.test(`${t.name} ${t.instrumentId}`),
        );
        if (backing) target = backing;
        else {
          // A second voice: new backing-vocal track singing the same words.
          const name = uniqueTrackName(song, id === 'double-octave' ? 'Vocal Double' : 'Harmony Vocal');
          const voiceType =
            id === 'double-octave' ? (semis > 0 ? 'soprano' : 'bass') : source.vocal?.voiceType;
          const virtual: Track = {
            ...source,
            id: name,
            name,
            instrumentId: 'backing-vocal',
            notes: [],
            constraints: { function: 'harmony' },
            vocal: { ...source.vocal, voiceType },
          };
          const ctx = ctxFor(
            st,
            { track: virtual, work: [], lockedIds: new Set(), locked: [], nonUniform: true, intents: 0 },
            scope,
            id,
            amount,
          );
          const res =
            id === 'double-octave'
              ? T.octaveDoubling(ctx, srcNotes, semis)
              : T.harmonizeNotes(ctx, srcNotes, steps);
          const withWords = res.notes.map((n, i) =>
            srcNotes[i]?.syllable ? { ...n, syllable: srcNotes[i].syllable } : n,
          );
          st.extraOps.push({
            op: 'add_track',
            name,
            instrument_id: 'backing-vocal',
            role: 'vocal',
            function: 'harmony',
            reason: `${INTENT_LABEL[id]} for ${source.name}`,
          });
          st.extraOps.push({
            op: 'add_notes',
            track: name,
            notes: sortWork(withWords).map((n) => toOpNote(song, n)),
            reason: INTENT_LABEL[id],
          });
          st.lines.push(
            `New track "${name}" (backing vocal, ${scope.rangeLabel}): ${res.summary} from the ${source.name}, singing the same syllables.`,
          );
          return;
        }
      }
      const w = st.tw(target);
      const ctx = ctxFor(st, w, scope, id, amount);
      const res =
        id === 'double-octave'
          ? T.octaveDoubling(ctx, srcNotes, semis)
          : T.harmonizeNotes(ctx, srcNotes, steps);
      const notes = isVocalTrack(target)
        ? res.notes.map((n, i) => (srcNotes[i]?.syllable ? { ...n, syllable: srcNotes[i].syllable } : n))
        : res.notes;
      const before = w.work.length;
      commit(st, w, [], notes);
      w.nonUniform = true;
      w.intents++;
      const added = w.work.length - before;
      st.lines.push(
        `${target.name} (${scope.rangeLabel}): ${res.summary}${target !== source ? ` from the ${source.name}` : ''}${added < notes.length ? ` (${notes.length - added} skipped in locked bars)` : ''}.`,
      );
      return;
    }
  }
}

const MONOPHONIC = new Set([
  'violin',
  'viola',
  'cello',
  'contrabass',
  'flute',
  'clarinet',
  'saxophone',
  'trumpet',
  'trombone',
  'french-horn',
  'synth-lead',
  'electric-guitar-lead',
  'electric-bass',
  'synth-bass',
  'upright-bass',
]);

function uniqueTrackName(song: Song, base: string): string {
  let name = base;
  let i = 2;
  while (song.tracks.some((t) => t.name.toLowerCase() === name.toLowerCase())) name = `${base} ${i++}`;
  return name;
}

function parseGrid(text: string): { beats: number; label: string } {
  if (/\b(?:32(?:nd)?s?|thirty-?second)\b/.test(text)) return { beats: 0.125, label: '32nd notes' };
  if (/\btriplets?\b/.test(text)) return { beats: 1 / 3, label: '8th-note triplets' };
  if (/\b(?:16(?:th)?s?|sixteenths?)\b/.test(text)) return { beats: 0.25, label: '16th notes' };
  if (/\b(?:8(?:th)?s?|eighths?)\b/.test(text)) return { beats: 0.5, label: '8th notes' };
  if (/\b(?:quarters?|4(?:th)?s|quarter notes?)\b/.test(text)) return { beats: 1, label: 'quarter notes' };
  return { beats: 0.25, label: '16th notes' };
}

/** Same pitch sequence, new rhythm on an 8th-note grid (same number of notes per bar). */
function newRhythmSamePitches(ctx: T.TransformContext, notes: WorkNote[]): T.TransformResult {
  const out: WorkNote[] = [];
  const byBar = new Map<number, WorkNote[]>();
  for (const n of sortWork(notes.map((x) => ({ ...x })))) {
    const b = barIndex(ctx.song, n.tick);
    byBar.set(b, [...(byBar.get(b) ?? []), n]);
  }
  for (const [b, ns] of byBar) {
    const start = barToTick(ctx.song, b);
    const len = barToTick(ctx.song, b + 1) - start;
    const step = Math.round(ctx.song.ppq / 2);
    const slots = Math.max(1, Math.floor(len / step));
    const groups = T.groupByOnset(ns);
    const k = Math.min(groups.length, slots);
    const positions = new Set<number>([0]);
    const pool = ctx.rng.shuffle([...Array(slots).keys()].slice(1));
    for (const p of pool) {
      if (positions.size >= k) break;
      positions.add(p);
    }
    const sorted = [...positions].sort((a, c) => a - c);
    groups.slice(0, k).forEach((g, i) => {
      const t = start + sorted[i] * step;
      const end = i + 1 < sorted.length ? start + sorted[i + 1] * step : start + len;
      for (const n of g)
        out.push({ ...n, tick: t, duration: Math.max(Math.round(step / 4), end - t - Math.round(step / 8)) });
    });
    for (const g of groups.slice(k)) for (const n of g) out.push(n);
  }
  return {
    notes: out,
    summary: `kept the pitch sequence and wrote a new 8th-note-grid rhythm (${notes.length} notes)`,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function finish(st: EditState, instruction: string): EditInterpretation {
  const ops: MusicOperation[] = [];
  const reason = instruction.trim();
  const chordRes = chordOpsFromSlots(st.song, st.slots, reason);
  ops.push(...chordRes.ops);
  ops.push(...st.extraOps);
  let noteOps = 0;
  for (const w of st.tracks.values()) {
    if (w.uniform && !w.nonUniform && w.uniformIds) {
      const ids = new Set(w.uniformIds);
      const editable = w.track.notes.filter((n) => ids.has(n.id));
      const o = uniformTransformOps(st.song, w.track, editable, w.uniform, reason, w.uniformRanges);
      ops.push(...o);
      noteOps += o.length;
      continue;
    }
    const res = emitNoteOps(st.song, w.track, w.track.notes, w.work, { reason });
    ops.push(...res.ops);
    noteOps += res.ops.length;
  }
  const uniqueIntents = [...new Set(st.intents)];
  const head = `Interpreted "${instruction.trim()}" as: ${uniqueIntents.map((i) => INTENT_LABEL[i as EditIntentId] ?? i).join(' + ')}.`;
  const parts = [head, ...st.lines];
  if (st.lockNotes.size) parts.push(`Locked material was skipped — ${[...st.lockNotes].join('; ')}.`);
  if (!ops.length && st.lockNotes.size) parts.push('Nothing was changed: everything in range is locked.');
  else if (!ops.length && st.appliedClauses)
    parts.push('No changes were needed — the music already matches that request.');
  void noteOps;
  return { operations: ops, explanation: parts.join(' '), intents: uniqueIntents, understood: true };
}
