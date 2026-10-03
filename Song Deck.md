# Structured AI Music Studio
## Comprehensive Product Specification

**Working description:**  
A model-agnostic AI music composition, MIDI generation, transcription, arrangement, vocal synthesis, and production environment built around an editable symbolic representation of music.

**Core philosophy:**  
> AI that gives you the song back.

Traditional generative-music systems generally make an audio recording from a prompt. Structured AI Music Studio instead creates the **composition first**—structure, harmony, melodies, rhythms, instrumentation, MIDI, lyrics, and musical metadata—and treats generated audio as a rendering of that underlying composition.

The user therefore owns something they can inspect, edit, export, regenerate, rearrange, re-orchestrate, and reproduce.

---

# 1. Product Vision

The application bridges three existing categories:

1. **DAWs and MIDI sequencers**
2. **Generative AI music systems**
3. **AI assistants and composition tools**

It should provide much of the creative accessibility of an AI song generator without requiring the user to surrender control of the underlying composition.

The central workflow is:

**Creative Intent → Song Blueprint → MIDI Composition → Arrangement → Guide Render → AI Production → Finished Recording**

The production layer is downstream from the composition rather than being responsible for inventing the composition itself.

---

# 2. Design Principles

## 2.1 Composition before rendering

The canonical version of a song is its structured project data—not its generated WAV file.

The project contains:

- key
- tempo
- meter
- sections
- chords
- melodies
- rhythms
- MIDI events
- instrument assignments
- motifs
- dynamics
- lyrics
- vocal melody
- production instructions
- model configuration
- generation seeds
- version history

Audio is generated from this information.

---

## 2.2 Provider independence

No core feature should depend permanently upon a single AI provider.

The application must support interchangeable providers for:

- reasoning
- composition
- MIDI transformation
- lyrics
- audio understanding
- music transcription
- source separation
- singing synthesis
- voice conversion
- music generation
- audio-to-audio production
- mixing
- mastering

Users may combine providers within one project.

Example:

**Composition Planner:** Anthropic  
**Harmony Assistant:** local Llama  
**MIDI Editor:** OpenAI  
**Audio Analysis:** Gemini  
**Singing Voice:** local DiffSinger  
**Production:** Stable Audio  
**Mastering:** local DSP pipeline

The project should remain usable if any provider disappears.

---

# 3. Supported AI Provider Classes

## 3.1 Cloud language/reasoning providers

Initial first-party adapters should target:

- OpenAI
- Anthropic
- Google Gemini
- Moonshot AI
- Meta/Llama-compatible hosted services

Additional providers should be installable later.

The application should not hard-code model names into its architecture. Instead, each provider reports available models and their capabilities.

For example:

```text
provider:
    id: google
    name: Google Gemini

model:
    id: <provider model id>

capabilities:
    text_input
    structured_output
    tool_calling
    audio_input
    long_context
```

Google's current Gemini API, for example, exposes both general reasoning models and specialized audio/music capabilities, including Lyria music-generation models, illustrating why capability discovery should be dynamic rather than tied to static model names.

---

# 4. Local AI Support

Local operation should be a first-class feature.

## 4.1 Supported local interfaces

The application should support providers through standardized adapters such as:

- OpenAI-compatible API
- Ollama-compatible API
- llama.cpp-compatible server
- LM Studio-compatible server
- vLLM-compatible endpoint
- custom HTTP endpoint
- application-specific local runtime adapter
- direct embedded inference where practical

A custom endpoint configuration should allow:

```text
Name
Endpoint URL
Authentication
Model ID
Context Length
Capabilities
Structured Output Support
Timeout
Concurrency
```

This means users can connect virtually any sufficiently compatible local model without waiting for an official app update.

---

# 5. Provider Capability Registry

Provider selection should be based on **capabilities**, not vendor names.

Example capability taxonomy:

```text
TEXT_REASONING
STRUCTURED_JSON
MUSIC_THEORY_REASONING
MIDI_GENERATION
MIDI_EDITING
LYRIC_GENERATION
AUDIO_UNDERSTANDING
AUDIO_TRANSCRIPTION
SOURCE_SEPARATION
PITCH_TRACKING
AUDIO_TO_MIDI
TEXT_TO_MUSIC
AUDIO_TO_AUDIO
SINGING_SYNTHESIS
VOICE_CONVERSION
VOCAL_ISOLATION
MIXING
MASTERING
STEM_GENERATION
```

Providers advertise what they can do.

A workflow requests a capability.

The orchestration system selects the configured provider capable of fulfilling it.

---

# 6. Provider Profiles

Users should be able to create profiles such as:

### Cloud Quality

Composition — OpenAI  
Music analysis — Gemini  
Production — managed music model  
Vocals — managed singing model

### Local Only

Composition — local Llama  
MIDI — internal deterministic engine  
Transcription — local model  
Vocals — DiffSinger  
Production — local music model

### Cheap Draft

Composition — inexpensive cloud model  
Production — local generator  
Vocals — disabled

### Final Production

Composition — high-reasoning model  
Production — premium cloud generator  
Vocals — high-quality singing synthesizer

Projects should record which provider produced each artifact without requiring the project to continue using that provider.

---

# 7. Bring Your Own API Key

Users should be able to configure their own credentials.

Supported configuration:

- API key
- OAuth where supported
- custom base URL
- organization/project ID
- region
- model
- request limits
- budget limits

Credentials must be stored securely using the host operating system's secure credential facility where possible.

API keys should never be stored inside portable project files.

---

# 8. Managed AI Option

The application may optionally offer its own managed AI service.

This would allow users to simply select:

> Automatic

instead of configuring providers.

The service could route tasks between models based on:

- quality
- cost
- latency
- availability
- task type
- user's privacy settings

This creates two parallel usage models:

**Managed Mode**
> The application handles the AI infrastructure.

**Bring Your Own AI**
> The user controls the infrastructure.

**Local Mode**
> Nothing must leave the user's machine.

---

# 9. Song Project Architecture

Every song exists as a structured project.

Example:

```text
song.project
│
├── project.json
├── song.json
├── lyrics/
├── midi/
├── motifs/
├── audio/
│   ├── references/
│   ├── guide-renders/
│   ├── generations/
│   ├── vocals/
│   └── masters/
├── stems/
├── analysis/
├── generations/
└── history/
```

A portable project could use a custom extension such as:

```text
.songproject
```

internally implemented as a ZIP-based package.

---

# 10. Song Blueprint

Every composition begins with a Song Blueprint.

Example:

```text
Title: Untitled

Tempo: 164 BPM
Meter: 4/4
Key: E minor

Style:
Emo
Pop-punk
Alternative rock

Mood:
Melancholy verses
Cathartic chorus
Defiant ending

Instrumentation:
Lead Vocal
Drums
Bass
Rhythm Guitar L
Rhythm Guitar R
Lead Guitar
Violin
Piano

Structure:
Intro        4 bars
Verse 1      8 bars
Pre-Chorus   4 bars
Chorus       8 bars
Verse 2      8 bars
Pre-Chorus   4 bars
Chorus       8 bars
Bridge       8 bars
Final Chorus 16 bars
Outro        4 bars
```

---

# 11. Song DNA

The application should expose a higher-level representation called **Song DNA**.

Song DNA describes recognizable characteristics that can survive regeneration.

Examples:

- harmonic language
- principal chord movement
- core motifs
- rhythmic identity
- melodic contour
- instrumentation
- structural proportions
- energy curve
- repetition patterns
- tempo
- meter
- tonal center

Example:

```text
Motif A:
Verse vocal motif

Motif B:
Chorus guitar hook

Motif C:
Violin answering phrase

Energy:
30 → 45 → 70 → 92 → 55 → 75 → 96 → 65 → 100
```

Song DNA allows the system to generate related versions rather than unrelated songs.

---

# 12. Composition Engine

The Composition Engine converts creative intent into symbolic music.

It combines:

### Deterministic music theory

with

### AI reasoning

with

### controlled randomness

This separation is important.

The AI should decide **what musical behavior is appropriate**.

A deterministic engine should ensure the generated representation is technically coherent.

---

# 13. Theory Engine

The built-in engine should understand:

- keys
- scales
- modes
- functional harmony
- modal harmony
- borrowed chords
- secondary dominants
- inversions
- extensions
- suspensions
- voice leading
- cadences
- modulation
- tension/release
- meter
- subdivisions
- syncopation
- swing
- tuplets
- rhythmic motifs
- melodic contour
- instrument range
- playable voicing
- orchestration density

Genre-specific rules should be layered on top.

---

# 14. Genre Profiles

Genres should be represented as editable rule profiles rather than simple text labels.

A profile could contain:

```text
Typical BPM range
Common meters
Preferred harmonic vocabulary
Typical song structure
Instrument roles
Rhythmic tendencies
Dynamic behavior
Arrangement conventions
Production expectations
```

Examples:

- pop
- synth-pop
- punk
- pop-punk
- emo
- indie rock
- metal
- folk
- country
- EDM
- house
- trance
- jazz
- R&B
- hip-hop
- orchestral
- cinematic

Profiles may be blended.

Example:

> 50% pop-punk  
> 30% emo  
> 20% cinematic

---

# 15. Composition Planning

The AI Composition Planner should first produce an abstract plan rather than MIDI.

Example:

| Section | Bars | Harmony | Energy | Purpose |
|---|---:|---|---:|---|
| Intro | 4 | Em–C | 35 | Establish motif |
| Verse | 8 | Em–C–G–D | 45 | Restrained |
| Pre | 4 | C–D–Em–D | 65 | Rising tension |
| Chorus | 8 | G–D–Em–C | 90 | Emotional release |
| Bridge | 8 | C–Em–D | 70→95 | Build |
| Final Chorus | 16 | G–D–Em–C | 100 | Maximum release |

All MIDI generators consume the same blueprint.

---

# 16. Instrument Role Generators

Individual track generators create MIDI within the shared musical context.

Initial roles:

### Drums

Understands:

- groove
- fills
- kick/snare relationships
- cymbal patterns
- transitions
- genre-specific playing styles

### Bass

Understands:

- chord roots
- passing tones
- rhythmic locking with kick
- melodic bass movement
- instrument range

### Rhythm Guitar

Understands:

- chord voicings
- strumming
- palm muting
- power chords
- rhythmic accents

### Lead Guitar

Understands:

- riffs
- hooks
- counter-melodies
- solos

### Piano / Keys

Understands:

- voicing
- accompaniment
- arpeggiation
- melodic fills

### Strings

Understands:

- legato
- counterpoint
- harmony
- orchestral voicing
- swells
- articulation

### Synthesizers

Understands:

- pads
- arpeggiators
- leads
- rhythmic sequences

### Vocal Melody

Understands:

- vocal range
- phrase length
- lyric syllables
- breathing
- repetition
- melodic hooks

---

# 17. Instrument Constraints

Users may define:

```text
Instrument:
Violin

Lowest note:
G3

Highest note:
E7

Complexity:
Medium

Role:
Counter-melody

Sections:
Chorus
Bridge
Final Chorus

Avoid:
Continuous doubling of vocal melody
```

Instrument definitions should eventually support custom profiles.

---

# 18. MIDI Workbench

Generated MIDI appears in a simplified DAW-style editor.

Views:

### Arrangement View

Tracks across the song timeline.

### Piano Roll

Traditional detailed MIDI editing.

### Pattern View

Loop and phrase editing.

### Chord View

Harmony and chord manipulation.

### Structure View

Song sections.

### Theory View

Musical explanation.

---

# 19. Macro Controls

Non-musicians should be able to modify musical behavior without editing notes.

Example controls:

**Complexity**  
Simple ↔ Complex

**Energy**  
Calm ↔ Aggressive

**Density**  
Sparse ↔ Busy

**Humanization**  
Mechanical ↔ Loose

**Melodic Movement**  
Static ↔ Active

**Harmonic Tension**  
Stable ↔ Dissonant

**Repetition**  
Predictable ↔ Varied

**Syncopation**  
Straight ↔ Syncopated

**Dynamics**  
Flat ↔ Expressive

---

# 20. AI MIDI Editing

Any MIDI selection can be changed through natural language.

Examples:

> Make the bass busier.

> Make this melody sadder.

> Simplify the drums.

> Change this to half-time.

> Add tension over these four bars.

> Make the violin answer the vocal rather than double it.

> Keep the rhythm but change the pitches.

> Turn these chords into something more harmonically ambiguous.

The output remains MIDI.

---

# 21. Proposed Change System

AI MIDI edits should not immediately destroy existing data.

Workflow:

**Current MIDI**

↓

**AI Proposal**

↓

Visual note diff

↓

**Accept / Reject / Modify**

This permits experimental editing without sacrificing user control.

---

# 22. Locking System

Every component should be lockable.

Example:

```text
SONG

Tempo            🔒
Key              🔒
Structure        🔒
Chords           🔒

DRUMS

Verse            🔒
Chorus           🔒
Bridge            🔓

BASS              🔓
VIOLIN            🔒
VOCAL MELODY      🔒
```

Command:

> Regenerate unlocked material.

Only unlocked components change.

This behavior should be guaranteed at the symbolic composition layer.

---

# 23. Generation Seeds

Every generative operation should optionally use a reproducible seed.

Example:

```text
Composition Seed:
882914

Variation:
20%
```

Identical:

- blueprint
- constraints
- provider configuration
- seed
- generation-engine version

should produce the same symbolic generation wherever deterministic execution is possible.

---

# 24. Variation System

Users should be able to request degrees of mutation.

### Ornament

Change:

- fills
- ornamentation
- velocity
- articulations

Preserve almost everything else.

### Variation

Preserve:

- harmony
- motifs
- structure

Change accompaniment details.

### Reinterpretation

Preserve:

- main melody
- recognizable motifs
- broad structure

Allow substantially different arrangement.

### Mutation

Preserve only Song DNA.

This enables musical families rather than unrelated generations.

---

# 25. Primary Application Modes

## Compose

Generate an entire structured song.

**Prompt → Blueprint → MIDI → Arrangement → Production**

---

## Generate MIDI

Create individual musical assets.

Examples:

> Create a melancholy 16-bar cello melody in D minor.

> Make a pop-punk drum pattern at 176 BPM.

> Generate four alternative bass lines for this progression.

Output:

- MIDI
- notation preview
- audio preview

---

## Transcribe

Convert audio into symbolic music.

Supported sources:

- humming
- singing
- guitar
- bass
- piano
- drums
- isolated instruments
- full mixes

---

## Rebuild

Attempt to reconstruct an existing recording as an editable project.

Pipeline:

**Audio**

↓

Source separation

↓

Tempo / beat detection

↓

Key detection

↓

Chord analysis

↓

Pitch transcription

↓

Instrument classification

↓

MIDI reconstruction

↓

Song structure reconstruction

↓

Editable project

The interface should clearly communicate confidence when transcription is uncertain.

---

# 26. Audio-to-MIDI Pipeline

Polyphonic material should support:

```text
Input Audio
     ↓
Source Separation
     ↓
Stem Classification
     ↓
Pitch / Rhythm Detection
     ↓
Quantization
     ↓
Instrument-Aware Correction
     ↓
MIDI
```

Example:

```text
song.wav

→ drums.mid
→ bass.mid
→ guitar.mid
→ piano.mid
→ vocal-melody.mid
```

---

# 27. Human Performance Capture

Users should also be able to:

- hum a melody
- sing a bass line
- tap a rhythm
- clap a drum pattern
- play an instrument
- upload a rough voice memo

and convert that performance into MIDI.

This allows AI to refine a human idea rather than inventing one.

---

# 28. Guide Rendering

Before generative audio production, MIDI should be rendered into a reference track.

Possible renderers:

- General MIDI soundfont
- built-in instrument library
- user VST instruments
- user soundfonts
- external DAW rendering
- plugin-based instruments

Output:

```text
guide_mix.wav
```

and optionally:

```text
drums_reference.wav
bass_reference.wav
guitar_reference.wav
strings_reference.wav
vocal_melody_reference.wav
```

---

# 29. Production Engine

The Production Engine converts the structured composition into polished audio.

Its conceptual instruction is:

> Perform and produce this composition.

rather than:

> Invent a song resembling this prompt.

Inputs may include:

- guide audio
- stems
- MIDI
- lyrics
- vocal melody
- BPM
- key
- meter
- section markers
- genre
- instrument list
- dynamics
- production instructions
- reference audio where permitted

---

# 30. Production Providers

Production must use the same provider-adapter philosophy as composition.

Provider capabilities may include:

```text
TEXT_TO_MUSIC
AUDIO_TO_AUDIO
REFERENCE_AUDIO
STEM_CONDITIONING
LYRIC_CONDITIONING
VOCAL_GENERATION
INSTRUMENTAL_ONLY
SECTION_GENERATION
INPAINTING
OUTPAINTING
STEM_OUTPUT
```

Managed and local models may coexist.

Examples of currently relevant technologies include Google's Lyria family, ElevenLabs Music, Stability AI's Stable Audio platform, and open/local systems such as ACE-Step. Google's current API exposes Lyria music-generation endpoints; ElevenLabs' Music v2 API supports composition plans; Stability exposes audio-to-audio music generation; and ACE-Step is designed for local music generation.

These are integrations, not dependencies.

---

# 31. Local Production Models

Local audio models should be loaded through a separate runtime abstraction.

Example:

```text
AudioModelProvider

discover_models()
get_capabilities()
generate()
transform_audio()
continue_audio()
inpaint()
cancel()
```

The UI should expose hardware requirements before generation.

Example:

```text
ACE-Step
Local

VRAM Requirement: ~4 GB+
Generation Type:
Music

Audio Conditioning:
Supported

Lyrics:
Supported

Estimated Compatibility:
Excellent
```

ACE-Step 1.5 specifically advertises local operation on under 4 GB VRAM, making consumer-device local generation increasingly practical.

---

# 32. Vocal Architecture

Vocals should be treated as an independent subsystem.

Do not assume that the music-production model must generate the singer.

This permits substantially greater control.

---

# 33. Vocal Modes

### No Vocal

Instrumental only.

### Vocal Melody Only

Generate:

```text
vocal.mid
```

### Placeholder Vocal

Create a temporary synthesized vocal for arranging.

### AI Singer

Generate finished singing from:

- lyrics
- vocal MIDI
- phonemes
- expression
- dynamics

### User Voice Conversion

Render a neutral singing performance and transform it into an authorized target voice.

### Recorded Vocal

User records their own performance.

---

# 34. Dedicated Singing Synthesis

The provider system should have a dedicated:

```text
SINGING_SYNTHESIS
```

capability.

Input:

```text
Lyrics
Phonemes
MIDI melody
Tempo
Expression
Voice
Dynamics
```

Output:

```text
lead_vocal.wav
```

This makes dedicated singing models usable independently of full-song generators.

Open-source DiffSinger is an important example: its singing pipeline explicitly supports lyric + MIDI input for singing-voice synthesis. OpenVPI's maintained implementation additionally exposes controls for characteristics including pitch, energy, and breathiness.

That fits the application architecture extremely well.

---

# 35. Vocal Expression Data

The song format should support vocal metadata beyond notes.

Example:

```text
note:
    pitch: A4
    lyric: "fire"
    velocity: 88

expression:
    breathiness: .22
    tension: .61
    vibrato: .35
    onset: soft
    release: falling
```

Not every provider must support every parameter.

Unsupported parameters can simply be ignored.

---

# 36. Voice Safety and Consent

The application should distinguish:

- stock synthetic voices
- user-trained voices
- imported voice models
- third-party voices

Voice cloning workflows should require confirmation that the user has authorization to use the target voice.

The project should retain voice provenance metadata.

---

# 37. Independent Vocal Regeneration

Vocals should be regeneratable without regenerating instrumentation.

Examples:

> Make the final line more aggressive.

> Add vibrato here.

> Sing this note more softly.

> Change the melody on the word "fire."

> Regenerate only the second chorus vocal.

This is one of the reasons vocals should remain separated from full-song production whenever possible.

---

# 38. Production Strategies

The application should support several strategies.

## Strategy A — Full Generation

Guide mix → generative music model → finished song.

Fastest.

Least precise.

---

## Strategy B — Stem Production

Each instrument reference is separately transformed.

Example:

```text
guitar MIDI → guitar reference → produced guitar
bass MIDI → bass reference → produced bass
drums MIDI → drum reference → produced drums
```

Then mixed together.

Much more controllable.

---

## Strategy C — Hybrid Production

Some stems use conventional virtual instruments.

Others use generative AI.

Example:

```text
Drums — sampled kit
Bass — VST
Guitar — AI-produced
Violin — orchestral library
Vocal — singing synthesis
```

This may ultimately provide the most professional workflow.

---

# 39. Selective Regeneration

Long-term goal:

> Regenerate bars 33–41.

The system should preserve everything outside the selected region.

Possible levels:

- MIDI-only region
- one instrument
- one stem
- one vocal phrase
- complete arrangement region

This should be treated as a major architectural goal even if early production models cannot support it reliably.

---

# 40. Mixing System

The application should contain a basic conventional mixer regardless of AI capabilities.

Each track should expose:

- volume
- pan
- mute
- solo
- EQ
- compression
- reverb
- delay
- stereo width
- automation

Generated stems should remain independently mixable.

---

# 41. AI Mix Assistant

Users may ask:

> Make the vocal clearer.

> Put the violin farther back.

> Make the drums hit harder.

> Reduce muddiness.

The assistant should preferably translate these requests into ordinary mixer changes whenever possible rather than regenerate audio.

This preserves determinism.

---

# 42. Mastering

Mastering should also be modular.

Options:

- built-in DSP mastering
- local AI mastering
- cloud mastering
- external provider
- user export

Target profiles could include:

- streaming
- CD
- loud rock
- dynamic
- podcast
- demo

---

# 43. Theory View

The application should explain the music.

Example:

### Chorus

**G – D – Em – C**

I – V – vi – IV in G major.

The verse emphasizes E minor while the chorus places more weight on G major, producing a perceptual emotional lift without requiring a full modulation.

Controls:

**Make darker**

**Increase tension**

**Make less conventional**

**Try modal harmony**

Theory View makes the software useful for learning as well as generation.

---

# 44. AI Conversation

Each project includes an assistant that understands the song's symbolic structure.

Users could say:

> Why does the pre-chorus feel weak?

> Give the bass more movement but don't change the chords.

> What would happen if this chorus were in half-time?

> Make the bridge contrast more strongly with the chorus.

> Add strings without making the arrangement crowded.

The assistant should answer in terms of the actual project.

---

# 45. Musical Context Object

AI providers should not receive the raw project format directly.

Instead, the application creates a normalized:

```text
MusicContext
```

containing relevant information.

Example:

```text
MusicContext {
    tempo
    meter
    key
    section
    chords
    tracks
    motifs
    selected_notes
    energy
    constraints
    instruction
}
```

Provider adapters translate MusicContext into model-specific prompts.

This is essential for provider independence.

---

# 46. Structured AI Output

Language models should generally not directly produce binary MIDI files.

Instead, request structured musical actions.

Example:

```json
{
  "operation": "replace_notes",
  "track": "bass",
  "region": {
    "start_bar": 17,
    "end_bar": 24
  },
  "notes": [...]
}
```

The internal music engine validates the response and produces the actual MIDI.

Benefits:

- model independence
- validation
- safety
- repeatability
- easier debugging
- easier provider switching

---

# 47. Internal Music Intermediate Representation

MIDI alone should not be the app's internal musical representation.

Create a richer **Music IR**.

Example:

```text
Note
Chord
Phrase
Motif
Section
Track
Automation
Articulation
LyricSyllable
Expression
TempoEvent
MeterEvent
KeyEvent
```

MIDI becomes one serialization target.

Others could eventually include:

- MusicXML
- MIDI 2.0
- Ableton export
- DAW stems
- notation formats

---

# 48. Validation Engine

Every AI-generated change should be validated.

Examples:

- notes inside instrument range
- MIDI events valid
- section boundaries respected
- locked material unchanged
- chord references valid
- lyrics align with vocal events
- overlapping notes reasonable
- requested bar range honored

Bad model output should never corrupt a project.

---

# 49. Model Routing

Users may choose:

### Manual

User selects every model.

### Automatic

Application chooses models by task.

### Rules

Example:

```text
Use local models whenever possible.

If local confidence < 70%:
    use Gemini.

Use cloud production only for Final renders.

Never upload vocals.
```

---

# 50. Privacy Controls

Every provider should display a data-flow indicator.

Example:

### Generation Request

Sending to:

**Gemini**

Data:

✓ Song description  
✓ Chord progression  
✓ MIDI  
✗ Recorded vocals  
✗ Reference audio

This should be particularly prominent for local/privacy-conscious workflows.

---

# 51. Offline Mode

The application should support complete offline operation when compatible local models are installed.

Offline mode may include:

- local LLM
- deterministic theory engine
- MIDI generation
- local transcription
- local source separation
- local singing synthesis
- local music generation
- local rendering
- local mixing

Cloud-dependent features simply become unavailable.

---

# 52. Version History

Every meaningful operation should create a reversible revision.

Example:

```text
v12
"Original chorus"

v13
"More active bass"

v14
"Half-time drums"

v15
"Raised vocal ending"
```

The user can:

- compare
- restore
- branch
- duplicate
- merge selected changes

---

# 53. Branching

Projects should support branches.

Example:

```text
Main
├── Heavy Version
├── Acoustic Version
├── Synth Version
└── Radio Edit
```

All may inherit the same underlying Song DNA.

---

# 54. A/B Generation

For expensive production operations, users should be able to request multiple candidates.

Example:

**Production A**

**Production B**

**Production C**

The composition remains identical.

Only interpretation/production differs.

This provides a much fairer comparison than normal AI music generation because the underlying song is controlled.

---

# 55. Export

Users should always be able to export their work.

Formats should eventually include:

### Project

Native project package

### MIDI

- individual tracks
- multi-track MIDI

### Audio

- WAV
- FLAC
- MP3
- AAC

### Stems

- vocals
- drums
- bass
- guitars
- keys
- strings
- others

### Composition

- chord sheet
- MusicXML
- notation PDF
- lyric sheet

---

# 56. DAW Interoperability

Long-term integrations should target:

- Ableton Live
- Logic Pro
- FL Studio
- Reaper
- Studio One
- Cubase
- Pro Tools

Early interoperability can simply use:

- multitrack MIDI
- stems
- tempo map
- marker file

Later versions could offer deeper project export.

---

# 57. Plugin Architecture

The application should eventually expose plugins for:

### AI Providers

New LLMs.

### Music Models

New generators.

### Singing Engines

New vocal systems.

### Transcription Engines

New audio-to-MIDI systems.

### Instruments

Soundfonts/VSTs.

### Genre Profiles

Community composition rules.

### Exporters

New DAW/project formats.

---

# 58. Provider Adapter Interfaces

Conceptual interfaces:

```text
CompositionProvider
plan_song()
modify_composition()
analyze_music()
explain_music()
```

```text
AudioGenerationProvider
generate_music()
transform_audio()
extend_audio()
inpaint_audio()
```

```text
SingingProvider
list_voices()
synthesize_singing()
regenerate_phrase()
```

```text
TranscriptionProvider
detect_tempo()
detect_key()
transcribe_notes()
transcribe_chords()
```

```text
SeparationProvider
separate_stems()
```

Each implementation translates between the app's normalized objects and its provider.

---

# 59. Capability Negotiation

A workflow should ask:

> Which installed provider can perform this?

rather than:

> Is provider X installed?

Example:

```text
Task:
Regenerate vocal phrase

Requires:
SINGING_SYNTHESIS
MIDI_CONDITIONING
LYRIC_CONDITIONING
REGION_GENERATION
```

The router lists compatible engines.

That allows future models to work without redesigning the application.

---

# 60. Cost Awareness

Cloud models should report estimated cost wherever possible.

Before a large generation:

```text
Production Model:
Cloud Music Generator

Estimated generation:
$0.84–$1.20

Duration:
3:42

Generate
```

Users should be able to configure:

- per-generation limit
- daily limit
- monthly limit
- warning threshold

---

# 61. Local Hardware Awareness

The local runtime manager should detect:

- GPU
- VRAM
- RAM
- CPU
- available storage
- acceleration backend

and classify models:

**Excellent**

**Compatible**

**Slow**

**Insufficient Hardware**

Quantized versions may be suggested where appropriate.

---

# 62. Model Manager

Users should have a single interface for installed models.

Categories:

**Composition**

**Audio**

**Vocals**

**Transcription**

**Separation**

Information:

- model name
- provider
- version
- size
- license
- hardware requirement
- capabilities
- location
- update status

---

# 63. Generation Queue

Expensive operations should run through a task queue.

Example:

```text
1. Separate reference stems
2. Transcribe bass
3. Regenerate guitar MIDI
4. Render guide mix
5. Generate vocals
6. Produce stems
7. Mix
8. Master
```

Tasks should be:

- cancellable
- resumable
- retryable
- independently inspectable

---

# 64. Provenance

Every generated artifact should know how it was created.

Example:

```text
Artifact:
chorus-vocal-v4.wav

Source:
vocal.mid v8

Lyrics:
lyrics.txt v5

Provider:
DiffSinger Adapter

Model:
custom_voice_01

Seed:
728441

Generated:
2026-10-03
```

This dramatically improves reproducibility.

---

# 65. Rights and Attribution Metadata

Projects should optionally record:

- human composer
- AI assistance
- lyric writer
- performer
- voice model
- model provider
- source references
- samples
- licensed assets

This may become increasingly important for professional release workflows.

---

# 66. MVP

The first useful version does **not** need to generate finished records.

The strongest MVP would be:

### Phase 1

- Song Blueprint generation
- deterministic theory engine
- AI-assisted composition
- MIDI generation
- piano roll
- arrangement view
- instrument tracks
- locking
- regeneration
- MIDI export
- local MIDI playback
- OpenAI-compatible provider abstraction
- several cloud provider adapters
- local LLM support

That alone is a legitimate application.

---

# 67. Phase 2

Add:

- audio-to-MIDI
- humming-to-MIDI
- source separation
- chord detection
- rebuild mode
- richer theory explanations
- custom genre profiles

---

# 68. Phase 3

Add production:

- guide rendering
- audio-generation provider system
- local music generation
- managed generation
- stem production
- production prompts
- A/B rendering

---

# 69. Phase 4

Add vocals:

- vocal melody
- lyric alignment
- dedicated singing synthesis
- vocal expression
- vocal regeneration
- authorized voice models
- user-recorded vocals

---

# 70. Phase 5

Add professional workflow:

- stem mixing
- mastering
- DAW interoperability
- collaboration
- version branches
- plugin ecosystem
- distributed/local render nodes

---

# 71. Recommended Technical Boundary

The system should be divided into these major services:

```text
UI
│
├── Project Manager
│
├── Music Engine
│   ├── Theory Engine
│   ├── MIDI Engine
│   ├── Arrangement Engine
│   └── Validation Engine
│
├── AI Orchestrator
│   ├── Provider Registry
│   ├── Capability Router
│   ├── Context Builder
│   └── Structured Output Parser
│
├── Audio Engine
│   ├── Playback
│   ├── Rendering
│   ├── Mixer
│   └── Effects
│
├── Model Runtime
│   ├── Local Models
│   └── Cloud Providers
│
└── Task Engine
    ├── Jobs
    ├── Queue
    └── Generation History
```

This architecture prevents any one AI system from becoming foundational infrastructure.

---

# 72. The Crucial Separation

There are ultimately four distinct forms of intelligence in the application:

### Composer

> What should the music be?

### Music Engine

> Represent that music precisely.

### Performer

> What should these notes sound like when played or sung?

### Producer

> What should the recording sound like?

Those roles should never be permanently collapsed into one model.

---

# 73. Example Complete Workflow

The user types:

> Make a fast alternative rock song with a melancholy verse and huge cathartic chorus. Drums, bass, two guitars, piano and violin. Male tenor vocal.

The Composition Planner creates:

```text
Key: E minor
Tempo: 162
Meter: 4/4
Structure:
Intro / Verse / Pre / Chorus / Verse / Pre /
Chorus / Bridge / Final Chorus / Outro
```

The Theory Engine creates the harmonic framework.

Instrument generators create:

```text
drums.mid
bass.mid
guitar-left.mid
guitar-right.mid
piano.mid
violin.mid
vocal.mid
```

The user listens.

They select the violin and say:

> Make this less busy during the verse but more emotional during the chorus.

The AI proposes revised MIDI.

The user accepts it.

The user locks:

- harmony
- vocal
- drums
- violin

and regenerates the bass.

They record themselves humming a new final vocal phrase.

The app converts it to MIDI.

The user substitutes that phrase.

A guide mix is rendered.

The user selects a production engine.

It generates produced instrumental stems.

The singing engine receives:

```text
vocal.mid
lyrics
expression
```

and generates a vocal performance.

The mixer assembles everything.

The user says:

> Bring the violin forward in the last chorus and make the vocal slightly drier.

Those instructions become mixer changes.

The result is exported as:

```text
Master.wav
Instrumental.wav
Acapella.wav
Stems.zip
Song.mid
Song.musicxml
SongProject.songproject
```

The user still possesses every musical decision underlying the finished recording.

---

# 74. Product Identity

The strongest way to describe this application is not:

> AI song generator.

It is:

> **A structured AI music workstation where AI composes, performs, and produces music without taking the composition away from you.**

Its primary differentiator is therefore not model quality.

Models will improve and providers will change.

The durable product advantage is the layer between the human and those models:

**Song Blueprint**

↓

**Music IR**

↓

**Editable MIDI**

↓

**Provider-independent generation**

↓

**Reproducible musical project**

That makes the system useful even if every AI provider available today is replaced five years from now.

---

# 75. Core Product Promise

The application should be able to make this promise:

> **Generate a song. Keep the song. Change the notes. Change the instruments. Change the singer. Change the production. Regenerate only what you want. Use whichever AI you want.**

That should govern the architecture of the entire product.