/**
 * Deterministic synthetic test signals for the analysis tests (no dependency on dsp/).
 * Every generator is a pure function of its arguments; randomness comes from a seeded LCG.
 */
import type { AudioData } from '../src/types';

export function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function midiHz(p: number): number {
  return 440 * Math.pow(2, (p - 69) / 12);
}

export function mono(sampleRate: number, x: Float32Array): AudioData {
  return { sampleRate, channels: [x] };
}

export function stereo(sampleRate: number, l: Float32Array, r: Float32Array): AudioData {
  return { sampleRate, channels: [l, r] };
}

export function silence(sampleRate: number, seconds: number): Float32Array {
  return new Float32Array(Math.round(sampleRate * seconds));
}

export function sine(sampleRate: number, seconds: number, hz: number, amp = 0.5): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return x;
}

export interface ToneOptions {
  /** Partial amplitudes relative to the fundamental (index 0 = fundamental). */
  partials?: number[];
  amp?: number;
  attack?: number;
  release?: number;
  /** Exponential decay time constant (s); 0 = sustained. */
  decay?: number;
  vibratoHz?: number;
  vibratoCents?: number;
  /** Seconds before vibrato starts. */
  vibratoDelay?: number;
  /** Linear pitch drift over the note, cents. */
  driftCents?: number;
  /** Start pitch offset (cents) gliding to 0 over `scoopSeconds`. */
  scoopCents?: number;
  scoopSeconds?: number;
  /** Inharmonicity coefficient (piano-like stretched partials). */
  inharmonicity?: number;
}

/** Add a harmonic tone (pitch in fractional MIDI) into `out` starting at `start` seconds. */
export function addTone(out: Float32Array, sampleRate: number, start: number, duration: number, pitch: number, o: ToneOptions = {}): void {
  const partials = o.partials ?? [1, 0.5, 0.33, 0.25, 0.2];
  const amp = o.amp ?? 0.3;
  const attack = o.attack ?? 0.01;
  const release = o.release ?? 0.03;
  const s0 = Math.round(start * sampleRate);
  const n = Math.round(duration * sampleRate);
  const phases = new Float64Array(partials.length);
  const f0 = midiHz(pitch);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const idx = s0 + i;
    if (idx < 0 || idx >= out.length) continue;
    let cents = 0;
    if (o.vibratoHz && o.vibratoCents && t >= (o.vibratoDelay ?? 0)) {
      const vt = t - (o.vibratoDelay ?? 0);
      const ramp = Math.min(1, vt / 0.1);
      cents += ramp * o.vibratoCents * Math.sin(2 * Math.PI * o.vibratoHz * vt);
    }
    if (o.driftCents) cents += (o.driftCents * t) / duration;
    if (o.scoopCents && o.scoopSeconds && t < o.scoopSeconds) cents += o.scoopCents * (1 - t / o.scoopSeconds);
    const f = f0 * Math.pow(2, cents / 1200);
    let env = 1;
    if (t < attack) env = t / attack;
    if (t > duration - release) env *= Math.max(0, (duration - t) / release);
    if (o.decay) env *= Math.exp(-t / o.decay);
    let v = 0;
    for (let h = 0; h < partials.length; h++) {
      const k = h + 1;
      const stretch = o.inharmonicity ? Math.sqrt(1 + o.inharmonicity * k * k) : 1;
      const fh = f * k * stretch;
      if (fh >= sampleRate / 2) break;
      phases[h] += (2 * Math.PI * fh) / sampleRate;
      v += partials[h] * Math.sin(phases[h]);
    }
    out[idx] += amp * env * v;
  }
}

/** RBJ-cookbook biquad (direct form I). */
function biquad(type: 'lp' | 'hp', fc: number, sampleRate: number, q = 0.707): (x: number) => number {
  const w0 = (2 * Math.PI * Math.min(fc, sampleRate * 0.49)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = type === 'lp' ? (1 - cos) / 2 : (1 + cos) / 2;
  const b1 = type === 'lp' ? 1 - cos : -(1 + cos);
  const b2 = b0;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x: number) => {
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

export function addNoiseBurst(
  out: Float32Array,
  sampleRate: number,
  start: number,
  opts: { amp: number; decay: number; duration?: number; highpassHz?: number; lowpassHz?: number; seed: number },
): void {
  const rnd = lcg(opts.seed);
  const s0 = Math.round(start * sampleRate);
  const n = Math.round((opts.duration ?? opts.decay * 6) * sampleRate);
  const hp = opts.highpassHz ? [biquad('hp', opts.highpassHz, sampleRate), biquad('hp', opts.highpassHz, sampleRate)] : [];
  const lp = opts.lowpassHz && opts.lowpassHz < sampleRate * 0.45 ? [biquad('lp', opts.lowpassHz, sampleRate), biquad('lp', opts.lowpassHz, sampleRate)] : [];
  for (let i = 0; i < n; i++) {
    const idx = s0 + i;
    if (idx >= out.length) break;
    let v = rnd() * 2 - 1;
    for (const f of hp) v = f(v);
    for (const f of lp) v = f(v);
    const fade = Math.min(1, (n - i) / (0.02 * sampleRate));
    const env = Math.exp(-(i / sampleRate) / opts.decay) * Math.min(1, i / (0.0015 * sampleRate)) * fade;
    if (idx >= 0) out[idx] += opts.amp * env * v;
  }
}

export function addKick(out: Float32Array, sampleRate: number, start: number, amp = 0.9, seed = 1): void {
  const s0 = Math.round(start * sampleRate);
  const n = Math.round(0.45 * sampleRate);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const idx = s0 + i;
    if (idx >= out.length) break;
    const t = i / sampleRate;
    const f = 50 + 110 * Math.exp(-t / 0.03);
    phase += (2 * Math.PI * f) / sampleRate;
    const fade = Math.min(1, (n - i) / (0.05 * sampleRate));
    const env = Math.exp(-t / 0.13) * Math.min(1, i / (0.001 * sampleRate)) * fade;
    if (idx >= 0) out[idx] += amp * env * Math.sin(phase);
  }
  addNoiseBurst(out, sampleRate, start, { amp: amp * 0.15, decay: 0.004, lowpassHz: 3000, seed });
}

export function addSnare(out: Float32Array, sampleRate: number, start: number, amp = 0.6, seed = 2): void {
  const s0 = Math.round(start * sampleRate);
  const n = Math.round(0.3 * sampleRate);
  for (let i = 0; i < n; i++) {
    const idx = s0 + i;
    if (idx >= out.length) break;
    const t = i / sampleRate;
    const env = Math.exp(-t / 0.06) * Math.min(1, (n - i) / (0.03 * sampleRate));
    if (idx >= 0) out[idx] += amp * 0.5 * env * Math.sin(2 * Math.PI * 185 * t);
  }
  addNoiseBurst(out, sampleRate, start, { amp: amp * 0.8, decay: 0.09, highpassHz: 900, lowpassHz: 9000, seed });
}

export function addHat(out: Float32Array, sampleRate: number, start: number, amp = 0.25, open = false, seed = 3): void {
  addNoiseBurst(out, sampleRate, start, { amp, decay: open ? 0.22 : 0.025, highpassHz: 7000, seed });
}

export function addCrash(out: Float32Array, sampleRate: number, start: number, amp = 0.35, seed = 4): void {
  addNoiseBurst(out, sampleRate, start, { amp, decay: 0.9, highpassHz: 2500, seed });
}

export function addTom(out: Float32Array, sampleRate: number, start: number, hz: number, amp = 0.6): void {
  const s0 = Math.round(start * sampleRate);
  const n = Math.round(0.6 * sampleRate);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const idx = s0 + i;
    if (idx >= out.length) break;
    const t = i / sampleRate;
    const f = hz * (1 + 0.15 * Math.exp(-t / 0.05));
    phase += (2 * Math.PI * f) / sampleRate;
    const fade = Math.min(1, (n - i) / (0.05 * sampleRate));
    const env = Math.exp(-t / 0.2) * Math.min(1, i / (0.001 * sampleRate)) * fade;
    if (idx >= 0) out[idx] += amp * env * (Math.sin(phase) + 0.2 * Math.sin(2 * phase));
  }
}

export function addClick(out: Float32Array, sampleRate: number, start: number, amp = 0.8, hz = 1500): void {
  const s0 = Math.round(start * sampleRate);
  const n = Math.round(0.03 * sampleRate);
  for (let i = 0; i < n; i++) {
    const idx = s0 + i;
    if (idx >= out.length || idx < 0) continue;
    const t = i / sampleRate;
    out[idx] += amp * Math.exp(-t / 0.006) * Math.sin(2 * Math.PI * hz * t);
  }
}

/** Click track; the first beat of each bar is accented (higher and louder) when `accent`. */
export function clickTrack(sampleRate: number, bpm: number, seconds: number, opts: { beatsPerBar?: number; accent?: boolean; offset?: number } = {}): Float32Array {
  const x = silence(sampleRate, seconds);
  const period = 60 / bpm;
  const bpb = opts.beatsPerBar ?? 4;
  let i = 0;
  for (let t = opts.offset ?? 0; t < seconds - 0.05; t += period, i++) {
    const down = i % bpb === 0;
    addClick(x, sampleRate, t, opts.accent && down ? 0.9 : 0.5, opts.accent && down ? 2000 : 1200);
  }
  return x;
}

export type DrumEvent = { time: number; drum: 'kick' | 'snare' | 'hat' | 'open-hat' | 'crash' | 'tom'; hz?: number };

/** Rock beat: kick 1 & 3, snare 2 & 4, closed hats on eighths. */
export function rockBeat(bpm: number, bars: number, opts: { offset?: number; beatsPerBar?: number; hats?: boolean } = {}): DrumEvent[] {
  const ev: DrumEvent[] = [];
  const beat = 60 / bpm;
  const bpb = opts.beatsPerBar ?? 4;
  const off = opts.offset ?? 0;
  for (let b = 0; b < bars; b++) {
    for (let q = 0; q < bpb; q++) {
      const t = off + (b * bpb + q) * beat;
      if (bpb === 3) {
        if (q === 0) ev.push({ time: t, drum: 'kick' });
        else ev.push({ time: t, drum: 'snare' });
      } else if (q % 2 === 0) ev.push({ time: t, drum: 'kick' });
      else ev.push({ time: t, drum: 'snare' });
      if (opts.hats !== false) {
        ev.push({ time: t, drum: 'hat' });
        ev.push({ time: t + beat / 2, drum: 'hat' });
      }
    }
  }
  return ev;
}

export function renderDrums(sampleRate: number, seconds: number, events: DrumEvent[], gain = 1): Float32Array {
  const x = silence(sampleRate, seconds);
  let seed = 11;
  for (const e of events) {
    seed++;
    if (e.drum === 'kick') addKick(x, sampleRate, e.time, 0.9 * gain, seed);
    else if (e.drum === 'snare') addSnare(x, sampleRate, e.time, 0.6 * gain, seed);
    else if (e.drum === 'hat') addHat(x, sampleRate, e.time, 0.22 * gain, false, seed);
    else if (e.drum === 'open-hat') addHat(x, sampleRate, e.time, 0.22 * gain, true, seed);
    else if (e.drum === 'crash') addCrash(x, sampleRate, e.time, 0.35 * gain, seed);
    else if (e.drum === 'tom') addTom(x, sampleRate, e.time, e.hz ?? 120, 0.6 * gain);
  }
  return x;
}

export interface MelodyNote {
  pitch: number;
  start: number;
  duration: number;
}

/** A sung/hummed melody: scoops, vibrato, drift, breath noise, global detune. */
export function hummedMelody(sampleRate: number, notes: MelodyNote[], opts: { detuneCents?: number; seed?: number; seconds?: number; breath?: number; partials?: number[] } = {}): Float32Array {
  const end = Math.max(...notes.map((n) => n.start + n.duration)) + 0.5;
  const x = silence(sampleRate, opts.seconds ?? end);
  const rnd = lcg(opts.seed ?? 5);
  for (const n of notes) {
    addTone(x, sampleRate, n.start, n.duration, n.pitch + (opts.detuneCents ?? 0) / 100 + (rnd() - 0.5) * 0.2, {
      partials: opts.partials ?? [1, 0.35, 0.12, 0.05],
      amp: 0.25 + rnd() * 0.1,
      attack: 0.04,
      release: 0.06,
      vibratoHz: 5 + rnd() * 1.5,
      vibratoCents: 20 + rnd() * 25,
      vibratoDelay: 0.12,
      driftCents: (rnd() - 0.5) * 30,
      scoopCents: -(20 + rnd() * 40),
      scoopSeconds: 0.06,
    });
  }
  if (opts.breath) {
    const r2 = lcg((opts.seed ?? 5) + 99);
    for (let i = 0; i < x.length; i++) x[i] += opts.breath * (r2() * 2 - 1);
  }
  return x;
}

/** Pitch-class sets of the chords used by the tests. */
export const CHORD_TONES: Record<string, number[]> = {
  Em: [52, 55, 59],
  C: [48, 52, 55],
  G: [55, 59, 62],
  D: [50, 54, 57],
  Am: [57, 60, 64],
  B7: [47, 51, 54, 57],
  B: [47, 51, 54],
  F: [53, 57, 60],
};

export const CHORD_ROOT: Record<string, number> = { Em: 40, C: 36, G: 43, D: 38, Am: 45, B7: 35, B: 35, F: 41 };

/** Block chords of harmonic tones, with an optional bass note an octave+ below. */
export function chordBlocks(sampleRate: number, chords: { symbol: string; duration: number }[], opts: { bass?: boolean; amp?: number; partials?: number[] } = {}): Float32Array {
  const total = chords.reduce((a, c) => a + c.duration, 0) + 0.3;
  const x = silence(sampleRate, total);
  let t = 0;
  for (const c of chords) {
    for (const p of CHORD_TONES[c.symbol]) {
      addTone(x, sampleRate, t, c.duration, p + 12, { amp: opts.amp ?? 0.12, partials: opts.partials ?? [1, 0.5, 0.33, 0.25, 0.2, 0.16], attack: 0.02, release: 0.05 });
    }
    if (opts.bass !== false) addTone(x, sampleRate, t, c.duration, CHORD_ROOT[c.symbol], { amp: 0.16, partials: [1, 0.6, 0.3, 0.2], attack: 0.01, release: 0.05 });
    t += c.duration;
  }
  return x;
}

export function addInto(dst: Float32Array, src: Float32Array, gain = 1): Float32Array {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] += src[i] * gain;
  return dst;
}

export function energy(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return s;
}

export function correlation(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

export interface SynthSongSection {
  label: string;
  bars: number;
  chords: string[];
  /** 0..1 */
  energy: number;
}

export interface SynthSong {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
  bpm: number;
  /** Section start times (s). */
  sectionStarts: number[];
  chords: { start: number; end: number; symbol: string }[];
  melody: MelodyNote[];
  bassNotes: MelodyNote[];
  drums: DrumEvent[];
  stems: { drums: Float32Array; bass: Float32Array; vocals: Float32Array; padL: Float32Array; padR: Float32Array };
}

/**
 * A small arrangement: drums (energy-dependent pattern), bass on chord roots, a centred sung
 * melody (vibrato) and a wide pad (left/right voicings differ). One chord per bar.
 */
export function synthSong(sampleRate: number, sections: SynthSongSection[], opts: { bpm?: number; lead?: number; tail?: number; vocalGain?: number } = {}): SynthSong {
  const bpm = opts.bpm ?? 120;
  const beat = 60 / bpm;
  const bar = 4 * beat;
  const lead = opts.lead ?? 0.25;
  const totalBars = sections.reduce((a, s) => a + s.bars, 0);
  const seconds = lead + totalBars * bar + (opts.tail ?? 1);
  const drumsEv: DrumEvent[] = [];
  const bass = silence(sampleRate, seconds);
  const padL = silence(sampleRate, seconds);
  const padR = silence(sampleRate, seconds);
  const melody: MelodyNote[] = [];
  const bassNotes: MelodyNote[] = [];
  const chords: { start: number; end: number; symbol: string }[] = [];
  const sectionStarts: number[] = [];
  let t = lead;
  let mi = 0;
  for (const s of sections) {
    sectionStarts.push(t);
    for (let b = 0; b < s.bars; b++) {
      const sym = s.chords[b % s.chords.length];
      chords.push({ start: t, end: t + bar, symbol: sym });
      const root = CHORD_ROOT[sym];
      const tones = CHORD_TONES[sym];
      // drums
      for (let q = 0; q < 4; q++) {
        const bt = t + q * beat;
        if (q % 2 === 0) drumsEv.push({ time: bt, drum: 'kick' });
        else if (s.energy > 0.5) drumsEv.push({ time: bt, drum: 'snare' });
        drumsEv.push({ time: bt, drum: 'hat' });
        if (s.energy > 0.5) drumsEv.push({ time: bt + beat / 2, drum: 'hat' });
      }
      // bass: roots on beats (8ths in high-energy sections)
      const step = s.energy > 0.5 ? beat / 2 : beat;
      for (let bt = 0; bt < bar - 1e-6; bt += step) {
        const p = root + 12;
        addTone(bass, sampleRate, t + bt, step * 0.9, p, { amp: 0.22 + 0.08 * s.energy, partials: [1, 0.5, 0.25, 0.12], attack: 0.005, release: 0.02 });
        bassNotes.push({ pitch: p, start: t + bt, duration: step * 0.9 });
      }
      // pad: different voicing per side
      for (const p of tones) {
        addTone(padL, sampleRate, t, bar, p + 12, { amp: 0.05, partials: [1, 0.4, 0.2, 0.1], attack: 0.15, release: 0.15 });
        addTone(padR, sampleRate, t, bar, p + 24, { amp: 0.035, partials: [1, 0.4, 0.2, 0.1], attack: 0.15, release: 0.15 });
      }
      // melody: two half-note-ish notes per bar from the chord, register by section energy
      const reg = s.energy > 0.5 ? 72 : 64;
      for (let k = 0; k < 2; k++) {
        const pc = tones[(mi + k) % tones.length] % 12;
        let p = reg - ((reg - pc) % 12);
        if (p < reg - 5) p += 12;
        melody.push({ pitch: p, start: t + k * 2 * beat + 0.02, duration: 2 * beat - 0.12 });
      }
      mi++;
      t += bar;
    }
  }
  const drums = renderDrums(sampleRate, seconds, drumsEv, 0.8);
  const vocals = hummedMelody(sampleRate, melody, { seconds, seed: 21, partials: [1, 0.55, 0.35, 0.2, 0.12, 0.08] });
  const vg = opts.vocalGain ?? 1;
  const left = new Float32Array(drums.length);
  const right = new Float32Array(drums.length);
  for (const [src, gl, gr] of [
    [drums, 0.8, 0.8],
    [bass, 1, 1],
    [vocals, vg, vg],
    [padL, 1, 0.15],
    [padR, 0.15, 1],
  ] as const) {
    addInto(left, src, gl);
    addInto(right, src, gr);
  }
  // section-level loudness: scale quiet sections
  let pos = lead;
  for (const s of sections) {
    const a = Math.round(pos * sampleRate);
    const b = Math.round((pos + s.bars * bar) * sampleRate);
    const g = 0.55 + 0.45 * s.energy;
    for (let i = a; i < Math.min(b, left.length); i++) {
      left[i] *= g;
      right[i] *= g;
    }
    pos += s.bars * bar;
  }
  return { sampleRate, left, right, bpm, sectionStarts, chords, melody, bassNotes, drums: drumsEv, stems: { drums, bass, vocals, padL, padR } };
}
