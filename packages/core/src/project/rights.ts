import type { AttestationBasis, AudioAttestation, Project, ProjectMeta, RightsMetadata } from '../ir/types';

/**
 * Upload attestations (docs/RIGHTS.md): every uploaded audio file carries the user's statement
 * of why they may use it, plus what the offline metadata check (and the optional online
 * identification) found. Attestations warn; they never block — a local, open-source app cannot
 * enforce them. They are stored in ProjectMeta.attestations, reflected in the rights metadata
 * (spec §65) and summarized in exports.
 */

export const ATTESTATION_BASIS_LABEL: Record<AttestationBasis, string> = {
  'own-work': 'I made this / I own the rights',
  licensed: 'I have a licence or written permission',
  'open-licence': 'Public domain or open licence',
  'personal-study': 'Personal study only, not for release',
};

/** Short label for summaries and the rights panel. */
export const ATTESTATION_BASIS_SHORT: Record<AttestationBasis, string> = {
  'own-work': 'own work',
  licensed: 'licensed / permission',
  'open-licence': 'public domain / open licence',
  'personal-study': 'personal study only',
};

/** Material that should not leave the device or be released without a second thought. */
export function attestationNeedsCare(a: Pick<AudioAttestation, 'basis' | 'flagged'>): boolean {
  return a.basis === 'personal-study' || a.flagged;
}

export function projectAttestations(project: Pick<Project, 'meta'> | null | undefined): AudioAttestation[] {
  return project?.meta.attestations ?? [];
}

/** Attestations of material that needs care (personal study, flagged or matched). */
export function attestationsNeedingCare(project: Pick<Project, 'meta'> | null | undefined, assetIds?: readonly string[]): AudioAttestation[] {
  return projectAttestations(project).filter((a) => attestationNeedsCare(a) && (!assetIds || (a.assetId !== undefined && assetIds.includes(a.assetId))));
}

/** One line for the rights metadata lists, e.g. "drums.wav — licensed / permission (Acme Samples; licence #42)". */
export function attestationRightsLine(a: AudioAttestation): string {
  const details = [a.rightsHolder?.trim(), a.licence?.trim()].filter(Boolean).join('; ');
  return `${a.fileName} — ${ATTESTATION_BASIS_SHORT[a.basis]}${details ? ` (${details})` : ''}`;
}

/** Which rights list an attestation belongs in. */
export function attestationRightsList(a: AudioAttestation): 'licensedAssets' | 'samples' | 'sourceReferences' {
  if (a.basis === 'licensed' || a.basis === 'open-licence') return 'licensedAssets';
  if (a.context === 'sample-instrument') return 'samples';
  return 'sourceReferences';
}

function withRightsLine(rights: RightsMetadata, a: AudioAttestation): RightsMetadata {
  const key = attestationRightsList(a);
  const line = attestationRightsLine(a);
  const cur = rights[key] ?? [];
  // Replace an earlier line for the same file (re-attestation) instead of piling up duplicates.
  const prefix = `${a.fileName} — `;
  const next = [...cur.filter((x) => !x.startsWith(prefix)), line];
  return { ...rights, [key]: next };
}

/** Store (or replace, by id) an attestation and reflect it in the rights metadata. */
export function addAttestation(project: Project, attestation: AudioAttestation, now?: string): Project {
  const list = projectAttestations(project).filter((a) => a.id !== attestation.id);
  const meta: ProjectMeta = {
    ...project.meta,
    updatedAt: now ?? new Date().toISOString(),
    attestations: [...list, attestation],
    rights: withRightsLine(project.meta.rights, attestation),
  };
  return { ...project, meta };
}

/** Plain-text attestation summary for exports (rights files, READMEs). Empty when there are none. */
export function attestationSummaryLines(attestations: readonly AudioAttestation[]): string[] {
  if (!attestations.length) return [];
  const out = ['Uploaded audio — rights attestations (self-declared by the user; not verified):'];
  for (const a of attestations) {
    const when = a.attestedAt.slice(0, 10);
    out.push(`- ${a.fileName} [${a.context}]: ${ATTESTATION_BASIS_LABEL[a.basis]} — attested by ${a.attestedBy || 'unknown'} on ${when}`);
    if (a.rightsHolder) out.push(`    rights holder: ${a.rightsHolder}`);
    if (a.licence) out.push(`    licence / permission: ${a.licence}`);
    if (a.notes) out.push(`    notes: ${a.notes}`);
    if (a.flagged) {
      const found = a.signals.map((s) => `${s.label} ${s.value}`).slice(0, 4);
      out.push(`    WARNING: checks suggested a commercial release${found.length ? ` (${found.join('; ')})` : ''}`);
    }
    if (a.basis === 'personal-study') out.push('    WARNING: personal study only — not cleared for release');
    out.push(`    sha256: ${a.contentHash}`);
  }
  return out;
}

/** Plain-text rights & attribution summary (spec §65) including upload attestations. */
export function rightsSummaryText(meta: Pick<ProjectMeta, 'name' | 'rights' | 'attestations'>): string {
  const r = meta.rights;
  const lines: string[] = [`Rights & attribution — ${meta.name}`, ''];
  const list = (label: string, values: string[] | undefined) => {
    if (values?.length) lines.push(`${label}: ${values.join(', ')}`);
  };
  list('Human composer(s)', r.humanComposers);
  list('Lyric writer(s)', r.lyricWriters);
  list('Performer(s)', r.performers);
  if (r.aiAssistance?.trim()) lines.push(`AI assistance: ${r.aiAssistance.trim()}`);
  list('Voice model(s)', r.voiceModels);
  list('Model provider(s)', r.modelProviders);
  list('Source references', r.sourceReferences);
  list('Samples', r.samples);
  list('Licensed assets', r.licensedAssets);
  if (r.copyrightNotice?.trim()) lines.push(`Copyright: ${r.copyrightNotice.trim()}`);
  if (r.notes?.trim()) lines.push(`Notes: ${r.notes.trim()}`);
  const att = attestationSummaryLines(meta.attestations ?? []);
  if (att.length) lines.push('', ...att);
  if (lines.length === 2) lines.push('No rights metadata recorded.');
  return `${lines.join('\n')}\n`;
}
