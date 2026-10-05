import type { AudioData } from '@songdeck/audio';
import type {
  InstrumentHostProvider,
  InstrumentHostStatus,
  InstrumentPluginDescription,
  InstrumentPluginInfo,
  InstrumentPluginState,
  InstrumentRenderRequest,
  InstrumentRenderResult,
} from '@songdeck/ai';

/**
 * In-browser instrument plugins: Web Audio Modules 2 (WAM, the open web plugin standard — see
 * webaudiomodules.com). A WAM is an ES module whose default export creates an AudioNode that
 * accepts MIDI events. Song Deck renders it offline in an OfflineAudioContext (the same "freeze"
 * the native plugin host does) and opens its own GUI in the studio for editing.
 *
 * WAM code runs in the page with the studio's rights: only add modules from sources you trust.
 */

/** The subset of the WAM 2 API Song Deck uses (`@webaudiomodules/api`). */
interface WamNodeLike extends AudioNode {
  scheduleEvents(...events: { type: string; time: number; data: unknown }[]): void;
  getState(): Promise<unknown>;
  setState(state: unknown): Promise<void>;
  getParameterInfo?(
    ...ids: string[]
  ): Promise<
    Record<
      string,
      { id: string; label?: string; minValue?: number; maxValue?: number; defaultValue?: number }
    >
  >;
  getParameterValues?(
    normalized?: boolean,
    ...ids: string[]
  ): Promise<Record<string, { id: string; value: number }>>;
  setParameterValues?(
    values: Record<string, { id: string; value: number; normalized: boolean }>,
  ): Promise<void>;
  destroy?(): void;
}

interface WamInstanceLike {
  audioNode: WamNodeLike;
  descriptor?: { name?: string; vendor?: string; isInstrument?: boolean; version?: string };
  createGui?(): Promise<Element>;
  destroyGui?(gui: Element): void;
}

interface WamModuleLike {
  default: {
    createInstance(groupId: string, ctx: BaseAudioContext, initialState?: unknown): Promise<WamInstanceLike>;
  };
}

const hostGroups = new WeakMap<BaseAudioContext, Promise<[string, string]>>();

async function hostGroup(ctx: BaseAudioContext): Promise<string> {
  let p = hostGroups.get(ctx);
  if (!p) {
    p = import('@webaudiomodules/sdk').then((sdk) =>
      (
        sdk as unknown as { initializeWamHost(c: BaseAudioContext): Promise<[string, string]> }
      ).initializeWamHost(ctx),
    );
    hostGroups.set(ctx, p);
  }
  return (await p)[0];
}

async function loadModule(url: string): Promise<WamModuleLike> {
  const mod = (await import(/* @vite-ignore */ url)) as Partial<WamModuleLike>;
  if (!mod.default || typeof mod.default.createInstance !== 'function')
    throw new Error(`${url} is not a Web Audio Module (its default export has no createInstance)`);
  return mod as WamModuleLike;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** WAM state stored in a project asset: the plugin's own state, serialized as JSON. */
export function wamStateToBase64(state: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(state ?? null)));
}

export function wamStateFromBase64(b64: string | undefined): unknown {
  if (!b64) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(base64ToBytes(b64)));
  } catch {
    return undefined;
  }
}

async function applyState(node: WamNodeLike, state: InstrumentPluginState | undefined): Promise<void> {
  const s = wamStateFromBase64(state?.stateBase64);
  if (s !== undefined && s !== null) await node.setState(s);
  const params = state?.parameters ?? {};
  if (Object.keys(params).length && node.setParameterValues)
    await node.setParameterValues(
      Object.fromEntries(Object.entries(params).map(([id, value]) => [id, { id, value, normalized: false }])),
    );
}

async function readState(node: WamNodeLike): Promise<InstrumentPluginState> {
  const raw = await node.getState();
  const values = node.getParameterValues ? await node.getParameterValues(false) : {};
  return {
    stateBase64: wamStateToBase64(raw),
    parameters: Object.fromEntries(Object.values(values).map((v) => [v.id, v.value])),
  };
}

/** Render MIDI through a WAM offline (sample-accurate, faster than real time). */
export async function renderWam(req: InstrumentRenderRequest): Promise<AudioData> {
  if (typeof OfflineAudioContext === 'undefined') throw new Error('This browser cannot render audio offline');
  const channels = req.channels ?? 2;
  const frames = Math.max(1, Math.ceil(req.durationSeconds * req.sampleRate));
  const ctx = new OfflineAudioContext(channels, frames, req.sampleRate);
  const groupId = await hostGroup(ctx);
  const mod = await loadModule(req.pluginId);
  const wam = await mod.default.createInstance(groupId, ctx);
  await applyState(wam.audioNode, req.state);
  wam.audioNode.connect(ctx.destination);
  wam.audioNode.scheduleEvents(
    ...req.events.map((e) => ({ type: 'wam-midi', time: e.time, data: { bytes: e.data.slice(0, 3) } })),
  );
  // Let the worklet receive the events before the clock starts.
  await new Promise((r) => setTimeout(r, 30));
  if (req.signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
  const buffer = await ctx.startRendering();
  wam.audioNode.destroy?.();
  return {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice()),
  };
}

/** A live WAM instance with its GUI, for editing in the studio (and playing it from a MIDI keyboard). */
export interface WamEditorSession {
  name: string;
  gui: Element | null;
  /** Send a raw MIDI message now (keyboard preview). */
  midi(bytes: number[]): void;
  state(): Promise<InstrumentPluginState>;
  close(): void;
}

export async function openWamEditor(url: string, state?: InstrumentPluginState): Promise<WamEditorSession> {
  const ctx = new AudioContext();
  const groupId = await hostGroup(ctx);
  const mod = await loadModule(url);
  const wam = await mod.default.createInstance(groupId, ctx);
  await applyState(wam.audioNode, state);
  wam.audioNode.connect(ctx.destination);
  const gui = wam.createGui ? await wam.createGui() : null;
  return {
    name: wam.descriptor?.name ?? url,
    gui,
    midi(bytes) {
      void ctx.resume();
      wam.audioNode.scheduleEvents({ type: 'wam-midi', time: ctx.currentTime, data: { bytes } });
    },
    state: () => readState(wam.audioNode),
    close() {
      if (gui && wam.destroyGui) wam.destroyGui(gui);
      wam.audioNode.destroy?.();
      void ctx.close();
    },
  };
}

/** Name, vendor and parameters of a WAM (loaded once in a throwaway offline context). */
export async function describeWam(url: string): Promise<InstrumentPluginDescription> {
  const ctx = new OfflineAudioContext(2, 128, 44100);
  const groupId = await hostGroup(ctx);
  const mod = await loadModule(url);
  const wam = await mod.default.createInstance(groupId, ctx);
  const info = wam.audioNode.getParameterInfo ? await wam.audioNode.getParameterInfo() : {};
  const values = wam.audioNode.getParameterValues ? await wam.audioNode.getParameterValues(false) : {};
  wam.audioNode.destroy?.();
  return {
    id: url,
    name: wam.descriptor?.name ?? url.split('/').filter(Boolean).pop() ?? url,
    format: 'wam',
    category: wam.descriptor?.isInstrument === false ? 'effect' : 'instrument',
    ...(wam.descriptor?.vendor ? { vendor: wam.descriptor.vendor } : {}),
    ...(wam.descriptor?.version ? { version: wam.descriptor.version } : {}),
    hasEditor: !!wam.createGui,
    loadable: true,
    parameters: Object.values(info).map((p) => ({
      id: p.id,
      name: p.label ?? p.id,
      value: values[p.id]?.value ?? p.defaultValue ?? 0,
      ...(p.minValue !== undefined ? { min: p.minValue } : {}),
      ...(p.maxValue !== undefined ? { max: p.maxValue } : {}),
      ...(p.defaultValue !== undefined ? { default: p.defaultValue } : {}),
    })),
  };
}

/**
 * The in-browser host as an instrument-host provider (registered as an internal provider), so WAM
 * plugins appear next to native ones. Plugins come from Settings → Plugins (module URLs).
 */
export function createWamHost(
  list: () => { url: string; name: string; vendor?: string }[],
  encode: (a: AudioData) => Promise<Uint8Array>,
): InstrumentHostProvider {
  return {
    async status(): Promise<InstrumentHostStatus> {
      return {
        name: 'Web Audio Modules (in the browser)',
        formats: [
          { format: 'wam', available: typeof OfflineAudioContext !== 'undefined', backend: 'browser' },
        ],
        editor: true,
      };
    },
    async listPlugins(): Promise<InstrumentPluginInfo[]> {
      return list().map((p) => ({
        id: p.url,
        name: p.name,
        format: 'wam',
        category: 'instrument',
        loadable: true,
        ...(p.vendor ? { vendor: p.vendor } : {}),
      }));
    },
    describePlugin: (id) => describeWam(id),
    async renderInstrument(req): Promise<InstrumentRenderResult> {
      const audio = await renderWam(req);
      return {
        audio: {
          mimeType: 'audio/wav',
          data: await encode(audio),
          sampleRate: audio.sampleRate,
          channels: audio.channels.length,
        },
        pluginId: req.pluginId,
      };
    },
    async captureState(pluginId, state) {
      const ed = await openWamEditor(pluginId, state);
      try {
        return await ed.state();
      } finally {
        ed.close();
      }
    },
  };
}
