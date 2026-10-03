import type { MixerState, Song } from '@songdeck/core';
import type { AudioData } from '@songdeck/audio';
import type { PlaybackInMessage, PlaybackOutMessage } from './playback.worker';
import type { RenderInstrumentConfig } from './render-config';

/**
 * Local MIDI/audio playback (spec §66 Phase 1 "local MIDI playback").
 *
 * The playback worker renders chunks with the same deterministic engine used for exports;
 * this class schedules them gaplessly on an AudioContext (sample-accurate `start(when)`),
 * keeps ~0.4 s of lookahead, and maps context time back to song position for the playhead.
 */

const LOOKAHEAD_SECONDS = 0.45;

interface ScheduledChunk {
  when: number;
  frame: number;
  frames: number;
  source: AudioBufferSourceNode;
}

export type MeterSnapshot = {
  tracks: Record<string, { peakDb: number; rmsDb: number }>;
  master: { peakDb: number; rmsDb: number };
};

type Listener = () => void;

export class Player {
  private ctx: AudioContext | null = null;
  private worker: Worker | null = null;
  private gain: GainNode | null = null;
  private gen = 0;
  private scheduled: ScheduledChunk[] = [];
  private nextWhen = 0;
  private pending = 0;
  private ended = false;
  private raf = 0;
  private song: Song | null = null;
  private sentAssets = new Set<string>();
  private pausedAtSeconds = 0;
  private loop: { start: number; end: number } | null = null;
  private metronome = false;
  private instruments: RenderInstrumentConfig | null = null;
  private listeners = new Set<Listener>();
  private lastError: string | null = null;
  playing = false;
  meters: MeterSnapshot | null = null;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get error(): string | null {
    return this.lastError;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./playback.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<PlaybackOutMessage>) => this.onWorkerMessage(ev.data);
    this.worker.onerror = (ev) => {
      this.lastError = ev.message || 'Playback worker error';
      this.emit();
    };
    this.post({ type: 'init', sampleRate: this.sampleRate });
    if (this.instruments) this.post({ type: 'instruments', ...this.instruments });
  }

  private post(msg: PlaybackInMessage, transfer: Transferable[] = []) {
    this.worker?.postMessage(msg, transfer);
  }

  private async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      // Re-init the worker at the device sample rate so no resampling is needed.
      this.ensureWorker();
      this.post({ type: 'init', sampleRate: this.ctx.sampleRate });
      if (this.song) this.post({ type: 'song', song: this.song });
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  setSong(song: Song) {
    this.song = song;
    this.ensureWorker();
    this.post({ type: 'song', song });
  }

  /** Custom instrument profiles and sampled instruments in scope (plugins, Settings, project). */
  setInstruments(config: RenderInstrumentConfig) {
    this.instruments = config;
    this.post({ type: 'instruments', ...config });
  }

  setMixer(mixer: MixerState) {
    if (this.song) this.song = { ...this.song, mixer };
    this.post({ type: 'mixer', mixer });
  }

  /** Make an audio asset available to the renderer (audio-track clips). */
  provideAsset(id: string, data: AudioData) {
    if (this.sentAssets.has(id)) return;
    this.ensureWorker();
    const channels = data.channels.map((c) => c.slice());
    this.post({ type: 'asset', id, sampleRate: data.sampleRate, channels }, channels.map((c) => c.buffer));
    this.sentAssets.add(id);
  }

  hasAsset(id: string): boolean {
    return this.sentAssets.has(id);
  }

  setMetronome(on: boolean) {
    this.metronome = on;
    this.post({ type: 'options', metronome: on });
  }

  setLoop(range: { start: number; end: number } | null) {
    this.loop = range;
    const sr = this.sampleRate;
    if (range) this.post({ type: 'loop', startFrame: Math.floor(range.start * sr), endFrame: Math.floor(range.end * sr) });
    else this.post({ type: 'loop', startFrame: null });
  }

  async play(fromSeconds?: number) {
    const ctx = await this.ensureContext();
    this.stopSources();
    this.gen++;
    const start = Math.max(0, fromSeconds ?? this.pausedAtSeconds);
    this.post({ type: 'loop', startFrame: this.loop ? Math.floor(this.loop.start * ctx.sampleRate) : null, endFrame: this.loop ? Math.floor(this.loop.end * ctx.sampleRate) : undefined });
    this.post({ type: 'options', metronome: this.metronome });
    this.post({ type: 'seek', frame: start * ctx.sampleRate, gen: this.gen });
    this.nextWhen = ctx.currentTime + 0.08;
    this.pending = 0;
    this.ended = false;
    this.playing = true;
    this.pausedAtSeconds = start;
    this.pump();
    this.startLoop();
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.pausedAtSeconds = this.position();
    this.playing = false;
    this.gen++;
    this.stopSources();
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  stop() {
    this.pause();
    this.pausedAtSeconds = 0;
    this.emit();
  }

  seek(seconds: number) {
    if (this.playing) void this.play(seconds);
    else {
      this.pausedAtSeconds = Math.max(0, seconds);
      this.emit();
    }
  }

  /** Current song position in seconds (compensated for output latency). */
  position(): number {
    if (!this.playing || !this.ctx) return this.pausedAtSeconds;
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    const now = this.ctx.currentTime - latency;
    const sr = this.ctx.sampleRate;
    let current: ScheduledChunk | undefined;
    for (const c of this.scheduled) {
      if (c.when <= now) current = c;
      else break;
    }
    if (!current) return this.pausedAtSeconds;
    const within = Math.min(current.frames, Math.max(0, (now - current.when) * sr));
    return (current.frame + within) / sr;
  }

  private stopSources() {
    for (const c of this.scheduled) {
      try {
        c.source.stop();
        c.source.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.scheduled = [];
  }

  private startLoop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.playing) return;
      this.pump();
      const ctx = this.ctx!;
      // Drop finished chunks.
      while (this.scheduled.length > 1 && this.scheduled[1].when < ctx.currentTime - 0.5) this.scheduled.shift();
      if (this.ended && this.pending === 0 && ctx.currentTime > this.nextWhen + 0.1) {
        this.playing = false;
        this.pausedAtSeconds = 0;
        this.emit();
        return;
      }
      this.emit();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private pump() {
    if (!this.playing || !this.ctx || this.ended) return;
    const ahead = this.nextWhen - this.ctx.currentTime;
    if (ahead < LOOKAHEAD_SECONDS && this.pending === 0) {
      const chunkSeconds = 4096 / this.ctx.sampleRate;
      const count = Math.max(1, Math.ceil((LOOKAHEAD_SECONDS - ahead) / chunkSeconds));
      this.pending = count;
      this.post({ type: 'pull', count, gen: this.gen });
    }
  }

  private onWorkerMessage(msg: PlaybackOutMessage) {
    if (msg.type === 'error') {
      this.lastError = msg.message;
      this.emit();
      return;
    }
    if (msg.type !== 'chunk') return;
    if (msg.gen !== this.gen || !this.ctx || !this.gain) return;
    this.pending = Math.max(0, this.pending - 1);
    if (msg.meters) this.meters = msg.meters;
    if (msg.frames > 0) {
      const buf = this.ctx.createBuffer(2, msg.frames, this.ctx.sampleRate);
      buf.copyToChannel(msg.left as Float32Array<ArrayBuffer>, 0);
      buf.copyToChannel(msg.right as Float32Array<ArrayBuffer>, 1);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      // If we fell behind (tab throttled), re-anchor slightly in the future.
      if (this.nextWhen < this.ctx.currentTime) this.nextWhen = this.ctx.currentTime + 0.03;
      src.start(this.nextWhen);
      this.scheduled.push({ when: this.nextWhen, frame: msg.frame, frames: msg.frames, source: src });
      this.nextWhen += msg.frames / this.ctx.sampleRate;
    }
    if (msg.ended) {
      this.ended = true;
      this.pending = 0;
    }
    this.pump();
  }

  setVolume(linear: number) {
    if (this.gain) this.gain.gain.value = linear;
  }

  dispose() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}

export const player = new Player();

// One audio context and playback worker per page: reload instead of hot-swapping.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
