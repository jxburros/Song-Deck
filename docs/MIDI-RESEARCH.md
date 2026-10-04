# Musical accuracy, controlled variation, and Expand

Research and code audit: 4 October 2026. This is an engineering synthesis of the
primary repositories and technical documentation linked below, not a listening
study or a claim that every style has been empirically validated. Network access
in this environment permits GitHub sources; journal full texts and general web
search were not available. No recordings, training datasets, or model weights
were downloaded.

## What “accurate” should mean

There is no universal correct MIDI realization of “sad jazz” or “energetic pop.”
Separate four objectives:

1. **Intent fidelity:** honor explicit key, meter, tempo, instrumentation, source
   notes, song sections, and constraints. Treat inferred settings as editable.
2. **Musical coherence:** develop motifs; maintain harmonic context and voice
   leading; distinguish rhythmic, bass, accompaniment, and melodic roles; make
   transitions and cadences appropriate to the selected form.
3. **Style plausibility:** use genre-specific distributions over groove, harmonic
   vocabulary, instrumentation, register, articulation, density, and form.
4. **Useful diversity:** vary meaningful musical decisions while keeping the
   requested style and recurring thematic identity recognizable.

MIDI records discrete performance instructions, not the final sound. Distortion,
room sound, a warm tape texture, breathiness, and production space are properties
of rendering as well as composition. A MIDI-only evaluation cannot establish
that a “shoegaze” or “lo-fi” production sounds authentic.

## Genres and tags

FMA exposes a hierarchical genre taxonomy and separate per-track genre/tag
metadata [1]. That supports a parent-genre plus modifier design, rather than a
flat list where every adjective becomes an independent genre. It does **not**
prove a particular tempo window or chord progression is obligatory.

Song Deck already has broad parent profiles, style tags, weighted progressions,
role generators, and instrument constraints. Retain those and make their
probability semantics reliable:

- Normalize each genre's progression and form-template pool before multiplying
  by its requested blend share. Otherwise a 30% contribution with many entries
  or large arbitrary weights can dominate a 70% contribution.
- Normalize the planner's candidate mass before adding section-specific
  alternatives, so a chorus-rotation prior has consistent strength across
  single genres and blends.
- Preserve coherent categorical idioms. A house pulse, a breakbeat, a swing
  subdivision, and a dembow pattern are not interchangeable scalar values.
  The current dominant-profile categorical choice is understandable; future
  blends should select compatible idioms per section or layer, with explicit
  transition rules, rather than randomly changing groove on each beat.
- Keep broad regional labels appropriately qualified. “Latin,” “African,”
  “Asian,” and “classical” are not single musical grammars. Specific traditions
  need their own rhythmic cycles, phrase conventions, ornamentation, and tuning
  support before claiming faithful representation.

Useful dimensions for curating profiles (guidance, not exhaustive rules):

| Family / idiom                   | Structural anchors                                     | Legitimate variation                                   | Common failure                                       |
| -------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------- |
| Pop / synth-pop                  | recurring hook, section contrast, clear pulse          | inversions, pickups, response phrases, layering        | unrelated chorus each time                           |
| Rock / punk / metal              | riff identity, guitar range, coordinated bass and kick | accents, turnaround fills, voicing, half-time sections | generic piano harmony voiced as guitar               |
| Jazz / soul / R&B                | voice leading, harmonic rhythm, extensions, groove     | approach tones, substitutions, comping rhythms         | demanding all notes belong to one scale              |
| Hip-hop / trap / drill           | repeatable rhythmic cell, bass contour, phrase accents | hats, ghost notes, sparse fills, displacement          | random drums without a stable anchor                 |
| House / techno / trance          | stable pulse and longer energy development             | hats, bass patterns, builds and breakdowns             | constant full-density arrangement                    |
| Drum and bass / garage           | characteristic break or shuffled grid                  | kick omissions, response figures, fills                | averaging the beat into generic four-on-floor        |
| Reggae / dub                     | offbeat accompaniment and bass placement               | rests, bass approaches, turnaround variations          | treating a production echo tag as a new melody       |
| Salsa / bossa / samba            | specific rhythmic organization and part interaction    | idiomatic comping and percussion responses             | one interchangeable “Latin” beat                     |
| Folk / country / acoustic        | instrument idiom, phrase balance, singable range       | picking patterns, passing bass, instrumental answers   | impossible voicings or continuous busy fills         |
| Ambient / cinematic / orchestral | pacing, register, texture and harmonic movement        | entrances, sustained voice leading, evolving motifs    | assuming every section needs drums and a pop cadence |

These anchors are expert design recommendations. Their exact distributions need
annotated examples and musician review for each supported style. The changes
here do not re-label the entire existing catalog as researched ground truth.

## Mood is multidimensional and local

EMOPIA explicitly supports emotion-conditioned symbolic generation, including
arousal conditioning [2]. It is a pop-piano dataset; it is not evidence that one
emotion-to-mode mapping generalizes to every culture and genre.

Use independent dimensions rather than `sad → minor` as a hard rule:

- **Valence:** harmonic color, contour, phrase resolution, register choices.
- **Arousal:** note activity, articulation, rhythmic emphasis, register span,
  instrumentation and energy contour; tempo is only one contributor.
- **Tension:** harmonic stability, dissonance, anticipations, registral pressure.
- **Space:** rests, texture, note lengths, density, and production decisions.

A fast minor-key track can be euphoric; a slow major-key track can be wistful.
Explicit user keys and tempos should survive mood interpretation. For future
parser work, retain whether a value was explicitly selected, inferred, or set
by a tag, so conflicts can be explained rather than silently overwritten.

The audit found that all section moods were included in the planner's global
harmony-darkness calculation. A dark bridge could change an otherwise unchanged
verse and chorus. Global darkness now excludes section-targeted display statements as well as section mood lists. The prompt parser keeps recognized section-only mood tags and arousal out of global settings, and chord regeneration uses the same separation. Local mood colors
its own harmony group. Repeated sections within a group still share harmony;
per-occurrence emotional reharmonization remains a future refinement.

## Theory constraints and the right kind of randomness

music21 documents pitch-class profile correlation for key estimation, including
alternative interpretations [3]. Short melodies, relative major/minor pairs,
modal passages, modulations, and percussion-only clips are inherently ambiguous.
A correlation or transcription confidence is not a calibrated probability that
the musical interpretation is correct.

POP909 distinguishes melody, secondary melody, and accompaniment, and supplies
beat/chord/key annotations [4]. Those distinctions are useful conditioning
signals: accompaniment should support a lead rather than independently invent a
competing principal line. Its track named BRIDGE means secondary melody, **not**
a labeled bridge section in song form.

MusicVAE explicitly distinguishes hierarchical sequence structure from local
sampling, and models interdependencies among instruments [5]. GrooVAE separately
models expressive drum performance [5]. Music Transformer supports generation
conditioned on scores [6]. These systems motivate the architecture; Song Deck
continues to use its existing deterministic rule-based engine and does not load
or claim to implement these neural models.

Recommended sampling hierarchy:

1. Select a section plan and compatible harmonic vocabulary.
2. Establish motif contour, rhythm, and phrase length.
3. Reuse those motifs across returns, adapting to local harmony and range.
4. Vary endings, responses, ornamentation, and transitional fills.
5. Apply bounded timing/velocity expression last.

Use independently derived seeds for planning, motifs, track parts and performance.
Do not regenerate every note independently or equate timing jitter with creative
variation. Same source/settings/seed/engine version must reproduce the result.
New seeds should alter notes, rhythm, voicings or arrangement—not only IDs.

A strong-beat chord-tone preference is useful, but a universal diatonic-only rule
would reject borrowed chords, secondary dominants, blues inflections, and idiomatic
jazz dissonances. Quantitative scale fit should remain a diagnostic, not an
unconditional rejection criterion. Instrument range, event bounds and positive
note durations are stronger invariants.

## Expand: implemented workflow and contract

The new **Expand** mode accepts a MIDI file, an existing project's MIDI, or a
1–60 second audio clip. Audio uses the existing on-device rebuild/transcription
worker; the interface exposes its uncertainty. The source file remains untouched.
No external model or new service is required. Audio imports use the same rights
attestation and source-asset provenance mechanism as the other capture modes.

1. Preview the imported/transcribed source and review its key.
2. Label one or more bar ranges as verse, chorus, hook, intro, bridge, drop, etc.
   UI bars are 1-based and inclusive; core ranges are 0-based and end-exclusive.
   Labels can overlap so a hook can sit inside a larger section.
3. Arrange the output as ordered sections. Each section chooses a source region
   and either **Keep source** or **Develop**. Move sections up, remove them, set
   generated bar counts, and add as many sections as needed within the limits.
4. Optionally specify genre/tag/mood text, correct the key, and adjust phrase
   variation and seed. **New variation** explicitly chooses a fresh seed.
5. Preview, download MIDI, or open as a new editable project with provenance.

“Keep source” retains imported pitches, timing, durations, velocities and note
expression at a translated timeline location. It preserves rests, tempo changes,
meter changes and key changes within the selected range. It never substitutes a
freshly generated approximation. A kept section must equal its region's bar
length. Notes straddling a cut are trimmed and the result reports that fact.
IDs and lyric/phrase references are remapped because the same source region may appear more than once. Kept sections start locked in the new project, so later regeneration also preserves them; users can unlock them in the Workbench.

“Develop” extracts up to two bars of source melodic contour and attack rhythm,
expressed as scale-degree motifs. Section-scoped motifs ensure that choosing a
different source region changes the conditioning. The opening half of each
extracted motif is retained; phrase variation permits bounded one-step changes
in the latter half. The existing role generators realize it against local harmony
and instrument constraints. Existing key/tempo at the chosen region starts the
new section. Supplied source harmony informs matching section types; missing
harmony gets explicitly qualified, bar-level diatonic-triad suggestions.
Percussion reuses source attack grids and drum pitches, with bounded velocity
variation and occasional quiet phrase-ending responses. Bass generation runs
after those conditioned drum cells so it can react to the actual kick pattern.

Hooks are currently represented as chorus-like sections in the underlying IR,
with “Hook” retained as their display name. This is a practical explicit mapping;
a hook can function inside many section types and is not theoretically identical
to a chorus.

The engine version advances to **1.1.0** because planner probabilities change.
Saved MIDI remains unchanged; rerunning a saved seed under the new engine can
produce a different composition than engine 1.0.0.

## Limitations and next research steps

- A mixed recording is a harder transcription problem than an isolated line.
  Basic Pitch itself states that it works best on one instrument at a time [7];
  it is a research reference, not the model used by this implementation.
- The existing local DSP transcription does not provide studio-grade, guaranteed
  note recovery. Check audio-derived MIDI before expanding it. Full editable
  correction remains available in the Workbench by opening a transcribed project
  and returning to Expand with **Use current project**.
- The current expansion selection grid is whole bars. Pickups and arbitrary
  sub-bar motif boundaries need a future tick/beat region editor.
- Developed sections inherit the starting meter/key/tempo; internal map changes
  are reproduced in kept sections only. Polyphonic motif extraction takes the
  upper note at simultaneous attacks and does not perform full voice separation.
- Harmony inference is intentionally modest: seven diatonic triads scored by
  overlapping note durations. It is not a chord-recognition model and is especially
  uncertain for single-note, modal, chromatic or sparse input.
- Expansion creates MIDI with the source instrument roster. It does not promise
  a full band from a single hummed line. Audio clips and mixer automation are not
  rearranged; the result warns when source content of those types is excluded.
- Standard imported MIDI can omit expressive details not represented by the
  existing importer/IR (e.g. continuous sustain or pitch-bend events). Preservation
  refers to the imported Song Deck note events, not byte-identical MIDI files.
- Source-independent idiomatic bass/accompaniment generation and short extracted
  motifs are a baseline. Longer-range thematic development, user-selected voices,
  learned harmonic continuation, and genre-specific cadence models would improve
  fidelity beyond this first implementation.

## Evaluation: accuracy and diversity together

MusPy provides pitch-in-scale, polyphony, empty-beat, pitch-range, entropy and
groove metrics [8]. mir_eval separates structure-boundary detection from section
label evaluation [9]. Use these distinctions to avoid a single misleading
“musical quality” number.

Automated checks in this change cover source immutability, exact kept-region
musical events and rests, deterministic replay, meaningful cross-seed event
differences, selected-region motif conditioning, variation bounds, relocated
map changes, MIDI round trips and invalid requests. Planner regression checks
cover genre-pool normalization and mood isolation. Existing genre, tag, range,
lock, variation and composition suites remain applicable.

For a future musician benchmark, sample at least 20 seeds per profile and input
class, with style, familiarity and source quality recorded. Evaluate:

- hard validity and source-preservation errors (must be zero);
- motif/rhythm similarity, chord-tone fit on strong beats, range and leap statistics;
- pairwise musical-event distance, rhythmic-pattern diversity and duplicate rate;
- section identity and boundaries separately;
- blind ratings for style fit, continuity, emotional fit and useful variation.

Listen to generated transitions and recurring hooks, not just isolated bars.
A higher entropy score can reward incoherence; 100% scale fit can reward a dull
loop or penalize legitimate chromatic writing. Human review is still needed.

## Primary sources consulted

1. [FMA: A Dataset for Music Analysis](https://github.com/mdeff/fma): taxonomy,
   hierarchy, genre/tag metadata, and dataset scope.
2. [EMOPIA](https://github.com/annahung31/EMOPIA): symbolic emotion-conditioned
   generation and arousal task; limited pop-piano domain.
3. [music21 key-analysis implementation and documentation](https://github.com/cuthbertLab/music21/blob/master/music21/analysis/discrete.py):
   pitch-class profiles, correlation and alternative key interpretations.
4. [POP909](https://github.com/music-x-lab/POP909-Dataset): melodic roles,
   accompaniment, beat/chord/key annotations; secondary-melody BRIDGE semantics.
5. [MusicVAE and GrooVAE](https://github.com/magenta/magenta/blob/main/magenta/models/music_vae/README.md):
   hierarchical generation, instrument dependencies and expressive drum control.
6. [Music Transformer / Score2Perf](https://github.com/magenta/magenta/blob/main/magenta/models/score2perf/README.md):
   score-conditioned performance generation.
7. [Spotify Basic Pitch](https://github.com/spotify/basic-pitch): audio-to-MIDI
   transcription scope and the single-instrument recommendation.
8. [MusPy evaluation metrics](https://github.com/salu133445/muspy/blob/main/muspy/metrics/metrics.py):
   definitions and limitations of symbolic music statistics.
9. [mir_eval structural segmentation metrics](https://github.com/mir-evaluation/mir_eval/blob/main/mir_eval/segment.py):
   boundary and section-label evaluation.
10. [pretty_midi](https://github.com/craffel/pretty-midi): event-based MIDI analysis,
    pitch-class summaries, and drum-aware pitch manipulation.
