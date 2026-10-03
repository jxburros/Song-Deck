# Song Deck — Phase Coverage

This document maps every item in the specification's delivery phases (`Song Deck.md` §66–§70)
to the code that implements it, how it is verified, and what its honest limitations are.
Paths are relative to the repository root; `views/…` and `engine/…` are short for
`apps/studio/src/views/…` and `apps/studio/src/engine/…`. "On-device" means it runs with no AI
provider, no network and no local server.

| Phase | Theme | Status |
| --- | --- | --- |
| 1 (§66) | Composition, MIDI workbench, providers | Implemented |
| 2 (§67) | Audio → MIDI, separation, rebuild, theory, custom genres | Implemented (see limitations) |
| 3 (§68) | Production | Implemented (see limitations) |
| 4 (§69) | Vocals | Implemented (see limitations) |
| 5 (§70) | Professional workflow | Implemented (see limitations) |

How to verify everything below:

```bash
npm install
npm test                 # unit + integration tests for every package
npm run typecheck        # strict TypeScript across the monorepo
npm run e2e              # Playwright: the studio in Chromium (set E2E_PORT if 5199 is taken)
npm run build            # production build of the studio
```

---

## Phase 1 — MVP (§66)

| Spec item | Where | Notes |
| --- | --- | --- |
| Song Blueprint generation | `packages/core/src/composer/blueprint.ts` (`parsePromptToBlueprint`), `apps/studio/src/views/compose/*`, `apps/studio/src/engine/ai.ts` (`aiDesignBlueprint`) | Prompt → editable Blueprint (§10). An AI provider with the *composition* role refines it through validated structured output; the deterministic parser is the always-available fallback. |
| Deterministic theory engine | `packages/core/src/theory/` (`pitch`, `scales`, `chords`, `roman`, `voicing`, `analysis`) | Scales/modes, chord parsing and spelling, roman numerals (secondary dominants, borrowed chords), voice-leading voicing search, cadence and tension analysis (§13). |
| AI-assisted composition | `packages/ai/src/orchestrator.ts`, `packages/ai/src/composition.ts`, `apps/studio/src/engine/ai.ts` | Blueprint design, composition planning, natural-language edits, theory Q&A and lyric generation are *roles* routed to any capable provider (§49). Output is always `MusicOperation`s or schema-validated JSON — never raw MIDI bytes (§46). |
| MIDI generation | `packages/core/src/composer/` (`planner`, `compose`, `generators/*`), Generate MIDI mode (`apps/studio/src/views/generate/`) | 19 genre profiles, 37 instrument profiles, role generators for drums, bass, chords, guitar, lead, synth, percussion and vocal melody, all seeded and reproducible (§12–§17, §23). Generate MIDI mode turns a prompt such as "Generate four alternative bass lines for this progression" into an editable request and seeded alternatives, each with a notation preview, audio preview, `.mid` export, and insert-as-proposal (§25). |
| Piano roll | `apps/studio/src/views/workbench/PianoRoll.tsx` | Canvas editor: draw/move/resize/marquee, velocity and vocal-expression lanes, chord-tone highlighting, ghost track, proposal diff overlay and in-place "Modify" of a pending proposal (§18, §21). |
| Arrangement view | `apps/studio/src/views/workbench/ArrangementView.tsx` | Tracks × sections timeline with chord lane, ruler loop selection and per-cell locks. Pattern, Chord, Structure and Theory views complete the six workbench views of §18. |
| Instrument tracks | `packages/core/src/composer/instruments.ts`, `apps/studio/src/views/workbench/SidePanel.tsx`, `panels/InspectorPanel.tsx` | Add/remove/rename tracks, change instruments, ranges, mute/solo; instrument constraints are enforced by the Validation Engine (§17, §48). |
| Locking | `packages/core/src/locks.ts`, `packages/core/src/edit/locks-check.ts`, `panels/LocksPanel.tsx` | Song-level (tempo, key, structure, chords), track, track×section, note and lyric locks. Locked material is guaranteed unchanged at the symbolic layer and re-verified before any proposal is accepted (§22). |
| Regeneration | `packages/core/src/composer/regenerate.ts`, `variation.ts` | "Regenerate unlocked material", per-track/section regeneration, and the four variation depths (ornament → mutation) of §24, all seeded. |
| MIDI export | `packages/core/src/io/midi.ts`, Export mode | Type-1 Standard MIDI Files with tempo/meter/key maps, markers and lyrics; per-track export; MIDI import for round-tripping. |
| Local MIDI playback | `packages/audio/src/dsp/renderer.ts`, `apps/studio/src/engine/player.ts`, `playback.worker.ts` | A pure-TypeScript synthesizer renders the song in a Web Worker and streams sample-accurate chunks to Web Audio; loop, metronome, mute/solo and live mixer changes. |
| OpenAI-compatible provider abstraction | `packages/ai/src/adapters/openai-compatible.ts` | One adapter covers any OpenAI-style endpoint (chat completions, JSON mode/structured output, streaming, model listing). |
| Several cloud provider adapters | `packages/ai/src/presets.ts`, `adapters/anthropic.ts`, `adapters/gemini.ts` | OpenAI, Anthropic (official SDK), Google Gemini (native API), Moonshot/Kimi, Meta Llama API, Together and Groq. |
| Local LLM support | `adapters/ollama.ts`, presets `llama-cpp`, `lm-studio`, `vllm`, `custom-llm-http` | Native Ollama adapter plus llama.cpp server, LM Studio and vLLM through the OpenAI-compatible adapter; arbitrary HTTP via a templated custom adapter. |

Cross-cutting Phase 1 behaviour that the spec makes non-negotiable:

* **Proposals, not overwrites (§21):** every AI or theory edit becomes a `Proposal` with a visual
  note diff and validation report; Accept / Reject / Modify (`panels/ProposalsPanel.tsx`).
* **Bad model output never corrupts a project (§48):** `packages/core/src/edit/` validates and
  applies operations to a clone; invalid operations are reported, optionally auto-fixed, never applied blindly.
* **Offline mode (§51):** with no provider configured every role falls back to the on-device
  engine (`apps/studio/src/engine/internalProviders.ts`), which is registered in the provider
  registry exactly like an external provider.
* **Keys never in project files (§7):** credentials live in the local server vault (OS keychain,
  encrypted-file fallback) or in an in-memory session store in the browser.

Verified by: `packages/core/test/{foundation,composer.*,composer-fuzz,edit,io,project,musician-*}.test.ts`,
`packages/ai/test/*.test.ts`, the Phase 1 browser loop in `apps/studio/e2e/smoke.spec.ts`
(prompt → blueprint → plan → MIDI → piano roll → "Make the bass busier." → proposal → accept → theory view),
and `apps/studio/e2e/workbench.spec.ts` (a locked track stays byte-identical through "Regenerate
unlocked", undo restores every track, and regenerating one track changes no other).

---

## Phase 2 — Audio understanding (§67)

| Spec item | Where | Notes |
| --- | --- | --- |
| Audio-to-MIDI | `packages/audio/src/analysis/transcribe*.ts`, Transcribe mode (`apps/studio/src/views/transcribe/`) | Monophonic (YIN + note segmentation), polyphonic (spectral peak/harmonic grouping) and drum (onset + band classification) transcription with tempo/key detection and quantization (§26). Results show a confidence-coloured note strip, notation, "check bars X–Y" hints and A/B playback of original vs MIDI; inserting stores the recording as an asset with provenance and an analysis record. |
| Humming-to-MIDI | `analysis/transcribe-mono.ts`, `views/transcribe/RecordPanel.tsx` | Hum, sing, whistle, clap or play into the microphone (count-in, level meter, input picker), upload a voice memo, or tap a rhythm (`TapPad.tsx`); then insert as a track, replace a phrase, export MIDI or start a new song (§27). A MIDI keyboard can also be recorded straight into the piano roll (`engine/midi-input.ts`). |
| Source separation | `analysis/separation.ts`, preset `demucs-local` (`adapters/separation-http.ts`) | On-device DSP separation (HPSS + spectral/mid-side masking) into drums, bass, vocals and other; a local neural separator can be plugged in through the separation contract. |
| Chord detection | `analysis/chords.ts`, `analysis/key.ts`, `analysis/chroma.ts` | Beat-synchronous chroma templates with key-aware smoothing; outputs chord symbols and roman numerals. |
| Rebuild mode | `analysis/rebuild.ts`, Rebuild mode (`apps/studio/src/views/rebuild/`) | The ten pipeline stages of §25 run as a cancellable queue task with live status and confidence: separation → tempo/meter/key → chords → per-stem transcription → structure → an editable song. Opening it stores the source as a reference asset and, optionally, the stems as muted audio tracks for A/B against the rebuilt MIDI. |
| Richer theory explanations | `packages/core/src/musician/theory-explain.ts`, `theory-controls.ts`, `views/workbench/TheoryView.tsx` | Per-section prose (§43): key/mode, cadences, borrowed and secondary chords, tension curve, melody/bass relationships; theory controls produce proposals. |
| Custom genre profiles | Settings → Plugins (`views/settings/GenreEditor.tsx`, `InstrumentEditor.tsx`), `plugins/lofi-hiphop-genre/`, `apps/studio/src/hooks.ts` (`useCustomGenres`) | Duplicate a built-in genre into an editable profile (tempo range, meters, modes, roman-numeral progressions, structure templates, instruments, rhythm and swing, dynamics, arrangement, production keywords) with JSON import/export, or install one as a plugin. Custom profiles feed the same composer and Generate MIDI as the built-ins; every commit bundles the profiles a song uses into its `.songproject`, so it stays portable. |

Verified by: `packages/audio/test/analysis-*.test.ts` (78 tests on synthetic signals: pitch within
10 cents, tempo within 0.1 %, chord progressions, separation ordering, a 3-minute rebuild under 60 s),
`packages/core/test/musician-theory.test.ts`, `apps/studio/test/midi-take.test.ts`, and the browser
flows in `apps/studio/e2e/generate-transcribe-rebuild.spec.ts` (generate alternatives, transcribe an
uploaded melody, a microphone take and a tapped rhythm, rebuild a synthesized mix),
`e2e/midi-record.spec.ts` and `e2e/task-resume.spec.ts` (a rebuild interrupted by a reload resumes).

Limitations (honest):

* Separation is classical DSP, not a neural network. Stems are usable for transcription and
  guide work but bleed is audible; confidences are reported at 0.3–0.6 and the UI says so.
* Polyphonic transcription misses octave doublings and dense voicings; tempo is a single
  fixed value (free-tempo performances are quantized with a low-confidence warning); key
  detection distinguishes major/minor only.
* Accuracy figures come from synthetic test signals; real recordings score lower.

---

## Phase 3 — Production (§68)

| Spec item | Where | Notes |
| --- | --- | --- |
| Guide rendering | `packages/audio/src/dsp/renderer.ts`, Produce → Guide render (`apps/studio/src/views/produce/GuidePanel.tsx`, `engine/handlers/render.ts`) | The composition is rendered with the built-in instruments, with plugin sample instruments, or round-tripped through an external DAW (MIDI per stem group out, WAV stems back in). Output is `guide_mix.wav` plus drums/bass/guitar/keys/strings/vocal-melody reference stems, saved as assets with provenance (§28). |
| Audio-generation provider system | `packages/ai/src/production.ts`, `adapters/{elevenlabs,stability,lyria,local-music,managed}.ts`, `engine/produce-providers.ts` | Providers advertise the §30 capabilities (text-to-music, MIDI/stem conditioning, audio-to-audio, inpainting, stems…); the Produce mode shows them as badges, picks how to call each provider (perform the MIDI, guide-conditioned, audio-to-audio or text-only with a warning) and warns about missing capabilities. |
| Local music generation | presets `ace-step-local`, `custom-audio-http`, `bridges/acestep_bridge.py`, `packages/ai/src/catalog.ts` | Local engines plug in through the JSON/HTTP music contract; before generating, the studio shows the model's hardware requirements against the detected hardware (§31). |
| Managed generation | `packages/ai/src/adapters/managed.ts`, `packages/ai/src/managed-gateway.ts`, `apps/server/src/managed.ts` | The "Automatic" option (§8): the local server's gateway routes each request across the configured providers by quality, cost, latency, availability and privacy settings. |
| Stem production | Strategy B in `views/produce/ProductionPanel.tsx`, `engine/handlers/production.ts` | Each stem is produced separately from its guide stem and MIDI, as a resumable task with per-stem checkpoints; produced stems stay independently mixable (§38 B). Strategy C mixes methods per track (§38 C). |
| Production prompts | `buildProductionPrompt` in `packages/ai/src/production.ts`, `ProductionPanel.tsx` | Prompts are derived from the composition (genre, mood, instrumentation, energy per section, lyrics) and editable, with a negative prompt, per-section prompts and a live preview; reference audio is uploaded only when allowed (§29, §50). |
| A/B rendering | `views/produce/CandidatesPanel.tsx`, `comparePlayer.ts` | Several candidates of the identical revision, compared at the same playback position with level matching, rated, annotated and adopted into the mix as audio tracks (§54). Any bar range of a candidate can be regenerated with everything outside it bit-identical (§39). |

Every production run shows its cost, duration and hardware estimate first, asks for confirmation
when data would leave the device, and records provenance (source revision, guide asset,
provider/model, seed, cost, parameters; §60, §64).

Verified by: `packages/ai/test/{audio-adapters,platform}.test.ts`, the bridge integration test
`packages/ai/test/bridges.integration.test.ts` (music, inpainting and extension through the real
adapters), `packages/audio/test/dsp-*.test.ts`, and `apps/studio/e2e/produce.spec.ts` (guide render,
two candidates, adopting stems, regenerating a region).

Limitations (honest):

* No neural music model ships with Song Deck. The on-device producer renders the composition with
  DSP production chains, and candidates differ by a seeded performance variation (timing and
  dynamics), not by genuinely different interpretations. Real generation needs a configured cloud
  provider or a local engine behind a bridge.
* The cloud adapters (ElevenLabs Music, Stable Audio, Lyria) and the real-engine bridges are
  implemented against the providers' documented APIs and tested against mocks, not live services.

---

## Phase 4 — Vocals (§69)

Vocals are an independent subsystem (§32): lyrics, the vocal melody (`vocal.mid`), expression, the
voice and its render are separate layers that can each be changed or regenerated without the
production model ever generating the singer. Vocals mode offers the six §33 modes (no vocal,
melody only, placeholder, AI singer, voice conversion, recorded).

| Spec item | Where | Notes |
| --- | --- | --- |
| Vocal melody | `packages/core/src/composer/generators/vocal.ts`, Vocals → Melody (`apps/studio/src/views/vocals/MelodyPanel.tsx`) | The lead vocal is its own MIDI track, composed against the harmony and lyric syllable counts; it can be regenerated per section without touching the instrumentation and exported as `vocal.mid`. |
| Lyric alignment | `packages/core/src/musician/lyrics/` (`syllables`, `g2p`, `align`, `placeholder`), `views/vocals/LyricsPanel.tsx` | Per-section lyric editor with live syllable counts against the vocal notes and a phoneme preview; syllables are aligned to notes, or the melody's rhythm is fitted to the lyrics as a reviewable proposal. AI-written or placeholder lyrics are labelled as such; lyric locks are respected and authorship is recorded in the rights metadata (§48, §65). |
| Dedicated singing synthesis | `packages/audio/src/dsp/singing/`, `adapters/singing-http.ts` + `bridges/diffsinger_bridge.py`, `views/vocals/RenderPanel.tsx`, `engine/vocal-render.ts` | A SINGING_SYNTHESIS provider sings from lyrics, phonemes, the MIDI melody, tempo, expression and voice to `lead_vocal-vN.wav`, which becomes an audio track mixed like any stem, with provenance as in the §64 example. The built-in formant singer (six stock voices) always works offline. |
| Vocal expression | `VocalExpression` in the IR, piano-roll expression lanes, `views/vocals/ExpressionPanel.tsx` | Breathiness, tension, vibrato depth and rate, energy, onset and release as defaults plus per-phrase or per-selection overrides, applied as validated operations; the panel shows which parameters the chosen singer honours (§35). |
| Vocal regeneration | `views/vocals/RegeneratePanel.tsx`, `engine/vocal-sync.ts`, `packages/core/src/musician/vocal-commands.ts` | Instructions such as the §37 examples become proposals; accepting one re-sings only the changed phrase or section and splices it into the current render with crossfades in the surrounding rests — the instrumentation is never touched. |
| Authorized voice models | `views/vocals/VoicesPanel.tsx`, `ConversionPanel.tsx`, `packages/ai/src/consent.ts`, preset `rvc-local` | Stock, user-trained, imported and third-party voices. Every non-stock voice needs an authorization attestation (who attests, rights holder, basis, evidence, scope) before it can be used, stored with the project as voice provenance and in the rights metadata; conversion providers are wrapped so they refuse to run without consent (§36). |
| User-recorded vocals | `views/vocals/RecordingPanel.tsx`, `engine/vocal-recorder.ts`, `vocal-takes.ts` | Record takes over the playing song with a count-in and latency compensation; takes are kept as recording assets on a takes track, one is chosen as active, and a take can be transcribed back into the vocal MIDI as a proposal so the symbolic layer stays in sync. |

Verified by: `packages/core/test/musician-{lyrics,mix-vocal}.test.ts`, `packages/audio/test/dsp-vocal.test.ts`
(pitch accuracy per stock voice, vowel formants, consonants), `packages/ai/test/audio-adapters.test.ts`
and the singing and voice-conversion cases of `packages/ai/test/bridges.integration.test.ts` (consent
is enforced before a request leaves the studio), and
`apps/studio/e2e/vocals.spec.ts` (lyrics, alignment, singing render, phrase and section regeneration,
consent, takes, expression, voices, take transcription).

Limitations (honest):

* The built-in singer is a formant synthesizer: intelligible and expressive, but clearly synthetic.
  Natural singing needs a singing model (for example DiffSinger behind its bridge) or a cloud
  provider; voice conversion always needs a provider.
* Syllables and pronunciations come from English rules plus a small dictionary, without stress
  marks; placeholder lyrics are template-based.
* "Fit the melody's rhythm to the lyrics" splits notes only down to sixteenth notes, so very dense
  lines can stay a syllable or two off; the alignment report flags them.
* Recorded takes rely on the browser's reported latency plus a user offset setting; headphones are
  needed to keep the song out of the microphone.


## Phase 5 — Professional workflow (§70)

| Spec item | Where | Notes |
| --- | --- | --- |
| Stem mixing | Mix & Master mode (`apps/studio/src/views/mix/`), `packages/audio/src/dsp/{mixer,automation,effects}` | A console strip per MIDI or audio track: fader, pan, mute/solo, 6-band EQ with a draggable curve, compressor with transfer curve, reverb/delay sends, width, drive, phase, live meters; automation lanes; imported stems become audio tracks. The AI Mix Assistant turns requests such as "Make the vocal clearer" into ordinary mixer changes shown as reviewable proposals (§40, §41). |
| Mastering | `packages/audio/src/dsp/{mastering,loudness}.ts`, `views/mix/MasteringPanel.tsx` | Built-in DSP mastering to the six §42 targets (streaming −14 LUFS … demo), with EBU R128 loudness analysis, true-peak limiting, A/B against the mix, provenance, and local/cloud/external mastering providers. |
| DAW interoperability | `packages/core/src/io/{dawproject,reaper,midi,musicxml,markers}.ts`, Export mode | Multitrack MIDI, stems, tempo map, markers and Audacity labels; DAWproject (Bitwig, Studio One, Cubase) and Reaper projects with referenced audio (§56). |
| Collaboration | `apps/server/src/collab/`, `apps/studio/src/engine/collab.ts`, Settings → Collaboration | Shared projects on the local server; a WebSocket room per project carries commits (with an outbox and two-way sync after reconnecting), presence, comments anchored to sections, and chat. Concurrent edits fork into "<branch> — <author>" branches instead of overwriting; while connected, undo/redo are shared revisions. |
| Version branches | `packages/core/src/project/history.ts`, `views/workbench/panels/{HistoryPanel,VariationPanel}.tsx` | Every meaningful operation is a revision; compare, restore, branch, duplicate and merge selected changes (§52); branch templates such as Heavy, Acoustic, Synth and Radio Edit keep the Song DNA (§53). |
| Plugin ecosystem | `apps/server/src/plugins.ts`, `apps/studio/src/engine/plugins.ts`, `plugins/`, [`docs/PLUGINS.md`](./PLUGINS.md) | Genre profiles, instruments (including SFZ sampled instruments), exporters and AI providers; the server validates and serves plugins but never runs their code, and the studio loads them only after the user enables them (§57). |
| Distributed/local render nodes | `apps/server/src/render/`, `apps/studio/src/engine/collab-render.ts`, Settings → Render nodes | Any Song Deck server can be a render node (worker threads, queue limits, token auth). Stem renders are split across healthy nodes and fall back to this device per stem; renders are deterministic, so distributed output equals a local render. |

Verified by: `apps/server/test/*.test.ts` (vault, proxy, collaboration, render nodes, plugins,
managed gateway), `packages/core/test/{io,project,rebase}.test.ts`, `apps/studio/test/sfz-plugin.test.ts`,
and the browser flows in `apps/studio/e2e/mix-export.spec.ts` (mixing, assistant proposals,
mastering, every export format), `e2e/settings.spec.ts` (provider keys in the vault, routing rules,
two people collaborating, render nodes) and `e2e/sfz-plugin.spec.ts`.

Limitations (honest):

* AAC export uses the browser's WebCodecs encoder and is disabled where the browser has none
  (including Playwright's Chromium).
* Collaboration and render nodes run through the Song Deck server. When a server is exposed
  beyond this machine it requires a token; collaboration and render nodes send it, but the
  studio's other requests (vault, provider proxy, models, plugins) expect the studio's own server
  on loopback, the default. Render-node tokens are stored in browser settings.
* Plugins run with the studio's rights once enabled; there is no sandbox beyond that trust prompt.

