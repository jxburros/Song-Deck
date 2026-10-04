import { useState } from 'react';
import { midiToSong } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { localGet, localSet } from '../../state/persistence';
import { openSettings } from '../settings/nav';
import { Badge, Button, FileButton, Modal, TextInput } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { useComposeSession } from '../compose/session';
import './home.css';

export default function Home() {
  const projects = useStudio((s) => s.projects);
  const st = useStudio.getState();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);

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

  return (
    <div className="mode-page home-page">
      <div className="home">
        <div className="home-heading">
          <span className="eyebrow">Your personal music studio</span>
          <span className="eyebrow home-edition">Song Deck / 01</span>
        </div>
        <section className="hero" aria-labelledby="home-title">
          <div className="hero-copy">
            <p className="eyebrow">Human creativity × artificial intelligence</p>
            <h1 id="home-title">
              AI proposes.
              <br />
              <span>You shape it.</span>
            </h1>
            <p className="promise">
              Your idea. Every note. Entirely yours.
              <br />
              Compose, refine, and produce music you can keep changing.
            </p>
            <div className="hero-actions">
              <Button variant="primary" size="lg" icon="sparkles" onClick={() => st.setMode('compose')}>
                Compose a new song
              </Button>
              <Button
                size="lg"
                icon="book"
                onClick={() => {
                  useComposeSession.getState().set({ tab: 'lyrics' });
                  st.setMode('compose');
                }}
              >
                Start from lyrics
              </Button>
            </div>
            <p className="hero-footnote">
              Ideas become music <span /> You stay in control
            </p>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="hero-art-label eyebrow">More possible sounds</div>
            <div className="hero-art-caption">
              <span>SONG DECK</span>
              <small>A new dimension for your ideas</small>
            </div>
          </div>
        </section>

        <div className="creation-grid" aria-label="Ways to create">
          <button className="creation-card" aria-label="Single Track" onClick={() => st.setMode('single')}>
            <span className="eyebrow">01 / Generate</span>
            <Icon name="midi" size={24} />
            <strong>A spark of something.</strong>
            <span>Create MIDI, render audio, or convert audio to notes.</span>
            <span className="creation-link">
              Single Track <Icon name="chevronRight" />
            </span>
          </button>
          <button className="creation-card" aria-label="Browse Library" onClick={() => st.setMode('library')}>
            <span className="eyebrow">02 / Library</span>
            <Icon name="mic" size={24} />
            <strong>Keep your ideas close.</strong>
            <span>Save tracks and files. Reuse them across projects.</span>
            <span className="creation-link">
              Browse Library <Icon name="chevronRight" />
            </span>
          </button>
          <button
            className="creation-card"
            aria-label="Rebuild a recording"
            onClick={() => st.setMode('rebuild')}
          >
            <span className="eyebrow">03 / Reimagine</span>
            <Icon name="rebuild" size={24} />
            <strong>Find a new direction.</strong>
            <span>Reconstruct a recording. Reshape the song.</span>
            <span className="creation-link">
              Rebuild a recording <Icon name="chevronRight" />
            </span>
          </button>
        </div>

        <ConnectNudge />

        <div className="section-title">
          <div>
            <span className="eyebrow">Your projects</span>
            <h2>Recent projects</h2>
          </div>
          <div className="row wrap">
            <FileButton accept=".songproject,.zip,.mid,.midi" onFile={importFile} icon="upload">
              Import .songproject / MIDI
            </FileButton>
            <Button icon="plus" onClick={() => setNewName('Untitled project')}>
              Empty project
            </Button>
          </div>
        </div>
        {projects.length === 0 ? (
          <div className="library-empty">
            <Icon name="music" size={28} />
            <div>
              <h3>Your next sound starts here.</h3>
              <p>No projects yet. Compose a song, capture an idea, or import your music.</p>
            </div>
            <span className="eyebrow">No API key needed</span>
          </div>
        ) : (
          <div className="project-grid">
            {projects.map((p) => (
              <div key={p.id} className="card project-card">
                <button
                  className="project-open"
                  aria-label={`Open ${p.name}`}
                  onClick={() => void st.openProject(p.id)}
                />
                <div className="row between">
                  <div style={{ fontWeight: 700 }} className="ellipsis">
                    {p.name}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    title="Delete project"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDelete(p.id);
                    }}
                  />
                </div>
                <div className="small muted" style={{ marginBottom: 8 }}>
                  {p.title !== p.name ? `${p.title} · ` : ''}
                  {p.keyName} · {Math.round(p.bpm)} BPM
                </div>
                <div className="row wrap">
                  <Badge>{p.tracks} tracks</Badge>
                  <Badge>{p.sections} sections</Badge>
                  <Badge tone="accent">
                    <Icon name="branch" size={11} /> {p.branch}
                  </Badge>
                  <Badge>v{p.revisions}</Badge>
                </div>
                <div className="small dim" style={{ marginTop: 8 }}>
                  Edited {new Date(p.updatedAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="section-title" style={{ marginTop: 22 }}>
          <div>
            <span className="eyebrow">From idea to expression</span>
            <h2>How Song Deck works</h2>
          </div>
        </div>
        <div className="grid-4 principles">
          {[
            [
              'compose',
              'Composition first',
              'Prompt → Song Blueprint → plan → MIDI. The song is structured data you own: key, chords, melodies, motifs, lyrics.',
            ],
            [
              'lock',
              'Lock & regenerate',
              'Lock anything — tempo, chords, a drum section — then regenerate only unlocked material, reproducibly by seed.',
            ],
            [
              'sparkles',
              'AI proposes, you decide',
              'Natural-language edits come back as visual note diffs to accept, reject or modify. Bad model output never corrupts a project.',
            ],
            [
              'shield',
              'Any AI, or none',
              'Bring your own keys, run local models, or stay fully offline. Every request shows exactly what leaves the device.',
            ],
          ].map(([icon, title, body]) => (
            <div className="card" key={title}>
              <div className="row" style={{ marginBottom: 6, color: 'var(--accent-text)' }}>
                <Icon name={icon} />
                <strong style={{ color: 'var(--text)' }}>{title}</strong>
              </div>
              <div className="small muted">{body}</div>
            </div>
          ))}
        </div>
        <footer className="home-footer">
          <span>AI that gives you the song back.</span>
          <span>Stored on this device · autosaved with full version history</span>
        </footer>
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
                  await st.newProject(newName || 'Untitled project');
                  setNewName(null);
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
    <div
      className="card row connect-nudge"
      data-testid="connect-nudge"
      style={{
        gap: 12,
        marginBottom: 18,
        borderColor: 'var(--ai-line)',
        boxShadow: 'inset 3px 0 0 var(--ai)',
      }}
    >
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
