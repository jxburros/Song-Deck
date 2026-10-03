import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Plugin ecosystem end to end (spec §57 "Instruments: Soundfonts"): the local server serves the
 * bundled felt-keys-sfz plugin, the studio loads it when enabled, the sampled instrument appears
 * in the instrument list, and offline renders of a track using it play the samples.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
let server: { url: string; proc: ChildProcess; dataDir: string };

test.beforeAll(async ({}, info) => {
  const base = new URL(info.project.use.baseURL ?? 'http://localhost:5199');
  const dataDir = mkdtempSync(path.join(tmpdir(), 'songdeck-sfz-'));
  const args = ['--import', 'tsx', 'apps/server/src/cli.ts', '--port', '0', '--data-dir', dataDir, '--log-level', 'warn'];
  for (const o of [base.origin, `${base.protocol}//127.0.0.1:${base.port}`]) args.push('--allow-origin', o);
  const proc = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, SONGDECK_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 60_000);
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      const m = /listening on (http:\/\/[^\s]+)/.exec(log);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`server exited (${code}):\n${log}`)));
  });
  server = { url, proc, dataDir };
});

test.afterAll(() => {
  server?.proc.kill('SIGTERM');
  if (server?.dataDir) rmSync(server.dataDir, { recursive: true, force: true });
});

async function pluginStatus(page: Page): Promise<string | undefined> {
  return page.evaluate(`import('/src/engine/plugins.ts').then(({ useExtensions }) => useExtensions.getState().loaded['felt-keys-sfz']?.status)`);
}

test('an enabled SFZ instrument plugin renders tracks with its samples', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(({ serverUrl }) => {
    if (!localStorage.getItem('songdeck:settings')) localStorage.setItem('songdeck:settings', JSON.stringify({ serverUrl, enabledPlugins: ['felt-keys-sfz'] }));
  }, { serverUrl: server.url });

  await page.goto('/');
  await expect.poll(() => pluginStatus(page), { timeout: 30_000 }).toBe('loaded');

  await page.getByRole('button', { name: 'Compose a new song' }).click();
  await page.getByLabel('Song prompt').fill('Dreamy synth-pop in D major, 108 BPM, warm pads and a punchy electronic kit.');
  await page.getByRole('button', { name: 'Draft Song Blueprint' }).click();
  await page.getByRole('button', { name: 'Plan composition' }).click();
  await page.getByRole('button', { name: 'Generate MIDI composition' }).click();
  await expect(page.getByTestId('arrangement')).toBeVisible();

  // The sampled instrument is offered like a built-in one; add a generated track with it.
  await page.locator('.wb-left').getByRole('button', { name: 'Add', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('select').first().selectOption({ value: 'felt-keys' });
  await dialog.getByRole('button', { name: 'Add track' }).click();
  await expect(page.locator('.wb-left .track-row', { hasText: 'Felt Keys (sampled)' })).toBeVisible();

  // Render the new track in the offline job worker with the samples, then with the fallback patch.
  const result = (await page.evaluate(`(async () => {
    const [{ useStudio }, { jobs }, { currentRenderInstruments }] = await Promise.all([
      import('/src/state/store.ts'), import('/src/engine/jobs.ts'), import('/src/engine/render-instruments.ts'),
    ]);
    const song = useStudio.getState().project.song;
    const track = song.tracks.find((t) => t.instrumentId === 'felt-keys');
    const cfg = currentRenderInstruments();
    const rms = (a) => { const x = a.channels[0]; let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); };
    const sampled = await jobs.call('renderTrack', { song, trackId: track.id, sampleRate: 22050 });
    jobs.configure({ instruments: cfg.instruments.map((p) => (p.id === 'felt-keys' ? { ...p, patchId: 'epiano' } : p)), sampleInstruments: {} });
    const fallback = await jobs.call('renderTrack', { song, trackId: track.id, sampleRate: 22050 });
    jobs.configure(cfg);
    let diff = 0;
    const a = sampled.channels[0], b = fallback.channels[0];
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff += Math.abs(a[i] - b[i]);
    return { patchId: cfg.instruments.find((p) => p.id === 'felt-keys')?.patchId, notes: track.notes.length, samples: Object.keys(cfg.sampleInstruments), rms: rms(sampled), diff };
  })()`)) as { patchId: string; notes: number; samples: string[]; rms: number; diff: number };

  expect(result.patchId).toBe('sfz:felt-keys-sfz/felt-keys');
  expect(result.samples).toContain('sfz:felt-keys-sfz/felt-keys');
  expect(result.notes).toBeGreaterThan(0);
  expect(result.rms).toBeGreaterThan(0.001);
  expect(result.diff).toBeGreaterThan(1);

  // The project bundles the profile; disabling the plugin removes its samples, and the track
  // falls back to the profile's General MIDI program instead of breaking.
  const after = (await page.evaluate(`(async () => {
    const [{ useStudio }, { unloadPlugin, useExtensions }, { currentRenderInstruments }] = await Promise.all([
      import('/src/state/store.ts'), import('/src/engine/plugins.ts'), import('/src/engine/render-instruments.ts'),
    ]);
    const bundled = useStudio.getState().project.meta.customInstruments.map((i) => i.id);
    unloadPlugin('felt-keys-sfz');
    const ext = useExtensions.getState();
    return {
      bundled,
      pluginInstruments: ext.instruments.map((i) => i.id),
      samples: Object.keys(ext.sampleInstruments),
      fallbackPatch: currentRenderInstruments().instruments.find((p) => p.id === 'felt-keys')?.patchId,
    };
  })()`)) as { bundled: string[]; pluginInstruments: string[]; samples: string[]; fallbackPatch?: string };
  expect(after.bundled).toContain('felt-keys');
  expect(after.pluginInstruments).not.toContain('felt-keys');
  expect(after.samples).toEqual([]);
  expect(after.fallbackPatch).toBe('epiano');
  expect(errors, errors.join('\n')).toEqual([]);
});
