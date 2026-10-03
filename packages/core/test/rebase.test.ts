import { describe, expect, it } from 'vitest';
import { acceptProposalOnto, createProposal, rebaseProposal } from '../src/edit';
import { cloneSong } from '../src/ir/song-utils';
import { IdFactory } from '../src/util/ids';
import { LockKeys } from '../src/locks';
import type { MusicOperation, Song } from '../src/ir/types';
import { makeSong, TICKS } from './edit-fixtures';

const { BAR, Q } = TICKS;

function track(song: Song, id: string) {
  return song.tracks.find((t) => t.id === id)!;
}

/** "Make the bass an octave lower in bars 1–2" as a proposal against the fixture song. */
function bassProposal(before: Song, idPrefix = 'p') {
  const ops: MusicOperation[] = [{ op: 'transform_notes', track: 'trk_bass', region: { start_bar: 1, end_bar: 2 }, transform: { transpose: -12 }, reason: 'test' } as MusicOperation];
  return createProposal(before, ops, { title: 'Lower bass', source: 'internal', ids: new IdFactory(1, idPrefix) });
}

describe('rebasing a proposal onto the current song', () => {
  it('is the proposed song when nothing changed since', () => {
    const before = makeSong();
    const p = bassProposal(before);
    const r = acceptProposalOnto(p, cloneSong(before));
    expect(r.conflicts).toEqual([]);
    expect(r.song).toEqual(p.after);
  });

  it('keeps edits made while the proposal was pending', () => {
    const before = makeSong();
    const p = bassProposal(before);
    const current = cloneSong(before);
    current.mixer.channels.trk_drums = { ...current.mixer.channels.trk_drums, mute: true }; // muted the drums
    track(current, 'trk_piano').notes[0].velocity = 30; // softened a piano note
    current.title = 'Renamed';
    const { song, conflicts } = acceptProposalOnto(p, current);
    expect(conflicts).toEqual([]);
    expect(song.mixer.channels.trk_drums.mute).toBe(true);
    expect(track(song, 'trk_piano').notes[0].velocity).toBe(30);
    expect(song.title).toBe('Renamed');
    expect(track(song, 'trk_bass').notes).toEqual(track(p.after, 'trk_bass').notes);
  });

  it('applies two independent proposals made from the same song', () => {
    const before = makeSong();
    const notes = bassProposal(before);
    const mixAfter = cloneSong(before);
    mixAfter.mixer.channels.trk_vocal = { ...mixAfter.mixer.channels.trk_vocal, volumeDb: 3 };
    const first = acceptProposalOnto(notes, before).song;
    const second = rebaseProposal(before, mixAfter, first);
    expect(second.conflicts).toEqual([]);
    expect(second.song.mixer.channels.trk_vocal.volumeDb).toBe(3);
    expect(track(second.song, 'trk_bass').notes).toEqual(track(notes.after, 'trk_bass').notes);
  });

  it('reports a conflict when the same note changed on both sides, and the proposal wins', () => {
    const before = makeSong();
    const p = bassProposal(before);
    const current = cloneSong(before);
    const edited = track(current, 'trk_bass').notes.find((n) => n.tick === 0)!;
    edited.pitch = 47;
    const { song, conflicts } = acceptProposalOnto(p, current);
    expect(conflicts).toEqual(['Notes on "Bass"']);
    expect(track(song, 'trk_bass').notes.find((n) => n.id === edited.id)!.pitch).toBe(28);
  });

  it('never brings back notes or tracks deleted since', () => {
    const before = makeSong();
    const p = bassProposal(before);
    const current = cloneSong(before);
    const bass = track(current, 'trk_bass');
    const gone = bass.notes.filter((n) => n.tick < Q * 2).map((n) => n.id);
    bass.notes = bass.notes.filter((n) => !gone.includes(n.id));
    let r = acceptProposalOnto(p, current);
    expect(track(r.song, 'trk_bass').notes.some((n) => gone.includes(n.id))).toBe(false);
    expect(r.conflicts).toEqual(['Notes on "Bass": changed by the proposal but deleted since (2)']);

    const noBass = cloneSong(before);
    noBass.tracks = noBass.tracks.filter((t) => t.id !== 'trk_bass');
    r = acceptProposalOnto(p, noBass);
    expect(r.song.tracks.some((t) => t.id === 'trk_bass')).toBe(false);
    expect(r.conflicts).toEqual(['Track "Bass": changed by the proposal but deleted since']);
  });

  it('keeps notes added on both sides, renaming a colliding id', () => {
    const before = makeSong();
    const p = createProposal(before, [{ op: 'add_notes', track: 'trk_bass', notes: [{ pitch: 45, bar: 3, beat: 1.5, duration_beats: 0.5 }] } as MusicOperation], {
      title: 'Add a pickup',
      source: 'internal',
      ids: new IdFactory(1, 'x'),
    });
    const added = track(p.after, 'trk_bass').notes.find((n) => !track(before, 'trk_bass').notes.some((b) => b.id === n.id))!;
    const current = cloneSong(before);
    track(current, 'trk_bass').notes.push({ ...added, pitch: 50, tick: 2 * BAR + 3 * Q }); // same id, different note
    const { song, conflicts } = acceptProposalOnto(p, current);
    expect(conflicts).toEqual([]);
    const bass = track(song, 'trk_bass').notes;
    expect(bass.filter((n) => n.pitch === 45 && n.tick === 2 * BAR + Q / 2)).toHaveLength(1);
    expect(bass.filter((n) => n.pitch === 50 && n.tick === 2 * BAR + 3 * Q)).toHaveLength(1);
    expect(new Set(bass.map((n) => n.id)).size).toBe(bass.length);
  });

  it('refuses to change material locked since the proposal was made', () => {
    const before = makeSong();
    const p = bassProposal(before);
    const current = cloneSong(before);
    current.locks[LockKeys.track('trk_bass')] = true;
    expect(() => acceptProposalOnto(p, current)).toThrow(/locked/);
  });
});
