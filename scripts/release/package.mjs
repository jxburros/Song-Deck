#!/usr/bin/env node
// Packages a release from a built checkout (run `npm run build` first):
//
//   <out>/song-deck-<version>.zip, .tar.gz   studio + local server for Node.js, plugins, bridges, docs
//   <out>/song-deck-studio-<version>.zip      the studio alone, as static files
//   <out>/SHA256SUMS.txt
//
// The server is bundled with esbuild into plain JavaScript (server/songdeck-server.mjs and its
// render worker), so the download needs nothing but Node.js. Archives are reproducible: sorted
// entries, fixed permissions and every timestamp set to SOURCE_DATE_EPOCH (default: the last
// commit's time).
//
// Usage: node scripts/release/package.mjs [--out dist/release]
process.env.TZ = 'UTC'; // zip timestamps are local time; pin them before any Date is created

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { zipSync } from 'fflate';
import { fail, githubRepo, manifests, parseVersion, readJson, ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'dist/release';
if (!outArg || outArg.startsWith('--')) fail('--out needs a directory');
const OUT = path.resolve(ROOT, outArg);

const version = parseVersion(readJson('package.json').version);
if (!version) fail('package.json has no valid version');
const STUDIO_DIST = path.join(ROOT, 'apps/studio/dist');
if (!existsSync(path.join(STUDIO_DIST, 'index.html')))
  fail('apps/studio/dist is missing; run "npm run build" first');

const epoch =
  Number(process.env.SOURCE_DATE_EPOCH) ||
  Number(gitOr(['log', '-1', '--format=%ct'], '')) ||
  Math.floor(Date.now() / 1000);
const MTIME = new Date(epoch * 1000);

const NAME = `song-deck-${version}`;
const STUDIO_NAME = `song-deck-studio-${version}`;
const STAGE = path.join(OUT, 'stage', NAME);

function gitOr(argv, fallback) {
  try {
    return execFileSync('git', argv, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

const skip = (name) =>
  name.startsWith('.') || name === 'node_modules' || name === '__pycache__' || name.endsWith('.pyc');

/** Copies a directory, leaving out dotfiles, node_modules, Python caches and anything `exclude` names. */
function copyTree(from, to, exclude = () => false) {
  cpSync(from, to, { recursive: true, filter: (src) => !skip(path.basename(src)) && !exclude(src) });
}

// --- 1. stage ---------------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const releaseDefine = { __SONGDECK_RELEASE__: JSON.stringify({ version }) };
const shared = {
  absWorkingDir: ROOT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: releaseDefine,
  // CommonJS dependencies (ws) call require() for Node built-ins; ES modules have no require.
  banner: {
    js: "import { createRequire as __songdeckRequire } from 'node:module';\nconst require = __songdeckRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
};
const server = await esbuild.build({
  ...shared,
  entryPoints: [path.join(ROOT, 'apps/server/src/cli.ts')],
  outfile: path.join(STAGE, 'server/songdeck-server.mjs'),
});
// The pool loads ./worker-entry.mjs next to the server; in the monorepo that file registers tsx
// first, here the worker is already plain JavaScript.
const worker = await esbuild.build({
  ...shared,
  stdin: {
    contents: [
      "import { parentPort } from 'node:worker_threads';",
      "import { startWorkerLoop } from './apps/server/src/render/worker.ts';",
      "if (!parentPort) throw new Error('worker-entry.mjs must run in a worker thread');",
      'startWorkerLoop(parentPort);',
    ].join('\n'),
    resolveDir: ROOT,
    sourcefile: 'worker-entry.mjs',
    loader: 'ts',
  },
  outfile: path.join(STAGE, 'server/worker-entry.mjs'),
});
// The CLI's shebang asks for tsx; the bundle runs on plain Node.
const serverFile = path.join(STAGE, 'server/songdeck-server.mjs');
writeFileSync(serverFile, readFileSync(serverFile, 'utf8').replace(/^#![^\n]*\n/, '#!/usr/bin/env node\n'));

copyTree(STUDIO_DIST, path.join(STAGE, 'studio'), (src) => src.endsWith('.map'));
copyTree(path.join(ROOT, 'plugins'), path.join(STAGE, 'plugins'));
copyTree(path.join(ROOT, 'bridges'), path.join(STAGE, 'bridges'));
for (const doc of ['ARCHITECTURE.md', 'PHASES.md', 'PLUGINS.md'])
  cpSync(path.join(ROOT, 'docs', doc), path.join(STAGE, 'docs', doc));
cpSync(path.join(ROOT, 'CHANGELOG.md'), path.join(STAGE, 'CHANGELOG.md'));

const repoUrl = githubRepo();
const template = readFileSync(path.join(ROOT, 'scripts/release/README.release.md'), 'utf8');
writeFileSync(
  path.join(STAGE, 'README.md'),
  template.replaceAll('{{version}}', version).replaceAll('{{repo}}', repoUrl || 'the Song Deck repository'),
);

const serverPkg = readJson('apps/server/package.json');
writeFileSync(
  path.join(STAGE, 'package.json'),
  `${JSON.stringify(
    {
      name: 'song-deck',
      version,
      private: true,
      description: 'Song Deck — structured AI music studio (release build)',
      type: 'module',
      engines: readJson('package.json').engines,
      scripts: { start: 'node server/songdeck-server.mjs' },
      // `npm install` here adds OS keychain support; without it keys go to the encrypted-file vault.
      optionalDependencies: serverPkg.optionalDependencies,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  path.join(STAGE, 'THIRD_PARTY_NOTICES.txt'),
  thirdPartyNotices([server.metafile, worker.metafile]),
);

// --- 2. archives ------------------------------------------------------------------------------
/** Files under `dir` as sorted `[relativePath, absolutePath]` pairs. */
function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((e) =>
      e.isDirectory()
        ? listFiles(path.join(dir, e.name), base)
        : [[path.relative(base, path.join(dir, e.name)).split(path.sep).join('/'), path.join(dir, e.name)]],
    );
}

/** 0755 for the server entry points and for files that are executable in the checkout (bridges), else 0644. */
const modeOf = (rel, abs) =>
  /^[^/]+\/server\/[^/]+\.mjs$/.test(rel) || statSync(abs).mode & 0o111 ? 0o755 : 0o644;

function zipDir(dir, prefix) {
  const entries = {};
  for (const [rel, abs] of listFiles(dir)) {
    const name = `${prefix}/${rel}`;
    entries[name] = [
      readFileSync(abs),
      { mtime: MTIME, os: 3, attrs: ((0o100000 | modeOf(name, abs)) << 16) >>> 0, level: 9 },
    ];
  }
  return zipSync(entries);
}

/** A POSIX ustar archive (directories first in path order, then their files). */
function tarDir(dir, prefix) {
  const blocks = [];
  const header = (name, size, mode, type) => {
    const h = Buffer.alloc(512);
    let base = name;
    let pre = '';
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf('/', 155);
      if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) fail(`path too long for tar: ${name}`);
      pre = name.slice(0, cut);
      base = name.slice(cut + 1);
    }
    const put = (value, offset, length) => h.write(value, offset, length, 'utf8');
    const octal = (n, length) => `${n.toString(8).padStart(length - 1, '0')}\0`;
    put(base, 0, 100);
    put(octal(mode, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(size, 12), 124, 12);
    put(octal(epoch, 12), 136, 12);
    put('        ', 148, 8);
    put(type, 156, 1);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    put('root', 265, 32);
    put('root', 297, 32);
    put(pre, 345, 155);
    let sum = 0;
    for (const byte of h) sum += byte;
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(h);
  };
  const dirs = new Set([prefix]);
  const files = listFiles(dir).map(([rel, abs]) => [`${prefix}/${rel}`, abs]);
  for (const [name] of files)
    for (let i = name.indexOf('/'); i > 0; i = name.indexOf('/', i + 1)) dirs.add(name.slice(0, i));
  for (const d of [...dirs].sort()) header(`${d}/`, 0, 0o755, '5');
  for (const [name, abs] of files) {
    const data = readFileSync(abs);
    header(name, data.length, modeOf(name, abs), '0');
    blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

const outputs = [
  [`${NAME}.zip`, zipDir(STAGE, NAME)],
  [`${NAME}.tar.gz`, tarDir(STAGE, NAME)],
  [`${STUDIO_NAME}.zip`, zipDir(path.join(STAGE, 'studio'), STUDIO_NAME)],
];
const sums = [];
for (const [file, bytes] of outputs) {
  writeFileSync(path.join(OUT, file), bytes);
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${file}`);
}
writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(
  `Song Deck ${version} packaged in ${path.relative(ROOT, OUT) || '.'} (timestamps ${MTIME.toISOString()}):`,
);
for (const [file, bytes] of outputs) console.log(`  ${file.padEnd(32)} ${mb(bytes.length)}`);
console.log(`  ${'SHA256SUMS.txt'.padEnd(32)} ${sums.length} checksums`);
console.log(
  `  server bundle: ${mb(statSync(serverFile).size)}, render worker: ${mb(statSync(path.join(STAGE, 'server/worker-entry.mjs')).size)}`,
);

// --- helpers ----------------------------------------------------------------------------------
/**
 * License texts of the third-party packages a user receives: everything bundled into the server
 * (from esbuild's metafiles) and the runtime dependencies of the studio and the engine packages
 * (resolved through package-lock.json).
 */
function thirdPartyNotices(metafiles) {
  const lock = readJson('package-lock.json').packages;
  const found = new Map(); // lock path → package name
  const add = (lockPath) => {
    if (found.has(lockPath) || !lock[lockPath] || lock[lockPath].link) return false;
    found.set(lockPath, lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length));
    return true;
  };
  // Server bundle: the node_modules directories esbuild actually read.
  for (const meta of metafiles) {
    for (const input of Object.keys(meta.inputs)) {
      const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.split(path.sep).join('/'));
      if (m) add(m[1]);
    }
  }
  // Studio and engine packages: their runtime dependency closure.
  const resolve = (from, dep) => {
    for (
      let dir = from;
      ;
      dir = dir.includes('/node_modules/') ? dir.slice(0, dir.lastIndexOf('/node_modules/')) : ''
    ) {
      const candidate = dir ? `${dir}/node_modules/${dep}` : `node_modules/${dep}`;
      if (lock[candidate]) return lock[candidate].link ? undefined : candidate;
      if (!dir) return undefined;
    }
  };
  const queue = manifests()
    .slice(1)
    .filter(({ dir }) => dir !== 'apps/server') // bundled above, exactly
    .flatMap(({ dir, pkg }) => Object.keys(pkg.dependencies ?? {}).map((dep) => [dir, dep]));
  while (queue.length) {
    const [from, dep] = queue.shift();
    const at = resolve(from, dep);
    if (at && add(at)) for (const next of Object.keys(lock[at].dependencies ?? {})) queue.push([at, next]);
  }
  const sections = [...found.entries()]
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([lockPath]) => {
      const dir = path.join(ROOT, lockPath);
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
      const text = licenseFile
        ? readFileSync(path.join(dir, licenseFile), 'utf8').trim()
        : `License: ${pkg.license ?? 'see package'}`;
      return `${'='.repeat(78)}\n${pkg.name}@${pkg.version} — ${pkg.license ?? 'unknown license'}\n${pkg.homepage ?? ''}\n${'-'.repeat(78)}\n${text}\n`;
    });
  return `Song Deck ${version} includes the following third-party software.\n\n${sections.join('\n')}`;
}
