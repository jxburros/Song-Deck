import {
  defaultChannelStrip,
  keyName,
  randomId,
  secondsToTick,
  type AudioClip,
  type Project,
  type Song,
  type StemGroup,
  type Track,
  type TrackRole,
} from '@songdeck/core';
import type { AudioData, RebuildReport } from '@songdeck/audio';
import { useStudio } from '../../state/store';
import { guessMime } from '../../state/assets';
import { runTask } from '../../engine/capture-tasks';
import type { EncodedStem, SeparateTaskInput, SeparateTaskOutput } from '../../engine/handlers/analysis';
import type { RunProvenance } from '@songdeck/ai';
import { DSP_PROVIDER, makeAnalysisRecord, makeAssetMeta, makeProvenance, pushAnalysis } from '../../engine/capture-song';
import { slugify } from '../../engine/capture-files';
import { colorForRole } from '../workbench/SidePanel';

export interface RebuildSource {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
  audio: AudioData;
  durationSeconds: number;
}

const STEM_INFO: Record<string, { label: string; role: TrackRole; instrumentId: string; stemGroup: StemGroup }> = {
  drums: { label: 'Drums', role: 'drums', instrumentId: 'drum-kit', stemGroup: 'drums' },
  bass: { label: 'Bass', role: 'bass', instrumentId: 'electric-bass', stemGroup: 'bass' },
  vocals: { label: 'Vocals', role: 'vocal', instrumentId: 'lead-vocal', stemGroup: 'vocals' },
  other: { label: 'Other', role: 'custom', instrumentId: 'piano', stemGroup: 'others' },
};

/**
 * "Open as project" for a rebuilt recording: new project with the reconstructed song, the source
 * audio as a `reference` asset, the rebuild report as an AnalysisRecord, provenance for the
 * reconstructed MIDI (spec §64) and — optionally — the separated stems as muted audio tracks at
 * bar 1 so the rebuilt MIDI can be A/B'd against them.
 */
export async function openRebuildAsProject(o: {
  title: string;
  song: Song;
  report: RebuildReport;
  source: RebuildSource;
  taskId?: string;
  keepStems: boolean;
  /** Stems an external separator already produced during the rebuild (no second separation pass). */
  providedStems?: EncodedStem[];
  separation?: { method: string; confidence?: number; provenance?: RunProvenance };
  /** Separation provider choice for the stems pass ('auto' | 'internal' | provider id). */
  separationProvider?: string;
  onStatus?: (msg: string) => void;
  onStemsTask?: (id: string) => void;
}): Promise<Project> {
  const st = useStudio.getState();
  const title = o.title.trim() || o.song.title || 'Rebuilt recording';
  const sourceAssetId = randomId('asset');
  const tracks: Track[] = [];
  const channels: Song['mixer']['channels'] = {};
  const stemAssets: { meta: ReturnType<typeof makeAssetMeta>; bytes: Uint8Array; name: string; confidence?: number }[] = [];
  let separation: SeparateTaskOutput | null = null;
  let stemsTaskId: string | undefined;

  if (o.keepStems) {
    if (o.providedStems?.length && o.providedStems.every((st) => st.wav)) {
      separation = { stems: o.providedStems, method: o.separation?.method ?? 'Provider separation', confidence: o.separation?.confidence, provenance: o.separation?.provenance };
      stemsTaskId = o.taskId;
    } else {
      o.onStatus?.('Separating stems…');
      const { id, done } = runTask<SeparateTaskInput, SeparateTaskOutput>({
        type: 'analysis.separate',
        title: `Separate stems of “${title}”`,
        input: { runId: randomId('run'), audio: o.source.audio, encode: true, provider: o.separationProvider },
        runner: 'local',
      });
      stemsTaskId = id;
      o.onStemsTask?.(id);
      separation = await done;
    }
    // Align the stems with the rebuilt grid: tick 0 ↔ report.offsetSeconds in the source audio.
    const offset = o.report.offsetSeconds ?? 0;
    const clipTick = offset < 0 ? Math.round(secondsToTick(o.song, -offset)) : 0;
    const clipOffset = Math.max(0, offset);
    for (const stem of separation.stems) {
      if (!stem.wav) continue;
      const info = STEM_INFO[stem.name] ?? { label: stem.name, role: 'custom' as TrackRole, instrumentId: 'piano', stemGroup: 'others' as StemGroup };
      const dur = (stem.audio.channels[0]?.length ?? 0) / stem.audio.sampleRate;
      const meta = makeAssetMeta({
        name: `${title} — ${stem.name}`,
        kind: 'stem',
        mimeType: 'audio/wav',
        bytes: stem.wav,
        sampleRate: stem.audio.sampleRate,
        channels: stem.audio.channels.length,
        durationSeconds: dur,
      });
      const clip: AudioClip = {
        id: randomId('clip'),
        assetId: meta.id,
        tick: clipTick,
        offsetSeconds: clipOffset,
        durationSeconds: Math.max(0, dur - clipOffset),
        gainDb: 0,
        fadeInSeconds: 0,
        fadeOutSeconds: 0.01,
        name: `${info.label} (separated)`,
      };
      const midiTwin = o.song.tracks.find((t) => t.kind === 'midi' && t.stemGroup === info.stemGroup);
      const track: Track = {
        id: randomId('trk'),
        name: `${info.label} stem`,
        kind: 'audio',
        role: info.role,
        instrumentId: info.instrumentId,
        constraints: {},
        notes: [],
        clips: [clip],
        color: colorForRole(info.role),
        stemGroup: info.stemGroup,
        sourceTrackId: midiTwin?.id,
      };
      tracks.push(track);
      // Muted by default: solo / unmute to A/B the stem against the rebuilt MIDI.
      channels[track.id] = defaultChannelStrip({ mute: true });
      stemAssets.push({ meta, bytes: stem.wav, name: stem.name, confidence: stem.confidence });
    }
  }

  o.onStatus?.('Creating the project…');
  const song: Song = {
    ...o.song,
    title,
    tracks: [...o.song.tracks, ...tracks],
    mixer: { ...o.song.mixer, channels: { ...o.song.mixer.channels, ...channels } },
    production: { ...o.song.production, referenceAudioAssetId: sourceAssetId },
  };
  const created = await st.newProject(title, song);
  st.commit(created.song, `Rebuilt from “${o.source.name}”`, 'import');

  // Source audio (reference) + provenance of the reconstructed MIDI.
  const mime = o.source.mimeType || guessMime(o.source.name, o.source.bytes);
  const sourceMeta = makeAssetMeta({
    id: sourceAssetId,
    name: o.source.name,
    kind: 'reference',
    mimeType: mime,
    bytes: o.source.bytes,
    sampleRate: o.source.audio.sampleRate,
    channels: o.source.audio.channels.length,
    durationSeconds: o.source.durationSeconds,
  });
  await st.addAsset(sourceMeta, o.source.bytes);
  st.addProvenance(
    makeProvenance({
      artifactId: created.song.id,
      artifactName: `${slugify(title)}-rebuild.mid`,
      artifactKind: 'midi',
      sources: [{ kind: 'audio', ref: sourceAssetId }],
      provider: DSP_PROVIDER,
      taskId: o.taskId,
      parameters: {
        separationProvider: o.separation?.provenance ? `${o.separation.provenance.providerName} (${o.separation.provenance.location})` : 'on-device DSP',
        bpm: o.report.bpm,
        key: keyName(o.report.key),
        meter: `${o.report.meter.numerator}/${o.report.meter.denominator}`,
        offsetSeconds: o.report.offsetSeconds,
        overallConfidence: o.report.overallConfidence,
        separationMethod: o.report.separationMethod,
        tracks: o.song.tracks.map((t) => ({ name: t.name, instrumentId: t.instrumentId, confidence: o.report.trackConfidence[t.id] })),
      },
    }),
  );
  pushAnalysis(
    makeAnalysisRecord({
      kind: 'rebuild',
      sourceAssetId,
      confidence: o.report.overallConfidence,
      summary: `Rebuilt ${o.song.tracks.length} tracks · ${Math.round(o.report.bpm)} BPM · ${keyName(o.report.key)} · ${o.report.meter.numerator}/${o.report.meter.denominator} · ${o.song.sections.length} sections · confidence ${Math.round(o.report.overallConfidence * 100)}%`,
      data: o.report,
    }),
  );

  // Stems.
  for (const s of stemAssets) {
    const prov = makeProvenance({
      artifactId: s.meta.id,
      artifactName: `${slugify(title)}-${s.name}.wav`,
      artifactKind: 'audio',
      sources: [{ kind: 'audio', ref: sourceAssetId }],
      provider: DSP_PROVIDER,
      run: separation?.provenance,
      taskId: stemsTaskId,
      parameters: { stem: s.name, method: separation?.method, confidence: s.confidence },
    });
    st.addProvenance(prov);
    await st.addAsset({ ...s.meta, provenanceId: prov.id }, s.bytes);
  }
  if (separation) {
    pushAnalysis(
      makeAnalysisRecord({
        kind: 'separation',
        sourceAssetId,
        confidence: separation.confidence,
        summary: `${separation.stems.length} stems (${separation.stems.map((s) => s.name).join(', ')}) · ${separation.method}`,
        data: { method: separation.method, stems: separation.stems.map((s) => ({ name: s.name, confidence: s.confidence })) },
      }),
    );
  }
  return useStudio.getState().project ?? created;
}
