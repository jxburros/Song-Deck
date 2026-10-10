import { colorForRole, randomId, type StemGroup, type TrackRole } from '@songdeck/core';
import type { AudioData } from '@songdeck/audio';
import { stemNameFrom, type RunProvenance } from '@songdeck/ai';
import { runTask } from './capture-tasks';
import type { SeparateTaskInput, SeparateTaskOutput } from './handlers/analysis';

/**
 * "Separate into stems" for an uploaded song with several parts: the recording is split into
 * drums / bass / vocals / other (a connected separation provider when one is set up, otherwise
 * the built-in on-device DSP separator — nothing is uploaded by default), so each part becomes
 * its own audio track and can get its own MIDI.
 */

export interface StemInfo {
  label: string;
  role: TrackRole;
  instrumentId: string;
  stemGroup: StemGroup;
}

export const STEM_INFO: Record<string, StemInfo> = {
  drums: { label: 'Drums', role: 'drums', instrumentId: 'drum-kit', stemGroup: 'drums' },
  bass: { label: 'Bass', role: 'bass', instrumentId: 'electric-bass', stemGroup: 'bass' },
  vocals: { label: 'Vocals', role: 'vocal', instrumentId: 'lead-vocal', stemGroup: 'vocals' },
  other: { label: 'Other', role: 'custom', instrumentId: 'piano', stemGroup: 'others' },
};

export function stemInfo(name: string): StemInfo {
  const key = stemNameFrom(name);
  if (STEM_INFO[key]) return STEM_INFO[key];
  const part = (role: TrackRole, instrumentId: string, stemGroup: StemGroup): StemInfo => ({
    label: name,
    role,
    instrumentId,
    stemGroup,
  });
  // Complements are mixtures, not the instrument named after 'no_'.
  if (/^(no|without|minus)-|instrumental/.test(key)) return part('custom', 'piano', 'others');
  if (/vocals/.test(key)) return part('vocal', 'lead-vocal', 'vocals');
  if (/guitar/.test(key))
    return part(
      'rhythm-guitar',
      key === 'acoustic-guitar' ? 'acoustic-guitar' : 'electric-guitar-clean',
      'guitars',
    );
  if (/piano|keys|organ/.test(key)) return part('keys', /organ/.test(key) ? 'organ' : 'piano', 'keys');
  if (/string|violin|cello/.test(key)) return part('strings', 'string-ensemble', 'strings');
  if (/wind|flute|brass|sax/.test(key))
    return part('custom', /brass/.test(name.toLowerCase()) ? 'brass-section' : 'flute', 'others');
  if (/synth/.test(key)) return part('synth-pad', 'synth-pad', 'keys');
  return part('custom', 'piano', 'others');
}

export interface SplitStem extends StemInfo {
  name: string;
  audio: AudioData;
  wav: Uint8Array;
  confidence?: number;
  color: string;
}

export interface SplitResult {
  stems: SplitStem[];
  method: string;
  confidence?: number;
  provenance?: RunProvenance;
  /** Stems left out because they were (nearly) silent. */
  skipped: string[];
}

function rms(audio: AudioData): number {
  let sum = 0;
  let n = 0;
  for (const c of audio.channels) {
    for (let i = 0; i < c.length; i++) sum += c[i] * c[i];
    n += c.length;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Below this level relative to the full mix (−40 dB) a stem is treated as "not in the song". */
const SILENT_RATIO = 0.01;

/** Separate a recording into instrument stems (WAV-encoded, near-silent stems dropped). */
export async function splitIntoStems(
  audio: AudioData,
  title: string,
  o: { provider?: string; onTask?: (id: string) => void } = {},
): Promise<SplitResult> {
  const { id, done } = runTask<SeparateTaskInput, SeparateTaskOutput>({
    type: 'analysis.separate',
    title: `Separate stems of “${title}”`,
    input: { runId: randomId('run'), audio, encode: true, provider: o.provider ?? 'auto' },
    runner: 'local',
  });
  o.onTask?.(id);
  const res = await done;
  const floor = rms(audio) * SILENT_RATIO;
  const stems: SplitStem[] = [];
  const skipped: string[] = [];
  for (const s of res.stems) {
    if (!s.wav || rms(s.audio) <= floor) {
      skipped.push(s.name);
      continue;
    }
    const info = stemInfo(s.name);
    stems.push({
      ...info,
      name: s.name,
      audio: s.audio,
      wav: s.wav,
      confidence: s.confidence,
      color: colorForRole(info.role),
    });
  }
  if (!stems.length) throw new Error(`No separable parts found in “${title}”.`);
  return { stems, method: res.method, confidence: res.confidence, provenance: res.provenance, skipped };
}
