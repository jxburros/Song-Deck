import { useState } from 'react';
import { tickToMusical } from '@songdeck/core';
import { useStudio } from '../../../state/store';
import { Badge, Button, Field, Spinner, TextArea } from '../../../ui/kit';
import { ProviderPicker } from '../../shared/ProviderPicker';
import { aiEdit } from '../../../engine/ai';

const EXAMPLES = [
  'Make the bass busier.',
  'Make this melody sadder.',
  'Simplify the drums.',
  'Change this to half-time.',
  'Add tension over these four bars.',
  'Make the violin answer the vocal rather than double it.',
  'Keep the rhythm but change the pitches.',
  'Turn these chords into something more harmonically ambiguous.',
];

/** AI MIDI editing (spec §20): natural language → structured operations → proposal with a visual diff. */
export default function AiEditPanel() {
  const song = useStudio((s) => s.project?.song ?? null);
  const selection = useStudio((s) => s.selection);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const st = useStudio.getState();
  const [instruction, setInstruction] = useState('');
  const [provider, setProvider] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ explanation: string; source: string } | null>(null);
  if (!song) return null;

  const track = song.tracks.find((t) => t.id === selectedTrackId);
  const scopeTracks = selection.trackIds?.length ? selection.trackIds : track ? [track.id] : [];
  const range =
    selection.startTick !== undefined && selection.endTick !== undefined
      ? `bars ${tickToMusical(song, selection.startTick).bar}–${tickToMusical(song, Math.max(selection.startTick, selection.endTick - 1)).bar}`
      : 'whole song';

  const run = async (text = instruction) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const res = await aiEdit(song, text, { ...selection, trackIds: scopeTracks }, { providerChoice: provider });
      setLast({ explanation: res.explanation, source: res.source });
      if (!res.proposalCreated && res.explanation) st.toast('info', res.explanation);
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) st.toast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col">
      <div>
        <h3>Change it with words</h3>
        <div className="small muted">The output stays MIDI. Nothing is overwritten until you accept the proposal.</div>
      </div>
      <div className="card small">
        <div className="row wrap">
          <span className="muted">Scope:</span>
          {scopeTracks.length ? (
            scopeTracks.map((id) => <Badge key={id}>{song.tracks.find((t) => t.id === id)?.name ?? id}</Badge>)
          ) : (
            <Badge>all tracks</Badge>
          )}
          <Badge tone="accent">{range}</Badge>
          {selection.noteIds.length > 0 && <Badge>{selection.noteIds.length} notes</Badge>}
        </div>
      </div>
      <Field label="Instruction">
        <TextArea
          value={instruction}
          onChange={setInstruction}
          rows={3}
          placeholder="e.g. Make the bass busier"
          aria-label="Edit instruction"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void run();
            }
          }}
        />
      </Field>
      <div className="chip-list">
        {EXAMPLES.map((ex) => (
          <button key={ex} className="chip" onClick={() => setInstruction(ex)}>
            {ex}
          </button>
        ))}
      </div>
      <Field label="Who edits">
        <ProviderPicker role="midi-editing" value={provider} onChange={setProvider} />
      </Field>
      <Button variant="ai" icon="sparkles" onClick={() => void run()} disabled={busy || !instruction.trim()}>
        {busy ? <Spinner /> : 'Propose change'}
      </Button>
      {last && (
        <div className="callout">
          <div className="small dim" style={{ marginBottom: 4 }}>
            {last.source}
          </div>
          {last.explanation}
        </div>
      )}
    </div>
  );
}
