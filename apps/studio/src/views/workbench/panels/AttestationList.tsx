import { ATTESTATION_BASIS_SHORT, attestationNeedsCare, type Project } from '@songdeck/core';
import { Badge } from '../../../ui/kit';
import { Icon } from '../../../ui/icons';

/** Upload rights attestations of the project (docs/RIGHTS.md), shown in the Inspector's rights panel. */
export function AttestationList({ project }: { project: Project }) {
  const list = project.meta.attestations ?? [];
  return (
    <div className="col" style={{ gap: 6 }} data-testid="rights-attestations">
      <div className="field-label">Upload attestations</div>
      {list.length === 0 ? (
        <div className="small muted">
          Uploaded audio files record who attested the right to use them, and on what basis, here.
        </div>
      ) : (
        list
          .slice()
          .reverse()
          .map((a) => {
            const care = attestationNeedsCare(a);
            return (
              <div key={a.id} className="card small" data-testid="rights-attestation">
                <div className="row between" style={{ gap: 6 }}>
                  <strong className="ellipsis" title={a.fileName}>
                    {a.fileName}
                  </strong>
                  <Badge tone={a.basis === 'personal-study' ? 'warning' : 'success'}>
                    {ATTESTATION_BASIS_SHORT[a.basis]}
                  </Badge>
                </div>
                <div className="muted">
                  Attested by {a.attestedBy || 'unknown'} · {new Date(a.attestedAt).toLocaleDateString()} ·{' '}
                  {a.context}
                </div>
                {(a.rightsHolder || a.licence) && (
                  <div className="dim">
                    {[
                      a.rightsHolder && `Rights holder: ${a.rightsHolder}`,
                      a.licence && `Licence: ${a.licence}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
                {a.notes && <div className="dim">{a.notes}</div>}
                {care && (
                  <div className="row" style={{ gap: 4, marginTop: 4, color: 'var(--warning)' }}>
                    <Icon name="alert" size={12} />
                    <span>
                      {a.match
                        ? `Matched ${a.match.title ?? 'a known recording'}${a.match.artists?.length ? ` — ${a.match.artists.join(', ')}` : ''} (${a.match.service})`
                        : a.flagged
                          ? `Tagged as a commercial release: ${a.signals
                              .filter((s) => s.kind !== 'artist' && s.kind !== 'title' && s.kind !== 'album')
                              .slice(0, 2)
                              .map((s) => `${s.label} ${s.value}`)
                              .join('; ')}`
                          : 'Personal study only — not for release'}
                    </span>
                  </div>
                )}
              </div>
            );
          })
      )}
    </div>
  );
}
