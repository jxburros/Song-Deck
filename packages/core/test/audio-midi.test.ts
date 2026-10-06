import { describe, expect, it } from 'vitest';
import {
  audioMidiIsStale,
  audioMidiSourceKey,
  firstClipTick,
  hasAttachedMidi,
  hasEditableNotes,
  noteTrackView,
  normalizeTuning,
  tuneTargets,
  tuningActive,
  tuningRenderIsCurrent,
  tuningRenderIsStale,
  tuningRenderKey,
} from '../src/audio-midi';
import { applyOperations, validateSong } from '../src/edit';
import { midiToSong, parseMidiFile, songToMidi, trackToMidi } from '../src/io';
import type { Song, Track } from '../src/ir/types';
import { makeSong } from './edit-fixtures';

/** Fixture song plus an audio vocal track ("Take") with MIDI made from it. */
function songWithAttached(): { song: Song; take: Track } {
  const song = makeSong();
  const take: Track = {
    id: 'take',
    name: 'Take',
    kind: 'audio',
    role: 'vocal',
    instrumentId: 'audio',
    constraints: {},
    notes: [
      { id: 'n1', pitch: 64, tick: 0, duration: 480, velocity: 90, origin: 'transcription' },
      { id: 'n2', pitch: 100, tick: 960, duration: 480, velocity: 90, origin: 'transcription' },
    ],
    clips: [
      {
        id: 'c1',
        assetId: 'a1',
        tick: 0,
        offsetSeconds: 0,
        durationSeconds: 4,
        gainDb: 0,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
      },
    ],
    color: '#888888',
    stemGroup: 'vocals',
  };
  song.tracks.push(take);
  take.audioMidi = {
    play: 'audio',
    mode: 'melody',
    instrumentId: 'synth-lead',
    sourceKey: audioMidiSourceKey(song, take),
    createdAt: '2026-01-01T00:00:00Z',
    tuning: { enabled: true, amount: 1, flatten: 0.3, speedMs: 40 },
  };
  return { song, take };
}

describe('audio tracks with attached MIDI', () => {
  it('are note tracks that play through their own instrument', () => {
    const { song, take } = songWithAttached();
    expect(hasAttachedMidi(take)).toBe(true);
    expect(hasEditableNotes(take)).toBe(true);
    const view = noteTrackView(take)!;
    expect(view).toMatchObject({ kind: 'midi', instrumentId: 'synth-lead', clips: [] });
    expect(view.notes).toBe(take.notes);
    const plain = song.tracks.find((t) => t.kind === 'midi')!;
    expect(noteTrackView(plain)).toBe(plain);
    expect(noteTrackView({ ...take, audioMidi: undefined })).toBeUndefined();
    expect(hasEditableNotes({ ...take, audioMidi: undefined })).toBe(false);
  });

  it('accept note operations; plain audio tracks still refuse them', () => {
    const { song } = songWithAttached();
    const r = applyOperations(song, [
      {
        op: 'transform_notes',
        track: 'take',
        region: { start_bar: 1, end_bar: 2 },
        transform: { transpose: 2 },
      },
      { op: 'add_notes', track: 'take', notes: [{ pitch: 'C6', bar: 3, beat: 1, duration_beats: 1 }] },
    ]);
    expect(r.report.ok).toBe(true);
    const take = r.song.tracks.find((t) => t.id === 'take')!;
    expect(take.notes.map((n) => n.pitch)).toEqual([66, 102, 84]);
    expect(take.kind).toBe('audio');
    expect(take.clips).toHaveLength(1);

    const plain = structuredClone(song);
    delete plain.tracks.find((t) => t.id === 'take')!.audioMidi;
    const refused = applyOperations(plain, [
      { op: 'add_notes', track: 'take', notes: [{ pitch: 'C4', bar: 1, beat: 1, duration_beats: 1 }] },
    ]);
    expect(refused.report.issues.some((i) => i.code === 'track.not-midi')).toBe(true);
  });

  it('keep transcribed pitches outside any instrument range', () => {
    const { song } = songWithAttached();
    const r = applyOperations(song, [
      {
        op: 'transform_notes',
        track: 'take',
        region: { start_bar: 1, end_bar: 1 },
        transform: { velocity_scale: 0.9 },
      },
    ]);
    expect(r.applied).toBe(1);
    // 100 is above synth-lead's range (48–96) but is what the recording holds
    expect(r.song.tracks.find((t) => t.id === 'take')!.notes.find((n) => n.id === 'n2')!.pitch).toBe(100);
    const report = validateSong(song);
    expect(report.issues.filter((i) => i.trackId === 'take' && i.code === 'note.out-of-range')).toEqual([]);
  });

  it('are exported to MIDI with the instrument that plays them', () => {
    const { song } = songWithAttached();
    const all = midiToSong(songToMidi(song));
    const exported = all.tracks.find((t) => t.name === 'Take')!;
    expect(exported.kind).toBe('midi');
    expect(exported.notes.map((n) => n.pitch)).toEqual([64, 100]);
    const single = parseMidiFile(trackToMidi(song, 'take'));
    const notes = single.tracks[0].events.filter((e) => e.type === 'noteOn');
    expect(notes).toHaveLength(2);
    const program = single.tracks[0].events.find((e) => e.type === 'programChange');
    expect(program).toMatchObject({ program: 81 }); // synth-lead's GM program (sawtooth lead)
  });

  it('start where their first unmuted clip starts', () => {
    const { take } = songWithAttached();
    expect(firstClipTick(take)).toBe(0);
    const later = { ...take.clips[0], id: 'c2', tick: 3840 };
    expect(firstClipTick({ ...take, clips: [later] })).toBe(3840);
    expect(firstClipTick({ ...take, clips: [{ ...take.clips[0], muted: true }, later] })).toBe(3840);
    expect(firstClipTick({ ...take, clips: [] })).toBe(0);
  });

  it('know when the audio they were made from changed', () => {
    const { song, take } = songWithAttached();
    expect(audioMidiIsStale(song, take)).toBe(false);
    take.notes[0].pitch = 65; // editing notes does not make the MIDI stale
    expect(audioMidiIsStale(song, take)).toBe(false);
    take.clips[0].offsetSeconds = 0.5;
    expect(audioMidiIsStale(song, take)).toBe(true);
  });
});

describe('tuning renders', () => {
  it('are keyed by the clips, the notes in time and the settings', () => {
    const { song, take } = songWithAttached();
    const key = tuningRenderKey(song, take);
    take.audioMidi!.tuning!.render = {
      assetId: 'tuned',
      key,
      sampleRate: 44100,
      durationSeconds: 4,
      renderedAt: '2026-01-01T00:00:00Z',
    };
    expect(tuningRenderIsCurrent(song, take)).toBe(true);
    expect(tuningRenderIsStale(song, take)).toBe(false);

    const changes: ((s: Song, t: Track) => void)[] = [
      (_, t) => (t.notes[0].pitch = 66),
      (_, t) => (t.notes[1].tick += 10),
      (_, t) => (t.audioMidi!.tuning!.flatten = 1),
      (_, t) => (t.clips[0].gainDb = -3),
      (s) => (s.tempoMap[0].bpm = 100),
    ];
    for (const change of changes) {
      const s = structuredClone(song);
      const t = s.tracks.find((x) => x.id === 'take')!;
      change(s, t);
      expect(tuningRenderKey(s, t)).not.toBe(key);
      expect(tuningRenderIsStale(s, t)).toBe(true);
    }
    // velocity, lyrics and names do not change the tuned audio
    const s = structuredClone(song);
    const t = s.tracks.find((x) => x.id === 'take')!;
    t.notes[0].velocity = 20;
    t.notes[0].syllable = 'la';
    t.name = 'Lead take';
    expect(tuningRenderKey(s, t)).toBe(key);
  });

  it('are inactive while the track plays MIDI or tuning is off', () => {
    const { take } = songWithAttached();
    expect(tuningActive(take)).toBe(true);
    expect(tuningActive({ ...take, audioMidi: { ...take.audioMidi!, play: 'midi' } })).toBe(false);
    expect(
      tuningActive({
        ...take,
        audioMidi: { ...take.audioMidi!, tuning: { ...take.audioMidi!.tuning!, enabled: false } },
      }),
    ).toBe(false);
  });

  it('target the notes in seconds on the tempo map', () => {
    const { song, take } = songWithAttached();
    const targets = tuneTargets(song, take); // 120 BPM: a quarter note is 0.5 s
    expect(targets).toEqual([
      { startSeconds: 0, endSeconds: 0.5, pitch: 64 },
      { startSeconds: 1, endSeconds: 1.5, pitch: 100 },
    ]);
  });

  it('normalize settings into range', () => {
    expect(normalizeTuning({ amount: 2, flatten: -1, speedMs: 9999 })).toEqual({
      amount: 1,
      flatten: 0,
      speedMs: 500,
    });
    expect(normalizeTuning({})).toMatchObject({ amount: 1 });
  });
});
