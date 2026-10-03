# @songdeck/server — Song Deck local runtime

The browser studio (`apps/studio`) runs everything it can in the browser. This server adds what a
browser cannot do securely or at all: an OS-keychain credential vault, a provider proxy that keeps
API keys out of the browser, hardware detection, a model manager, worker-thread render nodes, a
collaboration hub, a plugin host, the managed "Automatic" gateway, and disk storage for
`.songproject` packages. It can also serve the built studio, which makes `songdeck-server` a
complete local app.

## Running

```sh
# from the repo root
npx tsx apps/server/src/cli.ts                     # http://127.0.0.1:7788
npm run start:server                               # same, via the workspace script
npm run start -w @songdeck/server -- --port 7790   # passing flags through npm
npx tsx apps/server/src/cli.ts --port 0 --data-dir /tmp/sd --no-persist
```

| Flag | Default | |
| --- | --- | --- |
| `--port <n>` | `7788` | `0` picks a free port |
| `--host <addr>` | `127.0.0.1` | a non-loopback host **requires** `--token` |
| `--data-dir <dir>` | `$SONGDECK_DATA_DIR` or `~/.songdeck` | vault, providers, projects, collab rooms, models, plugins |
| `--static <dir>` / `--no-static` | `apps/studio/dist` if built (`studio/` in a release download) | serves the studio with SPA fallback |
| `--token <secret>` | `$SONGDECK_TOKEN` | every `/api` request except `/api/health` needs `Authorization: Bearer <secret>` |
| `--allow-origin <url>` | `http://localhost:5173`, `http://127.0.0.1:5173` | repeatable; replaces the defaults; same-origin is always allowed |
| `--vault <backend>` | `auto` | `auto` · `keychain` · `encrypted-file` · `memory` |
| `--no-persist` | | secrets live in memory only |
| `--workers <n>` | cpus − 1 | render worker threads |
| `--node-name <name>` | host name | render node display name |
| `--plugins-dir <dir>` | `<repo>/plugins` (`plugins/` in a release download), `<data-dir>/plugins` | repeatable |
| `--log-level <level>` / `--quiet` | `info` | `silent`, `error`, `warn`, `info`, `debug` |

In development the Vite dev server (port 5173) proxies `/api` (including the WebSocket) to 7788,
so the studio and the server share an origin.

A **remote render node** on another machine:
`songdeck-server --host 0.0.0.0 --token "$(openssl rand -hex 24)" --allow-origin http://<studio-host>:5173`,
then add its URL and token under Settings → Render nodes in the studio.

Programmatic use (tests, embedding):

```ts
import { createSongDeckServer } from '@songdeck/server';
const app = createSongDeckServer({ port: 0, dataDir, vault: 'memory', logLevel: 'silent' });
const { url } = await app.listen();
await app.close();
```

## Endpoints

All JSON unless noted. Errors are always `{ "error": string, "code": string }` with a matching
HTTP status (`400` validation, `401` token, `403` origin/host/allowlist, `404`, `405`, `409`,
`413` too large, `429` busy, `5xx`).

| Method & path | |
| --- | --- |
| `GET /api/health` | `{ name: 'songdeck-server', version, vault: { backend }, features[], dataDir, auth: { required } }` (no token needed; `dataDir` only when authorized) |
| `GET /api/vault` | `{ backend, detail?, refs: [{ ref, label?, updatedAt }] }` — never secrets |
| `PUT /api/vault/:ref` | `{ secret, label? }` → `204` |
| `DELETE /api/vault/:ref` | `204` |
| `GET /api/providers` | `{ providers: ProviderConfig[] }` |
| `PUT /api/providers` | `{ providers }` → `{ providers }`; configs with secrets are rejected (`secret-in-config`) |
| `POST /api/proxy` | provider proxy (see below) |
| `GET /api/hardware[?refresh=1]` | `HardwareInfo` (cached 60 s) |
| `GET /api/models[?refresh=1]` | `{ categories: [{ id, label, models: ModelEntry[] }], sources, hardware, scannedAt }` |
| `POST /api/models/rescan` | same, rescanned |
| `GET /api/local-services` | `{ services: [{ presetId, name, baseUrl, status: 'found' \| 'absent' \| 'error', models, capabilities?, version? }], scannedAt }` |
| `POST /api/connect/probe` | body `{ presetId, secret }` → `{ ok: true, result: { models, listed, account?, note? } }` or `{ ok: false, error: { kind, status?, message } }` |
| `GET /api/node/info` | `{ id, name, version, engineVersion, cpuCores, loadAvg, busyJobs, queuedJobs, maxJobs, maxQueue, capabilities, mode, … }` |
| `POST /api/render` | render job (see below) |
| `GET /api/collab/rooms` | `[{ projectId, peers, revisions }]` |
| `GET /api/collab/rooms/:id` | `{ projectId, peers, revisions, branches, comments }` |
| `GET /api/collab/rooms/:id/revisions/:revId` | the full `Revision` (with snapshot) |
| `WS /api/collab` | collaboration protocol (see below); token via `?access_token=` |
| `GET /api/plugins` | `{ plugins: PluginRecord[], errors: [{ dir, id?, error }] }` |
| `GET /api/plugins/:id/files/<path>` | plugin file with its MIME type |
| `GET /api/managed/status` | which task roles the gateway can serve (and offline) |
| `POST /api/managed/llm` · `/audio` · `/models` | managed "Automatic" gateway (`@songdeck/ai` contract) |
| `GET /api/projects` | `{ projects: [{ name, file, size, mtime }] }` |
| `GET /api/projects/:name` | `.songproject` bytes |
| `PUT /api/projects/:name` | `.songproject` bytes (`application/octet-stream`) → `201`/`200 { name, file, size, mtime }` |
| `DELETE /api/projects/:name` | `204` |

### Provider proxy — `POST /api/proxy`

Implements the contract of `ServerProxyTransport` (`packages/ai/src/transport/proxy.ts`):

```json
{ "url": "https://api.anthropic.com/v1/messages", "method": "POST",
  "headers": { "content-type": "application/json", "x-api-key": "proxy-managed" },
  "body": "{…}", "bodyEncoding": "utf8",
  "credentialRef": "provider:anthropic", "auth": { "type": "header", "name": "x-api-key" } }
```

The secret is read from the vault and injected per `auth` (`bearer` → `Authorization: Bearer …`,
`header` → `<name>: <prefix><secret>` replacing placeholders, `query` → `?<name>=<secret>`). The
upstream status, headers (minus hop-by-hop, cookies, encoding/length) and body are streamed back
unchanged (binary-safe). Failures of the proxy itself carry `x-songdeck-proxy-error: 1`:
`403 not-allowlisted`, `403 credential-scope`, `502 credential-missing`, `502 upstream-error`,
`504 upstream-timeout`, `400 invalid-envelope`. Client disconnects abort the upstream request.

### Render jobs — `POST /api/render`

```json
{ "kind": "mix" | "stems" | "track" | "master" | "loudness",
  "song": Song, "trackId": "…",
  "options": { "sampleRate": 44100, "applyMaster": true, "trackIds": ["…"], "by": "stemGroup" | "track",
               "startTick": 0, "endTick": 7680, "tailSeconds": 2, "bitDepth": 16 | 24 | 32, "seed": 1 },
  "assets": { "<assetId>": "<base64 WAV>" }, "audio": "<base64 WAV>", "mastering": MasteringSettings }
```

`mix`/`track` → `audio/wav` (24-bit by default); `master` → `audio/wav` + `x-songdeck-report`
(JSON `MasteringReport`); `stems` → `{ stems: { name: base64 WAV } }`; `loudness` → the
`LoudnessReport` of `audio` (or of the rendered song). Jobs run in a `worker_threads` pool
(`--workers`), queue up to `4 × workers` deep, and are answered with `429 busy` + `Retry-After`
beyond that. Renders are deterministic, so stems split across several nodes with
`options.trackIds` are identical to a single-node render. Limits: 64 MB request, 30 min of output,
a frame budget for high sample rates / many stems (`413`).

### Collaboration — `WS /api/collab`

Flat JSON messages with a `type` (requests may carry a `reqId`, echoed in the reply):

- client → server: `hello { projectId, user: { id, name, color } }`, `presence { view, trackId?, tick?, selection? }`,
  `commit { branchId, revision }` (full snapshot), `request-revision { id }`,
  `comment { comment: { id, author, text, at, sectionId?, trackId?, tick?, resolved? } }`,
  `resolve-comment { id, resolved? }`, `chat { text }`, `ping`.
- server → client: `welcome { projectId, you: { peerId }, peers, revisions: RevisionMeta[], branches, comments, chat }`,
  `peer-joined`, `peer-left`, `presence`, `commit { branchId, revision, from }`, `ack { revisionId | commentId, duplicate? }`,
  `revision { revision }`, `comment`, `resolve-comment`, `chat`, `error { code, error }`, `pong`.

Rooms are keyed by `projectId`. Revisions are persisted append-only in
`<data-dir>/collab/<projectId>/revisions.jsonl` with one snapshot file per revision id
(`snapshots/<revId>.json`); comments in `comments.jsonl`. Commits are acknowledged only after
they are on disk; re-committing a known revision id is an idempotent `ack { duplicate: true }`.
Messages are limited to 32 MB; dead connections are dropped by ping/pong heartbeats.

### Plugins

Each plugin directory contains `songdeck-plugin.json`:
`{ id, name, version, kind, description, author, entry?, files?, permissions?, homepage? }` with
`kind` one of `ai-provider`, `music-model`, `singing-engine`, `transcription-engine`,
`instrument`, `genre-profile`, `exporter`. The server validates manifests and serves the files;
**it never executes plugin code** — `entry` modules are imported by the studio in the browser,
after the user enables the plugin.

### Model manager

Combines `LOCAL_MODEL_CATALOG` (`@songdeck/ai`) with installed models discovered from Ollama
(`http://127.0.0.1:11434/api/tags`), LM Studio (`http://127.0.0.1:1234/v1/models`), local
OpenAI-compatible / Ollama provider configs, local bridge providers (`GET {baseUrl}/info`, or
`/voices` for singing bridges) and `<data-dir>/models/<dir>/model.json` manifests (a directory
named after a catalog id marks that catalog model installed; its `version` drives
`updateStatus`). Every entry is classified with `classifyCompatibility` against the detected
hardware. Well-known local services are probed even before they are configured: llama.cpp
(`127.0.0.1:8080/v1`), vLLM (`127.0.0.1:8000/v1`), the Song Deck bridges (`127.0.0.1:8810`-`8815`,
`GET /info`) and a custom audio bridge (`127.0.0.1:8820`); `discovery.localServices` overrides the
list (loopback URLs only) and `false` turns it off.

### Connecting services

`GET /api/local-services` probes the same local services plus Ollama and LM Studio in parallel
(short timeouts, loopback only) for the studio's "Found on this machine" list — the server sees
servers the browser cannot reach because of CORS. `POST /api/connect/probe` validates a pasted API
key against one of the connectable cloud presets (`CONNECTABLE_PRESET_IDS`) and lists its models
before anything is saved: only the preset's own base URL is contacted, the key is held in memory
for the request and never stored or logged.

## Security model

- **Loopback by default.** The server binds `127.0.0.1`; binding anything else requires a token.
  Tokens are compared in constant time and accepted as `Authorization: Bearer` or
  `?access_token=` (for WebSockets and ES-module imports, which cannot send headers); query tokens
  are redacted from logs.
- **Browser origins.** Every `/api` request that carries an `Origin` header (including WebSocket
  upgrades, where browsers do not enforce CORS) must come from an allowed origin or the same
  origin, otherwise `403 origin-not-allowed` — so other websites cannot use the vault or the proxy.
- **DNS rebinding.** On a loopback bind only loopback `Host` names are accepted.
- **Secrets.** API keys live in the OS keychain (`@napi-rs/keyring`, service `songdeck`; on Linux
  only the persistent Secret Service is used), verified with a probe at startup. Otherwise they are
  stored AES-256-GCM encrypted in `vault.enc` (random 96-bit nonce per entry, reference/label/
  timestamp authenticated) with a random 32-byte key in `vault.key` (mode 0600) — this protects
  backups and accidental sharing, not against malware running as the same user. Secrets are never
  returned over HTTP, never written to provider configs (rejected) or project files, and only
  injected server-side.
- **Proxy allowlist.** Only URLs inside a registered provider's base URL (origin + path prefix)
  or on loopback hosts are forwarded; a credential is injected only into URLs belonging to the
  provider configured with that `credentialRef`; redirects are followed only within the allowlist
  and drop the credential when they leave the provider's scope; cookies are stripped both ways;
  request/response sizes are capped.
- **Files.** Static, plugin and project paths are resolved lexically and via `realpath` inside
  their roots (no traversal, no symlink escapes, no dotfiles, no directory listings); project
  names are sanitized; uploads are size-limited and written atomically.
- **Plugins** are data to the server; their code only runs in the browser.
- **Renders** run in worker threads with size/duration limits; a cancelled or crashed job's
  worker is replaced.

## Data directory

```
~/.songdeck/
  vault.key, vault.enc        encrypted-file vault (or vault-index.json with the OS keychain)
  providers.json              provider configs (no secrets)
  node.json                   render node id
  projects/*.songproject      stored projects
  collab/<projectId>/         revisions.jsonl, snapshots/, comments.jsonl
  models/<name>/model.json    manually installed local models
  plugins/<name>/             user plugins
```

## Development

```sh
npx tsc -p apps/server                 # typecheck
cd apps/server && npx vitest run       # tests (ephemeral ports, temp data dirs)
```
