import type { ChordEvent, Note, Song } from '../ir/types';
import {
  barLengthTicks,
  barToTick,
  bpmAtTick,
  chordAtTick,
  keyAtBar,
  meterAtBar,
  sectionLayout,
  ticksPerBeat,
} from '../timing';
import { keyName } from '../theory/scales';
import { syllablesToWords } from '../edit/validate';
import { leadTrack } from './util';

const BARS_PER_LINE = 4;

function formatBpm(bpm: number): string {
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1);
}

/**
 * Plain-text chord chart (spec §55 "chord sheet"):
 *
 *   [Verse 1] (8 bars)
 *   | Em . . . | C . . . | G . . . | D . . . |
 *     i          VI        III       VII
 */
export function songToChordSheet(song: Song): string {
  const lines: string[] = [];
  const title = song.title || 'Untitled';
  lines.push(title);
  lines.push('='.repeat(Math.max(3, title.length)));
  const firstKey = keyAtBar(song, 0);
  const meter = meterAtBar(song, 0);
  lines.push(
    `Key: ${keyName(firstKey)} · Tempo: ${formatBpm(bpmAtTick(song, 0))} BPM · Time: ${meter.numerator}/${meter.denominator}`,
  );
  lines.push('');
  let prevKey = firstKey;
  let prevMeter = `${meter.numerator}/${meter.denominator}`;
  let prevBpm = bpmAtTick(song, 0);
  for (const span of sectionLayout(song)) {
    const bars = span.endBar - span.startBar;
    if (bars <= 0) continue;
    const key = keyAtBar(song, span.startBar);
    const m = meterAtBar(song, span.startBar);
    const bpm = bpmAtTick(song, span.startTick);
    const notes: string[] = [];
    if (key.tonic !== prevKey.tonic || key.mode !== prevKey.mode) notes.push(`key: ${keyName(key)}`);
    if (`${m.numerator}/${m.denominator}` !== prevMeter) notes.push(`time: ${m.numerator}/${m.denominator}`);
    if (bpm !== prevBpm) notes.push(`tempo: ${formatBpm(bpm)} BPM`);
    prevKey = key;
    prevMeter = `${m.numerator}/${m.denominator}`;
    prevBpm = bpm;
    lines.push(
      `[${span.section.name}] (${bars} bar${bars === 1 ? '' : 's'})${notes.length ? ` — ${notes.join(', ')}` : ''}`,
    );
    // Build slot grids: one slot per beat.
    const barCells: { symbols: string[]; romans: string[] }[] = [];
    let width = 1;
    for (let bar = span.startBar; bar < span.endBar; bar++) {
      const meterHere = meterAtBar(song, bar);
      const start = barToTick(song, bar);
      const beat = ticksPerBeat(meterHere.denominator, song.ppq);
      const slots = Math.max(1, Math.round(barLengthTicks(meterHere, song.ppq) / beat));
      const symbols: string[] = [];
      const romans: string[] = [];
      for (let k = 0; k < slots; k++) {
        const a = start + k * beat;
        const starting = song.chords
          .filter((c) => c.tick >= a && c.tick < a + beat)
          .sort((x, y) => x.tick - y.tick);
        let chord: ChordEvent | undefined = starting[0];
        if (!chord && k === 0) chord = chordAtTick(song, a);
        if (chord) {
          symbols.push(starting.length > 1 ? starting.map((c) => c.symbol).join(' ') : chord.symbol);
          romans.push(
            starting.length > 1 ? starting.map((c) => c.roman ?? '').join(' ') : (chord.roman ?? ''),
          );
        } else {
          symbols.push(k === 0 ? 'N.C.' : '.');
          romans.push('');
        }
      }
      for (const s of symbols) width = Math.max(width, s.length);
      for (const r of romans) width = Math.max(width, r.length);
      barCells.push({ symbols, romans });
    }
    for (let i = 0; i < barCells.length; i += BARS_PER_LINE) {
      const group = barCells.slice(i, i + BARS_PER_LINE);
      const chordLine =
        group.map((b) => `| ${b.symbols.map((s) => s.padEnd(width)).join(' ')} `).join('') + '|';
      const romanLine = group.map((b) => `  ${b.romans.map((s) => s.padEnd(width)).join(' ')} `).join('');
      lines.push(chordLine);
      if (romanLine.trim()) lines.push(romanLine.replace(/\s+$/, ''));
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

/** Lyric lines per section; falls back to syllables sung on the lead vocal track. */
export function lyricLinesBySection(song: Song): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of song.lyrics) {
    const list = out.get(line.sectionId) ?? [];
    list.push(line.text);
    out.set(line.sectionId, list);
  }
  if (out.size) return out;
  const track = leadTrack(song);
  if (!track) return out;
  for (const span of sectionLayout(song)) {
    const notes = track.notes.filter((n) => n.syllable && n.tick >= span.startTick && n.tick < span.endTick);
    if (!notes.length) continue;
    // Group by lyric line id, else by rests of two beats or more.
    const groups: Note[][] = [];
    let cur: Note[] = [];
    let prevEnd = -Infinity;
    let prevLine: string | undefined;
    for (const n of notes) {
      const newLine =
        cur.length && ((n.lyricLineId ?? null) !== (prevLine ?? null) || n.tick - prevEnd >= 2 * song.ppq);
      if (newLine) {
        groups.push(cur);
        cur = [];
      }
      cur.push(n);
      prevEnd = n.tick + n.duration;
      prevLine = n.lyricLineId;
    }
    if (cur.length) groups.push(cur);
    out.set(
      span.section.id,
      groups.map((g) => syllablesToWords(g.map((n) => n.syllable ?? '')).join(' ')).filter(Boolean),
    );
  }
  return out;
}

/** Plain-text lyric sheet: title, then each section with its lyric lines. */
export function songToLyricSheet(song: Song): string {
  const lines: string[] = [];
  const title = song.title || 'Untitled';
  lines.push(title);
  lines.push('='.repeat(Math.max(3, title.length)));
  lines.push('');
  const bySection = lyricLinesBySection(song);
  let any = false;
  for (const section of song.sections) {
    const text = bySection.get(section.id);
    if (!text?.length) continue;
    any = true;
    lines.push(`[${section.name}]`);
    lines.push(...text);
    lines.push('');
  }
  if (!any) lines.push('(no lyrics)', '');
  return lines.join('\n').replace(/\n+$/, '\n');
}
