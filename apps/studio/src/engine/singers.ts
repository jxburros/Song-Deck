import { fitToSinger, normalizeSinger, randomId, type SingerProfile, type Song } from '@songdeck/core';
import { useStudio } from '../state/store';
import { useSettings } from '../state/settings';
import { propose } from './proposals';

/**
 * Singers of the open song (`song.vocals.singers`), who sings which part (`vocal.singerId`), the
 * user's reusable "My singers", and fitting a song to a singer (a key-change proposal).
 */

function commitSingers(message: string, fn: (song: Song) => Song): void {
  const st = useStudio.getState();
  const song = st.project?.song;
  if (!song) return;
  st.commit(fn(song), message, 'vocals');
}

function withSingers(song: Song, singers: SingerProfile[]): Song {
  return { ...song, vocals: { ...song.vocals, singers } };
}

/** Add a singer to the song (a copy with a fresh id), optionally singing `trackId`. */
export function addSinger(singer: SingerProfile, trackId?: string): SingerProfile {
  const added = normalizeSinger({ ...singer, id: randomId('singer') });
  commitSingers(`Added singer ${added.name}`, (song) => {
    let next = withSingers(song, [...(song.vocals.singers ?? []), added]);
    if (trackId) next = assignIn(next, trackId, added.id);
    return next;
  });
  return added;
}

export function updateSinger(singer: SingerProfile): void {
  const fixed = normalizeSinger(singer);
  commitSingers(`Updated ${fixed.name}'s range`, (song) =>
    withSingers(
      song,
      (song.vocals.singers ?? []).map((s) => (s.id === fixed.id ? fixed : s)),
    ),
  );
}

/** Remove a singer; the parts they sang keep their voice type. */
export function removeSinger(id: string): void {
  const name = useStudio.getState().project?.song.vocals.singers?.find((s) => s.id === id)?.name ?? 'singer';
  commitSingers(`Removed singer ${name}`, (song) => ({
    ...withSingers(
      song,
      (song.vocals.singers ?? []).filter((s) => s.id !== id),
    ),
    tracks: song.tracks.map((t) =>
      t.vocal?.singerId === id ? { ...t, vocal: { ...t.vocal, singerId: undefined } } : t,
    ),
  }));
}

function assignIn(song: Song, trackId: string, singerId: string | undefined): Song {
  const singer = song.vocals.singers?.find((s) => s.id === singerId);
  return {
    ...song,
    tracks: song.tracks.map((t) =>
      t.id === trackId
        ? {
            ...t,
            vocal: {
              ...t.vocal,
              singerId,
              ...(singer?.voiceType ? { voiceType: singer.voiceType } : {}),
            },
          }
        : t,
    ),
  };
}

/** Who sings a part (undefined = nobody in particular: the voice type's range). */
export function assignSinger(trackId: string, singerId: string | undefined): void {
  const song = useStudio.getState().project?.song;
  const track = song?.tracks.find((t) => t.id === trackId);
  const singer = song?.vocals.singers?.find((s) => s.id === singerId);
  if (!track || track.vocal?.singerId === singerId) return;
  commitSingers(singer ? `${singer.name} sings ${track.name}` : `${track.name}: no singer`, (s) =>
    assignIn(s, trackId, singerId),
  );
}

/** Keep a singer in "My singers" for other songs (replaces one with the same name). */
export function saveToMySingers(singer: SingerProfile): void {
  const settings = useSettings.getState();
  const kept = normalizeSinger({ ...singer, id: randomId('singer') });
  settings.update({
    savedSingers: [...settings.savedSingers.filter((s) => s.name !== kept.name), kept],
  });
  useStudio.getState().toast('success', `${kept.name} is in My singers`);
}

export function removeFromMySingers(id: string): void {
  const settings = useSettings.getState();
  settings.update({ savedSingers: settings.savedSingers.filter((s) => s.id !== id) });
}

/** Propose moving the song (and/or the part) so it suits the part's singer better. */
export function proposeFitToSinger(trackId: string, semitones: number): void {
  const st = useStudio.getState();
  const song = st.project?.song;
  const track = song?.tracks.find((t) => t.id === trackId);
  if (!song || !track) return;
  const plan = fitToSinger(song, track, semitones);
  const proposal = propose(song, plan.ops, {
    title: `Fit “${track.name}” to its singer`,
    source: 'singer-range',
    instruction: plan.description,
    explanation: plan.description,
  });
  if (proposal) st.toast('info', `${plan.description}: review the proposal, then keep or discard it.`);
}
