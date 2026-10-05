# Writing Song Deck plugins

Plugins extend the studio with the contribution types listed in spec §57: AI providers, music
models, singing engines, transcription engines, instruments, genre profiles and exporters. Three
working examples live in [`plugins/`](../plugins):

| Example                 | Kind            | Shows                                                                       |
| ----------------------- | --------------- | --------------------------------------------------------------------------- |
| `lofi-hiphop-genre`     | `genre-profile` | Loading a JSON file shipped with the plugin and registering a genre profile |
| `abc-notation-exporter` | `exporter`      | Using the core library to turn a song into a new file format                |
| `felt-keys-sfz`         | `instrument`    | A sampled instrument: an SFZ file with WAV samples                          |

## Trust model

- The local server (`apps/server`) **finds and validates** plugin manifests and **serves** plugin
  files. It never executes plugin code.
- The studio imports a plugin's entry module **only after the user enables it** in
  Settings → Plugins, genres, instruments, which shows a trust warning. Plugin code then runs in the studio with the
  same rights as the studio itself, so only enable plugins you trust.
- Providers contributed by plugins go through the same orchestrator as built-in ones. A
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

| Member                                       | Purpose                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`                                       | The whole `@songdeck/core` library: Music IR helpers, theory engine, timing, MIDI/MusicXML writers…                                                                                                                                               |
| `fileUrl(path)`                              | URL of a file inside the plugin (samples, JSON, SFZ…)                                                                                                                                                                                             |
| `log(message)`                               | Write to the browser console, prefixed with the plugin id                                                                                                                                                                                         |
| `registerGenre(profile)`                     | Add a `GenreProfile` (spec §14) that Compose, Generate MIDI and the composer use like the built-in genres                                                                                                                                         |
| `registerInstrument(profile)`                | Add an `InstrumentProfile` (spec §17); its `patchId` picks the built-in synth patch used to play it                                                                                                                                               |
| `registerSampleInstrument({ profile, sfz })` | Add a sampled instrument from an SFZ file and its WAV or FLAC samples; see below                                                                                                                                                                  |
| `registerExporter(exporter)`                 | Add a format to Export → More formats: `{ id, name, extension, mimeType, description?, export(song) }`, where `export` returns a string or `Uint8Array` (sync or async)                                                                           |
| `ai.createProvider(spec)`                    | Build a provider instance from provider interfaces (`llm`, `composition`, `audioGeneration`, `singing`, `transcription`, `separation`, `voiceConversion`, `mastering`, `lyricTranscription`, `instrumentHost`) plus `capabilities` and `location` |
| `registerProvider(instance)`                 | Make a provider available to routing (spec §49) and the provider pickers                                                                                                                                                                          |

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

## Instrument plugins (VST3, AU, CLAP, LV2, SF2)

Separate from Song Deck plugins (the JavaScript extensions above), any **audio instrument plugin**
can play a MIDI track, like an instrument insert in a DAW.

| Format                    | Host                                 | How it is loaded                                                                                                  |
| ------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| VST3                      | plugin host bridge (`pedalboard`)    | Windows, macOS and Linux                                                                                          |
| Audio Units (AU)          | plugin host bridge (`pedalboard`)    | macOS                                                                                                             |
| VST2                      | plugin host bridge (`dawdreamer`)    | where DawDreamer is installed                                                                                     |
| CLAP, LV2                 | plugin host bridge (command backend) | scanned automatically; rendered through a command-line renderer you configure (`--clap-command`, `--lv2-command`) |
| SoundFont (SF2/SF3)       | plugin host bridge (FluidSynth)      | `pyfluidsynth` or the `fluidsynth` command                                                                        |
| SFZ                       | plugin host bridge (`sfizz_render`)  | or, without the bridge, as a Song Deck sample-instrument plugin (above)                                           |
| Web Audio Modules (WAM 2) | the studio itself (browser)          | add the module URL in Settings → Plugins → Instrument plugins                                                     |

**Set up the native host** (once per computer):

```sh
pip install pedalboard mido            # VST3 everywhere, Audio Units on macOS
pip install dawdreamer                 # optional: VST2
python3 bridges/plugin_host_bridge.py  # http://127.0.0.1:8817
```

Then Settings → Plugins → Instrument plugins → **Add the local plugin host** (or add the
_Instrument plugin host (local)_ preset under AI services). The host scans the standard plugin
folders of your operating system (plus `--plugin-path DIR`), and **Rescan plugins** picks up new
installs. Bridge flags and formats are documented in [`bridges/README.md`](../bridges/README.md).

**Use a plugin on a track**: select a MIDI track, open More tools → Inspector, choose the host and the
plugin, **Use plugin**. Then:

- **Edit plugin** opens the plugin's own editor — for native plugins a window on the computer running
  the host (the studio waits until you close it), for Web Audio Modules a dialog in the studio with
  a small keyboard to try sounds. Through the Song Deck server, a native editor request is limited
  to the proxy timeout (15 minutes): close the window within that time, or reopen it to continue. The edited state is stored in the project (a `plugin-state`
  asset), so the sound is reproducible and travels with `.songproject` files.
- **Parameters** lists the plugin's parameters and factory presets; changes are ordinary, undoable
  edits.
- The track is **rendered through the plugin** ("frozen", 48 kHz, latency-compensated) into a project
  asset. Playback, the mixer, stems, mastering and every audio export use that render while it matches
  the notes, tempo and plugin state. After an edit, the built-in sound of the track's instrument plays
  until the re-render (automatic after a short pause; **Render now** forces one). **Bypass** keeps the
  plugin but plays the built-in sound; **Remove** takes the plugin off.
- MIDI exports are unaffected (they carry the notes); audio exports carry the plugin's sound.
- A project opened on a computer without the plugin still plays the stored render. Re-rendering needs
  the plugin.

Rendering is offline, not real time: Song Deck sends the track's MIDI (note on/off with the track's
velocities and articulations) to the host and receives a WAV. Plugins are native code running in the
host process (or, for WAMs, in the page) — install only plugins you trust. The host only loads plugins
it found in its scan folders.

Other software can provide hosts too: a Song Deck JavaScript plugin can register a provider with the
`instrumentHost` interface (`status`, `listPlugins`, `describePlugin`, `renderInstrument`,
optional `captureState` / `openEditor`; see [`packages/ai/src/types.ts`](../packages/ai/src/types.ts))
and its plugins appear in the same pickers. The HTTP contract of the bridge is `PLUGIN_HOST_PATHS` in
[`packages/ai/src/contracts.ts`](../packages/ai/src/contracts.ts).
