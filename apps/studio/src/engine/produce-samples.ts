import { create } from 'zustand';
import { parseSfz, type AudioData, type SampleInstrument, type SampleZone } from '@songdeck/audio';
import { randomId } from '@songdeck/core';
import { decodeAudioBytes } from '../state/assets';
import { useExtensions } from './plugins';

/**
 * User sample instruments for guide rendering and hybrid production (spec §28 "user soundfonts",
 * "plugin-based instruments"; spec §38 Strategy C "Drums — sampled kit", "Violin — orchestral
 * library"). Instruments are loaded for this session (SFZ + samples, single WAVs, or SFZ files
 * shipped by instrument plugins) and assigned to tracks; renders then use them in place of the
 * built-in patch of those tracks.
 */

export interface SampleInstrumentEntry {
  id: string;
  name: string;
  source: 'file' | 'plugin';
  /** Where it came from (file names / plugin id). */
  origin: string;
  zones: number;
  keyRange: [number, number];
  instrument: SampleInstrument;
}

interface SampleState {
  instruments: SampleInstrumentEntry[];
  /** trackId → instrument id. */
  assignments: Record<string, string>;
  loading: boolean;
  error?: string;
}

export const useSampleInstruments = create<SampleState>(() => ({
  instruments: [],
  assignments: {},
  loading: false,
}));

const NOTE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Root key from a sample file name: "Piano_C4.wav", "violin-A#3.wav", "kick_36.wav". */
export function rootKeyFromName(name: string): number | undefined {
  const base = name.replace(/\.[^.]+$/, '');
  const m = /(?:^|[^a-z])([a-g])([#b]?)(-?\d)(?![0-9])/i.exec(base);
  if (m) {
    let n = NOTE[m[1].toLowerCase()];
    if (m[2] === '#') n += 1;
    if (m[2] === 'b') n -= 1;
    const midi = (parseInt(m[3], 10) + 1) * 12 + n;
    if (midi >= 0 && midi <= 127) return midi;
  }
  const d = /(?:^|[^0-9])(\d{2,3})(?![0-9])/.exec(base);
  if (d) {
    const v = parseInt(d[1], 10);
    if (v >= 12 && v <= 115) return v;
  }
  return undefined;
}

function summarize(inst: SampleInstrument): { zones: number; keyRange: [number, number] } {
  if (!inst.zones.length) return { zones: 0, keyRange: [0, 0] };
  return {
    zones: inst.zones.length,
    keyRange: [Math.min(...inst.zones.map((z) => z.lokey)), Math.max(...inst.zones.map((z) => z.hikey))],
  };
}

/** Multi-sample instrument from loose audio files: each file covers the keys nearest its root. */
export function instrumentFromSamples(
  samples: { name: string; audio: AudioData }[],
  name: string,
): SampleInstrument {
  const rooted = samples
    .map((s, i) => ({ ...s, root: rootKeyFromName(s.name) ?? (samples.length === 1 ? 60 : 48 + i * 2) }))
    .sort((a, b) => a.root - b.root);
  const zones: SampleZone[] = rooted.map((s, i) => {
    const prev = rooted[i - 1];
    const next = rooted[i + 1];
    const lokey = prev ? Math.floor((prev.root + s.root) / 2) + 1 : 0;
    const hikey = next ? Math.floor((s.root + next.root) / 2) : 127;
    return {
      sample: s.audio,
      lokey,
      hikey,
      pitchKeycenter: s.root,
      lovel: 1,
      hivel: 127,
      ampegRelease: 0.12,
    };
  });
  return { name, zones, polyphony: 32 };
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/** Parse SFZ text, loading the samples it references through `load(path)`. */
async function parseSfzWithSamples(
  text: string,
  load: (path: string) => Promise<AudioData | undefined>,
): Promise<SampleInstrument> {
  const wanted = new Set<string>();
  parseSfz(text, (p) => {
    wanted.add(p);
    return undefined;
  });
  const loaded = new Map<string, AudioData | undefined>();
  for (const p of wanted) {
    try {
      loaded.set(p, await load(p));
    } catch {
      loaded.set(p, undefined);
    }
  }
  return parseSfz(text, (p) => loaded.get(p));
}

function addEntry(entry: Omit<SampleInstrumentEntry, 'id' | 'zones' | 'keyRange'>): SampleInstrumentEntry {
  const s = summarize(entry.instrument);
  if (!s.zones) throw new Error(`“${entry.name}” has no playable samples`);
  const full: SampleInstrumentEntry = { ...entry, id: randomId('smp'), ...s };
  useSampleInstruments.setState((st) => ({ instruments: [...st.instruments, full], error: undefined }));
  return full;
}

/** Load an instrument from local files: one .sfz (+ its samples) or loose WAV/FLAC samples. */
export async function loadSampleFiles(files: File[]): Promise<SampleInstrumentEntry> {
  useSampleInstruments.setState({ loading: true, error: undefined });
  try {
    const sfz = files.find((f) => /\.sfz$/i.test(f.name));
    const audioFiles = files.filter((f) => !/\.sfz$/i.test(f.name));
    if (sfz) {
      const byName = new Map<string, File>();
      for (const f of audioFiles) {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        byName.set(norm(rel), f);
        byName.set(norm(f.name), f);
      }
      const instrument = await parseSfzWithSamples(await sfz.text(), async (path) => {
        const p = norm(path);
        const f =
          byName.get(p) ??
          byName.get(p.split('/').pop() ?? p) ??
          [...byName.entries()].find(([k]) => p.endsWith(k))?.[1];
        return f ? decodeAudioBytes(new Uint8Array(await f.arrayBuffer())) : undefined;
      });
      const name = instrument.name || sfz.name.replace(/\.sfz$/i, '');
      return addEntry({
        name,
        source: 'file',
        origin: `${sfz.name}${audioFiles.length ? ` + ${audioFiles.length} samples` : ''}`,
        instrument: { ...instrument, name },
      });
    }
    if (!audioFiles.length)
      throw new Error('Choose an .sfz file with its samples, or one or more WAV/FLAC samples');
    const samples = await Promise.all(
      audioFiles.map(async (f) => ({
        name: f.name,
        audio: await decodeAudioBytes(new Uint8Array(await f.arrayBuffer())),
      })),
    );
    const name =
      audioFiles.length === 1
        ? audioFiles[0].name.replace(/\.[^.]+$/, '')
        : `${audioFiles[0].name.replace(/[_ -]?[a-g][#b]?-?\d.*$/i, '').replace(/\.[^.]+$/, '') || 'Sample set'} (${audioFiles.length} samples)`;
    return addEntry({
      name,
      source: 'file',
      origin: audioFiles.map((f) => f.name).join(', '),
      instrument: instrumentFromSamples(samples, name),
    });
  } catch (err) {
    useSampleInstruments.setState({ error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    useSampleInstruments.setState({ loading: false });
  }
}

export interface PluginSampleInstrument {
  /** Patch id in the plugin registry (`sfz:<plugin>/<instrument>`). */
  patchId: string;
  name: string;
  plugin: string;
  zones: number;
  keyRange: [number, number];
  /** Samples are loaded (the plugin is enabled and its files were served). */
  loaded: boolean;
}

/** Sampled instruments contributed by instrument plugins (spec §57 "Instruments: Soundfonts"). */
export function pluginSampleInstruments(): PluginSampleInstrument[] {
  const ext = useExtensions.getState();
  const byPatch = new Map<string, PluginSampleInstrument>();
  for (const p of ext.instruments) {
    if (!p.patchId?.startsWith('sfz:')) continue;
    const inst = ext.sampleInstruments[p.patchId];
    const s = inst ? summarize(inst) : { zones: 0, keyRange: [0, 0] as [number, number] };
    byPatch.set(p.patchId, {
      patchId: p.patchId,
      name: p.name,
      plugin: p.patchId.slice(4).split('/')[0],
      ...s,
      loaded: !!inst,
    });
  }
  for (const [patchId, inst] of Object.entries(ext.sampleInstruments)) {
    if (byPatch.has(patchId)) continue;
    byPatch.set(patchId, {
      patchId,
      name: inst.name ?? patchId,
      plugin: patchId.slice(4).split('/')[0],
      ...summarize(inst),
      loaded: true,
    });
  }
  return [...byPatch.values()];
}

export function removeSampleInstrument(id: string): void {
  useSampleInstruments.setState((st) => ({
    instruments: st.instruments.filter((i) => i.id !== id),
    assignments: Object.fromEntries(Object.entries(st.assignments).filter(([, v]) => v !== id)),
  }));
}

export function assignSampleInstrument(trackId: string, instrumentId: string | null): void {
  useSampleInstruments.setState((st) => {
    const assignments = { ...st.assignments };
    if (instrumentId) assignments[trackId] = instrumentId;
    else delete assignments[trackId];
    return { assignments };
  });
}

/**
 * Renderer options for assigned sample instruments: patch overrides (trackId → patch id) and the
 * session sample instruments by patch id (plugin sample sets are already known to the render
 * workers). Only tracks in `trackIds` (when given) are considered.
 */
export function sampleRenderOptions(
  assignments: Record<string, string>,
  trackIds?: string[],
): {
  patchOverrides: Record<string, string>;
  sampleInstruments: Record<string, SampleInstrument>;
  used: { trackId: string; name: string }[];
  missing: string[];
} {
  const st = useSampleInstruments.getState();
  const plugin = new Map(pluginSampleInstruments().map((p) => [p.patchId, p]));
  const patchOverrides: Record<string, string> = {};
  const sampleInstruments: Record<string, SampleInstrument> = {};
  const used: { trackId: string; name: string }[] = [];
  const missing: string[] = [];
  for (const [trackId, instId] of Object.entries(assignments)) {
    if (trackIds && !trackIds.includes(trackId)) continue;
    if (instId.startsWith('sfz:')) {
      const p = plugin.get(instId);
      if (!p?.loaded) {
        missing.push(trackId);
        continue;
      }
      patchOverrides[trackId] = instId;
      used.push({ trackId, name: p.name });
      continue;
    }
    const entry = st.instruments.find((i) => i.id === instId);
    if (!entry) {
      missing.push(trackId);
      continue;
    }
    const patchId = `sample:${entry.id}`;
    patchOverrides[trackId] = patchId;
    sampleInstruments[patchId] = entry.instrument;
    used.push({ trackId, name: entry.name });
  }
  return { patchOverrides, sampleInstruments, used, missing };
}

/** Display name of an assignment value (plugin patch id or session instrument id). */
export function sampleInstrumentName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('sfz:')) return pluginSampleInstruments().find((p) => p.patchId === value)?.name;
  return useSampleInstruments.getState().instruments.find((i) => i.id === value)?.name;
}
