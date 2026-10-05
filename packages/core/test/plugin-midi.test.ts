import { describe, expect, it } from 'vitest';
import { createEmptySong } from '../src/ir/defaults';
import type { Song, Track } from '../src/ir/types';
import { pluginRenderIsCurrent, pluginRenderKey, trackMidiEvents } from '../src/io';

function fixture(): { song: Song; track: Track } {
  const song = createEmptySong({ title: 'P', bpm: 120 });
  song.sections = [{ id: 's', name: 'A', kind: 'verse', bars: 1, energy: 50 }];
  const track = {
    id: 't',
    name: 'Keys',
    kind: 'midi',
    role: 'keys',
    instrumentId: 'piano',
    constraints: {},
    clips: [],
    color: '#fff',
    stemGroup: 'keys',
    midiChannel: 2,
    notes: [
      { id: 'a', pitch: 60, tick: 0, duration: 480, velocity: 100 },
      { id: 'b', pitch: 64, tick: 480, duration: 480, velocity: 80, articulation: 'staccato' },
      { id: 'c', pitch: 60, tick: 240, duration: 480, velocity: 90 },
    ],
  } as unknown as Track;
  song.tracks = [track];
  return { song, track };
}

describe('instrument plugin MIDI', () => {
  it('turns notes into sorted raw note-on/off events in seconds with re-triggered overlaps', () => {
    const { song, track } = fixture();
    const { events, durationSeconds } = trackMidiEvents(song, track);
    // 120 BPM: 480 ticks = 0.5 s. Note c (60 @ 0.25 s) cuts the first C at 0.25 s.
    expect(events.slice(0, 5)).toEqual([
      { time: 0, data: [0x92, 60, 100] },
      { time: 0.25, data: [0x82, 60, 64] },
      { time: 0.25, data: [0x92, 60, 90] },
      { time: 0.5, data: [0x92, 64, 80] },
      { time: 0.5 + 0.5 * 0.45, data: [0x82, 64, 64] },
    ]);
    expect(events.at(-1)!.data).toEqual([0xb2, 123, 0]);
    expect(durationSeconds).toBeCloseTo(2 + 2, 6); // one 4/4 bar at 120 BPM + 2 s tail
  });

  it('render key changes with notes, tempo and plugin state; bypass disables the freeze', () => {
    const { song, track } = fixture();
    track.instrumentPlugin = { format: 'vst3', pluginId: 'p', name: 'P', hostId: 'h' };
    const k0 = pluginRenderKey(song, track);
    track.instrumentPlugin.render = {
      assetId: 'a1',
      key: k0,
      sampleRate: 44100,
      durationSeconds: 4,
      renderedAt: '',
    };
    expect(pluginRenderIsCurrent(song, track)).toBe(true);
    track.instrumentPlugin.parameters = { cutoff: 0.5 };
    expect(pluginRenderIsCurrent(song, track)).toBe(false);
    delete track.instrumentPlugin.parameters;
    song.tempoMap = [{ tick: 0, bpm: 100 }];
    expect(pluginRenderIsCurrent(song, track)).toBe(false);
    song.tempoMap = [{ tick: 0, bpm: 120 }];
    expect(pluginRenderKey(song, track)).toBe(k0);
    track.instrumentPlugin.bypass = true;
    expect(pluginRenderIsCurrent(song, track)).toBe(false);
  });
});
