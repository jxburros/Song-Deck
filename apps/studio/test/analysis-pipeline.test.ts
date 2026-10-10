import { beforeEach, expect, it, vi } from 'vitest';
import { encodeWav, decodeWav } from '@songdeck/audio';
const mock = vi.hoisted(() => ({ separate: vi.fn(), transcribe: vi.fn(), decode: vi.fn() }));
vi.mock('../src/engine/ai', () => ({
  initAi: () => {},
  getRouter: () => ({ select: () => ({ location: 'local', providerName: 'Test' }) }),
  getOrchestrator: () => mock,
}));
vi.mock('../src/state/assets', () => ({ decodeAudioBytes: mock.decode }));
vi.mock('../src/state/store', () => ({ useStudio: { getState: () => ({}) } }));
vi.mock('../src/engine/jobs', () => ({
  jobs: {
    call: async (op: string, args: { audio: Parameters<typeof encodeWav>[0]; bitDepth: 16 | 32 }) => {
      if (op === 'encodeWav') return encodeWav(args.audio, { bitDepth: args.bitDepth });
      throw new Error(`Unexpected job ${op}`);
    },
  },
}));
const { handlers } = await import('../src/engine/handlers/analysis');
const audio = { sampleRate: 8000, channels: [new Float32Array(800).fill(1.2)] };
const provenance = { providerId: 'test', providerName: 'Test', location: 'local' };
const context = (input: unknown) => ({
  input,
  signal: new AbortController().signal,
  attempt: 1,
  progress: vi.fn(),
  log: vi.fn(),
  checkpoint: vi.fn(),
  addCost: vi.fn(),
});
beforeEach(() => {
  mock.decode.mockResolvedValue(audio);
});
it('stores actual WAV when a provider returns compressed audio and preserves all instruments', async () => {
  const compressed = new Uint8Array([73, 68, 51]);
  mock.separate.mockResolvedValue({
    provenance,
    result: {
      stems: {
        guitar: { mimeType: 'audio/mpeg', data: compressed },
        piano: { mimeType: 'audio/mpeg', data: compressed },
        other: { mimeType: 'audio/mpeg', data: compressed },
      },
    },
  });
  const result = await handlers['analysis.separate'](context({ audio, encode: true, provider: 'test' }));
  expect(mock.separate.mock.calls[0][0]).not.toHaveProperty('stems');
  expect(result.stems.map((s: { name: string }) => s.name)).toEqual(['guitar', 'piano', 'other']);
  for (const s of result.stems) {
    expect(new TextDecoder().decode(s.wav.slice(0, 4))).toBe('RIFF');
    expect(decodeWav(s.wav).channels[0][0]).toBeCloseTo(1.2);
  }
});
it('preserves simultaneous provider drum events and never snaps GM pitches to a musical key', async () => {
  mock.transcribe.mockResolvedValue({
    provenance,
    result: {
      notes: [
        { pitch: 36, start: 0.5, end: 0.6, velocity: 90, confidence: 1 },
        { pitch: 42, start: 0.5, end: 0.6, velocity: 75, confidence: 1 },
      ],
    },
  });
  const result = await handlers['analysis.transcribe'](
    context({
      audio,
      provider: 'test',
      source: 'drums',
      bpm: 120,
      key: { tonic: 1, mode: 'major' },
      snapToKey: true,
    }),
  );
  expect(result.notes.map((n: { pitch: number }) => n.pitch)).toEqual([36, 42]);
  expect(result.drumHits).toHaveLength(2);
});
