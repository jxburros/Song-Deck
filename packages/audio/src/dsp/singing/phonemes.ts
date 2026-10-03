/**
 * Phoneme inventory (ARPAbet-like) with articulatory parameters for the formant singer, and a small
 * private English letter→phoneme fallback (with a dictionary of frequent lyric words) used when
 * notes carry syllables but no explicit phonemes.
 */
import type { VowelKey } from './formants';

export type PhClass = 'vowel' | 'stop' | 'fricative' | 'affricate' | 'nasal' | 'liquid' | 'glide' | 'aspirate';

export interface PhonemeInfo {
  name: string;
  cls: PhClass;
  voiced: boolean;
  /** Vowel target(s); a second key makes a diphthong. */
  v1?: VowelKey;
  v2?: VowelKey;
  /** Consonant locus F1..F3 (male reference). */
  f?: [number, number, number];
  /** Nominal duration (s) for consonants. */
  dur: number;
  /** Frication band (centre Hz, bandwidth Hz, amplitude). */
  fric?: { f: number; bw: number; amp: number };
  /** Plosive burst band. */
  burst?: { f: number; bw: number; amp: number };
  /** Stop closure (s). */
  closure?: number;
  /** Aspiration after release (s). */
  asp?: number;
  /** Voicing amplitude during the consonant. */
  av: number;
  nasal?: boolean;
}

const V = (name: string, v1: VowelKey, v2?: VowelKey): PhonemeInfo => ({ name, cls: 'vowel', voiced: true, v1, v2, dur: 0.2, av: 1 });

export const PHONEMES: Record<string, PhonemeInfo> = {
  AA: V('AA', 'a'),
  AE: V('AE', 'ae'),
  AH: V('AH', 'V'),
  AO: V('AO', 'O'),
  AW: V('AW', 'a', 'U'),
  AY: V('AY', 'a', 'I'),
  EH: V('EH', 'E'),
  ER: V('ER', 'er'),
  EY: V('EY', 'e', 'I'),
  IH: V('IH', 'I'),
  IY: V('IY', 'i'),
  OW: V('OW', 'o', 'U'),
  OY: V('OY', 'O', 'I'),
  UH: V('UH', 'U'),
  UW: V('UW', 'u'),
  B: { name: 'B', cls: 'stop', voiced: true, f: [220, 900, 2200], dur: 0.06, closure: 0.05, burst: { f: 900, bw: 1400, amp: 0.25 }, asp: 0, av: 0.22 },
  P: { name: 'P', cls: 'stop', voiced: false, f: [220, 900, 2200], dur: 0.09, closure: 0.06, burst: { f: 900, bw: 1600, amp: 0.45 }, asp: 0.035, av: 0 },
  D: { name: 'D', cls: 'stop', voiced: true, f: [260, 1700, 2600], dur: 0.05, closure: 0.04, burst: { f: 4000, bw: 2500, amp: 0.25 }, asp: 0, av: 0.22 },
  T: { name: 'T', cls: 'stop', voiced: false, f: [260, 1700, 2600], dur: 0.085, closure: 0.045, burst: { f: 4600, bw: 3000, amp: 0.55 }, asp: 0.04, av: 0 },
  G: { name: 'G', cls: 'stop', voiced: true, f: [260, 1900, 2300], dur: 0.06, closure: 0.045, burst: { f: 2200, bw: 1300, amp: 0.3 }, asp: 0, av: 0.22 },
  K: { name: 'K', cls: 'stop', voiced: false, f: [260, 1900, 2300], dur: 0.095, closure: 0.05, burst: { f: 2500, bw: 1500, amp: 0.55 }, asp: 0.045, av: 0 },
  CH: { name: 'CH', cls: 'affricate', voiced: false, f: [280, 1800, 2600], dur: 0.11, closure: 0.04, fric: { f: 3100, bw: 2200, amp: 0.45 }, av: 0 },
  JH: { name: 'JH', cls: 'affricate', voiced: true, f: [280, 1800, 2600], dur: 0.09, closure: 0.03, fric: { f: 2900, bw: 2200, amp: 0.25 }, av: 0.45 },
  F: { name: 'F', cls: 'fricative', voiced: false, f: [300, 1100, 2300], dur: 0.09, fric: { f: 6500, bw: 6000, amp: 0.14 }, av: 0 },
  V: { name: 'V', cls: 'fricative', voiced: true, f: [260, 1100, 2300], dur: 0.07, fric: { f: 5500, bw: 5000, amp: 0.07 }, av: 0.55 },
  TH: { name: 'TH', cls: 'fricative', voiced: false, f: [300, 1500, 2600], dur: 0.08, fric: { f: 6500, bw: 6000, amp: 0.11 }, av: 0 },
  DH: { name: 'DH', cls: 'fricative', voiced: true, f: [270, 1500, 2600], dur: 0.05, fric: { f: 5000, bw: 5000, amp: 0.06 }, av: 0.55 },
  S: { name: 'S', cls: 'fricative', voiced: false, f: [300, 1600, 2600], dur: 0.1, fric: { f: 6800, bw: 3000, amp: 0.5 }, av: 0 },
  Z: { name: 'Z', cls: 'fricative', voiced: true, f: [280, 1600, 2600], dur: 0.08, fric: { f: 6300, bw: 3000, amp: 0.25 }, av: 0.5 },
  SH: { name: 'SH', cls: 'fricative', voiced: false, f: [300, 1800, 2500], dur: 0.1, fric: { f: 3300, bw: 2200, amp: 0.45 }, av: 0 },
  ZH: { name: 'ZH', cls: 'fricative', voiced: true, f: [280, 1800, 2500], dur: 0.08, fric: { f: 3100, bw: 2200, amp: 0.25 }, av: 0.5 },
  HH: { name: 'HH', cls: 'aspirate', voiced: false, dur: 0.07, av: 0 },
  M: { name: 'M', cls: 'nasal', voiced: true, f: [280, 1000, 2200], dur: 0.08, av: 0.75, nasal: true },
  N: { name: 'N', cls: 'nasal', voiced: true, f: [280, 1650, 2600], dur: 0.07, av: 0.75, nasal: true },
  NG: { name: 'NG', cls: 'nasal', voiced: true, f: [280, 2100, 2700], dur: 0.08, av: 0.75, nasal: true },
  L: { name: 'L', cls: 'liquid', voiced: true, f: [360, 1100, 2650], dur: 0.07, av: 0.85 },
  R: { name: 'R', cls: 'liquid', voiced: true, f: [420, 1150, 1550], dur: 0.07, av: 0.9 },
  W: { name: 'W', cls: 'glide', voiced: true, f: [300, 720, 2250], dur: 0.06, av: 0.9 },
  Y: { name: 'Y', cls: 'glide', voiced: true, f: [270, 2200, 3000], dur: 0.05, av: 0.9 },
};

export function phonemeInfo(name: string): PhonemeInfo | undefined {
  return PHONEMES[name.toUpperCase().replace(/[0-9]/g, '')];
}

export function isVowel(name: string): boolean {
  return phonemeInfo(name)?.cls === 'vowel';
}

// ---------------------------------------------------------------------------
// Letter → phoneme fallback
// ---------------------------------------------------------------------------

const DICT: Record<string, string> = {
  a: 'AH', i: 'AY', im: 'AY M', "i'm": 'AY M', "i'll": 'AY L', "i've": 'AY V', "i'd": 'AY D', me: 'M IY', my: 'M AY', mine: 'M AY N',
  you: 'Y UW', your: 'Y AO R', "you're": 'Y AO R', yours: 'Y AO R Z', we: 'W IY', "we're": 'W IH R', us: 'AH S', our: 'AW ER',
  he: 'HH IY', she: 'SH IY', they: 'DH EY', them: 'DH EH M', their: 'DH EH R', there: 'DH EH R', "they're": 'DH EH R',
  the: 'DH AH', this: 'DH IH S', that: 'DH AE T', these: 'DH IY Z', those: 'DH OW Z', then: 'DH EH N', than: 'DH AE N',
  and: 'AE N D', or: 'AO R', but: 'B AH T', so: 'S OW', no: 'N OW', not: 'N AA T', "don't": 'D OW N T', "can't": 'K AE N T',
  "won't": 'W OW N T', "it's": 'IH T S', is: 'IH Z', was: 'W AA Z', are: 'AA R', were: 'W ER', be: 'B IY', been: 'B IH N',
  to: 'T UW', too: 'T UW', two: 'T UW', do: 'D UW', does: 'D AH Z', done: 'D AH N', of: 'AH V', off: 'AO F', for: 'F AO R',
  from: 'F R AH M', with: 'W IH DH', what: 'W AH T', when: 'W EH N', where: 'W EH R', why: 'W AY', who: 'HH UW', how: 'HH AW',
  all: 'AO L', one: 'W AH N', once: 'W AH N S', some: 'S AH M', come: 'K AH M', love: 'L AH V', above: 'AH B AH V',
  heart: 'HH AA R T', fire: 'F AY ER', night: 'N AY T', light: 'L AY T', right: 'R AY T', tonight: 'T AH N AY T',
  know: 'N OW', go: 'G OW', oh: 'OW', ooh: 'UW', ah: 'AA', aah: 'AA', la: 'L AA', na: 'N AA', da: 'D AA', ha: 'HH AA',
  hey: 'HH EY', yeah: 'Y EH', whoa: 'W OW', mm: 'M', hmm: 'HH M', ee: 'IY', eh: 'EH', uh: 'AH', oo: 'UW',
  say: 'S EY', said: 'S EH D', day: 'D EY', way: 'W EY', away: 'AH W EY', stay: 'S T EY', again: 'AH G EH N',
  eyes: 'AY Z', eye: 'AY', time: 'T AY M', life: 'L AY F', alive: 'AH L AY V', feel: 'F IY L', free: 'F R IY',
  dream: 'D R IY M', dreams: 'D R IY M Z', sky: 'S K AY', fly: 'F L AY', cry: 'K R AY', die: 'D AY', try: 'T R AY',
  world: 'W ER L D', word: 'W ER D', words: 'W ER D Z', heard: 'HH ER D', home: 'HH OW M', alone: 'AH L OW N', gone: 'G AO N',
  down: 'D AW N', now: 'N AW', town: 'T AW N', sound: 'S AW N D', ground: 'G R AW N D', around: 'AH R AW N D', out: 'AW T',
  rain: 'R EY N', pain: 'P EY N', again2: 'AH G EY N', break: 'B R EY K', make: 'M EY K', take: 'T EY K', wake: 'W EY K',
  live: 'L IH V', give: 'G IH V', have: 'HH AE V', could: 'K UH D', would: 'W UH D', should: 'SH UH D', good: 'G UH D',
  through: 'TH R UW', though: 'DH OW', thought: 'TH AO T', enough: 'IH N AH F', tough: 'T AH F', laugh: 'L AE F',
  old: 'OW L D', cold: 'K OW L D', hold: 'HH OW L D', soul: 'S OW L', only: 'OW N L IY', everything: 'EH V R IY TH IH NG',
  ever: 'EH V ER', never: 'N EH V ER', forever: 'F ER EH V ER', over: 'OW V ER', baby: 'B EY B IY', girl: 'G ER L',
  people: 'P IY P AH L', little: 'L IH T AH L', song: 'S AO NG', sing: 'S IH NG', young: 'Y AH NG', bright: 'B R AY T',
};

function wordToArpa(word: string): string[] {
  const w = word.toLowerCase().replace(/[^a-z']/g, '');
  if (!w) return [];
  if (DICT[w]) return DICT[w].split(' ');
  return letterToSound(w.replace(/'/g, ''));
}

const VOWELS = 'aeiouy';

function letterToSound(w: string): string[] {
  const out: string[] = [];
  const n = w.length;
  const isV = (c: string | undefined) => !!c && VOWELS.includes(c);
  // magic-e: vowel + consonant + final e
  const magicE = n >= 3 && w[n - 1] === 'e' && !isV(w[n - 2]) && isV(w[n - 3]) && w[n - 2] !== 'r';
  let i = 0;
  const startsWith = (s: string) => w.startsWith(s, i);
  while (i < n) {
    const c = w[i];
    const next = w[i + 1];
    // multi-letter graphemes
    if (startsWith('tch')) { out.push('CH'); i += 3; continue; }
    if (startsWith('igh')) { out.push('AY'); i += 3; continue; }
    if (startsWith('ough')) { out.push('AO'); i += 4; continue; }
    if (startsWith('augh')) { out.push('AO'); i += 4; continue; }
    if (startsWith('eigh')) { out.push('EY'); i += 4; continue; }
    if (startsWith('tion')) { out.push('SH', 'AH', 'N'); i += 4; continue; }
    if (startsWith('th')) { out.push(i === 0 && /^th(e|is|at|ey|em|ere|en|ough|us|an|ine|y)/.test(w) ? 'DH' : 'TH'); i += 2; continue; }
    if (startsWith('sh')) { out.push('SH'); i += 2; continue; }
    if (startsWith('ch')) { out.push('CH'); i += 2; continue; }
    if (startsWith('ph')) { out.push('F'); i += 2; continue; }
    if (startsWith('wh')) { out.push('W'); i += 2; continue; }
    if (startsWith('ck')) { out.push('K'); i += 2; continue; }
    if (startsWith('ng')) { out.push('NG'); i += 2; continue; }
    if (startsWith('nk')) { out.push('NG', 'K'); i += 2; continue; }
    if (startsWith('qu')) { out.push('K', 'W'); i += 2; continue; }
    if (startsWith('gh')) { if (i === 0) out.push('G'); i += 2; continue; }
    if (startsWith('ee') || startsWith('ea')) { out.push('IY'); i += 2; continue; }
    if (startsWith('oo')) { out.push(w[i + 2] === 'k' || w[i + 2] === 'd' ? 'UH' : 'UW'); i += 2; continue; }
    if (startsWith('ou')) { out.push('AW'); i += 2; continue; }
    if (startsWith('ow')) { out.push(i + 2 >= n ? 'OW' : 'AW'); i += 2; continue; }
    if (startsWith('oi') || startsWith('oy')) { out.push('OY'); i += 2; continue; }
    if (startsWith('ai') || startsWith('ay')) { out.push('EY'); i += 2; continue; }
    if (startsWith('au') || startsWith('aw')) { out.push('AO'); i += 2; continue; }
    if (startsWith('ie')) { out.push(i + 2 >= n && n <= 3 ? 'AY' : 'IY'); i += 2; continue; }
    if (startsWith('ue') || startsWith('ew')) { out.push('UW'); i += 2; continue; }
    if (startsWith('oa')) { out.push('OW'); i += 2; continue; }
    if (startsWith('ey')) { out.push('IY'); i += 2; continue; }
    if (startsWith('er') || startsWith('ir') || startsWith('ur')) {
      if (!isV(w[i + 2])) { out.push('ER'); i += 2; continue; }
    }
    if (startsWith('ar') && !isV(w[i + 2])) { out.push('AA', 'R'); i += 2; continue; }
    if (startsWith('or') && !isV(w[i + 2])) { out.push('AO', 'R'); i += 2; continue; }
    if (c === next && !isV(c)) { i++; continue; } // doubled consonant
    // open syllable (V-CV): a/o/u before a single consonant + vowel are long ("bro-ken", "pa-per", "mu-sic")
    const openSyl = i > 0 && i + 2 < n && !isV(next) && isV(w[i + 2]) && !'rwxy'.includes(next ?? '') && !(i + 2 === n - 1 && w[i + 2] === 'e');
    switch (c) {
      case 'a': out.push((magicE && i === n - 3) || openSyl ? 'EY' : 'AE'); break;
      case 'e':
        if (i === n - 1 && n > 2) break; // silent final e
        out.push(i === n - 1 ? 'IY' : 'EH');
        break;
      case 'i': out.push(magicE && i === n - 3 ? 'AY' : 'IH'); break;
      case 'o': out.push((magicE && i === n - 3) || openSyl || i === n - 1 ? 'OW' : 'AA'); break;
      case 'u': out.push((magicE && i === n - 3) || openSyl ? 'UW' : 'AH'); break;
      case 'y':
        if (i === 0) out.push('Y');
        else out.push(n <= 4 && i === n - 1 ? 'AY' : 'IY');
        break;
      case 'b': out.push('B'); break;
      case 'c': out.push(next === 'e' || next === 'i' || next === 'y' ? 'S' : 'K'); break;
      case 'd': out.push('D'); break;
      case 'f': out.push('F'); break;
      case 'g': out.push((next === 'e' || next === 'i') && i > 0 ? 'JH' : 'G'); break;
      case 'h': out.push('HH'); break;
      case 'j': out.push('JH'); break;
      case 'k': if (!(i === 0 && next === 'n')) out.push('K'); break;
      case 'l': out.push('L'); break;
      case 'm': out.push('M'); break;
      case 'n': out.push('N'); break;
      case 'p': out.push('P'); break;
      case 'q': out.push('K'); break;
      case 'r': out.push('R'); break;
      case 's': out.push(i > 0 && i === n - 1 && !'ptkf'.includes(w[i - 1]) ? 'Z' : isV(w[i - 1]) && isV(next) ? 'Z' : 'S'); break;
      case 't': out.push('T'); break;
      case 'v': out.push('V'); break;
      case 'w': out.push('W'); break;
      case 'x': out.push('K', 'S'); break;
      case 'z': out.push('Z'); break;
      default: break;
    }
    i++;
  }
  return out;
}

/** Phonemes for free text (words separated by spaces/punctuation). */
export function textToArpabet(text: string): string[] {
  return text
    .split(/[\s\-–—,.;:!?"()]+/)
    .filter(Boolean)
    .flatMap(wordToArpa);
}

/**
 * Distribute a word's phonemes over its sung syllables: each syllable gets one vowel nucleus,
 * consonant clusters between nuclei are split (single consonant → next onset).
 */
export function wordPhonemesBySyllable(word: string, syllableCount: number): string[][] | null {
  const ph = wordToArpa(word);
  const nuclei: number[] = [];
  ph.forEach((p, i) => {
    if (isVowel(p)) nuclei.push(i);
  });
  if (nuclei.length !== syllableCount || syllableCount === 0) return null;
  const out: string[][] = [];
  let start = 0;
  for (let s = 0; s < syllableCount; s++) {
    let end: number;
    if (s === syllableCount - 1) end = ph.length;
    else {
      const gap = nuclei[s + 1] - nuclei[s] - 1;
      end = nuclei[s] + 1 + (gap >= 2 ? 1 : 0);
    }
    out.push(ph.slice(start, end));
    start = end;
  }
  return out;
}

/** Phonemes for a single syllable string (fallback when the word can't be aligned). */
export function syllableToArpabet(syllable: string): string[] {
  return wordToArpa(syllable);
}
