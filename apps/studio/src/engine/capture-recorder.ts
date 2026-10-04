/**
 * Human performance capture from the microphone (spec §27: hum a melody, sing a bass line,
 * clap a drum pattern, play an instrument).
 *
 * getUserMedia (with voice processing disabled — echo cancellation, noise suppression and AGC
 * all distort pitch and dynamics) → live input level (AnalyserNode) → optional count-in clicks
 * scheduled sample-accurately on the same AudioContext → MediaRecorder. The recorder starts
 * exactly when the count-in ends, so time 0 of the recording is bar 1, beat 1.
 */

export type MicErrorKind = 'unsupported' | 'insecure' | 'denied' | 'no-device' | 'busy' | 'unknown';

export class MicError extends Error {
  constructor(
    readonly kind: MicErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'MicError';
  }
}

/** Human-readable explanation for any getUserMedia / MediaRecorder failure. */
export function describeMicError(err: unknown): MicError {
  if (err instanceof MicError) return err;
  const name =
    err instanceof Error || (typeof DOMException !== 'undefined' && err instanceof DOMException)
      ? (err as Error).name
      : '';
  const detail = err instanceof Error ? err.message : String(err);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new MicError(
        'denied',
        'Microphone access was blocked. Allow the microphone for this site in your browser (address-bar permissions), then try again — or upload a recording instead.',
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new MicError(
        'no-device',
        'No microphone was found. Connect one (or choose an input in your system settings) and try again, or upload a recording.',
      );
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new MicError(
        'busy',
        'The microphone could not be started — it may be in use by another application.',
      );
    default:
      return new MicError('unknown', `Could not use the microphone: ${detail || 'unknown error'}`);
  }
}

export function micSupport(): { ok: boolean; reason?: MicError } {
  if (typeof window === 'undefined')
    return { ok: false, reason: new MicError('unsupported', 'No browser environment.') };
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: new MicError(
        'insecure',
        'Recording needs a secure connection (https or localhost). Upload a recording instead.',
      ),
    };
  }
  if (!navigator.mediaDevices?.getUserMedia)
    return {
      ok: false,
      reason: new MicError(
        'unsupported',
        'This browser cannot record from a microphone. Upload a recording instead.',
      ),
    };
  if (typeof MediaRecorder === 'undefined')
    return {
      ok: false,
      reason: new MicError('unsupported', 'This browser has no MediaRecorder. Upload a recording instead.'),
    };
  return { ok: true };
}

export type RecorderPhase = 'idle' | 'requesting' | 'ready' | 'count-in' | 'recording' | 'stopping';

export interface LevelReading {
  rmsDb: number;
  peakDb: number;
}

export interface RecordingResult {
  bytes: Uint8Array;
  mimeType: string;
  durationSeconds: number;
}

export interface RecorderEvents {
  onPhase?(phase: RecorderPhase): void;
  onLevel?(level: LevelReading): void;
  /** Count-in beat about to sound (1-based) — for a visual countdown. */
  onCountIn?(beat: number, of: number): void;
  /** Seconds recorded so far (while recording). */
  onTime?(seconds: number): void;
}

const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function')
    return undefined;
  return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
}

/** Schedule metronome clicks on a context (used for the count-in). Returns the time after the last beat. */
export function scheduleClicks(
  ctx: BaseAudioContext,
  startAt: number,
  beats: number,
  bpm: number,
  beatsPerBar = beats,
): number {
  const beat = 60 / bpm;
  for (let i = 0; i < beats; i++) {
    const t = startAt + i * beat;
    const accent = i % beatsPerBar === 0;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1760 : 1175;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(accent ? 0.22 : 0.14, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  }
  return startAt + beats * beat;
}

export class MicRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private raf = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private startedAt = 0;
  private stopResolve: ((r: RecordingResult) => void) | null = null;
  private stopReject: ((e: Error) => void) | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  phase: RecorderPhase = 'idle';

  constructor(private events: RecorderEvents = {}) {}

  setEvents(events: RecorderEvents) {
    this.events = events;
  }

  private setPhase(p: RecorderPhase) {
    this.phase = p;
    this.events.onPhase?.(p);
  }

  /** Ask for the microphone and start the level meter. Throws MicError. */
  async open(deviceId?: string): Promise<void> {
    if (this.stream) return;
    const support = micSupport();
    if (!support.ok) throw support.reason!;
    this.setPhase('requesting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      this.setPhase('idle');
      throw describeMicError(err);
    }
    const Ctx: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);
    this.setPhase('ready');
    this.meterLoop();
  }

  get isOpen(): boolean {
    return !!this.stream;
  }

  private meterLoop() {
    const analyser = this.analyser;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    let lastTime = -1;
    const tick = () => {
      if (!this.analyser) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        sum += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / buf.length);
      this.events.onLevel?.({ rmsDb: 20 * Math.log10(rms + 1e-9), peakDb: 20 * Math.log10(peak + 1e-9) });
      if (this.phase === 'recording') {
        const t = Math.floor((performance.now() - this.startedAt) / 100) / 10;
        if (t !== lastTime) {
          lastTime = t;
          this.events.onTime?.(t);
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /**
   * Start recording, optionally after a count-in at `bpm` (`beats` clicks). Resolves once the
   * recorder is actually running. Use `stop()` to finish.
   */
  async start(
    opts: { countIn?: { beats: number; bpm: number; beatsPerBar?: number } | null; maxSeconds?: number } = {},
  ): Promise<void> {
    if (!this.stream || !this.ctx) await this.open();
    if (this.phase === 'recording' || this.phase === 'count-in') return;
    const ctx = this.ctx!;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    const mime = pickMime();
    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(this.stream!, { mimeType: mime }) : new MediaRecorder(this.stream!);
    } catch (err) {
      throw describeMicError(err);
    }
    this.recorder = recorder;
    this.chunks = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    recorder.onstop = async () => {
      const type = recorder.mimeType || mime || 'audio/webm';
      const blob = new Blob(this.chunks, { type });
      const durationSeconds = (performance.now() - this.startedAt) / 1000;
      this.chunks = [];
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        this.setPhase(this.stream ? 'ready' : 'idle');
        this.stopResolve?.({ bytes, mimeType: type.split(';')[0], durationSeconds });
      } catch (err) {
        this.stopReject?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        this.stopResolve = null;
        this.stopReject = null;
      }
    };
    recorder.onerror = (ev) => {
      const err = (ev as unknown as { error?: Error }).error ?? new Error('Recording failed');
      this.stopReject?.(describeMicError(err));
    };

    const beginRecording = () => {
      try {
        recorder.start(250);
      } catch (err) {
        this.setPhase('ready');
        throw describeMicError(err);
      }
      this.startedAt = performance.now();
      this.setPhase('recording');
      if (opts.maxSeconds)
        this.maxTimer = setTimeout(() => void this.stop().catch(() => undefined), opts.maxSeconds * 1000);
    };

    const ci = opts.countIn;
    if (ci && ci.beats > 0 && ci.bpm > 0) {
      this.setPhase('count-in');
      const t0 = ctx.currentTime + 0.12;
      const end = scheduleClicks(ctx, t0, ci.beats, ci.bpm, ci.beatsPerBar ?? ci.beats);
      const beat = 60 / ci.bpm;
      for (let i = 0; i < ci.beats; i++) {
        this.timers.push(
          setTimeout(
            () => this.events.onCountIn?.(i + 1, ci.beats),
            Math.max(0, (t0 + i * beat - ctx.currentTime) * 1000),
          ),
        );
      }
      await new Promise<void>((resolve, reject) => {
        this.timers.push(
          setTimeout(
            () => {
              try {
                if (this.phase !== 'count-in') return resolve(); // cancelled
                beginRecording();
                resolve();
              } catch (err) {
                reject(err);
              }
            },
            Math.max(0, (end - ctx.currentTime) * 1000 - 4),
          ),
        );
      });
    } else beginRecording();
  }

  /** Stop and return the encoded recording. */
  stop(): Promise<RecordingResult> {
    const rec = this.recorder;
    this.clearTimers();
    if (!rec || rec.state === 'inactive') {
      this.setPhase(this.stream ? 'ready' : 'idle');
      return Promise.reject(new Error('Not recording'));
    }
    this.setPhase('stopping');
    return new Promise<RecordingResult>((resolve, reject) => {
      this.stopResolve = resolve;
      this.stopReject = reject;
      try {
        rec.requestData();
      } catch {
        /* some browsers throw when no data is pending */
      }
      rec.stop();
    });
  }

  /** Abort a count-in or recording without producing a result. */
  cancel() {
    this.clearTimers();
    const rec = this.recorder;
    this.stopResolve = null;
    this.stopReject = null;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    this.recorder = null;
    this.chunks = [];
    this.setPhase(this.stream ? 'ready' : 'idle');
  }

  /** Release the microphone. */
  close() {
    this.cancel();
    cancelAnimationFrame(this.raf);
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.analyser = null;
    this.source = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.setPhase('idle');
  }

  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
  }
}

/** Available audio inputs (labels are only present after permission was granted). */
export async function listInputs(): Promise<MediaDeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}
