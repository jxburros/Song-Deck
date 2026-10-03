import type { LyricLine, MusicOperation, Note, Song, Track } from '../../ir/types';
import { sectionLayout, tickToMusical } from '../../timing';
import { findTrack } from '../../ir/song-utils';
import { beatTicks, emitNoteOps, lockChecker, sortWork, toWork, type WorkNote } from '../op-helpers';
import { lyricTokens } from './syllables';
import type { AlignLyricsOptions, LyricAlignmentEntry, LyricAlignmentResult } from '../types';

/**
 * Lyrics ↔ vocal-note alignment (spec §33-§35, §48 "lyrics align with vocal events").
 * Syllables are attached to notes (OpNote.syllable); word continuations carry a trailing "-"
 * ("ca-", "thar-", "tic") and melisma continuation notes carry "_".
 */

interface Token {
  text: string;
  word: number;
}

function tokensFor(line: LyricLine): Token[] {
  return lyricTokens(line.text).map((t) => ({ text: t.text, word: t.wordIndex }));
}

/** Partition the section's notes into one contiguous group per lyric line. */
export function groupNotesByLine(song: Song, notes: Note[], lines: LyricLine[]): Note[][] {
  return groupNotes(song, notes, lines, lines.map(tokensFor));
}

/** Syllables for notes: existing note syllables, else a provisional alignment of the lyric lines. */
export function provisionalSyllables(song: Song, track: Track, notes: Note[], lines: LyricLine[]): Map<string, string> {
  const out = new Map<string, string>();
  if (notes.some((n) => n.syllable)) {
    for (const n of notes) if (n.syllable) out.set(n.id, n.syllable);
    return out;
  }
  if (!lines.length) return out;
  const tokens = lines.map(tokensFor);
  const groups = groupNotes(song, notes, lines, tokens);
  groups.forEach((g, i) => {
    const assigned = assign(song, g.map(toWork), tokens[i]);
    assigned.forEach((w) => w.id && w.syllable && out.set(w.id, w.syllable));
  });
  void track;
  return out;
}

function groupNotes(song: Song, notes: Note[], lines: LyricLine[], tokens: Token[][]): Note[][] {
  const L = lines.length;
  if (L === 0) return [];
  // 1) Explicit lyricLineId on notes.
  const byId = lines.map((l) => notes.filter((n) => n.lyricLineId === l.id));
  if (byId.every((g) => g.length > 0) && byId.reduce((s, g) => s + g.length, 0) === notes.length) return byId;
  // 2) Phrases tagged with a lyric line.
  const phraseGroups = lines.map((l) => {
    const ph = song.phrases.find((p) => p.lyricLineId === l.id);
    return ph ? notes.filter((n) => n.tick >= ph.startTick && n.tick < ph.endTick) : [];
  });
  if (phraseGroups.every((g) => g.length > 0) && phraseGroups.reduce((s, g) => s + g.length, 0) === notes.length) return phraseGroups;
  // 3) Dynamic programming: match syllable counts, prefer cuts at rests.
  const n = notes.length;
  const syl = tokens.map((t) => t.length);
  const cut = (i: number) => {
    if (i <= 0 || i >= n) return 0;
    const beat = beatTicks(song, notes[i].tick);
    const gap = notes[i].tick - (notes[i - 1].tick + notes[i - 1].duration);
    if (gap >= beat) return 0;
    if (gap >= beat / 2) return 1;
    if (gap > beat / 8) return 4;
    return 10;
  };
  const INF = 1e9;
  const dp: number[][] = Array.from({ length: L + 1 }, () => new Array(n + 1).fill(INF));
  const from: number[][] = Array.from({ length: L + 1 }, () => new Array(n + 1).fill(-1));
  dp[0][0] = 0;
  for (let l = 1; l <= L; l++) {
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= j; i++) {
        if (dp[l - 1][i] >= INF) continue;
        const size = j - i;
        if (size === 0 && n >= L) continue;
        const cost = dp[l - 1][i] + Math.abs(size - syl[l - 1]) * 1.5 + (l > 1 ? cut(i) : 0);
        if (cost < dp[l][j]) {
          dp[l][j] = cost;
          from[l][j] = i;
        }
      }
    }
  }
  const groups: Note[][] = [];
  let j = n;
  for (let l = L; l >= 1; l--) {
    const i = Math.max(0, from[l][j]);
    groups.unshift(notes.slice(i, j));
    j = i;
  }
  return groups;
}

/** Merge adjacent syllables until `target` remain (same-word merges first). */
function mergeTokens(tokens: Token[], target: number): Token[] {
  const t = tokens.map((x) => ({ ...x }));
  while (t.length > Math.max(1, target)) {
    let best = 0;
    let bestCost = Infinity;
    for (let i = 0; i + 1 < t.length; i++) {
      const cost = (t[i].word === t[i + 1].word ? 0 : 2) + (t[i].text.length + t[i + 1].text.length) / 10;
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    const a = t[best];
    const b = t[best + 1];
    const text = a.word === b.word ? a.text.replace(/-$/, '') + b.text : `${a.text.replace(/-$/, '')} ${b.text}`;
    t.splice(best, 2, { text, word: b.word });
  }
  return t;
}

/** Choose which notes become melisma continuations ("_") when there are more notes than syllables. */
function melismaSlots(song: Song, notes: WorkNote[], extra: number): Set<number> {
  const scored: { i: number; s: number }[] = [];
  for (let i = 1; i < notes.length; i++) {
    const beat = beatTicks(song, notes[i].tick);
    const gap = notes[i].tick - (notes[i - 1].tick + notes[i - 1].duration);
    let s = 0;
    if (gap <= beat / 8) s += 2;
    if (Math.abs(notes[i].pitch - notes[i - 1].pitch) <= 2) s += 2;
    if (notes[i].duration <= beat / 2) s += 1;
    s += i / notes.length;
    scored.push({ i, s });
  }
  scored.sort((a, b) => b.s - a.s || b.i - a.i);
  return new Set(scored.slice(0, extra).map((x) => x.i));
}

function assign(song: Song, notes: WorkNote[], tokens: Token[]): WorkNote[] {
  const out = notes.map((n) => ({ ...n }));
  if (!out.length) return out;
  let toks = tokens;
  if (toks.length > out.length) toks = mergeTokens(toks, out.length);
  const extra = out.length - toks.length;
  const mel = extra > 0 ? melismaSlots(song, out, extra) : new Set<number>();
  let k = 0;
  for (let i = 0; i < out.length; i++) {
    if (mel.has(i) || k >= toks.length) out[i].syllable = '_';
    else out[i].syllable = toks[k++].text;
  }
  return out;
}

function fitRhythm(song: Song, notes: WorkNote[], tokens: Token[]): WorkNote[] {
  let out = sortWork(notes.map((n) => ({ ...n })));
  const target = tokens.length;
  if (!out.length || !target) return assign(song, out, tokens);
  // Too few notes: split the longest notes (same pitch, so the contour is preserved).
  let guard = 0;
  while (out.length < target && guard++ < 256) {
    let li = -1;
    for (let i = 0; i < out.length; i++) if (li < 0 || out[i].duration > out[li].duration) li = i;
    const n = out[li];
    const minLen = beatTicks(song, n.tick) / 4;
    if (n.duration < minLen * 2) break;
    const grid = minLen;
    const half = Math.max(grid, Math.round(Math.round(n.duration / grid) / 2) * grid);
    const second: WorkNote = { pitch: n.pitch, tick: n.tick + half, duration: n.duration - half, velocity: Math.max(1, n.velocity - 4) };
    if (n.expression) second.expression = { ...n.expression };
    out[li] = { ...n, duration: half - Math.round(minLen / 8) };
    out.splice(li + 1, 0, second);
  }
  // Too many notes: merge the smoothest adjacent pairs.
  guard = 0;
  while (out.length > target && guard++ < 256) {
    let bi = -1;
    let bc = Infinity;
    for (let i = 0; i + 1 < out.length; i++) {
      const c = Math.abs(out[i + 1].pitch - out[i].pitch) * 2 + out[i + 1].duration / beatTicks(song, out[i + 1].tick);
      if (c < bc) {
        bc = c;
        bi = i;
      }
    }
    const a = out[bi];
    const b = out[bi + 1];
    out[bi] = { ...a, duration: b.tick + b.duration - a.tick };
    out.splice(bi + 1, 1);
  }
  out = sortWork(out);
  return assign(song, out, tokens);
}

export function alignLyrics(song: Song, trackId: string, opts: AlignLyricsOptions = {}): LyricAlignmentResult {
  const track: Track | undefined = song.tracks.find((t) => t.id === trackId) ?? findTrack(song, trackId);
  const report: LyricAlignmentEntry[] = [];
  const warnings: string[] = [];
  if (!track) return { operations: [], report, warnings: [`There is no track "${trackId}".`] };
  const mode = opts.mode ?? 'assign';
  const isL = lockChecker(song, track);
  const work: WorkNote[] = track.notes.map(toWork);
  const byId = new Map(work.map((w) => [w.id!, w]));
  const replaced = new Map<WorkNote, WorkNote[]>();
  let touched = false;
  for (const span of sectionLayout(song)) {
    if (opts.sectionIds && !opts.sectionIds.includes(span.section.id)) continue;
    const lines = song.lyrics.filter((l) => l.sectionId === span.section.id && (!l.trackId || l.trackId === track.id));
    if (!lines.length) continue;
    const notes = track.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick).sort((a, b) => a.tick - b.tick || b.pitch - a.pitch);
    const tokens = lines.map(tokensFor);
    if (!notes.length) {
      warnings.push(`${span.section.name}: no vocal notes to sing ${lines.length} lyric line${lines.length === 1 ? '' : 's'}.`);
      lines.forEach((l, i) => report.push({ sectionId: span.section.id, lineId: l.id, syllables: tokens[i].length, notes: 0, status: 'too-many-syllables' }));
      continue;
    }
    const groups = groupNotes(song, notes, lines, tokens);
    lines.forEach((l, i) => {
      const s = tokens[i].length;
      const k = groups[i]?.length ?? 0;
      report.push({ sectionId: span.section.id, lineId: l.id, syllables: s, notes: k, status: s === k ? 'aligned' : s > k ? 'too-many-syllables' : 'too-few-syllables' });
    });
    const lockedHere = notes.filter((n) => isL(n)).length;
    if (lockedHere) {
      warnings.push(`${span.section.name}: ${lockedHere} locked vocal note${lockedHere === 1 ? '' : 's'} — syllables were not re-assigned there.`);
      continue;
    }
    groups.forEach((g, i) => {
      if (!g.length) return;
      const ws = g.map((n) => byId.get(n.id)!);
      const res = mode === 'fit-rhythm' ? fitRhythm(song, ws, tokens[i]) : assign(song, ws, tokens[i]);
      // Attach the whole group's result to its first note so the replacement keeps order.
      replaced.set(ws[0], res);
      for (const w of ws.slice(1)) replaced.set(w, []);
      touched = true;
    });
  }
  if (!touched) return { operations: [], report, warnings };
  const final: WorkNote[] = [];
  for (const w of work) {
    const r = replaced.get(w);
    if (r) final.push(...r);
    else final.push(w);
  }
  const res = emitNoteOps(song, track, track.notes, sortWork(final), { reason: mode === 'fit-rhythm' ? 'fit vocal rhythm to lyric syllables' : 'attach lyric syllables to vocal notes', maxGroups: 0 });
  const ops: MusicOperation[] = res.ops;
  return { operations: ops, report, warnings };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function normWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .split(/[^a-z']+/)
    .filter(Boolean);
}

/** Words sung by a sequence of syllables ("ca-", "thar-", "tic" → "cathartic"; "_" ignored). */
function sungWords(notes: Note[]): string[] {
  const words: string[] = [];
  let cur = '';
  for (const n of notes) {
    const s = (n.syllable ?? '').trim();
    if (!s || s === '_' || s === '-') continue;
    const parts = s.split(/\s+/);
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      const cont = part.endsWith('-');
      cur += part.replace(/^-|-$/g, '');
      if (!cont || p < parts.length - 1) {
        words.push(...normWords(cur));
        cur = '';
      }
    }
  }
  if (cur) words.push(...normWords(cur));
  return words;
}

function barOf(song: Song, tick: number): number {
  return tickToMusical(song, tick).bar;
}

export function validateLyricAlignment(song: Song, trackId: string): { ok: boolean; issues: string[] } {
  const track = song.tracks.find((t) => t.id === trackId) ?? findTrack(song, trackId);
  if (!track) return { ok: false, issues: [`There is no track "${trackId}".`] };
  const issues: string[] = [];
  const layout = sectionLayout(song);
  for (const span of layout) {
    const lines = song.lyrics.filter((l) => l.sectionId === span.section.id && (!l.trackId || l.trackId === track.id));
    const notes = track.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick).sort((a, b) => a.tick - b.tick || b.pitch - a.pitch);
    const name = span.section.name;
    if (!lines.length) {
      const withSyl = notes.filter((n) => n.syllable && n.syllable !== '_').length;
      if (withSyl) issues.push(`${name}: ${withSyl} note${withSyl === 1 ? '' : 's'} carry syllables but the section has no lyric lines.`);
      continue;
    }
    const expected = lines.reduce((s, l) => s + lyricTokens(l.text).length, 0);
    if (!notes.length) {
      issues.push(`${name}: ${lines.length} lyric line${lines.length === 1 ? '' : 's'} (${expected} syllables) but no vocal notes.`);
      continue;
    }
    const missing = notes.filter((n) => !n.syllable || !n.syllable.trim()).length;
    if (missing) issues.push(`${name}: ${missing} vocal note${missing === 1 ? ' has' : 's have'} no syllable.`);
    const sung = notes.filter((n) => n.syllable && n.syllable !== '_' && n.syllable !== '-').length;
    if (sung !== expected) issues.push(`${name}: the lyrics have ${expected} syllables but ${sung} notes carry syllables.`);
    const want = lines.flatMap((l) => normWords(l.text));
    const got = sungWords(notes);
    if (sung && want.join(' ') !== got.join(' ')) {
      const firstDiff = want.findIndex((w, i) => got[i] !== w);
      issues.push(`${name}: the sung words differ from the lyric text${firstDiff >= 0 ? ` (expected "${want[firstDiff]}", found "${got[firstDiff] ?? '—'}")` : ''}.`);
    }
    // Melisma marks must continue a syllable, not start a phrase.
    notes.forEach((n, i) => {
      if (n.syllable !== '_') return;
      const prev = notes[i - 1];
      const beat = beatTicks(song, n.tick);
      if (!prev || n.tick - (prev.tick + prev.duration) >= beat) issues.push(`${name}: a melisma "_" starts a phrase at bar ${barOf(song, n.tick)} (it has no syllable to continue).`);
    });
    // A single voice cannot sing overlapping notes.
    for (let i = 1; i < notes.length; i++) {
      const prev = notes[i - 1];
      const overlap = prev.tick + prev.duration - notes[i].tick;
      if (overlap > beatTicks(song, notes[i].tick) / 16) {
        issues.push(`${name}: overlapping vocal notes at bar ${barOf(song, notes[i].tick)} — a single voice cannot sing both.`);
        break;
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

