import {
  DirectTransport,
  ServerProxyTransport,
  ServerVaultClient,
  authForConfig,
  type AccelerationBackend,
  type Capability,
  type ModelQuantization,
  type ProviderConfig,
} from '@songdeck/ai';
import { serverBase, useSettings } from '../../state/settings';
import { useRuntime } from '../../engine/runtime';
import { getRegistry, sessionCredentials, useAiRuntime } from '../../engine/ai';
import { useExtensions, type PluginManifest } from '../../engine/plugins';

/**
 * Small client for the local server endpoints Settings needs (apps/server README): hardware,
 * model manager, plugins, vault status, provider sync. Types mirror the server's JSON.
 */

export class ServerApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ServerApiError';
  }
}

export function serverOnline(): boolean {
  return useRuntime.getState().server.status === 'online';
}

export async function serverJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${serverBase()}${path}`, init);
  } catch (err) {
    throw new ServerApiError(`Song Deck server unreachable (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body.error) message = body.error;
      code = body.code;
    } catch {
      /* not JSON */
    }
    throw new ServerApiError(message, res.status, code);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Hardware & models (spec §61, §62)
// ---------------------------------------------------------------------------

export interface HardwareGpu {
  name: string;
  vendor: string;
  vramGb: number;
  backend?: AccelerationBackend;
  driver?: string;
  unifiedMemory?: boolean;
}

export interface HardwareReport {
  gpus: HardwareGpu[];
  ramGb: number;
  freeRamGb?: number;
  cpu: { model?: string; cores: number; threads?: number };
  storageFreeGb?: number;
  backends: AccelerationBackend[];
  accelerationBackends?: AccelerationBackend[];
  unifiedMemory?: boolean;
  platform?: string;
  arch?: string;
  os?: string;
  detectedAt?: string;
}

export type CompatibilityRating = 'excellent' | 'compatible' | 'slow' | 'insufficient';

export interface ModelEntry {
  id: string;
  name: string;
  category: string;
  provider: string;
  version: string;
  sizeGb?: number;
  license: string;
  requirements: { minVramGb?: number; recommendedVramGb?: number; minRamGb?: number; cpuOk?: boolean; minCpuCores?: number };
  capabilities: string[];
  location?: string;
  installed: boolean;
  installedVersion?: string;
  updateStatus: 'up-to-date' | 'update-available' | 'not-installed' | 'unknown';
  compatibility: { rating: CompatibilityRating; reasons: string[]; suggestedQuantization?: string };
  source: string;
  description?: string;
  homepage?: string;
  install?: string;
  presetId?: string;
  quantizations?: ModelQuantization[];
  installedVia?: string[];
}

export interface ModelsReport {
  categories: { id: string; label: string; models: ModelEntry[] }[];
  sources: { source: string; url?: string; status: 'ok' | 'unreachable' | 'error' | 'disabled'; count: number; error?: string }[];
  hardware?: Partial<HardwareReport>;
  scannedAt: string;
}

export function getHardware(refresh = false): Promise<HardwareReport> {
  return serverJson<HardwareReport>(`/api/hardware${refresh ? '?refresh=1' : ''}`);
}

export function getModels(refresh = false): Promise<ModelsReport> {
  return serverJson<ModelsReport>(`/api/models${refresh ? '?refresh=1' : ''}`);
}

export function rescanModels(): Promise<ModelsReport> {
  return serverJson<ModelsReport>('/api/models/rescan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
}

// ---------------------------------------------------------------------------
// Plugins (spec §57)
// ---------------------------------------------------------------------------

export interface PluginRecord extends PluginManifest {
  source?: 'bundled' | 'user';
  dir?: string;
  entryUrl?: string;
  warnings?: string[];
}

export interface PluginScan {
  plugins: PluginRecord[];
  errors: { dir: string; id?: string; error: string }[];
}

/** Scan plugins (full records + manifest errors) and refresh the extension store's list. */
export async function scanPluginRecords(): Promise<PluginScan> {
  try {
    const data = await serverJson<PluginScan | PluginRecord[]>('/api/plugins');
    const scan: PluginScan = Array.isArray(data) ? { plugins: data, errors: [] } : { plugins: data.plugins ?? [], errors: data.errors ?? [] };
    useExtensions.setState({ available: scan.plugins, scanError: undefined });
    return scan;
  } catch (err) {
    useExtensions.setState({ scanError: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Providers & credentials (spec §7)
// ---------------------------------------------------------------------------

/** Push provider configs (never secrets) to the server now and wait for it (proxy allowlist + credential scope). */
export async function syncProvidersNow(): Promise<void> {
  if (!serverOnline()) return;
  try {
    await fetch(`${serverBase()}/api/providers`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providers: useSettings.getState().providers }),
    });
  } catch {
    /* server optional */
  }
}

export type CredentialWhere = 'vault' | 'session' | 'none';

export interface VaultInfo {
  backend?: string;
  detail?: string;
  refs: { ref: string; label?: string; updatedAt?: string }[];
}

export async function vaultInfo(): Promise<VaultInfo | null> {
  if (!serverOnline()) return null;
  try {
    const st = await serverJson<VaultInfo>('/api/vault');
    if (st.backend) useAiRuntime.setState({ vaultBackend: st.backend });
    return { backend: st.backend, detail: st.detail, refs: Array.isArray(st.refs) ? st.refs : [] };
  } catch {
    return null;
  }
}

/** Where each credential reference is stored (one vault call for all refs). */
export async function credentialLocations(refs: string[]): Promise<Record<string, CredentialWhere>> {
  const out: Record<string, CredentialWhere> = {};
  const vault = serverOnline() ? await vaultInfo() : null;
  const inVault = new Set((vault?.refs ?? []).map((r) => r.ref));
  for (const ref of refs) out[ref] = inVault.has(ref) ? 'vault' : sessionCredentials.has(ref) ? 'session' : 'none';
  return out;
}

/** Human description of where a secret went (spec §7: never in settings or project files). */
export function describeVaultBackend(backend: string | undefined): string {
  switch (backend) {
    case 'keychain':
      return 'OS keychain';
    case 'encrypted-file':
      return 'encrypted vault file';
    case 'memory':
      return 'server memory (until it restarts)';
    default:
      return backend ?? 'vault';
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Reachability probe for bridges without model discovery (`GET {base}/info`). */
export async function probeEndpoint(config: ProviderConfig, path = 'info'): Promise<{ status: number; ms: number; body?: unknown }> {
  const useProxy = serverOnline() && useSettings.getState().useServerProxy;
  const transport = useProxy ? new ServerProxyTransport(serverBase()) : new DirectTransport(sessionCredentials);
  const t0 = performance.now();
  const res = await transport.fetch(joinUrl(config.baseUrl, path), { method: 'GET' }, authForConfig(config));
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, ms: Math.round(performance.now() - t0), body };
}

/** Fetch the vault status straight from the server (used after saving a key). */
export async function refreshVault(): Promise<string | undefined> {
  if (!serverOnline()) return undefined;
  try {
    const st = await new ServerVaultClient(serverBase()).status();
    useAiRuntime.setState({ vaultBackend: st.backend });
    return st.backend;
  } catch {
    return undefined;
  }
}

export function capabilityList(caps: readonly string[] | undefined): Capability[] {
  return (caps ?? []) as Capability[];
}

export interface ProviderCheck {
  tone: 'success' | 'warning' | 'danger';
  text: string;
  models?: number;
}

/**
 * Discover a provider's models (or, for bridges that cannot list models, probe `GET /info`) and
 * describe the outcome. Throws on connection/auth errors (the registry records the status).
 */
export async function checkProvider(config: ProviderConfig, mode: 'discover' | 'test' = 'test'): Promise<ProviderCheck> {
  const reg = getRegistry();
  const inst = reg.get(config.id);
  if (!inst) throw new Error('The provider could not be created — check its configuration');
  const t0 = performance.now();
  const listsModels = !!(inst.llm || inst.audioGeneration || inst.singing || inst.voiceConversion?.listVoices);
  if (!listsModels) {
    const probe = await probeEndpoint(config);
    if (probe.status < 400) return { tone: 'success', text: `Reachable — HTTP ${probe.status} in ${probe.ms} ms.${mode === 'discover' ? ' This kind of provider does not list models.' : ''}` };
    return { tone: probe.status === 404 ? 'warning' : 'danger', text: `The endpoint answered HTTP ${probe.status} (${probe.ms} ms).` };
  }
  const list = await reg.discoverModels(config.id, { force: true });
  const ms = Math.round(performance.now() - t0);
  const voices = reg.voices(config.id).length;
  const what = `${list.length} model${list.length === 1 ? '' : 's'}${voices ? `${list.length ? ' and' : ''} ${voices} voices` : ''}`;
  return {
    tone: list.length || voices ? 'success' : 'warning',
    text: mode === 'test' ? `Connected in ${ms} ms — ${what} available.` : `Found ${what} (${ms} ms).`,
    models: list.length,
  };
}
