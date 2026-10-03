#!/usr/bin/env node
// Sets the version of the root package, every workspace and their @songdeck/* pins, in
// package.json and package-lock.json, and opens a CHANGELOG.md section for it: whatever is under
// "## [Unreleased]" becomes the new version's notes.
//
// Usage: node scripts/release/bump.mjs 1.2.3
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEPENDENCY_FIELDS, fail, manifests, parseVersion, ROOT, workspaceNames } from './lib.mjs';

const version = parseVersion(process.argv[2]);
if (!version || process.argv[2].startsWith('v'))
  fail('usage: node scripts/release/bump.mjs <version>, e.g. 0.2.0');

const names = workspaceNames();
const setPins = (pkg) => {
  for (const field of DEPENDENCY_FIELDS) {
    for (const dep of Object.keys(pkg[field] ?? {})) if (names.has(dep)) pkg[field][dep] = version;
  }
};
const writeJson = (file, value) =>
  writeFileSync(path.join(ROOT, file), `${JSON.stringify(value, null, 2)}\n`);

const all = manifests();
const previous = all[0].pkg.version;
for (const { file, pkg } of all) {
  pkg.version = version;
  setPins(pkg);
  writeJson(file, pkg);
}

const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
lock.version = version;
for (const { dir } of all) {
  const entry = lock.packages?.[dir === '.' ? '' : dir];
  if (!entry) fail(`package-lock.json has no entry for ${dir}; run npm install first`);
  entry.version = version;
  setPins(entry);
}
writeJson('package-lock.json', lock);

const changelogFile = path.join(ROOT, 'CHANGELOG.md');
const changelog = readFileSync(changelogFile, 'utf8');
const today = new Date().toISOString().slice(0, 10);
let note = `CHANGELOG.md: "## [${version}]" already exists`;
if (!new RegExp(`^## \\[${version.replace(/[.+]/g, '\\$&')}\\]`, 'm').test(changelog)) {
  if (!/^## \[Unreleased\][^\n]*$/m.test(changelog))
    fail('CHANGELOG.md has no "## [Unreleased]" section to release');
  writeFileSync(
    changelogFile,
    changelog.replace(/^## \[Unreleased\][^\n]*$/m, `## [Unreleased]\n\n## [${version}] - ${today}`),
  );
  note = `CHANGELOG.md: the Unreleased notes are now "## [${version}] - ${today}"`;
}

console.log(`Version ${previous} → ${version} in ${all.length} packages and package-lock.json.\n${note}.
Next: review CHANGELOG.md, run "node scripts/release/check.mjs v${version}", commit, then push the tag v${version}.`);
