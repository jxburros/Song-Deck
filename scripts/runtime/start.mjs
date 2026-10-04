#!/usr/bin/env node
/** Stable entry point for both a checkout and release download. Updates never overwrite it. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = existsSync(path.join(here, 'songdeck-runtime.mjs'))
  ? path.resolve(here, '..')
  : path.resolve(here, '../..');
const updates = path.join(root, '.songdeck-updates');
const args = process.argv.slice(2);
const informational = args.some((a) => ['--help', '-h', '--version', '-v'].includes(a));
const initial = existsSync(path.join(root, 'server/songdeck-runtime.mjs'))
  ? [path.join(root, 'server/songdeck-runtime.mjs')]
  : ['--import', fileURLToPath(import.meta.resolve('tsx')), path.join(root, 'apps/server/src/cli.ts')];

function readPointer(name) {
  try {
    const pointer = JSON.parse(readFileSync(path.join(updates, name + '.json'), 'utf8'));
    if (
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pointer.version) ||
      !new RegExp(`^version-${pointer.version.replaceAll('.', '\\.')}-[a-zA-Z0-9]+$`).test(pointer.directory)
    )
      return null;
    if (!existsSync(path.join(updates, pointer.directory, 'server/songdeck-runtime.mjs'))) return null;
    return pointer;
  } catch {
    return null;
  }
}
function writePointer(name, pointer) {
  const file = path.join(updates, name + '.json');
  writeFileSync(file + '.tmp', JSON.stringify(pointer) + '\n', { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

let child;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });

function launch(skipPending = false) {
  const current = readPointer('current');
  const pending = !skipPending && !informational ? readPointer('pending') : null;
  const selected = pending || current;
  const entry = selected ? [path.join(updates, selected.directory, 'server/songdeck-runtime.mjs')] : initial;
  let ready = false;
  let restarting = false;
  child = spawn(process.execPath, [...entry, ...args], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, SONGDECK_INSTALL_ROOT: root, SONGDECK_LAUNCHER: '1' },
  });
  const launched = child;
  let forceTimeout;
  const startupTimeout = pending
    ? setTimeout(() => {
        launched.kill('SIGTERM');
        forceTimeout = setTimeout(() => launched.kill('SIGKILL'), 5000);
      }, 30_000)
    : undefined;
  child.on('message', (message) => {
    if (message === 'songdeck:ready') {
      ready = true;
      clearTimeout(startupTimeout);
      if (pending) {
        try {
          writePointer('current', pending);
          if (readPointer('pending')?.directory === pending.directory)
            rmSync(path.join(updates, 'pending.json'), { force: true });
        } catch (error) {
          console.error('Could not save the active update:', error.message);
        }
      }
    }
    if (message === 'songdeck:restart' && ready && !stopping) restarting = true;
  });
  child.on('error', (error) => {
    console.error('Could not launch Song Deck:', error.message);
  });
  child.on('exit', (code, signal) => {
    clearTimeout(startupTimeout);
    clearTimeout(forceTimeout);
    if (stopping) {
      process.exitCode = 0;
      return;
    }
    if (pending && !ready) {
      console.error(`Song Deck ${pending.version} failed to start; returning to the previous version.`);
      try {
        renameSync(path.join(updates, 'pending.json'), path.join(updates, 'failed.json'));
      } catch {}
      launch(true);
    } else if (restarting && code === 0) launch();
    else process.exitCode = code ?? (signal ? 1 : 0);
  });
}
launch();
