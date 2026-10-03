import {
  ENGINE_VERSION,
  assetPathFor,
  createTimeMap,
  defaultChannelStrip,
  channelFor,
  randomId,
  randomSeed,
  sectionLayout,
  tickToMusical,
  type AudioAssetMeta,
  type AudioClip,
  type Project,
  type ProvenanceSource,
  type Song,
  type Track,
  type VocalMode,
  type VocalRender,
} from '@songdeck/core';
import { sliceAudio, spliceWithCrossfade, type AudioData } from '@songdeck/audio';
import { assertVoiceConsent, buildSingingRequest, toProvenanceRecord, type RunProvenance, type SingingRequest } from '@songdeck/ai';
import { aiAudio, getRegistry } from './ai';
import { jobs } from './jobs';
import { player } from './player';
import { assetStore, decodeAudioBytes } from '../state/assets';
import { useStudio } from '../state/store';
import {
  BUILTIN_SINGER_ID,
  VOCAL_RENDER_GENERATOR,
  VOICE_KIND_LABEL,
  CONSENT_BASIS_LABEL,
  activeRender,
  applyVocalMonitoring,
  artifactVersions,
  effectiveExpression,
  expandToRests,
  fileStem,
  formatBars,
  lastNoteEnd,
  renderSignature,
  renderTrackFor,
  resolveVoice,
  spliceSignature,
  timingKey,
  vocalMidiName,
  withRights,
  type VoiceChoice,
} from './vocal-model';

/**
 * Vocal render pipeline (spec §34 dedicated singing synthesis, §36 voice consent, §37 independent
 * vocal regeneration, §64 provenance). Runs inside generation-queue tasks (handlers/vocals.ts):
 *
 *   full render     vocal MIDI + lyrics/phonemes + expression + voice → lead_vocal-vN.wav
 *                   → VocalRender + "Lead Vocal (render)" audio track (sourceTrackId → vocal MIDI)
 *   range re-sing   only the notes of a phrase/section are sung again (provider regeneratePhrase,
 *                   else a range synthesis) and spliced into the current render with short
 *                   crossfades placed in the surrounding rests — the instrumentation is never touched
 *   conversion      neutral built-in performance → VOICE_CONVERSION to an authorized target voice
 *
 * Every step reads the project's *current* song when it runs, so queued jobs compose correctly.
 */

export interface VocalJobContext {
  signal: AbortSignal;
  progress(p: number, message?: string): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  addCost?(usd: number): void;
}

export interface RenderInput {
  projectId: string;
  trackId: string;
  /** Voice key (stock voice id or VoiceModelRecord id); default: song.vocals.voiceId → track voice type. */
  voiceKey?: string;
  seed?: number;
  sampleRate?: number;
}

export interface RenderOutput {
  assetId: string;
  fileName: string;
  version: number;
  providerName: string;
  voiceName: string;
  durationSeconds: number;
  summary: string;
}

export interface ResingInput {
  projectId: string;
  trackId: string;
  startTick: number;
  endTick: number;
  /** Disjoint ranges to re-sing (default: [startTick, endTick)); all are spliced in one pass. */
  ranges?: { startTick: number; endTick: number }[];
  /** e.g. "Chorus 2" or "Verse 1 · phrase 2". */
  label?: string;
  reason?: string;
  seed?: number;
}

export interface ResingOutput {
  assetId: string;
  phraseAssetIds: string[];
  fileName: string;
  phraseFileNames: string[];
  startTick: number;
  endTick: number;
  startSeconds: number;
  endSeconds: number;
  method: 'regenerate-phrase' | 'range-synthesis' | 'full-render';
  providerName: string;
  summary: string;
}

export interface ConvertInput {
  projectId: string;
  trackId: string;
  /** Target voice: VoiceModelRecord id. */
  targetKey: string;
  /** 'auto' or a VOICE_CONVERSION provider id. */
  providerChoice?: string;
  pitchShift?: number;
  seed?: number;
}

export interface ConvertOutput {
  assetId: string;
  neutralAssetId: string;
  fileName: string;
  providerName: string;
  voiceName: string;
  summary: string;
}

// ---------------------------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------------------------

export function abortError(message = 'Cancelled'): Error {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Progress estimate for jobs that report none (synthesis in the worker). */
async function estimated<T>(p: Promise<T>, seconds: number, ctx: VocalJobContext, from: number, to: number, msg: string): Promise<T> {
  const t0 = performance.now();
  const tau = Math.max(0.5, seconds) * 0.6;
  ctx.progress(from, msg);
  const timer = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    ctx.progress(from + (to - from) * 0.95 * (1 - Math.exp(-t / tau)), msg);
  }, 300);
  try {
    return await p;
  } finally {
    clearInterval(timer);
  }
}

/** Serialize read-modify-write jobs per vocal track (a re-sing must splice into the latest render). */
const chains = new Map<string, Promise<unknown>>();
export function withVocalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  chains.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

export function audioSeconds(a: AudioData): number {
  return (a.channels[0]?.length ?? 0) / a.sampleRate;
}

function openSong(projectId: string, trackId: string): { project: Project; song: Song; track: Track } {
  const project = useStudio.getState().project;
  if (!project || project.meta.id !== projectId) throw new Error('The project for this vocal task is not open. Open it and retry the task.');
  const track = project.song.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error('The vocal track no longer exists.');
  if (!track.notes.length) throw new Error(`“${track.name}” has no notes to sing — generate or write a vocal melody first.`);
  return { project, song: project.song, track };
}

function latestProject(projectId: string): Project {
  const p = useStudio.getState().project;
  if (!p || p.meta.id !== projectId) throw new Error('The project was closed while the vocal was rendering.');
  return p;
}

/** Built-in voices sing on the on-device engine; every other voice on the provider that hosts it. */
export function singerFor(voice: VoiceChoice): string {
  if (voice.source === 'built-in' || voice.providerId === BUILTIN_SINGER_ID) return 'internal';
  if (!voice.providerId || voice.providerId === 'external' || !getRegistry().has(voice.providerId)) {
    throw new Error(`The voice “${voice.name}” is not connected to a singing provider. Connect its provider in Settings → AI providers, or choose a built-in voice.`);
  }
  return voice.providerId;
}

/** Spec §36: no cloning / conversion with a non-stock voice without a valid attestation. */
export function assertVoiceAuthorized(voice: VoiceChoice): void {
  if (voice.kind === 'stock') return;
  assertVoiceConsent({ id: voice.ref, kind: voice.kind, name: voice.name, consent: voice.consent }, voice.consent);
}

function nextVersion(project: Project, stem: string): number {
  const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-v(\\d+)\\.`);
  let max = 0;
  for (const a of project.meta.assets) {
    const m = re.exec(a.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function uniquePath(project: Project, kind: AudioAssetMeta['kind'], fileName: string, id: string): string {
  const path = assetPathFor(kind, fileName);
  if (!project.meta.assets.some((a) => a.path === path)) return path;
  return assetPathFor(kind, fileName.replace(/(\.[a-z0-9]+)$/i, `-${id.slice(-6)}$1`));
}

function extFor(mime: string): string {
  if (/wav/.test(mime)) return 'wav';
  if (/flac/.test(mime)) return 'flac';
  if (/mpeg|mp3/.test(mime)) return 'mp3';
  if (/ogg/.test(mime)) return 'ogg';
  if (/webm/.test(mime)) return 'webm';
  return 'wav';
}

interface SaveAudio {
  name: string;
  kind: 'vocal' | 'recording';
  bytes: Uint8Array;
  mimeType: string;
  audio: AudioData;
  run: RunProvenance;
  sources: ProvenanceSource[];
  seed?: number;
  modelId?: string;
  parameters: Record<string, unknown>;
}

/** Store an audio asset with its provenance record (spec §64) and make it playable. */
async function saveAudio(projectId: string, o: SaveAudio): Promise<AudioAssetMeta> {
  const project = latestProject(projectId);
  const id = randomId('asset');
  const provenanceId = randomId('prov');
  const meta: AudioAssetMeta = {
    id,
    name: o.name,
    kind: o.kind,
    path: uniquePath(project, o.kind, o.name, id),
    mimeType: o.mimeType,
    sampleRate: o.audio.sampleRate,
    channels: o.audio.channels.length,
    durationSeconds: Math.round(audioSeconds(o.audio) * 1000) / 1000,
    bytes: o.bytes.byteLength,
    createdAt: new Date().toISOString(),
    provenanceId,
  };
  const st = useStudio.getState();
  await assetStore.add(meta, o.bytes, o.audio);
  st.updateProject((p) => ({ ...p, meta: { ...p.meta, assets: [...p.meta.assets.filter((a) => a.id !== meta.id), meta] } }));
  const rec = toProvenanceRecord(o.run, {
    id: provenanceId,
    artifactId: id,
    artifactName: o.name,
    artifactKind: 'audio',
    sources: o.sources,
    seed: o.seed,
    parameters: o.parameters,
    engineVersion: ENGINE_VERSION,
  });
  if (o.modelId) rec.modelId = o.modelId;
  st.addProvenance(rec);
  player.provideAsset(id, o.audio);
  return meta;
}

function voiceParams(voice: VoiceChoice): Record<string, unknown> {
  const out: Record<string, unknown> = { voiceKey: voice.key, voiceRef: voice.ref, voiceName: voice.name, voiceKind: voice.kind, voiceType: voice.voiceType, voiceSource: voice.source };
  if (voice.consent) out.consent = { attestedBy: voice.consent.attestedBy, rightsHolder: voice.consent.rightsHolder, basis: voice.consent.basis, attestedAt: voice.consent.attestedAt, scope: voice.consent.scope };
  return out;
}

function voiceRightsLabel(voice: VoiceChoice): string {
  const kind = voice.source === 'built-in' ? 'built-in formant singer, stock synthetic' : VOICE_KIND_LABEL[voice.kind].toLowerCase();
  const consent = voice.consent ? `, consent: ${CONSENT_BASIS_LABEL[voice.consent.basis] ?? voice.consent.basis} (${voice.consent.rightsHolder})` : '';
  return `${voice.name} (${kind}${consent})`;
}

function sourcesFor(project: Project, song: Song, track: Track, voice: VoiceChoice, extra: ProvenanceSource[] = []): { sources: ProvenanceSource[]; display: string; versions: ReturnType<typeof artifactVersions> } {
  const versions = artifactVersions(project, track.id);
  const midiName = vocalMidiName(song, track.id);
  const sources: ProvenanceSource[] = [{ kind: 'midi', ref: midiName, revision: versions.midi }];
  if (versions.lyrics) sources.push({ kind: 'lyrics', ref: 'lyrics.txt', revision: versions.lyrics });
  sources.push({ kind: 'voice', ref: voice.key });
  if (versions.revision !== undefined) sources.push({ kind: 'song', ref: song.id, revision: versions.revision });
  sources.push(...extra);
  const display = `${midiName} v${versions.midi}${versions.lyrics ? ` · lyrics.txt v${versions.lyrics}` : ''}`;
  return { sources, display, versions };
}

// ---------------------------------------------------------------------------------------------
// Singing
// ---------------------------------------------------------------------------------------------

interface Sung {
  audio: AudioData;
  bytes: Uint8Array;
  mimeType: string;
  run: RunProvenance;
  model?: string;
  costUsd?: number;
}

function requestFor(song: Song, track: Track, voice: VoiceChoice, o: { seed: number; sampleRate: number; startTick?: number; endTick?: number; shiftSeconds?: number }): SingingRequest {
  const req = buildSingingRequest(song, track.id, { voiceId: voice.ref, seed: o.seed, sampleRate: o.sampleRate, startTick: o.startTick, endTick: o.endTick, language: song.vocals.language });
  if (o.shiftSeconds) {
    const sh = o.shiftSeconds;
    req.notes = req.notes.map((n) => ({ ...n, startSeconds: Math.round((n.startSeconds - sh) * 10000) / 10000 }));
  }
  return req;
}

async function decodeResult(audio: { data: Uint8Array; mimeType: string }): Promise<{ audio: AudioData; bytes: Uint8Array; mimeType: string }> {
  const decoded = await decodeAudioBytes(audio.data);
  return { audio: decoded, bytes: audio.data, mimeType: audio.mimeType || 'audio/wav' };
}

async function singFull(song: Song, track: Track, voice: VoiceChoice, seed: number, sampleRate: number, ctx: VocalJobContext, from: number, to: number): Promise<Sung> {
  const choice = singerFor(voice);
  const req = requestFor(song, track, voice, { seed, sampleRate });
  const dur = req.notes.reduce((m, n) => Math.max(m, n.startSeconds + n.durationSeconds), 0);
  ctx.log('info', `Singing ${req.notes.length} notes (${dur.toFixed(1)} s) — voice “${voice.name}”, seed ${seed}, ${req.tempoBpm} BPM`);
  const r = await estimated(abortable(aiAudio.synthesizeSinging(req, { providerChoice: choice, signal: ctx.signal }), ctx.signal), 0.6 + dur * 0.035, ctx, from, to, 'Singing…');
  if (r.provenance.costUsd) ctx.addCost?.(r.provenance.costUsd);
  const d = await decodeResult(r.result.audio);
  return { ...d, run: r.provenance, model: r.result.model, costUsd: r.provenance.costUsd };
}

/**
 * Sing only [A, B] (seconds). Providers with phrase regeneration get the absolute timeline and
 * return exactly [A, B]; otherwise the range's notes are sung on their own (shifted to A).
 */
async function singRange(song: Song, track: Track, voice: VoiceChoice, o: { startTick: number; endTick: number; a: number; b: number; seed: number; sampleRate: number }, ctx: VocalJobContext): Promise<Sung & { method: ResingOutput['method'] }> {
  const choice = singerFor(voice);
  const providerId = choice === 'internal' ? BUILTIN_SINGER_ID : choice;
  const inst = getRegistry().get(providerId);
  const span = o.b - o.a;
  if (inst?.singing?.regeneratePhrase) {
    const base = requestFor(song, track, voice, { seed: o.seed, sampleRate: o.sampleRate, startTick: o.startTick, endTick: o.endTick });
    ctx.log('info', `Regenerating the phrase with ${inst.descriptor.name} (${base.notes.length} notes, ${o.a.toFixed(2)}–${o.b.toFixed(2)} s)`);
    const r = await estimated(
      abortable(aiAudio.regeneratePhrase({ ...base, startSeconds: o.a, endSeconds: o.b }, { providerChoice: providerId, signal: ctx.signal }), ctx.signal),
      0.6 + span * 0.05,
      ctx,
      0.15,
      0.7,
      'Re-singing…',
    );
    if (r.provenance.costUsd) ctx.addCost?.(r.provenance.costUsd);
    const d = await decodeResult(r.result.audio);
    const audio = audioSeconds(d.audio) > span + 0.05 ? sliceAudio(d.audio, 0, span) : d.audio;
    return { ...d, audio, run: r.provenance, model: r.result.model, method: 'regenerate-phrase' };
  }
  const req = requestFor(song, track, voice, { seed: o.seed, sampleRate: o.sampleRate, startTick: o.startTick, endTick: o.endTick, shiftSeconds: o.a });
  ctx.log('info', `Singing the range on its own with ${inst?.descriptor.name ?? providerId} (${req.notes.length} notes, ${span.toFixed(2)} s) — this provider has no phrase regeneration`);
  const r = await estimated(abortable(aiAudio.synthesizeSinging(req, { providerChoice: choice, signal: ctx.signal }), ctx.signal), 0.4 + span * 0.05, ctx, 0.15, 0.7, 'Re-singing…');
  if (r.provenance.costUsd) ctx.addCost?.(r.provenance.costUsd);
  const d = await decodeResult(r.result.audio);
  return { ...d, audio: sliceAudio(d.audio, 0, span), run: r.provenance, model: r.result.model, method: 'range-synthesis' };
}

async function encodeWav(audio: AudioData, signal: AbortSignal): Promise<Uint8Array> {
  return abortable(jobs.call<Uint8Array>('encodeWav', { audio, bitDepth: 16 }, { signal }), signal);
}

// ---------------------------------------------------------------------------------------------
// Song updates
// ---------------------------------------------------------------------------------------------

/** Point the vocal's render track at an asset (creating "<Track> (render)" next to the vocal MIDI track). */
export function withRenderClip(song: Song, o: { midiTrackId: string; assetId: string; durationSeconds: number; clipName: string }): Song {
  const midi = song.tracks.find((t) => t.id === o.midiTrackId);
  if (!midi) return song;
  const existing = renderTrackFor(song, midi.id);
  const clip: AudioClip = {
    id: randomId('clip'),
    assetId: o.assetId,
    tick: 0,
    offsetSeconds: 0,
    durationSeconds: Math.round(o.durationSeconds * 1000) / 1000,
    gainDb: 0,
    fadeInSeconds: 0,
    fadeOutSeconds: 0.05,
    name: o.clipName,
  };
  if (existing) {
    return { ...song, tracks: song.tracks.map((t) => (t.id === existing.id ? { ...t, clips: [clip] } : t)) };
  }
  const track: Track = {
    id: randomId('trk'),
    name: `${midi.name} (render)`,
    kind: 'audio',
    role: 'vocal',
    instrumentId: midi.instrumentId || 'lead-vocal',
    constraints: {},
    notes: [],
    clips: [clip],
    color: midi.color,
    stemGroup: 'vocals',
    sourceTrackId: midi.id,
    vocal: { voiceType: midi.vocal?.voiceType },
    generator: { id: VOCAL_RENDER_GENERATOR },
  };
  const idx = song.tracks.findIndex((t) => t.id === midi.id);
  const tracks = [...song.tracks];
  tracks.splice(idx + 1, 0, track);
  // The render inherits the vocal's channel strip so the mix sounds the same.
  const strip = { ...(song.mixer.channels[midi.id] ? channelFor(song, midi.id) : defaultChannelStrip()), mute: false, solo: false };
  return { ...song, tracks, mixer: { ...song.mixer, channels: { ...song.mixer.channels, [track.id]: strip } } };
}

/** Mode after an explicit render: keep Placeholder / AI singer, otherwise pick by the voice's engine. */
function renderMode(song: Song, voice: VoiceChoice): VocalMode {
  const m = song.vocals.mode;
  if (m === 'placeholder' || m === 'ai-singer') return m;
  return voice.source === 'built-in' ? 'placeholder' : 'ai-singer';
}

function commitRender(projectId: string, midiTrackId: string, o: { assetId: string; durationSeconds: number; clipName: string; renders: VocalRender[]; mode?: VocalMode; message: string; voiceKey?: string }): string[] {
  const project = latestProject(projectId);
  let song = withRenderClip(project.song, { midiTrackId, assetId: o.assetId, durationSeconds: o.durationSeconds, clipName: o.clipName });
  song = { ...song, vocals: { ...song.vocals, mode: o.mode ?? song.vocals.mode, renders: [...song.vocals.renders, ...o.renders], ...(o.voiceKey && !song.vocals.voiceId ? { voiceId: o.voiceKey } : {}) } };
  const mon = applyVocalMonitoring(song, midiTrackId);
  useStudio.getState().commit(mon.song, o.message, 'vocals');
  return mon.skipped;
}

// ---------------------------------------------------------------------------------------------
// Full render (spec §34)
// ---------------------------------------------------------------------------------------------

export function renderVocal(input: RenderInput, ctx: VocalJobContext): Promise<RenderOutput> {
  return withVocalLock(`${input.projectId}:${input.trackId}`, () => renderVocalBody(input, ctx));
}

/** Full render body (the caller holds the track's vocal lock). */
async function renderVocalBody(input: RenderInput, ctx: VocalJobContext): Promise<RenderOutput> {
  throwIfAborted(ctx.signal);
  const { project, song, track } = openSong(input.projectId, input.trackId);
  const voice = resolveVoice(project, input.voiceKey ?? song.vocals.voiceId, track);
  assertVoiceAuthorized(voice);
  const seed = input.seed ?? randomSeed();
  const sampleRate = input.sampleRate ?? 44100;
  const signature = renderSignature(song, track);
  const sung = await singFull(song, track, voice, seed, sampleRate, ctx, 0.05, 0.8);
  throwIfAborted(ctx.signal);
  const fresh = latestProject(input.projectId);
  const stem = fileStem(track.name);
  const version = nextVersion(fresh, stem);
  const fileName = `${stem}-v${version}.${extFor(sung.mimeType)}`;
  const { sources, display, versions } = sourcesFor(project, song, track, voice);
  ctx.progress(0.86, 'Saving the render');
  const durationSeconds = audioSeconds(sung.audio);
  const meta = await saveAudio(input.projectId, {
    name: fileName,
    kind: 'vocal',
    bytes: sung.bytes,
    mimeType: sung.mimeType,
    audio: sung.audio,
    run: sung.run,
    sources,
    seed,
    modelId: sung.model ?? voice.ref,
    parameters: {
      renderKind: 'full',
      version,
      trackId: track.id,
      trackName: track.name,
      ...voiceParams(voice),
      sampleRate: sung.audio.sampleRate,
      tempoBpm: Math.round(createTimeMap(song).bpmAt(0) * 100) / 100,
      notes: track.notes.length,
      defaultExpression: song.vocals.defaultExpression,
      language: song.vocals.language,
      source: display,
      signature,
      timing: timingKey(song),
    },
  });
  const render: VocalRender = {
    id: randomId('vr'),
    trackId: track.id,
    assetId: meta.id,
    startTick: 0,
    endTick: lastNoteEnd(track),
    providerId: sung.run.providerId,
    voiceId: voice.key,
    seed,
    createdAt: meta.createdAt,
  };
  const skipped = commitRender(input.projectId, track.id, {
    assetId: meta.id,
    durationSeconds,
    clipName: fileName,
    renders: [render],
    mode: renderMode(song, voice),
    message: `Rendered ${track.name} → ${fileName} (${sung.run.providerName}, ${voice.name}, seed ${seed})`,
    voiceKey: voice.key,
  });
  useStudio.getState().updateProject((p) => withRights(p, { voiceModels: [voiceRightsLabel(voice)], modelProviders: [sung.run.location === 'internal' ? undefined : sung.run.providerName] }));
  if (skipped.length) ctx.log('warn', `Mixer locked — mute state left unchanged for ${skipped.join(', ')}`);
  ctx.log('info', `${fileName}: ${durationSeconds.toFixed(1)} s from ${display} (project v${versions.revision ?? '?'})`);
  ctx.progress(1, 'Done');
  return {
    assetId: meta.id,
    fileName,
    version,
    providerName: sung.run.providerName,
    voiceName: voice.name,
    durationSeconds,
    summary: `${fileName} · ${voice.name} · ${sung.run.providerName}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Range re-sing + splice (spec §37)
// ---------------------------------------------------------------------------------------------

export function isConversionRender(parameters: Record<string, unknown> | undefined): boolean {
  return parameters?.renderKind === 'conversion';
}

/**
 * Splice region in seconds: the whole changed range (so the audio of removed notes is replaced
 * too), padded into the middle of the surrounding rests — never into the previous or next note.
 */
export function spliceWindow(song: Song, track: Track, startTick: number, endTick: number): { a: number; b: number } {
  const tm = createTimeMap(song);
  const sec = (t: number) => tm.tickToSeconds(t);
  const notes = [...track.notes].sort((x, y) => x.tick - y.tick);
  const inR = notes.filter((n) => n.tick >= startTick && n.tick < endTick);
  const before = notes.filter((n) => n.tick < startTick);
  const after = notes.filter((n) => n.tick >= endTick);
  const prevEnd = before.length ? Math.max(...before.map((n) => sec(n.tick + n.duration))) : 0;
  const nextStart = after.length ? sec(after[0].tick) : Infinity;
  const first = inR.length ? sec(inR[0].tick) : sec(startTick);
  const last = inR.length ? Math.max(...inR.map((n) => sec(n.tick + n.duration))) : sec(startTick);
  const lo = Math.min(first, sec(startTick));
  const hi = Math.max(last, sec(endTick));
  const gapBefore = Math.max(0, lo - prevEnd);
  const gapAfter = Number.isFinite(nextStart) ? Math.max(0, nextStart - hi) : Infinity;
  const a = Math.max(0, Math.min(first, Math.max(prevEnd, lo - Math.min(0.25, gapBefore / 2))));
  const b = hi + Math.min(0.5, gapAfter / 2);
  return { a, b: Math.max(b, a + 0.05) };
}

export async function resingRange(input: ResingInput, ctx: VocalJobContext): Promise<ResingOutput> {
  return withVocalLock(`${input.projectId}:${input.trackId}`, async () => {
    throwIfAborted(ctx.signal);
    const { project, song, track } = openSong(input.projectId, input.trackId);
    const current = activeRender(project, track.id);
    const baseMeta = current?.asset;
    if (!current || !baseMeta) {
      ctx.log('info', 'No vocal render yet — rendering the whole vocal instead');
      const r = await renderVocalBody({ projectId: input.projectId, trackId: input.trackId, seed: input.seed }, ctx);
      return { ...r, phraseAssetIds: [], phraseFileNames: [], startTick: 0, endTick: lastNoteEnd(track), startSeconds: 0, endSeconds: r.durationSeconds, method: 'full-render' };
    }
    if (isConversionRender(current.provenance?.parameters)) {
      throw new Error('The current vocal render is a voice conversion — a phrase cannot be re-sung into it with the singer. Run “Render & convert” again to update it.');
    }
    const ranges = mergeTickRanges((input.ranges?.length ? input.ranges : [{ startTick: input.startTick, endTick: input.endTick }]).map((r) => expandToRests(song, track, r.startTick, r.endTick)));
    const overall = { startTick: ranges[0].startTick, endTick: ranges[ranges.length - 1].endTick };
    const label = input.label ?? sectionLabel(song, overall.startTick, overall.endTick);
    const voiceKey = current.render?.voiceId ?? current.rendered?.voiceKey ?? song.vocals.voiceId;
    const voice = resolveVoice(project, voiceKey, track);
    assertVoiceAuthorized(voice);
    const seed = input.seed ?? current.render?.seed ?? randomSeed();
    ctx.log('info', `Re-singing ${label} (${ranges.map((r) => formatBars(song, r.startTick, r.endTick)).join(', ')}) into ${baseMeta.name}; the instrumentation is not regenerated`);
    ctx.progress(0.05, 'Loading the current render');
    const base = await assetStore.audio(baseMeta);
    if (!base) throw new Error(`The current render (${baseMeta.name}) could not be loaded.`);
    throwIfAborted(ctx.signal);
    const signatureNow = renderSignature(song, track);
    let signature = current.rendered?.signature ?? signatureNow;
    let merged = base;
    const pieces: { range: { startTick: number; endTick: number }; a: number; b: number; xf: number; sung: Sung & { method: ResingOutput['method'] }; label: string }[] = [];
    for (const range of ranges) {
      const { a, b } = spliceWindow(song, track, range.startTick, range.endTick);
      const sung = await singRange(song, track, voice, { startTick: range.startTick, endTick: range.endTick, a, b, seed, sampleRate: base.sampleRate }, ctx);
      throwIfAborted(ctx.signal);
      const xf = Math.min(0.04, Math.max(0.005, (b - a) / 4));
      merged = spliceWithCrossfade(merged, sung.audio, a, xf);
      signature = spliceSignature(signature, signatureNow, range.startTick, range.endTick);
      pieces.push({ range, a, b, xf, sung, label: ranges.length === 1 ? label : sectionLabel(song, range.startTick, range.endTick) });
    }
    ctx.progress(0.72, 'Splicing');
    const mergedBytes = await encodeWav(merged, ctx.signal);
    throwIfAborted(ctx.signal);
    const { sources, display } = sourcesFor(project, song, track, voice);
    const run = pieces[pieces.length - 1].sung.run;
    const method = pieces[0].sung.method;
    ctx.progress(0.85, 'Saving');
    const phraseMetas: AudioAssetMeta[] = [];
    const now = new Date().toISOString();
    const renders: VocalRender[] = [];
    for (const piece of pieces) {
      const fresh = latestProject(input.projectId);
      const phraseStem = `${fileStem(piece.label.replace(/·.*$/, '').replace(/\(.*\)/, '').trim() || 'phrase', '-')}-vocal`;
      const phraseVersion = nextVersion(fresh, phraseStem);
      const phraseFileName = `${phraseStem}-v${phraseVersion}.wav`;
      const bars = formatBars(song, piece.range.startTick, piece.range.endTick);
      const meta = await saveAudio(input.projectId, {
        name: phraseFileName,
        kind: 'vocal',
        bytes: await encodeWav(piece.sung.audio, ctx.signal),
        mimeType: 'audio/wav',
        audio: piece.sung.audio,
        run: piece.sung.run,
        sources,
        seed,
        modelId: piece.sung.model ?? voice.ref,
        parameters: {
          renderKind: 'phrase',
          version: phraseVersion,
          label: piece.label,
          reason: input.reason,
          method: piece.sung.method,
          trackId: track.id,
          range: { startTick: piece.range.startTick, endTick: piece.range.endTick, startSeconds: piece.a, endSeconds: piece.b, bars },
          ...voiceParams(voice),
          source: display,
        },
      });
      phraseMetas.push(meta);
      const sectionIds = sectionLayout(song)
        .filter((sp) => sp.startTick < piece.range.endTick && sp.endTick > piece.range.startTick)
        .map((sp) => sp.section.id);
      const tol = song.ppq / 4;
      const phrase = song.phrases.find((ph) => ph.trackId === track.id && ph.startTick - tol <= piece.range.startTick && ph.endTick + tol >= piece.range.endTick);
      renders.push({
        id: randomId('vr'),
        trackId: track.id,
        assetId: meta.id,
        sectionId: sectionIds.length === 1 ? sectionIds[0] : undefined,
        phraseId: phrase?.id,
        startTick: piece.range.startTick,
        endTick: piece.range.endTick,
        providerId: piece.sung.run.providerId,
        voiceId: voice.key,
        seed,
        createdAt: now,
      });
    }
    const fresh = latestProject(input.projectId);
    const stem = fileStem(track.name);
    const version = nextVersion(fresh, stem);
    const fileName = `${stem}-v${version}.wav`;
    const meta = await saveAudio(input.projectId, {
      name: fileName,
      kind: 'vocal',
      bytes: mergedBytes,
      mimeType: 'audio/wav',
      audio: merged,
      run,
      sources: [...sources, { kind: 'audio', ref: baseMeta.id }, ...phraseMetas.map((m) => ({ kind: 'audio', ref: m.id }))],
      seed,
      modelId: pieces[0].sung.model ?? voice.ref,
      parameters: {
        renderKind: 'splice',
        version,
        label,
        reason: input.reason,
        method,
        trackId: track.id,
        trackName: track.name,
        baseAssetId: baseMeta.id,
        baseName: baseMeta.name,
        phraseAssetIds: phraseMetas.map((m) => m.id),
        crossfadeMs: Math.round(Math.min(...pieces.map((p) => p.xf)) * 1000),
        ranges: pieces.map((p) => ({ startTick: p.range.startTick, endTick: p.range.endTick, startSeconds: p.a, endSeconds: p.b, bars: formatBars(song, p.range.startTick, p.range.endTick) })),
        ...voiceParams(voice),
        sampleRate: merged.sampleRate,
        source: display,
        signature,
        timing: timingKey(song),
      },
    });
    renders.push({ id: randomId('vr'), trackId: track.id, assetId: meta.id, startTick: 0, endTick: Math.max(lastNoteEnd(track), current.render?.endTick ?? 0), providerId: run.providerId, voiceId: voice.key, seed, createdAt: now });
    const where = ranges.map((r) => formatBars(song, r.startTick, r.endTick)).join(', ');
    // An automatic re-sing keeps the vocal mode (e.g. Recorded vocal) as it is.
    commitRender(input.projectId, track.id, {
      assetId: meta.id,
      durationSeconds: audioSeconds(merged),
      clipName: fileName,
      renders,
      message: `Re-sang ${label} only (${where}) → ${fileName}${input.reason ? ` — “${input.reason}”` : ''}`,
    });
    ctx.log('info', `${phraseMetas.map((m) => m.name).join(', ')} spliced into ${fileName} with short crossfades (${method === 'regenerate-phrase' ? 'provider phrase regeneration' : 'range synthesis'})`);
    ctx.progress(1, 'Done');
    return {
      assetId: meta.id,
      phraseAssetIds: phraseMetas.map((m) => m.id),
      fileName,
      phraseFileNames: phraseMetas.map((m) => m.name),
      startTick: overall.startTick,
      endTick: overall.endTick,
      startSeconds: pieces[0].a,
      endSeconds: pieces[pieces.length - 1].b,
      method,
      providerName: run.providerName,
      summary: `${label} → ${fileName}`,
    };
  });
}

/** Sort and merge overlapping / touching tick ranges. */
export function mergeTickRanges(ranges: { startTick: number; endTick: number }[]): { startTick: number; endTick: number }[] {
  const sorted = ranges.filter((r) => r.endTick > r.startTick).sort((a, b) => a.startTick - b.startTick);
  const out: { startTick: number; endTick: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startTick <= last.endTick) last.endTick = Math.max(last.endTick, r.endTick);
    else out.push({ ...r });
  }
  return out.length ? out : [{ startTick: 0, endTick: 1 }];
}

function sectionLabel(song: Song, startTick: number, endTick: number): string {
  const secs = sectionLayout(song).filter((s) => s.startTick < endTick && s.endTick > startTick);
  if (secs.length === 1 && secs[0].startTick >= startTick - 1 && secs[0].endTick <= endTick + 1) return secs[0].section.name;
  if (secs.length === 1) return `${secs[0].section.name} (bar ${tickToMusical(song, startTick).bar})`;
  return secs.map((s) => s.section.name).join(' + ') || formatBars(song, startTick, endTick);
}

// ---------------------------------------------------------------------------------------------
// Voice conversion (spec §33 "User Voice Conversion", §36)
// ---------------------------------------------------------------------------------------------

export function hasConversionProvider(): boolean {
  try {
    return getRegistry().findCompatible(['VOICE_CONVERSION'], { interface: 'voiceConversion' }).length > 0;
  } catch {
    return false;
  }
}

export async function convertVocal(input: ConvertInput, ctx: VocalJobContext): Promise<ConvertOutput> {
  return withVocalLock(`${input.projectId}:${input.trackId}`, async () => {
    throwIfAborted(ctx.signal);
    const { project, song, track } = openSong(input.projectId, input.trackId);
    const target = resolveTarget(project, input.targetKey);
    // Consent first — nothing is rendered or sent without it (spec §36).
    assertVoiceAuthorized(target);
    if (!hasConversionProvider() && (!input.providerChoice || input.providerChoice === 'auto')) {
      throw new Error('No voice-conversion provider is configured. Add a VOICE_CONVERSION provider (for example the RVC bridge) in Settings → AI providers.');
    }
    const seed = input.seed ?? randomSeed();
    // 1. Neutral performance with the built-in singer (stock voice for the track's voice type).
    const neutralVoice = resolveVoice(project, undefined, track);
    const neutral = await singFull(song, track, neutralVoice, seed, 44100, ctx, 0.05, 0.45);
    throwIfAborted(ctx.signal);
    const neutralWav = /wav/.test(neutral.mimeType) ? neutral.bytes : await encodeWav(neutral.audio, ctx.signal);
    const fresh = latestProject(input.projectId);
    const stem = fileStem(track.name);
    const neutralName = `${stem}-neutral-v${nextVersion(fresh, `${stem}-neutral`)}.wav`;
    const { sources, display } = sourcesFor(project, song, track, target);
    const neutralMeta = await saveAudio(input.projectId, {
      name: neutralName,
      kind: 'vocal',
      bytes: neutralWav,
      mimeType: 'audio/wav',
      audio: neutral.audio,
      run: neutral.run,
      sources: sources.filter((s) => s.kind !== 'voice').concat({ kind: 'voice', ref: neutralVoice.key }),
      seed,
      modelId: neutralVoice.ref,
      parameters: { renderKind: 'neutral', purpose: 'voice-conversion source', ...voiceParams(neutralVoice), source: display },
    });
    // 2. Convert to the authorized target voice.
    ctx.progress(0.5, `Converting to ${target.name}…`);
    ctx.log('info', `Converting the neutral performance to “${target.name}” (${VOICE_KIND_LABEL[target.kind]}; ${target.consent ? `authorized: ${CONSENT_BASIS_LABEL[target.consent.basis]}` : 'stock'})`);
    const providerChoice = input.providerChoice && input.providerChoice !== 'auto' ? input.providerChoice : target.providerId && getRegistry().has(target.providerId) ? target.providerId : 'auto';
    const r = await estimated(
      abortable(
        aiAudio.convertVoice(
          {
            audio: { mimeType: 'audio/wav', data: neutralWav, sampleRate: neutral.audio.sampleRate, channels: neutral.audio.channels.length, durationSeconds: audioSeconds(neutral.audio) },
            targetVoice: { id: target.ref, kind: target.kind, name: target.name, consent: target.consent },
            consent: target.consent,
            pitchShift: input.pitchShift || undefined,
          },
          { providerChoice, signal: ctx.signal },
        ),
        ctx.signal,
      ),
      2 + audioSeconds(neutral.audio) * 0.1,
      ctx,
      0.5,
      0.85,
      'Converting…',
    );
    if (r.provenance.costUsd) ctx.addCost?.(r.provenance.costUsd);
    const converted = await decodeResult(r.result.audio);
    const fileName = `${stem}-${fileStem(target.name, '-')}-v${nextVersion(latestProject(input.projectId), `${stem}-${fileStem(target.name, '-')}`)}.${extFor(converted.mimeType)}`;
    const meta = await saveAudio(input.projectId, {
      name: fileName,
      kind: 'vocal',
      bytes: converted.bytes,
      mimeType: converted.mimeType,
      audio: converted.audio,
      run: r.provenance,
      sources: [...sources, { kind: 'audio', ref: neutralMeta.id }],
      seed,
      modelId: r.result.model ?? target.ref,
      parameters: {
        renderKind: 'conversion',
        trackId: track.id,
        trackName: track.name,
        neutralAssetId: neutralMeta.id,
        neutralVoice: neutralVoice.name,
        pitchShift: input.pitchShift ?? 0,
        ...voiceParams(target),
        source: display,
        signature: renderSignature(song, track),
        timing: timingKey(song),
      },
    });
    const now = new Date().toISOString();
    commitRender(input.projectId, track.id, {
      assetId: meta.id,
      durationSeconds: audioSeconds(converted.audio),
      clipName: fileName,
      renders: [{ id: randomId('vr'), trackId: track.id, assetId: meta.id, startTick: 0, endTick: lastNoteEnd(track), providerId: r.provenance.providerId, voiceId: target.key, seed, createdAt: now }],
      mode: 'voice-conversion',
      message: `Converted ${track.name} to “${target.name}” (${r.provenance.providerName}) → ${fileName}`,
    });
    useStudio.getState().updateProject((p) => withRights(p, { voiceModels: [voiceRightsLabel(target)], modelProviders: [r.provenance.location === 'internal' ? undefined : r.provenance.providerName] }));
    ctx.progress(1, 'Done');
    return { assetId: meta.id, neutralAssetId: neutralMeta.id, fileName, providerName: r.provenance.providerName, voiceName: target.name, summary: `${fileName} · ${target.name}` };
  });
}

export function resolveTarget(project: Project, key: string): VoiceChoice {
  const rec = project.meta.voices.find((r) => r.id === key);
  if (!rec) throw new Error('Choose a target voice for the conversion.');
  return resolveVoice(project, rec.id, undefined);
}

/** Expression the singer will receive for a note (re-exported for views). */
export { effectiveExpression };
