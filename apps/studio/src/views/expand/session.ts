import { create } from 'zustand';
import type { PendingAttestation } from '../../engine/rights';
import {
  cloneSong,
  keyName,
  randomId,
  randomSeed,
  sectionLayout,
  type Song,
  type ExpansionRegion,
  type ExpansionSection,
  type ExpansionResult,
  type ExpansionRequest,
} from '@songdeck/core';

interface ExpandSession {
  source: Song | null;
  sourceName: string;
  sourceUpload: {
    bytes: Uint8Array;
    mimeType: string;
    sampleRate: number;
    channels: number;
    durationSeconds: number;
    attestation?: PendingAttestation;
  } | null;
  sourceNotice: string;
  regions: ExpansionRegion[];
  arrangement: ExpansionSection[];
  seed: number;
  variation: number;
  style: string;
  keyText: string;
  result: ExpansionResult | null;
  resultRequest: ExpansionRequest | null;
  set(patch: Partial<Omit<ExpandSession, 'set' | 'load'>>): void;
  load(song: Song, name: string, notice?: string): void;
}
export const useExpandSession = create<ExpandSession>((set) => ({
  source: null,
  sourceName: '',
  sourceUpload: null,
  sourceNotice: '',
  regions: [],
  arrangement: [],
  seed: randomSeed(),
  variation: 0.35,
  style: '',
  keyText: '',
  result: null,
  resultRequest: null,
  set: (patch) => set(patch),
  load: (song, name, notice = '') => {
    const regions = sectionLayout(song).map((s) => ({
      id: randomId('region'),
      startBar: s.startBar,
      endBar: s.endBar,
      kind: s.section.kind,
    }));
    set({
      source: cloneSong(song),
      sourceUpload: null,
      sourceName: name,
      sourceNotice: notice,
      regions,
      arrangement: [
        ...regions.map((r) => ({
          kind: r.kind,
          bars: r.endBar - r.startBar,
          sourceRegionId: r.id,
          preserve: true,
        })),
        { kind: 'verse', bars: 8, sourceRegionId: regions[0]?.id },
        { kind: 'chorus', bars: 8, sourceRegionId: regions[0]?.id },
      ],
      keyText: keyName(song.keyMap[0]?.key ?? { tonic: 0, mode: 'major' }),
      result: null,
      resultRequest: null,
    });
  },
}));
