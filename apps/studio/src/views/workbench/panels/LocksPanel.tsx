import { isTrackSectionLocked, LockKeys, lockCount, randomSeed, regenerateUnlocked } from '@songdeck/core';
import { useStudio } from '../../../state/store';
import { useCustomInstruments } from '../../../hooks';
import { Button, LockButton } from '../../../ui/kit';

const SONG_LOCKS: { key: string; label: string }[] = [
  { key: LockKeys.tempo, label: 'Tempo' },
  { key: LockKeys.key, label: 'Key' },
  { key: LockKeys.meter, label: 'Meter' },
  { key: LockKeys.structure, label: 'Structure' },
  { key: LockKeys.chords, label: 'Chords' },
  { key: LockKeys.lyrics, label: 'Lyrics' },
  { key: LockKeys.motifs, label: 'Motifs' },
];

/** Locking System (spec §22). "Regenerate unlocked material" is guaranteed at the symbolic layer. */
export default function LocksPanel() {
  const song = useStudio((s) => s.project?.song ?? null);
  const customInstruments = useCustomInstruments();
  const st = useStudio.getState();
  if (!song) return null;
  const noteLocks = song.tracks.reduce((n, t) => n + t.notes.filter((x) => x.locked).length, 0);
  return (
    <div className="col">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Locks</h3>
        <span className="small muted">
          {lockCount(song.locks)} components · {noteLocks} notes
        </span>
      </div>
      <h4>Song</h4>
      {SONG_LOCKS.map((l) => (
        <div key={l.key} className="row between" style={{ padding: '2px 0' }}>
          <span>{l.label}</span>
          <LockButton locked={!!song.locks[l.key]} onToggle={() => st.toggleLock(l.key, `${song.locks[l.key] ? 'Unlocked' : 'Locked'} ${l.label.toLowerCase()}`)} />
        </div>
      ))}
      <h4 style={{ marginTop: 8 }}>Tracks × sections</h4>
      <div className="scroll" style={{ maxWidth: '100%' }}>
        <table className="table" style={{ fontSize: 11 }}>
          <thead>
            <tr>
              <th>Track</th>
              <th title="Whole track">All</th>
              {song.sections.map((s) => (
                <th key={s.id} title={s.name} style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', padding: '6px 2px', height: 70 }}>
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {song.tracks.map((t) => (
              <tr key={t.id}>
                <td className="ellipsis" style={{ maxWidth: 90 }}>
                  {t.name}
                </td>
                <td>
                  <LockButton locked={!!song.locks[LockKeys.track(t.id)]} onToggle={() => st.toggleLock(LockKeys.track(t.id), `${song.locks[LockKeys.track(t.id)] ? 'Unlocked' : 'Locked'} ${t.name}`)} />
                </td>
                {song.sections.map((s) => {
                  const explicit = !!song.locks[LockKeys.trackSection(t.id, s.id)];
                  const effective = isTrackSectionLocked(song, t.id, s.id);
                  return (
                    <td key={s.id} style={{ padding: 2, opacity: effective && !explicit ? 0.6 : 1 }}>
                      <LockButton
                        locked={effective}
                        onToggle={() => st.toggleLock(LockKeys.trackSection(t.id, s.id), `${explicit ? 'Unlocked' : 'Locked'} ${t.name} · ${s.name}`)}
                        title={effective && !explicit ? 'Locked via track or section' : `${t.name} · ${s.name}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button
        variant="primary"
        icon="dice"
        onClick={() => {
          const seed = randomSeed();
          const res = regenerateUnlocked(song, { seed, customInstruments });
          st.commit(res.song, `Regenerated unlocked material · seed ${seed}`, 'regenerate');
          st.toast('success', `Regenerated ${res.changed.length} track(s); all locked material preserved.`);
        }}
      >
        Regenerate unlocked material
      </Button>
      <div className="small muted">Tip: select notes in the piano roll and press L to lock individual notes.</div>
    </div>
  );
}
