import { describe, expect, it } from 'vitest';
import { keyName } from '@songdeck/core';
import { chromagram, detectChords, detectKey, keyFromNotes } from '../src/analysis';
import { addTone, chordBlocks, mono, silence } from './analysis-signals';

const SR = 22050;
const blocks = (symbols: string[], d = 2) => symbols.map((symbol) => ({ symbol, duration: d }));

describe('analysis: chroma', () => {
  it('puts a C major triad on C, E, G and estimates detuning', () => {
    const x = silence(SR, 2);
    for (const p of [60, 64, 67]) addTone(x, SR, 0, 2, p + 0.3, { amp: 0.15 }); // 30 cents sharp
    const c = chromagram(mono(SR, x));
    expect(c.tuningCents).toBeGreaterThan(20);
    expect(c.tuningCents).toBeLessThan(40);
    const sum = new Float32Array(12);
    for (const f of c.frames) for (let k = 0; k < 12; k++) sum[k] += f[k];
    const top3 = Array.from(sum)
      .map((v, k) => [v, k] as const)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 3)
      .map(([, k]) => k)
      .sort((a, b) => a - b);
    expect(top3).toEqual([0, 4, 7]);
  });
});

describe('analysis: key detection', () => {
  const cases: [string, string[], string][] = [
    ['E minor (i–iv–V7–i–VI–iv–V–i)', ['Em', 'Am', 'B7', 'Em', 'C', 'Am', 'B', 'Em'], 'E minor'],
    ['G major (I–IV–V–I–vi–IV–V–I)', ['G', 'C', 'D', 'G', 'Em', 'C', 'D', 'G'], 'G major'],
  ];
  for (const [name, prog, expected] of cases) {
    for (const bass of [true, false]) {
      it(`${name}${bass ? ' with bass' : ' without bass'} → ${expected}`, () => {
        const r = detectKey(mono(SR, chordBlocks(SR, blocks(prog), { bass })));
        const got = keyName(r.key);
        if (got !== expected) {
          // relative-key confusion is acceptable only when reported with low confidence
          const rel = expected === 'E minor' ? 'G major' : 'E minor';
          expect(got).toBe(rel);
          expect(r.confidence).toBeLessThan(0.4);
        } else {
          expect(r.confidence).toBeGreaterThan(0.3);
        }
        expect(r.alternatives.length).toBeGreaterThan(0);
        expect(r.alternatives[0].score).toBeLessThanOrEqual(1);
      });
    }
  }

  it('accepts precomputed chroma frames', () => {
    const c = chromagram(mono(SR, chordBlocks(SR, blocks(['C', 'F', 'G', 'C']))));
    expect(keyName(detectKey({ frames: c.frames, bassFrames: c.bassFrames }).key)).toBe('C major');
  });

  it('works on note lists (melodies)', () => {
    const scale = [64, 66, 67, 69, 71, 72, 74, 76, 74, 71, 67, 64];
    const r = keyFromNotes(scale.map((p) => ({ pitch: p, duration: 0.5 })));
    expect(['E minor', 'G major']).toContain(keyName(r.key));
  });

  it('is not confident about silence', () => {
    expect(detectKey(mono(SR, silence(SR, 2))).confidence).toBe(0);
  });
});

describe('analysis: chord recognition', () => {
  it('Em–C–G–D blocks → correct symbols (≥ 3 of 4)', () => {
    const prog = ['Em', 'C', 'G', 'D'];
    const x = chordBlocks(SR, blocks(prog));
    const r = detectChords(mono(SR, x));
    let correct = 0;
    prog.forEach((sym, i) => {
      const mid = i * 2 + 1;
      const seg = r.segments.find((s) => s.start <= mid && s.end > mid);
      if (seg?.symbol === sym) correct++;
    });
    expect(correct).toBeGreaterThanOrEqual(3);
    for (const s of r.segments) {
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
      expect(s.end).toBeGreaterThan(s.start);
    }
  });

  it('places chord changes on beats and recognises sevenths', () => {
    const prog = ['Em', 'Am', 'B7', 'Em'];
    const x = chordBlocks(SR, blocks(prog));
    const beats = Array.from({ length: 17 }, (_, i) => i * 0.5);
    const r = detectChords(mono(SR, x), { beats, key: { tonic: 4, mode: 'minor' } });
    expect(r.segments.map((s) => s.symbol)).toEqual(prog);
    r.segments.slice(1).forEach((s, i) => expect(Math.abs(s.start - (i + 1) * 2)).toBeLessThan(0.01));
    expect(r.segments.map((s) => s.roman)).toEqual(['i', 'iv', 'V7', 'i']);
  });

  it('returns no chords for silence', () => {
    expect(detectChords(mono(SR, silence(SR, 2))).segments).toEqual([]);
  });
});
