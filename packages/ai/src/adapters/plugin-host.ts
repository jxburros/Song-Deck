/**
 * Instrument plugin host bridge adapter (capability INSTRUMENT_PLUGIN_HOST) — the Song Deck plugin
 * host contract (`PLUGIN_HOST_PATHS` in contracts.ts): list the instrument plugins installed on the
 * host machine (VST3, Audio Units, VST2, CLAP, LV2, SoundFonts, SFZ), describe one, render MIDI
 * through it offline ("freeze"), and read or edit its state (the native editor opens on the
 * machine running the host).
 */
import type { Capability } from '../capabilities';
import type { ProviderConfig } from '../config';
import {
  PLUGIN_FORMATS,
  PLUGIN_HOST_PATHS,
  type PluginFormat,
  type PluginHostDescription,
  type PluginHostInfo,
  type PluginHostPlugin,
  type PluginHostRenderRequest,
  type PluginHostState,
  type PluginHostStateRequest,
} from '../contracts';
import { ProviderError } from '../errors';
import type { HttpClient } from '../transport/http';
import type {
  InstrumentHostProvider,
  InstrumentHostStatus,
  InstrumentPluginDescription,
  InstrumentPluginFormat,
  InstrumentPluginInfo,
  InstrumentPluginState,
  InstrumentRenderRequest,
  InstrumentRenderResult,
  ModelInfo,
  ProviderInstance,
} from '../types';
import { clamp, joinUrl } from '../util';
import { audioFromResponse, buildDescriptor, createHttpClient, type CreateProviderDeps } from './common';

export const PLUGIN_HOST_CAPABILITIES: Capability[] = ['INSTRUMENT_PLUGIN_HOST'];

function format(f: unknown): InstrumentPluginFormat {
  return PLUGIN_FORMATS.includes(f as PluginFormat) ? (f as InstrumentPluginFormat) : 'vst3';
}

export function pluginInfoFromBridge(p: PluginHostPlugin): InstrumentPluginInfo {
  const out: InstrumentPluginInfo = {
    id: String(p.id),
    name: String(p.name ?? p.id),
    format: format(p.format),
  };
  if (p.vendor) out.vendor = p.vendor;
  if (p.version) out.version = p.version;
  if (p.category) out.category = p.category;
  if (p.path) out.path = p.path;
  if (typeof p.loadable === 'boolean') out.loadable = p.loadable;
  return out;
}

function stateFromBridge(s: PluginHostState | undefined): InstrumentPluginState {
  const out: InstrumentPluginState = { parameters: { ...(s?.parameters ?? {}) } };
  if (s?.state_base64) out.stateBase64 = s.state_base64;
  if (s?.preset) out.preset = s.preset;
  return out;
}

function stateRequest(pluginId: string, state: InstrumentPluginState | undefined): PluginHostStateRequest {
  const body: PluginHostStateRequest = { plugin_id: pluginId };
  if (state?.stateBase64) body.state_base64 = state.stateBase64;
  if (state?.parameters && Object.keys(state.parameters).length) body.parameters = { ...state.parameters };
  if (state?.preset) body.preset = state.preset;
  return body;
}

export class PluginHostBridge implements InstrumentHostProvider {
  constructor(
    readonly config: ProviderConfig,
    private readonly http: HttpClient,
  ) {}

  private url(path: string): string {
    return joinUrl(this.config.baseUrl, path);
  }

  async status(signal?: AbortSignal): Promise<InstrumentHostStatus> {
    const info = await this.http.json<PluginHostInfo>({
      url: this.url(PLUGIN_HOST_PATHS.info),
      method: 'GET',
      signal,
    });
    return {
      name: info?.name ?? this.config.name,
      ...(info?.version ? { version: info.version } : {}),
      formats: (info?.formats ?? []).map((f) => ({
        format: format(f.format),
        available: !!f.available,
        ...(f.backend ? { backend: f.backend } : {}),
        ...(f.note ? { note: f.note } : {}),
      })),
      editor: !!info?.editor,
      ...(info?.search_paths ? { searchPaths: info.search_paths } : {}),
    };
  }

  async listPlugins(
    opts: { rescan?: boolean; paths?: string[]; signal?: AbortSignal } = {},
  ): Promise<InstrumentPluginInfo[]> {
    const rescan = opts.rescan || !!opts.paths?.length;
    const json = await this.http.json<{ plugins?: PluginHostPlugin[] }>(
      rescan
        ? { url: this.url(PLUGIN_HOST_PATHS.plugins), json: { paths: opts.paths ?? [] }, signal: opts.signal }
        : { url: this.url(PLUGIN_HOST_PATHS.plugins), method: 'GET', signal: opts.signal },
    );
    return (json?.plugins ?? []).filter((p) => p && p.id).map(pluginInfoFromBridge);
  }

  async describePlugin(pluginId: string, signal?: AbortSignal): Promise<InstrumentPluginDescription> {
    const d = await this.http.json<PluginHostDescription>({
      url: this.url(PLUGIN_HOST_PATHS.describe),
      json: { plugin_id: pluginId },
      signal,
    });
    if (!d)
      throw new ProviderError('parse', 'The plugin host returned no description', {
        providerId: this.config.id,
      });
    const out: InstrumentPluginDescription = {
      ...pluginInfoFromBridge({ ...d, id: d.id ?? pluginId }),
      parameters: (d.parameters ?? []).map((p) => ({ ...p, id: String(p.id), name: String(p.name ?? p.id) })),
    };
    if (d.presets) out.presets = d.presets;
    if (typeof d.has_editor === 'boolean') out.hasEditor = d.has_editor;
    if (typeof d.latency_samples === 'number') out.latencySamples = d.latency_samples;
    return out;
  }

  async renderInstrument(req: InstrumentRenderRequest): Promise<InstrumentRenderResult> {
    const body: PluginHostRenderRequest = {
      ...stateRequest(req.pluginId, req.state),
      sample_rate: Math.round(req.sampleRate),
      channels: req.channels ?? 2,
      duration_seconds: Math.max(0.01, req.durationSeconds),
      events: req.events
        .filter((e) => Number.isFinite(e.time) && e.time >= 0 && e.data.length)
        .map((e) => ({ time_seconds: e.time, data: e.data.map((b) => clamp(Math.round(b), 0, 255)) })),
    };
    if (req.blockSize) body.block_size = req.blockSize;
    const r = await this.http.bytes({
      url: this.url(PLUGIN_HOST_PATHS.render),
      json: body,
      accept: 'audio/wav',
      signal: req.signal,
    });
    const latency = Number(r.headers.get('x-plugin-latency'));
    const res: InstrumentRenderResult = {
      audio: { ...audioFromResponse(r.data, r.contentType, 'wav'), sampleRate: body.sample_rate },
      pluginId: req.pluginId,
    };
    // The contract's renders are already latency compensated; the header is informational.
    if (Number.isFinite(latency) && latency > 0) res.latencySamples = latency;
    res.latencyCompensated = true;
    return res;
  }

  async captureState(
    pluginId: string,
    state?: InstrumentPluginState,
    signal?: AbortSignal,
  ): Promise<InstrumentPluginState> {
    const s = await this.http.json<PluginHostState>({
      url: this.url(PLUGIN_HOST_PATHS.state),
      json: stateRequest(pluginId, state),
      signal,
    });
    return stateFromBridge(s);
  }

  async openEditor(
    pluginId: string,
    state?: InstrumentPluginState,
    signal?: AbortSignal,
  ): Promise<InstrumentPluginState> {
    const s = await this.http.json<PluginHostState>({
      url: this.url(PLUGIN_HOST_PATHS.editor),
      json: stateRequest(pluginId, state),
      signal,
      // The window stays open as long as the user works in it.
      timeoutMs: 3_600_000,
      retry: false,
    });
    return stateFromBridge(s);
  }
}

/** Installed plugins as "models" of the host (what the provider list and pickers show). */
export function pluginModels(plugins: InstrumentPluginInfo[]): ModelInfo[] {
  return plugins.map((p) => ({
    id: p.id,
    name: p.vendor ? `${p.name} (${p.vendor})` : p.name,
    capabilities: ['INSTRUMENT_PLUGIN_HOST'],
    meta: { format: p.format, category: p.category, vendor: p.vendor, loadable: p.loadable },
  }));
}

export function createPluginHostProvider(config: ProviderConfig, deps: CreateProviderDeps): ProviderInstance {
  const http = createHttpClient(config, deps);
  return {
    descriptor: buildDescriptor(config, PLUGIN_HOST_CAPABILITIES),
    config,
    instrumentHost: new PluginHostBridge(config, http),
  };
}
