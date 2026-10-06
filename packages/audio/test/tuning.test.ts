import { describe, expect, it } from 'vitest';
import { trackPitch, type PitchTrack } from '../src/analysis';
import { planRetune, pitchMarks, psolaResynthesize, retuneAudio } from '../src/tuning';
import { addTone, hummedMelody, midiHz, mono, silence, stereo } from './analysis-signals';

const cents = (a: number, b: number) => 1200 * Math.log2(a / b);
const VOICE = { partials: [1, 0.7, 0.5, 0.35, 0.25, 0.15], amp: 0.4 };

/** Voiced f0 (Hz) of `buf` between `from` and `to` seconds. */
function pitchBetween(track: PitchTrack, from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < track.f0.length; i++)
    if (track.f0[i] > 0 && track.times[i] >= from && track.times[i] <= to) out.push(track.f0[i]);
  return out;
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];

function rmsDb(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return 10 * Math.log10(s / x.length + 1e-20);
}

describe('tuning: PSOLA resynthesis', () => {
  it('reproduces the input exactly when no pitch changes (voiced and unvoiced)', () => {
    const sr = 44100;
    const x = silence(sr, 2);
    addTone(x, sr, 0.2, 1.4, 57, { ...VOICE, vibratoHz: 5.5, vibratoCents: 40 });
    for (let i = 0; i < x.length; i += 7) x[i] += 0.01 * Math.sin(i * 12.9898); // noise floor
    const track = trackPitch(mono(sr, x), { hopSeconds: 0.005 });
    const marks = pitchMarks(x, sr, { hopSeconds: track.hopSeconds, f0: track.f0 });
    expect(marks.voiced.some((v) => v === 1)).toBe(true);
    for (let i = 1; i < marks.marks.length; i++) expect(marks.marks[i]).toBeGreaterThan(marks.marks[i - 1]);
    const [y] = psolaResynthesize([x], marks, () => 1);
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(x[i] - y[i]));
    expect(err).toBeLessThan(1e-6);
  });

  it('places voiced marks one period apart', () => {
    const sr = 44100;
    const x = silence(sr, 1.5);
    addTone(x, sr, 0.2, 1.1, 45, VOICE); // 110 Hz
    const track = trackPitch(mono(sr, x), { hopSeconds: 0.005 });
    const { marks, voiced } = pitchMarks(x, sr, { hopSeconds: track.hopSeconds, f0: track.f0 });
    const gaps: number[] = [];
    for (let i = 1; i < marks.length; i++) if (voiced[i] && voiced[i - 1]) gaps.push(marks[i] - marks[i - 1]);
    expect(gaps.length).toBeGreaterThan(100);
    expect(Math.abs(median(gaps) - sr / 110)).toBeLessThan(2);
  });
});

describe('tuning: retuneAudio', () => {
  for (const sr of [44100, 22050]) {
    for (const target of [58, 55, 60]) {
      it(`hard-tunes A3 with vibrato to ${target} @ ${sr} Hz (pitch exact, level kept)`, () => {
        const x = silence(sr, 3);
        addTone(x, sr, 0.2, 2.6, 57, { ...VOICE, vibratoHz: 5.5, vibratoCents: 30, vibratoDelay: 0.5 });
        const { audio, report } = retuneAudio(
          mono(sr, x),
          [{ startSeconds: 0.2, endSeconds: 2.8, pitch: target }],
          { amount: 1, flatten: 1, speedMs: 0 },
        );
        expect(audio.channels[0].length).toBe(x.length);
        expect(report.tunedNotes).toBe(1);
        const f = pitchBetween(trackPitch(audio), 0.45, 2.6);
        expect(Math.abs(cents(median(f), midiHz(target)))).toBeLessThan(5);
        // vibrato flattened: every frame within 15 cents of the target
        for (const v of f) expect(Math.abs(cents(v, midiHz(target)))).toBeLessThan(15);
        expect(Math.abs(rmsDb(audio.channels[0]) - rmsDb(x))).toBeLessThan(1.5);
      });
    }
  }

  it('keeps the intonation offset with amount 0 and corrects it with amount 1', () => {
    const sr = 22050;
    const x = silence(sr, 2);
    addTone(x, sr, 0.2, 1.6, 57.35, VOICE); // 35 cents sharp of A3
    const note = [{ startSeconds: 0.2, endSeconds: 1.8, pitch: 59 }];
    const keep = retuneAudio(mono(sr, x), note, { amount: 0, flatten: 0, speedMs: 0 });
    const exact = retuneAudio(mono(sr, x), note, { amount: 1, flatten: 0, speedMs: 0 });
    const keepCents = cents(median(pitchBetween(trackPitch(keep.audio), 0.4, 1.6)), midiHz(59));
    const exactCents = cents(median(pitchBetween(trackPitch(exact.audio), 0.4, 1.6)), midiHz(59));
    expect(Math.abs(keepCents - 35)).toBeLessThan(6); // moved by exactly two semitones
    expect(Math.abs(exactCents)).toBeLessThan(6);
  });

  it('keeps vibrato with flatten 0', () => {
    const sr = 22050;
    const x = silence(sr, 2.5);
    addTone(x, sr, 0.2, 2.1, 57, { ...VOICE, vibratoHz: 5, vibratoCents: 50 });
    const { audio } = retuneAudio(mono(sr, x), [{ startSeconds: 0.2, endSeconds: 2.3, pitch: 59 }], {
      amount: 1,
      flatten: 0,
      speedMs: 0,
    });
    const devs = pitchBetween(trackPitch(audio), 0.5, 2.1).map((v) => cents(v, midiHz(59)));
    expect(Math.max(...devs) - Math.min(...devs)).toBeGreaterThan(60);
  });

  it('tunes a sung melody note by note, moving only the edited note', () => {
    const sr = 22050;
    const melody = [
      { pitch: 60, start: 0.3, duration: 0.6 },
      { pitch: 62, start: 1.0, duration: 0.6 },
      { pitch: 64, start: 1.7, duration: 0.8 },
    ];
    const x = hummedMelody(sr, melody, { detuneCents: 20, seed: 3 });
    const edited = melody.map((m, i) => ({
      startSeconds: m.start,
      endSeconds: m.start + m.duration,
      pitch: i === 1 ? 63 : m.pitch,
    }));
    const { audio, report } = retuneAudio(mono(sr, x), edited, { amount: 1, flatten: 0.5, speedMs: 20 });
    expect(report.tunedNotes).toBe(3);
    const out = trackPitch(audio);
    for (const [i, m] of melody.entries()) {
      const f = pitchBetween(out, m.start + 0.15, m.start + m.duration - 0.1);
      expect(Math.abs(cents(median(f), midiHz(edited[i].pitch)))).toBeLessThan(25);
    }
  });

  it('leaves audio outside notes, and notes over silence, untouched', () => {
    const sr = 22050;
    const x = silence(sr, 3);
    addTone(x, sr, 0.2, 1, 57, VOICE);
    addTone(x, sr, 1.6, 1, 57, VOICE);
    const { audio, report } = retuneAudio(
      mono(sr, x),
      [
        { startSeconds: 0.2, endSeconds: 1.2, pitch: 59 },
        { startSeconds: 2.7, endSeconds: 2.95, pitch: 64 }, // nothing sung there
      ],
      { amount: 1, flatten: 0, speedMs: 0 },
    );
    expect(report).toMatchObject({ tunedNotes: 1, skippedNotes: 1 });
    const out = trackPitch(audio);
    expect(Math.abs(cents(median(pitchBetween(out, 0.4, 1.0)), midiHz(59)))).toBeLessThan(6);
    expect(Math.abs(cents(median(pitchBetween(out, 1.8, 2.4)), midiHz(57)))).toBeLessThan(6);
  });

  it('returns an unchanged copy when the notes already match', () => {
    const sr = 22050;
    const x = silence(sr, 1.5);
    addTone(x, sr, 0.2, 1, 57, VOICE);
    const { audio, report } = retuneAudio(mono(sr, x), [{ startSeconds: 0.2, endSeconds: 1.2, pitch: 57 }], {
      amount: 0,
      flatten: 0,
    });
    expect(report.maxShiftSemitones).toBe(0);
    expect(audio.channels[0]).toEqual(x);
    expect(audio.channels[0]).not.toBe(x);
  });

  it('shifts both stereo channels with the same marks', () => {
    const sr = 22050;
    const l = silence(sr, 1.6);
    addTone(l, sr, 0.2, 1.2, 57, VOICE);
    const r = l.map((v) => v * 0.5);
    const { audio } = retuneAudio(stereo(sr, l, r), [{ startSeconds: 0.2, endSeconds: 1.4, pitch: 60 }], {
      amount: 1,
      flatten: 1,
      speedMs: 0,
    });
    expect(audio.channels).toHaveLength(2);
    for (let i = 0; i < l.length; i += 97)
      expect(audio.channels[1][i]).toBeCloseTo(audio.channels[0][i] * 0.5, 5);
  });
});

describe('tuning: planRetune', () => {
  const track = (pitches: number[], hop = 0.01): PitchTrack => ({
    times: Float32Array.from(pitches, (_, i) => i * hop),
    f0: Float32Array.from(pitches, (p) => (p > 0 ? midiHz(p) : 0)),
    confidence: Float32Array.from(pitches, (p) => (p > 0 ? 1 : 0)),
    rms: new Float32Array(pitches.length).fill(0.1),
    hopSeconds: hop,
  });

  it('plans whole-semitone moves plus the chosen share of the centre correction', () => {
    const t = track(Array(100).fill(57.3));
    const notes = [{ startSeconds: 0, endSeconds: 1, pitch: 59 }];
    const half = planRetune(t, notes, { amount: 0.5, flatten: 0, speedMs: 0 });
    expect(half.shift[50]).toBeCloseTo(2 - 0.15, 4);
    expect(half.report.meanCorrectionCents).toBe(185);
  });

  it('glides between corrections with a retune speed', () => {
    const t = track([...Array(50).fill(57), ...Array(50).fill(60)]);
    const notes = [
      { startSeconds: 0, endSeconds: 0.5, pitch: 58 },
      { startSeconds: 0.5, endSeconds: 1, pitch: 60 },
    ];
    const hard = planRetune(t, notes, { amount: 1, speedMs: 0 });
    const soft = planRetune(t, notes, { amount: 1, speedMs: 80 });
    expect(hard.shift[49]).toBeCloseTo(1, 5);
    expect(hard.shift[50]).toBeCloseTo(0, 5);
    expect(soft.shift[49]).toBeGreaterThan(0.2);
    expect(soft.shift[49]).toBeLessThan(0.8);
    expect(soft.shift[10]).toBeGreaterThan(0.9);
  });
});
