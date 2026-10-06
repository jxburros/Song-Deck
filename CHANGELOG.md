# Changelog

All notable changes to Song Deck are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **MIDI from any audio track, attached to it.** **Make MIDI from audio** (an audio track's menu, the
  piano roll or its track details) turns the track's recording into editable notes that sit exactly
  under the audio. An **Audio / MIDI** switch (in Write and Sound) chooses what plays: the recording,
  or the notes through any instrument. Edit the notes in the piano roll, with words, or copy them to a
  new MIDI track; they are included in MIDI exports. Melody, chords and drums are supported, on-device
  or with a connected transcription service.
- **Tune the audio to the MIDI (pitch correction).** For a sung or played single line, the recording is
  pitch-corrected to follow its MIDI: edit a note's pitch and the audio under it moves there. Correction,
  Flatten (drift and vibrato) and Retune speed controls, with Natural and Hard tune presets. The tuned
  recording is rendered on-device, plays in every step and export, and updates automatically after edits.

- **Instrument plugins like a DAW.** Any MIDI track can be played by an installed **VST3, Audio
  Unit, VST2, CLAP, LV2, SoundFont (SF2/SF3) or SFZ** instrument through the new local plugin host
  bridge (`bridges/plugin_host_bridge.py`), or by a **Web Audio Module (WAM 2)** running in the
  browser. Choose the plugin in the track inspector, edit it in its own editor (state is saved in the
  project), set parameters and presets, bypass or remove it. The track is rendered through the plugin
  and frozen to audio that playback, stems, mastering and every export use; after edits the built-in
  sound plays until the automatic re-render. Settings → Plugins → Instrument plugins lists hosts,
  formats and installed plugins, and manages WAM module URLs.
- **Lyrics transcription.** Audio to MIDI can also transcribe the sung words (Singing, Isolated,
  Full mix): each word becomes syllables on the notes sung under it and the lines become the song's
  lyrics. Engines: a local Whisper bridge (`bridges/whisper_bridge.py`, faster-whisper/WhisperX),
  OpenAI (`whisper-1`, `gpt-4o-transcribe`), Groq Whisper, ElevenLabs Scribe and any OpenAI-style
  speech-to-text server.
- **New AI services:** OpenRouter, DeepSeek, Mistral and xAI (Grok) language models; Claude in
  **Amazon Bedrock** and on **Google Cloud Vertex AI**; **MiniMax Music** and **Mureka** full songs
  with vocals; cloud stem separation with **ElevenLabs**, **AudioShake** and **LALAL.AI**.
- **New local music models:** YuE, DiffRhythm, Stable Audio Open and MusicGen bridges (music bridge
  contract) with presets and Model Manager entries.
- Mock bridge roles `lyrics` (8816) and `instruments` (8817) for testing without models.

### Changed

- Pasting an OpenRouter (`sk-or-v1-…`) or xAI (`xai-…`) key connects it directly; DeepSeek and
  Mistral keys are offered as candidates.
- The server proxy can fetch generated files from a provider's declared download hosts (credential-free
  HTTPS GET only), for services that return signed result URLs.
- A provider that returns single stems (or "instrumental") no longer doubles audio in Rebuild: a
  missing "other" stem is derived from what remains of the mix.

## [0.4.0] - 2026-10-05

### Changed

- **Redesigned studio.** Four areas on a left rail (a bottom bar on phones): Songs, Single Track,
  Library and Settings. An open song has three steps — Write, Sound and Export — plus **More tools**,
  a grouped, searchable list of every detailed editor (pattern, chords, structure, theory, macros,
  locks, vocals, production, mixing console, automation, mastering, history, variations, inspector,
  assistant). The top bar, status bar and project timeline are replaced by a song header and a player
  bar with a keyboard-accessible seek control.
- **Start a song** in two steps. **Material**: lyrics, audio (uploaded or recorded live), MIDI and,
  with a text model connected, a prompt — any combination. **Shape**: starting points, genre blend,
  moods, tags, instruments, song settings, feel and advanced options on one screen. A song needs some
  material and at least one basic (style, mood, instrument, tempo, key or length); detected values
  count. **Start from style settings** skips material, so a starting point alone makes a song.
  Rebuild and Expand are reachable from the Material step.
- **With vocals or Instrumental** is the first choice when starting a song. Instrumental hides every
  lyrics option and guarantees no vocal; With vocals guarantees a lead vocal, even for genres that are
  usually instrumental.
- **Write** pairs the arrangement with a single Change panel (changes in words, pending proposals,
  regenerate, lock, edit notes, save to Library); track actions live in each track's menu.
- **Sound** gathers instruments, levels, mute and solo, built-in versus AI audio versions, and one
  Polish for release switch. **Export** offers five one-click exports (song, stems, MIDI, project
  backup, Save to Library) with every other format under More formats.
- **Single Track** offers Audio to MIDI, Generate MIDI and Generate audio, and any result can start a
  song. **Library** has kind filters, previews and Start a song / Add to this song actions.
- **Settings** lead with AI services, Privacy and spending (budget joined to privacy) and General;
  routing, models, render nodes, plugins and collaboration sit under Advanced. Deep links keep working.
- Geometric visual language throughout: cut corners, lit brackets, slanted chips and tabs, diamonds,
  measure-grid page bands and zero corner radii (see `docs/BRAND.md`).
- An offline marker on the rail replaces the status bar's offline notice.

### Fixed

- Provider redirects now strip client authentication headers when they leave the original origin or
  credential scope, reject embedded credentials, and remove vault keys hidden behind duplicate query
  parameters.
- Project imports inspect ZIP expansion size and entry counts before decompression, rejecting archives
  over 1 GiB expanded or 10,000 entries instead of exhausting browser memory.
- Static hosting applies the same real-path containment checks to SPA fallback pages as to direct
  file requests.
- Produced stems and full mixes remain audible when their source tracks are soloed. Switching full-mix
  candidates no longer changes a previous revision's mute-restoration list.
- Sound exposes produced audio tracks for level, mute and solo adjustments, displays the actual minimum
  level (-40 dB), and prevents duplicate generation while a production task is active. Progress and
  failures remain visible after navigating away and back.
- Audio-model selection checks the song's vocal requirements, including when a previous audio version
  has muted the original MIDI tracks.

### Maintenance

- Upgrade Vitest and its coverage provider to 4.1.11 to resolve GHSA-82fw-gwwq-j7x9. CI audits runtime
  and development dependencies for moderate-or-higher vulnerabilities.
- Browser tests can use an installed Chromium through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when the
  Playwright-managed browser is unavailable.

### Removed

- The unused “Show theory hints in the workbench” setting.

## [0.3.0] - 2026-10-04

### Added

- **Library and Single Track workflows.** Save reusable tracks, collections, audio and files across
  projects; create or transcribe individual tracks separately from composing a full song.
- **Flexible Compose inputs.** Start a song with any combination of prompts, lyrics, imported audio,
  MIDI and saved library assets, with a persistent project timeline.
- **Expand MIDI.** Import MIDI, use an open project's MIDI, or transcribe a short audio clip;
  label source bar ranges (including overlapping hooks), arrange preserved and developed sections,
  adjust phrase variation and seed, preview, download MIDI, or open a new project. Source-conditioned
  melodic motifs and percussion grids carry the clip's identity into new sections.
- Research notes on genre/tag semantics, mood, music theory, controlled variation, transcription
  uncertainty and musical evaluation in `docs/MIDI-RESEARCH.md`.

### Fixed

- Genre blend shares now normalize progression and form-template pools before weighting;
  catalog size and arbitrary weight magnitudes no longer dominate the requested blend.
- A section's mood no longer changes global harmonic coloring in other section groups.

### Changed

- Refreshed studio identity with an obsidian and ice palette, updated typography and clearer navigation.
- Deterministic composition engine version is now 1.1.0. Existing saved MIDI is unchanged;
  regenerating with an old seed can differ because planner probability handling has improved.

## [0.2.0] - 2026-10-03

Upgrade from v0.1.0 by downloading and unpacking this release, then start the new server at the
same address and port. This installs the launcher needed for future in-app updates. Your browser
projects and the server's existing data directory remain in place. Update controls are under
**Settings → General → App updates**; automatic updates are optional and off by default.

### Added

- **In-app updates.** Settings → General now checks stable GitHub releases, verifies and downloads
  updates, and offers a restart when ready. Optional automatic updates check at startup and every
  six hours, applying on next start without interrupting a session. The launcher preserves the
  previous version and rolls back when an update cannot start. Private releases use a server-side token.

- **Compose builder.** Compose starts with a builder instead of a prompt box: pick instruments and
  how many of each, genres with how much influence, moods (whole song or one section), style, era
  and production tags, and settings such as tempo feel, key, length, structure and vocal. It works
  fully offline. With an AI model attached you can also describe the song in your own words; your
  picks stay fixed. "Generate song" goes straight to an editable MIDI composition; "Fine-tune
  first" keeps the blueprint and plan editors, which now edit tags too.
- **Start from lyrics.** Paste a song, with or without `[Verse]`/`[Chorus]` headers, and Song Deck
  finds the sections (repeated stanzas become the chorus), builds the structure around them, sings
  your words with stressed syllables on strong beats, locks them and credits you as lyric writer.
- **38 new genres (57 in all)**, from funk, reggaeton, bossa nova and amapiano to drum and bass,
  phonk, bluegrass and Bollywood, with 29 new drum grooves, world-percussion families, bass and
  comping idioms, and 12 new instruments with their own sounds (nylon guitar, banjo, mandolin,
  pedal steel, sitar, clavinet, accordion, harmonica, steel pan, log drum, 808 bass, chip lead).
- **487 tags** (style, mood, era, production, vocal, region, rhythm) that nudge a genre blend and
  carry through composition, regeneration, variations and saved projects. Every tag is tested to
  change the music. [`docs/GENRES.md`](docs/GENRES.md) lists them and is generated from the code.
- **Connect a service.** Paste an API key: Song Deck recognises the provider, checks the key, lists
  the models you can use grouped by what they do here and pre-ticks the best ones. Works for the
  language-model providers and for ElevenLabs, Stability AI and Lyria (through a Gemini key).
- **Found on this machine.** Running Ollama, LM Studio, llama.cpp, vLLM and Song Deck bridges are
  detected and added with one click.
- **Rights attestations for uploaded audio.** Every audio upload asks whether you made it, licensed
  it, it is public domain or open-licensed, or it is for personal study. The answer is stored with
  the project, shown in the Inspector and summarised in exports. Nothing is blocked.
- **Offline copyright-tag check.** Uploads carrying ISRCs, copyright or label tags, or store
  purchase markers are flagged as likely commercial releases.
- **Optional AcoustID identification** (off by default; free for non-commercial use with your own
  key). Only an on-device Chromaprint fingerprint and the duration are sent.
- **Visual identity:** a new logo, favicon, app icons and web manifest; a pink, blue, yellow and
  gray palette (pink for actions, blue for AI, yellow for locks and warnings) with WCAG AA
  contrast enforced by a test; Inter and JetBrains Mono bundled for offline use.
  See [`docs/BRAND.md`](docs/BRAND.md).
- **Continuous integration:** lint (ESLint, Prettier, Ruff), typecheck, tests on Node 20.19, 22
  and 24 with coverage, server tests on macOS and Windows, a bundle-size budget, a production
  dependency audit, Playwright end-to-end and axe accessibility tests, CodeQL, dependency review
  and Dependabot.

### Changed

- Without the local server, API keys are stored encrypted in the browser and survive reloads; they
  can be moved into the server vault or forgotten. See [`docs/CREDENTIALS.md`](docs/CREDENTIALS.md).
- Cloud requests that would send audio marked for personal study, or flagged by the rights checks,
  always ask for confirmation first.
- The prompt parser understands every genre and tag; "brushed drums", plain "bass" and mood words
  such as "warm" now come out right.
- Faster first load: the main script is about 340 KB (was 1.49 MB).
- The top bar and the Mix, Produce and Settings pages work on phones and tablets.
- Track colours come from one brand palette that reads in both themes.

### Fixed

- The Theory view no longer states the same fact twice within a section.
- Level meters, lyric syllable gutters and the spinner have valid accessibility roles.

## [0.1.0] - 2026-10-03

The first release of Song Deck. It implements all five delivery phases of the specification
(`Song Deck.md` §66–§70); [`docs/PHASES.md`](docs/PHASES.md) maps every item to its code and tests.
With no AI provider configured, the built-in deterministic engine does everything offline except
voice conversion.

### Composition and MIDI workbench (phase 1)

- Prompt → editable Song Blueprint → composition plan → seeded, reproducible MIDI song, with
  19 genre profiles, 37 instrument profiles and generators for drums, bass, chords, guitar, lead,
  synth, percussion and vocal melody.
- Deterministic theory engine: scales and modes, chord spelling, roman numerals (secondary and
  borrowed chords), voice leading, cadence and tension analysis.
- Workbench with arrangement, piano roll, pattern, chord, structure and theory views; instrument
  tracks; song, track, section, note and lyric locks that are guaranteed unchanged.
- Regenerate unlocked material, single tracks or sections, and four variation depths.
- AI and theory edits arrive as proposals with a note diff and validation report (accept, reject
  or modify); accepting merges onto edits made while the proposal was pending.
- Generate MIDI mode: alternatives from a prompt, each with notation, audio preview and `.mid` export.
- In-browser playback through a pure-TypeScript synthesizer in a Web Worker; MIDI keyboard recording.
- AI providers by capability: OpenAI-compatible endpoints, Anthropic, Google Gemini, Moonshot/Kimi,
  Meta Llama API, Together, Groq, Ollama, llama.cpp, LM Studio, vLLM and custom HTTP.

### Audio understanding (phase 2)

- Audio-to-MIDI for monophonic, polyphonic and drum recordings, with tempo and key detection.
- Hum, sing, whistle, clap or tap ideas into MIDI from the microphone, an upload or the keyboard.
- On-device source separation into drums, bass, vocals and other; chord detection.
- Rebuild mode turns a mixed recording into an editable song with confidences, and keeps the stems
  for A/B comparison.
- Per-section theory explanations, and theory controls that produce proposals.
- Custom genre and instrument profiles (editor, JSON import/export, plugins), saved inside the
  projects that use them.

### Production (phase 3)

- Guide renders (`guide_mix.wav` plus reference stems) with built-in or sampled instruments, or
  round-tripped through an external DAW.
- Audio-generation providers chosen by capability: ElevenLabs Music, Stable Audio, Lyria, local
  engines through HTTP bridges (ACE-Step), and the managed "Automatic" gateway.
- Stem-by-stem production as resumable tasks; editable production prompts derived from the song.
- A/B candidates of the same revision with level matching, ratings and adoption into the mix;
  regenerate any bar range with everything outside it bit-identical.
- Cost, duration and hardware estimates before every run, consent before data leaves the device,
  and provenance for every generated asset.

### Vocals (phase 4)

- Lead vocal melody as its own MIDI track, composed against the harmony and lyric syllables.
- Lyric editor with syllable counts and phonemes; align syllables to notes or fit the rhythm to the lyrics.
- Built-in formant singer with six stock voices, plus singing-synthesis providers (DiffSinger bridge).
- Vocal expression (breathiness, tension, vibrato, energy, onset, release) per song, phrase or selection.
- Re-sing only the phrase or section an instruction changed, spliced into the current render.
- Voice models (trained, imported, third-party) require a rights attestation before use.
- Record takes over the song with count-in and latency compensation, and transcribe a take back into MIDI.

### Professional workflow (phase 5)

- Mix & Master: channel strips with EQ, compression, sends, width and drive; automation lanes;
  an AI mix assistant whose suggestions are proposals.
- Mastering to six loudness targets with EBU R128 analysis and true-peak limiting.
- Export: multitrack MIDI, MusicXML, PDF score, WAV/FLAC/MP3 (and AAC where the browser can encode
  it), stems, DAWproject, Reaper projects, markers and `.songproject` packages.
- Real-time collaboration through the local server: shared projects, presence, section comments,
  chat, offline outbox, and concurrent edits forked into branches.
- Version history with compare, restore, branch, duplicate and selective merge; branch templates
  that keep the Song DNA.
- Plugins: genre profiles, instruments (including SFZ sampled instruments), exporters and AI
  providers, enabled per user. Three examples are included.
- Render nodes: any Song Deck server can render stems for others; renders are deterministic, so
  distributed output equals a local render.

### Platform

- Local server (`apps/server`): OS-keychain or encrypted-file credential vault, provider proxy,
  hardware detection and local model manager, collaboration, plugin host, render node, and the
  managed AI gateway. API keys never enter project files.
- Release downloads: the studio and a bundled server that runs on Node.js alone, plus a
  studio-only build for static hosting. A release workflow builds, tests and publishes them for
  every version tag.

### Known limitations

- No neural models ship with Song Deck. Separation is classical DSP (audible bleed), the built-in
  producer renders the composition with effects, so candidates differ in performance rather than
  interpretation, and the built-in singer sounds synthetic. Natural generation, singing and voice
  conversion need a cloud provider or a local model behind a bridge.
- The cloud audio adapters and model bridges are tested against mock services, not live ones.
- Polyphonic transcription misses octave doublings and dense voicings; tempo is a single value;
  key detection distinguishes major and minor only.
- Lyrics use English rules and a small dictionary.
- Plugins run with the studio's rights once enabled; there is no sandbox beyond the trust prompt.
- On a server reachable from other machines, only collaboration and render nodes send its token.
