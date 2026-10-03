/**
 * Local hardware awareness (spec §61): GPU, VRAM, RAM, CPU, free storage and acceleration
 * backends, used by the model manager to classify local models (Excellent / Compatible / Slow /
 * Insufficient). Detection shells out to vendor tools with short timeouts; every failure simply
 * yields fewer GPUs — detection never throws.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccelerationBackend, GpuInfo as AiGpuInfo, GpuVendor, HardwareInfo as AiHardwareInfo } from '@songdeck/ai';
import type { Router } from './router';
import { sendJson } from './http-util';

export type { AccelerationBackend, GpuVendor };

/**
 * `@songdeck/ai` GpuInfo plus the driver version. `backend` is omitted for a GPU without a usable
 * acceleration backend. Apple Silicon reports `vramGb: 0` with `unifiedMemory` (the AI package
 * derives usable GPU memory from system RAM, spec §61).
 */
export interface GpuInfo extends AiGpuInfo {
  driver?: string;
  /** Shares system memory (Apple Silicon, integrated GPUs). */
  unifiedMemory?: boolean;
}

/**
 * `@songdeck/ai` HardwareInfo (accepted by `classifyCompatibility`) plus free RAM, platform and
 * a timestamp. `accelerationBackends` mirrors `backends`.
 */
export interface HardwareInfo extends AiHardwareInfo {
  cpu: { model: string; cores: number; threads: number };
  gpus: GpuInfo[];
  freeRamGb: number;
  storageFreeGb: number;
  accelerationBackends: AccelerationBackend[];
  platform: string;
  arch: string;
  os: string;
  detectedAt: string;
}

export interface CommandResult {
  stdout: string;
  code: number;
}

export type CommandRunner = (command: string, args: string[], opts: { timeoutMs: number }) => Promise<CommandResult>;

const GB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;

export const defaultRunner: CommandRunner = (command, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(err);
        return;
      }
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : 1) : 0;
      resolve({ stdout: String(stdout ?? ''), code });
    });
  });

async function tryRun(run: CommandRunner, command: string, args: string[], timeoutMs = 4000): Promise<string | undefined> {
  try {
    const { stdout, code } = await run(command, args, { timeoutMs });
    return code === 0 && stdout.trim() ? stdout : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Parsers (exported for tests)
// ---------------------------------------------------------------------------

/** `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits` */
export function parseNvidiaSmi(stdout: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 2) continue;
    const [name, memMiB, driver] = parts;
    const mib = Number(memMiB);
    gpus.push({
      name: name || 'NVIDIA GPU',
      vendor: 'nvidia',
      vramGb: Number.isFinite(mib) ? round1(mib / 1024) : 0,
      ...(driver ? { driver } : {}),
      backend: 'cuda',
    });
  }
  return gpus;
}

function vendorOf(text: string): GpuVendor {
  const t = text.toLowerCase();
  if (/nvidia|geforce|quadro|tesla/.test(t)) return 'nvidia';
  if (/\bamd\b|advanced micro|radeon|\bati\b|instinct/.test(t)) return 'amd';
  if (/apple/.test(t)) return 'apple';
  if (/intel/.test(t)) return 'intel';
  return 'other';
}

/** `rocm-smi --showproductname --showmeminfo vram --json` (key names vary across ROCm versions). */
export function parseRocmSmi(stdout: string): GpuInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const gpus: GpuInfo[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!/^card\d+/i.test(key) || !value || typeof value !== 'object') continue;
    const card = value as Record<string, unknown>;
    const pick = (...names: string[]) => {
      for (const n of names) {
        const hit = Object.keys(card).find((k) => k.toLowerCase() === n.toLowerCase());
        if (hit && typeof card[hit] === 'string' && (card[hit] as string).trim()) return (card[hit] as string).trim();
      }
      return undefined;
    };
    const name = pick('Card Series', 'Card series', 'Marketing Name', 'Card Model', 'Card model', 'Device Name', 'Card SKU') ?? 'AMD GPU';
    const totalBytes = Number(pick('VRAM Total Memory (B)', 'vram total memory (b)'));
    gpus.push({
      name,
      vendor: 'amd',
      vramGb: Number.isFinite(totalBytes) && totalBytes > 0 ? round1(totalBytes / GB) : 0,
      ...(pick('Driver version') ? { driver: pick('Driver version') } : {}),
      backend: 'rocm',
    });
  }
  return gpus;
}

function parseSizeGb(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined;
  const m = /([\d.]+)\s*(GB|MB|TB)/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2].toUpperCase();
  return round1(unit === 'TB' ? n * 1024 : unit === 'MB' ? n / 1024 : n);
}

/** `system_profiler SPDisplaysDataType -json` (macOS). Apple Silicon → Metal with unified memory. */
export function parseSystemProfiler(stdout: string): GpuInfo[] {
  let data: { SPDisplaysDataType?: Record<string, unknown>[] };
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const gpus: GpuInfo[] = [];
  for (const d of data.SPDisplaysDataType ?? []) {
    const name = String(d.sppci_model ?? d._name ?? 'GPU');
    const vendorRaw = String(d.sppci_vendor ?? d.spdisplays_vendor ?? '').replace(/^sppci_vendor_/, '');
    const apple = /apple/i.test(vendorRaw) || /^apple /i.test(name);
    const vendor: GpuVendor = apple ? 'apple' : vendorOf(`${vendorRaw} ${name}`);
    const vram = parseSizeGb(d.spdisplays_vram) ?? parseSizeGb(d._spdisplays_vram);
    const metal = d.spdisplays_mtlgpufamilysupport !== undefined || d.spdisplays_metal !== undefined || apple;
    gpus.push({
      name,
      vendor,
      vramGb: apple ? 0 : (vram ?? 0),
      ...(metal ? { backend: 'metal' as const } : {}),
      ...(apple || (!vram && parseSizeGb(d.spdisplays_vram_shared) !== undefined) ? { unifiedMemory: true } : {}),
    });
  }
  return gpus;
}

/** `Get-CimInstance Win32_VideoController | ConvertTo-Json` (Windows). */
export function parseWindowsVideoControllers(stdout: string): GpuInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const list = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
  const gpus: GpuInfo[] = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const name = String(c.Name ?? c.Caption ?? '').trim();
    if (!name || /basic (display|render)|remote display|virtual|parsec|mirage/i.test(name)) continue;
    const vendor = vendorOf(`${String(c.AdapterCompatibility ?? '')} ${name}`);
    const ram = Number(c.AdapterRAM);
    gpus.push({
      name,
      vendor,
      // AdapterRAM is a uint32 and saturates at 4 GB; nvidia-smi (when present) replaces NVIDIA entries.
      vramGb: Number.isFinite(ram) && ram > 0 ? round1(ram / GB) : 0,
      ...(c.DriverVersion ? { driver: String(c.DriverVersion) } : {}),
      backend: 'directml',
    });
  }
  return gpus;
}

const PCI_VENDORS: Record<string, { vendor: GpuVendor; label: string; backend: AccelerationBackend }> = {
  '0x10de': { vendor: 'nvidia', label: 'NVIDIA GPU', backend: 'vulkan' },
  '0x1002': { vendor: 'amd', label: 'AMD Radeon GPU', backend: 'vulkan' },
  '0x8086': { vendor: 'intel', label: 'Intel GPU', backend: 'vulkan' },
};

/** Linux fallback without vendor tools: PCI ids (and amdgpu VRAM size) from sysfs. */
export async function linuxSysfsGpus(root = '/sys/class/drm'): Promise<GpuInfo[]> {
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return [];
  }
  const gpus: GpuInfo[] = [];
  for (const card of names.filter((n) => /^card\d+$/.test(n)).sort()) {
    const dev = path.join(root, card, 'device');
    const vendorId = (await fsp.readFile(path.join(dev, 'vendor'), 'utf8').catch(() => '')).trim().toLowerCase();
    const info = PCI_VENDORS[vendorId];
    if (!info) continue;
    const deviceId = (await fsp.readFile(path.join(dev, 'device'), 'utf8').catch(() => '')).trim();
    const vramBytes = Number((await fsp.readFile(path.join(dev, 'mem_info_vram_total'), 'utf8').catch(() => '')).trim());
    gpus.push({
      name: deviceId ? `${info.label} (${deviceId})` : info.label,
      vendor: info.vendor,
      vramGb: Number.isFinite(vramBytes) && vramBytes > 0 ? round1(vramBytes / GB) : 0,
      backend: info.backend,
      ...(info.vendor === 'intel' ? { unifiedMemory: true } : {}),
    });
  }
  return gpus;
}

async function physicalCores(run: CommandRunner, platform: NodeJS.Platform, threads: number): Promise<number> {
  try {
    if (platform === 'linux') {
      const text = await fsp.readFile('/proc/cpuinfo', 'utf8');
      const pairs = new Set<string>();
      let phys = '0';
      for (const line of text.split('\n')) {
        const [k, v] = line.split(':').map((s) => s?.trim());
        if (k === 'physical id') phys = v ?? '0';
        else if (k === 'core id') pairs.add(`${phys}:${v}`);
      }
      if (pairs.size) return pairs.size;
    } else if (platform === 'darwin') {
      const out = await tryRun(run, 'sysctl', ['-n', 'hw.physicalcpu'], 2000);
      const n = Number(out?.trim());
      if (n > 0) return n;
    }
  } catch {
    /* fall through */
  }
  return threads;
}

export interface DetectOptions {
  dataDir: string;
  run?: CommandRunner;
  platform?: NodeJS.Platform;
  sysfsRoot?: string;
}

export async function detectGpus(run: CommandRunner, platform: NodeJS.Platform, sysfsRoot?: string): Promise<GpuInfo[]> {
  const gpus: GpuInfo[] = [];
  const nvidia = await tryRun(run, 'nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (nvidia) gpus.push(...parseNvidiaSmi(nvidia));
  if (platform === 'linux') {
    const rocm = await tryRun(run, 'rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json']);
    if (rocm) gpus.push(...parseRocmSmi(rocm));
    if (!gpus.length) gpus.push(...(await linuxSysfsGpus(sysfsRoot)));
  } else if (platform === 'darwin') {
    const sp = await tryRun(run, 'system_profiler', ['SPDisplaysDataType', '-json'], 8000);
    if (sp) gpus.push(...parseSystemProfiler(sp));
  } else if (platform === 'win32') {
    const ps = await tryRun(
      run,
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,AdapterCompatibility | ConvertTo-Json -Compress',
      ],
      8000,
    );
    if (ps) {
      const hasNvidiaSmi = gpus.some((g) => g.vendor === 'nvidia');
      for (const g of parseWindowsVideoControllers(ps)) {
        if (hasNvidiaSmi && g.vendor === 'nvidia') continue; // nvidia-smi has the accurate VRAM
        gpus.push(g);
      }
    }
  }
  return gpus;
}

export async function detectHardware(opts: DetectOptions): Promise<HardwareInfo> {
  const run = opts.run ?? defaultRunner;
  const platform = opts.platform ?? process.platform;
  const cpus = os.cpus();
  const threads = Math.max(1, cpus.length || os.availableParallelism?.() || 1);
  const ramGb = round1(os.totalmem() / GB);
  const [gpus, cores, storageFreeGb] = await Promise.all([
    detectGpus(run, platform, opts.sysfsRoot).catch(() => [] as GpuInfo[]),
    physicalCores(run, platform, threads).catch(() => threads),
    fsp
      .mkdir(opts.dataDir, { recursive: true })
      .then(() => fsp.statfs(opts.dataDir))
      .then((s) => round1((Number(s.bavail) * Number(s.bsize)) / GB))
      .catch(() => 0),
  ]);
  const backends: AccelerationBackend[] = [];
  for (const g of gpus) if (g.backend && !backends.includes(g.backend)) backends.push(g.backend);
  backends.push('cpu');
  const unified = gpus.some((g) => g.vendor === 'apple');
  return {
    cpu: { model: (cpus[0]?.model ?? 'Unknown CPU').trim(), cores, threads },
    ramGb,
    freeRamGb: round1(os.freemem() / GB),
    gpus,
    storageFreeGb,
    backends,
    accelerationBackends: [...backends],
    ...(unified ? { unifiedMemory: true } : {}),
    platform,
    arch: process.arch,
    os: `${platform} ${os.release()}`,
    detectedAt: new Date().toISOString(),
  };
}

/** Cached detection (default 60 s) with in-flight de-duplication. */
export class HardwareService {
  private cached?: { at: number; info: HardwareInfo };
  private inflight?: Promise<HardwareInfo>;

  constructor(
    private readonly opts: { dataDir: string; detect?: () => Promise<HardwareInfo>; run?: CommandRunner; cacheMs: number },
  ) {}

  async get(force = false): Promise<HardwareInfo> {
    if (!force && this.cached && Date.now() - this.cached.at < this.opts.cacheMs) {
      // RAM usage changes quickly; refresh the cheap fields on every call.
      return { ...this.cached.info, freeRamGb: round1(os.freemem() / GB) };
    }
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const info = this.opts.detect ? await this.opts.detect() : await detectHardware({ dataDir: this.opts.dataDir, run: this.opts.run });
        this.cached = { at: Date.now(), info };
        return info;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}

export function registerHardwareRoutes(router: Router, service: HardwareService): void {
  router.get('/api/hardware', async ({ res, url }) => {
    const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
    sendJson(res, 200, await service.get(force));
  });
}
