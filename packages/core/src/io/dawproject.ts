import { strToU8, zipSync, type Zippable } from 'fflate';
import type { Song, Track } from '../ir/types';
import { channelFor } from '../ir/song-utils';
import { barToTick, createTimeMap, meterAtBar, sectionLayout, songLengthTicks } from '../timing';
import { isDrumTrack, type InstrumentLookupOptions } from '../edit/instruments';
import { assignChannels } from './midi';
import { xmlEscape } from './util';

export interface DawAudioFile {
  /** Track the audio belongs to (an audio track, or a MIDI track whose rendered stem this is). */
  trackId: string;
  /** Path inside the archive, e.g. "audio/vocal.wav". */
  path: string;
  data: Uint8Array;
  /** Overrides when the file is not a parseable WAV. */
  sampleRate?: number;
  channels?: number;
  durationSeconds?: number;
}

export interface DawProjectOptions extends InstrumentLookupOptions {
  audio?: DawAudioFile[];
  application?: { name: string; version: string };
  /** Archive timestamp (default: fixed epoch for reproducible files). */
  mtime?: Date | string | number;
}

/** Sample rate / channels / duration from a RIFF WAVE header (undefined if not a WAV). */
export function wavInfo(
  data: Uint8Array,
): { sampleRate: number; channels: number; durationSeconds: number } | undefined {
  if (data.length < 44) return undefined;
  const str = (o: number) => String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]);
  if (str(0) !== 'RIFF' || str(8) !== 'WAVE') return undefined;
  const u32 = (o: number) => (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)) >>> 0;
  const u16 = (o: number) => data[o] | (data[o + 1] << 8);
  let pos = 12;
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let dataBytes = 0;
  while (pos + 8 <= data.length) {
    const id = str(pos);
    const len = u32(pos + 4);
    if (id === 'fmt ') {
      channels = u16(pos + 10);
      sampleRate = u32(pos + 12);
      blockAlign = u16(pos + 20);
    } else if (id === 'data') {
      dataBytes = Math.min(len, data.length - pos - 8);
      break;
    }
    pos += 8 + len + (len & 1);
  }
  if (!sampleRate || !blockAlign) return undefined;
  return { sampleRate, channels, durationSeconds: dataBytes / blockAlign / sampleRate };
}

const num = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Number.isInteger(r) ? `${r}.0` : String(r);
};

/**
 * DAWproject 1.0 archive (project.xml + metadata.xml + audio files), the open exchange format
 * read by Bitwig Studio, Studio One, Cubase and others (spec §56 "deeper project export").
 */
export function songToDawProject(song: Song, opts: DawProjectOptions = {}): Uint8Array {
  let nextId = 0;
  const id = () => `id${nextId++}`;
  const lookup: InstrumentLookupOptions = {
    customInstruments: opts.customInstruments,
    resolveInstrument: opts.resolveInstrument,
  };
  const ppq = song.ppq;
  const beats = (ticks: number) => ticks / ppq;
  const tm = createTimeMap(song);
  const midiTracks = song.tracks.filter((t) => t.kind === 'midi');
  const channels = assignChannels(midiTracks, lookup);
  let endTick = songLengthTicks(song);
  for (const t of song.tracks) for (const n of t.notes) endTick = Math.max(endTick, n.tick + n.duration);
  const audioFiles = opts.audio ?? [];
  for (const a of audioFiles) {
    const info = wavInfo(a.data);
    const dur = a.durationSeconds ?? info?.durationSeconds ?? 0;
    if (dur > 0) endTick = Math.max(endTick, Math.ceil(tm.secondsToTick(dur)));
  }
  const lengthBeats = Math.max(1, Math.ceil(beats(endTick)));

  const tempos = [...song.tempoMap].sort((a, b) => a.tick - b.tick);
  const tempoParamId = id();
  const timeSigParamId = id();
  const meter0 = meterAtBar(song, 0);
  const masterChannelId = id();
  const masterTrackId = id();

  interface Lane {
    trackId: string;
    clips: string;
  }
  const structure: string[] = [];
  const lanes: Lane[] = [];

  const channelXml = (track: Track | undefined, chId: string, role: 'regular' | 'master') => {
    const strip = track ? channelFor(song, track.id) : undefined;
    const volDb = role === 'master' ? song.mixer.master.volumeDb : (strip?.volumeDb ?? 0);
    const vol = Math.min(2, Math.max(0, Math.pow(10, volDb / 20)));
    const pan = role === 'master' ? 0.5 : ((strip?.pan ?? 0) + 1) / 2;
    const mute = role === 'master' ? false : !!strip?.mute;
    const solo = role === 'master' ? false : !!strip?.solo;
    const dest = role === 'master' ? '' : ` destination="${masterChannelId}"`;
    return (
      `      <Channel audioChannels="2"${dest} role="${role}" solo="${solo}" id="${chId}">\n` +
      `        <Mute value="${mute}" id="${id()}" name="Mute"/>\n` +
      `        <Pan max="1.0" min="0.0" unit="normalized" value="${num(Math.min(1, Math.max(0, pan)))}" id="${id()}" name="Pan"/>\n` +
      `        <Volume max="2.0" min="0.0" unit="linear" value="${num(vol)}" id="${id()}" name="Volume"/>\n` +
      `      </Channel>\n`
    );
  };

  const audioClip = (a: DawAudioFile, name: string) => {
    const info = wavInfo(a.data);
    const seconds = a.durationSeconds ?? info?.durationSeconds ?? tm.tickToSeconds(endTick);
    const sampleRate = a.sampleRate ?? info?.sampleRate ?? 48000;
    const chans = a.channels ?? info?.channels ?? 2;
    const durBeats = beats(tm.secondsToTick(seconds));
    return (
      `          <Clip time="0.0" duration="${num(durBeats)}" playStart="0.0" name="${xmlEscape(name)}">\n` +
      `            <Warps contentTimeUnit="seconds" timeUnit="beats" id="${id()}">\n` +
      `              <Audio algorithm="stretch" channels="${chans}" duration="${num(seconds)}" sampleRate="${sampleRate}" id="${id()}">\n` +
      `                <File path="${xmlEscape(a.path)}"/>\n` +
      `              </Audio>\n` +
      `              <Warp time="0.0" contentTime="0.0"/>\n` +
      `              <Warp time="${num(durBeats)}" contentTime="${num(seconds)}"/>\n` +
      `            </Warps>\n` +
      `          </Clip>\n`
    );
  };

  const addTrack = (
    name: string,
    color: string,
    contentType: 'notes' | 'audio',
    track: Track | undefined,
    clips: string,
  ) => {
    const trackId = id();
    const chId = id();
    structure.push(
      `    <Track contentType="${contentType}" loaded="true" id="${trackId}" name="${xmlEscape(name)}" color="${xmlEscape(color)}">\n${channelXml(track, chId, 'regular')}    </Track>\n`,
    );
    lanes.push({ trackId, clips });
  };

  for (const track of song.tracks) {
    if (track.kind === 'midi') {
      const ch = isDrumTrack(track, lookup) ? 9 : (channels.get(track.id) ?? 0);
      const notes = track.notes
        .map(
          (n) =>
            `              <Note time="${num(beats(n.tick))}" duration="${num(beats(Math.max(1, n.duration)))}" channel="${ch}" key="${Math.max(0, Math.min(127, n.pitch))}" vel="${num(Math.max(1, Math.min(127, n.velocity)) / 127)}" rel="0.5"/>\n`,
        )
        .join('');
      const clip =
        `          <Clip time="0.0" duration="${num(lengthBeats)}" playStart="0.0" name="${xmlEscape(track.name)}">\n` +
        `            <Notes id="${id()}">\n${notes}            </Notes>\n` +
        `          </Clip>\n`;
      addTrack(track.name, track.color, 'notes', track, clip);
      for (const a of audioFiles.filter((x) => x.trackId === track.id))
        addTrack(`${track.name} (audio)`, track.color, 'audio', track, audioClip(a, `${track.name} (audio)`));
    } else {
      const clips = audioFiles
        .filter((x) => x.trackId === track.id)
        .map((a) => audioClip(a, track.name))
        .join('');
      addTrack(track.name, track.color, 'audio', track, clips);
    }
  }
  structure.push(
    `    <Track contentType="audio notes" loaded="true" id="${masterTrackId}" name="Master" color="#666666">\n${channelXml(undefined, masterChannelId, 'master')}    </Track>\n`,
  );

  const arr: string[] = [];
  const arrangementId = id();
  arr.push(`  <Arrangement id="${arrangementId}">\n`);
  const meters = [...song.meterMap].sort((a, b) => a.bar - b.bar);
  if (meters.length > 1) {
    arr.push(
      `    <TimeSignatureAutomation timeUnit="beats" id="${id()}">\n      <Target parameter="${timeSigParamId}"/>\n`,
    );
    for (const m of meters)
      arr.push(
        `      <TimeSignaturePoint time="${num(beats(barToTick(song, m.bar)))}" numerator="${m.numerator}" denominator="${m.denominator}"/>\n`,
      );
    arr.push('    </TimeSignatureAutomation>\n');
  }
  if (tempos.length > 1) {
    arr.push(
      `    <TempoAutomation timeUnit="beats" unit="bpm" id="${id()}">\n      <Target parameter="${tempoParamId}"/>\n`,
    );
    for (const t of tempos)
      arr.push(
        `      <RealPoint time="${num(beats(t.tick))}" value="${num(t.bpm)}" interpolation="hold"/>\n`,
      );
    arr.push('    </TempoAutomation>\n');
  }
  const spans = sectionLayout(song).filter((s) => s.endBar > s.startBar);
  if (spans.length) {
    arr.push(`    <Markers timeUnit="beats" id="${id()}">\n`);
    for (const s of spans)
      arr.push(`      <Marker time="${num(beats(s.startTick))}" name="${xmlEscape(s.section.name)}"/>\n`);
    arr.push('    </Markers>\n');
  }
  arr.push(`    <Lanes timeUnit="beats" id="${id()}">\n`);
  for (const lane of lanes) {
    arr.push(
      `      <Lanes track="${lane.trackId}" id="${id()}">\n        <Clips id="${id()}">\n${lane.clips}        </Clips>\n      </Lanes>\n`,
    );
  }
  arr.push('    </Lanes>\n  </Arrangement>\n');

  const app = opts.application ?? { name: 'Song Deck', version: '1.0' };
  const project =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Project version="1.0">\n' +
    `  <Application name="${xmlEscape(app.name)}" version="${xmlEscape(app.version)}"/>\n` +
    '  <Transport>\n' +
    `    <Tempo max="999.0" min="20.0" unit="bpm" value="${num(tempos[0]?.bpm ?? 120)}" id="${tempoParamId}" name="Tempo"/>\n` +
    `    <TimeSignature denominator="${meter0.denominator}" numerator="${meter0.numerator}" id="${timeSigParamId}"/>\n` +
    '  </Transport>\n' +
    `  <Structure>\n${structure.join('')}  </Structure>\n` +
    arr.join('') +
    '  <Scenes/>\n' +
    '</Project>\n';
  const metadata =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<MetaData>\n' +
    `  <Title>${xmlEscape(song.title || 'Untitled')}</Title>\n` +
    '  <Comment>Exported from Song Deck</Comment>\n' +
    '</MetaData>\n';
  const mtime = opts.mtime ?? new Date('2000-01-01T00:00:00Z');
  const files: Zippable = {
    'project.xml': [strToU8(project), { level: 6, mtime }],
    'metadata.xml': [strToU8(metadata), { level: 6, mtime }],
  };
  for (const a of audioFiles) {
    const path = a.path.replace(/^\/+/, '').replace(/\.\.(\/|\\)/g, '');
    files[path] = [a.data, { level: 0, mtime }];
  }
  return zipSync(files);
}
