/**
 * Lyrics-first composition: a song structure sized from lyrics supplied up front, and the lyrics
 * placed into the composed song's sections (as the user's own, locked words).
 *
 *   structureFromLyrics(lyrics, { tempo, meter })  sections whose length follows the lines
 *   matchLyricsToSections(lyricSections, sections)  which song section sings which stanza
 *   placeBlueprintLyrics(song, lyrics, seed)        LyricLines + lyric locks (used by composeSong)
 *   creditLyricWriter(project, name)                rights metadata: the user wrote the lyrics
 */
import type { BlueprintLyrics, BlueprintSection, LyricLine, Project, SectionKind, Song } from '../ir/types';
import { LockKeys } from '../locks';
import { IdFactory } from '../util/ids';
import { countSyllables } from '../musician/lyrics/syllables';
import { nameSections } from './blueprint';

/** Section kinds that carry no lyrics of their own when the structure is built around lyrics. */
export const INSTRUMENTAL_KINDS: readonly SectionKind[] = [
  'intro',
  'outro',
  'solo',
  'interlude',
  'breakdown',
  'build',
  'drop',
];

const INSTRUMENTAL_BARS: Partial<Record<SectionKind, number>> = {
  intro: 4,
  outro: 4,
  solo: 8,
  interlude: 4,
  breakdown: 8,
  build: 8,
  drop: 8,
};

export interface LyricsStructureOptions {
  tempo: number;
  meter?: { numerator: number; denominator: number };
  /** Instrumental intro: false = none, a number = bars (default: 4 bars, 2 when slow). Skipped when the lyrics start with an intro. */
  intro?: boolean | number;
  /** Instrumental outro: false = none, a number = bars (default 4). Skipped when the lyrics end with an outro. */
  outro?: boolean | number;
}

/** Syllables comfortably sung in one bar at a tempo (with room to breathe), at least 4. */
export function syllablesPerBar(
  tempo: number,
  meter: { numerator: number; denominator: number } = { numerator: 4, denominator: 4 },
): number {
  const beats = (meter.numerator * 4) / (meter.denominator || 4);
  const barSeconds = (beats * 60) / Math.max(30, tempo || 120);
  return Math.max(4, Math.round(barSeconds * 2.4));
}

/**
 * Bars for one stanza: one bar per line that fits in a bar at this tempo, two for longer lines;
 * rounded up to an even number of bars (minimum 2) so phrases stay paired.
 */
export function lyricSectionBars(
  lines: readonly string[],
  tempo: number,
  meter?: { numerator: number; denominator: number },
): number {
  const cap = syllablesPerBar(tempo, meter);
  let bars = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    bars += countSyllables(l) <= cap ? 1 : 2;
  }
  if (bars % 2) bars++;
  return Math.max(2, Math.min(64, bars));
}

const chorusLike = (k: SectionKind) => k === 'chorus' || k === 'final-chorus';

/**
 * Song structure from lyrics: one section per stanza (in order), sized by its lines and syllables,
 * plus an instrumental intro/outro when the lyrics do not open/close with one. The last chorus
 * (after the last verse) becomes the final chorus. Energies are left to the caller.
 */
export function structureFromLyrics(
  lyrics: Pick<BlueprintLyrics, 'sections'>,
  opts: LyricsStructureOptions,
): BlueprintSection[] {
  const meter = opts.meter ?? { numerator: 4, denominator: 4 };
  const out: { kind: SectionKind; bars: number }[] = lyrics.sections.map((s) => ({
    kind: s.kind,
    bars: s.lines.length ? lyricSectionBars(s.lines, opts.tempo, meter) : (INSTRUMENTAL_BARS[s.kind] ?? 4),
  }));
  if (!out.length) return [];
  const choruses = out.map((s, i) => (chorusLike(s.kind) ? i : -1)).filter((i) => i >= 0);
  const lastVerse = out.map((s) => s.kind).lastIndexOf('verse');
  const last = choruses[choruses.length - 1];
  if (choruses.length >= 2 && last > lastVerse && out[last].kind === 'chorus')
    out[last] = { ...out[last], kind: 'final-chorus' };
  if (opts.intro !== false && out[0].kind !== 'intro')
    out.unshift({
      kind: 'intro',
      bars: typeof opts.intro === 'number' ? opts.intro : opts.tempo <= 80 ? 2 : 4,
    });
  if (opts.outro !== false && out[out.length - 1].kind !== 'outro')
    out.push({ kind: 'outro', bars: typeof opts.outro === 'number' ? opts.outro : 4 });
  return nameSections(out);
}

/**
 * For each lyric stanza, the index of the section that sings it (or -1 when the structure has no
 * room left): stanzas are matched in order to the next section of the same kind (chorus ≈ final
 * chorus), else to the next section that is not instrumental.
 */
export function matchLyricsToSections(
  lyricSections: Pick<BlueprintLyrics['sections'][number], 'kind' | 'lines'>[],
  sections: readonly { kind: SectionKind }[],
): number[] {
  const used = new Set<number>();
  const wanted = new Set<SectionKind>(
    lyricSections
      .filter((s) => s.lines.length)
      .flatMap((s) => (chorusLike(s.kind) ? (['chorus', 'final-chorus'] as SectionKind[]) : [s.kind])),
  );
  let from = 0;
  return lyricSections.map((ls) => {
    if (!ls.lines.length) {
      // Instrumental stanza: consume a matching instrumental section if it is next in line.
      const j = sections.findIndex((s, k) => k >= from && !used.has(k) && s.kind === ls.kind);
      if (j >= 0 && j - from <= 1) {
        used.add(j);
        from = j + 1;
      }
      return -1;
    }
    const same = (k: SectionKind) =>
      k === ls.kind || (chorusLike(k) && chorusLike(ls.kind)) || k === 'custom' || ls.kind === 'custom';
    let j = sections.findIndex((s, k) => k >= from && !used.has(k) && same(s.kind));
    // No section of this kind left: borrow a free vocal section no stanza asks for by kind (never another stanza's place).
    if (j < 0)
      j = sections.findIndex(
        (s, k) => k >= from && !used.has(k) && !INSTRUMENTAL_KINDS.includes(s.kind) && !wanted.has(s.kind),
      );
    if (j < 0) return -1;
    used.add(j);
    from = j + 1;
    return j;
  });
}

/** The lead (melody) vocal track of a song, if any. */
export function leadVocalTrack(song: Pick<Song, 'tracks'>): Song['tracks'][number] | undefined {
  const vocals = song.tracks.filter((t) => t.role === 'vocal' && t.instrumentId !== 'choir');
  return (
    vocals.find((t) => t.constraints?.function === 'melody') ??
    vocals.find((t) => !t.constraints?.function && t.instrumentId === 'lead-vocal')
  );
}

/**
 * Put up-front lyrics into a (draft) song: one LyricLine per line in the section that sings the
 * stanza, on the lead vocal track, authored by the user ("human"), and lock each sung section's
 * lyrics unless `lyrics.lock === false`. Deterministic ids from the seed. Mutates `song`.
 * Returns the stanzas that found no section.
 */
export function placeBlueprintLyrics(
  song: Song,
  lyrics: BlueprintLyrics,
  seed: number,
): { placed: number; unplaced: string[] } {
  const ids = new IdFactory(seed, 'lyrics');
  const vocal = leadVocalTrack(song);
  const match = matchLyricsToSections(lyrics.sections, song.sections);
  const out: LyricLine[] = [];
  const unplaced: string[] = [];
  let placed = 0;
  const locks = { ...song.locks };
  lyrics.sections.forEach((ls, i) => {
    if (!ls.lines.length) return;
    const sec = song.sections[match[i]];
    if (!sec) {
      unplaced.push(ls.name);
      return;
    }
    for (const raw of ls.lines) {
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const line: LyricLine = { id: ids.next('ly'), sectionId: sec.id, text, author: 'human' };
      if (vocal) line.trackId = vocal.id;
      out.push(line);
    }
    placed++;
    if (lyrics.lock !== false) locks[LockKeys.sectionLyrics(sec.id)] = true;
  });
  // Keep song order: lines sorted by section position (stable within a section).
  const order = new Map(song.sections.map((s, i) => [s.id, i] as const));
  song.lyrics = [...song.lyrics.filter((l) => !out.some((o) => o.sectionId === l.sectionId)), ...out].sort(
    (a, b) => (order.get(a.sectionId) ?? 0) - (order.get(b.sectionId) ?? 0),
  );
  song.locks = locks;
  return { placed, unplaced };
}

/** Record `writer` (the user) as a lyric writer in the project's rights metadata (never removes anyone). */
export function creditLyricWriter(project: Project, writer: string): Project {
  const name = writer.trim();
  if (!name) return project;
  const cur = project.meta.rights.lyricWriters ?? [];
  if (cur.some((w) => w.toLowerCase() === name.toLowerCase())) return project;
  return {
    ...project,
    meta: { ...project.meta, rights: { ...project.meta.rights, lyricWriters: [...cur, name] } },
  };
}
