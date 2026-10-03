import type { LyricLine, Section, SectionKind, Song } from '../ir/types';
import { sectionLayout, songLengthBars } from '../timing';
import { lyricsProtected } from './locks-check';
import { resolveSection, type OpContext } from './op-context';
import { restructure, type Segment } from './structure';
import { SECTION_FEELS, SECTION_KINDS, clampNum, isRecord, oneOf, toInt, toNumber, toStr } from './util';

type RawOp = Record<string, unknown>;

const MAX_SECTION_BARS = 512;

function kindLabel(kind: SectionKind): string {
  return kind
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('-');
}

function uniqueSectionName(song: Song, name: string): string {
  const names = new Set(song.sections.map((s) => s.name.toLowerCase()));
  if (!names.has(name.toLowerCase())) return name;
  const base = name.replace(/\s+\d+$/, '');
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${name} (copy)`;
}

function applyRestructure(song: Song, segments: Segment[], sections: Section[], c: OpContext, extra: Parameters<typeof restructure>[3] = { ids: c.ids }) {
  const res = restructure(song, segments, sections, { ...extra, ids: c.ids });
  Object.assign(song, res.song);
  return res.stats;
}

export function opUpdateSection(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'update_section';
  const section = resolveSection(song, op.section, c, name);
  if (!section) return false;
  const ch = op.changes;
  if (!isRecord(ch)) {
    c.error('op.malformed', `${name}: "changes" must be an object.`, { sectionId: section.id });
    return false;
  }
  const next: Partial<Section> = {};
  const bad = (field: string) => c.warn('section.invalid', `${name}: invalid "${field}" ignored.`, { sectionId: section.id });
  if (ch.name !== undefined) {
    const v = toStr(ch.name)?.trim();
    if (v) next.name = v;
    else bad('name');
  }
  if (ch.kind !== undefined) {
    const v = oneOf(ch.kind, SECTION_KINDS);
    if (v) next.kind = v;
    else bad('kind');
  }
  for (const f of ['energy', 'energyEnd'] as const) {
    if (ch[f] === undefined) continue;
    const v = toNumber(ch[f]);
    if (v === undefined) bad(f);
    else next[f] = clampNum(v, 0, 100);
  }
  if (ch.purpose !== undefined) {
    const v = toStr(ch.purpose);
    if (v !== undefined) next.purpose = v;
    else bad('purpose');
  }
  if (ch.mood !== undefined) {
    const list = Array.isArray(ch.mood) ? ch.mood : typeof ch.mood === 'string' ? [ch.mood] : null;
    if (list) next.mood = list.map((m) => toStr(m)).filter((m): m is string => !!m && m.trim() !== '');
    else bad('mood');
  }
  if (ch.feel !== undefined) {
    const v = oneOf(ch.feel, SECTION_FEELS);
    if (v) next.feel = v;
    else bad('feel');
  }
  if (ch.progression !== undefined) {
    if (Array.isArray(ch.progression)) next.progression = ch.progression.map((p) => toStr(p)).filter((p): p is string => !!p && p.trim() !== '');
    else bad('progression');
  }
  let bars: number | undefined;
  if (ch.bars !== undefined) {
    const v = toInt(ch.bars);
    if (v === undefined || v < 1 || v > MAX_SECTION_BARS) {
      c.error('section.invalid', `${name}: "bars" must be an integer between 1 and ${MAX_SECTION_BARS}.`, { sectionId: section.id });
      return false;
    }
    if (v !== section.bars) bars = v;
  }
  if (c.respectLocks) {
    const structural = bars !== undefined || (next.name !== undefined && next.name !== section.name) || (next.kind !== undefined && next.kind !== section.kind);
    if (c.locks.structure && structural) {
      c.error('lock.violated', `${name}: the song structure is locked.`, { sectionId: section.id });
      return false;
    }
    if (c.locks.sections.has(section.id) && (bars !== undefined || next.progression !== undefined)) {
      c.error('lock.violated', `${name}: section "${section.name}" is locked.`, { sectionId: section.id });
      return false;
    }
  }
  if (next.name && next.name !== section.name) {
    const clash = song.sections.find((s) => s.id !== section.id && s.name.toLowerCase() === next.name!.toLowerCase());
    if (clash) c.warn('section.duplicate-name', `${name}: another section is already called "${next.name}".`, { sectionId: section.id });
  }
  Object.assign(section, next);
  if (bars !== undefined) {
    const spans = sectionLayout(song);
    const span = spans.find((s) => s.section.id === section.id)!;
    const total = songLengthBars(song);
    const segments: Segment[] =
      bars > section.bars
        ? [
            { kind: 'old', startBar: 0, endBar: span.endBar },
            { kind: 'empty', bars: bars - section.bars, contextBar: Math.max(0, span.endBar - 1) },
            { kind: 'old', startBar: span.endBar, endBar: total },
          ]
        : [
            { kind: 'old', startBar: 0, endBar: span.startBar + bars },
            { kind: 'old', startBar: span.endBar, endBar: total },
          ];
    const sections = song.sections.map((s) => (s.id === section.id ? { ...s, bars } : s));
    const stats = applyRestructure(song, segments, sections, c);
    if (stats.droppedNotes || stats.droppedChords) {
      c.info('section.material-removed', `${name}: shortening "${section.name}" removed ${stats.droppedNotes} note(s) and ${stats.droppedChords} chord(s).`, {
        sectionId: section.id,
      });
    }
  }
  return true;
}

export function opInsertSection(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'insert_section';
  const spec = op.section;
  if (!isRecord(spec)) {
    c.error('op.malformed', `${name}: "section" must be an object with name, kind and bars.`);
    return false;
  }
  let source: Section | undefined;
  if (op.copy_from !== undefined && op.copy_from !== null && op.copy_from !== '') {
    source = resolveSection(song, op.copy_from, c, name);
    if (!source) return false;
  }
  let index = song.sections.length;
  const afterRef = op.after;
  if (afterRef !== undefined && afterRef !== null) {
    const r = toStr(afterRef)?.trim() ?? '';
    if (r === '' || /^(start|beginning|begin|top|none)$/i.test(r)) index = 0;
    else if (/^(end|last)$/i.test(r)) index = song.sections.length;
    else {
      const after = resolveSection(song, r, c, name);
      if (!after) return false;
      index = song.sections.indexOf(after) + 1;
    }
  }
  let kind = oneOf(spec.kind, SECTION_KINDS);
  if (!kind) {
    if (spec.kind !== undefined) c.warn('section.invalid', `${name}: unknown section kind ${JSON.stringify(spec.kind)}; using "${source?.kind ?? 'custom'}".`);
    kind = source?.kind ?? 'custom';
  }
  let bars = toInt(spec.bars);
  if (bars === undefined && source) bars = source.bars;
  if (bars === undefined || bars < 1 || bars > MAX_SECTION_BARS) {
    c.error('section.invalid', `${name}: "bars" must be an integer between 1 and ${MAX_SECTION_BARS}.`);
    return false;
  }
  if (c.respectLocks && c.locks.structure) {
    c.error('lock.violated', `${name}: the song structure is locked.`);
    return false;
  }
  const requestedName = toStr(spec.name)?.trim() || source?.name || kindLabel(kind);
  const sectionName = uniqueSectionName(song, requestedName);
  if (sectionName !== requestedName) c.info('section.renamed', `${name}: "${requestedName}" already exists; the new section is called "${sectionName}".`);
  const energy = toNumber(spec.energy);
  const section: Section = {
    id: c.ids.next('sec'),
    name: sectionName,
    kind,
    bars,
    energy: clampNum(energy ?? source?.energy ?? 50, 0, 100),
  };
  const purpose = toStr(spec.purpose);
  if (purpose) section.purpose = purpose;
  else if (source?.purpose) section.purpose = source.purpose;
  if (source) {
    section.repeatOf = source.repeatOf ?? source.id;
    if (source.energyEnd !== undefined) section.energyEnd = source.energyEnd;
    if (source.mood) section.mood = [...source.mood];
    if (source.progression) section.progression = [...source.progression];
    if (source.harmonicRhythm !== undefined) section.harmonicRhythm = source.harmonicRhythm;
    if (source.feel) section.feel = source.feel;
  }
  const spans = sectionLayout(song);
  const total = songLengthBars(song);
  const insertBar = index < spans.length ? spans[index].startBar : total;
  const srcSpan = source ? spans.find((s) => s.section.id === source!.id) : undefined;
  const segments: Segment[] = [
    { kind: 'old', startBar: 0, endBar: insertBar },
    srcSpan
      ? { kind: 'copy', startBar: srcSpan.startBar, endBar: srcSpan.endBar, bars }
      : { kind: 'empty', bars, contextBar: Math.max(0, insertBar - 1) },
    { kind: 'old', startBar: insertBar, endBar: total },
  ];
  // Copy the source section's lyric lines.
  const lyricMap = new Map<string, string>();
  const copiedLines: LyricLine[] = [];
  if (source) {
    for (const l of song.lyrics.filter((x) => x.sectionId === source!.id)) {
      const id = c.ids.next('ly');
      lyricMap.set(l.id, id);
      copiedLines.push({ ...l, id, sectionId: section.id });
    }
  }
  const sections = song.sections.slice();
  sections.splice(index, 0, section);
  applyRestructure(song, segments, sections, c, {
    ids: c.ids,
    copySectionIds: source ? new Map([[source.id, section.id]]) : undefined,
    copyLyricLineIds: lyricMap,
  });
  if (copiedLines.length) {
    const order = new Map(song.sections.map((s, i) => [s.id, i] as const));
    const pos = song.lyrics.findIndex((l) => (order.get(l.sectionId) ?? Infinity) > index);
    song.lyrics.splice(pos < 0 ? song.lyrics.length : pos, 0, ...copiedLines);
  }
  if (source && song.production?.sectionPrompts?.[source.id]) {
    song.production.sectionPrompts = { ...song.production.sectionPrompts, [section.id]: song.production.sectionPrompts[source.id] };
  }
  return true;
}

export function opRemoveSection(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'remove_section';
  const section = resolveSection(song, op.section, c, name);
  if (!section) return false;
  if (song.sections.length <= 1) {
    c.error('section.last', `${name}: "${section.name}" is the only section; a song needs at least one section.`, { sectionId: section.id });
    return false;
  }
  if (c.respectLocks) {
    if (c.locks.structure) {
      c.error('lock.violated', `${name}: the song structure is locked.`, { sectionId: section.id });
      return false;
    }
    if (c.locks.sections.has(section.id)) {
      c.error('lock.violated', `${name}: section "${section.name}" is locked.`, { sectionId: section.id });
      return false;
    }
    if (song.lyrics.some((l) => l.sectionId === section.id) && lyricsProtected(c.locks, section.id)) {
      c.error('lock.violated', `${name}: lyrics of "${section.name}" are locked.`, { sectionId: section.id });
      return false;
    }
  }
  const span = sectionLayout(song).find((s) => s.section.id === section.id)!;
  const total = songLengthBars(song);
  const segments: Segment[] = [
    { kind: 'old', startBar: 0, endBar: span.startBar },
    { kind: 'old', startBar: span.endBar, endBar: total },
  ];
  const sections = song.sections
    .filter((s) => s.id !== section.id)
    .map((s) => {
      if (s.repeatOf !== section.id) return s;
      const copy = { ...s };
      delete copy.repeatOf;
      return copy;
    });
  const stats = applyRestructure(song, segments, sections, c);
  song.lyrics = song.lyrics.filter((l) => l.sectionId !== section.id);
  const locks = { ...song.locks };
  for (const key of Object.keys(locks)) {
    if (key === `section:${section.id}` || key.endsWith(`:section:${section.id}`)) delete locks[key];
  }
  song.locks = locks;
  if (song.production?.sectionPrompts?.[section.id] !== undefined) {
    const prompts = { ...song.production.sectionPrompts };
    delete prompts[section.id];
    song.production.sectionPrompts = prompts;
  }
  if (stats.droppedClips) c.warn('audio.unaligned', `${name}: ${stats.droppedClips} audio clip(s) starting in "${section.name}" were removed.`, { sectionId: section.id });
  return true;
}

export function opMoveSection(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'move_section';
  const section = resolveSection(song, op.section, c, name);
  if (!section) return false;
  const to = toInt(op.to_index);
  if (to === undefined) {
    c.error('op.malformed', `${name}: "to_index" must be a (0-based) section index.`, { sectionId: section.id });
    return false;
  }
  if (c.respectLocks && c.locks.structure) {
    c.error('lock.violated', `${name}: the song structure is locked.`, { sectionId: section.id });
    return false;
  }
  const from = song.sections.indexOf(section);
  const target = Math.max(0, Math.min(song.sections.length - 1, to));
  if (target !== to) c.warn('section.invalid', `${name}: to_index ${to} clamped to ${target}.`, { sectionId: section.id, fixed: true });
  if (target === from) {
    c.info('op.no-effect', `${name}: "${section.name}" is already at index ${from}.`, { sectionId: section.id });
    return true;
  }
  const spans = sectionLayout(song);
  const order = song.sections.slice();
  order.splice(from, 1);
  order.splice(target, 0, section);
  const segments: Segment[] = order.map((s) => {
    const span = spans.find((x) => x.section.id === s.id)!;
    return { kind: 'old', startBar: span.startBar, endBar: span.endBar };
  });
  const stats = applyRestructure(song, segments, order, c);
  if (stats.trimmedNotes) c.info('section.notes-trimmed', `${name}: ${stats.trimmedNotes} note(s) sustaining across the moved section boundaries were shortened.`, { sectionId: section.id });
  return true;
}
