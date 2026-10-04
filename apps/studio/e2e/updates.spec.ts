import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const currentVersion: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const nextVersion = `${Number(currentVersion.split('.')[0]) + 1}.0.0`;

test('checks, downloads, restarts, and persists the automatic-update preference', async ({ page }) => {
  let version = currentVersion;
  const status = {
    currentVersion: version,
    supported: true,
    busy: false,
    automatic: false,
    available: false,
    latestVersion: undefined as string | undefined,
    pendingVersion: undefined as string | undefined,
    checkedAt: undefined as string | undefined,
  };
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { name: 'songdeck-server', version, features: ['updates'] } }),
  );
  await page.route('**/api/updates{,/**}', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() !== 'GET') expect(req.headers()['x-songdeck-client']).toBe('updates');
    if (url.pathname.endsWith('/check'))
      Object.assign(status, {
        available: true,
        latestVersion: nextVersion,
        checkedAt: new Date().toISOString(),
      });
    if (url.pathname.endsWith('/install')) status.pendingVersion = nextVersion;
    if (url.pathname.endsWith('/settings')) status.automatic = req.postDataJSON().automatic;
    if (url.pathname.endsWith('/restart')) {
      version = nextVersion;
      status.currentVersion = version;
      status.pendingVersion = undefined;
    }
    await route.fulfill({ json: status });
  });
  await page.goto('/#settings/general');
  const panel = page.getByTestId('updates-panel');
  await expect(panel.getByRole('button', { name: 'Check for updates' })).toBeEnabled();
  await panel.getByRole('checkbox', { name: /Automatically download/ }).click();
  await expect(panel.getByRole('checkbox')).toBeChecked();
  await page.reload();
  await expect(panel.getByRole('checkbox')).toBeChecked();
  await panel.getByRole('button', { name: 'Check for updates' }).click();
  await expect(panel.getByText(`Version ${nextVersion} is available.`)).toBeVisible();
  await panel.getByRole('button', { name: 'Download update' }).click();
  await expect(panel.getByText(`Version ${nextVersion} is ready.`)).toBeVisible();
  await panel.getByRole('button', { name: 'Restart to update' }).click();
  await page.getByRole('button', { name: 'Restart server', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Reload studio' })).toBeVisible();
});

test('explains browser-only mode and shows update errors with retry available', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({ status: 503, json: {} }));
  await page.goto('/#settings/general');
  const panel = page.getByTestId('updates-panel');
  await expect(panel.getByText(/Start the local Song Deck server/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Check for updates' })).toHaveCount(0);
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { name: 'songdeck-server', version: currentVersion, features: ['updates'] } }),
  );
  await page.route('**/api/updates', (route) =>
    route.fulfill({
      json: {
        currentVersion: currentVersion,
        supported: true,
        busy: false,
        automatic: false,
        available: false,
      },
    }),
  );
  await page.route('**/api/updates/check', (route) =>
    route.fulfill({ status: 502, json: { error: 'GitHub is unavailable. Try again later.' } }),
  );
  await page.reload();
  await panel.getByRole('button', { name: 'Check for updates' }).click();
  await expect(panel.getByRole('alert')).toContainText('GitHub is unavailable');
  await expect(panel.getByRole('button', { name: 'Check for updates' })).toBeEnabled();
});
