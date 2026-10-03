import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSong } from '@songdeck/audio';
import { createEmptySong, defaultChannelStrip, type InstrumentProfile, type Song, type Track } from '@songdeck/core';
import { loadSfzInstrument } from '../src/engine/sfz-loader';

const PLUGIN_DIR = join(__dirname, '../../../plugins/felt-keys-sfz');
const fetchBytes = async (path: string) => new Uint8Array(await readFile(join(PLUGIN_DIR, path)));

const profile: InstrumentProfile = {
  id: 'felt-keys',
  name: 'Felt Keys (sampled)',
  family: 'keys',
  gmProgram: 4,
  range: { low: 21, high: 108 },
  polyphony: 'poly',
  defaultRole: 'keys',
  defaultFunction: 'accompaniment',
  articulations: ['normal'],
  patchId: 'sfz:felt-keys-sfz/felt-keys',
  clef: 'grand',
  stemGroup: 'keys',
  custom: true,
};

/** One bar at 120 BPM with a single middle C on the sampled instrument. */
function oneNoteSong(): Song {
  const song = createEmptySong({ title: 'Felt', bpm: 120 });
  song.sections = [{ id: 'sec', name: 'A', kind: 'verse', bars: 1, energy: 50 }];
  const track = {
    id: 'trk',
    name: 'Keys',
    kind: 'midi',
    role: 'keys',
    instrumentId: 'felt-keys',
    constraints: {},
    notes: [{ id: 'n1', pitch: 60, tick: 0, duration: 960, velocity: 100 }],
    clips: [],
    stemGroup: 'keys',
  } as unknown as Track;
  song.tracks = [track];
  song.mixer.channels.trk = defaultChannelStrip();
  return song;
}

/** Dominant frequency by autocorrelation over the steady part of the note. */
function pitchHz(x: Float32Array, sr: number): number {
  const start = Math.round(sr * 0.1);
  const len = Math.round(sr * 0.2);
  let best = 0;
  let bestLag = 0;
  for (let lag = Math.round(sr / 1000); lag < Math.round(sr / 60); lag++) {
    let s = 0;
    for (let i = 0; i < len; i++) s += x[start + i] * x[start + i + lag];
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  return sr / bestLag;
}

describe('SFZ sampled instruments from plugins', () => {
  it('loads the example plugin: four multisampled zones from WAV files', async () => {
    const { instrument, samples, bytes } = await loadSfzInstrument('felt-keys.sfz', fetchBytes);
    expect(samples).toBe(4);
    expect(bytes).toBeGreaterThan(100_000);
    expect(instrument.zones).toHaveLength(4);
    expect(instrument.zones.map((z) => [z.lokey, z.hikey, z.pitchKeycenter])).toEqual([
      [21, 41, 36],
      [42, 53, 48],
      [54, 65, 60],
      [66, 108, 72],
    ]);
  });

  it('renders tracks with the samples, at the right pitch, instead of the fallback patch', async () => {
    const { instrument } = await loadSfzInstrument('felt-keys.sfz', fetchBytes);
    const song = oneNoteSong();
    const sr = 44100;
    const sampled = renderSong(song, { sampleRate: sr, instruments: [profile], sampleInstruments: { [profile.patchId]: instrument }, tailSeconds: 0.5 });
    const fallback = renderSong(song, { sampleRate: sr, instruments: [{ ...profile, patchId: 'epiano' }], tailSeconds: 0.5 });
    const left = sampled.channels[0];
    const peak = left.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.05);
    expect(Math.abs(1200 * Math.log2(pitchHz(left, sr) / 261.63))).toBeLessThan(30);
    let diff = 0;
    for (let i = 0; i < Math.min(left.length, fallback.channels[0].length); i++) diff += Math.abs(left[i] - fallback.channels[0][i]);
    expect(diff).toBeGreaterThan(1);
  });

  it('rejects sample paths that escape the plugin and files that are not audio', async () => {
    const files: Record<string, string> = {
      'bad.sfz': '<region> sample=../../secret.wav key=60',
      'text.sfz': '<region> sample=notes.txt key=60',
      'notes.txt': 'hello',
    };
    const fake = async (path: string) => new TextEncoder().encode(files[path] ?? '');
    await expect(loadSfzInstrument('bad.sfz', fake)).rejects.toThrow(/escapes the plugin/);
    await expect(loadSfzInstrument('text.sfz', fake)).rejects.toThrow(/unsupported sample format/);
  });
});
