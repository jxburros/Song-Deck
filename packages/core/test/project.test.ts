import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  addAnalysisRecord,
  addAsset,
  addGenerationRecord,
  addProvenance,
  assetPathFor,
  branchLog,
  canRedo,
  canUndo,
  commitRevision,
  compareRevisions,
  createBranch,
  currentBranch,
  deleteBranch,
  duplicateProject,
  headRevision,
  mergeSelected,
  mergeSongs,
  packProject,
  provenanceFor,
  recordProviderUse,
  redoRevision,
  removeAsset,
  renameBranch,
  restoreRevision,
  sanitizeAssetFileName,
  scrubSecrets,
  stepHistory,
  switchBranch,
  undoRevision,
  undoTarget,
  unpackProject,
  updateRights,
} from '../src/project';
import { applyOperations } from '../src/edit';
import { createProject } from '../src/ir/defaults';
import { cloneSong } from '../src/ir/song-utils';
import { LockKeys } from '../src/locks';
import { IdFactory } from '../src/util/ids';
import type { AudioAssetMeta, MusicOperation, Project, Song } from '../src/ir/types';
import { makeSong, notesInBars, TICKS } from './edit-fixtures';

const { BAR } = TICKS;
let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 3, 12, 0, clock++)).toISOString();

function edit(song: Song, ops: unknown[]): Song {
  const r = applyOperations(song, ops as MusicOperation[], { ids: new IdFactory(5, 'proj') });
  expect(r.skipped).toBe(0);
  return r.song;
}

function newProject(): Project {
  const p = createProject('Demo', makeSong());
  return p;
}

const bass = (s: Song) => s.tracks.find((t) => t.id === 'trk_bass')!;

describe('version history', () => {
  it('commits revisions on the current branch', () => {
    const p0 = newProject();
    const v1 = headRevision(p0);
    expect(v1).toMatchObject({ number: 1, kind: 'create', parents: [] });
    const song2 = edit(p0.song, [{ op: 'set_tempo', bpm: 150 }]);
    const p1 = commitRevision(p0, song2, 'Faster', 'edit', 'alice', {
      now: '2026-10-03T10:00:00.000Z',
      id: 'rev_2',
    });
    expect(p0.history.revisions).toHaveLength(1); // immutable
    const v2 = headRevision(p1);
    expect(v2).toMatchObject({
      id: 'rev_2',
      number: 2,
      parents: [v1.id],
      branchId: p0.history.currentBranchId,
      message: 'Faster',
      kind: 'edit',
      author: 'alice',
    });
    expect(p1.meta.updatedAt).toBe('2026-10-03T10:00:00.000Z');
    expect(p1.song).toBe(song2);
    // The snapshot is a copy: later mutation of the working song does not alter history.
    p1.song.tempoMap[0].bpm = 1;
    expect(v2.snapshot.tempoMap[0].bpm).toBe(150);
    expect(branchLog(p1).map((r) => r.number)).toEqual([2, 1]);
  });

  it('restores an old revision as a new revision', () => {
    let p = newProject();
    p = commitRevision(p, edit(p.song, [{ op: 'set_tempo', bpm: 150 }]), 'Faster', 'edit');
    p = commitRevision(p, edit(p.song, [{ op: 'set_tempo', bpm: 170 }]), 'Even faster', 'edit');
    const v1 = p.history.revisions[0];
    p = restoreRevision(p, v1.id);
    const head = headRevision(p);
    expect(head).toMatchObject({ number: 4, kind: 'restore', message: 'Restored v1' });
    expect(head.snapshot).toEqual(v1.snapshot);
    expect(head.snapshot).not.toBe(v1.snapshot);
    expect(p.song.tempoMap[0].bpm).toBe(120);
    expect(p.history.revisions).toHaveLength(4);
    expect(() => restoreRevision(p, 'nope')).toThrow(/Unknown revision/);
  });

  it('branches, switches, renames and deletes branches', () => {
    let p = newProject();
    const main = currentBranch(p).id;
    p = commitRevision(p, edit(p.song, [{ op: 'set_tempo', bpm: 130 }]), 'v2', 'edit');
    const v2 = headRevision(p);
    p = createBranch(p, 'Heavy Version', undefined, 'Distorted guitars', { id: 'br_heavy' });
    expect(currentBranch(p)).toMatchObject({
      id: 'br_heavy',
      name: 'Heavy Version',
      headRevisionId: v2.id,
      baseRevisionId: v2.id,
      description: 'Distorted guitars',
    });
    p = commitRevision(p, edit(p.song, [{ op: 'set_tempo', bpm: 180 }]), 'Heavy tempo', 'edit');
    expect(headRevision(p).branchId).toBe('br_heavy');
    expect(headRevision(p, main).id).toBe(v2.id);
    p = switchBranch(p, main);
    expect(p.song.tempoMap[0].bpm).toBe(130);
    p = createBranch(p, 'Heavy Version', p.history.revisions[0].id);
    expect(currentBranch(p).name).toBe('Heavy Version (2)');
    expect(p.song.tempoMap[0].bpm).toBe(120);
    const acoustic = currentBranch(p).id;
    p = renameBranch(p, acoustic, 'Acoustic');
    expect(currentBranch(p).name).toBe('Acoustic');
    expect(() => deleteBranch(p, acoustic)).toThrow(/current branch/);
    p = switchBranch(p, 'br_heavy');
    const before = p.history.revisions.length;
    p = commitRevision(
      switchBranch(p, acoustic),
      edit(p.song, [{ op: 'set_tempo', bpm: 90 }]),
      'acoustic edit',
      'edit',
    );
    expect(p.history.revisions).toHaveLength(before + 1);
    p = switchBranch(p, main);
    p = deleteBranch(p, acoustic);
    expect(p.history.branches.map((b) => b.name)).toEqual(['Main', 'Heavy Version']);
    expect(p.history.revisions).toHaveLength(before); // the acoustic-only revision was dropped
    p = deleteBranch(p, 'br_heavy');
    expect(() => deleteBranch(p, main)).toThrow(/last branch/);
  });

  it('undo / redo move the branch head without deleting revisions', () => {
    let p = newProject();
    p = commitRevision(p, edit(p.song, [{ op: 'set_tempo', bpm: 130 }]), 'v2', 'edit');
    p = commitRevision(p, edit(p.song, [{ op: 'set_tempo', bpm: 140 }]), 'v3', 'edit');
    expect(canRedo(p)).toBe(false);
    p = undoRevision(p);
    expect(headRevision(p).number).toBe(2);
    expect(p.song.tempoMap[0].bpm).toBe(130);
    expect(p.history.revisions).toHaveLength(3);
    p = undoRevision(p);
    expect(headRevision(p).number).toBe(1);
    expect(canUndo(p)).toBe(false);
    expect(undoRevision(p)).toBe(p);
    p = redoRevision(p);
    expect(headRevision(p).number).toBe(2);
    p = redoRevision(p);
    expect(headRevision(p).number).toBe(3);
    p = stepHistory(stepHistory(p, 'undo'), 'undo');
    // New work after undo: v4's parent is v1; the undone v2/v3 can no longer be redone from v4…
    p = commitRevision(p, edit(p.song, [{ op: 'set_tempo', bpm: 99 }]), 'v4', 'edit');
    expect(headRevision(p).parents).toEqual([p.history.revisions[0].id]);
    expect(canRedo(p)).toBe(false);
    // …and undoing v4 makes v4 (the newest child) the redo target.
    p = undoRevision(p);
    expect(headRevision(p).number).toBe(1);
    expect(redoRevision(p).song.tempoMap[0].bpm).toBe(99);
    // Undo never crosses a branch's base revision.
    p = createBranch(p, 'Alt');
    expect(undoTarget(p)).toBeUndefined();
    p = commitRevision(p, edit(p.song, [{ op: 'set_tempo', bpm: 111 }]), 'alt', 'edit');
    expect(undoTarget(p)?.number).toBe(1);
    p = undoRevision(p);
    expect(canUndo(p)).toBe(false);
    expect(redoRevision(p).song.tempoMap[0].bpm).toBe(111);
  });

  it('compares revisions', () => {
    let p = newProject();
    p = commitRevision(
      p,
      edit(p.song, [
        {
          op: 'transform_notes',
          track: 'bass',
          region: { start_bar: 17, end_bar: 20 },
          transform: { transpose: 12 },
        },
      ]),
      'Bass up',
      'edit',
    );
    const [v1, v2] = p.history.revisions;
    expect(compareRevisions(p, v1.id, v2.id).summary).toEqual(['Bass: 16 notes modified (bars 17–20)']);
    expect(compareRevisions(p, v2.id, v2.id).summary).toEqual(['No changes']);
  });

  it('duplicates a project with new ids', () => {
    let p = newProject();
    p = commitRevision(p, edit(p.song, [{ op: 'set_tempo', bpm: 130 }]), 'v2', 'edit');
    p = createBranch(p, 'Alt');
    p = addGenerationRecord(p, {
      id: 'gen_1',
      kind: 'composition',
      createdAt: at(),
      providerId: 'internal',
      status: 'succeeded',
      revisionId: p.history.revisions[1].id,
    });
    const d = duplicateProject(p, 'Demo (copy)');
    expect(d.meta.name).toBe('Demo (copy)');
    expect(d.meta.id).not.toBe(p.meta.id);
    expect(d.song.id).not.toBe(p.song.id);
    const oldIds = new Set([...p.history.revisions.map((r) => r.id), ...p.history.branches.map((b) => b.id)]);
    for (const r of d.history.revisions) {
      expect(oldIds.has(r.id)).toBe(false);
      for (const parent of r.parents) expect(d.history.revisions.some((x) => x.id === parent)).toBe(true);
      expect(d.history.branches.some((b) => b.id === r.branchId)).toBe(true);
      expect(r.snapshot.id).toBe(d.song.id);
    }
    expect(currentBranch(d).name).toBe('Alt');
    expect(headRevision(d).number).toBe(2);
    expect(d.generations[0].revisionId).toBe(d.history.revisions[1].id);
    expect(d.song.tracks).toEqual(p.song.tracks);
  });
});

describe('merge selected changes', () => {
  function heavy(): { p: Project; main: string; heavyRev: string } {
    let p = newProject();
    const main = currentBranch(p).id;
    p = createBranch(p, 'Heavy');
    p = commitRevision(
      p,
      edit(p.song, [
        { op: 'transform_notes', track: 'bass', transform: { transpose: 12 } },
        { op: 'transform_notes', track: 'drums', transform: { velocity_add: 10 } },
        {
          op: 'set_chords',
          region: { start_bar: 13, end_bar: 13 },
          chords: [{ bar: 13, beat: 1, symbol: 'Am', duration_beats: 4 }],
        },
        { op: 'set_mixer', track: 'bass', changes: { volumeDb: -1 } },
        { op: 'set_tempo', bpm: 170 },
        { op: 'set_lyrics', section: 'Chorus', lines: ['Louder now'] },
        { op: 'add_track', name: 'Lead Guitar', instrument_id: 'electric-guitar-lead', role: 'lead-guitar' },
        {
          op: 'add_notes',
          track: 'Lead Guitar',
          notes: [{ pitch: 'E4', bar: 13, beat: 1, duration_beats: 4 }],
        },
      ]),
      'Heavier',
      'edit',
    );
    const heavyRev = headRevision(p).id;
    return { p: switchBranch(p, main), main, heavyRev };
  }

  it('merges whole tracks into the current branch as a merge revision', () => {
    const { p, heavyRev } = heavy();
    const head = headRevision(p);
    const m = mergeSelected(p, heavyRev, { trackIds: ['trk_bass', 'Lead Guitar'] });
    const rev = headRevision(m);
    expect(rev).toMatchObject({ kind: 'merge', parents: [head.id, heavyRev], number: 3 });
    expect(rev.message).toBe('Merged track "Bass", added track "Lead Guitar" from v2');
    expect(bass(m.song).notes.map((n) => n.pitch)).toEqual(
      bass(getHeavy(p, heavyRev)).notes.map((n) => n.pitch),
    );
    expect(m.song.tracks.find((t) => t.name === 'Lead Guitar')!.notes).toHaveLength(1);
    expect(m.song.tracks.find((t) => t.id === 'trk_drums')).toEqual(
      p.song.tracks.find((t) => t.id === 'trk_drums'),
    );
    expect(m.song.tempoMap[0].bpm).toBe(120);
    expect(m.song.chords).toEqual(p.song.chords);
  });

  it('merges sections (all tracks + chords), matching sections by name', () => {
    const { p, heavyRev } = heavy();
    const from = getHeavy(p, heavyRev);
    const renamedIds = cloneSong(p.song);
    renamedIds.sections = renamedIds.sections.map((s) => ({ ...s, id: `x_${s.id}` }));
    const r = mergeSongs(renamedIds, from, { sectionIds: ['Chorus'] });
    expect(r.report.ok).toBe(true);
    expect(notesInBars(r.song, 'trk_bass', 13, 20).every((n) => n.pitch >= 48)).toBe(true);
    expect(notesInBars(r.song, 'trk_bass', 1, 12)).toEqual(notesInBars(p.song, 'trk_bass', 1, 12));
    expect(r.song.chords.find((c) => c.tick === 12 * BAR)!.symbol).toBe('Am');
    expect(r.song.chords.find((c) => c.tick === 4 * BAR)!.symbol).toBe('Em');
    expect(r.song.tracks.some((t) => t.name === 'Lead Guitar')).toBe(false); // not explicitly selected
    const withTrack = mergeSongs(p.song, from, {
      sectionIds: ['sec_chorus'],
      trackIds: ['Lead Guitar'],
      lyrics: true,
    });
    expect(withTrack.song.tracks.find((t) => t.name === 'Lead Guitar')!.notes).toHaveLength(1);
    expect(notesInBars(withTrack.song, 'trk_bass', 13, 20)).toEqual(notesInBars(p.song, 'trk_bass', 13, 20));
    expect(withTrack.song.lyrics.map((l) => l.text)).toEqual(['Louder now']);
  });

  it('merges chords, lyrics, mixer and tempo/key; respects locks', () => {
    const { p, heavyRev } = heavy();
    const from = getHeavy(p, heavyRev);
    const r = mergeSongs(p.song, from, { chords: true, lyrics: true, mixer: true, tempoKey: true });
    expect(r.merged).toEqual(['chords', 'lyrics', 'mixer', 'tempo & key']);
    expect(r.song.tempoMap[0].bpm).toBe(170);
    expect(r.song.mixer.channels.trk_bass.volumeDb).toBe(-1);
    expect(r.song.lyrics.map((l) => l.text)).toEqual(['Louder now']);
    expect(bass(r.song).notes).toEqual(bass(p.song).notes);
    const locked = cloneSong(p.song);
    locked.locks = { [LockKeys.track('trk_bass')]: true, [LockKeys.tempo]: true };
    const lr = mergeSongs(locked, from, { trackIds: ['trk_bass'], tempoKey: true });
    expect(bass(lr.song).notes).toEqual(bass(p.song).notes);
    expect(lr.song.tempoMap[0].bpm).toBe(120);
    expect(lr.report.issues.filter((i) => i.code === 'lock.violated')).toHaveLength(2);
    const forced = mergeSongs(locked, from, { trackIds: ['trk_bass'] }, { respectLocks: false });
    expect(bass(forced.song).notes[0].pitch).toBe(52);
  });
});

function getHeavy(p: Project, id: string): Song {
  return p.history.revisions.find((r) => r.id === id)!.snapshot;
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

function wavBytes(n: number): Uint8Array {
  const b = new Uint8Array(44 + n);
  b.set(strToU8('RIFF'), 0);
  b.set(strToU8('WAVE'), 8);
  for (let i = 44; i < b.length; i++) b[i] = i % 251;
  return b;
}

function richProject(): { project: Project; assets: Map<string, Uint8Array> } {
  clock = 0;
  let p = createProject('Demo Project', makeSong());
  p = { ...p, meta: { ...p.meta, createdAt: at(), updatedAt: at() } };
  p = commitRevision(p, edit(p.song, [{ op: 'set_tempo', bpm: 128 }]), 'Faster', 'edit', 'me', { now: at() });
  p = createBranch(p, 'Acoustic', undefined, 'Unplugged', { now: at() });
  p = commitRevision(
    p,
    edit(p.song, [{ op: 'set_instrument', track: 'bass', instrument_id: 'upright-bass' }]),
    'Upright',
    'edit',
    undefined,
    { now: at() },
  );
  const guide: AudioAssetMeta = {
    id: 'asset_guide',
    name: 'guide_mix.wav',
    kind: 'guide-render',
    path: assetPathFor('guide-render', 'guide_mix.wav'),
    mimeType: 'audio/wav',
    sampleRate: 48000,
    channels: 2,
    durationSeconds: 40,
    bytes: 1044,
    createdAt: at(),
  };
  const stem: AudioAssetMeta = {
    ...guide,
    id: 'asset_stem',
    name: 'bass.wav',
    kind: 'stem',
    path: assetPathFor('stem', 'bass.wav'),
  };
  const missing: AudioAssetMeta = {
    ...guide,
    id: 'asset_missing',
    name: 'gone.wav',
    kind: 'reference',
    path: assetPathFor('reference', 'gone.wav'),
  };
  p = addAsset(addAsset(addAsset(p, guide, at()), stem, at()), missing, at());
  p = addProvenance(
    p,
    {
      id: 'prov_1',
      artifactId: 'asset_guide',
      artifactName: 'guide_mix.wav',
      artifactKind: 'audio',
      sources: [{ kind: 'song', ref: 'song.json', revision: 2 }],
      providerId: 'internal',
      providerName: 'Guide renderer',
      seed: 42,
      generatedAt: at(),
      cloud: false,
    },
    at(),
  );
  p = recordProviderUse(p, 'internal', 'Song Deck engine', at());
  p = addAnalysisRecord(
    p,
    { id: 'an_1', kind: 'key', createdAt: at(), summary: 'E minor', confidence: 0.9, data: { tonic: 4 } },
    at(),
  );
  p = addGenerationRecord(
    p,
    {
      id: 'gen_1',
      kind: 'composition',
      createdAt: at(),
      providerId: 'internal',
      status: 'succeeded',
      seed: 42,
      revisionId: p.history.revisions[1].id,
    },
    at(),
  );
  p = updateRights(
    p,
    { humanComposers: ['Test Writer'], aiAssistance: 'Arrangement drafted with Song Deck' },
    at(),
  );
  p.song.motifs.push({
    id: 'motif_a',
    name: 'Motif A',
    role: 'vocal-hook',
    lengthTicks: 1920,
    notes: [{ offset: 0, duration: 480, degree: 0, velocity: 90 }],
  });
  const assets = new Map<string, Uint8Array>([
    ['asset_guide', wavBytes(1000)],
    ['asset_stem', wavBytes(500)],
    ['unreferenced', wavBytes(10)],
  ]);
  return { project: p, assets };
}

describe('.songproject packages', () => {
  it('round-trips packProject/unpackProject exactly', () => {
    const { project, assets } = richProject();
    const bytes = packProject(project, assets);
    const back = unpackProject(bytes);
    expect(back.project).toEqual(project);
    expect([...back.assets.keys()].sort()).toEqual(['asset_guide', 'asset_stem']);
    expect(back.assets.get('asset_guide')).toEqual(assets.get('asset_guide'));
    expect(packProject(project, assets)).toEqual(bytes); // reproducible
    expect(packProject(back.project, back.assets)).toEqual(bytes);
  });

  it('uses the spec §9 layout', () => {
    const { project, assets } = richProject();
    const files = unzipSync(packProject(project, assets));
    const names = Object.keys(files).sort();
    for (const required of [
      'project.json',
      'song.json',
      'history/revisions.json',
      'audio/guide-renders/guide_mix.wav',
      'stems/bass.wav',
      'analysis/an_1.json',
      'generations/gen_1.json',
      'motifs/motif_a.json',
      'midi/song.mid',
      'midi/bass.mid',
      'midi/vocal.mid',
      'lyrics/03-chorus.txt',
      'lyrics/lyric-sheet.txt',
    ]) {
      expect(names).toContain(required);
    }
    expect(names.filter((n) => n.startsWith('history/snapshots/'))).toHaveLength(
      project.history.revisions.length,
    );
    expect(strFromU8(files['lyrics/03-chorus.txt'])).toBe(
      'Hold on to the lightning\nHold on to the lightning\n',
    );
    const header = JSON.parse(strFromU8(files['project.json']));
    expect(header).toMatchObject({ format: 'songdeck-project', formatVersion: 1 });
    expect(header.meta.id).toBe(project.meta.id);
    expect(JSON.parse(strFromU8(files['history/revisions.json']))[0].snapshot).toBeUndefined();
    const lean = unzipSync(packProject(project, assets, { includeDerived: false }));
    expect(Object.keys(lean).some((n) => n.startsWith('midi/') || n.startsWith('lyrics/'))).toBe(false);
  });

  it('never writes credentials', () => {
    const { project, assets } = richProject();
    const leaky: Project = cloneSong(project);
    (leaky.meta.settings as Record<string, unknown>).apiKey = 'sk-live-should-not-be-here-123456';
    leaky.meta.provenance[0].parameters = {
      temperature: 0.7,
      api_key: 'abc',
      nested: { Authorization: 'Bearer abcdefghijklmnop', model: 'x' },
      maxTokens: 2048,
    };
    leaky.generations[0].details = {
      prompt: 'make it heavier',
      token: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV',
      note: 'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    };
    const files = unzipSync(packProject(leaky, assets));
    const all = Object.entries(files)
      .filter(([n]) => n.endsWith('.json'))
      .map(([, d]) => strFromU8(d))
      .join('\n');
    for (const secret of [
      'sk-live-should-not-be-here',
      '"abc"',
      'Bearer abcdefghijklmnop',
      'sk-ant-api03',
      'AIzaSyA1234567890',
    ])
      expect(all).not.toContain(secret);
    const back = unpackProject(packProject(leaky, assets)).project;
    expect(back.meta.provenance[0].parameters).toEqual({
      temperature: 0.7,
      nested: { model: 'x' },
      maxTokens: 2048,
    });
    expect(back.generations[0].details).toEqual({
      prompt: 'make it heavier',
      token: undefined,
      note: '[redacted]',
    });
    expect(scrubSecrets({ password: 'x', list: ['ghp_abcdefghijklmnopqrstuvwxyz'] })).toEqual({
      list: ['[redacted]'],
    });
  });

  it('validates the package format and version', () => {
    const { project, assets } = richProject();
    expect(() => unpackProject(strToU8('not a zip'))).toThrow(/invalid ZIP/);
    expect(() => unpackProject(zipSync({ 'song.json': strToU8('{}') }))).toThrow(/project\.json is missing/);
    const files = unzipSync(packProject(project, assets));
    const header = JSON.parse(strFromU8(files['project.json']));
    expect(() =>
      unpackProject(
        zipSync({ ...files, 'project.json': strToU8(JSON.stringify({ ...header, formatVersion: 99 })) }),
      ),
    ).toThrow(/newer version/);
    expect(() =>
      unpackProject(
        zipSync({ ...files, 'project.json': strToU8(JSON.stringify({ ...header, format: 'other' })) }),
      ),
    ).toThrow(/Not a \.songproject/);
    expect(() => unpackProject(zipSync({ ...files, 'song.json': strToU8('{oops') }))).toThrow(
      /song\.json is not valid JSON/,
    );
  });

  it('is tolerant of missing optional folders and repairs broken history', () => {
    const { project, assets } = richProject();
    const files = unzipSync(packProject(project, assets));
    // Only the canonical minimum: project.json + song.json.
    const minimal = unpackProject(
      zipSync({ 'project.json': files['project.json'], 'song.json': files['song.json'] }),
    );
    expect(minimal.project.song).toEqual(project.song);
    expect(minimal.project.history.revisions).toHaveLength(1);
    expect(minimal.project.history.revisions[0].kind).toBe('import');
    expect(minimal.project.analysis).toEqual([]);
    expect(minimal.assets.size).toBe(0);
    // A missing snapshot drops that revision and re-links its children.
    const v2 = project.history.revisions[1];
    const header = JSON.parse(strFromU8(files['project.json']));
    const v2File = header.files.snapshots[1];
    const broken = { ...files };
    delete broken[v2File];
    const repaired = unpackProject(zipSync(broken)).project;
    expect(repaired.history.revisions.map((r) => r.number)).toEqual([1, 3]);
    expect(repaired.history.revisions[1].parents).toEqual([project.history.revisions[0].id]);
    expect(repaired.history.branches.find((b) => b.name === 'Main')!.headRevisionId).toBe(
      project.history.revisions[0].id,
    );
    expect(repaired.history.branches.find((b) => b.name === 'Acoustic')!.baseRevisionId).toBe(
      project.history.revisions[0].id,
    );
    expect(v2.number).toBe(2);
  });
});

describe('assets, provenance, providers', () => {
  it('builds safe asset paths per kind', () => {
    expect(assetPathFor('guide-render', 'guide_mix.wav')).toBe('audio/guide-renders/guide_mix.wav');
    expect(assetPathFor('reference', 'ref.mp3')).toBe('audio/references/ref.mp3');
    expect(assetPathFor('generation', 'take A.wav')).toBe('audio/generations/take A.wav');
    expect(assetPathFor('vocal', 'chorus-vocal-v4.wav')).toBe('audio/vocals/chorus-vocal-v4.wav');
    expect(assetPathFor('master', 'master.flac')).toBe('audio/masters/master.flac');
    expect(assetPathFor('stem', 'drums.wav')).toBe('stems/drums.wav');
    expect(assetPathFor('stem', '../../etc/passwd')).toBe('stems/passwd');
    expect(sanitizeAssetFileName('..\\evil:name?.wav')).toBe('evilname.wav');
    expect(sanitizeAssetFileName('')).toBe('asset');
  });

  it('adds, replaces and removes assets and provenance; records provider use', () => {
    let p = newProject();
    const meta: AudioAssetMeta = {
      id: 'a1',
      name: 'x.wav',
      kind: 'stem',
      path: '../../x.wav',
      mimeType: 'audio/wav',
      sampleRate: 44100,
      channels: 2,
      durationSeconds: 1,
      bytes: 10,
      createdAt: '2026-01-01T00:00:00Z',
    };
    p = addAsset(p, meta, '2026-02-01T00:00:00.000Z');
    expect(p.meta.assets[0].path).toBe('x.wav');
    expect(p.meta.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    p = addAsset(p, { ...meta, path: 'stems/x.wav', name: 'renamed.wav' });
    expect(p.meta.assets).toHaveLength(1);
    expect(p.meta.assets[0]).toMatchObject({ name: 'renamed.wav', path: 'stems/x.wav' });
    p = removeAsset(p, 'a1');
    expect(p.meta.assets).toEqual([]);
    expect(removeAsset(p, 'a1')).toBe(p);
    const rec = {
      id: 'pv',
      artifactId: 'a1',
      artifactName: 'x.wav',
      artifactKind: 'audio' as const,
      sources: [],
      providerId: 'p',
      providerName: 'P',
      generatedAt: '2026-01-01T00:00:00Z',
      cloud: true,
    };
    p = addProvenance(addProvenance(p, rec), { ...rec, seed: 7 });
    expect(provenanceFor(p, 'a1')).toEqual([{ ...rec, seed: 7 }]);
    p = recordProviderUse(p, 'openai', 'OpenAI', '2026-03-01T00:00:00.000Z');
    p = recordProviderUse(p, 'anthropic', 'Anthropic', '2026-03-02T00:00:00.000Z');
    p = recordProviderUse(p, 'openai', 'OpenAI', '2026-03-03T00:00:00.000Z');
    expect(p.meta.providersUsed).toEqual([
      { providerId: 'anthropic', providerName: 'Anthropic', lastUsedAt: '2026-03-02T00:00:00.000Z' },
      { providerId: 'openai', providerName: 'OpenAI', lastUsedAt: '2026-03-03T00:00:00.000Z' },
    ]);
  });
});
