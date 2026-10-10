import { beforeEach, expect, it, vi } from 'vitest';
import { createEmptySong, type Track } from '@songdeck/core';

const audio = { sampleRate: 1000, channels: [new Float32Array(1000)] };
const state = vi.hoisted(() => ({ getState: vi.fn(), transcribe: vi.fn(), commit: vi.fn() }));
vi.mock('../src/state/store', () => ({ useStudio: state }));
vi.mock('../src/state/assets', () => ({ assetStore: { audio: async () => audio } }));
vi.mock('../src/engine/jobs', () => ({ jobs: { call: async () => audio } }));
vi.mock('../src/engine/player', () => ({ player: {} }));
vi.mock('../src/engine/plugins', () => ({ allCustomInstruments: () => [] }));
vi.mock('../src/engine/capture-tasks', () => ({ enqueueTask: vi.fn() }));
vi.mock('../src/engine/runtime', () => ({ taskQueue: {} }));
vi.mock('../src/engine/handlers/analysis', () => ({ handlers: { 'analysis.transcribe': state.transcribe } }));
const { runMakeMidi } = await import('../src/engine/audio-midi');

const track: Track = {
  id: 'audio',
  name: 'Audio',
  kind: 'audio',
  role: 'vocal',
  instrumentId: 'lead-vocal',
  stemGroup: 'vocals',
  color: '#888888',
  constraints: {},
  notes: [],
  clips: [
    {
      id: 'clip',
      assetId: 'asset',
      tick: 0,
      offsetSeconds: 0,
      durationSeconds: 1,
      gainDb: 0,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
    },
  ],
};
const original = { ...createEmptySong({ title: 'Test', id: 'song' }), tracks: [track] };
let live = structuredClone(original);
let abort: AbortController;
beforeEach(() => {
  live = structuredClone(original);
  abort = new AbortController();
  state.commit.mockReset();
  state.getState.mockImplementation(() => ({
    project: { song: live, meta: { assets: [{ id: 'asset' }] } },
    commit: state.commit,
  }));
});

it.each(['clips', 'tempo', 'notes', 'project', 'cancel'])(
  'does not overwrite a %s change during transcription',
  async (change) => {
    state.transcribe.mockImplementation(async () => {
      live = structuredClone(live);
      if (change === 'clips') live.tracks[0].clips[0].tick = 480;
      if (change === 'tempo') live.tempoMap = [{ tick: 0, bpm: 90 }];
      if (change === 'notes')
        live.tracks[0].notes = [{ id: 'edited', tick: 0, pitch: 64, duration: 480, velocity: 80 }];
      if (change === 'project') live.id = 'other-song';
      if (change === 'cancel') abort.abort();
      return {
        method: 'test',
        confidence: 1,
        transcribed: [{ pitch: 60, startSeconds: 0, endSeconds: 0.5, velocity: 80, confidence: 1 }],
      };
    });
    const input = { trackId: 'audio', mode: 'melody' as const };
    await expect(
      runMakeMidi(input, {
        input,
        signal: abort.signal,
        attempt: 1,
        progress: vi.fn(),
        log: vi.fn(),
        checkpoint: vi.fn(),
        addCost: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(state.commit).not.toHaveBeenCalled();
  },
);
