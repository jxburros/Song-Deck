import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * "Connect a service" in browser-only mode (no local server):
 *  - the first-run card on Home opens the connect flow;
 *  - a pasted Gemini key is recognised, checked live (the Gemini API is intercepted and answers
 *    with a realistic model list), and the models are grouped by what they do in Song Deck with
 *    the best ones pre-ticked;
 *  - "Add" creates the provider and stores the key encrypted in the browser — never in plain text;
 *  - after a reload the provider and its key are still there and the key is used for requests;
 *  - the provider shows up in a role picker; a local Ollama found on this machine is one click away.
 */

const KEY = 'AIzaSyE2E-0123456789abcdefghijklmnopqr';
const SHOTS = '/tmp/claude-0';

const GEMINI_MODELS = {
  models: [
    {
      name: 'models/gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens', 'createCachedContent'],
    },
    {
      name: 'models/gemini-2.5-pro-preview-06-05',
      displayName: 'Gemini 2.5 Pro Preview 06-05',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-2.5-flash-lite',
      displayName: 'Gemini 2.5 Flash-Lite',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-2.5-flash-preview-tts',
      displayName: 'Gemini 2.5 Flash Preview TTS',
      inputTokenLimit: 8192,
      outputTokenLimit: 16384,
      supportedGenerationMethods: ['countTokens', 'generateContent'],
    },
    {
      name: 'models/gemma-3-27b-it',
      displayName: 'Gemma 3 27B',
      inputTokenLimit: 131072,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/text-embedding-004',
      displayName: 'Text Embedding 004',
      inputTokenLimit: 2048,
      outputTokenLimit: 1,
      supportedGenerationMethods: ['embedContent'],
    },
    {
      name: 'models/imagen-4.0-generate-001',
      displayName: 'Imagen 4',
      inputTokenLimit: 480,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ['predict'],
    },
    {
      name: 'models/lyria-3-clip-preview',
      displayName: 'Lyria 3 Clip Preview',
      inputTokenLimit: 1024,
      outputTokenLimit: 1,
      supportedGenerationMethods: ['generateContent'],
    },
    {
      name: 'models/lyria-realtime-exp',
      displayName: 'Lyria RealTime Experimental',
      supportedGenerationMethods: ['bidiGenerateContent'],
    },
  ],
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

/** Fake Gemini API; records the key each request carried. */
async function fakeGemini(page: Page, seen: string[]): Promise<void> {
  await page.route('https://generativelanguage.googleapis.com/**', async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const key = (await req.allHeaders())['x-goog-api-key'] ?? '';
    seen.push(key);
    if (key !== KEY)
      return route.fulfill({
        status: 400,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
          },
        }),
      });
    if (new URL(req.url()).pathname === '/v1beta/models')
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        json: GEMINI_MODELS,
      });
    return route.fulfill({ status: 404, headers: CORS, body: '{}' });
  });
}

/** A fake Ollama on this machine; every other local port is closed. */
async function fakeLocalMachine(page: Page): Promise<void> {
  await page.route(/^http:\/\/127\.0\.0\.1:(1234|8080|8000|88\d\d)\//, (route) =>
    route.abort('connectionrefused'),
  );
  await page.route('http://127.0.0.1:11434/**', (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: CORS })
      : route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'application/json' },
          json: {
            models: [
              { name: 'qwen3:8b', model: 'qwen3:8b', details: { family: 'qwen3', parameter_size: '8.2B' } },
            ],
          },
        }),
  );
}

/** Everything the page stored locally: web storage and every IndexedDB database. */
async function storageDump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
    for (const info of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase | null>((resolve) => {
        const req = indexedDB.open(info.name!);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
      if (!db) continue;
      for (const name of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve) => {
          const r = db.transaction(name, 'readonly').objectStore(name).getAll();
          r.onsuccess = () => resolve(r.result as unknown[]);
          r.onerror = () => resolve([]);
        });
        parts.push(
          JSON.stringify(rows, (_k, v) =>
            v instanceof Uint8Array
              ? new TextDecoder('latin1').decode(v)
              : v instanceof CryptoKey
                ? `[CryptoKey extractable=${v.extractable}]`
                : v,
          ),
        );
      }
      db.close();
    }
    return parts.join('\n');
  });
}

test('connect Gemini with a pasted key, keep it across reloads, use it in a role picker', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Browser-only mode: point the studio at a port where no Song Deck server runs.
  await page.addInitScript(() => {
    if (!localStorage.getItem('songdeck:settings'))
      localStorage.setItem('songdeck:settings', JSON.stringify({ serverUrl: 'http://127.0.0.1:9' }));
  });
  const seen: string[] = [];
  await fakeGemini(page, seen);
  await fakeLocalMachine(page);

  await page.goto('/');
  const nudge = page.getByTestId('connect-nudge');
  await expect(nudge).toContainText('Works offline');
  await nudge.getByRole('button', { name: 'Connect an AI service' }).click();

  const dialog = page.getByTestId('connect-service');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('settings-mode')).toBeVisible();

  // A wrong key is rejected with a clear message.
  await dialog.getByLabel('API key').fill('AIzaSyWRONG-0123456789abcdefghijklmnop');
  await expect(dialog.getByTestId('connect-detected')).toContainText('Google Gemini');
  await expect(dialog.getByTestId('connect-error')).toContainText('rejected this key');

  // The real key: recognised, checked, models grouped by use with recommendations ticked.
  await dialog.getByLabel('API key').fill(`GEMINI_API_KEY="${KEY}"`);
  const models = dialog.getByTestId('connect-models');
  await expect(models).toContainText('Key accepted');
  const writing = dialog.getByTestId('connect-group-writing');
  const music = dialog.getByTestId('connect-group-music');
  await expect(writing).toContainText('Writing, arranging & theory');
  await expect(writing).toContainText('Gemini 2.5 Pro');
  await expect(writing).toContainText('Composition planning');
  await expect(writing).toContainText('MIDI edits in plain words');
  await expect(writing).toContainText('Listens to audio');
  await expect(music).toContainText('Lyria 3 Clip Preview');
  await expect(models).not.toContainText('Text Embedding 004');
  await expect(models).not.toContainText('Lyria RealTime');
  await expect(dialog.getByLabel('gemini-2.5-pro', { exact: true })).toBeChecked();
  await expect(dialog.getByLabel('lyria-3-clip-preview')).toBeChecked();
  await expect(dialog.getByLabel('gemini-2.5-flash', { exact: true })).not.toBeChecked();
  await expect(dialog.getByLabel('gemini-2.5-pro-preview-06-05')).not.toBeChecked();
  await dialog.getByLabel('gemini-2.5-flash', { exact: true }).check();
  // Models the app cannot use stay hidden behind "show all".
  await dialog.getByText(/^Show all \d+ models/).click();
  await expect(dialog.getByTestId('connect-group-unusable')).toContainText('Text Embedding 004');
  await expect(dialog.getByLabel('text-embedding-004')).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/connect-e2e-models.png` });

  // "Found on this machine": Ollama answers, everything else is closed.
  await dialog.getByRole('button', { name: 'Scan this machine' }).click();
  await expect(dialog.getByTestId('local-ollama')).toContainText('qwen3:8b');

  await dialog.getByTestId('connect-add').click();
  await expect(dialog).toBeHidden();
  const card = page.getByTestId('provider-gemini');
  await expect(card).toContainText('Google Gemini');
  await expect(card).toContainText('Key in browser');
  await expect(card).toContainText('gemini-2.5-pro');
  await expect(page.getByTestId('browser-keys')).toContainText('1 key is stored in this browser');

  // The key is never stored in plain text; the encryption key cannot be exported.
  const dump = await storageDump(page);
  expect(dump).not.toContain(KEY);
  expect(dump).toContain('[CryptoKey extractable=false]');
  const settingsJson = await page.evaluate(() => localStorage.getItem('songdeck:settings') ?? '');
  expect(settingsJson).toContain(
    '"enabledModels":["gemini-2.5-pro","lyria-3-clip-preview","gemini-2.5-flash"]',
  );
  expect(settingsJson).toContain('"credentialRef":"provider:gemini"');

  // One click adds the local Ollama found on this machine.
  await page.getByTestId('local-services-panel').getByRole('button', { name: 'Scan this machine' }).click();
  await page.getByTestId('local-services-panel').getByRole('button', { name: 'Add Ollama' }).click();
  await expect(page.getByTestId('provider-ollama')).toBeVisible();
  await expect(page.getByTestId('local-services-panel').getByTestId('local-ollama')).toContainText('Added');

  // Reload: provider and key persist, and the decrypted key is what reaches the API.
  await page.reload();
  await page.getByTitle(/^Settings/).click();
  await page.getByRole('tab', { name: /^Providers/ }).click();
  await expect(page.getByTestId('provider-gemini')).toContainText('Key in browser');
  seen.length = 0;
  await page.getByTestId('provider-gemini').getByRole('button', { name: 'Test Google Gemini' }).click();
  await expect(page.getByTestId('provider-gemini')).toContainText(/Connected in \d+ ms — 3 models available/);
  expect(seen).toEqual([KEY]);
  await page.screenshot({ path: `${SHOTS}/connect-e2e-providers.png` });

  // Re-choose models later without the key.
  await page.getByTestId('provider-gemini').getByRole('button', { name: 'Models' }).click();
  await expect(page.getByRole('dialog')).toContainText('Choose models — Google Gemini');
  await expect(
    page.getByTestId('connect-service').getByLabel('gemini-2.5-flash', { exact: true }),
  ).toBeChecked();
  await page.keyboard.press('Escape');

  // The new provider is offered in role pickers right away (no first-run card any more).
  await page.getByTitle('Song Deck — projects').click();
  await expect(page.getByTestId('connect-nudge')).toHaveCount(0);
  // A one-note MIDI file opens straight into the Workbench (no Compose step needed).
  const midi = Buffer.from([
    ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0],
    ...[
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 13, 0x00, 0x90, 0x3c, 0x64, 0x83, 0x60, 0x80, 0x3c, 0x40, 0x00, 0xff,
      0x2f, 0x00,
    ],
  ]);
  await page
    .locator('input[type=file][accept*=".mid"]')
    .setInputFiles({ name: 'riff.mid', mimeType: 'audio/midi', buffer: midi });
  await expect(page.getByTestId('arrangement')).toBeVisible({ timeout: 30_000 });
  await page.locator('.right-tabs .tab', { hasText: 'AI Edit' }).click();
  const picker = page.locator('.right-body').getByLabel('Provider');
  await expect(picker.locator('option', { hasText: 'Google Gemini · cloud' })).toHaveCount(1);
  await picker.selectOption({ label: 'Google Gemini · cloud' });
  await expect(picker).toHaveValue('gemini');

  expect(errors, errors.join('\n')).toEqual([]);
});
