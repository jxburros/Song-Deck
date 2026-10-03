#!/usr/bin/env node
// Prints the GitHub release notes for a version: its CHANGELOG.md section followed by the
// download table. Usage: node scripts/release/notes.mjs [version] > notes.md
import { changelogSection, fail, githubRepo, parseVersion, readJson, tagFor } from './lib.mjs';

const version = parseVersion(process.argv[2] ?? readJson('package.json').version);
if (!version) fail(`"${process.argv[2]}" is not a version`);
const section = changelogSection(version);
if (!section?.body) fail(`CHANGELOG.md has no notes for ${version}`);

// Links relative to the repository root would resolve against the release page; point them at
// the tagged files instead.
const repo = githubRepo();
const body = repo
  ? section.body.replace(
      /\]\((?!https?:|mailto:|#)([^)\s]+)\)/g,
      (_, target) => `](${repo}/blob/${tagFor(version)}/${target.replace(/^\.\//, '')})`,
    )
  : section.body;

process.stdout.write(`${body}

## Downloads

| File | What it is |
| --- | --- |
| \`song-deck-${version}.zip\` / \`.tar.gz\` | The studio and the local server, ready to run with Node.js 20.19 or newer: \`node server/songdeck-server.mjs\`, then open http://localhost:7788. Includes the example plugins, the reference model bridges and the docs. |
| \`song-deck-studio-${version}.zip\` | Only the studio, as static files for any web server. It runs fully in the browser; server features (key vault, collaboration, plugins, render nodes) need the local server. |
| \`SHA256SUMS.txt\` | SHA-256 checksums of the files above (\`sha256sum -c SHA256SUMS.txt\`). |
`);
