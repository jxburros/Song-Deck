import { describe, expect, it } from 'vitest';
import { audioMidiSourceKey, tuningRenderKey, type Song, type Track } from '@songdeck/core';
import { playbackTrack, renderTrack, renderTrackClips } from '../src/dsp';
import { cents, mkNote, mkSong, mkTrack, rms, sine, yinF0 } from './dsp-helpers';

const SR = 22050;
const opts = { sampleRate: SR, tailSeconds: 0, includeSends: false };

/** An audio track playing a 220 Hz recording, with attached MIDI (one A4 note) and tuning. */
function setup(): { song: Song; track: Track; assets: (id: string) => ReturnType<typeof sine> | undefined } {
  const song = mkSong(2, 120);
  const recording = sine(220, 2, SR, 0.3, 1);
  const tuned = sine(330, 2, SR, 0.3, 1);
  const track = mkTrack('take', 'audio', [mkNote(69, 0, 1920)], {
    kind: 'audio',
    role: 'vocal',
    clips: [
      {
        id: 'c',
        assetId: 'rec',
        tick: 0,
        offsetSeconds: 0,
        durationSeconds: 2,
        gainDb: 0,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
      },
    ],
  });
  song.tracks = [track];
  track.audioMidi = {
    play: 'audio',
    mode: 'melody',
    instrumentId: 'synth-lead',
    sourceKey: audioMidiSourceKey(song, track),
    createdAt: '2026-01-01T00:00:00Z',
    tuning: { enabled: true, amount: 1, flatten: 0, speedMs: 0 },
  };
  track.audioMidi.tuning!.render = {
    assetId: 'tuned',
    key: tuningRenderKey(song, track),
    sampleRate: SR,
    durationSeconds: 2,
    renderedAt: '2026-01-01T00:00:00Z',
  };
  const assets = (id: string) => (id === 'rec' ? recording : id === 'tuned' ? tuned : undefined);
  return { song, track, assets };
}

function pitchOf(song: Song, assets: (id: string) => ReturnType<typeof sine> | undefined): number {
  const out = renderTrack(song, 'take', { ...opts, assets });
  return yinF0(out.channels[0], SR, SR / 2);
}

describe('audio tracks with attached MIDI: playback', () => {
  it('play the current tuned render instead of the clips', () => {
    const { song, track, assets } = setup();
    expect(playbackTrack(song, track, assets).substitute).toBe('tuned');
    expect(Math.abs(cents(pitchOf(song, assets), 330))).toBeLessThan(10);
  });

  it('play the original clips when tuning is off, stale or not loaded', () => {
    const { song, assets } = setup();
    const off = structuredClone(song);
    off.tracks[0].audioMidi!.tuning!.enabled = false;
    const stale = structuredClone(song);
    stale.tracks[0].notes[0].pitch = 70;
    for (const s of [off, stale]) expect(Math.abs(cents(pitchOf(s, assets), 220))).toBeLessThan(10);
    const missing = (id: string) => (id === 'tuned' ? undefined : assets(id));
    expect(Math.abs(cents(pitchOf(song, missing), 220))).toBeLessThan(10);
  });

  it('play the notes through their instrument when set to MIDI', () => {
    const { song, track, assets } = setup();
    const midi = structuredClone(song);
    midi.tracks[0].audioMidi!.play = 'midi';
    const play = playbackTrack(midi, midi.tracks[0], assets);
    expect(play).toMatchObject({ kind: 'patch', substitute: 'midi' });
    expect(play.track.instrumentId).toBe('synth-lead');
    const out = renderTrack(midi, 'take', { ...opts, assets });
    expect(rms(out.channels[0], SR >> 2, SR)).toBeGreaterThan(0.01);
    const f0 = yinF0(out.channels[0], SR, SR >> 2);
    expect(Math.abs(cents(f0, 440))).toBeLessThan(30); // A4, not the 220 Hz recording
    expect(track.audioMidi!.play).toBe('audio');
  });

  it('place a tuned render that starts at the first clip where the clip is', () => {
    const { song, track, assets } = setup();
    track.clips[0].tick = 960; // 1 s
    const render = track.audioMidi!.tuning!.render!;
    render.startTick = 960;
    render.key = tuningRenderKey(song, track);
    const out = renderTrack(song, 'take', { ...opts, assets });
    expect(rms(out.channels[0], 0, SR - 64)).toBe(0);
    expect(Math.abs(cents(yinF0(out.channels[0], SR, SR + 2048), 330))).toBeLessThan(10);
  });

  it('render their own clips pre-fader from a start position', () => {
    const { song, track, assets } = setup();
    track.clips[0].tick = 960;
    const clips = renderTrackClips(song, track, { sampleRate: SR, assets, startTick: 960 });
    expect(clips.channels[0].length).toBe(2 * SR);
    expect(clips.channels[0].slice(0, 100)).toEqual(assets('rec')!.channels[0].slice(0, 100));
  });

  it('render their own clips pre-fader from song time 0', () => {
    const { song, track, assets } = setup();
    song.mixer.channels[track.id] = { ...song.mixer.channels[track.id], volumeDb: -20 } as never;
    track.clips[0].tick = 960; // starts at 1 s (120 BPM)
    track.clips[0].gainDb = -6;
    const clips = renderTrackClips(song, track, { sampleRate: SR, assets });
    expect(clips.channels).toHaveLength(1);
    expect(clips.channels[0].length).toBe(3 * SR);
    expect(rms(clips.channels[0], 0, SR - 10)).toBe(0);
    expect(rms(clips.channels[0], SR + 100, 2 * SR)).toBeCloseTo((0.3 / Math.SQRT2) * 0.5012, 2);
  });
});
