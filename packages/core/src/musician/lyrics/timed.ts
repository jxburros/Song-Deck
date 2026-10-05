import type { MusicOperation, Song } from '../../ir/types';
import { findTrack } from '../../ir/song-utils';
import { createTimeMap, sectionLayout } from '../../timing';
import {
  barIndex,
  beatTicks,
  emitNoteOps,
  lockChecker,
  sortWork,
  toWork,
  type WorkNote,
} from '../op-helpers';
import { lyricTokens } from './syllables';

/**
 * Timed lyrics → song (spec §26 transcription, §33-§35 lyrics): words recognised in a recording
 * (speech-to-text with word timings) become lyric lines in the sections where they are sung and
 * syllables on the vocal notes that sound while each word is sung.
 *
 * Per word: the notes whose onset falls inside the word (± a 32nd of a beat) receive its syllables
 * in order; extra notes become melisma "_", and extra syllables are merged into the last note.
 * Notes no word reaches keep no syllable. Locked notes — and, as with every note edit, the rest of
 * the bars that hold them — and locked lyric sections are left alone.
 */

export interface TimedLyricWord {
  word: string;
  /** Seconds on the recording's clock. */
  startSeconds: number;
  endSeconds: number;
  confidence?: number;
}

export interface TimedLyricPhrase {
  text: string;
  startSeconds: number;
  endSeconds: number;
  words?: TimedLyricWord[];
}

export interface TimedLyricsOptions {
  /** Song time (seconds) of the recording's t = 0 (default 0). */
  offsetSeconds?: number;
  /** Drop words below this confidence (default 0: keep all). */
  minConfidence?: number;
  /** Leave lyric lines alone and only attach syllables (default false). */
  syllablesOnly?: boolean;
}

export interface TimedLyricsResult {
  operations: MusicOperation[];
  /** Lyric lines per section (what the set_lyrics operations write). */
  lines: { sectionId: string; sectionName: string; lines: string[] }[];
  /** Words that landed on at least one note. */
  matchedWords: number;
  /** Words sung where the track has no (unlocked) note. */
  unmatchedWords: string[];
  /** True when the phrases carry no word timings: align with `alignLyrics` after applying the lines. */
  needsAlignment: boolean;
  warnings: string[];
}

function cleanSyllable(s: string): string {
  return s.replace(/-$/, '');
}

const WORD_CHAR = /[\p{L}\p{N}']/u;

/** "love," → "love" (linear scan from both ends; no backtracking regex on transcribed text). */
function trimPunctuation(word: string): string {
  const chars = Array.from(word);
  let a = 0;
  let b = chars.length;
  while (a < b && !WORD_CHAR.test(chars[a])) a++;
  while (b > a && !WORD_CHAR.test(chars[b - 1])) b--;
  return chars.slice(a, b).join('');
}

/** Spread a word's syllables over its notes (melisma "_" for extra notes, merge extra syllables). */
function syllablesForNotes(word: string, count: number): string[] {
  const tokens = lyricTokens(word).map((t) => t.text);
  const syl = tokens.length ? tokens : [word];
  if (count <= 0) return [];
  if (syl.length <= count) return [...syl, ...new Array<string>(count - syl.length).fill('_')];
  const head = syl.slice(0, count - 1);
  const tail = syl
    .slice(count - 1)
    .map(cleanSyllable)
    .join('');
  return [...head, tail];
}

/**
 * Syllables for notes from word timings (note id → syllable). Notes are matched to the word whose
 * span holds their onset (± a 32nd of a beat), nearest word start first.
 */
export function timedSyllables(
  song: Song,
  notes: readonly { id: string; tick: number }[],
  words: readonly TimedLyricWord[],
  opts: { offsetSeconds?: number } = {},
): { syllables: Map<string, string>; matchedWords: number; unmatchedWords: string[] } {
  const tm = createTimeMap(song);
  const offset = opts.offsetSeconds ?? 0;
  const toTick = (sec: number) => Math.max(0, Math.round(tm.secondsToTick(sec + offset)));
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  const spans = words
    .map((w, i) => ({ i, word: w.word.trim(), t0: toTick(w.startSeconds), t1: toTick(w.endSeconds) }))
    .filter((w) => w.word);
  const owner = new Map<string, number>();
  for (const n of sorted) {
    const tol = beatTicks(song, n.tick) / 8;
    let best = -1;
    let bestDist = Infinity;
    for (const s of spans) {
      if (n.tick < s.t0 - tol || n.tick >= Math.max(s.t1, s.t0 + tol)) continue;
      const d = Math.abs(n.tick - s.t0);
      if (d < bestDist) {
        bestDist = d;
        best = s.i;
      }
    }
    if (best >= 0) owner.set(n.id, best);
  }
  const syllables = new Map<string, string>();
  const unmatchedWords: string[] = [];
  let matchedWords = 0;
  for (const s of spans) {
    const mine = sorted.filter((n) => owner.get(n.id) === s.i);
    if (!mine.length) {
      unmatchedWords.push(s.word);
      continue;
    }
    matchedWords++;
    const bare = trimPunctuation(s.word) || s.word;
    const syl = syllablesForNotes(bare, mine.length);
    mine.forEach((n, k) => syllables.set(n.id, syl[k]));
  }
  return { syllables, matchedWords, unmatchedWords };
}

export function applyTimedLyrics(
  song: Song,
  trackId: string,
  phrases: readonly TimedLyricPhrase[],
  opts: TimedLyricsOptions = {},
): TimedLyricsResult {
  const result: TimedLyricsResult = {
    operations: [],
    lines: [],
    matchedWords: 0,
    unmatchedWords: [],
    needsAlignment: false,
    warnings: [],
  };
  const track = song.tracks.find((t) => t.id === trackId) ?? findTrack(song, trackId);
  if (!track) {
    result.warnings.push(`There is no track "${trackId}".`);
    return result;
  }
  const offset = opts.offsetSeconds ?? 0;
  const tm = createTimeMap(song);
  const toTick = (sec: number) => Math.max(0, Math.round(tm.secondsToTick(sec + offset)));
  const layout = sectionLayout(song);
  const sectionAt = (tick: number) =>
    layout.find((s) => tick >= s.startTick && tick < s.endTick) ?? layout[layout.length - 1];

  const clean = phrases
    .map((p) => ({ ...p, text: p.text.replace(/\s+/g, ' ').trim() }))
    .filter((p) => p.text && Number.isFinite(p.startSeconds))
    .sort((a, b) => a.startSeconds - b.startSeconds);

  // 1) Lyric lines per section.
  if (!opts.syllablesOnly && layout.length) {
    const bySection = new Map<string, string[]>();
    for (const p of clean) {
      const span = sectionAt(toTick(p.startSeconds));
      if (!span) continue;
      const list = bySection.get(span.section.id) ?? [];
      list.push(p.text);
      bySection.set(span.section.id, list);
    }
    for (const span of layout) {
      const lines = bySection.get(span.section.id);
      if (!lines) continue;
      result.lines.push({ sectionId: span.section.id, sectionName: span.section.name, lines });
      result.operations.push({
        op: 'set_lyrics',
        section: span.section.id,
        lines,
        reason: 'lyrics transcribed from the recording',
      });
    }
  }

  // 2) Syllables on notes, by word timing.
  const words = clean
    .flatMap((p) => p.words ?? [])
    .filter((w) => (w.confidence ?? 1) >= (opts.minConfidence ?? 0));
  if (!words.length) {
    result.needsAlignment = clean.length > 0;
    return result;
  }
  const isLocked = lockChecker(song, track);
  const assigned = timedSyllables(
    song,
    track.notes.filter((n) => !isLocked(n)),
    words,
    {
      offsetSeconds: offset,
    },
  );
  result.matchedWords = assigned.matchedWords;
  result.unmatchedWords = assigned.unmatchedWords;
  const work: WorkNote[] = sortWork(track.notes.map(toWork));
  const free = work.filter((w) => !isLocked(track.notes.find((n) => n.id === w.id)!));
  for (const w of free) {
    const syl = assigned.syllables.get(w.id!);
    if (syl) w.syllable = syl;
    else delete w.syllable;
  }
  if (result.unmatchedWords.length)
    result.warnings.push(
      `${result.unmatchedWords.length} word${result.unmatchedWords.length === 1 ? '' : 's'} had no vocal note under them${
        result.unmatchedWords.length <= 6 ? ` (${result.unmatchedWords.join(', ')})` : ''
      }.`,
    );
  const lockedBars = new Set(track.notes.filter((n) => isLocked(n)).map((n) => barIndex(song, n.tick)));
  const skipped = free.filter((n) => n.syllable && lockedBars.has(barIndex(song, n.tick))).length;
  if (skipped)
    result.warnings.push(
      `${skipped} note${skipped === 1 ? '' : 's'} share${skipped === 1 ? 's' : ''} a bar with locked notes and kept ${
        skipped === 1 ? 'its' : 'their'
      } syllable${skipped === 1 ? '' : 's'}; unlock the bar to attach the words there.`,
    );
  const res = emitNoteOps(song, track, track.notes, work, {
    reason: 'attach transcribed lyrics to the notes they are sung on',
    maxGroups: 0,
  });
  result.operations.push(...res.ops);
  return result;
}
