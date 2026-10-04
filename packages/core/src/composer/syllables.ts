/**
 * Tiny vowel-group syllabifier used by the vocal generator to match note counts to lyric lines.
 * (The musician module owns the full lyric tooling; this is intentionally small and internal.)
 */
import { wordStress } from '../musician/lyrics/g2p';

const VOWELS = 'aeiouy';

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch);
}

/** Syllable count of one word: vowel groups, with silent-e and -le/-es/-ed corrections. */
export function wordSyllableCount(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  let count = 0;
  let prevVowel = false;
  for (let i = 0; i < w.length; i++) {
    const v = isVowel(w[i]) && !(w[i] === 'y' && i === 0);
    if (v && !prevVowel) count++;
    prevVowel = v;
  }
  // Silent final "e" ("fire" → 1… but "the" handled by the length guard), except "-le" after a consonant.
  if (w.endsWith('e') && !w.endsWith('le') && !w.endsWith('ee') && count > 1) count--;
  else if (w.endsWith('le') && w.length > 2 && !isVowel(w[w.length - 3]) && count === 1) count = 2;
  // "-es"/"-ed" endings are usually not syllabic unless after t/d/s/z/x/sh/ch.
  if ((w.endsWith('es') || w.endsWith('ed')) && count > 1) {
    const before = w[w.length - 3];
    if (!'tdszxhc'.includes(before)) count--;
  }
  return Math.max(1, count);
}

export function textSyllableCount(text: string): number {
  return splitWords(text).reduce((n, w) => n + wordSyllableCount(w), 0);
}

export function splitWords(text: string): string[] {
  return text
    .replace(/[’']/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/**
 * Split a word into `wordSyllableCount(word)` chunks at vowel-group boundaries.
 * Chunks except the last carry a trailing "-" (word continuation marker of the Music IR).
 */
export function splitWordSyllables(word: string): string[] {
  const n = wordSyllableCount(word);
  if (n <= 1) return [word];
  const lower = word.toLowerCase();
  // Find vowel-group start indices.
  const starts: number[] = [];
  let prev = false;
  for (let i = 0; i < lower.length; i++) {
    const v = isVowel(lower[i]) && !(lower[i] === 'y' && i === 0);
    if (v && !prev) starts.push(i);
    prev = v;
  }
  const groups = starts.slice(0, n);
  const cuts: number[] = [];
  for (let g = 1; g < groups.length; g++) {
    // Cut between the previous vowel group and this one: keep one consonant with the next syllable.
    let c = groups[g];
    if (c - 1 > groups[g - 1] && !isVowel(lower[c - 1])) c = c - 1;
    cuts.push(c);
  }
  const parts: string[] = [];
  let last = 0;
  for (const c of cuts) {
    if (c > last && c < word.length) {
      parts.push(word.slice(last, c));
      last = c;
    }
  }
  parts.push(word.slice(last));
  return parts.map((p, i) => (i < parts.length - 1 ? `${p}-` : p));
}

/** Syllables of a lyric line in order (continuations marked with "-"). */
export function lineSyllables(text: string): string[] {
  const out: string[] = [];
  for (const w of splitWords(text)) out.push(...splitWordSyllables(w));
  return out;
}

/**
 * Lexical stress (1/0) of each syllable `lineSyllables` returns: the musician's stress rules
 * (primary stress per word, monosyllabic function words unstressed) mapped onto this splitter.
 */
export function lineStresses(text: string): number[] {
  const out: number[] = [];
  for (const w of splitWords(text)) {
    const n = splitWordSyllables(w).length;
    const s = wordStress(w);
    if (s.length === n) {
      out.push(...s);
      continue;
    }
    const idx = s.indexOf(1);
    const at =
      idx < 0 ? -1 : n === 1 ? 0 : Math.min(n - 1, Math.round((idx * (n - 1)) / Math.max(1, s.length - 1)));
    for (let i = 0; i < n; i++) out.push(i === at ? 1 : 0);
  }
  return out;
}
