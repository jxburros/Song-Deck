# Song Deck

**A structured AI music workstation where AI composes, performs, and produces music without taking the composition away from you.**

> Generate a song. Keep the song. Change the notes. Change the instruments. Change the singer. Change the production. Regenerate only what you want. Use whichever AI you want.

Song Deck creates the _composition_ first — structure, harmony, melodies, rhythms, instrumentation, MIDI, lyrics and musical metadata — and treats audio as a rendering of that composition. Everything is editable, lockable, reproducible by seed, versioned, and exportable. AI providers are interchangeable plug-ins selected by capability; with none configured, the built-in deterministic engine does the job fully offline.

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
npm run e2e            # Playwright end-to-end tests (Chromium)
```

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
| `scripts/release/` | Release tooling (version checks, packaging, smoke test) used by `.github/workflows/release.yml`                                                                                                                                                                                                                                                                                                                       |

## License

See repository settings.
