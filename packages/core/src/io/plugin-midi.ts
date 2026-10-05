import type { Articulation, Song, Track } from '../ir/types';
import { stableStringify } from '../ir/song-utils';
import { createTimeMap, songLengthTicks } from '../timing';

/**
 * MIDI for instrument plugins (DAW-style "freeze"): a track's notes as raw MIDI events in seconds,
 * and the key that decides whether a frozen render still matches the track.
 */

export interface PluginMidiEvent {
  /** Seconds from song time 0. */
  time: number;
  /** Raw MIDI bytes (status first). */
  data: number[];
}

export interface PluginMidiOptions {
  /** MIDI channel 0..15 (default: the track's channel, else 0; drums 9). */
  channel?: number;
  /** Extra seconds after the last note for release tails (default 2). */
  tailSeconds?: number;
}

const clamp7 = (v: number) => Math.max(0, Math.min(127, Math.round(v)));

function durationFactor(a: Articulation | undefined): number {
  switch (a) {
    case 'staccato':
      return 0.45;
    case 'marcato':
      return 0.75;
    case 'palm-mute':
      return 0.5;
    default:
      return 1;
  }
}

function velocityFor(v: number, a: Articulation | undefined): number {
  let vel = v;
  if (a === 'ghost') vel *= 0.45;
  if (a === 'accent') vel = vel * 1.15 + 8;
  if (a === 'marcato') vel += 6;
  return Math.max(1, clamp7(vel));
}

/**
 * Note-on / note-off events (plus all-notes-off at the end) for a MIDI track, sorted by time with
 * note-offs before note-ons at the same instant. Overlapping notes of the same pitch are
 * re-triggered cleanly (the earlier one is released first).
 */
export function trackMidiEvents(
  song: Song,
  track: Track,
  opts: PluginMidiOptions = {},
): { events: PluginMidiEvent[]; durationSeconds: number } {
  const tm = createTimeMap(song);
  const ch = Math.max(0, Math.min(15, opts.channel ?? track.midiChannel ?? (track.role === 'drums' ? 9 : 0)));
  const raw: { time: number; order: number; data: number[] }[] = [];
  let end = tm.tickToSeconds(songLengthTicks(song));
  const notes = [...track.notes]
    .filter((n) => Number.isFinite(n.tick) && n.duration > 0 && n.pitch >= 0 && n.pitch <= 127)
    .sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  const lastOff = new Map<number, number>();
  for (const n of notes) {
    const t0 = tm.tickToSeconds(n.tick);
    let t1 = tm.tickToSeconds(n.tick + Math.max(1, Math.round(n.duration * durationFactor(n.articulation))));
    if (t1 <= t0) t1 = t0 + 0.01;
    const pitch = clamp7(n.pitch);
    // Release a still-sounding note of the same pitch before re-triggering it.
    const prev = lastOff.get(pitch);
    if (prev !== undefined && prev > t0) {
      const i = raw.findIndex((e) => e.order === 0 && e.data[1] === pitch && e.time === prev);
      if (i >= 0) raw[i].time = t0;
    }
    raw.push({ time: t0, order: 1, data: [0x90 | ch, pitch, velocityFor(n.velocity, n.articulation)] });
    raw.push({ time: t1, order: 0, data: [0x80 | ch, pitch, 64] });
    lastOff.set(pitch, t1);
    end = Math.max(end, t1);
  }
  raw.sort((a, b) => a.time - b.time || a.order - b.order);
  const events: PluginMidiEvent[] = raw.map((e) => ({ time: Math.max(0, e.time), data: e.data }));
  events.push({ time: end, data: [0xb0 | ch, 123, 0] });
  return { events, durationSeconds: end + Math.max(0, opts.tailSeconds ?? 2) };
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Key of everything a plugin render depends on: the track's notes and channel, the tempo map,
 * the plugin and its state/parameters/preset. A frozen render is current while its key matches.
 */
export function pluginRenderKey(song: Song, track: Track): string {
  const slot = track.instrumentPlugin;
  return fnv(
    stableStringify({
      tempo: song.tempoMap,
      ppq: song.ppq,
      ch: track.midiChannel,
      role: track.role === 'drums',
      notes: track.notes.map((n) => [n.tick, n.duration, n.pitch, n.velocity, n.articulation ?? '']),
      plugin: slot
        ? [slot.hostId, slot.pluginId, slot.stateAssetId ?? '', slot.parameters ?? {}, slot.preset ?? '']
        : null,
    }),
  );
}

/** Whether the track should play its frozen plugin render (plugin active and render current). */
export function pluginRenderIsCurrent(song: Song, track: Track): boolean {
  const slot = track.instrumentPlugin;
  return !!slot && !slot.bypass && !!slot.render && slot.render.key === pluginRenderKey(song, track);
}
