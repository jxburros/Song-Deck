/** Shared result types of the audio-analysis / transcription modules. */

/** A transcribed note in seconds (before conversion to IR ticks). */
export interface TranscribedNote {
  /** MIDI pitch (integer). */
  pitch: number;
  startSeconds: number;
  endSeconds: number;
  /** 1..127 */
  velocity: number;
  /** 0..1 */
  confidence: number;
  /** Median deviation of the performed pitch from `pitch` (cents), when measured. */
  pitchBendCents?: number;
}

/** A transcribed drum hit. */
export interface DrumHit {
  /** Seconds. */
  time: number;
  /** General MIDI drum note (36 kick, 38 snare, 42 closed hat, 46 open hat, 49 crash, toms 41–50). */
  drum: number;
  /** 1..127 */
  velocity: number;
  /** 0..1 */
  confidence: number;
}

export type StemName = 'drums' | 'bass' | 'vocals' | 'other';
