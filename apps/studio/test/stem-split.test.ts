import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioData } from '@songdeck/audio';

const runTask = vi.fn();
vi.mock('../src/engine/capture-tasks', () => ({ runTask: (...a: unknown[]) => runTask(...a) }));

const { splitIntoStems, stemInfo } = await import('../src/engine/stem-split');

const tone = (amp: number, n = 1000): AudioData => ({
  sampleRate: 1000,
  channels: [Float32Array.from({ length: n }, (_, i) => Math.sin(i / 3) * amp)],
});
const wav = new Uint8Array([1]);

describe('separating an uploaded song into stems', () => {
  beforeEach(() => runTask.mockReset());

  it('keeps the parts that are present, labelled as instruments, and drops near-silent ones', async () => {
    runTask.mockReturnValue({
      id: 't',
      done: Promise.resolve({
        method: 'On-device DSP separation',
        stems: [
          { name: 'drums', audio: tone(0.3), wav, confidence: 0.7 },
          { name: 'bass', audio: tone(0.2), wav },
          { name: 'vocals', audio: tone(0.0005), wav }, // −60 dB: not in this song
          { name: 'other', audio: tone(0.1), wav },
        ],
      }),
    });
    const res = await splitIntoStems(tone(0.5), 'Song');
    expect(runTask.mock.calls[0][0]).toMatchObject({
      type: 'analysis.separate',
      input: { encode: true, provider: 'auto' },
    });
    expect(res.stems.map((s) => [s.name, s.label, s.role, s.stemGroup])).toEqual([
      ['drums', 'Drums', 'drums', 'drums'],
      ['bass', 'Bass', 'bass', 'bass'],
      ['other', 'Other', 'custom', 'others'],
    ]);
    expect(res.skipped).toEqual(['vocals']);
    expect(res.stems[0].confidence).toBe(0.7);
  });

  it('fails clearly when nothing could be separated', async () => {
    runTask.mockReturnValue({
      id: 't',
      done: Promise.resolve({ method: 'x', stems: [{ name: 'drums', audio: tone(0), wav }] }),
    });
    await expect(splitIntoStems(tone(0.5), 'Quiet')).rejects.toThrow('No separable parts found in “Quiet”');
  });

  it('describes unknown stem names as other parts', () => {
    expect(stemInfo('piano')).toMatchObject({ label: 'piano', role: 'custom', stemGroup: 'others' });
  });
});
