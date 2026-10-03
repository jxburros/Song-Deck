import {
  ENGINE_VERSION,
  assetPathFor,
  bpmAtTick,
  channelFor,
  createTimeMap,
  defaultChannelStrip,
  keyAtTick,
  randomId,
  sectionLayout,
  tickToMusical,
  type AudioAssetMeta,
  type AudioClip,
  type Song,
  type Track,
  type VocalTake,
} from '@songdeck/core';
import type { AudioData, TranscribeAudioResult } from '@songdeck/audio';
import { useStudio } from '../state/store';
import { useSettings } from '../state/settings';
import { assetStore } from '../state/assets';
import { jobs } from './jobs';
import { player } from './player';
import { insertOperations } from './capture-song';
import {
  VOCAL_TAKES_GENERATOR,
  applyVocalMonitoring,
  artifactVersions,
  fileStem,
  formatBars,
  takesTrackFor,
  withRights,
} from './vocal-model';
import { proposeVocal } from './vocal-sync';
import type { VocalJobContext } from './vocal-render';

/**
 * Recorded vocals (spec §33 "Recorded Vocal", Phase 4 "user-recorded vocals"): takes are stored
 * as `recording` assets, placed as clips on a "<Vocal> (takes)" audio track (one clip per take;
 * only active takes are unmuted) and listed in `song.vocals.takes`. A take can be transcribed
 * back into the vocal MIDI (as a reviewable proposal) to keep the symbolic layer in sync.
 */

export interface SaveTakeInput {
  projectId: string;
  midiTrackId: string;
  /** Recording as captured (MediaRecorder WebM/Opus or WAV). */
  audio: AudioData;
  /** Timeline position where the recording's song time starts. */
  startTick: number;
  /** Seconds of the recording to skip (playback start delay + latency compensation). */
  offsetSeconds: number;
  measuredDelaySeconds?: number;
  latencyMs?: number;
  sectionName?: string;
  inputLabel?: string;
}

export interface TranscribeTakeInput {
  projectId: string;
  takeId: string;
}

export interface TranscribeTakeOutput {
  proposalId?: string;
  notes: number;
  confidence: number;
  summary: string;
}

function audioSeconds(a: AudioData): number {
  return (a.channels[0]?.length ?? 0) / a.sampleRate;
}

/** Add a take clip (and the takes track, created next to the vocal MIDI track) and make it active. */
export function withTake(
  song: Song,
  o: {
    midiTrackId: string;
    assetId: string;
    name: string;
    startTick: number;
    offsetSeconds: number;
    durationSeconds: number;
  },
): { song: Song; take: VocalTake } {
  const midi = song.tracks.find((t) => t.id === o.midiTrackId);
  if (!midi) throw new Error('The vocal track no longer exists.');
  let takesTrack = takesTrackFor(song, midi.id);
  let tracks = song.tracks;
  let channels = song.mixer.channels;
  if (!takesTrack) {
    takesTrack = {
      id: randomId('trk'),
      name: `${midi.name} (takes)`,
      kind: 'audio',
      role: 'vocal',
      instrumentId: midi.instrumentId || 'lead-vocal',
      constraints: {},
      notes: [],
      clips: [],
      color: midi.color,
      stemGroup: 'vocals',
      sourceTrackId: midi.id,
      generator: { id: VOCAL_TAKES_GENERATOR },
    };
    const idx = tracks.findIndex((t) => t.id === midi.id);
    tracks = [...tracks];
    tracks.splice(idx + 1, 0, takesTrack);
    // Takes go through the vocal's channel strip settings (EQ, compression, sends).
    const strip = {
      ...(song.mixer.channels[midi.id] ? channelFor(song, midi.id) : defaultChannelStrip()),
      mute: false,
      solo: false,
    };
    channels = { ...channels, [takesTrack.id]: strip };
  }
  const take: VocalTake = {
    id: randomId('take'),
    assetId: o.assetId,
    trackId: takesTrack.id,
    createdAt: new Date().toISOString(),
    name: o.name,
    active: true,
  };
  const clip: AudioClip = {
    id: randomId('clip'),
    assetId: o.assetId,
    tick: o.startTick,
    offsetSeconds: Math.max(0, Math.round(o.offsetSeconds * 1000) / 1000),
    durationSeconds: Math.max(0.05, Math.round(o.durationSeconds * 1000) / 1000),
    gainDb: 0,
    fadeInSeconds: 0.01,
    fadeOutSeconds: 0.05,
    name: o.name,
    takeId: take.id,
  };
  const tId = takesTrack.id;
  const next: Song = {
    ...song,
    tracks: tracks.map((t) => (t.id === tId ? { ...t, clips: [...t.clips, clip] } : t)),
    mixer: { ...song.mixer, channels },
    vocals: { ...song.vocals, takes: [...song.vocals.takes, take] },
  };
  return { song: activateTake(next, take.id), take };
}

function clipRange(song: Song, clip: AudioClip): [number, number] {
  const tm = createTimeMap(song);
  const a = tm.tickToSeconds(clip.tick);
  return [a, a + clip.durationSeconds];
}

/** Make a take active; takes overlapping it in time are deactivated (their clips muted). */
export function activateTake(song: Song, takeId: string): Song {
  const take = song.vocals.takes.find((t) => t.id === takeId);
  if (!take) return song;
  const track = song.tracks.find((t) => t.id === take.trackId);
  const clip = track?.clips.find((c) => c.takeId === takeId);
  if (!track || !clip) return song;
  const [a0, a1] = clipRange(song, clip);
  const overlapping = new Set(
    track.clips
      .filter((c) => c.takeId && c.takeId !== takeId)
      .filter((c) => {
        const [b0, b1] = clipRange(song, c);
        return b0 < a1 && b1 > a0;
      })
      .map((c) => c.takeId!),
  );
  return {
    ...song,
    tracks: song.tracks.map((t) =>
      t.id === track.id
        ? {
            ...t,
            clips: t.clips.map((c) =>
              c.takeId === takeId
                ? { ...c, muted: false }
                : c.takeId && overlapping.has(c.takeId)
                  ? { ...c, muted: true }
                  : c,
            ),
          }
        : t,
    ),
    vocals: {
      ...song.vocals,
      takes: song.vocals.takes.map((t) =>
        t.id === takeId ? { ...t, active: true } : overlapping.has(t.id) ? { ...t, active: false } : t,
      ),
    },
  };
}

export function deactivateTake(song: Song, takeId: string): Song {
  const take = song.vocals.takes.find((t) => t.id === takeId);
  if (!take) return song;
  return {
    ...song,
    tracks: song.tracks.map((t) =>
      t.id === take.trackId
        ? { ...t, clips: t.clips.map((c) => (c.takeId === takeId ? { ...c, muted: true } : c)) }
        : t,
    ),
    vocals: {
      ...song.vocals,
      takes: song.vocals.takes.map((t) => (t.id === takeId ? { ...t, active: false } : t)),
    },
  };
}

/** Remove a take from the song (its asset stays in the project for history / undo). */
export function removeTake(song: Song, takeId: string): Song {
  const take = song.vocals.takes.find((t) => t.id === takeId);
  if (!take) return song;
  return {
    ...song,
    tracks: song.tracks.map((t) =>
      t.id === take.trackId ? { ...t, clips: t.clips.filter((c) => c.takeId !== takeId) } : t,
    ),
    vocals: { ...song.vocals, takes: song.vocals.takes.filter((t) => t.id !== takeId) },
  };
}

export function takeClip(song: Song, take: VocalTake): { track: Track; clip: AudioClip } | null {
  const track = song.tracks.find((t) => t.id === take.trackId);
  const clip = track?.clips.find((c) => c.takeId === take.id);
  return track && clip ? { track, clip } : null;
}

/** Store a recorded take (WAV, `recording` asset + provenance) and commit it as the active take. */
export async function saveTake(o: SaveTakeInput): Promise<{ takeId: string; assetId: string; name: string }> {
  const st = useStudio.getState();
  const project = st.project;
  if (!project || project.meta.id !== o.projectId) throw new Error('The project was closed while recording.');
  const song = project.song;
  const midi = song.tracks.find((t) => t.id === o.midiTrackId);
  if (!midi) throw new Error('The vocal track no longer exists.');
  const bytes = await jobs.call<Uint8Array>('encodeWav', { audio: o.audio, bitDepth: 16 });
  const n = song.vocals.takes.length + 1;
  const where = o.sectionName ?? formatBars(song, o.startTick, o.startTick + 1);
  const name = `Take ${n} · ${where}`;
  const id = randomId('asset');
  const provenanceId = randomId('prov');
  const fileName = `${fileStem(midi.name)}-take-${n}-${fileStem(where, '-')}.wav`;
  const path = project.meta.assets.some((a) => a.path === assetPathFor('recording', fileName))
    ? assetPathFor('recording', fileName.replace(/\.wav$/, `-${id.slice(-6)}.wav`))
    : assetPathFor('recording', fileName);
  const duration = audioSeconds(o.audio);
  const meta: AudioAssetMeta = {
    id,
    name: fileName,
    kind: 'recording',
    path,
    mimeType: 'audio/wav',
    sampleRate: o.audio.sampleRate,
    channels: o.audio.channels.length,
    durationSeconds: Math.round(duration * 1000) / 1000,
    bytes: bytes.byteLength,
    createdAt: new Date().toISOString(),
    provenanceId,
  };
  await st.addAsset(meta, bytes);
  const userName = useSettings.getState().userName || 'Me';
  const versions = artifactVersions(project, midi.id);
  st.addProvenance({
    id: provenanceId,
    artifactId: id,
    artifactName: fileName,
    artifactKind: 'audio',
    sources: [
      { kind: 'performance', ref: userName },
      { kind: 'song', ref: song.id, revision: versions.revision },
      ...(o.inputLabel ? [{ kind: 'input', ref: o.inputLabel }] : []),
    ],
    providerId: 'user-recording',
    providerName: `Recorded by ${userName}`,
    parameters: {
      takeNumber: n,
      startTick: o.startTick,
      startBar: tickToMusical(song, o.startTick).bar,
      offsetSeconds: o.offsetSeconds,
      measuredDelaySeconds: o.measuredDelaySeconds,
      latencyCompensationMs: o.latencyMs,
      durationSeconds: duration,
      section: o.sectionName,
    },
    engineVersion: ENGINE_VERSION,
    generatedAt: meta.createdAt,
    cloud: false,
  });
  player.provideAsset(id, o.audio);
  const latest = useStudio.getState().project!.song;
  const { song: withIt, take } = withTake(latest, {
    midiTrackId: midi.id,
    assetId: id,
    name,
    startTick: o.startTick,
    offsetSeconds: o.offsetSeconds,
    durationSeconds: Math.max(0.05, duration - o.offsetSeconds),
  });
  const mon = applyVocalMonitoring({ ...withIt, vocals: { ...withIt.vocals, mode: 'recorded' } }, midi.id);
  useStudio.getState().commit(mon.song, `Recorded ${name} (${duration.toFixed(1)} s)`, 'vocals');
  useStudio.getState().updateProject((p) => withRights(p, { performers: [userName] }));
  return { takeId: take.id, assetId: id, name };
}

/** Transcribe a take (jobs 'transcribe', source 'singing') into a proposal that replaces the vocal MIDI in the take's bars. */
export async function transcribeTake(
  input: TranscribeTakeInput,
  ctx: VocalJobContext,
): Promise<TranscribeTakeOutput> {
  const project = useStudio.getState().project;
  if (!project || project.meta.id !== input.projectId)
    throw new Error('The project for this task is not open.');
  const song = project.song;
  const take = song.vocals.takes.find((t) => t.id === input.takeId);
  if (!take) throw new Error('The take no longer exists.');
  const tc = takeClip(song, take);
  if (!tc) throw new Error('The take has no clip on the timeline.');
  const midi = song.tracks.find((t) => t.id === tc.track.sourceTrackId);
  if (!midi) throw new Error('The take is not linked to a vocal MIDI track.');
  const meta = project.meta.assets.find((a) => a.id === take.assetId);
  if (!meta) throw new Error('The take audio is missing from the project.');
  ctx.progress(0.05, 'Loading the take');
  const audio = await assetStore.audio(meta);
  if (!audio) throw new Error('The take audio could not be decoded.');
  const bpm = bpmAtTick(song, tc.clip.tick);
  const key = keyAtTick(song, tc.clip.tick);
  ctx.log(
    'info',
    `Transcribing ${take.name} as singing at ${Math.round(bpm)} BPM (tick 0 = ${tc.clip.offsetSeconds.toFixed(3)} s into the recording)`,
  );
  ctx.progress(0.15, 'Tracking pitch…');
  const result = await jobs.call<TranscribeAudioResult>(
    'transcribe',
    {
      audio,
      source: 'singing',
      bpm,
      key,
      quantizeBeats: 0.25,
      snapToKey: true,
      offsetSeconds: tc.clip.offsetSeconds,
    },
    { signal: ctx.signal },
  );
  if (ctx.signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
  const tm = createTimeMap(song);
  const startSec = tm.tickToSeconds(tc.clip.tick);
  const endTick = Math.round(tm.secondsToTick(startSec + tc.clip.durationSeconds));
  const startBar = tickToMusical(song, tc.clip.tick).bar;
  const lastBar = Math.max(startBar, tickToMusical(song, Math.max(tc.clip.tick, endTick - 1)).bar);
  const songBars = sectionLayout(song).reduce((m, s) => Math.max(m, s.endBar), 0);
  const endBar = Math.min(lastBar, Math.max(startBar, songBars));
  for (const w of result.warnings ?? []) ctx.log('warn', w);
  ctx.progress(0.85, 'Building the proposal');
  const notes = result.notes.map((n) => ({ ...n, origin: 'transcription' }));
  if (!notes.length) {
    ctx.progress(1, 'Done');
    return { notes: 0, confidence: result.confidence, summary: 'No sung notes were detected in the take.' };
  }
  const title = `Transcribe ${take.name} → ${midi.name}`;
  const { ops } = insertOperations({
    mode: 'replace',
    song,
    notes,
    targetBar: startBar,
    endBar,
    trackId: midi.id,
    keepSyllables: true,
    meta: { title, source: 'internal' },
  });
  const p = proposeVocal(
    song,
    ops,
    {
      title,
      source: 'internal',
      instruction: `Transcribe ${take.name}`,
      explanation: `${notes.length} sung notes (${result.method}, confidence ${Math.round(result.confidence * 100)}%) replace the vocal MIDI in bars ${startBar}–${endBar}; existing lyric syllables are kept in order.`,
    },
    { projectId: project.meta.id, trackId: midi.id, kind: 'transcription', title },
  );
  ctx.progress(1, 'Done');
  if ('error' in p) return { notes: notes.length, confidence: result.confidence, summary: p.error };
  return {
    proposalId: p.id,
    notes: notes.length,
    confidence: result.confidence,
    summary: `${notes.length} notes · confidence ${Math.round(result.confidence * 100)}% · review the proposal`,
  };
}
