/**
 * Voice plumbing shared by every synthesis engine.
 *
 * A PolyInstrument owns a fixed pool of voices (allocated once). Voices ADD their output into the
 * instrument's block buffers. Mono-output patches only use `L` (the instrument copies it to `R`).
 */
import type { Articulation } from '@songdeck/core';

export const ART_STACCATO = 1;
export const ART_LEGATO = 2;
export const ART_ACCENT = 4;
export const ART_PALM = 8;
export const ART_PIZZ = 16;
export const ART_TREMOLO = 32;
export const ART_GHOST = 64;
export const ART_SLIDE = 128;
export const ART_BEND = 256;
export const ART_HARMONIC = 512;
export const ART_DEAD = 1024;
export const ART_MARCATO = 2048;
export const ART_TENUTO = 4096;

export function articulationFlag(a: Articulation | undefined): number {
  switch (a) {
    case 'staccato':
      return ART_STACCATO;
    case 'legato':
      return ART_LEGATO;
    case 'accent':
      return ART_ACCENT;
    case 'marcato':
      return ART_MARCATO | ART_ACCENT;
    case 'tenuto':
      return ART_TENUTO;
    case 'palm-mute':
      return ART_PALM;
    case 'pizzicato':
      return ART_PIZZ;
    case 'tremolo':
      return ART_TREMOLO;
    case 'ghost':
      return ART_GHOST;
    case 'slide':
      return ART_SLIDE;
    case 'bend':
      return ART_BEND;
    case 'harmonic':
      return ART_HARMONIC;
    case 'dead':
      return ART_DEAD;
    default:
      return 0;
  }
}

/** A scheduled note (frames are absolute, relative to the render start). Built once per song update. */
export interface NoteEvent {
  id: string;
  /** Index in the track's (sorted) event list. */
  index: number;
  start: number;
  end: number;
  /** MIDI pitch (sounding). */
  pitch: number;
  /** 1..127 after articulation adjustments. */
  velocity: number;
  /** Articulation flags (ART_*). */
  art: number;
  /** Deterministic per-note seed. */
  seed: number;
  /** Tempo at the note start (for tempo-synced articulations). */
  bpm: number;
  /** Pitch to glide/slide from (-1 = none). */
  fromPitch: number;
  /** Continue the previous voice (mono legato / hammer-on / portamento). */
  legato: boolean;
  /** Stereo position -1..1 suggested by the instrument (drums/piano spread). */
  pan: number;
}

export interface VoiceHost {
  readonly sampleRate: number;
  /** Shared scratch buffer (BLOCK sized) voices may use for envelopes. */
  readonly scratch: Float64Array;
  readonly scratch2: Float64Array;
}

export abstract class Voice {
  active = false;
  note: NoteEvent | null = null;
  pitch = 0;
  /** Absolute frame the note started (oldest-voice stealing). */
  startFrame = 0;
  /** Absolute frame at which the note releases. */
  endFrame = 0;
  released = false;
  killed = false;
  /** First sample offset to render in the current block (mid-block note-on). */
  renderFrom = 0;

  constructor(protected readonly host: VoiceHost) {}

  /** Fresh note-on. */
  abstract start(ev: NoteEvent): void;
  /** Note-off (enter release). */
  abstract release(): void;
  /** Fast fade-out (stealing / choke). */
  abstract kill(): void;
  /** Add output into L/R for [start, end). Must set `active = false` when silent. */
  abstract render(L: Float64Array, R: Float64Array, start: number, end: number): void;
  /** Rough current amplitude (quietest-voice stealing). */
  abstract level(): number;

  /** Legato transition to a new note without re-attack. Return false if unsupported. */
  glideTo(_ev: NoteEvent): boolean {
    return false;
  }

  /** Re-strike the same pitch reusing this voice (sustained synths). Return false if unsupported. */
  retrigger(_ev: NoteEvent): boolean {
    return false;
  }

  /** Reset to idle (seek). */
  reset(): void {
    this.active = false;
    this.note = null;
    this.released = false;
    this.killed = false;
    this.renderFrom = 0;
  }

  protected begin(ev: NoteEvent): void {
    this.active = true;
    this.note = ev;
    this.pitch = ev.pitch;
    this.startFrame = ev.start;
    this.endFrame = ev.end;
    this.released = false;
    this.killed = false;
  }
}

/** Equal-power pan gains with unity at center: returns [gL, gR]. */
export function panGains(pan: number, out: Float64Array): void {
  const p = Math.max(-1, Math.min(1, pan));
  const a = ((p + 1) * Math.PI) / 4;
  out[0] = Math.cos(a) * Math.SQRT2;
  out[1] = Math.sin(a) * Math.SQRT2;
}
