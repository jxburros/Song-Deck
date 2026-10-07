import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AudioData } from '@songdeck/audio';
import { player } from '../../engine/player';
import { previewPlayer } from '../../engine/capture-playback';

/**
 * A/B/C comparison playback (spec §54): every loaded source (guide, candidates A, B, C…, or the
 * reference stems of a guide) is started in lock-step from the same offset on its own gain node;
 * switching only moves gains (15 ms crossfade), so the comparison is instant and at the same
 * playback position. Optional level matching plays every source at the quietest one's loudness so
 * you judge production, not volume.
 */

export interface CompareSource {
  key: string;
  audio: AudioData;
  /** Integrated loudness (LUFS) for level-matched playback. */
  lufs?: number;
}

interface Entry {
  audio: AudioData;
  buffer: AudioBuffer;
  gain: GainNode;
  lufs?: number;
}

type Listener = () => void;

class ComparePlayer {
  private ctx: AudioContext | null = null;
  private entries = new Map<string, Entry>();
  private nodes: AudioBufferSourceNode[] = [];
  private startCtxTime = 0;
  private startOffset = 0;
  private listeners = new Set<Listener>();
  active: string | null = null;
  playing = false;
  matching = true;
  version = 0;
  /** Which UI owns the loaded set (guide deck, candidate deck, stem preview…). */
  owner: string | null = null;

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
    }
    return this.ctx;
  }

  private toBuffer(a: AudioData): AudioBuffer {
    const ctx = this.ensure();
    const len = Math.max(1, a.channels[0]?.length ?? 0);
    const buf = ctx.createBuffer(Math.max(1, Math.min(2, a.channels.length)), len, a.sampleRate);
    for (let i = 0; i < buf.numberOfChannels; i++)
      buf.copyToChannel(a.channels[i] as Float32Array<ArrayBuffer>, i);
    return buf;
  }

  /** Replace the loaded set (buffers of unchanged sources are kept). */
  setSources(owner: string, list: CompareSource[]) {
    const wasPlaying = this.playing;
    const pos = this.position();
    const keys = new Set(list.map((s) => s.key));
    let changed = owner !== this.owner;
    for (const [k, e] of this.entries) {
      if (keys.has(k)) continue;
      e.gain.disconnect();
      this.entries.delete(k);
      changed = true;
    }
    for (const s of list) {
      const prev = this.entries.get(s.key);
      if (prev && prev.audio === s.audio) {
        prev.lufs = s.lufs;
        continue;
      }
      prev?.gain.disconnect();
      const ctx = this.ensure();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(ctx.destination);
      this.entries.set(s.key, { audio: s.audio, buffer: this.toBuffer(s.audio), gain, lufs: s.lufs });
      changed = true;
    }
    this.owner = owner;
    if (!this.active || !this.entries.has(this.active)) this.active = list[0]?.key ?? null;
    if (!changed) {
      this.applyGains(0);
      this.emit();
      return;
    }
    if (wasPlaying) void this.play(pos);
    else {
      this.startOffset = Math.min(this.startOffset, this.duration());
      this.applyGains(0);
      this.emit();
    }
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  duration(): number {
    let d = 0;
    for (const e of this.entries.values()) d = Math.max(d, e.buffer.duration);
    return d;
  }

  position(): number {
    if (!this.playing || !this.ctx) return this.startOffset;
    return Math.min(this.duration(), this.startOffset + (this.ctx.currentTime - this.startCtxTime));
  }

  activeAudio(): AudioData | null {
    return (this.active && this.entries.get(this.active)?.audio) || null;
  }

  /** Gain (dB) applied to `key` when level matching: brings every source to the quietest one. */
  matchGainDb(key: string): number {
    if (!this.matching) return 0;
    const all = [...this.entries.values()]
      .map((e) => e.lufs)
      .filter((v): v is number => v !== undefined && Number.isFinite(v) && v > -70);
    const lufs = this.entries.get(key)?.lufs;
    if (!all.length || lufs === undefined || !Number.isFinite(lufs) || lufs <= -70) return 0;
    return Math.max(-24, Math.min(0, Math.min(...all) - lufs));
  }

  private applyGains(rampSeconds = 0.015) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [k, e] of this.entries) {
      const target = k === this.active ? Math.pow(10, this.matchGainDb(k) / 20) : 0;
      e.gain.gain.cancelScheduledValues(t);
      e.gain.gain.setValueAtTime(e.gain.gain.value, t);
      if (rampSeconds > 0) e.gain.gain.linearRampToValueAtTime(target, t + rampSeconds);
      else e.gain.gain.setValueAtTime(target, t);
    }
  }

  private stopNodes() {
    for (const n of this.nodes) {
      try {
        n.onended = null;
        n.stop();
        n.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.nodes = [];
  }

  async play(from?: number) {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    if (player.playing) player.pause();
    previewPlayer.stop();
    this.stopNodes();
    const dur = this.duration();
    if (!this.entries.size || dur <= 0) return;
    const offset = Math.max(0, Math.min(from ?? this.startOffset, Math.max(0, dur - 0.05)));
    const when = ctx.currentTime + 0.04;
    for (const e of this.entries.values()) {
      const src = ctx.createBufferSource();
      src.buffer = e.buffer;
      src.connect(e.gain);
      if (offset < e.buffer.duration) src.start(when, offset);
      this.nodes.push(src);
    }
    const longest = this.nodes.reduce<AudioBufferSourceNode | null>(
      (a, n) => (!a || (n.buffer?.duration ?? 0) > (a.buffer?.duration ?? 0) ? n : a),
      null,
    );
    if (longest) {
      longest.onended = () => {
        if (this.playing && this.position() >= this.duration() - 0.1) {
          this.playing = false;
          this.startOffset = 0;
          this.stopNodes();
          this.emit();
        }
      };
    }
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
    this.stopNodes();
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

  setActive(key: string) {
    if (!this.entries.has(key)) return;
    this.active = key;
    this.applyGains();
    this.emit();
  }

  setMatching(on: boolean) {
    this.matching = on;
    this.applyGains();
    this.emit();
  }

  /** Release everything owned by `owner` (when its view unmounts). */
  release(owner: string) {
    if (this.owner !== owner) return;
    this.stop();
    for (const e of this.entries.values()) e.gain.disconnect();
    this.entries.clear();
    this.active = null;
    this.owner = null;
    this.emit();
  }
}

export const comparePlayer = new ComparePlayer();

// The song transport takes over → comparison pauses.
player.subscribe(() => {
  if (player.playing && comparePlayer.playing) comparePlayer.pause();
});

export function useCompareState(): number {
  return useSyncExternalStore(
    (cb) => comparePlayer.subscribe(cb),
    () => comparePlayer.version,
  );
}

/** Comparison position, updated per animation frame while playing. */
export function useComparePosition(): number {
  useCompareState();
  const [pos, setPos] = useState(comparePlayer.position());
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setPos(comparePlayer.position());
      if (comparePlayer.playing) raf = requestAnimationFrame(loop);
    };
    loop();
    const unsub = comparePlayer.subscribe(() => {
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
