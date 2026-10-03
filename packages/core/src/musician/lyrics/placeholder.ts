import type { SectionKind } from '../../ir/types';
import { deriveRng, type Rng } from '../../util/random';
import { countSyllables } from './syllables';
import type { PlaceholderLyricsOptions } from '../types';

/**
 * Offline placeholder lyrics (spec §33 "Placeholder Vocal"): singable, rhymed (AABB / ABAB),
 * mood-coloured lines that fit a syllable budget. Clearly placeholder quality — meant to give a
 * melody something to sing until real lyrics are written.
 */

type Pos = 'n' | 'a' | 'v' | 'd';

interface Bank {
  nouns: string[];
  plurals: string[];
  adjs: string[];
  verbs: string[];
}

const BANKS: Record<string, Bank> = {
  melancholy: {
    nouns: [
      'rain',
      'shadow',
      'memory',
      'silence',
      'window',
      'river',
      'winter',
      'echo',
      'letter',
      'candle',
      'distance',
      'harbor',
    ],
    plurals: [
      'shadows',
      'memories',
      'streetlights',
      'letters',
      'echoes',
      'raindrops',
      'footsteps',
      'photographs',
    ],
    adjs: ['empty', 'faded', 'broken', 'quiet', 'cold', 'gray', 'hollow', 'distant', 'fragile', 'lonely'],
    verbs: ['fade', 'wait', 'wonder', 'drift', 'remember', 'fall', 'break', 'cry'],
  },
  hopeful: {
    nouns: ['sun', 'morning', 'sky', 'summer', 'sunrise', 'horizon', 'garden', 'river', 'heartbeat'],
    plurals: ['colors', 'flowers', 'voices', 'dreams', 'stars', 'windows'],
    adjs: ['golden', 'bright', 'open', 'endless', 'brand new', 'warm', 'shining', 'gentle'],
    verbs: ['rise', 'shine', 'dance', 'sing', 'fly', 'believe', 'run', 'begin'],
  },
  angry: {
    nouns: ['fire', 'thunder', 'storm', 'engine', 'wall', 'siren', 'hammer', 'city'],
    plurals: ['sirens', 'ashes', 'bridges', 'chains', 'flames', 'engines'],
    adjs: ['wild', 'restless', 'burning', 'reckless', 'loud', 'fearless', 'heavy'],
    verbs: ['fight', 'burn', 'scream', 'break', 'rise', 'run', 'shout', 'shake'],
  },
  romantic: {
    nouns: ['heart', 'moonlight', 'touch', 'whisper', 'evening', 'dance', 'promise'],
    plurals: ['hearts', 'whispers', 'candles', 'roses', 'secrets'],
    adjs: ['tender', 'sweet', 'golden', 'gentle', 'warm', 'velvet'],
    verbs: ['hold', 'kiss', 'stay', 'love', 'dance', 'fall', 'stay'],
  },
  dreamy: {
    nouns: ['cloud', 'ocean', 'moon', 'tide', 'breeze', 'feather', 'starlight', 'silver sky'],
    plurals: ['clouds', 'waves', 'stars', 'fireflies', 'colors'],
    adjs: ['soft', 'slow', 'silver', 'floating', 'gentle', 'hazy', 'quiet'],
    verbs: ['float', 'drift', 'glow', 'breathe', 'dream', 'sway', 'wander'],
  },
  dark: {
    nouns: ['shadow', 'ghost', 'storm', 'smoke', 'mirror', 'midnight', 'hallway'],
    plurals: ['shadows', 'ghosts', 'wolves', 'whispers', 'embers'],
    adjs: ['cold', 'black', 'hollow', 'silent', 'broken', 'restless'],
    verbs: ['haunt', 'fall', 'hide', 'drown', 'burn', 'vanish'],
  },
  cathartic: {
    nouns: ['fire', 'sky', 'heart', 'thunder', 'ocean', 'skyline', 'anthem'],
    plurals: ['lights', 'stars', 'voices', 'flames', 'fireworks'],
    adjs: ['alive', 'unbroken', 'endless', 'electric', 'burning', 'fearless'],
    verbs: ['scream', 'rise', 'burn', 'fly', 'shine', 'run'],
  },
  nostalgic: {
    nouns: ['summer', 'photograph', 'highway', 'hometown', 'radio', 'backseat'],
    plurals: ['memories', 'headlights', 'songs', 'postcards', 'summers'],
    adjs: ['faded', 'younger', 'golden', 'old', 'distant', 'careless'],
    verbs: ['remember', 'drive', 'wander', 'return', 'sing', 'dream'],
  },
};

const MOOD_ALIASES: [RegExp, keyof typeof BANKS][] = [
  [/sad|melanchol|somber|sombre|lonely|heartbr|blue|wistful|bittersweet|grief|mourn/, 'melancholy'],
  [/happy|joy|uplift|cheer|bright|euphor|hope|optimis|sunny|playful/, 'hopeful'],
  [/angry|aggress|defian|rebel|intense|furious|rage|punk/, 'angry'],
  [/romant|love|tender|sensual|intimate/, 'romantic'],
  [/dream|calm|chill|ethereal|peace|relax|mellow|ambient/, 'dreamy'],
  [/dark|eerie|haunt|myster|ominous|gothic|sinister/, 'dark'],
  [/cathar|epic|triumph|anthem|empower|huge|soar/, 'cathartic'],
  [/nostalg|reflect|sentiment|memor/, 'nostalgic'],
];

interface RhymeWord {
  w: string;
  pos: Pos;
}

const RHYMES: RhymeWord[][] = [
  [
    { w: 'night', pos: 'n' },
    { w: 'light', pos: 'n' },
    { w: 'tonight', pos: 'd' },
    { w: 'fight', pos: 'v' },
    { w: 'bright', pos: 'a' },
    { w: 'alright', pos: 'a' },
    { w: 'sight', pos: 'n' },
    { w: 'white', pos: 'a' },
  ],
  [
    { w: 'rain', pos: 'n' },
    { w: 'pain', pos: 'n' },
    { w: 'again', pos: 'd' },
    { w: 'remain', pos: 'v' },
    { w: 'chain', pos: 'n' },
    { w: 'train', pos: 'n' },
  ],
  [
    { w: 'away', pos: 'd' },
    { w: 'stay', pos: 'v' },
    { w: 'day', pos: 'n' },
    { w: 'today', pos: 'd' },
    { w: 'gray', pos: 'a' },
    { w: 'pray', pos: 'v' },
  ],
  [
    { w: 'fire', pos: 'n' },
    { w: 'higher', pos: 'd' },
    { w: 'desire', pos: 'n' },
    { w: 'wire', pos: 'n' },
  ],
  [
    { w: 'down', pos: 'd' },
    { w: 'town', pos: 'n' },
    { w: 'crown', pos: 'n' },
    { w: 'drown', pos: 'v' },
  ],
  [
    { w: 'go', pos: 'v' },
    { w: 'know', pos: 'v' },
    { w: 'slow', pos: 'a' },
    { w: 'glow', pos: 'n' },
    { w: 'below', pos: 'd' },
    { w: 'snow', pos: 'n' },
    { w: 'grow', pos: 'v' },
  ],
  [
    { w: 'heart', pos: 'n' },
    { w: 'apart', pos: 'd' },
    { w: 'start', pos: 'v' },
    { w: 'dark', pos: 'n' },
  ],
  [
    { w: 'free', pos: 'a' },
    { w: 'see', pos: 'v' },
    { w: 'sea', pos: 'n' },
    { w: 'be', pos: 'v' },
    { w: 'me', pos: 'd' },
  ],
  [
    { w: 'song', pos: 'n' },
    { w: 'long', pos: 'a' },
    { w: 'strong', pos: 'a' },
    { w: 'wrong', pos: 'a' },
    { w: 'along', pos: 'd' },
    { w: 'belong', pos: 'v' },
  ],
  [
    { w: 'alive', pos: 'a' },
    { w: 'survive', pos: 'v' },
    { w: 'arrive', pos: 'v' },
    { w: 'drive', pos: 'v' },
  ],
  [
    { w: 'mind', pos: 'n' },
    { w: 'find', pos: 'v' },
    { w: 'behind', pos: 'd' },
    { w: 'kind', pos: 'a' },
    { w: 'blind', pos: 'a' },
  ],
  [
    { w: 'here', pos: 'd' },
    { w: 'near', pos: 'a' },
    { w: 'fear', pos: 'n' },
    { w: 'clear', pos: 'a' },
    { w: 'year', pos: 'n' },
    { w: 'disappear', pos: 'v' },
  ],
  [
    { w: 'inside', pos: 'd' },
    { w: 'ride', pos: 'n' },
    { w: 'hide', pos: 'v' },
    { w: 'tide', pos: 'n' },
    { w: 'wide', pos: 'a' },
    { w: 'collide', pos: 'v' },
  ],
  [
    { w: 'name', pos: 'n' },
    { w: 'flame', pos: 'n' },
    { w: 'same', pos: 'a' },
    { w: 'frame', pos: 'n' },
    { w: 'game', pos: 'n' },
  ],
  [
    { w: 'cold', pos: 'a' },
    { w: 'hold', pos: 'v' },
    { w: 'gold', pos: 'n' },
    { w: 'old', pos: 'a' },
    { w: 'bold', pos: 'a' },
  ],
  [
    { w: 'sleep', pos: 'n' },
    { w: 'deep', pos: 'a' },
    { w: 'keep', pos: 'v' },
    { w: 'weep', pos: 'v' },
  ],
  [
    { w: 'fall', pos: 'v' },
    { w: 'call', pos: 'v' },
    { w: 'wall', pos: 'n' },
    { w: 'small', pos: 'a' },
  ],
  [
    { w: 'alone', pos: 'a' },
    { w: 'stone', pos: 'n' },
    { w: 'home', pos: 'n' },
    { w: 'unknown', pos: 'a' },
  ],
  [
    { w: 'true', pos: 'a' },
    { w: 'blue', pos: 'a' },
    { w: 'through', pos: 'd' },
    { w: 'new', pos: 'a' },
  ],
  [
    { w: 'face', pos: 'n' },
    { w: 'place', pos: 'n' },
    { w: 'space', pos: 'n' },
    { w: 'grace', pos: 'n' },
  ],
  [
    { w: 'stars', pos: 'n' },
    { w: 'scars', pos: 'n' },
    { w: 'cars', pos: 'n' },
    { w: 'ours', pos: 'a' },
  ],
];

interface Template {
  t: string;
  kinds?: SectionKind[];
}

const TEMPLATES: Record<Pos, Template[]> = {
  n: [
    { t: 'I can see the {R}' },
    { t: 'Lost inside the {R}' },
    { t: 'Holding on to the {R}' },
    { t: 'Waiting for the {R}' },
    { t: 'Under a {A} {R}' },
    { t: '{Ps} in the {R}' },
    { t: 'Calling out into the {R}' },
    { t: 'Running through the {A} {R}' },
    { t: 'All I need is the {R}' },
    { t: 'We were dancing in the {R}' },
    { t: 'Every {N} becomes the {R}' },
    { t: 'Can you feel the {R}', kinds: ['pre-chorus', 'build', 'bridge'] },
    { t: 'Fading into the {R}', kinds: ['outro', 'bridge', 'breakdown'] },
    { t: 'Follow me into the {R}', kinds: ['chorus', 'final-chorus', 'post-chorus'] },
  ],
  a: [
    { t: 'Everything feels so {R}' },
    { t: "Tell me it's {R}" },
    { t: 'We were young and {R}' },
    { t: 'Nothing stays this {R}' },
    { t: 'Even when the {N} is {R}' },
    { t: 'Your {N} is {R}' },
    { t: 'Are we {A} or {R}', kinds: ['pre-chorus', 'bridge'] },
    { t: 'Maybe we were {R}', kinds: ['bridge', 'outro'] },
    { t: 'Hold me till I feel {R}', kinds: ['chorus', 'final-chorus'] },
  ],
  v: [
    { t: 'I just want to {R}' },
    { t: "Don't let it {R}" },
    { t: 'We were born to {R}' },
    { t: 'Watch the {Ps} {R}' },
    { t: 'Never gonna {R}' },
    { t: 'Learn to {R}' },
    { t: 'Teach me how to {R}' },
    { t: 'If I could {R}', kinds: ['bridge', 'pre-chorus'] },
    { t: 'Tonight we {R}', kinds: ['chorus', 'final-chorus'] },
  ],
  d: [
    { t: "Don't you go {R}" },
    { t: 'Let it all fade {R}' },
    { t: 'We could run {R}' },
    { t: "I'll be {R}" },
    { t: 'Take me {R}' },
    { t: 'Hold me {R}' },
    { t: 'Come back {R}' },
    { t: 'Carry me {R}', kinds: ['chorus', 'final-chorus'] },
  ],
};

const FILLERS: { text: string; syl: number }[] = [
  { text: 'Oh,', syl: 1 },
  { text: 'And', syl: 1 },
  { text: 'So', syl: 1 },
  { text: 'Now', syl: 1 },
  { text: 'Yeah,', syl: 1 },
  { text: 'Oh, oh,', syl: 2 },
  { text: 'And now', syl: 2 },
  { text: 'So now', syl: 2 },
  { text: 'Oh, and now', syl: 3 },
];

const STOP = new Set([
  'the',
  'and',
  'with',
  'about',
  'from',
  'that',
  'this',
  'into',
  'your',
  'their',
  'song',
  'songs',
  'some',
  'very',
  'over',
  'when',
  'what',
  'where',
  'love-song',
]);

function resolveBank(mood?: string): Bank {
  const m = (mood ?? '').toLowerCase();
  for (const [re, key] of MOOD_ALIASES) if (re.test(m)) return BANKS[key];
  return BANKS.hopeful;
}

function defaultSyllables(kind: SectionKind): number {
  switch (kind) {
    case 'verse':
      return 8;
    case 'pre-chorus':
    case 'build':
      return 7;
    case 'bridge':
      return 7;
    default:
      return 6;
  }
}

function schemeFor(kind: SectionKind, lines: number, rng: Rng): string[] {
  const chorus = kind === 'chorus' || kind === 'final-chorus' || kind === 'post-chorus';
  const abab = chorus || (kind === 'verse' && rng.chance(0.5));
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const block = Math.floor(i / 4) * 2;
    const pos = i % 4;
    const letter = abab ? (pos % 2 === 0 ? 0 : 1) : pos < 2 ? 0 : 1;
    out.push(String.fromCharCode(65 + block + letter));
  }
  return out;
}

function fill(
  template: string,
  bank: Bank,
  theme: string[],
  rng: Rng,
  rhyme: string,
  useTheme: boolean,
  avoid: Set<string>,
): { line: string; words: string[] } {
  let themeUsed = false;
  const words: string[] = [];
  // Prefer bank words this section has not sung yet, so placeholder verses don't repeat themselves.
  const pick = (list: string[]): string => {
    const fresh = list.filter((w) => !avoid.has(w) && !words.includes(w));
    const w = rng.pick(fresh.length ? fresh : list);
    words.push(w);
    return w;
  };
  const line = template
    .replace(/\{R\}/g, rhyme)
    .replace(/\{N\}/g, () => {
      if (useTheme && theme.length && !themeUsed) {
        themeUsed = true;
        return rng.pick(theme);
      }
      return pick(bank.nouns);
    })
    .replace(/\{Ps\}/g, () => pick(bank.plurals))
    .replace(/\{A\}/g, () => pick(bank.adjs))
    .replace(/\{V\}/g, () => pick(bank.verbs))
    // "a endless sky" → "an endless sky"
    .replace(/\b([Aa]) (?=[aeiouAEIOU])/g, '$1n ');
  return { line, words };
}

function capitalizeFirst(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Line shapes for phrases of three syllables or fewer, by the rhyme word's part of speech. */
const SHORT_SHAPES: Record<Pos, string[]> = {
  n: ['{R}', 'Oh, {R}', 'My {R}', 'The {R}', 'In the {R}', 'Oh, the {R}', 'Through the {R}'],
  v: ['{R}', 'Oh, {R}', 'We {R}', 'Just {R}', 'Let me {R}', 'Then we {R}'],
  a: ['{R}', 'So {R}', 'Oh, so {R}', 'Still so {R}', 'Not so {R}'],
  d: ['{R}', 'Oh, {R}', 'Left {R}', 'Way {R}', 'Not {R}', 'So far {R}'],
};

/** A line of exactly `target` syllables ending on a rhyme word, or null when none fits. */
function shortLine(
  pool: RhymeWord[],
  target: number,
  rng: { shuffle<T>(a: readonly T[]): T[] },
): { line: string; word: string } | null {
  for (const r of rng.shuffle(pool)) {
    for (const shape of rng.shuffle(SHORT_SHAPES[r.pos])) {
      const line = shape.replace('{R}', r.w);
      if (countSyllables(line) === target) return { line, word: r.w };
    }
  }
  return null;
}

export function generatePlaceholderLyrics(opts: PlaceholderLyricsOptions): string[] {
  const lines = Math.max(0, Math.floor(opts.lines));
  if (!lines) return [];
  const rng = deriveRng(opts.seed, 'placeholder-lyrics', opts.sectionKind, opts.mood ?? '', opts.theme ?? '');
  const bank = resolveBank(opts.mood);
  const themeWords = (opts.theme ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  // The head noun of a theme phrase is usually its last content word ("leaving home" → home).
  const theme = themeWords.length ? [themeWords[themeWords.length - 1]] : [];
  const kind = opts.sectionKind;
  const scheme = schemeFor(kind, lines, rng);
  const families = rng.shuffle(RHYMES);
  const letterFamily = new Map<string, RhymeWord[]>();
  const used = new Set<string>();
  const usedWords = new Set<string>();
  const templateUses = new Map<string, number>();
  const chorus = kind === 'chorus' || kind === 'final-chorus';
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const letter = scheme[i];
    const target = opts.syllablesPerLine?.length
      ? Math.max(1, opts.syllablesPerLine[i % opts.syllablesPerLine.length])
      : defaultSyllables(kind);
    // Hook: the chorus repeats its first line (same rhyme letter in ABAB) when it fits the phrase.
    if (
      chorus &&
      lines >= 4 &&
      i % 4 === 2 &&
      out[i - 2] &&
      (!opts.syllablesPerLine?.length || countSyllables(out[i - 2]) === target)
    ) {
      out.push(out[i - 2]);
      continue;
    }
    if (!letterFamily.has(letter)) letterFamily.set(letter, families[letterFamily.size % families.length]);
    const family = letterFamily.get(letter)!;
    const fresh = family.filter((r) => !used.has(r.w));
    const pool = fresh.length ? fresh : family;
    if (target <= 3) {
      // Short phrases get short lines built around the rhyme word ("Oh, fire", "In the night").
      const short = shortLine(pool, target, rng);
      if (short) {
        used.add(short.word);
        out.push(capitalizeFirst(short.line));
        continue;
      }
    }
    let best = '';
    let bestDiff = Infinity;
    let bestWord = pool[0].w;
    let bestTemplate = '';
    let bestWords: string[] = [];
    for (let attempt = 0; attempt < 48 && bestDiff > 0; attempt++) {
      const r = rng.pick(pool);
      const temps = TEMPLATES[r.pos].filter((t) => !t.kinds || t.kinds.includes(kind));
      const tpl = rng.pick(temps.length ? temps : TEMPLATES[r.pos]);
      const filled = fill(tpl.t, bank, theme, rng, r.w, i === 0 || attempt % 3 === 0, usedWords);
      let line = filled.line;
      let n = countSyllables(line);
      // Re-using a line shape within the section reads as a template — avoid it unless nothing else fits.
      let penalty = 0.8 * (templateUses.get(tpl.t) ?? 0);
      if (n < target) {
        const pad = FILLERS.filter((f) => f.syl === Math.min(3, target - n));
        if (pad.length) {
          const f = rng.pick(pad);
          line = `${f.text} ${line[0] === 'I' && /^I\b|^I'/.test(line) ? line : line[0].toLowerCase() + line.slice(1)}`;
          n = countSyllables(line);
          penalty += 0.3 * f.syl;
        }
      }
      const diff = Math.abs(n - target) + penalty;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = line;
        bestWord = r.w;
        bestTemplate = tpl.t;
        bestWords = filled.words;
      }
    }
    used.add(bestWord);
    templateUses.set(bestTemplate, (templateUses.get(bestTemplate) ?? 0) + 1);
    for (const w of bestWords) usedWords.add(w);
    out.push(capitalizeFirst(best.replace(/\s+/g, ' ').trim()));
  }
  return out;
}
