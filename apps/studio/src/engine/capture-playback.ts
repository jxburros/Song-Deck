import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AudioData } from '@songdeck/audio';
import { player } from './player';

/**
 * Preview playback for audio that is not (yet) part of the project: rendered MIDI alternatives,
 * captured recordings, uploaded references, separated stems. One preview plays at a time and
 * the project transport is paused while a preview plays (and vice versa via `stopPreview`).
 */

type Listener = () => void;

class PreviewPlayer {
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private duration = 0;
  private listeners = new Set<Listener>();
  private cache = new WeakMap<AudioData, AudioBuffer>();
  playingId: string | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private context(): AudioContext {
    if (!this.ctx) {
      const Ctx: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
    }
    return this.ctx;
  }

  private toBuffer(audio: AudioData): AudioBuffer {
    const hit = this.cache.get(audio);
    if (hit) return hit;
    const ctx = this.context();
    const frames = Math.max(1, audio.channels[0]?.length ?? 1);
    const buf = ctx.createBuffer(Math.max(1, audio.channels.length), frames, audio.sampleRate);
    audio.channels.forEach((ch, i) => buf.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
    this.cache.set(audio, buf);
    return buf;
  }

  /** Play `audio` under `id` from `offsetSeconds`. Stops any other preview. */
  async play(id: string, audio: AudioData, offsetSeconds = 0): Promise<void> {
    this.stopSource();
    if (player.playing) player.pause();
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    const buffer = this.toBuffer(audio);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    src.connect(gain).connect(ctx.destination);
    this.offset = Math.max(0, Math.min(offsetSeconds, buffer.duration));
    this.duration = buffer.duration;
    this.startedAt = ctx.currentTime;
    src.onended = () => {
      if (this.src === src) {
        this.src = null;
        this.playingId = null;
        this.emit();
      }
    };
    src.start(0, this.offset);
    this.src = src;
    this.gain = gain;
    this.playingId = id;
    this.emit();
  }

  /** Seconds into the playing preview (0 when stopped). */
  position(): number {
    if (!this.src || !this.ctx) return 0;
    return Math.min(this.duration, this.offset + (this.ctx.currentTime - this.startedAt));
  }

  private stopSource() {
    if (this.src) {
      const s = this.src;
      this.src = null;
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
      this.gain?.disconnect();
    }
  }

  stop() {
    this.stopSource();
    if (this.playingId !== null) {
      this.playingId = null;
      this.emit();
    }
  }
}

export const previewPlayer = new PreviewPlayer();

/** Stop previews when the project transport starts. */
player.subscribe(() => {
  if (player.playing && previewPlayer.playingId) previewPlayer.stop();
});

/** Id of the preview currently playing (re-renders on change). */
export function usePreviewId(): string | null {
  return useSyncExternalStore(
    (cb) => previewPlayer.subscribe(cb),
    () => previewPlayer.playingId,
  );
}

/** Position (seconds) of the preview `id` while it plays, updated every animation frame. */
export function usePreviewPosition(id: string | null): number | null {
  const playing = usePreviewId();
  const [pos, setPos] = useState<number | null>(null);
  useEffect(() => {
    if (!id || playing !== id) {
      setPos(null);
      return;
    }
    let raf = 0;
    const loop = () => {
      setPos(previewPlayer.position());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [id, playing]);
  return pos;
}

/** Stop previews when a view unmounts. */
export function useStopPreviewOnUnmount() {
  useEffect(() => () => previewPlayer.stop(), []);
}
