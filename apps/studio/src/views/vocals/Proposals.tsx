import type { Project, Proposal } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { activeRender, formatBars } from '../../engine/vocal-model';
import { acceptVocalProposal, rejectVocalProposal, useVocalJobs, type VocalProposalInfo } from '../../engine/vocal-sync';
import { Badge, Button } from '../../ui/kit';
import { Icon } from '../../ui/icons';

/** A pending vocal proposal (spec §21): diff summary, validation, accept (→ re-sing only its range) / reject / view diff. */
export function VocalProposalCard({ project, proposal, info, compact }: { project: Project; proposal: Proposal; info?: VocalProposalInfo; compact?: boolean }) {
  const st = useStudio.getState();
  const autoResing = useVocalJobs((s) => s.autoResing);
  const errors = proposal.validation.issues.filter((i) => i.severity === 'error' && !i.fixed);
  const warnings = proposal.validation.issues.filter((i) => i.severity === 'warning' || i.fixed);
  const trackId = info?.trackId ?? proposal.diff.tracks.find((t) => t.added.length || t.removed.length || t.modified.length)?.trackId;
  const willResing = !!(info?.range && trackId && autoResing && activeRender(project, trackId));
  const accept = () => {
    const r = acceptVocalProposal(proposal.id);
    if (!r.ok) {
      if (!r.reported) st.toast('error', r.error ?? 'Could not accept the proposal.');
    }
    else st.toast('success', willResing ? `Accepted — re-singing ${info?.label ?? 'the changed range'} only.` : 'Accepted.');
  };
  const view = () => {
    st.setActiveProposal(proposal.id);
    if (trackId) st.selectTrack(trackId);
    st.setWorkbenchView('piano-roll');
  };
  return (
    <div className="card vx-proposal" data-testid="vocal-proposal">
      <div className="row between" style={{ gap: 6 }}>
        <strong className="ellipsis">{proposal.title}</strong>
        <Badge tone="ai">{proposal.source === 'internal' ? 'on-device' : proposal.source}</Badge>
      </div>
      {proposal.explanation && !compact && <div className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{proposal.explanation}</div>}
      <ul className="small vx-diff">
        {proposal.diff.summary.slice(0, compact ? 3 : 6).map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      {info?.range && (
        <div className="small dim" style={{ marginBottom: 6 }}>
          <Icon name="waveform" size={11} /> {willResing ? 'After accepting, only' : 'Changed range:'} {info.label ?? formatBars(project.song, info.range.startTick, info.range.endTick)}{' '}
          {willResing ? 'is re-sung and spliced into the render.' : ''}
        </div>
      )}
      {(errors.length > 0 || warnings.length > 0) && (
        <div className="callout warning small" style={{ marginBottom: 6 }}>
          {[...errors, ...warnings].slice(0, 3).map((i, k) => (
            <div key={k}>
              {i.fixed ? 'Fixed: ' : i.severity === 'error' ? 'Error: ' : 'Warning: '}
              {i.message}
            </div>
          ))}
        </div>
      )}
      <div className="row wrap">
        <Button size="sm" variant="success" icon="check" onClick={accept} aria-label={willResing ? 'Accept and re-sing' : 'Accept proposal'}>
          {willResing ? 'Accept & re-sing' : 'Accept'}
        </Button>
        <Button size="sm" variant="danger" icon="close" onClick={() => rejectVocalProposal(proposal.id)} aria-label="Reject proposal">
          Reject
        </Button>
        <Button size="sm" variant="ghost" icon="eye" onClick={view} title="Show the note diff in the piano roll">
          View diff
        </Button>
      </div>
    </div>
  );
}

/** Pending proposals made from Vocals mode. */
export function PendingVocalProposals({ project, compact }: { project: Project; compact?: boolean }) {
  const proposals = useStudio((s) => s.proposals);
  const infos = useVocalJobs((s) => s.proposals);
  const pending = proposals.filter((p) => p.status === 'pending' && infos.some((i) => i.proposalId === p.id));
  if (!pending.length) return null;
  return (
    <div className="col" style={{ gap: 8 }}>
      {pending.map((p) => (
        <VocalProposalCard key={p.id} project={project} proposal={p} info={infos.find((i) => i.proposalId === p.id)} compact={compact} />
      ))}
    </div>
  );
}
