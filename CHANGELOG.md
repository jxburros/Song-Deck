# Changelog

All notable changes to Song Deck are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
