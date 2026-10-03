import { useMemo } from 'react';
import {
  TRACK_NEUTRAL,
  BUILTIN_INSTRUMENTS,
  getInstrument,
  midiToNoteName,
  noteNameToMidi,
  randomId,
  type RightsMetadata,
  type Track,
} from '@songdeck/core';
import { useStudio } from '../../../state/store';
import { useCustomInstruments } from '../../../hooks';
import { Badge, Button, CommitText, Field, Select } from '../../../ui/kit';
import { AVOID_RULES, FUNCTIONS, TRACK_ROLES } from '../../compose/BlueprintEditor';
import { AttestationList } from './AttestationList';

const RIGHTS_FIELDS: { key: keyof RightsMetadata; label: string }[] = [
  { key: 'humanComposers', label: 'Human composer(s)' },
  { key: 'lyricWriters', label: 'Lyric writer(s)' },
  { key: 'performers', label: 'Performer(s)' },
  { key: 'voiceModels', label: 'Voice model(s)' },
  { key: 'modelProviders', label: 'Model provider(s)' },
  { key: 'sourceReferences', label: 'Source references' },
  { key: 'samples', label: 'Samples' },
  { key: 'licensedAssets', label: 'Licensed assets' },
];

/** Track inspector (instrument constraints §17), provenance (§64) and rights metadata (§65). */
export default function InspectorPanel() {
  const project = useStudio((s) => s.project);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const customInstruments = useCustomInstruments();
  const instruments = useMemo(() => [...BUILTIN_INSTRUMENTS, ...customInstruments], [customInstruments]);
  const st = useStudio.getState();
  if (!project) return null;
  const song = project.song;
  const track = song.tracks.find((t) => t.id === selectedTrackId);

  const updateTrack = (patch: Partial<Track>, message: string) => {
    if (!track) return;
    st.commit({ ...song, tracks: song.tracks.map((t) => (t.id === track.id ? { ...t, ...patch } : t)) }, message, 'edit');
  };
  const rights = project.meta.rights;
  const setRights = (patch: Partial<RightsMetadata>) => st.updateProject((p) => ({ ...p, meta: { ...p.meta, rights: { ...p.meta.rights, ...patch } } }));

  return (
    <div className="col">
      {track ? (
        <>
          <h3>Track</h3>
          <Field label="Name">
            <CommitText value={track.name} onCommit={(name) => updateTrack({ name }, `Renamed track to ${name}`)} />
          </Field>
          <Field label="Instrument">
            <Select
              value={track.instrumentId}
              onChange={(instrumentId) => updateTrack({ instrumentId, stemGroup: getInstrument(instrumentId, customInstruments).stemGroup }, `${track.name}: instrument → ${instrumentId}`)}
              options={instruments.map((i) => ({ value: i.id, label: i.name }))}
            />
          </Field>
          <div className="grid-2">
            <Field label="Generator role">
              <Select value={track.role} onChange={(role) => updateTrack({ role }, `${track.name}: role → ${role}`)} options={TRACK_ROLES} />
            </Field>
            <Field label="Function">
              <Select
                value={track.constraints.function ?? 'accompaniment'}
                onChange={(fn) => updateTrack({ constraints: { ...track.constraints, function: fn } }, `${track.name}: function → ${fn}`)}
                options={FUNCTIONS}
              />
            </Field>
            <Field label="Lowest note" hint={`Instrument: ${midiToNoteName(getInstrument(track.instrumentId, customInstruments).range.low)}`}>
              <CommitText
                value={track.constraints.lowest !== undefined ? midiToNoteName(track.constraints.lowest) : ''}
                placeholder="—"
                onCommit={(v) => {
                  const m = v.trim() ? noteNameToMidi(v) : undefined;
                  if (m !== null) updateTrack({ constraints: { ...track.constraints, lowest: m ?? undefined } }, `${track.name}: lowest note ${v || 'cleared'}`);
                }}
              />
            </Field>
            <Field label="Highest note" hint={`Instrument: ${midiToNoteName(getInstrument(track.instrumentId, customInstruments).range.high)}`}>
              <CommitText
                value={track.constraints.highest !== undefined ? midiToNoteName(track.constraints.highest) : ''}
                placeholder="—"
                onCommit={(v) => {
                  const m = v.trim() ? noteNameToMidi(v) : undefined;
                  if (m !== null) updateTrack({ constraints: { ...track.constraints, highest: m ?? undefined } }, `${track.name}: highest note ${v || 'cleared'}`);
                }}
              />
            </Field>
            <Field label="Complexity">
              <Select
                value={track.constraints.complexity ?? 'medium'}
                onChange={(complexity) => updateTrack({ constraints: { ...track.constraints, complexity } }, `${track.name}: complexity ${complexity}`)}
                options={['low', 'medium', 'high'] as const}
              />
            </Field>
            <Field label="Colour">
              <input type="color" value={track.color || TRACK_NEUTRAL} onChange={(e) => updateTrack({ color: e.target.value }, `${track.name}: colour`)} style={{ height: 30, width: '100%', background: 'none', border: 'none' }} />
            </Field>
          </div>
          <Field label="Plays in sections" hint="None selected = arrangement engine decides">
            <div className="chip-list">
              {song.sections.map((s) => {
                const on = track.constraints.sectionIds?.includes(s.id) ?? false;
                return (
                  <button
                    key={s.id}
                    className={`chip ${on ? 'on' : ''}`}
                    onClick={() => {
                      const ids = new Set(track.constraints.sectionIds ?? []);
                      if (on) ids.delete(s.id);
                      else ids.add(s.id);
                      updateTrack({ constraints: { ...track.constraints, sectionIds: Array.from(ids) } }, `${track.name}: sections`);
                    }}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Avoid">
            <div className="chip-list">
              {AVOID_RULES.map((a) => {
                const on = track.constraints.avoid?.includes(a) ?? false;
                return (
                  <button
                    key={a}
                    className={`chip ${on ? 'on' : ''}`}
                    onClick={() =>
                      updateTrack(
                        { constraints: { ...track.constraints, avoid: on ? (track.constraints.avoid ?? []).filter((x) => x !== a) : [...(track.constraints.avoid ?? []), a] } },
                        `${track.name}: avoid ${a}`,
                      )
                    }
                  >
                    {a}
                  </button>
                );
              })}
            </div>
          </Field>
          <div className="row">
            <Button
              size="sm"
              icon="copy"
              onClick={() => {
                const copy: Track = { ...track, id: randomId('trk'), name: `${track.name} 2`, notes: track.notes.map((n) => ({ ...n, id: randomId('n') })) };
                st.commit({ ...song, tracks: [...song.tracks, copy], mixer: { ...song.mixer, channels: { ...song.mixer.channels, [copy.id]: song.mixer.channels[track.id] } } }, `Duplicated ${track.name}`, 'edit');
              }}
            >
              Duplicate
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon="trash"
              onClick={() => {
                st.commit({ ...song, tracks: song.tracks.filter((t) => t.id !== track.id) }, `Removed track ${track.name}`, 'edit');
                st.selectTrack(song.tracks.find((t) => t.id !== track.id)?.id ?? null);
              }}
            >
              Remove
            </Button>
          </div>
          {track.generator && (
            <div className="small dim">
              Generated by {track.generator.id}
              {track.generator.seed !== undefined ? ` · seed ${track.generator.seed}` : ''}
            </div>
          )}
        </>
      ) : (
        <div className="small muted">Select a track to inspect it.</div>
      )}

      <h3 style={{ marginTop: 12 }}>Provenance</h3>
      {project.meta.provenance.length === 0 ? (
        <div className="small muted">Generated artifacts (renders, vocals, productions, masters) record how they were made here.</div>
      ) : (
        project.meta.provenance
          .slice()
          .reverse()
          .slice(0, 20)
          .map((p) => (
            <div key={p.id} className="card small">
              <div className="row between">
                <strong className="ellipsis">{p.artifactName}</strong>
                <Badge tone={p.cloud ? 'warning' : 'success'}>{p.cloud ? 'cloud' : 'on-device'}</Badge>
              </div>
              <div className="muted">
                {p.providerName}
                {p.modelId ? ` · ${p.modelId}` : ''}
                {p.seed !== undefined ? ` · seed ${p.seed}` : ''}
              </div>
              {p.sources.length > 0 && <div className="dim">Source: {p.sources.map((s) => `${s.ref}${s.revision ? ` v${s.revision}` : ''}`).join(', ')}</div>}
              <div className="dim">{new Date(p.generatedAt).toLocaleString()}</div>
            </div>
          ))
      )}

      <h3 style={{ marginTop: 12 }}>Rights & attribution</h3>
      {RIGHTS_FIELDS.map((f) => (
        <Field key={f.key} label={f.label}>
          <CommitText value={(rights[f.key] as string[]).join(', ')} onCommit={(v) => setRights({ [f.key]: v.split(',').map((x) => x.trim()).filter(Boolean) })} />
        </Field>
      ))}
      <Field label="AI assistance (description)">
        <CommitText value={rights.aiAssistance} onCommit={(aiAssistance) => setRights({ aiAssistance })} placeholder="e.g. Harmony and drums AI-generated, edited by hand" />
      </Field>
      <AttestationList project={project} />
    </div>
  );
}
