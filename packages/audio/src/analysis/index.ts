/**
 * @songdeck/audio — analysis: the built-in, fully offline implementations behind Transcribe and
 * Rebuild (spec §25–§27). Every result reports an honest confidence; cloud/local ML providers can
 * replace individual stages through provider adapters.
 */
export * from './types';
export { FFT, fftReal, ifftReal, fftComplex, getFFT } from './fft';
export {
  stft,
  istft,
  magnitudeSpectrogram,
  spectrogramMagnitude,
  stftFrameCount,
  forEachStftFrame,
  StftFrameReader,
  OverlapAdd,
  binFrequency,
  frequencyBin,
  type Spectrogram,
  type MagnitudeSpectrogram,
  type StftOptions,
} from './stft';
export { analysisWindow, type WindowType } from './windows';
export {
  melFilterbank,
  logFilterbank,
  applyFilterbank,
  bandEnergies,
  spectralCentroid,
  spectralFlatness,
  spectralRolloff,
  frameRms,
  zeroCrossingRate,
  logBandFlux,
  cepstrum,
  hzToMel,
  melToHz,
  type Filterbank,
} from './features';
export {
  detectOnsets,
  onsetEnvelopeFromSignal,
  pickOnsetPeaks,
  type OnsetResult,
  type OnsetOptions,
  type OnsetEnvelope,
  type PeakPickOptions,
} from './onsets';
export {
  detectTempo,
  tempoFromEnvelope,
  trackBeats,
  estimateMeter,
  beatsToBpm,
  extendBeatGrid,
  tempoPrior,
  type TempoResult,
  type TempoOptions,
} from './tempo';
export {
  chromagram,
  chromagramFromSignal,
  syncChroma,
  normalizeChroma,
  estimateTuning,
  type ChromaResult,
  type ChromaOptions,
} from './chroma';
export {
  detectKey,
  keyFromHistogram,
  keyFromNotes,
  chromaHistogram,
  type KeyResult,
  type KeyInput,
} from './key';
export { detectChords, chordsFromChroma, type ChordSegment, type ChordOptions } from './chords';
export { trackPitch, yinTrack, medianF0, type PitchTrack, type PitchTrackOptions } from './pitch-yin';
export {
  transcribeMonophonic,
  notesFromPitchTrack,
  type MonophonicOptions,
  type MonophonicResult,
} from './transcribe-mono';
export {
  transcribePolyphonic,
  transcribePolyphonicSignal,
  type PolyphonicOptions,
  type PolyphonicResult,
} from './transcribe-poly';
export {
  transcribeDrums,
  type DrumTranscriptionOptions,
  type DrumTranscriptionResult,
} from './transcribe-drums';
export {
  separateSources,
  medianFilterTime,
  medianFilterFreq,
  type SeparationOptions,
  type SeparationResult,
} from './separation';
export {
  classifyStem,
  stemFeatures,
  STEM_INSTRUMENT_ROLE,
  type StemClassification,
  type StemInstrumentId,
  type ClassifyOptions,
} from './classify';
export { segmentStructure, assignKinds, type StructureSegment, type StructureOptions } from './structure';
export {
  transcribedToNotes,
  drumHitsToNotes,
  tapsToNotes,
  enforceMonophony,
  resolveOverlaps,
  secondsToTicks,
  ticksToSeconds,
  type TranscribedToNotesOptions,
  type DrumHitsToNotesOptions,
  type TapsToNotesOptions,
} from './quantize';
export {
  transcribeAudio,
  gridOrigin,
  type TranscriptionSource,
  type TranscribeAudioOptions,
  type TranscribeAudioResult,
} from './transcribe';
export {
  rebuildProject,
  type RebuildStage,
  type RebuildStageId,
  type RebuildReport,
  type RebuildOptions,
} from './rebuild';
export {
  chromaprintFingerprint,
  chromaprintRaw,
  compressFingerprint,
  encodeChromaprint,
  chromaprintBase64,
  fingerprintBitErrorRate,
  resampleForFingerprint,
  CHROMAPRINT_ALGORITHM,
  CHROMAPRINT_SAMPLE_RATE,
  CHROMAPRINT_MAX_SECONDS,
  type ChromaprintOptions,
  type ChromaprintResult,
} from './chromaprint';
