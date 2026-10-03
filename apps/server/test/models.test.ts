import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HardwareInfo } from '../src/hardware';
import { LOCAL_MODEL_CATALOG } from '@songdeck/ai';
import { classifyRequirements, compareVersions, type ModelEntry } from '../src/models';
import { json, startMock, startServer, type MockServer, type TestServer } from './helpers';

let srv: TestServer | undefined;
const mocks: MockServer[] = [];
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  for (const m of mocks.splice(0)) await m.close();
});

const HW: HardwareInfo = {
  cpu: { model: 'Test CPU', cores: 8, threads: 16 },
  ramGb: 32,
  freeRamGb: 20,
  gpus: [{ name: 'Test GPU', vendor: 'nvidia', vramGb: 8, backend: 'cuda' }],
  storageFreeGb: 500,
  backends: ['cuda', 'cpu'],
  accelerationBackends: ['cuda', 'cpu'],
  platform: 'linux',
  arch: 'x64',
  os: 'linux test',
  detectedAt: '2026-01-01T00:00:00.000Z',
};

const allModels = (report: { categories: { models: ModelEntry[] }[] }) => report.categories.flatMap((c) => c.models);

describe('model manager', () => {
  it('merges the catalog with models discovered from a (mock) Ollama server', async () => {
    const ollama = await startMock((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              { name: 'llama3.1:8b', model: 'llama3.1:8b', size: 4.9 * 1024 ** 3, details: { family: 'llama', parameter_size: '8.0B', quantization_level: 'Q4_K_M' } },
              { name: 'qwen2.5:72b', model: 'qwen2.5:72b', size: 47 * 1024 ** 3, details: { family: 'qwen2', parameter_size: '72.7B', quantization_level: 'Q4_K_M' } },
              { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', size: 274302450, details: { family: 'nomic-bert' } },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    mocks.push(ollama);
    srv = await startServer({ discovery: { ollamaUrl: ollama.url, lmStudioUrl: false }, hardware: { detect: async () => HW } });
    const res = await fetch(`${srv.url}/api/models`);
    expect(res.status).toBe(200);
    const report = await json(res);
    expect(report.categories.map((c: { id: string }) => c.id)).toEqual(['composition', 'audio', 'vocals', 'transcription', 'separation', 'mastering']);
    expect(report.categories.map((c: { label: string }) => c.label)).toEqual(['Composition', 'Audio', 'Vocals', 'Transcription', 'Separation', 'Mastering']);
    const models = allModels(report);
    // llama3.1:8b is in the catalog (install alias "ollama pull llama3.1:8b"): the catalog entry is marked installed.
    const llama = models.find((m) => m.id === 'llama-3.1-8b-instruct');
    expect(llama).toMatchObject({ installed: true, source: 'catalog', category: 'composition', installedVia: [`ollama@${ollama.url}`], compatibility: { rating: 'excellent' } });
    expect(models.some((m) => m.id === 'ollama:llama3.1:8b')).toBe(false);
    // qwen2.5:72b is not: it is listed on its own, rated against 8 GB of VRAM.
    const qwen = models.find((m) => m.id === 'ollama:qwen2.5:72b');
    expect(qwen).toMatchObject({ installed: true, source: 'ollama', provider: 'Ollama', version: '72b', updateStatus: 'unknown' });
    expect(qwen?.compatibility.rating).toMatch(/slow|insufficient/); // 47 GB of weights vs 8 GB VRAM
    expect(models.some((m) => m.name.includes('nomic-embed'))).toBe(false); // embeddings are not composition models
    for (const m of models) {
      expect(m).toMatchObject({ id: expect.any(String), name: expect.any(String), provider: expect.any(String), version: expect.any(String), license: expect.any(String), installed: expect.any(Boolean), updateStatus: expect.any(String) });
      expect(Array.isArray(m.capabilities)).toBe(true);
    }
    // Every catalog entry (from @songdeck/ai) is listed, installed or not, with its category mapped.
    expect(LOCAL_MODEL_CATALOG.length).toBeGreaterThan(0);
    for (const item of LOCAL_MODEL_CATALOG) expect(models.some((m) => m.id === item.id)).toBe(true);
    const ace = models.find((m) => m.id === 'ace-step-1.5');
    expect(ace).toMatchObject({ category: 'audio', installed: false, updateStatus: 'not-installed', license: 'Apache-2.0', location: expect.stringMatching(/^https:/) });
    expect(ace?.compatibility.rating).toBe('excellent'); // 8 GB VRAM ≥ recommended 8 GB
    const rvc = models.find((m) => m.id === 'rvc-v2');
    expect(rvc?.category).toBe('vocals');
    const mistral = models.find((m) => m.id === 'mistral-small-3.2-24b');
    expect(mistral?.compatibility).toMatchObject({ rating: 'slow' });
    expect(report.sources.find((s: { source: string }) => s.source === 'ollama')).toMatchObject({ status: 'ok', count: 2 });
  });

  it('reports unreachable discovery sources without failing', async () => {
    const dead = await startMock((_req, res) => res.end());
    const deadUrl = dead.url;
    await dead.close();
    srv = await startServer({ discovery: { ollamaUrl: deadUrl, lmStudioUrl: `${deadUrl}/v1`, timeoutMs: 500 }, hardware: { detect: async () => HW } });
    const report = await json(await fetch(`${srv.url}/api/models`));
    expect(report.sources.find((s: { source: string }) => s.source === 'ollama').status).toBe('unreachable');
    expect(report.sources.find((s: { source: string }) => s.source === 'lm-studio').status).toBe('unreachable');
  });

  it('lists LM Studio models, local bridge engines and models-directory manifests; rescan picks up changes', async () => {
    const lm = await startMock((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mistral-small-3.1-24b-instruct', object: 'model' }, { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model' }] }));
    });
    const bridge = await startMock((req, res) => {
      if (req.url === '/info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'ACE-Step bridge', version: '1.5.0', models: [{ id: 'ace-step-v1.5', name: 'ACE-Step 1.5' }], capabilities: ['TEXT_TO_MUSIC', 'LYRIC_CONDITIONING'], hardware: { min_vram_gb: 4 } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const singer = await startMock((req, res) => {
      if (req.url === '/voices') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: 'opencpop', name: 'Opencpop', voice_type: 'soprano', language: 'zh', kind: 'stock' }]));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    mocks.push(lm, bridge, singer);
    srv = await startServer({ discovery: { ollamaUrl: false, lmStudioUrl: `${lm.url}/v1` }, hardware: { detect: async () => HW } });
    await fetch(`${srv.url}/api/providers`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [
          { id: 'ace', name: 'ACE-Step', adapter: 'local-music', enabled: true, location: 'local', baseUrl: bridge.url, auth: { type: 'none' }, timeoutMs: 1000, concurrency: 1 },
          { id: 'diffsinger', name: 'DiffSinger', adapter: 'singing-http', enabled: true, location: 'local', baseUrl: singer.url, auth: { type: 'none' }, timeoutMs: 1000, concurrency: 1 },
        ],
      }),
    });
    let report = await json(await fetch(`${srv.url}/api/models/rescan`, { method: 'POST' }));
    let models = allModels(report);
    expect(models.find((m) => m.name === 'mistral-small-3.1-24b-instruct')).toMatchObject({ installed: true, category: 'composition', provider: 'LM Studio' });
    expect(models.some((m) => /embed/.test(m.name))).toBe(false);
    const ace = models.find((m) => m.installedVia?.includes('provider:ace'));
    expect(ace).toMatchObject({ installed: true, category: 'audio' });
    expect(ace?.capabilities).toEqual(expect.arrayContaining(['TEXT_TO_MUSIC']));
    const voice = models.find((m) => m.installedVia?.includes('provider:diffsinger'));
    expect(voice).toMatchObject({ category: 'vocals', installed: true });

    // A standalone manifest model…
    const dir = path.join(srv.dataDir, 'models', 'my-separator');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ id: 'my-separator-v2', name: 'My Separator', category: 'separation', version: '2.0.1', license: 'MIT', requirements: { minVramGb: 2 }, capabilities: ['SOURCE_SEPARATION'] }));
    writeFileSync(path.join(dir, 'weights.bin'), Buffer.alloc(1024));
    // …and a directory named after a catalog id with an older version installs that catalog model.
    const demucs = path.join(srv.dataDir, 'models', 'demucs-htdemucs');
    mkdirSync(demucs, { recursive: true });
    writeFileSync(path.join(demucs, 'model.json'), JSON.stringify({ name: 'Demucs', version: '3.0', category: 'separation' }));
    report = await json(await fetch(`${srv.url}/api/models`)); // cached: not visible yet
    expect(allModels(report).some((m) => m.id === 'my-separator-v2')).toBe(false);
    report = await json(await fetch(`${srv.url}/api/models/rescan`, { method: 'POST' }));
    models = allModels(report);
    expect(models.find((m) => m.id === 'my-separator-v2')).toMatchObject({ installed: true, category: 'separation', license: 'MIT', location: dir, source: 'directory', compatibility: { rating: 'excellent' } });
    expect(models.find((m) => m.id === 'demucs-htdemucs')).toMatchObject({ installed: true, installedVersion: '3.0', updateStatus: 'update-available', location: demucs });
  });
});

describe('compatibility classification', () => {
  it('rates discovered models with partially known requirements', () => {
    expect(classifyRequirements({}, undefined, HW).rating).toBe('compatible');
    expect(classifyRequirements({ minVramGb: 4, recommendedVramGb: 6 }, 3, HW).rating).toBe('excellent');
    expect(classifyRequirements({ minVramGb: 8, recommendedVramGb: 12 }, 7, HW).rating).toBe('compatible');
    expect(classifyRequirements({ minVramGb: 24, cpuOk: true }, 20, HW).rating).toBe('slow');
    expect(classifyRequirements({ minVramGb: 24, cpuOk: false }, 20, HW).rating).toBe('insufficient');
    expect(classifyRequirements({ minVramGb: 4, minRamGb: 128 }, 3, HW).rating).toBe('insufficient');
    const cpuOnly: HardwareInfo = { ...HW, gpus: [], backends: ['cpu'], accelerationBackends: ['cpu'] };
    expect(classifyRequirements({ minVramGb: 4, cpuOk: true }, 3, cpuOnly).rating).toBe('slow');
  });

  it('compares versions', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('v2.0', '2.0.0')).toBe(0);
    expect(compareVersions('1.5', '1.4.9')).toBe(1);
  });
});
