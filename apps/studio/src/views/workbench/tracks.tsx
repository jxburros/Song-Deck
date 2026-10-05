import { useMemo, useState } from 'react';
import {
  BUILTIN_INSTRUMENTS,
  channelFor,
  colorForRole,
  defaultChannelStrip,
  randomId,
  randomSeed,
  regenerateUnlocked,
  type Song,
  type Track,
  type TrackRole,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useCustomInstruments } from '../../hooks';
import { Button, Field, Modal, Select, TextInput, Toggle } from '../../ui/kit';
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

/** "Add instrument track": pick an instrument, name and role, and optionally generate a part now. */
export function AddTrackModal({ onClose }: { onClose: () => void }) {
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
