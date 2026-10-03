import type { Song, Track } from '../ir/types';
import { defaultChannelStrip } from '../ir/defaults';
import { colorForStemGroup, isDrumTrack, isKnownInstrument, lookupInstrument } from './instruments';
import { isProtected, resolveTrack, type OpContext } from './op-context';
import { MUSICAL_FUNCTIONS, SectionLocator, TRACK_ROLES, oneOf, toStr } from './util';

type RawOp = Record<string, unknown>;

/** Lowest MIDI channel not used by another track (drums always use channel 10 = index 9). */
export function freeMidiChannel(song: Song, exceptTrackId?: string): number {
  const used = new Set(song.tracks.filter((t) => t.id !== exceptTrackId).map((t) => t.midiChannel));
  for (let ch = 0; ch < 16; ch++) if (ch !== 9 && !used.has(ch)) return ch;
  const melodic = song.tracks.filter((t) => t.midiChannel !== 9).length;
  const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
  return pool[melodic % pool.length];
}

function uniqueTrackName(song: Song, name: string): string {
  const names = new Set(song.tracks.map((t) => t.name.toLowerCase()));
  if (!names.has(name.toLowerCase())) return name;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${name} ${i}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${name} (new)`;
}

export function opAddTrack(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'add_track';
  const instrumentId = toStr(op.instrument_id)?.trim();
  if (!instrumentId) {
    c.error('op.malformed', `${name}: "instrument_id" is required.`);
    return false;
  }
  const profile = lookupInstrument(instrumentId, c.instruments);
  if (!isKnownInstrument(instrumentId, c.instruments)) {
    c.info('instrument.unknown', `${name}: unknown instrument "${instrumentId}"; treating it as ${profile.family === 'other' ? 'a generic instrument' : `a ${profile.family} instrument`}.`);
  }
  let role = oneOf(op.role, TRACK_ROLES);
  if (!role) {
    if (op.role !== undefined) c.warn('track.invalid', `${name}: unknown role ${JSON.stringify(op.role)}; using "${profile.defaultRole}".`);
    role = profile.defaultRole;
  }
  const fn = oneOf(op.function, MUSICAL_FUNCTIONS);
  if (op.function !== undefined && !fn) c.warn('track.invalid', `${name}: unknown musical function ${JSON.stringify(op.function)}; ignored.`);
  const requested = toStr(op.name)?.trim() || profile.name;
  const trackName = uniqueTrackName(song, requested);
  if (trackName !== requested) c.info('track.renamed', `${name}: a track called "${requested}" already exists; the new track is "${trackName}".`);
  const track: Track = {
    id: c.ids.next('trk'),
    name: trackName,
    kind: 'midi',
    role,
    instrumentId,
    constraints: fn ? { function: fn } : {},
    notes: [],
    clips: [],
    color: colorForStemGroup(profile.stemGroup),
    stemGroup: profile.stemGroup,
    midiChannel: profile.isDrumKit ? 9 : freeMidiChannel(song),
  };
  if (role === 'vocal') track.vocal = { mode: song.vocals?.mode ?? 'melody-only' };
  song.tracks.push(track);
  song.mixer.channels[track.id] = defaultChannelStrip();
  return true;
}

export function opRemoveTrack(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'remove_track';
  const track = resolveTrack(song, op.track, c, name);
  if (!track) return false;
  if (c.respectLocks) {
    const p = c.locks;
    if (p.tracks.has(track.id) || p.mixers.has(track.id)) {
      c.error('lock.violated', `${name}: track "${track.name}" is locked.`, { trackId: track.id });
      return false;
    }
    const locator = new SectionLocator(song);
    const locked = track.notes.find((n) => isProtected(c, locator, track, n));
    if (locked) {
      c.error('lock.violated', `${name}: "${track.name}" contains locked material.`, { trackId: track.id, noteId: locked.id });
      return false;
    }
  }
  const id = track.id;
  song.tracks = song.tracks.filter((t) => t.id !== id);
  const channels = { ...song.mixer.channels };
  delete channels[id];
  song.mixer = { ...song.mixer, channels };
  song.automation = song.automation.filter((l) => l.target !== id);
  song.phrases = song.phrases.filter((p) => p.trackId !== id);
  song.lyrics = song.lyrics.map((l) => {
    if (l.trackId !== id) return l;
    const copy = { ...l };
    delete copy.trackId;
    return copy;
  });
  const locks = { ...song.locks };
  for (const key of Object.keys(locks)) {
    if (key === `track:${id}` || key.startsWith(`track:${id}:section:`) || key === `mixer:${id}`) delete locks[key];
  }
  song.locks = locks;
  if (song.production?.trackMethods?.[id] !== undefined) {
    const methods = { ...song.production.trackMethods };
    delete methods[id];
    song.production = { ...song.production, trackMethods: methods };
  }
  if (song.vocals) {
    song.vocals = {
      ...song.vocals,
      renders: song.vocals.renders.filter((r) => r.trackId !== id),
      takes: song.vocals.takes.filter((t) => t.trackId !== id),
    };
  }
  for (const t of song.tracks) if (t.sourceTrackId === id) delete t.sourceTrackId;
  return true;
}

export function opSetInstrument(song: Song, op: RawOp, c: OpContext): boolean {
  const name = 'set_instrument';
  const track = resolveTrack(song, op.track, c, name);
  if (!track) return false;
  const instrumentId = toStr(op.instrument_id)?.trim();
  if (!instrumentId) {
    c.error('op.malformed', `${name}: "instrument_id" is required.`, { trackId: track.id });
    return false;
  }
  if (c.respectLocks && c.locks.tracks.has(track.id)) {
    c.error('lock.violated', `${name}: track "${track.name}" is locked.`, { trackId: track.id });
    return false;
  }
  if (instrumentId === track.instrumentId) {
    c.info('op.no-effect', `${name}: "${track.name}" already uses "${instrumentId}".`, { trackId: track.id });
    return true;
  }
  const profile = lookupInstrument(instrumentId, c.instruments);
  if (!isKnownInstrument(instrumentId, c.instruments)) {
    c.info('instrument.unknown', `${name}: unknown instrument "${instrumentId}"; treating it as ${profile.family === 'other' ? 'a generic instrument' : `a ${profile.family} instrument`}.`, {
      trackId: track.id,
    });
  }
  const wasDrums = isDrumTrack(track, c.instruments);
  const isDrums = !!profile.isDrumKit;
  if (wasDrums !== isDrums && track.notes.length) {
    c.warn('instrument.kind-change', `${name}: "${track.name}" changes between a drum kit and a pitched instrument; its notes may need rewriting.`, { trackId: track.id });
  }
  track.instrumentId = instrumentId;
  track.stemGroup = profile.stemGroup;
  if (isDrums) track.midiChannel = 9;
  else if (track.midiChannel === 9 || track.midiChannel === undefined) track.midiChannel = freeMidiChannel(song, track.id);
  // Re-check every note against the new range (autoFix folds out-of-range notes).
  if (!isDrums && track.kind === 'midi') {
    const locator = new SectionLocator(song);
    for (const n of track.notes) if (!isProtected(c, locator, track, n)) c.touch(track.id, n.id);
  }
  return true;
}
