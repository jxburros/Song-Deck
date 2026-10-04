import { useEffect, useState } from 'react';
import { ATTESTATION_BASIS_LABEL, type AttestationBasis } from '@songdeck/core';
import { useSettings } from '../../state/settings';
import {
  buildAttestations,
  checkFileOffline,
  checkFileOnline,
  isFlagged,
  loadAttestationMemory,
  settleAttestation,
  useAttestationDialog,
  useContentCheck,
  type AttestationRequest,
  type CheckedFile,
} from '../../engine/rights';
import { Badge, Button, Field, Modal, Spinner, TextArea, TextInput } from '../../ui/kit';
import { Icon } from '../../ui/icons';

/**
 * Shared upload attestation dialog (docs/RIGHTS.md). Shown before uploaded audio is used, by
 * every upload path. Warn-only: the checks (embedded tags; optional online identification)
 * never block, but the user must state a basis — Cancel abandons the upload.
 */

const BASES: { value: AttestationBasis; hint: string }[] = [
  { value: 'own-work', hint: 'You wrote, performed and recorded it, or otherwise hold the rights.' },
  {
    value: 'licensed',
    hint: 'A licence, sample-pack terms or written permission from the rights holder covers this use.',
  },
  {
    value: 'open-licence',
    hint: 'Public domain, or released under an open licence such as Creative Commons. Name the licence below.',
  },
  {
    value: 'personal-study',
    hint: 'Learning, practice or analysis on this device — not for release. You will be reminded before it leaves the device or is exported.',
  },
];

export function AttestationDialog() {
  const request = useAttestationDialog((s) => s.request);
  if (!request) return null;
  return <AttestationModal key={request.id} request={request} />;
}

function bytesLabel(n: number): string {
  return n >= 1024 * 1024
    ? `${(n / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function AttestationModal({ request }: { request: AttestationRequest }) {
  const userName = useSettings((s) => s.userName);
  const online = useContentCheck((s) => s.online);
  const [checked, setChecked] = useState<CheckedFile[] | null>(null);
  const [basis, setBasis] = useState<AttestationBasis | null>(null);
  const [attestedBy, setAttestedBy] = useState(
    () => loadAttestationMemory().lastAttestedBy ?? userName ?? '',
  );
  const [rightsHolder, setRightsHolder] = useState('');
  const [licence, setLicence] = useState('');
  const [notes, setNotes] = useState('');
  const [prefilled, setPrefilled] = useState(false);

  // Offline checks first (hash + tags), then the optional online identification per file.
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      const list = await Promise.all(request.files.map((f) => checkFileOffline(f)));
      if (ctrl.signal.aborted) return;
      const rem = list.map((c) => c.remembered).find(Boolean);
      if (rem && list.every((c) => c.remembered && c.remembered.basis === rem.basis)) {
        setBasis(rem.basis);
        setAttestedBy(rem.attestedBy);
        setRightsHolder(rem.rightsHolder ?? '');
        setLicence(rem.licence ?? '');
        setNotes(rem.notes ?? '');
        setPrefilled(true);
      }
      setChecked(online ? list.map((c) => ({ ...c, online: 'pending' })) : list);
      if (!online) return;
      for (let i = 0; i < request.files.length; i++) {
        const r = await checkFileOnline(request.files[i], ctrl.signal);
        if (ctrl.signal.aborted) return;
        setChecked((cur) => cur && cur.map((c, j) => (j === i ? { ...c, ...r } : c)));
      }
    })();
    return () => ctrl.abort();
  }, [request, online]);

  const cancel = () => settleAttestation(null);
  const needsLicence = basis === 'open-licence';
  const ready =
    !!checked && !!basis && attestedBy.trim().length > 0 && (!needsLicence || licence.trim().length > 0);
  const confirm = () => {
    if (!ready || !checked || !basis) return;
    settleAttestation(
      buildAttestations(checked, { basis, attestedBy, rightsHolder, licence, notes }, request.context),
    );
  };
  const flagged = checked?.filter((c) => isFlagged(c)) ?? [];
  const many = request.files.length > 1;

  return (
    <Modal
      title={many ? `Your rights to ${request.files.length} audio files` : 'Your rights to this audio'}
      icon="shield"
      wide
      onClose={cancel}
      footer={
        <>
          <span className="small dim grow" style={{ textAlign: 'left' }}>
            Stored with the project and remembered for this file in this browser.
          </span>
          <Button onClick={cancel}>Cancel upload</Button>
          <Button
            variant="primary"
            icon="shield"
            onClick={confirm}
            disabled={!ready}
            data-testid="attest-confirm"
          >
            {flagged.length ? 'Attest and continue anyway' : 'Attest and continue'}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }} data-testid="attestation-dialog">
        <div className="small muted">
          <strong>{request.purpose}.</strong> Before {many ? 'these files are' : 'this file is'} used, say on
          what basis you may use {many ? 'them' : 'it'}. Song Deck does not block anything — this is your
          record and a reminder.
        </div>

        <div className="col" style={{ gap: 8 }}>
          {request.files.map((f, i) => {
            const c = checked?.[i];
            return <FileCheck key={i} name={f.name} size={f.bytes.length} check={c} onlineEnabled={online} />;
          })}
        </div>

        {prefilled && (
          <div className="callout success small" data-testid="attestation-prefilled">
            You attested {many ? 'these files' : 'this exact file'} before — your previous answer is filled
            in.
          </div>
        )}

        <div role="radiogroup" aria-label="Basis" className="col" style={{ gap: 6 }}>
          {BASES.map((b) => {
            const on = basis === b.value;
            return (
              <label
                key={b.value}
                className="card row"
                style={{
                  cursor: 'pointer',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '8px 10px',
                  borderColor: on ? 'var(--accent)' : undefined,
                  background: on ? 'var(--accent-soft)' : undefined,
                }}
              >
                <input
                  type="radio"
                  name={`basis-${request.id}`}
                  checked={on}
                  onChange={() => setBasis(b.value)}
                  aria-label={ATTESTATION_BASIS_LABEL[b.value]}
                  style={{ marginTop: 3 }}
                />
                <span className="col" style={{ gap: 2 }}>
                  <strong>{ATTESTATION_BASIS_LABEL[b.value]}</strong>
                  <span className="small dim">{b.hint}</span>
                </span>
              </label>
            );
          })}
        </div>

        <div className="grid-2">
          <Field label="Attested by" hint="The person making this statement">
            <TextInput value={attestedBy} onChange={setAttestedBy} aria-label="Attested by" />
          </Field>
          <Field label="Rights holder (optional)" hint="Who owns the recording, if not you">
            <TextInput
              value={rightsHolder}
              onChange={setRightsHolder}
              placeholder="e.g. Acme Samples Ltd"
              aria-label="Rights holder"
            />
          </Field>
          {(basis === 'open-licence' || basis === 'licensed') && (
            <Field
              label={basis === 'open-licence' ? 'Licence' : 'Licence / permission (optional)'}
              hint={
                basis === 'open-licence'
                  ? 'e.g. CC BY 4.0, CC0, public domain'
                  : 'e.g. licence number, contract, e-mail permission'
              }
            >
              <TextInput
                value={licence}
                onChange={setLicence}
                placeholder={basis === 'open-licence' ? 'CC BY 4.0' : 'Licence #42'}
                aria-label="Licence"
              />
            </Field>
          )}
        </div>
        <Field label="Notes (optional)">
          <TextArea
            value={notes}
            onChange={setNotes}
            rows={2}
            placeholder="Where it came from, what the licence allows…"
            aria-label="Attestation notes"
          />
        </Field>
        <div className="small dim">
          Checks are limited: embedded tags are easy to strip, and fingerprinting
          {online ? '' : ' (off — Settings → Privacy → Content check)'} only recognises this exact recording,
          not covers, re-recordings or humming.
        </div>
      </div>
    </Modal>
  );
}

function FileCheck({
  name,
  size,
  check,
  onlineEnabled,
}: {
  name: string;
  size: number;
  check?: CheckedFile;
  onlineEnabled: boolean;
}) {
  const level = check?.metadata.level ?? 'none';
  const commercial = level === 'likely-commercial' || !!check?.match;
  return (
    <div className="card col" style={{ gap: 6 }} data-testid="attestation-file">
      <div className="row between">
        <span className="row ellipsis" style={{ gap: 6 }}>
          <Icon name="wave" size={14} />
          <strong className="ellipsis" title={name}>
            {name}
          </strong>
          <span className="small dim">{bytesLabel(size)}</span>
        </span>
        {!check ? (
          <Spinner />
        ) : commercial ? (
          <Badge tone="warning">
            <Icon name="alert" size={11} /> looks like a commercial release
          </Badge>
        ) : level === 'hint' ? (
          <Badge>tagged</Badge>
        ) : (
          <Badge tone="success">no rights tags found</Badge>
        )}
      </div>
      {check && level !== 'none' && (
        <div
          className={`callout small ${level === 'likely-commercial' ? 'warning' : ''}`}
          data-testid="attestation-warning"
          role={level === 'likely-commercial' ? 'alert' : undefined}
        >
          {check.metadata.summary}
          {level === 'likely-commercial' &&
            ' You can still continue if you have the rights — but uploading other people’s releases without permission may infringe their copyright.'}
        </div>
      )}
      {check && onlineEnabled && (
        <div className="small" data-testid="attestation-online">
          {check.online === 'pending' && (
            <span className="row dim" style={{ gap: 6 }}>
              <Spinner /> Checking the fingerprint with AcoustID…
            </span>
          )}
          {check.online === 'matched' && check.match && (
            <div className="callout warning" role="alert">
              AcoustID recognises this recording as{' '}
              <strong>{check.match.title ?? 'a known recording'}</strong>
              {check.match.artists?.length ? ` by ${check.match.artists.join(', ')}` : ''}
              {check.match.releaseTitle ? ` (${check.match.releaseTitle})` : ''} —{' '}
              {Math.round(check.match.score * 100)}% match.
            </div>
          )}
          {check.online === 'no-match' && (
            <span className="dim">
              AcoustID: no match (this does not prove the recording is free to use).
            </span>
          )}
          {check.online === 'error' && (
            <span className="dim">Online check unavailable: {check.onlineError}</span>
          )}
        </div>
      )}
    </div>
  );
}
