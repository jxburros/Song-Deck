import { useState } from 'react';
import { midiToSong } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { localGet, localSet } from '../../state/persistence';
import type { ProjectSummary } from '../../state/persistence';
import { openSettings } from '../settings/nav';
import { Button, FileButton, Modal, TextInput } from '../../ui/kit';
import { Icon, type IconName } from '../../ui/icons';
import { useComposeSession, type StartFocus } from '../compose/session';
import { SongTypeSwitch } from '../compose/SongType';
import { useRoleRoute } from '../../engine/ai';
import './home.css';

/**
 * Songs home: with vocals or instrumental, the ways to start a song (lyrics, audio, MIDI, a
 * prompt, or style settings alone), opening a saved project or MIDI file, an empty project, and
 * your songs.
 */

const STARTS: { focus: StartFocus; title: string; body: string; icon: IconName; label: string }[] = [
  {
    focus: 'lyrics',
    title: 'Lyrics',
    body: 'Full or partial. Sections like [Chorus] shape the song.',
    icon: 'book',
    label: 'Start from lyrics',
  },
  {
    focus: 'audio',
    title: 'Audio',
    body: 'Hum, sing or play it live, or upload recordings. One track or several.',
    icon: 'mic',
    label: 'Start from audio',
  },
  {
    focus: 'midi',
    title: 'MIDI',
    body: 'One or more tracks, from a few bars to a whole part.',
    icon: 'midi',
    label: 'Start from MIDI',
  },
  {
    focus: 'prompt',
    title: 'Prompt',
    body: 'Describe the song in your own words.',
    icon: 'sparkles',
    label: 'Start from a prompt',
  },
];

/** A small abstract arrangement for a song card, derived from its size (no audio is loaded). */
function Thumb({ p }: { p: ProjectSummary }) {
  let h = 0;
  for (const c of p.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const sections = Math.max(1, Math.min(8, p.sections || 1));
  const lanes = Math.max(0, Math.min(4, p.tracks));
  const widths = Array.from({ length: sections }, (_, i) => (i % 3 === 0 ? 1 : 2));
  const kinds = ['--sec-a', '--sec-b', '--sec-c', '--sec-b', '--sec-c', '--sec-d', '--sec-c', '--sec-a'];
  return (
    <div className="song-thumb" aria-hidden="true">
      <div className="song-thumb-row ribbon">
        {widths.map((w, i) => (
          <span key={i} style={{ flexGrow: w, background: `var(${kinds[i % kinds.length]})` }} />
        ))}
      </div>
      {Array.from({ length: lanes }, (_, l) => (
        <div key={l} className="song-thumb-row">
          {widths.map((w, i) => (
            <span
              key={i}
              style={{ flexGrow: w }}
              className={(h >> ((l * 8 + i) % 31)) & 1 || i === 2 ? 'on' : ''}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const projects = useStudio((s) => s.projects);
  const st = useStudio.getState();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const route = useRoleRoute('composition', 'auto');
  const instrumental = useComposeSession((s) => s.instrumental);
  const hasModel = Boolean(route && !route.internal);

  const importFile = async (files: File[]) => {
    const file = files[0];
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      if (/\.(mid|midi)$/i.test(file.name)) {
        const song = midiToSong(bytes, { title: file.name.replace(/\.(mid|midi)$/i, '') });
        await st.newProject(song.title, song);
        st.setMode('workbench');
        st.toast('success', `Imported ${file.name} (${song.tracks.length} tracks)`);
      } else {
        await st.importProjectBytes(bytes);
        st.toast('success', `Opened ${file.name}`);
      }
    } catch (err) {
      st.toast('error', `Could not import ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const start = (focus: StartFocus) => {
    if (focus === 'prompt' && !hasModel) {
      openSettings('providers', 'connect');
      return;
    }
    useComposeSession.getState().start(focus);
    st.setMode('compose');
  };
  const startFromStyle = () => {
    useComposeSession.getState().startFromStyle();
    st.setMode('compose');
  };

  return (
    <div className="area-page home-page">
      <header className="songs-hero measure-grid">
        <img className="songs-hero-art" src="/brand/sound-dimension.svg" alt="" aria-hidden="true" />
        <svg className="songs-hero-edge" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d="M22 0 L0 100" vectorEffect="non-scaling-stroke" />
          <path d="M26 0 L4 100" vectorEffect="non-scaling-stroke" className="soft" />
        </svg>
        <div className="songs-hero-copy">
          <span className="eyebrow-rule">Songs</span>
          <h1 id="home-title">Make a song</h1>
          <p>
            Start from words, a melody you hum, MIDI you already have, all of them at once, or just a style.
          </p>
        </div>
      </header>

      <div className="area-body col" style={{ gap: 26 }}>
        <div className="rule-title">
          <span className="index">01</span>
          <h2>Start from</h2>
          <span className="line" />
          <span className="note">Combine as many as you like on the next screen</span>
        </div>
        <SongTypeSwitch />
        <div className="start-grid" aria-label="Ways to start a song">
          {STARTS.filter((s) => !(instrumental && s.focus === 'lyrics')).map((s, i) => {
            const locked = s.focus === 'prompt' && !hasModel;
            return (
              <button
                key={s.focus}
                type="button"
                className={`start-tile ${locked ? 'locked' : ''}`}
                aria-label={locked ? 'Connect an AI service to start from a prompt' : s.label}
                onClick={() => start(s.focus)}
              >
                <span className="start-tile-top">
                  <span className="start-tile-icon">
                    <Icon name={s.icon} size={22} />
                  </span>
                  <span className="mono dim">{String(i + 1).padStart(2, '0')}</span>
                </span>
                <span className="start-tile-title">{s.title}</span>
                <span className="start-tile-body">{s.body}</span>
                {locked && (
                  <span className="start-tile-note">
                    <span className="diamond ai" /> Connect an AI service first
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="style-start"
          aria-label="Start from style settings"
          onClick={startFromStyle}
        >
          <span className="start-tile-icon">
            <Icon name="sliders" size={20} />
          </span>
          <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
            <span className="style-start-title">Nothing to bring? Start from style settings</span>
            <span className="small muted">
              Skip material: pick a starting point like Alt-rock band or Laid-back hip-hop, set a few basics
              and create{instrumental ? ' an instrumental' : ''}.
            </span>
          </span>
          <Icon name="chevronRight" />
        </button>

        <ConnectNudge />

        <div className="rule-title" style={{ marginTop: 8 }}>
          <span className="index">02</span>
          <h2>Your songs</h2>
          <span className="line" />
          <div className="row wrap">
            <FileButton accept=".songproject,.zip,.mid,.midi" onFile={importFile} icon="upload">
              Open a .songproject or MIDI
            </FileButton>
            <Button icon="plus" onClick={() => setNewName('Untitled song')}>
              Empty project
            </Button>
          </div>
        </div>
        {projects.length === 0 ? (
          <div className="songs-empty hatch-soft">
            <Icon name="music" size={28} />
            <div>
              <h3>No songs yet</h3>
              <p className="muted">
                Pick a starting point above. Songs are saved on this device as you work.
              </p>
            </div>
          </div>
        ) : (
          <div className="song-grid">
            {projects.map((p) => (
              <div key={p.id} className="song-card card">
                <button
                  type="button"
                  className="song-open"
                  aria-label={`Open ${p.name}`}
                  onClick={() => void st.openProject(p.id)}
                />
                <Thumb p={p} />
                <div className="song-card-body">
                  <div className="row between" style={{ gap: 8 }}>
                    <strong className="ellipsis">{p.name}</strong>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      title="Delete project"
                      className="song-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(p.id);
                      }}
                    />
                  </div>
                  <span className="mono small muted">
                    {p.keyName} · {Math.round(p.bpm)} BPM · {p.tracks} tracks
                  </span>
                  <span className="small dim">
                    {p.branch !== 'main' ? `${p.branch} · ` : ''}v{p.revisions} · Edited{' '}
                    {new Date(p.updatedAt).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {confirmDelete && (
        <Modal
          title="Delete project?"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  void st.deleteProject(confirmDelete);
                  setConfirmDelete(null);
                }}
              >
                Delete permanently
              </Button>
            </>
          }
        >
          This removes the project, its version history and its audio from this device. Export a .songproject
          first if you want a backup.
        </Modal>
      )}
      {newName !== null && (
        <Modal
          title="New empty project"
          onClose={() => setNewName(null)}
          footer={
            <>
              <Button onClick={() => setNewName(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={async () => {
                  await st.newProject(newName || 'Untitled song');
                  setNewName(null);
                  useComposeSession.getState().start(null);
                  st.setMode('compose');
                }}
              >
                Create
              </Button>
            </>
          }
        >
          <TextInput value={newName} onChange={setNewName} aria-label="Project name" autoFocus />
        </Modal>
      )}
    </div>
  );
}

const NUDGE_KEY = 'connect-nudge-dismissed';

/** First-run hint: the studio works offline; connecting an AI service is one paste away. */
function ConnectNudge() {
  const hasProviders = useSettings((s) => s.providers.length > 0);
  const [dismissed, setDismissed] = useState(() => localGet<boolean>(NUDGE_KEY, false));
  if (hasProviders || dismissed) return null;
  return (
    <div className="connect-nudge callout row" data-testid="connect-nudge">
      <Icon name="plug" />
      <div className="grow" style={{ minWidth: 0 }}>
        <strong>Works offline — add AI when you want it.</strong>
        <div className="small muted">
          Paste a service API key, then click Connect and use. Song Deck discovers its text and audio models
          and enables the recommended ones for compatible tasks.
        </div>
      </div>
      <Button variant="ai" icon="plug" onClick={() => openSettings('providers', 'connect')}>
        Connect an AI service
      </Button>
      <Button
        variant="ghost"
        icon="close"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => {
          localSet(NUDGE_KEY, true);
          setDismissed(true);
        }}
      />
    </div>
  );
}
