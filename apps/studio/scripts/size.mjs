#!/usr/bin/env node
/**
 * Bundle-size budget for the studio (`npm run size -w @songdeck/studio`).
 *
 * Reads dist/index.html, measures the entry chunk and everything the page loads before first paint
 * (entry + modulepreloads + CSS), prints the 15 largest chunks, and exits non-zero when a budget is
 * exceeded. Builds first when dist/ is missing or `--build` is passed.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const KB = 1024;
/** Raw (minified, not gzipped) budgets. */
const BUDGET = {
  entry: 400 * KB,
  initial: 700 * KB,
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
if (process.argv.includes('--build') || !existsSync(join(dist, 'index.html'))) {
  execSync('npx vite build', { cwd: root, stdio: 'inherit' });
}

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = html.match(/<script[^>]+type="module"[^>]+src="\/?([^"]+\.js)"/)?.[1];
if (!entry) {
  console.error('size: no entry <script type="module"> found in dist/index.html');
  process.exit(1);
}
const preloads = [
  ...html.matchAll(/<link[^>]+rel="(?:modulepreload|stylesheet)"[^>]+href="\/?([^"]+)"/g),
].map((m) => m[1]);

const measure = (rel) => {
  const buf = readFileSync(join(dist, rel));
  return { file: rel, raw: buf.length, gzip: gzipSync(buf).length };
};
const fmt = (n) => `${(n / KB).toFixed(1)} KB`.padStart(10);

const entryInfo = measure(entry);
const initial = [entryInfo, ...preloads.map(measure)];
const initialRaw = initial.reduce((sum, f) => sum + f.raw, 0);
const initialGzip = initial.reduce((sum, f) => sum + f.gzip, 0);

const chunks = readdirSync(join(dist, 'assets'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ file: `assets/${f}`, raw: statSync(join(dist, 'assets', f)).size }))
  .sort((a, b) => b.raw - a.raw);

console.log('Largest chunks:');
for (const c of chunks.slice(0, 15)) console.log(`  ${fmt(c.raw)}  ${c.file}`);
console.log('\nLoaded before first paint:');
for (const f of initial) console.log(`  ${fmt(f.raw)}  (gzip ${fmt(f.gzip).trim()})  ${f.file}`);
console.log(
  `\nEntry chunk:   ${fmt(entryInfo.raw)} (gzip ${(entryInfo.gzip / KB).toFixed(1)} KB)   budget ${fmt(BUDGET.entry).trim()}`,
);
console.log(
  `Initial total: ${fmt(initialRaw)} (gzip ${(initialGzip / KB).toFixed(1)} KB)   budget ${fmt(BUDGET.initial).trim()}`,
);

const failures = [];
if (entryInfo.raw > BUDGET.entry)
  failures.push(`entry chunk ${fmt(entryInfo.raw).trim()} exceeds ${fmt(BUDGET.entry).trim()}`);
if (initialRaw > BUDGET.initial)
  failures.push(`initial load ${fmt(initialRaw).trim()} exceeds ${fmt(BUDGET.initial).trim()}`);
if (failures.length) {
  console.error(`\nsize: over budget: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nsize: within budget');
