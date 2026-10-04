import { describe, expect, it } from 'vitest';
import { PPQ } from '@songdeck/core';
import {
  medianF0,
  trackPitch,
  transcribeMonophonic,
  transcribePolyphonic,
  transcribedToNotes,
  type TranscribedNote,
} from '../src/analysis';
import { addTone, hummedMelody, lcg, midiHz, mono, silence, type MelodyNote } from './analysis-signals';

const SR = 22050;

function cents(a: number, b: number): number {
  return 1200 * Math.log2(a / b);
}

describe('analysis: YIN pitch tracking', () => {
  const cases: [string, number, Parameters<typeof addTone>[5], { minHz?: number; maxHz?: number }][] = [
    ['A3', 57, { partials: [1, 0.6, 0.4, 0.3, 0.2] }, {}],
    ['E2 bass (strong 2nd harmonic)', 40, { partials: [0.6, 1, 0.5, 0.3] }, { minHz: 30, maxHz: 400 }],
    ['C5', 72, { partials: [1, 0.3, 0.1] }, {}],
    ['A3 with a weak fundamental', 57, { partials: [0.2, 1, 0.8, 0.5, 0.3] }, {}],
  ];
  for (const sr of [22050, 44100]) {
    for (const [name, pitch, tone, range] of cases) {
      it(`${name} @ ${sr} Hz → within 10 cents, voiced`, () => {
        const x = silence(sr, 1.5);
        addTone(x, sr, 0.2, 1.1, pitch, { ...tone, amp: 0.4 });
        const tr = trackPitch(mono(sr, x), range);
        expect(Math.abs(cents(medianF0(tr), midiHz(pitch)))).toBeLessThan(10);
        const voiced = Array.from(tr.f0).filter((f) => f > 0).length;
        expect(voiced * tr.hopSeconds).toBeGreaterThan(0.95); // ≈ 1.1 s of tone
        expect(voiced * tr.hopSeconds).toBeLessThan(1.25);
        // no octave errors anywhere in the note
        for (const f of tr.f0) if (f > 0) expect(Math.abs(cents(f, midiHz(pitch)))).toBeLessThan(80);
      });
    }
  }

  it('vibrato tone → correct median pitch', () => {
    const x = silence(SR, 2);
    addTone(x, SR, 0.2, 1.6, 67, { partials: [1, 0.4, 0.2], vibratoHz: 5.5, vibratoCents: 60, amp: 0.4 });
    const tr = trackPitch(mono(SR, x));
    expect(Math.abs(cents(medianF0(tr), midiHz(67)))).toBeLessThan(10);
    // the vibrato itself is tracked (±60 cents)
    const voiced = Array.from(tr.f0)
      .filter((f) => f > 0)
      .map((f) => cents(f, midiHz(67)));
    expect(Math.max(...voiced)).toBeGreaterThan(35);
    expect(Math.min(...voiced)).toBeLessThan(-35);
  });

  it('white noise and silence are unvoiced', () => {
    const rnd = lcg(9);
    const noise = new Float32Array(SR);
    for (let i = 0; i < noise.length; i++) noise[i] = 0.3 * (rnd() * 2 - 1);
    const tr = trackPitch(mono(SR, noise));
    expect(Array.from(tr.f0).filter((f) => f > 0).length).toBe(0);
    const tr2 = trackPitch(mono(SR, silence(SR, 1)));
    expect(Array.from(tr2.f0).every((f) => f === 0)).toBe(true);
  });
});

function makeMelody(
  seed: number,
  count: number,
  opts: { legato?: boolean; repeats?: boolean } = {},
): MelodyNote[] {
  const rnd = lcg(seed);
  const scale = [0, 2, 4, 5, 7, 9, 11, 12, 14];
  const notes: MelodyNote[] = [];
  let t = 0.3;
  let deg = 2;
  for (let i = 0; i < count; i++) {
    const step = Math.floor(rnd() * 5) - 2;
    deg = Math.max(0, Math.min(scale.length - 1, deg + (opts.repeats && rnd() < 0.2 ? 0 : step || 1)));
    const dur = [0.2, 0.3, 0.4, 0.5, 0.6, 0.8][Math.floor(rnd() * 6)];
    notes.push({ pitch: 60 + scale[deg], start: t, duration: dur });
    t += dur + (opts.legato ? (rnd() < 0.5 ? 0 : 0.05) : [0, 0.05, 0.1, 0.15][Math.floor(rnd() * 4)]);
  }
  return notes;
}

function scoreNotes(
  truth: MelodyNote[],
  det: TranscribedNote[],
  tol = 0.05,
): { recall: number; precision: number } {
  const used = new Set<number>();
  let ok = 0;
  for (const n of truth) {
    const i = det.findIndex(
      (d, j) => !used.has(j) && d.pitch === n.pitch && Math.abs(d.startSeconds - n.start) <= tol,
    );
    if (i >= 0) {
      ok++;
      used.add(i);
    }
  }
  return { recall: ok / truth.length, precision: ok / Math.max(1, det.length) };
}

describe('analysis: monophonic transcription (humming / singing)', () => {
  const scenarios: [string, { legato?: boolean; repeats?: boolean }, number][] = [
    ['detached notes with gaps', {}, 0],
    ['legato, +35 cents sharp singer', { legato: true }, 35],
    ['repeated notes', { repeats: true }, -20],
  ];
  for (const [name, opt, detune] of scenarios) {
    it(`hummed melody (${name}) → ≥ 90 % notes with correct pitch and onset ±50 ms`, () => {
      const truth = makeMelody(7 + detune, 40, opt);
      const x = hummedMelody(SR, truth, { detuneCents: detune, breath: 0.004, seed: 3 });
      const t0 = performance.now();
      const r = transcribeMonophonic(mono(SR, x), { minHz: 70, maxHz: 1000 });
      const ms = performance.now() - t0;
      const sc = scoreNotes(truth, r.notes);
      expect(sc.recall).toBeGreaterThanOrEqual(0.9);
      expect(sc.precision).toBeGreaterThanOrEqual(0.9);
      expect(Math.abs(r.tuningCents - detune)).toBeLessThan(15);
      expect(r.confidence).toBeGreaterThan(0.5);
      for (const n of r.notes) {
        expect(n.confidence).toBeGreaterThan(0);
        expect(n.confidence).toBeLessThanOrEqual(1);
        expect(n.endSeconds).toBeGreaterThan(n.startSeconds);
      }
      // ≈ 20 s of humming transcribes in ≈ 0.15 s standalone (spec: < 2 s); bound leaves room for parallel test workers
      expect(ms).toBeLessThan(4000);
    });
  }

  it('bass line (E1–E3) with the bass range', () => {
    const truth: MelodyNote[] = [28, 33, 35, 40, 43, 40, 35, 31].map((p, i) => ({
      pitch: p,
      start: 0.2 + i * 0.5,
      duration: 0.45,
    }));
    const x = silence(SR, 4.5);
    for (const n of truth)
      addTone(x, SR, n.start, n.duration, n.pitch, {
        amp: 0.4,
        partials: [1, 0.7, 0.4, 0.25],
        attack: 0.005,
      });
    const r = transcribeMonophonic(mono(SR, x), { minHz: 30, maxHz: 400 });
    expect(scoreNotes(truth, r.notes).recall).toBeGreaterThanOrEqual(0.875);
  });

  it('silence → no notes, zero confidence', () => {
    const r = transcribeMonophonic(mono(SR, silence(SR, 2)));
    expect(r.notes).toEqual([]);
    expect(r.confidence).toBe(0);
  });
});

describe('analysis: polyphonic transcription', () => {
  const chords = [
    [60, 64, 67],
    [57, 60, 64],
    [53, 57, 60],
    [55, 59, 62],
    [48, 55, 64],
    [62, 65, 69, 72],
  ];
  const timbres = {
    organ: { partials: [1, 0.5, 0.33, 0.25, 0.2, 0.16], attack: 0.02 },
    piano: {
      partials: [1, 0.6, 0.4, 0.3, 0.22, 0.15, 0.1, 0.07],
      decay: 0.8,
      inharmonicity: 0.0004,
      attack: 0.005,
    },
  };
  for (const [name, timbre] of Object.entries(timbres)) {
    it(`3–4 note chords (${name}) → finds the chord tones`, () => {
      const x = silence(SR, chords.length * 1.2 + 0.5);
      chords.forEach((c, i) =>
        c.forEach((p) => addTone(x, SR, 0.2 + i * 1.2, 1.0, p, { ...timbre, amp: 0.15 })),
      );
      const r = transcribePolyphonic(mono(SR, x));
      let tp = 0;
      let fp = 0;
      let total = 0;
      chords.forEach((c, i) => {
        const t = 0.2 + i * 1.2;
        const det = r.notes.filter((n) => Math.abs(n.startSeconds - t) < 0.08).map((n) => n.pitch);
        total += c.length;
        tp += c.filter((p) => det.includes(p)).length;
        fp += det.filter((p) => !c.includes(p)).length;
      });
      expect(tp / total).toBeGreaterThanOrEqual(0.9);
      expect(fp).toBeLessThanOrEqual(1);
      expect(r.meanPolyphony).toBeGreaterThan(2.5);
      // note ends follow the chord ends (±80 ms)
      const first = r.notes.filter((n) => n.startSeconds < 0.3);
      for (const n of first) expect(Math.abs(n.endSeconds - 1.2)).toBeLessThan(0.08);
    });
  }
});

describe('analysis: transcription → IR notes', () => {
  const notes: TranscribedNote[] = [
    { pitch: 60, startSeconds: 1.02, endSeconds: 1.49, velocity: 100, confidence: 0.9 },
    { pitch: 61, startSeconds: 1.53, endSeconds: 1.74, velocity: 90, confidence: 0.4 }, // C# (not in C major)
    { pitch: 64, startSeconds: 1.76, endSeconds: 2.27, velocity: 80, confidence: 0.8, pitchBendCents: 12 },
  ];

  it('quantises to sixteenths at the given tempo and offset', () => {
    const out = transcribedToNotes(notes, { bpm: 120, offsetSeconds: 1, quantizeBeats: 0.25 });
    expect(out.map((n) => [n.pitch, n.tick, n.duration])).toEqual([
      [60, 0, 480],
      [61, 480, 240],
      [64, 720, 480],
    ]);
    expect(out.every((n) => n.origin === 'transcription')).toBe(true);
    expect(out.map((n) => n.confidence)).toEqual([0.9, 0.4, 0.8]);
    expect(new Set(out.map((n) => n.id)).size).toBe(3);
    // deterministic ids
    expect(transcribedToNotes(notes, { bpm: 120, offsetSeconds: 1 }).map((n) => n.id)).toEqual(
      out.map((n) => n.id),
    );
  });

  it('honours quantize strength and no-quantize', () => {
    const half = transcribedToNotes([notes[0]], {
      bpm: 120,
      offsetSeconds: 1,
      quantizeBeats: 0.25,
      quantizeStrength: 0.5,
    });
    expect(half[0].tick).toBe(10); // 0.02 s = 19.2 ticks → halfway to 0
    const raw = transcribedToNotes([notes[0]], { bpm: 120, offsetSeconds: 1, quantizeBeats: 0 });
    expect(raw[0].tick).toBe(19);
    expect(raw[0].duration).toBe(Math.round(0.49 * 960) - 19);
  });

  it('snaps out-of-key notes and lowers their confidence', () => {
    const out = transcribedToNotes(notes, {
      bpm: 120,
      offsetSeconds: 1,
      key: { tonic: 0, mode: 'major' },
      snapToKey: true,
    });
    expect(out.map((n) => n.pitch)).toEqual([60, 62, 64]);
    expect(out[1].confidence).toBeCloseTo(0.34, 2);
    expect(out[0].confidence).toBe(0.9);
  });

  it('folds pitches into an instrument range and resolves same-pitch overlaps', () => {
    const out = transcribedToNotes(
      [
        { pitch: 30, startSeconds: 0, endSeconds: 0.6, velocity: 100, confidence: 1 },
        { pitch: 42, startSeconds: 0.5, endSeconds: 1, velocity: 100, confidence: 1 },
      ],
      { bpm: 60, lowest: 40, highest: 64 },
    );
    expect(out.map((n) => n.pitch)).toEqual([42, 42]);
    expect(out[0].tick + out[0].duration).toBeLessThanOrEqual(out[1].tick);
    expect(out[0].duration).toBeGreaterThan(0);
    expect(PPQ).toBe(480);
  });
});
