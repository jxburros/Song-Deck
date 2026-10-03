/// <reference lib="webworker" />
/**
 * Playback worker: runs the deterministic @songdeck/audio SongRenderer off the main thread
 * and streams stereo chunks to the Player, which schedules them on the AudioContext.
 * The same renderer produces offline renders/exports, so what you hear is what you export.
 */
import { SongRenderer, type AudioData } from '@songdeck/audio';
import type { MixerState, Song } from '@songdeck/core';

declare const self: DedicatedWorkerGlobalScope;

export type PlaybackInMessage =
  | { type: 'init'; sampleRate: number }
  | { type: 'song'; song: Song }
  | { type: 'mixer'; mixer: MixerState }
  | { type: 'asset'; id: string; sampleRate: number; channels: Float32Array[] }
  | { type: 'seek'; frame: number; gen: number }
  | { type: 'loop'; startFrame: number | null; endFrame?: number }
  | { type: 'pull'; count: number; gen: number }
  | { type: 'options'; metronome: boolean };

export type PlaybackOutMessage =
  | { type: 'ready' }
  | {
      type: 'chunk';
      gen: number;
      frame: number;
      frames: number;
      left: Float32Array;
      right: Float32Array;
      meters?: { tracks: Record<string, { peakDb: number; rmsDb: number }>; master: { peakDb: number; rmsDb: number } };
      ended: boolean;
    }
  | { type: 'error'; message: string };

export const CHUNK_FRAMES = 4096;

let sampleRate = 48000;
let song: Song | null = null;
let renderer: SongRenderer | null = null;
let metronome = false;
let loop: { startFrame: number | null; endFrame?: number } = { startFrame: null };
const assets = new Map<string, AudioData>();
let chunkCounter = 0;

function post(msg: PlaybackOutMessage, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function buildRenderer(keepPosition: boolean) {
  if (!song) return;
  const pos = keepPosition && renderer ? renderer.positionFrames : 0;
  renderer = new SongRenderer(song, {
    sampleRate,
    assets: (id: string) => assets.get(id),
    metronome,
    tailSeconds: 1.5,
  });
  if (loop.startFrame !== null) renderer.setLoop(loop.startFrame, loop.endFrame);
  if (pos) renderer.seekFrame(pos);
}

self.onmessage = (ev: MessageEvent<PlaybackInMessage>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init':
        sampleRate = msg.sampleRate;
        if (song) buildRenderer(false);
        post({ type: 'ready' });
        break;
      case 'song':
        song = msg.song;
        if (renderer) renderer.updateSong(msg.song);
        else buildRenderer(false);
        break;
      case 'mixer':
        if (song) song = { ...song, mixer: msg.mixer };
        renderer?.updateMixer(msg.mixer);
        break;
      case 'asset':
        assets.set(msg.id, { sampleRate: msg.sampleRate, channels: msg.channels });
        break;
      case 'seek':
        if (!renderer) buildRenderer(false);
        renderer?.seekFrame(Math.max(0, Math.floor(msg.frame)));
        break;
      case 'loop':
        loop = { startFrame: msg.startFrame, endFrame: msg.endFrame };
        renderer?.setLoop(msg.startFrame, msg.endFrame);
        break;
      case 'options':
        if (msg.metronome !== metronome) {
          metronome = msg.metronome;
          buildRenderer(true);
        }
        break;
      case 'pull': {
        if (!renderer) {
          post({ type: 'chunk', gen: msg.gen, frame: 0, frames: 0, left: new Float32Array(0), right: new Float32Array(0), ended: true });
          break;
        }
        for (let i = 0; i < msg.count; i++) {
          const frame = renderer.positionFrames;
          const left = new Float32Array(CHUNK_FRAMES);
          const right = new Float32Array(CHUNK_FRAMES);
          const n = renderer.process(left, right, CHUNK_FRAMES);
          const ended = n === 0;
          chunkCounter++;
          const meters = chunkCounter % 2 === 0 ? renderer.getMeters() : undefined;
          const outL = n === CHUNK_FRAMES ? left : left.slice(0, n);
          const outR = n === CHUNK_FRAMES ? right : right.slice(0, n);
          post({ type: 'chunk', gen: msg.gen, frame, frames: n, left: outL, right: outR, meters, ended }, [outL.buffer, outR.buffer]);
          if (ended) break;
        }
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
