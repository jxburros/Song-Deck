# Song Deck — Architecture & Module Contracts

> "AI that gives you the song back." The canonical version of a song is its structured
> project data (Music IR), never a WAV. Every AI provider is replaceable.

This document maps the product specification (`Song Deck.md`) onto code and defines the
contracts between modules. Section references (§N) point at the spec.

## 1. Service boundary (spec §71)

```
apps/studio (UI) ─────────────────────────────────────────────────────────────
│  Project Manager UI · Workbench views · Modes · Settings · Task queue panel
│
├── packages/core   = Music Engine + Project Manager + Task Engine
│   ├── ir/         Music IR types, defaults, GM constants          (§47)
│   ├── theory/     Theory Engine primitives                        (§13)
│   ├── timing.ts   bars/beats/ticks/seconds                         (§47 TempoEvent/MeterEvent)
│   ├── locks.ts    lock keys and lock resolution                    (§22)
│   ├── composer/   genres, instruments, blueprint, planner, role generators,
│   │               arrangement, macros, regeneration, variation, Song DNA  (§10-§24)
│   ├── musician/   natural-language MIDI edits, theory explanations, lyrics,
│   │               vocal commands, mix-assistant rules, offline assistant (§20, §37, §41, §43, §44)
│   ├── edit/       structured operations, Validation Engine, diffs, proposals (§21, §46, §48)
│   ├── io/         MIDI, MusicXML, chord/lyric sheets, notation PDF, DAWproject,
│   │               Reaper, tempo map / markers                         (§55, §56)
│   ├── project/    .songproject packages, version history, branches, merge, provenance (§9, §52, §53, §64)
│   └── tasks/      Task queue: cancellable, resumable, retryable, inspectable (§63)
│
├── packages/ai     = AI Orchestrator + Model Runtime (cloud & local adapters)
│   capability taxonomy, provider registry, capability router, profiles, routing rules,
│   privacy/data-flow, cost & budgets, MusicContext builder, structured output parser,
│   LLM / audio-generation / singing / transcription / separation / mastering adapters (§3-§8, §30, §45-§46, §49-§50, §58-§62)
│
├── packages/audio  = Audio Engine (pure TypeScript, deterministic, browser + Node)
│   ├── dsp/        synth voices + instrument patches, streaming SongRenderer, mixer,
│   │               effects, automation, mastering & loudness, codecs, singing synthesis (§28, §34, §40, §42)
│   └── analysis/   FFT, onsets, tempo/beats, key, chroma/chords, YIN pitch tracking,
│                   transcription (mono/poly/drums), source separation, structure, rebuild (§25-§27)
│
└── apps/server     = Local runtime: credential vault (OS keychain), provider proxy,
                      hardware detection, model manager, render nodes, collaboration hub,
                      plugin host, managed "Automatic" gateway (§7, §8, §61, §62, Phase 5)
```

Dependency direction: `core ← audio`, `core ← ai`, `{core, audio, ai} ← studio, server`.
`ai` never imports `audio`; internal (on-device) providers that need DSP are implemented in
the apps and registered into the provider registry (dependency injection), so the
orchestrator stays provider-agnostic (§2.2, §72).

## 2. Conventions (all packages)

- **TypeScript, ESM, no build step for libraries** — each package's `exports` points at `src/index.ts`.
  Relative imports are extensionless.
- **Music IR** lives in `packages/core/src/ir/types.ts`. Do not fork these types; extend them there.
- **Time:** integer ticks, `PPQ = 480` ticks per quarter note. Internal bars/beats are **0-based**.
  Structured AI operations (`MusicOperation`) and the UI use **1-based** bars/beats.
  `bpm` is always quarter-notes per minute.
- **Determinism (§23):** generators take randomness only from `deriveRng(seed, ...keys)` and ids
  only from `IdFactory`. Same blueprint + constraints + seed + `ENGINE_VERSION` ⇒ identical song
  (`songHash` equal). Never use `Math.random()`/`Date.now()` inside generation.
- **Locks (§22):** use `locks.ts`. Regeneration must leave locked material byte-identical and the
  Validation Engine must verify it.
- **Bad model output never corrupts a project (§48):** AI output → `MusicOperation[]` → validated and
  applied to a clone → `Proposal` → user accepts → new revision.
- **Audio:** planar `Float32Array` channels (`AudioData`). No Web Audio in `packages/audio`.
- **No secrets in project files (§7):** credentials live only in the server vault (OS keychain) or,
  without the server, encrypted in the browser (AES-GCM, non-extractable key; `docs/CREDENTIALS.md`).
- **Dependencies:** runtime deps are intentionally minimal: `fflate` (zip), `@anthropic-ai/sdk`
  (Anthropic adapter), `react`/`zustand` (UI), `ws` (server), `@breezystack/lamejs` (MP3).

## 3. Module contracts (public exports)

### 3.1 core foundation (done)

`types`, `defaults` (`createEmptySong`, `createProject`, `defaultMixer`, `defaultChannelStrip`, `defaultMacros`, `ENGINE_VERSION`),
`gm` (`GM_DRUM`, `GM_PROGRAM_NAMES`), `song-utils` (`cloneSong`, `findTrack`, `sortNotes`, `songHash`, `stableStringify`),
`random` (`deriveRng`, `createRng`, `hashSeed`, `randomSeed`), `ids` (`IdFactory`, `randomId`),
`timing` (`barToTick`, `tickToBar`, `musicalToTick`, `tickToMusical`, `regionToTicks`, `createTimeMap`,
`sectionLayout`, `findSection`, `keyAtTick`, `chordAtTick`, `chordsInRange`, `quantizeTick`, …),
`locks` (`LockKeys`, `isTrackSectionLocked`, `isNoteLocked`, `lockedNotes`, …),
`theory` (`parseChordSymbol`, `formatChordSymbol`, `chordPitchClasses`, `chordTones`, `romanToChord`,
`chordToRoman`, `diatonicChords`, `borrowedFrom`, `voiceChord`, `guitarVoicing`, `pianoVoicing`,
`chordFunction`, `detectCadence`, `chordTension`, `parseKey`, `keyName`, `scalePitchClasses`,
`transposeDiatonic`, `snapToScale`, `noteNameToMidi`, `midiToNoteName`, …).

### 3.2 core/composer

```ts
BUILTIN_GENRES: GenreProfile[]                 // ≥17 genres of §14
getGenre(id, custom?: GenreProfile[]): GenreProfile | undefined
blendGenres(weights: GenreWeight[], custom?): GenreProfile        // "50% pop-punk 30% emo 20% cinematic"
BUILTIN_INSTRUMENTS: InstrumentProfile[]
getInstrument(id, custom?): InstrumentProfile                     // falls back to a sensible default
parsePromptToBlueprint(prompt: string, opts?: { seed?: number; customGenres?: GenreProfile[] }): Blueprint
defaultBlueprint(opts?): Blueprint
planComposition(blueprint: Blueprint, opts?): CompositionPlan     // abstract plan before MIDI (§15)
composeSong(blueprint: Blueprint, plan?: CompositionPlan, opts?): Song   // full deterministic pipeline
regenerateUnlocked(song: Song, opts?: RegenerateOptions): { song: Song; changed: { trackId: string; sectionIds: string[] }[] }
   // RegenerateOptions: { seed?, trackIds?, sectionIds?, startTick?, endTick?, level?: VariationLevel, includeChords? }
createVariation(song: Song, level: VariationLevel, opts: { seed: number; amount: number }): Song   // §24
extractSongDNA(song: Song): SongDNA                                // §11
composeFromDNA(dna: SongDNA, opts): Song                           // mutation / related versions
BRANCH_TEMPLATES                                                   // Heavy / Acoustic / Synth / Radio Edit (§53)
computeArrangement(song): Record<trackId, sectionId[]>             // orchestration density
applyMacroTransforms(song, macros, trackId?): Song                 // humanization/dynamics without regeneration
generateAsset(request: AssetRequest, seed: number): { song: Song; trackId: string }   // Generate MIDI mode
expandSong(source: Song, request: ExpansionRequest, opts?: ComposeSongOptions): ExpansionResult
   // Labeled source bar ranges + ordered keep/develop sections; immutable source, seeded development.
   // Kept sections are locked; returns { song, warnings, preservedSectionIds }.
   // See docs/MIDI-RESEARCH.md for conditioning, uncertainty, and supported source details.
```

### 3.3 core/musician

```ts
interpretEditInstruction(song, instruction, selection: EditSelection, opts?): EditInterpretation
   // EditInterpretation: { operations: MusicOperation[]; explanation: string; intents: string[]; understood: boolean }
explainSection(song, sectionId): SectionExplanation; explainSong(song): SongExplanation       // Theory View (§43)
applyTheoryControl(song, sectionId, control: TheoryControl, opts: { seed }): EditInterpretation
suggestChordSubstitutions(song, chordId): ChordSuggestion[]
syllabify(word): string[]; syllabifyText(text); countSyllables(text); textToPhonemes(text): string[]
alignLyrics(song, trackId, opts?): { operations: MusicOperation[]; report: LyricAlignmentEntry[]; warnings: string[] }  // §48 lyrics ↔ vocal events (apply via core/edit)
validateLyricAlignment(song, trackId): { ok: boolean; issues: string[] }
generatePlaceholderLyrics(opts): string[]
interpretVocalInstruction(song, trackId, instruction, selection): EditInterpretation & { regenerateRange?: { startTick; endTick } }
interpretMixInstruction(song, instruction): EditInterpretation      // §41 → set_mixer / set_automation
answerQuestion(song, question, selection?): AssistantAnswer          // §44 offline assistant
parseAssetPrompt(prompt): AssetRequest                               // §25 Generate MIDI
```

### 3.4 core/edit

```ts
applyOperations(song, ops: MusicOperation[], opts?: ApplyOptions): { song: Song; report: ValidationReport; applied: number }
   // ApplyOptions: { respectLocks?=true; autoFix?=true; regenerate?: (song, op) => Song; customInstruments? }
validateSong(song, opts?): ValidationReport
validateChange(before, after, opts?): ValidationReport   // locked material unchanged, region honored …
diffSongs(before, after): SongDiff
createProposal(before, ops, meta): Proposal; proposalFromSongs(before, after, meta): Proposal
acceptProposalOnto(proposal, currentSong): { song; conflicts }   // three-way merge: edits made while
rebaseProposal(before, after, current): { song; conflicts }       // the proposal was pending survive
```

### 3.5 core/io

```ts
songToMidi(song, opts?): Uint8Array; trackToMidi(song, trackId): Uint8Array; midiToSong(bytes, opts?): Song
songToMusicXML(song, opts?): string; songToChordSheet(song): string; songToLyricSheet(song): string
songToNotationPdf(song, opts?): Uint8Array
songToDawProject(song, opts?): Uint8Array; songToReaperProject(song, opts?): string
tempoMapCsv(song): string; markersCsv(song): string; audacityLabels(song): string
```

### 3.6 core/project

```ts
packProject(project, assets: Map<string, Uint8Array>): Uint8Array      // .songproject (ZIP)
unpackProject(bytes): { project: Project; assets: Map<string, Uint8Array> }
commitRevision(project, song, message, kind, author?): Project
restoreRevision, createBranch, switchBranch, deleteBranch, renameBranch, headRevision,
compareRevisions(project, aId, bId): SongDiff
mergeSelected(project, fromRevisionId, selection: MergeSelection, message?): Project
undoRevision / redoRevision helpers, addAsset, addProvenance, recordProviderUse
```

### 3.7 core/tasks

```ts
class TaskQueue {
  // §63
  constructor(opts?: {
    concurrency?: number;
    persistence?: TaskPersistence;
    now?: () => string;
    awaitHandlers?: boolean;
  });
  register<I, O>(type: string, handler: TaskHandler<I, O>): void;
  enqueue<I>(spec: {
    type;
    title;
    input: I;
    dependsOn?;
    priority?;
    maxAttempts?;
    providerId?;
    runner?;
  }): TaskRecord;
  cancel(id);
  retry(id);
  pause(id);
  resume(id);
  remove(id);
  get(id);
  list();
  subscribe(listener): () => void;
  restore(): Promise<void>; // resume persisted tasks from their checkpoints
}
TaskHandler = (ctx: {
  input;
  signal: AbortSignal;
  progress(p, msg?);
  log(level, msg);
  checkpoint(data);
  previousCheckpoint?;
  attempt;
}) => Promise<O>;
```

### 3.8 audio/dsp

```ts
class SongRenderer { constructor(song, opts?: RenderOptions); sampleRate; totalFrames; seekSeconds(s); seekFrame(f);
  process(outL, outR, frames?): number; updateSong(song); updateMixer(mixer); getMeters(): Meters }
renderSong(song, opts?): AudioData; renderStems(song, opts?): Record<string, AudioData>; renderTrack(song, trackId, opts?)
PATCHES, patchIdForInstrument(instrumentId | gmProgram)
MASTERING_PRESETS, masterAudio(input, settings: MasteringSettings): { output: AudioData; report }
measureLoudness(buf): LoudnessReport                           // BS.1770 LUFS, true peak, LRA
encodeWav, decodeWav, encodeFlac, mixBuffers, resample, toMono, normalizePeak, spliceWithCrossfade
STOCK_VOICES, synthesizeVocal(song, trackId, opts): AudioData  // formant placeholder / built-in singer
```

### 3.9 audio/analysis

```ts
stft, detectOnsets, detectTempo, detectKey, chromagram, detectChords, trackPitch (YIN),
transcribeMonophonic, transcribePolyphonic, transcribeDrums, separateSources (HPSS + spectral masks),
classifyStem, segmentStructure, transcribedToNotes, rebuildProject(buf, opts): Promise<{ song; report }>
```

### 3.10 ai

Capabilities (§5, §30, §59), `ProviderRegistry`, `CapabilityRouter`, `BUILTIN_PROFILES` (§6),
routing rules (§49), `describeDataFlow` (§50), `BudgetManager` + `estimateCost` (§60),
`buildMusicContext` (§45), structured schemas + `parseOperations` (§46), `CompositionService`
(plan_song / modify_composition / analyze_music / explain_music, §58), `Orchestrator`
(route → privacy confirm → budget → execute → record), `PROVIDER_PRESETS`, transports
(`DirectTransport`, `ServerProxyTransport`), adapters for OpenAI-compatible (OpenAI, OpenRouter,
DeepSeek, Mistral, xAI, Moonshot, Llama API, Together, Groq, LM Studio, vLLM, llama.cpp), Anthropic
(Claude API, Claude in Amazon Bedrock, Claude on Vertex AI — `extra.anthropicPlatform`), Gemini,
Ollama, custom HTTP, ElevenLabs (Music, stem separation, Scribe speech-to-text), Stability Stable
Audio, Google Lyria (Vertex), MiniMax Music, Mureka, AudioShake, LALAL.AI, OpenAI-style
speech-to-text (`/audio/transcriptions`), local music HTTP (ACE-Step, YuE, DiffRhythm, Stable Audio
Open, MusicGen bridges), singing HTTP (DiffSinger bridge), transcription/separation/voice-conversion/
mastering/lyrics HTTP, the instrument plugin host (`plugin-host-http`: VST3, AU, VST2, CLAP, LV2,
SF2, SFZ),
`LOCAL_MODEL_CATALOG` + `classifyCompatibility` (§61-§62). Connecting services:
`detectKeyProvider` (key formats), `probeProvider` (validate a key, list its models),
`groupModels` / `recommendModels` (models → Song Deck uses, best per use), `connectedConfig`,
`detectLocalServices` (Ollama, LM Studio, llama.cpp, vLLM, bridges; loopback only) and
`EncryptedCredentialStore` (behind a `KeyValueBackend`).

### 3.11 apps/studio (runtime wiring)

- `state/store.ts` — the open project, proposals (accepted with `acceptProposalOnto`), revisions,
  branches, undo/redo (shared revisions while collaborating), confirmations, transport.
- `engine/player.ts` + `playback.worker.ts` — live playback: the worker runs `SongRenderer` and
  streams chunks scheduled sample-accurately on an `AudioContext`.
- `engine/jobs.ts` + `jobs.worker.ts` — a worker pool for offline renders, mastering, codecs,
  singing, transcription, separation and Rebuild. `render-instruments.ts` keeps both the player and
  the pool configured with custom instrument profiles and plugin sample sets.
- `engine/runtime.ts` — the task queue (§63; inputs of unfinished tasks persist, so they resume
  after a reload) and local-server status. Task handlers live in `engine/handlers/*`.
- `engine/ai.ts` — the AI runtime: registry, router, budget and orchestrator; internal (on-device)
  providers from `internalProviders.ts`; plugin providers; role helpers used by every mode.
- `engine/credentials.ts` — browser-held keys (encrypted IndexedDB store, memory fallback) used when
  the server vault is not; `views/settings/ConnectService.tsx` — the "Connect a service" flow.
- `engine/plugins.ts` — plugin loading and the plugin API (`docs/PLUGINS.md`).
- `engine/instrument-plugins.ts` + `wam-host.ts` — instrument plugins on MIDI tracks
  (`Track.instrumentPlugin`): hosts (native bridge, in-browser Web Audio Modules), editors, the
  `instrument.render` task that freezes a track into a `plugin-render` asset, and automatic
  re-renders. `@songdeck/core` `trackMidiEvents` / `pluginRenderKey` define the MIDI sent and when a
  render is current; the audio renderer plays a current render instead of the track's patch.
- `engine/collab.ts`, `collab-render.ts` — collaboration client and distributed stem renders.
- `engine/midi-input.ts`, `midi-take.ts` — MIDI keyboard capture into the piano roll (§27).
- `views/*` — one folder per mode (compose, workbench, generate, expand, transcribe, rebuild, produce,
  vocals, mix, export, settings) plus shell and shared components.

### 3.12 apps/server

CLI `apps/server/src/cli.ts`; modules: `vault/` (OS keychain, encrypted-file fallback), `proxy.ts`
(provider proxy with allowlist and credential injection), `hardware.ts`, `models.ts` (model
manager), `render/` (render node: worker-thread pool), `collab/` (WebSocket rooms, persisted
revisions, comments, chat), `plugins.ts` (manifest validation and file serving), `managed.ts`
(the "Automatic" gateway), `local-services.ts` (local service detection, key validation for the
connect flow), `projects.ts`, `static.ts` (serves the built studio). Security model
and endpoints: `apps/server/README.md`.
