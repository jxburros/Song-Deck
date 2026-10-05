import { create } from 'zustand';
import {
  barToTick,
  createEmptySong,
  createTimeMap,
  createVariation,
  defaultChannelStrip,
  LockKeys,
  randomId,
  sectionLayout,
  tickToMusical,
  type Song,
} from '@songdeck/core';
import type { KeyResult, TempoResult } from '@songdeck/audio';
import { decodeAudioBytes } from '../../state/assets';
import { independentCopy, type LibraryItem } from '../../state/library';
import { makeAssetMeta } from '../../engine/capture-song';
import { jobs } from '../../engine/jobs';
import { runTask } from '../../engine/capture-tasks';
import type { RebuildTaskInput, RebuildTaskOutput } from '../../engine/handlers/analysis';

export type Interpretation = 'preserve' | 'light' | 'moderate' | 'free';
export const INTERPRETATIONS: { value: Interpretation; label: string; hint: string }[] = [
  {
    value: 'preserve',
    label: 'Exactly',
    hint: 'Keep the performance and audio unchanged; lock these tracks.',
  },
  {
    value: 'light',
    label: 'Closely',
    hint: 'Keep pitches and rhythm; vary expression, articulations, ornaments and fills.',
  },
  { value: 'moderate', label: 'Loosely', hint: 'Keep harmony, motifs and structure; vary accompaniment.' },
  {
    value: 'free',
    label: 'Just for ideas',
    hint: 'Use the musical identity as a starting point for new MIDI material.',
  },
];
export interface ComposeInput {
  id: string;
  item: LibraryItem;
  interpretation: Interpretation;
  startBar: number;
}
export const useComposeInputs = create<{
  inputs: ComposeInput[];
  add(item: LibraryItem): void;
  patch(id: string, patch: Partial<Pick<ComposeInput, 'interpretation' | 'startBar'>>): void;
  remove(id: string): void;
}>((set) => ({
  inputs: [],
  add: (item) =>
    set((s) => ({
      inputs: [
        ...s.inputs,
        { id: randomId('input'), item: independentCopy(item), interpretation: 'preserve', startBar: 1 },
      ],
    })),
  patch: (id, patch) => set((s) => ({ inputs: s.inputs.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
  remove: (id) => set((s) => ({ inputs: s.inputs.filter((i) => i.id !== id) })),
}));

/** Analyze a recording for composition context while retaining every byte of its performance. */
export async function playableItem(item: LibraryItem): Promise<LibraryItem> {
  if (item.song) return item;
  if (item.kind !== 'audio' || !item.file)
    throw new Error('Choose MIDI, audio, or a track collection to compose with.');
  const audio = await decodeAudioBytes(item.file.bytes);
  const info = await jobs.call<{ tempo: TempoResult; key: KeyResult }>('analyze', { audio });
  const duration = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
  const song = createEmptySong({ title: item.name, bpm: info.tempo.bpm || 120, key: info.key.key });
  const meta = makeAssetMeta({
    name: item.name,
    kind: 'reference',
    mimeType: item.file.mime,
    bytes: item.file.bytes,
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    durationSeconds: duration,
  });
  const id = randomId('track');
  song.sections = [
    {
      id: randomId('sec'),
      name: 'Recording',
      kind: 'verse',
      bars: Math.max(1, Math.ceil((duration * (info.tempo.bpm || 120)) / 240)),
      energy: 60,
    },
  ];
  song.tracks = [
    {
      id,
      name: item.name,
      kind: 'audio',
      role: 'custom',
      instrumentId: 'piano',
      constraints: {},
      notes: [],
      clips: [
        {
          id: randomId('clip'),
          assetId: meta.id,
          tick: 0,
          offsetSeconds: 0,
          durationSeconds: duration,
          gainDb: 0,
          fadeInSeconds: 0,
          fadeOutSeconds: 0,
        },
      ],
      color: '#50b8ad',
      stemGroup: 'others',
    },
  ];
  song.mixer.channels[id] = defaultChannelStrip();
  return { ...item, song, assets: [{ meta, bytes: item.file.bytes }] };
}

export async function interpretInput(input: ComposeInput, seed: number): Promise<ComposeInput> {
  const item = structuredClone(await playableItem(input.item));
  if (input.interpretation !== 'preserve') {
    let song = item.song!;
    if (song.tracks.some((t) => t.kind === 'audio')) {
      const timeline = createTimeMap(song);
      const audioTracks = song.tracks.filter((t) => t.kind === 'audio');
      song.tracks = song.tracks.filter((t) => t.kind === 'midi');
      for (const track of audioTracks)
        for (const clip of track.clips) {
          if (clip.muted) continue;
          const asset = item.assets.find((a) => a.meta.id === clip.assetId);
          if (!asset) throw new Error(`Missing source recording: ${track.name}`);
          const decoded = await decodeAudioBytes(asset.bytes);
          const start = Math.round(clip.offsetSeconds * decoded.sampleRate);
          const end = Math.round((clip.offsetSeconds + clip.durationSeconds) * decoded.sampleRate);
          const audio = {
            sampleRate: decoded.sampleRate,
            channels: decoded.channels.map((c) => c.slice(start, end)),
          };
          const result = await runTask<RebuildTaskInput, RebuildTaskOutput>({
            type: 'analysis.rebuild',
            title: `Interpret ${track.name}`,
            input: { runId: randomId('run'), title: track.name, audio },
          }).done;
          const sourceTime = createTimeMap(result.song);
          const offset = timeline.tickToSeconds(clip.tick);
          const tick = (t: number) =>
            Math.round(timeline.secondsToTick(sourceTime.tickToSeconds(t) + offset));
          for (const rebuilt of result.song.tracks) {
            const id = randomId('track');
            song.tracks.push({
              ...rebuilt,
              id,
              name: `${track.name} · ${rebuilt.name}`,
              notes: rebuilt.notes.map((n) => ({
                ...n,
                id: randomId('note'),
                tick: tick(n.tick),
                duration: Math.max(1, tick(n.tick + n.duration) - tick(n.tick)),
                phraseId: undefined,
                motifId: undefined,
                lyricLineId: undefined,
              })),
            });
            song.mixer.channels[id] = structuredClone(song.mixer.channels[track.id] ?? defaultChannelStrip());
          }
          delete song.mixer.channels[track.id];
        }
    }
    // Choosing reinterpretation explicitly releases locks on this independent working copy.
    song = structuredClone(song);
    song.locks = {};
    for (const track of song.tracks) track.notes = track.notes.map((note) => ({ ...note, locked: false }));
    item.song = createVariation(
      song,
      input.interpretation === 'light'
        ? 'ornament'
        : input.interpretation === 'moderate'
          ? 'variation'
          : 'mutation',
      {
        seed,
        amount: input.interpretation === 'light' ? 0.2 : input.interpretation === 'moderate' ? 0.55 : 1,
      },
    );
  }
  return { ...input, item: independentCopy(item) };
}

/** Preserve physical timing across differing MIDI PPQs and tempo maps, at an explicit target bar. */
export function mergeComposeInputs(base: Song, inputs: ComposeInput[]): Song {
  const song = structuredClone(base);
  const targetTime = createTimeMap(song);
  let lastTick = barToTick(
    song,
    song.sections.reduce((n, s) => n + s.bars, 0),
  );
  const importedDetails: { source: Song; tick: (t: number) => number }[] = [];
  for (const input of inputs) {
    const source = input.item.song;
    if (!source) throw new Error(`No musical content in ${input.item.name}`);
    const time = createTimeMap(source);
    const startTick = barToTick(song, input.startBar - 1);
    const offset = targetTime.tickToSeconds(startTick);
    const tick = (t: number) => Math.round(targetTime.secondsToTick(time.tickToSeconds(t) + offset));
    importedDetails.push({ source, tick });
    for (const original of source.tracks) {
      const track = structuredClone(original);
      track.notes = track.notes.map((n) => ({
        ...n,
        tick: tick(n.tick),
        duration: Math.max(1, tick(n.tick + n.duration) - tick(n.tick)),
      }));
      track.clips = track.clips.map((c) => ({ ...c, tick: tick(c.tick) }));
      song.tracks.push(track);
      song.mixer.channels[track.id] = structuredClone(
        source.mixer.channels[track.id] ?? defaultChannelStrip(),
      );
      if (input.interpretation === 'preserve') song.locks[LockKeys.track(track.id)] = true;
      for (const n of track.notes) lastTick = Math.max(lastTick, n.tick + n.duration);
      for (const c of track.clips)
        lastTick = Math.max(
          lastTick,
          targetTime.secondsToTick(targetTime.tickToSeconds(c.tick) + c.durationSeconds),
        );
    }
  }
  const bars = song.sections.reduce((n, s) => n + s.bars, 0);
  const needed = tickToMusical(song, Math.max(0, Math.ceil(lastTick) - 1)).bar;
  if (needed > bars)
    song.sections.push({
      id: randomId('sec'),
      kind: 'custom',
      name: 'Source continuation',
      bars: needed - bars,
      energy: 60,
    });
  const spans = sectionLayout(song);
  for (const { source, tick } of importedDetails) {
    const sourceSpans = sectionLayout(source);
    const sectionId = (id: string | undefined) => {
      const start = tick(sourceSpans.find((s) => s.section.id === id)?.startTick ?? 0);
      return spans.find((s) => start >= s.startTick && start < s.endTick)?.section.id ?? song.sections[0]?.id;
    };
    song.lyrics.push(...source.lyrics.map((l) => ({ ...l, sectionId: sectionId(l.sectionId) })));
    song.phrases.push(
      ...source.phrases.map((p) => ({
        ...p,
        startTick: tick(p.startTick),
        endTick: tick(p.endTick),
        sectionId: sectionId(p.sectionId),
      })),
    );
    song.motifs.push(...structuredClone(source.motifs));
    song.automation.push(
      ...source.automation
        .filter((a) => a.target !== 'master')
        .map((a) => ({ ...a, points: a.points.map((p) => ({ ...p, tick: tick(p.tick) })) })),
    );
  }
  return song;
}
