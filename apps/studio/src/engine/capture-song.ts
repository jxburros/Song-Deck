import {
  ENGINE_VERSION,
  assetPathFor,
  barToTick,
  createEmptySong,
  defaultChannelStrip,
  diffSongs,
  getInstrument,
  keyAtTick,
  noteToOpNote,
  randomId,
  sectionLayout,
  sortNotes,
  type AnalysisRecord,
  type AssetKind,
  type AudioAssetMeta,
  type InstrumentProfile,
  type KeySignature,
  type MusicOperation,
  type MusicalFunction,
  type Note,
  type OpNote,
  type Proposal,
  type ProvenanceRecord,
  type ProvenanceSource,
  type Song,
  type Track,
  type TrackRole,
} from '@songdeck/core';
import type { RunProvenance } from '@songdeck/ai';
import { useStudio } from '../state/store';
import { useSettings } from '../state/settings';
import { propose, type ProposalMeta } from './proposals';
import { colorForRole } from '../views/workbench/SidePanel';
import { extensionFor, slugify } from './capture-files';

/**
 * Turning captured / generated / rebuilt material into project material:
 *  - stand-alone "idea" songs (new project, MIDI export, previews)
 *  - reviewable proposals against the open project (spec §21): new track, or `replace_notes`
 *    for phrase substitution (spec §73 "the user substitutes that phrase")
 *  - asset, provenance (§64) and analysis records for the source audio.
 */

export const DSP_PROVIDER = { id: 'songdeck-dsp', name: 'On-device DSP (Song Deck audio engine)' } as const;
export const COMPOSER_PROVIDER = {
  id: 'internal',
  name: 'On-device composer (Song Deck music engine)',
} as const;

export function uniqueTrackName(song: Pick<Song, 'tracks'>, name: string): string {
  const names = new Set(song.tracks.map((t) => t.name.toLowerCase()));
  if (!names.has(name.toLowerCase())) return name;
  for (let i = 2; i < 1000; i++) {
    const c = `${name} ${i}`;
    if (!names.has(c.toLowerCase())) return c;
  }
  return `${name} (new)`;
}

/** Semitone shift (−6..+5) that moves `from`'s tonic onto `to`'s tonic by the shortest route. */
export function transposeBetween(from: KeySignature, to: KeySignature): number {
  let d = (((to.tonic - from.tonic) % 12) + 12) % 12;
  if (d > 6) d -= 12;
  return d;
}

export interface IdeaSongOptions {
  title: string;
  bpm: number;
  meter: { numerator: number; denominator: number };
  key: KeySignature;
  notes: Note[];
  instrumentId: string;
  role?: TrackRole;
  fn?: MusicalFunction;
  trackName?: string;
  /** Total bars (default: enough to hold the notes). */
  bars?: number;
  sectionName?: string;
  origin?: string;
  customInstruments?: InstrumentProfile[];
}

export function makeMidiTrack(
  inst: InstrumentProfile,
  opts: {
    name: string;
    role?: TrackRole;
    fn?: MusicalFunction;
    notes: Note[];
    origin?: string;
    params?: Record<string, unknown>;
  },
): Track {
  const role = opts.role ?? inst.defaultRole;
  return {
    id: randomId('trk'),
    name: opts.name,
    kind: 'midi',
    role,
    instrumentId: inst.id,
    constraints: opts.fn ? { function: opts.fn } : {},
    notes: sortNotes(opts.notes.map((n) => ({ ...n }))),
    clips: [],
    color: colorForRole(role),
    stemGroup: inst.stemGroup,
    midiChannel: inst.isDrumKit ? 9 : 0,
    ...(role === 'vocal' ? { vocal: { mode: 'melody-only' as const } } : {}),
    ...(opts.origin ? { generator: { id: opts.origin, params: opts.params } } : {}),
  };
}

/** A one-section song holding a single captured idea (new project / MIDI export). */
export function buildIdeaSong(o: IdeaSongOptions): Song {
  const song = createEmptySong({
    title: o.title,
    bpm: Math.round(o.bpm * 100) / 100,
    meter: o.meter,
    key: o.key,
  });
  const barTicks = barToTick(song, 1);
  const last = o.notes.reduce((m, n) => Math.max(m, n.tick + n.duration), 0);
  const bars = Math.max(1, o.bars ?? Math.ceil(last / barTicks - 1e-9));
  song.sections = [{ id: randomId('sec'), name: o.sectionName ?? 'Idea', kind: 'verse', bars, energy: 60 }];
  const inst = getInstrument(o.instrumentId, o.customInstruments);
  const track = makeMidiTrack(inst, {
    name: o.trackName ?? inst.name,
    role: o.role,
    fn: o.fn,
    notes: o.notes,
    origin: o.origin,
  });
  song.tracks = [track];
  song.mixer = { ...song.mixer, channels: { ...song.mixer.channels, [track.id]: defaultChannelStrip() } };
  return song;
}

export type InsertMode = 'new-track' | 'replace';

export interface InsertRequest {
  mode: InsertMode;
  /** The project song the proposal is made against. */
  song: Song;
  /** Material in its own timeline (tick 0 = its bar 1), same PPQ as the project. */
  notes: Note[];
  /** Use only material in this source range (ticks); default: everything. */
  sourceStartTick?: number;
  sourceEndTick?: number;
  /** 1-based target bar where the material (or the source range) starts. */
  targetBar: number;
  /** Replace: inclusive 1-based last bar of the replaced region. */
  endBar?: number;
  /** Replace: target track id. */
  trackId?: string;
  /** New track: name / instrument / role / function. */
  trackName?: string;
  instrumentId?: string;
  role?: TrackRole;
  fn?: MusicalFunction;
  /** Semitones added to every pitch (e.g. to match the project key). */
  transpose?: number;
  /** Replace on a vocal track: re-use the replaced notes' lyric syllables in order. */
  keepSyllables?: boolean;
  meta: ProposalMeta;
}

function shifted(req: InsertRequest): Note[] {
  const offset = barToTick(req.song, Math.max(0, req.targetBar - 1)) - (req.sourceStartTick ?? 0);
  const t0 = req.sourceStartTick ?? -Infinity;
  const t1 = req.sourceEndTick ?? Infinity;
  return req.notes
    .filter((n) => n.tick >= t0 && n.tick < t1)
    .map((n) => {
      const out: Note = {
        ...n,
        tick: n.tick + offset,
        pitch: Math.max(0, Math.min(127, n.pitch + (req.transpose ?? 0))),
      };
      if (req.sourceEndTick !== undefined && n.tick + n.duration > t1)
        out.duration = Math.max(1, t1 - n.tick);
      return out;
    });
}

/** Build the structured operations for an insertion (exposed for tests and the UI preview). */
export function insertOperations(req: InsertRequest): {
  ops: MusicOperation[];
  trackRef: string;
  notes: Note[];
} {
  const notes = sortNotes(shifted(req));
  if (req.mode === 'new-track') {
    const inst = getInstrument(req.instrumentId ?? 'piano', useSettings.getState().customInstruments);
    const name = uniqueTrackName(req.song, req.trackName?.trim() || inst.name);
    const opNotes: OpNote[] = notes.map((n) => noteToOpNote(req.song, n));
    return {
      ops: [
        {
          op: 'add_track',
          name,
          instrument_id: inst.id,
          role: req.role ?? inst.defaultRole,
          function: req.fn,
          reason: req.meta.title,
        },
        { op: 'add_notes', track: name, notes: opNotes, reason: req.meta.title },
      ],
      trackRef: name,
      notes,
    };
  }
  const track = req.song.tracks.find((t) => t.id === req.trackId);
  if (!track) throw new Error('Choose a MIDI track to replace a phrase in.');
  const start = barToTick(req.song, req.targetBar - 1);
  const end = barToTick(req.song, Math.max(req.targetBar, req.endBar ?? req.targetBar));
  const inRegion = notes.filter((n) => n.tick >= start && n.tick < end);
  let opNotes: OpNote[] = inRegion.map((n) => noteToOpNote(req.song, n));
  if (req.keepSyllables) {
    const old = track.notes
      .filter((n) => n.tick >= start && n.tick < end && n.syllable)
      .sort((a, b) => a.tick - b.tick);
    if (old.length)
      opNotes = opNotes.map((o, i) => (old[i]?.syllable ? { ...o, syllable: old[i].syllable } : o));
  }
  return {
    ops: [
      {
        op: 'replace_notes',
        track: track.id,
        region: { start_bar: req.targetBar, end_bar: Math.max(req.targetBar, req.endBar ?? req.targetBar) },
        notes: opNotes,
        reason: req.meta.title,
      },
    ],
    trackRef: track.id,
    notes: inRegion,
  };
}

/**
 * Create a reviewable proposal (spec §21) for the insertion and open it in the piano roll.
 * Structured ops carry no per-note confidence/origin, so those are restored on the proposed
 * notes afterwards (the piano roll marks low-confidence notes).
 */
export function proposeInsertion(req: InsertRequest): Proposal | null {
  const { ops, trackRef, notes } = insertOperations(req);
  if (!notes.length) {
    useStudio.getState().toast('warning', 'There are no notes in the selected range to insert.');
    return null;
  }
  const p = propose(req.song, ops, req.meta, { openPianoRoll: true });
  if (!p) return null;
  const after: Song = { ...p.after, tracks: p.after.tracks.map((t) => ({ ...t })) };
  const target = after.tracks.find((t) => t.id === trackRef) ?? after.tracks.find((t) => t.name === trackRef);
  if (target) {
    const pool = new Map<string, Note[]>();
    for (const n of notes) {
      const k = `${n.tick}|${n.pitch}`;
      pool.set(k, [...(pool.get(k) ?? []), n]);
    }
    const byClass = new Map<string, Note[]>();
    for (const n of notes) {
      const k = `${n.tick}|${n.pitch % 12}`;
      byClass.set(k, [...(byClass.get(k) ?? []), n]);
    }
    target.notes = target.notes.map((n) => {
      const src =
        pool.get(`${n.tick}|${n.pitch}`)?.shift() ?? byClass.get(`${n.tick}|${n.pitch % 12}`)?.shift();
      if (!src) return n;
      const out: Note = { ...n };
      if (src.confidence !== undefined) out.confidence = src.confidence;
      if (src.origin) out.origin = src.origin;
      return out;
    });
    useStudio.setState((s) => ({
      proposals: s.proposals.map((x) =>
        x.id === p.id ? { ...x, after, diff: diffSongs(x.before, after) } : x,
      ),
    }));
    const st = useStudio.getState();
    st.selectTrack(target.id);
    st.setWorkbenchView('piano-roll');
  } else useStudio.getState().setMode('workbench');
  return useStudio.getState().proposals.find((x) => x.id === p.id) ?? p;
}

// ---------------------------------------------------------------------------------------------
// Project context helpers
// ---------------------------------------------------------------------------------------------

export interface SectionChoice {
  id: string;
  name: string;
  startBar: number; // 1-based
  bars: number;
}

export function sectionChoices(song: Song): SectionChoice[] {
  return sectionLayout(song).map((s) => ({
    id: s.section.id,
    name: s.section.name,
    startBar: s.startBar + 1,
    bars: s.endBar - s.startBar,
  }));
}

export function songBars(song: Song): number {
  return song.sections.reduce((a, s) => a + s.bars, 0);
}

export function keyAtBar1(song: Song, bar1: number): KeySignature {
  return keyAtTick(song, barToTick(song, Math.max(0, bar1 - 1)));
}

// ---------------------------------------------------------------------------------------------
// Assets, provenance, analysis records
// ---------------------------------------------------------------------------------------------

export function makeAssetMeta(o: {
  name: string;
  kind: AssetKind;
  mimeType: string;
  bytes: Uint8Array;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  id?: string;
  provenanceId?: string;
}): AudioAssetMeta {
  const id = o.id ?? randomId('asset');
  return {
    id,
    name: o.name,
    kind: o.kind,
    path: assetPathFor(
      o.kind,
      `${slugify(o.name, o.kind)}-${id.slice(-6)}.${extensionFor(o.mimeType, 'wav')}`,
    ),
    mimeType: o.mimeType,
    sampleRate: o.sampleRate,
    channels: o.channels,
    durationSeconds: Math.round(o.durationSeconds * 1000) / 1000,
    bytes: o.bytes.byteLength,
    createdAt: new Date().toISOString(),
    provenanceId: o.provenanceId,
  };
}

export function makeProvenance(o: {
  artifactId: string;
  artifactName: string;
  artifactKind: ProvenanceRecord['artifactKind'];
  sources: ProvenanceSource[];
  provider?: { id: string; name: string };
  /** Orchestrator provenance of a provider run (provider, model, cloud flag, cost). */
  run?: RunProvenance;
  parameters?: Record<string, unknown>;
  seed?: number;
  taskId?: string;
  modelId?: string;
}): ProvenanceRecord {
  const provider = o.run ? { id: o.run.providerId, name: o.run.providerName } : (o.provider ?? DSP_PROVIDER);
  const rec: ProvenanceRecord = {
    id: randomId('prov'),
    artifactId: o.artifactId,
    artifactName: o.artifactName,
    artifactKind: o.artifactKind,
    sources: o.sources,
    providerId: provider.id,
    providerName: provider.name,
    modelId: o.run?.modelId ?? o.modelId,
    seed: o.seed,
    parameters: o.parameters,
    engineVersion: ENGINE_VERSION,
    taskId: o.taskId,
    generatedAt: o.run?.finishedAt ?? new Date().toISOString(),
    cloud: o.run?.cloud ?? false,
  };
  if (o.run?.costUsd !== undefined) rec.costUsd = o.run.costUsd;
  return rec;
}

export function makeAnalysisRecord(o: {
  kind: AnalysisRecord['kind'];
  summary: string;
  confidence?: number;
  sourceAssetId?: string;
  data: unknown;
}): AnalysisRecord {
  return {
    id: randomId('an'),
    kind: o.kind,
    createdAt: new Date().toISOString(),
    sourceAssetId: o.sourceAssetId,
    summary: o.summary,
    confidence: o.confidence,
    data: o.data,
  };
}

export function pushAnalysis(record: AnalysisRecord) {
  useStudio.getState().updateProject((p) => ({ ...p, analysis: [...p.analysis, record] }));
}
