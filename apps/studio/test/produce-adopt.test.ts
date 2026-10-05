import { describe, expect, it } from 'vitest';
import {
  createEmptySong,
  defaultChannelStrip,
  type AudioAssetMeta,
  type ProductionCandidate,
  type Track,
} from '@songdeck/core';
import { adoptCandidate, removeProducedAudio } from '../src/views/produce/adopt';
import { isProducedTrack } from '../src/engine/produce-model';

const track = (id: string): Track => ({
  id,
  name: id,
  kind: 'midi',
  role: 'keys',
  instrumentId: 'piano',
  color: '#66aaff',
  stemGroup: 'keys',
  constraints: {},
  notes: [],
  clips: [],
});
const audio: AudioAssetMeta = {
  id: 'audio',
  name: 'mix.wav',
  kind: 'generation',
  path: 'audio/mix.wav',
  mimeType: 'audio/wav',
  sampleRate: 44100,
  channels: 2,
  durationSeconds: 1,
  bytes: 100,
  createdAt: '2026-10-05T00:00:00Z',
};
const candidate: ProductionCandidate = {
  id: 'candidate',
  label: 'A',
  providerId: 'internal',
  seed: 1,
  mixAssetId: audio.id,
  stemAssetIds: {},
  createdAt: audio.createdAt,
  strategy: 'full',
};

function fixture() {
  const song = createEmptySong();
  song.tracks = [track('keys'), track('bass')];
  song.mixer.channels = { keys: defaultChannelStrip({ solo: true }), bass: defaultChannelStrip() };
  return song;
}

describe('adopting produced audio', () => {
  it.each(['mix', 'stems'])(
    'keeps %s audible when a source is soloed, and restores the original mix',
    (kind) => {
      const song = fixture();
      const c = kind === 'stems' ? { ...candidate, stemAssetIds: { keys: audio.id } } : candidate;
      const next = adoptCandidate(song, c, [audio]).song;
      const produced = next.tracks.find(isProducedTrack)!;
      // The renderer excludes non-solo tracks whenever any channel is soloed.
      expect(next.mixer.channels[produced.id]).toMatchObject({ mute: false, solo: true });
      expect(next.mixer.channels.keys).toMatchObject({ mute: true, solo: true });
      expect(removeProducedAudio(next).mixer).toEqual(song.mixer);
      expect(song.mixer.channels.keys.mute).toBe(false);
    },
  );

  it('switches full-mix candidates without mutating a previous revision mute list', () => {
    const first = adoptCandidate(fixture(), candidate, [audio]).song;
    first.tracks.push(track('new-track'));
    first.mixer.channels['new-track'] = defaultChannelStrip();
    const before = structuredClone(first);
    const next = adoptCandidate(first, { ...candidate, id: 'candidate-b', label: 'B' }, [audio]).song;
    expect(first).toEqual(before);
    expect(next.mixer.channels['new-track'].mute).toBe(true);
    expect(removeProducedAudio(next).mixer.channels['new-track'].mute).toBe(false);
  });
});
