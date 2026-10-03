import { bpmAtTick, createTimeMap, meterAtBar, tickToBar, type MixerState, type Song } from '@songdeck/core';
import { MicRecorder, type LevelReading, type RecorderPhase } from './capture-recorder';
import { player } from './player';

/**
 * Recording vocal takes over the playing song (spec §33 "Recorded Vocal").
 *
 * Count-in clicks → the recorder starts → song playback starts at the take position. The delay
 * between the first recorded sample and the first audible sample of the song (scheduling +
 * output latency) is measured from the player's latency-compensated position while recording;
 * the user's latency setting adds input/converter latency on top. The sum becomes the clip's
 * `offsetSeconds`, so what was sung lines up with what was heard.
 */

export interface TakeRecorderEvents {
  onPhase?(phase: RecorderPhase): void;
  onLevel?(level: LevelReading): void;
  onCountIn?(beat: number, of: number): void;
  onTime?(seconds: number): void;
  /** Playback reached the end of the take range (or the song ended): the view should stop. */
  onAutoStop?(): void;
  /** Measured playback start delay (seconds), once known. */
  onDelay?(seconds: number): void;
}

export interface TakeStartOptions {
  song: Song;
  startTick: number;
  /** Stop automatically shortly after this tick (end of section). */
  endTick?: number;
  countInBars: number;
  /** Hear the vocal guide (MIDI vocal / render / other takes) while recording. */
  guide: boolean;
  /** Track ids muted in the monitor mix when the guide is off. */
  vocalTrackIds: string[];
}

export interface TakeResult {
  bytes: Uint8Array;
  mimeType: string;
  durationSeconds: number;
  startTick: number;
  startSeconds: number;
  /** Measured delay from recording start to audible song start (seconds). */
  measuredDelaySeconds: number;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export class VocalTakeRecorder {
  private mic: MicRecorder;
  private recStart = 0;
  private delays: number[] = [];
  private raf = 0;
  private startSec = 0;
  private endSec: number | null = null;
  private startTick = 0;
  private restoreMixer: MixerState | null = null;
  private autoStopped = false;
  private sawPlayback = false;

  constructor(private events: TakeRecorderEvents = {}) {
    this.mic = new MicRecorder({
      onPhase: (p) => {
        if (p === 'recording') this.beginPlayback();
        this.events.onPhase?.(p);
      },
      onLevel: (l) => this.events.onLevel?.(l),
      onCountIn: (b, of) => this.events.onCountIn?.(b, of),
      onTime: (t) => this.events.onTime?.(t),
    });
  }

  setEvents(events: TakeRecorderEvents) {
    this.events = events;
  }

  get phase(): RecorderPhase {
    return this.mic.phase;
  }

  get isOpen(): boolean {
    return this.mic.isOpen;
  }

  open(deviceId?: string): Promise<void> {
    return this.mic.open(deviceId);
  }

  async start(o: TakeStartOptions): Promise<void> {
    const tm = createTimeMap(o.song);
    this.startTick = o.startTick;
    this.startSec = tm.tickToSeconds(o.startTick);
    this.endSec = o.endTick !== undefined ? tm.tickToSeconds(o.endTick) : null;
    this.delays = [];
    this.autoStopped = false;
    this.sawPlayback = false;
    if (player.playing) player.pause();
    if (!o.guide && o.vocalTrackIds.length) {
      // Monitor mix without the vocal guide (not committed — only the player's copy changes).
      this.restoreMixer = o.song.mixer;
      const channels = { ...o.song.mixer.channels };
      for (const id of o.vocalTrackIds) if (channels[id]) channels[id] = { ...channels[id], mute: true };
      player.setMixer({ ...o.song.mixer, channels });
    }
    const bar = tickToBar(o.song, o.startTick).bar;
    const meter = meterAtBar(o.song, bar);
    const bpm = bpmAtTick(o.song, o.startTick);
    // One click per beat of the bar (bpm is quarter notes per minute; x/8 meters click eighths).
    const clickBpm = (bpm * (meter.denominator || 4)) / 4;
    const countIn = o.countInBars > 0 ? { beats: Math.max(1, Math.round(o.countInBars * meter.numerator)), bpm: clickBpm, beatsPerBar: meter.numerator } : null;
    try {
      await this.mic.start({ countIn, maxSeconds: 900 });
    } catch (err) {
      this.restore();
      throw err;
    }
  }

  private beginPlayback() {
    this.recStart = performance.now();
    void player.play(this.startSec);
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (this.mic.phase !== 'recording') return;
      if (player.playing) {
        const pos = player.position();
        if (pos > this.startSec + 0.02) {
          this.sawPlayback = true;
          if (this.delays.length < 24) {
            const elapsed = (performance.now() - this.recStart) / 1000;
            this.delays.push(Math.max(0, elapsed - (pos - this.startSec)));
            if (this.delays.length === 8) this.events.onDelay?.(median(this.delays));
          }
        }
        if (this.endSec !== null && pos >= this.endSec + 0.4 && !this.autoStopped) {
          this.autoStopped = true;
          this.events.onAutoStop?.();
        }
      } else if (this.sawPlayback && !this.autoStopped) {
        // The song ended (or playback was stopped from the transport).
        this.autoStopped = true;
        this.events.onAutoStop?.();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private restore() {
    cancelAnimationFrame(this.raf);
    if (this.restoreMixer) {
      player.setMixer(this.restoreMixer);
      this.restoreMixer = null;
    }
  }

  /** Stop recording and playback; returns the encoded take with its timing. */
  async stop(): Promise<TakeResult> {
    try {
      const res = await this.mic.stop();
      return {
        bytes: res.bytes,
        mimeType: res.mimeType,
        durationSeconds: res.durationSeconds,
        startTick: this.startTick,
        startSeconds: this.startSec,
        measuredDelaySeconds: this.delays.length ? median(this.delays) : 0.08,
      };
    } finally {
      if (player.playing) player.pause();
      this.restore();
    }
  }

  cancel() {
    this.mic.cancel();
    if (player.playing) player.pause();
    this.restore();
  }

  close() {
    this.cancel();
    this.mic.close();
  }
}
