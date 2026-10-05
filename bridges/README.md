# Song Deck bridges: local AI models over small HTTP contracts

Song Deck never depends on a specific AI engine (spec §2.2). Local engines, such as
[ACE-Step](https://github.com/ace-step/ACE-Step) for music,
[DiffSinger](https://github.com/openvpi/DiffSinger) for singing,
[Demucs](https://github.com/adefossez/demucs) for stem separation,
[Basic Pitch](https://github.com/spotify/basic-pitch) for transcription,
[RVC](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) for voice conversion,
[Matchering](https://github.com/sergree/matchering) for mastering,
[Whisper](https://github.com/SYSTRAN/faster-whisper) for lyrics transcription,
[MusicGen](https://huggingface.co/facebook/musicgen-medium),
[Stable Audio Open](https://huggingface.co/stabilityai/stable-audio-open-1.0),
[YuE](https://github.com/multimodal-art-projection/YuE) and [DiffRhythm](https://github.com/ASLP-lab/DiffRhythm)
for music, and your installed instrument plugins (VST3, Audio Units, VST2, CLAP, LV2, SoundFonts, SFZ)
for rendering MIDI, sit behind **generic JSON/HTTP contracts** defined in
[`packages/ai/src/contracts.ts`](../packages/ai/src/contracts.ts). A _bridge_ is a small server that speaks
one contract and drives one engine. Song Deck's adapters (`local-music`, `singing-http`,
`transcription-http`, `separation-http`, `voice-conversion-http`, `mastering-http`, and the lyrics and
plugin-host adapters) only know the contract, so you can:

- swap engines (or engine versions) without touching Song Deck,
- run any model that implements a contract, including your own,
- keep everything on your machine, with no keys or cloud involved.

This folder holds the **mock bridge**, which implements every contract with simple deterministic
DSP and lets you check a Song Deck setup end to end without ML models. It also holds **reference
bridges** for the real engines and `songdeck_bridge`, a tiny standard-library toolkit that they all
share.

| File                          | What it is                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mock_bridge.py`              | Every contract, deterministic stdlib DSP, no ML. One role per process, or all eight roles at once.                                                                                                                                                                                                                                                                                                                                   |
| `acestep_bridge.py`           | Music (ACE-Step v1 pipeline): generate, transform, inpaint, extend, cancel.                                                                                                                                                                                                                                                                                                                                                          |
| `diffsinger_bridge.py`        | Singing (OpenVPI DiffSinger): contract notes → `.ds` project → inference command.                                                                                                                                                                                                                                                                                                                                                    |
| `demucs_bridge.py`            | Separation (Demucs CLI).                                                                                                                                                                                                                                                                                                                                                                                                             |
| `basic_pitch_bridge.py`       | Transcription (Basic Pitch).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `rvc_bridge.py`               | Voice conversion (any RVC command line, through a template).                                                                                                                                                                                                                                                                                                                                                                         |
| `mastering_bridge.py`         | Mastering (Matchering with a reference; otherwise pyloudnorm or the stdlib loudness path).                                                                                                                                                                                                                                                                                                                                           |
| `whisper_bridge.py`           | Lyrics transcription (faster-whisper, openai-whisper or WhisperX): text, segments, words with timings and confidence.                                                                                                                                                                                                                                                                                                                |
| `plugin_host_bridge.py`       | Instrument plugin host: renders MIDI through VST3/AU (pedalboard), VST2 (DawDreamer), SoundFonts (FluidSynth), SFZ (sfizz) and CLAP/LV2 (command templates); parameters, presets, state, native editors.                                                                                                                                                                                                                             |
| `musicgen_bridge.py`          | Music (Meta MusicGen through `transformers`): text, melody conditioning, windowed continuation (`/extend`).                                                                                                                                                                                                                                                                                                                          |
| `stable_audio_open_bridge.py` | Music (Stable Audio Open through `diffusers`): text to audio up to ~47 s, negative prompts.                                                                                                                                                                                                                                                                                                                                          |
| `yue_bridge.py`               | Songs with vocals from lyrics and a style (YuE2 command line, or YuE v1 `infer.py` with in-context learning).                                                                                                                                                                                                                                                                                                                        |
| `diffrhythm_bridge.py`        | Songs with vocals (DiffRhythm): lyrics become a timed LRC from the request's sections; inpainting through its edit mode.                                                                                                                                                                                                                                                                                                             |
| `songdeck_bridge/`            | Shared toolkit: `server.py` (HTTP app), `wav.py` (WAV/base64/resampling), `cli.py` (common flags, serve loop, main-thread runner), `dsp.py` (stdlib DSP), `singing.py` (singing-request parsing), `midi.py` (MIDI event validation, Standard MIDI File writer), `pluginhost.py` (plugin-host request parsing), `music.py` (music-request helpers, WAV fitting, engine output decoding), `npaudio.py` (NumPy WAV I/O for ML engines). |

Everything needs **Python 3.9+**. The mock bridge and `songdeck_bridge` use only the standard
library. Engine bridges import their engine lazily and stop with an install hint when it is missing.

## Quick start (no models needed)

```sh
python3 bridges/mock_bridge.py --role all          # eight bridges on 127.0.0.1:8810-8817
```

In Song Deck, open **Settings → Providers → Add provider**. Pick the local preset of a category,
for example _Music generation → ACE-Step (local)_. Its endpoint URL already points at the right port.
Save, then click **Test connection** or **Discover models**. Generations, vocals, transcriptions,
stems, conversions, masters, lyric timings and plugin renders now come from the mock: real WAV files,
audibly simple.

## Contract summary

### Rules shared by every bridge

| Topic           | Rule                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport       | HTTP/1.1 on a configurable base URL; paths are relative to it. Requests are `application/json` (UTF-8).                                                                                                                       |
| Audio in JSON   | Base64 (standard alphabet, no `data:` prefix) of a **complete WAV file**: PCM 16/24-bit or 32-bit float, any sample rate, mono or stereo. The toolkit also reads 8/32-bit PCM, 64-bit float, WAVE_FORMAT_EXTENSIBLE and RF64. |
| Audio responses | `200`, `Content-Type: audio/wav`, the WAV bytes. Optional `X-Seed: <int>` (the seed actually used, also when the request had none) and `X-Model: <id>`.                                                                       |
| Errors          | Non-2xx with `{"error": "<message>"}`. See the table below.                                                                                                                                                                   |
| Auth            | Optional. A bridge started with `--token` (or `$SONGDECK_BRIDGE_TOKEN`) requires `Authorization: Bearer <token>` on everything except `GET /health`.                                                                          |
| Long jobs       | Requests may take minutes. When Song Deck cancels, it aborts the HTTP request, and the bridge notices the disconnect and stops the job. It may also call `POST /cancel`.                                                      |
| Idempotency     | Song Deck retries 429/5xx up to twice, so handlers have no side effects. With the same seed, the result is the same.                                                                                                          |
| Units           | Times are seconds (floats), pitches are MIDI numbers (60 = C4), velocities run 1–127 and expression values 0–1.                                                                                                               |

| Status | When                                                                                             | Song Deck sees              |
| ------ | ------------------------------------------------------------------------------------------------ | --------------------------- |
| 400    | Invalid input: bad JSON, missing/ill-typed field, unreadable WAV, out-of-range value             | `bad-request` (not retried) |
| 401    | Missing or wrong bearer token                                                                    | `auth`                      |
| 403    | Browser origin or `Host` header not allowed (see Security)                                       | `auth`                      |
| 404    | Unknown endpoint, **voice id or model id**                                                       | `bad-request`               |
| 405    | Wrong method (an `Allow` header lists the right ones)                                            | `bad-request`               |
| 409    | **Busy and not queueing** (queue full); also the answer to a request cancelled by `POST /cancel` | `bad-request`               |
| 413    | Body larger than `--max-body-mb`                                                                 | `bad-request`               |
| 500    | The engine failed (the message includes the last lines of its output)                            | `unavailable`, retried ≤ 2  |
| 501    | **Operation not supported** (e.g. drums in Basic Pitch)                                          | `unavailable`               |
| 503    | **Model still loading** (`Retry-After`), or the bridge is shutting down                          | `unavailable`, retried ≤ 2  |

Every bridge also answers `GET /info` (Song Deck's _Test connection_ and model manager probe it),
`GET /health` (status, job counters, model-loading state; no auth) and `POST /cancel` (`{"job_id"?}`
→ `204`; without `job_id` it cancels every running or queued job). Job responses carry `X-Job-Id`. A
client may choose the id by sending an `X-Job-Id` request header.

### Endpoints

| Bridge (preset, port)                                                                                                                                     | Endpoint                  | Request                                                                                                                                                                                                              | Response                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Music (`ace-step-local` 8810, `custom-audio-http` 8820, `yue-local` 8821, `diffrhythm-local` 8822, `stable-audio-open-local` 8823, `musicgen-local` 8824) | `GET /info`               | –                                                                                                                                                                                                                    | `{name, version, models: [{id, name}], capabilities: ["TEXT_TO_MUSIC", …], hardware?: {min_vram_gb}}`                                |
|                                                                                                                                                           | `POST /generate`          | `{prompt, duration_seconds, seed?, bpm?, key?, lyrics?, sections?: [{name, start_seconds, end_seconds, prompt?}], negative_prompt?, reference_audio_base64?, guide_audio_base64?, strength?, instrumental?, model?}` | WAV                                                                                                                                  |
|                                                                                                                                                           | `POST /transform`         | `{audio_base64, prompt, strength, seed?, model?}`                                                                                                                                                                    | WAV (audio-to-audio)                                                                                                                 |
|                                                                                                                                                           | `POST /inpaint`           | `{audio_base64, start_seconds, end_seconds, prompt, seed?, model?}`                                                                                                                                                  | WAV; only the range changes                                                                                                          |
|                                                                                                                                                           | `POST /extend`            | `{audio_base64, prompt, duration_seconds, seed?, model?}`                                                                                                                                                            | WAV; only if `OUTPAINTING` is advertised                                                                                             |
|                                                                                                                                                           | `POST /cancel`            | `{job_id?}`                                                                                                                                                                                                          | `204`                                                                                                                                |
| Singing (`diffsinger-local` 8811)                                                                                                                         | `GET /voices`             | –                                                                                                                                                                                                                    | `[{id, name, voice_type, language, kind}]`                                                                                           |
|                                                                                                                                                           | `POST /synthesize`        | `{voice_id, tempo_bpm, sample_rate, seed, notes: [{pitch, start_seconds, duration_seconds, lyric, phonemes?, velocity, expression?}], language?}`                                                                    | WAV covering **0 … end of the last note**                                                                                            |
|                                                                                                                                                           | `POST /regenerate_phrase` | the same + `start_seconds, end_seconds`                                                                                                                                                                              | WAV covering **only [start, end]**                                                                                                   |
| Separation (`demucs-local` 8812)                                                                                                                          | `POST /separate`          | `{audio_base64, stems: ["drums", "bass", "vocals", "other"]}` (`guitar`, `piano` with 6-stem models)                                                                                                                 | `{stems: {name: wav_base64}, model}`                                                                                                 |
| Transcription (`basic-pitch-local` 8813)                                                                                                                  | `POST /transcribe`        | `{audio_base64, source: mix\|vocals\|bass\|drums\|piano\|guitar\|melody\|other}`                                                                                                                                     | `{notes: [{pitch, start, end, velocity, confidence}], tempo?, key?, chords?}`                                                        |
| Voice conversion (`rvc-local` 8814)                                                                                                                       | `POST /convert`           | `{audio_base64, target_voice_id, pitch_shift?}`                                                                                                                                                                      | WAV                                                                                                                                  |
|                                                                                                                                                           | `GET /voices`             | –                                                                                                                                                                                                                    | `[{id, name, voice_type, language, kind}]` (optional in the contract)                                                                |
| Mastering (`mastering-local` 8815)                                                                                                                        | `POST /master`            | `{audio_base64, target: streaming\|cd\|loud-rock\|dynamic\|podcast\|demo, reference_audio_base64?}`                                                                                                                  | WAV                                                                                                                                  |
| Lyrics (`whisper-local` 8816)                                                                                                                             | `POST /transcribe_lyrics` | `{audio_base64, language?, prompt?, word_timestamps?, model?}`                                                                                                                                                       | `{text, language?, segments: [{start, end, text, words?: [{word, start, end, confidence?}]}], model?}`                               |
| Instrument plugins (`plugin-host-local` 8817)                                                                                                             | `GET /info`               | –                                                                                                                                                                                                                    | `{name, version, formats: [{format, available, backend?, note?}], capabilities: ["INSTRUMENT_PLUGIN_HOST"], editor?, search_paths?}` |
|                                                                                                                                                           | `GET /plugins`            | –                                                                                                                                                                                                                    | `{plugins: [{id, name, format, vendor?, version?, category?, path?, loadable?}]}` (cached scan)                                      |
|                                                                                                                                                           | `POST /plugins`           | `{paths?}`                                                                                                                                                                                                           | the same, after a rescan (extra files/folders are remembered)                                                                        |
|                                                                                                                                                           | `POST /plugins/describe`  | `{plugin_id}`                                                                                                                                                                                                        | the plugin + `{parameters: [{id, name, value, min?, max?, default?, label?}], presets?, has_editor?, latency_samples?}`              |
|                                                                                                                                                           | `POST /render`            | `{plugin_id, state_base64?, parameters?, preset?, sample_rate, channels?, duration_seconds, events: [{time_seconds, data}], block_size?}`                                                                            | WAV of exactly `duration_seconds` (`X-Plugin-Latency`, `X-Model: <plugin id>`)                                                       |
|                                                                                                                                                           | `POST /editor`            | `{plugin_id, state_base64?, parameters?, preset?}`                                                                                                                                                                   | `{plugin_id, state_base64?, parameters, preset?}` once the native window closes                                                      |
|                                                                                                                                                           | `POST /state`             | the same                                                                                                                                                                                                             | the same, without a window (apply state → preset → parameters, read back)                                                            |

Lyrics may carry section tags (`[verse]\nline…\n\n[chorus]\n…`). In singing notes, a syllable ending
in `-` continues a word (`a-`, `lone`), and `_` sustains the previous vowel (melisma). Song Deck
enforces voice-conversion consent (spec §36) **before** any audio leaves the app: stock voices
convert freely, while any other `kind` needs a recorded attestation.

Plugin MIDI events are raw messages (status byte first, channel in the low nibble) at absolute times
in seconds; events at or after `duration_seconds` are ignored. Plugin ids are opaque to Song Deck: the
host uses `<format>:<absolute path>`, plus `#<sub-plugin>` for VST3/AU shells and `#<URI>` for LV2.
Requests are idempotent: every plugin request starts from the plugin's default state and applies
`state_base64`, then `preset`, then `parameters`. Song Deck should store **both** `state_base64` and
`parameters` from `/state` and `/editor` and send both back.

## Status

| Bridge                                         | Engine                                                  | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mock_bridge.py` + `songdeck_bridge/`          | none (stdlib DSP)                                       | **Tested end to end.** `packages/ai/test/bridges.integration.test.ts` drives the real Song Deck adapters against it for every contract: errors, bearer auth, abort → job cancellation and consent.                                                                                                                                                                                                                                                         |
| `acestep_bridge.py`                            | ACE-Step v1                                             | **Reference code, not exercised in CI.** The engine call follows ACE-Step v1's `ACEStepPipeline` and must be verified against your checkout. ACE-Step 1.5 needs `AceStepEngine.run()` adapted.                                                                                                                                                                                                                                                             |
| `diffsinger_bridge.py`                         | OpenVPI DiffSinger                                      | **Reference code, not exercised in CI.** The `.ds` builder can be inspected offline (`--print-ds`). The G2P is a tiny English heuristic.                                                                                                                                                                                                                                                                                                                   |
| `demucs_bridge.py`                             | Demucs 4 CLI                                            | **Reference code, not exercised in CI.**                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `basic_pitch_bridge.py`                        | basic-pitch 0.3/0.4                                     | **Reference code, not exercised in CI.**                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `rvc_bridge.py`                                | any RVC CLI (template)                                  | **Reference code, not exercised in CI.** The command template must match your fork.                                                                                                                                                                                                                                                                                                                                                                        |
| `mastering_bridge.py`                          | Matchering 2 / pyloudnorm / stdlib                      | **Reference code.** The stdlib path is the mock's tested code. The Matchering and pyloudnorm paths are not exercised in CI.                                                                                                                                                                                                                                                                                                                                |
| `mock_bridge.py` roles `lyrics`, `instruments` | none (stdlib DSP)                                       | **Smoke-tested over HTTP** (info, plugins, describe, render length/format, state round trip, `404`/`400`s, transcription with and without a prompt). The TypeScript integration test covers them once the lyrics and plugin-host adapters use them.                                                                                                                                                                                                        |
| `plugin_host_bridge.py`                        | pedalboard / DawDreamer / FluidSynth / sfizz / commands | **Partly run against real engines (Linux):** pedalboard 0.9.25 and DawDreamer 0.9.0 with real VST3 instruments (DISTRHO Nekobi and Kars): scan, describe, render, parameters and state round trips; FluidSynth 2.3.4 through pyfluidsynth and through the CLI with real SoundFonts. **Not run:** Audio Units and editor windows (macOS/Windows only), real VST2 binaries, sfizz, CLAP and LV2 (their command plumbing was tested with stand-in renderers). |
| `whisper_bridge.py`                            | faster-whisper / openai-whisper / WhisperX              | **Reference code, not exercised in CI.** Decoding, request mapping and response shaping were tested against a stand-in `faster_whisper` module; model loading failures are reported in `/health` and `/info`.                                                                                                                                                                                                                                              |
| `musicgen_bridge.py`                           | transformers MusicGen                                   | **Reference code, not exercised in CI.** Windowed generation, continuation and melody routing were tested against stand-in `torch`/`transformers` modules.                                                                                                                                                                                                                                                                                                 |
| `stable_audio_open_bridge.py`                  | diffusers `StableAudioPipeline`                         | **Reference code, not exercised in CI.** Tested against a stand-in pipeline; the `initial_audio_waveforms` check reads the installed diffusers signature.                                                                                                                                                                                                                                                                                                  |
| `yue_bridge.py`                                | YuE2 CLI / YuE v1 `infer.py`                            | **Reference code, not exercised in CI.** Both command templates, prompt files, ICL arguments and output lookup were tested against stand-in scripts.                                                                                                                                                                                                                                                                                                       |
| `diffrhythm_bridge.py`                         | DiffRhythm `infer/infer.py`                             | **Reference code, not exercised in CI.** LRC building, length choice, edit-mode inpainting and splicing were tested against a stand-in script.                                                                                                                                                                                                                                                                                                             |

While these bridges were developed, their HTTP and command plumbing (temp files, command templates,
output lookup, trimming, splicing, cancellation) was smoke-tested against stand-in engines. The engine
calls themselves were never run against real installs here, because engine APIs change between
versions. Each bridge therefore isolates them in one or two clearly marked functions
(`run_demucs()`, `run_basic_pitch()`, `AceStepEngine.run()`, `build_ds()`/`run_inference()`, `run_rvc()`,
`run_matchering()`/`master_pyloudnorm()`, `WhisperEngine.load()`/`transcribe()`, the `pb_*` functions and
`DawDreamerInstance` of the plugin host, `MusicGenEngine.generate()`, `StableAudioEngine.generate()`,
`run_yue()`, `run_diffrhythm()`) that you can adapt.

## Running the bridges

### Common flags (every bridge)

| Flag                         | Default                  | Notes                                                                                                                                                                          |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--host`                     | `127.0.0.1`              | This machine only. A non-loopback host **requires** `--token`; `--allow-remote-without-token` overrides that (not recommended).                                                |
| `--port`                     | preset port              | `0` picks a free port. The bridge prints a `songdeck-bridge ready {json}` line with the URLs once it listens.                                                                  |
| `--token`                    | `$SONGDECK_BRIDGE_TOKEN` | Requires `Authorization: Bearer <token>`. Prefer the environment variable, which keeps the token out of `ps`.                                                                  |
| `--model`, `--device`        | per bridge, `auto`       | Model to load/report; `auto`/`cpu`/`cuda`/`cuda:N`/`mps`. Ignored where meaningless.                                                                                           |
| `--allow-origin URL`         | studio + server origins  | CORS allow-list (repeatable, replaces the defaults `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:7788`, `http://127.0.0.1:7788`); `*` allows any origin. |
| `--allow-host NAME`          | –                        | Extra `Host` name accepted while bound to loopback.                                                                                                                            |
| `--max-body-mb`              | `512`                    | Request size limit (`413` beyond it).                                                                                                                                          |
| `--max-jobs` / `--max-queue` | `1` / `8`                | Concurrent jobs and waiting requests. A request beyond the queue gets `409`. `--max-queue 0` never queues.                                                                     |
| `--no-disconnect-detection`  | off                      | Keep running jobs whose client disconnected (only `POST /cancel` stops them).                                                                                                  |
| `--log-level` / `--quiet`    | `info`                   | One line per request (never bodies or tokens).                                                                                                                                 |

Stop a bridge with Ctrl+C or SIGTERM. It refuses new jobs (`503`), cancels running ones, closes its
port and exits. A second Ctrl+C exits immediately.

### Mock bridge

```sh
python3 bridges/mock_bridge.py --role music                  # 8810 (ACE-Step preset); --port 8820 for the custom-audio preset
python3 bridges/mock_bridge.py --role all --base-port 8810   # all roles: music 8810, singing 8811, separation 8812,
                                                             # transcription 8813, voice-conversion 8814, mastering 8815,
                                                             # lyrics 8816, instruments 8817
python3 bridges/mock_bridge.py --role all --base-port 0      # any free ports (printed on the ready line)
```

Extra flags: `--role`, `--base-port`, `--sample-rate` (generated music, default 44100),
`--max-duration` (default 600 s), `--delay SECONDS` (simulated engine latency, cancellable; handy
for testing Song Deck's cancel and queue UI) and `--model mock-additive|mock-additive-lofi`.

What each role does:

- **music**: `/generate` renders a seeded additive-synth arrangement at the requested bpm, key and
  duration. The pad chords, bass and drums use one progression and energy per section (intro quiet,
  chorus loud; prompt words such as _calm_ or _energetic_ move the energy). A hummed line follows the
  syllables of the section's lyric lines. Guide audio is blended by `strength`, and reference audio sets
  the level. `/transform` blends the input with a re-synthesis (`strength` 0 = input, 1 = new).
  `/inpaint` replaces only the range, with crossfades inside it, so everything outside it stays
  bit-identical. `/extend` appends a continuation. The role advertises the ACE-Step preset's
  capabilities, including `INPAINTING` and `OUTPAINTING`. Two models: `mock-additive` and
  `mock-additive-lofi`.
- **singing**: two stock voices (`mock-soprano` sine, `mock-tenor` sawtooth). Each note becomes a
  tone at its pitch and time with vibrato (`vibrato`/`vibrato_rate`), onset/release shapes,
  `breathiness` noise and `velocity`/`energy` loudness. `_` glides from the previous note. The output
  covers exactly the contract range, and a phrase render equals the matching slice of a full render
  with the same seed.
- **transcription**: an autocorrelation (McLeod NSDF) pitch tracker for **monophonic** input turns
  audio into notes with confidence. It reports `key` when there are enough notes and `tempo` from onsets.
  `source: "drums"` runs an onset detector instead (kick 36, snare 38, hat 42).
- **separation**: complementary frequency bands (plus mid/side) as "stems" whose sum equals the
  input. One requested stem also returns `no_<stem>`, as Demucs `--two-stems` does.
- **voice-conversion**: a duration-preserving pitch shift (resampling + WSOLA) plus a per-voice tone
  colour. Voices: `mock-alto`, `mock-baritone` (stock) and `mock-user-voice` (`user-trained`, to
  exercise Song Deck's consent flow). Unknown ids get `404`.
- **mastering**: BS.1770 integrated loudness normalized to the target (or to the reference's loudness)
  and a look-ahead peak limiter. The output is 24-bit, or 16-bit with dither for `cd`. `X-Integrated-LUFS` reports the result.
- **lyrics** (`whisper-local` preset): `/transcribe_lyrics` finds voiced units in the input (the pitch
  tracker's notes, or energy regions for unpitched audio) and gives each one a word: the words of
  `prompt` in order, then `la`. Units more than 0.3 s apart start a new segment. `language` echoes the
  request (default `en`), and the model is `mock-whisper`.
- **instruments** (`plugin-host-local` preset): a plugin host with three fake plugins:
  `mock:sine-synth` (vst3 instrument; parameters `gain` (0.8), `waveform` (<0.5 sine, else saw) and
  `release`; presets `Init`, `Bright Saw`), `mock:square-bass` (clap instrument; `gain`, `release`;
  reports 64 frames of latency) and `mock:reverb` (an effect, which renders silence). `/render` plays
  the note on/off events (velocity-scaled, with a release tail) at the requested rate, channels and
  length as 32-bit float. The state is base64 JSON of the parameter values. `/editor` behaves like
  `/state` (no window). `/info.formats` lists every format with `backend: "mock"`; only vst3 and clap
  are available. Unknown plugin ids get `404`.

All audio responses carry `X-Seed` and `X-Model`. Everything is plain Python and is meant for short
clips: a few seconds render in well under a second. Long files work but use several hundred MB per
minute of stereo audio.

### ACE-Step (music, 8810)

```sh
git clone https://github.com/ace-step/ACE-Step && cd ACE-Step && pip install -e .
python3 bridges/acestep_bridge.py --device cuda:0 [--checkpoint-dir ~/ace-step-ckpt] [--cpu-offload]
```

Targets **ACE-Step v1**, whose `acestep.pipeline_ace_step.ACEStepPipeline` checkpoints download on
first use. The model loads in the background, and jobs answer `503` until it is ready. The prompt
plus bpm and key become ACE-Step's tag prompt, and the lyrics keep their section tags (`[instrumental]`
when instrumental). Guide or reference audio switches on audio2audio with `ref_audio_strength = 1 −
strength`. `/inpaint` uses `repaint` and splices the result into the original, so nothing outside the
range changes (`--no-splice` returns ACE-Step's full re-render). `/extend` uses ACE-Step's `extend`
task. ACE-Step v1 has no negative prompt and no explicit section timing, so both are accepted and
ignored. Diffusion parameters can be set with `--infer-steps`, `--guidance-scale`, `--scheduler`,
`--cfg-type` and `--omega-scale`. Cancellation stops at the next diffusion step (the bridge wraps
ACE-Step's `tqdm` loop). `--max-duration` defaults to 240 s.

### DiffSinger (singing, 8811)

```sh
git clone https://github.com/openvpi/DiffSinger && cd DiffSinger && pip install -r requirements.txt
# install an acoustic model (checkpoints/<exp>) and a vocoder as the DiffSinger docs describe
python3 bridges/diffsinger_bridge.py --diffsinger-root ~/DiffSinger --exp my_acoustic_exp \
    --voice aria:"Aria":soprano:en [--phoneme-prefix en/] [--dictionary dict.txt]
python3 bridges/diffsinger_bridge.py --print-ds request.json      # inspect the generated .ds, no inference
```

The bridge converts notes into a `.ds` project with one segment per phrase. Each segment carries
`ph_seq`, `ph_dur`, `ph_num`, `note_seq`, `note_dur`, `note_slur`, an `f0_seq` at 5 ms with vibrato
and glides, `offset` and `seed`. Phonemes come from the note's `phonemes`, then `--dictionary`
(`syllable<TAB>phonemes`, which is how non-English voicebanks work), then a tiny English G2P. Onset
consonants are placed before the beat. `--phoneme-map` and `--phoneme-prefix` adapt the names to
your voicebank.

The default command is `{python} scripts/infer.py acoustic {ds} --exp {exp} --out {out}`, run in
`--diffsinger-root`. Use `--command` to add e.g. `--spk {spk}` or `--seed {seed}`, and
`--variance-command` to run a variance model first. Voices come from `--voice id[:name[:type[:lang[:speaker]]]]`
or `--voices-json`. The output is trimmed to the exact contract range and resampled to `sample_rate`.
`--dump-ds DIR` keeps every generated project for debugging.

### Demucs (separation, 8812)

```sh
pip install demucs        # installs PyTorch (install the CUDA build first for a GPU)
python3 bridges/demucs_bridge.py --model htdemucs_ft --device cuda [--shifts 2]
```

Runs `python -m demucs -n <model> -o <tmp> [--two-stems <stem>] [--float32] <input.wav>` and returns
`<tmp>/<model>/<track>/*.wav`. Requests for `guitar` or `piano` switch to `--model-6s` (`htdemucs_6s`),
and a single requested stem uses `--two-stems` (fast vocal isolation). `--python` points at another
venv. A cancelled job kills the Demucs process.

### Basic Pitch (transcription, 8813)

```sh
pip install basic-pitch
python3 bridges/basic_pitch_bridge.py [--onset-threshold 0.5] [--frame-threshold 0.3]
```

`predict()` note events `(start, end, pitch, amplitude, bends)` become contract notes, with
`velocity = 127 × amplitude` and `confidence = amplitude`. Basic Pitch has no separate per-note
confidence, so the note posterior is the proxy. `source` selects a frequency range, and `drums` →
`501`. Tempo (onset autocorrelation) and key (Krumhansl profiles) are stdlib estimates.

### RVC (voice conversion, 8814)

```sh
python3 bridges/rvc_bridge.py --models-dir ~/rvc/weights --rvc-root ~/rvc \
    --command "{python} infer_cli.py --input {input} --output {output} --model {model} --pitch {pitch}"
# RVC WebUI's tools/infer_cli.py (check --help of your fork):
#   --command "{python} tools/infer_cli.py --f0up_key {pitch} --input_path {input} --index_path {index}
#              --f0method {f0_method} --opt_path {output} --model_name {voice}.pth --index_rate {index_rate} --device {device}"
```

Voices are the `<id>.pth` files in `--models-dir`, with an optional `<id>.index` and an optional
`<id>.json` (`{"name", "voice_type", "language", "kind"}`; `kind` defaults to `imported`). Pitch
shifts are rounded to whole semitones. Only install voices you are authorized to use.

### Mastering (8815)

```sh
pip install matchering            # optional: reference mastering
pip install pyloudnorm numpy      # optional: faster loudness normalization
python3 bridges/mastering_bridge.py [--engine auto|matchering|pyloudnorm|stdlib]
```

With a reference track and Matchering installed, Matchering 2 runs in a killable subprocess.
Otherwise the bridge normalizes loudness to the target with pyloudnorm, or with the pure-Python
BS.1770 path when pyloudnorm is not installed, and then applies the limiter.

| Target    | Loudness | Ceiling   | Output               |
| --------- | -------- | --------- | -------------------- |
| streaming | −14 LUFS | −1.0 dBFS | 24-bit               |
| cd        | −9 LUFS  | −0.3 dBFS | 16-bit + TPDF dither |
| loud-rock | −8 LUFS  | −0.3 dBFS | 24-bit               |
| dynamic   | −18 LUFS | −1.0 dBFS | 24-bit               |
| podcast   | −16 LUFS | −1.0 dBFS | 24-bit               |
| demo      | −12 LUFS | −1.0 dBFS | 24-bit               |

### Whisper (lyrics, 8816)

```sh
pip install faster-whisper            # preferred; or: pip install openai-whisper | pip install whisperx
python3 bridges/whisper_bridge.py [--model large-v3-turbo] [--engine auto|faster-whisper|whisper|whisperx] \
    [--device cuda] [--compute-type float16] [--vad] [--align]
```

The model loads in the background (`503` until ready; `/health` and `/info` report a failed load with
the install hint). Audio is decoded with NumPy to 16 kHz mono and passed to the engine, so ffmpeg is
not needed. `prompt` becomes Whisper's `initial_prompt` (it biases recognition toward the expected
lyrics) and `language` (`en-US` → `en`) skips detection. Word `confidence` is Whisper's word
probability (WhisperX: the alignment score). `--vad` skips silence first, which reduces invented words
in instrumental passages. `--align` refines word timings with WhisperX's wav2vec2 alignment.
`--condition-on-previous-text` is off by default because it causes repetition loops on songs. Sung
vocals transcribe much better once isolated (the Demucs bridge with `stems: ["vocals"]`).

### Instrument plugin host (8817)

```sh
pip install pedalboard mido           # VST3 everywhere, Audio Units on macOS
pip install dawdreamer                # VST2 (and VST3 when pedalboard is missing)
pip install pyfluidsynth              # SoundFonts in process (or install the fluidsynth command line)
python3 bridges/plugin_host_bridge.py [--plugin-path ~/MyPlugins] \
    [--clap-command "<template>"] [--lv2-command "<template>"] [--command FORMAT=TEMPLATE]
```

It renders MIDI through an installed instrument offline, like a DAW freeze. Which backend renders
which format:

| Format | Backend (first available)                               | Parameters                                           | Presets                                                  | State                                                 | Editor                    |
| ------ | ------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- | ------------------------- |
| vst3   | pedalboard, else DawDreamer                             | normalized 0–1 (pedalboard ids; DawDreamer: indices) | `.vstpreset` files in the standard VST3 preset folders   | parameter values + the plugin's own state (see below) | pedalboard, macOS/Windows |
| au     | pedalboard (macOS only)                                 | normalized 0–1                                       | –                                                        | as vst3                                               | pedalboard, macOS         |
| vst2   | DawDreamer                                              | normalized 0–1 (indices)                             | –                                                        | parameter values + DawDreamer `save_state`            | –                         |
| sf2    | FluidSynth: pyfluidsynth, else the `fluidsynth` CLI     | `gain` 0–10, `reverb`, `chorus` 0/1                  | bank:program list read from the file (`000:000 Piano 1`) | JSON `{bank, program, gain, reverb, chorus}`          | –                         |
| sfz    | `sfizz_render` (`--sfz-command` to change)              | –                                                    | –                                                        | passed through                                        | –                         |
| clap   | `--clap-command` template                               | passed to the command                                | passed to the command                                    | passed to the command as a file                       | –                         |
| lv2    | `--lv2-command` template                                | passed to the command                                | passed to the command                                    | passed to the command as a file                       | –                         |
| wam    | not hostable here (Web Audio Modules run in the studio) | –                                                    | –                                                        | –                                                     | –                         |

A format without a backend is listed in `/info.formats` with `available: false` and a `note` that
says what to install or configure. `--command FORMAT=TEMPLATE` (or `--clap-command`, `--lv2-command`,
`--vst2-command`, `--sf2-command`, `--sfz-command`) renders any format with an external program. The
template is split into arguments before its placeholders are filled (no shell): `{plugin}` (file or
bundle), `{uri}` (LV2 URI or sub-plugin), `{name}`, `{midi}` (a Standard MIDI File of the events),
`{output}` (the WAV to write), `{sample_rate}`, `{duration}`, `{channels}`, `{block_size}`, `{state}`
(a file with the decoded state, empty when none), `{params}` (a JSON file of the parameters),
`{preset}`, `{fluidsynth}`, `{sfizz}` and `{python}`. The default SFZ command is
`{sfizz} --sfz {plugin} --midi {midi} --wav {output} --samplerate {sample_rate} --blocksize {block_size} --use-eot`.
Any output is resampled, remixed and cut or padded to the requested format.

**Scanning.** The host scans the standard folders of the OS (Linux: `~/.vst3`, `/usr/lib/vst3`,
`/usr/local/lib/vst3`, `~/.vst`, `/usr/lib/vst`, `~/.clap`, `/usr/lib/clap`, `~/.lv2`, `/usr/lib/lv2`,
`/usr/local/lib/lv2`, `/usr/share/sounds/sf2`, `/usr/share/soundfonts`, `~/.local/share/soundfonts`,
`~/Documents/SoundFonts`…; macOS: `/Library/Audio/Plug-Ins/{VST3,Components,VST,CLAP,LV2}` and the
same under `~/Library`, plus `~/Library/Audio/Sounds/Banks`; Windows: `%COMMONPROGRAMFILES%\VST3`,
`%PROGRAMFILES%\VSTPlugins`, `%PROGRAMFILES%\Steinberg\VSTPlugins`, `%COMMONPROGRAMFILES%\CLAP`,
`%COMMONPROGRAMFILES%\LV2`, `Documents\SoundFonts`…), `$VST3_PATH`, `$VST_PATH`, `$CLAP_PATH`,
`$LV2_PATH`, every `--plugin-path` and the `paths` sent to `POST /plugins`. The scan never loads a
plugin: names, vendors, versions and categories come from file names and cheap bundle metadata
(VST3 `moduleinfo.json`, `Info.plist`, Audio Unit component lists, LV2 `manifest.ttl` plus `lv2ls`
names when lilv is installed). A VST3 shell whose `moduleinfo.json` lists several audio classes gets
one id per class; `--deep-scan` also asks pedalboard for the sub-plugins of other shells (this loads
them). `.so`/`.dll` files count as VST2 only inside VST folders. `GET /plugins` serves the cached
scan, `POST /plugins` rescans, and a plugin's category becomes known (`instrument`/`effect`) once it
has been loaded.

**State.** For VST3, AU and VST2, `state_base64` holds `SDPS\x01`, the parameter values as JSON, and
the plugin's own state (pedalboard `raw_state`, else `preset_data`; DawDreamer `save_state`), because
some plugins keep parameter values out of their own state. A blob without that header is applied as a
raw plugin state. Applying a different state can reload the whole plugin, which takes seconds for some
plugins, so a request with the same state as the previous one only restores the parameters it changed.

**Threads and editors.** pedalboard and DawDreamer (JUCE) only reload and reset plugins on the main
thread, and macOS only opens windows there. The host's serve loop therefore runs a main-thread queue,
and every pedalboard or DawDreamer request runs on it, one at a time. `/editor` opens the plugin's
native window there (pedalboard `show_editor`, macOS and Windows) and answers with the state when the
window closes. Cancelling the request or stopping the bridge closes the window. Other
pedalboard/DawDreamer requests wait while a window is open. `/info.editor` is false on Linux and with
`--no-editor`, and `/editor` then answers `501`.

| Flag                                  | Default   | Notes                                                                                                                                |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--plugin-path DIR`                   | –         | Extra folder or file to scan (repeatable). `--no-default-paths` scans only these.                                                    |
| `--command FORMAT=TEMPLATE`           | –         | Render a format with a command; `--clap-command`, `--lv2-command`, `--vst2-command`, `--sf2-command`, `--sfz-command` are shortcuts. |
| `--disable-backend NAME`              | –         | `pedalboard`, `dawdreamer`, `fluidsynth` or `sfizz` (repeatable).                                                                    |
| `--fluidsynth-mode auto\|python\|cli` | `auto`    | pyfluidsynth first. `--fluidsynth PATH`, `--fluidsynth-gain 0.5`, `--fluidsynth-arg ARG`.                                            |
| `--sfizz-render PATH`                 | PATH      | The `sfizz_render` executable.                                                                                                       |
| `--no-editor`                         | off       | Never open native windows.                                                                                                           |
| `--max-loaded`                        | `4`       | Loaded plugin instances kept (least recently used are unloaded).                                                                     |
| `--max-renders` / `--max-jobs`        | `1` / `2` | Renders at a time / job slots (one stays free for an open editor).                                                                   |
| `--load-timeout`                      | `10`      | Seconds a plugin may take to initialize (pedalboard).                                                                                |
| `--scan-depth`, `--deep-scan`         | `6`, off  | Folder depth; load shells while scanning.                                                                                            |
| `--max-duration` / `--timeout`        | `1800`    | Longest render; seconds before a render command is killed.                                                                           |

Renders are 32-bit float WAV, already latency compensated (pedalboard compensates itself; DawDreamer
renders the latency longer and drops it). `X-Plugin-Latency` reports the plugin's declared latency for
information only. A pedalboard render cannot be interrupted midway: a cancelled render finishes its
call and the result is dropped. DawDreamer renders are not always bit-reproducible (some plugins
differ between runs even with fresh engines).

### MusicGen (music, 8824)

```sh
pip install torch transformers        # the CUDA build of torch first for a GPU
python3 bridges/musicgen_bridge.py --model facebook/musicgen-medium --device cuda
```

Models: `facebook/musicgen-small|medium|large`, their `-stereo-` variants, and the melody models
(`facebook/musicgen-melody`, `-melody-large`, `-stereo-melody`, `-stereo-melody-large`). MusicGen is
instrumental only: `lyrics`, `sections` and `negative_prompt` are accepted and ignored
(`X-Lyrics-Ignored: true`). `bpm` and `key` join the prompt. Text models advertise `TEXT_TO_MUSIC`,
`INSTRUMENTAL_ONLY` and `OUTPAINTING`: requests longer than `--window-seconds` (30) are generated
window by window, each continuing from the last `--context-seconds` (10), up to `--max-duration`
(120), and `/extend` continues the input the same way. Melody models advertise `REFERENCE_AUDIO` and
`AUDIO_TO_AUDIO` instead: guide (else reference) audio conditions the chromagram, `/transform`
re-renders the input's melody (MusicGen has no `strength`), and they generate at most one window.
`/inpaint` answers `501`. Cancellation stops at the next token. Also `--guidance-scale`,
`--temperature`, `--top-k`, `--dtype`, `--cache-dir`.

### Stable Audio Open (music, 8823)

```sh
pip install torch diffusers transformers accelerate torchsde soundfile
huggingface-cli login                 # the model is gated: accept its license on Hugging Face first
python3 bridges/stable_audio_open_bridge.py --device cuda [--steps 100] [--cfg-scale 7]
```

Runs `stabilityai/stable-audio-open-1.0` (44.1 kHz stereo, at most ~47 s: `--max-duration 47`).
`negative_prompt` is used (default `--negative-prompt "Low quality."`), the seed drives a
`torch.Generator`, and `bpm`/`key` join the prompt. When the installed diffusers accepts
`initial_audio_waveforms`, the bridge also advertises `AUDIO_TO_AUDIO` and `REFERENCE_AUDIO`: guide or
reference audio (and `/transform`'s input) is encoded into the starting noise. diffusers offers no
strength control for it, so `strength` is ignored and the influence is modest
(`--no-audio-to-audio` turns it off). Cancellation stops at the next diffusion step.

### YuE (songs with vocals, 8821)

```sh
# YuE2 (the current main branch):
git clone https://github.com/multimodal-art-projection/YuE && cd YuE && python3.12 -m venv .venv && .venv/bin/pip install .
python3 bridges/yue_bridge.py --python ~/YuE/.venv/bin/python [--device cuda]
# YuE v1 (infer.py, in-context learning with reference audio):
git clone -b YuE-v1 https://github.com/multimodal-art-projection/YuE YuE-v1   # + its README's setup (xcodec_mini_infer)
python3 bridges/yue_bridge.py --engine yue1 --yue-root ~/YuE-v1 --python ~/YuE-v1/.venv/bin/python
```

YuE needs `lyrics` (`[verse]`/`[chorus]` sections; a request without lyrics is a `400`). The prompt
(+ `bpm`, `key`) becomes the YuE2 style or the YuE v1 genre tags. **YuE2** (`--engine yue2`, the
default unless `--yue-root` holds `inference/infer.py`) runs
`{python} -m yue2.cli generate --id song --style {style} --lyrics-file {lyrics_txt} --seed {seed} --output {output_dir} --device {device} --model {model} --quiet`
and reads `song/audio.flac`. **YuE v1** runs `infer.py` in `<yue-root>/inference` with one segment per
lyric section and `max_new_tokens` sized for the duration (`--tokens-per-second 100`). With reference
or guide audio it appends `--icl-args` (`--use_audio_prompt --audio_prompt_path {audio_prompt}
--prompt_start_time 0 --prompt_end_time {prompt_end}`) and switches to `--stage1-icl-model`, so v1
also advertises `REFERENCE_AUDIO`; `instrumental: true` returns its instrumental stem. Both templates
are overridable (`--command`, `--icl-args`). MP3/FLAC outputs are converted with ffmpeg, or with
soundfile/torchaudio in `--python`, then trimmed or padded to `duration_seconds`. The YuE environment
is checked in the background (`/health`).

### DiffRhythm (songs with vocals, 8822)

```sh
git clone https://github.com/ASLP-lab/DiffRhythm && cd DiffRhythm && pip install -r requirements.txt
sudo apt-get install espeak-ng        # macOS: brew install espeak-ng
python3 bridges/diffrhythm_bridge.py --diffrhythm-root ~/DiffRhythm [--python ~/DiffRhythm/.venv/bin/python]
```

Runs `infer/infer.py` in the checkout with `PYTHONPATH` set to it. Lyrics become an LRC file: each
`[section]` block is placed on a request section (the next one whose name matches the tag, else the
next one) and its lines are spread evenly from the section's `start_seconds`. Without sections the
blocks share the song after a short intro. The style is the prompt (+ `bpm`, `key`), or the
reference/guide audio (`--ref-audio-path`; DiffRhythm wants about 10 s or more). `--audio-length` is
95 (base model) when the request fits, otherwise the request rounded up to at most 285 (full model);
the output is trimmed to `duration_seconds` (`--fixed-lengths` asks only for 95 or 285, for older
checkouts). `/inpaint` uses DiffRhythm's edit mode (`--edit --ref-song --edit-segments`) and splices
the range into the original, so nothing outside it changes (`--no-splice` returns the full
re-render). DiffRhythm has no seed flag, so no `X-Seed` is sent. Templates: `--command`,
`--ref-audio-command`, `--edit-command`.

## Connecting a bridge in Song Deck

1. Start the bridge. Its log shows `… listening on http://127.0.0.1:<port>`.
2. **Settings → Providers → Add provider** and pick the matching local preset: _ACE-Step (local)_,
   _DiffSinger (local)_, _Demucs (local)_, _Basic Pitch (local)_, _RVC voice conversion (local)_,
   _Local mastering engine_, or _Custom audio model (HTTP)_ for any other music model on the music
   contract. The newer bridges have the presets `whisper-local`, `plugin-host-local`, `yue-local`,
   `diffrhythm-local`, `stable-audio-open-local` and `musicgen-local`.
3. Set **Endpoint URL** to the bridge's base URL if you changed host or port (for example
   `http://127.0.0.1:8810`, with no path).
4. If the bridge has a token, set **Authentication → Bearer token (Authorization header)** and paste
   the token into the key field. Song Deck keeps it in its credential vault, not in settings or projects.
5. **Save**, then **Test connection** / **Discover models**. Music bridges report their capabilities from
   `GET /info`, and singing and voice-conversion bridges list their voices.

When the Song Deck local server runs with its provider proxy enabled, requests go from the server to
the bridge (no CORS involved). Otherwise the studio calls the bridge from the browser, and CORS
admits the studio's origin (see `--allow-origin`).

## Security

- **Bind to `127.0.0.1`** (the default). A bridge runs heavy jobs and reads/writes temporary files.
  Expose it to a network only with a token: `--host 0.0.0.0` refuses to start without `--token`.
  Treat the token as a password and prefer `SONGDECK_BRIDGE_TOKEN` over the command line.
- **Browsers:** requests carrying an `Origin` header that is not allow-listed get `403`. This stops web
  pages you visit from triggering jobs. Only the Song Deck origins receive CORS headers.
- **DNS rebinding:** while bound to loopback, a `Host` header other than `localhost`/`127.x`/`::1`
  (or `--allow-host`) gets `403`.
- Tokens are compared in constant time. Request bodies are size-limited and never logged.
- Engine commands run **without a shell**. Templates are split into arguments before the
  placeholders are filled, so file names and ids cannot inject commands. RVC voice ids are matched
  against the files in `--models-dir`.
- Voice conversion: Song Deck checks consent before sending audio. Install only voices you have the
  right to use.
- **Plugins are native code running inside the plugin host's process.** A plugin can read and write
  your files and crash the bridge. Install only plugins you trust. The host only loads plugins found in
  its scan paths (default folders, `--plugin-path`, or `paths` sent to `POST /plugins`): a `plugin_id`
  naming any other file gets `404`, and command templates only ever receive such scanned paths.
- Whisper, MusicGen, Stable Audio Open, YuE and DiffRhythm download model weights from Hugging Face on
  first use; after that they run offline.

## Writing your own bridge

Put the script in `bridges/`, next to `songdeck_bridge/`, or add `bridges/` to `PYTHONPATH`:

```python
from songdeck_bridge.cli import app_options, build_parser, check_bind, serve, setup_logging
from songdeck_bridge.server import BridgeApp, json_response, req_number, req_seed, req_str, wav_response

args = build_parser("My model bridge", 8820).parse_args()
setup_logging(args); check_bind(args)
app = BridgeApp("My model", role="music", **app_options(args))

@app.route("GET", "/info")
def info(ctx):
    return json_response({"name": "My model", "version": "1.0", "models": [{"id": "my-model", "name": "My model"}],
                          "capabilities": ["TEXT_TO_MUSIC"]})

@app.job("POST", "/generate")
def generate(ctx):
    body = ctx.json_object()
    prompt = req_str(body, "prompt")                                  # 400s are raised here, before queueing
    seconds = req_number(body, "duration_seconds", exclusive_minimum=0)
    seed, _ = req_seed(body)

    def work():                                                       # runs in a job slot (409 when the queue is full)
        wav = my_engine(prompt, seconds, seed, should_stop=lambda: ctx.cancelled)
        return wav_response(wav, seed=seed, model="my-model")
    return work

serve([(app, args.host, args.port)])
```

`songdeck_bridge.server` also provides `ModelLoader` (background loading, with `503` until ready),
`run_command` (an engine CLI killed on cancel) and the `req_*` validators. `songdeck_bridge.wav`
reads and writes WAV and base64.

## Tests

```sh
cd packages/ai && npx vitest run test/bridges.integration.test.ts   # skipped when python3 is missing (SONGDECK_PYTHON overrides)
python3 -m py_compile bridges/*.py bridges/songdeck_bridge/*.py
```

`ruff check bridges` and `ruff format --check bridges` lint the Python (target Python 3.9).

The integration test starts `mock_bridge.py --role all` on random free ports and drives the
**real** adapters: `createProvider(configFromPreset(<local preset>, { baseUrl }), { transport: new DirectTransport() })`.
It covers every contract, deterministic seeds, the inpaint range invariant, the exact singing time
ranges, the stems summing to the input, pitch round trips (singing → transcription, conversion →
transcription), consent errors, `404`/`400` mapping, abort → job cancellation on the bridge, and
bearer auth.
