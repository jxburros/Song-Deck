import {
  rightsSummaryText,
  songToDawProject,
  songToMidi,
  songToMusicXML,
  songToReaperProject,
  trackToMidi,
  type Song,
  type StemGroup,
  type TaskHandler,
} from '@songdeck/core';
import type { AudioData } from '@songdeck/audio';
import { useStudio } from '../../state/store';
import { assetStore, decodeAudioBytes } from '../../state/assets';
import { allCustomInstruments } from '../plugins';
import { currentMaster } from '../mix-mastering';
import {
  abortError,
  collectAssets,
  instrumentalTrackIds,
  masterAudioBuffer,
  renderMixAudio,
  renderTrackAudio,
  throwIfAborted,
  vocalTrackIds,
  ProgressMix,
} from '../mix-render';
import { renderStemsDistributed } from '../collab-render';
import { describeEncoding, encodeAudio, formatInfo, zipEntries, type AudioFormat, type FlacBits, type WavBits, type ZipEntry } from '../export-audio';
import { deliverFile, MIME, sanitizeFileName } from '../export-files';

/**
 * Export tasks (spec §55, §56, §63, §73). Every render-based export runs through the generation
 * queue with progress, cancellation and logs, then hands the file to the browser. Inputs hold only
 * settings — the song is read from the open project when the task runs.
 */

export type AudioWhich = 'mix' | 'master' | 'instrumental' | 'acapella';

export interface AudioEncodingInput {
  format: AudioFormat;
  wavBits: WavBits;
  flacBits: FlacBits;
  kbps: number;
  sampleRate: number;
}

export interface AudioExportInput extends AudioEncodingInput {
  projectId: string;
  which: AudioWhich;
  fileBase: string;
}

export interface StemsExportInput {
  projectId: string;
  by: 'stemGroup' | 'track';
  wavBits: WavBits;
  sampleRate: number;
  /** Also include each audio track (produced / recorded / imported stems) individually. */
  includeAudioTracks: boolean;
  fileBase: string;
}

export interface DawExportInput {
  projectId: string;
  target: 'reaper' | 'dawproject';
  wavBits: WavBits;
  sampleRate: number;
  /** Render MIDI tracks to audio as well (so the DAW project is audible without instruments). */
  renderMidi: boolean;
  fileBase: string;
}

export interface EverythingInput {
  projectId: string;
  wavBits: WavBits;
  sampleRate: number;
  fileBase: string;
}

export interface ExportResult {
  fileName: string;
  bytes: number;
  files?: string[];
}

const STEM_LABEL: Record<StemGroup, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  guitars: 'Guitars',
  keys: 'Keys',
  strings: 'Strings',
  others: 'Others',
};

const STEM_ORDER: StemGroup[] = ['vocals', 'drums', 'bass', 'guitars', 'keys', 'strings', 'others'];

function openSong(projectId: string): Song {
  const project = useStudio.getState().project;
  if (!project || project.meta.id !== projectId) throw new Error('The project for this export is not open. Open it and retry the task.');
  return project.song;
}

function lookup() {
  const p = useStudio.getState().project;
  return { customInstruments: allCustomInstruments(p?.meta.customInstruments ?? []) };
}

function peakOf(a: AudioData): number {
  let peak = 0;
  for (const ch of a.channels) for (let i = 0; i < ch.length; i++) {
    const v = ch[i] < 0 ? -ch[i] : ch[i];
    if (v > peak) peak = v;
  }
  return peak;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "03 Lead Vocal" — numbered so files sort in track order. */
function trackFileName(song: Song, trackId: string): string {
  const i = song.tracks.findIndex((t) => t.id === trackId);
  const t = song.tracks[i];
  return `${pad2(i + 1)} ${sanitizeFileName(t?.name ?? 'Track', 'Track')}`;
}

function songInfoText(song: Song, sampleRate: number, bits: number, lines: string[]): string {
  const bpm = song.tempoMap[0]?.bpm ?? 120;
  const meter = song.meterMap[0] ?? { numerator: 4, denominator: 4 };
  return [
    `${song.title}`,
    `Exported by Song Deck on ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Tempo: ${bpm} BPM${song.tempoMap.length > 1 ? ' (tempo changes — see tempo map)' : ''}`,
    `Meter: ${meter.numerator}/${meter.denominator}`,
    `Audio: ${sampleRate} Hz, ${bits === 32 ? '32-bit float' : `${bits}-bit`} WAV`,
    'All files start at bar 1 (0:00) — import them at the start of the session to stay aligned.',
    '',
    ...lines,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Single audio files: mix / master / instrumental / acapella
// ---------------------------------------------------------------------------

/** Render (and master when asked) one of the full-length audio deliverables. */
async function renderDeliverable(
  song: Song,
  which: AudioWhich,
  opts: { sampleRate: number; signal: AbortSignal; assets: Record<string, AudioData>; onProgress: (p: number) => void; log: (msg: string) => void },
): Promise<{ audio: AudioData | null; existing?: Uint8Array; label: string }> {
  if (which === 'master') {
    const project = useStudio.getState().project;
    const m = currentMaster(project, song);
    if (song.mastering.method === 'none') {
      opts.log('Mastering is set to “None (user export)” — exporting the unmastered mix.');
      const audio = await renderMixAudio(song, { sampleRate: opts.sampleRate, signal: opts.signal, assets: opts.assets, onProgress: opts.onProgress });
      return { audio, label: 'Mix' };
    }
    if (m && !m.stale) {
      opts.log(`Using the saved master (${m.meta.name}, ${new Date(m.meta.createdAt).toLocaleString()}).`);
      const bytes = await assetStore.bytes(m.meta);
      if (bytes) {
        opts.onProgress(1);
        return { audio: null, existing: bytes, label: 'Master' };
      }
      opts.log('Saved master audio is missing from browser storage — mastering again.');
    } else if (m?.stale) opts.log('The saved master is out of date (the mix changed) — mastering the current mix on the fly.');
    else opts.log('No master yet — mastering the current mix on the fly with built-in DSP.');
    const mix = await renderMixAudio(song, { sampleRate: opts.sampleRate, signal: opts.signal, assets: opts.assets, onProgress: (p) => opts.onProgress(p * 0.7) });
    const { output } = await masterAudioBuffer(mix, { ...song.mastering, method: 'builtin' }, { signal: opts.signal, onProgress: (p) => opts.onProgress(0.7 + p * 0.3) });
    return { audio: output, label: 'Master' };
  }
  const trackIds = which === 'instrumental' ? instrumentalTrackIds(song) : which === 'acapella' ? vocalTrackIds(song) : undefined;
  if (trackIds && trackIds.length === 0) throw new Error(which === 'acapella' ? 'This song has no vocal tracks — there is no acapella to export.' : 'This song has only vocal tracks — there is no instrumental to export.');
  const audio = await renderMixAudio(song, { sampleRate: opts.sampleRate, trackIds, signal: opts.signal, assets: opts.assets, onProgress: opts.onProgress });
  return { audio, label: which === 'mix' ? 'Mix' : which === 'instrumental' ? 'Instrumental' : 'Acapella' };
}

const exportAudio: TaskHandler<AudioExportInput, ExportResult> = async (ctx) => {
  const { input, signal } = ctx;
  const song = openSong(input.projectId);
  const pm = new ProgressMix((p, m) => ctx.progress(p, m));
  const pRender = pm.part('render', 7, 'Rendering');
  const pEncode = pm.part('encode', 3, 'Encoding');
  const info = formatInfo(input.format);
  ctx.log('info', `${input.which} → ${describeEncoding(input, input.sampleRate)}`);
  const assets = await collectAssets(song);
  const r = await renderDeliverable(song, input.which, { sampleRate: input.sampleRate, signal, assets, onProgress: pRender, log: (m) => ctx.log('info', m) });
  throwIfAborted(signal);
  let bytes: Uint8Array;
  if (r.existing && input.format === 'wav') bytes = r.existing;
  else {
    const audio = r.audio ?? (await decodeAudioBytes(r.existing!));
    bytes = await encodeAudio(audio, { format: input.format, wavBits: input.wavBits, flacBits: input.flacBits, kbps: input.kbps, signal, onProgress: pEncode, consume: true });
  }
  pm.done('encode');
  const fileName = `${input.fileBase} - ${r.label}.${info.ext}`;
  deliverFile(fileName, bytes, info.mime, { detail: `${r.label} · ${describeEncoding(input, input.sampleRate)}` });
  ctx.log('info', `Delivered ${fileName} (${bytes.length} bytes)`);
  ctx.progress(1, 'Done');
  return { fileName, bytes: bytes.length };
};

// ---------------------------------------------------------------------------
// Stems
// ---------------------------------------------------------------------------

async function buildStems(
  song: Song,
  opts: { by: 'stemGroup' | 'track'; wavBits: WavBits; sampleRate: number; includeAudioTracks: boolean; signal: AbortSignal; assets: Record<string, AudioData>; onProgress: (p: number) => void; log: (m: string) => void },
): Promise<{ entries: ZipEntry[]; names: string[] }> {
  // Spread stem groups across render nodes when enabled (Settings → Render nodes); otherwise,
  // or when no node is healthy, this renders on this device exactly like renderStemsAudio.
  const stems = await renderStemsDistributed(song, opts.assets, {
    by: opts.by,
    sampleRate: opts.sampleRate,
    signal: opts.signal,
    onProgress: (p) => opts.onProgress(p * 0.6),
    onPlacement: (pl) => {
      if (pl.where !== 'this device') opts.log(`Stem ${pl.stem} rendered on ${pl.where} in ${(pl.ms / 1000).toFixed(1)} s`);
    },
  });
  throwIfAborted(opts.signal);
  const keys = Object.keys(stems);
  const ordered =
    opts.by === 'stemGroup'
      ? [...STEM_ORDER.filter((g) => keys.includes(g)), ...keys.filter((k) => !STEM_ORDER.includes(k as StemGroup))]
      : [...song.tracks.map((t) => t.id).filter((id) => keys.includes(id)), ...keys.filter((k) => !song.tracks.some((t) => t.id === k))];
  const audioTracks = opts.includeAudioTracks && opts.by === 'stemGroup' ? song.tracks.filter((t) => t.kind === 'audio' && t.clips.length) : [];
  const total = ordered.length + audioTracks.length;
  const entries: ZipEntry[] = [];
  const names: string[] = [];
  let done = 0;
  for (const key of ordered) {
    const audio = stems[key];
    if (!audio || peakOf(audio) < 1e-6) {
      opts.log(`Skipped silent stem “${key}”.`);
      done++;
      continue;
    }
    const base = opts.by === 'stemGroup' ? (STEM_LABEL[key as StemGroup] ?? sanitizeFileName(key, 'Stem')) : song.tracks.some((t) => t.id === key) ? trackFileName(song, key) : sanitizeFileName(key, 'Stem');
    const data = await encodeAudio(audio, { format: 'wav', wavBits: opts.wavBits, signal: opts.signal, consume: true });
    delete stems[key];
    entries.push({ name: `${base}.wav`, data, compress: false });
    names.push(`${base}.wav`);
    done++;
    opts.onProgress(0.6 + (0.4 * done) / Math.max(1, total));
  }
  for (const t of audioTracks) {
    const audio = await renderTrackAudio(song, t.id, { sampleRate: opts.sampleRate, signal: opts.signal, assets: opts.assets });
    const data = await encodeAudio(audio, { format: 'wav', wavBits: opts.wavBits, signal: opts.signal, consume: true });
    const name = `Audio tracks/${trackFileName(song, t.id)}.wav`;
    entries.push({ name, data, compress: false });
    names.push(name);
    done++;
    opts.onProgress(0.6 + (0.4 * done) / Math.max(1, total));
  }
  if (!entries.length) throw new Error('Every stem is silent (are all tracks muted?).');
  entries.push({
    name: 'Stems info.txt',
    data: songInfoText(song, opts.sampleRate, opts.wavBits, [opts.by === 'stemGroup' ? 'Stems (by group, mixer processing and sends included, no master bus):' : 'Stems (one per track):', ...names.map((n) => `  ${n}`)]),
  });
  return { entries, names };
}

const exportStems: TaskHandler<StemsExportInput, ExportResult> = async (ctx) => {
  const { input, signal } = ctx;
  const song = openSong(input.projectId);
  const pm = new ProgressMix((p, m) => ctx.progress(p, m));
  const pStems = pm.part('stems', 9, 'Rendering stems');
  const pZip = pm.part('zip', 1, 'Packaging');
  ctx.log('info', `Stems ${input.by === 'stemGroup' ? 'by group' : 'per track'} at ${input.sampleRate} Hz / ${input.wavBits}-bit`);
  const assets = await collectAssets(song);
  const { entries, names } = await buildStems(song, { ...input, signal, assets, onProgress: pStems, log: (m) => ctx.log('info', m) });
  pZip(0.2);
  const zip = await zipEntries(entries, signal);
  pZip(1);
  const fileName = `${input.fileBase} - Stems.zip`;
  deliverFile(fileName, zip, MIME.zip, { detail: `${names.length} stems · WAV ${input.wavBits}-bit` });
  ctx.progress(1, 'Done');
  return { fileName, bytes: zip.length, files: names };
};

// ---------------------------------------------------------------------------
// DAW interoperability (Reaper bundle, DAWproject)
// ---------------------------------------------------------------------------

const exportDaw: TaskHandler<DawExportInput, ExportResult> = async (ctx) => {
  const { input, signal } = ctx;
  const song = openSong(input.projectId);
  const pm = new ProgressMix((p, m) => ctx.progress(p, m));
  const audioTracks = song.tracks.filter((t) => t.kind === 'audio' && t.clips.length);
  const midiTracks = input.renderMidi ? song.tracks.filter((t) => t.kind === 'midi' && t.notes.length) : [];
  const toRender = [...audioTracks, ...midiTracks];
  const pRender = pm.part('render', toRender.length ? 9 : 0.1, 'Rendering track audio');
  const pPack = pm.part('pack', 1, 'Packaging');
  const assets = await collectAssets(song);
  const audioFiles: { trackId: string; path: string; data: Uint8Array; durationSeconds: number }[] = [];
  let i = 0;
  for (const t of toRender) {
    throwIfAborted(signal);
    const audio = await renderTrackAudio(song, t.id, { sampleRate: input.sampleRate, signal, assets });
    const durationSeconds = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
    const data = await encodeAudio(audio, { format: 'wav', wavBits: input.wavBits, signal, consume: true });
    audioFiles.push({ trackId: t.id, path: `audio/${trackFileName(song, t.id)}.wav`, data, durationSeconds });
    pRender(++i / toRender.length);
    ctx.log('info', `Rendered ${t.name}`);
  }
  pRender(1);
  const custom = lookup();
  let fileName: string;
  let bytes: Uint8Array;
  if (input.target === 'dawproject') {
    bytes = songToDawProject(song, { ...custom, audio: audioFiles.map((f) => ({ trackId: f.trackId, path: f.path, data: f.data, durationSeconds: f.durationSeconds })), application: { name: 'Song Deck', version: '0.1.0' } });
    fileName = `${input.fileBase}.dawproject`;
    deliverFile(fileName, bytes, MIME.dawproject, { detail: `DAWproject · ${song.tracks.length} tracks${audioFiles.length ? ` · ${audioFiles.length} audio files` : ''}` });
  } else {
    const rpp = songToReaperProject(song, { ...custom, audio: audioFiles.map((f) => ({ trackId: f.trackId, path: f.path, durationSeconds: f.durationSeconds })) });
    const dir = input.fileBase;
    const entries: ZipEntry[] = [{ name: `${dir}/${input.fileBase}.rpp`, data: rpp }];
    for (const f of audioFiles) entries.push({ name: `${dir}/${f.path}`, data: f.data, compress: false });
    for (const t of song.tracks.filter((x) => x.kind === 'midi' && x.notes.length)) entries.push({ name: `${dir}/midi/${trackFileName(song, t.id)}.mid`, data: trackToMidi(song, t.id, custom) });
    entries.push({
      name: `${dir}/README.txt`,
      data: songInfoText(song, input.sampleRate, input.wavBits, [
        `Open ${input.fileBase}.rpp in Reaper. MIDI parts are embedded in the project (with section markers and the tempo map);`,
        'audio files referenced by the project are in audio/. The midi/ folder holds each MIDI track as a standard .mid file.',
      ]),
    });
    pPack(0.3);
    bytes = await zipEntries(entries, signal);
    fileName = `${input.fileBase} - Reaper.zip`;
    deliverFile(fileName, bytes, MIME.zip, { detail: `Reaper project · ${song.tracks.length} tracks${audioFiles.length ? ` · ${audioFiles.length} audio files` : ''}` });
  }
  pPack(1);
  ctx.progress(1, 'Done');
  return { fileName, bytes: bytes.length };
};

// ---------------------------------------------------------------------------
// Export everything (spec §73)
// ---------------------------------------------------------------------------

const exportEverything: TaskHandler<EverythingInput, ExportResult> = async (ctx) => {
  const { input, signal } = ctx;
  const song = openSong(input.projectId);
  const st = useStudio.getState();
  const hasVocals = vocalTrackIds(song).length > 0;
  const hasInstrumental = instrumentalTrackIds(song).length > 0;
  const pm = new ProgressMix((p, m) => ctx.progress(p, m));
  const pMaster = pm.part('master', 4, 'Rendering & mastering');
  const pInstr = pm.part('instrumental', hasInstrumental ? 3 : 0, 'Rendering instrumental');
  const pAcap = pm.part('acapella', hasVocals ? 2 : 0, 'Rendering acapella');
  const pStems = pm.part('stems', 6, 'Rendering stems');
  const pRest = pm.part('rest', 1, 'MIDI, MusicXML, project');
  const pZip = pm.part('zip', 2, 'Packaging');
  const log = (m: string) => ctx.log('info', m);
  const wav = (audio: AudioData) => encodeAudio(audio, { format: 'wav', wavBits: input.wavBits, signal, consume: true });
  const assets = await collectAssets(song);
  throwIfAborted(signal);

  // Master / Instrumental / Acapella render concurrently across the job-worker pool.
  const [master, instrumental, acapella] = await Promise.all([
    renderDeliverable(song, 'master', { sampleRate: input.sampleRate, signal, assets, onProgress: pMaster, log }).then(async (r) => ({ label: r.label, bytes: r.existing ?? (await wav(r.audio!)) })),
    hasInstrumental ? renderDeliverable(song, 'instrumental', { sampleRate: input.sampleRate, signal, assets, onProgress: pInstr, log }).then((r) => wav(r.audio!)) : Promise.resolve(null),
    hasVocals ? renderDeliverable(song, 'acapella', { sampleRate: input.sampleRate, signal, assets, onProgress: pAcap, log }).then((r) => wav(r.audio!)) : Promise.resolve(null),
  ]);
  if (!hasVocals) log('No vocal tracks — Acapella.wav skipped.');
  throwIfAborted(signal);

  const stems = await buildStems(song, { by: 'stemGroup', wavBits: input.wavBits, sampleRate: input.sampleRate, includeAudioTracks: true, signal, assets, onProgress: pStems, log });
  const stemsZip = await zipEntries(stems.entries, signal);
  throwIfAborted(signal);

  const custom = lookup();
  const midi = songToMidi(song, custom);
  const xml = songToMusicXML(song, custom);
  const project = await st.exportProjectBytes();
  pRest(1);

  const masterName = master.label === 'Master' ? 'Master.wav' : 'Mix.wav';
  const entries: ZipEntry[] = [{ name: masterName, data: master.bytes, compress: false }];
  if (instrumental) entries.push({ name: 'Instrumental.wav', data: instrumental, compress: false });
  if (acapella) entries.push({ name: 'Acapella.wav', data: acapella, compress: false });
  entries.push({ name: 'Stems.zip', data: stemsZip, compress: false });
  entries.push({ name: 'Song.mid', data: midi });
  entries.push({ name: 'Song.musicxml', data: xml });
  entries.push({ name: `${input.fileBase}.songproject`, data: project, compress: false });
  // Rights & attribution with the upload attestations (docs/RIGHTS.md), when there are any.
  const meta = useStudio.getState().project?.meta;
  if (meta?.attestations?.length) entries.push({ name: 'RIGHTS.txt', data: new TextEncoder().encode(rightsSummaryText(meta)) });
  const listing = entries.map((e) => e.name);
  pZip(0.2);
  const zip = await zipEntries(entries, signal);
  pZip(1);
  if (signal.aborted) throw abortError();
  const fileName = `${input.fileBase} - Export.zip`;
  deliverFile(fileName, zip, MIME.zip, { detail: listing.join(' · ') });
  ctx.log('info', `Delivered ${fileName}: ${listing.join(', ')}`);
  ctx.progress(1, 'Done');
  return { fileName, bytes: zip.length, files: listing };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, TaskHandler<any, any>> = {
  'export.audio': exportAudio,
  'export.stems': exportStems,
  'export.daw': exportDaw,
  'export.everything': exportEverything,
};
