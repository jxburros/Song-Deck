import type { ChordEvent, KeyEvent, KeySignature, LyricLine, MeterEvent, ModeName, Note, Section, Song, TempoEvent, Track } from '../ir/types';
import { PPQ } from '../ir/types';
import { createEmptySong, defaultChannelStrip } from '../ir/defaults';
import { GM_DRUM_CHANNEL, GM_PROGRAM_NAMES } from '../ir/gm';
import { sortNotes } from '../ir/song-utils';
import { barLengthTicks, barToTick, keyAtTick, sectionLayout, tickToBar } from '../timing';
import { parseChordSymbol } from '../theory/chords';
import { chordToRoman } from '../theory/roman';
import { mod12 } from '../theory/pitch';
import type { IdFactory } from '../util/ids';
import { randomId } from '../util/ids';
import { colorForStemGroup, instrumentIdForProgram, isDrumTrack, lookupInstrument, type InstrumentLookupOptions } from '../edit/instruments';
import { MODE_NAMES, MUSICAL_FUNCTIONS, SECTION_KINDS, TRACK_ROLES, isRecord, oneOf } from '../edit/util';
import { concatBytes, decodeText, inferSectionKind, keyFifths, keyFromFifths, utf8 } from './util';

// ---------------------------------------------------------------------------
// Low-level Standard MIDI File model
// ---------------------------------------------------------------------------

export type MidiEvent =
  | { tick: number; type: 'noteOn'; channel: number; note: number; velocity: number }
  | { tick: number; type: 'noteOff'; channel: number; note: number; velocity: number }
  | { tick: number; type: 'polyAftertouch'; channel: number; note: number; pressure: number }
  | { tick: number; type: 'controller'; channel: number; controller: number; value: number }
  | { tick: number; type: 'programChange'; channel: number; program: number }
  | { tick: number; type: 'channelAftertouch'; channel: number; pressure: number }
  /** Pitch bend −8192…8191. */
  | { tick: number; type: 'pitchBend'; channel: number; value: number }
  | { tick: number; type: 'tempo'; microsecondsPerQuarter: number }
  | { tick: number; type: 'timeSignature'; numerator: number; denominator: number; clocksPerClick: number; thirtySecondsPerQuarter: number }
  /** Key signature: −7 (7 flats) … +7 (7 sharps), minor flag. */
  | { tick: number; type: 'keySignature'; sharps: number; minor: boolean }
  /** Text-like meta events: 1 text, 2 copyright, 3 track name, 4 instrument, 5 lyric, 6 marker, 7 cue point. */
  | { tick: number; type: 'text'; metaType: number; text: string }
  /** Any other meta event (sequencer-specific 0x7F, SMPTE offset…). */
  | { tick: number; type: 'meta'; metaType: number; data: Uint8Array }
  | { tick: number; type: 'sysex'; data: Uint8Array; escape?: boolean };

export interface MidiTrack {
  /** Events with absolute tick positions (kept in file order). */
  events: MidiEvent[];
  /** Tick of the End Of Track event. */
  endTick?: number;
}

export interface MidiFile {
  format: 0 | 1 | 2;
  /** Ticks per quarter note (SMPTE divisions are converted assuming 120 BPM). */
  ticksPerQuarter: number;
  tracks: MidiTrack[];
}

export const META = { TEXT: 1, COPYRIGHT: 2, TRACK_NAME: 3, INSTRUMENT: 4, LYRIC: 5, MARKER: 6, CUE: 7, SEQUENCER: 0x7f } as const;

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

class ByteWriter {
  private buf = new Uint8Array(1024);
  length = 0;
  private ensure(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  byte(b: number) {
    this.ensure(1);
    this.buf[this.length++] = b & 0xff;
  }
  bytes(data: ArrayLike<number>) {
    this.ensure(data.length);
    for (let i = 0; i < data.length; i++) this.buf[this.length++] = data[i] & 0xff;
  }
  u16(v: number) {
    this.byte(v >> 8);
    this.byte(v);
  }
  u32(v: number) {
    this.byte(v >>> 24);
    this.byte(v >>> 16);
    this.byte(v >>> 8);
    this.byte(v);
  }
  vlq(v: number) {
    let value = Math.max(0, Math.min(0x0fffffff, Math.round(v)));
    const stack = [value & 0x7f];
    value >>>= 7;
    while (value > 0) {
      stack.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    for (let i = stack.length - 1; i >= 0; i--) this.byte(stack[i]);
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

const clamp7 = (v: number) => Math.max(0, Math.min(127, Math.round(v)));
const ch4 = (c: number) => Math.max(0, Math.min(15, Math.round(c)));

function writeEvent(w: ByteWriter, e: MidiEvent, running: { status: number }, useRunning: boolean) {
  const channelStatus = (status: number) => {
    if (useRunning && running.status === status) return;
    w.byte(status);
    running.status = status;
  };
  switch (e.type) {
    case 'noteOn':
      channelStatus(0x90 | ch4(e.channel));
      w.byte(clamp7(e.note));
      w.byte(clamp7(e.velocity));
      return;
    case 'noteOff':
      channelStatus(0x80 | ch4(e.channel));
      w.byte(clamp7(e.note));
      w.byte(clamp7(e.velocity));
      return;
    case 'polyAftertouch':
      channelStatus(0xa0 | ch4(e.channel));
      w.byte(clamp7(e.note));
      w.byte(clamp7(e.pressure));
      return;
    case 'controller':
      channelStatus(0xb0 | ch4(e.channel));
      w.byte(clamp7(e.controller));
      w.byte(clamp7(e.value));
      return;
    case 'programChange':
      channelStatus(0xc0 | ch4(e.channel));
      w.byte(clamp7(e.program));
      return;
    case 'channelAftertouch':
      channelStatus(0xd0 | ch4(e.channel));
      w.byte(clamp7(e.pressure));
      return;
    case 'pitchBend': {
      channelStatus(0xe0 | ch4(e.channel));
      const v = Math.max(0, Math.min(16383, Math.round(e.value) + 8192));
      w.byte(v & 0x7f);
      w.byte(v >> 7);
      return;
    }
    default:
      break;
  }
  running.status = 0; // meta & sysex cancel running status
  switch (e.type) {
    case 'tempo': {
      const us = Math.max(1, Math.min(0xffffff, Math.round(e.microsecondsPerQuarter)));
      w.bytes([0xff, 0x51, 0x03, us >> 16, us >> 8, us]);
      return;
    }
    case 'timeSignature': {
      const dd = Math.max(0, Math.round(Math.log2(Math.max(1, e.denominator))));
      w.bytes([0xff, 0x58, 0x04, e.numerator & 0xff, dd, e.clocksPerClick & 0xff, e.thirtySecondsPerQuarter & 0xff]);
      return;
    }
    case 'keySignature': {
      const sf = Math.max(-7, Math.min(7, Math.round(e.sharps)));
      w.bytes([0xff, 0x59, 0x02, sf & 0xff, e.minor ? 1 : 0]);
      return;
    }
    case 'text': {
      const data = utf8(e.text);
      w.bytes([0xff, e.metaType & 0x7f]);
      w.vlq(data.length);
      w.bytes(data);
      return;
    }
    case 'meta':
      w.bytes([0xff, e.metaType & 0x7f]);
      w.vlq(e.data.length);
      w.bytes(e.data);
      return;
    case 'sysex': {
      w.byte(e.escape ? 0xf7 : 0xf0);
      w.vlq(e.data.length);
      w.bytes(e.data);
      return;
    }
  }
}

/** Serialize a MIDI file (events are written in tick order; ties keep their given order). */
export function writeMidiFile(file: MidiFile, opts: { runningStatus?: boolean } = {}): Uint8Array {
  const w = new ByteWriter();
  w.ascii('MThd');
  w.u32(6);
  w.u16(file.format);
  w.u16(file.tracks.length);
  w.u16(Math.max(1, Math.min(0x7fff, Math.round(file.ticksPerQuarter))));
  for (const track of file.tracks) {
    const tw = new ByteWriter();
    const events = track.events
      .map((e, i) => ({ e, i }))
      .sort((a, b) => a.e.tick - b.e.tick || a.i - b.i)
      .map((x) => x.e);
    let last = 0;
    const running = { status: 0 };
    for (const e of events) {
      const tick = Math.max(last, Math.round(e.tick));
      tw.vlq(tick - last);
      last = tick;
      writeEvent(tw, e, running, !!opts.runningStatus);
    }
    const end = Math.max(last, Math.round(track.endTick ?? 0));
    tw.vlq(end - last);
    tw.bytes([0xff, 0x2f, 0x00]);
    const data = tw.result();
    w.ascii('MTrk');
    w.u32(data.length);
    w.bytes(data);
  }
  return w.result();
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Parse a Standard MIDI File (format 0/1/2). Tolerant of truncated files and unknown chunks. */
export function parseMidiFile(bytes: Uint8Array): MidiFile {
  const data = bytes;
  const str = (o: number) => String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]);
  const u32 = (o: number) => ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
  const u16 = (o: number) => (data[o] << 8) | data[o + 1];
  let pos = 0;
  // RIFF-wrapped MIDI (RMID)
  if (data.length >= 20 && str(0) === 'RIFF' && str(8) === 'RMID') {
    let p = 12;
    while (p + 8 <= data.length) {
      const len = data[p + 4] | (data[p + 5] << 8) | (data[p + 6] << 16) | (data[p + 7] << 24);
      if (str(p) === 'data') {
        pos = p + 8;
        break;
      }
      p += 8 + len + (len & 1);
    }
  }
  if (data.length < pos + 14 || str(pos) !== 'MThd') throw new Error('Not a Standard MIDI File (missing MThd header).');
  const headerLen = u32(pos + 4);
  const formatRaw = u16(pos + 8);
  const ntrks = u16(pos + 10);
  const division = u16(pos + 12);
  let ticksPerQuarter: number;
  if (division & 0x8000) {
    const fps = 256 - (division >> 8);
    const tpf = division & 0xff;
    ticksPerQuarter = Math.max(1, Math.round((fps * tpf) / 2));
  } else ticksPerQuarter = division || PPQ;
  const format = (formatRaw === 0 || formatRaw === 1 || formatRaw === 2 ? formatRaw : 1) as 0 | 1 | 2;
  pos += 8 + headerLen;
  const tracks: MidiTrack[] = [];
  while (pos + 8 <= data.length && tracks.length < Math.max(ntrks, 1) * 4) {
    const id = str(pos);
    const len = u32(pos + 4);
    const start = pos + 8;
    const end = Math.min(data.length, start + len);
    if (id === 'MTrk') tracks.push(parseTrack(data, start, end));
    pos = start + len;
  }
  return { format, ticksPerQuarter, tracks };
}

function parseTrack(data: Uint8Array, start: number, end: number): MidiTrack {
  const events: MidiEvent[] = [];
  let pos = start;
  let tick = 0;
  let running = 0;
  const readVlq = (): number | null => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      if (pos >= end) return null;
      const b = data[pos++];
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    return v;
  };
  while (pos < end) {
    const delta = readVlq();
    if (delta === null) break;
    tick += delta;
    if (pos >= end) break;
    let status = data[pos];
    if (status & 0x80) pos++;
    else if (running) status = running;
    else break; // data byte without running status — corrupt track
    if (status === 0xff) {
      if (pos >= end) break;
      const type = data[pos++];
      const len = readVlq();
      if (len === null) break;
      const d = data.subarray(pos, Math.min(end, pos + len));
      pos += len;
      running = 0;
      if (type === 0x2f) return { events, endTick: tick };
      if (type === 0x51 && d.length >= 3) events.push({ tick, type: 'tempo', microsecondsPerQuarter: (d[0] << 16) | (d[1] << 8) | d[2] });
      else if (type === 0x58 && d.length >= 2)
        events.push({ tick, type: 'timeSignature', numerator: d[0], denominator: 2 ** d[1], clocksPerClick: d[2] ?? 24, thirtySecondsPerQuarter: d[3] ?? 8 });
      else if (type === 0x59 && d.length >= 2) events.push({ tick, type: 'keySignature', sharps: d[0] > 127 ? d[0] - 256 : d[0], minor: d[1] === 1 });
      else if (type >= 0x01 && type <= 0x0f) events.push({ tick, type: 'text', metaType: type, text: decodeText(d) });
      else events.push({ tick, type: 'meta', metaType: type, data: d.slice() });
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      const len = readVlq();
      if (len === null) break;
      const sysex: MidiEvent = { tick, type: 'sysex', data: data.slice(pos, Math.min(end, pos + len)) };
      if (status === 0xf7) sysex.escape = true;
      events.push(sysex);
      pos += len;
      running = 0;
      continue;
    }
    if (status >= 0xf1) {
      // System common/real-time messages do not belong in files; skip defensively.
      running = 0;
      continue;
    }
    running = status;
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    const one = kind === 0xc0 || kind === 0xd0;
    if (pos + (one ? 1 : 2) > end) break;
    const d1 = data[pos++] & 0x7f;
    const d2 = one ? 0 : data[pos++] & 0x7f;
    switch (kind) {
      case 0x80:
        events.push({ tick, type: 'noteOff', channel, note: d1, velocity: d2 });
        break;
      case 0x90:
        if (d2 === 0) events.push({ tick, type: 'noteOff', channel, note: d1, velocity: 64 });
        else events.push({ tick, type: 'noteOn', channel, note: d1, velocity: d2 });
        break;
      case 0xa0:
        events.push({ tick, type: 'polyAftertouch', channel, note: d1, pressure: d2 });
        break;
      case 0xb0:
        events.push({ tick, type: 'controller', channel, controller: d1, value: d2 });
        break;
      case 0xc0:
        events.push({ tick, type: 'programChange', channel, program: d1 });
        break;
      case 0xd0:
        events.push({ tick, type: 'channelAftertouch', channel, pressure: d1 });
        break;
      case 0xe0:
        events.push({ tick, type: 'pitchBend', channel, value: ((d2 << 7) | d1) - 8192 });
        break;
    }
  }
  return { events, endTick: tick };
}

// ---------------------------------------------------------------------------
// Song → MIDI
// ---------------------------------------------------------------------------

export interface SongToMidiOptions extends InstrumentLookupOptions {
  /** Export only these tracks (default: all MIDI tracks). */
  trackIds?: string[];
  /** Section markers (FF 06) in the conductor track (default true). */
  includeMarkers?: boolean;
  /** Lyric events (FF 05) on tracks whose notes carry syllables (default true). */
  includeLyrics?: boolean;
  /** Embed Song Deck metadata (exact modes, section kinds, chords, lyric lines) as sequencer-specific events (default true). */
  includeSongDeckMeta?: boolean;
  /** Mixer volume/pan as CC7/CC10 at the start of each track (default true). */
  includeMixer?: boolean;
}

const SONGDECK_PREFIX = 'SongDeck:';
const STEM_GROUPS = ['vocals', 'drums', 'bass', 'guitars', 'keys', 'strings', 'others'] as const;
/** Manufacturer id 0x7D (non-commercial / educational) for our sequencer-specific events. */
const SONGDECK_MANUFACTURER = 0x7d;

function songDeckMeta(tick: number, payload: unknown): MidiEvent {
  return { tick, type: 'meta', metaType: META.SEQUENCER, data: concatBytes([Uint8Array.of(SONGDECK_MANUFACTURER), utf8(SONGDECK_PREFIX + JSON.stringify(payload))]) };
}

function readSongDeckMeta(e: MidiEvent): Record<string, unknown> | undefined {
  if (e.type !== 'meta' || e.metaType !== META.SEQUENCER || e.data[0] !== SONGDECK_MANUFACTURER) return undefined;
  const text = decodeText(e.data.subarray(1));
  if (!text.startsWith(SONGDECK_PREFIX)) return undefined;
  try {
    const v = JSON.parse(text.slice(SONGDECK_PREFIX.length));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Assign MIDI channels: drums → 9, others keep a valid preferred channel or get the next free one (skipping 9). */
export function assignChannels(tracks: Track[], lookup: InstrumentLookupOptions = {}): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  const pending: Track[] = [];
  for (const t of tracks) {
    if (isDrumTrack(t, lookup)) {
      out.set(t.id, GM_DRUM_CHANNEL);
      continue;
    }
    const ch = t.midiChannel;
    if (ch !== undefined && Number.isInteger(ch) && ch >= 0 && ch <= 15 && ch !== GM_DRUM_CHANNEL && !used.has(ch)) {
      out.set(t.id, ch);
      used.add(ch);
    } else pending.push(t);
  }
  const free = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15].filter((c) => !used.has(c));
  pending.forEach((t, i) => out.set(t.id, free.length ? free[i % free.length] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15][i % 15]));
  return out;
}

/** Non-overlapping note on/off pairs per pitch (same-pitch overlaps are cut at the next onset). */
function notePairs(notes: readonly Note[]): { note: Note; end: number }[] {
  const sorted = [...notes].filter((n) => Number.isFinite(n.tick) && n.duration > 0).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  const nextByPitch = new Map<number, number>();
  const out: { note: Note; end: number }[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const n = sorted[i];
    const next = nextByPitch.get(n.pitch);
    let end = n.tick + Math.max(1, Math.round(n.duration));
    if (next !== undefined) {
      if (next === n.tick) continue; // exact duplicate onset — keep one
      end = Math.min(end, next);
    }
    nextByPitch.set(n.pitch, n.tick);
    out.push({ note: n, end });
  }
  return out.reverse();
}

const RANK = { meta: 0, control: 1, noteOff: 2, lyric: 3, noteOn: 4 } as const;

interface Ranked {
  e: MidiEvent;
  rank: number;
}

function sortRanked(list: Ranked[]): MidiEvent[] {
  return list
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => a.e.tick - b.e.tick || a.rank - b.rank || a.i - b.i)
    .map((r) => r.e);
}

function conductorEvents(song: Song, opts: SongToMidiOptions, trackOrder: Track[]): Ranked[] {
  const out: Ranked[] = [];
  out.push({ e: { tick: 0, type: 'text', metaType: META.TRACK_NAME, text: song.title || 'Song' }, rank: RANK.meta });
  const tempos = [...song.tempoMap].sort((a, b) => a.tick - b.tick);
  if (!tempos.length || tempos[0].tick !== 0) tempos.unshift({ tick: 0, bpm: tempos[0]?.bpm ?? 120 });
  for (const t of tempos) out.push({ e: { tick: Math.round(t.tick), type: 'tempo', microsecondsPerQuarter: 60_000_000 / t.bpm }, rank: RANK.meta });
  const meters = [...song.meterMap].sort((a, b) => a.bar - b.bar);
  if (!meters.length || meters[0].bar !== 0) meters.unshift({ bar: 0, numerator: meters[0]?.numerator ?? 4, denominator: meters[0]?.denominator ?? 4 });
  for (const m of meters) {
    out.push({ e: { tick: barToTick(song, m.bar), type: 'timeSignature', numerator: m.numerator, denominator: m.denominator, clocksPerClick: 24, thirtySecondsPerQuarter: 8 }, rank: RANK.meta });
  }
  const keys = [...song.keyMap].sort((a, b) => a.bar - b.bar);
  for (const k of keys) {
    out.push({ e: { tick: barToTick(song, k.bar), type: 'keySignature', sharps: keyFifths(k.key), minor: isMinorFlag(k.key) }, rank: RANK.meta });
  }
  if (opts.includeMarkers !== false) {
    for (const span of sectionLayout(song)) out.push({ e: { tick: span.startTick, type: 'text', metaType: META.MARKER, text: span.section.name }, rank: RANK.meta });
  }
  if (opts.includeSongDeckMeta !== false) {
    const trackIndex = new Map(trackOrder.map((t, i) => [t.id, i] as const));
    const sectionIndex = new Map(song.sections.map((s, i) => [s.id, i] as const));
    const lyrics = song.lyrics
      .filter((l) => sectionIndex.has(l.sectionId))
      .map((l) => {
        const track = l.trackId ? trackOrder.find((t) => t.id === l.trackId) : undefined;
        const ticks = track?.notes.filter((n) => n.lyricLineId === l.id).map((n) => n.tick) ?? [];
        return {
          section: sectionIndex.get(l.sectionId),
          text: l.text,
          track: track ? trackIndex.get(track.id) : null,
          ticks: ticks.length ? [Math.min(...ticks), Math.max(...ticks)] : null,
          author: l.author ?? null,
        };
      });
    out.push({
      e: songDeckMeta(0, {
        v: 1,
        title: song.title,
        keys: keys.map((k) => ({ bar: k.bar, tonic: k.key.tonic, mode: k.key.mode })),
        sections: song.sections.map((s) => ({ name: s.name, kind: s.kind, bars: s.bars, energy: s.energy })),
        chords: song.chords.map((c) => ({ tick: c.tick, duration: c.duration, symbol: c.symbol })),
        lyrics,
      }),
      rank: RANK.meta,
    });
  }
  return out;
}

function isMinorFlag(key: KeySignature): boolean {
  return key.mode === 'minor' || key.mode === 'harmonic-minor' || key.mode === 'melodic-minor' || key.mode === 'dorian' || key.mode === 'phrygian' || key.mode === 'locrian';
}

function trackEvents(song: Song, track: Track, channel: number, opts: SongToMidiOptions, lookup: InstrumentLookupOptions): Ranked[] {
  const out: Ranked[] = [];
  const profile = lookupInstrument(track.instrumentId, lookup);
  const drums = channel === GM_DRUM_CHANNEL;
  out.push({ e: { tick: 0, type: 'text', metaType: META.TRACK_NAME, text: track.name }, rank: RANK.meta });
  out.push({ e: { tick: 0, type: 'text', metaType: META.INSTRUMENT, text: profile.name }, rank: RANK.meta });
  if (opts.includeSongDeckMeta !== false) {
    out.push({
      e: songDeckMeta(0, { v: 1, instrumentId: track.instrumentId, role: track.role, stemGroup: track.stemGroup, color: track.color, function: track.constraints?.function ?? null }),
      rank: RANK.meta,
    });
  }
  if (!drums) out.push({ e: { tick: 0, type: 'programChange', channel, program: Math.max(0, Math.min(127, profile.gmProgram)) }, rank: RANK.control });
  const strip = song.mixer?.channels?.[track.id];
  if (opts.includeMixer !== false && strip) {
    const vol = Math.round(127 * Math.pow(10, Math.min(0, strip.volumeDb) / 40));
    out.push({ e: { tick: 0, type: 'controller', channel, controller: 7, value: Math.max(0, Math.min(127, vol)) }, rank: RANK.control });
    out.push({ e: { tick: 0, type: 'controller', channel, controller: 10, value: Math.max(0, Math.min(127, Math.round(64 + strip.pan * 63))) }, rank: RANK.control });
  }
  const withLyrics = opts.includeLyrics !== false && track.notes.some((n) => n.syllable);
  for (const { note, end } of notePairs(track.notes)) {
    const tick = Math.round(note.tick);
    if (withLyrics && note.syllable) out.push({ e: { tick, type: 'text', metaType: META.LYRIC, text: note.syllable }, rank: RANK.lyric });
    out.push({ e: { tick, type: 'noteOn', channel, note: clamp7(note.pitch), velocity: Math.max(1, clamp7(note.velocity)) }, rank: RANK.noteOn });
    out.push({ e: { tick: Math.round(end), type: 'noteOff', channel, note: clamp7(note.pitch), velocity: 64 }, rank: RANK.noteOff });
  }
  return out;
}

function exportTracks(song: Song, opts: SongToMidiOptions): Track[] {
  return song.tracks.filter((t) => t.kind === 'midi' && (!opts.trackIds || opts.trackIds.includes(t.id)));
}

/** Multi-track Standard MIDI File (type 1, PPQ = song.ppq) with a conductor track. */
export function songToMidi(song: Song, opts: SongToMidiOptions = {}): Uint8Array {
  const lookup: InstrumentLookupOptions = { customInstruments: opts.customInstruments, resolveInstrument: opts.resolveInstrument };
  const tracks = exportTracks(song, opts);
  const channels = assignChannels(tracks, lookup);
  const file: MidiFile = {
    format: 1,
    ticksPerQuarter: song.ppq,
    tracks: [{ events: sortRanked(conductorEvents(song, opts, tracks)) }],
  };
  for (const t of tracks) file.tracks.push({ events: sortRanked(trackEvents(song, t, channels.get(t.id)!, opts, lookup)) });
  return writeMidiFile(file);
}

/** Single-track Standard MIDI File (type 0) containing one track plus tempo/meter/key/markers. */
export function trackToMidi(song: Song, trackId: string, opts: Omit<SongToMidiOptions, 'trackIds'> = {}): Uint8Array {
  const lookup: InstrumentLookupOptions = { customInstruments: opts.customInstruments, resolveInstrument: opts.resolveInstrument };
  const track = song.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Unknown track "${trackId}".`);
  const channels = assignChannels([track], lookup);
  const conductor = conductorEvents(song, { ...opts, includeSongDeckMeta: false }, [track]).filter(
    (r) => !(r.e.type === 'text' && r.e.metaType === META.TRACK_NAME),
  );
  const events = sortRanked([...trackEvents(song, track, channels.get(track.id)!, opts, lookup), ...conductor]);
  return writeMidiFile({ format: 0, ticksPerQuarter: song.ppq, tracks: [{ events }] });
}

// ---------------------------------------------------------------------------
// MIDI → Song
// ---------------------------------------------------------------------------

export interface MidiToSongOptions {
  title?: string;
  /** Deterministic ids (default random). */
  ids?: IdFactory;
  /** Song id (default random). */
  id?: string;
  /** Bars per generated section when the file has no markers (default 8). */
  sectionBars?: number;
}

interface RawTrack {
  name?: string;
  channel: number;
  program?: number;
  notes: { pitch: number; tick: number; end: number; velocity: number }[];
  lyrics: { tick: number; text: string }[];
  meta?: Record<string, unknown>;
  volume?: number;
  pan?: number;
  fileTrack: number;
}

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Krumhansl–Schmuckler key estimate from duration-weighted pitch classes. */
export function estimateKeyFromNotes(notes: readonly { pitch: number; duration: number }[]): KeySignature {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[mod12(n.pitch)] += Math.max(1, n.duration);
  if (hist.every((v) => v === 0)) return { tonic: 0, mode: 'major' };
  const corr = (profile: number[], tonic: number) => {
    const x = hist;
    const y = Array.from({ length: 12 }, (_, i) => profile[mod12(i - tonic)]);
    const mx = x.reduce((a, b) => a + b, 0) / 12;
    const my = y.reduce((a, b) => a + b, 0) / 12;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < 12; i++) {
      num += (x[i] - mx) * (y[i] - my);
      dx += (x[i] - mx) ** 2;
      dy += (y[i] - my) ** 2;
    }
    return dx && dy ? num / Math.sqrt(dx * dy) : 0;
  };
  let best: KeySignature = { tonic: 0, mode: 'major' };
  let bestScore = -Infinity;
  for (let t = 0; t < 12; t++) {
    for (const [profile, mode] of [
      [KS_MAJOR, 'major'],
      [KS_MINOR, 'minor'],
    ] as const) {
      const s = corr(profile as unknown as number[], t);
      if (s > bestScore + 1e-12) {
        bestScore = s;
        best = { tonic: t, mode: mode as ModeName };
      }
    }
  }
  return best;
}

interface CleanLyric {
  text: string;
  /** A new lyric line starts with this syllable ("/" or "\\" karaoke prefix, leading newline). */
  breakBefore: boolean;
  /** The lyric line ends after this syllable (trailing CR/LF). */
  breakAfter: boolean;
  /** Raw text had surrounding whitespace (space-separated-words convention). */
  spaceAfter: boolean;
  spaceBefore: boolean;
}

/** Section generation stops here for absurd files (a stray event hours after the music). */
const MAX_IMPORT_BARS = 10000;

function cleanLyric(text: string): CleanLyric {
  const breakBefore = /^[/\\]|^[\r\n]/.test(text);
  const breakAfter = /[\r\n]\s*$/.test(text);
  const core = text.replace(/[\r\n]/g, '').replace(/^[/\\]+/, '');
  return { text: core.trim(), breakBefore, breakAfter, spaceAfter: /\s$/.test(core), spaceBefore: /^\s/.test(core) };
}

/**
 * Normalize MIDI lyric syllables to the IR convention ("hel-" + "lo"). Files that separate words
 * with spaces ("Twin" "kle ") get "-" appended to syllables that continue into the next one.
 */
function normalizeSyllables(list: CleanLyric[]): CleanLyric[] {
  const spaced = list.some((l) => l.spaceAfter || l.spaceBefore) && !list.some((l) => /-$/.test(l.text));
  if (!spaced) return list;
  return list.map((l, i) => {
    const next = list[i + 1];
    const continues = next && !l.spaceAfter && !l.breakAfter && !next.spaceBefore && !next.breakBefore && l.text !== '_' && next.text !== '_';
    return continues ? { ...l, text: `${l.text}-` } : l;
  });
}

/** Import a Standard MIDI File (type 0/1/2) as a Song. */
export function midiToSong(bytes: Uint8Array, opts: MidiToSongOptions = {}): Song {
  const file = parseMidiFile(bytes);
  const scale = PPQ / file.ticksPerQuarter;
  const T = (t: number) => Math.round(t * scale);
  const nextId = (prefix: string) => (opts.ids ? opts.ids.next(prefix) : randomId(prefix));

  const tempoEvents: { tick: number; us: number }[] = [];
  const timeSigs: { tick: number; num: number; den: number }[] = [];
  const keySigs: { tick: number; sharps: number; minor: boolean }[] = [];
  const markers: { tick: number; text: string }[] = [];
  let songMeta: Record<string, unknown> | undefined;
  let conductorName: string | undefined;
  const raws: RawTrack[] = [];
  const orphanLyrics: { tick: number; text: string }[] = [];

  file.tracks.forEach((mt, fileTrack) => {
    let name: string | undefined;
    let trackMeta: Record<string, unknown> | undefined;
    const byChannel = new Map<number, RawTrack>();
    const programs = new Map<number, number>();
    const volume = new Map<number, number>();
    const pan = new Map<number, number>();
    const lyrics: { tick: number; text: string }[] = [];
    const open = new Map<string, { tick: number; velocity: number }[]>();
    const get = (channel: number) => {
      let r = byChannel.get(channel);
      if (!r) byChannel.set(channel, (r = { channel, notes: [], lyrics: [], fileTrack }));
      return r;
    };
    let lastTick = 0;
    for (const e of mt.events) {
      lastTick = Math.max(lastTick, e.tick);
      switch (e.type) {
        case 'tempo':
          tempoEvents.push({ tick: e.tick, us: e.microsecondsPerQuarter });
          break;
        case 'timeSignature':
          timeSigs.push({ tick: e.tick, num: e.numerator, den: e.denominator });
          break;
        case 'keySignature':
          keySigs.push({ tick: e.tick, sharps: e.sharps, minor: e.minor });
          break;
        case 'text':
          if (e.metaType === META.TRACK_NAME && name === undefined) name = e.text.trim();
          else if (e.metaType === META.MARKER || (e.metaType === META.CUE && !markers.length)) markers.push({ tick: e.tick, text: e.text.trim() });
          else if (e.metaType === META.LYRIC) lyrics.push({ tick: e.tick, text: e.text });
          break;
        case 'meta': {
          const m = readSongDeckMeta(e);
          if (m && 'sections' in m) songMeta = m;
          else if (m) trackMeta = m;
          break;
        }
        case 'programChange':
          if (!programs.has(e.channel)) programs.set(e.channel, e.program);
          break;
        case 'controller':
          if (e.controller === 7 && !volume.has(e.channel)) volume.set(e.channel, e.value);
          if (e.controller === 10 && !pan.has(e.channel)) pan.set(e.channel, e.value);
          break;
        case 'noteOn': {
          const key = `${e.channel}:${e.note}`;
          const list = open.get(key) ?? [];
          list.push({ tick: e.tick, velocity: e.velocity });
          open.set(key, list);
          break;
        }
        case 'noteOff': {
          const key = `${e.channel}:${e.note}`;
          const on = open.get(key)?.shift();
          if (on) get(e.channel).notes.push({ pitch: e.note, tick: on.tick, end: Math.max(e.tick, on.tick + 1), velocity: on.velocity });
          break;
        }
        default:
          break;
      }
    }
    // Unterminated notes end at the end of the track.
    const trackEnd = Math.max(lastTick, mt.endTick ?? 0);
    for (const [key, list] of open) {
      const [channel, note] = key.split(':').map(Number);
      for (const on of list) get(channel).notes.push({ pitch: note, tick: on.tick, end: Math.max(trackEnd, on.tick + file.ticksPerQuarter / 4), velocity: on.velocity });
    }
    const withNotes = [...byChannel.values()].filter((r) => r.notes.length).sort((a, b) => a.channel - b.channel);
    if (!withNotes.length) {
      if (fileTrack === 0 && name) conductorName = name;
      orphanLyrics.push(...lyrics);
      return;
    }
    for (const r of withNotes) {
      r.program = programs.get(r.channel);
      r.volume = volume.get(r.channel);
      r.pan = pan.get(r.channel);
      r.meta = trackMeta;
      r.name = withNotes.length > 1 ? (name ? `${name} (ch ${r.channel + 1})` : undefined) : name;
      // Lyrics belong to the channel whose notes they line up with.
      r.lyrics = withNotes.length === 1 ? lyrics : lyrics.filter((l) => r.notes.some((n) => n.tick === l.tick));
      raws.push(r);
    }
  });

  // Lyrics in a separate (note-less) track go to the track with the most matching onsets.
  if (orphanLyrics.length && raws.length) {
    let best = raws[0];
    let bestScore = -1;
    for (const r of raws) {
      const onsets = new Set(r.notes.map((n) => n.tick));
      const score = orphanLyrics.filter((l) => onsets.has(l.tick)).length;
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    best.lyrics = [...best.lyrics, ...orphanLyrics].sort((a, b) => a.tick - b.tick);
  }

  const song = createEmptySong({ title: opts.title ?? (typeof songMeta?.title === 'string' ? songMeta.title : undefined) ?? conductorName ?? 'Imported MIDI', id: opts.id });

  // --- tempo -------------------------------------------------------------------
  const tempoMap: TempoEvent[] = [];
  for (const t of tempoEvents.sort((a, b) => a.tick - b.tick)) {
    const bpm = Math.round((60_000_000 / Math.max(1, t.us)) * 1000) / 1000;
    const tick = T(t.tick);
    if (tempoMap.length && tempoMap[tempoMap.length - 1].tick === tick) tempoMap[tempoMap.length - 1].bpm = bpm;
    else tempoMap.push({ tick, bpm });
  }
  if (!tempoMap.length) tempoMap.push({ tick: 0, bpm: 120 });
  if (tempoMap[0].tick !== 0) tempoMap.unshift({ tick: 0, bpm: tempoMap[0].bpm });
  song.tempoMap = tempoMap;

  // --- meter (tick positions → bar indices) -----------------------------------------
  const meterMap: MeterEvent[] = [{ bar: 0, numerator: 4, denominator: 4 }];
  {
    let curBar = 0;
    let curTick = 0;
    let cur = meterMap[0];
    for (const ts of timeSigs.sort((a, b) => a.tick - b.tick)) {
      if (!(ts.num >= 1) || ![1, 2, 4, 8, 16, 32].includes(ts.den)) continue;
      const tick = T(ts.tick);
      const len = barLengthTicks(cur, PPQ);
      const bar = curBar + Math.ceil((tick - curTick) / len - 1e-9);
      const ev: MeterEvent = { bar: Math.max(0, bar), numerator: ts.num, denominator: ts.den };
      const last = meterMap[meterMap.length - 1];
      if (last.bar === ev.bar) meterMap[meterMap.length - 1] = ev;
      else meterMap.push(ev);
      curTick = curTick + (ev.bar - curBar) * len;
      curBar = ev.bar;
      cur = ev;
    }
    const compressed: MeterEvent[] = [];
    for (const m of meterMap) {
      const last = compressed[compressed.length - 1];
      if (last && last.numerator === m.numerator && last.denominator === m.denominator) continue;
      compressed.push(m);
    }
    song.meterMap = compressed;
  }

  // --- tracks ------------------------------------------------------------------------
  const allNotes: { pitch: number; duration: number }[] = [];
  let maxTick = 0;
  const lyricByTrack = new Map<string, (CleanLyric & { tick: number })[]>();
  raws.forEach((r, index) => {
    const meta = r.meta;
    const drums = r.channel === GM_DRUM_CHANNEL;
    const hasLyrics = r.lyrics.some((l) => cleanLyric(l.text).text);
    const metaInstrument = typeof meta?.instrumentId === 'string' && /^[\w.-]{1,80}$/.test(meta.instrumentId) ? meta.instrumentId : undefined;
    let instrumentId = metaInstrument ?? (drums ? 'drum-kit' : instrumentIdForProgram(r.program ?? 0));
    const nameLooksVocal = /vocal|voice|vox|sing|melody|lyric/i.test(r.name ?? '');
    if (!meta && !drums && (hasLyrics || nameLooksVocal) && !/vocal|choir/.test(instrumentId)) instrumentId = 'lead-vocal';
    const profile = lookupInstrument(instrumentId);
    const role = oneOf(meta?.role, TRACK_ROLES) ?? (hasLyrics || nameLooksVocal ? 'vocal' : profile.defaultRole);
    const stemGroup = oneOf(meta?.stemGroup, STEM_GROUPS) ?? profile.stemGroup;
    const fn = oneOf(meta?.function, MUSICAL_FUNCTIONS);
    const name = r.name || (drums ? 'Drums' : r.program !== undefined ? GM_PROGRAM_NAMES[r.program] : `Track ${index + 1}`);
    const track: Track = {
      id: nextId('trk'),
      name,
      kind: 'midi',
      role,
      instrumentId,
      constraints: fn ? { function: fn } : {},
      notes: [],
      clips: [],
      color: typeof meta?.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(meta.color) ? meta.color : colorForStemGroup(stemGroup),
      stemGroup,
      midiChannel: r.channel,
    };
    const notes: Note[] = r.notes.map((n) => {
      const tick = T(n.tick);
      const duration = Math.max(1, T(n.end) - tick);
      maxTick = Math.max(maxTick, tick + duration);
      if (!drums) allNotes.push({ pitch: n.pitch, duration });
      return { id: nextId('n'), pitch: n.pitch, tick, duration, velocity: Math.max(1, Math.min(127, n.velocity)) };
    });
    track.notes = sortNotes(notes);
    // Syllables: lyric events attach to the (highest) note starting at the same tick.
    const tol = Math.max(1, Math.round(PPQ / 32));
    const cleaned = normalizeSyllables(r.lyrics.map((l) => ({ tick: T(l.tick), ...cleanLyric(l.text) })).filter((l) => l.text)) as (CleanLyric & { tick: number })[];
    for (const l of cleaned) {
      let best: Note | undefined;
      for (const n of track.notes) {
        if (Math.abs(n.tick - l.tick) > tol || n.syllable) continue;
        if (!best || Math.abs(n.tick - l.tick) < Math.abs(best.tick - l.tick) || (n.tick === best.tick && n.pitch > best.pitch)) best = n;
      }
      if (best) best.syllable = l.text;
    }
    lyricByTrack.set(track.id, cleaned);
    song.tracks.push(track);
    const strip = defaultChannelStrip();
    if (r.volume !== undefined) strip.volumeDb = r.volume > 0 ? Math.max(-60, Math.round(40 * Math.log10(r.volume / 127) * 10) / 10) : -60;
    if (r.pan !== undefined) strip.pan = Math.max(-1, Math.min(1, Math.round(((r.pan - 64) / 63) * 100) / 100));
    song.mixer.channels[track.id] = strip;
  });

  // --- key map -------------------------------------------------------------------------
  const metaKeys = Array.isArray(songMeta?.keys) ? (songMeta!.keys as unknown[]) : undefined;
  let keyMap: KeyEvent[] = [];
  const validKey = (k: unknown): k is { bar: number; tonic: number; mode: ModeName } =>
    isRecord(k) && Number.isInteger(k.bar) && (k.bar as number) >= 0 && (k.bar as number) <= MAX_IMPORT_BARS && Number.isInteger(k.tonic) && !!oneOf(k.mode, MODE_NAMES);
  if (metaKeys?.length && metaKeys.every(validKey)) {
    keyMap = (metaKeys as { bar: number; tonic: number; mode: ModeName }[]).map((k) => ({ bar: k.bar, key: { tonic: mod12(k.tonic), mode: k.mode } }));
  } else if (keySigs.length) {
    for (const ks of keySigs.sort((a, b) => a.tick - b.tick)) {
      const bar = tickToBar(song, T(ks.tick)).bar;
      const key = keyFromFifths(ks.sharps, ks.minor);
      const last = keyMap[keyMap.length - 1];
      if (last && last.bar === bar) last.key = key;
      else if (!last || last.key.tonic !== key.tonic || last.key.mode !== key.mode) keyMap.push({ bar, key });
    }
  }
  if (!keyMap.length) keyMap = [{ bar: 0, key: estimateKeyFromNotes(allNotes) }];
  if (keyMap[0].bar !== 0) keyMap.unshift({ bar: 0, key: keyMap[0].key });
  song.keyMap = keyMap;

  // --- sections ------------------------------------------------------------------------
  const markerTicks = markers.map((m) => ({ ...m, tick: T(m.tick) })).filter((m) => m.text);
  for (const m of markerTicks) maxTick = Math.max(maxTick, m.tick + 1);
  const totalBars = Math.max(1, Math.min(MAX_IMPORT_BARS, maxTick > 0 ? tickToBar(song, maxTick - 1).bar + 1 : 1));
  const metaSections = Array.isArray(songMeta?.sections)
    ? (songMeta!.sections as unknown[])
        .filter(isRecord)
        .map((x) => ({
          name: typeof x.name === 'string' ? x.name.slice(0, 200) : '',
          kind: oneOf(x.kind, SECTION_KINDS),
          bars: Number.isInteger(x.bars) ? (x.bars as number) : 0,
          energy: typeof x.energy === 'number' && Number.isFinite(x.energy) ? Math.max(0, Math.min(100, x.energy)) : undefined,
        }))
    : undefined;
  // Sections from markers (rounded to the nearest bar line).
  let markerStarts: { bar: number; name: string }[] | undefined;
  if (markerTicks.length) {
    markerStarts = [];
    for (const m of markerTicks.sort((a, b) => a.tick - b.tick)) {
      const p = tickToBar(song, m.tick);
      const barLen = barLengthTicks(p.meter, PPQ);
      const bar = p.tickInBar * 2 >= barLen ? p.bar + 1 : p.bar;
      const last = markerStarts[markerStarts.length - 1];
      if (last && last.bar === bar) last.name = m.text;
      else markerStarts.push({ bar, name: m.text });
    }
  }
  const validMeta =
    !!metaSections?.length &&
    metaSections.length === (songMeta!.sections as unknown[]).length &&
    metaSections.every((s) => s.name && s.bars > 0 && s.bars <= 4096) &&
    metaSections.reduce((n, s) => n + s.bars, 0) <= MAX_IMPORT_BARS;
  // Embedded Song Deck sections are used unless the markers were edited elsewhere (e.g. in a DAW).
  let metaMatchesMarkers = true;
  if (validMeta && markerStarts) {
    let bar = 0;
    const metaStarts = metaSections!.map((s) => {
      const start = { bar, name: s.name };
      bar += s.bars;
      return start;
    });
    metaMatchesMarkers = metaStarts.length === markerStarts.length && metaStarts.every((m, i) => m.bar === markerStarts![i].bar && m.name === markerStarts![i].name);
  }
  const sections: Section[] = [];
  if (validMeta && metaMatchesMarkers) {
    for (const s of metaSections!) sections.push({ id: nextId('sec'), name: s.name, kind: s.kind ?? inferSectionKind(s.name), bars: s.bars, energy: typeof s.energy === 'number' ? s.energy : 50 });
    const covered = sections.reduce((n, s) => n + s.bars, 0);
    if (covered < totalBars) sections.push({ id: nextId('sec'), name: 'Coda', kind: 'outro', bars: totalBars - covered, energy: 50 });
  } else if (markerStarts?.length) {
    if (markerStarts[0].bar > 0) markerStarts.unshift({ bar: 0, name: 'Intro' });
    const end = Math.max(totalBars, markerStarts[markerStarts.length - 1].bar + 1);
    markerStarts.forEach((s, i) => {
      const next = i + 1 < markerStarts!.length ? markerStarts![i + 1].bar : end;
      const known = validMeta ? metaSections!.find((m) => m.name === s.name) : undefined;
      sections.push({ id: nextId('sec'), name: s.name, kind: known?.kind ?? inferSectionKind(s.name), bars: Math.max(1, next - s.bar), energy: typeof known?.energy === 'number' ? known.energy : 50 });
    });
  } else {
    const size = Math.max(1, Math.round(opts.sectionBars ?? 8));
    for (let start = 0, i = 1; start < totalBars; start += size, i++) {
      sections.push({ id: nextId('sec'), name: `Section ${i}`, kind: 'custom', bars: Math.min(size, totalBars - start), energy: 50 });
    }
  }
  song.sections = sections;

  // --- chords (Song Deck metadata only) ----------------------------------------------------
  if (Array.isArray(songMeta?.chords)) {
    const chords: ChordEvent[] = [];
    for (const c of (songMeta!.chords as unknown[]).filter(isRecord) as { tick: number; duration: number; symbol: string }[]) {
      const spec = typeof c.symbol === 'string' ? parseChordSymbol(c.symbol) : null;
      if (!spec || !Number.isFinite(c.tick) || c.tick < 0 || !Number.isFinite(c.duration) || !(c.duration > 0)) continue;
      const tick = T(c.tick);
      chords.push({ id: nextId('ch'), tick, duration: Math.max(1, T(c.tick + c.duration) - tick), ...spec, symbol: c.symbol, roman: chordToRoman(spec, keyAtTick(song, tick)) });
    }
    song.chords = chords.sort((a, b) => a.tick - b.tick);
  }

  // --- lyric lines -----------------------------------------------------------------------------
  const metaLyrics = Array.isArray(songMeta?.lyrics)
    ? ((songMeta!.lyrics as unknown[]).filter(isRecord) as { section: number; text: string; track: number | null; ticks: [number, number] | null; author?: string | null }[])
    : undefined;
  if (metaLyrics?.length) {
    for (const l of metaLyrics) {
      const section = Number.isInteger(l.section) ? sections[l.section] : undefined;
      if (!section || typeof l.text !== 'string') continue;
      if (l.ticks && !(Array.isArray(l.ticks) && l.ticks.length === 2 && l.ticks.every((t) => Number.isFinite(t)))) l.ticks = null;
      if (l.author !== undefined && l.author !== null && typeof l.author !== 'string') l.author = null;
      const line: LyricLine = { id: nextId('ly'), sectionId: section.id, text: l.text };
      const track = Number.isInteger(l.track) ? song.tracks[l.track as number] : undefined;
      if (track) {
        line.trackId = track.id;
        if (l.ticks) {
          const [a, b] = [T(l.ticks[0]), T(l.ticks[1])];
          for (const n of track.notes) if (n.syllable && n.tick >= a && n.tick <= b) n.lyricLineId = line.id;
        }
      }
      if (l.author) line.author = l.author;
      song.lyrics.push(line);
    }
  } else {
    buildLyricLines(song, lyricByTrack, nextId);
  }
  return song;
}

/** Group imported syllables into lyric lines per section (breaks at karaoke markers or long rests). */
function buildLyricLines(song: Song, lyricByTrack: Map<string, (CleanLyric & { tick: number })[]>, nextId: (p: string) => string) {
  const spans = sectionLayout(song);
  for (const track of song.tracks) {
    const sung = track.notes.filter((n) => n.syllable);
    if (!sung.length) continue;
    const raw = lyricByTrack.get(track.id) ?? [];
    const breaksBefore = new Set(raw.filter((l) => l.breakBefore).map((l) => l.tick));
    const breaksAfter = new Set(raw.filter((l) => l.breakAfter).map((l) => l.tick));
    const hasMarkers = breaksBefore.size > 0 || breaksAfter.size > 0;
    let current: Note[] = [];
    let currentSection: string | undefined;
    const flush = () => {
      if (!current.length || !currentSection) return;
      const words: string[] = [];
      let word = '';
      let cont = false;
      for (const n of current) {
        const s = n.syllable!;
        if (s === '_') continue;
        const text = s.replace(/^-+|-+$/g, '');
        if (cont || s.startsWith('-')) word += text;
        else {
          if (word) words.push(word);
          word = text;
        }
        cont = s.endsWith('-');
      }
      if (word) words.push(word);
      const line: LyricLine = { id: nextId('ly'), sectionId: currentSection, text: words.join(' '), trackId: track.id };
      for (const n of current) n.lyricLineId = line.id;
      song.lyrics.push(line);
      current = [];
    };
    let prevEnd = -Infinity;
    let prevTick = -Infinity;
    for (const n of sung) {
      const sid = spans.find((s) => n.tick >= s.startTick && n.tick < s.endTick)?.section.id ?? spans[spans.length - 1]?.section.id;
      const gap = n.tick - prevEnd;
      const breakHere = sid !== currentSection || (hasMarkers ? breaksBefore.has(n.tick) || breaksAfter.has(prevTick) : gap >= 2 * PPQ);
      if (breakHere) flush();
      currentSection = sid;
      current.push(n);
      prevEnd = n.tick + n.duration;
      prevTick = n.tick;
    }
    flush();
  }
}
