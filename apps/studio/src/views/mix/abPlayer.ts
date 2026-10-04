import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AudioData } from '@songdeck/audio';
import { player } from '../../engine/player';

/**
 * A/B listening for mastering (spec §42): the unmastered mix (A) and the master (B) play in
 * lock-step from two AudioBufferSourceNodes started at the same instant; switching only moves
 * two gain nodes (15 ms crossfade), so the comparison is instant and at the same position.
 * Optional level matching plays B at A's integrated loudness to judge tone, not volume.
 */

export type Side = 'A' | 'B';

type Listener = () => void;

function toBuffer(ctx: BaseAudioContext, a: AudioData): AudioBuffer {
  const len = a.channels[0]?.length ?? 0;
  const buf = ctx.createBuffer(Math.max(1, a.channels.length), Math.max(1, len), a.sampleRate);
  a.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return buf;
}

class ABPlayer {
  private ctx: AudioContext | null = null;
  private buffers: Record<Side, AudioBuffer | null> = { A: null, B: null };
  private sources: AudioBufferSourceNode[] = [];
  private gains: Record<Side, GainNode | null> = { A: null, B: null };
  private startCtxTime = 0;
  private startOffset = 0;
  private listeners = new Set<Listener>();
  private ids: Record<Side, string | null> = { A: null, B: null };
  playing = false;
  side: Side = 'B';
  /** Gain (dB) applied to B when level matching. */
  matchDb = 0;
  matching = false;
  version = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private ensure(): AudioContext {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      for (const s of ['A', 'B'] as Side[]) {
        const g = this.ctx.createGain();
        g.connect(this.ctx.destination);
        this.gains[s] = g;
      }
      this.applyGains(0);
    }
    return this.ctx;
  }

  /** Load (or replace) a side. `id` lets callers skip reloading the same audio. */
  load(side: Side, audio: AudioData | null, id: string | null) {
    if (this.ids[side] === id && (audio === null) === (this.buffers[side] === null)) return;
    const wasPlaying = this.playing;
    const pos = this.position();
    if (wasPlaying) this.stopSources();
    this.ids[side] = id;
    this.buffers[side] = audio ? toBuffer(this.ensure(), audio) : null;
    if (wasPlaying) this.play(pos);
    else this.emit();
  }

  loadedId(side: Side): string | null {
    return this.buffers[side] ? this.ids[side] : null;
  }

  has(side: Side): boolean {
    return !!this.buffers[side];
  }

  duration(): number {
    return Math.max(this.buffers.A?.duration ?? 0, this.buffers.B?.duration ?? 0);
  }

  position(): number {
    if (!this.playing || !this.ctx) return this.startOffset;
    return Math.min(this.duration(), this.startOffset + (this.ctx.currentTime - this.startCtxTime));
  }

  private stopSources() {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
        s.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
  }

  private applyGains(rampSeconds = 0.015) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const bGain = this.matching ? Math.pow(10, this.matchDb / 20) : 1;
    const target: Record<Side, number> = {
      A: this.side === 'A' ? 1 : 0,
      B: this.side === 'B' ? bGain : 0,
    };
    for (const s of ['A', 'B'] as Side[]) {
      const g = this.gains[s];
      if (!g) continue;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      if (rampSeconds > 0) g.gain.linearRampToValueAtTime(target[s], t + rampSeconds);
      else g.gain.setValueAtTime(target[s], t);
    }
  }

  async play(from?: number) {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') await ctx.resume();
    if (player.playing) player.pause();
    this.stopSources();
    const offset = Math.max(0, Math.min(from ?? this.startOffset, Math.max(0, this.duration() - 0.05)));
    const when = ctx.currentTime + 0.04;
    for (const side of ['A', 'B'] as Side[]) {
      const buf = this.buffers[side];
      if (!buf || !this.gains[side]) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gains[side]!);
      if (offset < buf.duration) src.start(when, offset);
      this.sources.push(src);
    }
    if (!this.sources.length) return;
    this.sources[0].onended = () => {
      if (this.playing && this.position() >= this.duration() - 0.1) {
        this.playing = false;
        this.startOffset = 0;
        this.stopSources();
        this.emit();
      }
    };
    this.startCtxTime = when;
    this.startOffset = offset;
    this.playing = true;
    this.applyGains(0);
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.startOffset = this.position();
    this.playing = false;
    this.stopSources();
    this.emit();
  }

  stop() {
    this.pause();
    this.startOffset = 0;
    this.emit();
  }

  seek(seconds: number) {
    if (this.playing) void this.play(seconds);
    else {
      this.startOffset = Math.max(0, Math.min(seconds, this.duration()));
      this.emit();
    }
  }

  setSide(side: Side) {
    this.side = side;
    this.applyGains();
    this.emit();
  }

  setMatching(on: boolean, matchDb: number) {
    this.matching = on;
    this.matchDb = Number.isFinite(matchDb) ? Math.max(-24, Math.min(24, matchDb)) : 0;
    this.applyGains();
    this.emit();
  }

  clear() {
    this.stop();
    this.buffers = { A: null, B: null };
    this.ids = { A: null, B: null };
    this.emit();
  }
}

export const abPlayer = new ABPlayer();

// Main transport takes over → A/B pauses.
player.subscribe(() => {
  if (player.playing && abPlayer.playing) abPlayer.pause();
});

/** Re-render on A/B state changes. */
export function useABState() {
  return useSyncExternalStore(
    (cb) => abPlayer.subscribe(cb),
    () => abPlayer.version,
  );
}

/** A/B position, updated per animation frame while playing. */
export function useABPosition(): number {
  useABState();
  const [pos, setPos] = useState(abPlayer.position());
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setPos(abPlayer.position());
      if (abPlayer.playing) raf = requestAnimationFrame(loop);
    };
    loop();
    const unsub = abPlayer.subscribe(() => {
      cancelAnimationFrame(raf);
      loop();
    });
    return () => {
      unsub();
      cancelAnimationFrame(raf);
    };
  }, []);
  return pos;
}
