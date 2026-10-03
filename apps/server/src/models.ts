/**
 * Model manager (spec §62): one view of local models, grouped into Composition / Audio / Vocals /
 * Transcription / Separation / Mastering, combining
 *  - the curated `LOCAL_MODEL_CATALOG` of `@songdeck/ai` (requirements, licenses, capabilities),
 *  - installed models discovered from Ollama (`/api/tags`), LM Studio and other local
 *    OpenAI-compatible servers (`/models`), and local bridge providers (`GET {baseUrl}/info`,
 *    `/voices` for singing bridges),
 *  - manifests in `<dataDir>/models/<name>/model.json`,
 * each classified against the detected hardware with `classifyCompatibility` (spec §61:
 * Excellent / Compatible / Slow / Insufficient, with a suggested quantization where one fits).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  classifyCompatibility,
  inferModelCapabilities,
  LOCAL_MODEL_CATALOG,
  type LocalModelEntry,
  type ModelQuantization,
} from '@songdeck/ai';
import type { HardwareInfo, HardwareService } from './hardware';
import { sendJson } from './http-util';
import type { Logger } from './logger';
import type { ProviderStore, StoredProviderConfig } from './providers';
import type { Router } from './router';

export type ModelCategory = 'composition' | 'audio' | 'vocals' | 'transcription' | 'separation' | 'mastering';
export type CompatibilityRating = 'excellent' | 'compatible' | 'slow' | 'insufficient';
export type UpdateStatus = 'up-to-date' | 'update-available' | 'not-installed' | 'unknown';
export type ModelSource = 'catalog' | 'ollama' | 'openai-compatible' | 'bridge' | 'directory';

export const MODEL_CATEGORIES: { id: ModelCategory; label: string }[] = [
  { id: 'composition', label: 'Composition' },
  { id: 'audio', label: 'Audio' },
  { id: 'vocals', label: 'Vocals' },
  { id: 'transcription', label: 'Transcription' },
  { id: 'separation', label: 'Separation' },
  { id: 'mastering', label: 'Mastering' },
];

/** Hardware requirements (the catalog's fields; partially known for discovered models). */
export interface ModelRequirements {
  minVramGb?: number;
  recommendedVramGb?: number;
  minRamGb?: number;
  /** Runs (slowly) on CPU only. */
  cpuOk?: boolean;
  minCpuCores?: number;
  [key: string]: unknown;
}

export interface Compatibility {
  rating: CompatibilityRating;
  reasons: string[];
  suggestedQuantization?: string;
}

export interface ModelEntry {
  id: string;
  name: string;
  category: ModelCategory;
  /** Runtime / vendor ("Ollama", "ACE-Step bridge", "LM Studio"…). */
  provider: string;
  version: string;
  sizeGb?: number;
  license: string;
  requirements: ModelRequirements;
  capabilities: string[];
  /** Filesystem path or URL where the model lives (installed) or can be obtained. */
  location?: string;
  installed: boolean;
  installedVersion?: string;
  updateStatus: UpdateStatus;
  compatibility: Compatibility;
  source: ModelSource;
  description?: string;
  homepage?: string;
  /** Install hint (e.g. `ollama pull llama3.1:8b`). */
  install?: string;
  /** Provider preset that connects to this model. */
  presetId?: string;
  quantizations?: ModelQuantization[];
  /** Discovery sources that reported this model as installed. */
  installedVia?: string[];
}

export interface SourceStatus {
  source: string;
  url?: string;
  status: 'ok' | 'unreachable' | 'error' | 'disabled';
  count: number;
  error?: string;
}

export interface ModelsReport {
  categories: { id: ModelCategory; label: string; models: ModelEntry[] }[];
  sources: SourceStatus[];
  hardware: Pick<HardwareInfo, 'gpus' | 'ramGb' | 'storageFreeGb' | 'backends' | 'accelerationBackends' | 'unifiedMemory'>;
  scannedAt: string;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

const CATEGORY_ALIASES: Record<string, ModelCategory> = {
  composition: 'composition',
  llm: 'composition',
  reasoning: 'composition',
  text: 'composition',
  audio: 'audio',
  music: 'audio',
  production: 'audio',
  generation: 'audio',
  vocals: 'vocals',
  vocal: 'vocals',
  singing: 'vocals',
  voice: 'vocals',
  'voice-conversion': 'vocals',
  transcription: 'transcription',
  'audio-to-midi': 'transcription',
  separation: 'separation',
  mastering: 'mastering',
};

export function categoryFrom(value: unknown, capabilities: readonly string[] = []): ModelCategory {
  if (typeof value === 'string') {
    const hit = CATEGORY_ALIASES[value.toLowerCase()];
    if (hit) return hit;
  }
  const caps = new Set(capabilities);
  if (caps.has('SINGING_SYNTHESIS') || caps.has('VOICE_CONVERSION')) return 'vocals';
  if (caps.has('SOURCE_SEPARATION') || caps.has('VOCAL_ISOLATION')) return 'separation';
  if (caps.has('AUDIO_TRANSCRIPTION') || caps.has('AUDIO_TO_MIDI') || caps.has('PITCH_TRACKING')) return 'transcription';
  if (caps.has('MASTERING')) return 'mastering';
  if (caps.has('TEXT_TO_MUSIC') || caps.has('AUDIO_TO_AUDIO') || caps.has('STEM_GENERATION')) return 'audio';
  return 'composition';
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const trimSlash = (u: string) => u.replace(/\/+$/, '');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.:]+/g, '');

interface NormalizedModel {
  id: string;
  name: string;
  provider: string;
  version: string;
  category: ModelCategory;
  sizeGb?: number;
  license: string;
  requirements: ModelRequirements;
  capabilities: string[];
  location?: string;
  aliases: string[];
  description?: string;
  homepage?: string;
}

/** Map a manifest / bridge-info object of loosely known shape onto the model manager's fields. */
export function normalizeModelObject(raw: Record<string, unknown>): NormalizedModel {
  const reqSrc = (raw.requirements && typeof raw.requirements === 'object' ? raw.requirements : raw.hardware && typeof raw.hardware === 'object' ? raw.hardware : {}) as Record<
    string,
    unknown
  >;
  const requirements: ModelRequirements = {};
  const minVramGb = num(reqSrc.minVramGb) ?? num(reqSrc.vramGb) ?? num(reqSrc.min_vram_gb) ?? num(raw.minVramGb);
  const recommendedVramGb = num(reqSrc.recommendedVramGb) ?? num(reqSrc.recommended_vram_gb) ?? num(raw.recommendedVramGb);
  const minRamGb = num(reqSrc.minRamGb) ?? num(reqSrc.ramGb) ?? num(reqSrc.min_ram_gb) ?? num(raw.minRamGb);
  const minCpuCores = num(reqSrc.minCpuCores) ?? num(reqSrc.min_cpu_cores);
  if (minVramGb !== undefined) requirements.minVramGb = minVramGb;
  if (recommendedVramGb !== undefined) requirements.recommendedVramGb = recommendedVramGb;
  if (minRamGb !== undefined) requirements.minRamGb = minRamGb;
  if (minCpuCores !== undefined) requirements.minCpuCores = minCpuCores;
  if (typeof reqSrc.cpuOk === 'boolean') requirements.cpuOk = reqSrc.cpuOk;
  else if (typeof reqSrc.cpu_ok === 'boolean') requirements.cpuOk = reqSrc.cpu_ok;
  const capabilities = strArr(raw.capabilities);
  const sizeBytes = num(raw.sizeBytes);
  return {
    id: String(raw.id ?? raw.name ?? 'model'),
    name: String(raw.name ?? raw.id ?? 'Model'),
    provider: str(raw.provider) ?? str(raw.runtime) ?? str(raw.vendor) ?? 'local',
    version: str(raw.version) ?? 'unknown',
    category: categoryFrom(raw.category ?? raw.kind ?? raw.type, capabilities),
    sizeGb: num(raw.sizeGb) ?? num(raw.size_gb) ?? (sizeBytes !== undefined ? sizeBytes / 1024 ** 3 : undefined),
    license: str(raw.license) ?? 'unknown',
    requirements,
    capabilities,
    location: str(raw.location) ?? str(raw.url),
    aliases: [...strArr(raw.aliases), ...[raw.ollama, raw.ollamaTag, raw.catalogId].filter((x): x is string => typeof x === 'string')],
    description: str(raw.description) ?? str(raw.notes),
    homepage: str(raw.homepage),
  };
}

// ---------------------------------------------------------------------------
// Catalog (@songdeck/ai LOCAL_MODEL_CATALOG)
// ---------------------------------------------------------------------------

const RUNTIME_LABELS: Record<LocalModelEntry['runtime'], string> = {
  ollama: 'Ollama',
  'lm-studio': 'LM Studio',
  'llama.cpp': 'llama.cpp',
  'ace-step-bridge': 'ACE-Step bridge',
  'diffsinger-bridge': 'DiffSinger bridge',
  'demucs-bridge': 'Demucs bridge',
  'basic-pitch-bridge': 'Basic Pitch bridge',
  'rvc-bridge': 'RVC bridge',
  'mastering-bridge': 'Mastering bridge',
};

/** `ollama pull llama3.1:8b` → `llama3.1:8b` (the name Ollama lists once installed). */
function installAlias(entry: LocalModelEntry): string[] {
  const m = entry.install ? /^ollama\s+(?:pull|run)\s+(\S+)/.exec(entry.install.trim()) : null;
  return m ? [m[1]] : [];
}

export function catalogEntries(): LocalModelEntry[] {
  return LOCAL_MODEL_CATALOG;
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

/**
 * Classify a model whose requirements may be partially known (discovered / manifest models)
 * with the AI package's classifier. Unknown requirements → "compatible" when it is installed and
 * already being served locally.
 */
export function classifyRequirements(req: ModelRequirements, sizeGb: number | undefined, hw: HardwareInfo, installed = true): Compatibility {
  const minV = req.minVramGb;
  const minRam = req.minRamGb;
  if (minV === undefined && minRam === undefined && req.recommendedVramGb === undefined) {
    return installed
      ? { rating: 'compatible', reasons: ['Installed and served on this machine; hardware requirements are not published'] }
      : { rating: 'compatible', reasons: ['Hardware requirements are not published'] };
  }
  const minVramGb = minV ?? 0;
  const entry: LocalModelEntry = {
    id: 'discovered',
    name: 'discovered',
    category: 'composition',
    runtime: 'ollama',
    presetId: '',
    version: '',
    // Installed models need no extra disk space.
    sizeGb: installed ? 0 : (sizeGb ?? 0),
    license: '',
    requirements: {
      minVramGb,
      recommendedVramGb: req.recommendedVramGb ?? minVramGb,
      minRamGb: minRam ?? 0,
      cpuOk: req.cpuOk ?? minVramGb === 0,
      ...(req.minCpuCores !== undefined ? { minCpuCores: req.minCpuCores } : {}),
    },
    capabilities: [],
    homepage: '',
  };
  return classifyCompatibility(entry, hw);
}

/** Naive version comparison: numeric segments first, then lexicographic. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.\-+_]/);
  const pb = b.replace(/^v/i, '').split(/[.\-+_]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface Discovered {
  id: string;
  name: string;
  provider: string;
  version: string;
  category: ModelCategory;
  sizeGb?: number;
  license: string;
  requirements: ModelRequirements;
  capabilities: string[];
  location: string;
  source: ModelSource;
  via: string;
  description?: string;
  matchKeys: string[];
  /** Preset of the provider config it was discovered through (bridges). */
  presetId?: string;
  /** Directory manifests may name the catalog entry they install. */
  catalogId?: string;
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function fetchJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpStatusError(res.status);
  }
  return res.json();
}

function errorStatus(err: unknown): Pick<SourceStatus, 'status' | 'error'> {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  const code = e?.cause?.code ?? '';
  if (e?.name === 'TimeoutError' || /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET/.test(code) || /fetch failed/.test(e?.message ?? '')) {
    return { status: 'unreachable', error: code || e?.message };
  }
  return { status: 'error', error: e?.message ?? String(err) };
}

/** Capabilities of a chat model (undefined for embeddings / speech / image models). */
function llmCapabilities(id: string, parameterSize?: string, serverCaps?: string[]): string[] | undefined {
  const r = inferModelCapabilities(id, { parameterSize, serverCapabilities: serverCaps });
  return r ? [...r.capabilities] : undefined;
}

function llmRequirements(sizeGb: number | undefined): ModelRequirements {
  if (!sizeGb) return {};
  // Weights + KV cache / runtime overhead.
  const min = Math.round((sizeGb * 1.15 + 0.5) * 10) / 10;
  return { minVramGb: min, recommendedVramGb: Math.round((sizeGb * 1.4 + 1) * 10) / 10, minRamGb: Math.ceil(sizeGb + 2), cpuOk: true };
}

async function discoverOllama(fetchImpl: typeof fetch, baseUrl: string, timeoutMs: number): Promise<Discovered[]> {
  const data = (await fetchJson(fetchImpl, `${trimSlash(baseUrl)}/api/tags`, timeoutMs)) as { models?: Record<string, unknown>[] };
  const out: Discovered[] = [];
  for (const m of data.models ?? []) {
    const name = String(m.name ?? m.model ?? '');
    if (!name) continue;
    const details = (m.details ?? {}) as Record<string, unknown>;
    const caps = llmCapabilities(name, str(details.parameter_size), strArr(m.capabilities));
    if (!caps) continue;
    const sizeGb = typeof m.size === 'number' ? Math.round((m.size / 1024 ** 3) * 100) / 100 : undefined;
    const [base, tag = 'latest'] = name.split(':');
    out.push({
      id: `ollama:${name}`,
      name,
      provider: 'Ollama',
      version: tag,
      category: 'composition',
      sizeGb,
      license: 'see model card',
      requirements: llmRequirements(sizeGb),
      capabilities: caps,
      location: `${trimSlash(baseUrl)} (${name})`,
      source: 'ollama',
      via: `ollama@${trimSlash(baseUrl)}`,
      description: [str(details.family), str(details.parameter_size), str(details.quantization_level)].filter(Boolean).join(' · ') || undefined,
      matchKeys: tag === 'latest' ? [name, base] : [name],
    });
  }
  return out;
}

async function discoverOpenAICompatible(fetchImpl: typeof fetch, baseUrl: string, timeoutMs: number, label: string): Promise<Discovered[]> {
  const data = (await fetchJson(fetchImpl, `${trimSlash(baseUrl)}/models`, timeoutMs)) as { data?: Record<string, unknown>[] };
  const out: Discovered[] = [];
  for (const m of data.data ?? []) {
    const id = String(m.id ?? '');
    if (!id) continue;
    const caps = llmCapabilities(id);
    if (!caps) continue;
    out.push({
      id: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${id}`,
      name: id,
      provider: label,
      version: 'unknown',
      category: 'composition',
      license: 'see model card',
      requirements: {},
      capabilities: caps,
      location: `${trimSlash(baseUrl)} (${id})`,
      source: 'openai-compatible',
      via: `${label}@${trimSlash(baseUrl)}`,
      matchKeys: [id, id.split('/').pop() ?? id],
    });
  }
  return out;
}

const BRIDGE_CATEGORY: Record<string, ModelCategory> = {
  'local-music': 'audio',
  'singing-http': 'vocals',
  'voice-conversion-http': 'vocals',
  'transcription-http': 'transcription',
  'separation-http': 'separation',
  'mastering-http': 'mastering',
};

const BRIDGE_CAPABILITIES: Record<string, string[]> = {
  'singing-http': ['SINGING_SYNTHESIS', 'LYRIC_CONDITIONING', 'MIDI_CONDITIONING'],
  'voice-conversion-http': ['VOICE_CONVERSION'],
  'transcription-http': ['AUDIO_TRANSCRIPTION', 'AUDIO_TO_MIDI'],
  'separation-http': ['SOURCE_SEPARATION', 'VOCAL_ISOLATION'],
  'mastering-http': ['MASTERING'],
};

/**
 * Local bridge providers (contracts of @songdeck/ai): music bridges describe themselves at
 * `GET /info`; singing / voice-conversion bridges list voices at `GET /voices`; the others are
 * listed as one installed engine when they answer at all.
 */
async function discoverBridge(fetchImpl: typeof fetch, config: StoredProviderConfig, timeoutMs: number): Promise<Discovered[]> {
  const base = trimSlash(config.baseUrl);
  const fallbackCategory = BRIDGE_CATEGORY[config.adapter] ?? 'audio';
  const presetId = typeof config.presetId === 'string' ? config.presetId : undefined;
  const entry = (raw: Record<string, unknown>, extra: Partial<Discovered> = {}): Discovered => {
    const n = normalizeModelObject(raw);
    const hasCategory = raw.category ?? raw.kind ?? raw.type;
    const capabilities = n.capabilities.length ? n.capabilities : (BRIDGE_CAPABILITIES[config.adapter] ?? []);
    return {
      id: `${config.id}:${n.id}`,
      name: n.name,
      provider: config.name,
      version: n.version,
      category: hasCategory ? n.category : BRIDGE_CATEGORY[config.adapter] ? fallbackCategory : categoryFrom(undefined, capabilities),
      sizeGb: n.sizeGb,
      license: n.license,
      requirements: n.requirements,
      capabilities,
      location: base,
      source: 'bridge',
      via: `provider:${config.id}`,
      description: n.description,
      matchKeys: [n.id, n.name, ...n.aliases],
      ...(presetId ? { presetId } : {}),
      ...extra,
    };
  };
  let info: Record<string, unknown> | undefined;
  let reachable = false;
  try {
    info = (await fetchJson(fetchImpl, `${base}/info`, timeoutMs)) as Record<string, unknown>;
    reachable = true;
  } catch (err) {
    if (!(err instanceof HttpStatusError)) throw err;
    reachable = true; // the bridge answered, it just has no /info
  }
  if (info && typeof info === 'object') {
    const shared = { version: info.version, capabilities: info.capabilities, hardware: info.hardware };
    const models = Array.isArray(info.models) && info.models.length ? (info.models as Record<string, unknown>[]) : [{ id: info.name ?? config.id, name: info.name ?? config.name }];
    return models.filter((m) => m && typeof m === 'object').map((m) => entry({ ...shared, ...m }));
  }
  if (config.adapter === 'singing-http' || config.adapter === 'voice-conversion-http') {
    try {
      const data = (await fetchJson(fetchImpl, `${base}/voices`, timeoutMs)) as unknown;
      const voices = (Array.isArray(data) ? data : ((data as { voices?: unknown[] })?.voices ?? [])) as Record<string, unknown>[];
      if (voices.length) {
        return voices
          .filter((v) => v && typeof v.id === 'string')
          .map((v) =>
            entry(
              { id: v.id, name: v.name ?? v.id, license: v.kind === 'stock' ? 'stock voice' : 'see voice consent' },
              { description: [v.voice_type, v.language, v.kind].filter((x) => typeof x === 'string').join(' · ') || undefined },
            ),
          );
      }
    } catch {
      /* fall through to a single engine entry */
    }
  }
  return reachable ? [entry({ id: 'engine', name: config.name })] : [];
}

async function dirSizeGb(dir: string, budget = { files: 5000 }): Promise<number> {
  let total = 0;
  const walk = async (d: string, depth: number) => {
    if (depth > 6 || budget.files <= 0) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget.files-- <= 0) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir, 0);
  return Math.round((total / 1024 ** 3) * 100) / 100;
}

/** `<dataDir>/models/<dir>/model.json` manifests (a directory named after a catalog id installs it). */
async function discoverDirectory(modelsDir: string): Promise<{ models: Discovered[]; errors: string[] }> {
  const models: Discovered[] = [];
  const errors: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(modelsDir, { withFileTypes: true });
  } catch {
    return { models, errors };
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(modelsDir, e.name);
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(dir, 'model.json'), 'utf8')) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${e.name}/model.json: ${(err as Error).message}`);
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      errors.push(`${e.name}/model.json: not an object`);
      continue;
    }
    const n = normalizeModelObject({ id: e.name, ...manifest });
    models.push({
      id: n.id,
      name: n.name,
      provider: n.provider,
      version: n.version,
      category: n.category,
      sizeGb: n.sizeGb ?? (await dirSizeGb(dir)),
      license: n.license,
      requirements: n.requirements,
      capabilities: n.capabilities,
      location: dir,
      source: 'directory',
      via: 'models-dir',
      description: n.description,
      matchKeys: [n.id, n.name, e.name, ...n.aliases],
      ...(typeof manifest.catalogId === 'string' ? { catalogId: manifest.catalogId } : {}),
    });
  }
  return { models, errors };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface ModelManagerOptions {
  dataDir: string;
  hardware: HardwareService;
  providers: ProviderStore;
  ollamaUrl: string | false;
  lmStudioUrl: string | false;
  timeoutMs: number;
  fetch: typeof fetch;
  logger: Logger;
  /** Reuse a scan for this long (default 30 s); POST /api/models/rescan forces a new one. */
  cacheMs?: number;
}

const RANK: Record<CompatibilityRating, number> = { excellent: 0, compatible: 1, slow: 2, insufficient: 3 };

export class ModelManager {
  private cached?: { at: number; report: ModelsReport };
  private inflight?: Promise<ModelsReport>;

  constructor(private readonly opts: ModelManagerOptions) {}

  async get(force = false): Promise<ModelsReport> {
    if (!force && this.cached && Date.now() - this.cached.at < (this.opts.cacheMs ?? 30_000)) return this.cached.report;
    if (this.inflight) return this.inflight;
    this.inflight = this.scan().finally(() => {
      this.inflight = undefined;
    });
    const report = await this.inflight;
    this.cached = { at: Date.now(), report };
    return report;
  }

  private async discover(): Promise<{ discovered: Discovered[]; sources: SourceStatus[] }> {
    const { fetch: fetchImpl, timeoutMs } = this.opts;
    const sources: SourceStatus[] = [];
    const tasks: Promise<Discovered[]>[] = [];
    const track = (source: string, url: string | undefined, p: Promise<Discovered[]>) =>
      tasks.push(
        p.then(
          (models) => {
            sources.push({ source, ...(url ? { url } : {}), status: 'ok', count: models.length });
            return models;
          },
          (err) => {
            sources.push({ source, ...(url ? { url } : {}), count: 0, ...errorStatus(err) });
            return [];
          },
        ),
      );

    const ollamaUrls = new Set<string>();
    const openaiUrls = new Map<string, string>();
    if (this.opts.ollamaUrl) ollamaUrls.add(trimSlash(this.opts.ollamaUrl));
    else sources.push({ source: 'ollama', status: 'disabled', count: 0 });
    if (this.opts.lmStudioUrl) openaiUrls.set(trimSlash(this.opts.lmStudioUrl), 'LM Studio');
    else sources.push({ source: 'lm-studio', status: 'disabled', count: 0 });

    for (const c of this.opts.providers.list()) {
      if (c.location !== 'local' || !c.baseUrl || !/^https?:\/\//.test(c.baseUrl) || c.enabled === false) continue;
      // Local providers that need a key are skipped: discovery never touches the vault.
      if (c.auth?.type && c.auth.type !== 'none') continue;
      if (c.adapter === 'ollama') ollamaUrls.add(trimSlash(c.baseUrl).replace(/\/(api|v1)$/, ''));
      else if (c.adapter === 'openai-compatible') {
        if (!openaiUrls.has(trimSlash(c.baseUrl))) openaiUrls.set(trimSlash(c.baseUrl), c.name);
      } else if (BRIDGE_CATEGORY[c.adapter]) {
        track(`provider:${c.id}`, trimSlash(c.baseUrl), discoverBridge(fetchImpl, c, timeoutMs));
      }
    }
    for (const u of ollamaUrls) track('ollama', `${u}/api/tags`, discoverOllama(fetchImpl, u, timeoutMs));
    for (const [u, label] of openaiUrls) track(label === 'LM Studio' ? 'lm-studio' : `openai-compatible:${label}`, `${u}/models`, discoverOpenAICompatible(fetchImpl, u, timeoutMs, label));
    const modelsDir = path.join(this.opts.dataDir, 'models');
    tasks.push(
      discoverDirectory(modelsDir).then(({ models, errors }) => {
        sources.push({ source: 'models-dir', url: modelsDir, status: errors.length ? 'error' : 'ok', count: models.length, ...(errors.length ? { error: errors.join('; ') } : {}) });
        return models;
      }),
    );
    const discovered = (await Promise.all(tasks)).flat();
    return { discovered, sources };
  }

  private async scan(): Promise<ModelsReport> {
    const [hw, { discovered, sources }] = await Promise.all([this.opts.hardware.get(), this.discover()]);
    const catalog = catalogEntries();
    const entries: ModelEntry[] = [];
    const claimed = new Set<Discovered>();

    // Installed models attach to catalog entries (by catalog id, name, install alias, or a
    // provider preset that serves exactly one catalog model); the rest are listed on their own.
    const presetCounts = new Map<string, number>();
    for (const item of catalog) presetCounts.set(item.presetId, (presetCounts.get(item.presetId) ?? 0) + 1);
    for (const item of catalog) {
      const keys = new Set([item.id, item.name, ...installAlias(item)].map(norm));
      const hits = discovered.filter(
        (d) =>
          d.catalogId === item.id ||
          d.matchKeys.some((k) => keys.has(norm(k))) ||
          (d.presetId !== undefined && d.presetId === item.presetId && presetCounts.get(item.presetId) === 1 && !discovered.some((o) => o !== d && o.via === d.via && o.matchKeys.some((k) => keys.has(norm(k))))),
      );
      for (const h of hits) claimed.add(h);
      const installed = hits.length > 0;
      const installedVersion = hits.find((h) => h.source === 'directory' && h.version !== 'unknown')?.version;
      let updateStatus: UpdateStatus = installed ? 'unknown' : 'not-installed';
      if (installedVersion) updateStatus = compareVersions(installedVersion, item.version) < 0 ? 'update-available' : 'up-to-date';
      entries.push({
        id: item.id,
        name: item.name,
        category: categoryFrom(item.category),
        provider: RUNTIME_LABELS[item.runtime] ?? item.runtime,
        version: item.version,
        sizeGb: item.sizeGb,
        license: item.license,
        requirements: { ...item.requirements },
        capabilities: [...item.capabilities],
        location: installed ? hits[0].location : item.homepage,
        installed,
        ...(installedVersion ? { installedVersion } : {}),
        updateStatus,
        // Installed models need no further disk space.
        compatibility: classifyCompatibility(installed ? { ...item, sizeGb: 0, quantizations: item.quantizations?.map((q) => ({ ...q, sizeGb: 0 })) } : item, hw),
        source: 'catalog',
        ...(item.notes ? { description: item.notes } : {}),
        homepage: item.homepage,
        ...(item.install ? { install: item.install } : {}),
        presetId: item.presetId,
        ...(item.quantizations ? { quantizations: item.quantizations } : {}),
        ...(installed ? { installedVia: [...new Set(hits.map((h) => h.via))] } : {}),
      });
    }
    const seen = new Set(entries.map((e) => e.id));
    for (const d of discovered) {
      if (claimed.has(d) || seen.has(d.id)) continue;
      seen.add(d.id);
      entries.push({
        id: d.id,
        name: d.name,
        category: d.category,
        provider: d.provider,
        version: d.version,
        ...(d.sizeGb !== undefined ? { sizeGb: d.sizeGb } : {}),
        license: d.license,
        requirements: d.requirements,
        capabilities: d.capabilities,
        location: d.location,
        installed: true,
        updateStatus: 'unknown',
        compatibility: classifyRequirements(d.requirements, d.sizeGb, hw, true),
        source: d.source,
        ...(d.description ? { description: d.description } : {}),
        ...(d.presetId ? { presetId: d.presetId } : {}),
        installedVia: [d.via],
      });
    }
    return {
      categories: MODEL_CATEGORIES.map((c) => ({
        ...c,
        models: entries
          .filter((e) => e.category === c.id)
          .sort((a, b) => Number(b.installed) - Number(a.installed) || RANK[a.compatibility.rating] - RANK[b.compatibility.rating] || a.name.localeCompare(b.name)),
      })),
      sources: sources.sort((a, b) => a.source.localeCompare(b.source)),
      hardware: {
        gpus: hw.gpus,
        ramGb: hw.ramGb,
        storageFreeGb: hw.storageFreeGb,
        backends: hw.backends,
        accelerationBackends: hw.accelerationBackends,
        ...(hw.unifiedMemory ? { unifiedMemory: true } : {}),
      },
      scannedAt: new Date().toISOString(),
    };
  }
}

export function registerModelRoutes(router: Router, manager: ModelManager): void {
  router.get('/api/models', async ({ res, url }) => {
    sendJson(res, 200, await manager.get(url.searchParams.get('refresh') === '1'));
  });
  router.post('/api/models/rescan', async ({ res }) => {
    sendJson(res, 200, await manager.get(true));
  });
}
