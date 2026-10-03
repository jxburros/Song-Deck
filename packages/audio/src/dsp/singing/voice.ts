/**
 * Formant singing synthesizer (spec §33 "Placeholder Vocal", §34 built-in singer, §35 expression).
 *
 * Source–filter model:
 *  - glottal source: band-limited (mip-mapped) Rosenberg flow-derivative tables at three open
 *    quotients, crossfaded by `tension`; spectral tilt by energy/brightness; jitter & shimmer per
 *    glottal period; vibrato with delayed onset; drift; scoop/fall/rise pitch gestures; legato glides
 *  - aspiration noise (pitch-synchronous, through the vocal tract) by breathiness
 *  - vocal tract: 5 cascaded Klatt resonators (F1–F5) per vowel, scaled per voice type, with formant
 *    tuning (F1 ≥ f0 at high pitch) and smoothing between targets (coarticulation)
 *  - consonants: fricatives (band-passed noise branch), plosives (closure / voice bar → burst →
 *    aspiration), affricates, nasals (murmur low-pass), liquids/glides (formant transitions)
 *  - onset styles (soft / normal / hard / scoop) and release styles (normal / falling / rising /
 *    breathy / cut); legato phonation across notes of a phrase (incl. melismas "_").
 * A whole vocal track becomes a timeline of parameter segments rendered by one mono engine.
 */
import type { Note, Song, Track, VocalExpression, VoiceType } from '@songdeck/core';
import { createTimeMap } from '@songdeck/core';
import type { AudioData } from '../../types';
import { Biquad } from '../filters';
import { WT_SIZE, Wavetable, wtRead } from '../oscillators';
import { NOISE_SCALE, SINE_TABLE, SINE_SIZE, clampNum, hashString, midiToHz, seedState, sin01, xorshift } from '../utils';
import { BANDWIDTHS_FEMALE, BANDWIDTHS_MALE, type FormantBase, scaledLocus, vowelFormants } from './formants';
import { type PhonemeInfo, PHONEMES, phonemeInfo, syllableToArpabet, wordPhonemesBySyllable } from './phonemes';

export interface SingingVoice {
  id: string;
  name: string;
  voiceType: VoiceType;
  description: string;
  base: FormantBase;
  formantScale: number;
  breathiness: number;
  tension: number;
  vibrato: number;
  vibratoRate: number;
  /** 0..1 spectral brightness. */
  brightness: number;
  /** Period jitter (fraction). */
  jitter: number;
  /** Amplitude shimmer (fraction). */
  shimmer: number;
  /** Singer's-formant boost around 2.9 kHz (dB). */
  ringDb: number;
  gainDb: number;
}

export const STOCK_VOICES: SingingVoice[] = [
  {
    id: 'tenor-warm',
    name: 'Tenor — warm',
    voiceType: 'tenor',
    description: 'Warm pop/rock tenor, moderate vibrato.',
    base: 'male',
    formantScale: 1.03,
    breathiness: 0.16,
    tension: 0.5,
    vibrato: 0.3,
    vibratoRate: 5.6,
    brightness: 0.55,
    jitter: 0.005,
    shimmer: 0.035,
    ringDb: 3,
    gainDb: 0,
  },
  {
    id: 'soprano-bright',
    name: 'Soprano — bright',
    voiceType: 'soprano',
    description: 'Clear, bright soprano with formant tuning on high notes.',
    base: 'female',
    formantScale: 1.04,
    breathiness: 0.1,
    tension: 0.55,
    vibrato: 0.38,
    vibratoRate: 5.8,
    brightness: 0.65,
    jitter: 0.004,
    shimmer: 0.03,
    ringDb: 2,
    gainDb: 0,
  },
  {
    id: 'alto-soft',
    name: 'Alto — soft',
    voiceType: 'alto',
    description: 'Soft, breathy alto for intimate verses.',
    base: 'female',
    formantScale: 0.96,
    breathiness: 0.32,
    tension: 0.35,
    vibrato: 0.24,
    vibratoRate: 5.2,
    brightness: 0.4,
    jitter: 0.006,
    shimmer: 0.04,
    ringDb: 0,
    gainDb: 1,
  },
  {
    id: 'baritone-deep',
    name: 'Baritone — deep',
    voiceType: 'baritone',
    description: 'Deep, resonant baritone.',
    base: 'male',
    formantScale: 0.97,
    breathiness: 0.14,
    tension: 0.48,
    vibrato: 0.3,
    vibratoRate: 5.3,
    brightness: 0.45,
    jitter: 0.005,
    shimmer: 0.035,
    ringDb: 4,
    gainDb: 0,
  },
  {
    id: 'mezzo-pop',
    name: 'Mezzo — pop',
    voiceType: 'mezzo',
    description: 'Contemporary pop mezzo, light vibrato.',
    base: 'female',
    formantScale: 1.0,
    breathiness: 0.2,
    tension: 0.45,
    vibrato: 0.22,
    vibratoRate: 5.5,
    brightness: 0.55,
    jitter: 0.005,
    shimmer: 0.035,
    ringDb: 1,
    gainDb: 0,
  },
  {
    id: 'bass-dark',
    name: 'Bass — dark',
    voiceType: 'bass',
    description: 'Dark low bass voice.',
    base: 'male',
    formantScale: 0.94,
    breathiness: 0.12,
    tension: 0.5,
    vibrato: 0.28,
    vibratoRate: 5.0,
    brightness: 0.4,
    jitter: 0.006,
    shimmer: 0.04,
    ringDb: 4,
    gainDb: 1,
  },
];

const BY_TYPE: Record<VoiceType, string> = {
  soprano: 'soprano-bright',
  mezzo: 'mezzo-pop',
  alto: 'alto-soft',
  tenor: 'tenor-warm',
  baritone: 'baritone-deep',
  bass: 'bass-dark',
};

/** Pick a stock voice: explicit id → track voice id → track voice type → melody range. */
export function resolveSingingVoice(track: Track, voiceId?: string): SingingVoice {
  const byId = (id?: string) => (id ? STOCK_VOICES.find((v) => v.id === id) : undefined);
  const explicit = byId(voiceId) ?? byId(track.vocal?.voiceId);
  if (explicit) return explicit;
  const vt = track.vocal?.voiceType;
  if (vt && BY_TYPE[vt]) return byId(BY_TYPE[vt])!;
  const pitches = track.notes.map((n) => n.pitch).sort((a, b) => a - b);
  const med = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 60;
  const id = med < 50 ? 'bass-dark' : med < 56 ? 'baritone-deep' : med < 62 ? 'tenor-warm' : med < 66 ? 'alto-soft' : med < 70 ? 'mezzo-pop' : 'soprano-bright';
  return byId(id)!;
}

// ---------------------------------------------------------------------------
// Glottal source tables
// ---------------------------------------------------------------------------

interface GlottalSet {
  tables: Wavetable[]; // lax, modal, pressed
  flow: Float64Array; // modal flow (for pitch-synchronous aspiration)
}

let glottal: GlottalSet | null = null;

function rosenberg(t: number, oq: number, sq: number): number {
  const tp = (oq * sq) / (1 + sq);
  const tn = oq / (1 + sq);
  if (t < tp) return 0.5 * (1 - Math.cos((Math.PI * t) / tp));
  if (t < tp + tn) return Math.cos((Math.PI * (t - tp)) / (2 * tn));
  return 0;
}

function glottalTables(): GlottalSet {
  if (glottal) return glottal;
  const N = WT_SIZE;
  const configs: [number, number][] = [
    [0.8, 1.6],
    [0.62, 2.4],
    [0.46, 3.2],
  ];
  const tables: Wavetable[] = [];
  let flowTable = new Float64Array(N + 1);
  configs.forEach(([oq, sq], ci) => {
    const flow = new Float64Array(N);
    for (let n = 0; n < N; n++) flow[n] = rosenberg(n / N, oq, sq);
    if (ci === 1) {
      flowTable = new Float64Array(N + 1);
      for (let n = 0; n < N; n++) flowTable[n] = flow[n];
      flowTable[N] = flow[0];
    }
    // derivative (lip radiation) → DFT → harmonic amplitudes / phases
    const d = new Float64Array(N);
    for (let n = 0; n < N; n++) d[n] = (flow[(n + 1) % N] - flow[(n - 1 + N) % N]) * 0.5 * N;
    const H = N / 4 - 1; // ≥ 1023 harmonics: enough for f0 ≥ 22 Hz at 48 kHz
    const amps = new Float64Array(H);
    const phs = new Float64Array(H);
    const mask = SINE_SIZE - 1;
    for (let h = 1; h <= H; h++) {
      let a = 0, b = 0;
      for (let n = 0; n < N; n++) {
        const idx = (h * n) & mask;
        b += d[n] * SINE_TABLE[idx];
        a += d[n] * SINE_TABLE[(idx + SINE_SIZE / 4) & mask];
      }
      a *= 2 / N;
      b *= 2 / N;
      amps[h - 1] = Math.hypot(a, b);
      phs[h - 1] = Math.atan2(a, b) / (2 * Math.PI);
    }
    tables.push(new Wavetable(amps, phs, 'peak'));
  });
  glottal = { tables, flow: flowTable };
  return glottal;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

interface VSeg {
  start: number;
  end: number;
  av: number;
  ah: number;
  af: number;
  fricF: number;
  fricBw: number;
  lp: number;
  F: Float64Array; // start targets (5)
  F2: Float64Array; // end targets (5)
  /** fraction of the segment after which F moves from F → F2 (diphthongs) */
  glideFrom: number;
  tau: number;
  ampTau: number;
}

interface VNote {
  start: number; // phonation start (incl. anticipated consonants)
  end: number;
  noteStart: number;
  noteEnd: number;
  pitch: number;
  prevPitch: number;
  legato: boolean;
  onset: NonNullable<VocalExpression['onset']>;
  release: NonNullable<VocalExpression['release']>;
  vib: number;
  vibRate: number;
  breath: number;
  tension: number;
  energy: number;
  gain: number;
  releaseTau: number;
}

export interface VocalTimeline {
  segs: VSeg[];
  notes: VNote[];
  voice: SingingVoice;
  sampleRate: number;
  /** last frame with sound (incl. release tail) */
  endFrame: number;
}

export interface VocalBuildOptions {
  sampleRate: number;
  /** seconds at frame 0 */
  startSec: number;
  voice: SingingVoice;
  defaultExpression?: VocalExpression;
}

function cleanSyllable(s: string | undefined): string {
  return (s ?? '').trim();
}

function isMelisma(s: string): boolean {
  return s === '_' || s === '-' || s === '~' || /^_+$/.test(s) || s.startsWith('_');
}

/** Resolve phonemes per note (explicit phonemes → word-level g2p → per-syllable g2p → "AA"). */
export function resolveNotePhonemes(notes: Note[]): (string[] | null)[] {
  const out: (string[] | null)[] = notes.map(() => null);
  // explicit
  const pending: number[] = [];
  notes.forEach((n, i) => {
    if (n.phonemes && n.phonemes.length) {
      out[i] = n.phonemes.map((p) => p.toUpperCase().replace(/[0-9]/g, '')).filter((p) => !!PHONEMES[p]);
      if (!out[i]!.length) out[i] = null;
    }
    if (!out[i]) pending.push(i);
  });
  // group syllables into words
  let k = 0;
  while (k < pending.length) {
    const i = pending[k];
    const syl = cleanSyllable(notes[i].syllable);
    if (!syl) {
      out[i] = ['AA'];
      k++;
      continue;
    }
    if (isMelisma(syl)) {
      out[i] = []; // hold previous vowel
      k++;
      continue;
    }
    const group = [i];
    let j = k;
    while (j + 1 < pending.length) {
      const cur = cleanSyllable(notes[pending[j]].syllable);
      const nxt = cleanSyllable(notes[pending[j + 1]].syllable);
      if (!nxt || isMelisma(nxt)) break;
      if (cur.endsWith('-') || nxt.startsWith('-')) {
        group.push(pending[j + 1]);
        j++;
      } else break;
    }
    const word = group.map((g) => cleanSyllable(notes[g].syllable).replace(/^-+|-+$/g, '')).join('');
    const split = group.length > 1 ? wordPhonemesBySyllable(word, group.length) : null;
    group.forEach((g, gi) => {
      let ph = split ? split[gi] : syllableToArpabet(cleanSyllable(notes[g].syllable).replace(/^-+|-+$/g, ''));
      if (!ph.length) ph = ['AA'];
      out[g] = ph;
    });
    k = j + 1;
  }
  return out;
}

const SONORANT = new Set(['M', 'N', 'NG', 'L', 'R', 'W', 'Y', 'V', 'Z', 'DH', 'ZH']);

function consonantDur(p: PhonemeInfo): number {
  if (p.cls === 'stop') return (p.closure ?? 0.05) + 0.008 + (p.asp ?? 0);
  if (p.cls === 'affricate') return (p.closure ?? 0.04) + p.dur * 0.6;
  return p.dur;
}

/** Build the parameter timeline for a vocal track. */
export function buildVocalTimeline(song: Song, track: Track, opts: VocalBuildOptions): VocalTimeline {
  const sr = opts.sampleRate;
  const tm = createTimeMap(song);
  const voice = opts.voice;
  const def = { ...(song.vocals?.defaultExpression ?? {}), ...(opts.defaultExpression ?? {}) };
  const sorted = [...track.notes].sort((a, b) => a.tick - b.tick || b.pitch - a.pitch);
  // mono: drop notes starting at the same tick (keep highest), truncate overlaps
  const notes: Note[] = [];
  for (const n of sorted) {
    if (notes.length && notes[notes.length - 1].tick === n.tick) continue;
    notes.push(n);
  }
  const phon = resolveNotePhonemes(notes);
  const base = voice.base;
  const scale = voice.formantScale;
  const bw = base === 'male' ? BANDWIDTHS_MALE : BANDWIDTHS_FEMALE;
  void bw;
  const segs: VSeg[] = [];
  const vnotes: VNote[] = [];
  const toFrame = (sec: number) => Math.round((sec - opts.startSec) * sr);

  const mkSeg = (start: number, end: number, init: Partial<VSeg>, F: Float64Array, F2?: Float64Array): void => {
    if (end <= start) return;
    segs.push({
      start,
      end,
      av: 0,
      ah: 0,
      af: 0,
      fricF: 4000,
      fricBw: 3000,
      lp: 0,
      glideFrom: 0,
      tau: 0.018,
      ampTau: 0.006,
      ...init,
      F,
      F2: F2 ?? F,
    });
  };
  const vowelF = (key: PhonemeInfo['v1']): Float64Array => {
    const f = new Float64Array(5);
    vowelFormants(key ?? 'a', base, scale, f);
    return f;
  };
  const locusF = (p: PhonemeInfo, nextVowel: Float64Array): Float64Array => {
    const f = new Float64Array(5);
    if (p.f) {
      scaledLocus(p.f, base, scale, f);
      // coarticulation: 35 % toward the adjacent vowel
      for (let k = 0; k < 5; k++) f[k] = f[k] * 0.65 + nextVowel[k] * 0.35;
    } else f.set(nextVowel);
    return f;
  };

  let prevNote: VNote | null = null;
  let prevVowelF: Float64Array = vowelF('V');
  let prevVowelSegIndex = -1;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const ex: VocalExpression = { ...def, ...(n.expression ?? {}) };
    const ns = toFrame(tm.tickToSeconds(n.tick));
    let ne = toFrame(tm.tickToSeconds(n.tick + Math.max(1, n.duration)));
    const next = notes[i + 1];
    if (next) ne = Math.min(ne, toFrame(tm.tickToSeconds(next.tick)));
    if (ne <= ns) continue;
    const durF = ne - ns;
    const legato = !!prevNote && ns - prevNote.noteEnd < 0.03 * sr;
    const ph = phon[i] ?? ['AA'];
    const melisma = ph.length === 0 && !!prevNote && legato;
    // split onset / nucleus / coda
    let firstV = ph.findIndex((p) => PHONEMES[p]?.cls === 'vowel');
    let lastV = -1;
    for (let k = ph.length - 1; k >= 0; k--)
      if (PHONEMES[ph[k]]?.cls === 'vowel') {
        lastV = k;
        break;
      }
    let list = ph.slice();
    if (!melisma && firstV < 0) {
      const son = list.findIndex((p) => SONORANT.has(p));
      if (son >= 0) {
        firstV = lastV = son;
      } else {
        list = [...list, 'AH'];
        firstV = lastV = list.length - 1;
      }
    }
    const onset = melisma ? [] : list.slice(0, firstV).map((p) => PHONEMES[p]).filter(Boolean);
    const nucleus = melisma ? [] : list.slice(firstV, lastV + 1).map((p) => PHONEMES[p]).filter((p) => p && (p.cls === 'vowel' || firstV === lastV));
    const coda = melisma ? [] : list.slice(lastV + 1).map((p) => PHONEMES[p]).filter(Boolean);
    const nucVowel = nucleus.find((p) => p.cls === 'vowel');
    const nucF = melisma ? prevVowelF : nucVowel ? vowelF(nucVowel.v1) : locusF(nucleus[0] ?? PHONEMES.AH, prevVowelF);
    // durations
    const noteSec = durF / sr;
    let onDur = onset.reduce((a, p) => a + consonantDur(p), 0);
    let codaDur = coda.reduce((a, p) => a + consonantDur(p), 0);
    const maxOn = Math.min(0.3, noteSec * 0.45 + 0.06);
    if (onDur > maxOn) onDur = maxOn;
    const maxCoda = Math.min(0.25, noteSec * 0.3);
    if (codaDur > maxCoda) codaDur = maxCoda;
    // anticipation: put ~70 % of the onset before the beat, limited by available room
    let before = onDur * 0.7;
    if (prevNote) {
      const room = legato ? Math.max(0, (prevNote.noteEnd - (prevVowelSegIndex >= 0 ? segs[prevVowelSegIndex].start : prevNote.noteStart)) * 0.4) / sr : (ns - prevNote.end) / sr;
      before = Math.min(before, Math.max(0, room));
    }
    const onStart = ns - Math.round(before * sr);
    const onEnd = onStart + Math.round(onDur * sr);
    const codaStart = ne - Math.round(codaDur * sr);
    const vowStart = Math.max(onEnd, ns - (melisma ? 0 : 0));
    // if anticipating into a legato previous note, shorten its trailing vowel segment
    if (legato && prevVowelSegIndex >= 0 && onStart < segs[prevVowelSegIndex].end) {
      segs[prevVowelSegIndex].end = Math.max(segs[prevVowelSegIndex].start + 1, onStart);
    }
    const resolvedOnset = ex.onset ?? 'normal';
    const onsetTau = resolvedOnset === 'soft' ? 0.06 : resolvedOnset === 'hard' ? 0.004 : resolvedOnset === 'scoop' ? 0.03 : 0.022;
    const rel = ex.release ?? 'normal';
    const releaseTau = rel === 'cut' ? 0.006 : rel === 'breathy' ? 0.09 : rel === 'falling' || rel === 'rising' ? 0.05 : 0.04;
    const breath = clampNum(ex.breathiness ?? voice.breathiness, 0, 1);
    // onset consonants
    let t = onStart;
    const firstAmpTau = legato ? 0.008 : onsetTau;
    onset.forEach((p, k) => {
      const share = consonantDur(p) / Math.max(1e-6, onset.reduce((a, q) => a + consonantDur(q), 0));
      const d = Math.max(1, Math.round((onEnd - onStart) * share));
      const fL = locusF(p, nucF);
      const at = k === 0 ? firstAmpTau : 0.005;
      emitConsonant(p, t, t + d, fL, nucF, at, breath);
      t += d;
    });
    // nucleus
    if (melisma && prevVowelSegIndex >= 0) {
      // extend the held vowel through this note
      mkSeg(Math.max(t, ns), codaStart, { av: 1, ah: breath * 0.28, tau: 0.03, ampTau: 0.008 }, prevVowelF);
      prevVowelSegIndex = segs.length - 1;
    } else if (nucleus.length) {
      const vStart = Math.max(t, vowStart);
      const vEnd = Math.max(vStart + 1, codaStart);
      const vowels = nucleus.filter((p) => p.cls === 'vowel');
      const ampTau = onset.length || legato ? 0.008 : onsetTau;
      if (vowels.length === 0) {
        const p = nucleus[0];
        emitConsonant(p, vStart, vEnd, locusF(p, prevVowelF), prevVowelF, ampTau, breath);
      } else if (vowels.length === 1) {
        const v = vowels[0];
        const F = vowelF(v.v1);
        const F2 = v.v2 ? vowelF(v.v2) : F;
        mkSeg(vStart, vEnd, { av: 1, ah: breath * 0.28, ampTau, tau: 0.02, glideFrom: v.v2 ? 0.45 : 0 }, F, F2);
        prevVowelF = F2;
      } else {
        // two vowels in one syllable: second takes the last 35 %
        const split = vStart + Math.round((vEnd - vStart) * 0.65);
        const Fa = vowelF(vowels[0].v1);
        const Fa2 = vowels[0].v2 ? vowelF(vowels[0].v2) : Fa;
        mkSeg(vStart, split, { av: 1, ah: breath * 0.28, ampTau, tau: 0.02, glideFrom: vowels[0].v2 ? 0.45 : 0 }, Fa, Fa2);
        const v2 = vowels[vowels.length - 1];
        const Fb = vowelF(v2.v1);
        const Fb2 = v2.v2 ? vowelF(v2.v2) : Fb;
        mkSeg(split, vEnd, { av: 1, ah: breath * 0.28, ampTau: 0.008, tau: 0.035, glideFrom: v2.v2 ? 0.45 : 0 }, Fb, Fb2);
        prevVowelF = Fb2;
      }
      prevVowelSegIndex = segs.length - 1;
    }
    // breathy release: add aspiration over the vowel tail
    if (rel === 'breathy' && prevVowelSegIndex >= 0) {
      const sgi = segs[prevVowelSegIndex];
      const tailStart = Math.max(sgi.start + 1, sgi.end - Math.round(0.18 * sr));
      if (tailStart < sgi.end && (!notes[i + 1] || toFrame(tm.tickToSeconds(notes[i + 1].tick)) - ne > 0.03 * sr)) {
        const old = sgi.end;
        sgi.end = tailStart;
        mkSeg(tailStart, old, { av: 0.45, ah: 0.55, ampTau: 0.04, tau: 0.03 }, sgi.F2);
        prevVowelSegIndex = segs.length - 1;
      }
    }
    // coda
    t = codaStart;
    coda.forEach((p) => {
      const share = consonantDur(p) / Math.max(1e-6, coda.reduce((a, q) => a + consonantDur(q), 0));
      const d = Math.max(1, Math.round((ne - codaStart) * share));
      emitConsonant(p, t, Math.min(ne, t + d), locusF(p, prevVowelF), prevVowelF, 0.005, breath);
      t += d;
    });
    const velGain = Math.pow(10, ((clampNum(n.velocity, 1, 127) - 100) / 127) * 18 / 20);
    const vn: VNote = {
      start: Math.min(onStart, ns),
      end: ne,
      noteStart: ns,
      noteEnd: ne,
      pitch: n.pitch,
      prevPitch: prevNote ? prevNote.pitch : n.pitch,
      legato,
      onset: resolvedOnset,
      release: rel,
      vib: clampNum(ex.vibrato ?? voice.vibrato, 0, 1),
      vibRate: clampNum(ex.vibratoRate ?? voice.vibratoRate, 2, 9),
      breath,
      tension: clampNum(ex.tension ?? voice.tension, 0, 1),
      energy: clampNum(ex.energy ?? 0.5, 0, 1),
      gain: velGain,
      releaseTau,
    };
    vnotes.push(vn);
    prevNote = vn;
  }

  function emitConsonant(p: PhonemeInfo, s: number, e: number, fL: Float64Array, fV: Float64Array, ampTau: number, breath: number): void {
    if (e <= s) return;
    const len = e - s;
    switch (p.cls) {
      case 'stop': {
        const total = consonantDur(p);
        const cl = Math.max(1, Math.round((len * (p.closure ?? 0.05)) / total));
        const bu = Math.max(1, Math.round((len * 0.008) / total));
        mkSeg(s, s + cl, { av: p.voiced ? p.av : 0, lp: p.voiced ? 450 : 0, ampTau: 0.004, tau: 0.012 }, fL);
        mkSeg(s + cl, Math.min(e, s + cl + bu), { av: p.voiced ? 0.3 : 0, af: p.burst?.amp ?? 0.4, fricF: p.burst?.f ?? 3000, fricBw: p.burst?.bw ?? 2000, ampTau: 0.0015, tau: 0.01 }, fL);
        if (s + cl + bu < e) {
          if (p.voiced) mkSeg(s + cl + bu, e, { av: 0.9, ah: breath * 0.2, ampTau: 0.004, tau: 0.012 }, fL, fV);
          else mkSeg(s + cl + bu, e, { ah: 0.5, av: 0, ampTau: 0.003, tau: 0.01 }, fV);
        }
        break;
      }
      case 'affricate': {
        const total = consonantDur(p);
        const cl = Math.max(1, Math.round((len * (p.closure ?? 0.04)) / total));
        mkSeg(s, s + cl, { av: p.voiced ? 0.2 : 0, lp: p.voiced ? 450 : 0, ampTau: 0.004, tau: 0.012 }, fL);
        mkSeg(s + cl, e, { av: p.av, af: p.fric?.amp ?? 0.3, fricF: p.fric?.f ?? 3000, fricBw: p.fric?.bw ?? 2000, ampTau: 0.003, tau: 0.012 }, fL);
        break;
      }
      case 'fricative':
        mkSeg(s, e, { av: p.av, af: p.fric?.amp ?? 0.2, fricF: p.fric?.f ?? 5000, fricBw: p.fric?.bw ?? 4000, ampTau, tau: 0.012 }, fL);
        break;
      case 'aspirate':
        mkSeg(s, e, { av: 0, ah: 0.55, ampTau, tau: 0.01 }, fV);
        break;
      case 'nasal':
        mkSeg(s, e, { av: p.av, lp: 1300, ampTau, tau: 0.012 }, fL);
        break;
      default:
        mkSeg(s, e, { av: p.av, ah: breath * 0.15, ampTau, tau: 0.015 }, fL);
    }
  }

  segs.sort((a, b) => a.start - b.start);
  // remove overlaps (later segments win)
  for (let k = 0; k + 1 < segs.length; k++) if (segs[k].end > segs[k + 1].start) segs[k].end = Math.max(segs[k].start, segs[k + 1].start);
  const filtered = segs.filter((s) => s.end > s.start);
  const last = vnotes.length ? vnotes[vnotes.length - 1].end : 0;
  return { segs: filtered, notes: vnotes, voice, sampleRate: sr, endFrame: last + Math.round(0.4 * sr) };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const CR = 16;

export class VocalEngine {
  private tl: VocalTimeline | null = null;
  private segCur = 0;
  private noteCur = 0;
  // smoothed parameters
  private readonly F = new Float64Array(5);
  private readonly B = new Float64Array(5);
  private av = 0;
  private ah = 0;
  private af = 0;
  private fricF = 4000;
  private fricBw = 3000;
  private lpHz = 0;
  private gain = 0;
  private tension = 0.5;
  private bright = 0.5;
  // resonators
  private readonly rA = new Float64Array(5);
  private readonly rB = new Float64Array(5);
  private readonly rC = new Float64Array(5);
  private readonly y1 = new Float64Array(5);
  private readonly y2 = new Float64Array(5);
  private readonly fric = new Biquad();
  private readonly ring = new Biquad();
  private lpState = 0;
  private tiltState = 0;
  private phase = 0;
  private jit = 1;
  private shim = 1;
  private noise: number;
  private noise2: number;
  private vibPhase = 0;
  private drift = 0;
  private driftTarget = 0;
  private driftTimer = 0;
  private curPitch = 60;
  private lastNote: VNote | null = null;
  /** True when the last render produced no sound (between phrases). */
  idle = true;
  private readonly sr: number;
  private readonly gs: GlottalSet;
  private readonly baseGain: number;

  constructor(private readonly voice: SingingVoice, sampleRate: number, seed = 1) {
    this.sr = sampleRate;
    this.gs = glottalTables();
    this.noise = seedState(seed ^ 0x51ed);
    this.noise2 = seedState(seed ^ 0x2bad);
    const bw = voice.base === 'male' ? BANDWIDTHS_MALE : BANDWIDTHS_FEMALE;
    for (let k = 0; k < 5; k++) this.B[k] = bw[k];
    vowelFormants('V', voice.base, voice.formantScale, this.F);
    this.ring.design('peak', 2900 * voice.formantScale, 1.4, voice.ringDb, sampleRate);
    this.baseGain = 0.085 * Math.pow(10, voice.gainDb / 20);
  }

  setTimeline(tl: VocalTimeline): void {
    this.tl = tl;
    this.seek(0);
  }

  get timeline(): VocalTimeline | null {
    return this.tl;
  }

  /** Position cursors at `frame` and snap smoothed parameters to their targets. */
  seek(frame: number): void {
    const tl = this.tl;
    this.segCur = 0;
    this.noteCur = 0;
    if (!tl) return;
    while (this.segCur < tl.segs.length && tl.segs[this.segCur].end <= frame) this.segCur++;
    while (this.noteCur < tl.notes.length && tl.notes[this.noteCur].end <= frame) this.noteCur++;
    this.av = this.ah = this.af = 0;
    this.gain = 0;
    this.y1.fill(0);
    this.y2.fill(0);
    this.fric.reset();
    this.ring.reset();
    this.lpState = 0;
    this.tiltState = 0;
    this.lastNote = null;
    const n = tl.notes[this.noteCur];
    if (n) this.curPitch = n.pitch;
  }

  /** Add `n` mono samples starting at timeline frame `frame0` into out[offset..offset+n). */
  render(out: Float64Array, offset: number, frame0: number, n: number): void {
    const tl = this.tl;
    if (!tl) return;
    const sr = this.sr;
    const segs = tl.segs;
    const notes = tl.notes;
    let sounding = false;
    for (let i = 0; i < n; ) {
      const segEnd = Math.min(n, i + CR);
      const f = frame0 + i;
      while (this.segCur < segs.length && segs[this.segCur].end <= f) this.segCur++;
      while (this.noteCur < notes.length && notes[this.noteCur].end <= f) {
        this.lastNote = notes[this.noteCur];
        this.noteCur++;
      }
      const seg = this.segCur < segs.length && segs[this.segCur].start <= f ? segs[this.segCur] : null;
      const note = this.noteCur < notes.length && notes[this.noteCur].start <= f ? notes[this.noteCur] : null;
      const dt = (segEnd - i) / sr;
      // ---- targets ----
      let tAv = 0, tAh = 0, tAf = 0, tLp = 0, ampTau = 0.006, fTau = 0.02;
      if (seg) {
        tAv = seg.av;
        tAh = seg.ah;
        tAf = seg.af;
        tLp = seg.lp;
        ampTau = seg.ampTau;
        fTau = seg.tau;
        const pos = (f - seg.start) / Math.max(1, seg.end - seg.start);
        let w = 0;
        if (seg.F2 !== seg.F && pos > seg.glideFrom) {
          const x = Math.min(1, (pos - seg.glideFrom) / Math.max(0.05, 0.95 - seg.glideFrom));
          w = x * x * (3 - 2 * x);
        }
        const kF = 1 - Math.exp(-dt / fTau);
        for (let k = 0; k < 5; k++) {
          const target = seg.F[k] + (seg.F2[k] - seg.F[k]) * w;
          this.F[k] += (target - this.F[k]) * kF;
        }
        if (tAf > 0) {
          const kq = 1 - Math.exp(-dt / 0.004);
          this.fricF += (seg.fricF * (this.voice.base === 'female' ? 1.1 : 1) - this.fricF) * kq;
          this.fricBw += (seg.fricBw - this.fricBw) * kq;
        }
      } else if (!note && this.lastNote) {
        ampTau = this.lastNote.releaseTau;
      }
      const cur = note ?? this.lastNote;
      // pitch
      if (cur) {
        const tSec = (f - cur.noteStart) / sr;
        let p = cur.pitch;
        if (cur.legato && cur.prevPitch !== cur.pitch) {
          const gt = 0.07;
          const x = clampNum((tSec + 0.02) / gt, 0, 1);
          p = cur.prevPitch + (cur.pitch - cur.prevPitch) * (x * x * (3 - 2 * x));
        } else if (cur.onset === 'scoop' && !cur.legato) {
          p -= 1.6 * Math.exp(-Math.max(0, tSec) / 0.06);
        }
        const toEnd = (cur.noteEnd - f) / sr;
        const nextLegato = this.noteCur + 1 < notes.length && notes[this.noteCur + 1].legato;
        if (!nextLegato && toEnd < 0.2) {
          const x = clampNum(1 - Math.max(0, toEnd) / 0.2, 0, 1);
          if (cur.release === 'falling') p -= 2.5 * x * x;
          else if (cur.release === 'rising') p += 1.2 * x * x;
        }
        // vibrato with delayed onset
        const noteLen = (cur.noteEnd - cur.noteStart) / sr;
        if (cur.vib > 0 && noteLen > 0.35) {
          const amt = clampNum((tSec - 0.22) / 0.35, 0, 1);
          this.vibPhase += cur.vibRate * dt;
          if (this.vibPhase > 1) this.vibPhase -= 1;
          p += (cur.vib * 0.75) * amt * sin01(this.vibPhase);
        }
        // drift
        this.driftTimer -= dt;
        if (this.driftTimer <= 0) {
          this.noise = xorshift(this.noise);
          this.driftTarget = this.noise * NOISE_SCALE * 0.06;
          this.driftTimer = 0.25;
        }
        this.drift += (this.driftTarget - this.drift) * 0.02;
        p += this.drift;
        this.curPitch = p;
        const kt = 1 - Math.exp(-dt / 0.05);
        this.tension += (cur.tension - this.tension) * kt;
        this.bright += (clampNum(0.35 * this.voice.brightness + 0.65 * cur.energy, 0, 1) - this.bright) * kt;
        if (seg && tAh > 0 && seg.av > 0.5) tAh = Math.max(tAh, cur.breath * 0.3);
      }
      const tGain = cur ? cur.gain : 0;
      const kA = 1 - Math.exp(-dt / Math.max(0.0008, ampTau));
      this.av += (tAv - this.av) * kA;
      this.ah += (tAh - this.ah) * kA;
      this.af += (tAf - this.af) * (1 - Math.exp(-dt / 0.003));
      this.gain += (tGain - this.gain) * (1 - Math.exp(-dt / 0.02));
      this.lpHz = tLp;
      if (this.av < 1e-4 && this.ah < 1e-4 && this.af < 1e-4 && tAv === 0 && tAh === 0 && tAf === 0) {
        i = segEnd;
        continue;
      }
      sounding = true;
      // formant tuning: keep F1 above f0
      const f0 = midiToHz(this.curPitch);
      // resonator coefficients
      for (let k = 0; k < 5; k++) {
        let F = this.F[k];
        if (k === 0 && F < f0 * 1.08) F = f0 * 1.08;
        F = Math.min(F, sr * 0.45);
        const r = Math.exp((-Math.PI * this.B[k]) / sr);
        const C = -r * r;
        const Bc = 2 * r * Math.cos((2 * Math.PI * F) / sr);
        this.rA[k] = 1 - Bc - C;
        this.rB[k] = Bc;
        this.rC[k] = C;
      }
      if (this.af > 1e-4) this.fric.design('bandpass', this.fricF, clampNum(this.fricF / Math.max(200, this.fricBw), 0.4, 8), 0, sr);
      const lpA = this.lpHz > 0 ? 1 - Math.exp((-2 * Math.PI * this.lpHz) / sr) : 1;
      // tilt (one-pole lowpass blend): darker for low brightness
      const tiltA = 1 - Math.exp((-2 * Math.PI * (900 + 5000 * this.bright)) / sr);
      const tiltMix = 0.35 + 0.65 * this.bright;
      // glottal tables
      const lvl = this.gs.tables[0].levelFor(f0, sr);
      const tens = this.tension * 2; // 0..2 across the three tables
      const tIdx = tens < 1 ? 0 : 1;
      const tw = tens < 1 ? tens : tens - 1;
      const ta = this.gs.tables[tIdx].levels[lvl];
      const tb = this.gs.tables[tIdx + 1].levels[lvl];
      const flow = this.gs.flow;
      const baseInc = f0 / sr;
      const av = this.av, ah = this.ah, af = this.af;
      const g = this.gain * this.baseGain;
      const rA = this.rA, rB = this.rB, rC = this.rC, y1 = this.y1, y2 = this.y2;
      let ph = this.phase;
      let ns = this.noise, ns2 = this.noise2;
      let lp = this.lpState, tilt = this.tiltState;
      const jitter = this.voice.jitter, shimmer = this.voice.shimmer;
      for (let j = i; j < segEnd; j++) {
        ph += baseInc * this.jit;
        if (ph >= 1) {
          ph -= 1;
          ns = xorshift(ns);
          this.jit = 1 + jitter * ns * NOISE_SCALE;
          ns = xorshift(ns);
          this.shim = 1 + shimmer * ns * NOISE_SCALE;
        }
        const ga = wtRead(ta, ph);
        const gb = wtRead(tb, ph);
        let src = (ga + (gb - ga) * tw) * av * this.shim;
        tilt += tiltA * (src - tilt);
        src = tilt + (src - tilt) * tiltMix;
        ns = xorshift(ns);
        const nz = ns * NOISE_SCALE;
        const fl = wtRead(flow, ph);
        let x = src + nz * ah * (0.35 + 0.65 * fl) * 0.6;
        // cascade
        for (let k = 0; k < 5; k++) {
          const y = rA[k] * x + rB[k] * y1[k] + rC[k] * y2[k];
          y2[k] = y1[k];
          y1[k] = y;
          x = y;
        }
        if (af > 1e-4) {
          ns2 = xorshift(ns2);
          x += this.fric.tick(ns2 * NOISE_SCALE) * af * 2.2;
        }
        if (lpA < 1) {
          lp += lpA * (x - lp);
          x = lp;
        } else lp = x;
        out[offset + j] += x * g;
      }
      this.phase = ph;
      this.noise = ns;
      this.noise2 = ns2;
      this.lpState = lp;
      this.tiltState = tilt;
      for (let k = 0; k < 5; k++) {
        if (Math.abs(y1[k]) < 1e-25) y1[k] = 0;
        if (Math.abs(y2[k]) < 1e-25) y2[k] = 0;
      }
      i = segEnd;
    }
    if (this.voice.ringDb !== 0 && (sounding || !this.idle)) this.ring.processMono(out, offset, offset + n);
    this.fric.flush();
    this.idle = !sounding;
  }
}

/** Resolve a vocal track's voice + timeline (shared by the renderer and synthesizeVocal). */
export function prepareVocal(song: Song, track: Track, sampleRate: number, startSec: number, voiceId?: string): VocalTimeline {
  const voice = resolveSingingVoice(track, voiceId);
  return buildVocalTimeline(song, track, { sampleRate, startSec, voice });
}

export interface SynthesizeVocalOptions {
  voiceId?: string;
  startTick?: number;
  endTick?: number;
  sampleRate?: number;
  seed?: number;
}

/** Render a vocal track (dry, mono) with the formant singer. */
export function synthesizeVocal(song: Song, trackId: string, opts: SynthesizeVocalOptions = {}): AudioData {
  const sr = opts.sampleRate ?? 44100;
  const track = song.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`synthesizeVocal: unknown track ${trackId}`);
  const tm = createTimeMap(song);
  const startTick = opts.startTick ?? 0;
  const lastTick = track.notes.reduce((m, n) => Math.max(m, n.tick + n.duration), 0);
  const endTick = opts.endTick ?? lastTick;
  const startSec = tm.tickToSeconds(startTick);
  const endSec = tm.tickToSeconds(Math.max(startTick, endTick));
  const sub: Track = {
    ...track,
    notes: track.notes.filter((n) => n.tick + n.duration > startTick && n.tick < endTick),
  };
  const tl = prepareVocal(song, sub, sr, startSec, opts.voiceId);
  const total = Math.max(1, Math.round((endSec - startSec) * sr) + Math.round(0.35 * sr));
  const out = new Float64Array(total);
  const eng = new VocalEngine(tl.voice, sr, (opts.seed ?? 1) ^ hashString(trackId));
  eng.setTimeline(tl);
  const block = 256;
  for (let f = 0; f < total; f += block) eng.render(out, f, f, Math.min(block, total - f));
  const res = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const v = out[i];
    res[i] = Number.isFinite(v) ? v : 0;
  }
  return { sampleRate: sr, channels: [res] };
}

export { phonemeInfo };
