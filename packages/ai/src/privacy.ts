/**
 * Privacy controls & data-flow indicator (spec §50):
 *
 *   Sending to: Gemini
 *   ✓ Song description  ✓ Chord progression  ✓ MIDI  ✗ Recorded vocals  ✗ Reference audio
 */
import type { DataKind, ProviderLocation, TaskRole } from './types';
import { DATA_KINDS } from './types';

export const DATA_KIND_INFO: Record<DataKind, { label: string; description: string; audio: boolean }> = {
  'song-description': {
    label: 'Song description',
    description: 'Title, style, moods, structure and instructions.',
    audio: false,
  },
  'chord-progression': { label: 'Chord progression', description: 'Chords and harmonic plan.', audio: false },
  midi: { label: 'MIDI', description: 'Notes of the selected tracks/regions.', audio: false },
  lyrics: { label: 'Lyrics', description: 'Lyric lines.', audio: false },
  'recorded-vocals': { label: 'Recorded vocals', description: 'Your recorded voice.', audio: true },
  'reference-audio': {
    label: 'Reference audio',
    description: 'Imported reference tracks or recordings.',
    audio: true,
  },
  'guide-audio': { label: 'Guide audio', description: 'Guide renders of your composition.', audio: true },
  stems: { label: 'Stems', description: 'Rendered or produced stems / mixes.', audio: true },
  'project-metadata': {
    label: 'Project metadata',
    description: 'Mixer settings, track names, project settings.',
    audio: false,
  },
  analysis: { label: 'Analysis results', description: 'Transcription and analysis data.', audio: false },
};

export type PrivacyConfirmMode = 'always' | 'cloud' | 'audio' | 'never';

export interface DataFlowItem {
  kind: DataKind;
  label: string;
  included: boolean;
}

export interface DataFlowDescriptor {
  title: string;
  providerId?: string;
  providerName: string;
  modelId?: string;
  location: ProviderLocation;
  /** True when the data leaves this device (cloud providers). */
  leavesDevice: boolean;
  items: DataFlowItem[];
}

export interface DataFlowRequest {
  dataKinds: readonly DataKind[];
  role?: TaskRole;
  title?: string;
  /** Kinds to list even when not included (default: all kinds). */
  show?: readonly DataKind[];
}

export interface DataFlowTarget {
  providerId?: string;
  providerName: string;
  modelId?: string;
  location: ProviderLocation;
}

const TITLES: Partial<Record<TaskRole, string>> = {
  production: 'Generation Request',
  vocals: 'Singing Request',
  transcription: 'Transcription Request',
  separation: 'Separation Request',
  mastering: 'Mastering Request',
  'voice-conversion': 'Voice Conversion Request',
};

/** Data-flow indicator for a request routed to a provider (spec §50). */
export function describeDataFlow(request: DataFlowRequest, target: DataFlowTarget): DataFlowDescriptor {
  const included = new Set(request.dataKinds);
  const show = request.show ?? DATA_KINDS;
  const ordered = [...show.filter((k) => included.has(k)), ...show.filter((k) => !included.has(k))];
  for (const k of included) if (!ordered.includes(k)) ordered.unshift(k);
  const flow: DataFlowDescriptor = {
    title: request.title ?? (request.role ? (TITLES[request.role] ?? 'AI Request') : 'AI Request'),
    providerName: target.providerName,
    location: target.location,
    leavesDevice: target.location === 'cloud',
    items: ordered.map((kind) => ({ kind, label: DATA_KIND_INFO[kind].label, included: included.has(kind) })),
  };
  if (target.providerId) flow.providerId = target.providerId;
  if (target.modelId) flow.modelId = target.modelId;
  return flow;
}

/** Text rendering with ✓/✗ marks (spec §50 example). */
export function formatDataFlow(flow: DataFlowDescriptor): string {
  const where =
    flow.location === 'cloud'
      ? 'cloud — data leaves this device'
      : flow.location === 'local'
        ? 'local — stays on this machine'
        : 'built-in engine — stays on this device';
  return [
    flow.title,
    '',
    `Sending to: ${flow.providerName}${flow.modelId ? ` (${flow.modelId})` : ''} [${where}]`,
    '',
    'Data:',
    ...flow.items.map((i) => `${i.included ? '✓' : '✗'} ${i.label}`),
  ].join('\n');
}

/** Whether the user must confirm this data flow under the privacy setting. */
export function needsPrivacyConfirmation(
  mode: PrivacyConfirmMode,
  flow: DataFlowDescriptor,
  trustedProviderIds: readonly string[] = [],
): boolean {
  if (mode !== 'always' && flow.providerId && trustedProviderIds.includes(flow.providerId)) return false;
  switch (mode) {
    case 'always':
      return true;
    case 'cloud':
      return flow.leavesDevice;
    case 'audio':
      return flow.leavesDevice && flow.items.some((i) => i.included && DATA_KIND_INFO[i.kind].audio);
    case 'never':
    default:
      return false;
  }
}

/** Data kinds that may not leave the device under "never upload" settings. */
export function blockedDataKinds(
  dataKinds: readonly DataKind[],
  neverUpload: readonly DataKind[],
): DataKind[] {
  const blocked = new Set(neverUpload);
  return dataKinds.filter((k) => blocked.has(k));
}
