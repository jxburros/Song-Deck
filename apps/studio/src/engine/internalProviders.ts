import {
  answerQuestion,
  explainSection,
  explainSong,
  generatePlaceholderLyrics,
  interpretEditInstruction,
  interpretMixInstruction,
  parsePromptToBlueprint,
  planComposition,
  createEmptySong,
  randomId,
  createTimeMap,
  type EditSelection,
  type Song,
} from '@songdeck/core';
import { STOCK_VOICES, encodeWav, type AudioData, type LoudnessReport } from '@songdeck/audio';
import {
  createInternalProvider,
  type AudioGenerationProvider,
  type CompositionProvider,
  type EncodedAudio,
  type MasteringProvider,
  type ProviderInstance,
  type SeparationProvider,
  type SingingProvider,
  type SingingRequest,
  type TranscriptionProvider,
} from '@songdeck/ai';
import { INTERNAL_DESCRIPTORS } from './internalDescriptors';
import { jobs } from './jobs';
import { decodeAudioBytes } from '../state/assets';
import { collectAssets } from './mix-render';
import { allCustomGenres } from './plugins';

/**
 * The on-device engines as provider instances (spec §2.2, §51). The studio calls them with full
 * project context (song + selection) through `getContext`, so their answers are about the actual
 * song, exactly like a cloud model given a MusicContext.
 */

export interface InternalContext {
  song(): Song | null;
  selection(): EditSelection;
  seed(): number;
}

function requireSong(ctx: InternalContext): Song {
  const s = ctx.song();
  if (!s) throw new Error('No song is open');
  return s;
}

function wav(audio: AudioData): EncodedAudio {
  return {
    mimeType: 'audio/wav',
    data: encodeWav(audio, { bitDepth: 24 }),
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    durationSeconds: (audio.channels[0]?.length ?? 0) / audio.sampleRate,
  };
}

function composer(ctx: InternalContext): CompositionProvider {
  return {
    async planSong(req) {
      const blueprint = req.blueprint ?? parsePromptToBlueprint(req.prompt ?? '', { seed: ctx.seed(), customGenres: allCustomGenres() });
      return { plan: planComposition(blueprint, { seed: blueprint.seed, customGenres: allCustomGenres() }), confidence: 0.65, explanation: 'Planned by the on-device theory engine.' };
    },
    async designBlueprint(req) {
      const blueprint = parsePromptToBlueprint(req.prompt, { seed: (req.defaults?.seed as number | undefined) ?? ctx.seed(), customGenres: allCustomGenres() });
      return { blueprint: { ...blueprint, ...(req.defaults ?? {}), seed: blueprint.seed }, confidence: 0.6 };
    },
    async modifyComposition(req) {
      const song = requireSong(ctx);
      const r = interpretEditInstruction(song, req.instruction ?? req.context.instruction, ctx.selection(), { seed: ctx.seed() });
      return { operations: r.operations, explanation: r.explanation, errors: [], confidence: r.understood ? 0.75 : 0.1 };
    },
    async analyzeMusic() {
      const song = requireSong(ctx);
      const ex = explainSong(song);
      return { summary: ex.overview.join(' '), observations: ex.sections.map((s) => ({ topic: s.sectionName, detail: s.narrative.join(' '), section: s.sectionName })), confidence: 0.7 };
    },
    async explainMusic(req) {
      const song = requireSong(ctx);
      const id = req.sectionId ?? song.sections[0]?.id;
      const ex = explainSection(song, id);
      return {
        explanation: [ex.romanSummary, ...ex.narrative, ...ex.comparisons].join('\n\n'),
        harmony: [{ section: ex.sectionName, chords: ex.chords.map((c) => c.symbol), romans: ex.chords.map((c) => c.roman) }],
        suggestions: [],
        confidence: 0.75,
      };
    },
    async generateLyrics(req) {
      return {
        sections: req.sections.map((s, i) => ({
          section: s.name,
          lines: s.locked && s.existing?.length
            ? s.existing
            : generatePlaceholderLyrics({ mood: req.style, theme: req.theme, sectionKind: s.kind ?? 'verse', lines: s.lines, syllablesPerLine: s.syllables, seed: ctx.seed() + i }),
        })),
        notes: 'Placeholder lyrics from the on-device engine — configure a language model for real lyric writing.',
        confidence: 0.3,
      };
    },
    async chat(req) {
      const song = requireSong(ctx);
      const r = answerQuestion(song, req.question, ctx.selection());
      return { answer: r.answer, suggestions: r.suggestions ?? [], operations: r.operations ?? [], errors: [], confidence: 0.6 };
    },
    async mixAssist(req) {
      const song = requireSong(ctx);
      const r = interpretMixInstruction(song, req.instruction);
      return { operations: r.operations, explanation: r.explanation, errors: [], confidence: r.understood ? 0.8 : 0.1 };
    },
  };
}

/** Re-express a singing request as a one-track song so the built-in singing engine renders it. */
function singingRequestToSong(req: SingingRequest): Song {
  const song = createEmptySong({ bpm: req.tempoBpm });
  const tm = createTimeMap(song);
  const end = Math.max(1, ...req.notes.map((n) => n.startSeconds + n.durationSeconds));
  const bars = Math.ceil((end / 60) * (req.tempoBpm / 4)) + 1;
  song.sections = [{ id: 'sec', name: 'Vocal', kind: 'verse', bars, energy: 50 }];
  song.tracks = [
    {
      id: 'vox',
      name: 'Vocal',
      kind: 'midi',
      role: 'vocal',
      instrumentId: 'lead-vocal',
      constraints: {},
      clips: [],
      color: '#ff7ac6',
      stemGroup: 'vocals',
      notes: req.notes.map((n) => {
        const tick = Math.round(tm.secondsToTick(n.startSeconds));
        return {
          id: randomId('n'),
          pitch: n.pitch,
          tick,
          duration: Math.max(1, Math.round(tm.secondsToTick(n.startSeconds + n.durationSeconds)) - tick),
          velocity: n.velocity,
          syllable: n.lyric,
          phonemes: n.phonemes,
          expression: n.expression,
        };
      }),
    },
  ];
  return song;
}

function singer(): SingingProvider {
  return {
    async listVoices() {
      return STOCK_VOICES.map((v) => ({ id: v.id, name: v.name, voiceType: v.voiceType, kind: 'stock' as const, language: 'en', description: 'Built-in formant voice' }));
    },
    async synthesizeSinging(req) {
      const song = singingRequestToSong(req);
      const audio = await jobs.call<AudioData>('synthesizeVocal', { song, trackId: 'vox', voiceId: req.voiceId, sampleRate: req.sampleRate ?? 44100, seed: req.seed }, { signal: req.signal });
      return { audio: wav(audio), voiceId: req.voiceId, seed: req.seed };
    },
    async regeneratePhrase(req) {
      // Sing only the requested range; the result is the matching slice of a full render.
      const song = singingRequestToSong(req);
      const tm = createTimeMap(song);
      const startTick = Math.max(0, Math.round(tm.secondsToTick(req.startSeconds)));
      const endTick = Math.max(startTick + 1, Math.round(tm.secondsToTick(req.endSeconds)));
      const audio = await jobs.call<AudioData>(
        'synthesizeVocal',
        { song, trackId: 'vox', voiceId: req.voiceId, sampleRate: req.sampleRate ?? 44100, seed: req.seed, startTick, endTick },
        { signal: req.signal },
      );
      const frames = Math.max(1, Math.round((req.endSeconds - req.startSeconds) * audio.sampleRate));
      return { audio: wav({ sampleRate: audio.sampleRate, channels: audio.channels.map((c) => c.slice(0, frames)) }), voiceId: req.voiceId, seed: req.seed };
    },
  };
}

function analysis(): TranscriptionProvider & SeparationProvider {
  return {
    async transcribeNotes(req) {
      const audio = await decodeAudioBytes(req.audio.data);
      const source = (req.source ?? 'full-mix') as never;
      const r = await jobs.call<{ notes: { pitch: number; tick: number; duration: number; velocity: number; confidence?: number }[]; bpm: number; key: { tonic: number; mode: string }; confidence: number }>(
        'transcribe',
        { audio, source, quantizeBeats: 0 },
        { signal: req.signal },
      );
      const spt = 60 / (r.bpm * 480);
      return {
        notes: r.notes.map((n) => ({ pitch: n.pitch, start: n.tick * spt, end: (n.tick + n.duration) * spt, velocity: n.velocity, confidence: n.confidence ?? r.confidence })),
        tempo: r.bpm,
        confidence: r.confidence,
        model: 'on-device DSP',
      };
    },
    async separateStems(req) {
      const audio = await decodeAudioBytes(req.audio.data);
      const r = await jobs.call<{ stems: Record<string, AudioData>; confidence: Record<string, number> }>('separate', { audio }, { signal: req.signal });
      const stems: Record<string, EncodedAudio> = {};
      for (const [name, buf] of Object.entries(r.stems)) stems[name] = wav(buf);
      const confs = Object.values(r.confidence ?? {});
      return { stems, model: 'HPSS + spectral masks (on-device)', confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0.4 };
    },
  };
}

function mastering(): MasteringProvider {
  return {
    async master(req) {
      const audio = await decodeAudioBytes(req.audio.data);
      const r = await jobs.call<{ output: AudioData; report: Record<string, unknown> }>(
        'master',
        { audio, settings: { method: 'builtin', target: req.target, tone: 0, width: 1 } },
        { signal: req.signal },
      );
      return { audio: wav(r.output), report: r.report, model: 'Built-in DSP mastering' };
    },
  };
}

function producer(): AudioGenerationProvider {
  return {
    async discoverModels() {
      return [{ id: 'dsp-producer', name: 'DSP producer', capabilities: [...INTERNAL_DESCRIPTORS.producer.capabilities] }];
    },
    async getCapabilities() {
      return [...INTERNAL_DESCRIPTORS.producer.capabilities];
    },
    async generateMusic(req) {
      if (!req.song) throw new Error('The built-in producer renders the composition itself — no song was supplied');
      // Audio-track clips (stems, recordings) are part of the performance too.
      const assets = await collectAssets(req.song);
      const audio = await jobs.call<AudioData>('renderMix', { song: req.song, assets, sampleRate: 44100, applyMaster: true, seed: req.seed }, { signal: req.signal });
      return { audio: wav(audio), model: 'dsp-producer', seed: req.seed, confidence: 0.5 };
    },
    async transformAudio(req) {
      // Stem "production" without a neural model: glue compression, saturation-friendly EQ tilt and
      // width — then matched back to the input's loudness so the mix balance between stems survives.
      const audio = await decodeAudioBytes(req.audio.data);
      const [before, r] = await Promise.all([
        jobs.call<LoudnessReport>('loudness', audio, { signal: req.signal }),
        jobs.call<{ output: AudioData }>('master', { audio, settings: { method: 'builtin', target: 'demo', tone: 0.15, width: 1.1 } }, { signal: req.signal }),
      ]);
      const after = await jobs.call<LoudnessReport>('loudness', r.output, { signal: req.signal });
      return { audio: wav(matchLoudness(r.output, before, after)), model: 'dsp-producer', seed: req.seed, confidence: 0.4 };
    },
  };
}

/** Scale `audio` from loudness `after` back to `before` (peak-limited to avoid clipping). */
function matchLoudness(audio: AudioData, before: LoudnessReport, after: LoudnessReport): AudioData {
  if (!Number.isFinite(before.integratedLufs) || !Number.isFinite(after.integratedLufs)) return audio;
  let gain = 10 ** ((before.integratedLufs - after.integratedLufs) / 20);
  let peak = 0;
  for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (peak * gain > 0.989) gain = 0.989 / Math.max(peak, 1e-9);
  return { sampleRate: audio.sampleRate, channels: audio.channels.map((ch) => ch.map((v) => v * gain)) };
}

export function createInternalProviders(ctx: InternalContext): ProviderInstance[] {
  const d = INTERNAL_DESCRIPTORS;
  const a = analysis();
  return [
    createInternalProvider({ ...d.composer, composition: composer(ctx) }),
    createInternalProvider({ ...d.analysis, transcription: a, separation: a }),
    createInternalProvider({ ...d.singer, singing: singer() }),
    createInternalProvider({ ...d.producer, audioGeneration: producer() }),
    createInternalProvider({ ...d.mastering, mastering: mastering() }),
  ];
}
