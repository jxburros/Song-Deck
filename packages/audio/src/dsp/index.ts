/**
 * Audio Engine DSP (spec §28, §33–§35, §40, §42, §51, §55): deterministic pure-TypeScript synthesis,
 * guide rendering (streaming + offline), mixer & effects, automation, mastering & loudness
 * (BS.1770-4 / EBU R128), WAV/FLAC codecs, singing synthesis, sample instruments (SFZ).
 */

// Rendering
export { SongRenderer, renderSong, renderTrack, renderStems } from './renderer';
export type { RenderOptions, RenderMeters } from './renderer';
export type { Meter } from './mixer';

// Patches / instruments
export { PATCHES, patchIdForInstrument, patchIdForGmProgram } from './patches';
export type { PatchDefinition, PatchEngine, InstrumentFxSpec } from './patches';
export type { DrumKitId, DrumPiece } from './drums';

// Sample instruments
export { parseSfz } from './sfz';
export type { SampleInstrument, SampleZone, SampleLoopMode } from './sampler';

// Mastering & loudness
export { MASTERING_PRESETS, masterAudio } from './mastering';
export type { MasteringPreset, MasteringReport, MasteringResult } from './mastering';
export { measureLoudness, kWeightingCoefficients } from './loudness';
export type { LoudnessReport, KWeighting } from './loudness';

// Codecs
export { encodeWav, decodeWav } from './codecs/wav';
export type { WavEncodeOptions } from './codecs/wav';
export { encodeFlac, decodeFlac, flacInfo } from './codecs/flac';
export type { FlacEncodeOptions, FlacInfo } from './codecs/flac';

// Buffer utilities
export {
  mixBuffers,
  resample,
  toMono,
  toStereo,
  normalizePeak,
  sliceAudio,
  applyFades,
  spliceWithCrossfade,
  gainAudio,
  concatAudio,
} from './buffers';

// Singing synthesis
export { STOCK_VOICES, synthesizeVocal, resolveSingingVoice } from './singing/voice';
export type { SingingVoice, SynthesizeVocalOptions } from './singing/voice';
