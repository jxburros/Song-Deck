import { useEffect, useState } from 'react';
import { colorForRole, keyName, PPQ, randomId, type AudioClip, type Song } from '@songdeck/core';
import {
  attachLibraryAssets,
  exportLibraryItem,
  fileToLibraryDraft,
  independentCopy,
  useLibrary,
  type LibraryItem,
} from '../../state/library';
import { useStudio } from '../../state/store';
import { Button, FileButton, TextInput, Modal } from '../../ui/kit';
import { useComposeSession } from '../compose/session';
import {
  mergeComposeInputs,
  playableItem,
  separateInput,
  transcribeInput,
  useComposeInputs,
} from '../compose/inputs';
import { SaveLibraryButton } from './SaveLibraryButton';
import { AudioPreviewButton } from '../shared/AudioPreviewButton';
import { decodeAudioBytes } from '../../state/assets';
import { jobs } from '../../engine/jobs';
import type { AudioData } from '@songdeck/audio';

const KINDS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'midi', label: 'MIDI parts' },
  { value: 'collection', label: 'Track sets' },
  { value: 'audio', label: 'Audio' },
  { value: 'file', label: 'Lyrics and files' },
];

function describeItem(item: LibraryItem): string {
  const tracks = item.song?.tracks.length ?? 0;
  switch (item.kind) {
    case 'midi':
      return 'MIDI part';
    case 'collection':
      return `Track set · ${tracks} track${tracks === 1 ? '' : 's'}`;
    case 'audio':
      return 'Audio';
    default:
      return item.file ? (item.file.name.split('.').pop()?.toUpperCase() ?? 'File') : 'File';
  }
}

function itemMeta(song?: Song): string {
  if (!song) return '';
  const parts: string[] = [];
  if (song.keyMap[0]) parts.push(keyName(song.keyMap[0].key));
  if (song.tempoMap[0]) parts.push(`${Math.round(song.tempoMap[0].bpm)} BPM`);
  if (song.meterMap[0]) parts.push(`${song.meterMap[0].numerator}/${song.meterMap[0].denominator}`);
  return parts.join(' · ');
}

/** Rough clip length in ticks at the song's opening tempo (enough for a thumbnail). */
const clipTicks = (song: Song, c: AudioClip) =>
  Math.round(c.durationSeconds * ((song.tempoMap[0]?.bpm ?? 120) / 60) * PPQ);

/** A small picture of the item: notes for a part, lanes for a track set, a wave for audio. */
function LibraryPreview({ item }: { item: LibraryItem }) {
  const song = item.song;
  const notes =
    song?.tracks.flatMap((t) => t.notes.map((n) => ({ ...n, role: t.role, color: t.color }))) ?? [];
  if (item.kind === 'midi' && notes.length) {
    const end = Math.max(...notes.map((n) => n.tick + n.duration), 1);
    const lo = Math.min(...notes.map((n) => n.pitch));
    const hi = Math.max(...notes.map((n) => n.pitch), lo + 1);
    return (
      <div className="lib-preview" aria-hidden="true">
        {notes.slice(0, 160).map((n) => (
          <span
            key={n.id}
            className="lib-note"
            style={{
              left: `${(n.tick / end) * 100}%`,
              width: `max(2px, calc(${(n.duration / end) * 100}% - 1px))`,
              top: `${88 - ((n.pitch - lo) / (hi - lo)) * 76}%`,
              background: n.color || colorForRole(n.role),
            }}
          />
        ))}
      </div>
    );
  }
  if (song && song.tracks.length > 1) {
    const end = Math.max(
      ...song.tracks.flatMap((t) => [
        ...t.notes.map((n) => n.tick + n.duration),
        ...t.clips.map((c) => c.tick + clipTicks(song, c)),
      ]),
      1,
    );
    return (
      <div className="lib-preview lanes" aria-hidden="true">
        {song.tracks.slice(0, 6).map((t) => {
          const starts = [...t.notes.map((n) => n.tick), ...t.clips.map((c) => c.tick)];
          const ends = [
            ...t.notes.map((n) => n.tick + n.duration),
            ...t.clips.map((c) => c.tick + clipTicks(song, c)),
          ];
          const a = starts.length ? Math.min(...starts) : 0;
          const b = ends.length ? Math.max(...ends) : 0;
          return (
            <span key={t.id} className="lib-lane">
              <span
                style={{
                  left: `${(a / end) * 100}%`,
                  width: `${((b - a) / end) * 100}%`,
                  background: t.color || colorForRole(t.role),
                }}
              />
            </span>
          );
        })}
      </div>
    );
  }
  if (item.kind === 'audio') {
    const seed = item.name.length;
    return (
      <div className="lib-preview wave" aria-hidden="true">
        {Array.from({ length: 36 }, (_, i) => (
          <span
            key={i}
            style={{
              height: `${Math.max(10, Math.abs(Math.sin(i * (0.6 + seed / 40)) * 0.7 + Math.sin(i * 0.5) * 0.3) * 100)}%`,
            }}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="lib-preview hatch-soft file" aria-hidden="true">
      <span className="mono small">{describeItem(item)}</span>
    </div>
  );
}

export function LibraryBrowser({ onPick }: { onPick?: (item: LibraryItem) => void }) {
  const { items, refresh, save, remove } = useLibrary();
  const project = useStudio((s) => s.project);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [busy, setBusy] = useState(false);
  const [pendingAudio, setPendingAudio] = useState<{
    item: LibraryItem;
    action: 'start' | 'add' | 'pick';
  } | null>(null);
  const [deleting, setDeleting] = useState<LibraryItem | null>(null);
  const [separate, setSeparate] = useState(false);
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
  const applyItem = async (item: LibraryItem, action: 'start' | 'add' | 'pick') => {
    if (action === 'add') await addToProject(item);
    else if (action === 'pick') onPick?.(item);
    else {
      useComposeInputs.getState().add(await playableItem(item));
      useComposeSession.getState().start(item.kind === 'audio' ? 'audio' : 'midi');
      st.setMode('compose');
    }
  };
  const choose = (item: LibraryItem, action: 'start' | 'add' | 'pick') => {
    const needsMidi =
      (item.kind === 'audio' && !item.song) ||
      item.song?.tracks.some((t) => t.kind === 'audio' && !t.audioMidi);
    if (needsMidi) {
      setSeparate(false);
      setPendingAudio({ item, action });
    } else void perform(() => applyItem(item, action));
  };
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row wrap lib-toolbar">
        <TextInput
          value={search}
          onChange={setSearch}
          placeholder="Search the Library"
          aria-label="Search library"
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
          Upload
        </FileButton>
        {!onPick && project && (
          <SaveLibraryButton song={project.song} label={`Save all tracks of ${project.meta.name}`} />
        )}
      </div>
      <div className="chip-list" role="radiogroup" aria-label="Library type">
        {KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            role="radio"
            aria-checked={kind === k.value}
            className={`chip ${kind === k.value ? 'on' : ''}`}
            onClick={() => setKind(k.value)}
          >
            {k.label}
          </button>
        ))}
      </div>
      {!items.length && (
        <div className="lib-empty hatch-soft">
          <strong>Nothing kept yet</strong>
          <span className="small muted">
            Upload audio, MIDI, lyrics or a .songproject, save tracks from a song, or keep anything you make
            in Single Track. Saved on this device; using an item makes an independent copy.
          </span>
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
            <article className="panel quiet lib-card" key={item.id} data-testid="library-item">
              <LibraryPreview item={item} />
              <div className="lib-card-body">
                <div className="lib-card-top">
                  <span className="lib-kind grow">{describeItem(item)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="download"
                    aria-label={`Download ${item.name}`}
                    title="Download"
                    onClick={() => void perform(async () => exportLibraryItem(item))}
                  />
                  {!onPick && (
                    <Button
                      size="sm"
                      icon="trash"
                      variant="ghost"
                      aria-label={`Delete ${item.name} from library`}
                      title={`Delete ${item.name} from library`}
                      onClick={() => setDeleting(item)}
                    />
                  )}
                </div>
                <strong className="lib-name">{item.name}</strong>
                <span className="small dim">{itemMeta(item.song)}</span>
                <span className={`lib-source ${item.file ? 'upload' : ''}`}>
                  {item.file ? 'Uploaded' : 'Saved in Song Deck'} ·{' '}
                  {new Date(item.createdAt).toLocaleDateString()}
                </span>
              </div>
              <div className="lib-actions">
                {item.kind !== 'file' && (
                  <AudioPreviewButton
                    id={`library:${item.id}`}
                    label={item.name}
                    load={async () => {
                      if (item.file && item.kind === 'audio') return decodeAudioBytes(item.file.bytes);
                      if (!item.song) return undefined;
                      const assets: Record<string, AudioData> = {};
                      for (const asset of item.assets)
                        assets[asset.meta.id] = await decodeAudioBytes(asset.bytes);
                      return jobs.call<AudioData>('renderMix', {
                        song: item.song,
                        assets,
                        sampleRate: 44100,
                      });
                    }}
                  />
                )}

                {onPick ? (
                  <Button disabled={busy || item.kind === 'file'} onClick={() => choose(item, 'pick')}>
                    Use this input
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy || item.kind === 'file'}
                      onClick={() => choose(item, 'start')}
                    >
                      Start a song with it
                    </Button>
                    {project && (
                      <Button
                        size="sm"
                        disabled={busy || item.kind === 'file'}
                        title={`Add an independent copy to ${project.meta.name}`}
                        onClick={() => choose(item, 'add')}
                      >
                        Add to this song
                      </Button>
                    )}
                  </>
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
      {pendingAudio && (
        <Modal title="Add MIDI before using this audio?" onClose={() => !busy && setPendingAudio(null)}>
          <p>
            Recommended: make editable MIDI so AI can use the notes when generating other parts. The original
            audio stays unchanged and still plays. Transcription runs on this device and may take a moment.
          </p>
          {pendingAudio.item.kind === 'audio' && !pendingAudio.item.song && (
            <label className="field">
              <span className="row">
                <input
                  type="checkbox"
                  checked={separate}
                  disabled={busy}
                  onChange={(e) => setSeparate(e.target.checked)}
                />
                Separate into instrument stems first (a song with several parts)
              </span>
              <span className="small muted">
                Makes a track and MIDI for each part. On-device separation estimates drums, bass, vocals and
                other. Connected engines can also isolate guitar, piano, strings, winds and synths, depending
                on the model. Cloud engines may charge for each requested part.
              </span>
            </label>
          )}
          <div className="row wrap">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const source = separate ? await separateInput(pendingAudio.item) : pendingAudio.item;
                  const item = await transcribeInput(source);
                  await applyItem(item, pendingAudio.action);
                  setPendingAudio(null);
                })
              }
            >
              {busy ? (separate ? 'Separating and making MIDI…' : 'Making MIDI…') : 'Make MIDI and continue'}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const source = separate ? await separateInput(pendingAudio.item) : pendingAudio.item;
                  await applyItem(source, pendingAudio.action);
                  setPendingAudio(null);
                })
              }
            >
              {separate ? 'Continue with stems only' : 'Continue with audio only'}
            </Button>
            <Button disabled={busy} onClick={() => setPendingAudio(null)}>
              Cancel
            </Button>
          </div>
        </Modal>
      )}
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
    <div className="area-page library-page">
      <header className="page-band measure-grid">
        <span className="eyebrow-rule">Library</span>
        <h1>Everything you keep</h1>
        <p className="lede">
          Uploads, parts saved from your songs and anything from Single Track. Use any of it in any song; each
          use is an independent copy.
        </p>
      </header>
      <div className="area-body">
        <LibraryBrowser />
      </div>
    </div>
  );
}
