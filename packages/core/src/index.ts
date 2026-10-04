/**
 * @songdeck/core — the Music Engine (spec §71):
 *   Music IR, Theory Engine, Composition/Arrangement Engine, Validation Engine,
 *   serialization (MIDI, MusicXML, sheets, DAW formats), Project Manager
 *   (packages, version history, branches, provenance) and Task Engine.
 */
export * from './ir/types';
export * from './ir/defaults';
export * from './ir/gm';
export * from './ir/palette';
export * from './ir/song-utils';
export * from './util/random';
export * from './util/ids';
export * from './timing';
export * from './locks';
export * from './theory';

// Composition engine (genres, instruments, blueprint, planner, generators, arrangement, macros,
// regeneration with locks, variation system, Song DNA).
export * from './composer';
// Musical intelligence (natural-language MIDI edits, theory explanations, lyrics, vocal commands,
// mix assistant rules, offline assistant).
export * from './musician';
// Structured operations, validation engine, diffs and proposals.
export * from './edit';
// Serialization: MIDI, MusicXML, chord/lyric sheets, notation PDF, DAWproject, Reaper, markers.
export * from './io';
// Project manager: .songproject packages, version history & branches, provenance.
export * from './project';
// Task engine: queue, jobs, cancellation, retry, resumable checkpoints.
export * from './tasks';
