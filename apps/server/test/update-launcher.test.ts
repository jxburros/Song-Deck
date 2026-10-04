import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(code: string) {
  const root = tempDir();
  roots.push(root);
  const updates = path.join(root, '.songdeck-updates');
  const directory = 'version-0.2.0-fixture';
  mkdirSync(path.join(root, 'server'), { recursive: true });
  mkdirSync(path.join(updates, directory, 'server'), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL('../../../scripts/runtime/start.mjs', import.meta.url)),
    path.join(root, 'server/songdeck-server.mjs'),
  );
  writeFileSync(
    path.join(root, 'server/songdeck-runtime.mjs'),
    "console.log('BASE'); process.send?.('songdeck:ready'); setTimeout(() => process.exit(0), 40);",
  );
  writeFileSync(path.join(updates, directory, 'server/songdeck-runtime.mjs'), code);
  writeFileSync(path.join(updates, 'pending.json'), JSON.stringify({ version: '0.2.0', directory }));
  return { root, updates, directory };
}
async function run(root: string, args: string[] = []) {
  const proc = spawn(process.execPath, [path.join(root, 'server/songdeck-server.mjs'), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (b) => (output += String(b)));
  proc.stderr.on('data', (b) => (output += String(b)));
  const code = await new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('exit', resolve);
  });
  return { code, output };
}
it('activates only after the updated server is ready and keeps it active on subsequent starts', async () => {
  const { root, updates, directory } = setup(
    "console.log('UPDATED'); process.send?.('songdeck:ready'); setTimeout(() => process.exit(0), 40);",
  );
  expect(await run(root)).toMatchObject({ code: 0, output: 'UPDATED\n' });
  expect(JSON.parse(readFileSync(path.join(updates, 'current.json'), 'utf8')).directory).toBe(directory);
  expect(existsSync(path.join(updates, 'pending.json'))).toBe(false);
  expect((await run(root)).output).toBe('UPDATED\n');
});
it('returns to the previous working version when an update cannot start', async () => {
  const { root, updates } = setup("console.error('broken update'); process.exit(1);");
  const result = await run(root);
  expect(result.code).toBe(0);
  expect(result.output).toContain('returning to the previous version');
  expect(result.output).toContain('BASE');
  expect(existsSync(path.join(updates, 'current.json'))).toBe(false);
  expect(existsSync(path.join(updates, 'failed.json'))).toBe(true);
});
it('does not activate pending updates for --version and ignores paths outside the update directory', async () => {
  const { root, updates } = setup("console.log('UPDATED');");
  expect((await run(root, ['--version'])).output).toBe('BASE\n');
  expect(existsSync(path.join(updates, 'pending.json'))).toBe(true);
  writeFileSync(
    path.join(updates, 'pending.json'),
    JSON.stringify({ version: '0.2.0', directory: '../elsewhere' }),
  );
  expect((await run(root)).output).toBe('BASE\n');
});
