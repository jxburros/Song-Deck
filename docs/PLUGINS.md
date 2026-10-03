# Writing Song Deck plugins

Plugins extend the studio with the contribution types listed in spec §57: AI providers, music
models, singing engines, transcription engines, instruments, genre profiles and exporters. Three
working examples live in [`plugins/`](../plugins):

| Example | Kind | Shows |
| --- | --- | --- |
| `lofi-hiphop-genre` | `genre-profile` | Loading a JSON file shipped with the plugin and registering a genre profile |
| `abc-notation-exporter` | `exporter` | Using the core library to turn a song into a new file format |
| `felt-keys-sfz` | `instrument` | A sampled instrument: an SFZ file with WAV samples |

## Trust model

* The local server (`apps/server`) **finds and validates** plugin manifests and **serves** plugin
  files. It never executes plugin code.
* The studio imports a plugin's entry module **only after the user enables it** in
  Settings → Plugins, which shows a trust warning. Plugin code then runs in the studio with the
  same rights as the studio itself, so only enable plugins you trust.
* Providers contributed by plugins go through the same orchestrator as built-in ones. A
  provider declared as `location: 'cloud'` is subject to the privacy confirmation, offline mode
  and budgets (spec §50, §60).

## Where plugins live

The server scans `<repo>/plugins` (bundled examples; `plugins/` in a release download) and
`<data-dir>/plugins` (your own plugins; the data directory defaults to `~/.songdeck`). Add more directories with
`npm run start:server -- --plugins-dir <dir>` (repeatable). Each plugin is a directory with a
`songdeck-plugin.json` manifest:

```json
{
  "id": "felt-keys-sfz",
  "name": "Felt Keys (SFZ sampled instrument)",
  "version": "1.0.0",
  "kind": "instrument",
  "description": "…",
  "author": "…",
  "entry": "index.js",
  "files": ["index.js", "felt-keys.sfz", "samples/felt-c2.wav"],
  "permissions": ["audio"]
}
```

`kind` is one of `ai-provider`, `music-model`, `singing-engine`, `transcription-engine`,
`instrument`, `genre-profile`, `exporter`. Hidden files and paths outside the plugin directory are
never served.

## The entry module

`entry` is a browser ES module that exports `register(api)` (it may be `async`):

```js
export async function register(api) {
  const res = await fetch(api.fileUrl('profile.json'));
  api.registerGenre(await res.json());
  api.log('registered');
}
```

### API (`apiVersion: 1`)

| Member | Purpose |
| --- | --- |
| `core` | The whole `@songdeck/core` library: Music IR helpers, theory engine, timing, MIDI/MusicXML writers… |
| `fileUrl(path)` | URL of a file inside the plugin (samples, JSON, SFZ…) |
| `log(message)` | Write to the browser console, prefixed with the plugin id |
| `registerGenre(profile)` | Add a `GenreProfile` (spec §14) that Compose, Generate MIDI and the composer use like the built-in genres |
| `registerInstrument(profile)` | Add an `InstrumentProfile` (spec §17); its `patchId` picks the built-in synth patch used to play it |
| `registerSampleInstrument({ profile, sfz })` | Add a sampled instrument from an SFZ file and its WAV or FLAC samples; see below |
| `registerExporter(exporter)` | Add a format to Export mode: `{ id, name, extension, mimeType, description?, export(song) }`, where `export` returns a string or `Uint8Array` (sync or async) |
| `ai.createProvider(spec)` | Build a provider instance from provider interfaces (`llm`, `composition`, `audioGeneration`, `singing`, `transcription`, `separation`, `voiceConversion`, `mastering`) plus `capabilities` and `location` |
| `registerProvider(instance)` | Make a provider available to routing (spec §49) and the provider pickers |

### Sampled instruments

`registerSampleInstrument` reads the SFZ file, fetches every sample it references (paths are
relative to the SFZ file and may not leave the plugin), and registers the profile with a patch
that plays those samples, both in playback and in every offline render and export. The parser
supports `<control>`/`<global>`/`<master>`/`<group>`/`<region>` inheritance, `#define`, and the
opcodes `sample`, `default_path`, `key`, `lokey`, `hikey`, `pitch_keycenter`, `lovel`, `hivel`,
`tune`, `transpose`, `volume`, `pan`, `pitch_keytrack`, `amp_veltrack`, `loop_mode`,
`loop_start`, `loop_end`, `offset`, `end`, `ampeg_*`, `group`, `off_by`, `trigger`,
`seq_length`, `seq_position`, `lorand` and `hirand`.

Projects that use a custom instrument store its profile, so they stay portable. Where the
plugin is not installed, the instrument falls back to the synth patch for the profile's
`gmProgram`.

### Provider plugins

```js
export function register(api) {
  api.registerProvider(
    api.ai.createProvider({
      id: 'my-transcriber',
      name: 'My transcriber',
      capabilities: ['AUDIO_TRANSCRIPTION', 'AUDIO_TO_MIDI'],
      location: 'local', // or 'cloud' if audio leaves this machine
      transcription: {
        async transcribeNotes(req) {
          /* … return { notes, confidence } … */
        },
      },
    }),
  );
}
```

The interfaces and capability names are defined in
[`packages/ai/src/types.ts`](../packages/ai/src/types.ts) and
[`packages/ai/src/capabilities.ts`](../packages/ai/src/capabilities.ts). A provider that needs
a local model server can instead use the HTTP contracts in
[`packages/ai/src/contracts.ts`](../packages/ai/src/contracts.ts); see
[`bridges/`](../bridges).
