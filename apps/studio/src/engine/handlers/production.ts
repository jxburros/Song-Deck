import {
  barToTick,
  bpmAtTick,
  defaultChannelStrip,
  hashSeed,
  keyAtTick,
  keyName,
  randomId,
  songDurationSeconds,
  songLengthBars,
  songLengthTicks,
  tickToSeconds,
  type ProductionCandidate,
  type ProductionStrategy,
  type ProvenanceSource,
  type Song,
  type TaskHandler,
  type Track,
  type TrackProductionMethod,
} from '@songdeck/core';
import { resolveSingingVoice, type AudioData } from '@songdeck/audio';
import {
  buildMusicGenerationRequest,
  buildProductionPrompt,
  buildSingingRequest,
  type AudioGenerationResult,
  type EncodedAudio,
  type MusicGenerationRequest,
  type OrchestratorResult,
  type RunProvenance,
} from '@songdeck/ai';
import { useSettings } from '../../state/settings';
import { decodeAudioBytes } from '../../state/assets';
import { aiAudio } from '../ai';
import { collectAssets, renderableSong } from '../mix-render';
import { accumulate, conformAudio, loudnessOf, masterSum, matchLoudness, printStem, renderProduction, spliceAudio } from '../produce-jobs';
import {
  GUIDE_RENDERERS,
  GUIDE_RENDERER_ID,
  candidateSourceSong,
  compositionHash,
  guideHash,
  hasSungVocals,
  isVocalTrack,
  methodFor,
  nextVersionLabel,
  opDataKinds,
  performSong,
  productionSourceSong,
  productionUnits,
  regionLabel,
  regionSpan,
  sectionsInRegion,
  slug,
  strategyInfo,
  type OpPlan,
  type ProductionUnit,
  type RegionSpan,
} from '../produce-model';
import { describeProvider, resolveProduction, runProduction, singingTurn, type ResolvedProvider } from '../produce-providers';
import {
  assetMeta,
  audioSeconds,
  commitProduction,
  loadAssetAudio,
  provenanceOfAsset,
  requireProject,
  revisionNumber,
  storeAudio,
  throwIfAborted,
  wavOf,
} from '../produce-assets';
import { sampleRenderOptions } from '../produce-samples';

/**
 * Production tasks (spec §29 "Perform and produce this composition", §38 strategies, §39
 * selective regeneration, §54 A/B generation, §60 cost, §63 queue, §64 provenance):
 *
 *  - `produce.candidate`  one candidate (A, B, C…) of the composition at a fixed source revision.
 *                         Strategy A: guide mix → provider → finished mix.
 *                         Strategy B/C: per-track reference → method (AI / built-in / sampled /
 *                         external / singing / recorded) → printed stem → stems summed through the
 *                         master bus. Resumable per stem (checkpoints hold asset ids).
 *  - `produce.region`     regenerate a bar range of a candidate: provider inpainting when supported,
 *                         otherwise re-produce just that region and splice it in with crossfades.
 *                         Everything outside the region is preserved; the result is a new
 *                         candidate version ("B2") with provenance.
 */

export interface CandidateInput {
  projectId: string;
  /** Candidates queued together share consent for the same data flow. */
  batchId: string;
  /** Head revision when the batch was queued: every candidate produces this exact composition. */
  sourceRevisionId?: string;
  label: string;
  seed: number;
  strategy: ProductionStrategy;
  providerChoice: string;
  modelId?: string;
  /** Singing engine choice for Hybrid "singing" tracks (role 'vocals'). */
  singingChoice?: string;
  voiceId?: string;
  prompt: string;
  negativePrompt: string;
  sectionPrompts: Record<string, string>;
  trackMethods: Record<string, TrackProductionMethod>;
  /** 0..1 how far the production may depart from the guide/reference. */
  strength: number;
  /** 0..1 seeded performance variation (timing, dynamics). */
  variation: number;
  /** Gain-match AI stems to their references (keeps the mix balance). */
  levelMatch: boolean;
  referenceAssetId?: string;
  allowReferenceUpload: boolean;
  sampleRate?: number;
  bitDepth?: 16 | 24 | 32;
  /** trackId → sample instrument id (Hybrid "sampled" tracks). */
  sampleAssignments?: Record<string, string>;
}

export interface CandidateOutput {
  candidateId: string;
  label: string;
  mixAssetId: string;
  stems: number;
  costUsd: number;
  summary: string;
}

interface StemRecord {
  assetId: string;
  method: TrackProductionMethod;
  providerId: string;
  providerName: string;
  modelId?: string;
  costUsd?: number;
  seed: number;
  cloud?: boolean;
}

interface CandidateCheckpoint {
  composition: string;
  stems: Record<string, StemRecord>;
}

const PRODUCER_ID = 'internal-producer';

function prefs() {
  return useSettings.getState().exportPrefs;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The composition with the batch's production instructions applied (prompts are part of the request). */
function withPrompts(song: Song, input: Pick<CandidateInput, 'prompt' | 'negativePrompt' | 'sectionPrompts' | 'trackMethods'>): Song {
  return {
    ...song,
    production: { ...song.production, prompt: input.prompt, negativePrompt: input.negativePrompt, sectionPrompts: input.sectionPrompts, trackMethods: input.trackMethods },
  };
}

/** Mute the given tracks (tracks switched "Off" stay out of guide / full-mix renders). */
function muteTracks(song: Song, ids: string[]): Song {
  const present = ids.filter((id) => song.tracks.some((t) => t.id === id));
  if (!present.length) return song;
  const channels = { ...song.mixer.channels };
  for (const id of present) channels[id] = { ...(channels[id] ?? defaultChannelStrip()), mute: true };
  return { ...song, mixer: { ...song.mixer, channels } };
}

function referenceUsable(provider: ResolvedProvider | undefined, allowUpload: boolean, neverUpload: string[]): boolean {
  if (!provider) return false;
  if (provider.location !== 'cloud') return true;
  return allowUpload && !neverUpload.includes('reference-audio');
}

/** Current guide mix when it was rendered from exactly this composition + mix (else undefined). */
async function currentGuideMix(projectId: string, song: Song): Promise<{ audio: AudioData; assetId: string } | undefined> {
  const project = requireProject(projectId);
  const id = project.song.production.guideMixAssetId;
  const prov = provenanceOfAsset(project, id);
  if (!id || !prov || (prov.parameters as { guideHash?: string } | undefined)?.guideHash !== guideHash(song)) return undefined;
  try {
    return { audio: await loadAssetAudio(projectId, id), assetId: id };
  } catch {
    return undefined;
  }
}

/** External render of a stem group (guide imported from a DAW), if the current guide is one. */
function externalGuideStem(projectId: string, group: string): string | undefined {
  const project = requireProject(projectId);
  const id = project.song.production.guideStemAssetIds?.[group];
  const prov = provenanceOfAsset(project, id);
  return prov && (prov.parameters as { renderer?: string } | undefined)?.renderer === 'external' ? id : undefined;
}

interface ProducedStem {
  audio: AudioData;
  record: Omit<StemRecord, 'assetId'>;
  run?: RunProvenance;
  /** Extra provenance sources (guide assets, takes, external files). */
  sources: ProvenanceSource[];
  parameters: Record<string, unknown>;
}

interface StemContext {
  projectId: string;
  input: CandidateInput;
  source: Song;
  performed: Song;
  promptSong: Song;
  clipAssets: Record<string, AudioData>;
  sampleRate: number;
  plan?: OpPlan;
  reference?: EncodedAudio;
  externalUsed: Set<string>;
  signal: AbortSignal;
  log: (level: 'info' | 'warn', msg: string) => void;
  onProgress: (p: number) => void;
}

async function renderReference(c: StemContext, track: Track, seed: number, opts: { performed?: boolean; startTick?: number; endTick?: number; applyMaster?: boolean; samples?: boolean } = {}): Promise<AudioData> {
  const sample = opts.samples ? sampleRenderOptions(c.input.sampleAssignments ?? {}, [track.id]) : undefined;
  if (opts.samples && sample && !sample.used.length) c.log('warn', `${track.name}: no sample instrument assigned — using the built-in instrument`);
  return renderProduction(
    {
      song: opts.performed === false ? c.source : c.performed,
      assets: c.clipAssets,
      sampleRate: c.sampleRate,
      trackIds: [track.id],
      applyMaster: opts.applyMaster ?? false,
      ignoreMuteSolo: true,
      startTick: opts.startTick,
      endTick: opts.endTick,
      tailSeconds: opts.startTick !== undefined ? 0 : 2,
      seed,
      patchOverrides: sample?.patchOverrides,
      sampleInstruments: sample?.sampleInstruments,
    },
    { signal: c.signal, onProgress: c.onProgress },
  );
}

/** Call the production provider for one generation following the plan's operation. */
async function providerGenerate(
  c: StemContext,
  plan: OpPlan,
  args: { reference?: AudioData; durationSeconds: number; seed: number; trackId?: string; sectionId?: string; extraPrompt?: string; scope: 'mix' | 'stem' | 'region'; title: string; song?: Song; atTick?: number },
): Promise<OrchestratorResult<AudioGenerationResult>> {
  const pp = buildProductionPrompt(c.promptSong, { trackId: args.trackId, sectionId: args.sectionId, extra: args.extraPrompt });
  const atTick = args.atTick ?? 0;
  const bpm = bpmAtTick(c.source, atTick);
  const key = keyName(keyAtTick(c.source, atTick));
  const refWav = args.reference ? await wavOf(args.reference, 16, c.signal) : undefined;
  return runProduction<AudioGenerationResult>({
    choice: c.input.providerChoice,
    modelId: c.input.modelId,
    caps: plan.caps,
    dataKinds: opDataKinds(plan, args.scope),
    durationSeconds: args.durationSeconds,
    title: args.title,
    signal: c.signal,
    consentKey: c.input.batchId,
    execute: async (inst, model, signal) => {
      const gen = inst.audioGeneration;
      if (!gen) throw new Error(`${inst.descriptor.name} cannot produce audio`);
      if (plan.op === 'transform') {
        if (!refWav) throw new Error('No reference audio to transform');
        return gen.transformAudio({ audio: refWav, prompt: pp.prompt, negativePrompt: pp.negativePrompt || undefined, strength: c.input.strength, seed: args.seed, durationSeconds: args.durationSeconds, bpm, key, model, signal });
      }
      const req: MusicGenerationRequest = buildMusicGenerationRequest(args.song ?? c.promptSong, {
        trackId: args.trackId,
        sectionIds: args.sectionId ? [args.sectionId] : undefined,
        seed: args.seed,
        model,
        guideAudio: plan.op === 'generate-guided' ? refWav : undefined,
        referenceAudio: plan.reference ? c.reference : undefined,
        strength: plan.op === 'generate-guided' ? c.input.strength : undefined,
        extraPrompt: args.extraPrompt,
      });
      req.durationSeconds = args.durationSeconds;
      if (plan.op === 'render-song') req.song = args.song ?? c.performed;
      if (!plan.sing && plan.op !== 'render-song') {
        req.instrumental = true;
        delete req.lyrics;
        if (!/(^|,\s*)vocals(\s*,|$)/i.test(req.negativePrompt ?? '') && !args.trackId) req.negativePrompt = [req.negativePrompt, 'vocals'].filter(Boolean).join(', ');
      }
      return gen.generateMusic({ ...req, signal });
    },
  });
}

/** Produce one track according to its method; returns a printed stem aligned at the song start. */
async function produceUnit(c: StemContext, unit: ProductionUnit, seed: number): Promise<ProducedStem | null> {
  const { track } = unit;
  let method = unit.method;
  const local = (providerName: string, providerId = GUIDE_RENDERER_ID): Omit<StemRecord, 'assetId'> => ({ method, providerId, providerName, seed, costUsd: 0 });
  const params: Record<string, unknown> = { method, trackId: track.id, trackName: track.name, stemGroup: track.stemGroup };

  if (method === 'external') {
    const group = track.stemGroup || 'others';
    const id = externalGuideStem(c.projectId, group);
    if (id && c.externalUsed.has(group)) {
      c.log('info', `${track.name}: covered by the external ${group} stem`);
      return null;
    }
    if (id) {
      c.externalUsed.add(group);
      const audio = await loadAssetAudio(c.projectId, id);
      return { audio, record: local(GUIDE_RENDERERS.external.providerName, 'external-daw'), sources: [{ kind: 'audio', ref: id }], parameters: { ...params, coversStemGroup: group } };
    }
    c.log('warn', `${track.name}: no external render for “${group}” — import it in Guide render; using the built-in instrument`);
    method = 'guide';
  }

  if (method === 'recorded') {
    if (track.kind === 'audio') {
      const audio = await renderReference(c, track, seed, { performed: false });
      return { audio, record: local('Recorded audio'), sources: track.clips.map((cl) => ({ kind: 'audio', ref: cl.assetId })), parameters: params };
    }
    const take = c.source.vocals.takes.find((t) => t.trackId === track.id && t.active);
    if (take) {
      const dry = await loadAssetAudio(c.projectId, take.assetId);
      const audio = await printStem({ song: c.source, trackId: track.id, audio: dry, sampleRate: c.sampleRate }, { signal: c.signal, onProgress: c.onProgress });
      return { audio, record: local('Recorded vocal take'), sources: [{ kind: 'audio', ref: take.assetId }], parameters: { ...params, takeId: take.id } };
    }
    c.log('warn', `${track.name}: no active recorded take — using the guide render`);
    method = 'guide';
  }

  if (method === 'singing') {
    const voiceId = c.input.voiceId ?? track.vocal?.voiceId ?? c.source.vocals.voiceId ?? resolveSingingVoice(track).id;
    try {
      const req = buildSingingRequest(c.performed, track.id, { voiceId, seed, sampleRate: c.sampleRate });
      const r = await singingTurn(c.input.singingChoice ?? 'internal', () => aiAudio.synthesizeSinging(req, { providerChoice: c.input.singingChoice ?? 'internal', signal: c.signal }));
      const dry = await decodeAudioBytes(r.result.audio.data);
      const audio = await printStem({ song: c.source, trackId: track.id, audio: dry, sampleRate: c.sampleRate }, { signal: c.signal, onProgress: c.onProgress });
      return {
        audio,
        record: { method, providerId: r.provenance.providerId, providerName: r.provenance.providerName, modelId: r.provenance.modelId, seed, costUsd: r.provenance.costUsd ?? 0, cloud: r.provenance.cloud },
        run: r.provenance,
        sources: [{ kind: 'lyrics', ref: `${track.name} lyrics` }],
        parameters: { ...params, voiceId },
      };
    } catch (err) {
      if (c.signal.aborted) throw err;
      c.log('warn', `${track.name}: singing synthesis failed (${errorText(err)}) — using the guide vocal`);
      method = 'guide';
    }
  }

  if (method === 'guide' || method === 'sampled') {
    const audio = await renderReference(c, track, seed, { samples: method === 'sampled' });
    const names = method === 'sampled' ? sampleRenderOptions(c.input.sampleAssignments ?? {}, [track.id]).used.map((u) => u.name) : [];
    return {
      audio,
      record: local(method === 'sampled' && names.length ? `Sample instrument: ${names.join(', ')}` : GUIDE_RENDERERS.builtin.providerName),
      sources: [],
      parameters: { ...params, method, sampleInstruments: names },
    };
  }

  // method === 'ai'
  if (!c.plan) throw new Error('No production provider can produce stems');
  const reference = await renderReference(c, track, seed);
  throwIfAborted(c.signal);
  const res = await providerGenerate(c, c.plan, { reference, durationSeconds: audioSeconds(reference), seed, trackId: track.id, scope: 'stem', title: `Produce ${track.name} (${c.input.label})` });
  let audio = await decodeAudioBytes(res.result.audio.data);
  let gainDb = 0;
  if (c.input.levelMatch) {
    const m = await matchLoudness(audio, reference, { signal: c.signal });
    audio = m.audio;
    gainDb = m.gainDb;
  }
  return {
    audio,
    record: { method, providerId: res.provenance.providerId, providerName: res.provenance.providerName, modelId: res.provenance.modelId, seed, costUsd: res.provenance.costUsd ?? 0, cloud: res.provenance.cloud },
    run: res.provenance,
    sources: [],
    parameters: { ...params, op: c.plan.op, strength: c.input.strength, levelMatchDb: Math.round(gainDb * 100) / 100 },
  };
}

const produceCandidate: TaskHandler<CandidateInput, CandidateOutput> = async (ctx) => {
  const { input, signal } = ctx;
  const project = requireProject(input.projectId);
  const snapshot = project.history.revisions.find((r) => r.id === input.sourceRevisionId)?.snapshot ?? project.song;
  const promptSong = productionSourceSong(withPrompts(snapshot, input));
  const offTracks = Object.entries(input.trackMethods).filter(([, m]) => m === 'off').map(([id]) => id);
  const source = renderableSong(muteTracks(promptSong, offTracks));
  const composition = compositionHash(snapshot);
  const sampleRate = input.sampleRate ?? prefs().sampleRate;
  const bitDepth = input.bitDepth ?? prefs().bitDepth;
  const revision = revisionNumber(project, input.sourceRevisionId);
  const info = strategyInfo(input.strategy);
  const units = productionUnits(source, input.strategy, input.trackMethods);
  if (!units.length) throw new Error('Nothing to produce — every track is muted, empty or switched off.');
  const aiUnits = input.strategy === 'full' ? 0 : units.filter((u) => u.method === 'ai').length;
  const vocals = hasSungVocals(source);
  const neverUpload = project.meta.settings.neverUpload ?? [];
  const hasReference = !!input.referenceAssetId && !!assetMeta(project, input.referenceAssetId);
  const base = { vocals, aiUnits, aiVocalUnits: units.filter((u) => u.method === 'ai' && isVocalTrack(u.track)).length };
  let resolution = resolveProduction(input.providerChoice, input.modelId, input.strategy, { ...base, reference: hasReference });
  if (hasReference && !referenceUsable(resolution.provider, input.allowReferenceUpload, neverUpload)) {
    ctx.log('info', 'Reference audio stays on this device (sending it to cloud providers is not allowed)');
    resolution = resolveProduction(input.providerChoice, input.modelId, input.strategy, { ...base, reference: false });
  }
  const needsProvider = input.strategy === 'full' || aiUnits > 0;
  if (needsProvider && !resolution.plan.ok) throw new Error(resolution.error ?? resolution.plan.warnings.find((w) => w.level === 'danger')?.text ?? 'The selected provider cannot produce this strategy');
  if (needsProvider && resolution.error && input.providerChoice !== 'auto') throw new Error(resolution.error);
  for (const w of resolution.plan.warnings) ctx.log(w.level === 'info' ? 'info' : 'warn', w.text);
  const plan = resolution.plan.plan;
  const reference = plan?.reference && input.referenceAssetId ? await wavOf(await loadAssetAudio(input.projectId, input.referenceAssetId), 16, signal) : undefined;

  ctx.log('info', `${info.letter} — ${info.title} · ${units.length} track(s) · seed ${input.seed} · source revision ${revision ? `v${revision}` : 'working copy'}`);
  ctx.progress(0.01, 'Preparing the performance');
  const performed = performSong(source, input.seed, input.variation);
  const clipAssets = await collectAssets(source);
  throwIfAborted(signal);
  const guide = await currentGuideMix(input.projectId, snapshot);
  const songSources: ProvenanceSource[] = [{ kind: 'song', ref: snapshot.id, revision }];
  if (guide) songSources.push({ kind: 'audio', ref: guide.assetId });
  if (reference && input.referenceAssetId) songSources.push({ kind: 'reference', ref: input.referenceAssetId });

  const c: StemContext = {
    projectId: input.projectId,
    input,
    source,
    performed,
    promptSong,
    clipAssets,
    sampleRate,
    plan,
    reference,
    externalUsed: new Set(),
    signal,
    log: (l, m) => ctx.log(l, m),
    onProgress: () => undefined,
  };

  let costUsd = 0;
  let mixAudio: AudioData;
  let mixRun: RunProvenance | undefined;
  const stems: Record<string, StemRecord> = {};
  const methods: Record<string, TrackProductionMethod> = {};
  let providerInfo: { id: string; name: string; modelId?: string; cloud: boolean } | undefined;

  if (input.strategy === 'full') {
    if (!plan) throw new Error('No production plan');
    let guideAudio: AudioData | undefined;
    if (plan.op === 'transform' || plan.op === 'generate-guided') {
      if (guide) {
        guideAudio = guide.audio;
        ctx.log('info', 'Using the current guide mix');
      } else {
        ctx.progress(0.05, 'Rendering the guide mix');
        ctx.log('info', 'The guide mix is missing or out of date — rendering it for this production');
        guideAudio = await renderProduction({ song: source, assets: clipAssets, sampleRate, applyMaster: true, tailSeconds: 2 }, { signal, onProgress: (p) => ctx.progress(0.05 + p * 0.3, 'Rendering the guide mix') });
      }
    }
    ctx.progress(0.38, 'Generating');
    const duration = guideAudio ? audioSeconds(guideAudio) : songDurationSeconds(source);
    const res = await providerGenerate(c, plan, { reference: guideAudio, durationSeconds: duration, seed: input.seed, scope: 'mix', title: `Production ${input.label}`, song: plan.op === 'render-song' ? performed : undefined });
    throwIfAborted(signal);
    mixRun = res.provenance;
    costUsd += res.provenance.costUsd ?? 0;
    if (res.provenance.costUsd) ctx.addCost(res.provenance.costUsd);
    providerInfo = { id: res.provenance.providerId, name: res.provenance.providerName, modelId: res.provenance.modelId, cloud: res.provenance.cloud };
    ctx.progress(0.8, 'Decoding');
    mixAudio = await decodeAudioBytes(res.result.audio.data);
    for (const u of units) methods[u.track.id] = 'ai';
  } else {
    const prev = ctx.previousCheckpoint as CandidateCheckpoint | undefined;
    const done = prev?.composition === composition ? prev.stems : {};
    let sum: AudioData | null = null;
    const weights = units.map((u) => (u.method === 'ai' ? 3 : u.method === 'singing' ? 2 : 1));
    const total = weights.reduce((a, b) => a + b, 0) + 2;
    let acc = 0;
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const w = weights[i];
      methods[unit.track.id] = unit.method;
      const prior = done[unit.track.id];
      if (prior && assetMeta(requireProject(input.projectId), prior.assetId)) {
        stems[unit.track.id] = prior;
        sum = accumulate(sum, await conformAudio(await loadAssetAudio(input.projectId, prior.assetId), sampleRate, { signal }));
        acc += w;
        ctx.progress(0.02 + (0.88 * acc) / total, `${unit.track.name} (resumed)`);
        continue;
      }
      const label = `${unit.track.name} — ${unit.method === 'ai' ? 'AI production' : unit.method}`;
      c.onProgress = (p) => ctx.progress(0.02 + (0.88 * (acc + w * Math.min(1, p))) / total, label);
      c.onProgress(0);
      const seed = hashSeed(input.seed, 'stem', unit.track.id);
      const produced = await produceUnit(c, unit, seed);
      throwIfAborted(signal);
      acc += w;
      if (!produced) continue;
      const fileName = `production_${input.label}_${slug(unit.track.name)}.wav`;
      const meta = await storeAudio({
        projectId: input.projectId,
        audio: produced.audio,
        fileName,
        kind: 'stem',
        bitDepth,
        signal,
        provenance: produced.run
          ? { run: produced.run, sources: [...songSources, { kind: 'midi', ref: `${unit.track.name} (${unit.track.id})`, revision }, ...produced.sources], seed, parameters: { ...produced.parameters, candidate: input.label, strategy: input.strategy, compositionHash: composition } }
          : {
              providerId: produced.record.providerId,
              providerName: produced.record.providerName,
              sources: [...songSources, { kind: unit.track.kind === 'audio' ? 'audio' : 'midi', ref: `${unit.track.name} (${unit.track.id})`, revision }, ...produced.sources],
              seed,
              parameters: { ...produced.parameters, candidate: input.label, strategy: input.strategy, variation: input.variation, compositionHash: composition },
            },
      });
      stems[unit.track.id] = { ...produced.record, assetId: meta.id };
      costUsd += produced.record.costUsd ?? 0;
      if (produced.record.costUsd) ctx.addCost(produced.record.costUsd);
      if (unit.method === 'ai' && !providerInfo) providerInfo = { id: produced.record.providerId, name: produced.record.providerName, modelId: produced.record.modelId, cloud: !!produced.record.cloud };
      sum = accumulate(sum, await conformAudio(produced.audio, sampleRate, { signal }));
      ctx.checkpoint({ composition, stems: { ...stems } } satisfies CandidateCheckpoint);
      ctx.log('info', `${unit.track.name}: ${produced.record.providerName}${produced.record.costUsd ? ` · $${produced.record.costUsd.toFixed(3)}` : ''}`);
    }
    if (!sum) throw new Error('No stems were produced');
    ctx.progress(0.9, 'Mixing the produced stems');
    mixAudio = await masterSum({ song: source, audio: sum, sampleRate, applyMaster: true }, { signal });
    if (!providerInfo) {
      const first = Object.values(stems)[0];
      providerInfo = { id: first?.providerId ?? GUIDE_RENDERER_ID, name: first?.providerName ?? GUIDE_RENDERERS.builtin.providerName, modelId: first?.modelId, cloud: false };
    }
  }
  throwIfAborted(signal);

  ctx.progress(0.94, 'Saving the candidate');
  const lufs = (await loudnessOf(mixAudio, { signal })).integratedLufs;
  const stemSources: ProvenanceSource[] = Object.values(stems).map((s) => ({ kind: 'audio', ref: s.assetId }));
  const parameters = {
    candidate: input.label,
    strategy: input.strategy,
    batchId: input.batchId,
    methods,
    stemProviders: Object.fromEntries(Object.entries(stems).map(([k, s]) => [k, s.providerName])),
    prompt: buildProductionPrompt(promptSong).prompt,
    negativePrompt: buildProductionPrompt(promptSong).negativePrompt,
    strength: input.strength,
    variation: input.variation,
    levelMatch: input.levelMatch,
    op: plan?.op,
    integratedLufs: Number.isFinite(lufs) ? Math.round(lufs * 10) / 10 : undefined,
    compositionHash: composition,
    sampleRate,
  };
  const mixMeta = await storeAudio({
    projectId: input.projectId,
    audio: mixAudio,
    fileName: `production_${input.label}.wav`,
    kind: 'generation',
    bitDepth,
    signal,
    provenance: mixRun
      ? { run: mixRun, artifactKind: 'mix', sources: [...songSources, ...stemSources], seed: input.seed, parameters }
      : { providerId: providerInfo!.id, providerName: providerInfo!.name, modelId: providerInfo!.modelId, cloud: providerInfo!.cloud, costUsd, artifactKind: 'mix', sources: [...songSources, ...stemSources], seed: input.seed, parameters },
  });

  const candidate: ProductionCandidate = {
    id: randomId('cand'),
    label: input.label,
    providerId: providerInfo!.id,
    seed: input.seed,
    mixAssetId: mixMeta.id,
    stemAssetIds: Object.fromEntries(Object.entries(stems).map(([k, s]) => [k, s.assetId])),
    createdAt: new Date().toISOString(),
    costUsd: Math.round(costUsd * 10000) / 10000,
    strategy: input.strategy,
    sourceRevisionId: input.sourceRevisionId,
  };
  if (providerInfo!.modelId) candidate.modelId = providerInfo!.modelId;
  commitProduction(
    input.projectId,
    (prod) => ({ ...prod, candidates: [...prod.candidates.filter((x) => x.id !== candidate.id), candidate] }),
    `Produced candidate ${input.label} — ${info.title} · ${providerInfo!.name} · seed ${input.seed}`,
  );
  ctx.progress(1, 'Done');
  const summary = `${input.label}: ${info.title}, ${Object.keys(stems).length || 1} ${Object.keys(stems).length ? 'stems' : 'mix'}, ${costUsd ? `$${costUsd.toFixed(3)}` : 'free'}`;
  return { candidateId: candidate.id, label: input.label, mixAssetId: mixMeta.id, stems: Object.keys(stems).length, costUsd, summary };
};

// ---------------------------------------------------------------------------
// Selective regeneration (spec §39)
// ---------------------------------------------------------------------------

export interface RegionInput {
  projectId: string;
  candidateId: string;
  /** 1-based, inclusive. */
  startBar: number;
  endBar: number;
  /** 'all' = complete arrangement region; otherwise one stem (track id). */
  scope: 'all' | string;
  providerChoice: string;
  modelId?: string;
  singingChoice?: string;
  seed: number;
  variation: number;
  strength: number;
  levelMatch: boolean;
  crossfadeMs: number;
  /** Extra instructions for this region. */
  prompt?: string;
  batchId: string;
  sampleAssignments?: Record<string, string>;
  bitDepth?: 16 | 24 | 32;
}

export interface RegionOutput {
  candidateId: string;
  label: string;
  mode: 'inpaint' | 'reproduce';
  regenerated: string[];
  skipped: string[];
  summary: string;
}

/** Render a region with up to one bar of context on each side; returns audio + the region offset. */
function contextTicks(song: Song, region: RegionSpan): { startTick: number; endTick: number } {
  const firstBar = Math.max(0, region.startBar - 2);
  const lastBar = Math.min(songLengthBars(song), region.endBar + 1);
  return { startTick: barToTick(song, firstBar), endTick: Math.min(songLengthTicks(song), barToTick(song, lastBar)) };
}

const regenerateRegion: TaskHandler<RegionInput, RegionOutput> = async (ctx) => {
  const { input, signal } = ctx;
  const project = requireProject(input.projectId);
  const parent = project.song.production.candidates.find((x) => x.id === input.candidateId);
  if (!parent) throw new Error('That candidate no longer exists.');
  if (!parent.mixAssetId) throw new Error(`Candidate ${parent.label} has no audio.`);
  const snapshot = candidateSourceSong(project, parent);
  const cur = project.song.production;
  const promptSong = productionSourceSong(withPrompts(snapshot, { prompt: cur.prompt, negativePrompt: cur.negativePrompt, sectionPrompts: cur.sectionPrompts, trackMethods: cur.trackMethods }));
  // Only the tracks the candidate produced take part (others were muted or switched off then).
  const produced = new Set(Object.keys(((provenanceOfAsset(project, parent.mixAssetId)?.parameters as { methods?: Record<string, string> } | undefined)?.methods ?? {})));
  const source = renderableSong(produced.size ? muteTracks(promptSong, promptSong.tracks.filter((t) => !produced.has(t.id)).map((t) => t.id)) : promptSong);
  const region = regionSpan(source, input.startBar, input.endBar);
  const xf = Math.max(0.005, Math.min(0.5, input.crossfadeMs / 1000));
  const sampleRate = prefs().sampleRate;
  const bitDepth = input.bitDepth ?? prefs().bitDepth;
  const revision = revisionNumber(project, parent.sourceRevisionId);
  const parentProv = provenanceOfAsset(project, parent.mixAssetId);
  const parentMethods = ((parentProv?.parameters as { methods?: Record<string, TrackProductionMethod> } | undefined)?.methods ?? {}) as Record<string, TrackProductionMethod>;
  const stemIds = Object.keys(parent.stemAssetIds);
  const hasStems = stemIds.length > 0;
  const tracks = new Map(source.tracks.map((t) => [t.id, t]));
  const methodOf = (id: string): TrackProductionMethod => parentMethods[id] ?? (tracks.get(id) ? methodFor(tracks.get(id)!, parent.strategy, cur.trackMethods) : 'ai');
  const targets = hasStems ? (input.scope === 'all' ? stemIds : stemIds.filter((id) => id === input.scope)) : [];
  if (hasStems && !targets.length) throw new Error('That stem is not part of the candidate.');
  const sectionId = sectionsInRegion(source, region.startTick, region.endTick)[0]?.section.id;
  const aiTargets = hasStems ? targets.filter((id) => methodOf(id) === 'ai').length : 1;
  const resolution = resolveProduction(input.providerChoice, input.modelId, parent.strategy, {
    vocals: hasSungVocals(source),
    reference: false,
    aiUnits: aiTargets,
    aiVocalUnits: hasStems ? targets.filter((id) => methodOf(id) === 'ai' && tracks.get(id) && isVocalTrack(tracks.get(id)!)).length : 0,
  });
  const plan = resolution.plan.plan;
  if (aiTargets > 0 && resolution.error && input.providerChoice !== 'auto') throw new Error(resolution.error);
  const mode: 'inpaint' | 'reproduce' = resolution.plan.region === 'inpaint' && !resolution.error ? 'inpaint' : 'reproduce';
  const label = nextVersionLabel(project.song.production.candidates, parent.label);
  const what = regionLabel(region);
  ctx.log('info', `Regenerating ${what} of ${parent.label} → ${label} (${mode === 'inpaint' ? `inpainting with ${resolution.provider?.name}` : 're-producing the region and splicing it in'})`);
  const seedOf = (id: string) => hashSeed(input.seed, 'region', id);
  const performed = performSong(source, input.seed, input.variation);
  const clipAssets = await collectAssets(source);
  const ctxRange = contextTicks(source, region);
  /** Seconds of context rendered before the region (one bar when available). */
  const preRoll = region.startSeconds - tickToSeconds(source, ctxRange.startTick);
  const c: StemContext = {
    projectId: input.projectId,
    input: {
      projectId: input.projectId,
      batchId: input.batchId,
      label,
      seed: input.seed,
      strategy: parent.strategy,
      providerChoice: input.providerChoice,
      modelId: input.modelId,
      singingChoice: input.singingChoice,
      prompt: cur.prompt,
      negativePrompt: cur.negativePrompt,
      sectionPrompts: cur.sectionPrompts,
      trackMethods: cur.trackMethods,
      strength: input.strength,
      variation: input.variation,
      levelMatch: input.levelMatch,
      allowReferenceUpload: false,
      sampleAssignments: input.sampleAssignments,
    },
    source,
    performed,
    promptSong,
    clipAssets,
    sampleRate,
    plan,
    externalUsed: new Set(),
    signal,
    log: (l, m) => ctx.log(l, m),
    onProgress: () => undefined,
  };

  let costUsd = 0;
  const runs: RunProvenance[] = [];
  const regionLen = region.endSeconds - region.startSeconds;
  /** The region in frames of a buffer at `sr` (frame-exact, so splices touch nothing outside it). */
  const framesAt = (sr: number) => ({ start: Math.round(region.startSeconds * sr), end: Math.round(region.endSeconds * sr) });
  const sliceFrames = (a: AudioData, start: number, end: number): AudioData => ({ sampleRate: a.sampleRate, channels: a.channels.map((ch) => ch.slice(start, end)) });

  /**
   * Exactly the region's frames (at `original`'s rate) from `insert`, whose region starts
   * `regionOffset` seconds into it; zero-padded when short; optionally level-matched to the
   * original region so the splice does not jump in loudness.
   */
  const fitInsert = async (insert: AudioData, regionOffset: number, original: AudioData, levelMatch = input.levelMatch): Promise<AudioData> => {
    const sr = original.sampleRate;
    const conf = await conformAudio(insert, sr, { signal });
    const f = framesAt(sr);
    const n = Math.max(1, f.end - f.start);
    const off = Math.max(0, Math.round(regionOffset * sr));
    let out: AudioData = {
      sampleRate: sr,
      channels: conf.channels.map((ch) => {
        const o = new Float32Array(n);
        o.set(ch.subarray(Math.min(off, ch.length), Math.min(ch.length, off + n)));
        return o;
      }),
    };
    if (levelMatch) out = (await matchLoudness(out, sliceFrames(original, f.start, f.end), { signal })).audio;
    return out;
  };
  const spliceRegion = (original: AudioData, insert: AudioData) => spliceAudio(original, insert, framesAt(original.sampleRate).start / original.sampleRate, xf, { signal });

  const inpaint = async (original: AudioData, title: string): Promise<AudioData> => {
    const wav = await wavOf(original, 16, signal);
    const pp = buildProductionPrompt(promptSong, { sectionId, extra: input.prompt });
    const res = await runProduction<AudioGenerationResult>({
      choice: input.providerChoice,
      modelId: input.modelId,
      caps: ['INPAINTING'],
      dataKinds: ['stems', 'song-description'],
      durationSeconds: regionLen,
      title,
      signal,
      consentKey: input.batchId,
      execute: async (inst, model, sig) => {
        if (!inst.audioGeneration?.inpaintAudio) throw new Error(`${inst.descriptor.name} cannot inpaint`);
        return inst.audioGeneration.inpaintAudio({ audio: wav, startSeconds: region.startSeconds, endSeconds: region.endSeconds, prompt: pp.prompt, seed: input.seed, model, signal: sig });
      },
    });
    runs.push(res.provenance);
    costUsd += res.provenance.costUsd ?? 0;
    if (res.provenance.costUsd) ctx.addCost(res.provenance.costUsd);
    // The provider returns the whole clip; only the region is taken from it.
    return fitInsert(await decodeAudioBytes(res.result.audio.data), region.startSeconds, original);
  };

  const regenerated: string[] = [];
  const skipped: string[] = [];
  const newStemIds: Record<string, string> = { ...parent.stemAssetIds };
  let newMix: AudioData;
  const regionParams = { parentCandidateId: parent.id, parentLabel: parent.label, region: { startBar: region.startBar, endBar: region.endBar, startSeconds: region.startSeconds, endSeconds: region.endSeconds }, crossfadeMs: Math.round(xf * 1000), mode, seed: input.seed, variation: input.variation };

  if (hasStems) {
    let i = 0;
    for (const id of targets) {
      const track = tracks.get(id);
      const method = methodOf(id);
      const name = track?.name ?? id;
      ctx.progress(0.03 + (0.7 * i) / targets.length, `${name}: ${what}`);
      c.onProgress = (p) => ctx.progress(0.03 + (0.7 * (i + Math.min(1, p) * 0.8)) / targets.length, `${name}: ${what}`);
      i++;
      if (!track || method === 'external' || method === 'recorded') {
        skipped.push(name);
        ctx.log('warn', `${name}: ${method} audio cannot be regenerated — kept as is`);
        continue;
      }
      const original = await loadAssetAudio(input.projectId, parent.stemAssetIds[id]);
      let insert: AudioData;
      let stemRun: RunProvenance | undefined;
      if (method === 'ai' && mode === 'inpaint') {
        insert = await inpaint(original, `Inpaint ${name} ${what} (${label})`);
        stemRun = runs[runs.length - 1];
      } else if (method === 'ai') {
        if (!plan) throw new Error(resolution.error ?? 'No production provider can re-produce this stem');
        const ref = await renderReference(c, track, seedOf(id), { startTick: ctxRange.startTick, endTick: ctxRange.endTick });
        const res = await providerGenerate(c, plan, { reference: ref, durationSeconds: audioSeconds(ref), seed: seedOf(id), trackId: id, sectionId, extraPrompt: input.prompt, scope: 'region', title: `Re-produce ${name} ${what} (${label})`, atTick: ctxRange.startTick });
        runs.push(res.provenance);
        stemRun = res.provenance;
        costUsd += res.provenance.costUsd ?? 0;
        if (res.provenance.costUsd) ctx.addCost(res.provenance.costUsd);
        insert = await fitInsert(await decodeAudioBytes(res.result.audio.data), preRoll, original);
      } else if (method === 'singing') {
        const produced = await produceUnit(c, { track, method }, seedOf(id));
        if (!produced) {
          skipped.push(name);
          continue;
        }
        if (produced.run) {
          runs.push(produced.run);
          stemRun = produced.run;
          costUsd += produced.record.costUsd ?? 0;
        }
        insert = await fitInsert(produced.audio, region.startSeconds, original);
      } else {
        const ref = await renderReference(c, track, seedOf(id), { startTick: ctxRange.startTick, endTick: ctxRange.endTick, samples: method === 'sampled' });
        insert = await fitInsert(ref, preRoll, original);
      }
      throwIfAborted(signal);
      const spliced = await spliceRegion(original, insert);
      const meta = await storeAudio({
        projectId: input.projectId,
        audio: spliced,
        fileName: `production_${label}_${slug(name)}.wav`,
        kind: 'stem',
        bitDepth,
        signal,
        provenance: stemRun
          ? { run: stemRun, sources: [{ kind: 'audio', ref: parent.stemAssetIds[id] }, { kind: 'song', ref: snapshot.id, revision }, { kind: 'midi', ref: `${name} (${id})`, revision }], seed: seedOf(id), parameters: { ...regionParams, method, trackId: id } }
          : {
              providerId: GUIDE_RENDERER_ID,
              providerName: method === 'sampled' ? GUIDE_RENDERERS.sampled.providerName : GUIDE_RENDERERS.builtin.providerName,
              sources: [{ kind: 'audio', ref: parent.stemAssetIds[id] }, { kind: 'song', ref: snapshot.id, revision }, { kind: 'midi', ref: `${name} (${id})`, revision }],
              seed: seedOf(id),
              parameters: { ...regionParams, method, trackId: id },
            },
      });
      newStemIds[id] = meta.id;
      regenerated.push(name);
      ctx.log('info', `${name}: ${what} regenerated`);
    }
    if (!regenerated.length) throw new Error(`Nothing could be regenerated (${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} recorded/external audio).`);
    ctx.progress(0.75, 'Re-mixing the stems');
    let sum: AudioData | null = null;
    for (const id of stemIds) sum = accumulate(sum, await conformAudio(await loadAssetAudio(input.projectId, newStemIds[id]), sampleRate, { signal }));
    const full = await masterSum({ song: source, audio: sum!, sampleRate, applyMaster: true }, { signal });
    const parentMix = await loadAssetAudio(input.projectId, parent.mixAssetId);
    // Outside the region the parent mix is kept as is; inside, the re-mixed stems.
    newMix = await spliceRegion(parentMix, await fitInsert(full, region.startSeconds, parentMix, false));
  } else {
    const parentMix = await loadAssetAudio(input.projectId, parent.mixAssetId);
    ctx.progress(0.1, `Regenerating ${what}`);
    c.onProgress = (p) => ctx.progress(0.1 + 0.6 * Math.min(1, p), `Regenerating ${what}`);
    let insert: AudioData;
    if (mode === 'inpaint') insert = await inpaint(parentMix, `Inpaint ${what} (${label})`);
    else {
      if (!plan) throw new Error(resolution.error ?? 'No production provider can re-produce this region');
      const performedRegion = await renderProduction(
        { song: performed, assets: clipAssets, sampleRate, applyMaster: true, startTick: ctxRange.startTick, endTick: ctxRange.endTick, tailSeconds: 0, seed: input.seed },
        { signal, onProgress: c.onProgress },
      );
      let out = performedRegion;
      if (plan.op !== 'render-song') {
        const plainRegion = await renderProduction({ song: source, assets: clipAssets, sampleRate, applyMaster: true, startTick: ctxRange.startTick, endTick: ctxRange.endTick, tailSeconds: 0 }, { signal });
        const res = await providerGenerate(c, plan, { reference: plainRegion, durationSeconds: audioSeconds(plainRegion), seed: input.seed, sectionId, extraPrompt: input.prompt, scope: 'region', title: `Re-produce ${what} (${label})`, atTick: ctxRange.startTick });
        runs.push(res.provenance);
        costUsd += res.provenance.costUsd ?? 0;
        if (res.provenance.costUsd) ctx.addCost(res.provenance.costUsd);
        out = await decodeAudioBytes(res.result.audio.data);
      }
      insert = await fitInsert(out, preRoll, parentMix);
    }
    newMix = await spliceRegion(parentMix, insert);
    regenerated.push('mix');
  }
  throwIfAborted(signal);

  ctx.progress(0.9, 'Saving the new version');
  const run = runs[runs.length - 1];
  const producer = run ? { id: run.providerId, name: run.providerName, modelId: run.modelId, cloud: run.cloud } : (() => {
    const d = describeProvider(parent.providerId) ?? describeProvider(PRODUCER_ID);
    return { id: d?.id ?? parent.providerId, name: d?.name ?? parent.providerId, modelId: parent.modelId, cloud: d?.location === 'cloud' };
  })();
  const lufs = (await loudnessOf(newMix, { signal })).integratedLufs;
  const mixMeta = await storeAudio({
    projectId: input.projectId,
    audio: newMix,
    fileName: `production_${label}.wav`,
    kind: 'generation',
    bitDepth,
    signal,
    provenance: {
      providerId: producer.id,
      providerName: producer.name,
      modelId: producer.modelId,
      cloud: producer.cloud,
      costUsd,
      artifactKind: 'mix',
      sources: [{ kind: 'audio', ref: parent.mixAssetId }, { kind: 'song', ref: snapshot.id, revision }, ...Object.values(newStemIds).filter((x) => !Object.values(parent.stemAssetIds).includes(x)).map((ref) => ({ kind: 'audio', ref }))],
      seed: input.seed,
      parameters: {
        ...regionParams,
        candidate: label,
        strategy: parent.strategy,
        methods: parentMethods,
        scope: input.scope,
        regenerated,
        skipped,
        prompt: input.prompt,
        integratedLufs: Number.isFinite(lufs) ? Math.round(lufs * 10) / 10 : undefined,
        compositionHash: compositionHash(snapshot),
      },
    },
  });
  const candidate: ProductionCandidate = {
    id: randomId('cand'),
    label,
    providerId: producer.id,
    seed: input.seed,
    mixAssetId: mixMeta.id,
    stemAssetIds: newStemIds,
    createdAt: new Date().toISOString(),
    costUsd: Math.round(costUsd * 10000) / 10000,
    strategy: parent.strategy,
    sourceRevisionId: parent.sourceRevisionId,
  };
  if (producer.modelId) candidate.modelId = producer.modelId;
  commitProduction(
    input.projectId,
    (prod) => ({ ...prod, candidates: [...prod.candidates, candidate] }),
    `Regenerated ${what} of ${parent.label} → ${label} (${mode === 'inpaint' ? 'inpainting' : 're-produced region'})`,
  );
  ctx.progress(1, 'Done');
  return { candidateId: candidate.id, label, mode, regenerated, skipped, summary: `${label}: ${what} of ${parent.label} regenerated${skipped.length ? ` (kept: ${skipped.join(', ')})` : ''}` };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, TaskHandler<any, any>> = {
  'produce.candidate': produceCandidate,
  'produce.region': regenerateRegion,
};
