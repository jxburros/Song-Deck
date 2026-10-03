// Shared helpers for the release scripts. Plain Node (no TypeScript loader needed).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(ROOT, file), 'utf8'));
}

/** The root package followed by every workspace: `{ dir, file, pkg }` with paths relative to ROOT. */
export function manifests() {
  const root = readJson('package.json');
  return [
    { dir: '.', file: 'package.json', pkg: root },
    ...root.workspaces.map((dir) => ({
      dir,
      file: `${dir}/package.json`,
      pkg: readJson(`${dir}/package.json`),
    })),
  ];
}

/** Names of the workspace packages (`@songdeck/core`, …). */
export function workspaceNames() {
  return new Set(
    manifests()
      .slice(1)
      .map((m) => m.pkg.name),
  );
}

export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** "v0.1.0", "0.1.0" or "refs/tags/v0.1.0" → "0.1.0"; undefined when it is not a semantic version. */
export function parseVersion(input) {
  const v = String(input ?? '')
    .trim()
    .replace(/^refs\/tags\//, '')
    .replace(/^v/, '');
  return SEMVER.test(v) ? v : undefined;
}

export function isPrerelease(version) {
  return version.split('+')[0].includes('-');
}

export const tagFor = (version) => `v${version}`;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `## [version]` heading line and body of CHANGELOG.md, or undefined when there is none. */
export function changelogSection(version, text = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')) {
  const lines = text.split(/\r?\n/);
  const heading = new RegExp(`^## \\[?v?${escapeRegExp(version)}\\]?(?:\\s|$)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .filter((l) => !/^\[[^\]]+\]:\s*\S+/.test(l)) // link reference definitions belong to the whole file
    .join('\n')
    .trim();
  return { heading: lines[start], body };
}

/** https://github.com/<owner>/<repo> from $GITHUB_REPOSITORY (Actions) or the origin remote; '' if unknown. */
export function githubRepo() {
  if (process.env.GITHUB_REPOSITORY) return `https://github.com/${process.env.GITHUB_REPOSITORY}`;
  let remote = '';
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
  const m =
    /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i.exec(remote) ??
    /\/git\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return m ? `https://github.com/${m[1]}` : '';
}

export function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
