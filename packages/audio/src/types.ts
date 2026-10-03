/**
 * Shared audio types. Audio is planar float32 (one Float32Array per channel, -1..1).
 * Everything in @songdeck/audio is pure TypeScript (no Web Audio dependency), deterministic,
 * and runs identically in browsers, Web Workers and Node (render nodes, tests).
 */
export interface AudioData {
  sampleRate: number;
  /** 1 (mono) or 2 (stereo) planar channels of equal length. */
  channels: Float32Array[];
}

/** Resolves audio-track clip assets (stems, recordings, produced audio) by asset id. */
export type AssetResolver = (assetId: string) => AudioData | undefined;

export function audioLength(buf: AudioData): number {
  return buf.channels[0]?.length ?? 0;
}

export function audioDuration(buf: AudioData): number {
  return audioLength(buf) / buf.sampleRate;
}

export function createAudio(sampleRate: number, frames: number, channels = 2): AudioData {
  return { sampleRate, channels: Array.from({ length: channels }, () => new Float32Array(frames)) };
}
