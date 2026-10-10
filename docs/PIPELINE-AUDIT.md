# Pipeline audit — Song Deck 0.7.0

Audited against main `ebb6d09` (including the stem-import work after 0.6.0), October 10, 2026.
This release fixes the integration defects below and expands connected separator coverage.

## Pipeline map

- **Separate:** Library / Mix → `splitIntoStems` → `analysis.separate` → on-device DSP or the
  orchestrator's separation provider → decoded instrument stems → WAV assets / audio tracks.
  Import optionally queues MIDI transcription for each track. Rebuild folds available instruments
  into its four analysis categories before reconstructing a song.
- **Transcribe:** Make MIDI renders a track's unmuted clips from the first clip, transcribes audio
  in seconds, then converts both note boundaries using the song's complete tempo map. Library
  inputs transcribe clips before composition and retain their recording. Melody, chords and drums
  choose different transcription and note-cleanup paths. No quantization is applied to attached MIDI.
- **Compose / regenerate:** blueprint → genre/tag resolution → plan, chords, motifs and arrangement
  → track/section generators → overlap cleanup and lock-preserving replacement. Drums run first,
  then principal melody, bass, accompaniment, and responding leads / backing vocals.
- **AI editing / production:** current musical state becomes a bounded note/section context for
  language-model edits; audio providers receive a production prompt and their supported guide,
  MIDI or lyric inputs. These contracts do not imply that every audio engine consumes raw MIDI.
- **MIDI interchange:** standard MIDI note/channel/program/tempo/meter/key events plus optional
  Song Deck metadata; imported PPQ is scaled into the internal tick grid. Attached audio MIDI is
  included through its note-track view.

## Findings and fixes

| Area                         | Defect                                                                                                                                                                 | Fix and regression coverage                                                                                                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instrument coverage          | Studio always requested four stems, leaving capable engines underused.                                                                                                 | Bridge `/info` vocabulary drives default requests, with legacy fallback; known cloud adapters request their supported instrument sets. Explicit API subsets still work. Tests exercise six-stem output against the actual mock HTTP bridge and verify that stems sum to the input. |
| Stem identities              | Guitar, piano and extended instrument labels became generic piano tracks; electric/acoustic guitars lost their distinction.                                            | Preserve fine-grained output, classify recognized labels into role/instrument/stem group, and retain unknown labels as independent tracks.                                                                                                                                         |
| Asset formats                | Compressed cloud output was stored with a WAV filename and MIME type.                                                                                                  | Decode provider output and encode actual float32 WAV bytes before storing, preserving stem peaks above 0 dBFS.                                                                                                                                                                     |
| Partial / overlapping output | Isolated instruments could omit the rest of the recording; full accompaniment could double other tracks.                                                               | Retain a residual when needed; keep a lone instrument plus its complement, and discard redundant complements beside detailed stems.                                                                                                                                                |
| Rebuild mixing               | Different sample rates were mixed by sample index; later stereo channels or longer tails could disappear.                                                              | Resample to the input clock and allocate the maximum channel count and length before combining.                                                                                                                                                                                    |
| Provider drums               | Providers return note events, while attached MIDI expected a separate drum-hit array and produced no notes.                                                            | Normalize provider drum events to hits; attached MIDI also accepts note-only provider results. GM drum pitches bypass melodic key snapping.                                                                                                                                        |
| Source vocabulary            | Studio `singing`, `humming`, `isolated`, and `full-mix` did not match Basic Pitch's source names.                                                                      | Translate to `vocals`, `other`, and `mix` at the bridge boundary.                                                                                                                                                                                                                  |
| Library MIDI                 | Library Auto defaulted unknown recordings to chords, losing automatically detected drums; bass playback defaulted to a lead synth.                                     | Reuse Make MIDI source/mode/instrument resolution and preserve recognized instrument identity.                                                                                                                                                                                     |
| Async edits / locks          | Make MIDI ignored section locks and could replace notes after clip, tempo, MIDI or song changes.                                                                       | Check section/track-section locks and cancellation; compare source, tempo, PPQ, notes and link state before committing. Race tests cover edits and switching songs.                                                                                                                |
| Existing MIDI context        | Planned arrangement could hide real imported/locked notes; sustained melody was omitted at the next section; generated vocal selection could override attached melody. | Read actual sounding notes for melody, kicks and bass presence; clip sustained context to section bounds without changing source notes; prioritize nonempty attached melody and use a section-local fallback.                                                                      |
| Modulation                   | Chord regeneration reused absolute pitches from an earlier section of the same kind in a different key.                                                                | Cache plans and progressions per key as well as section kind.                                                                                                                                                                                                                      |
| Genre / tags                 | Style-only regeneration fell back to pop; duplicate aliases multiplied parent weights; AI prompts could use old blueprint genres.                                      | Share genre inference, deduplicate canonical tags, and use the current blend while retaining free-form style descriptions. Explicit empty AI tags no longer restore defaults.                                                                                                      |
| MIDI duration                | Trailing rests disappeared without private metadata.                                                                                                                   | Write and honor standard End-of-Track duration, including single-track export.                                                                                                                                                                                                     |
| Provider validation          | Empty/null stem results and malformed note fields could leak invalid values downstream.                                                                                | Reject unusable separation output; sanitize transcription events, velocity/confidence and tempo.                                                                                                                                                                                   |

## How other MIDI influences generation

The chord map and key remain the harmonic authority. Bass patterns can follow actual kick onsets;
backing vocals and melodic instruments can follow, double, or answer the principal melody;
accompaniment uses actual bass presence to choose voicings. Supplied audio with attached MIDI can
provide those same cues, but regeneration only rewrites MIDI tracks. Track, section, track-section,
note and other composition locks protect their corresponding material.

This is targeted musical conditioning, not an all-track neural arrangement model. Arbitrary
accompaniment notes do not automatically replace the chord map. A chord-map edit or Rebuild analysis
is needed when the intended harmony changes. Melody fallback applies within a section when the
principal has no sounding notes. Mixer mute/solo controls playback; it does not discard composition
context. If a recording changes, regenerate its attached MIDI when the stale indicator appears.

## Separator coverage and limits

| Engine                  | Default instrument coverage                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On-device DSP           | Drums, bass, vocals, other: HPSS and spectral masks, approximate and subject to bleed.                                                                                                                         |
| Reference Demucs bridge | Six stems: drums, bass, vocals, other, guitar, piano (`htdemucs_6s`). An explicit subset can select a four-stem model or single-instrument isolation. Other compatible bridges can advertise additional names. |
| ElevenLabs              | Six-stem service variation; every returned instrument is retained.                                                                                                                                             |
| AudioShake              | Drums, bass, vocals, guitar, piano, strings, wind, other.                                                                                                                                                      |
| LALAL.AI                | Vocals, drums, bass, piano, electric guitar, acoustic guitar, synthesizer, strings, wind; unmatched material is retained as other.                                                                             |

The application does not manufacture isolated instruments beyond an engine's capabilities. Unknown
returned instrument names are kept, but may require the user to choose the best playback instrument
or transcription mode. More cloud targets can mean more billed tasks and longer processing.
Independent isolation models can overlap or leave artifacts; a residual preserves the subtraction
result but is not evidence of perfect separation. Quiet output is filtered at the existing relative
RMS threshold, so a very soft real part may be omitted. Basic Pitch is pitched transcription and
explicitly does not support drums; use on-device drum transcription or a compatible drum provider.

## Validation boundary

Regression tests cover provider requests and malformed replies, an actual mock bridge over HTTP,
stem mixing and residuals, source routing, tempo-map conversion, edit races, locks, composition
context, modulation, genre/tag conventions and MIDI duration. The full repository suite, static
checks, browser checks, production build and packaged-server smoke checks gate the release.

No paid provider jobs or model-weight downloads were used for this audit. The mock bridge verifies
protocols and reconstruction, not Demucs/Basic Pitch inference quality. Real-model listening and
transcription accuracy across instruments remain empirical limits; the DSP separator and pitch
transcription are approximations, not lossless recovery of the original recording session.
