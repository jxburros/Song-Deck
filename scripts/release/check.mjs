#!/usr/bin/env node
// Checks that a release can be cut from this checkout:
//   * the root package, every workspace and their @songdeck/* pins carry one version,
//     in package.json and package-lock.json;
//   * it matches the requested tag or version, when one is given;
//   * CHANGELOG.md has a non-empty section for it.
//
// Usage: node scripts/release/check.mjs [v1.2.3 | 1.2.3] [--github-output]
// --github-output appends version, tag and prerelease to $GITHUB_OUTPUT (GitHub Actions).
import { appendFileSync } from 'node:fs';
import { changelogSection, DEPENDENCY_FIELDS, fail, isPrerelease, manifests, parseVersion, readJson, tagFor, workspaceNames } from './lib.mjs';

const args = process.argv.slice(2);
const githubOutput = args.includes('--github-output');
const requested = args.find((a) => !a.startsWith('--'));

const all = manifests();
const version = all[0].pkg.version;
const problems = [];

if (!parseVersion(version)) fail(`package.json version "${version}" is not a semantic version`);
if (requested !== undefined) {
  const want = parseVersion(requested);
  if (!want) fail(`"${requested}" is not a version or a v-prefixed version tag`);
  if (want !== version) {
    fail(`${requested} does not match the package version ${version}. Run "node scripts/release/bump.mjs ${want}" and commit first.`);
  }
}

const names = workspaceNames();
for (const { file, pkg } of all) {
  if (pkg.version !== version) problems.push(`${file}: version is ${pkg.version}, expected ${version}`);
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (names.has(dep) && range !== version) problems.push(`${file}: ${field}.${dep} is "${range}", expected "${version}"`);
    }
  }
}

const lock = readJson('package-lock.json');
if (lock.version !== version) problems.push(`package-lock.json: version is ${lock.version}, expected ${version}`);
for (const { dir } of all) {
  const entry = lock.packages?.[dir === '.' ? '' : dir];
  if (!entry) problems.push(`package-lock.json: no entry for ${dir} (run npm install)`);
  else if (entry.version !== version) problems.push(`package-lock.json: ${dir || '.'} is ${entry.version}, expected ${version} (run npm install)`);
}

const section = changelogSection(version);
if (!section) problems.push(`CHANGELOG.md: no "## [${version}]" section`);
else if (!section.body) problems.push(`CHANGELOG.md: the ${version} section is empty`);

if (problems.length) fail(`release ${version} is not ready:\n  - ${problems.join('\n  - ')}`);

const tag = tagFor(version);
const prerelease = isPrerelease(version);
if (githubOutput) {
  if (!process.env.GITHUB_OUTPUT) fail('--github-output needs $GITHUB_OUTPUT');
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\nprerelease=${prerelease}\n`);
}
console.log(`Release ${version} (tag ${tag}${prerelease ? ', pre-release' : ''}) is consistent across ${all.length} packages and CHANGELOG.md.`);
