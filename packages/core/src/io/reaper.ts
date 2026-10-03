import type { Song, Track } from '../ir/types';
import { channelFor } from '../ir/song-utils';
import { hashSeed } from '../util/random';
import { barToTick, createTimeMap, sectionLayout, songLengthTicks } from '../timing';
import { isDrumTrack, lookupInstrument, type InstrumentLookupOptions } from '../edit/instruments';
import { assignChannels } from './midi';

export interface ReaperAudioFile {
  trackId: string;
  /** Path relative to the .RPP file (e.g. "audio/vocal.wav"). */
  path: string;
  /** Item length in seconds (default: song length). */
  durationSeconds?: number;
}

export interface ReaperOptions extends InstrumentLookupOptions {
  audio?: ReaperAudioFile[];
}

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
const sec = (v: number) => (Math.round(v * 1e9) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
const quote = (s: string) => `"${s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ')}"`;

/** Deterministic Reaper-style GUID from a string. */
function guid(seed: string): string {
  const parts = [0, 1, 2, 3].map((i) => hashSeed(7, seed, i).toString(16).padStart(8, '0').toUpperCase());
  const h = parts.join('');
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}}`;
}

function sourceType(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'mp3') return 'MP3';
  if (ext === 'flac') return 'FLAC';
  if (ext === 'ogg' || ext === 'oga') return 'VORBIS';
  if (ext === 'opus') return 'OPUS';
  return 'WAVE';
}

/**
 * Reaper project (.RPP text): tempo/time signature (with a tempo envelope when the map changes),
 * section markers, one track per song track with volume/pan/mute/solo and an item holding
 * in-project MIDI (or an audio source referencing a file).
 */
export function songToReaperProject(song: Song, opts: ReaperOptions = {}): string {
  const lookup: InstrumentLookupOptions = { customInstruments: opts.customInstruments, resolveInstrument: opts.resolveInstrument };
  const tm = createTimeMap(song);
  const tempos = [...song.tempoMap].sort((a, b) => a.tick - b.tick);
  if (!tempos.length || tempos[0].tick !== 0) tempos.unshift({ tick: 0, bpm: tempos[0]?.bpm ?? 120 });
  const meters = [...song.meterMap].sort((a, b) => a.bar - b.bar);
  if (!meters.length || meters[0].bar !== 0) meters.unshift({ bar: 0, numerator: meters[0]?.numerator ?? 4, denominator: meters[0]?.denominator ?? 4 });
  let endTick = songLengthTicks(song);
  for (const t of song.tracks) for (const n of t.notes) endTick = Math.max(endTick, n.tick + n.duration);
  const songSeconds = tm.tickToSeconds(endTick);
  const L: string[] = [];
  L.push(`<REAPER_PROJECT 0.1 "6.0/SongDeck" 0`);
  L.push('  RIPPLE 0');
  L.push('  AUTOXFADE 1');
  L.push(`  TEMPO ${sec(tempos[0].bpm)} ${meters[0].numerator} ${meters[0].denominator}`);
  L.push('  PLAYRATE 1 0 0.25 4');
  L.push('  SAMPLERATE 48000 0 0');
  // Tempo envelope (tempo changes and time signature changes as tempo markers).
  const points = new Map<number, { bpm: number; ts?: number }>();
  for (const t of tempos) points.set(Math.round(t.tick), { bpm: t.bpm });
  for (const m of meters) {
    const tick = barToTick(song, m.bar);
    const p = points.get(tick) ?? { bpm: tm.bpmAt(tick) };
    p.ts = m.numerator + m.denominator * 65536;
    points.set(tick, p);
  }
  if (points.size > 1) {
    L.push('  <TEMPOENVEX');
    L.push('    ACT 1 -1');
    L.push('    VIS 1 0 1');
    L.push('    LANEHEIGHT 0 0');
    L.push('    ARM 0');
    L.push('    DEFSHAPE 1 -1 -1');
    for (const [tick, p] of [...points].sort((a, b) => a[0] - b[0])) {
      L.push(`    PT ${sec(tm.tickToSeconds(tick))} ${sec(p.bpm)} 1${p.ts !== undefined ? ` ${p.ts}` : ''}`);
    }
    L.push('  >');
  }
  sectionLayout(song)
    .filter((s) => s.endBar > s.startBar)
    .forEach((s, i) => L.push(`  MARKER ${i + 1} ${sec(tm.tickToSeconds(s.startTick))} ${quote(s.section.name)} 0 0 1`));

  const midiTracks = song.tracks.filter((t) => t.kind === 'midi');
  const channels = assignChannels(midiTracks, lookup);
  const audio = opts.audio ?? [];

  const trackHeader = (track: Track, name: string, suffix = '') => {
    const strip = channelFor(song, track.id);
    L.push(`  <TRACK ${guid(track.id + suffix)}`);
    L.push(`    NAME ${quote(name)}`);
    L.push(`    VOLPAN ${sec(Math.pow(10, strip.volumeDb / 20))} ${sec(Math.max(-1, Math.min(1, strip.pan)))} -1 -1 1`);
    L.push(`    MUTESOLO ${strip.mute ? 1 : 0} ${strip.solo ? 2 : 0} 0`);
    L.push('    NCHAN 2');
  };
  const audioItem = (a: ReaperAudioFile, name: string) => {
    L.push('    <ITEM');
    L.push('      POSITION 0');
    L.push(`      LENGTH ${sec(a.durationSeconds ?? songSeconds)}`);
    L.push('      LOOP 0');
    L.push(`      NAME ${quote(name)}`);
    L.push(`      <SOURCE ${sourceType(a.path)}`);
    L.push(`        FILE ${quote(a.path)}`);
    L.push('      >');
    L.push('    >');
  };

  for (const track of song.tracks) {
    trackHeader(track, track.name);
    if (track.kind === 'midi') {
      const ch = isDrumTrack(track, lookup) ? 9 : (channels.get(track.id) ?? 0);
      const profile = lookupInstrument(track.instrumentId, lookup);
      const events: { tick: number; rank: number; bytes: number[] }[] = [];
      if (ch !== 9) events.push({ tick: 0, rank: 0, bytes: [0xc0 | ch, Math.max(0, Math.min(127, profile.gmProgram)), 0] });
      // Same-pitch overlaps are cut at the next onset so on/off pairs stay unambiguous.
      const sorted = [...track.notes].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
      const nextOn = new Map<number, number>();
      const pairs: { on: number; off: number; pitch: number; vel: number }[] = [];
      for (let i = sorted.length - 1; i >= 0; i--) {
        const n = sorted[i];
        const next = nextOn.get(n.pitch);
        if (next === n.tick) continue;
        const off = Math.min(n.tick + Math.max(1, n.duration), next ?? Infinity);
        nextOn.set(n.pitch, n.tick);
        pairs.push({ on: n.tick, off, pitch: n.pitch, vel: n.velocity });
      }
      for (const p of pairs) {
        events.push({ tick: Math.round(p.on), rank: 2, bytes: [0x90 | ch, p.pitch, Math.max(1, Math.min(127, p.vel))] });
        events.push({ tick: Math.round(p.off), rank: 1, bytes: [0x80 | ch, p.pitch, 0x40] });
      }
      events.sort((a, b) => a.tick - b.tick || a.rank - b.rank);
      L.push('    <ITEM');
      L.push('      POSITION 0');
      L.push(`      LENGTH ${sec(songSeconds)}`);
      L.push('      LOOP 0');
      L.push(`      NAME ${quote(track.name)}`);
      L.push('      <SOURCE MIDI');
      L.push(`        HASDATA 1 ${song.ppq} QN`);
      L.push('        CCINTERP 32');
      let last = 0;
      for (const e of events) {
        L.push(`        E ${e.tick - last} ${e.bytes.map(hex2).join(' ')}`);
        last = e.tick;
      }
      L.push(`        E ${Math.max(0, endTick - last)} b${ch.toString(16)} 7b 00`);
      L.push('      >');
      L.push('    >');
      L.push('  >');
      for (const a of audio.filter((x) => x.trackId === track.id)) {
        trackHeader(track, `${track.name} (audio)`, ':audio');
        audioItem(a, `${track.name} (audio)`);
        L.push('  >');
      }
    } else {
      for (const a of audio.filter((x) => x.trackId === track.id)) audioItem(a, track.name);
      L.push('  >');
    }
  }
  L.push('>');
  return L.join('\n') + '\n';
}
