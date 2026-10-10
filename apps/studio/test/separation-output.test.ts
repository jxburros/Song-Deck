import { expect, it } from 'vitest';
import { completeSeparatedStems } from '../src/engine/separation-output';
import { toFourStems } from '../src/engine/handlers/analysis';

const audio = (value: number, sampleRate = 8000, length = 800) => ({
  sampleRate,
  channels: [new Float32Array(length).fill(value)],
});
it('keeps every fine-grained stem and removes redundant full accompaniment', () => {
  const result = completeSeparatedStems(
    [
      { name: 'Drums.wav', audio: audio(0.1) },
      { name: 'Electric Guitar.wav', audio: audio(0.2) },
      { name: 'other', audio: audio(0.3) },
      { name: 'instrumental', audio: audio(0.6) },
      { name: 'backing vocals', audio: audio(0.05) },
    ],
    audio(0.65),
  );
  expect(result.map((s) => s.name)).toEqual(['drums', 'electric-guitar', 'other', 'backing-vocals']);
});
it('retains an isolated instrument and its complement without double-counting', () => {
  const result = completeSeparatedStems(
    [
      { name: 'drums', audio: audio(0.2) },
      { name: 'no_drums', audio: audio(0.4) },
    ],
    audio(0.6),
  );
  expect(result.map((s) => s.name)).toEqual(['drums', 'no-drums']);
});
it('keeps a remainder for partial providers at a different sample rate', () => {
  const result = completeSeparatedStems([{ name: 'bass', audio: audio(0.2, 16000, 1600) }], audio(0.6));
  expect(result.map((s) => s.name)).toEqual(['bass', 'other']);
  expect(result[1].audio.sampleRate).toBe(8000);
  expect(result[1].audio.channels[0][400]).toBeCloseTo(0.4, 4);
});
it('folds extended stems onto the rebuild model without dropping channels or tails', () => {
  const stems = toFourStems(
    [
      { name: 'piano', audio: audio(0.1, 16000, 1600) },
      {
        name: 'guitar',
        audio: {
          sampleRate: 8000,
          channels: [new Float32Array(1200).fill(0.2), new Float32Array(1200).fill(0.3)],
        },
      },
      { name: 'backing-vocals', audio: audio(0.1) },
    ],
    audio(0.6),
  );
  expect(stems.other.channels).toHaveLength(2);
  expect(stems.other.channels[0]).toHaveLength(1200);
  expect(stems.other.channels[0][400]).toBeCloseTo(0.3, 4);
  expect(stems.other.channels[1][1000]).toBeCloseTo(0.3, 4);
  expect(stems.vocals.channels[0][400]).toBeCloseTo(0.1);
});
