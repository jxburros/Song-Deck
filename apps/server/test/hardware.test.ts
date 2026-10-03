import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyCompatibility, LOCAL_MODEL_CATALOG } from '@songdeck/ai';
import {
  type CommandRunner,
  detectHardware,
  linuxSysfsGpus,
  parseNvidiaSmi,
  parseRocmSmi,
  parseSystemProfiler,
  parseWindowsVideoControllers,
} from '../src/hardware';
import { json, startServer, tempDir, type TestServer } from './helpers';

let srv: TestServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const missing: CommandRunner = async () => {
  const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
};

describe('hardware detection', () => {
  it('GET /api/hardware returns the HardwareInfo shape', async () => {
    srv = await startServer();
    const res = await fetch(`${srv.url}/api/hardware`);
    expect(res.status).toBe(200);
    const hw = await json(res);
    expect(hw).toMatchObject({
      cpu: { model: expect.any(String), cores: expect.any(Number), threads: expect.any(Number) },
      ramGb: expect.any(Number),
      freeRamGb: expect.any(Number),
      gpus: expect.any(Array),
      storageFreeGb: expect.any(Number),
      platform: process.platform,
      arch: process.arch,
    });
    expect(hw.cpu.threads).toBeGreaterThan(0);
    expect(hw.ramGb).toBeGreaterThan(0);
    expect(hw.accelerationBackends).toContain('cpu');
    expect(hw.backends).toEqual(hw.accelerationBackends);
    for (const g of hw.gpus) {
      expect(['nvidia', 'amd', 'apple', 'intel', 'other']).toContain(g.vendor);
      if (g.backend !== undefined) expect(['cuda', 'rocm', 'metal', 'vulkan', 'directml']).toContain(g.backend);
    }
    // The response is directly usable with @songdeck/ai's classifier.
    for (const m of LOCAL_MODEL_CATALOG) expect(['excellent', 'compatible', 'slow', 'insufficient']).toContain(classifyCompatibility(m, hw).rating);
    // Cached: a second call returns the same detection.
    const again = await json(await fetch(`${srv.url}/api/hardware`));
    expect(again.detectedAt).toBe(hw.detectedAt);
    const refreshed = await json(await fetch(`${srv.url}/api/hardware?refresh=1`));
    expect(refreshed.detectedAt >= hw.detectedAt).toBe(true);
  });

  it('never throws when no GPU tools exist', async () => {
    const d = tempDir();
    dirs.push(d);
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const hw = await detectHardware({ dataDir: d, run: missing, platform, sysfsRoot: path.join(d, 'no-sysfs') });
      expect(hw.gpus).toEqual([]);
      expect(hw.accelerationBackends).toEqual(['cpu']);
      expect(hw.backends).toEqual(['cpu']);
      expect(hw.storageFreeGb).toBeGreaterThan(0);
    }
  });

  it('survives garbage and failing tool output', async () => {
    const d = tempDir();
    dirs.push(d);
    const garbage: CommandRunner = async () => ({ stdout: '}{ not json, at all', code: 0 });
    const failing: CommandRunner = async () => ({ stdout: '', code: 9 });
    for (const run of [garbage, failing]) {
      for (const platform of ['linux', 'darwin', 'win32'] as const) {
        const hw = await detectHardware({ dataDir: d, run, platform, sysfsRoot: path.join(d, 'none') });
        expect(Array.isArray(hw.gpus)).toBe(true);
      }
    }
  });

  it('uses nvidia-smi output', async () => {
    const d = tempDir();
    dirs.push(d);
    const run: CommandRunner = async (cmd) => {
      if (cmd === 'nvidia-smi') return { stdout: 'NVIDIA GeForce RTX 4090, 24564, 550.54.14\nNVIDIA RTX A2000, 6138, 550.54.14\n', code: 0 };
      return missing(cmd, [], { timeoutMs: 1 });
    };
    const hw = await detectHardware({ dataDir: d, run, platform: 'linux', sysfsRoot: path.join(d, 'none') });
    expect(hw.gpus).toEqual([
      { name: 'NVIDIA GeForce RTX 4090', vendor: 'nvidia', vramGb: 24, driver: '550.54.14', backend: 'cuda' },
      { name: 'NVIDIA RTX A2000', vendor: 'nvidia', vramGb: 6, driver: '550.54.14', backend: 'cuda' },
    ]);
    expect(hw.accelerationBackends).toEqual(['cuda', 'cpu']);
    expect(hw.backends).toEqual(['cuda', 'cpu']);
    const llama = LOCAL_MODEL_CATALOG.find((m) => m.id === 'llama-3.1-8b-instruct');
    if (llama) expect(classifyCompatibility(llama, hw).rating).toBe('excellent');
  });
});

describe('vendor tool parsers', () => {
  it('parses nvidia-smi CSV', () => {
    expect(parseNvidiaSmi('Tesla T4, 15360, 535.104.05')).toEqual([{ name: 'Tesla T4', vendor: 'nvidia', vramGb: 15, driver: '535.104.05', backend: 'cuda' }]);
    expect(parseNvidiaSmi('')).toEqual([]);
  });

  it('parses rocm-smi JSON across key spellings', () => {
    const out = parseRocmSmi(
      JSON.stringify({
        card0: { 'Card series': 'Radeon RX 7900 XTX', 'VRAM Total Memory (B)': String(24 * 1024 ** 3), 'VRAM Total Used Memory (B)': '0' },
        card1: { 'Card Series': 'AMD Instinct MI210', 'VRAM Total Memory (B)': String(64 * 1024 ** 3) },
        system: { 'Driver version': '6.7' },
      }),
    );
    expect(out).toEqual([
      { name: 'Radeon RX 7900 XTX', vendor: 'amd', vramGb: 24, backend: 'rocm' },
      { name: 'AMD Instinct MI210', vendor: 'amd', vramGb: 64, backend: 'rocm' },
    ]);
    expect(parseRocmSmi('not json')).toEqual([]);
  });

  it('parses system_profiler JSON (Apple Silicon unified memory and discrete GPUs)', async () => {
    const apple = parseSystemProfiler(
      JSON.stringify({ SPDisplaysDataType: [{ _name: 'Apple M2 Pro', sppci_model: 'Apple M2 Pro', sppci_vendor: 'sppci_vendor_Apple', spdisplays_mtlgpufamilysupport: 'spdisplays_metal3', sppci_cores: '19' }] }),
    );
    // @songdeck/ai convention: Apple Silicon reports 0 dedicated VRAM; usable memory derives from RAM.
    expect(apple).toEqual([{ name: 'Apple M2 Pro', vendor: 'apple', vramGb: 0, backend: 'metal', unifiedMemory: true }]);
    const amd = parseSystemProfiler(
      JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'AMD Radeon Pro 5500M', spdisplays_vram: '8 GB', sppci_vendor: 'sppci_vendor_amd', spdisplays_mtlgpufamilysupport: 'spdisplays_metal2' }] }),
    );
    expect(amd).toEqual([{ name: 'AMD Radeon Pro 5500M', vendor: 'amd', vramGb: 8, backend: 'metal' }]);
    const d = tempDir();
    dirs.push(d);
    const run: CommandRunner = async (cmd) => {
      if (cmd === 'system_profiler') return { stdout: JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M3 Max', sppci_vendor: 'sppci_vendor_Apple' }] }), code: 0 };
      return missing(cmd, [], { timeoutMs: 1 });
    };
    const hw = await detectHardware({ dataDir: d, run, platform: 'darwin' });
    expect(hw.unifiedMemory).toBe(true);
    expect(hw.backends).toEqual(['metal', 'cpu']);
  });

  it('parses Win32_VideoController JSON (object or array) and skips virtual adapters', () => {
    const one = parseWindowsVideoControllers(JSON.stringify({ Name: 'AMD Radeon RX 6800', AdapterRAM: 4293918720, DriverVersion: '31.0.21', AdapterCompatibility: 'Advanced Micro Devices, Inc.' }));
    expect(one).toEqual([{ name: 'AMD Radeon RX 6800', vendor: 'amd', vramGb: 4, driver: '31.0.21', backend: 'directml' }]);
    const many = parseWindowsVideoControllers(
      JSON.stringify([
        { Name: 'Microsoft Basic Display Adapter', AdapterRAM: 0 },
        { Name: 'Intel(R) UHD Graphics 770', AdapterRAM: 1073741824, AdapterCompatibility: 'Intel Corporation' },
      ]),
    );
    expect(many).toEqual([{ name: 'Intel(R) UHD Graphics 770', vendor: 'intel', vramGb: 1, backend: 'directml' }]);
  });

  it('falls back to sysfs PCI ids on Linux', async () => {
    const root = tempDir();
    dirs.push(root);
    const card = (name: string, vendor: string, device: string, vram?: number) => {
      const dev = path.join(root, name, 'device');
      mkdirSync(dev, { recursive: true });
      writeFileSync(path.join(dev, 'vendor'), `${vendor}\n`);
      writeFileSync(path.join(dev, 'device'), `${device}\n`);
      if (vram) writeFileSync(path.join(dev, 'mem_info_vram_total'), `${vram}\n`);
    };
    card('card0', '0x1002', '0x744c', 20 * 1024 ** 3);
    card('card1', '0x8086', '0x4680');
    mkdirSync(path.join(root, 'card0-DP-1'));
    const gpus = await linuxSysfsGpus(root);
    expect(gpus).toEqual([
      { name: 'AMD Radeon GPU (0x744c)', vendor: 'amd', vramGb: 20, backend: 'vulkan' },
      { name: 'Intel GPU (0x4680)', vendor: 'intel', vramGb: 0, backend: 'vulkan', unifiedMemory: true },
    ]);
  });
});
