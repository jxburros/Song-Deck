import { useMemo, useState } from 'react';
import {
  BUILTIN_INSTRUMENTS,
  channelFor,
  colorForRole,
  defaultChannelStrip,
  getInstrument,
  LockKeys,
  randomId,
  randomSeed,
  regenerateUnlocked,
  sectionLayout,
  type Song,
  type Track,
  type TrackRole,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useCustomInstruments } from '../../hooks';
import { Button, Field, LockButton, Modal, Select, TextInput, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { TRACK_ROLES } from '../compose/BlueprintEditor';

/** Track colours live in @songdeck/core (ir/palette.ts) so composed, imported and rebuilt tracks agree. */
export { colorForRole };

export function setChannel(
  song: Song,
  trackId: string,
  patch: Partial<ReturnType<typeof defaultChannelStrip>>,
): Song {
  const ch = { ...channelFor(song, trackId), ...patch };
  return { ...song, mixer: { ...song.mixer, channels: { ...song.mixer.channels, [trackId]: ch } } };
}

function TrackRow({ song, track, selected }: { song: Song; track: Track; selected: boolean }) {
  const st = useStudio.getState();
  const ch = channelFor(song, track.id);
  const locked = !!song.locks[LockKeys.track(track.id)];
  const customInstruments = useCustomInstruments();
  const inst = getInstrument(track.instrumentId, customInstruments);
  return (
    <div
      className={`track-row ${selected ? 'selected' : ''}`}
      onClick={() => st.selectTrack(track.id)}
      onDoubleClick={() => st.setWorkbenchView('piano-roll')}
    >
      <div className="track-color" style={{ background: track.color || colorForRole(track.role) }} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="track-name ellipsis">{track.name}</div>
        <div className="track-meta ellipsis">
          {track.kind === 'audio' ? 'Audio' : inst.name} · {track.notes.length || track.clips.length}{' '}
          {track.kind === 'audio' ? 'clips' : 'notes'}
        </div>
      </div>
      <button
        className={`ms-btn mute ${ch.mute ? 'on' : ''}`}
        title="Mute"
        onClick={(e) => {
          e.stopPropagation();
          st.commit(
            setChannel(song, track.id, { mute: !ch.mute }),
            `${ch.mute ? 'Unmuted' : 'Muted'} ${track.name}`,
            'mix',
          );
        }}
      >
        M
      </button>
      <button
        className={`ms-btn solo ${ch.solo ? 'on' : ''}`}
        title="Solo"
        onClick={(e) => {
          e.stopPropagation();
          st.commit(
            setChannel(song, track.id, { solo: !ch.solo }),
            `${ch.solo ? 'Unsoloed' : 'Soloed'} ${track.name}`,
            'mix',
          );
        }}
      >
        S
      </button>
      <LockButton
        locked={locked}
        onToggle={() =>
          st.toggleLock(LockKeys.track(track.id), `${locked ? 'Unlocked' : 'Locked'} ${track.name}`)
        }
      />
    </div>
  );
}

function AddTrackModal({ onClose }: { onClose: () => void }) {
  const song = useStudio((s) => s.project?.song)!;
  const customInstruments = useCustomInstruments();
  const instruments = useMemo(() => [...BUILTIN_INSTRUMENTS, ...customInstruments], [customInstruments]);
  const [instrumentId, setInstrumentId] = useState('string-ensemble');
  const inst = instruments.find((i) => i.id === instrumentId) ?? instruments[0];
  const [name, setName] = useState(inst.name);
  const [role, setRole] = useState<TrackRole>(inst.defaultRole);
  const [generate, setGenerate] = useState(true);
  const st = useStudio.getState();
  const create = () => {
    const id = randomId('trk');
    const track: Track = {
      id,
      name,
      kind: 'midi',
      role,
      instrumentId,
      constraints: { function: inst.defaultFunction },
      notes: [],
      clips: [],
      color: colorForRole(role),
      stemGroup: inst.stemGroup,
      midiChannel: inst.isDrumKit ? 9 : undefined,
    };
    let next: Song = {
      ...song,
      tracks: [...song.tracks, track],
      mixer: { ...song.mixer, channels: { ...song.mixer.channels, [id]: defaultChannelStrip() } },
    };
    if (generate) {
      next = regenerateUnlocked(next, { seed: randomSeed(), trackIds: [id], customInstruments }).song;
    }
    st.commit(next, `Added track ${name}${generate ? ' (generated)' : ''}`, 'edit');
    st.selectTrack(id);
    onClose();
  };
  return (
    <Modal
      title="Add instrument track"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={create}>
            Add track
          </Button>
        </>
      }
    >
      <div className="col">
        <Field label="Instrument">
          <Select
            value={instrumentId}
            onChange={(v) => {
              const i = instruments.find((x) => x.id === v)!;
              setInstrumentId(v);
              setName(i.name);
              setRole(i.defaultRole);
            }}
            options={instruments.map((i) => ({ value: i.id, label: `${i.name} (${i.family})` }))}
          />
        </Field>
        <div className="grid-2">
          <Field label="Name">
            <TextInput value={name} onChange={setName} />
          </Field>
          <Field label="Generator role">
            <Select value={role} onChange={setRole} options={TRACK_ROLES} />
          </Field>
        </div>
        <Toggle
          on={generate}
          onChange={setGenerate}
          label="Generate a part for it now (respects the arrangement and locks)"
        />
      </div>
    </Modal>
  );
}

export function SidePanel() {
  const song = useStudio((s) => s.project?.song ?? null);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const selection = useStudio((s) => s.selection);
  const [adding, setAdding] = useState(false);
  const st = useStudio.getState();
  if (!song) return null;
  const layout = sectionLayout(song);
  return (
    <>
      <div className="panel-header">
        <h3 className="grow">Tracks</h3>
        <Button size="sm" icon="plus" onClick={() => setAdding(true)} title="Add track">
          Add
        </Button>
      </div>
      <div className="scroll" style={{ flex: '1 1 55%' }}>
        {song.tracks.map((t) => (
          <TrackRow key={t.id} song={song} track={t} selected={t.id === selectedTrackId} />
        ))}
      </div>
      <div className="panel-header" style={{ borderTop: '1px solid var(--border)' }}>
        <h3 className="grow">Sections</h3>
        <span className="small dim">{song.sections.reduce((n, s) => n + s.bars, 0)} bars</span>
      </div>
      <div className="scroll" style={{ flex: '1 1 45%' }}>
        {layout.map((span) => {
          const s = span.section;
          const active = selection.sectionIds?.includes(s.id);
          const locked = !!song.locks[LockKeys.section(s.id)];
          return (
            <div
              key={s.id}
              className={`track-row ${active ? 'selected' : ''}`}
              style={{ height: 34, paddingLeft: 10 }}
              onClick={() =>
                st.setSelection({
                  startTick: span.startTick,
                  endTick: span.endTick,
                  sectionIds: [s.id],
                  noteIds: [],
                })
              }
              title="Select section (scope for regeneration and AI edits)"
            >
              <div className="grow ellipsis">
                <span style={{ fontWeight: 600 }}>{s.name}</span>{' '}
                <span className="small dim">
                  bars {span.startBar + 1}–{span.endBar} · energy {Math.round(s.energy)}
                  {s.energyEnd !== undefined && s.energyEnd !== s.energy ? `→${Math.round(s.energyEnd)}` : ''}
                </span>
              </div>
              <LockButton
                locked={locked}
                onToggle={() =>
                  st.toggleLock(LockKeys.section(s.id), `${locked ? 'Unlocked' : 'Locked'} section ${s.name}`)
                }
              />
            </div>
          );
        })}
        {selection.sectionIds?.length ? (
          <div style={{ padding: 8 }}>
            <Button
              size="sm"
              variant="ghost"
              icon="close"
              onClick={() =>
                st.setSelection({ startTick: undefined, endTick: undefined, sectionIds: [], noteIds: [] })
              }
            >
              Clear selection
            </Button>
          </div>
        ) : (
          <div className="small dim" style={{ padding: 10 }}>
            <Icon name="info" size={12} /> Click a section to scope edits and regeneration to it.
          </div>
        )}
      </div>
      {adding && <AddTrackModal onClose={() => setAdding(false)} />}
    </>
  );
}
