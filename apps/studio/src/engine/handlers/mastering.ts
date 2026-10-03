import {
  ENGINE_VERSION,
  assetPathFor,
  randomId,
  type AnalysisRecord,
  type AudioAssetMeta,
  type MasteringSettings,
  type Project,
  type ProvenanceRecord,
  type Song,
  type TaskHandler,
} from '@songdeck/core';
import type { AudioData, LoudnessReport } from '@songdeck/audio';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { jobs } from '../jobs';
import { cacheMaster, cacheMix } from '../mix-cache';
import { BUILTIN_MASTERING, loudnessSummary, targetInfo } from '../mix-mastering';
import {
  abortError,
  abortable,
  audioSeconds,
  collectAssets,
  isAbortError,
  masterAudioBuffer,
  measureAudioLoudness,
  mixHash,
  renderMixAudio,
  subProgress,
  throwIfAborted,
  type MasterReport,
} from '../mix-render';
import { resolveExternalMastering } from '../mix-providers';

/**
 * Mastering tasks (spec §42, §63, §64):
 *  - `mix.analyze`: render the unmastered mix and measure its loudness (BS.1770 / EBU R128).
 *  - `mix.master`:  render → master (built-in DSP or a mastering provider) → Master.wav asset,
 *                   provenance record, and a new revision pointing at the master.
 * Both read the *current* project song when they run, so they also work after a restart.
 */

export interface AnalyzeInput {
  projectId: string;
  sampleRate?: number;
}

export interface AnalyzeOutput {
  hash: string;
  report: LoudnessReport;
  durationSeconds: number;
  summary: string;
}

export interface MasterInput {
  projectId: string;
  settings: MasteringSettings;
  sampleRate?: number;
  bitDepth?: 16 | 24 | 32;
  /** Provider choice for non-builtin methods ('auto' or a provider id). */
  providerChoice?: string;
}

export interface MasterOutput {
  assetId: string;
  hash: string;
  before: LoudnessReport;
  after: LoudnessReport;
  report: MasterReport;
  providerName: string;
  /** Why the built-in engine was used instead of the requested method. */
  fallbackReason?: string;
  summary: string;
}

function openProject(projectId: string): { project: Project; song: Song } {
  const project = useStudio.getState().project;
  if (!project || project.meta.id !== projectId) throw new Error('The project for this task is not open. Open it and retry the task.');
  if (!project.song.tracks.length) throw new Error('The song has no tracks to render.');
  return { project, song: project.song };
}

function headRevisionNumber(project: Project): number | undefined {
  const branch = project.history.branches.find((b) => b.id === project.history.currentBranchId);
  return project.history.revisions.find((r) => r.id === branch?.headRevisionId)?.number;
}

function recordLoudness(projectId: string, hash: string, report: LoudnessReport, sampleRate: number, scope: 'mix' | 'master', sourceAssetId?: string): void {
  const st = useStudio.getState();
  if (st.project?.meta.id !== projectId) return;
  const rec: AnalysisRecord = {
    id: randomId('ana'),
    kind: 'loudness',
    createdAt: new Date().toISOString(),
    sourceAssetId,
    summary: `${scope === 'mix' ? 'Mix' : 'Master'}: ${loudnessSummary(report)}`,
    confidence: 1,
    data: { scope, hash, report, sampleRate },
  };
  st.updateProject((p) => {
    // Keep the 12 most recent loudness records; other analysis kinds are untouched.
    const loud = p.analysis.filter((a) => a.kind === 'loudness');
    const drop = new Set(loud.slice(0, Math.max(0, loud.length - 11)).map((a) => a.id));
    return { ...p, analysis: [...p.analysis.filter((a) => !drop.has(a.id)), rec] };
  });
}

const analyze: TaskHandler<AnalyzeInput, AnalyzeOutput> = async (ctx) => {
  const { input, signal } = ctx;
  const prog = (p: number, msg?: string) => ctx.progress(p, msg);
  const { song } = openProject(input.projectId);
  const sampleRate = input.sampleRate ?? useSettings.getState().exportPrefs.sampleRate;
  const hash = mixHash(song);
  ctx.log('info', `Rendering the unmastered mix at ${sampleRate} Hz (${song.tracks.length} tracks)`);
  ctx.progress(0.02, 'Collecting audio clips');
  const assets = await collectAssets(song);
  throwIfAborted(signal);
  const mix = await renderMixAudio(song, { sampleRate, assets, signal, onProgress: subProgress(prog, 0.05, 0.85, 'Rendering mix') });
  ctx.progress(0.86, 'Measuring loudness');
  const report = await measureAudioLoudness(mix, signal);
  throwIfAborted(signal);
  cacheMix({ projectId: input.projectId, hash, audio: mix, report });
  recordLoudness(input.projectId, hash, report, sampleRate, 'mix');
  const summary = loudnessSummary(report);
  ctx.log('info', `Mix loudness: ${summary}, short-term max ${report.shortTermMaxLufs.toFixed(1)} LUFS`);
  ctx.progress(1, 'Done');
  return { hash, report, durationSeconds: audioSeconds(mix), summary };
};

const master: TaskHandler<MasterInput, MasterOutput> = async (ctx) => {
  const { input, signal } = ctx;
  const prog = (p: number, msg?: string) => ctx.progress(p, msg);
  const { project, song } = openProject(input.projectId);
  const prefs = useSettings.getState().exportPrefs;
  const sampleRate = input.sampleRate ?? prefs.sampleRate;
  const bitDepth = input.bitDepth ?? prefs.bitDepth;
  const settings: MasteringSettings = { ...song.mastering, ...input.settings };
  if (settings.method === 'none') throw new Error('Mastering is set to “None” — export the unmastered mix from Export instead.');
  const target = targetInfo(settings.target);
  const hash = mixHash(song);

  ctx.progress(0.01, 'Collecting audio clips');
  const assets = await collectAssets(song);
  throwIfAborted(signal);
  ctx.log('info', `Rendering the mix at ${sampleRate} Hz for ${target.label} mastering (${target.lufs} LUFS, ${target.truePeakDb} dBTP)`);
  const mix = await renderMixAudio(song, { sampleRate, assets, signal, onProgress: subProgress(prog, 0.03, 0.4, 'Rendering mix') });
  ctx.progress(0.41, 'Measuring mix loudness');
  const before = await measureAudioLoudness(mix, signal);
  cacheMix({ projectId: input.projectId, hash, audio: mix, report: before });
  recordLoudness(input.projectId, hash, before, sampleRate, 'mix');
  ctx.log('info', `Unmastered mix: ${loudnessSummary(before)}`);

  let output: AudioData | null = null;
  let report: MasterReport = {};
  let providerId: string = BUILTIN_MASTERING.id;
  let providerName: string = BUILTIN_MASTERING.name;
  let modelId: string | undefined;
  let cloud = false;
  let costUsd: number | undefined;
  let fallbackReason: string | undefined;

  if (settings.method !== 'builtin') {
    ctx.progress(0.45, 'Contacting mastering provider');
    const ext = await resolveExternalMastering(settings.method, input.providerChoice ?? settings.providerId);
    if (!ext.provider) {
      fallbackReason = ext.reason;
      ctx.log('warn', `${ext.reason} Falling back to built-in DSP mastering.`);
    } else {
      try {
        ctx.log('info', `Mastering with ${ext.provider.name}${ext.provider.cloud ? ' (cloud — the mix leaves this device)' : ''}`);
        const wav = await abortable(jobs.call<Uint8Array>('encodeWav', { audio: mix, bitDepth: 24 }, { signal }), signal);
        const res = await ext.provider.master({ wav, sampleRate, durationSeconds: audioSeconds(mix), target: settings.target, signal });
        output = res.audio;
        report = res.report ?? {};
        providerId = res.provenance.providerId;
        providerName = res.provenance.providerName;
        modelId = res.model;
        cloud = res.provenance.cloud;
        costUsd = res.provenance.costUsd;
        if (costUsd) ctx.addCost(costUsd);
        if (output.sampleRate !== sampleRate) ctx.log('info', `Provider returned ${output.sampleRate} Hz audio.`);
      } catch (err) {
        if (signal.aborted) throw abortError();
        if (isAbortError(err)) throw abortError('Cancelled — the mix was not sent for cloud mastering');
        fallbackReason = `${ext.provider.name} failed: ${err instanceof Error ? err.message : String(err)}.`;
        ctx.log('warn', `${fallbackReason} Falling back to built-in DSP mastering.`);
      }
    }
  }

  if (!output) {
    ctx.log('info', `Built-in DSP mastering → ${target.label}`);
    const res = await masterAudioBuffer(mix, { ...settings, method: 'builtin' }, { signal, onProgress: subProgress(prog, 0.46, 0.8, 'Mastering') });
    output = res.output;
    report = res.report ?? {};
  }
  throwIfAborted(signal);

  ctx.progress(0.82, 'Measuring master loudness');
  const after = await measureAudioLoudness(output, signal);
  ctx.log('info', `Master: ${loudnessSummary(after)}`);
  ctx.progress(0.86, 'Encoding Master.wav');
  const bytes = await abortable(jobs.call<Uint8Array>('encodeWav', { audio: output, bitDepth }, { signal }), signal);
  throwIfAborted(signal);

  // Persist: asset → provenance → revision (each step reads the latest project state).
  ctx.progress(0.94, 'Saving master');
  const st = useStudio.getState();
  if (st.project?.meta.id !== project.meta.id) throw new Error('The project was closed while mastering.');
  const now = new Date().toISOString();
  const assetId = randomId('asset');
  const provenanceId = randomId('prov');
  const meta: AudioAssetMeta = {
    id: assetId,
    name: 'Master.wav',
    kind: 'master',
    path: assetPathFor('master', 'Master.wav'),
    mimeType: 'audio/wav',
    sampleRate: output.sampleRate,
    channels: output.channels.length,
    durationSeconds: audioSeconds(output),
    bytes: bytes.length,
    createdAt: now,
    provenanceId,
  };
  await st.addAsset(meta, bytes);
  const provenance: ProvenanceRecord = {
    id: provenanceId,
    artifactId: assetId,
    artifactName: 'Master.wav',
    artifactKind: 'master',
    sources: [
      { kind: 'song', ref: song.id, revision: headRevisionNumber(project) },
      { kind: 'mix', ref: `mix:${hash}` },
    ],
    providerId,
    providerName,
    modelId,
    parameters: {
      method: settings.method,
      requestedMethod: input.settings.method,
      target: settings.target,
      targetLufs: target.lufs,
      truePeakCeilingDb: target.truePeakDb,
      tone: settings.tone,
      width: settings.width,
      sampleRate: output.sampleRate,
      bitDepth,
      mixHash: hash,
      loudnessBefore: before,
      loudnessAfter: after,
      report,
      fallbackReason,
    },
    engineVersion: ENGINE_VERSION,
    generatedAt: now,
    cloud,
    ...(costUsd ? { costUsd } : {}),
  };
  useStudio.getState().addProvenance(provenance);
  cacheMaster({ projectId: project.meta.id, assetId, hash, audio: output, report: after });
  recordLoudness(project.meta.id, hash, after, output.sampleRate, 'master', assetId);

  const cur = useStudio.getState().project?.song;
  if (cur) {
    useStudio
      .getState()
      .commit(
        { ...cur, mastering: { ...cur.mastering, lastMasterAssetId: assetId } },
        `Mastered for ${target.label}: ${after.integratedLufs.toFixed(1)} LUFS, ${after.truePeakDb.toFixed(1)} dBTP`,
        'production',
      );
  }
  const summary = `${target.label}: ${loudnessSummary(after)}`;
  ctx.progress(1, 'Done');
  return { assetId, hash, before, after, report, providerName, fallbackReason, summary };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, TaskHandler<any, any>> = {
  'mix.analyze': analyze,
  'mix.master': master,
};
