# Song Deck

**A structured AI music workstation where AI composes, performs, and produces music without taking the composition away from you.**

> Generate a song. Keep the song. Change the notes. Change the instruments. Change the singer. Change the production. Regenerate only what you want. Use whichever AI you want.

Song Deck creates the _composition_ first — structure, harmony, melodies, rhythms, instrumentation, MIDI, lyrics and musical metadata — and treats audio as a rendering of that composition. Everything is editable, lockable, reproducible by seed, versioned, and exportable. AI providers are interchangeable plug-ins selected by capability; with none configured, the built-in deterministic engine does the job fully offline.

Use **Expand** to import a short MIDI or audio clip, label verse/chorus/hook regions, and build an arrangement from preserved source sections and newly developed material. Preview, vary by seed, export MIDI, or open the result as a new project. See [musical-generation research and expansion limits](./docs/MIDI-RESEARCH.md).

The full product specification lives in [`Song Deck.md`](./Song%20Deck.md). How the code maps onto it is in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), and what each phase delivers (and its honest limits) is in [`docs/PHASES.md`](./docs/PHASES.md).

## Download

Prebuilt downloads are on the [Releases page](https://github.com/jxburros/Song-Deck/releases). Unpack
`song-deck-<version>.zip`, then, with [Node.js](https://nodejs.org) 20.19 or newer:

```bash
node server/songdeck-server.mjs    # studio + local server at http://localhost:7788
```

What changed in each version is in [`CHANGELOG.md`](./CHANGELOG.md); how releases are made is in
[`docs/RELEASING.md`](./docs/RELEASING.md).

## Quick start

```bash
npm install
npm run dev            # studio at http://localhost:5173 (works fully in-browser)
npm run dev:server     # optional local runtime at http://localhost:7788
```

The studio works on its own (projects are stored in the browser, rendering and analysis run in Web Workers). Start the local server to add an OS-keychain credential vault and provider proxy (API keys never touch the browser or project files), hardware detection and the local model manager, render nodes, real-time collaboration, the plugin host and the managed "Automatic" AI gateway.

```bash
npm run build          # production build of the studio (apps/studio/dist)
npm run start:server   # serves the built studio + API at http://localhost:7788
npm test               # unit/integration tests for every package
npm run typecheck
npm run e2e            # Playwright end-to-end and accessibility tests (Chromium)
npm run lint           # ESLint; `npm run format` / `format:check` for Prettier
npm run size           # entry-chunk and first-paint bundle budget (after a build)
```

CI runs all of these on every pull request (`.github/workflows/ci.yml`), plus Ruff for the Python
bridges, CodeQL and dependency review.

## Updating Song Deck

Open **Settings → General → App updates** to check for a stable release, download it, and
restart the server when you are ready. Start source checkouts with `npm run start:server`;
release downloads use `node server/songdeck-server.mjs` (or `npm start`). Development mode
(`npm run dev:server`) can check for releases but cannot install them.

Turn on **Automatically download and install updates on next start** to check at server startup
and every six hours. It is off by default. Updates are verified against the release's SHA-256
checksums, staged separately, and activated on the next server start. The app never restarts or
reloads your studio automatically. Save your work in all tabs before using **Restart to update**;
once it returns, use **Reload studio**. A build that fails to start rolls back to the previous
version. Your browser projects, server data, credentials, and settings remain in their existing
locations. Keep using the same server address and port to retain access to browser storage.

Private repositories require a server-side `SONGDECK_UPDATE_TOKEN` environment variable with
read access to repository contents. The token is used only for the fixed Song Deck GitHub API
and is never returned to the studio. Update controls are restricted to connections from the
server's own computer. Browser-only/static installations use the Releases download link.
Automatic updates contact GitHub independently of the studio's AI offline setting; turn off the
update checkbox to stop future downloads. Already staged updates still apply on next start.

The launcher and staged versions live in the installation folder (`.songdeck-updates/`), so that
folder must be writable. Keep launching the original installation; source files are not rewritten
when a packaged update is activated. New releases must include the updater-compatible runtime
and `SHA256SUMS.txt`. Existing older installations need a one-time manual upgrade to this launcher.

## Making a song

- **Compose** accepts any combination of a model-backed text prompt, audio recordings or rough ideas,
  MIDI files, saved library items, lyrics, and an editable composer table. Each recording or MIDI input
  has its own start bar and interpretation level: Preserve (the default), Light, Moderate, or Free.
  Preserved material retains its playback timing and is locked in the resulting song. Reinterpreting
  audio first reconstructs editable MIDI; the original recording is retained as a project asset.
- **Lyrics** can be supplied, generated from a prompt with a configured lyrics model, replaced by
  clearly marked placeholders, or omitted for an instrumental song.
- **Single Track** creates standalone MIDI, renders an instrument part to WAV, or converts recorded
  audio to MIDI. It keeps separate settings from project track tools. Results can be exported or
  explicitly saved to the Library.
- **Library** keeps tracks, track collections, audio, and other files in browser storage independently
  of projects. Reusing an item makes a fresh copy; deleting a project does not delete the saved item.
  Save from generation results, workbench track selections, recent exports, or import files directly.
- The header identifies the open project. Its compact arrangement timeline shows tracks, clips,
  sections, and a live playhead, with click-to-seek and a keyboard-accessible seek control.
- **Project tools** group the workbench, track generation/transcription, production, vocals, mixing,
  and export beneath the project timeline.
- **Connect an AI service** in Settings → Providers. Keys stay in the local server's vault or,
  without it, encrypted in the browser ([`docs/CREDENTIALS.md`](./docs/CREDENTIALS.md)).
- Uploaded audio uses the existing rights attestation flow; see [`docs/RIGHTS.md`](./docs/RIGHTS.md).

### Local AI models (optional)

Local engines plug in through small JSON/HTTP contracts. To try the whole pipeline without any
model, run the dependency-free mock bridge and add a local preset under Settings → Providers:

```bash
python3 bridges/mock_bridge.py --role all   # music, singing, separation, transcription, voice, mastering on :8810-8815
```

Reference bridges for ACE-Step, DiffSinger, Demucs, Basic Pitch, RVC and Matchering are in
[`bridges/`](./bridges); Ollama, LM Studio, llama.cpp and vLLM work through their own presets.

### Plugins

Enable the bundled examples under Settings → Plugins (the local server must be running). How to
write your own: [`docs/PLUGINS.md`](./docs/PLUGINS.md).

## Repository layout

| Path               | What it is                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`    | Music Engine: Music IR, theory engine, composition engine (genres, blueprint, planner, role generators, arrangement, macros, locks, regeneration, variation, Song DNA), musical intelligence (natural-language edits, theory explanations, lyrics, mix assistant), validation engine & proposals, MIDI/MusicXML/PDF/DAWproject/Reaper serialization, `.songproject` packages, version history & branches, task engine |
| `packages/audio`   | Audio Engine in pure TypeScript: synthesis & guide rendering, streaming renderer, mixer & effects & automation, mastering & EBU R128 loudness, WAV/FLAC codecs, singing synthesis, and analysis (tempo, key, chords, pitch, transcription, source separation, structure, Rebuild)                                                                                                                                     |
| `packages/ai`      | AI Orchestrator: capability taxonomy, provider registry & capability router, profiles, routing rules, privacy data-flow, cost & budgets, MusicContext, structured output, adapters (OpenAI-compatible, Anthropic, Gemini, Ollama, custom HTTP, ElevenLabs Music, Stable Audio, Lyria, local model bridges)                                                                                                            |
| `apps/studio`      | The workstation UI (React + Vite)                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/server`      | Local runtime server (Node)                                                                                                                                                                                                                                                                                                                                                                                           |
| `plugins/`         | Example plugins: a genre profile, an exporter (ABC notation) and an SFZ sampled instrument                                                                                                                                                                                                                                                                                                                            |
| `bridges/`         | Reference HTTP bridges for local models (ACE-Step, DiffSinger, Demucs, Basic Pitch, RVC, Matchering) and a dependency-free mock bridge                                                                                                                                                                                                                                                                                |
| `docs/`            | Architecture, phases, genres and tags, brand, credentials, rights, plugins and releasing                                                                                                                                                                                                                                                                                                                              |
| `scripts/release/` | Release tooling (version checks, packaging, smoke test) used by `.github/workflows/release.yml`                                                                                                                                                                                                                                                                                                                       |

## License

See repository settings.
