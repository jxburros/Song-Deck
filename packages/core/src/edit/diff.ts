import type { ChordEvent, Note, NoteChange, Song, SongDiff, TrackDiff } from '../ir/types';
import { channelFor, stableStringify } from '../ir/song-utils';
import { tickToBar } from '../timing';
import { keyName } from '../theory/scales';

function noteBody(n: Note): string {
  // Everything except the id.
  return JSON.stringify([
    n.pitch,
    n.tick,
    n.duration,
    n.velocity,
    n.articulation ?? null,
    n.syllable ?? null,
    n.phonemes ?? null,
    n.lyricLineId ?? null,
    n.expression ? stableStringify(n.expression) : null,
    n.locked ?? false,
    n.motifId ?? null,
    n.phraseId ?? null,
    n.confidence ?? null,
    n.origin ?? null,
  ]);
}

/** Note diff: match by id, then (for different ids) by identical pitch + onset. */
export function diffNotes(before: readonly Note[], after: readonly Note[]): { added: Note[]; removed: Note[]; modified: NoteChange[] } {
  const beforeById = new Map(before.map((n) => [n.id, n] as const));
  const pairs: [Note, Note][] = [];
  const unmatchedAfter: Note[] = [];
  const matchedBefore = new Set<Note>();
  for (const a of after) {
    const b = beforeById.get(a.id);
    if (b && !matchedBefore.has(b)) {
      pairs.push([b, a]);
      matchedBefore.add(b);
    } else unmatchedAfter.push(a);
  }
  const pool = new Map<string, Note[]>();
  for (const b of before) {
    if (matchedBefore.has(b)) continue;
    const key = `${b.pitch}|${b.tick}`;
    const list = pool.get(key);
    if (list) list.push(b);
    else pool.set(key, [b]);
  }
  const added: Note[] = [];
  for (const a of unmatchedAfter) {
    const list = pool.get(`${a.pitch}|${a.tick}`);
    const b = list?.shift();
    if (b) {
      pairs.push([b, a]);
      matchedBefore.add(b);
    } else added.push(a);
  }
  const removed = before.filter((b) => !matchedBefore.has(b));
  const modified: NoteChange[] = [];
  for (const [b, a] of pairs) if (noteBody(b) !== noteBody(a)) modified.push({ before: b, after: a });
  return { added, removed, modified };
}

function chordKey(c: ChordEvent): string {
  return `${c.tick}|${c.duration}|${c.root}|${c.quality}|${c.bass ?? ''}|${c.symbol}`;
}

function diffChords(before: readonly ChordEvent[], after: readonly ChordEvent[]): { added: ChordEvent[]; removed: ChordEvent[] } {
  const pool = new Map<string, ChordEvent[]>();
  for (const c of before) {
    const k = chordKey(c);
    const list = pool.get(k);
    if (list) list.push(c);
    else pool.set(k, [c]);
  }
  const added: ChordEvent[] = [];
  const kept = new Set<ChordEvent>();
  for (const c of after) {
    const list = pool.get(chordKey(c));
    if (!list?.length) {
      added.push(c);
      continue;
    }
    // Prefer the same id when several identical chords exist.
    const i = Math.max(0, list.findIndex((x) => x.id === c.id));
    kept.add(list.splice(i, 1)[0]);
  }
  return { added, removed: before.filter((c) => !kept.has(c)) };
}

function flatten(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out[prefix] = value;
  return out;
}

function sortedStr<T>(items: readonly T[], key: (t: T) => number): string {
  return stableStringify([...items].sort((a, b) => key(a) - key(b)));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function fmt(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v).replace('-', '−') : (Math.round(v * 100) / 100).toString().replace('-', '−');
  return String(v);
}

function barSpan(song: Song, ticks: number[]): [number, number] | undefined {
  if (!ticks.length) return undefined;
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of ticks) {
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return [tickToBar(song, lo).bar + 1, tickToBar(song, hi).bar + 1];
}

function mergeSpans(a?: [number, number], b?: [number, number]): [number, number] | undefined {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

function spanLabel(span?: [number, number]): string {
  if (!span) return '';
  return span[0] === span[1] ? ` (bar ${span[0]})` : ` (bars ${span[0]}–${span[1]})`;
}

/**
 * Structured diff of two songs (spec §21 "visual note diff"): per-track note changes, chord
 * changes, structure/tempo/key/meter/lyrics/automation flags, field-level mixer changes and
 * human-readable summary lines such as "Bass: +12 notes, −8 notes, 3 modified (bars 17–24)".
 */
export function diffSongs(before: Song, after: Song): SongDiff {
  const summary: string[] = [];
  const tracks: TrackDiff[] = [];
  const beforeTracks = new Map(before.tracks.map((t) => [t.id, t] as const));
  const afterIds = new Set(after.tracks.map((t) => t.id));
  const tracksAdded: string[] = [];
  const tracksRemoved: string[] = [];

  for (const t of after.tracks) {
    const b = beforeTracks.get(t.id);
    if (!b) {
      tracksAdded.push(t.id);
      tracks.push({ trackId: t.id, trackName: t.name, added: t.notes.slice(), removed: [], modified: [] });
      summary.push(`Added track "${t.name}"${t.notes.length ? ` (${plural(t.notes.length, 'note')})` : ''}`);
      continue;
    }
    const d = diffNotes(b.notes, t.notes);
    const renamed = b.name !== t.name;
    const instrumentChanged = b.instrumentId !== t.instrumentId;
    if (d.added.length || d.removed.length || d.modified.length) {
      tracks.push({ trackId: t.id, trackName: t.name, ...d });
      const parts: string[] = [];
      if (d.added.length) parts.push(`+${plural(d.added.length, 'note')}`);
      if (d.removed.length) parts.push(`−${plural(d.removed.length, 'note')}`);
      if (d.modified.length) parts.push(d.added.length || d.removed.length ? `${d.modified.length} modified` : `${plural(d.modified.length, 'note')} modified`);
      const span = mergeSpans(
        barSpan(after, [...d.added.map((n) => n.tick), ...d.modified.map((m) => m.after.tick)]),
        barSpan(before, [...d.removed.map((n) => n.tick), ...d.modified.map((m) => m.before.tick)]),
      );
      summary.push(`${t.name}: ${parts.join(', ')}${spanLabel(span)}`);
    }
    if (renamed) summary.push(`Track "${b.name}" renamed to "${t.name}"`);
    if (instrumentChanged) summary.push(`${t.name}: instrument ${b.instrumentId} → ${t.instrumentId}`);
    if (stableStringify(b.clips) !== stableStringify(t.clips)) summary.push(`${t.name}: audio clips changed`);
  }
  for (const b of before.tracks) {
    if (afterIds.has(b.id)) continue;
    tracksRemoved.push(b.id);
    tracks.push({ trackId: b.id, trackName: b.name, added: [], removed: b.notes.slice(), modified: [] });
    summary.push(`Removed track "${b.name}"${b.notes.length ? ` (${plural(b.notes.length, 'note')})` : ''}`);
  }

  // Chords
  const chords = diffChords(before.chords, after.chords);
  if (chords.added.length || chords.removed.length) {
    const span = mergeSpans(barSpan(after, chords.added.map((c) => c.tick)), barSpan(before, chords.removed.map((c) => c.tick)));
    const parts: string[] = [];
    if (chords.added.length) parts.push(`+${plural(chords.added.length, 'chord')}`);
    if (chords.removed.length) parts.push(`−${plural(chords.removed.length, 'chord')}`);
    summary.push(`Chords: ${parts.join(', ')}${spanLabel(span)}`);
  }

  // Structure
  const sectionsChanged = stableStringify(before.sections) !== stableStringify(after.sections);
  if (sectionsChanged) summary.push(...describeStructure(before, after));

  const tempoChanged = sortedStr(before.tempoMap, (t) => t.tick) !== sortedStr(after.tempoMap, (t) => t.tick);
  if (tempoChanged) {
    const b0 = [...before.tempoMap].sort((x, y) => x.tick - y.tick)[0];
    const a0 = [...after.tempoMap].sort((x, y) => x.tick - y.tick)[0];
    if (b0 && a0 && b0.bpm !== a0.bpm && before.tempoMap.length === 1 && after.tempoMap.length === 1) summary.push(`Tempo: ${fmt(b0.bpm)} → ${fmt(a0.bpm)} BPM`);
    else summary.push('Tempo map changed');
  }
  const keyChanged = sortedStr(before.keyMap, (k) => k.bar) !== sortedStr(after.keyMap, (k) => k.bar);
  if (keyChanged) {
    const b0 = [...before.keyMap].sort((x, y) => x.bar - y.bar)[0];
    const a0 = [...after.keyMap].sort((x, y) => x.bar - y.bar)[0];
    if (b0 && a0 && (b0.key.tonic !== a0.key.tonic || b0.key.mode !== a0.key.mode)) summary.push(`Key: ${keyName(b0.key)} → ${keyName(a0.key)}`);
    else summary.push('Key changes edited');
  }
  const meterChanged = sortedStr(before.meterMap, (m) => m.bar) !== sortedStr(after.meterMap, (m) => m.bar);
  if (meterChanged) {
    const b0 = [...before.meterMap].sort((x, y) => x.bar - y.bar)[0];
    const a0 = [...after.meterMap].sort((x, y) => x.bar - y.bar)[0];
    if (b0 && a0 && (b0.numerator !== a0.numerator || b0.denominator !== a0.denominator) && before.meterMap.length === 1 && after.meterMap.length === 1) {
      summary.push(`Meter: ${b0.numerator}/${b0.denominator} → ${a0.numerator}/${a0.denominator}`);
    } else summary.push('Meter changes edited');
  }
  const lyricsChanged = stableStringify(before.lyrics) !== stableStringify(after.lyrics);
  if (lyricsChanged) {
    const names: string[] = [];
    const ids = new Set([...before.lyrics.map((l) => l.sectionId), ...after.lyrics.map((l) => l.sectionId)]);
    for (const sid of ids) {
      const a = stableStringify(before.lyrics.filter((l) => l.sectionId === sid).map((l) => l.text));
      const b = stableStringify(after.lyrics.filter((l) => l.sectionId === sid).map((l) => l.text));
      if (a !== b) names.push(after.sections.find((s) => s.id === sid)?.name ?? before.sections.find((s) => s.id === sid)?.name ?? sid);
    }
    summary.push(names.length ? `Lyrics changed: ${names.join(', ')}` : 'Lyrics metadata changed');
  }

  // Mixer
  const mixerChanged: SongDiff['mixerChanged'] = [];
  const common = after.tracks.filter((t) => beforeTracks.has(t.id)).map((t) => t.id);
  for (const id of common) {
    const fb = flatten(channelFor(before, id));
    const fa = flatten(channelFor(after, id));
    for (const field of new Set([...Object.keys(fb), ...Object.keys(fa)])) {
      if (!Object.is(fb[field], fa[field]) && stableStringify(fb[field]) !== stableStringify(fa[field])) mixerChanged.push({ target: id, field, before: fb[field], after: fa[field] });
    }
  }
  {
    const fb = flatten({ ...before.mixer.master, reverb: before.mixer.reverb, delay: before.mixer.delay });
    const fa = flatten({ ...after.mixer.master, reverb: after.mixer.reverb, delay: after.mixer.delay });
    for (const field of new Set([...Object.keys(fb), ...Object.keys(fa)])) {
      if (stableStringify(fb[field]) !== stableStringify(fa[field])) mixerChanged.push({ target: 'master', field, before: fb[field], after: fa[field] });
    }
  }
  const byTarget = new Map<string, typeof mixerChanged>();
  for (const m of mixerChanged) {
    const list = byTarget.get(m.target) ?? [];
    list.push(m);
    byTarget.set(m.target, list);
  }
  for (const [target, list] of byTarget) {
    const name = target === 'master' ? 'Master' : (after.tracks.find((t) => t.id === target)?.name ?? target);
    const shown = list.slice(0, 4).map((m) => `${m.field} ${fmt(m.before)} → ${fmt(m.after)}`);
    summary.push(`Mixer ${name}: ${shown.join(', ')}${list.length > 4 ? `, +${list.length - 4} more` : ''}`);
  }

  const automationChanged = stableStringify(before.automation) !== stableStringify(after.automation);
  if (automationChanged) summary.push('Automation changed');
  if (stableStringify(before.locks) !== stableStringify(after.locks)) summary.push('Locks changed');
  if (stableStringify(before.macros) !== stableStringify(after.macros)) summary.push('Song macros changed');

  if (!summary.length) summary.push('No changes');
  return {
    tracks,
    chords,
    sectionsChanged,
    tempoChanged,
    keyChanged,
    meterChanged,
    lyricsChanged,
    mixerChanged,
    automationChanged,
    tracksAdded,
    tracksRemoved,
    summary,
  };
}

function describeStructure(before: Song, after: Song): string[] {
  const out: string[] = [];
  const b = new Map(before.sections.map((s) => [s.id, s] as const));
  const a = new Map(after.sections.map((s) => [s.id, s] as const));
  const added = after.sections.filter((s) => !b.has(s.id)).map((s) => `"${s.name}" (${plural(s.bars, 'bar')})`);
  const removed = before.sections.filter((s) => !a.has(s.id)).map((s) => `"${s.name}"`);
  if (added.length) out.push(`Structure: added ${added.join(', ')}`);
  if (removed.length) out.push(`Structure: removed ${removed.join(', ')}`);
  const resized: string[] = [];
  const renamed: string[] = [];
  const edited: string[] = [];
  for (const s of after.sections) {
    const old = b.get(s.id);
    if (!old) continue;
    if (old.bars !== s.bars) resized.push(`"${s.name}" ${old.bars} → ${s.bars} bars`);
    if (old.name !== s.name) renamed.push(`"${old.name}" → "${s.name}"`);
    else if (stableStringify({ ...old, bars: 0 }) !== stableStringify({ ...s, bars: 0 })) edited.push(`"${s.name}"`);
  }
  if (resized.length) out.push(`Structure: ${resized.join(', ')}`);
  if (renamed.length) out.push(`Structure: renamed ${renamed.join(', ')}`);
  const commonOrderBefore = before.sections.filter((s) => a.has(s.id)).map((s) => s.id).join('|');
  const commonOrderAfter = after.sections.filter((s) => b.has(s.id)).map((s) => s.id).join('|');
  if (commonOrderBefore !== commonOrderAfter) out.push('Structure: sections reordered');
  if (edited.length) out.push(`Sections edited: ${edited.join(', ')}`);
  if (!out.length) out.push('Structure changed');
  return out;
}
