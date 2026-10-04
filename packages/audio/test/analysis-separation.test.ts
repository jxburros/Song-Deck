import { describe, expect, it } from 'vitest';
import { classifyStem, separateSources, segmentStructure, detectTempo } from '../src/analysis';
import type { AudioData } from '../src/types';
import {
  addInto,
  addTone,
  correlation,
  hummedMelody,
  mono,
  renderDrums,
  rockBeat,
  silence,
  stereo,
  synthSong,
} from './analysis-signals';

const SR = 22050;

function synthMix(sr: number, dur = 10) {
  const drums = renderDrums(sr, dur, rockBeat(120, 4, { offset: 0.5 }));
  const bass = silence(sr, dur);
  const roots = [40, 36, 43, 38];
  for (let i = 0; i < 10; i++)
    addTone(bass, sr, 0.5 + i * 0.9, 0.85, roots[i % 4], {
      amp: 0.25,
      partials: [1, 0.5, 0.25],
      attack: 0.01,
    });
  const vocal = hummedMelody(
    sr,
    Array.from({ length: 13 }, (_, i) => ({
      pitch: [64, 67, 69, 71, 72, 71, 69, 67][i % 8],
      start: 0.5 + i * 0.7,
      duration: 0.6,
    })),
    {
      seconds: dur,
      seed: 4,
      partials: [1, 0.6, 0.4, 0.25, 0.15, 0.1],
    },
  );
  const padL = silence(sr, dur);
  const padR = silence(sr, dur);
  const chords = [
    [52, 55, 59],
    [48, 52, 55],
    [55, 59, 62],
  ];
  for (let i = 0; i < 3; i++) {
    for (const p of chords[i]) {
      addTone(padL, sr, 0.5 + i * 3, 3, p + 12, { amp: 0.06, partials: [1, 0.4, 0.2, 0.1], attack: 0.3 });
      addTone(padR, sr, 0.5 + i * 3, 3, p + 19, { amp: 0.06, partials: [1, 0.4, 0.2, 0.1], attack: 0.3 });
    }
  }
  const L = new Float32Array(drums.length);
  const R = new Float32Array(drums.length);
  for (const [src, gl, gr] of [
    [drums, 1, 1],
    [bass, 1, 1],
    [vocal, 1, 1],
    [padL, 1, 0],
    [padR, 0, 1],
  ] as const) {
    addInto(L, src, gl);
    addInto(R, src, gr);
  }
  return {
    mix: stereo(sr, L, R),
    sources: {
      drums: [drums, drums],
      bass: [bass, bass],
      vocals: [vocal, vocal],
      other: [padL, padR],
    } as Record<string, [Float32Array, Float32Array]>,
  };
}

describe('analysis: source separation', () => {
  for (const sr of [22050, 44100]) {
    it(`each stem correlates most with its own source; stems sum to the mix (${sr} Hz)`, () => {
      const { mix, sources } = synthMix(sr);
      const progress: number[] = [];
      const r = separateSources(mix, { onProgress: (p) => progress.push(p) });
      expect(r.stems.drums.sampleRate).toBe(sr);
      expect(r.stems.vocals.channels.length).toBe(2);
      for (const stem of ['drums', 'bass', 'vocals', 'other'] as const) {
        const out = r.stems[stem];
        const corr = (name: string): number =>
          (correlation(out.channels[0], sources[name][0]) + correlation(out.channels[1], sources[name][1])) /
          2;
        const own = corr(stem);
        for (const other of Object.keys(sources))
          if (other !== stem) expect(own).toBeGreaterThan(corr(other));
        expect(own).toBeGreaterThan(0.5);
        expect(r.confidence[stem]).toBeGreaterThan(0);
        expect(r.confidence[stem]).toBeLessThan(0.8); // DSP separation: honest, never "certain"
      }
      // perfect reconstruction: Σ stems ≈ mix
      let err = 0;
      let sig = 0;
      for (let c = 0; c < 2; c++) {
        const m = mix.channels[c];
        for (let i = 0; i < m.length; i++) {
          const s =
            r.stems.drums.channels[c][i] +
            r.stems.bass.channels[c][i] +
            r.stems.vocals.channels[c][i] +
            r.stems.other.channels[c][i];
          err += (s - m[i]) ** 2;
          sig += m[i] ** 2;
        }
      }
      expect(10 * Math.log10(err / sig)).toBeLessThan(-60);
      expect(progress[progress.length - 1]).toBe(1);
      for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    });
  }

  it('mono input works but reports a lower vocal confidence', () => {
    const { mix } = synthMix(SR, 6);
    const monoMix: AudioData = { sampleRate: SR, channels: [mix.channels[0]] };
    const r = separateSources(monoMix);
    const st = separateSources(mix);
    expect(r.stems.vocals.channels.length).toBe(1);
    expect(r.confidence.vocals).toBeLessThan(st.confidence.vocals);
    expect(r.method).toContain('mono');
  });

  it('honours an AbortSignal', () => {
    const { mix } = synthMix(SR, 4);
    const ac = new AbortController();
    ac.abort();
    expect(() => separateSources(mix, { signal: ac.signal })).toThrowError(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });
});

describe('analysis: stem classification', () => {
  const dur = 10;
  const chords = [
    [52, 55, 59],
    [48, 52, 55],
    [55, 59, 62],
    [50, 54, 57],
  ];
  const stems: Record<string, () => Float32Array> = {
    'drum-kit': () => renderDrums(SR, dur, rockBeat(120, 4, { offset: 0.3 })),
    'electric-bass': () => {
      const x = silence(SR, dur);
      for (let i = 0; i < 18; i++)
        addTone(x, SR, 0.3 + i * 0.5, 0.45, [40, 36, 43, 38][Math.floor(i / 4) % 4] + (i % 2 ? 12 : 0), {
          amp: 0.4,
          partials: [1, 0.5, 0.25, 0.1],
          attack: 0.005,
          decay: 0.6,
        });
      return x;
    },
    'lead-vocal': () =>
      hummedMelody(
        SR,
        Array.from({ length: 13 }, (_, i) => ({
          pitch: [64, 67, 69, 71, 72, 71, 69, 67][i % 8],
          start: 0.3 + i * 0.7,
          duration: 0.6,
        })),
        {
          seconds: dur,
          seed: 4,
          partials: [1, 0.6, 0.4, 0.25, 0.15, 0.1],
          breath: 0.003,
        },
      ),
    'synth-pad': () => {
      const x = silence(SR, dur);
      for (let i = 0; i < 4; i++)
        for (const p of chords[i])
          addTone(x, SR, 0.3 + i * 2.4, 2.4, p + 12, {
            amp: 0.08,
            partials: [1, 0.5, 0.3, 0.2, 0.1],
            attack: 0.4,
            release: 0.4,
          });
      return x;
    },
    piano: () => {
      const x = silence(SR, dur);
      for (let i = 0; i < 13; i++)
        for (const p of chords[Math.floor(i / 4) % 4])
          addTone(x, SR, 0.3 + i * 0.7, 0.7, p + 12 + (i % 2 ? 12 : 0), {
            amp: 0.1,
            partials: [1, 0.6, 0.4, 0.3, 0.2, 0.15, 0.1],
            attack: 0.003,
            decay: 0.35,
            inharmonicity: 0.0003,
          });
      return x;
    },
    'synth-lead': () => {
      const x = silence(SR, dur);
      for (let i = 0; i < 20; i++)
        addTone(x, SR, 0.3 + i * 0.45, 0.4, [72, 74, 76, 79, 76, 74][i % 6], {
          amp: 0.15,
          partials: Array.from({ length: 14 }, (_, k) => 1 / (k + 1)),
          attack: 0.01,
        });
      return x;
    },
  };
  for (const [expected, make] of Object.entries(stems)) {
    it(`synthetic ${expected} stem → ${expected}`, () => {
      const r = classifyStem(mono(SR, make()));
      expect(r.instrumentId).toBe(expected);
      expect(r.confidence).toBeGreaterThan(0.3);
      expect(r.confidence).toBeLessThanOrEqual(0.85);
      expect(Object.keys(r.features).length).toBeGreaterThan(10);
    });
  }

  it('maps instruments to track roles and respects candidate restrictions', () => {
    const pad = stems['synth-pad']();
    const r = classifyStem(mono(SR, pad), { candidates: ['piano', 'acoustic-guitar'] });
    expect(['piano', 'acoustic-guitar']).toContain(r.instrumentId);
    expect(classifyStem(mono(SR, stems['drum-kit']())).role).toBe('drums');
    expect(classifyStem(mono(SR, stems['electric-bass']())).role).toBe('bass');
  });
});

describe('analysis: structure segmentation', () => {
  const A = { label: 'A', bars: 4, chords: ['Em', 'C', 'Em', 'C'], energy: 0.3 };
  const B = { label: 'B', bars: 4, chords: ['G', 'D', 'G', 'D'], energy: 0.9 };

  it('ABAB arrangement → boundaries at the section starts, A/B labels, verse/chorus kinds', () => {
    const song = synthSong(SR, [A, B, A, B]);
    const audio = stereo(SR, song.left, song.right);
    const tempo = detectTempo(audio);
    const r = segmentStructure(audio, { beats: tempo.beats, downbeats: tempo.downbeats, bpm: tempo.bpm });
    expect(r.segments.length).toBe(4);
    r.segments.forEach((s, i) => expect(Math.abs(s.startSeconds - song.sectionStarts[i])).toBeLessThan(0.25));
    expect(r.segments.map((s) => s.label)).toEqual(['A', 'B', 'A', 'B']);
    expect(r.segments.map((s) => s.kind)).toEqual(['verse', 'chorus', 'verse', 'chorus']);
    expect(r.segments[r.segments.length - 1].endSeconds).toBeCloseTo(song.left.length / SR, 2);
    for (const s of r.segments) expect(s.confidence).toBeGreaterThan(0.3);
  });

  it('verse / chorus / bridge arrangement with a short bridge', () => {
    const song = synthSong(SR, [
      { ...A, bars: 8 },
      { ...B, bars: 8 },
      { ...A, bars: 8 },
      { ...B, bars: 8 },
      { label: 'C', bars: 4, chords: ['Am', 'F'], energy: 0.6 },
      { ...B, bars: 8 },
    ]);
    const beats = Array.from({ length: 200 }, (_, i) => 0.25 + i * 0.5).filter(
      (b) => b < song.left.length / SR,
    );
    const r = segmentStructure(stereo(SR, song.left, song.right), { beats, bpm: 120 });
    expect(r.segments.map((s) => Math.round(s.startSeconds * 4) / 4)).toEqual(song.sectionStarts);
    expect(r.segments.map((s) => s.kind)).toEqual(['verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus']);
    expect(r.segments.map((s) => s.label)).toEqual(['A', 'B', 'A', 'B', 'C', 'B']);
  });
});
