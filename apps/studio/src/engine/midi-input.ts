import type { CapturedNote } from './midi-take';

/**
 * MIDI keyboard capture over the Web MIDI API (spec §27: "play an instrument … and convert that
 * performance into MIDI").
 *
 * Onsets are read from a caller-supplied song clock (the player's latency-compensated position
 * while recording over playback), corrected for delivery delay with each event's timestamp.
 * Lengths come from event timestamps, so a note held across a loop wrap keeps its real length.
 * The sustain pedal (CC 64) holds note-offs until it is released.
 */

export interface MidiInputInfo {
  id: string;
  name: string;
  manufacturer: string;
}

let access: Promise<MIDIAccess> | null = null;

export function midiSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

/** Ask for MIDI access once per session (the browser may show a permission prompt). */
export function requestMidiAccess(): Promise<MIDIAccess> {
  if (!midiSupported()) {
    return Promise.reject(
      new Error(
        'This browser has no Web MIDI support. Use Chrome, Edge or Opera, or record audio in Transcribe mode instead.',
      ),
    );
  }
  access ??= navigator.requestMIDIAccess({ sysex: false }).catch((err: unknown) => {
    access = null;
    throw err instanceof Error ? err : new Error(String(err));
  });
  return access;
}

export async function listMidiInputs(): Promise<MidiInputInfo[]> {
  const a = await requestMidiAccess();
  return Array.from(a.inputs.values()).map((i) => ({
    id: i.id,
    name: i.name || 'MIDI input',
    manufacturer: i.manufacturer || '',
  }));
}

export interface CaptureOptions {
  /** Current song position in seconds. */
  clock: () => number;
  /** Capture one input only (default: every connected input, including ones plugged in later). */
  inputId?: string;
  onNoteOn?: (pitch: number, velocity: number) => void;
  onNoteOff?: (pitch: number) => void;
}

interface Held {
  velocity: number;
  start: number;
  /** Event timestamp (ms, performance clock) of the note-on. */
  at: number;
}

const MAX_DELIVERY_DELAY = 0.2;

export class MidiCapture {
  private inputs = new Set<MIDIInput>();
  private held = new Map<number, Held>();
  private sustained = new Map<number, Held>();
  private pedal = false;
  private notes: CapturedNote[] = [];
  private midi: MIDIAccess | null = null;
  private readonly onMessage = (e: Event) => this.handle(e as MIDIMessageEvent);
  private readonly onState = (e: Event) => {
    const port = (e as MIDIConnectionEvent).port;
    if (port && port.type === 'input' && port.state === 'connected') this.attach(port as MIDIInput);
  };

  constructor(private readonly opts: CaptureOptions) {}

  /** Start listening; resolves to the number of inputs attached. */
  async start(): Promise<number> {
    this.midi = await requestMidiAccess();
    for (const input of this.midi.inputs.values()) this.attach(input);
    if (!this.opts.inputId) this.midi.addEventListener('statechange', this.onState);
    return this.inputs.size;
  }

  /** Notes captured so far (completed notes only). */
  get count(): number {
    return this.notes.length;
  }

  /** Stop listening and return the take; notes still held end now. */
  stop(): CapturedNote[] {
    const nowMs = performance.now();
    for (const [pitch, h] of [...this.held, ...this.sustained]) this.close(pitch, h, nowMs);
    this.held.clear();
    this.sustained.clear();
    for (const input of this.inputs) input.removeEventListener('midimessage', this.onMessage);
    this.inputs.clear();
    this.midi?.removeEventListener('statechange', this.onState);
    this.midi = null;
    return [...this.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  }

  private attach(input: MIDIInput) {
    if (this.inputs.has(input) || (this.opts.inputId && input.id !== this.opts.inputId)) return;
    this.inputs.add(input);
    input.addEventListener('midimessage', this.onMessage);
  }

  private handle(e: MIDIMessageEvent) {
    const data = e.data;
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0;
    const at = e.timeStamp || performance.now();
    if (status === 0x90 && data.length >= 3 && data[2] > 0) this.noteOn(data[1], data[2], at);
    else if (status === 0x80 || (status === 0x90 && data.length >= 3 && data[2] === 0))
      this.noteOff(data[1], at);
    else if (status === 0xb0 && data.length >= 3 && data[1] === 64) this.setPedal(data[2] >= 64, at);
  }

  private noteOn(pitch: number, velocity: number, at: number) {
    // A re-struck key ends the previous note (held or sustained) first.
    const prev = this.held.get(pitch) ?? this.sustained.get(pitch);
    if (prev) this.close(pitch, prev, at);
    this.sustained.delete(pitch);
    const delay = Math.min(MAX_DELIVERY_DELAY, Math.max(0, (performance.now() - at) / 1000));
    this.held.set(pitch, { velocity, start: Math.max(0, this.opts.clock() - delay), at });
    this.opts.onNoteOn?.(pitch, velocity);
  }

  private noteOff(pitch: number, at: number) {
    const h = this.held.get(pitch);
    if (!h) return;
    this.held.delete(pitch);
    if (this.pedal) {
      this.sustained.set(pitch, h);
      return;
    }
    this.close(pitch, h, at);
    this.opts.onNoteOff?.(pitch);
  }

  private setPedal(down: boolean, at: number) {
    this.pedal = down;
    if (down) return;
    for (const [pitch, h] of this.sustained) {
      this.close(pitch, h, at);
      this.opts.onNoteOff?.(pitch);
    }
    this.sustained.clear();
  }

  private close(pitch: number, h: Held, atMs: number) {
    const seconds = Math.max(0, (atMs - h.at) / 1000);
    this.notes.push({ pitch, velocity: h.velocity, start: h.start, end: h.start + seconds });
  }
}

/** Low-latency monitor so the player hears the keyboard while recording (any MIDI keyboard, even silent ones). */
export class MonitorSynth {
  private ctx: AudioContext | null = null;
  private voices = new Map<number, { osc: OscillatorNode; gain: GainNode }>();

  noteOn(pitch: number, velocity: number) {
    try {
      this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
      const ctx = this.ctx;
      if (ctx.state === 'suspended') void ctx.resume();
      this.noteOff(pitch);
      const t = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime((velocity / 127) * 0.16, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0005, (velocity / 127) * 0.05), t + 0.6);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2400;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 440 * Math.pow(2, (pitch - 69) / 12);
      osc.connect(filter).connect(gain).connect(ctx.destination);
      osc.start(t);
      this.voices.set(pitch, { osc, gain });
    } catch {
      /* audio unavailable: recording still works */
    }
  }

  noteOff(pitch: number) {
    const v = this.voices.get(pitch);
    if (!v || !this.ctx) return;
    this.voices.delete(pitch);
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(Math.max(0.0001, v.gain.gain.value), t);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    v.osc.stop(t + 0.15);
  }

  allOff() {
    for (const pitch of [...this.voices.keys()]) this.noteOff(pitch);
  }
}
