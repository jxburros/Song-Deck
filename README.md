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
# Optional: use an installed browser instead of Playwright’s download
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run e2e
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

The studio has four areas, always on the left rail (a bottom bar on phones): **Songs**, **Single
Track**, **Library** and **Settings**.

- **With vocals or Instrumental** is the first choice, on the Songs screen and at the top of Start a
  song. Instrumental hides every lyrics option and guarantees no vocal track; With vocals guarantees a
  lead vocal (a guide melody, or a singer when there are lyrics). An instrumental starting point (such
  as Laid-back hip-hop) switches a song without lyrics to Instrumental.
- **Start a song** from the Songs screen with one or more starting points: full or partial
  **lyrics**, **audio** (upload recordings, or hum, sing or play one live), **MIDI** tracks, or a
  **prompt** (when a text model is connected). Add as many as you like on the **Material** step;
  each recording or MIDI input keeps its own start bar and interpretation: Exactly (the default),
  Closely, Loosely, or Just for ideas. Exact material retains its playback timing and is locked in the
  resulting song. Reinterpreting audio first reconstructs editable MIDI; the original recording is
  retained as a project asset.
- **Start from style settings** skips material entirely (on the Songs screen, or **Skip to style
  settings** on an empty Material step): a starting point such as Alt-rock band or Cinematic
  orchestral, or any single basic, is enough to create a song.
- Otherwise a song needs some material **and** at least one basic: a style, mood, instrument, tempo,
  key or length. Values detected from your material (tempo, key, meter, sections) count. The **Shape**
  step holds everything else: starting points, genre blend, moods by section, tags, instruments and
  counts, song settings, the feel macros, and advanced options (planner, seed, destination, and an
  optional review of the blueprint and composition plan). **Create now, rest on Auto** skips Shape.
- **Rebuild a full recording** and **Develop a short clip** (Expand MIDI) are offered on the Material
  step.
- **Lyrics** can be supplied, generated from a prompt with a configured lyrics model, replaced by
  clearly marked placeholders, or omitted for an instrumental song.
- An open song has three steps in its header: **Write** (the arrangement and piano roll beside a
  **Change** panel: describe a change in words, keep or discard proposals, regenerate a range, track
  or everything unlocked, lock, edit notes, save tracks to the Library), **Sound** (instrument and
  level per track, mute and solo, built-in instruments or an AI audio version, and one **Polish for
  release** switch for mastering), and **Export** (the song, stems, MIDI, a project backup or Save to
  Library in one click; every other format under **More formats**).
- **More tools** in the song header lists every detailed editor, grouped and searchable: pattern,
  chords, structure and theory; macros and locks; vocals (lyrics, melody, expression, singer, takes,
  voices, conversion); production (guide sound, production plan, audio versions, region
  regeneration); the full mixing console, automation and mastering; history and branches;
  variations and Song DNA; the inspector with provenance and rights; the assistant; and adding a part
  from words or from audio.
- **Make an audio version** (on Sound, or **Also make an audio version** when creating) saves
  editable MIDI, queues a connected audio model, and adds the resulting mix or stems. Choose the audio
  model in Shape's advanced options or let Auto pick one; models that can follow MIDI or a rendered
  guide are preferred. If you edit the composition during generation, the result is saved as a
  version for you to apply. Normal provider charges apply.
- **Single Track** makes one part with no song open: **Audio to MIDI** (hum, sing, tap, clap or
  upload), **Generate MIDI**, or **Generate audio** (one instrument rendered to WAV). It keeps
  separate settings from a song's own tools. Results can be downloaded, saved to the Library, or used
  to **start a song**.
- **Library** keeps tracks, track sets, audio, lyrics and other files in browser storage independently
  of songs. Using an item makes a fresh copy; deleting a song does not delete the saved item. Save from
  Single Track results, a track's menu in Write, Export, recent exports, or upload files directly.
- The player bar under every song screen has transport, the section strip with a click-to-seek and
  keyboard-accessible seek control, loop and metronome.
- **Connect an AI service** from the Songs screen or Settings → AI services: paste a service API key and click
  **Connect and use**. Song Deck validates the key and enables recommended text and audio models for
  compatible tasks without repeated permission prompts. Connecting preserves your routing preferences;
  model choices are optional and remain available after reload. Choose the service when its key format
  is ambiguous. Local and custom endpoints have a **Save and connect** action in the provider editor.
  Existing connections have an **Allow requests** shortcut. Permissions
  can be changed in Settings → Privacy and spending. Keys stay in the local server's vault or,
  without it, encrypted in the browser ([`docs/CREDENTIALS.md`](./docs/CREDENTIALS.md)).
- Uploaded audio uses the existing rights attestation flow; see [`docs/RIGHTS.md`](./docs/RIGHTS.md).

### Local AI models (optional)

Local engines plug in through small JSON/HTTP contracts. To try the whole pipeline without any
model, run the dependency-free mock bridge and add a local preset under Settings → AI services:

```bash
python3 bridges/mock_bridge.py --role all   # music, singing, separation, transcription, voice, mastering on :8810-8815
```

Reference bridges for ACE-Step, DiffSinger, Demucs, Basic Pitch, RVC and Matchering are in
[`bridges/`](./bridges); Ollama, LM Studio, llama.cpp and vLLM work through their own presets.

### Plugins

Enable the bundled examples under Settings → Advanced → Plugins, genres, instruments (the local
server must be running). How to
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
