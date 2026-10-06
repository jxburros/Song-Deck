import { useState } from 'react';
import {
  VOICE_TYPE_LABELS,
  checkSingerRange,
  describeSinger,
  singerForTrack,
  singerFromVoiceType,
  type Project,
  type SingerProfile,
  type Track,
  type VoiceType,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { Button, Select } from '../../ui/kit';
import {
  addSinger,
  assignSinger,
  removeFromMySingers,
  removeSinger,
  saveToMySingers,
  updateSinger,
} from '../../engine/singers';
import { RangeCheckCard, RangeKeyboard, SingerEditor, ZoneLegend } from '../shared/SingerRange';

/**
 * Singers: the people who sing this song, each with range zones (sweet spot, easy, difficult but
 * possible, falsetto, out of range), who sings this part, and how the part sits in their voice.
 */
export function SingersPanel({ project, track }: { project: Project; track: Track }) {
  const song = project.song;
  const st = useStudio.getState();
  const saved = useSettings((s) => s.savedSingers);
  const singers = song.vocals.singers ?? [];
  const singer = singerForTrack(song, track);
  const [editing, setEditing] = useState<{ singer: SingerProfile; isNew: boolean } | null>(null);
  const voice: VoiceType = track.vocal?.voiceType ?? 'tenor';

  const newSinger = () =>
    setEditing({
      singer: singerFromVoiceType(voice, { id: 'new', name: `${VOICE_TYPE_LABELS[voice]} singer` }),
      isNew: true,
    });

  return (
    <div className="col" data-testid="singers-panel" style={{ gap: 16 }}>
      <section className="col" aria-labelledby="singer-of-part" style={{ gap: 8 }}>
        <h3 id="singer-of-part">Who sings “{track.name}”</h3>
        <div className="row wrap">
          <Select
            value={singer?.id ?? ''}
            onChange={(id) => assignSinger(track.id, id || undefined)}
            options={[
              {
                value: '',
                label: `Nobody in particular (typical ${VOICE_TYPE_LABELS[voice].toLowerCase()})`,
              },
              ...singers.map((s) => ({ value: s.id, label: s.name })),
            ]}
            aria-label="Singer of this part"
          />
          <Button icon="plus" onClick={newSinger}>
            New singer…
          </Button>
          {saved.length > 0 && (
            <Select
              value=""
              onChange={(id) => {
                const s = saved.find((x) => x.id === id);
                if (s) addSinger(s, track.id);
              }}
              options={[
                { value: '', label: 'Add from My singers…' },
                ...saved.map((s) => ({ value: s.id, label: s.name })),
              ]}
              aria-label="Add from My singers"
            />
          )}
        </div>
        {singer ? (
          <>
            <RangeKeyboard
              singer={singer}
              part={(() => {
                const c = checkSingerRange(song, track, singer, { maxShift: 0 });
                return { lowest: c.lowest, highest: c.highest };
              })()}
              height={64}
            />
            <ZoneLegend />
            <RangeCheckCard song={song} track={track} singer={singer} />
          </>
        ) : (
          <div className="small muted">
            Add the singer’s range to see which notes are easy, difficult but possible, falsetto only or out
            of reach — the melody is then written for their voice, and Song Deck suggests the key that suits
            them best.
          </div>
        )}
      </section>

      <section className="col" aria-labelledby="song-singers" style={{ gap: 8 }}>
        <h3 id="song-singers">Singers in this song</h3>
        {singers.length === 0 && <div className="small muted">No singers yet.</div>}
        {singers.map((s) => {
          const parts = song.tracks.filter((t) => t.vocal?.singerId === s.id).map((t) => t.name);
          return (
            <div key={s.id} className="singer-card" data-testid="singer-card">
              <div className="row between wrap">
                <strong>{s.name}</strong>
                <span className="small muted">
                  {s.voiceType ? VOICE_TYPE_LABELS[s.voiceType] : 'Custom range'}
                  {parts.length ? ` · sings ${parts.join(', ')}` : ''}
                </span>
              </div>
              <RangeKeyboard singer={s} height={44} />
              <div className="small muted">{describeSinger(s)}</div>
              {s.notes && <div className="small">{s.notes}</div>}
              <div className="row wrap">
                <Button size="sm" icon="pencil" onClick={() => setEditing({ singer: s, isNew: false })}>
                  Edit range
                </Button>
                {singer?.id !== s.id && (
                  <Button size="sm" icon="mic" onClick={() => assignSinger(track.id, s.id)}>
                    Sings “{track.name}”
                  </Button>
                )}
                <Button size="sm" icon="book" onClick={() => saveToMySingers(s)}>
                  Save to My singers
                </Button>
                <Button size="sm" variant="danger" icon="trash" onClick={() => removeSinger(s.id)}>
                  Remove
                </Button>
              </div>
            </div>
          );
        })}
      </section>

      {saved.length > 0 && (
        <section className="col" aria-labelledby="my-singers" style={{ gap: 6 }}>
          <h3 id="my-singers">My singers</h3>
          <div className="small muted">Kept in this browser for every song.</div>
          {saved.map((s) => (
            <div key={s.id} className="row between wrap small">
              <span>
                <strong>{s.name}</strong> · <span className="muted">{describeSinger(s)}</span>
              </span>
              <span className="row">
                <Button size="sm" onClick={() => addSinger(s, track.id)}>
                  Add to song
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={`Remove ${s.name} from My singers`}
                  onClick={() => removeFromMySingers(s.id)}
                />
              </span>
            </div>
          ))}
        </section>
      )}

      {editing && (
        <SingerEditor
          initial={editing.singer}
          title={editing.isNew ? 'New singer' : `${editing.singer.name}'s range`}
          onClose={() => setEditing(null)}
          onSave={(s) => {
            if (editing.isNew) {
              const added = addSinger(s, track.id);
              st.toast('success', `${added.name} sings “${track.name}”`);
            } else updateSinger(s);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
