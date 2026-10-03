# Releasing Song Deck

Releases are published by the [Release workflow](../.github/workflows/release.yml). It tests the
exact commit being released, builds the downloads, checks that they run, and only then creates the
GitHub release, so a failed step publishes nothing.

## Cut a release

1. **Prepare the version** on a branch and merge it into `main`:

   ```bash
   node scripts/release/bump.mjs 0.2.0     # every package.json, package-lock.json and a CHANGELOG.md section
   # edit CHANGELOG.md: the notes under "## [0.2.0]" become the release notes
   npm run release:check -- v0.2.0         # what the workflow checks first
   ```

   `bump.mjs` moves everything under `## [Unreleased]` into the new version's section, so record
   changes under Unreleased as they land.

2. **Publish** in one of two ways:

   * push a tag: `git tag v0.2.0 origin/main && git push origin v0.2.0`, or
   * run **Actions → Release → Run workflow** on `main` with the version `0.2.0`; the workflow
     tags that commit when it publishes.

   A version with a pre-release suffix (`0.2.0-beta.1`) is published as a pre-release.

3. **Watch the run.** The `Test and package` job:
   * checks that the tag, every package version and CHANGELOG.md agree (and, for a manual run,
     that the tag does not exist yet);
   * runs the typecheck, the unit and integration tests and the Playwright end-to-end tests;
   * builds the studio, packages the downloads (`scripts/release/package.mjs`), unpacks both
     archives and checks that the bundled server starts and serves the studio, the API, the
     plugins and a render job (`scripts/release/smoke.mjs`), then runs browser tests against it.

   The `Publish the GitHub release` job (the only one with write access) creates the release as a
   draft with the notes from CHANGELOG.md and the files attached, then publishes it.

Pull requests that change the release tooling, `CHANGELOG.md` or the package manifests run the
`Test and package` job as a dry run, so a broken release is caught before it is merged.

If a run fails, fix the problem on `main` and release again. A tag that never got a release can be
deleted and pushed again (`git push origin :refs/tags/v0.2.0`); a published version is never
replaced — release the next patch version instead.

## The downloads

| File | Contents |
| --- | --- |
| `song-deck-<version>.zip`, `.tar.gz` | `server/` (the local server and its render worker, bundled by esbuild into plain JavaScript for Node.js 20.19+), `studio/` (the production build without source maps), `plugins/`, `bridges/`, `docs/`, a README, the changelog and `THIRD_PARTY_NOTICES.txt` |
| `song-deck-studio-<version>.zip` | The studio alone, for static hosting at the root of a site |
| `SHA256SUMS.txt` | Checksums of the archives |

The bundled server finds `studio/` and `plugins/` next to its `server/` folder (`APP_PATHS` in
`apps/server/src/config.ts`), and loads the optional OS-keychain module from a `node_modules`
folder beside it, which `npm install` in the download creates. Archives are reproducible: entries
are sorted, permissions fixed and timestamps set to `SOURCE_DATE_EPOCH` (by default the commit
time), so packaging the same commit twice gives the same checksums.

To build and check them locally:

```bash
npm run build
npm run release:package                                   # → dist/release/
npm run release:smoke -- dist/release/song-deck-0.1.0.tar.gz
node scripts/release/notes.mjs 0.1.0                      # the release notes
```
