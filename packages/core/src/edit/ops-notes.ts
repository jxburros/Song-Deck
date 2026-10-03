import type { Note, Song } from '../ir/types';
import { barToTick, beatsToTicks, keyAtTick, quantizeTick, tickToBar } from '../timing';
import { transposeDiatonic } from '../theory/scales';
import { parsePitch } from '../theory/pitch';
import { deriveRng } from '../util/random';
import { isDrumTrack } from './instruments';
import {
  filterLockedSelection,
  isProtected,
  parseExpression,
  parseOpNote,
  parseRegion,
  regionIsLocked,
  resolveMidiTrack,
  selectNotes,
  type OpContext,
} from './op-context';
import { ARTICULATIONS, SectionLocator, barsLabel, clampNum, isRecord, oneOf, toNumber } from './util';

type RawOp = Record<string, unknown>;

export function opReplaceNotes(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'replace_notes';
  const track = resolveMidiTrack(song, op.track, c, name);
  if (!track) return false;
  const region = parseRegion(song, op.region, c, name, true);
  if (!region) return false;
  if (!Array.isArray(op.notes)) {
    c.error('op.malformed', `${name}: "notes" must be an array.`, { trackId: track.id });
    return false;
  }
  if (regionIsLocked(song, track, region.startTick, region.endTick, c, name)) return false;
  const fresh: Note[] = [];
  let outside = 0;
  let trimmed = 0;
  op.notes.forEach((raw, i) => {
    const n = parseOpNote(song, raw, c, name, i, track.id);
    if (!n) return;
    if (n.tick < region.startTick || n.tick >= region.endTick) {
      outside++;
      return;
    }
    if (n.tick + n.duration > region.endTick) {
      n.duration = region.endTick - n.tick;
      trimmed++;
    }
    fresh.push({ id: c.ids.next('n'), ...n });
  });
  const label = `bars ${region.startBar1}–${region.endBar1}`;
  if (outside) c.warn('region.note-outside', `${name}: ${outside} note(s) outside the requested ${label} were dropped.`, { trackId: track.id, fixed: true });
  if (trimmed) c.info('region.note-trimmed', `${name}: ${trimmed} note(s) shortened to end at the region boundary.`, { trackId: track.id, fixed: true });
  const locator = new SectionLocator(song);
  const keep: Note[] = [];
  for (const n of track.notes) {
    if (n.tick >= region.startTick && n.tick < region.endTick) continue;
    // A note sustaining into the replaced region is cut at the region start (unless protected).
    if (n.tick < region.startTick && n.tick + n.duration > region.startTick && !isProtected(c, locator, track, n)) {
      keep.push({ ...n, duration: region.startTick - n.tick });
    } else keep.push(n);
  }
  track.notes = keep.concat(fresh);
  for (const n of fresh) c.touch(track.id, n.id);
  if (!fresh.length) c.info('op.no-effect', `${name}: ${label} of "${track.name}" cleared (no valid notes supplied).`, { trackId: track.id });
  return true;
}

export function opAddNotes(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'add_notes';
  const track = resolveMidiTrack(song, op.track, c, name);
  if (!track) return false;
  if (!Array.isArray(op.notes)) {
    c.error('op.malformed', `${name}: "notes" must be an array.`, { trackId: track.id });
    return false;
  }
  const locator = new SectionLocator(song);
  const fresh: Note[] = [];
  for (let i = 0; i < op.notes.length; i++) {
    const n = parseOpNote(song, op.notes[i], c, name, i, track.id);
    if (!n) continue;
    if (isProtected(c, locator, track, { tick: n.tick, locked: false })) {
      c.error('lock.violated', `${name}: "${track.name}" is locked at ${barsLabel(song, n.tick, n.tick + 1)}.`, { trackId: track.id });
      return false;
    }
    fresh.push({ id: c.ids.next('n'), ...n });
  }
  if (!fresh.length) {
    c.info('op.no-effect', `${name}: no valid notes to add.`, { trackId: track.id });
    return true;
  }
  track.notes.push(...fresh);
  for (const n of fresh) c.touch(track.id, n.id);
  return true;
}

function parsePitchRange(raw: unknown): [number, number] | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const parse = (v: unknown) => {
    if (typeof v !== 'number' && typeof v !== 'string') return undefined;
    const p = parsePitch(v);
    return p === null ? undefined : p;
  };
  const lo = parse(raw[0]);
  const hi = parse(raw[1]);
  if (lo === undefined || hi === undefined) return null;
  return lo <= hi ? [lo, hi] : [hi, lo];
}

export function opDeleteNotes(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'delete_notes';
  const track = resolveMidiTrack(song, op.track, c, name);
  if (!track) return false;
  const region = parseRegion(song, op.region, c, name, false);
  if (region === null) return false;
  const range = parsePitchRange(op.pitch_range);
  if (range === null) {
    c.error('op.malformed', `${name}: "pitch_range" must be [low, high] (MIDI numbers or note names).`, { trackId: track.id });
    return false;
  }
  const sel = selectNotes(track, region, op.note_ids, c, name);
  if (!sel) return false;
  if (range) sel.notes = sel.notes.filter((n) => n.pitch >= range[0] && n.pitch <= range[1]);
  const locator = new SectionLocator(song);
  const notes = filterLockedSelection(c, locator, track, sel, name);
  if (!notes) return false;
  if (!notes.length) {
    c.info('op.no-effect', `${name}: no matching notes on "${track.name}".`, { trackId: track.id });
    return true;
  }
  const del = new Set(notes);
  track.notes = track.notes.filter((n) => !del.has(n));
  return true;
}

export function opTransformNotes(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'transform_notes';
  const track = resolveMidiTrack(song, op.track, c, name);
  if (!track) return false;
  const region = parseRegion(song, op.region, c, name, false);
  if (region === null) return false;
  const t = op.transform;
  if (!isRecord(t)) {
    c.error('op.malformed', `${name}: "transform" must be an object.`, { trackId: track.id });
    return false;
  }
  const num = (key: string, check: (v: number) => boolean = () => true): number | undefined => {
    if (t[key] === undefined || t[key] === null) return undefined;
    const v = toNumber(t[key]);
    if (v === undefined || !check(v)) {
      c.warn('transform.invalid', `${name}: transform.${key} = ${JSON.stringify(t[key])} is invalid; ignored.`, { trackId: track.id });
      return undefined;
    }
    return v;
  };
  const drums = isDrumTrack(track, c.instruments);
  let transpose = num('transpose', (v) => Math.abs(v) <= 48);
  let diatonic = num('transpose_diatonic', (v) => Math.abs(v) <= 28);
  if (drums && (transpose || diatonic)) {
    c.info('transform.drums-skipped', `${name}: pitch transposition skipped on drum track "${track.name}".`, { trackId: track.id });
    transpose = undefined;
    diatonic = undefined;
  }
  const velScale = num('velocity_scale', (v) => v >= 0 && v <= 10);
  const velAdd = num('velocity_add', (v) => Math.abs(v) <= 127);
  const shift = num('time_shift_beats', (v) => Math.abs(v) <= 4096);
  const durScale = num('duration_scale', (v) => v > 0 && v <= 64);
  const quant = num('quantize_beats', (v) => v > 0 && v <= 16);
  const quantStrength = clampNum(num('quantize_strength', (v) => v >= 0 && v <= 1) ?? 1, 0, 1);
  const humanize = num('humanize', (v) => v >= 0 && v <= 1);
  let articulation = undefined as Note['articulation'] | undefined;
  if (t.articulation !== undefined) {
    articulation = oneOf(t.articulation, ARTICULATIONS);
    if (!articulation) c.warn('transform.invalid', `${name}: unknown articulation "${String(t.articulation)}"; ignored.`, { trackId: track.id });
  }
  const sel = selectNotes(track, region, op.note_ids, c, name);
  if (!sel) return false;
  const locator = new SectionLocator(song);
  const notes = filterLockedSelection(c, locator, track, sel, name);
  if (!notes) return false;
  if (!notes.length) {
    c.info('op.no-effect', `${name}: no matching notes on "${track.name}".`, { trackId: track.id });
    return true;
  }
  const selected = new Set(notes);
  let clampedStart = 0;
  track.notes = track.notes.map((orig) => {
    if (!selected.has(orig)) return orig;
    const n: Note = { ...orig };
    if (transpose) n.pitch += Math.round(transpose);
    if (diatonic) n.pitch = transposeDiatonic(n.pitch, Math.round(diatonic), keyAtTick(song, orig.tick));
    if (velScale !== undefined) n.velocity *= velScale;
    if (velAdd !== undefined) n.velocity += velAdd;
    if (shift) {
      n.tick += beatsToTicks(song, shift, orig.tick);
      if (n.tick < 0) {
        n.tick = 0;
        clampedStart++;
      }
    }
    if (durScale !== undefined) n.duration = Math.max(1, Math.round(n.duration * durScale));
    if (quant !== undefined) {
      const grid = beatsToTicks(song, quant, n.tick);
      if (grid >= 1) {
        const barStart = barToTick(song, tickToBar(song, n.tick).bar);
        n.tick = barStart + quantizeTick(n.tick - barStart, grid, quantStrength);
        const targetDur = Math.max(grid, Math.round(n.duration / grid) * grid);
        n.duration = Math.max(1, Math.round(n.duration + (targetDur - n.duration) * quantStrength));
      }
    }
    if (humanize) {
      const rng = deriveRng(song.generation?.seed ?? 1, 'humanize', c.opIndex, orig.id);
      const maxShift = (humanize * song.ppq) / 8;
      const dt = Math.round(clampNum(rng.gaussian(0, (humanize * song.ppq) / 24), -maxShift, maxShift));
      n.tick = Math.max(0, n.tick + dt);
      n.velocity += Math.round(clampNum(rng.gaussian(0, humanize * 8), -humanize * 20, humanize * 20));
    }
    if (articulation) n.articulation = articulation;
    n.velocity = Math.round(clampNum(n.velocity, 1, 127));
    c.touch(track.id, n.id);
    return n;
  });
  if (clampedStart) c.warn('note.past-start', `${name}: ${clampedStart} note(s) shifted before the song start were placed at bar 1.`, { trackId: track.id, fixed: true });
  return true;
}

export function opSetExpression(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'set_expression';
  const track = resolveMidiTrack(song, op.track, c, name);
  if (!track) return false;
  const region = parseRegion(song, op.region, c, name, false);
  if (region === null) return false;
  if (!isRecord(op.expression)) {
    c.error('op.malformed', `${name}: "expression" must be an object.`, { trackId: track.id });
    return false;
  }
  const expr = parseExpression(op.expression, c, name);
  if (!expr) {
    c.error('op.malformed', `${name}: "expression" contains no valid fields.`, { trackId: track.id });
    return false;
  }
  const sel = selectNotes(track, region, op.note_ids, c, name);
  if (!sel) return false;
  const locator = new SectionLocator(song);
  const notes = filterLockedSelection(c, locator, track, sel, name);
  if (!notes) return false;
  if (!notes.length) {
    c.info('op.no-effect', `${name}: no matching notes on "${track.name}".`, { trackId: track.id });
    return true;
  }
  const selected = new Set(notes);
  track.notes = track.notes.map((n) => {
    if (!selected.has(n)) return n;
    c.touch(track.id, n.id);
    return { ...n, expression: { ...(n.expression ?? {}), ...expr } };
  });
  return true;
}
