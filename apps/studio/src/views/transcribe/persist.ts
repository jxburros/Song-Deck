import { keyName, type AudioAssetMeta } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { jobs } from '../../engine/jobs';
import { makeAnalysisRecord, makeAssetMeta, makeProvenance, pushAnalysis, type InsertRequest } from '../../engine/capture-song';
import { GRID_BEATS, lowConfidenceRegions, SOURCES, type Capture, type TranscribeOptions, type TranscriptionView } from './model';

/** Asset ids of captures already stored, per project (a capture is stored once per project). */
const stored = new Map<string, string>();

/**
 * Store the captured audio in the open project as a `recording` asset. Microphone takes
 * (MediaRecorder WebM/Opus) are re-encoded as WAV so the .songproject stays portable; uploads
 * keep their original bytes.
 */
export async function storeCaptureAsset(capture: Capture): Promise<AudioAssetMeta | null> {
  const st = useStudio.getState();
  const project = st.project;
  if (!project || !capture.audio) return null;
  const key = `${project.meta.id}:${capture.id}`;
  const existing = stored.get(key);
  if (existing) {
    const meta = project.meta.assets.find((a) => a.id === existing);
    if (meta) return meta;
  }
  let bytes = capture.bytes;
  let mimeType = capture.mimeType ?? 'audio/wav';
  if (!bytes || capture.origin === 'mic' || capture.origin === 'clap') {
    bytes = await jobs.call<Uint8Array>('encodeWav', { audio: capture.audio, bitDepth: 16 });
    mimeType = 'audio/wav';
  }
  const meta = makeAssetMeta({
    name: capture.name,
    kind: 'recording',
    mimeType,
    bytes,
    sampleRate: capture.audio.sampleRate,
    channels: capture.audio.channels.length,
    durationSeconds: capture.durationSeconds,
  });
  await st.addAsset(meta, bytes);
  stored.set(key, meta.id);
  return meta;
}

/** Provenance (spec §64) + an AnalysisRecord for a transcription that entered the project. */
export function recordTranscriptionInProject(o: {
  capture: Capture;
  view: TranscriptionView;
  options: TranscribeOptions;
  asset: AudioAssetMeta | null;
  trackId?: string;
  trackName?: string;
  taskId?: string;
  proposalId?: string;
  insert?: InsertRequest;
}) {
  const st = useStudio.getState();
  if (!st.project) return;
  const { capture, view, options, asset } = o;
  const sourceLabel = SOURCES.find((s) => s.value === options.source)?.label ?? options.source;
  const barTicks = (view.meter.numerator * 4 * view.ppq) / view.meter.denominator;
  const regions = lowConfidenceRegions(view.notes, barTicks);
  const parameters = {
    source: options.source,
    origin: capture.origin,
    bpm: Math.round(view.bpm * 100) / 100,
    bpmSource: view.bpmSource,
    key: view.key ? keyName(view.key) : null,
    keySource: view.keySource,
    quantizeBeats: GRID_BEATS[options.grid] || null,
    snapToKey: options.snapToKey,
    method: view.method,
    proposalId: o.proposalId,
    insert: o.insert ? { mode: o.insert.mode, targetBar: o.insert.targetBar, endBar: o.insert.endBar, transpose: o.insert.transpose } : undefined,
  };
  st.addProvenance(
    makeProvenance({
      artifactId: o.trackId ?? o.proposalId ?? capture.id,
      artifactName: `${(o.trackName ?? 'transcription').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.mid`,
      artifactKind: 'midi',
      sources: asset ? [{ kind: 'audio', ref: asset.id }] : [{ kind: capture.origin === 'taps' ? 'taps' : 'audio', ref: capture.name }],
      run: view.provenance,
      parameters,
      taskId: o.taskId,
    }),
  );
  pushAnalysis(
    makeAnalysisRecord({
      kind: 'transcription',
      sourceAssetId: asset?.id,
      confidence: view.confidence,
      summary: `${sourceLabel} → ${view.notes.length} ${view.drums ? 'hits' : 'notes'} · ${Math.round(view.bpm)} BPM${view.key ? ` · ${keyName(view.key)}` : ''} · confidence ${Math.round(view.confidence * 100)}%`,
      data: {
        ...parameters,
        bpmConfidence: view.bpmConfidence,
        keyConfidence: view.keyConfidence,
        notes: view.notes.length,
        bars: view.bars,
        lowConfidenceRegions: regions,
        warnings: view.warnings,
        taps: capture.taps,
      },
    }),
  );
}
