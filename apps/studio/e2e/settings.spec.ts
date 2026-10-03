import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { composeQuickSong } from './compose-helpers';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Settings mode and real-time collaboration, end to end:
 *  - a custom OpenAI-compatible provider pointing at a mock endpoint served by this test, its key
 *    stored in the local server's vault (and never in browser storage), model discovery through the
 *    server proxy (the mock sees the injected key), the browser-only session fallback;
 *  - Rules routing with "Never upload vocals", the live routing preview, offline mode;
 *  - hardware detection and the model manager from the local server;
 *  - enabling the example plugin "lofi-hiphop-genre" and editing a custom genre profile;
 *  - render nodes (health, test render, distributed stems);
 *  - two browser contexts in one collaboration room: a commit by one appears in the other's history.
 *
 * The test starts its own Song Deck server (random port, temporary data dir) and points the
 * studio at it through Settings → General → server URL, so it does not depend on the dev proxy.
 */

const SHOTS = '/tmp/claude-0';
mkdirSync(SHOTS, { recursive: true });
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SECRET = 'sk-mock-e2e-0123456789abcdefghijklmnop';
const SESSION_SECRET = 'sk-mock-session-9876543210zyxwvutsrq';

test.describe.configure({ mode: 'serial', timeout: 300_000 });

// ---------------------------------------------------------------------------
// Fixtures: mock OpenAI-compatible endpoint + Song Deck server
// ---------------------------------------------------------------------------

interface Mock {
  url: string;
  seen: { method: string; path: string; auth?: string }[];
  close(): Promise<void>;
}

async function startMock(): Promise<Mock> {
  const seen: Mock['seen'] = [];
  const server = http.createServer((req, res) => {
    // `Authorization` cannot be covered by a wildcard: echo the requested headers.
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? 'authorization, content-type'),
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    seen.push({ method: req.method ?? 'GET', path: req.url ?? '', auth: req.headers.authorization });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'mock-llama-3.1-8b-instruct', object: 'model', owned_by: 'e2e', context_length: 131072 },
            { id: 'mock-text-embedding-3', object: 'model', owned_by: 'e2e' },
          ],
        }),
      );
      return;
    }
    if (req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ id: 'cmpl', model: 'mock-llama-3.1-8b-instruct', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 14, completion_tokens: 1 } }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json', ...cors });
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

interface SongDeckServer {
  url: string;
  proc: ChildProcess;
  dataDir: string;
}

async function startServer(origins: string[]): Promise<SongDeckServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'songdeck-e2e-'));
  const args = ['--import', 'tsx', 'apps/server/src/cli.ts', '--port', '0', '--data-dir', dataDir, '--log-level', 'warn'];
  for (const o of origins) args.push('--allow-origin', o);
  const proc = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, SONGDECK_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Song Deck server did not start:\n${log}`)), 60_000);
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
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Song Deck server exited (${code}):\n${log}`));
    });
  });
  return { url, proc, dataDir };
}

let mock: Mock;
let server: SongDeckServer;
let ada: { context: BrowserContext; page: Page; errors: string[] };

test.beforeAll(async ({ browser }, info) => {
  const base = new URL(info.project.use.baseURL ?? 'http://localhost:5199');
  mock = await startMock();
  server = await startServer([base.origin, `${base.protocol}//127.0.0.1:${base.port}`]);
  ada = await studio(browser, 'Ada');
});

test.afterAll(async () => {
  await ada?.context.close().catch(() => undefined);
  server?.proc.kill('SIGTERM');
  await mock?.close().catch(() => undefined);
  if (server?.dataDir) rmSync(server.dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fresh browser profile pointed at the test server, with a display name. */
async function studio(browser: Browser, userName: string): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext();
  await context.addInitScript(
    ({ serverUrl, name }) => {
      if (!localStorage.getItem('songdeck:settings')) localStorage.setItem('songdeck:settings', JSON.stringify({ serverUrl, userName: name }));
    },
    { serverUrl: server.url, name: userName },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  return { context, page, errors };
}

async function openSettings(page: Page, tab: RegExp): Promise<void> {
  if (!(await page.getByTestId('settings-mode').isVisible())) await page.getByTitle(/^Settings/).click();
  await page.getByRole('tab', { name: tab }).click();
}

async function expectServerOnline(page: Page): Promise<void> {
  await expect(page.locator('.st-nav-status')).toContainText('Server online', { timeout: 30_000 });
}

/** Everything the page stored locally (web storage + IndexedDB), as one string. */
async function browserStorageDump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const req = indexedDB.open('songdeck');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (db) {
      for (const name of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve) => {
          const r = db.transaction(name, 'readonly').objectStore(name).getAll();
          r.onsuccess = () => resolve(r.result as unknown[]);
          r.onerror = () => resolve([]);
        });
        parts.push(JSON.stringify(rows, (_k, v) => (v instanceof Uint8Array ? `[${v.length} bytes]` : v)));
      }
      db.close();
    }
    return parts.join('\n');
  });
}

async function composeSong(page: Page): Promise<void> {
  await composeQuickSong(page, 'Alt-rock band', 60_000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('providers: custom OpenAI-compatible endpoint, key in the server vault, model discovery', async () => {
  const { page } = ada;
  await openSettings(page, /^Providers/);
  await expectServerOnline(page);
  await expect(page.locator('.st-keys-callout')).toContainText('Keys are stored by the local server');

  // Add provider → gallery → custom endpoint (spec §4.1 fields).
  await page.getByRole('button', { name: 'Add provider' }).click();
  const gallery = page.getByTestId('provider-gallery');
  for (const group of ['Cloud language models', 'Local LLM servers', 'Custom endpoints', 'Music generation', 'Singing synthesis', 'Transcription', 'Source separation', 'Voice conversion', 'Mastering']) {
    await expect(gallery.getByRole('heading', { name: group })).toBeVisible();
  }
  await expect(gallery.getByRole('article', { name: 'Ollama' })).toBeVisible();
  await gallery.getByRole('button', { name: 'Add OpenAI-compatible endpoint' }).click();

  const editor = page.getByTestId('provider-editor');
  await editor.getByLabel('Provider name').fill('Mock LLM');
  await editor.getByLabel('Provider id').fill('mock-llm');
  await editor.getByLabel('Endpoint URL').fill(`${mock.url}/v1`);
  await editor.getByRole('radio', { name: 'Cloud' }).click();
  await editor.getByLabel('Authentication type').selectOption('bearer');
  await editor.getByLabel('Context length').fill('32768');
  await editor.getByLabel('Structured output support').selectOption('json_object');
  await editor.getByLabel('Timeout seconds').fill('60');
  await editor.getByLabel('Concurrency').fill('2');
  await editor.locator('.st-editor-bar').getByRole('button', { name: 'Save' }).click();
  await expect(editor.locator('.st-editor-bar')).not.toContainText('Not saved yet');

  // The key goes to the server vault — never into settings or browser storage (spec §7).
  await editor.getByLabel('API key').fill(SECRET);
  await editor.getByRole('button', { name: 'Save key' }).click();
  await expect(editor.getByTestId('key-note')).toContainText('via the local Song Deck server');
  await expect(editor.getByLabel('API key')).toHaveValue('');
  await expect(editor.locator('.st-key-status')).toContainText('Key stored in the server vault');
  expect(await browserStorageDump(page)).not.toContain(SECRET);
  const settingsJson = await page.evaluate(() => localStorage.getItem('songdeck:settings') ?? '');
  expect(settingsJson).toContain('"credentialRef":"provider:mock-llm"');
  expect(settingsJson).not.toContain(SECRET);

  // Discover models through the server proxy: the mock receives the key injected server-side.
  await editor.getByRole('button', { name: 'Discover models' }).click();
  await expect(editor.getByTestId('provider-result')).toContainText('Found 1 model');
  const table = editor.getByTestId('model-table');
  await expect(table).toContainText('mock-llama-3.1-8b-instruct');
  await expect(table).not.toContainText('embedding');
  await expect(table).toContainText('inferred');
  await expect(table).toContainText('Music theory reasoning');
  expect(mock.seen.some((r) => r.path === '/v1/models' && r.auth === `Bearer ${SECRET}`)).toBe(true);

  await editor.getByRole('button', { name: 'Send a test prompt' }).click();
  await expect(editor.getByTestId('provider-result')).toContainText('answered “OK”');
  await page.screenshot({ path: `${SHOTS}/settings-e2e-provider-editor.png` });

  await editor.getByRole('button', { name: 'Back to providers' }).click();
  const card = page.getByTestId('provider-mock-llm');
  await expect(card).toContainText('Ready');
  await expect(card).toContainText('Key in vault');
  await expect(card).toContainText('1 model');
  await page.screenshot({ path: `${SHOTS}/settings-e2e-providers.png` });

  // Browser-only mode: without a server the key is stored encrypted in this browser (never in plain text).
  await openSettings(page, /^General/);
  const serverUrl = page.getByLabel('Server URL');
  await serverUrl.fill('http://127.0.0.1:9');
  await serverUrl.press('Enter');
  await expect(page.getByTestId('server-status')).toContainText('browser-only mode', { timeout: 15_000 });
  await openSettings(page, /^Providers/);
  await expect(page.locator('.st-keys-callout')).toContainText('Browser-only mode');
  await page.getByTestId('provider-mock-llm').getByRole('button', { name: 'Configure' }).click();
  await expect(editor.locator('.st-key-status')).toContainText('No key stored yet');
  await editor.getByLabel('API key').fill(SESSION_SECRET);
  await editor.getByRole('button', { name: 'Save key' }).click();
  await expect(editor.getByTestId('key-note')).toContainText('Stored encrypted in this browser');
  await editor.getByRole('button', { name: 'Test connection' }).click();
  await expect(editor.getByTestId('provider-result')).toContainText('Connected');
  expect(mock.seen.some((r) => r.path === '/v1/models' && r.auth === `Bearer ${SESSION_SECRET}`)).toBe(true);
  expect(await browserStorageDump(page)).not.toContain(SESSION_SECRET);
  await editor.getByRole('button', { name: 'Back to providers' }).click();

  await openSettings(page, /^General/);
  await serverUrl.fill(server.url);
  await serverUrl.press('Enter');
  await expect(page.getByTestId('server-status')).toContainText('Online', { timeout: 15_000 });

  // With the server back, the browser-held key can move into the server vault.
  await openSettings(page, /^Providers/);
  const browserKeys = page.getByTestId('browser-keys');
  await expect(browserKeys).toContainText('move them into its vault');
  await browserKeys.getByRole('button', { name: 'Move to server vault' }).click();
  await expect(browserKeys).toHaveCount(0);
  await expect(page.getByTestId('provider-mock-llm')).toContainText('Key in vault');
  expect(ada.errors).toEqual([]);
});

test('routing: Rules mode with “Never upload vocals”, live preview, offline mode', async () => {
  const { page } = ada;
  await openSettings(page, /^Profiles & routing/);
  await page.getByRole('radio', { name: /^Rules/ }).click();
  await expect(page.locator('.st-nav-item', { hasText: 'Profiles & routing' })).toContainText('rules');

  const rules = page.getByTestId('routing-rules');
  await rules.getByRole('button', { name: 'Never upload vocals' }).click();
  await expect(rules.getByTestId('routing-rule')).toHaveCount(1);
  await expect(rules.getByTestId('routing-rule').first()).toContainText('Never upload recorded vocals.');

  // A rule that prefers the cloud provider for composition makes the preview interesting.
  await rules.getByLabel('Rule kind').selectOption('prefer-provider');
  await rules.getByRole('button', { name: 'Add rule' }).click();
  const prefer = rules.getByTestId('routing-rule').nth(1);
  await prefer.getByLabel('Preferred provider').selectOption('mock-llm');
  await expect(prefer).toContainText('Prefer Mock LLM for composition planner.');

  const preview = page.getByTestId('routing-preview');
  for (const role of ['composition', 'harmony', 'midi-editing', 'lyrics', 'analysis', 'chat', 'transcription', 'separation', 'production', 'vocals', 'voice-conversion', 'mixing', 'mastering']) {
    await expect(preview.getByTestId(`route-${role}`)).toBeVisible();
  }
  const composition = preview.getByTestId('route-composition');
  await expect(composition.locator('.st-route-name')).toHaveText('Mock LLM');
  await expect(composition).toContainText('rule: prefer Mock LLM for composition');
  await expect(preview.getByTestId('route-transcription')).toContainText('On-device analysis');

  // A request containing recorded vocals may not go to the cloud.
  await preview.getByRole('button', { name: 'Recorded vocals' }).click();
  await expect(composition.locator('.st-route-name')).not.toHaveText('Mock LLM');
  await composition.getByRole('button', { name: /excluded/ }).click();
  await expect(composition.getByTestId('excluded-provider').filter({ hasText: 'Mock LLM' })).toContainText('never upload: recorded vocals');
  await preview.getByRole('button', { name: 'Recorded vocals' }).click();
  await expect(composition.locator('.st-route-name')).toHaveText('Mock LLM');
  await page.screenshot({ path: `${SHOTS}/settings-e2e-routing.png` });
  await preview.screenshot({ path: `${SHOTS}/settings-e2e-routing-preview.png` });

  // Offline mode: cloud providers become unavailable (spec §51).
  await openSettings(page, /^Privacy/);
  const offline = page.getByTestId('offline-panel');
  await expect(offline.getByTestId('offline-unavailable')).toContainText('Mock LLM');
  await offline.getByRole('switch').click();
  await expect(offline.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.statusbar')).toContainText('Offline mode — nothing leaves this device');
  await page.screenshot({ path: `${SHOTS}/settings-e2e-privacy.png` });

  await openSettings(page, /^Profiles & routing/);
  await expect(composition.locator('.st-route-name')).not.toHaveText('Mock LLM');
  await composition.getByRole('button', { name: /excluded/ }).click();
  await expect(composition.getByTestId('excluded-provider').filter({ hasText: 'Mock LLM' })).toContainText('offline mode: cloud providers are disabled');

  await openSettings(page, /^Providers/);
  await expect(page.getByTestId('provider-mock-llm')).toContainText('Unavailable offline');

  // Back online; leave routing automatic for the rest of the run.
  await openSettings(page, /^Privacy/);
  await page.getByTestId('offline-panel').getByRole('switch').click();
  await openSettings(page, /^Profiles & routing/);
  await page.getByRole('radio', { name: /^Automatic/ }).click();
  expect(ada.errors).toEqual([]);
});

test('models & hardware from the local server', async () => {
  const { page } = ada;
  await openSettings(page, /^Models & hardware/);
  const hw = page.getByTestId('hardware');
  await expect(hw).toContainText('CPU');
  await expect(hw).toContainText(/\d+ cores/);
  await expect(hw).toContainText(/RAM/);
  await expect(hw).toContainText('Acceleration');
  const manager = page.getByTestId('model-manager');
  for (const cat of ['Composition', 'Audio', 'Vocals', 'Transcription', 'Separation', 'Mastering']) await expect(manager.getByRole('radio', { name: new RegExp(`^${cat}`) })).toBeVisible();
  await expect(manager.getByTestId('model-row').first()).toBeVisible();
  await expect(manager.locator('.st-model-rating .badge').first()).toHaveText(/Excellent|Compatible|Slow|Insufficient Hardware/);
  await page.getByRole('button', { name: 'Rescan' }).click();
  await expect(page.getByRole('button', { name: 'Rescan' })).toBeEnabled({ timeout: 60_000 });
  await manager.getByRole('radio', { name: /^Composition/ }).click();
  const row = manager.getByTestId('model-row').first();
  await row.locator('.st-model-main').click();
  await expect(row).toContainText('License');
  await expect(row).toContainText('Compatibility');
  await page.screenshot({ path: `${SHOTS}/settings-e2e-models.png` });
  expect(ada.errors).toEqual([]);
});

test('plugins: enable the lo-fi hip-hop genre plugin and edit a custom genre profile', async () => {
  const { page } = ada;
  await openSettings(page, /^Plugins & profiles/);
  const card = page.getByTestId('plugin-lofi-hiphop-genre');
  await expect(card).toContainText('Lo-fi Hip-Hop Genre Profile');
  await expect(card).toContainText('Genre profile');
  await card.getByRole('switch').click();
  const trust = page.getByRole('dialog');
  await expect(trust).toContainText('Plugin code runs in the studio');
  await trust.getByRole('button', { name: /I trust this plugin/ }).click();
  await expect(card).toContainText('Loaded');
  await expect(card.getByTestId('plugin-contributions')).toContainText('genre Lo-fi Hip-Hop');
  await page.screenshot({ path: `${SHOTS}/settings-e2e-plugins.png` });

  // The plugin's genre is now a genre profile; duplicate it into an editable custom profile.
  await page.getByRole('tab', { name: 'Genre profiles', exact: true }).click();
  const genre = page.getByTestId('genre-lofi-hiphop');
  await expect(genre).toContainText('Lo-fi Hip-Hop');
  await expect(genre).toContainText('Plugin');
  await genre.getByRole('button', { name: 'Duplicate Lo-fi Hip-Hop' }).click();
  const editor = page.getByTestId('genre-editor');
  await editor.getByLabel('Genre name').fill('Rainy Lo-fi');
  await editor.getByLabel('Typical tempo').fill('78');
  await editor.getByLabel('Progression').first().fill('ii7 V7 Imaj7 IVmaj7');
  await editor.getByLabel('Progression').first().press('Enter');
  await page.getByRole('button', { name: 'Save profile' }).click();
  const custom = page.getByTestId('genre-lofi-hiphop-custom');
  await expect(custom).toContainText('Rainy Lo-fi');
  await expect(custom).toContainText('Custom');
  await expect(custom).toContainText('ii7 V7 Imaj7 IVmaj7');
  await page.screenshot({ path: `${SHOTS}/settings-e2e-genres.png` });
  expect(ada.errors).toEqual([]);
});

let alice: { context: BrowserContext; page: Page; errors: string[] } | undefined;
let bob: { context: BrowserContext; page: Page; errors: string[] } | undefined;

test.afterAll(async () => {
  await alice?.context.close().catch(() => undefined);
  await bob?.context.close().catch(() => undefined);
});

test('collaboration: two people in one room — a commit by Alice appears in Bob’s history', async ({ browser }) => {
  alice = await studio(browser, 'Alice');
  bob = await studio(browser, 'Bob');
  const a = alice.page;
  const b = bob.page;

  // Alice composes a song, shares it and joins the room.
  await composeSong(a);
  await openSettings(a, /^Collaboration/);
  await expectServerOnline(a);
  const shareName = `E2E Song ${Date.now().toString(36)}`;
  await a.getByLabel('Shared project name').fill(shareName);
  await a.getByRole('button', { name: 'Share project' }).click();
  await expect(a.getByTestId('shared-projects')).toContainText(shareName);
  await a.getByTestId('collab-connection').getByRole('button', { name: 'Connect' }).click();
  await expect(a.getByTestId('collab-status')).toHaveText('Connected');

  // Bob opens the shared project and joins the same room.
  await openSettings(b, /^Collaboration/);
  await expectServerOnline(b);
  await b.getByTestId('shared-projects').getByRole('button', { name: `Open ${shareName}` }).click();
  await expect(b.getByTestId('arrangement')).toBeVisible({ timeout: 30_000 });
  await openSettings(b, /^Collaboration/);
  await b.getByTestId('collab-connection').getByRole('button', { name: 'Connect' }).click();
  await expect(b.getByTestId('collab-status')).toHaveText('Connected');
  await expect(b.getByTestId('collab-peers')).toContainText('Alice');
  await expect(a.getByTestId('collab-peers')).toContainText('Bob');

  // Alice commits (locks the tempo) in the workbench …
  await a.getByRole('button', { name: /^Workbench/ }).click();
  await a.locator('.right-tabs .tab', { hasText: 'Locks' }).click();
  await a.locator('.right-body .row', { hasText: 'Tempo' }).first().getByRole('button').click();

  // … and it reaches Bob's version history.
  await b.getByRole('button', { name: /^Workbench/ }).click();
  await b.locator('.right-tabs .tab', { hasText: 'History' }).click();
  await expect(b.locator('.right-body')).toContainText('Locked tempo', { timeout: 20_000 });
  await expect(b.locator('.right-body')).toContainText('Alice');

  // While collaborating, Alice's undo is a shared revision too: Bob receives it.
  await a.getByTitle('Undo (Ctrl/Cmd+Z)').click();
  await expect(b.locator('.right-body')).toContainText('Undo: Locked tempo', { timeout: 20_000 });
  await b.screenshot({ path: `${SHOTS}/settings-e2e-collab-bob-history.png` });

  // Bob comments on a section; Alice sees it anchored, and resolves it.
  await openSettings(b, /^Collaboration/);
  const comments = b.getByTestId('collab-comments');
  await comments.getByLabel('Comment', { exact: true }).fill('Make the chorus bigger');
  await comments.getByLabel('Section', { exact: true }).selectOption({ index: 1 });
  await comments.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(comments.getByTestId('collab-comment')).toContainText('Make the chorus bigger');
  await openSettings(a, /^Collaboration/);
  const aComments = a.getByTestId('collab-comments');
  await expect(aComments.getByTestId('collab-comment')).toContainText('Make the chorus bigger');
  await expect(aComments.getByTestId('collab-comment')).toContainText('Bob');
  await a.getByTestId('collab-chat').getByLabel('Chat message').fill('On it!');
  await a.getByTestId('collab-chat').getByRole('button', { name: 'Send' }).click();
  await expect(b.getByTestId('collab-chat')).toContainText('On it!');
  await aComments.getByRole('button', { name: 'Resolve' }).click();
  await expect(comments.getByTestId('collab-comment')).toHaveCount(0);
  await a.screenshot({ path: `${SHOTS}/settings-e2e-collab-alice.png` });

  expect(alice.errors).toEqual([]);
  expect(bob.errors).toEqual([]);
});

test('render nodes: health, test render and a distributed stem render', async () => {
  const page = alice!.page;
  await openSettings(page, /^Render nodes/);
  await page.getByRole('button', { name: 'Add node' }).first().click();
  await page.getByLabel('Node name').fill('Test server');
  await page.getByLabel('Node URL').fill(server.url);
  await page.getByRole('button', { name: 'Add node' }).nth(1).click();
  const node = page.getByTestId('render-node');
  await expect(node).toContainText('Healthy', { timeout: 15_000 });
  await expect(node).toContainText(/\d+ cores/);
  await node.getByRole('button', { name: 'Test render' }).click();
  await expect(node.getByTestId('node-test-result')).toContainText('LUFS', { timeout: 60_000 });

  await page.getByText('Use render nodes for stem renders').click();
  const dist = page.getByTestId('distributed-test');
  await dist.getByRole('button', { name: 'Render stems' }).click();
  await expect(dist).toContainText(/\d+ stems in/, { timeout: 180_000 });
  await expect(dist.locator('tbody')).toContainText('Test server');
  await page.screenshot({ path: `${SHOTS}/settings-e2e-nodes.png` });
  expect(alice!.errors).toEqual([]);
});
