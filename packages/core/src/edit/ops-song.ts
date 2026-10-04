import type {
  AutomationLane,
  AutomationParam,
  AutomationPoint,
  ChannelStrip,
  ChordEvent,
  ChordSpec,
  KeyEvent,
  KeySignature,
  LyricLine,
  MacroSettings,
  MeterEvent,
  ModeName,
  Song,
} from '../ir/types';
import { defaultChannelStrip } from '../ir/defaults';
import { cloneSong, findTrack } from '../ir/song-utils';
import { LockKeys, setLock } from '../locks';
import {
  barToTick,
  findSection,
  keyAtBar,
  keyAtTick,
  musicalToTick,
  sectionLayout,
  songLengthBars,
  songLengthTicks,
} from '../timing';
import {
  CHORD_INTERVALS,
  QUALITY_SUFFIX,
  diatonicChord,
  formatChordSymbol,
  isDiatonic,
  parseChordSymbol,
} from '../theory/chords';
import { mod12, pitchClassFromName } from '../theory/pitch';
import { chordDegree, chordToRoman } from '../theory/roman';
import { parseKey, pitchToScaleIndex, scaleIndexToPitch } from '../theory/scales';
import { isDrumTrack } from './instruments';
import { chordsProtected, lyricsProtected } from './locks-check';
import { isProtected, parseRegion, resolveSection, resolveTrack, type OpContext } from './op-context';
import { rebar } from './structure';
import {
  AUTOMATION_PARAMS,
  MACRO_KEYS,
  MODE_NAMES,
  SectionLocator,
  VALID_DENOMINATORS,
  clampNum,
  isRecord,
  oneOf,
  toBool,
  toInt,
  toNumber,
  toStr,
} from './util';

type RawOp = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------

/** Keep the user's root/bass spelling, canonical quality suffix. */
export function normalizeChordSymbol(original: string, spec: ChordSpec): string {
  const fix = (s: string) => s[0].toUpperCase() + s.slice(1).replace('♯', '#').replace('♭', 'b');
  const root = /^\s*([A-Ga-g](?:#|♯|b|♭)?)/.exec(original);
  const bass = /\/\s*([A-Ga-g](?:#|♯|b|♭)?)\s*$/.exec(original);
  if (!root) return formatChordSymbol(spec);
  const bassText =
    spec.bass !== undefined && spec.bass !== spec.root
      ? `/${bass ? fix(bass[1]) : formatChordSymbol({ root: spec.bass, quality: 'maj' })}`
      : '';
  return `${fix(root[1])}${QUALITY_SUFFIX[spec.quality]}${bassText}`;
}

/** Remove chord material in [start, end): chords straddling the range are trimmed/split. */
export function clearChordRange(
  chords: ChordEvent[],
  start: number,
  end: number,
  nextId: () => string,
): ChordEvent[] {
  const out: ChordEvent[] = [];
  for (const ch of chords) {
    const chEnd = ch.tick + ch.duration;
    if (chEnd <= start || ch.tick >= end) {
      out.push(ch);
      continue;
    }
    if (ch.tick < start) out.push({ ...ch, duration: start - ch.tick });
    if (chEnd > end)
      out.push({ ...ch, id: ch.tick < start ? nextId() : ch.id, tick: end, duration: chEnd - end });
  }
  return out.sort((a, b) => a.tick - b.tick);
}

export function opSetChords(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'set_chords';
  const region = parseRegion(song, op.region, c, name, true);
  if (!region) return false;
  if (!Array.isArray(op.chords)) {
    c.error('op.malformed', `${name}: "chords" must be an array.`);
    return false;
  }
  if (c.respectLocks) {
    if (c.locks.chords) {
      c.error('lock.violated', `${name}: the chord progression is locked.`);
      return false;
    }
    for (const span of sectionLayout(song)) {
      if (span.endTick <= region.startTick || span.startTick >= region.endTick) continue;
      if (chordsProtected(c.locks, span.section.id)) {
        c.error('lock.violated', `${name}: chords in "${span.section.name}" are locked.`, {
          sectionId: span.section.id,
        });
        return false;
      }
    }
  }
  const parsed: { tick: number; spec: ChordSpec; symbol: string }[] = [];
  let outside = 0;
  op.chords.forEach((raw, i) => {
    const where = `${name}: chord #${i + 1}`;
    if (!isRecord(raw)) {
      c.warn('chord.invalid', `${where} is not an object; dropped.`);
      return;
    }
    const symbol = toStr(raw.symbol)?.trim();
    const spec = symbol ? parseChordSymbol(symbol) : null;
    if (!symbol || !spec) {
      c.warn(
        'chord.unparseable',
        `${where}: chord symbol ${JSON.stringify(raw.symbol)} could not be parsed; dropped.`,
      );
      return;
    }
    const bar = toNumber(raw.bar);
    const beat = raw.beat === undefined ? 1 : toNumber(raw.beat);
    if (bar === undefined || bar < 1 || beat === undefined || beat < 1) {
      c.warn('chord.invalid', `${where} ("${symbol}") has an invalid bar/beat; dropped.`);
      return;
    }
    const tick = musicalToTick(song, Math.floor(bar), beat);
    if (tick < region.startTick || tick >= region.endTick) {
      outside++;
      return;
    }
    parsed.push({ tick, spec, symbol: normalizeChordSymbol(symbol, spec) });
  });
  if (outside)
    c.warn(
      'region.chord-outside',
      `${name}: ${outside} chord(s) outside bars ${region.startBar1}–${region.endBar1} were dropped.`,
      { fixed: true },
    );
  parsed.sort((a, b) => a.tick - b.tick);
  const unique: typeof parsed = [];
  for (const p of parsed) {
    if (unique.length && unique[unique.length - 1].tick === p.tick) unique[unique.length - 1] = p;
    else unique.push(p);
  }
  const sounding = song.chords.find(
    (ch) => ch.tick <= region.startTick && ch.tick + ch.duration > region.startTick,
  );
  const chords = clearChordRange(song.chords, region.startTick, region.endTick, () => c.ids.next('ch'));
  if (unique.length) {
    const first = unique[0].tick;
    if (first > region.startTick) {
      // Gap before the first new chord: the harmony that was sounding at the region start continues;
      // with nothing sounding, the first new chord starts at the region start.
      if (sounding) {
        const locator = new SectionLocator(song);
        const head =
          sounding.tick < region.startTick
            ? chords.find((ch) => ch.id === sounding.id && ch.tick === sounding.tick)
            : undefined;
        if (head && !(c.respectLocks && chordsProtected(c.locks, locator.sectionIdAt(head.tick))))
          head.duration = first - head.tick;
        else {
          const id = chords.some((ch) => ch.id === sounding.id) ? c.ids.next('ch') : sounding.id;
          chords.push({
            ...sounding,
            id,
            tick: region.startTick,
            duration: first - region.startTick,
            roman: chordToRoman(sounding, keyAtTick(song, region.startTick)),
          });
        }
      } else unique[0].tick = region.startTick;
    }
    unique.forEach((p, i) => {
      const end = i + 1 < unique.length ? unique[i + 1].tick : region.endTick;
      const key = keyAtTick(song, p.tick);
      chords.push({
        id: c.ids.next('ch'),
        tick: p.tick,
        duration: end - p.tick,
        root: p.spec.root,
        quality: p.spec.quality,
        ...(p.spec.bass !== undefined ? { bass: p.spec.bass } : {}),
        symbol: p.symbol,
        roman: chordToRoman(p.spec, key),
      });
    });
  } else {
    c.warn(
      'chord.gap',
      `${name}: no valid chords supplied; bars ${region.startBar1}–${region.endBar1} now have no chords.`,
    );
  }
  song.chords = chords.sort((a, b) => a.tick - b.tick);
  return true;
}

// ---------------------------------------------------------------------------
// Tempo, key, meter
// ---------------------------------------------------------------------------

function parseAtBar(song: Song, raw: unknown, c: OpContext, name: string): number | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  const v = toNumber(raw);
  if (v === undefined || v < 1) {
    c.error('op.malformed', `${name}: "at_bar" must be a 1-based bar number.`);
    return null;
  }
  const bar = Math.floor(v);
  const total = songLengthBars(song);
  if (total > 0 && bar > total) {
    c.error('region.outside', `${name}: bar ${bar} is past the end of the song (${total} bars).`);
    return null;
  }
  return bar - 1;
}

export function opSetTempo(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'set_tempo';
  const bpm = toNumber(op.bpm);
  if (bpm === undefined || bpm < 20 || bpm > 400) {
    c.error(
      'tempo.invalid',
      `${name}: bpm must be a number between 20 and 400 (got ${JSON.stringify(op.bpm)}).`,
    );
    return false;
  }
  const at = parseAtBar(song, op.at_bar, c, name);
  if (at === null) return false;
  if (c.respectLocks && c.locks.tempo) {
    c.error('lock.violated', `${name}: tempo is locked.`);
    return false;
  }
  const value = Math.round(bpm * 1000) / 1000;
  const sorted = [...song.tempoMap].sort((a, b) => a.tick - b.tick);
  if (at === undefined) {
    if (sorted.length <= 1) song.tempoMap = [{ tick: 0, bpm: value }];
    else {
      const ratio = value / sorted[0].bpm;
      song.tempoMap = sorted.map((t) => ({ tick: t.tick, bpm: Math.round(t.bpm * ratio * 1000) / 1000 }));
      c.info(
        'tempo.scaled',
        `${name}: the song has tempo changes; all tempos were scaled so the base tempo is ${value} BPM.`,
      );
    }
    return true;
  }
  const tick = barToTick(song, at);
  const rest = sorted.filter((t) => t.tick !== tick);
  rest.push({ tick, bpm: value });
  song.tempoMap = rest.sort((a, b) => a.tick - b.tick);
  if (song.tempoMap[0].tick !== 0) song.tempoMap.unshift({ tick: 0, bpm: sorted[0]?.bpm ?? value });
  return true;
}

const MODE_ALIASES: Record<string, ModeName> = {
  maj: 'major',
  major: 'major',
  ionian: 'major',
  m: 'minor',
  min: 'minor',
  minor: 'minor',
  aeolian: 'minor',
  'natural-minor': 'minor',
  'harmonic minor': 'harmonic-minor',
  harmonicminor: 'harmonic-minor',
  'melodic minor': 'melodic-minor',
  melodicminor: 'melodic-minor',
};

export function parseMode(raw: unknown): ModeName | undefined {
  const s = toStr(raw)?.trim();
  if (!s) return undefined;
  const lower = s.toLowerCase();
  return oneOf(lower, MODE_NAMES) ?? MODE_ALIASES[lower] ?? MODE_ALIASES[lower.replace(/[_\s]+/g, '-')];
}

/** Map a pitch from one key to another preserving scale degree (chromatic shift when modes match). */
export function mapPitchBetweenKeys(pitch: number, from: KeySignature, to: KeySignature): number {
  const raw = to.tonic - from.tonic;
  let delta = mod12(raw);
  if (delta > 5) delta -= 12;
  if (from.mode === to.mode) return pitch + delta;
  const { index, alteration } = pitchToScaleIndex(pitch, from);
  return scaleIndexToPitch(index, to) + alteration + (delta - raw);
}

function mapChord(ch: ChordEvent, from: KeySignature, to: KeySignature): ChordEvent {
  const root = mod12(mapPitchBetweenKeys(ch.root + 60, from, to));
  let quality = ch.quality;
  if (from.mode !== to.mode && isDiatonic(ch, from)) {
    const deg = chordDegree(ch, from);
    if (deg >= 0) {
      const seventh = CHORD_INTERVALS[ch.quality].length >= 4;
      if (diatonicChord(from, deg, seventh).quality === ch.quality)
        quality = diatonicChord(to, deg, seventh).quality;
    }
  }
  const spec: ChordSpec = { root, quality };
  if (ch.bass !== undefined) spec.bass = mod12(mapPitchBetweenKeys(ch.bass + 60, from, to));
  const out: ChordEvent = {
    ...ch,
    root,
    quality,
    symbol: formatChordSymbol(spec, to),
    roman: chordToRoman(spec, to),
  };
  if (spec.bass !== undefined) out.bass = spec.bass;
  else delete out.bass;
  return out;
}

export function opSetKey(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'set_key';
  let tonic: number | null = null;
  let mode = parseMode(op.mode);
  if (typeof op.tonic === 'number' && Number.isFinite(op.tonic)) tonic = mod12(Math.round(op.tonic));
  else if (typeof op.tonic === 'string') {
    tonic = pitchClassFromName(op.tonic);
    if (tonic === null) {
      const k = parseKey(op.tonic);
      if (k) {
        tonic = k.tonic;
        if (!mode) mode = k.mode;
      }
    }
  }
  if (tonic === null) {
    c.error('key.invalid', `${name}: unknown tonic ${JSON.stringify(op.tonic)}.`);
    return false;
  }
  if (op.mode !== undefined && !parseMode(op.mode)) {
    c.error('key.invalid', `${name}: unknown mode ${JSON.stringify(op.mode)}.`);
    return false;
  }
  const at = parseAtBar(song, op.at_bar, c, name);
  if (at === null) return false;
  const startBar = at ?? 0;
  if (!mode) mode = keyAtBar(song, startBar).mode;
  const newKey: KeySignature = { tonic, mode };
  if (c.respectLocks && c.locks.key) {
    c.error('lock.violated', `${name}: the key is locked.`);
    return false;
  }
  const transpose = toBool(op.transpose_notes) === true;
  const sortedKeys = [...song.keyMap].sort((a, b) => a.bar - b.bar);
  const oldSong = { ...song, keyMap: sortedKeys };
  let keyMap: KeyEvent[];
  let endBar = Infinity;
  if (at === undefined) {
    if (sortedKeys.length <= 1) keyMap = [{ bar: 0, key: newKey }];
    else {
      const first = sortedKeys[0].key;
      let delta = mod12(newKey.tonic - first.tonic);
      if (delta > 5) delta -= 12;
      keyMap = sortedKeys.map((k, i) =>
        i === 0
          ? { bar: k.bar, key: newKey }
          : { bar: k.bar, key: { tonic: mod12(k.key.tonic + delta), mode: k.key.mode } },
      );
      if (keyMap[0].bar !== 0) keyMap.unshift({ bar: 0, key: newKey });
    }
  } else {
    keyMap = sortedKeys.filter((k) => k.bar !== at);
    keyMap.push({ bar: at, key: newKey });
    keyMap.sort((a, b) => a.bar - b.bar);
    if (keyMap[0].bar !== 0)
      keyMap.unshift({ bar: 0, key: sortedKeys[0]?.key ?? { tonic: 0, mode: 'major' } });
    endBar = sortedKeys.find((k) => k.bar > at)?.bar ?? Infinity;
  }
  const newSong = { ...song, keyMap };
  const startTick = barToTick(song, startBar);
  const endTick = endBar === Infinity ? Infinity : barToTick(song, endBar);
  const inRange = (tick: number) => tick >= startTick && tick < endTick;

  if (transpose) {
    const locator = new SectionLocator(song);
    if (c.respectLocks) {
      for (const t of song.tracks) {
        if (t.kind !== 'midi' || isDrumTrack(t, c.instruments)) continue;
        const locked = t.notes.find((n) => inRange(n.tick) && isProtected(c, locator, t, n));
        if (locked) {
          c.error(
            'lock.violated',
            `${name}: cannot transpose — "${t.name}" has locked notes in the affected range.`,
            { trackId: t.id, noteId: locked.id },
          );
          return false;
        }
      }
      const lockedChord = song.chords.find(
        (ch) => inRange(ch.tick) && chordsProtected(c.locks, locator.sectionIdAt(ch.tick)),
      );
      if (lockedChord) {
        c.error('lock.violated', `${name}: cannot transpose — chords in the affected range are locked.`);
        return false;
      }
    }
    for (const t of song.tracks) {
      if (t.kind !== 'midi' || isDrumTrack(t, c.instruments)) continue;
      t.notes = t.notes.map((n) => {
        if (!inRange(n.tick)) return n;
        const p = mapPitchBetweenKeys(n.pitch, keyAtTick(oldSong, n.tick), keyAtTick(newSong, n.tick));
        if (p === n.pitch) return n;
        c.touch(t.id, n.id);
        return { ...n, pitch: p };
      });
    }
    song.chords = song.chords.map((ch) =>
      inRange(ch.tick) ? mapChord(ch, keyAtTick(oldSong, ch.tick), keyAtTick(newSong, ch.tick)) : ch,
    );
  }
  song.keyMap = keyMap;
  // Roman numerals are relative to the key in effect.
  song.chords = song.chords.map((ch) => {
    if (!inRange(ch.tick)) return ch;
    const roman = chordToRoman(ch, keyAtTick(song, ch.tick));
    return roman === ch.roman ? ch : { ...ch, roman };
  });
  return true;
}

export function opSetMeter(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'set_meter';
  const num = toInt(op.numerator);
  const den = toInt(op.denominator);
  if (
    num === undefined ||
    num < 1 ||
    num > 32 ||
    den === undefined ||
    !(VALID_DENOMINATORS as readonly number[]).includes(den)
  ) {
    c.error(
      'meter.invalid',
      `${name}: invalid time signature ${JSON.stringify(op.numerator)}/${JSON.stringify(op.denominator)}.`,
    );
    return false;
  }
  const at = parseAtBar(song, op.at_bar, c, name);
  if (at === null) return false;
  if (c.respectLocks && c.locks.meter) {
    c.error('lock.violated', `${name}: the meter is locked.`);
    return false;
  }
  let map: MeterEvent[];
  if (at === undefined) map = [{ bar: 0, numerator: num, denominator: den }];
  else {
    map = [...song.meterMap].filter((m) => m.bar !== at);
    map.push({ bar: at, numerator: num, denominator: den });
    map.sort((a, b) => a.bar - b.bar);
    if (map[0].bar !== 0) map.unshift({ bar: 0, numerator: 4, denominator: 4 });
  }
  const compressed: MeterEvent[] = [];
  for (const m of map) {
    const last = compressed[compressed.length - 1];
    if (last && last.numerator === m.numerator && last.denominator === m.denominator) continue;
    compressed.push(m);
  }
  const res = rebar(song, compressed);
  Object.assign(song, res.song);
  if (res.droppedNotes || res.droppedChords) {
    c.warn(
      'meter.material-dropped',
      `${name}: ${res.droppedNotes} note(s) and ${res.droppedChords} chord(s) fell beyond the end of the shorter ${num}/${den} bars and were removed.`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

export function opSetLyrics(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'set_lyrics';
  const section = resolveSection(song, op.section, c, name);
  if (!section) return false;
  let lines: string[];
  if (Array.isArray(op.lines))
    lines = op.lines.map((l) => toStr(l) ?? '').map((l) => l.replace(/\s+/g, ' ').trim());
  else if (typeof op.lines === 'string')
    lines = op.lines.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim());
  else {
    c.error('op.malformed', `${name}: "lines" must be an array of strings.`, { sectionId: section.id });
    return false;
  }
  lines = lines.filter((l) => l.length > 0);
  if (c.respectLocks && lyricsProtected(c.locks, section.id)) {
    c.error('lock.violated', `${name}: lyrics of "${section.name}" are locked.`, { sectionId: section.id });
    return false;
  }
  const existing = song.lyrics.filter((l) => l.sectionId === section.id);
  const removedIds = new Set(existing.map((l) => l.id));
  const vocal = song.tracks.find((t) => t.role === 'vocal' && t.kind === 'midi');
  const trackId = existing.find((l) => l.trackId)?.trackId ?? vocal?.id;
  const fresh: LyricLine[] = lines.map((text) => {
    const line: LyricLine = { id: c.ids.next('ly'), sectionId: section.id, text };
    if (trackId) line.trackId = trackId;
    if (c.opts.author) line.author = c.opts.author;
    return line;
  });
  // Keep lyrics ordered by section.
  const order = new Map(song.sections.map((s, i) => [s.id, i] as const));
  const kept = song.lyrics.filter((l) => !removedIds.has(l.id));
  const idx = order.get(section.id) ?? Infinity;
  let insertAt = kept.length;
  for (let i = 0; i < kept.length; i++) {
    if ((order.get(kept[i].sectionId) ?? Infinity) > idx) {
      insertAt = i;
      break;
    }
  }
  kept.splice(insertAt, 0, ...fresh);
  song.lyrics = kept;
  // Syllables aligned to the replaced lines are now stale.
  if (removedIds.size) {
    const locator = new SectionLocator(song);
    let cleared = 0;
    for (const t of song.tracks) {
      if (!t.notes.some((n) => n.lyricLineId && removedIds.has(n.lyricLineId))) continue;
      t.notes = t.notes.map((n) => {
        if (!n.lyricLineId || !removedIds.has(n.lyricLineId) || isProtected(c, locator, t, n)) return n;
        cleared++;
        const copy = { ...n };
        delete copy.lyricLineId;
        delete copy.syllable;
        delete copy.phonemes;
        return copy;
      });
    }
    if (cleared)
      c.info(
        'lyrics.unaligned',
        `${name}: ${cleared} vocal note(s) in "${section.name}" lost their old syllables; re-align the lyrics to the melody.`,
        { sectionId: section.id },
      );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mixer & automation
// ---------------------------------------------------------------------------

interface FieldSpec {
  type: 'number' | 'boolean';
  min?: number;
  max?: number;
  master?: boolean;
}

const MIXER_FIELDS: Record<string, FieldSpec> = {
  volumeDb: { type: 'number', min: -96, max: 12, master: true },
  pan: { type: 'number', min: -1, max: 1 },
  mute: { type: 'boolean' },
  solo: { type: 'boolean' },
  reverbSend: { type: 'number', min: 0, max: 1 },
  delaySend: { type: 'number', min: 0, max: 1 },
  width: { type: 'number', min: 0, max: 2, master: true },
  drive: { type: 'number', min: 0, max: 1 },
  phaseInvert: { type: 'boolean' },
  'eq.enabled': { type: 'boolean', master: true },
  'eq.highpassHz': { type: 'number', min: 0, max: 20000, master: true },
  'eq.lowShelfHz': { type: 'number', min: 20, max: 2000, master: true },
  'eq.lowShelfDb': { type: 'number', min: -24, max: 24, master: true },
  'eq.lowMidHz': { type: 'number', min: 40, max: 8000, master: true },
  'eq.lowMidDb': { type: 'number', min: -24, max: 24, master: true },
  'eq.lowMidQ': { type: 'number', min: 0.1, max: 18, master: true },
  'eq.highMidHz': { type: 'number', min: 200, max: 16000, master: true },
  'eq.highMidDb': { type: 'number', min: -24, max: 24, master: true },
  'eq.highMidQ': { type: 'number', min: 0.1, max: 18, master: true },
  'eq.highShelfHz': { type: 'number', min: 1000, max: 20000, master: true },
  'eq.highShelfDb': { type: 'number', min: -24, max: 24, master: true },
  'eq.lowpassHz': { type: 'number', min: 0, max: 22050, master: true },
  'compressor.enabled': { type: 'boolean', master: true },
  'compressor.thresholdDb': { type: 'number', min: -60, max: 0, master: true },
  'compressor.ratio': { type: 'number', min: 1, max: 20, master: true },
  'compressor.attackMs': { type: 'number', min: 0.1, max: 300, master: true },
  'compressor.releaseMs': { type: 'number', min: 5, max: 3000, master: true },
  'compressor.kneeDb': { type: 'number', min: 0, max: 24, master: true },
  'compressor.makeupDb': { type: 'number', min: 0, max: 24, master: true },
};

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (!isRecord(next)) cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function resolveMixTarget(
  song: Song,
  ref: unknown,
  c: OpContext,
  name: string,
): { id: string; label: string } | undefined {
  const r = toStr(ref)?.trim();
  if (r && r.toLowerCase() === 'master' && !song.tracks.some((t) => t.id === r))
    return { id: 'master', label: 'Master' };
  const t = resolveTrack(song, ref, c, name);
  return t ? { id: t.id, label: t.name } : undefined;
}

export function opSetMixer(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'set_mixer';
  const target = resolveMixTarget(song, op.track, c, name);
  if (!target) return false;
  if (!isRecord(op.changes)) {
    c.error('op.malformed', `${name}: "changes" must be an object.`);
    return false;
  }
  const trackId = target.id === 'master' ? undefined : target.id;
  if (c.respectLocks && c.locks.mixers.has(target.id)) {
    c.error('lock.violated', `${name}: the mixer channel of "${target.label}" is locked.`, { trackId });
    return false;
  }
  const isMaster = target.id === 'master';
  // Copy-on-write: the strip is edited on a private copy and stored back into a new mixer object.
  const strip = (isMaster
    ? cloneSong(song.mixer.master)
    : cloneSong(song.mixer.channels[target.id] ?? defaultChannelStrip())) as unknown as Record<
    string,
    unknown
  >;
  let applied = 0;
  for (const [field, raw] of Object.entries(op.changes)) {
    const spec = MIXER_FIELDS[field];
    if (!spec) {
      c.warn('mixer.invalid-field', `${name}: unknown mixer field "${field}"; ignored.`, { trackId });
      continue;
    }
    if (isMaster && !spec.master) {
      c.warn('mixer.invalid-field', `${name}: "${field}" does not apply to the master bus; ignored.`);
      continue;
    }
    if (spec.type === 'boolean') {
      const b = toBool(raw);
      if (b === undefined) {
        c.warn('mixer.invalid-field', `${name}: "${field}" must be true/false; ignored.`, { trackId });
        continue;
      }
      setPath(strip, field, b);
      applied++;
      continue;
    }
    const v = toNumber(raw);
    if (v === undefined) {
      c.warn('mixer.invalid-field', `${name}: "${field}" must be a number; ignored.`, { trackId });
      continue;
    }
    const clamped = clampNum(v, spec.min ?? -Infinity, spec.max ?? Infinity);
    if (clamped !== v)
      c.warn('mixer.clamped', `${name}: ${field} ${v} clamped to ${clamped}.`, { trackId, fixed: true });
    setPath(strip, field, clamped);
    applied++;
  }
  if (!applied) {
    c.info('op.no-effect', `${name}: no applicable mixer changes for "${target.label}".`, { trackId });
    return true;
  }
  song.mixer = isMaster
    ? { ...song.mixer, master: strip as unknown as Song['mixer']['master'] }
    : { ...song.mixer, channels: { ...song.mixer.channels, [target.id]: strip as unknown as ChannelStrip } };
  return true;
}

const PARAM_RANGE: Record<AutomationParam, [number, number]> = {
  volumeDb: [-96, 12],
  pan: [-1, 1],
  reverbSend: [0, 1],
  delaySend: [0, 1],
  width: [0, 2],
  drive: [0, 1],
  'eq.lowShelfDb': [-24, 24],
  'eq.lowMidDb': [-24, 24],
  'eq.highMidDb': [-24, 24],
  'eq.highShelfDb': [-24, 24],
  'eq.lowpassHz': [0, 22050],
  'eq.highpassHz': [0, 20000],
};

export function opSetAutomation(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'set_automation';
  const target = resolveMixTarget(song, op.track, c, name);
  if (!target) return false;
  const param = oneOf(op.param, AUTOMATION_PARAMS);
  if (!param) {
    c.error('automation.invalid', `${name}: unknown automation parameter ${JSON.stringify(op.param)}.`);
    return false;
  }
  if (!Array.isArray(op.points)) {
    c.error('op.malformed', `${name}: "points" must be an array.`);
    return false;
  }
  const trackId = target.id === 'master' ? undefined : target.id;
  if (c.respectLocks && c.locks.mixers.has(target.id)) {
    c.error('lock.violated', `${name}: the mixer channel of "${target.label}" is locked.`, { trackId });
    return false;
  }
  const [lo, hi] = PARAM_RANGE[param];
  const end = song.sections.length ? songLengthTicks(song) : Infinity;
  const points: AutomationPoint[] = [];
  op.points.forEach((raw, i) => {
    if (!isRecord(raw)) {
      c.warn('automation.invalid', `${name}: point #${i + 1} is not an object; dropped.`, { trackId });
      return;
    }
    const bar = toNumber(raw.bar);
    const beat = raw.beat === undefined ? 1 : toNumber(raw.beat);
    const value = toNumber(raw.value);
    if (bar === undefined || bar < 1 || beat === undefined || beat < 1 || value === undefined) {
      c.warn(
        'automation.invalid',
        `${name}: point #${i + 1} needs a 1-based bar/beat and a numeric value; dropped.`,
        { trackId },
      );
      return;
    }
    const tick = musicalToTick(song, Math.floor(bar), beat);
    if (tick > end) {
      c.warn('automation.invalid', `${name}: point #${i + 1} is past the end of the song; dropped.`, {
        trackId,
      });
      return;
    }
    const v = clampNum(value, lo, hi);
    if (v !== value)
      c.warn('automation.clamped', `${name}: value ${value} clamped to ${v} for ${param}.`, {
        trackId,
        fixed: true,
      });
    const curve = oneOf(raw.curve, ['linear', 'step'] as const);
    points.push(curve ? { tick, value: v, curve } : { tick, value: v });
  });
  const existing = song.automation.find((l) => l.target === target.id && l.param === param);
  if (!points.length) {
    if (existing && op.points.length === 0) {
      song.automation = song.automation.filter((l) => l !== existing);
      c.info('automation.cleared', `${name}: ${param} automation of "${target.label}" removed.`, { trackId });
    } else c.info('op.no-effect', `${name}: no valid automation points.`, { trackId });
    return true;
  }
  points.sort((a, b) => a.tick - b.tick);
  const minT = points[0].tick;
  const maxT = points[points.length - 1].tick;
  const merged = (existing?.points ?? []).filter((p) => p.tick < minT || p.tick > maxT);
  for (const p of points) {
    const i = merged.findIndex((x) => x.tick === p.tick);
    if (i >= 0) merged.splice(i, 1);
    merged.push(p);
  }
  merged.sort((a, b) => a.tick - b.tick);
  const lane: AutomationLane = existing
    ? { ...existing, points: merged, enabled: true }
    : { id: c.ids.next('auto'), target: target.id, param, points: merged, enabled: true };
  song.automation = existing
    ? song.automation.map((l) => (l === existing ? lane : l))
    : [...song.automation, lane];
  return true;
}

// ---------------------------------------------------------------------------
// Macros & locks
// ---------------------------------------------------------------------------

export function opSetMacros(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'set_macros';
  if (!isRecord(op.macros)) {
    c.error('op.malformed', `${name}: "macros" must be an object.`);
    return false;
  }
  let track;
  if (op.track !== undefined && op.track !== null) {
    track = resolveTrack(song, op.track, c, name);
    if (!track) return false;
  }
  const valid: Partial<MacroSettings> = {};
  for (const [k, raw] of Object.entries(op.macros)) {
    const key = oneOf(k, MACRO_KEYS);
    const v = toNumber(raw);
    if (!key || v === undefined) {
      c.warn('macro.invalid', `${name}: "${k}" is not a macro control or not a number; ignored.`, {
        trackId: track?.id,
      });
      continue;
    }
    let value = v;
    if (value > 1 && value <= 100) {
      value = value / 100;
      c.warn('macro.invalid', `${name}: ${k} = ${v} interpreted as ${v}%.`, {
        trackId: track?.id,
        fixed: true,
      });
    }
    valid[key] = clampNum(value, 0, 1);
  }
  if (!Object.keys(valid).length) {
    c.info('op.no-effect', `${name}: no valid macro values.`, { trackId: track?.id });
    return true;
  }
  if (track) track.macros = { ...(track.macros ?? {}), ...valid };
  else song.macros = { ...song.macros, ...valid };
  return true;
}

const SONG_LOCK_ALIASES: Record<string, string> = {
  tempo: LockKeys.tempo,
  key: LockKeys.key,
  meter: LockKeys.meter,
  'time-signature': LockKeys.meter,
  structure: LockKeys.structure,
  chords: LockKeys.chords,
  harmony: LockKeys.chords,
  lyrics: LockKeys.lyrics,
  motifs: LockKeys.motifs,
};

/** Normalize a lock key, resolving track/section names to ids. */
export function normalizeLockKey(song: Song, raw: string): string | undefined {
  const key = raw.trim();
  const songKeys = Object.values(SONG_LOCK_ALIASES);
  if (songKeys.includes(key)) return key;
  if (SONG_LOCK_ALIASES[key.toLowerCase()]) return SONG_LOCK_ALIASES[key.toLowerCase()];
  if (key.startsWith('song.') && SONG_LOCK_ALIASES[key.slice(5).toLowerCase()])
    return SONG_LOCK_ALIASES[key.slice(5).toLowerCase()];
  const tid = (ref: string) => findTrack(song, ref)?.id;
  const sid = (ref: string) => findSection(song, ref)?.id;
  let m: RegExpExecArray | null;
  if ((m = /^track:(.+?):section:(.+)$/.exec(key))) {
    const t = tid(m[1]);
    const s = sid(m[2]);
    return t && s ? LockKeys.trackSection(t, s) : undefined;
  }
  if ((m = /^track:(.+)$/.exec(key))) {
    const t = tid(m[1]);
    return t ? LockKeys.track(t) : undefined;
  }
  if ((m = /^(chords|lyrics):section:(.+)$/.exec(key))) {
    const s = sid(m[2]);
    return s ? (m[1] === 'chords' ? LockKeys.sectionChords(s) : LockKeys.sectionLyrics(s)) : undefined;
  }
  if ((m = /^section:(.+)$/.exec(key))) {
    const s = sid(m[1]);
    return s ? LockKeys.section(s) : undefined;
  }
  if ((m = /^mixer:(.+)$/.exec(key))) {
    if (m[1].toLowerCase() === 'master') return LockKeys.mixer('master');
    const t = tid(m[1]);
    return t ? LockKeys.mixer(t) : undefined;
  }
  if ((m = /^motif:(.+)$/.exec(key))) {
    const motif =
      song.motifs.find((x) => x.id === m![1]) ??
      song.motifs.find((x) => x.name.toLowerCase() === m![1].toLowerCase());
    return motif ? LockKeys.motif(motif.id) : undefined;
  }
  return undefined;
}

export function opSetLock(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'set_lock';
  const raw = toStr(op.key)?.trim();
  const locked = toBool(op.locked);
  if (!raw || locked === undefined) {
    c.error('op.malformed', `${name}: needs a "key" string and a boolean "locked".`);
    return false;
  }
  const key = normalizeLockKey(song, raw);
  if (!key) {
    c.error(
      'lock.unknown-key',
      `${name}: "${raw}" is not a valid lock key (or refers to an unknown track/section).`,
    );
    return false;
  }
  song.locks = setLock(song.locks, key, locked);
  if (locked) c.addLock(key);
  else if (c.lockMap[key]) {
    c.info(
      'lock.deferred',
      `${name}: "${key}" will be unlocked when this change is accepted; it stays protected for the rest of this change.`,
    );
  }
  return true;
}
