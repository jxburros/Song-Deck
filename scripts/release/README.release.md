# Song Deck {{version}}

A structured AI music workstation: AI composes, performs and produces music while the song stays
yours — editable MIDI, lockable, reproducible by seed, versioned and exportable. This download
contains the studio (a web app) and the local Song Deck server, bundled to run with Node.js alone.

## Run it

You need [Node.js](https://nodejs.org) 20.19 or newer.

```bash
node server/songdeck-server.mjs        # or: npm start
```

Then open <http://localhost:7788>. Projects are stored in your browser; the server adds the
credential vault (API keys never enter project files), the provider proxy, hardware detection,
real-time collaboration, plugins, render nodes and the managed "Automatic" AI gateway. Its data
lives in `~/.songdeck` (change it with `--data-dir` or `SONGDECK_DATA_DIR`).

```bash
node server/songdeck-server.mjs --help                  # every option
node server/songdeck-server.mjs --port 8080             # another port
node server/songdeck-server.mjs --host 0.0.0.0 --token "$(openssl rand -hex 24)"   # collaboration server or render node for other machines
```

**OS keychain (optional):** run `npm install` once in this folder to add the native keychain
module (macOS Keychain, Windows Credential Manager, Linux Secret Service). Without it, keys are
kept in an encrypted file in the data directory.

## What is in this folder

| Path | What it is |
| --- | --- |
| `server/` | The local server and its render worker, bundled into plain JavaScript |
| `studio/` | The built studio. Any static web server can also host it on its own, at the root of a site (it runs fully in the browser); the features above need the local server |
| `plugins/` | Example plugins: a genre profile, an ABC-notation exporter and an SFZ sampled instrument. Enable them under Settings → Plugins |
| `bridges/` | Reference HTTP bridges for local models (ACE-Step, DiffSinger, Demucs, Basic Pitch, RVC, Matchering) and a dependency-free mock: `python3 bridges/mock_bridge.py --role all` |
| `docs/` | Architecture, phase coverage (with honest limitations) and the plugin guide |
| `CHANGELOG.md` | What changed in each release |
| `THIRD_PARTY_NOTICES.txt` | Licenses of the open-source software included in this download |

## AI providers

Song Deck works offline with its built-in deterministic engine. Add cloud or local providers
(OpenAI-compatible endpoints, Anthropic, Gemini, Ollama, LM Studio, llama.cpp, vLLM, audio
generation services, local model bridges) under Settings → Providers.

Source code, issues and documentation: {{repo}}
