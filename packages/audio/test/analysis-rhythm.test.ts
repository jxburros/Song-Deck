import { describe, expect, it } from 'vitest';
import { GM_DRUM, PPQ } from '@songdeck/core';
import { detectOnsets, detectTempo, drumHitsToNotes, tapsToNotes, transcribeDrums, type DrumHit } from '../src/analysis';
import { addClick, clickTrack, mono, renderDrums, rockBeat, silence, type DrumEvent } from './analysis-signals';

const SR = 22050;

function beatAlignmentError(beats: number[], bpm: number, offset: number): number {
  const p = 60 / bpm;
  let worst = 0;
  for (const b of beats) {
    const k = Math.round((b - offset) / p);
    worst = Math.max(worst, Math.abs(b - offset - k * p));
  }
  return worst;
}

describe('analysis: onsets', () => {
  it('finds click onsets within 15 ms', () => {
    const times = [0.5, 1.13, 1.71, 2.4, 3.05, 3.77];
    const x = silence(SR, 4.5);
    for (const t of times) addClick(x, SR, t);
    const r = detectOnsets(mono(SR, x));
    expect(r.times.length).toBe(times.length);
    times.forEach((t, i) => expect(Math.abs(r.times[i] - t)).toBeLessThan(0.015));
    expect(r.envelope.length).toBeGreaterThan(100);
    expect(r.hopSeconds).toBeCloseTo(0.0116, 3);
  });

  it('returns nothing for silence', () => {
    const r = detectOnsets(mono(SR, silence(SR, 2)));
    expect(r.times).toEqual([]);
  });
});

describe('analysis: tempo, beats, meter', () => {
  for (const bpm of [90, 120, 164]) {
    it(`click track at ${bpm} BPM → ±2 %, beats aligned, 4/4 with downbeats`, () => {
      const x = clickTrack(SR, bpm, 14, { accent: true, offset: 0.3 });
      const r = detectTempo(mono(SR, x));
      expect(Math.abs(r.bpm - bpm) / bpm).toBeLessThan(0.02);
      expect(r.confidence).toBeGreaterThan(0.6);
      expect(beatAlignmentError(r.beats, bpm, 0.3)).toBeLessThan(0.03);
      expect(r.beats.length).toBeGreaterThan((14 - 1) / (60 / bpm) - 3);
      expect(r.meter).toEqual({ numerator: 4, denominator: 4 });
      // accented clicks mark the bar lines
      expect(Math.abs(r.downbeats[0] - 0.3)).toBeLessThan(0.03);
      for (let i = 1; i < r.downbeats.length; i++) expect(r.downbeats[i] - r.downbeats[i - 1]).toBeCloseTo((4 * 60) / bpm, 1);
    });

    it(`rock drum pattern at ${bpm} BPM → ±2 % (no octave error)`, () => {
      const bars = Math.floor(13 / ((4 * 60) / bpm));
      const x = renderDrums(SR, 14, rockBeat(bpm, bars, { offset: 0.25 }));
      const r = detectTempo(mono(SR, x));
      expect(Math.abs(r.bpm - bpm) / bpm).toBeLessThan(0.02);
      expect(beatAlignmentError(r.beats, bpm, 0.25)).toBeLessThan(0.04);
      expect(r.meter.numerator).toBe(4);
    });
  }

  it('detects 3/4 from a waltz pattern', () => {
    const bpm = 140;
    const x = renderDrums(SR, 14, rockBeat(bpm, Math.floor(13 / ((3 * 60) / bpm)), { offset: 0.25, beatsPerBar: 3 }));
    const r = detectTempo(mono(SR, x));
    expect(Math.abs(r.bpm - bpm) / bpm).toBeLessThan(0.02);
    expect(r.meter.numerator).toBe(3);
    expect(Math.abs(r.downbeats[0] - 0.25)).toBeLessThan(0.04);
  });

  it('reports zero confidence for silence', () => {
    const r = detectTempo(mono(SR, silence(SR, 4)));
    expect(r.confidence).toBe(0);
    expect(r.beats).toEqual([]);
  });
});

const CLASS: Record<DrumEvent['drum'], number[]> = {
  kick: [36],
  snare: [38],
  hat: [42],
  'open-hat': [46],
  crash: [49],
  tom: [41, 43, 45, 47, 48, 50],
};

function drumAccuracy(events: DrumEvent[], hits: DrumHit[]): { recall: number; falsePositives: number } {
  const used = new Set<number>();
  let ok = 0;
  for (const e of events) {
    const i = hits.findIndex((h, j) => !used.has(j) && Math.abs(h.time - e.time) < 0.05 && CLASS[e.drum].includes(h.drum));
    if (i >= 0) {
      used.add(i);
      ok++;
    }
  }
  return { recall: ok / events.length, falsePositives: hits.length - used.size };
}

describe('analysis: drum transcription', () => {
  for (const sr of [22050, 44100]) {
    it(`kick / snare / hat pattern (${sr} Hz) → ≥ 85 % correct classes`, () => {
      const events = rockBeat(120, 4, { offset: 0.3 });
      const r = transcribeDrums(mono(sr, renderDrums(sr, 9, events)));
      const acc = drumAccuracy(events, r.hits);
      expect(acc.recall).toBeGreaterThanOrEqual(0.85);
      expect(acc.falsePositives).toBeLessThanOrEqual(events.length * 0.1);
      expect(r.confidence).toBeGreaterThan(0.5);
      for (const h of r.hits) {
        expect(h.velocity).toBeGreaterThanOrEqual(1);
        expect(h.velocity).toBeLessThanOrEqual(127);
        expect(h.confidence).toBeGreaterThan(0);
        expect(h.confidence).toBeLessThanOrEqual(1);
      }
    });
  }

  it('separates open hats, crash and toms by decay and pitch', () => {
    const ev: DrumEvent[] = [];
    for (let i = 0; i < 4; i++) ev.push({ time: 0.3 + i * 0.5, drum: 'kick' }, { time: 0.55 + i * 0.5, drum: 'open-hat' });
    ev.push({ time: 2.5, drum: 'crash' }, { time: 2.5, drum: 'kick' });
    [200, 160, 120, 95].forEach((hz, i) => ev.push({ time: 4.0 + i * 0.25, drum: 'tom', hz }));
    const r = transcribeDrums(mono(SR, renderDrums(SR, 6, ev)));
    const acc = drumAccuracy(ev, r.hits);
    expect(acc.recall).toBeGreaterThanOrEqual(0.85);
    // toms descend in pitch
    const toms = r.hits.filter((h) => h.time > 3.9 && h.time < 4.9 && [41, 43, 45, 47, 48, 50].includes(h.drum)).map((h) => h.drum);
    expect(toms.length).toBe(4);
    for (let i = 1; i < toms.length; i++) expect(toms[i]).toBeLessThan(toms[i - 1]);
  });

  it('converts hits to quantised GM drum notes', () => {
    const notes = drumHitsToNotes(
      [
        { time: 0.51, drum: 36, velocity: 110, confidence: 0.9 },
        { time: 0.52, drum: 42, velocity: 70, confidence: 0.8 },
        { time: 0.99, drum: 38, velocity: 100, confidence: 0.85 },
      ],
      { bpm: 120, offsetSeconds: 0.5 },
    );
    expect(notes.map((n) => [n.pitch, n.tick])).toEqual([
      [36, 0],
      [42, 0],
      [38, PPQ],
    ]);
    for (const n of notes) {
      expect(n.origin).toBe('transcription');
      expect(n.confidence).toBeGreaterThan(0.7);
    }
  });
});

describe('analysis: tap a rhythm (§27)', () => {
  it('quantises taps relative to the first tap', () => {
    const taps = [10.02, 10.49, 11.03, 11.26, 11.51, 12.0];
    const notes = tapsToNotes(taps, { bpm: 120, drum: GM_DRUM.KICK });
    expect(notes.map((n) => n.tick)).toEqual([0, 480, 960, 1200, 1440, 1920]);
    expect(notes.every((n) => n.pitch === 36 && n.velocity === 100)).toBe(true);
    expect(new Set(notes.map((n) => n.id)).size).toBe(notes.length);
  });

  it('supports an explicit offset, eighth-note grid and default clap', () => {
    // 60 BPM: one beat = 1 s = 480 ticks; eighth grid = 240 ticks
    const notes = tapsToNotes([0.52, 1.49, 2.0], { bpm: 60, quantizeBeats: 0.5, offsetSeconds: 0 });
    expect(notes.map((n) => n.tick)).toEqual([240, 720, 960]);
    expect(notes[0].pitch).toBe(GM_DRUM.CLAP);
    // two taps in one grid slot collapse into one note
    expect(tapsToNotes([0.27, 0.38], { bpm: 60, quantizeBeats: 0.5, offsetSeconds: 0 }).length).toBe(1);
  });
});
