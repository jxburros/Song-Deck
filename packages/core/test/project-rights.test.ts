import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import {
  addAttestation,
  attestationNeedsCare,
  attestationRightsLine,
  attestationSummaryLines,
  attestationsNeedingCare,
  packProject,
  rightsSummaryText,
  unpackProject,
} from '../src/project';
import { createEmptySong, createProject } from '../src/ir/defaults';
import type { AudioAttestation } from '../src/ir/types';

function att(over: Partial<AudioAttestation> = {}): AudioAttestation {
  return {
    id: 'att_1',
    contentHash: 'a'.repeat(64),
    fileName: 'song.wav',
    context: 'rebuild',
    basis: 'own-work',
    attestedBy: 'Jo',
    attestedAt: '2026-10-01T10:00:00.000Z',
    signals: [],
    flagged: false,
    checks: { metadata: true, online: 'off' },
    ...over,
  };
}

describe('upload attestations', () => {
  it('stores attestations and reflects them in the rights lists', () => {
    let p = createProject('Rights', createEmptySong());
    p = addAttestation(p, att({ assetId: 'asset_1' }), '2026-10-01T10:00:00.000Z');
    p = addAttestation(
      p,
      att({
        id: 'att_2',
        fileName: 'loop.wav',
        basis: 'open-licence',
        licence: 'CC BY 4.0',
        rightsHolder: 'Free Loops',
      }),
    );
    p = addAttestation(
      p,
      att({ id: 'att_3', fileName: 'kit.wav', basis: 'own-work', context: 'sample-instrument' }),
    );
    expect(p.meta.attestations?.map((a) => a.id)).toEqual(['att_1', 'att_2', 'att_3']);
    expect(p.meta.rights.sourceReferences).toEqual(['song.wav — own work']);
    expect(p.meta.rights.licensedAssets).toEqual([
      'loop.wav — public domain / open licence (Free Loops; CC BY 4.0)',
    ]);
    expect(p.meta.rights.samples).toEqual(['kit.wav — own work']);
    // Re-attesting a file replaces its line instead of duplicating it.
    p = addAttestation(p, att({ id: 'att_4', basis: 'personal-study' }));
    expect(p.meta.rights.sourceReferences).toEqual(['song.wav — personal study only']);
  });

  it('identifies material that needs care', () => {
    expect(attestationNeedsCare({ basis: 'personal-study', flagged: false })).toBe(true);
    expect(attestationNeedsCare({ basis: 'own-work', flagged: true })).toBe(true);
    expect(attestationNeedsCare({ basis: 'licensed', flagged: false })).toBe(false);
    let p = createProject('Care', createEmptySong());
    p = addAttestation(p, att({ assetId: 'a1', basis: 'personal-study' }));
    p = addAttestation(p, att({ id: 'att_2', assetId: 'a2', flagged: true, fileName: 'x.mp3' }));
    p = addAttestation(p, att({ id: 'att_3', assetId: 'a3', fileName: 'y.wav' }));
    expect(attestationsNeedingCare(p).map((a) => a.assetId)).toEqual(['a1', 'a2']);
    expect(attestationsNeedingCare(p, ['a2', 'a3']).map((a) => a.assetId)).toEqual(['a2']);
    expect(attestationsNeedingCare(null)).toEqual([]);
  });

  it('summarizes attestations for exports and round-trips through .songproject', () => {
    let p = createProject('Export', createEmptySong());
    p = addAttestation(
      p,
      att({
        flagged: true,
        signals: [{ kind: 'isrc', label: 'ISRC', value: 'USRC17607839', source: 'ID3 TSRC' }],
        notes: 'reference only',
        rightsHolder: 'Some Label',
      }),
    );
    const lines = attestationSummaryLines(p.meta.attestations!);
    expect(lines.join('\n')).toContain(
      'song.wav [rebuild]: I made this / I own the rights — attested by Jo on 2026-10-01',
    );
    expect(lines.join('\n')).toContain('WARNING: checks suggested a commercial release (ISRC USRC17607839)');
    expect(rightsSummaryText(p.meta)).toContain('Source references: song.wav — own work (Some Label)');
    expect(attestationRightsLine(att({ basis: 'licensed', licence: 'Sync #42' }))).toBe(
      'song.wav — licensed / permission (Sync #42)',
    );

    const files = unzipSync(packProject(p));
    expect(strFromU8(files['rights/RIGHTS.txt'])).toContain('rights attestations');
    const back = unpackProject(packProject(p)).project;
    expect(back.meta.attestations).toEqual(p.meta.attestations);
    // No attestations → no rights file, and older projects load without the field.
    const plain = createProject('Plain', createEmptySong());
    expect(Object.keys(unzipSync(packProject(plain)))).not.toContain('rights/RIGHTS.txt');
    expect(unpackProject(packProject(plain)).project.meta.attestations).toBeUndefined();
  });
});
