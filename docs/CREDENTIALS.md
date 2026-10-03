# API keys and connected services

How Song Deck stores the API keys you give it, what that protects against, and how the
"Connect a service" flow reaches providers.

## Where keys live

| Situation                                                                    | Where the key is stored                                                                                | Who can read it back                                                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local server running, "use the server's keychain vault & proxy" on (default) | Server vault: the OS keychain, or an encrypted file where no keychain exists (`apps/server/README.md`) | Only the server. The browser can set and delete keys but never read them; requests go through the server proxy, which injects the key for that provider only. |
| No local server (browser-only mode), or the proxy turned off                 | This browser, encrypted (see below)                                                                    | Song Deck's page in this browser profile                                                                                                                      |
| Browser cannot store it (some private windows, non-secure origins)           | This tab's memory                                                                                      | Song Deck's page, until the tab is closed or reloaded                                                                                                         |

Keys are never written to settings (`localStorage`), project files, exports, provenance records or
logs. Provider configs only hold a reference (`credentialRef`, e.g. `provider:gemini`).

When the server comes online and keys are held by the browser, Settings → Providers offers
**Move to server vault**: each key is copied into the vault and deleted from the browser.
**Forget browser keys** deletes every browser-held key and the encryption key itself.
Settings → General → "Clear local data" also forgets them.

## The encrypted browser store

`EncryptedCredentialStore` (`packages/ai/src/transport/encrypted-store.ts`), wired up in
`apps/studio/src/engine/credentials.ts`:

- On first use it generates an AES-GCM 256-bit key with WebCrypto as **non-extractable** and keeps
  the `CryptoKey` object in a dedicated IndexedDB database (`songdeck-keys`). Page code can use the
  key to encrypt and decrypt but cannot read its bytes; storage dumps show only an opaque handle.
- Each secret is stored as a random 12-byte IV and the ciphertext. The credential reference is bound
  as additional authenticated data, so a record that is altered — or copied to another reference —
  fails to decrypt (the user is asked for the key again) instead of producing a wrong key.
- The database is separate from projects, so project exports and backups never include it.

### What this protects against

- **Reading the browser profile on disk.** IndexedDB files contain ciphertext. Note: browsers keep
  the non-extractable `CryptoKey` in the same profile, so this raises the bar (no plaintext keys
  sitting in files, nothing to grep for, nothing in backups of project data) rather than providing
  protection equivalent to an OS keychain.
- **Other websites.** The same-origin policy keeps other origins away from this origin's IndexedDB.
- **Accidental leaks.** Keys cannot end up in settings exports, project files, screenshots of
  settings JSON or bug reports.

### What it does NOT protect against

- **Script running in Song Deck's origin** — an XSS bug or a malicious plugin can ask the store to
  decrypt, exactly as the app does.
- **Someone using your unlocked browser profile** — they can open Song Deck and use (or re-read via
  developer tools) the keys.
- **Malware on the machine** with access to the profile and the browser's process.

For stronger protection run the local server: keys then live in the OS keychain and never reach the
page at all.

## Connecting a service

Settings → Providers → **Connect a service** (also from the Home screen's first-run card):

1. **Paste a key.** `detectKeyProvider` recognises documented prefixes — Gemini `AIza…`, Anthropic
   `sk-ant-…`, Groq `gsk_…`, OpenAI `sk-proj-…` / `sk-svcacct-…` / `sk-admin-…` (and legacy keys with
   the `T3BlbkFJ` marker), ElevenLabs `sk_…`, Together `tgp_v1_…`. Plain `sk-…` keys are used by
   OpenAI, Stability AI and Moonshot alike, so the user picks one; unknown formats get the full list.
2. **The key is checked live** and every model the account can use is listed (`probeProvider`):
   OpenAI-compatible presets `GET {base}/models`, Anthropic `GET /v1/models`, Gemini
   `GET /v1beta/models`, ElevenLabs `GET /v1/models` (the music model is presented when only speech
   models are listed), Stability AI `GET /v1/user/balance` (no model list; the known Stable Audio
   models are presented). With the local server online the check runs there
   (`POST /api/connect/probe`), which avoids CORS; otherwise it runs from the page.
3. **Models are grouped by what they do in Song Deck** (`groupModels`, from the capability taxonomy
   and task roles): writing & theory (composition planning, lyrics, MIDI edits, theory Q&A, mix
   assistant, listening to audio), music generation, singing & voices, transcription & separation,
   mastering. Models Song Deck cannot use are behind "show all". The best model per use is ticked
   (`recommendModels`).
4. **Add** creates or updates the provider (enabled, `enabledModels`, default model) and stores the
   key as described above. Pickers across the studio offer it immediately.

Lyria models that a Gemini API key can see (e.g. `lyria-3-clip-preview`) are listed as music
generation; choosing one gives the Gemini provider an audio-generation interface. Real-time Lyria
(WebSocket) is not supported; Lyria on Vertex AI (OAuth token) remains under Advanced.

### Browser-only limits (CORS)

From the page, a provider is reachable only if it allows cross-origin requests. Gemini, OpenAI and
Anthropic (with its direct-browser-access header, which the SDK sends) do; for others the check may
fail with a network error, and the message suggests starting the local server.

## Local services

"Found on this machine" lists local AI servers that are running: Ollama (`:11434`), LM Studio
(`:1234`), llama.cpp (`:8080`), vLLM (`:8000`), the Song Deck bridges (`:8810`-`:8815`, `GET /info`)
and a custom audio bridge (`:8820`), each with its models and a one-click **Add**. The local server
probes them in parallel with short timeouts, loopback addresses only (`GET /api/local-services`).
Without the server the page probes them itself, which works only for servers that allow its origin:
Song Deck bridges, llama.cpp and vLLM do by default; start Ollama with `OLLAMA_ORIGINS=<studio
origin>` and turn on "Enable CORS" in LM Studio's server settings.
