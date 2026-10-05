import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type {
  AnalysisRecord,
  GenerationRecord,
  HistoryState,
  Project,
  ProjectMeta,
  Revision,
  Song,
} from '../ir/types';
import { ENGINE_VERSION, PROJECT_FORMAT_VERSION, emptyRights } from '../ir/defaults';
import { randomId } from '../util/ids';
import { sectionLayout } from '../timing';
import { songToMidi, trackToMidi } from '../io/midi';
import { songToLyricSheet } from '../io/sheets';
import { slugify, uniqueNames } from '../io/util';
import { safePackagePath } from './assets';
import { rightsSummaryText } from './rights';

/**
 * `.songproject` package (spec §9): a ZIP containing
 *
 *   project.json                    format marker, ProjectMeta, branches, file index
 *   song.json                       working song (canonical Music IR)
 *   history/revisions.json          revision metadata (no snapshots)
 *   history/snapshots/<revId>.json  one song snapshot per revision
 *   lyrics/<NN>-<section>.txt       lyric lines per section (+ lyric-sheet.txt)      [derived]
 *   midi/song.mid, midi/<track>.mid multitrack and per-track MIDI exports             [derived]
 *   motifs/<id>.json                motif library                                     [derived]
 *   audio/{references,guide-renders,generations,vocals,masters,…}/…, stems/…   asset bytes at AudioAssetMeta.path
 *   analysis/<id>.json, generations/<id>.json
 *   rights/RIGHTS.txt               rights metadata + upload attestations (when there are any)      [derived]
 *
 * Derived files are conveniences for other tools; unpacking reads only the canonical JSON.
 * Credentials are never written: keys such as apiKey/token/secret/password are dropped and
 * API-key-looking strings are redacted from every JSON file.
 */

export const PROJECT_PACKAGE_FORMAT = 'songdeck-project';

export interface PackOptions {
  /** Write derived lyrics/MIDI/motif files (default true). */
  includeDerived?: boolean;
  /** ZIP entry timestamp (default: project.meta.updatedAt, for reproducible packages). */
  mtime?: string | Date | number;
}

const SECRET_KEY =
  /^(api[-_]?key|apikey|x[-_]?api[-_]?key|secret|client[-_]?secret|token|access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|session[-_]?token|bearer|authorization|password|passwd|credentials?|private[-_]?key)$/i;
const SECRET_VALUE =
  /^(?:Bearer\s+\S{8,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|r8_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})$/;

/** Deep copy without credentials (spec §7: no secrets in project files). */
export function scrubSecrets<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return SECRET_VALUE.test(v.trim()) ? '[redacted]' : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_KEY.test(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

const json = (v: unknown, pretty = false) =>
  strToU8(JSON.stringify(scrubSecrets(v), null, pretty ? 2 : undefined));

function fileId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100) || 'item';
}

/** Unique file names for a list of ids. */
function idFiles(dir: string, ids: string[]): string[] {
  const names = uniqueNames(ids.map(fileId));
  return names.map((n) => `${dir}/${n}.json`);
}

const STORED = /\.(wav|mp3|flac|ogg|oga|opus|m4a|aac|aif|aiff|png|jpe?g|webp|zip)$/i;

/** Serialize a project (+ asset bytes keyed by asset id) into a .songproject ZIP. */
export function packProject(
  project: Project,
  assets: Map<string, Uint8Array> = new Map(),
  opts: PackOptions = {},
): Uint8Array {
  if (!project?.meta || !project.song || !project.history) throw new Error('packProject: not a project.');
  const mtime = opts.mtime ?? project.meta.updatedAt ?? '2000-01-01T00:00:00Z';
  const files: Zippable = {};
  const add = (path: string, data: Uint8Array) => {
    files[path] = [data, { level: STORED.test(path) ? 0 : 6, mtime }];
  };
  const revisions = project.history.revisions;
  const snapshotFiles = idFiles(
    'history/snapshots',
    revisions.map((r) => r.id),
  );
  const analysisFiles = idFiles(
    'analysis',
    project.analysis.map((a) => a.id),
  );
  const generationFiles = idFiles(
    'generations',
    project.generations.map((g) => g.id),
  );
  add(
    'project.json',
    json(
      {
        format: PROJECT_PACKAGE_FORMAT,
        formatVersion: project.meta.formatVersion ?? PROJECT_FORMAT_VERSION,
        engineVersion: ENGINE_VERSION,
        meta: project.meta,
        history: { currentBranchId: project.history.currentBranchId, branches: project.history.branches },
        files: { snapshots: snapshotFiles, analysis: analysisFiles, generations: generationFiles },
      },
      true,
    ),
  );
  add('song.json', json(project.song));
  add(
    'history/revisions.json',
    json(
      revisions.map(({ snapshot: _snapshot, ...meta }) => meta),
      true,
    ),
  );
  revisions.forEach((r, i) => add(snapshotFiles[i], json(r.snapshot)));
  project.analysis.forEach((a, i) => add(analysisFiles[i], json(a, true)));
  project.generations.forEach((g, i) => add(generationFiles[i], json(g, true)));

  if (opts.includeDerived !== false) {
    addDerived(project.song, add);
    if (project.meta.attestations?.length) add('rights/RIGHTS.txt', strToU8(rightsSummaryText(project.meta)));
  }

  for (const meta of project.meta.assets) {
    const bytes = assets.get(meta.id);
    if (!bytes) continue;
    const path = safePackagePath(meta.path);
    if (!path || path === 'project.json' || path === 'song.json' || path.startsWith('history/')) continue;
    add(path, bytes);
  }
  return zipSync(files);
}

function addDerived(song: Song, add: (path: string, data: Uint8Array) => void) {
  const spans = sectionLayout(song);
  const sectionNames = uniqueNames(
    spans.map((s, i) => `${String(i + 1).padStart(2, '0')}-${slugify(s.section.name, 'section')}`),
  );
  spans.forEach((s, i) => {
    const lines = song.lyrics.filter((l) => l.sectionId === s.section.id).map((l) => l.text);
    if (lines.length) add(`lyrics/${sectionNames[i]}.txt`, strToU8(lines.join('\n') + '\n'));
  });
  if (song.lyrics.length || song.tracks.some((t) => t.notes.some((n) => n.syllable)))
    add('lyrics/lyric-sheet.txt', strToU8(songToLyricSheet(song)));
  const midiTracks = song.tracks.filter((t) => t.kind === 'midi');
  if (midiTracks.length) {
    try {
      add('midi/song.mid', songToMidi(song));
      const names = uniqueNames(['song', ...midiTracks.map((t) => slugify(t.name, 'track'))]).slice(1);
      midiTracks.forEach((t, i) => add(`midi/${names[i]}.mid`, trackToMidi(song, t.id)));
    } catch {
      /* derived files are best-effort */
    }
  }
  const motifNames = idFiles(
    'motifs',
    song.motifs.map((m) => m.id),
  );
  song.motifs.forEach((m, i) => add(motifNames[i], strToU8(JSON.stringify(m, null, 2))));
}

function parseJson<T>(files: Record<string, Uint8Array>, path: string): T {
  const data = files[path];
  if (!data) throw new Error(`Invalid .songproject: missing ${path}.`);
  try {
    return JSON.parse(strFromU8(data)) as T;
  } catch (e) {
    throw new Error(
      `Invalid .songproject: ${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
}

function isSongLike(v: unknown): v is Song {
  const s = v as Song;
  return (
    !!s &&
    typeof s === 'object' &&
    Array.isArray(s.tracks) &&
    Array.isArray(s.sections) &&
    Array.isArray(s.tempoMap)
  );
}

function completeMeta(meta: Partial<ProjectMeta>): ProjectMeta {
  if (!meta || typeof meta !== 'object' || typeof meta.id !== 'string')
    throw new Error('Invalid .songproject: project metadata is missing.');
  const now = new Date().toISOString();
  const out = { ...meta } as ProjectMeta;
  out.name ??= 'Untitled project';
  out.formatVersion ??= PROJECT_FORMAT_VERSION;
  out.createdAt ??= now;
  out.updatedAt ??= out.createdAt;
  out.rights ??= emptyRights();
  out.assets ??= [];
  out.provenance ??= [];
  out.voices ??= [];
  out.providersUsed ??= [];
  out.customGenres ??= [];
  out.customInstruments ??= [];
  out.settings ??= { neverUpload: [] };
  return out;
}

/** Read a .songproject package. Validates the format version; tolerant of missing optional folders. */
export function unpackProject(bytes: Uint8Array): { project: Project; assets: Map<string, Uint8Array> } {
  // Match the server's upload ceiling, and inspect the entire directory before allocating
  // decompressed data. A small ZIP can otherwise expand into gigabytes in the browser.
  const maxBytes = 1024 * 1024 * 1024;
  const tooLarge = new Error('Project package exceeds the limit of 1 GiB or 10,000 entries.');
  if (bytes.byteLength > maxBytes) throw tooLarge;
  let files: Record<string, Uint8Array>;
  try {
    let expanded = 0;
    let entries = 0;
    unzipSync(bytes, {
      filter(entry) {
        expanded += entry.originalSize;
        if (++entries > 10_000 || expanded > maxBytes) throw tooLarge;
        return false;
      },
    });
    files = unzipSync(bytes);
  } catch (err) {
    if (err === tooLarge) throw err;
    throw new Error('Not a .songproject package (invalid ZIP data).');
  }
  if (!files['project.json']) throw new Error('Not a .songproject package (project.json is missing).');
  const header = parseJson<{
    format?: string;
    formatVersion?: number;
    meta?: Partial<ProjectMeta>;
    history?: { currentBranchId?: string; branches?: HistoryState['branches'] };
    files?: { snapshots?: string[]; analysis?: string[]; generations?: string[] };
  }>(files, 'project.json');
  if (header.format !== undefined && header.format !== PROJECT_PACKAGE_FORMAT)
    throw new Error(`Not a .songproject package (format "${header.format}").`);
  const version = header.formatVersion ?? header.meta?.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new Error('Invalid .songproject: unknown format version.');
  if (version > PROJECT_FORMAT_VERSION) {
    throw new Error(
      `This project was saved by a newer version of Song Deck (format ${version}; this version reads up to ${PROJECT_FORMAT_VERSION}).`,
    );
  }
  const meta = completeMeta(header.meta ?? {});

  // --- history -------------------------------------------------------------------------------
  let song: Song | undefined = files['song.json'] ? parseJson<Song>(files, 'song.json') : undefined;
  if (song !== undefined && !isSongLike(song))
    throw new Error('Invalid .songproject: song.json is not a song.');
  let revisions: Revision[] = [];
  let branches = header.history?.branches ?? [];
  let currentBranchId = header.history?.currentBranchId;
  if (files['history/revisions.json']) {
    const metas = parseJson<Omit<Revision, 'snapshot'>[]>(files, 'history/revisions.json');
    if (!Array.isArray(metas)) throw new Error('Invalid .songproject: history/revisions.json is not a list.');
    const listed = header.files?.snapshots;
    metas.forEach((m, i) => {
      const path = listed?.[i] ?? `history/snapshots/${fileId(m.id)}.json`;
      if (!files[path]) return;
      const snapshot = parseJson<Song>(files, path);
      if (isSongLike(snapshot)) revisions.push({ ...m, snapshot });
    });
    if (revisions.length < metas.length)
      revisions = repairHistory(revisions, metas, (b) => (branches = b), branches);
  }
  if (!revisions.length) {
    if (!song) throw new Error('Invalid .songproject: no song data found.');
    const branchId = randomId('br');
    const revId = randomId('rev');
    revisions = [
      {
        id: revId,
        number: 1,
        parents: [],
        branchId,
        message: 'Imported project',
        kind: 'import',
        createdAt: meta.updatedAt,
        snapshot: song,
      },
    ];
    branches = [{ id: branchId, name: 'Main', headRevisionId: revId, createdAt: meta.updatedAt }];
    currentBranchId = branchId;
  }
  const ids = new Set(revisions.map((r) => r.id));
  branches = branches.filter((b) => ids.has(b.headRevisionId));
  if (!branches.length) {
    const last = revisions[revisions.length - 1];
    branches = [{ id: randomId('br'), name: 'Main', headRevisionId: last.id, createdAt: meta.updatedAt }];
  }
  if (!currentBranchId || !branches.some((b) => b.id === currentBranchId)) currentBranchId = branches[0].id;
  if (!song) {
    const branch = branches.find((b) => b.id === currentBranchId)!;
    song = revisions.find((r) => r.id === branch.headRevisionId)!.snapshot;
  }

  // --- records -------------------------------------------------------------------------------
  const readDir = <T>(dir: string, listed: string[] | undefined): T[] => {
    const paths = listed?.filter((p) => files[p]) ?? [];
    const extra = Object.keys(files)
      .filter(
        (p) =>
          p.startsWith(`${dir}/`) && p.endsWith('.json') && p.split('/').length === 2 && !paths.includes(p),
      )
      .sort();
    return [...paths, ...extra].map((p) => parseJson<T>(files, p));
  };
  const analysis = readDir<AnalysisRecord>('analysis', header.files?.analysis);
  const generations = readDir<GenerationRecord>('generations', header.files?.generations);

  const assets = new Map<string, Uint8Array>();
  for (const a of meta.assets) {
    const data = files[safePackagePath(a.path)];
    if (data) assets.set(a.id, data);
  }
  return {
    project: { meta, song, history: { revisions, branches, currentBranchId }, analysis, generations },
    assets,
  };
}

/** Drop revisions whose snapshots are missing; re-point parents and branch heads at surviving ancestors. */
function repairHistory(
  kept: Revision[],
  all: Omit<Revision, 'snapshot'>[],
  setBranches: (b: HistoryState['branches']) => void,
  branches: HistoryState['branches'],
): Revision[] {
  const byId = new Map(all.map((r) => [r.id, r] as const));
  const keptIds = new Set(kept.map((r) => r.id));
  const survivor = (id: string, seen = new Set<string>()): string | undefined => {
    if (keptIds.has(id)) return id;
    if (seen.has(id)) return undefined;
    seen.add(id);
    const r = byId.get(id);
    for (const p of r?.parents ?? []) {
      const s = survivor(p, seen);
      if (s) return s;
    }
    return undefined;
  };
  const out = kept.map((r) => ({
    ...r,
    parents: [...new Set(r.parents.map((p) => survivor(p)).filter((p): p is string => !!p && p !== r.id))],
  }));
  const repaired: HistoryState['branches'] = [];
  for (const b of branches) {
    const head = survivor(b.headRevisionId);
    if (!head) continue;
    const next = { ...b, headRevisionId: head };
    const base = b.baseRevisionId ? survivor(b.baseRevisionId) : undefined;
    if (base) next.baseRevisionId = base;
    else delete next.baseRevisionId;
    repaired.push(next);
  }
  setBranches(repaired);
  return out;
}
