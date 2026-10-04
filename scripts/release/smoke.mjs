#!/usr/bin/env node
// Smoke-tests a release download: unpacks it, starts the bundled server with plain Node from
// another directory, and checks that it serves the studio, the API and the example plugins, and
// renders audio in a worker thread.
//
// Usage: node scripts/release/smoke.mjs dist/release/song-deck-<version>.tar.gz|.zip|<folder>
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { fail } from './lib.mjs';

const input = process.argv[2]
  ? path.resolve(process.argv[2])
  : fail('usage: node scripts/release/smoke.mjs <archive or folder>');
if (!existsSync(input)) fail(`${input} does not exist`);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'songdeck-smoke-'));
let server;
const log = [];

function cleanup() {
  server?.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
}

/** The release folder: the input itself, or the single top-level folder of the unpacked archive. */
function unpack() {
  if (statSync(input).isDirectory()) return input;
  const into = path.join(tmp, 'unpacked');
  mkdirSync(into);
  if (input.endsWith('.zip')) {
    for (const [name, data] of Object.entries(unzipSync(readFileSync(input)))) {
      const file = path.join(into, name);
      if (name.endsWith('/')) continue;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, data);
      if (/\/server\/[^/]+\.mjs$/.test(name)) chmodSync(file, 0o755);
    }
  } else {
    execFileSync('tar', ['-xzf', input, '-C', into]);
  }
  const top = readdirSync(into);
  if (top.length !== 1)
    throw new Error(`expected one top-level folder in the archive, found ${top.join(', ')}`);
  return path.join(into, top[0]);
}

/** One second of a 440 Hz sine as a 16-bit mono WAV, base64. */
function sineWav(sampleRate = 22050) {
  const n = sampleRate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5 * 32767), 44 + i * 2);
  return buf.toString('base64');
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

async function main() {
  const root = unpack();
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const entry = path.join(root, 'server', 'songdeck-server.mjs');
  console.log(`Smoke-testing Song Deck ${version} from ${root}`);

  const printed = execFileSync(process.execPath, [entry, '--version'], { cwd: tmp, encoding: 'utf8' }).trim();
  check(printed === version, `--version prints ${version}`);

  server = spawn(
    process.execPath,
    [entry, '--port', '0', '--data-dir', path.join(tmp, 'data'), '--vault', 'memory', '--workers', '1'],
    {
      cwd: tmp,
      env: { ...process.env, SONGDECK_DATA_DIR: '', SONGDECK_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server did not start within 30 s')), 30_000);
    const onData = (chunk) => {
      log.push(String(chunk));
      const m = /listening on (http:\/\/\S+)/.exec(log.join(''));
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', (chunk) => log.push(String(chunk)));
    server.on('exit', (code) => reject(new Error(`the server exited with code ${code}`)));
  });
  check(true, `server started on ${url}`);

  const health = await (await fetch(`${url}/api/health`)).json();
  check(
    health.name === 'songdeck-server' && health.version === version,
    `/api/health reports songdeck-server ${version}`,
  );
  const updates = await fetch(`${url}/api/updates`).then((r) => r.json());
  check(updates.supported === true && updates.automatic === false, 'launcher enables opt-in app updates');

  check(
    ['static', 'plugins', 'render-node', 'collab', 'vault'].every((f) => health.features.includes(f)),
    'static studio, plugins, render node, collaboration and vault are enabled',
  );

  const page = await fetch(`${url}/`);
  const html = await page.text();
  check(
    page.status === 200 &&
      /text\/html/.test(page.headers.get('content-type') ?? '') &&
      html.includes('<div id="root"'),
    'serves the studio page',
  );
  const script = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
  const asset = script && (await fetch(new URL(script, url)));
  check(
    asset?.status === 200 && /javascript/.test(asset.headers.get('content-type') ?? ''),
    `serves the studio bundle ${script}`,
  );
  check(
    (await fetch(`${url}/workbench`, { headers: { accept: 'text/html' } })).status === 200,
    'falls back to the studio for client-side routes',
  );

  const expected = readdirSync(path.join(root, 'plugins')).map(
    (dir) => JSON.parse(readFileSync(path.join(root, 'plugins', dir, 'songdeck-plugin.json'), 'utf8')).id,
  );
  const plugins = (await (await fetch(`${url}/api/plugins`)).json()).plugins.map((p) => p.id);
  check(
    expected.length > 0 && expected.every((id) => plugins.includes(id)),
    `lists the bundled plugins (${expected.join(', ')})`,
  );

  const rendered = await fetch(`${url}/api/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'loudness', audio: sineWav() }),
  });
  const report = await rendered.json();
  check(
    rendered.status === 200 &&
      Math.abs(report.durationSeconds - 1) < 0.01 &&
      Number.isFinite(report.integratedLufs),
    'measures loudness on the render node',
  );
  const info = await (await fetch(`${url}/api/node/info`)).json();
  check(
    info.mode === 'workers' && typeof info.engineVersion === 'string',
    `rendered in a worker thread (engine ${info.engineVersion})`,
  );
  check(!/render worker/i.test(log.join('')), 'no render worker warnings');

  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  server = undefined;
  console.log(`Smoke test passed: Song Deck ${version}`);
}

main()
  .then(() => cleanup())
  .catch((err) => {
    console.error(`\nSmoke test failed: ${err.message}`);
    if (log.length) console.error(`\nServer output:\n${log.join('')}`);
    cleanup();
    process.exit(1);
  });
