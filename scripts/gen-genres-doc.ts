/**
 * Regenerates docs/GENRES.md from the genre profiles and the tag catalog.
 *   npm run docs:genres          write the file
 *   npm run docs:genres -- --check   exit 1 when the file is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderGenresDoc } from '../packages/core/src/composer/genre-docs';

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'GENRES.md');
const doc = renderGenresDoc();
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // missing → stale
  }
  if (current !== doc) {
    console.error('docs/GENRES.md is stale: run `npm run docs:genres`.');
    process.exit(1);
  }
  console.log('docs/GENRES.md is up to date.');
} else {
  writeFileSync(target, doc);
  console.log(`Wrote ${target} (${doc.length} bytes).`);
}
