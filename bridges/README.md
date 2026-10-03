# Song Deck bridges: local AI models over small HTTP contracts

Song Deck never depends on a specific AI engine (spec §2.2). Local engines, such as
[ACE-Step](https://github.com/ace-step/ACE-Step) for music,
[DiffSinger](https://github.com/openvpi/DiffSinger) for singing,
[Demucs](https://github.com/adefossez/demucs) for stem separation,
[Basic Pitch](https://github.com/spotify/basic-pitch) for transcription,
[RVC](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) for voice conversion and
[Matchering](https://github.com/sergree/matchering) for mastering, sit behind **generic JSON/HTTP
contracts** defined in [`packages/ai/src/contracts.ts`](../packages/ai/src/contracts.ts). A *bridge* is a
small server that speaks one contract and drives one engine. Song Deck's adapters (`local-music`,
`singing-http`, `transcription-http`, `separation-http`, `voice-conversion-http`, `mastering-http`)
only know the contract, so you can:

* swap engines (or engine versions) without touching Song Deck,
* run any model that implements a contract, including your own,
* keep everything on your machine, with no keys or cloud involved.

This folder holds the **mock bridge**, which implements every contract with simple deterministic
DSP and lets you check a Song Deck setup end to end without ML models. It also holds **reference
bridges** for the real engines and `songdeck_bridge`, a tiny standard-library toolkit that they all
share.

| File | What it is |
| --- | --- |
| `mock_bridge.py` | Every contract, deterministic stdlib DSP, no ML. One role per process, or all six roles at once. |
| `acestep_bridge.py` | Music (ACE-Step v1 pipeline): generate, transform, inpaint, extend, cancel. |
| `diffsinger_bridge.py` | Singing (OpenVPI DiffSinger): contract notes → `.ds` project → inference command. |
| `demucs_bridge.py` | Separation (Demucs CLI). |
| `basic_pitch_bridge.py` | Transcription (Basic Pitch). |
| `rvc_bridge.py` | Voice conversion (any RVC command line, through a template). |
| `mastering_bridge.py` | Mastering (Matchering with a reference; otherwise pyloudnorm or the stdlib loudness path). |
| `songdeck_bridge/` | Shared toolkit: `server.py` (HTTP app), `wav.py` (WAV/base64/resampling), `cli.py` (common flags, serve loop), `dsp.py` (stdlib DSP), `singing.py` (singing-request parsing). |

Everything needs **Python 3.9+**. The mock bridge and `songdeck_bridge` use only the standard
library. Engine bridges import their engine lazily and stop with an install hint when it is missing.

## Quick start (no models needed)

```sh
python3 bridges/mock_bridge.py --role all          # six bridges on 127.0.0.1:8810-8815
```

In Song Deck, open **Settings → Providers → Add provider**. Pick the local preset of a category,
for example *Music generation → ACE-Step (local)*. Its endpoint URL already points at the right port.
Save, then click **Test connection** or **Discover models**. Generations, vocals, transcriptions,
stems, conversions and masters now come from the mock: real WAV files, audibly simple.

## Contract summary

### Rules shared by every bridge

| Topic | Rule |
| --- | --- |
| Transport | HTTP/1.1 on a configurable base URL; paths are relative to it. Requests are `application/json` (UTF-8). |
| Audio in JSON | Base64 (standard alphabet, no `data:` prefix) of a **complete WAV file**: PCM 16/24-bit or 32-bit float, any sample rate, mono or stereo. The toolkit also reads 8/32-bit PCM, 64-bit float, WAVE_FORMAT_EXTENSIBLE and RF64. |
| Audio responses | `200`, `Content-Type: audio/wav`, the WAV bytes. Optional `X-Seed: <int>` (the seed actually used, also when the request had none) and `X-Model: <id>`. |
| Errors | Non-2xx with `{"error": "<message>"}`. See the table below. |
| Auth | Optional. A bridge started with `--token` (or `$SONGDECK_BRIDGE_TOKEN`) requires `Authorization: Bearer <token>` on everything except `GET /health`. |
| Long jobs | Requests may take minutes. When Song Deck cancels, it aborts the HTTP request, and the bridge notices the disconnect and stops the job. It may also call `POST /cancel`. |
| Idempotency | Song Deck retries 429/5xx up to twice, so handlers have no side effects. With the same seed, the result is the same. |
| Units | Times are seconds (floats), pitches are MIDI numbers (60 = C4), velocities run 1–127 and expression values 0–1. |

| Status | When | Song Deck sees |
| --- | --- | --- |
| 400 | Invalid input: bad JSON, missing/ill-typed field, unreadable WAV, out-of-range value | `bad-request` (not retried) |
| 401 | Missing or wrong bearer token | `auth` |
| 403 | Browser origin or `Host` header not allowed (see Security) | `auth` |
| 404 | Unknown endpoint, **voice id or model id** | `bad-request` |
| 405 | Wrong method (an `Allow` header lists the right ones) | `bad-request` |
| 409 | **Busy and not queueing** (queue full); also the answer to a request cancelled by `POST /cancel` | `bad-request` |
| 413 | Body larger than `--max-body-mb` | `bad-request` |
| 500 | The engine failed (the message includes the last lines of its output) | `unavailable`, retried ≤ 2 |
| 501 | **Operation not supported** (e.g. drums in Basic Pitch) | `unavailable` |
| 503 | **Model still loading** (`Retry-After`), or the bridge is shutting down | `unavailable`, retried ≤ 2 |

Every bridge also answers `GET /info` (Song Deck's *Test connection* and model manager probe it),
`GET /health` (status, job counters, model-loading state; no auth) and `POST /cancel` (`{"job_id"?}`
→ `204`; without `job_id` it cancels every running or queued job). Job responses carry `X-Job-Id`. A
client may choose the id by sending an `X-Job-Id` request header.

### Endpoints

| Bridge (preset, port) | Endpoint | Request | Response |
| --- | --- | --- | --- |
| Music (`ace-step-local` 8810, `custom-audio-http` 8820) | `GET /info` | – | `{name, version, models: [{id, name}], capabilities: ["TEXT_TO_MUSIC", …], hardware?: {min_vram_gb}}` |
| | `POST /generate` | `{prompt, duration_seconds, seed?, bpm?, key?, lyrics?, sections?: [{name, start_seconds, end_seconds, prompt?}], negative_prompt?, reference_audio_base64?, guide_audio_base64?, strength?, instrumental?, model?}` | WAV |
| | `POST /transform` | `{audio_base64, prompt, strength, seed?, model?}` | WAV (audio-to-audio) |
| | `POST /inpaint` | `{audio_base64, start_seconds, end_seconds, prompt, seed?, model?}` | WAV; only the range changes |
| | `POST /extend` | `{audio_base64, prompt, duration_seconds, seed?, model?}` | WAV; only if `OUTPAINTING` is advertised |
| | `POST /cancel` | `{job_id?}` | `204` |
| Singing (`diffsinger-local` 8811) | `GET /voices` | – | `[{id, name, voice_type, language, kind}]` |
| | `POST /synthesize` | `{voice_id, tempo_bpm, sample_rate, seed, notes: [{pitch, start_seconds, duration_seconds, lyric, phonemes?, velocity, expression?}], language?}` | WAV covering **0 … end of the last note** |
| | `POST /regenerate_phrase` | the same + `start_seconds, end_seconds` | WAV covering **only [start, end]** |
| Separation (`demucs-local` 8812) | `POST /separate` | `{audio_base64, stems: ["drums", "bass", "vocals", "other"]}` (`guitar`, `piano` with 6-stem models) | `{stems: {name: wav_base64}, model}` |
| Transcription (`basic-pitch-local` 8813) | `POST /transcribe` | `{audio_base64, source: mix\|vocals\|bass\|drums\|piano\|guitar\|melody\|other}` | `{notes: [{pitch, start, end, velocity, confidence}], tempo?, key?, chords?}` |
| Voice conversion (`rvc-local` 8814) | `POST /convert` | `{audio_base64, target_voice_id, pitch_shift?}` | WAV |
| | `GET /voices` | – | `[{id, name, voice_type, language, kind}]` (optional in the contract) |
| Mastering (`mastering-local` 8815) | `POST /master` | `{audio_base64, target: streaming\|cd\|loud-rock\|dynamic\|podcast\|demo, reference_audio_base64?}` | WAV |

Lyrics may carry section tags (`[verse]\nline…\n\n[chorus]\n…`). In singing notes, a syllable ending
in `-` continues a word (`a-`, `lone`), and `_` sustains the previous vowel (melisma). Song Deck
enforces voice-conversion consent (spec §36) **before** any audio leaves the app: stock voices
convert freely, while any other `kind` needs a recorded attestation.

## Status

| Bridge | Engine | Status |
| --- | --- | --- |
| `mock_bridge.py` + `songdeck_bridge/` | none (stdlib DSP) | **Tested end to end.** `packages/ai/test/bridges.integration.test.ts` drives the real Song Deck adapters against it for every contract: errors, bearer auth, abort → job cancellation and consent. |
| `acestep_bridge.py` | ACE-Step v1 | **Reference code, not exercised in CI.** The engine call follows ACE-Step v1's `ACEStepPipeline` and must be verified against your checkout. ACE-Step 1.5 needs `AceStepEngine.run()` adapted. |
| `diffsinger_bridge.py` | OpenVPI DiffSinger | **Reference code, not exercised in CI.** The `.ds` builder can be inspected offline (`--print-ds`). The G2P is a tiny English heuristic. |
| `demucs_bridge.py` | Demucs 4 CLI | **Reference code, not exercised in CI.** |
| `basic_pitch_bridge.py` | basic-pitch 0.3/0.4 | **Reference code, not exercised in CI.** |
| `rvc_bridge.py` | any RVC CLI (template) | **Reference code, not exercised in CI.** The command template must match your fork. |
| `mastering_bridge.py` | Matchering 2 / pyloudnorm / stdlib | **Reference code.** The stdlib path is the mock's tested code. The Matchering and pyloudnorm paths are not exercised in CI. |

While these bridges were developed, their HTTP and command plumbing (temp files, command templates,
output lookup, trimming, splicing, cancellation) was smoke-tested against stand-in engines. The engine
calls themselves were never run against real installs here, because engine APIs change between
versions. Each bridge therefore isolates them in one or two clearly marked functions
(`run_demucs()`, `run_basic_pitch()`, `AceStepEngine.run()`, `build_ds()`/`run_inference()`, `run_rvc()`,
`run_matchering()`/`master_pyloudnorm()`) that you can adapt.

## Running the bridges

### Common flags (every bridge)

| Flag | Default | Notes |
| --- | --- | --- |
| `--host` | `127.0.0.1` | This machine only. A non-loopback host **requires** `--token`; `--allow-remote-without-token` overrides that (not recommended). |
| `--port` | preset port | `0` picks a free port. The bridge prints a `songdeck-bridge ready {json}` line with the URLs once it listens. |
| `--token` | `$SONGDECK_BRIDGE_TOKEN` | Requires `Authorization: Bearer <token>`. Prefer the environment variable, which keeps the token out of `ps`. |
| `--model`, `--device` | per bridge, `auto` | Model to load/report; `auto`/`cpu`/`cuda`/`cuda:N`/`mps`. Ignored where meaningless. |
| `--allow-origin URL` | studio + server origins | CORS allow-list (repeatable, replaces the defaults `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:7788`, `http://127.0.0.1:7788`); `*` allows any origin. |
| `--allow-host NAME` | – | Extra `Host` name accepted while bound to loopback. |
| `--max-body-mb` | `512` | Request size limit (`413` beyond it). |
| `--max-jobs` / `--max-queue` | `1` / `8` | Concurrent jobs and waiting requests. A request beyond the queue gets `409`. `--max-queue 0` never queues. |
| `--no-disconnect-detection` | off | Keep running jobs whose client disconnected (only `POST /cancel` stops them). |
| `--log-level` / `--quiet` | `info` | One line per request (never bodies or tokens). |

Stop a bridge with Ctrl+C or SIGTERM. It refuses new jobs (`503`), cancels running ones, closes its
port and exits. A second Ctrl+C exits immediately.

### Mock bridge

```sh
python3 bridges/mock_bridge.py --role music                  # 8810 (ACE-Step preset); --port 8820 for the custom-audio preset
python3 bridges/mock_bridge.py --role all --base-port 8810   # all roles: music 8810, singing 8811, separation 8812,
                                                             # transcription 8813, voice-conversion 8814, mastering 8815
python3 bridges/mock_bridge.py --role all --base-port 0      # any free ports (printed on the ready line)
```

Extra flags: `--role`, `--base-port`, `--sample-rate` (generated music, default 44100),
`--max-duration` (default 600 s), `--delay SECONDS` (simulated engine latency, cancellable; handy
for testing Song Deck's cancel and queue UI) and `--model mock-additive|mock-additive-lofi`.

What each role does:

* **music**: `/generate` renders a seeded additive-synth arrangement at the requested bpm, key and
  duration. The pad chords, bass and drums use one progression and energy per section (intro quiet,
  chorus loud; prompt words such as *calm* or *energetic* move the energy). A hummed line follows the
  syllables of the section's lyric lines. Guide audio is blended by `strength`, and reference audio sets
  the level. `/transform` blends the input with a re-synthesis (`strength` 0 = input, 1 = new).
  `/inpaint` replaces only the range, with crossfades inside it, so everything outside it stays
  bit-identical. `/extend` appends a continuation. The role advertises the ACE-Step preset's
  capabilities, including `INPAINTING` and `OUTPAINTING`. Two models: `mock-additive` and
  `mock-additive-lofi`.
* **singing**: two stock voices (`mock-soprano` sine, `mock-tenor` sawtooth). Each note becomes a
  tone at its pitch and time with vibrato (`vibrato`/`vibrato_rate`), onset/release shapes,
  `breathiness` noise and `velocity`/`energy` loudness. `_` glides from the previous note. The output
  covers exactly the contract range, and a phrase render equals the matching slice of a full render
  with the same seed.
* **transcription**: an autocorrelation (McLeod NSDF) pitch tracker for **monophonic** input turns
  audio into notes with confidence. It reports `key` when there are enough notes and `tempo` from onsets.
  `source: "drums"` runs an onset detector instead (kick 36, snare 38, hat 42).
* **separation**: complementary frequency bands (plus mid/side) as "stems" whose sum equals the
  input. One requested stem also returns `no_<stem>`, as Demucs `--two-stems` does.
* **voice-conversion**: a duration-preserving pitch shift (resampling + WSOLA) plus a per-voice tone
  colour. Voices: `mock-alto`, `mock-baritone` (stock) and `mock-user-voice` (`user-trained`, to
  exercise Song Deck's consent flow). Unknown ids get `404`.
* **mastering**: BS.1770 integrated loudness normalized to the target (or to the reference's loudness)
  and a look-ahead peak limiter. The output is 24-bit, or 16-bit with dither for `cd`. `X-Integrated-LUFS` reports the result.

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

| Target | Loudness | Ceiling | Output |
| --- | --- | --- | --- |
| streaming | −14 LUFS | −1.0 dBFS | 24-bit |
| cd | −9 LUFS | −0.3 dBFS | 16-bit + TPDF dither |
| loud-rock | −8 LUFS | −0.3 dBFS | 24-bit |
| dynamic | −18 LUFS | −1.0 dBFS | 24-bit |
| podcast | −16 LUFS | −1.0 dBFS | 24-bit |
| demo | −12 LUFS | −1.0 dBFS | 24-bit |

## Connecting a bridge in Song Deck

1. Start the bridge. Its log shows `… listening on http://127.0.0.1:<port>`.
2. **Settings → Providers → Add provider** and pick the matching local preset: *ACE-Step (local)*,
   *DiffSinger (local)*, *Demucs (local)*, *Basic Pitch (local)*, *RVC voice conversion (local)*,
   *Local mastering engine*, or *Custom audio model (HTTP)* for any other music model on the music
   contract.
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

* **Bind to `127.0.0.1`** (the default). A bridge runs heavy jobs and reads/writes temporary files.
  Expose it to a network only with a token: `--host 0.0.0.0` refuses to start without `--token`.
  Treat the token as a password and prefer `SONGDECK_BRIDGE_TOKEN` over the command line.
* **Browsers:** requests carrying an `Origin` header that is not allow-listed get `403`. This stops web
  pages you visit from triggering jobs. Only the Song Deck origins receive CORS headers.
* **DNS rebinding:** while bound to loopback, a `Host` header other than `localhost`/`127.x`/`::1`
  (or `--allow-host`) gets `403`.
* Tokens are compared in constant time. Request bodies are size-limited and never logged.
* Engine commands run **without a shell**. Templates are split into arguments before the
  placeholders are filled, so file names and ids cannot inject commands. RVC voice ids are matched
  against the files in `--models-dir`.
* Voice conversion: Song Deck checks consent before sending audio. Install only voices you have the
  right to use.

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

The integration test starts `mock_bridge.py --role all` on random free ports and drives the
**real** adapters: `createProvider(configFromPreset(<local preset>, { baseUrl }), { transport: new DirectTransport() })`.
It covers every contract, deterministic seeds, the inpaint range invariant, the exact singing time
ranges, the stems summing to the input, pitch round trips (singing → transcription, conversion →
transcription), consent errors, `404`/`400` mapping, abort → job cancellation on the bridge, and
bearer auth.
