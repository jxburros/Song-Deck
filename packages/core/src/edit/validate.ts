import type { ChordEvent, InstrumentProfile, LockMap, Note, Song, Track, ValidationReport } from '../ir/types';
import { CHORD_INTERVALS, parseChordSymbol } from '../theory/chords';
import { sectionLayout, songLengthTicks } from '../timing';
import { countPolyphonicOverlaps } from './apply';
import { isDrumTrack, isKnownInstrument, lookupInstrument, trackRange, type InstrumentResolver } from './instruments';
import { lockViolations, scopeViolations } from './locks-check';
import { AUTOMATION_PARAMS, IssueList, MODE_NAMES, SECTION_KINDS, VALID_DENOMINATORS, barsLabel, estimateSyllables, makeReport } from './util';

export interface ValidateOptions {
  customInstruments?: InstrumentProfile[];
  resolveInstrument?: InstrumentResolver;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validation Engine (spec §48) for a whole song: MIDI validity, instrument ranges, structure,
 * chord references, lyric/vocal alignment, overlaps & polyphony, mixer/automation sanity.
 * Pure: never modifies the song. `ok` is false when any error is present.
 */
export function validateSong(song: Song, opts: ValidateOptions = {}): ValidationReport {
  const issues = new IssueList();
  if (!song || typeof song !== 'object' || !Array.isArray(song.tracks) || !Array.isArray(song.sections)) {
    issues.error('song.invalid', 'Not a valid song: tracks/sections are missing.');
    return issues.report();
  }
  for (const key of ['tempoMap', 'meterMap', 'keyMap', 'chords', 'lyrics', 'automation', 'phrases', 'motifs'] as const) {
    if (!Array.isArray(song[key])) {
      issues.error('song.invalid', `Not a valid song: "${key}" is missing.`);
      return issues.report();
    }
  }
  if (!isInt(song.ppq) || song.ppq <= 0) issues.error('song.invalid', `Invalid PPQ ${String(song.ppq)}.`);
  const lookup = { customInstruments: opts.customInstruments, resolveInstrument: opts.resolveInstrument };

  // --- tempo / meter / key ---------------------------------------------------------
  if (!song.tempoMap.length) issues.error('tempo.invalid', 'The tempo map is empty.');
  const tempoTicks = new Set<number>();
  for (const t of song.tempoMap) {
    if (!isNum(t.tick) || t.tick < 0 || !isNum(t.bpm) || t.bpm <= 0 || t.bpm > 1000) issues.error('tempo.invalid', `Invalid tempo event (tick ${String(t.tick)}, ${String(t.bpm)} BPM).`);
    else if (tempoTicks.has(t.tick)) issues.warn('tempo.duplicate', `Two tempo events at tick ${t.tick}.`);
    tempoTicks.add(t.tick);
  }
  if (song.tempoMap.length && !song.tempoMap.some((t) => t.tick === 0)) issues.warn('tempo.invalid', 'The tempo map has no event at the start of the song.');
  if (!song.meterMap.length) issues.warn('meter.invalid', 'The meter map is empty (4/4 assumed).');
  for (const m of song.meterMap) {
    if (!isInt(m.bar) || m.bar < 0 || !isInt(m.numerator) || m.numerator < 1 || m.numerator > 64 || !(VALID_DENOMINATORS as readonly number[]).includes(m.denominator)) {
      issues.error('meter.invalid', `Invalid time signature ${String(m.numerator)}/${String(m.denominator)} at bar ${Number(m.bar) + 1}.`);
    }
  }
  for (const k of song.keyMap) {
    if (!isInt(k.bar) || k.bar < 0 || !k.key || !isInt(k.key.tonic) || k.key.tonic < 0 || k.key.tonic > 11 || !MODE_NAMES.includes(k.key.mode)) {
      issues.error('key.invalid', `Invalid key event at bar ${Number(k.bar) + 1}.`);
    }
  }

  // --- sections ----------------------------------------------------------------------
  const sectionIds = new Set<string>();
  for (const s of song.sections) {
    if (sectionIds.has(s.id)) issues.error('section.duplicate-id', `Duplicate section id "${s.id}".`, { sectionId: s.id });
    sectionIds.add(s.id);
    if (!isInt(s.bars) || s.bars < 1) issues.error('section.invalid', `Section "${s.name}" has an invalid length (${String(s.bars)} bars).`, { sectionId: s.id });
    if (!s.name || !String(s.name).trim()) issues.warn('section.invalid', 'A section has no name.', { sectionId: s.id });
    if (!SECTION_KINDS.includes(s.kind)) issues.warn('section.invalid', `Section "${s.name}" has an unknown kind "${String(s.kind)}".`, { sectionId: s.id });
  }
  const hasStructure = song.sections.length > 0 && song.sections.every((s) => isInt(s.bars) && s.bars >= 1);
  const end = hasStructure ? songLengthTicks(song) : Infinity;

  // --- tracks & notes --------------------------------------------------------------------
  const trackIds = new Set<string>();
  const noteIds = new Set<string>();
  for (const track of song.tracks) {
    if (trackIds.has(track.id)) issues.error('track.duplicate-id', `Duplicate track id "${track.id}".`, { trackId: track.id });
    trackIds.add(track.id);
    if (track.kind !== 'midi' && track.kind !== 'audio') issues.error('track.invalid', `Track "${track.name}" has an invalid kind.`, { trackId: track.id });
    if (!Array.isArray(track.notes) || !Array.isArray(track.clips)) {
      issues.error('track.invalid', `Track "${track.name}" is missing its notes/clips.`, { trackId: track.id });
      continue;
    }
    if (track.midiChannel !== undefined && (!isInt(track.midiChannel) || track.midiChannel < 0 || track.midiChannel > 15)) {
      issues.warn('track.invalid', `Track "${track.name}" has an invalid MIDI channel (${String(track.midiChannel)}).`, { trackId: track.id });
    }
    if (!isKnownInstrument(track.instrumentId, lookup)) {
      issues.info('instrument.unknown', `Track "${track.name}" uses an unknown instrument "${track.instrumentId}".`, { trackId: track.id });
    }
    validateNotes(song, track, end, noteIds, issues, lookup);
  }

  validateChords(song, end, hasStructure, issues);
  validateLyrics(song, issues);

  // --- automation, mixer, locks, phrases ------------------------------------------------------
  for (const lane of song.automation) {
    if (lane.target !== 'master' && !trackIds.has(lane.target)) {
      issues.warn('automation.target-missing', `An automation lane targets a missing track ("${lane.target}").`);
    }
    if (!AUTOMATION_PARAMS.includes(lane.param)) issues.warn('automation.invalid', `Unknown automation parameter "${String(lane.param)}".`);
    let last = -Infinity;
    for (const p of lane.points ?? []) {
      if (!isNum(p.tick) || p.tick < 0 || !isNum(p.value)) {
        issues.error('automation.invalid', `Invalid automation point on ${lane.param}.`, { trackId: lane.target === 'master' ? undefined : lane.target });
        continue;
      }
      if (p.tick < last) issues.info('automation.unsorted', `Automation points of ${lane.param} are not in time order.`);
      last = p.tick;
    }
  }
  for (const [id, strip] of Object.entries(song.mixer?.channels ?? {})) {
    if (!trackIds.has(id)) issues.info('mixer.orphan', `Mixer channel for a missing track ("${id}").`);
    for (const f of ['volumeDb', 'pan', 'reverbSend', 'delaySend', 'width', 'drive'] as const) {
      if (!isNum(strip?.[f])) issues.error('mixer.invalid', `Mixer field ${f} of "${id}" is not a number.`, { trackId: trackIds.has(id) ? id : undefined });
    }
    if (isNum(strip?.pan) && Math.abs(strip.pan) > 1) issues.warn('mixer.invalid', `Pan of "${id}" is outside −1…1.`, { trackId: trackIds.has(id) ? id : undefined });
  }
  for (const key of Object.keys(song.locks ?? {})) {
    const m = /^(?:track|mixer):([^:]+)/.exec(key);
    if (m && m[1] !== 'master' && !trackIds.has(m[1])) issues.info('lock.stale', `Lock "${key}" refers to a missing track.`);
    const s = /section:(.+)$/.exec(key);
    if (s && !sectionIds.has(s[1])) issues.info('lock.stale', `Lock "${key}" refers to a missing section.`);
  }
  for (const ph of song.phrases) {
    if (!trackIds.has(ph.trackId)) issues.info('phrase.orphan', `Phrase "${ph.label ?? ph.id}" refers to a missing track.`);
    if (!(ph.endTick >= ph.startTick)) issues.warn('phrase.invalid', `Phrase "${ph.label ?? ph.id}" ends before it starts.`);
  }
  return issues.report();
}

function validateNotes(
  song: Song,
  track: Track,
  end: number,
  noteIds: Set<string>,
  issues: IssueList,
  lookup: ValidateOptions,
): void {
  if (track.kind !== 'midi') return;
  const drums = isDrumTrack(track, lookup);
  const range = trackRange(track, lookup);
  let prev: Note | undefined;
  let unsorted = false;
  const valid: Note[] = [];
  for (const n of track.notes) {
    const tid = track.id;
    if (!n || typeof n.id !== 'string') {
      issues.error('note.invalid', `A note on "${track.name}" has no id.`, { trackId: tid });
      continue;
    }
    if (noteIds.has(n.id)) issues.error('note.duplicate-id', `Duplicate note id "${n.id}".`, { trackId: tid, noteId: n.id });
    noteIds.add(n.id);
    const problems: string[] = [];
    if (!isInt(n.pitch) || n.pitch < 0 || n.pitch > 127) problems.push(`pitch ${String(n.pitch)}`);
    if (!isNum(n.tick) || n.tick < 0 || !Number.isInteger(n.tick)) problems.push(`tick ${String(n.tick)}`);
    if (!isNum(n.duration) || n.duration <= 0) problems.push(`duration ${String(n.duration)}`);
    if (!isNum(n.velocity) || n.velocity < 1 || n.velocity > 127) problems.push(`velocity ${String(n.velocity)}`);
    if (problems.length) {
      issues.error('note.invalid', `Invalid MIDI note on "${track.name}": ${problems.join(', ')}.`, { trackId: tid, noteId: n.id });
      continue;
    }
    valid.push(n);
    if (prev && (n.tick < prev.tick || (n.tick === prev.tick && n.pitch < prev.pitch))) unsorted = true;
    prev = n;
    if (!drums && (n.pitch < range.low || n.pitch > range.high)) {
      issues.warn('note.out-of-range', `Pitch ${n.pitch} is outside the range of "${track.name}" (${range.low}–${range.high}) at ${barsLabel(song, n.tick, n.tick + 1)}.`, {
        trackId: tid,
        noteId: n.id,
      });
    }
    if (n.tick >= end) issues.warn('note.past-end', `A note on "${track.name}" starts after the end of the song.`, { trackId: tid, noteId: n.id });
    else if (n.tick + n.duration > end) issues.info('note.past-end', `A note on "${track.name}" rings past the end of the song.`, { trackId: tid, noteId: n.id });
  }
  if (unsorted) issues.info('note.unsorted', `Notes of "${track.name}" are not sorted by time.`, { trackId: track.id });
  // Same-pitch overlaps.
  const byPitch = new Map<number, Note[]>();
  for (const n of valid) {
    const list = byPitch.get(n.pitch);
    if (list) list.push(n);
    else byPitch.set(n.pitch, [n]);
  }
  for (const list of byPitch.values()) {
    list.sort((a, b) => a.tick - b.tick);
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (b.tick < a.tick + a.duration) {
        issues.warn('note.overlap', `Overlapping notes of the same pitch on "${track.name}" (${barsLabel(song, b.tick, b.tick + 1)}).`, { trackId: track.id, noteId: b.id });
      }
    }
  }
  // Polyphony.
  const profile = lookupInstrument(track.instrumentId, lookup);
  if (!drums && profile.polyphony === 'mono') {
    const overlaps = countPolyphonicOverlaps(valid);
    if (overlaps) issues.warn('polyphony.mono', `"${track.name}" is monophonic but has ${overlaps} overlapping note(s).`, { trackId: track.id });
  } else if (!drums) {
    const max = maxPolyphony(valid);
    if (max > 16) issues.warn('polyphony.excessive', `"${track.name}" plays up to ${max} simultaneous notes.`, { trackId: track.id });
  }
}

function maxPolyphony(notes: readonly Note[]): number {
  const events: [number, number][] = [];
  for (const n of notes) {
    events.push([n.tick, 1]);
    events.push([n.tick + n.duration, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of events) {
    cur += d;
    if (cur > max) max = cur;
  }
  return max;
}

function validateChords(song: Song, end: number, hasStructure: boolean, issues: IssueList): void {
  const valid: ChordEvent[] = [];
  const ids = new Set<string>();
  for (const c of song.chords) {
    if (ids.has(c.id)) issues.error('chord.duplicate-id', `Duplicate chord id "${c.id}".`);
    ids.add(c.id);
    if (!isNum(c.tick) || c.tick < 0 || !isNum(c.duration) || c.duration <= 0) {
      issues.error('chord.invalid', `Chord "${c.symbol}" has an invalid position or duration.`);
      continue;
    }
    if (!isInt(c.root) || c.root < 0 || c.root > 11 || !(c.quality in CHORD_INTERVALS)) {
      issues.error('chord.invalid', `Chord "${c.symbol}" has an invalid root/quality.`);
      continue;
    }
    const parsed = typeof c.symbol === 'string' ? parseChordSymbol(c.symbol) : null;
    if (!parsed) issues.error('chord.unparseable', `Chord symbol "${String(c.symbol)}" (${barsLabel(song, c.tick, c.tick + 1)}) cannot be parsed.`);
    else if (parsed.root !== c.root || parsed.quality !== c.quality || (parsed.bass ?? c.root) !== (c.bass ?? c.root)) {
      issues.warn('chord.mismatch', `Chord symbol "${c.symbol}" does not match its stored root/quality (${barsLabel(song, c.tick, c.tick + 1)}).`);
    }
    if (hasStructure && c.tick >= end) issues.warn('chord.past-end', `Chord "${c.symbol}" starts after the end of the song.`);
    valid.push(c);
  }
  valid.sort((a, b) => a.tick - b.tick);
  for (let i = 0; i + 1 < valid.length; i++) {
    const a = valid[i];
    const b = valid[i + 1];
    const aEnd = a.tick + a.duration;
    if (b.tick < aEnd) {
      issues.error('chord.overlap', `Chords "${a.symbol}" and "${b.symbol}" overlap (${barsLabel(song, b.tick, Math.min(aEnd, b.tick + b.duration))}).`);
    } else if (b.tick > aEnd) {
      issues.warn('chord.gap', `No chord between "${a.symbol}" and "${b.symbol}" (${barsLabel(song, aEnd, b.tick)}).`);
    }
  }
}

/** Reconstruct the words sung on notes from "-" continuation markers. */
export function syllablesToWords(syllables: readonly string[]): string[] {
  const words: string[] = [];
  let cur = '';
  let open = false;
  for (const raw of syllables) {
    if (raw === '_' || raw === '') continue;
    const startsCont = raw.startsWith('-');
    const text = raw.replace(/^-+|-+$/g, '');
    if (open || startsCont) cur += text;
    else {
      if (cur) words.push(cur);
      cur = text;
    }
    open = raw.endsWith('-');
  }
  if (cur) words.push(cur);
  return words;
}

function normWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/[-']/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

function validateLyrics(song: Song, issues: IssueList): void {
  if (!song.lyrics.length) return;
  const sections = new Map(song.sections.map((s) => [s.id, s] as const));
  const tracks = new Map(song.tracks.map((t) => [t.id, t] as const));
  const spans = new Map(sectionLayout(song).map((s) => [s.section.id, s] as const));
  const defaultVocal = song.tracks.find((t) => t.role === 'vocal' && t.kind === 'midi');
  const bySection = new Map<string, typeof song.lyrics>();
  for (const line of song.lyrics) {
    if (!sections.has(line.sectionId)) {
      issues.warn('lyrics.section-missing', `Lyric line "${line.text.slice(0, 40)}" refers to a missing section.`);
      continue;
    }
    if (line.trackId && !tracks.has(line.trackId)) issues.warn('lyrics.track-missing', `Lyric line "${line.text.slice(0, 40)}" refers to a missing track.`, { sectionId: line.sectionId });
    const list = bySection.get(line.sectionId) ?? [];
    list.push(line);
    bySection.set(line.sectionId, list);
  }
  for (const [sid, lines] of bySection) {
    const section = sections.get(sid)!;
    const span = spans.get(sid);
    const withTrack = lines.find((l) => l.trackId && tracks.has(l.trackId));
    const track = (withTrack ? tracks.get(withTrack.trackId!) : undefined) ?? defaultVocal;
    const text = lines.map((l) => l.text).join(' ');
    if (!text.trim()) continue;
    if (!track || !span) {
      issues.info('lyrics.no-vocal', `"${section.name}" has lyrics but there is no vocal track to sing them.`, { sectionId: sid });
      continue;
    }
    const notes = track.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick);
    if (!notes.length) {
      issues.warn('lyrics.no-vocal', `"${section.name}" has lyrics but "${track.name}" has no notes there.`, { sectionId: sid, trackId: track.id });
      continue;
    }
    const sung = notes.filter((n) => n.syllable && n.syllable !== '_');
    const expected = estimateSyllables(text);
    if (!sung.length) {
      if (notes.length < expected * 0.8) {
        issues.warn('lyrics.too-many-syllables', `"${section.name}" has about ${expected} syllables of lyrics but only ${notes.length} vocal notes.`, { sectionId: sid, trackId: track.id });
      } else {
        issues.info('lyrics.unaligned', `Lyrics of "${section.name}" are not aligned to the vocal notes yet.`, { sectionId: sid, trackId: track.id });
      }
      continue;
    }
    // Per-line word check for notes that reference their line.
    let lineMismatch = false;
    for (const line of lines) {
      const lineNotes = notes.filter((n) => n.lyricLineId === line.id);
      if (!lineNotes.length) continue;
      const sungWords = syllablesToWords(lineNotes.map((n) => n.syllable ?? '')).map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''));
      const lineWords = normWords(line.text).map((w) => w.replace(/[^a-z0-9]/g, ''));
      if (sungWords.join(' ') !== lineWords.join(' ')) {
        lineMismatch = true;
        issues.warn('lyrics.mismatch', `The syllables sung in "${section.name}" do not match the lyric line "${line.text.slice(0, 50)}".`, { sectionId: sid, trackId: track.id });
      }
    }
    if (lineMismatch) continue;
    const diff = Math.abs(sung.length - expected);
    if (diff > Math.max(2, expected * 0.25)) {
      issues.warn('lyrics.misaligned', `"${section.name}": ${sung.length} sung syllables vs. about ${expected} syllables in the lyrics.`, { sectionId: sid, trackId: track.id });
    }
  }
}

export interface ValidateChangeOptions {
  /** Requested range: notes/chords starting outside it must be unchanged. */
  region?: { startTick: number; endTick: number };
  /** Requested tracks: other tracks must be unchanged. */
  trackIds?: string[];
  /** Lock map to enforce (default: `before.locks`). */
  locks?: LockMap;
}

/**
 * Validate a change: locked material unchanged (section-relative, so unrelated structure edits
 * are fine) and, when given, the requested region/tracks honored.
 */
export function validateChange(before: Song, after: Song, opts: ValidateChangeOptions = {}): ValidationReport {
  const issues = [...lockViolations(before, after, opts.locks ?? before.locks ?? {}), ...scopeViolations(before, after, opts)];
  return makeReport(issues);
}
