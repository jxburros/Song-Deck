/**
 * @songdeck/audio — the Audio Engine (spec §71: Playback, Rendering, Mixer, Effects) plus
 * the music-information-retrieval analysis used by Transcribe / Rebuild (spec §25-§27).
 */
export * from './types';
// Synthesis, guide rendering, streaming renderer, mixer, effects, automation, mastering, codecs, singing synthesis.
export * from './dsp';
// FFT/STFT, onsets, tempo/beats, key, chroma/chords, pitch tracking, transcription, separation, structure, rebuild.
export * from './analysis';
