import { useStudio } from '../../../state/store';
import { Badge, Button } from '../../../ui/kit';
import { Icon } from '../../../ui/icons';

/** Proposed Change System (spec §21): Current MIDI → AI proposal → visual diff → Accept / Reject / Modify. */
export default function ProposalsPanel({ pendingOnly = false }: { pendingOnly?: boolean } = {}) {
  const proposals = useStudio((s) => s.proposals);
  const activeId = useStudio((s) => s.activeProposalId);
  const st = useStudio.getState();
  if (pendingOnly && !proposals.some((p) => p.status === 'pending')) return null;
  if (!proposals.length)
    return (
      <div className="small muted">
        No proposals yet. AI edits, theory controls and assistant suggestions appear here as reviewable diffs
        — nothing changes until you accept.
      </div>
    );
  const pending = proposals.filter((p) => p.status === 'pending');
  const past = proposals.filter((p) => p.status !== 'pending');
  const view = (id: string) => {
    const p = proposals.find((x) => x.id === id)!;
    st.setActiveProposal(id);
    const t = p.diff.tracks.find((d) => d.added.length || d.removed.length || d.modified.length);
    if (t) {
      st.selectTrack(t.trackId);
      st.setWorkbenchView('piano-roll');
    } else if (p.diff.chords.added.length || p.diff.chords.removed.length) st.setWorkbenchView('chords');
    else if (p.diff.sectionsChanged) st.setWorkbenchView('structure');
  };
  return (
    <div className="col">
      {pending.map((p) => {
        const errors = p.validation.issues.filter((i) => i.severity === 'error' && !i.fixed);
        const warnings = p.validation.issues.filter((i) => i.severity === 'warning' || i.fixed);
        return (
          <div key={p.id} className={`card ${p.id === activeId ? 'selected' : ''}`}>
            <div className="row between">
              <strong>{p.title}</strong>
              <Badge tone="ai">{p.source === 'internal' ? 'on-device' : p.source}</Badge>
            </div>
            {p.instruction && <div className="small muted">“{p.instruction}”</div>}
            {p.explanation && (
              <div className="small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                {p.explanation}
              </div>
            )}
            <ul className="small" style={{ margin: '8px 0', paddingLeft: 16 }}>
              {p.diff.summary.slice(0, 8).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
            {(errors.length > 0 || warnings.length > 0) && (
              <div className="callout warning small" style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>Validation</div>
                {[...errors, ...warnings].slice(0, 5).map((i, k) => (
                  <div key={k}>
                    {i.fixed ? '🔧 ' : i.severity === 'error' ? '⛔ ' : '⚠️ '}
                    {i.message}
                  </div>
                ))}
              </div>
            )}
            <div className="row wrap">
              <Button size="sm" icon="eye" onClick={() => view(p.id)} title="Show the note diff">
                View diff
              </Button>
              <Button size="sm" variant="success" icon="check" onClick={() => st.acceptProposal(p.id)}>
                Accept
              </Button>
              <Button size="sm" variant="danger" icon="close" onClick={() => st.rejectProposal(p.id)}>
                Reject
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="pencil"
                onClick={() => view(p.id)}
                title="Edit the proposed notes in the piano roll before accepting"
              >
                Modify
              </Button>
            </div>
          </div>
        );
      })}
      {!pendingOnly && past.length > 0 && (
        <>
          <h4 style={{ marginTop: 8 }}>Earlier</h4>
          {past.map((p) => (
            <div
              key={p.id}
              className="row small"
              style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}
            >
              <Icon name={p.status === 'accepted' ? 'check' : 'close'} size={12} />
              <span className="grow ellipsis">{p.title}</span>
              <Badge tone={p.status === 'accepted' ? 'success' : undefined}>{p.status}</Badge>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
