import { useMemo, useState } from 'react';
import { compareRevisions, duplicateProject, type Revision, type SongDiff } from '@songdeck/core';
import { useStudio } from '../../../state/store';
import { Badge, Button, Field, Modal, Select, TextInput, Toggle } from '../../../ui/kit';
import { Icon } from '../../../ui/icons';

/** Version history (spec §52) and branching (spec §53): compare, restore, branch, duplicate, merge selected changes. */
export default function HistoryPanel() {
  const project = useStudio((s) => s.project);
  const st = useStudio.getState();
  const [compareA, setCompareA] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ a: Revision; b: Revision; diff: SongDiff } | null>(null);
  const [newBranch, setNewBranch] = useState<{ from?: string; name: string } | null>(null);
  const [merge, setMerge] = useState<{ from: string; trackIds: string[]; sectionIds: string[]; chords: boolean; lyrics: boolean; mixer: boolean; tempoKey: boolean } | null>(null);
  const branchRevs = useMemo(() => {
    if (!project) return [];
    const branch = project.history.branches.find((b) => b.id === project.history.currentBranchId)!;
    const byId = new Map(project.history.revisions.map((r) => [r.id, r]));
    const out: Revision[] = [];
    let cur = byId.get(branch.headRevisionId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur);
      cur = cur.parents[0] ? byId.get(cur.parents[0]) : undefined;
    }
    return out;
  }, [project]);
  if (!project) return null;
  const { branches, currentBranchId } = project.history;
  const headId = branches.find((b) => b.id === currentBranchId)?.headRevisionId;
  const workingRevId = project.history.revisions.find((r) => r.snapshot === project.song)?.id;

  const pickCompare = (r: Revision) => {
    if (!compareA) return setCompareA(r.id);
    if (compareA === r.id) return setCompareA(null);
    const a = project.history.revisions.find((x) => x.id === compareA)!;
    setDiff({ a, b: r, diff: compareRevisions(project, a.id, r.id) });
    setCompareA(null);
  };

  const otherHeads = branches.filter((b) => b.id !== currentBranchId);
  const mergeSource = merge ? project.history.revisions.find((r) => r.id === merge.from) : undefined;

  return (
    <div className="col">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Branches</h3>
        <Button size="sm" icon="branch" onClick={() => setNewBranch({ name: 'New version' })}>
          New branch
        </Button>
      </div>
      {branches.map((b) => (
        <div key={b.id} className={`card row ${b.id === currentBranchId ? 'selected' : ''}`} style={{ padding: '6px 10px' }}>
          <Icon name="branch" size={13} />
          <span className="grow ellipsis" style={{ fontWeight: b.id === currentBranchId ? 700 : 500 }}>
            {b.name}
          </span>
          <span className="small dim">v{project.history.revisions.find((r) => r.id === b.headRevisionId)?.number}</span>
          {b.id !== currentBranchId && (
            <>
              <Button size="sm" variant="ghost" onClick={() => st.switchBranch(b.id)}>
                Switch
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMerge({ from: b.headRevisionId, trackIds: [], sectionIds: [], chords: false, lyrics: false, mixer: false, tempoKey: false })} title="Merge selected changes from this branch">
                Merge…
              </Button>
              <Button size="sm" variant="ghost" icon="trash" onClick={() => st.deleteBranch(b.id)} />
            </>
          )}
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        icon="copy"
        onClick={async () => {
          const dup = duplicateProject(project, `${project.meta.name} (copy)`);
          st.setProject(dup);
          await st.refreshProjects();
          st.toast('success', 'Duplicated project');
        }}
      >
        Duplicate project
      </Button>

      <div className="row between" style={{ marginTop: 8 }}>
        <h3 style={{ margin: 0 }}>History</h3>
        <span className="small muted">{compareA ? 'Pick a second version to compare' : `${branchRevs.length} versions`}</span>
      </div>
      {branchRevs.map((r) => (
        <div key={r.id} className={`card ${r.id === headId ? 'selected' : ''}`} style={{ padding: '6px 10px' }}>
          <div className="row">
            <strong className="mono">v{r.number}</strong>
            <span className="grow ellipsis" title={r.message}>
              {r.message}
            </span>
            <Badge>{r.kind}</Badge>
          </div>
          <div className="row small dim">
            <span className="grow">
              {new Date(r.createdAt).toLocaleString()}
              {r.author ? ` · ${r.author}` : ''}
              {r.parents.length > 1 ? ' · merge' : ''}
              {r.id === workingRevId ? ' · current' : ''}
            </span>
            <Button size="sm" variant="ghost" onClick={() => pickCompare(r)} active={compareA === r.id}>
              Compare
            </Button>
            {r.id !== headId && (
              <Button size="sm" variant="ghost" onClick={() => st.restoreRevision(r.id)}>
                Restore
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setNewBranch({ from: r.id, name: `From v${r.number}` })}>
              Branch
            </Button>
          </div>
        </div>
      ))}

      {diff && (
        <Modal title={`Compare v${diff.a.number} → v${diff.b.number}`} onClose={() => setDiff(null)} wide>
          <ul>
            {diff.diff.summary.length ? diff.diff.summary.map((s, i) => <li key={i}>{s}</li>) : <li>No differences.</li>}
          </ul>
          <div className="row wrap">
            <Button onClick={() => { st.restoreRevision(diff.a.id); setDiff(null); }}>Restore v{diff.a.number}</Button>
            <Button onClick={() => { st.restoreRevision(diff.b.id); setDiff(null); }}>Restore v{diff.b.number}</Button>
            <Button
              variant="ai"
              onClick={() => {
                setMerge({ from: diff.b.id, trackIds: diff.diff.tracks.map((t) => t.trackId), sectionIds: [], chords: false, lyrics: false, mixer: false, tempoKey: false });
                setDiff(null);
              }}
            >
              Merge changed tracks from v{diff.b.number}…
            </Button>
          </div>
        </Modal>
      )}

      {newBranch && (
        <Modal
          title="Create branch"
          onClose={() => setNewBranch(null)}
          footer={
            <>
              <Button onClick={() => setNewBranch(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => { st.createBranch(newBranch.name || 'Branch', newBranch.from); setNewBranch(null); }}>
                Create
              </Button>
            </>
          }
        >
          <Field label="Name" hint="e.g. Heavy Version, Acoustic Version, Radio Edit — all inherit the same Song DNA.">
            <TextInput value={newBranch.name} onChange={(name) => setNewBranch({ ...newBranch, name })} autoFocus />
          </Field>
        </Modal>
      )}

      {merge && mergeSource && (
        <Modal
          title={`Merge selected changes from v${mergeSource.number}`}
          onClose={() => setMerge(null)}
          footer={
            <>
              <Button onClick={() => setMerge(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  st.mergeSelected(merge.from, {
                    trackIds: merge.trackIds,
                    sectionIds: merge.sectionIds,
                    chords: merge.chords,
                    lyrics: merge.lyrics,
                    mixer: merge.mixer,
                    tempoKey: merge.tempoKey,
                  });
                  setMerge(null);
                }}
              >
                Merge into current branch
              </Button>
            </>
          }
        >
          <div className="col">
            <Field label="Source">
              <Select
                value={merge.from}
                onChange={(from) => setMerge({ ...merge, from })}
                options={[
                  ...otherHeads.map((b) => ({ value: b.headRevisionId, label: `${b.name} (head)` })),
                  ...project.history.revisions.slice(-30).map((r) => ({ value: r.id, label: `v${r.number} — ${r.message.slice(0, 40)}` })),
                ].filter((o, i, arr) => arr.findIndex((x) => x.value === o.value) === i)}
              />
            </Field>
            <div className="field-label">Tracks</div>
            <div className="chip-list">
              {mergeSource.snapshot.tracks.map((t) => (
                <button
                  key={t.id}
                  className={`chip ${merge.trackIds.includes(t.id) ? 'on' : ''}`}
                  onClick={() => setMerge({ ...merge, trackIds: merge.trackIds.includes(t.id) ? merge.trackIds.filter((x) => x !== t.id) : [...merge.trackIds, t.id] })}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <div className="field-label">Sections (all material inside)</div>
            <div className="chip-list">
              {mergeSource.snapshot.sections.map((s) => (
                <button
                  key={s.id}
                  className={`chip ${merge.sectionIds.includes(s.id) ? 'on' : ''}`}
                  onClick={() => setMerge({ ...merge, sectionIds: merge.sectionIds.includes(s.id) ? merge.sectionIds.filter((x) => x !== s.id) : [...merge.sectionIds, s.id] })}
                >
                  {s.name}
                </button>
              ))}
            </div>
            <div className="grid-2">
              <Toggle on={merge.chords} onChange={(chords) => setMerge({ ...merge, chords })} label="Chords" />
              <Toggle on={merge.lyrics} onChange={(lyrics) => setMerge({ ...merge, lyrics })} label="Lyrics" />
              <Toggle on={merge.mixer} onChange={(mixer) => setMerge({ ...merge, mixer })} label="Mixer" />
              <Toggle on={merge.tempoKey} onChange={(tempoKey) => setMerge({ ...merge, tempoKey })} label="Tempo & key" />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
