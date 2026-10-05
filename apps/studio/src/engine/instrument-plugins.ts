import { create } from 'zustand';
import {
  addAsset as coreAddAsset,
  pluginRenderIsCurrent,
  pluginRenderKey,
  randomId,
  trackMidiEvents,
  type TaskHandler,
  type AudioAssetMeta,
  type InstrumentPluginSlot,
  type Song,
  type Track,
} from '@songdeck/core';
import {
  createInternalProvider,
  type InstrumentHostProvider,
  type InstrumentHostStatus,
  type InstrumentPluginDescription,
  type InstrumentPluginInfo,
  type InstrumentPluginState,
  type ProviderInstance,
} from '@songdeck/ai';
import type { AudioData } from '@songdeck/audio';
import { useStudio } from '../state/store';
import { useSettings } from '../state/settings';
import { assetStore, decodeAudioBytes } from '../state/assets';
import { getOrchestrator, getRegistry, initAi } from './ai';
import { jobs } from './jobs';
import { enqueueTask } from './capture-tasks';
import { taskQueue } from './runtime';
import {
  base64ToBytes,
  bytesToBase64,
  createWamHost,
  openWamEditor,
  type WamEditorSession,
} from './wam-host';

/**
 * Instrument plugins on MIDI tracks, like instrument inserts in a DAW (spec §17 instruments,
 * §28 renders). A track's `instrumentPlugin` slot names a plugin on a host:
 *   - native hosts (the plugin host bridge: VST3, Audio Units, VST2, CLAP, LV2, SF2, SFZ) — any
 *     registered provider with the `instrumentHost` interface;
 *   - the in-browser Web Audio Module host (`WAM_HOST_ID`).
 * The host renders the track's MIDI offline ("freeze"); the WAV becomes a project asset that
 * playback and every export use while it matches the notes (`pluginRenderKey`). Edits make the
 * render stale — playback falls back to the built-in patch until the automatic re-render lands.
 */

export const WAM_HOST_ID = 'wam';
const RENDER_SAMPLE_RATE = 48000;

export interface HostView {
  id: string;
  name: string;
  location: string;
  status: 'loading' | 'ready' | 'offline' | 'error';
  error?: string;
  info?: InstrumentHostStatus;
  plugins: InstrumentPluginInfo[];
}

export interface TrackRenderState {
  status: 'queued' | 'running' | 'done' | 'failed';
  taskId?: string;
  error?: string;
}

interface InstrumentPluginsState {
  hosts: HostView[];
  refreshing: boolean;
  renders: Record<string, TrackRenderState>;
}

export const useInstrumentPlugins = create<InstrumentPluginsState>(() => ({
  hosts: [],
  refreshing: false,
  renders: {},
}));

function setRender(trackId: string, r: TrackRenderState | null) {
  useInstrumentPlugins.setState((s) => {
    const renders = { ...s.renders };
    if (r) renders[trackId] = r;
    else delete renders[trackId];
    return { renders };
  });
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

let wamRegistered = false;

async function encodeWav(audio: AudioData): Promise<Uint8Array> {
  return jobs.call<Uint8Array>('encodeWav', { audio, bitDepth: 24 });
}

/** Register the in-browser WAM host with the provider registry (once). */
export function ensureWamHost(): void {
  if (wamRegistered) return;
  initAi();
  const host = createWamHost(() => useSettings.getState().wamPlugins, encodeWav);
  const inst: ProviderInstance = createInternalProvider({
    id: WAM_HOST_ID,
    name: 'Web Audio Modules (browser)',
    capabilities: ['INSTRUMENT_PLUGIN_HOST'],
    qualityTier: 4,
    description: 'Web Audio Module (WAM 2) instruments rendered in the browser.',
  });
  inst.instrumentHost = host;
  getRegistry().register(inst);
  wamRegistered = true;
}

/** Every provider that hosts instrument plugins (native bridges, WAM, plugin-contributed hosts). */
export function instrumentHostInstances(): ProviderInstance[] {
  ensureWamHost();
  return getRegistry()
    .allEntries()
    .map((e) => e.instance)
    .filter((i) => !!i.instrumentHost);
}

export function getHost(hostId: string): InstrumentHostProvider {
  ensureWamHost();
  const host = getRegistry().get(hostId)?.instrumentHost;
  if (!host)
    throw new Error(`The instrument plugin host "${hostId}" is not connected (Settings → Providers).`);
  return host;
}

/** Ask every host for its status and installed plugins. */
export async function refreshPluginHosts(opts: { rescan?: boolean } = {}): Promise<void> {
  const instances = instrumentHostInstances();
  useInstrumentPlugins.setState((s) => ({
    refreshing: true,
    hosts: instances.map(
      (i) =>
        s.hosts.find((h) => h.id === i.descriptor.id) ?? {
          id: i.descriptor.id,
          name: i.descriptor.name,
          location: i.descriptor.location,
          status: 'loading' as const,
          plugins: [],
        },
    ),
  }));
  const views = await Promise.all(
    instances.map(async (i): Promise<HostView> => {
      const base = { id: i.descriptor.id, name: i.descriptor.name, location: i.descriptor.location };
      try {
        const info = await i.instrumentHost!.status();
        const plugins = await i.instrumentHost!.listPlugins({ rescan: opts.rescan });
        return { ...base, status: 'ready', info, plugins };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ...base,
          status: /network|fetch|reach|refused/i.test(msg) ? 'offline' : 'error',
          error: msg,
          plugins: [],
        };
      }
    }),
  );
  useInstrumentPlugins.setState({ hosts: views, refreshing: false });
}

export async function describePlugin(hostId: string, pluginId: string): Promise<InstrumentPluginDescription> {
  return getHost(hostId).describePlugin(pluginId);
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

function currentSong(): Song | null {
  return useStudio.getState().project?.song ?? null;
}

function withSlot(
  song: Song,
  trackId: string,
  fn: (slot: InstrumentPluginSlot | undefined, t: Track) => InstrumentPluginSlot | undefined,
): Song {
  return {
    ...song,
    tracks: song.tracks.map((t) => {
      if (t.id !== trackId) return t;
      const next = fn(t.instrumentPlugin, t);
      const out = { ...t };
      if (next) out.instrumentPlugin = next;
      else delete out.instrumentPlugin;
      return out;
    }),
  };
}

/** Put a plugin on a MIDI track (an undoable edit), then render it. */
export function assignPlugin(trackId: string, hostId: string, plugin: InstrumentPluginInfo): void {
  const song = currentSong();
  const track = song?.tracks.find((t) => t.id === trackId);
  if (!song || !track) return;
  const slot: InstrumentPluginSlot = {
    format: plugin.format,
    pluginId: plugin.id,
    name: plugin.name,
    hostId,
    ...(plugin.vendor ? { vendor: plugin.vendor } : {}),
  };
  useStudio.getState().commit(
    withSlot(song, trackId, () => slot),
    `${track.name}: instrument plugin → ${plugin.name}`,
    'edit',
  );
  void renderTrackPlugin(trackId);
}

export function removePlugin(trackId: string): void {
  const song = currentSong();
  const track = song?.tracks.find((t) => t.id === trackId);
  if (!song || !track?.instrumentPlugin) return;
  useStudio.getState().commit(
    withSlot(song, trackId, () => undefined),
    `${track.name}: removed ${track.instrumentPlugin.name}`,
    'edit',
  );
  setRender(trackId, null);
}

export function setPluginOptions(
  trackId: string,
  patch: Partial<Pick<InstrumentPluginSlot, 'bypass' | 'autoRender' | 'preset' | 'parameters'>>,
  message: string,
): void {
  const song = currentSong();
  if (!song?.tracks.find((t) => t.id === trackId)?.instrumentPlugin) return;
  useStudio.getState().commit(
    withSlot(song, trackId, (slot) => (slot ? { ...slot, ...patch } : slot)),
    message,
    'edit',
  );
}

/** The slot's stored state (state asset + parameters + preset) as the host expects it. */
export async function slotState(slot: InstrumentPluginSlot): Promise<InstrumentPluginState> {
  const state: InstrumentPluginState = { parameters: { ...(slot.parameters ?? {}) } };
  if (slot.preset) state.preset = slot.preset;
  if (slot.stateAssetId) {
    const meta = useStudio.getState().project?.meta.assets.find((a) => a.id === slot.stateAssetId);
    const bytes = meta ? await assetStore.bytes(meta) : undefined;
    if (bytes) state.stateBase64 = bytesToBase64(bytes);
  }
  return state;
}

/** Save an edited plugin state (from a plugin editor) on the track: an undoable edit. */
export async function savePluginState(trackId: string, state: InstrumentPluginState): Promise<void> {
  const st = useStudio.getState();
  const song = currentSong();
  const track = song?.tracks.find((t) => t.id === trackId);
  const slot = track?.instrumentPlugin;
  if (!song || !track || !slot) return;
  let stateAssetId = slot.stateAssetId;
  if (state.stateBase64) {
    const bytes = base64ToBytes(state.stateBase64);
    const meta: AudioAssetMeta = {
      id: randomId('pstate'),
      name: `${track.name} – ${slot.name}.state`,
      kind: 'plugin-state',
      path: '',
      mimeType: 'application/octet-stream',
      sampleRate: 0,
      channels: 0,
      durationSeconds: 0,
      bytes: bytes.length,
      createdAt: new Date().toISOString(),
    };
    await st.addAsset(meta, bytes);
    stateAssetId = meta.id;
  }
  const fresh = currentSong() ?? song;
  st.commit(
    withSlot(fresh, trackId, (s) =>
      s
        ? {
            ...s,
            ...(stateAssetId ? { stateAssetId } : {}),
            parameters: { ...state.parameters },
            ...(state.preset ? { preset: state.preset } : {}),
          }
        : s,
    ),
    `${track.name}: edited ${slot.name}`,
    'edit',
  );
  void renderTrackPlugin(trackId);
}

/**
 * Open the plugin's own editor. Native hosts open a window on the machine running the host and
 * resolve when it closes; WAM editors open in the studio (the caller shows `session.gui`).
 */
export async function openPluginEditor(trackId: string): Promise<{ wam?: WamEditorSession }> {
  const track = currentSong()?.tracks.find((t) => t.id === trackId);
  const slot = track?.instrumentPlugin;
  if (!slot) throw new Error('This track has no instrument plugin');
  const state = await slotState(slot);
  if (slot.hostId === WAM_HOST_ID) return { wam: await openWamEditor(slot.pluginId, state) };
  const host = getHost(slot.hostId);
  if (!host.openEditor) throw new Error('This plugin host cannot open plugin editors');
  const edited = await host.openEditor(slot.pluginId, state);
  await savePluginState(trackId, edited);
  return {};
}

// ---------------------------------------------------------------------------
// Rendering (freeze)
// ---------------------------------------------------------------------------

export interface InstrumentRenderTaskInput {
  trackId: string;
}

/** Queue a render of the track's plugin (one at a time per track). */
export function renderTrackPlugin(trackId: string): string | undefined {
  const track = currentSong()?.tracks.find((t) => t.id === trackId);
  const slot = track?.instrumentPlugin;
  if (!track || !slot || slot.bypass) return undefined;
  const busy = useInstrumentPlugins.getState().renders[trackId];
  if (busy && (busy.status === 'queued' || busy.status === 'running')) return busy.taskId;
  taskQueue.register('instrument.render', renderHandler);
  const rec = enqueueTask<InstrumentRenderTaskInput>({
    type: 'instrument.render',
    title: `Render ${slot.name} on “${track.name}”`,
    input: { trackId },
    runner: slot.hostId === WAM_HOST_ID ? 'browser' : slot.hostId,
    providerId: slot.hostId,
  });
  setRender(trackId, { status: 'queued', taskId: rec.id });
  return rec.id;
}

/** Plugin render assets no revision and not the current song refer to. */
function unusedRenderAssets(): string[] {
  const project = useStudio.getState().project;
  if (!project) return [];
  const used = new Set<string>();
  const add = (s: Song) => {
    for (const t of s.tracks) if (t.instrumentPlugin?.render) used.add(t.instrumentPlugin.render.assetId);
  };
  add(project.song);
  for (const r of project.history.revisions) add(r.snapshot);
  return project.meta.assets.filter((a) => a.kind === 'plugin-render' && !used.has(a.id)).map((a) => a.id);
}

export async function runInstrumentRender(
  input: InstrumentRenderTaskInput,
  ctx: {
    signal: AbortSignal;
    progress(p: number, msg?: string): void;
    log(level: 'info' | 'warn' | 'error', msg: string): void;
  },
): Promise<{ assetId: string; durationSeconds: number }> {
  const { trackId } = input;
  setRender(trackId, { status: 'running', taskId: useInstrumentPlugins.getState().renders[trackId]?.taskId });
  try {
    const song = currentSong();
    const track = song?.tracks.find((t) => t.id === trackId);
    const slot = track?.instrumentPlugin;
    if (!song || !track || !slot) throw new Error('The track or its instrument plugin no longer exists');
    const key = pluginRenderKey(song, track);
    const { events, durationSeconds } = trackMidiEvents(song, track);
    ctx.log(
      'info',
      `${events.length} MIDI events, ${durationSeconds.toFixed(1)} s through ${slot.name} (${slot.format})`,
    );
    ctx.progress(0.1, `Rendering ${slot.name}…`);
    initAi();
    ensureWamHost();
    const run = await getOrchestrator().renderInstrument(
      {
        pluginId: slot.pluginId,
        state: await slotState(slot),
        sampleRate: RENDER_SAMPLE_RATE,
        channels: 2,
        durationSeconds,
        events: events.map((e) => ({ time: e.time, data: e.data })),
      },
      { providerId: slot.hostId, modelId: slot.pluginId, signal: ctx.signal, dataKinds: ['midi'] },
    );
    ctx.progress(0.8, 'Storing the render…');
    const bytes = run.result.audio.data;
    const audio = await decodeAudioBytes(bytes);
    const seconds = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
    const meta: AudioAssetMeta = {
      id: randomId('prender'),
      name: `${track.name} – ${slot.name}.wav`,
      kind: 'plugin-render',
      path: '',
      mimeType: 'audio/wav',
      sampleRate: audio.sampleRate,
      channels: audio.channels.length,
      durationSeconds: seconds,
      bytes: bytes.length,
      createdAt: new Date().toISOString(),
    };
    const st = useStudio.getState();
    await assetStore.add(meta, bytes, audio);
    const latency = run.result.latencyCompensated ? 0 : (run.result.latencySamples ?? 0) / audio.sampleRate;
    st.updateProject((p) => {
      const t = p.song.tracks.find((x) => x.id === trackId);
      // The slot was changed or removed meanwhile: keep the asset list clean, drop the result.
      if (
        !t?.instrumentPlugin ||
        t.instrumentPlugin.pluginId !== slot.pluginId ||
        t.instrumentPlugin.hostId !== slot.hostId
      )
        return p;
      const song2 = withSlot(p.song, trackId, (s) =>
        s
          ? {
              ...s,
              render: {
                assetId: meta.id,
                key,
                sampleRate: audio.sampleRate,
                durationSeconds: seconds,
                ...(latency > 0 ? { offsetSeconds: latency } : {}),
                renderedAt: meta.createdAt,
              },
            }
          : s,
      );
      return coreAddAsset({ ...p, song: song2 }, meta);
    });
    // Superseded renders that no revision uses are deleted.
    const unused = unusedRenderAssets();
    for (const id of unused) await assetStore.remove(id);
    if (unused.length)
      st.updateProject((p) => ({
        ...p,
        meta: { ...p.meta, assets: p.meta.assets.filter((a) => !unused.includes(a.id)) },
      }));
    ctx.progress(1, 'Done');
    setRender(trackId, { status: 'done' });
    return { assetId: meta.id, durationSeconds: seconds };
  } catch (err) {
    setRender(trackId, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

const renderHandler: TaskHandler<InstrumentRenderTaskInput, { assetId: string; durationSeconds: number }> = (
  ctx,
) => runInstrumentRender(ctx.input, ctx);

/** Task handlers for the generation queue (engine/taskHandlers.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, TaskHandler<any, any>> = { 'instrument.render': renderHandler };

// ---------------------------------------------------------------------------
// Automatic re-render
// ---------------------------------------------------------------------------

let autoStarted = false;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Whether a track's plugin render is missing or out of date. */
export function pluginRenderStale(song: Song, track: Track): boolean {
  const slot = track.instrumentPlugin;
  return !!slot && !slot.bypass && !pluginRenderIsCurrent(song, track);
}

/** Re-render stale plugin tracks a moment after the last edit (Settings: automatic re-render). */
export function initPluginAutoRender(): void {
  if (autoStarted) return;
  autoStarted = true;
  let last: Song | null = null;
  useStudio.subscribe((s) => {
    const song = s.project?.song ?? null;
    if (!song || song === last) return;
    last = song;
    if (!useSettings.getState().autoRenderPlugins) return;
    for (const t of song.tracks) {
      const slot = t.instrumentPlugin;
      if (!slot || slot.autoRender === false || !pluginRenderStale(song, t)) continue;
      const r = useInstrumentPlugins.getState().renders[t.id];
      if (r?.status === 'failed') continue; // retry from the track panel
      clearTimeout(timers.get(t.id));
      timers.set(
        t.id,
        setTimeout(() => {
          timers.delete(t.id);
          const cur = currentSong();
          const ct = cur?.tracks.find((x) => x.id === t.id);
          if (cur && ct && pluginRenderStale(cur, ct)) renderTrackPlugin(t.id);
        }, 1500),
      );
    }
  });
}
