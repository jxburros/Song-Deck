#!/usr/bin/env node
/**
 * Capture the studio's key screens in both themes and at phone width, for docs/brand/screenshots.
 *
 *   node scripts/screenshots.mjs [outDir] [--port 5212] [--only desktop|mobile] [--all]
 *
 * Starts its own frozen dev server (E2E=1) on the given port, composes a song in the browser, and
 * writes PNGs named <screen>-<theme>.png (desktop 1440×900) and mobile-<screen>-<theme>.png (390×844).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const port = Number(flag('--port') ?? 5212);
const only = flag('--only');
// --all also visits the remaining modes (an overflow check; not part of the docs set).
const all = args.includes('--all') ? (args.splice(args.indexOf('--all'), 1), true) : false;
const outDir = resolve(args[0] ?? join(root, '../../docs/brand/screenshots'));
mkdirSync(outDir, { recursive: true });
const base = `http://127.0.0.1:${port}`;

const server = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  env: { ...process.env, E2E: '1' },
  stdio: 'ignore',
  detached: true,
});
const ready = async () => {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('dev server did not start');
};

async function compose(page) {
  await page.getByRole('button', { name: 'Compose a new song' }).click();
  await page
    .getByLabel('Song prompt')
    .fill(
      'Make a fast alternative rock song with a melancholy verse and huge cathartic chorus. Drums, bass, two guitars, piano and violin. Male tenor vocal.',
    );
  await page.getByRole('button', { name: 'Draft Song Blueprint' }).click();
}

async function generate(page) {
  await page.getByRole('button', { name: 'Plan composition' }).click();
  await page.getByRole('button', { name: 'Generate MIDI composition' }).click();
  await page.getByTestId('arrangement').waitFor({ timeout: 90_000 });
}

async function run(browser, theme, viewport, prefix) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript((t) => {
    if (!sessionStorage.getItem('shots:init')) {
      localStorage.setItem('songdeck:settings', JSON.stringify({ theme: t }));
      sessionStorage.setItem('shots:init', '1');
    }
  }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, `${prefix}${name}-${theme}.png`) });
    // Anything that sticks out past the viewport without a scrolling ancestor is page overflow.
    const overflow = await page.evaluate(() => {
      const W = document.documentElement.clientWidth;
      // A scroll container (or a deliberately clipped component) inside the page is fine; being cut
      // off by the page shell itself (body, #root, .app, main) is not.
      const shell = new Set([
        document.body,
        document.getElementById('root'),
        document.querySelector('.app'),
        document.querySelector('main'),
      ]);
      const clipped = (el) => {
        for (let p = el.parentElement; p && !shell.has(p); p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o !== 'visible' && p.getBoundingClientRect().right <= W + 1) return true;
        }
        return false;
      };
      return [...document.querySelectorAll('body *')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right > W + 1 && !clipped(el);
        })
        .slice(0, 5)
        .map(
          (el) =>
            `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} right=${Math.round(el.getBoundingClientRect().right)}`,
        );
    });
    console.log(
      `  ${prefix}${name}-${theme}.png${overflow.length ? `  OVERFLOW: ${overflow.join(', ')}` : ''}`,
    );
  };
  const mode = async (name) => {
    const nav = page.getByRole('navigation', { name: 'Modes' });
    if (await nav.isVisible()) await nav.getByRole('button', { name, exact: true }).click();
    else await page.getByRole('combobox', { name: 'Studio mode', exact: true }).selectOption({ label: name });
  };

  await page.goto(base);
  await page.getByText('AI that gives you the song back.').waitFor();
  await shot('home');
  await compose(page);
  await shot('compose-blueprint');
  await generate(page);
  await shot('workbench-arrangement');
  await page.getByRole('tab', { name: 'Piano Roll' }).click();
  await shot('piano-roll');
  await page.getByRole('tab', { name: 'Theory' }).click();
  await shot('theory');
  await mode('Mix & Master');
  await page
    .locator('.mx-strip, [data-testid="mixer"]')
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => {});
  await shot('mix');
  await page
    .getByTitle(/^Settings/)
    .first()
    .click();
  await shot('settings');
  if (all) {
    for (const m of ['Compose', 'Generate', 'Transcribe', 'Rebuild', 'Produce', 'Vocals', 'Export']) {
      await mode(m);
      await shot(`mode-${m.toLowerCase()}`);
    }
  }
  await context.close();
  if (errors.length)
    console.warn(`  page errors (${theme}${prefix ? ', mobile' : ''}):\n    ${errors.join('\n    ')}`);
}

try {
  await ready();
  const browser = await chromium.launch();
  for (const theme of ['dark', 'light']) {
    if (only !== 'mobile') await run(browser, theme, { width: 1440, height: 900 }, '');
    if (only !== 'desktop') await run(browser, theme, { width: 390, height: 844 }, 'mobile-');
    if (all && only !== 'desktop') await run(browser, theme, { width: 768, height: 1024 }, 'tablet-');
  }
  await browser.close();
} finally {
  process.kill(-server.pid);
}
