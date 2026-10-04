import { useEffect, useState } from 'react';
import { randomId } from '@songdeck/core';
import {
  attachLibraryAssets,
  exportLibraryItem,
  fileToLibraryDraft,
  independentCopy,
  useLibrary,
  type LibraryItem,
} from '../../state/library';
import { useStudio } from '../../state/store';
import { Button, FileButton, TextInput, Select, Modal } from '../../ui/kit';
import { mergeComposeInputs, playableItem, useComposeInputs } from '../compose/inputs';
import { SaveLibraryButton } from './SaveLibraryButton';

export function LibraryBrowser({ onPick }: { onPick?: (item: LibraryItem) => void }) {
  const { items, refresh, save, remove } = useLibrary();
  const project = useStudio((s) => s.project);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<LibraryItem | null>(null);
  const st = useStudio.getState();
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof Error && e.name === 'AbortError'))
        st.toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh().catch((e: unknown) =>
      useStudio.getState().toast('error', `Could not load Library: ${String(e)}`),
    );
  }, [refresh]);
  const addToProject = async (item: LibraryItem) => {
    if (!project) return;
    const copy = independentCopy(await playableItem(item));
    if (useStudio.getState().project?.meta.id !== project.meta.id)
      throw new Error('The active project changed. Add the item again in the intended project.');
    await attachLibraryAssets([copy], project.meta.id);
    const current = useStudio.getState().project!;
    st.commit(
      mergeComposeInputs(current.song, [
        { id: randomId('input'), item: copy, interpretation: 'preserve', startBar: 1 },
      ]),
      `Added library copy: ${item.name}`,
      'import',
    );
    st.toast('success', `Added an independent copy of ${item.name}`);
  };
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row wrap">
        <TextInput
          value={search}
          onChange={setSearch}
          placeholder="Search your library"
          aria-label="Search library"
        />
        <Select
          value={kind}
          onChange={setKind}
          aria-label="Library type"
          options={['all', 'midi', 'collection', 'audio', 'file'].map((value) => ({
            value,
            label: value === 'all' ? 'All items' : value,
          }))}
        />
        <FileButton
          multiple
          disabled={busy}
          onFile={(files) =>
            void perform(async () => {
              for (const file of files) await save(await fileToLibraryDraft(file, true));
            })
          }
          icon="upload"
        >
          Import files
        </FileButton>
        {!onPick && project && (
          <SaveLibraryButton song={project.song} label="Save project tracks as collection" />
        )}
      </div>
      <p className="small muted">
        Saved on this device across projects. Reuse creates independent copies. Export files or complete track
        collections at any time.
      </p>
      {!items.length && (
        <div className="card">
          Your library is empty. Import files or save tracks and generated results here.
        </div>
      )}
      <div className="library-grid">
        {items
          .filter(
            (item) =>
              (kind === 'all' || item.kind === kind) &&
              item.name.toLowerCase().includes(search.toLowerCase()),
          )
          .map((item) => (
            <article className="card col" key={item.id} data-testid="library-item">
              <strong>{item.name}</strong>
              <span className="small muted">
                {item.kind}
                {item.song ? ` · ${item.song.tracks.length} tracks` : ''}
              </span>
              <div className="row wrap">
                {onPick ? (
                  <Button disabled={busy || item.kind === 'file'} onClick={() => onPick(item)}>
                    Use this input
                  </Button>
                ) : (
                  <>
                    <Button
                      disabled={busy || item.kind === 'file'}
                      onClick={() =>
                        void perform(async () => {
                          useComposeInputs.getState().add(await playableItem(item));
                          st.setMode('compose');
                        })
                      }
                    >
                      Use in Compose
                    </Button>
                    {project && (
                      <Button
                        disabled={busy || item.kind === 'file'}
                        onClick={() => void perform(() => addToProject(item))}
                      >
                        Add copy to project
                      </Button>
                    )}
                  </>
                )}
                <Button icon="download" onClick={() => void perform(async () => exportLibraryItem(item))}>
                  Export
                </Button>
                {!onPick && (
                  <Button
                    icon="trash"
                    variant="ghost"
                    title={`Delete ${item.name} from library`}
                    onClick={() => setDeleting(item)}
                  />
                )}
              </div>
            </article>
          ))}
      </div>
      {items.length > 0 &&
        !items.some(
          (item) =>
            (kind === 'all' || item.kind === kind) && item.name.toLowerCase().includes(search.toLowerCase()),
        ) && <p>No matching items.</p>}
      {deleting && (
        <Modal title="Delete library item?" onClose={() => setDeleting(null)}>
          <p>Delete “{deleting.name}” from the library? Copies already added to projects are kept.</p>
          <Button
            variant="danger"
            onClick={() =>
              void perform(async () => {
                await remove(deleting.id);
                setDeleting(null);
              })
            }
          >
            Delete item
          </Button>
        </Modal>
      )}
    </div>
  );
}
export default function LibraryMode() {
  return (
    <div className="mode-page">
      <div className="page-header">
        <div>
          <h1>Library</h1>
          <p className="lede">Your saved tracks, collections, audio, and files.</p>
        </div>
      </div>
      <LibraryBrowser />
    </div>
  );
}
