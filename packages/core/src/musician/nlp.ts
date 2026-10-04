import type { Section, SectionKind, Song, Track } from '../ir/types';
import { GM_DRUM } from '../ir/gm';

/**
 * Tiny deterministic natural-language helpers shared by the offline interpreters:
 * normalization, number words, ordinals, amounts, section / track / bar mentions, clauses.
 */

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const CONTRACTIONS: [RegExp, string][] = [
  [/\bdon't\b/g, 'do not'],
  [/\bdoesn't\b/g, 'does not'],
  [/\bdidn't\b/g, 'did not'],
  [/\bcan't\b/g, 'cannot'],
  [/\bcannot\b/g, 'can not'],
  [/\bwon't\b/g, 'will not'],
  [/\bisn't\b/g, 'is not'],
  [/\baren't\b/g, 'are not'],
  [/\bwasn't\b/g, 'was not'],
  [/\bshouldn't\b/g, 'should not'],
  [/\bwouldn't\b/g, 'would not'],
  [/\bcouldn't\b/g, 'could not'],
  [/\bit's\b/g, 'it is'],
  [/\bwhat's\b/g, 'what is'],
  [/\bthat's\b/g, 'that is'],
  [/\bthere's\b/g, 'there is'],
  [/\bwhere's\b/g, 'where is'],
  [/\bwho's\b/g, 'who is'],
  [/\bhow's\b/g, 'how is'],
  [/\blet's\b/g, 'let us'],
  [/\bi'm\b/g, 'i am'],
  [/\bi'd\b/g, 'i would'],
  [/\bi've\b/g, 'i have'],
  [/\bwe're\b/g, 'we are'],
  [/\byou're\b/g, 'you are'],
  [/\bthey're\b/g, 'they are'],
];

const SMALL_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Replace English number words with digits ("sixteen-bar" → "16-bar", "twenty four" → "24"). */
export function wordsToNumbers(text: string): string {
  let t = text;
  t = t
    .replace(/\ba couple of\b/g, '2')
    .replace(/\ba couple\b/g, '2')
    .replace(/\ba few\b/g, '3');
  t = t.replace(
    /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/g,
    (_m, tens: string, ones: string) => String(TENS[tens] + SMALL_NUMBERS[ones]),
  );
  t = t.replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/g, (m) => String(TENS[m]));
  t = t.replace(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/g,
    (m) => String(SMALL_NUMBERS[m]),
  );
  // "no 1" (from "no one") back to words.
  t = t.replace(/\bno 1\b/g, 'no one');
  return t;
}

/** Lowercase, unify quotes/dashes, expand contractions, convert number words, collapse spaces. */
export function normalizeText(text: string): string {
  let t = text.toLowerCase();
  t = t
    .replace(/[‘’‛`´]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-');
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
  t = wordsToNumbers(t);
  // Sentence punctuation becomes a clause separator; keep decimals ("1.5 db").
  t = t.replace(/[.!?]+(\s|$)/g, ' , ').replace(/[!?]+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/(\s*,\s*)+$/g, '').trim();
  return t;
}

/** Words or phrases in quotes: 'fire', "fire", “fire”. */
export function extractQuoted(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s(:])(?:"([^"]+)"|“([^”]+)”|‘([^’]+)’|'([^']+)')(?=$|[\s.,!?;:)])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push((m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim());
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Amounts, numbers, ordinals
// ---------------------------------------------------------------------------

/** Intensity multiplier: "slightly" → 0.5, default 1, "much" → 1.6. */
export function amountOf(text: string): number {
  if (
    /\b(slight(ly)?|a (little )?bit|a little|a touch|somewhat|subtl(e|y)|gently|a tad|marginally|mildly|a hair)\b/.test(
      text,
    )
  )
    return 0.5;
  if (
    /\b(much|a lot|lots|way|really|very|significantly|drastically|heavily|extremely|super|massively|dramatically|hugely|considerably|totally|a ton)\b/.test(
      text,
    )
  )
    return 1.6;
  return 1;
}

/** Explicit decibel amount ("by 3 db", "-2db", "+1.5 dB"). */
export function parseDb(text: string): number | null {
  const m = /([+-]?\d+(?:\.\d+)?)\s*db\b/.exec(text);
  return m ? parseFloat(m[1]) : null;
}

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  '1st': 1,
  opening: 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  fourth: 4,
  '4th': 4,
  fifth: 5,
  '5th': 5,
  sixth: 6,
  '6th': 6,
  seventh: 7,
  '7th': 7,
  eighth: 8,
  '8th': 8,
  ninth: 9,
  '9th': 9,
  tenth: 10,
  '10th': 10,
  last: -1,
  final: -1,
  closing: -1,
  penultimate: -2,
};

/** Ordinal right before `index` in `text` ("the second chorus", "the last verse", "the second to last chorus"). */
export function ordinalBefore(text: string, index: number): number | null {
  const before = text.slice(Math.max(0, index - 28), index);
  if (/\b(second[\s-]to[\s-]last|second last|next[\s-]to[\s-]last|penultimate)\s*$/.test(before)) return -2;
  const m =
    /\b(first|1st|opening|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|last|final|closing)\s*$/.exec(
      before,
    );
  return m ? ORDINAL_WORDS[m[1]] : null;
}

/** "all", "every", "each", "both" right before a mention. */
function quantifierBefore(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 12), index);
  return /\b(all( the| of the)?|every|each|both( the)?)\s*$/.test(before);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface SectionMention {
  sections: Section[];
  /** Matched text. */
  text: string;
  index: number;
  end: number;
}

const CHORUS_LIKE: SectionKind[] = ['chorus', 'final-chorus'];

const SECTION_PATTERNS: { kind: SectionKind; re: RegExp }[] = [
  { kind: 'pre-chorus', re: /\bpre[\s-]?chorus(?:es)?\b|\bthe pre\b/g },
  { kind: 'post-chorus', re: /\bpost[\s-]?chorus(?:es)?\b/g },
  { kind: 'chorus', re: /\bchorus(?:es)?\b|\brefrains?\b/g },
  { kind: 'verse', re: /\bverses?\b/g },
  { kind: 'bridge', re: /\bbridges?\b|\bmiddle[\s-]?(?:8|eight)\b/g },
  { kind: 'intro', re: /\bintro(?:duction)?s?\b/g },
  { kind: 'outro', re: /\boutros?\b|\bcoda\b/g },
  { kind: 'breakdown', re: /\bbreakdowns?\b/g },
  { kind: 'build', re: /\bbuild[\s-]?ups?\b|\bthe build\b/g },
  { kind: 'drop', re: /\bthe drops?\b|\bdrops\b/g },
  { kind: 'solo', re: /\bthe solo\b|\bsolo section\b/g },
  { kind: 'interlude', re: /\binterludes?\b/g },
];

function overlaps(a: { index: number; end: number }, spans: { index: number; end: number }[]): boolean {
  return spans.some((s) => a.index < s.end && s.index < a.end);
}

/** Section mentions in reading order. Exact section names win over kind words. */
export function findSectionMentions(song: Pick<Song, 'sections'>, text: string): SectionMention[] {
  const t = text.toLowerCase();
  const out: SectionMention[] = [];
  // 1) Exact names (longest first).
  const names = Array.from(
    new Set(song.sections.map((s) => s.name.toLowerCase()).filter((n) => n.length >= 3)),
  ).sort((a, b) => b.length - a.length);
  for (const name of names) {
    const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const span = { index: m.index, end: m.index + m[0].length };
      if (overlaps(span, out)) continue;
      // A bare kind word that happens to be a name ("Chorus") is still subject to ordinals.
      const ord = ordinalBefore(t, m.index);
      const sameName = song.sections.filter((s) => s.name.toLowerCase() === name);
      if (ord !== null && sameName.length === 1 && /^[a-z-]+$/.test(name)) continue; // let kind logic handle "last chorus"
      out.push({ sections: sameName, text: m[0], ...span });
    }
  }
  // 2) Kind words with ordinals / numbers / quantifiers.
  for (const { kind, re } of SECTION_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const span = { index: m.index, end: m.index + m[0].length };
      if (overlaps(span, out)) continue;
      if (kind === 'chorus' && /(pre|post)[\s-]?$/.test(t.slice(Math.max(0, m.index - 5), m.index))) continue;
      const kinds = kind === 'chorus' ? CHORUS_LIKE : [kind];
      let candidates = song.sections.filter((s) => kinds.includes(s.kind));
      if (candidates.length === 0 && kind === 'chorus')
        candidates = song.sections.filter((s) => /chorus/i.test(s.name) && !/pre|post/i.test(s.name));
      if (candidates.length === 0)
        candidates = song.sections.filter((s) => s.name.toLowerCase().includes(kind.replace('-', '')));
      const ord = ordinalBefore(t, m.index);
      const after = /^\s*(\d+)\b/.exec(t.slice(span.end));
      const plural = /(es|s)$/.test(m[0]) && !/chorus$/.test(m[0]);
      let chosen: Section[];
      let textSpan = span;
      if (ord !== null) {
        if (kind === 'chorus' && ord === -1 && /final\s*$/.test(t.slice(Math.max(0, m.index - 8), m.index))) {
          const finals = song.sections.filter((s) => s.kind === 'final-chorus');
          chosen = finals.length ? [finals[finals.length - 1]] : candidates.slice(-1);
        } else {
          const idx = ord > 0 ? ord - 1 : candidates.length + ord;
          chosen = idx >= 0 && idx < candidates.length ? [candidates[idx]] : [];
        }
        const ordStart = t
          .slice(0, m.index)
          .search(
            /(?:\b(?:second[\s-]to[\s-]last|second last|next[\s-]to[\s-]last|penultimate|first|1st|opening|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|last|final|closing))\s*$/,
          );
        textSpan = { index: ordStart >= 0 ? ordStart : m.index, end: span.end };
      } else if (after) {
        const n = parseInt(after[1], 10);
        const byName = song.sections.find((s) => s.name.toLowerCase() === `${m![0]} ${n}`.toLowerCase());
        chosen = byName ? [byName] : n >= 1 && n <= candidates.length ? [candidates[n - 1]] : [];
        textSpan = { index: m.index, end: span.end + after[0].length };
      } else {
        void plural;
        void quantifierBefore;
        chosen = candidates;
      }
      out.push({ sections: chosen, text: t.slice(textSpan.index, textSpan.end), ...textSpan });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

export type GenericTrackRef = 'melody' | 'all' | 'chords' | 'selection';

export interface TrackMention {
  tracks: Track[];
  /** The vocabulary word or track name that matched. */
  word: string;
  index: number;
  end: number;
  generic?: GenericTrackRef;
  /** Drum-element filter (GM pitches) for "kick", "snare", "hi-hats"… */
  drumPitches?: number[];
  /** Human label, e.g. "bass". */
  label: string;
}

const isDrumKit = (t: Track) =>
  t.role === 'drums' ||
  t.role === 'percussion' ||
  ['drum-kit', 'electronic-kit', 'percussion'].includes(t.instrumentId) ||
  t.midiChannel === 9;
const inst =
  (...ids: string[]) =>
  (t: Track) =>
    ids.includes(t.instrumentId);
const nameHas = (re: RegExp) => (t: Track) => re.test(t.name);
const anyOf =
  (...fs: ((t: Track) => boolean)[]) =>
  (t: Track) =>
    fs.some((f) => f(t));

export const DRUM_GROUPS: Record<string, number[]> = {
  kick: [GM_DRUM.KICK_ACOUSTIC, GM_DRUM.KICK],
  snare: [GM_DRUM.SIDE_STICK, GM_DRUM.SNARE, GM_DRUM.CLAP, GM_DRUM.SNARE_ELECTRIC],
  hats: [GM_DRUM.HIHAT_CLOSED, GM_DRUM.HIHAT_PEDAL, GM_DRUM.HIHAT_OPEN],
  ride: [GM_DRUM.RIDE, GM_DRUM.RIDE_BELL, GM_DRUM.RIDE_2],
  crash: [GM_DRUM.CRASH, GM_DRUM.CRASH_2, GM_DRUM.CHINA, GM_DRUM.SPLASH],
  cymbals: [
    GM_DRUM.CRASH,
    GM_DRUM.CRASH_2,
    GM_DRUM.CHINA,
    GM_DRUM.SPLASH,
    GM_DRUM.RIDE,
    GM_DRUM.RIDE_BELL,
    GM_DRUM.RIDE_2,
  ],
  toms: [
    GM_DRUM.FLOOR_TOM_LOW,
    GM_DRUM.FLOOR_TOM_HIGH,
    GM_DRUM.TOM_LOW,
    GM_DRUM.TOM_LOW_MID,
    GM_DRUM.TOM_HIGH_MID,
    GM_DRUM.TOM_HIGH,
  ],
};

interface Vocab {
  re: RegExp;
  label: string;
  match?: (t: Track) => boolean;
  generic?: GenericTrackRef;
  drum?: keyof typeof DRUM_GROUPS;
}

const VOCAB: Vocab[] = [
  { re: /\b(?:kick(?: drum)?s?|bass drums?)\b/g, label: 'kick', match: isDrumKit, drum: 'kick' },
  { re: /\bsnares?\b|\bclaps?\b/g, label: 'snare', match: isDrumKit, drum: 'snare' },
  { re: /\bhi[\s-]?hats?\b|\bhats\b/g, label: 'hi-hats', match: isDrumKit, drum: 'hats' },
  { re: /\bcymbals?\b/g, label: 'cymbals', match: isDrumKit, drum: 'cymbals' },
  { re: /\bcrash(?:es)?\b/g, label: 'crash', match: isDrumKit, drum: 'crash' },
  { re: /\bride cymbal\b/g, label: 'ride', match: isDrumKit, drum: 'ride' },
  { re: /\btoms\b|\btom[\s-]?toms?\b/g, label: 'toms', match: isDrumKit, drum: 'toms' },
  {
    re: /\blead vocals?\b|\blead vox\b|\blead singer\b/g,
    label: 'lead vocal',
    match: (t) =>
      t.role === 'vocal' && t.instrumentId !== 'backing-vocal' && !/backing|harmony|bv/i.test(t.name),
  },
  {
    re: /\bbacking vocals?\b|\bbvs\b|\bvocal harmon(?:y|ies)\b|\bharmony vocals?\b/g,
    label: 'backing vocals',
    match: anyOf(inst('backing-vocal'), (t) => t.role === 'vocal' && /backing|harmony|bv/i.test(t.name)),
  },
  {
    re: /\bvocals?\b|\bvox\b|\bsinger\b|\bsinging\b|\bvoice\b/g,
    label: 'vocal',
    match: (t) => t.role === 'vocal' || inst('lead-vocal', 'backing-vocal', 'choir')(t),
  },
  { re: /\bmelod(?:y|ies)\b|\btopline\b|\blead line\b|\btune\b/g, label: 'melody', generic: 'melody' },
  { re: /\bsynth[\s-]?bass\b/g, label: 'synth bass', match: inst('synth-bass') },
  {
    re: /\b(?:upright|double|acoustic) bass\b|\bcontrabass\b/g,
    label: 'upright bass',
    match: inst('upright-bass', 'contrabass'),
  },
  {
    re: /\bbass(?:[\s-]?lines?|[\s-]?guitar)?\b|\bbassline\b/g,
    label: 'bass',
    match: anyOf((t) => t.role === 'bass', inst('electric-bass', 'synth-bass', 'upright-bass', 'contrabass')),
  },
  {
    re: /\bdrums?\b|\bdrum ?kit\b|\bthe kit\b|\bthe beat\b|\bpercussion\b|\bgroove\b/g,
    label: 'drums',
    match: isDrumKit,
  },
  { re: /\brhythm guitars?\b/g, label: 'rhythm guitar', match: anyOf((t) => t.role === 'rhythm-guitar') },
  {
    re: /\blead guitars?\b|\bguitar solo\b/g,
    label: 'lead guitar',
    match: anyOf((t) => t.role === 'lead-guitar', inst('electric-guitar-lead')),
  },
  { re: /\bacoustic guitars?\b/g, label: 'acoustic guitar', match: inst('acoustic-guitar') },
  {
    re: /\bguitars?\b/g,
    label: 'guitar',
    match: anyOf(
      (t) => t.role === 'rhythm-guitar' || t.role === 'lead-guitar',
      (t) => /guitar/.test(t.instrumentId),
      nameHas(/guitar|gtr/i),
    ),
  },
  {
    re: /\belectric piano\b|\brhodes\b|\bwurli(?:tzer)?\b|\be-?piano\b/g,
    label: 'electric piano',
    match: inst('electric-piano'),
  },
  { re: /\bpianos?\b/g, label: 'piano', match: anyOf(inst('piano', 'electric-piano'), nameHas(/piano/i)) },
  {
    re: /\bkeys\b|\bkeyboards?\b/g,
    label: 'keys',
    match: anyOf((t) => t.role === 'keys', inst('piano', 'electric-piano', 'organ')),
  },
  { re: /\borgans?\b/g, label: 'organ', match: inst('organ') },
  {
    re: /\bstring section\b|\bstring ensemble\b|\bstrings\b/g,
    label: 'strings',
    match: anyOf(
      (t) => t.role === 'strings',
      inst('violin', 'viola', 'cello', 'contrabass', 'string-ensemble', 'pizzicato-strings'),
    ),
  },
  {
    re: /\bviolins?\b|\bfiddles?\b/g,
    label: 'violin',
    match: anyOf(inst('violin'), nameHas(/violin|fiddle/i)),
  },
  { re: /\bviolas?\b/g, label: 'viola', match: anyOf(inst('viola'), nameHas(/viola/i)) },
  { re: /\bcellos?\b|\bvioloncello\b/g, label: 'cello', match: anyOf(inst('cello'), nameHas(/cello/i)) },
  { re: /\bpizzicato\b/g, label: 'pizzicato strings', match: inst('pizzicato-strings') },
  {
    re: /\bsynth pads?\b|\bpads?\b/g,
    label: 'pad',
    match: anyOf(
      (t) => t.role === 'synth-pad',
      inst('synth-pad'),
      (t) => t.constraints.function === 'pad',
    ),
  },
  {
    re: /\barps?\b|\barpeggiat(?:o|e)r?s?\b|\barpeggios?\b/g,
    label: 'arp',
    match: anyOf((t) => t.role === 'synth-arp', inst('synth-arp')),
  },
  {
    re: /\blead synths?\b|\bsynth leads?\b/g,
    label: 'synth lead',
    match: anyOf((t) => t.role === 'synth-lead', inst('synth-lead')),
  },
  {
    re: /\bsequencer\b|\bsynth seq(?:uence)?\b/g,
    label: 'synth sequence',
    match: anyOf((t) => t.role === 'synth-seq', inst('synth-seq')),
  },
  {
    re: /\bsynths?\b|\bsynthesi[sz]ers?\b/g,
    label: 'synth',
    match: anyOf(
      (t) => t.role.startsWith('synth'),
      (t) => t.instrumentId.startsWith('synth'),
    ),
  },
  {
    re: /\bbrass\b|\bhorns?\b(?! section)/g,
    label: 'brass',
    match: inst('trumpet', 'trombone', 'french-horn', 'brass-section'),
  },
  { re: /\btrumpets?\b/g, label: 'trumpet', match: inst('trumpet') },
  { re: /\btrombones?\b/g, label: 'trombone', match: inst('trombone') },
  { re: /\bfrench horns?\b/g, label: 'french horn', match: inst('french-horn') },
  { re: /\bsax(?:ophone)?s?\b/g, label: 'saxophone', match: inst('saxophone') },
  { re: /\bflutes?\b/g, label: 'flute', match: inst('flute') },
  { re: /\bclarinets?\b/g, label: 'clarinet', match: inst('clarinet') },
  { re: /\bchoir\b/g, label: 'choir', match: inst('choir') },
  { re: /\bharps?\b/g, label: 'harp', match: inst('harp') },
  { re: /\bmarimbas?\b/g, label: 'marimba', match: inst('marimba') },
  { re: /\bglock(?:enspiel)?\b/g, label: 'glockenspiel', match: inst('glockenspiel') },
  { re: /\btimpani\b/g, label: 'timpani', match: inst('timpani') },
  {
    re: /\beverything\b|\ball (?:the )?(?:tracks|instruments|parts)\b|\bthe whole (?:band|song|arrangement|track)\b|\bthe (?:band|arrangement|full mix)\b|\boverall\b/g,
    label: 'everything',
    generic: 'all',
  },
  { re: /\bchords?\b|\bharmon(?:y|ies)\b|\bprogressions?\b/g, label: 'chords', generic: 'chords' },
  {
    re: /\bthis\b|\bthese\b|\bthat\b|\bthose\b|\bit\b|\bselection\b|\bselected\b|\bhere\b/g,
    label: 'selection',
    generic: 'selection',
  },
];

/** Track mentions in reading order (exact track names first, then instrument vocabulary). */
export function findTrackMentions(
  song: Pick<Song, 'tracks'>,
  text: string,
  opts: { melodyTrack?: Track } = {},
): TrackMention[] {
  const t = text.toLowerCase();
  const out: TrackMention[] = [];
  const names = song.tracks
    .map((tr) => ({ tr, name: tr.name.toLowerCase() }))
    .filter((x) => x.name.length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
  for (const { tr, name } of names) {
    const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const span = { index: m.index, end: m.index + m[0].length };
      if (overlaps(span, out)) continue;
      // Generic words that are also track names ("Bass") resolve through the vocabulary below
      // so that "bass drum" still means the kick.
      if (/^(bass|drums?|vocals?|melody|keys|strings|guitar|synth|pad|lead)$/.test(name)) continue;
      out.push({ tracks: [tr], word: m[0], label: tr.name, ...span });
    }
  }
  for (const v of VOCAB) {
    v.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = v.re.exec(t))) {
      const span = { index: m.index, end: m.index + m[0].length };
      if (overlaps(span, out)) continue;
      let tracks: Track[] = [];
      if (v.generic === 'melody') tracks = opts.melodyTrack ? [opts.melodyTrack] : [];
      else if (v.generic === 'all') tracks = song.tracks.filter((x) => x.kind === 'midi');
      else if (v.match) tracks = song.tracks.filter(v.match);
      out.push({
        tracks,
        word: m[0],
        label: v.label,
        generic: v.generic,
        drumPitches: v.drum ? DRUM_GROUPS[v.drum] : undefined,
        ...span,
      });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

export type BarSpec =
  | { kind: 'range'; startBar: number; endBar: number }
  | { kind: 'last'; bars: number }
  | { kind: 'first'; bars: number }
  | { kind: 'count'; bars: number };

/** Bar references: "bars 5-8", "bar 9", "the last 4 bars", "the first 2 bars", "these 4 bars". (1-based, inclusive). */
export function findBarSpec(text: string): BarSpec | null {
  let m = /\bbars?\s+(\d+)\s*(?:-|to|through|thru|until|and)\s*(\d+)\b/.exec(text);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    return { kind: 'range', startBar: Math.min(a, b), endBar: Math.max(a, b) };
  }
  m = /\blast\s+(\d+)\s+(?:bars|measures)\b/.exec(text);
  if (m) return { kind: 'last', bars: parseInt(m[1], 10) };
  if (/\b(?:the )?last (?:bar|measure)\b/.test(text)) return { kind: 'last', bars: 1 };
  m = /\bfirst\s+(\d+)\s+(?:bars|measures)\b/.exec(text);
  if (m) return { kind: 'first', bars: parseInt(m[1], 10) };
  if (/\b(?:the )?first (?:bar|measure)\b/.test(text)) return { kind: 'first', bars: 1 };
  m = /\b(?:bar|measure)\s+(\d+)\b/.exec(text);
  if (m) {
    const a = parseInt(m[1], 10);
    return { kind: 'range', startBar: a, endBar: a };
  }
  m = /\b(\d+)[\s-](?:bars|measures)\b/.exec(text);
  if (m) return { kind: 'count', bars: parseInt(m[1], 10) };
  return null;
}

// ---------------------------------------------------------------------------
// Transposition amounts
// ---------------------------------------------------------------------------

export interface TransposeSpec {
  /** Chromatic semitones (signed). */
  semitones?: number;
  /** Diatonic scale steps (signed). */
  steps?: number;
  label: string;
}

const INTERVAL_STEPS: Record<string, number> = {
  second: 1,
  third: 2,
  fourth: 3,
  fifth: 4,
  sixth: 5,
  seventh: 6,
  ninth: 8,
  tenth: 9,
};

/** Parse a transposition amount and direction. Returns null when there is no amount. */
export function parseTranspose(text: string): TransposeSpec | null {
  const down =
    /\b(down|lower|below|beneath|drop|minus)\b/.test(text) && !/\b(up|higher|above|raise)\b/.test(text);
  const sign = down ? -1 : 1;
  const dir = down ? 'down' : 'up';
  let m = /([+-]?\d+)\s*(?:semi-?tones?|half[\s-]?steps?|semis?)\b/.exec(text);
  if (m) {
    const n = parseInt(m[1], 10);
    const s = m[1].startsWith('-') || m[1].startsWith('+') ? n : sign * n;
    return { semitones: s, label: `${s > 0 ? '+' : ''}${s} semitone${Math.abs(s) === 1 ? '' : 's'}` };
  }
  if (/\b(?:a|one|1) (?:semi-?tone|half[\s-]?step)\b|\bhalf a step\b/.test(text))
    return { semitones: sign, label: `${dir} a semitone` };
  m = /(\d+)\s*(?:whole[\s-]?steps?|whole[\s-]?tones?)\b/.exec(text);
  if (m) return { semitones: sign * 2 * parseInt(m[1], 10), label: `${dir} ${m[1]} whole step(s)` };
  if (/\b(?:a|one|1) (?:whole[\s-]?step|whole[\s-]?tone|tone)\b/.test(text))
    return { semitones: sign * 2, label: `${dir} a whole step` };
  m = /(\d+)\s*octaves?\b/.exec(text);
  if (m) return { semitones: sign * 12 * parseInt(m[1], 10), label: `${dir} ${m[1]} octave(s)` };
  if (/\b(?:an|one|1|by an|by one) octave\b|\boctave (?:up|down|higher|lower)\b|\boctave\b/.test(text))
    return { semitones: sign * 12, label: `${dir} an octave` };
  m = /\b(?:a|an|one|by a|by an)\s+(second|third|fourth|fifth|sixth|seventh|ninth|tenth)\b/.exec(text);
  if (m) return { steps: sign * INTERVAL_STEPS[m[1]], label: `${dir} a ${m[1]} (diatonic)` };
  m = /(\d+)\s*(?:scale[\s-]?)?steps?\b/.exec(text);
  if (m) return { steps: sign * parseInt(m[1], 10), label: `${dir} ${m[1]} scale step(s)` };
  if (/\b(?:a|one|1) (?:scale )?step\b/.test(text)) return { steps: sign, label: `${dir} a scale step` };
  return null;
}

// ---------------------------------------------------------------------------
// Clauses
// ---------------------------------------------------------------------------

/** Split an instruction into clauses on conjunctions and punctuation (protecting a few fixed phrases). */
export function splitClauses(text: string): string[] {
  const protectedText = text
    .replace(/\bcall and response\b/g, 'call-and-response')
    .replace(/\brock and roll\b/g, 'rock-n-roll')
    .replace(/\bdrum and bass\b/g, 'drum-n-bass')
    .replace(/\bbars?\s+(\d+)\s*(?:and|to|through|thru|-)\s*(\d+)\b/g, 'bars $1-$2')
    .replace(/\bbetween (\d+) and (\d+)\b/g, '$1-$2');
  return protectedText
    .split(
      /\s*(?:,|;|\bbut\b|\band then\b|\bthen\b|\band also\b|\balso\b|\band\b|\bplus\b|\bwhile\b|\bas well as\b|\bwhereas\b)\s*/,
    )
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First match index of any regex (or -1). */
export function firstIndex(text: string, res: RegExp[]): number {
  let best = -1;
  for (const re of res) {
    const r = new RegExp(re.source, re.flags.replace('g', ''));
    const m = r.exec(text);
    if (m && (best < 0 || m.index < best)) best = m.index;
  }
  return best;
}

export function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "a, b and c" */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}
