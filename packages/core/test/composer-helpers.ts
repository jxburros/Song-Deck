/** Shared assertions for the composer test suites (not a test file itself). */
import { getInstrument } from '../src/composer';
import { songLengthTicks } from '../src/timing';
import { parseChordSymbol } from '../src/theory/chords';
import type { Song } from '../src/ir/types';

/** Every invariant generated material must satisfy. */
export function validityProblems(song: Song): string[] {
  const out: string[] = [];
  const end = songLengthTicks(song);
  for (const t of song.tracks) {
    const inst = getInstrument(t.instrumentId);
    const ids = new Set<string>();
    for (let i = 0; i < t.notes.length; i++) {
      const n = t.notes[i];
      if (ids.has(n.id)) out.push(`${t.name}: duplicate id ${n.id}`);
      ids.add(n.id);
      if (!Number.isInteger(n.pitch) || n.pitch < 0 || n.pitch > 127) out.push(`${t.name}: pitch ${n.pitch}`);
      if (!inst.isDrumKit && (n.pitch < inst.range.low || n.pitch > inst.range.high))
        out.push(`${t.name}: ${n.pitch} outside ${inst.range.low}-${inst.range.high}`);
      if (t.constraints.lowest !== undefined && n.pitch < t.constraints.lowest)
        out.push(`${t.name}: below constraint`);
      if (t.constraints.highest !== undefined && n.pitch > t.constraints.highest)
        out.push(`${t.name}: above constraint`);
      if (!Number.isInteger(n.velocity) || n.velocity < 1 || n.velocity > 127)
        out.push(`${t.name}: velocity ${n.velocity}`);
      if (!Number.isInteger(n.duration) || n.duration <= 0) out.push(`${t.name}: duration ${n.duration}`);
      if (!Number.isInteger(n.tick) || n.tick < 0 || n.tick + n.duration > end)
        out.push(`${t.name}: outside song ${n.tick}+${n.duration}`);
      if (i > 0) {
        const p = t.notes[i - 1];
        if (p.tick > n.tick || (p.tick === n.tick && p.pitch > n.pitch))
          out.push(`${t.name}: unsorted at ${n.tick}`);
      }
    }
    const lastEnd = new Map<number, number>();
    for (const n of t.notes) {
      if ((lastEnd.get(n.pitch) ?? -1) > n.tick) {
        out.push(`${t.name}: same-pitch overlap at ${n.tick}`);
        break;
      }
      lastEnd.set(n.pitch, n.tick + n.duration);
    }
    if (inst.polyphony === 'mono' && !inst.isDrumKit) {
      for (let i = 1; i < t.notes.length; i++)
        if (t.notes[i].tick < t.notes[i - 1].tick + t.notes[i - 1].duration)
          out.push(`${t.name}: overlap at ${t.notes[i].tick}`);
    }
  }
  let cursor = 0;
  for (const c of song.chords) {
    if (c.tick !== cursor) out.push(`chords not contiguous at ${c.tick}`);
    if (!(c.duration > 0)) out.push(`chord duration ${c.duration}`);
    const parsed = parseChordSymbol(c.symbol);
    if (!parsed || parsed.root !== c.root || parsed.quality !== c.quality)
      out.push(`chord symbol ${c.symbol} disagrees`);
    cursor = c.tick + c.duration;
  }
  if (cursor !== end) out.push(`chords end at ${cursor}, song at ${end}`);
  const bad: string[] = [];
  findNonFinite(song, 'song', bad);
  if (bad.length) out.push(`NaN/null in song: ${bad.slice(0, 3).join(', ')}`);
  return out;
}

function findNonFinite(o: unknown, path: string, out: string[]): void {
  if (out.length > 3) return;
  if (o === null || (typeof o === 'number' && !Number.isFinite(o))) {
    out.push(path);
    return;
  }
  if (Array.isArray(o)) o.forEach((x, i) => findNonFinite(x, `${path}[${i}]`, out));
  else if (o && typeof o === 'object')
    for (const [k, v] of Object.entries(o)) findNonFinite(v, `${path}.${k}`, out);
}
