import { create } from 'zustand';
import {
  AUDIO_MIDI_DEFAULT_INSTRUMENT,
  BUILTIN_INSTRUMENTS,
  addAsset as coreAddAsset,
  audioMidiSourceKey,
  createTimeMap,
  firstClipTick,
  hasAttachedMidi,
  keyAtTick,
  bpmAtTick,
  LockKeys,
  normalizeTuning,
  randomId,
  sortNotes,
  tuneTargets,
  tuningActive,
  tuningRenderKey,
  tuningRenderIsStale,
  DEFAULT_TUNING,
  type AudioAssetMeta,
  type AudioMidiLink,
  type AudioMidiMode,
  type AudioMidiPlayback,
  type AudioTuningSettings,
  type Note,
  type Song,
  type TaskHandler,
  type Track,
} from '@songdeck/core';
import {
  enforceMonophony,
  resolveOverlaps,
  type AudioData,
  type RetuneReport,
  type TranscriptionSource,
} from '@songdeck/audio';
import { useStudio } from '../state/store';
import { assetStore } from '../state/assets';
import { jobs } from './jobs';
import { player } from './player';
import { enqueueTask } from './capture-tasks';
import { taskQueue } from './runtime';
import { allCustomInstruments } from './plugins';
import {
  handlers as analysisHandlers,
  type TranscribeTaskInput,
  type TranscribeTaskOutput,
} from './handlers/analysis';

/**
 * MIDI attached to audio tracks: "Make MIDI" transcribes an audio track's own clips (on the song
 * timeline, never quantized) into notes stored on that track; the track then plays its recording
 * or the notes through an instrument. With tuning on, the recording is pitch-corrected to follow
 * the notes (TD-PSOLA in the job worker) and frozen into a `tuned-render` asset that playback
 * and every export use while it matches; edits make it stale and it re-renders automatically.
 */

export type MakeMidiMode = AudioMidiMode | 'auto';

export interface MakeMidiTaskInput {
  trackId: string;
  mode: MakeMidiMode;
  /** Transcription provider: 'auto' | 'internal' | provider id (default on-device). */
  provider?: string;
}

export interface MakeMidiTaskOutput {
  notes: number;
  mode: AudioMidiMode;
  method: string;
  confidence: number;
  warnings: string[];
}

export interface RetuneTaskInput {
  trackId: string;
}

export interface RetuneTaskOutput {
  assetId: string;
  report: RetuneReport;
}

interface JobState {
  status: 'queued' | 'running' | 'done' | 'failed';
  taskId?: string;
  error?: string;
}

interface AudioMidiState {
  /** "Make MIDI" runs by track id. */
  making: Record<string, JobState>;
  /** Tuning renders by track id. */
  tuning: Record<string, JobState & { report?: RetuneReport }>;
}

export const useAudioMidi = create<AudioMidiState>(() => ({ making: {}, tuning: {} }));

function setMaking(trackId: string, s: JobState): void {
  useAudioMidi.setState((st) => ({ making: { ...st.making, [trackId]: s } }));
}

function setTuning(trackId: string, s: AudioMidiState['tuning'][string]): void {
  useAudioMidi.setState((st) => ({ tuning: { ...st.tuning, [trackId]: s } }));
}

function currentSong(): Song | undefined {
  return useStudio.getState().project?.song;
}

function busy(s: JobState | undefined): boolean {
  return !!s && (s.status === 'queued' || s.status === 'running');
}

/** Decoded audio of a track's clips, and the highest clip sample rate (the render rate). */
async function clipAudio(track: Track): Promise<{ assets: Record<string, AudioData>; sampleRate: number }> {
  const project = useStudio.getState().project;
  const assets: Record<string, AudioData> = {};
  let sampleRate = 0;
  for (const c of track.clips) {
    if (c.muted || assets[c.assetId]) continue;
    const meta = project?.meta.assets.find((a) => a.id === c.assetId);
    const audio = meta ? await assetStore.audio(meta) : undefined;
    if (!audio) continue;
    assets[c.assetId] = audio;
    sampleRate = Math.max(sampleRate, audio.sampleRate);
  }
  return { assets, sampleRate: Math.min(96000, sampleRate || 44100) };
}

// ---------------------------------------------------------------------------------------------
// Make MIDI from audio
// ---------------------------------------------------------------------------------------------

const VOCAL_LIKE = (t: Track) => t.role === 'vocal' || t.stemGroup === 'vocals';
const BASS_LIKE = (t: Track) => t.role === 'bass' || t.stemGroup === 'bass';
const DRUM_LIKE = (t: Track) => t.role === 'drums' || t.role === 'percussion' || t.stemGroup === 'drums';

/** The mode "Auto" picks from what the track is (null: let the instrument classifier decide). */
export function guessMode(track: Track): AudioMidiMode | null {
  if (DRUM_LIKE(track)) return 'drums';
  if (VOCAL_LIKE(track) || BASS_LIKE(track)) return 'melody';
  if (track.stemGroup === 'guitars' || track.stemGroup === 'keys' || track.role === 'keys') return 'chords';
  return null;
}

function sourceFor(mode: MakeMidiMode, track: Track): TranscriptionSource {
  const m = mode === 'auto' ? guessMode(track) : mode;
  if (m === 'drums') return 'drums';
  if (m === 'melody') return BASS_LIKE(track) ? 'bass' : 'singing';
  if (m === 'chords') return track.stemGroup === 'guitars' ? 'guitar' : 'piano';
  return 'isolated';
}

function modeOf(result: TranscribeTaskOutput, source: TranscriptionSource): AudioMidiMode {
  if (source === 'drums' || (result.drumHits && !result.transcribed.length)) return 'drums';
  if (source === 'singing' || source === 'bass') return 'melody';
  const role = result.suggestedRole;
  return role === 'vocal' || role === 'bass' || role === 'synth-lead' || role === 'lead-guitar'
    ? 'melody'
    : 'chords';
}

/** Instrument that plays the MIDI: the track's own when it is a real (non-vocal) instrument. */
function playbackInstrument(track: Track, mode: AudioMidiMode, suggested: string | undefined): string {
  const all = [...BUILTIN_INSTRUMENTS, ...allCustomInstruments()];
  const usable = (id: string | undefined) => {
    const p = id ? all.find((i) => i.id === id) : undefined;
    // Sung parts play on a lead synth: the built-in singer needs lyrics and may be switched off.
    return !!p && p.family !== 'vocal' && (mode === 'drums') === !!p.isDrumKit;
  };
  if (track.audioMidi && usable(track.audioMidi.instrumentId)) return track.audioMidi.instrumentId;
  if (usable(track.instrumentId)) return track.instrumentId;
  if (usable(suggested)) return suggested!;
  return AUDIO_MIDI_DEFAULT_INSTRUMENT[mode];
}

/** Why the track's notes cannot be replaced (a locked track or locked notes), or null. */
export function notesLockedReason(song: Song, track: Track): string | null {
  if (song.locks[LockKeys.track(track.id)]) return `“${track.name}” is locked: unlock the track first.`;
  if (track.notes.some((n) => n.locked)) return `“${track.name}” has locked notes: unlock them first.`;
  return null;
}

/**
 * Transcribed notes (seconds from the start of the transcribed audio, which begins
 * `offsetSeconds` into the song) → song notes on the tempo map, unquantized.
 */
export function notesFromTranscription(
  song: Song,
  result: Pick<TranscribeTaskOutput, 'transcribed' | 'drumHits' | 'method'>,
  mode: AudioMidiMode,
  offsetSeconds = 0,
  idPrefix = randomId('am'),
): Note[] {
  const tm = createTimeMap(song);
  const toTick = (s: number) => Math.max(0, Math.round(tm.secondsToTick(Math.max(0, s + offsetSeconds))));
  const origin = `transcription:${result.method}`;
  let notes: Note[] = [];
  if (mode === 'drums') {
    const len = Math.max(1, Math.round(song.ppq / 4));
    notes = (result.drumHits ?? []).map((h, i) => ({
      id: `${idPrefix}_${i}`,
      pitch: Math.max(0, Math.min(127, Math.round(h.drum))),
      tick: toTick(h.time),
      duration: len,
      velocity: Math.max(1, Math.min(127, Math.round(h.velocity))),
      confidence: h.confidence,
      origin,
    }));
  } else {
    notes = result.transcribed
      .filter((n) => n.endSeconds > n.startSeconds && n.pitch >= 0 && n.pitch <= 127)
      .map((n, i) => {
        const tick = toTick(n.startSeconds);
        return {
          id: `${idPrefix}_${i}`,
          pitch: Math.round(n.pitch),
          tick,
          duration: Math.max(1, toTick(n.endSeconds) - tick),
          velocity: Math.max(1, Math.min(127, Math.round(n.velocity))),
          confidence: n.confidence,
          origin,
        };
      });
    notes = resolveOverlaps(notes);
    if (mode === 'melody') notes = enforceMonophony(notes);
  }
  return sortNotes(notes);
}

/** Queue "Make MIDI" for an audio track (one run at a time per track). */
export function makeMidiFromAudio(
  trackId: string,
  mode: MakeMidiMode,
  provider?: string,
): string | undefined {
  const track = currentSong()?.tracks.find((t) => t.id === trackId);
  if (!track || track.kind !== 'audio') return undefined;
  const cur = useAudioMidi.getState().making[trackId];
  if (busy(cur)) return cur!.taskId;
  taskQueue.register('audio.make-midi', makeMidiHandler);
  const rec = enqueueTask<MakeMidiTaskInput>({
    type: 'audio.make-midi',
    title: `Make MIDI from “${track.name}”`,
    input: { trackId, mode, provider },
  });
  setMaking(trackId, { status: 'queued', taskId: rec.id });
  return rec.id;
}

export async function runMakeMidi(
  input: MakeMidiTaskInput,
  ctx: Parameters<TaskHandler<MakeMidiTaskInput, MakeMidiTaskOutput>>[0],
): Promise<MakeMidiTaskOutput> {
  const { trackId } = input;
  setMaking(trackId, { status: 'running', taskId: useAudioMidi.getState().making[trackId]?.taskId });
  try {
    const song = currentSong();
    const track = song?.tracks.find((t) => t.id === trackId);
    if (!song || !track || track.kind !== 'audio') throw new Error('The audio track no longer exists');
    const locked = notesLockedReason(song, track);
    if (locked) throw new Error(locked);
    ctx.progress(0.03, 'Loading the recording…');
    const { assets, sampleRate } = await clipAudio(track);
    if (!Object.keys(assets).length) throw new Error('This track has no audio that can be loaded');
    // From the first clip on: no silent lead-in to analyse (or upload).
    const firstTick = firstClipTick(track);
    const audio = await jobs.call<AudioData>(
      'trackClips',
      { song, trackId, assets, sampleRate, startTick: firstTick },
      { signal: ctx.signal },
    );
    if (!(audio.channels[0]?.length > 0)) throw new Error('This track has no audio to transcribe');
    const sourceKey = audioMidiSourceKey(song, track);
    const source = sourceFor(input.mode, track);
    const transcribeInput: TranscribeTaskInput = {
      runId: randomId('am'),
      audio,
      source,
      // The song's tempo and key; timing is kept exactly (no grid).
      bpm: bpmAtTick(song, firstTick),
      key: keyAtTick(song, firstTick),
      quantizeBeats: 0,
      provider: input.provider ?? 'internal',
    };
    const result = (await analysisHandlers['analysis.transcribe']({
      ...ctx,
      input: transcribeInput,
      progress: (p: number, msg?: string) => ctx.progress(0.1 + 0.8 * p, msg),
    })) as TranscribeTaskOutput;
    const mode = input.mode === 'auto' ? modeOf(result, source) : input.mode;
    const notes = notesFromTranscription(song, result, mode, createTimeMap(song).tickToSeconds(firstTick));
    ctx.progress(0.95, 'Attaching the MIDI…');
    const st = useStudio.getState();
    const now = st.project?.song;
    const live = now?.tracks.find((t) => t.id === trackId);
    if (!now || !live || live.kind !== 'audio') throw new Error('The audio track no longer exists');
    const lockedNow = notesLockedReason(now, live);
    if (lockedNow) throw new Error(lockedNow);
    const link: AudioMidiLink = {
      play: live.audioMidi?.play ?? 'audio',
      mode,
      instrumentId: playbackInstrument(live, mode, result.suggestedInstrumentId),
      sourceKey,
      createdAt: new Date().toISOString(),
      method: result.method,
      confidence: Math.round(result.confidence * 1000) / 1000,
      ...(live.audioMidi?.tuning ? { tuning: live.audioMidi.tuning } : {}),
    };
    st.commit(
      {
        ...now,
        tracks: now.tracks.map((t) => (t.id === trackId ? { ...t, notes, audioMidi: link } : t)),
      },
      `Made MIDI from “${live.name}” (${notes.length} ${mode === 'drums' ? 'hits' : 'notes'})`,
      'import',
    );
    ctx.progress(1, 'Done');
    setMaking(trackId, { status: 'done' });
    return {
      notes: notes.length,
      mode,
      method: result.method,
      confidence: result.confidence,
      warnings: result.warnings ?? [],
    };
  } catch (err) {
    setMaking(trackId, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

const makeMidiHandler: TaskHandler<MakeMidiTaskInput, MakeMidiTaskOutput> = (ctx) =>
  runMakeMidi(ctx.input, ctx);

// ---------------------------------------------------------------------------------------------
// Editing the link
// ---------------------------------------------------------------------------------------------

function updateLink(
  trackId: string,
  message: string,
  fn: (link: AudioMidiLink, track: Track) => AudioMidiLink | undefined,
) {
  const st = useStudio.getState();
  const song = st.project?.song;
  const track = song?.tracks.find((t) => t.id === trackId);
  if (!song || !track || !hasAttachedMidi(track)) return;
  const next = fn(track.audioMidi, track);
  st.commit(
    {
      ...song,
      tracks: song.tracks.map((t) => {
        if (t.id !== trackId) return t;
        if (next) return { ...t, audioMidi: next };
        const { audioMidi: _removed, ...rest } = t;
        void _removed;
        return { ...rest, notes: [] };
      }),
    },
    message,
    'edit',
  );
}

/** Play the recording or the MIDI. */
export function setAudioMidiPlay(trackId: string, play: AudioMidiPlayback): void {
  updateLink(trackId, play === 'midi' ? 'Play MIDI instead of audio' : 'Play audio instead of MIDI', (l) =>
    l.play === play ? l : { ...l, play },
  );
}

/** The instrument that plays the MIDI. */
export function setAudioMidiInstrument(trackId: string, instrumentId: string): void {
  updateLink(trackId, 'Change the MIDI instrument', (l) => ({ ...l, instrumentId }));
}

/** Turn tuning on or off (keeps the settings). */
export function setTuningEnabled(trackId: string, enabled: boolean): void {
  updateLink(trackId, enabled ? 'Tune the audio to the MIDI' : 'Stop tuning the audio', (l) => ({
    ...l,
    tuning: { ...DEFAULT_TUNING, ...l.tuning, enabled },
  }));
}

/** Change tuning amount / flatten / speed. */
export function setTuningSettings(trackId: string, settings: Partial<AudioTuningSettings>): void {
  updateLink(trackId, 'Change tuning', (l) => {
    const cur = { ...DEFAULT_TUNING, ...l.tuning };
    return {
      ...l,
      tuning: { ...cur, ...normalizeTuning({ ...cur, ...settings }), enabled: cur.enabled ?? true },
    };
  });
}

/** Remove the attached MIDI (the recording is untouched). */
export function removeAttachedMidi(trackId: string): void {
  const st = useStudio.getState();
  const song = st.project?.song;
  const track = song?.tracks.find((t) => t.id === trackId);
  const locked = song && track ? notesLockedReason(song, track) : null;
  if (locked) {
    st.toast('warning', locked);
    return;
  }
  updateLink(trackId, 'Remove MIDI from audio', () => undefined);
}

/** Copy the attached MIDI to a new MIDI track right after the audio track. */
export function copyAttachedMidiToTrack(trackId: string): string | undefined {
  const st = useStudio.getState();
  const song = st.project?.song;
  const track = song?.tracks.find((t) => t.id === trackId);
  if (!song || !track || !hasAttachedMidi(track)) return undefined;
  const id = randomId('trk');
  const all = [...BUILTIN_INSTRUMENTS, ...allCustomInstruments()];
  const inst = all.find((i) => i.id === track.audioMidi.instrumentId);
  const copy: Track = {
    id,
    name: `${track.name} (MIDI)`,
    kind: 'midi',
    role: inst?.defaultRole ?? (track.audioMidi.mode === 'drums' ? 'drums' : 'custom'),
    instrumentId: track.audioMidi.instrumentId,
    constraints: {},
    notes: track.notes.map((n, i) => ({ ...n, id: `${id}_${i}` })),
    clips: [],
    color: track.color,
    stemGroup: inst?.stemGroup ?? track.stemGroup,
    ...(track.audioMidi.mode === 'drums' ? { midiChannel: 9 } : {}),
    generator: { id: 'audio-midi-copy', params: { sourceTrackId: track.id } },
  };
  const at = song.tracks.findIndex((t) => t.id === trackId);
  const tracks = [...song.tracks];
  tracks.splice(at + 1, 0, copy);
  st.commit({ ...song, tracks }, `Copied the MIDI of “${track.name}” to a new track`, 'edit');
  return id;
}

// ---------------------------------------------------------------------------------------------
// Tuning renders
// ---------------------------------------------------------------------------------------------

/** Queue a tuning render (one at a time per track). */
export function renderTuning(trackId: string): string | undefined {
  const track = currentSong()?.tracks.find((t) => t.id === trackId);
  if (!track || !tuningActive(track)) return undefined;
  const cur = useAudioMidi.getState().tuning[trackId];
  if (busy(cur)) return cur!.taskId;
  taskQueue.register('audio.retune', retuneHandler);
  const rec = enqueueTask<RetuneTaskInput>({
    type: 'audio.retune',
    title: `Tune “${track.name}” to its MIDI`,
    input: { trackId },
  });
  setTuning(trackId, { status: 'queued', taskId: rec.id, report: cur?.report });
  return rec.id;
}

/** Tuned renders no revision and not the current song refer to. */
function unusedTunedAssets(): string[] {
  const project = useStudio.getState().project;
  if (!project) return [];
  const used = new Set<string>();
  const add = (s: Song) => {
    for (const t of s.tracks) if (t.audioMidi?.tuning?.render) used.add(t.audioMidi.tuning.render.assetId);
  };
  add(project.song);
  for (const r of project.history.revisions) add(r.snapshot);
  return project.meta.assets.filter((a) => a.kind === 'tuned-render' && !used.has(a.id)).map((a) => a.id);
}

export async function runRetune(
  input: RetuneTaskInput,
  ctx: Parameters<TaskHandler<RetuneTaskInput, RetuneTaskOutput>>[0],
): Promise<RetuneTaskOutput> {
  const { trackId } = input;
  const prev = useAudioMidi.getState().tuning[trackId];
  setTuning(trackId, { status: 'running', taskId: prev?.taskId, report: prev?.report });
  try {
    const song = currentSong();
    const track = song?.tracks.find((t) => t.id === trackId);
    if (!song || !track || !tuningActive(track)) throw new Error('Tuning is no longer on for this track');
    const key = tuningRenderKey(song, track);
    const settings = normalizeTuning({ ...DEFAULT_TUNING, ...track.audioMidi!.tuning });
    const notes = tuneTargets(song, track);
    ctx.progress(0.05, 'Loading the recording…');
    const { assets, sampleRate } = await clipAudio(track);
    if (!Object.keys(assets).length) throw new Error('This track has no audio that can be loaded');
    ctx.log(
      'info',
      `${notes.length} notes · correction ${Math.round(settings.amount * 100)}% · flatten ${Math.round(settings.flatten * 100)}% · speed ${Math.round(settings.speedMs)} ms`,
    );
    const startTick = firstClipTick(track);
    const res = await jobs.call<{ audio: AudioData; wav: Uint8Array; report: RetuneReport }>(
      'retune',
      { song, trackId, assets, sampleRate, startTick, notes, settings },
      { signal: ctx.signal, onProgress: (p: number) => ctx.progress(0.1 + 0.75 * p, 'Tuning…') },
    );
    ctx.progress(0.9, 'Storing the tuned audio…');
    const seconds = (res.audio.channels[0]?.length ?? 0) / res.audio.sampleRate;
    const meta: AudioAssetMeta = {
      id: randomId('tuned'),
      name: `${track.name} – tuned.wav`,
      kind: 'tuned-render',
      path: '',
      mimeType: 'audio/wav',
      sampleRate: res.audio.sampleRate,
      channels: res.audio.channels.length,
      durationSeconds: seconds,
      bytes: res.wav.length,
      createdAt: new Date().toISOString(),
    };
    const st = useStudio.getState();
    await assetStore.add(meta, res.wav, res.audio);
    // Hand the audio to the player before the song points at it, so playback switches at once.
    player.provideAsset(meta.id, res.audio);
    // Done before the song changes: edits made during the render then schedule the next one.
    setTuning(trackId, { status: 'done', report: res.report });
    st.updateProject((p) => {
      const t = p.song.tracks.find((x) => x.id === trackId);
      if (!t?.audioMidi?.tuning) return coreAddAsset(p, meta);
      const tuning = {
        ...t.audioMidi.tuning,
        render: {
          assetId: meta.id,
          startTick,
          key,
          sampleRate: res.audio.sampleRate,
          durationSeconds: seconds,
          renderedAt: meta.createdAt,
          tunedNotes: res.report.tunedNotes,
          skippedNotes: res.report.skippedNotes,
        },
      };
      const songNext = {
        ...p.song,
        tracks: p.song.tracks.map((x) =>
          x.id === trackId ? { ...x, audioMidi: { ...x.audioMidi!, tuning } } : x,
        ),
      };
      return coreAddAsset({ ...p, song: songNext }, meta);
    });
    const unused = unusedTunedAssets();
    for (const id of unused) await assetStore.remove(id);
    if (unused.length)
      st.updateProject((p) => ({
        ...p,
        meta: { ...p.meta, assets: p.meta.assets.filter((a) => !unused.includes(a.id)) },
      }));
    ctx.log(
      'info',
      `${res.report.tunedNotes} notes tuned${res.report.skippedNotes ? `, ${res.report.skippedNotes} without clear pitch left alone` : ''} · mean correction ${res.report.meanCorrectionCents} cents`,
    );
    ctx.progress(1, 'Done');
    return { assetId: meta.id, report: res.report };
  } catch (err) {
    setTuning(trackId, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      report: prev?.report,
    });
    throw err;
  }
}

const retuneHandler: TaskHandler<RetuneTaskInput, RetuneTaskOutput> = (ctx) => runRetune(ctx.input, ctx);

/** Task handlers for the generation queue (engine/taskHandlers.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, TaskHandler<any, any>> = {
  'audio.make-midi': makeMidiHandler,
  'audio.retune': retuneHandler,
};

// ---------------------------------------------------------------------------------------------
// Automatic re-render
// ---------------------------------------------------------------------------------------------

let autoStarted = false;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Re-render stale tuned recordings a moment after the last edit. */
export function initTuningAutoRender(): void {
  if (autoStarted) return;
  autoStarted = true;
  let last: Song | null = null;
  useStudio.subscribe((s) => {
    const song = s.project?.song ?? null;
    if (!song || song === last) return;
    last = song;
    for (const t of song.tracks) {
      if (!tuningRenderIsStale(song, t)) continue;
      const job = useAudioMidi.getState().tuning[t.id];
      if (job?.status === 'failed' || busy(job)) continue; // retry from the track's MIDI panel
      clearTimeout(timers.get(t.id));
      timers.set(
        t.id,
        setTimeout(() => {
          timers.delete(t.id);
          const cur = currentSong();
          const ct = cur?.tracks.find((x) => x.id === t.id);
          if (cur && ct && tuningRenderIsStale(cur, ct)) renderTuning(t.id);
        }, 1500),
      );
    }
  });
}
