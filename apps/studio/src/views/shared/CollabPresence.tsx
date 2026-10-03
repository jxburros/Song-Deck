import type { CSSProperties } from 'react';
import { useSettings } from '../../state/settings';
import { useStudio } from '../../state/store';
import { describePresence, initials, useCollab } from '../../engine/collab';
import { openSettings } from '../settings/nav';

/**
 * Collaboration presence for the top bar (spec §70 Phase 5): compact avatars of the people in the
 * open project's room with what they are looking at. Hidden when not collaborating; click opens
 * Settings → Collaboration. Importing this module also wires the collaboration client (commit
 * sync, auto-connect) at startup.
 */

const wrap: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 30,
  padding: '0 8px 0 6px',
  borderRadius: 999,
  border: '1px solid var(--border)',
  background: 'var(--bg-input)',
  color: 'var(--text-muted)',
  font: 'inherit',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const avatar = (color: string, i: number): CSSProperties => ({
  display: 'inline-grid',
  placeItems: 'center',
  width: 22,
  height: 22,
  borderRadius: '50%',
  background: color,
  color: 'var(--on-track)',
  fontSize: 9.5,
  fontWeight: 800,
  letterSpacing: '-0.02em',
  marginLeft: i === 0 ? 0 : -4,
  boxShadow: '0 0 0 2px var(--bg-elev-1)',
  position: 'relative',
  zIndex: i + 1,
});

const MAX = 4;

export function CollabPresence() {
  const status = useCollab((s) => s.status);
  const peers = useCollab((s) => s.peers);
  const roomId = useCollab((s) => s.projectId);
  const color = useCollab((s) => s.color);
  const userName = useSettings((s) => s.userName);
  const project = useStudio((s) => s.project);
  if (status === 'disconnected' || !project || project.meta.id !== roomId) return null;
  const dot = status === 'connected' ? 'var(--success)' : 'var(--warning)';
  const label =
    status === 'connected'
      ? `Live collaboration — ${peers.length ? `${peers.length + 1} people in the room` : 'only you so far'}`
      : status === 'reconnecting'
        ? 'Collaboration: reconnecting…'
        : 'Collaboration: connecting…';
  return (
    <button
      type="button"
      style={wrap}
      onClick={() => openSettings('collab')}
      title={label}
      aria-label={label}
      data-testid="collab-presence"
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flex: 'none' }} />
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <span style={avatar(color, 0)} title={`${userName || 'Me'} (you)`}>
          {initials(userName || 'Me')}
        </span>
        {peers.slice(0, MAX).map((p, i) => (
          <span
            key={p.peerId}
            style={avatar(p.user.color, i + 1)}
            title={`${p.user.name} — ${describePresence(p.presence, project.song)}`}
          >
            {initials(p.user.name)}
          </span>
        ))}
        {peers.length > MAX && (
          <span style={{ ...avatar('var(--bg-elev-3)', MAX + 1), color: 'var(--text)' }}>
            +{peers.length - MAX}
          </span>
        )}
      </span>
      <span>{status === 'connected' ? 'Live' : '…'}</span>
    </button>
  );
}

export default CollabPresence;
