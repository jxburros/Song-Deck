import { useEffect, useMemo, useState } from 'react';
import { randomId, type Project, type Track, type VoiceConsent, type VoiceKind, type VoiceModelRecord, type VoiceType } from '@songdeck/core';
import { isValidConsent, type VoiceInfo } from '@songdeck/ai';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { getRegistry, useAiRuntime } from '../../engine/ai';
import {
  BUILTIN_SINGER_ID,
  CONSENT_BASIS_LABEL,
  VOICE_KIND_LABEL,
  builtInVoices,
  consentSummary,
  isBuiltInVoice,
  providerVoiceChoices,
  projectVoiceChoices,
  withRights,
  type VoiceChoice,
} from '../../engine/vocal-model';
import { Badge, Button, Field, Modal, Select, TextArea, TextInput } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { discoverVoicesOnce } from './shared';

/**
 * Voice library, safety and consent (spec §36): stock synthetic voices, user-trained voices,
 * imported voice models and third-party voices. Every non-stock voice needs an authorization
 * attestation (who attests, rights holder, basis, evidence, scope) before it can be used for
 * singing synthesis (cloning) or voice conversion; the attestation is stored with the project
 * as voice provenance (VoiceModelRecord.consent) and in the rights metadata (spec §65).
 */

const VOICE_TYPES: { value: VoiceType | ''; label: string }[] = [
  { value: '', label: '—' },
  { value: 'soprano', label: 'Soprano' },
  { value: 'mezzo', label: 'Mezzo' },
  { value: 'alto', label: 'Alto' },
  { value: 'tenor', label: 'Tenor' },
  { value: 'baritone', label: 'Baritone' },
  { value: 'bass', label: 'Bass' },
];

const BASES: { value: Exclude<VoiceConsent['basis'], 'stock'>; label: string }[] = [
  { value: 'own-voice', label: CONSENT_BASIS_LABEL['own-voice'] },
  { value: 'written-permission', label: CONSENT_BASIS_LABEL['written-permission'] },
  { value: 'license', label: CONSENT_BASIS_LABEL.license },
  { value: 'public-domain', label: CONSENT_BASIS_LABEL['public-domain'] },
];

export interface VoiceModalRequest {
  mode: 'add' | 'attest';
  /** Prefill (provider voice / existing record). */
  initial?: Partial<VoiceModelRecord>;
  /** After saving: also use the voice for singing or as the conversion target. */
  useFor?: 'singing' | 'conversion';
}

/** Providers that can host a voice: singing or voice-conversion providers (configured ones). */
function hostOptions(): { value: string; label: string }[] {
  const reg = getRegistry();
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  for (const [caps, iface] of [
    [['SINGING_SYNTHESIS'], 'singing'],
    [['VOICE_CONVERSION'], 'voiceConversion'],
  ] as const) {
    for (const c of reg.findCompatible([...caps], { interface: iface, includeUnavailable: true })) {
      if (c.location === 'internal' || seen.has(c.providerId)) continue;
      seen.add(c.providerId);
      out.push({ value: c.providerId, label: `${c.providerName} · ${c.location}` });
    }
  }
  out.push({ value: 'external', label: 'Not connected yet (record only)' });
  return out;
}

export function providerName(id: string): string {
  if (id === 'external') return 'Not connected';
  if (id === BUILTIN_SINGER_ID) return 'Built-in formant singer';
  try {
    return getRegistry().get(id)?.descriptor.name ?? id;
  } catch {
    return id;
  }
}

/** Store (or update) a voice model record; rights metadata lists authorized voices. */
export function saveVoiceRecord(rec: VoiceModelRecord) {
  const authorized = rec.kind === 'stock' || isValidConsent(rec.consent);
  useStudio.getState().updateProject((p) => {
    const voices = [...p.meta.voices.filter((v) => v.id !== rec.id), rec];
    const next = { ...p, meta: { ...p.meta, voices } };
    return authorized && rec.consent
      ? withRights(next, { voiceModels: [`${rec.name} (${VOICE_KIND_LABEL[rec.kind].toLowerCase()}; consent: ${CONSENT_BASIS_LABEL[rec.consent.basis] ?? rec.consent.basis} — ${rec.consent.rightsHolder})`] })
      : next;
  });
}

/** Use a voice for singing (song.vocals.voiceId; built-in voices also drive the live placeholder singer). */
export function chooseSingingVoice(track: Track, key: string, name: string) {
  const st = useStudio.getState();
  const cur = st.project?.song;
  if (!cur || cur.vocals.voiceId === key) return;
  const tracks = isBuiltInVoice(key) ? cur.tracks.map((t) => (t.id === track.id ? { ...t, vocal: { ...(t.vocal ?? {}), voiceId: key } } : t)) : cur.tracks;
  st.commit({ ...cur, tracks, vocals: { ...cur.vocals, voiceId: key } }, `Singing voice → ${name}`, 'vocals');
}

/** A stock voice reported by a provider: record it in the project (voice provenance) and sing with it. */
export function adoptProviderVoice(v: VoiceChoice, track: Track) {
  const rec: VoiceModelRecord = { id: v.key, name: v.name, kind: v.kind, providerId: v.providerId, modelRef: v.ref, createdAt: new Date().toISOString() };
  if (v.voiceType) rec.voiceType = v.voiceType;
  if (v.description) rec.description = v.description;
  saveVoiceRecord(rec);
  chooseSingingVoice(track, rec.id, rec.name);
}

export function chooseConversionVoice(key: string, name: string) {
  const st = useStudio.getState();
  const cur = st.project?.song;
  if (!cur || cur.vocals.conversionVoiceId === key) return;
  st.commit({ ...cur, vocals: { ...cur.vocals, conversionVoiceId: key } }, `Conversion target voice → ${name}`, 'vocals');
}

export function VoiceModelModal({ project, track, request, onClose }: { project: Project; track: Track; request: VoiceModalRequest; onClose: () => void }) {
  const userName = useSettings((s) => s.userName);
  const init = request.initial ?? {};
  const attest = request.mode === 'attest';
  const [name, setName] = useState(init.name ?? '');
  const [kind, setKind] = useState<Exclude<VoiceKind, 'stock'>>(init.kind && init.kind !== 'stock' ? init.kind : 'user-trained');
  const hosts = useMemo(() => hostOptions(), []);
  const [providerId, setProviderId] = useState(init.providerId ?? hosts[0]?.value ?? 'external');
  const [modelRef, setModelRef] = useState(init.modelRef ?? '');
  const [voiceType, setVoiceType] = useState<VoiceType | ''>(init.voiceType ?? track.vocal?.voiceType ?? '');
  const [language, setLanguage] = useState(init.language ?? project.song.vocals.language ?? 'en');
  const [description, setDescription] = useState(init.description ?? '');
  const c = init.consent;
  const [attestedBy, setAttestedBy] = useState(c?.attestedBy ?? userName ?? '');
  const [rightsHolder, setRightsHolder] = useState(c?.rightsHolder ?? '');
  const [basis, setBasis] = useState<Exclude<VoiceConsent['basis'], 'stock'>>(c?.basis && c.basis !== 'stock' ? c.basis : 'own-voice');
  const [evidence, setEvidence] = useState(c?.evidence ?? '');
  const [scope, setScope] = useState(c?.scope ?? `This project (“${project.meta.name}”)`);
  const [confirmed, setConfirmed] = useState(false);
  const identityOk = name.trim().length > 0;
  const consentOk = attestedBy.trim().length > 0 && rightsHolder.trim().length > 0 && !!basis && confirmed;
  useEffect(() => {
    if (basis === 'own-voice' && !rightsHolder && attestedBy) setRightsHolder(attestedBy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basis]);

  const save = (authorized: boolean) => {
    const now = new Date().toISOString();
    const rec: VoiceModelRecord = {
      id: init.id ?? randomId('voice'),
      name: name.trim(),
      kind: init.kind === 'stock' ? 'stock' : kind,
      providerId,
      modelRef: modelRef.trim() || name.trim(),
      createdAt: init.createdAt ?? now,
    };
    if (voiceType) rec.voiceType = voiceType;
    if (language.trim()) rec.language = language.trim();
    if (description.trim()) rec.description = description.trim();
    if (authorized) {
      rec.consent = { attestedBy: attestedBy.trim(), rightsHolder: rightsHolder.trim(), basis, attestedAt: now };
      if (evidence.trim()) rec.consent.evidence = evidence.trim();
      if (scope.trim()) rec.consent.scope = scope.trim();
    } else if (init.consent) rec.consent = init.consent;
    saveVoiceRecord(rec);
    const st = useStudio.getState();
    if (authorized) st.toast('success', `“${rec.name}” is authorized — attestation stored with the project.`);
    else st.toast('warning', `“${rec.name}” saved without authorization — it cannot be used for singing or conversion until you attest.`);
    if (request.useFor === 'singing' && authorized) chooseSingingVoice(track, rec.id, rec.name);
    if (request.useFor === 'conversion') chooseConversionVoice(rec.id, rec.name);
    onClose();
  };

  return (
    <Modal
      title={attest ? `Authorize “${init.name ?? 'voice'}”` : 'Add voice model'}
      icon="shield"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {!attest && (
            <Button onClick={() => save(false)} disabled={!identityOk} title="Keep the record; it stays unusable for cloning / conversion until authorized">
              Save without authorization
            </Button>
          )}
          <Button variant="primary" icon="shield" onClick={() => save(true)} disabled={!identityOk || !consentOk}>
            {attest ? 'Save authorization' : 'Save authorized voice'}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }} data-testid="voice-modal">
        <div className="grid-3">
          <Field label="Voice name">
            <TextInput value={name} onChange={setName} placeholder="e.g. My voice (2026)" readOnly={attest} aria-label="Voice name" />
          </Field>
          <Field label="Kind">
            <Select
              value={kind}
              onChange={setKind}
              disabled={attest}
              options={[
                { value: 'user-trained', label: VOICE_KIND_LABEL['user-trained'] },
                { value: 'imported', label: VOICE_KIND_LABEL.imported },
                { value: 'third-party', label: VOICE_KIND_LABEL['third-party'] },
              ]}
              aria-label="Voice kind"
            />
          </Field>
          <Field label="Hosted by" hint="The singing or voice-conversion provider that runs this voice model">
            <Select value={providerId} onChange={setProviderId} disabled={attest} options={hosts} aria-label="Hosting provider" />
          </Field>
          <Field label="Model reference" hint="Voice id at the provider, or the model file name">
            <TextInput value={modelRef} onChange={setModelRef} placeholder="custom_voice_01" mono readOnly={attest} aria-label="Model reference" />
          </Field>
          <Field label="Voice type">
            <Select value={voiceType} onChange={setVoiceType} disabled={attest} options={VOICE_TYPES} aria-label="Voice type of the model" />
          </Field>
          <Field label="Language">
            <TextInput value={language} onChange={setLanguage} readOnly={attest} aria-label="Voice language" />
          </Field>
        </div>
        {!attest && (
          <Field label="Description">
            <TextInput value={description} onChange={setDescription} placeholder="Where the model came from, training data, version…" aria-label="Voice description" />
          </Field>
        )}
        <div className="vx-consent">
          <div className="row" style={{ marginBottom: 8 }}>
            <Icon name="shield" />
            <strong className="grow">Authorization to use this voice</strong>
            <Badge tone="warning">required for cloning &amp; conversion</Badge>
          </div>
          <div className="grid-2">
            <Field label="Attested by" hint="The person making this attestation">
              <TextInput value={attestedBy} onChange={setAttestedBy} aria-label="Attested by" />
            </Field>
            <Field label="Rights holder" hint="The person whose voice it is">
              <TextInput value={rightsHolder} onChange={setRightsHolder} placeholder="Full name" aria-label="Rights holder" />
            </Field>
            <Field label="Basis">
              <Select value={basis} onChange={setBasis} options={BASES} aria-label="Authorization basis" />
            </Field>
            <Field label="Scope" hint="Where the voice may be used">
              <TextInput value={scope} onChange={setScope} aria-label="Authorization scope" />
            </Field>
          </div>
          <Field label="Evidence" hint="e.g. signed release on file, license number, recording session notes">
            <TextArea value={evidence} onChange={setEvidence} rows={2} placeholder="Signed voice release dated 2026-09-30, stored in the label's contracts folder" aria-label="Evidence" />
          </Field>
          <label className="row vx-attest" style={{ cursor: 'pointer', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} aria-label="I confirm I am authorized to use this voice" />
            <span className="small">
              I confirm that I am authorized to use this voice for singing synthesis and voice conversion within the scope above, and that this attestation is accurate.
              It is stored with the project as voice provenance.
            </span>
          </label>
        </div>
      </div>
    </Modal>
  );
}

function ConsentBadge({ v }: { v: VoiceChoice }) {
  if (v.kind === 'stock') return <Badge tone="success">Stock · no attestation needed</Badge>;
  if (v.authorized) {
    return (
      <Badge tone="success" title={consentSummary(v.consent)}>
        <Icon name="shield" size={11} /> Authorized
      </Badge>
    );
  }
  return (
    <Badge tone="danger" title="Cannot be used for singing or conversion until authorized">
      <Icon name="alert" size={11} /> Consent required
    </Badge>
  );
}

function VoiceRow({ v, track, songVoice, convVoice, onAttest, onRemove }: { v: VoiceChoice; track: Track; songVoice?: string; convVoice?: string; onAttest: (v: VoiceChoice) => void; onRemove?: (v: VoiceChoice) => void }) {
  const canSing = v.source === 'built-in' || (v.providerId !== 'external' && !!getRegistry().get(v.providerId)?.singing);
  const isSinging = songVoice === v.key;
  const isTarget = convVoice === v.key;
  return (
    <tr data-testid="voice-row" data-voice={v.name}>
      <td>
        <div style={{ fontWeight: 600 }}>{v.name}</div>
        <div className="small dim ellipsis" style={{ maxWidth: 320 }}>
          {v.description ?? (v.consent ? consentSummary(v.consent) : '')}
        </div>
      </td>
      <td className="small">{v.voiceType ?? '—'}</td>
      <td className="small">{providerName(v.providerId)}</td>
      <td>
        <ConsentBadge v={v} />
      </td>
      <td style={{ textAlign: 'right' }}>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
          {isSinging && <Badge tone="accent">singing</Badge>}
          {isTarget && <Badge tone="ai">conversion target</Badge>}
          {!v.authorized && (
            <Button size="sm" variant="primary" icon="shield" onClick={() => onAttest(v)}>
              Attest authorization
            </Button>
          )}
          {v.authorized && canSing && !isSinging && (
            <Button size="sm" onClick={() => (v.source === 'provider' ? adoptProviderVoice(v, track) : chooseSingingVoice(track, v.key, v.name))} title="Use this voice to sing the vocal">
              Sing with this
            </Button>
          )}
          {v.kind !== 'stock' && v.source === 'project' && !isTarget && (
            <Button size="sm" variant="ghost" onClick={() => chooseConversionVoice(v.key, v.name)} title="Use as the voice-conversion target">
              Conversion target
            </Button>
          )}
          {onRemove && v.source === 'project' && <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${v.name}`} onClick={() => onRemove(v)} />}
        </div>
      </td>
    </tr>
  );
}

export function VoicesPanel({ project, track }: { project: Project; track: Track }) {
  const song = project.song;
  const version = useAiRuntime((s) => s.version);
  const [modal, setModal] = useState<VoiceModalRequest | null>(null);
  const [providerVoices, setProviderVoices] = useState<Record<string, VoiceInfo[]>>({});
  useEffect(() => {
    let alive = true;
    const reg = getRegistry();
    const ids = [
      ...reg.findCompatible(['SINGING_SYNTHESIS'], { interface: 'singing' }),
      ...reg.findCompatible(['VOICE_CONVERSION'], { interface: 'voiceConversion' }),
    ]
      .filter((c) => c.location !== 'internal')
      .map((c) => c.providerId);
    void Promise.all(
      [...new Set(ids)].map(async (id) => {
        await discoverVoicesOnce(id);
        return [id, reg.voices(id)] as const;
      }),
    ).then((pairs) => alive && setProviderVoices(Object.fromEntries(pairs)));
    return () => {
      alive = false;
    };
  }, [version]);

  const fromProviders = Object.entries(providerVoices).flatMap(([id, list]) => providerVoiceChoices(project, id, list));
  const records = projectVoiceChoices(project);
  const all: VoiceChoice[] = [...builtInVoices(), ...fromProviders.filter((v) => !records.some((r) => r.key === v.key)), ...records];
  const groups: { kind: VoiceKind; title: string; hint: string }[] = [
    { kind: 'stock', title: 'Stock synthetic voices', hint: 'Synthetic voices that imitate no real person — usable without an attestation.' },
    { kind: 'user-trained', title: 'User-trained voices', hint: 'Models trained on recordings you supplied.' },
    { kind: 'imported', title: 'Imported voice models', hint: 'Model files brought in from elsewhere.' },
    { kind: 'third-party', title: 'Third-party voices', hint: 'Voices owned by someone else (artists, voice actors, vendors).' },
  ];

  const attest = (v: VoiceChoice) => {
    if (v.record) setModal({ mode: 'attest', initial: v.record });
    else setModal({ mode: 'add', initial: { name: v.name, kind: v.kind, providerId: v.providerId, modelRef: v.ref, voiceType: v.voiceType, description: v.description, id: v.key }, useFor: 'singing' });
  };

  const remove = (v: VoiceChoice) => {
    const st = useStudio.getState();
    st.updateProject((p) => ({ ...p, meta: { ...p.meta, voices: p.meta.voices.filter((x) => x.id !== v.key) } }));
    const cur = useStudio.getState().project?.song;
    if (cur && (cur.vocals.voiceId === v.key || cur.vocals.conversionVoiceId === v.key)) {
      st.commit(
        { ...cur, vocals: { ...cur.vocals, voiceId: cur.vocals.voiceId === v.key ? undefined : cur.vocals.voiceId, conversionVoiceId: cur.vocals.conversionVoiceId === v.key ? undefined : cur.vocals.conversionVoiceId } },
        `Removed voice “${v.name}”`,
        'vocals',
      );
    }
    st.toast('info', `Removed “${v.name}” from the project (renders made with it keep their provenance).`);
  };

  return (
    <div className="col" style={{ gap: 12 }} data-testid="voices-panel">
      <div className="callout small">
        <strong>Voice safety &amp; consent (spec §36).</strong> Stock synthetic voices can be used freely. User-trained, imported and third-party voices can only sing
        (cloning) or be a conversion target after you attest that you are authorized to use them — who attests, the rights holder, the basis, evidence and scope are
        stored with the project as voice provenance and listed in the rights metadata.
      </div>
      <div className="row">
        <Button variant="primary" icon="plus" onClick={() => setModal({ mode: 'add' })}>
          Add voice model
        </Button>
        <span className="small dim">
          {records.length} project voice model{records.length === 1 ? '' : 's'} · {records.filter((r) => r.authorized).length} authorized
        </span>
      </div>
      {groups.map((g) => {
        const list = all.filter((v) => v.kind === g.kind);
        return (
          <div className="panel" key={g.kind}>
            <div className="panel-header">
              <h3 className="grow">{g.title}</h3>
              <span className="small dim">{g.hint}</span>
            </div>
            <div className="panel-body" style={{ padding: list.length ? 0 : 12 }}>
              {list.length ? (
                <table className="table" aria-label={g.title}>
                  <thead>
                    <tr>
                      <th>Voice</th>
                      <th>Type</th>
                      <th>Provider</th>
                      <th>Authorization</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((v) => (
                      <VoiceRow key={v.key} v={v} track={track} songVoice={song.vocals.voiceId} convVoice={song.vocals.conversionVoiceId} onAttest={attest} onRemove={remove} />
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="small muted">None yet.</div>
              )}
            </div>
          </div>
        );
      })}
      {modal && <VoiceModelModal project={project} track={track} request={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
