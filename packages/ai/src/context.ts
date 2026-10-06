/**
 * MusicContext (spec §45): the normalized, provider-neutral view of a song that AI providers
 * receive instead of the raw project format. Adapters/prompts translate it into model-specific
 * text with `musicContextToPrompt`.
 *
 * All bar/beat positions are 1-BASED (AI operation convention). Large songs are budgeted: note
 * lists of unselected tracks are replaced by summaries first; the user's selection is never
 * silently dropped.
 */
import {
  barToTick,
  bpmAtTick,
  describeSinger,
  singerForTrack,
  chordsInRange,
  chordToRoman,
  createTimeMap,
  getTag,
  isLocked,
  isTrackSectionLocked,
  keyAtTick,
  keyName,
  keyPrefersFlats,
  LockKeys,
  meterAtBar,
  midiToNoteName,
  sectionLayout,
  songLengthBars,
  songTags,
  songLengthTicks,
  tickToBar,
  tickToMusical,
  ticksToBeats,
  type ChannelStrip,
  type EditSelection,
  type KeySignature,
  type Note,
  type SectionSpan,
  type Song,
  type Track,
} from '@songdeck/core';
import { estimateTokens, round } from './util';

export interface ContextNote {
  id: string;
  bar: number;
  beat: number;
  pitch: string;
  /** GM drum name on drum tracks. */
  drum?: string;
  duration_beats: number;
  velocity: number;
  locked?: boolean;
  syllable?: string;
  articulation?: string;
}

export interface ContextSelectedNote extends ContextNote {
  track: string;
}

export interface ContextSection {
  id: string;
  name: string;
  kind: string;
  bars: number;
  start_bar: number;
  end_bar: number;
  energy: number;
  energy_end?: number;
  purpose?: string;
  mood?: string[];
  feel?: string;
  progression?: string[];
  repeat_of?: string;
  locked?: boolean;
}

export interface ContextChord {
  bar: number;
  beat: number;
  symbol: string;
  roman?: string;
  duration_beats: number;
}

export interface ContextTrack {
  id: string;
  name: string;
  role: string;
  instrument: string;
  kind: 'midi' | 'audio';
  function?: string;
  /** Allowed/observed range, e.g. "E1-G3". */
  range?: string;
  /** The singer of a vocal part and their range zones (keep the melody in the easy zones). */
  singer?: string;
  /** true = whole track locked; list = section names where it is locked. */
  locked: boolean | string[];
  selected?: boolean;
  /** Total notes in the whole song. */
  note_count: number;
  /** Notes in focus (absent when summarized). */
  notes?: ContextNote[];
  /** Summary replacing `notes` when the note budget is exceeded. */
  summary?: string;
}

export interface ContextMotif {
  id: string;
  name: string;
  role: string;
  description?: string;
  length_beats: number;
  /** Scale-degree contour of the motif (0 = anchor). */
  degrees: number[];
  source_track?: string;
}

export interface ContextLyricLine {
  id: string;
  section: string;
  text: string;
  track?: string;
  locked?: boolean;
}

export interface ContextMixerStrip {
  track: string;
  volume_db: number;
  pan: number;
  mute?: boolean;
  solo?: boolean;
  reverb_send: number;
  delay_send: number;
  width?: number;
  drive?: number;
  eq?: string;
  compressor?: string;
  locked?: boolean;
}

export interface ContextInstrumentConstraint {
  track: string;
  lowest?: string;
  highest?: string;
  complexity?: string;
  function?: string;
  avoid?: string[];
  sections?: string[];
}

export interface ContextConstraints {
  /** Human-readable lock descriptions. */
  locks: string[];
  /** Note-level locks within focus. */
  locked_note_ids: string[];
  instruments: ContextInstrumentConstraint[];
  /** When set, changes must stay inside this region. */
  region?: { start_bar: number; end_bar: number };
  rules: string[];
}

export interface MusicContext {
  title: string;
  /** BPM at the focus start. */
  tempo: number;
  tempo_changes?: { bar: number; bpm: number }[];
  /** "4/4" */
  meter: string;
  meter_changes?: { bar: number; meter: string }[];
  /** "E minor" */
  key: string;
  key_changes?: { bar: number; key: string }[];
  styles?: string[];
  /** Tag-catalog tags of the song, as "Name (kind)" — e.g. "Lo-fi (production)". */
  tags?: string[];
  moods?: string[];
  total_bars: number;
  duration_seconds: number;
  focus: { start_bar: number; end_bar: number; description: string };
  /** Section containing the focus (or the requested section). */
  section?: ContextSection;
  sections: ContextSection[];
  chords: ContextChord[];
  tracks: ContextTrack[];
  motifs: ContextMotif[];
  selected_notes: ContextSelectedNote[];
  energy: { section: string; energy: number; energy_end?: number }[];
  constraints: ContextConstraints;
  lyrics: ContextLyricLine[];
  mixer: ContextMixerStrip[];
  instruction: string;
  truncation?: { omitted_notes: number; summarized_tracks: string[] };
}

export interface BuildMusicContextOptions {
  instruction: string;
  selection?: EditSelection;
  sectionId?: string;
  /** Restrict tracks (selected tracks are always included). */
  trackIds?: string[];
  /** Max note rows across track lists (selection excluded, always kept). Default 400. */
  maxNotes?: number;
  /** Approximate token budget for the rendered prompt; tracks are summarized until it fits. */
  maxTokens?: number;
  /** Include mixer summary (default true). */
  includeMixer?: boolean;
}

const GM_DRUM_NAMES: Record<number, string> = {
  35: 'kick',
  36: 'kick',
  37: 'side-stick',
  38: 'snare',
  39: 'clap',
  40: 'snare',
  41: 'floor-tom',
  42: 'hihat-closed',
  43: 'floor-tom',
  44: 'hihat-pedal',
  45: 'tom-low',
  46: 'hihat-open',
  47: 'tom-mid',
  48: 'tom-high',
  49: 'crash',
  50: 'tom-high',
  51: 'ride',
  52: 'china',
  53: 'ride-bell',
  54: 'tambourine',
  55: 'splash',
  56: 'cowbell',
  57: 'crash',
  59: 'ride',
};

const isDrumTrack = (t: Track) => t.role === 'drums' || t.role === 'percussion' || t.midiChannel === 9;

function noteName(pitch: number, key: KeySignature): string {
  return midiToNoteName(pitch, keyPrefersFlats(key));
}

function sectionToContext(span: SectionSpan, song: Song): ContextSection {
  const s = span.section;
  const out: ContextSection = {
    id: s.id,
    name: s.name,
    kind: s.kind,
    bars: s.bars,
    start_bar: span.startBar + 1,
    end_bar: span.endBar,
    energy: s.energy,
  };
  if (s.energyEnd !== undefined) out.energy_end = s.energyEnd;
  if (s.purpose) out.purpose = s.purpose;
  if (s.mood?.length) out.mood = [...s.mood];
  if (s.feel && s.feel !== 'normal') out.feel = s.feel;
  if (s.progression?.length) out.progression = [...s.progression];
  if (s.repeatOf) out.repeat_of = song.sections.find((x) => x.id === s.repeatOf)?.name ?? s.repeatOf;
  if (isLocked(song.locks, LockKeys.section(s.id))) out.locked = true;
  return out;
}

function noteToContext(
  song: Song,
  track: Track,
  n: Note,
  key: KeySignature,
  lockedFn: (n: Note) => boolean,
): ContextNote {
  const pos = tickToMusical(song, n.tick);
  const out: ContextNote = {
    id: n.id,
    bar: pos.bar,
    beat: round(pos.beat, 3),
    pitch: noteName(n.pitch, key),
    duration_beats: round(ticksToBeats(song, n.duration, n.tick), 3),
    velocity: Math.round(n.velocity),
  };
  if (isDrumTrack(track) && GM_DRUM_NAMES[n.pitch]) out.drum = GM_DRUM_NAMES[n.pitch];
  if (lockedFn(n)) out.locked = true;
  if (n.syllable) out.syllable = n.syllable;
  if (n.articulation && n.articulation !== 'normal') out.articulation = n.articulation;
  return out;
}

function summarizeNotes(song: Song, notes: Note[], key: KeySignature, drum: boolean): string {
  if (!notes.length) return 'no notes in focus';
  let lo = 127;
  let hi = 0;
  let vel = 0;
  const bars = new Set<number>();
  const durCounts = new Map<number, number>();
  const drumCounts = new Map<string, number>();
  for (const n of notes) {
    lo = Math.min(lo, n.pitch);
    hi = Math.max(hi, n.pitch);
    vel += n.velocity;
    const beats = round(ticksToBeats(song, n.duration, n.tick), 2);
    durCounts.set(beats, (durCounts.get(beats) ?? 0) + 1);
    bars.add(tickToBar(song, n.tick).bar);
    if (drum) {
      const name = GM_DRUM_NAMES[n.pitch] ?? String(n.pitch);
      drumCounts.set(name, (drumCounts.get(name) ?? 0) + 1);
    }
  }
  const typical = [...durCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const barList = [...bars].sort((a, b) => a - b);
  const parts = [
    `${notes.length} notes`,
    drum
      ? `hits: ${[...drumCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 6)
          .map(([k, v]) => `${k}×${v}`)
          .join(' ')}`
      : `range ${noteName(lo, key)}-${noteName(hi, key)}`,
    `avg velocity ${Math.round(vel / notes.length)}`,
    `typical duration ${typical} beats`,
    `avg ${round(notes.length / Math.max(1, barList.length), 1)} notes/bar over bars ${barList[0] + 1}-${barList[barList.length - 1] + 1}`,
  ];
  return parts.join(', ');
}

function mixerSummary(trackName: string, strip: ChannelStrip, locked: boolean): ContextMixerStrip {
  const out: ContextMixerStrip = {
    track: trackName,
    volume_db: round(strip.volumeDb, 1),
    pan: round(strip.pan, 2),
    reverb_send: round(strip.reverbSend, 2),
    delay_send: round(strip.delaySend, 2),
  };
  if (strip.mute) out.mute = true;
  if (strip.solo) out.solo = true;
  if (strip.width !== 1) out.width = round(strip.width, 2);
  if (strip.drive > 0) out.drive = round(strip.drive, 2);
  const eq = strip.eq;
  if (eq?.enabled) {
    const bits: string[] = [];
    if (eq.highpassHz > 0) bits.push(`HP ${Math.round(eq.highpassHz)} Hz`);
    if (eq.lowShelfDb)
      bits.push(
        `low shelf ${eq.lowShelfDb > 0 ? '+' : ''}${round(eq.lowShelfDb, 1)} dB @${Math.round(eq.lowShelfHz)} Hz`,
      );
    if (eq.lowMidDb)
      bits.push(
        `low-mid ${eq.lowMidDb > 0 ? '+' : ''}${round(eq.lowMidDb, 1)} dB @${Math.round(eq.lowMidHz)} Hz`,
      );
    if (eq.highMidDb)
      bits.push(
        `high-mid ${eq.highMidDb > 0 ? '+' : ''}${round(eq.highMidDb, 1)} dB @${Math.round(eq.highMidHz)} Hz`,
      );
    if (eq.highShelfDb)
      bits.push(
        `high shelf ${eq.highShelfDb > 0 ? '+' : ''}${round(eq.highShelfDb, 1)} dB @${Math.round(eq.highShelfHz)} Hz`,
      );
    if (eq.lowpassHz > 0) bits.push(`LP ${Math.round(eq.lowpassHz)} Hz`);
    if (bits.length) out.eq = bits.join(', ');
  }
  const c = strip.compressor;
  if (c?.enabled)
    out.compressor = `${round(c.thresholdDb, 1)} dB ${round(c.ratio, 1)}:1 attack ${round(c.attackMs, 1)} ms release ${Math.round(c.releaseMs)} ms`;
  if (locked) out.locked = true;
  return out;
}

function describeLock(song: Song, key: string): string | undefined {
  const trackName = (id: string) => song.tracks.find((t) => t.id === id)?.name ?? id;
  const sectionName = (id: string) => song.sections.find((s) => s.id === id)?.name ?? id;
  const simple: Record<string, string> = {
    [LockKeys.tempo]: 'Tempo is locked',
    [LockKeys.key]: 'Key is locked',
    [LockKeys.meter]: 'Meter is locked',
    [LockKeys.structure]: 'Song structure (sections) is locked',
    [LockKeys.chords]: 'All chords are locked',
    [LockKeys.lyrics]: 'All lyrics are locked',
    [LockKeys.motifs]: 'Motifs are locked',
  };
  if (simple[key]) return simple[key];
  let m: RegExpExecArray | null;
  if ((m = /^track:([^:]+):section:(.+)$/.exec(key)))
    return `Track "${trackName(m[1])}" is locked in "${sectionName(m[2])}"`;
  if ((m = /^track:(.+)$/.exec(key))) return `Track "${trackName(m[1])}" is locked`;
  if ((m = /^section:(.+)$/.exec(key))) return `Section "${sectionName(m[1])}" is locked (all material)`;
  if ((m = /^chords:section:(.+)$/.exec(key))) return `Chords in "${sectionName(m[1])}" are locked`;
  if ((m = /^lyrics:section:(.+)$/.exec(key))) return `Lyrics in "${sectionName(m[1])}" are locked`;
  if ((m = /^motif:(.+)$/.exec(key)))
    return `Motif "${song.motifs.find((x) => x.id === m![1])?.name ?? m[1]}" is locked`;
  if ((m = /^mixer:(.+)$/.exec(key))) return `Mixer strip of "${trackName(m[1])}" is locked`;
  return `Locked: ${key}`;
}

/** Build the MusicContext for a request. */
export function buildMusicContext(song: Song, opts: BuildMusicContextOptions): MusicContext {
  const layout = sectionLayout(song);
  const totalBars = songLengthBars(song);
  const songEnd = songLengthTicks(song);
  const sel = opts.selection ?? {};
  const selectedNoteIds = new Set(sel.noteIds ?? []);
  const selectedTrackIds = new Set(sel.trackIds ?? []);

  // ---- Focus range [start, end)
  let start = 0;
  let end = Math.max(songEnd, 1);
  let description = 'whole song';
  let focusSpan: SectionSpan | undefined;
  if (sel.startTick !== undefined || sel.endTick !== undefined) {
    start = Math.max(0, sel.startTick ?? 0);
    end = Math.max(start + 1, sel.endTick ?? songEnd);
    description = 'selected range';
  } else if (sel.sectionIds?.length) {
    const spans = layout.filter((s) => sel.sectionIds!.includes(s.section.id));
    if (spans.length) {
      start = Math.min(...spans.map((s) => s.startTick));
      end = Math.max(...spans.map((s) => s.endTick));
      description = spans.map((s) => s.section.name).join(', ');
      focusSpan = spans[0];
    }
  } else if (opts.sectionId) {
    const span = layout.find((s) => s.section.id === opts.sectionId);
    if (span) {
      start = span.startTick;
      end = span.endTick;
      description = span.section.name;
      focusSpan = span;
    }
  } else if (selectedNoteIds.size) {
    const notes = song.tracks.flatMap((t) => t.notes.filter((n) => selectedNoteIds.has(n.id)));
    if (notes.length) {
      const first = Math.min(...notes.map((n) => n.tick));
      const last = Math.max(...notes.map((n) => n.tick + n.duration));
      const firstPos = tickToBar(song, first);
      const lastBar = tickToBar(song, Math.max(first, last - 1)).bar;
      start = first - firstPos.tickInBar;
      end = Math.max(barToTick(song, lastBar + 1), start + 1);
      description = `selected notes (bars ${firstPos.bar + 1}-${lastBar + 1})`;
    }
  }
  if (!focusSpan) focusSpan = layout.find((s) => start >= s.startTick && start < s.endTick) ?? layout[0];
  const startBar1 = tickToMusical(song, start).bar;
  const endBar1 = tickToMusical(song, Math.max(start, end - 1)).bar;
  const wholeSong = start <= 0 && end >= songEnd;

  const key = keyAtTick(song, start);
  const meter = meterAtBar(song, startBar1 - 1);

  // ---- Tempo / meter / key changes
  const tempoChanges = [...song.tempoMap].sort((a, b) => a.tick - b.tick);
  const meterChanges = [...song.meterMap].sort((a, b) => a.bar - b.bar);
  const keyChanges = [...song.keyMap].sort((a, b) => a.bar - b.bar);

  // ---- Sections
  const sections = layout.map((s) => sectionToContext(s, song));
  const sectionByName = new Map(layout.map((s) => [s.section.id, s.section.name]));

  // ---- Chords in focus
  const chords: ContextChord[] = chordsInRange(song, start, end).map((c) => {
    const pos = tickToMusical(song, c.tick);
    const k = keyAtTick(song, c.tick);
    let roman = c.roman;
    if (!roman) {
      try {
        roman = chordToRoman(c, k);
      } catch {
        roman = undefined;
      }
    }
    const out: ContextChord = {
      bar: pos.bar,
      beat: round(pos.beat, 3),
      symbol: c.symbol,
      duration_beats: round(ticksToBeats(song, c.duration, c.tick), 3),
    };
    if (roman) out.roman = roman;
    return out;
  });

  // ---- Tracks
  const includeTrack = (t: Track) =>
    !opts.trackIds?.length ||
    opts.trackIds.includes(t.id) ||
    selectedTrackIds.has(t.id) ||
    t.notes.some((n) => selectedNoteIds.has(n.id));
  const tracksInScope = song.tracks.filter(includeTrack);
  const lockedNoteIds: string[] = [];
  const selectedNotes: ContextSelectedNote[] = [];

  interface Draft {
    track: Track;
    ctx: ContextTrack;
    focusNotes: Note[];
    rows: ContextNote[];
    selectedTrack: boolean;
  }
  const drafts: Draft[] = tracksInScope.map((track) => {
    const wholeLocked = isLocked(song.locks, LockKeys.track(track.id));
    const lockedSections = layout
      .filter((s) => isTrackSectionLocked(song, track.id, s.section.id))
      .map((s) => s.section.name);
    const lockedRanges = layout.filter((s) => isTrackSectionLocked(song, track.id, s.section.id));
    const lockedFn = (n: Note) =>
      n.locked === true ||
      wholeLocked ||
      lockedRanges.some((r) => n.tick >= r.startTick && n.tick < r.endTick);
    const focusNotes = track.notes
      .filter((n) => n.tick >= start && n.tick < end)
      .sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    const rows = focusNotes.map((n) => noteToContext(song, track, n, keyAtTick(song, n.tick), lockedFn));
    for (const n of focusNotes) if (n.locked) lockedNoteIds.push(n.id);
    for (const n of track.notes) {
      if (selectedNoteIds.has(n.id))
        selectedNotes.push({
          ...noteToContext(song, track, n, keyAtTick(song, n.tick), lockedFn),
          track: track.name,
        });
    }
    let range: string | undefined;
    const c = track.constraints ?? {};
    if (c.lowest !== undefined && c.highest !== undefined)
      range = `${noteName(c.lowest, key)}-${noteName(c.highest, key)}`;
    else if (track.notes.length && !isDrumTrack(track)) {
      const lo = Math.min(...track.notes.map((n) => n.pitch));
      const hi = Math.max(...track.notes.map((n) => n.pitch));
      range = `${noteName(lo, key)}-${noteName(hi, key)} (observed)`;
    }
    const ctx: ContextTrack = {
      id: track.id,
      name: track.name,
      role: track.role,
      instrument: track.instrumentId,
      kind: track.kind,
      locked: wholeLocked ? true : lockedSections.length ? lockedSections : false,
      note_count: track.notes.length,
    };
    if (c.function) ctx.function = c.function;
    if (range) ctx.range = range;
    const singer = singerForTrack(song, track);
    if (singer) ctx.singer = `${singer.name}: ${describeSinger(singer)}`;
    const selectedTrack =
      selectedTrackIds.has(track.id) || track.notes.some((n) => selectedNoteIds.has(n.id));
    if (selectedTrack) ctx.selected = true;
    return { track, ctx, focusNotes, rows, selectedTrack };
  });

  // ---- Note budget: selected tracks first, then song order; summarize what does not fit.
  const maxNotes = Math.max(0, opts.maxNotes ?? 400);
  let remaining = maxNotes;
  let omitted = 0;
  const summarized: string[] = [];
  const ordered = [...drafts].sort((a, b) => Number(b.selectedTrack) - Number(a.selectedTrack));
  for (const d of ordered) {
    if (d.track.kind === 'audio' && !d.rows.length) {
      d.ctx.summary = `audio track (${d.track.clips.length} clip${d.track.clips.length === 1 ? '' : 's'})`;
      continue;
    }
    if (d.rows.length <= remaining) {
      d.ctx.notes = d.rows;
      remaining -= d.rows.length;
    } else {
      d.ctx.summary = summarizeNotes(song, d.focusNotes, key, isDrumTrack(d.track));
      omitted += d.rows.length;
      summarized.push(d.track.name);
    }
  }

  // ---- Constraints
  const locks = Object.entries(song.locks)
    .filter(([, v]) => v)
    .map(([k]) => describeLock(song, k))
    .filter((s): s is string => !!s)
    .sort();
  const instruments: ContextInstrumentConstraint[] = tracksInScope
    .map((t) => {
      const c = t.constraints ?? {};
      const out: ContextInstrumentConstraint = { track: t.name };
      if (c.lowest !== undefined) out.lowest = noteName(c.lowest, key);
      if (c.highest !== undefined) out.highest = noteName(c.highest, key);
      if (c.complexity) out.complexity = c.complexity;
      if (c.function) out.function = c.function;
      if (c.avoid?.length) out.avoid = [...c.avoid];
      if (c.sectionIds?.length) out.sections = c.sectionIds.map((id) => sectionByName.get(id) ?? id);
      return out;
    })
    .filter((x) => Object.keys(x).length > 1);
  const rules = ['Never modify locked material.', 'Keep notes inside each instrument range.'];
  if (!wholeSong)
    rules.push(
      `Only change material inside bars ${startBar1}-${endBar1} unless the instruction explicitly says otherwise.`,
    );
  const constraints: ContextConstraints = { locks, locked_note_ids: lockedNoteIds, instruments, rules };
  if (!wholeSong) constraints.region = { start_bar: startBar1, end_bar: endBar1 };

  // ---- Lyrics in focus sections
  const focusSectionIds = new Set(
    layout.filter((s) => s.startTick < end && s.endTick > start).map((s) => s.section.id),
  );
  const lyrics: ContextLyricLine[] = song.lyrics
    .filter((l) => focusSectionIds.has(l.sectionId))
    .map((l) => {
      const out: ContextLyricLine = {
        id: l.id,
        section: sectionByName.get(l.sectionId) ?? l.sectionId,
        text: l.text,
      };
      if (l.trackId) out.track = song.tracks.find((t) => t.id === l.trackId)?.name ?? l.trackId;
      if (isLocked(song.locks, LockKeys.lyrics) || isLocked(song.locks, LockKeys.sectionLyrics(l.sectionId)))
        out.locked = true;
      return out;
    });

  // ---- Mixer
  const mixer: ContextMixerStrip[] =
    opts.includeMixer === false
      ? []
      : tracksInScope
          .filter((t) => song.mixer.channels[t.id])
          .map((t) =>
            mixerSummary(t.name, song.mixer.channels[t.id], isLocked(song.locks, LockKeys.mixer(t.id))),
          );

  // ---- Motifs
  const ppq = song.ppq;
  const motifs: ContextMotif[] = song.motifs.map((m) => {
    const out: ContextMotif = {
      id: m.id,
      name: m.name,
      role: m.role,
      length_beats: round(m.lengthTicks / ppq, 3),
      degrees: m.notes.slice(0, 24).map((n) => n.degree),
    };
    if (m.description) out.description = m.description;
    if (m.sourceTrackId)
      out.source_track = song.tracks.find((t) => t.id === m.sourceTrackId)?.name ?? m.sourceTrackId;
    return out;
  });

  const ctx: MusicContext = {
    title: song.title,
    tempo: round(bpmAtTick(song, start), 2),
    meter: `${meter.numerator}/${meter.denominator}`,
    key: keyName(key),
    total_bars: totalBars,
    duration_seconds: round(createTimeMap(song).tickToSeconds(songEnd), 1),
    focus: { start_bar: startBar1, end_bar: endBar1, description },
    sections,
    chords,
    tracks: drafts.map((d) => d.ctx),
    motifs,
    selected_notes: selectedNotes,
    energy: layout.map((s) => ({
      section: s.section.name,
      energy: s.section.energy,
      ...(s.section.energyEnd !== undefined ? { energy_end: s.section.energyEnd } : {}),
    })),
    constraints,
    lyrics,
    mixer,
    instruction: opts.instruction,
  };
  if (tempoChanges.length > 1)
    ctx.tempo_changes = tempoChanges.map((t) => ({ bar: tickToMusical(song, t.tick).bar, bpm: t.bpm }));
  if (meterChanges.length > 1)
    ctx.meter_changes = meterChanges.map((m) => ({
      bar: m.bar + 1,
      meter: `${m.numerator}/${m.denominator}`,
    }));
  if (keyChanges.length > 1)
    ctx.key_changes = keyChanges.map((k) => ({ bar: k.bar + 1, key: keyName(k.key) }));
  const styles = song.blueprint?.styles?.length
    ? song.blueprint.styles
    : song.genreBlend.map((g) => g.genreId);
  if (styles.length) ctx.styles = [...styles];
  const tagIds = songTags(song);
  if (tagIds.length)
    ctx.tags = tagIds
      .map((id) => getTag(id))
      .filter((t) => t !== undefined)
      .map((t) => `${t.name} (${t.kind})`);
  if (song.blueprint?.moods?.length) ctx.moods = [...song.blueprint.moods];
  if (focusSpan) ctx.section = sectionToContext(focusSpan, song);
  if (omitted || summarized.length)
    ctx.truncation = { omitted_notes: omitted, summarized_tracks: summarized };

  if (opts.maxTokens) fitToTokenBudget(song, ctx, drafts, key, opts.maxTokens);
  return ctx;
}

/** Summarize unselected (then selected) track note lists until the prompt fits the budget. */
function fitToTokenBudget(
  song: Song,
  ctx: MusicContext,
  drafts: { track: Track; ctx: ContextTrack; focusNotes: Note[]; selectedTrack: boolean }[],
  key: KeySignature,
  maxTokens: number,
): void {
  const over = () => estimateTokens(musicContextToPrompt(ctx)) > maxTokens;
  if (!over()) return;
  const candidates = drafts
    .filter((d) => d.ctx.notes && d.ctx.notes.length)
    .sort(
      (a, b) =>
        Number(a.selectedTrack) - Number(b.selectedTrack) || b.ctx.notes!.length - a.ctx.notes!.length,
    );
  for (const d of candidates) {
    if (!over()) break;
    const count = d.ctx.notes!.length;
    delete d.ctx.notes;
    d.ctx.summary = summarizeNotes(song, d.focusNotes, key, isDrumTrack(d.track));
    ctx.truncation = ctx.truncation ?? { omitted_notes: 0, summarized_tracks: [] };
    ctx.truncation.omitted_notes += count;
    ctx.truncation.summarized_tracks.push(d.track.name);
  }
  if (over() && ctx.mixer.length) ctx.mixer = [];
  if (over()) {
    for (const s of ctx.sections) {
      delete s.purpose;
      delete s.mood;
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round(n, 3));
}

function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function noteRow(n: ContextNote): string {
  const pitch = n.drum ? `${n.pitch}(${n.drum})` : n.pitch;
  let row = `${n.bar}:${fmtNum(n.beat)} ${pitch} ${fmtNum(n.duration_beats)} ${n.velocity}`;
  if (n.articulation) row += ` ${n.articulation}`;
  if (n.syllable) row += ` "${n.syllable}"`;
  if (n.locked) row += ' L';
  return row;
}

/** Deterministic compact text rendering of a MusicContext for prompts. */
export function musicContextToPrompt(ctx: MusicContext): string {
  const lines: string[] = [];
  lines.push(
    `SONG: "${ctx.title}" — ${fmtNum(ctx.tempo)} BPM, ${ctx.meter}, ${ctx.key}, ${ctx.total_bars} bars (${fmtDuration(ctx.duration_seconds)})`,
  );
  if (ctx.styles?.length) lines.push(`STYLE: ${ctx.styles.join(', ')}`);
  if (ctx.tags?.length) lines.push(`STYLE TAGS: ${ctx.tags.join(', ')}`);
  if (ctx.moods?.length) lines.push(`MOODS: ${ctx.moods.join('; ')}`);
  if (ctx.tempo_changes?.length)
    lines.push(
      `TEMPO MAP: ${ctx.tempo_changes.map((t) => `bar ${t.bar} → ${fmtNum(t.bpm)} BPM`).join(', ')}`,
    );
  if (ctx.meter_changes?.length)
    lines.push(`METER MAP: ${ctx.meter_changes.map((m) => `bar ${m.bar} → ${m.meter}`).join(', ')}`);
  if (ctx.key_changes?.length)
    lines.push(`KEY MAP: ${ctx.key_changes.map((k) => `bar ${k.bar} → ${k.key}`).join(', ')}`);

  lines.push('SECTIONS (1-based inclusive bars):');
  ctx.sections.forEach((s, i) => {
    let row = `  ${i + 1}. ${s.name} [${s.kind}] bars ${s.start_bar}-${s.end_bar}, energy ${fmtNum(s.energy)}${s.energy_end !== undefined ? `→${fmtNum(s.energy_end)}` : ''}`;
    if (s.feel) row += `, ${s.feel}`;
    if (s.progression?.length) row += `, progression ${s.progression.join(' ')}`;
    if (s.purpose) row += `, purpose: ${s.purpose}`;
    if (s.mood?.length) row += `, mood: ${s.mood.join('/')}`;
    if (s.repeat_of) row += `, repeats ${s.repeat_of}`;
    if (s.locked) row += ' [LOCKED]';
    lines.push(row);
  });
  lines.push(
    `FOCUS: bars ${ctx.focus.start_bar}-${ctx.focus.end_bar} (${ctx.focus.description})${ctx.section ? ` — section "${ctx.section.name}"` : ''}`,
  );

  if (ctx.chords.length) {
    lines.push(
      `CHORDS in focus (bar:beat symbol roman beats): ${ctx.chords.map((c) => `${c.bar}:${fmtNum(c.beat)} ${c.symbol}${c.roman ? ` ${c.roman}` : ''} ${fmtNum(c.duration_beats)}`).join(' | ')}`,
    );
  } else {
    lines.push('CHORDS in focus: none');
  }

  lines.push('TRACKS:');
  for (const t of ctx.tracks) {
    let head = `  - "${t.name}" (id ${t.id}) role=${t.role} instrument=${t.instrument}`;
    if (t.function) head += ` function=${t.function}`;
    if (t.range) head += ` range=${t.range}`;
    if (t.singer) head += ` singer=(${t.singer})`;
    if (t.locked === true) head += ' [LOCKED]';
    else if (Array.isArray(t.locked) && t.locked.length) head += ` [LOCKED in: ${t.locked.join(', ')}]`;
    if (t.selected) head += ' [SELECTED]';
    head += ` notes_total=${t.note_count}`;
    lines.push(head);
    if (t.notes) {
      lines.push(
        t.notes.length
          ? `    notes in focus (bar:beat pitch beats velocity): ${t.notes.map(noteRow).join(', ')}`
          : '    notes in focus: none',
      );
    } else if (t.summary) {
      lines.push(`    summary: ${t.summary}`);
    }
  }
  if (ctx.selected_notes.length) {
    lines.push(
      `SELECTED NOTES (id track bar:beat pitch beats velocity): ${ctx.selected_notes.map((n) => `${n.id} ${n.track} ${noteRow(n)}`).join('; ')}`,
    );
  }
  if (ctx.motifs.length) {
    lines.push(
      `MOTIFS: ${ctx.motifs.map((m) => `${m.name} (${m.role}, ${fmtNum(m.length_beats)} beats${m.source_track ? `, ${m.source_track}` : ''}): degrees ${m.degrees.join(' ')}`).join(' | ')}`,
    );
  }
  lines.push('CONSTRAINTS:');
  for (const r of ctx.constraints.rules) lines.push(`  - ${r}`);
  for (const l of ctx.constraints.locks) lines.push(`  - ${l}`);
  if (ctx.constraints.locked_note_ids.length)
    lines.push(`  - Locked notes (marked L): ${ctx.constraints.locked_note_ids.length}`);
  for (const c of ctx.constraints.instruments) {
    const bits: string[] = [];
    if (c.lowest || c.highest) bits.push(`range ${c.lowest ?? '?'}-${c.highest ?? '?'}`);
    if (c.complexity) bits.push(`${c.complexity} complexity`);
    if (c.function) bits.push(c.function);
    if (c.avoid?.length) bits.push(`avoid ${c.avoid.join(', ')}`);
    if (c.sections?.length) bits.push(`plays in ${c.sections.join(', ')}`);
    lines.push(`  - ${c.track}: ${bits.join('; ')}`);
  }
  if (ctx.lyrics.length) {
    lines.push('LYRICS in focus:');
    const bySection = new Map<string, ContextLyricLine[]>();
    for (const l of ctx.lyrics) bySection.set(l.section, [...(bySection.get(l.section) ?? []), l]);
    for (const [section, ls] of bySection)
      lines.push(
        `  ${section}${ls.some((l) => l.locked) ? ' [LOCKED]' : ''}: ${ls.map((l) => `"${l.text}"`).join(' / ')}`,
      );
  }
  if (ctx.mixer.length) {
    lines.push(
      `MIXER: ${ctx.mixer
        .map((m) => {
          const bits = [
            `vol ${fmtNum(m.volume_db)} dB`,
            `pan ${fmtNum(m.pan)}`,
            `rev ${fmtNum(m.reverb_send)}`,
            `dly ${fmtNum(m.delay_send)}`,
          ];
          if (m.mute) bits.push('muted');
          if (m.solo) bits.push('solo');
          if (m.width !== undefined) bits.push(`width ${fmtNum(m.width)}`);
          if (m.drive !== undefined) bits.push(`drive ${fmtNum(m.drive)}`);
          if (m.eq) bits.push(`EQ ${m.eq}`);
          if (m.compressor) bits.push(`comp ${m.compressor}`);
          if (m.locked) bits.push('LOCKED');
          return `${m.track}: ${bits.join(', ')}`;
        })
        .join(' | ')}`,
    );
  }
  if (ctx.truncation) {
    lines.push(
      `NOTE: ${ctx.truncation.omitted_notes} notes summarized to save space (${ctx.truncation.summarized_tracks.join(', ')}).`,
    );
  }
  lines.push(`INSTRUCTION: ${ctx.instruction}`);
  return lines.join('\n');
}

/** Data kinds a MusicContext would disclose (privacy indicator, spec §50). */
export function contextDataKinds(
  ctx: MusicContext,
): ('song-description' | 'chord-progression' | 'midi' | 'lyrics' | 'project-metadata')[] {
  const kinds: ('song-description' | 'chord-progression' | 'midi' | 'lyrics' | 'project-metadata')[] = [
    'song-description',
  ];
  if (ctx.chords.length || ctx.sections.some((s) => s.progression?.length)) kinds.push('chord-progression');
  if (ctx.tracks.some((t) => t.notes?.length || t.summary) || ctx.selected_notes.length) kinds.push('midi');
  if (ctx.lyrics.length) kinds.push('lyrics');
  if (ctx.mixer.length) kinds.push('project-metadata');
  return kinds;
}
