import { syllabify } from './syllables';

/**
 * Rule-based English grapheme-to-phoneme conversion to ARPAbet-like phonemes (no stress digits),
 * for singing synthesis (spec §34). A small exception dictionary covers frequent, irregular song
 * words; everything else goes through letter-to-sound rules with syllable-aware vowel length
 * (magic e, open/closed syllables, vowel teams, r-control) and a simple stress heuristic.
 */

const DICT_SRC: Record<string, string> = {
  the: 'DH AH',
  a: 'AH',
  an: 'AE N',
  and: 'AE N D',
  i: 'AY',
  you: 'Y UW',
  your: 'Y AO R',
  "you're": 'Y UH R',
  yours: 'Y AO R Z',
  me: 'M IY',
  my: 'M AY',
  mine: 'M AY N',
  we: 'W IY',
  us: 'AH S',
  our: 'AW ER',
  they: 'DH EY',
  them: 'DH EH M',
  their: 'DH EH R',
  there: 'DH EH R',
  here: 'HH IY R',
  where: 'W EH R',
  he: 'HH IY',
  she: 'SH IY',
  his: 'HH IH Z',
  her: 'HH ER',
  it: 'IH T',
  its: 'IH T S',
  "it's": 'IH T S',
  is: 'IH Z',
  was: 'W AA Z',
  are: 'AA R',
  were: 'W ER',
  be: 'B IY',
  been: 'B IH N',
  being: 'B IY IH NG',
  to: 'T UW',
  too: 'T UW',
  two: 'T UW',
  of: 'AH V',
  off: 'AO F',
  for: 'F AO R',
  from: 'F R AH M',
  in: 'IH N',
  on: 'AA N',
  at: 'AE T',
  by: 'B AY',
  with: 'W IH DH',
  without: 'W IH TH AW T',
  all: 'AO L',
  love: 'L AH V',
  loved: 'L AH V D',
  loving: 'L AH V IH NG',
  lover: 'L AH V ER',
  heart: 'HH AA R T',
  hearts: 'HH AA R T S',
  fire: 'F AY ER',
  night: 'N AY T',
  light: 'L AY T',
  tonight: 'T AH N AY T',
  time: 'T AY M',
  life: 'L AY F',
  world: 'W ER L D',
  know: 'N OW',
  known: 'N OW N',
  knew: 'N UW',
  go: 'G OW',
  gone: 'G AO N',
  so: 'S OW',
  no: 'N OW',
  oh: 'OW',
  ooh: 'UW',
  yeah: 'Y AE',
  whoa: 'W OW',
  one: 'W AH N',
  once: 'W AH N S',
  come: 'K AH M',
  some: 'S AH M',
  someone: 'S AH M W AH N',
  something: 'S AH M TH IH NG',
  nothing: 'N AH TH IH NG',
  everything: 'EH V R IY TH IH NG',
  anything: 'EH N IY TH IH NG',
  done: 'D AH N',
  none: 'N AH N',
  home: 'HH OW M',
  alone: 'AH L OW N',
  away: 'AH W EY',
  again: 'AH G EH N',
  against: 'AH G EH N S T',
  said: 'S EH D',
  says: 'S EH Z',
  does: 'D AH Z',
  do: 'D UW',
  "don't": 'D OW N T',
  "can't": 'K AE N T',
  "won't": 'W OW N T',
  "i'm": 'AY M',
  "i'll": 'AY L',
  "i've": 'AY V',
  "i'd": 'AY D',
  "we're": 'W IH R',
  "they're": 'DH EH R',
  can: 'K AE N',
  could: 'K UH D',
  would: 'W UH D',
  should: 'SH UH D',
  want: 'W AA N T',
  what: 'W AH T',
  when: 'W EH N',
  why: 'W AY',
  who: 'HH UW',
  whose: 'HH UW Z',
  how: 'HH AW',
  now: 'N AW',
  never: 'N EH V ER',
  ever: 'EH V ER',
  forever: 'F ER EH V ER',
  every: 'EH V R IY',
  heaven: 'HH EH V AH N',
  eye: 'AY',
  eyes: 'AY Z',
  sky: 'S K AY',
  cry: 'K R AY',
  die: 'D AY',
  true: 'T R UW',
  blue: 'B L UW',
  new: 'N UW',
  through: 'TH R UW',
  though: 'DH OW',
  thought: 'TH AO T',
  enough: 'IH N AH F',
  tough: 'T AH F',
  rough: 'R AH F',
  laugh: 'L AE F',
  give: 'G IH V',
  given: 'G IH V AH N',
  live: 'L IH V',
  living: 'L IH V IH NG',
  believe: 'B IH L IY V',
  people: 'P IY P AH L',
  only: 'OW N L IY',
  very: 'V EH R IY',
  maybe: 'M EY B IY',
  baby: 'B EY B IY',
  friend: 'F R EH N D',
  friends: 'F R EH N D Z',
  heard: 'HH ER D',
  word: 'W ER D',
  words: 'W ER D Z',
  work: 'W ER K',
  water: 'W AO T ER',
  breathe: 'B R IY DH',
  breath: 'B R EH TH',
  touch: 'T AH CH',
  young: 'Y AH NG',
  move: 'M UW V',
  prove: 'P R UW V',
  lose: 'L UW Z',
  above: 'AH B AH V',
  whole: 'HH OW L',
  hour: 'AW ER',
  sure: 'SH UH R',
  listen: 'L IH S AH N',
  dream: 'D R IY M',
  dreams: 'D R IY M Z',
  soul: 'S OW L',
  hold: 'HH OW L D',
  cold: 'K OW L D',
  broken: 'B R OW K AH N',
  burn: 'B ER N',
  walk: 'W AO K',
  talk: 'T AO K',
  real: 'R IY L',
  feel: 'F IY L',
  free: 'F R IY',
  see: 'S IY',
  sea: 'S IY',
  rain: 'R EY N',
  pain: 'P EY N',
  stay: 'S T EY',
  day: 'D EY',
  say: 'S EY',
  way: 'W EY',
  still: 'S T IH L',
  mind: 'M AY N D',
  find: 'F AY N D',
  kind: 'K AY N D',
  behind: 'B IH HH AY N D',
  gonna: 'G AA N AH',
  wanna: 'W AA N AH',
  gotta: 'G AA T AH',
  because: 'B IH K AH Z',
  cause: 'K AH Z',
  beautiful: 'B Y UW T AH F AH L',
  music: 'M Y UW Z IH K',
  song: 'S AO NG',
  sing: 'S IH NG',
  voice: 'V OY S',
  door: 'D AO R',
  floor: 'F L AO R',
  four: 'F AO R',
  more: 'M AO R',
  before: 'B IH F AO R',
  pour: 'P AO R',
  tour: 'T UH R',
  other: 'AH DH ER',
  mother: 'M AH DH ER',
  brother: 'B R AH DH ER',
  father: 'F AA DH ER',
  together: 'T AH G EH DH ER',
  fall: 'F AO L',
  call: 'K AO L',
  star: 'S T AA R',
  stars: 'S T AA R Z',
  remember: 'R IH M EH M B ER',
  tomorrow: 'T AH M AA R OW',
  yesterday: 'Y EH S T ER D EY',
  goodbye: 'G UH D B AY',
  hello: 'HH AH L OW',
  good: 'G UH D',
  blood: 'B L AH D',
  food: 'F UW D',
  book: 'B UH K',
  look: 'L UH K',
  foot: 'F UH T',
  girl: 'G ER L',
  boy: 'B OY',
  get: 'G EH T',
  got: 'G AA T',
  begin: 'B IH G IH N',
  forget: 'F ER G EH T',
  forgive: 'F ER G IH V',
  answer: 'AE N S ER',
  ocean: 'OW SH AH N',
  open: 'OW P AH N',
  truth: 'T R UW TH',
  youth: 'Y UW TH',
  color: 'K AH L ER',
  wonder: 'W AH N D ER',
  country: 'K AH N T R IY',
  trouble: 'T R AH B AH L',
  double: 'D AH B AH L',
  woman: 'W UH M AH N',
  women: 'W IH M AH N',
  child: 'CH AY L D',
  children: 'CH IH L D R AH N',
  idea: 'AY D IY AH',
  quiet: 'K W AY AH T',
  piano: 'P IY AE N OW',
  violin: 'V AY AH L IH N',
  guitar: 'G IH T AA R',
  choir: 'K W AY ER',
  chorus: 'K AO R AH S',
  echo: 'EH K OW',
  school: 'S K UW L',
  ache: 'EY K',
  bear: 'B EH R',
  wear: 'W EH R',
  swear: 'S W EH R',
  tear: 'T IH R',
  tears: 'T IH R Z',
  year: 'Y IH R',
  years: 'Y IH R Z',
  ear: 'IH R',
  dear: 'D IH R',
  clear: 'K L IH R',
  near: 'N IH R',
  fear: 'F IH R',
  desire: 'D IH Z AY ER',
  higher: 'HH AY ER',
  power: 'P AW ER',
  flower: 'F L AW ER',
  tower: 'T AW ER',
  lower: 'L OW ER',
  shadow: 'SH AE D OW',
  window: 'W IH N D OW',
  follow: 'F AA L OW',
  city: 'S IH T IY',
  pretty: 'P R IH T IY',
  busy: 'B IH Z IY',
  any: 'EH N IY',
  many: 'M EH N IY',
  body: 'B AA D IY',
  nobody: 'N OW B AA D IY',
  everybody: 'EH V R IY B AA D IY',
  mountain: 'M AW N T AH N',
  around: 'AH R AW N D',
  ground: 'G R AW N D',
  sound: 'S AW N D',
  down: 'D AW N',
  town: 'T AW N',
  crown: 'K R AW N',
  drown: 'D R AW N',
  own: 'OW N',
  grown: 'G R OW N',
  show: 'SH OW',
  slow: 'S L OW',
  grow: 'G R OW',
  glow: 'G L OW',
  below: 'B IH L OW',
  snow: 'S N OW',
  low: 'L OW',
  blow: 'B L OW',
  throw: 'TH R OW',
  allow: 'AH L AW',
  wow: 'W AW',
  shine: 'SH AY N',
  smile: 'S M AY L',
  while: 'W AY L',
  inside: 'IH N S AY D',
  outside: 'AW T S AY D',
  side: 'S AY D',
  ride: 'R AY D',
  hide: 'HH AY D',
  wide: 'W AY D',
  paradise: 'P EH R AH D AY S',
  great: 'G R EY T',
  break: 'B R EY K',
  steak: 'S T EY K',
  head: 'HH EH D',
  dead: 'D EH D',
  bread: 'B R EH D',
  ready: 'R EH D IY',
  heavy: 'HH EH V IY',
  learn: 'L ER N',
  early: 'ER L IY',
  earth: 'ER TH',
  search: 'S ER CH',
  wild: 'W AY L D',
  wind: 'W IH N D',
  weight: 'W EY T',
  eight: 'EY T',
  height: 'HH AY T',
  either: 'IY DH ER',
  neither: 'N IY DH ER',
  whether: 'W EH DH ER',
  weather: 'W EH DH ER',
  rather: 'R AE DH ER',
  gather: 'G AE DH ER',
  tongue: 'T AH NG',
  danger: 'D EY N JH ER',
  stranger: 'S T R EY N JH ER',
  angel: 'EY N JH AH L',
  angels: 'EY N JH AH L Z',
  finger: 'F IH NG G ER',
  anger: 'AE NG G ER',
  longer: 'L AO NG G ER',
  stronger: 'S T R AO NG G ER',
  hungry: 'HH AH NG G R IY',
  island: 'AY L AH N D',
  honest: 'AA N AH S T',
  listen_: 'L IH S AH N',
  often: 'AO F AH N',
  christmas: 'K R IH S M AH S',
  rhythm: 'R IH DH AH M',
  business: 'B IH Z N AH S',
  minute: 'M IH N AH T',
  machine: 'M AH SH IY N',
  police: 'P AH L IY S',
  dove: 'D AH V',
  glove: 'G L AH V',
  shove: 'SH AH V',
  worry: 'W ER IY',
  sorry: 'S AA R IY',
  carry: 'K EH R IY',
  marry: 'M EH R IY',
  story: 'S T AO R IY',
  glory: 'G L AO R IY',
  hurry: 'HH ER IY',
  journey: 'JH ER N IY',
  money: 'M AH N IY',
  honey: 'HH AH N IY',
  worth: 'W ER TH',
  world_: 'W ER L D',
  bright: 'B R AY T',
  fight: 'F AY T',
  right: 'R AY T',
  sight: 'S AY T',
  flight: 'F L AY T',
  alright: 'AO L R AY T',
  tight: 'T AY T',
  might: 'M AY T',
  fly: 'F L AY',
  try: 'T R AY',
  dry: 'D R AY',
  shy: 'SH AY',
  animal: 'AE N AH M AH L',
  animals: 'AE N AH M AH L Z',
  amazing: 'AH M EY Z IH NG',
  alive: 'AH L AY V',
  high: 'HH AY',
  sigh: 'S AY',
  bye: 'B AY',
  lie: 'L AY',
  put: 'P UH T',
  become: 'B IH K AH M',
  self: 'S EH L F',
  selves: 'S EH L V Z',
  empty: 'EH M P T IY',
  happy: 'HH AE P IY',
  lonely: 'L OW N L IY',
  beauty: 'B Y UW T IY',
  angry: 'AE NG G R IY',
};
const DICT: Record<string, string[]> = Object.fromEntries(
  Object.entries(DICT_SRC).map(([k, v]) => [k.replace(/_$/, ''), v.split(' ')]),
);

const VOWELS = 'aeiou';
const isV = (c: string | undefined) => !!c && VOWELS.includes(c);
const isCons = (c: string | undefined) => !!c && /[a-z]/.test(c) && !VOWELS.includes(c);
const VOICELESS_END = /(p|t|k|f|th|ch|sh|s|x|ck|gh)$/;
const AW_FINAL = new Set([
  'now',
  'how',
  'cow',
  'wow',
  'vow',
  'allow',
  'plow',
  'brow',
  'chow',
  'somehow',
  'anyhow',
  'endow',
]);
const AW_OWN = new Set([
  'down',
  'town',
  'crown',
  'brown',
  'drown',
  'gown',
  'frown',
  'clown',
  'downtown',
  'renown',
]);
const LABIAL_VELAR = new Set(['p', 'b', 'f', 'v', 'm', 'k', 'c', 'g', 'h']);
const PREFIXES = ['a', 'be', 'de', 're', 'un', 'in', 'ex', 'to', 'for', 'mis', 'dis', 'pre'];

/** Index of the stressed syllable (heuristic). */
function stressIndex(sylls: string[], w: string): number {
  const n = sylls.length;
  if (n <= 1) return 0;
  const tionIdx = sylls.findIndex((s) => /^(tion|sion|cian|cial|tial|cious|tious|ic|ical|ity)s?$/.test(s));
  if (tionIdx > 0) return tionIdx - 1;
  if (/(ic|ics)$/.test(w) && n >= 2) return n - 2;
  const first = sylls[0];
  if (PREFIXES.includes(first) && n >= 2) return 1;
  return 0;
}

function consumeVowelTeam(
  w: string,
  i: number,
  sylStart: number,
  sylEnd: number,
  stressed: boolean,
  isLastSyl: boolean,
  sylCount: number,
): { ph: string[]; len: number } | null {
  const rest = w.slice(i);
  const prev = w[i - 1];
  const after = (n: number) => w.slice(i + n);
  const wordLen = w.length;
  if (rest.startsWith('eau')) return { ph: ['OW'], len: 3 };
  if (rest.startsWith('igh')) return { ph: ['AY'], len: 3 };
  if (rest.startsWith('ough')) {
    if (after(4).startsWith('t')) return { ph: ['AO'], len: 4 };
    return { ph: ['OW'], len: 4 };
  }
  if (rest.startsWith('augh')) return { ph: ['AO'], len: 4 };
  if (rest.startsWith('eigh')) return { ph: ['EY'], len: 4 };
  const two = rest.slice(0, 2);
  switch (two) {
    case 'ai':
    case 'ay':
      return { ph: ['EY'], len: 2 };
    case 'au':
    case 'aw':
      return { ph: ['AO'], len: 2 };
    case 'ea': {
      if (rest.startsWith('ear')) {
        const c3 = w[i + 3];
        if (c3 && isCons(c3) && c3 !== 's') return { ph: ['ER'], len: 3 };
        return { ph: ['IH', 'R'], len: 3 };
      }
      if (/^ea(d|th(?!e)|v(?!e)|lth|nt|pon|sure|ther)/.test(rest)) return { ph: ['EH'], len: 2 };
      if (i + 2 === wordLen && sylCount > 1) return { ph: ['IY', 'AH'], len: 2 };
      return { ph: ['IY'], len: 2 };
    }
    case 'ee':
      if (rest.startsWith('eer')) return { ph: ['IH', 'R'], len: 3 };
      return { ph: ['IY'], len: 2 };
    case 'ei':
      return { ph: prev === 'c' ? ['IY'] : ['EY'], len: 2 };
    case 'ey':
      return { ph: i + 2 === wordLen && sylCount > 1 ? ['IY'] : ['EY'], len: 2 };
    case 'eu':
    case 'ew':
      return { ph: !prev || LABIAL_VELAR.has(prev) ? ['Y', 'UW'] : ['UW'], len: 2 };
    case 'ie': {
      const tail = after(2);
      const mono = sylCount === 1;
      if (tail === '' || ((tail === 's' || tail === 'd') && mono))
        return { ph: mono ? ['AY'] : ['IY'], len: 2 };
      return { ph: ['IY'], len: 2 };
    }
    case 'oa':
      return { ph: ['OW'], len: 2 };
    case 'oe':
      return { ph: ['OW'], len: 2 };
    case 'oi':
    case 'oy':
      return { ph: ['OY'], len: 2 };
    case 'oo': {
      if (rest.startsWith('oor')) return { ph: ['AO', 'R'], len: 3 };
      if (/^oo(k|d|t)/.test(rest) && !/^oo(d)$/.test(rest.slice(0, 3) + (w[i + 3] ?? '')))
        return { ph: ['UH'], len: 2 };
      return { ph: ['UW'], len: 2 };
    }
    case 'ou': {
      if (rest.startsWith('our'))
        return {
          ph: isLastSyl && (i + 3 === wordLen || after(3) === 's') ? ['AW', 'ER'] : ['AO', 'R'],
          len: 3,
        };
      if (rest.startsWith('oul')) return { ph: /^oul(d)/.test(rest) ? ['UH'] : ['OW'], len: 2 };
      if (/^ou(ch|ble|ple|ntry|ng|sin)/.test(rest)) return { ph: ['AH'], len: 2 };
      if (/^ous$/.test(rest) || (/^ous/.test(rest) && !stressed)) return { ph: ['AH'], len: 2 };
      return { ph: ['AW'], len: 2 };
    }
    case 'ow': {
      const tail = after(2);
      if (tail === '' || tail === 's')
        return { ph: AW_FINAL.has(w.replace(/s$/, '')) ? ['AW'] : ['OW'], len: 2 };
      if (/^n(s)?$/.test(tail)) return { ph: AW_OWN.has(w.replace(/s$/, '')) ? ['AW'] : ['OW'], len: 2 };
      if (/^(er|l|d|el|ard)/.test(tail)) return { ph: ['AW'], len: 2 };
      return { ph: ['OW'], len: 2 };
    }
    case 'ue':
    case 'ui':
      return { ph: prev && LABIAL_VELAR.has(prev) && prev !== 'g' ? ['Y', 'UW'] : ['UW'], len: 2 };
  }
  void sylStart;
  void sylEnd;
  return null;
}

/** Magic e: vowel + one consonant (unit) + silent e at the end of the word (or before s/d). */
function hasMagicE(w: string, i: number): boolean {
  let j = i + 1;
  if (/^ange/.test(w.slice(i)) || /^aste/.test(w.slice(i))) return true;
  if (w.startsWith('ch', j) || w.startsWith('sh', j)) {
    if (w.slice(j + 2) === 'es' || w.slice(j + 2) === 'ed') return false;
  }
  if (w.startsWith('th', j) || w.startsWith('ch', j) || w.startsWith('sh', j) || w.startsWith('ph', j))
    j += 2;
  else if (isCons(w[j]) && w[j] !== 'w' && w[j] !== 'x' && w[j] !== 'y') j += 1;
  else return false;
  if (w[j] !== 'e') return false;
  const tail = w.slice(j + 1);
  return (
    tail === '' ||
    tail === 's' ||
    tail === 'd' ||
    tail === 'ly' ||
    tail === 'ful' ||
    tail === 'less' ||
    tail === 'ness' ||
    tail === 'ment'
  );
}

function singleVowel(
  w: string,
  i: number,
  sylEnd: number,
  stressed: boolean,
  sylCount: number,
): { ph: string[]; len: number } {
  const c = w[i];
  const next = w[i + 1];
  const prev = w[i - 1];
  const beforeGlide =
    /^.(sion|tion|cial|tial|cious|tious|cian)/.test(w.slice(i)) || /^.s(sion)/.test(w.slice(i));
  if (beforeGlide && (c === 'e' || c === 'i')) return { ph: [c === 'e' ? 'EH' : 'IH'], len: 1 };
  // Trisyllabic laxing: stressed open first syllable of a 3+ syllable word is short (me-lo-dy, fa-mi-ly).
  const laxed =
    sylCount >= 3 &&
    i + 1 === sylEnd &&
    stressed &&
    (c === 'e' || c === 'a' || c === 'i') &&
    !hasMagicE(w, i) &&
    !isV(next) &&
    next !== 'y';
  if (laxed) return { ph: [c === 'e' ? 'EH' : c === 'a' ? 'AE' : 'IH'], len: 1 };
  const open = i + 1 === sylEnd && i + 1 < w.length;
  const finalLetter = i + 1 === w.length;
  const magic = hasMagicE(w, i);
  const rCtrl =
    next === 'r' && (!isV(w[i + 2]) || (w[i + 2] === 'e' && i + 3 === w.length)) && w[i + 2] !== 'r';
  switch (c) {
    case 'a': {
      if (rCtrl) {
        if (w[i + 2] === 'e' && i + 3 === w.length) return { ph: ['EH', 'R'], len: 3 };
        if (prev === 'w' || (prev === 'u' && w[i - 2] === 'q')) return { ph: ['AO', 'R'], len: 2 };
        return { ph: ['AA', 'R'], len: 2 };
      }
      if (next === 'r' && isV(w[i + 2])) return { ph: stressed ? ['EH'] : ['AH'], len: 1 };
      if (/^al(l|k|t|so|ways|most|ready)/.test(w.slice(i)))
        return { ph: ['AO'], len: /^alk/.test(w.slice(i)) ? 2 : 1 };
      if (prev === 'w' && isCons(next) && next !== 'y' && next !== 'g' && next !== 'v')
        return { ph: ['AA'], len: 1 };
      if (magic) return { ph: ['EY'], len: 1 };
      if (finalLetter) return { ph: sylCount > 1 ? ['AH'] : ['EY'], len: 1 };
      if (open) return { ph: stressed ? ['EY'] : ['AH'], len: 1 };
      return { ph: stressed ? ['AE'] : ['AH'], len: 1 };
    }
    case 'e': {
      if (rCtrl) {
        if (w[i + 2] === 'e' && i + 3 === w.length) return { ph: ['IH', 'R'], len: 3 };
        return { ph: ['ER'], len: 2 };
      }
      if (next === 'r' && w[i + 2] === 'r') return { ph: ['EH'], len: 1 };
      if (magic) return { ph: ['IY'], len: 1 };
      if (finalLetter) return { ph: sylCount === 1 ? ['IY'] : [], len: 1 };
      if (open) return { ph: stressed ? ['IY'] : ['IH'], len: 1 };
      return { ph: stressed ? ['EH'] : ['AH'], len: 1 };
    }
    case 'i': {
      if (rCtrl) {
        if (w[i + 2] === 'e' && i + 3 === w.length) return { ph: ['AY', 'ER'], len: 3 };
        return { ph: ['ER'], len: 2 };
      }
      if (/^i(nd|ld)$/.test(w.slice(i)) || /^i(nd|ld)(s|ed|er|ing|ly)?$/.test(w.slice(i)))
        return { ph: ['AY'], len: 1 };
      if (magic) return { ph: ['AY'], len: 1 };
      if (finalLetter) return { ph: sylCount === 1 ? ['AY'] : ['IY'], len: 1 };
      if (open) return { ph: stressed ? ['AY'] : ['IH'], len: 1 };
      return { ph: ['IH'], len: 1 };
    }
    case 'o': {
      if (rCtrl) {
        if (prev === 'w' && isCons(w[i + 2])) return { ph: ['ER'], len: 2 };
        if (w[i + 2] === 'e' && i + 3 === w.length) return { ph: ['AO', 'R'], len: 3 };
        return { ph: stressed || sylCount === 1 ? ['AO', 'R'] : ['ER'], len: 2 };
      }
      if (/^o(ld|lt|ll)/.test(w.slice(i)) && !/^oll(y|ar)/.test(w.slice(i))) return { ph: ['OW'], len: 1 };
      if (/^ost/.test(w.slice(i)))
        return {
          ph:
            /^(m|p|h|gh)$/.test(w.slice(Math.max(0, i - 2), i).replace(/^.(?=.)/, '')) ||
            /(m|p|h)$/.test(w.slice(0, i))
              ? ['OW']
              : ['AO'],
          len: 1,
        };
      if (/^ong/.test(w.slice(i))) return { ph: ['AO'], len: 1 };
      if (/^ove$/.test(w.slice(i))) return { ph: ['AH'], len: 1 };
      if (/^oth/.test(w.slice(i)) && w[i + 3] === 'e' && w[i + 4] === 'r') return { ph: ['AH'], len: 1 };
      if (magic) return { ph: ['OW'], len: 1 };
      if (finalLetter) return { ph: ['OW'], len: 1 };
      if (open) return { ph: stressed ? ['OW'] : ['AH'], len: 1 };
      return { ph: stressed ? ['AA'] : ['AH'], len: 1 };
    }
    case 'u': {
      if (rCtrl) {
        if (w[i + 2] === 'e' && i + 3 === w.length)
          return { ph: prev && LABIAL_VELAR.has(prev) ? ['Y', 'UH', 'R'] : ['UH', 'R'], len: 3 };
        return { ph: ['ER'], len: 2 };
      }
      if (/^u(ll|sh)/.test(w.slice(i)) && /[pbf]/.test(prev ?? '')) return { ph: ['UH'], len: 1 };
      const yu = !prev || (LABIAL_VELAR.has(prev) && prev !== 'g') ? ['Y', 'UW'] : ['UW'];
      if (magic) return { ph: yu, len: 1 };
      if (finalLetter) return { ph: yu, len: 1 };
      if (open) return { ph: stressed ? yu : ['AH'], len: 1 };
      return { ph: ['AH'], len: 1 };
    }
    case 'y': {
      if (finalLetter) return { ph: sylCount === 1 ? ['AY'] : ['IY'], len: 1 };
      if (magic) return { ph: ['AY'], len: 1 };
      if (open) return { ph: stressed ? ['AY'] : ['IH'], len: 1 };
      return { ph: ['IH'], len: 1 };
    }
  }
  return { ph: [], len: 1 };
}

/** Letter-to-sound for a lowercase word (letters only). */
function ruleWord(w: string): string[] {
  const sylls = syllabify(w).map((s) => s.toLowerCase());
  const sylCount = Math.max(1, sylls.length);
  const stress = stressIndex(sylls, w);
  // Syllable boundaries (letter index → syllable index / end).
  const sylOf: number[] = [];
  const sylEndAt: number[] = [];
  let pos = 0;
  sylls.forEach((s, si) => {
    for (let k = 0; k < s.length; k++) {
      sylOf[pos + k] = si;
      sylEndAt[pos + k] = pos + s.length;
    }
    pos += s.length;
  });
  const out: string[] = [];
  const silent = new Set<number>();
  let i = 0;
  const push = (...p: string[]) => {
    for (const x of p)
      if (x && (out[out.length - 1] !== x || !/^[BCDFGHJKLMNPRSTVWZ]/.test(x) || x === 'R')) out.push(x);
  };
  while (i < w.length) {
    if (silent.has(i)) {
      i++;
      continue;
    }
    const c = w[i];
    const rest = w.slice(i);
    if (/^heart/.test(rest)) {
      push('HH', 'AA', 'R', 'T');
      i += 5;
      continue;
    }
    if (/^ign(s|ed|ing)?$/.test(rest) && i > 0) {
      push('AY', 'N');
      i += 3;
      continue;
    }
    if (/^stion(s)?$/.test(rest)) {
      push('S', 'CH', 'AH', 'N');
      if (rest.endsWith('s')) push('Z');
      break;
    }
    const dblLe = /^([^aeiouy])\1le(s|d)?$/.exec(rest);
    if (dblLe && i > 0) {
      ruleConsonant(w, i + 1, push);
      push('AH', 'L');
      if (rest.endsWith('s')) push('Z');
      if (rest.endsWith('d')) push('D');
      break;
    }
    if (/^se$/.test(rest) && i > 0) {
      const before = w.slice(0, i);
      push(/(ou|oo|ea|[^aeiou]|^[^aeiou]*a)$/.test(before) && !/(ee|oi|oo)$/.test(before) ? 'S' : 'Z');
      break;
    }
    const si = sylOf[i] ?? sylCount - 1;
    const stressed = si === stress;
    const sylEnd = sylEndAt[i] ?? w.length;
    const isLastSyl = si === sylCount - 1;
    // Suffix-like endings.
    if (/^tion(s)?$/.test(rest) || /^sion(s)?$/.test(rest)) {
      push(c === 's' && isV(w[i - 1]) ? 'ZH' : 'SH', 'AH', 'N');
      if (rest.endsWith('s')) push('Z');
      break;
    }
    if (/^(cious|tious)$/.test(rest)) {
      push('SH', 'AH', 'S');
      break;
    }
    if (/^(cial|tial)$/.test(rest)) {
      push('SH', 'AH', 'L');
      break;
    }
    if (/^ture(s|d)?$/.test(rest)) {
      push('CH', 'ER');
      if (rest.endsWith('s')) push('Z');
      if (rest.endsWith('d')) push('D');
      break;
    }
    if (/^sure$/.test(rest) && i > 0) {
      push('ZH', 'ER');
      break;
    }
    if (/^[^aeiouy]le(s|d)?$/.test(rest) && i > 0) {
      ruleConsonant(w, i, push);
      push('AH', 'L');
      if (rest.endsWith('s')) push('Z');
      if (rest.endsWith('d')) push('D');
      break;
    }
    if (isV(c) || (c === 'y' && i > 0 && !isV(w[i + 1]))) {
      const team = consumeVowelTeam(w, i, 0, sylEnd, stressed, isLastSyl, sylCount);
      if (team) {
        push(...team.ph);
        i += team.len;
        continue;
      }
      // Silent final e (and e in -es / -ed endings after magic vowels).
      if (
        c === 'e' &&
        i > 0 &&
        (i + 1 === w.length || (i + 2 === w.length && (w[i + 1] === 's' || w[i + 1] === 'd'))) &&
        sylCount >= 1 &&
        out.some((p) => /^[AEIOU]/.test(p))
      ) {
        if (i + 1 === w.length) {
          i++;
          continue;
        }
        const tail = w[i + 1];
        const before = w.slice(0, i);
        const last = out[out.length - 1] ?? '';
        if (tail === 's') {
          if (/^(S|Z|SH|ZH|CH|JH)$/.test(last) || /(s|z|x|ch|sh)$/.test(before)) push('IH', 'Z');
          else push(/^(P|T|K|F|TH)$/.test(last) ? 'S' : 'Z');
        } else {
          if (/^(T|D)$/.test(last)) push('IH', 'D');
          else push(/^(P|K|F|S|SH|CH|TH|X)$/.test(last) || VOICELESS_END.test(before) ? 'T' : 'D');
        }
        i += 2;
        continue;
      }
      const v = singleVowel(w, i, sylEnd, stressed, sylCount);
      if (hasMagicE(w, i) && v.len === 1 && /[aeiouy]/.test(c)) {
        // The e of a magic-e pattern is silent.
        let j = i + 1;
        while (j < w.length && w[j] !== 'e') j++;
        if (j < w.length && j <= i + 3) silent.add(j);
      }
      push(...v.ph);
      i += v.len;
      continue;
    }
    i += ruleConsonant(w, i, push);
  }
  return out.filter(Boolean);
}

/** Emit phonemes for the consonant at i; returns letters consumed. */
function ruleConsonant(w: string, i: number, push: (...p: string[]) => void): number {
  const c = w[i];
  const rest = w.slice(i);
  const prev = w[i - 1];
  const next = w[i + 1];
  if (rest.startsWith('tch')) return (push('CH'), 3);
  if (rest.startsWith('sch')) return (push('S', 'K'), 3);
  if (
    rest.startsWith('chr') ||
    (rest.startsWith('ch') && /^(chorus|chaos|character|christ|chord|chem)/.test(w))
  )
    return (push('K'), 2);
  if (rest.startsWith('ch')) return (push('CH'), 2);
  if (rest.startsWith('sh')) return (push('SH'), 2);
  if (rest.startsWith('th')) {
    const dh =
      /^th(e|is|at|ese|ose|ey|em|en|an|ere|eir|ough|us)$/.test(w) ||
      /^ther/.test(w.slice(i)) ||
      (rest === 'the' && i > 0) ||
      /^the[sd]$/.test(rest);
    return (push(dh ? 'DH' : 'TH'), 2);
  }
  if (rest.startsWith('ph')) return (push('F'), 2);
  if (rest.startsWith('wh')) return (push('W'), 2);
  if (rest.startsWith('gh')) {
    if (i === 0) push('G');
    return 2;
  }
  if (rest.startsWith('ck')) return (push('K'), 2);
  if (rest.startsWith('ng')) return (push('NG'), 2);
  if (rest.startsWith('nk')) return (push('NG', 'K'), 2);
  if (rest.startsWith('qu')) return (push('K', 'W'), 2);
  if (i === 0 && rest.startsWith('kn')) return (push('N'), 2);
  if (i === 0 && rest.startsWith('wr')) return (push('R'), 2);
  if (i === 0 && rest.startsWith('gn')) return (push('N'), 2);
  if (i === 0 && rest.startsWith('ps')) return (push('S'), 2);
  if (rest === 'mb' || rest === 'mbs') return (push('M'), rest.length);
  if (rest === 'gn' || rest === 'gns') return (push('N'), rest.length);
  if (/^(t|s|c|x)i[aou]/.test(rest) && i > 0) {
    push(c === 's' && isV(prev) ? 'ZH' : c === 'x' ? 'K' : 'SH');
    if (c === 'x') push('SH');
    return 2;
  }
  if (rest.startsWith('gu') && isV(w[i + 2])) return (push('G'), 2);
  // Doubled consonants sound once.
  if (next === c && c !== 'c') {
    ruleConsonant(w.slice(0, i) + w.slice(i + 1), i, push);
    return 2;
  }
  switch (c) {
    case 'b':
      push('B');
      return 1;
    case 'c':
      if (next === 'c') {
        push('K');
        if (/[eiy]/.test(w[i + 2] ?? '')) push('S');
        return 2;
      }
      push(/[eiy]/.test(next ?? '') ? 'S' : 'K');
      return 1;
    case 'd':
      push('D');
      return 1;
    case 'f':
      push('F');
      return 1;
    case 'g':
      push(
        /[eiy]/.test(next ?? '') &&
          !/^(get|give|girl|gift|begin|forget|tiger|target|together|geese|gear)/.test(
            w.slice(Math.max(0, i - 3)),
          )
          ? 'JH'
          : 'G',
      );
      return 1;
    case 'h':
      if (isV(next) || next === 'y') push('HH');
      return 1;
    case 'j':
      push('JH');
      return 1;
    case 'k':
      push('K');
      return 1;
    case 'l':
      push('L');
      return 1;
    case 'm':
      push('M');
      return 1;
    case 'n':
      push('N');
      return 1;
    case 'p':
      push('P');
      return 1;
    case 'r':
      push('R');
      return 1;
    case 's': {
      const end = i + 1 === w.length;
      const between = isV(prev) && (isV(next) || next === 'y');
      if (end && i > 0) push(/[pkft]$/.test(w.slice(0, i)) || w.slice(0, i).endsWith('th') ? 'S' : 'Z');
      else push(between ? 'Z' : 'S');
      return 1;
    }
    case 't':
      push('T');
      return 1;
    case 'v':
      push('V');
      return 1;
    case 'w':
      push('W');
      return 1;
    case 'x':
      if (i === 0) push('Z');
      else push('K', 'S');
      return 1;
    case 'y':
      push('Y');
      return 1;
    case 'z':
      push('Z');
      return 1;
  }
  return 1;
}

function wordPhonemes(raw: string): string[] {
  const w = raw
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z']/g, '')
    .replace(/^'+|'+$/g, '');
  if (!w) return [];
  if (DICT[w]) return [...DICT[w]];
  // Contractions.
  const m = /^(.+?)('s|'re|'ve|'ll|'d|'m|n't)$/.exec(w);
  if (m) {
    const base = wordPhonemes(m[1]);
    switch (m[2]) {
      case "'s":
        return [...base, /(P|T|K|F|TH)$/.test(base[base.length - 1] ?? '') ? 'S' : 'Z'];
      case "'re":
        return [...base, 'R'];
      case "'ve":
        return [...base, 'V'];
      case "'ll":
        return [...base, 'L'];
      case "'d":
        return [...base, 'D'];
      case "'m":
        return [...base, 'M'];
      case "n't":
        return [...base, 'AH', 'N', 'T'];
    }
  }
  // Suffixes: phonemes of the base (dictionary or rules) + suffix sounds.
  const voicedPlural = (b: string[]) => {
    const last = b[b.length - 1] ?? '';
    return /^(S|Z|SH|ZH|CH|JH)$/.test(last) ? ['IH', 'Z'] : /^(P|T|K|F|TH)$/.test(last) ? ['S'] : ['Z'];
  };
  const pastTense = (b: string[]) => {
    const last = b[b.length - 1] ?? '';
    return /^(T|D)$/.test(last) ? ['IH', 'D'] : /^(P|K|F|S|SH|CH|TH)$/.test(last) ? ['T'] : ['D'];
  };
  const hasVowelLetters = (x: string) => /[aeiouy]/.test(x);
  const restoreE = (base: string) => {
    if (
      base.length >= 3 &&
      base[base.length - 1] === base[base.length - 2] &&
      !/[lsfz]/.test(base[base.length - 1])
    )
      return base.slice(0, -1);
    if (DICT[base]) return base;
    if (DICT[base + 'e']) return base + 'e';
    const groups = base.match(/[aeiouy]+/g) ?? [];
    if (/[^aeiou]c$|[aeiou]c$/.test(base) && groups.length >= 1) return base + 'e';
    if (
      groups.length === 1 &&
      /[^aeiouy][aeiou][^aeiouywx]$/.test(base) &&
      !/(ck|ng|nk|sh|ch|th)$/.test(base)
    )
      return base + 'e';
    return base;
  };
  let sm: RegExpExecArray | null;
  if ((sm = /^(.{2,}?)ing$/.exec(w)) && hasVowelLetters(sm[1]))
    return [...wordPhonemes(restoreE(sm[1])), 'IH', 'NG'];
  if (!/eed$/.test(w) && (sm = /^(.{2,}?)ed$/.exec(w)) && hasVowelLetters(sm[1]) && sm[1].length >= 3) {
    const b = wordPhonemes(restoreE(sm[1]));
    return [...b, ...pastTense(b)];
  }
  if ((sm = /^(.{2,}?)es$/.exec(w)) && /(s|z|x|ch|sh)$/.test(sm[1]) && hasVowelLetters(sm[1])) {
    const b = wordPhonemes(sm[1]);
    return [...b, 'IH', 'Z'];
  }
  if ((sm = /^(.{2,}?)(?:i)es$/.exec(w)) && hasVowelLetters(sm[1]) && DICT[sm[1] + 'y'])
    return [...DICT[sm[1] + 'y'], 'Z'];
  if ((sm = /^(.{3,}?)s$/.exec(w)) && !/(s|u|i)$/.test(sm[1]) && hasVowelLetters(sm[1])) {
    const b =
      sm[1].endsWith('e') && DICT[sm[1].slice(0, -1)]
        ? wordPhonemes(sm[1].slice(0, -1))
        : wordPhonemes(sm[1]);
    return [...b, ...voicedPlural(b)];
  }
  for (const [suf, ph] of [
    ['selves', ['S', 'EH', 'L', 'V', 'Z']],
    ['self', ['S', 'EH', 'L', 'F']],
    ['less', ['L', 'AH', 'S']],
    ['ness', ['N', 'AH', 'S']],
    ['ful', ['F', 'AH', 'L']],
    ['ment', ['M', 'AH', 'N', 'T']],
    ['ly', ['L', 'IY']],
  ] as [string, string[]][]) {
    if (!w.endsWith(suf) || w.length <= suf.length + 1) continue;
    let base = w.slice(0, -suf.length);
    if (!hasVowelLetters(base)) continue;
    if (base.endsWith('i')) {
      if (!DICT[base.slice(0, -1) + 'y']) continue;
      base = base.slice(0, -1) + 'y';
    }
    if (suf === 'ly' && (/[fb]$/.test(base) || (/[aiou]$/.test(base) && !DICT[base]))) continue;
    const b = wordPhonemes(base);
    return b[b.length - 1] === ph[0] ? [...b, ...ph.slice(1)] : [...b, ...ph];
  }
  // Compounds (moonlight, heartbeat, fire|works, sun|shine…): prefer splits into two dictionary words.
  for (let k = 2; k <= w.length - 2; k++) {
    const a = w.slice(0, k);
    const b = w.slice(k);
    if (
      a.length >= 2 &&
      b.length >= 2 &&
      DICT[a] &&
      DICT[b] &&
      !['a', 'i'].includes(a) &&
      a.length + b.length >= 5
    )
      return [...DICT[a], ...DICT[b]];
  }
  for (let k = 2; k <= w.length - 2; k++) {
    const a = w.slice(0, k);
    const b = w.slice(k);
    if (a.length < 3 || b.length < 3 || !/^[^aeiou]/.test(b) || !hasVowelLetters(a) || !hasVowelLetters(b))
      continue;
    const both = DICT[a] && DICT[b];
    const longA = DICT[a] && a.length >= 4 && b.length >= 4;
    const longB = DICT[b] && b.length >= 4 && a.length >= 3;
    if (both || longA || longB) return [...wordPhonemes(a), ...wordPhonemes(b)];
  }
  return ruleWord(w);
}

const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;

/** Text → flat ARPAbet phoneme list (word boundaries are not marked). */
export function textToPhonemes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WORD_RE)) out.push(...wordPhonemes(m[0]));
  return out;
}

/** Phonemes of one lyric syllable ("ca-", "thar-", "tic"); melisma "_" and "-" yield []. */
export function syllableToPhonemes(syllable: string): string[] {
  const s = syllable.trim().replace(/^[-+]+|[-+]+$/g, '');
  if (!s || s === '_' || /^[_~]+$/.test(s)) return [];
  return textToPhonemes(s);
}

/** Phonemes per word, preserving word boundaries. */
export function wordsToPhonemes(text: string): { word: string; phonemes: string[] }[] {
  return [...text.matchAll(WORD_RE)].map((m) => ({ word: m[0], phonemes: wordPhonemes(m[0]) }));
}

// ---------------------------------------------------------------------------------------------
// Lexical stress (the vocal generator puts stressed syllables on strong beats)
// ---------------------------------------------------------------------------------------------

/** Monosyllabic function words: unstressed when sung in a line. */
const FUNCTION_WORDS = new Set(
  (
    'a an the and or but nor of to in on at by for with from as than then so if is am are was were be been ' +
    'it its i me my you your he him his she her we us our they them their that this these those do does did has have had ' +
    'can could will would shall should may might must just there what when who whom whose which how ' +
    "i'm i'll i've i'd you're you'll you've you'd he's she's it's we're we'll we've they're they'll they've that's there's"
  ).split(' '),
);

/** Words the stress heuristic gets wrong (index of the stressed syllable as `syllabify` splits them). */
const STRESS_EXCEPTIONS: Record<string, number> = {
  into: 0,
  onto: 0,
  unto: 0,
  under: 0,
  even: 0,
  over: 0,
  only: 0,
  ever: 0,
  every: 0,
  never: 0,
  any: 0,
  many: 0,
  very: 0,
  inner: 0,
  enter: 0,
  entire: 1,
  indeed: 1,
  instead: 1,
  between: 1,
  believe: 1,
  become: 1,
  because: 1,
  without: 1,
  within: 1,
};

/**
 * Per-syllable lexical stress of one word (1 = primary stress, 0 = unstressed), aligned with
 * `syllabify(word)`. Monosyllabic function words ("the", "and", "my"…) are unstressed; other
 * one-syllable words carry the stress.
 */
export function wordStress(word: string): number[] {
  const w = word
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z']/g, '');
  const sylls = syllabify(word).map((s) => s.toLowerCase());
  if (sylls.length <= 1) return [FUNCTION_WORDS.has(w) ? 0 : 1];
  const letters = w.replace(/[^a-z]/g, '');
  const idx = STRESS_EXCEPTIONS[letters] ?? stressIndex(sylls, letters);
  return sylls.map((_, i) => (i === idx ? 1 : 0));
}

const STRESS_WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*/g;

/** Stress of every sung syllable of a text, in order (aligned with `lyricTokens`). */
export function lyricStress(text: string): { syllable: string; word: string; stress: 0 | 1 }[] {
  const out: { syllable: string; word: string; stress: 0 | 1 }[] = [];
  for (const m of text.matchAll(STRESS_WORD_RE)) {
    const word = m[0];
    const sylls = syllabify(word);
    if (!sylls.length) {
      out.push({ syllable: word, word, stress: 1 });
      continue;
    }
    const stress = wordStress(word);
    sylls.forEach((s, i) => out.push({ syllable: s, word, stress: stress[i] === 1 ? 1 : 0 }));
  }
  return out;
}
