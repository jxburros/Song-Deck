import { useState } from 'react';
import { midiToSong } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { localGet, localSet } from '../../state/persistence';
import { openSettings } from '../settings/nav';
import { Badge, Button, FileButton, Modal, TextInput } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { useComposeSession } from '../compose/session';

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
    <div className="mode-page">
      <div className="home">
        <div className="hero">
          <h1>AI that gives you the song back.</h1>
          <p className="promise">
            Generate a song. Keep the song. Change the notes. Change the instruments. Change the singer. Change the production. Regenerate only what
            you want. Use whichever AI you want — or none at all: everything here runs on this device until you choose a provider.
          </p>
          <div className="row wrap" style={{ marginTop: 14 }}>
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
            <Button size="lg" icon="plus" onClick={() => setNewName('Untitled project')}>
              Empty project
            </Button>
            <FileButton accept=".songproject,.zip,.mid,.midi" onFile={importFile} icon="upload">
              Import .songproject / MIDI
            </FileButton>
            <Button icon="rebuild" onClick={() => st.setMode('rebuild')}>
              Rebuild a recording
            </Button>
            <Button icon="mic" onClick={() => st.setMode('transcribe')}>
              Hum an idea
            </Button>
            <Button icon="midi" onClick={() => st.setMode('generate')}>
              Generate a MIDI part
            </Button>
          </div>
        </div>

        <ConnectNudge />

        <div className="section-title">
          <h3>Recent projects</h3>
          <span className="muted small">Stored on this device · autosaved with full version history</span>
        </div>
        {projects.length === 0 ? (
          <div className="card muted">No projects yet. Start by composing a song from a prompt — no API key needed.</div>
        ) : (
          <div className="project-grid">
            {projects.map((p) => (
              <div key={p.id} className="card selectable" onClick={() => void st.openProject(p.id)} role="button" tabIndex={0}>
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
          <h3>How Song Deck works</h3>
        </div>
        <div className="grid-4">
          {[
            ['compose', 'Composition first', 'Prompt → Song Blueprint → plan → MIDI. The song is structured data you own: key, chords, melodies, motifs, lyrics.'],
            ['lock', 'Lock & regenerate', 'Lock anything — tempo, chords, a drum section — then regenerate only unlocked material, reproducibly by seed.'],
            ['sparkles', 'AI proposes, you decide', 'Natural-language edits come back as visual note diffs to accept, reject or modify. Bad model output never corrupts a project.'],
            ['shield', 'Any AI, or none', 'Bring your own keys, run local models, or stay fully offline. Every request shows exactly what leaves the device.'],
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
          This removes the project, its version history and its audio from this device. Export a .songproject first if you want a backup.
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
          <TextInput value={newName} onChange={setNewName} autoFocus />
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
    <div className="card row" data-testid="connect-nudge" style={{ gap: 12, marginBottom: 18, borderColor: 'var(--ai-line)', boxShadow: 'inset 3px 0 0 var(--ai)' }}>
      <Icon name="plug" />
      <div className="grow" style={{ minWidth: 0 }}>
        <strong>Works offline — add AI when you want it.</strong>
        <div className="small muted">Paste an API key (Gemini, Claude, OpenAI, ElevenLabs…) or use a local model server; Song Deck lists what each model can do here.</div>
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
