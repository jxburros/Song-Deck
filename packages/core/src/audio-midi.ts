/**
 * MIDI attached to audio tracks: an audio track can carry editable notes made from its own
 * recording (`Track.audioMidi`, notes in `Track.notes`). The track plays its recording or the
 * notes through an instrument, and the recording can be pitch-corrected to follow the notes
 * ("tuning"), rendered to an asset like a frozen instrument-plugin track.
 */
import type { AudioMidiLink, AudioTuningSettings, Song, Track } from './ir/types';
import { stableStringify } from './ir/song-utils';
import { createTimeMap } from './timing';

/** Natural-sounding correction: notes pulled onto pitch, some drift kept, a short glide. */
export const DEFAULT_TUNING: AudioTuningSettings = { amount: 1, flatten: 0.35, speedMs: 40 };

/** The "hard tune" preset: exact pitch, no drift or vibrato, instant transitions. */
export const HARD_TUNING: AudioTuningSettings = { amount: 1, flatten: 1, speedMs: 0 };

/** Instrument used to play attached MIDI made in each mode when nothing better is known. */
export const AUDIO_MIDI_DEFAULT_INSTRUMENT: Record<AudioMidiLink['mode'], string> = {
  melody: 'synth-lead',
  chords: 'piano',
  drums: 'drum-kit',
};

/** An audio track carrying MIDI made from its recording. */
export function hasAttachedMidi(track: Track | undefined): track is Track & { audioMidi: AudioMidiLink } {
  return !!track && track.kind === 'audio' && !!track.audioMidi;
}

/** Tracks whose notes can be viewed and edited: MIDI tracks and audio tracks with attached MIDI. */
export function hasEditableNotes(track: Track | undefined): boolean {
  return !!track && (track.kind === 'midi' || hasAttachedMidi(track));
}

/**
 * The track as a MIDI track: attached MIDI becomes a MIDI track played by its instrument (no
 * clips). MIDI tracks are returned unchanged; plain audio tracks give undefined.
 */
export function noteTrackView(track: Track): Track | undefined {
  if (track.kind === 'midi') return track;
  if (!hasAttachedMidi(track)) return undefined;
  return { ...track, kind: 'midi', instrumentId: track.audioMidi.instrumentId, clips: [] };
}

/** Whether an attached-MIDI track currently plays its notes instead of its recording. */
export function playsAttachedMidi(track: Track): boolean {
  return hasAttachedMidi(track) && track.audioMidi.play === 'midi';
}

/** Whether a track's recording should play pitch-corrected (tuning on and the recording audible). */
export function tuningActive(track: Track): boolean {
  return hasAttachedMidi(track) && track.audioMidi.play === 'audio' && !!track.audioMidi.tuning?.enabled;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function clipSignature(song: Song, track: Track): unknown {
  const tm = createTimeMap(song);
  // Clip positions in seconds: tempo changes that move the audio change the key, others do not.
  return (track.clips ?? [])
    .filter((c) => c && !c.muted)
    .map((c) => [
      c.assetId,
      Math.round(tm.tickToSeconds(c.tick) * 1e4) / 1e4,
      c.offsetSeconds,
      c.durationSeconds,
      c.gainDb,
      c.fadeInSeconds,
      c.fadeOutSeconds,
    ]);
}

/** Key of the audio an audio track plays (its unmuted clips and where they sit in time). */
export function audioMidiSourceKey(song: Song, track: Track): string {
  return fnv(stableStringify({ clips: clipSignature(song, track) }));
}

/** Where an audio track's audio starts: its first unmuted clip (0 without clips). */
export function firstClipTick(track: Track): number {
  let first = Infinity;
  for (const c of track.clips ?? [])
    if (c && !c.muted && Number.isFinite(c.tick)) first = Math.min(first, c.tick);
  return Number.isFinite(first) ? Math.max(0, first) : 0;
}

/** The track's recording changed since its MIDI was made (clips moved, replaced, trimmed…). */
export function audioMidiIsStale(song: Song, track: Track): boolean {
  return hasAttachedMidi(track) && track.audioMidi.sourceKey !== audioMidiSourceKey(song, track);
}

/** Note targets of the tuning render, in seconds from song time 0. */
export interface TuneTarget {
  startSeconds: number;
  endSeconds: number;
  /** Target MIDI pitch. */
  pitch: number;
}

/** The attached notes as tuning targets (sorted by start). */
export function tuneTargets(song: Song, track: Track): TuneTarget[] {
  const tm = createTimeMap(song);
  return track.notes
    .filter((n) => Number.isFinite(n.tick) && n.duration > 0 && n.pitch >= 0 && n.pitch <= 127)
    .map((n) => ({
      startSeconds: tm.tickToSeconds(n.tick),
      endSeconds: tm.tickToSeconds(n.tick + n.duration),
      pitch: n.pitch,
    }))
    .sort((a, b) => a.startSeconds - b.startSeconds || a.pitch - b.pitch);
}

/**
 * Key of everything a tuning render depends on: the clips, the notes in seconds and the tuning
 * settings. A tuned render is current while its key matches.
 */
export function tuningRenderKey(song: Song, track: Track): string {
  const t = track.audioMidi?.tuning;
  return fnv(
    stableStringify({
      clips: clipSignature(song, track),
      notes: tuneTargets(song, track).map((n) => [
        Math.round(n.startSeconds * 1e4),
        Math.round(n.endSeconds * 1e4),
        n.pitch,
      ]),
      tuning: t ? [t.amount, t.flatten, t.speedMs] : null,
    }),
  );
}

/** Whether the track should play its tuned render (tuning active and the render current). */
export function tuningRenderIsCurrent(song: Song, track: Track): boolean {
  const render = track.audioMidi?.tuning?.render;
  return tuningActive(track) && !!render && render.key === tuningRenderKey(song, track);
}

/** Tuning needs a (re-)render: tuning is active and there is no current render. */
export function tuningRenderIsStale(song: Song, track: Track): boolean {
  return tuningActive(track) && !tuningRenderIsCurrent(song, track);
}

/** Clamp tuning settings into their valid ranges. */
export function normalizeTuning(s: Partial<AudioTuningSettings>): AudioTuningSettings {
  const unit = (v: unknown, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d;
  const speed =
    typeof s.speedMs === 'number' && Number.isFinite(s.speedMs)
      ? Math.max(0, Math.min(500, s.speedMs))
      : DEFAULT_TUNING.speedMs;
  return {
    amount: unit(s.amount, DEFAULT_TUNING.amount),
    flatten: unit(s.flatten, DEFAULT_TUNING.flatten),
    speedMs: speed,
  };
}
