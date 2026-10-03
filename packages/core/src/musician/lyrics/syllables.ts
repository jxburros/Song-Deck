/**
 * English syllabification heuristics for lyric alignment (spec §33-§35, §48).
 *
 * Rule-based: vowel nuclei (with diphthong/hiatus handling), silent final e, consonant+"le",
 * common suffixes (-ing, -ed, -es, -ly, -ful, -less, -ness, -ment), glide i in -tion/-sion/-cial,
 * contractions, compounds, plus a small exception dictionary of frequent song words.
 */

const DICT: Record<string, string[]> = {
  every: ['ev', 'ery'],
  everything: ['ev', 'ery', 'thing'],
  everyone: ['ev', 'ery', 'one'],
  everybody: ['ev', 'ery', 'bod', 'y'],
  everywhere: ['ev', 'ery', 'where'],
  forever: ['for', 'ev', 'er'],
  never: ['nev', 'er'],
  ever: ['ev', 'er'],
  whatever: ['what', 'ev', 'er'],
  whenever: ['when', 'ev', 'er'],
  wherever: ['wher', 'ev', 'er'],
  however: ['how', 'ev', 'er'],
  heaven: ['heav', 'en'],
  seven: ['sev', 'en'],
  given: ['giv', 'en'],
  river: ['riv', 'er'],
  over: ['o', 'ver'],
  lover: ['lov', 'er'],
  cover: ['cov', 'er'],
  even: ['e', 'ven'],
  evening: ['eve', 'ning'],
  something: ['some', 'thing'],
  nothing: ['noth', 'ing'],
  anything: ['an', 'y', 'thing'],
  anyone: ['an', 'y', 'one'],
  someone: ['some', 'one'],
  somewhere: ['some', 'where'],
  sometimes: ['some', 'times'],
  people: ['peo', 'ple'],
  business: ['busi', 'ness'],
  rhythm: ['rhy', 'thm'],
  rhythms: ['rhy', 'thms'],
  prism: ['pri', 'sm'],
  recipe: ['rec', 'i', 'pe'],
  catastrophe: ['ca', 'tas', 'tro', 'phe'],
  apostrophe: ['a', 'pos', 'tro', 'phe'],
  eye: ['eye'],
  eyes: ['eyes'],
  fire: ['fire'],
  fires: ['fires'],
  desire: ['de', 'sire'],
  higher: ['high', 'er'],
  hour: ['hour'],
  hours: ['hours'],
  our: ['our'],
  flower: ['flow', 'er'],
  flowers: ['flow', 'ers'],
  power: ['pow', 'er'],
  tower: ['tow', 'er'],
  create: ['cre', 'ate'],
  created: ['cre', 'at', 'ed'],
  idea: ['i', 'de', 'a'],
  area: ['ar', 'e', 'a'],
  real: ['real'],
  really: ['real', 'ly'],
  being: ['be', 'ing'],
  going: ['go', 'ing'],
  doing: ['do', 'ing'],
  seeing: ['see', 'ing'],
  argue: ['ar', 'gue'],
  onion: ['on', 'ion'],
  quiet: ['qui', 'et'],
  science: ['sci', 'ence'],
  violin: ['vi', 'o', 'lin'],
  piano: ['pi', 'an', 'o'],
  radio: ['ra', 'di', 'o'],
  video: ['vid', 'e', 'o'],
  poem: ['po', 'em'],
  ruin: ['ru', 'in'],
  fluid: ['flu', 'id'],
  naked: ['na', 'ked'],
  wicked: ['wick', 'ed'],
  sacred: ['sa', 'cred'],
  beloved: ['be', 'lov', 'ed'],
  safety: ['safe', 'ty'],
  ninety: ['nine', 'ty'],
  element: ['el', 'e', 'ment'],
  different: ['dif', 'fer', 'ent'],
  family: ['fam', 'i', 'ly'],
  memory: ['mem', 'o', 'ry'],
  memories: ['mem', 'o', 'ries'],
  beautiful: ['beau', 'ti', 'ful'],
  chocolate: ['choc', 'o', 'late'],
  camera: ['cam', 'er', 'a'],
  orange: ['or', 'ange'],
  baby: ['ba', 'by'],
  maybe: ['may', 'be'],
  tonight: ['to', 'night'],
  today: ['to', 'day'],
  tomorrow: ['to', 'mor', 'row'],
  yesterday: ['yes', 'ter', 'day'],
  alone: ['a', 'lone'],
  away: ['a', 'way'],
  again: ['a', 'gain'],
  inside: ['in', 'side'],
  outside: ['out', 'side'],
  little: ['lit', 'tle'],
  heartache: ['heart', 'ache'],
  goodbye: ['good', 'bye'],
  hello: ['hel', 'lo'],
  silence: ['si', 'lence'],
  lion: ['li', 'on'],
  diamond: ['di', 'a', 'mond'],
  diamonds: ['di', 'a', 'monds'],
  wanna: ['wan', 'na'],
  gonna: ['gon', 'na'],
  gotta: ['got', 'ta'],
  oh: ['oh'],
  ooh: ['ooh'],
  yeah: ['yeah'],
  whoa: ['whoa'],
  woah: ['woah'],
  i: ['I'],
  "i'm": ["I'm"],
  "i'll": ["I'll"],
  "i'd": ["I'd"],
  "i've": ["I've"],
};

const SUFFIX_KEEP_E = new Set(['some', 'fire', 'home', 'life', 'time', 'love', 'lone', 'base', 'game', 'side', 'whole', 'stone', 'bone', 'wire', 'care', 'more', 'where', 'there', 'here', 'face', 'place', 'space', 'grace', 'rage', 'page', 'stage', 'wave', 'save', 'brave', 'make', 'take', 'wake', 'shake', 'smoke', 'line', 'mine', 'nine', 'shine', 'fine', 'hope', 'rope', 'tune', 'moon', 'free', 'tree', 'sun', 'star', 'heart', 'night', 'day', 'rain', 'snow', 'sea', 'sky']);

const VALID_ONSET2 = new Set(['bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'tr', 'thr', 'shr', 'wr', 'chr', 'tw', 'dw', 'sw', 'kw', 'qu']);
const S_CLUSTER = new Set(['st', 'sp', 'sk', 'sc', 'sm', 'sn', 'sl']);

function isLetterVowel(c: string): boolean {
  return c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u';
}

/** Per-letter vowel flags for a lowercase word (no apostrophes). */
function vowelMask(w: string): boolean[] {
  const m: boolean[] = [];
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const prev = w[i - 1] ?? '';
    const next = w[i + 1] ?? '';
    let v = isLetterVowel(c);
    if (c === 'y') v = i > 0 && !(isLetterVowel(next) && (isLetterVowel(prev) || i === 0));
    if (c === 'y' && i > 0 && isLetterVowel(prev) && !isLetterVowel(next)) v = true; // ay, ey, oy teams
    if (c === 'u' && prev === 'q') v = false;
    if (c === 'u' && prev === 'g' && isLetterVowel(next)) v = false;
    if (c === 'w' && i > 0 && (prev === 'a' || prev === 'e' || prev === 'o') && !isLetterVowel(next) && next !== 'y') v = true;
    m.push(v);
  }
  // Glide i in -tion, -sion, -cial, -cious, -tious, -gion, -geous, million, union…
  const glide = /(?:t|s|c|x|g|sh|ch|ll)i(?=[aou])|(?<=[aeiou])ni(?=o)/g;
  let g: RegExpExecArray | null;
  while ((g = glide.exec(w))) m[g.index + g[0].length - 1] = false;
  return m;
}

/** Vowel groups as [start, end) letter spans, with hiatus splits. */
function nuclei(w: string): [number, number][] {
  const mask = vowelMask(w);
  const groups: [number, number][] = [];
  let i = 0;
  while (i < w.length) {
    if (!mask[i]) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < w.length && mask[j]) j++;
    // Hiatus splits inside a vowel run.
    let s = i;
    for (let k = i + 1; k < j; k++) {
      const pair = w[k - 1] + w[k];
      const before = w.slice(0, k - 1);
      const after = w.slice(k + 1);
      void before;
      const priorVowel = groups.length > 0;
      let split = false;
      if (pair === 'ia' || pair === 'io' || pair === 'iu') split = true;
      else if (pair === 'eo') split = !/^peo|geo[nu]/.test(w.slice(k - 2, k + 2)) && !(w.slice(k - 2, k + 1) === 'peo');
      else if (pair === 'ua' || pair === 'uo') split = true;
      else if (pair === 'ea' && k + 1 === w.length && priorVowel) split = true;
      else if (pair === 'ie' && (/^(t|nt|nc)/.test(after) || (after === 'r' && priorVowel) || (after.startsWith('st') && priorVowel)) && !/[tcs]$/.test(w[k - 2] ?? '')) split = true;
      else if (pair === 'ue' && after.length > 0 && !/^(s|d)$/.test(after)) split = true;
      else if (pair === 'oe' && after.length > 0 && after !== 's') split = true;
      else if (pair === 'ye' && after.length > 0 && after !== 's' && after !== 'd') split = true;
      else if (pair === 'yi' || pair === 'yo' || pair === 'ya') split = true;
      if (split) {
        groups.push([s, k]);
        s = k;
      }
    }
    groups.push([s, j]);
    i = j;
  }
  return groups;
}

const DIGRAPHS = ['tch', 'ch', 'sh', 'th', 'ph', 'wh', 'gh', 'ck', 'ng', 'qu'];

function consonantUnits(cluster: string): string[] {
  const out: string[] = [];
  let i = 0;
  if (cluster.endsWith('gu') && cluster.length >= 3) return [...consonantUnits(cluster.slice(0, -2)), 'gu'];
  if (cluster.endsWith('i') && cluster.length >= 2) {
    // Glide i (na-tion, spe-cial, mil-lion): it belongs to the following syllable with its consonant.
    const units = consonantUnits(cluster.slice(0, -1));
    units[units.length - 1] += 'i';
    return units;
  }
  while (i < cluster.length) {
    const d = DIGRAPHS.find((x) => cluster.startsWith(x, i));
    if (d) {
      out.push(d);
      i += d.length;
    } else {
      out.push(cluster[i]);
      i++;
    }
  }
  return out;
}

/** How many leading consonant units of an intervocalic cluster stay with the previous syllable. */
function splitCluster(units: string[], nextIsLe: boolean): number {
  const n = units.length;
  if (n === 0) return 0;
  if (nextIsLe) {
    // Consonant + "le": the consonant before l starts the last syllable (ta-ble, lit-tle), except ck/x.
    // "ng" + le splits inside the digraph (sin-gle, jun-gle): keep the n (half a unit).
    if (n >= 2 && units[n - 2] === 'ng') return n - 2 + 0.5;
    const lIdx = n - 1;
    if (n >= 2 && (units[lIdx - 1] === 'ck' || units[lIdx - 1] === 'x')) return lIdx;
    return Math.max(0, lIdx - 1);
  }
  if (n === 1) return ['ck', 'x', 'ng'].includes(units[0]) ? 1 : 0;
  const lastTwo = units.slice(-2).join('');
  if (n === 2 && VALID_ONSET2.has(lastTwo) && !['ck', 'ng'].includes(units[0])) return 0;
  if (n >= 3 && VALID_ONSET2.has(lastTwo)) return n - 2;
  if (n >= 3 && S_CLUSTER.has(lastTwo)) return n - 2;
  if (units[0] === 'ck' || units[0] === 'ng' || units[0] === 'x') return Math.max(1, n - 1);
  return n - 1;
}

/** Core syllabification of a plain lowercase word (no suffix handling). */
function core(w: string, silentE = true): string[] {
  if (!w) return [];
  let groups = nuclei(w);
  if (!groups.length) return [w];
  // Silent final e (but not consonant + le, and not when it is the only vowel).
  const lastG = groups[groups.length - 1];
  const leEnding = /[^aeiouy]le$/.test(w) && groups.length >= 2;
  if (silentE && groups.length >= 2 && lastG[0] === w.length - 1 && w.endsWith('e') && !leEnding && lastG[1] - lastG[0] === 1) {
    groups = groups.slice(0, -1);
  }
  if (groups.length === 1) return [w];
  const sylls: string[] = [];
  let start = 0;
  for (let g = 0; g < groups.length - 1; g++) {
    const endV = groups[g][1];
    const nextV = groups[g + 1][0];
    const cluster = w.slice(endV, nextV);
    const isLe = leEnding && g + 1 === groups.length - 1;
    const units = consonantUnits(cluster);
    const keep = splitCluster(units, isLe);
    const whole = Math.floor(keep);
    const cut = endV + units.slice(0, whole).join('').length + (keep !== whole ? 1 : 0);
    sylls.push(w.slice(start, cut));
    start = cut;
  }
  sylls.push(w.slice(start));
  return sylls.filter((s) => s.length > 0);
}

function hasVowel(s: string): boolean {
  return nuclei(s).length > 0;
}

function lowerWord(word: string): string {
  return word.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z']/g, '');
}

/** Restore the original capitalization of `word` onto syllables of its lowercase form. */
function recase(word: string, sylls: string[]): string[] {
  const letters = word.replace(/[^A-Za-z'’]/g, '');
  let i = 0;
  return sylls.map((s) => {
    let out = '';
    for (const ch of s) {
      const orig = letters[i] ?? ch;
      out += orig.toLowerCase() === ch || orig === '’' ? (orig === '’' ? "'" : orig) : ch;
      i++;
    }
    return out;
  });
}

function syllabifyLower(w: string): string[] {
  if (!w) return [];
  if (DICT[w]) return [...DICT[w]];
  // Contractions.
  const apo = w.endsWith("n't") ? w.length - 3 : w.indexOf("'");
  if (apo >= 0) {
    const base = w.slice(0, apo);
    const tail = w.slice(apo);
    if (tail === "n't") {
      if (/^(do|ca|wo|ai|sha)$/.test(base)) return [w];
      const b = syllabifyLower(base);
      // couldn't, wouldn't, shouldn't, didn't, isn't, wasn't → extra syllable on "n't"
      return [...b, "n't"];
    }
    const b = syllabifyLower(base);
    if (!b.length) return [w];
    b[b.length - 1] += tail;
    return b;
  }
  if (w.length <= 3) return core(w);
  if (/ee[ds]$/.test(w)) return core(w);
  const syllabicM = /(s|th)m(s?)$/.exec(w);
  if (syllabicM && w.length > 4) {
    // Syllabic m: pri-sm, cha-sm, rea-li-sm.
    const head = w.slice(0, syllabicM.index);
    const s = syllabifyLower(head);
    return [...s, w.slice(syllabicM.index)];
  }
  if (/[^aeiouy]led$/.test(w) && w.length > 5) {
    const s = syllabifyLower(w.slice(0, -1));
    s[s.length - 1] += 'd';
    return s;
  }
  // Compounds whose first part ends in silent e (some|thing, fire|works, home|town).
  for (const first of SUFFIX_KEEP_E) {
    if (w.length > first.length + 2 && w.startsWith(first) && !/^[aeiouy]/.test(w.slice(first.length))) {
      const rest = w.slice(first.length);
      if (rest.length >= 3 && hasVowel(rest)) return [...syllabifyLower(first), ...syllabifyLower(rest)];
    }
  }
  // -ings / -les plural forms.
  if (w.endsWith('ings') && w.length > 5) {
    const s = syllabifyLower(w.slice(0, -1));
    s[s.length - 1] += 's';
    return s;
  }
  if (/[^aeiouy]les$/.test(w) && w.length > 4) {
    const s = syllabifyLower(w.slice(0, -1));
    s[s.length - 1] += 's';
    return s;
  }
  // -ing
  if (w.endsWith('ing') && w.length > 4) {
    let base = w.slice(0, -3);
    if (hasVowel(base)) {
      let carry = '';
      if (base.length >= 3 && base[base.length - 1] === base[base.length - 2] && !/[aeiouylsfz]/.test(base[base.length - 1])) {
        carry = base[base.length - 1];
        base = base.slice(0, -1);
      }
      if (DICT[base + 'e']) {
        const d = [...DICT[base + 'e']];
        d[d.length - 1] = d[d.length - 1].replace(/e$/, '');
        return [...d, carry + 'ing'];
      }
      return [...core(base, false), carry + 'ing'];
    }
  }
  // -ed
  if (w.endsWith('ed') && w.length > 3) {
    const base = w.slice(0, -2);
    if (hasVowel(base)) {
      if (DICT[base + 'e']) {
        const d = [...DICT[base + 'e']];
        d[d.length - 1] = d[d.length - 1].replace(/e$/, '');
        return /[td]$/.test(base) ? [...d, 'ed'] : [...d.slice(0, -1), d[d.length - 1] + 'ed'];
      }
      if (/[td]$/.test(base)) return [...syllabifyBaseForSuffix(base), 'ed'];
      const b = syllabifyBaseForSuffix(base);
      b[b.length - 1] += 'ed';
      return b;
    }
  }
  // -es
  if (w.endsWith('es') && w.length > 3) {
    const base = w.slice(0, -2);
    if (hasVowel(base)) {
      if (/(s|z|x|ch|sh|ss|zz)$/.test(base) || /[gc]$/.test(base)) return [...syllabifyBaseForSuffix(base), 'es'];
      const b = syllabifyBaseForSuffix(base);
      b[b.length - 1] += 'es';
      return b;
    }
  }
  // -ly, -ful, -less, -ness, -ment
  for (const suf of ['ly', 'ful', 'less', 'ness', 'ment', 'ship', 'hood']) {
    if (w.endsWith(suf) && w.length > suf.length + 2) {
      const base = w.slice(0, -suf.length);
      if (hasVowel(base) && !(suf === 'ly' && /l$/.test(base) && base.length <= 2)) {
        const b = syllabifyLower(base);
        if (suf === 'ly' && /[^aeiouy][fb]$/.test(base)) {
          // butter-fly, hum-bly: the consonant joins "ly".
          const last = b[b.length - 1];
          b[b.length - 1] = last.slice(0, -1);
          return [...b.filter(Boolean), `${last.slice(-1)}${suf}`];
        }
        return [...b, suf];
      }
    }
  }
  return core(w);
}

/** Syllables of a base that had a suffix stripped (final e is a real vowel only if nothing else is). */
function syllabifyBaseForSuffix(base: string): string[] {
  if (DICT[base]) return [...DICT[base]];
  return core(base, true);
}

/** Split an English word into syllables ("cathartic" → ["ca", "thar", "tic"]). */
export function syllabify(word: string): string[] {
  const trimmed = word.trim();
  if (!trimmed) return [];
  if (trimmed.includes('-') && /[A-Za-z]-[A-Za-z]/.test(trimmed)) return trimmed.split('-').filter(Boolean).flatMap((p) => syllabify(p));
  const w = lowerWord(trimmed);
  if (!w || !/[a-z]/.test(w)) return [];
  const sylls = syllabifyLower(w);
  return recase(trimmed, sylls);
}

const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*/g;

/** Words of a text with their syllables. */
export function syllabifyText(text: string): { word: string; syllables: string[] }[] {
  const out: { word: string; syllables: string[] }[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[0];
    out.push({ word, syllables: syllabify(word) });
  }
  return out;
}

/** Total syllable count of a text. */
export function countSyllables(text: string): number {
  return syllabifyText(text).reduce((n, w) => n + Math.max(1, w.syllables.length), 0);
}

/**
 * Syllables of a lyric line as sung tokens: word-continuation syllables carry a trailing "-"
 * ("ca-", "thar-", "tic").
 */
export function lyricTokens(text: string): { text: string; wordIndex: number; syllableIndex: number; word: string }[] {
  const out: { text: string; wordIndex: number; syllableIndex: number; word: string }[] = [];
  syllabifyText(text).forEach((w, wi) => {
    const s = w.syllables.length ? w.syllables : [w.word];
    s.forEach((syl, si) => out.push({ text: si < s.length - 1 ? `${syl}-` : syl, wordIndex: wi, syllableIndex: si, word: w.word }));
  });
  return out;
}
