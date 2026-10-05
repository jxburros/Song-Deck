import { useEffect, useMemo, useRef, useState } from 'react';
import { TRACK_NEUTRAL, barToTick, sectionLayout, tickToMusical, type Song } from '@songdeck/core';
import { useSettings } from '../../state/settings';
import { useStudio } from '../../state/store';
import { useRuntime } from '../../engine/runtime';
import {
  PEER_COLORS,
  addCollabComment,
  collabUrl,
  connectCollab,
  disconnectCollab,
  describePresence,
  fetchSharedProject,
  initials,
  inspectSharedProject,
  listRooms,
  listSharedProjects,
  openSharedProject,
  resolveCollabComment,
  retryCollabNow,
  sendCollabChat,
  setCollabPrefs,
  shareProject,
  useCollab,
  type CollabComment,
  type RoomSummary,
  type SharedProjectInfo,
} from '../../engine/collab';
import { Badge, Button, CommitText, Field, Select, TextInput, Toggle } from '../../ui/kit';
import { CollabPresence } from '../shared/CollabPresence';
import { Icon } from '../../ui/icons';
import { ConfirmModal, Panel, TabHeader, bytesLabel, errorMessage, timeAgo, useTicker } from './ui';

/** Real-time collaboration (spec §70 Phase 5): shared projects, live rooms, presence, comments, chat. */

export function Avatar({
  name,
  color,
  size = 26,
  title,
}: {
  name: string;
  color: string;
  size?: number;
  title?: string;
}) {
  return (
    <span
      className="st-avatar"
      style={{ background: color, width: size, height: size, fontSize: size * 0.4 }}
      title={title ?? name}
      aria-label={name}
    >
      {initials(name)}
    </span>
  );
}

export default function CollabTab() {
  const server = useRuntime((s) => s.server.status);
  const project = useStudio((s) => s.project);
  const status = useCollab((s) => s.status);
  const roomId = useCollab((s) => s.projectId);
  useTicker(1000, status === 'reconnecting');
  return (
    <>
      <TabHeader
        icon="users"
        title="Collaboration"
        lede="Share a project through the local Song Deck server and work on it together in real time: every commit reaches the room, concurrent work forks onto collaborator branches instead of overwriting, and you can comment on sections, tracks and bars."
      />
      {server !== 'online' && (
        <div className="callout warning">
          Collaboration runs through a Song Deck server. Start one (
          <code>npx tsx apps/server/src/cli.ts</code>) — or point General → Local server at a shared one.
        </div>
      )}
      <div className="st-two">
        <IdentityPanel />
        <ConnectionPanel />
      </div>
      <SharePanel />
      {status !== 'disconnected' && roomId && project?.meta.id === roomId && (
        <>
          <div className="st-two">
            <PeersPanel />
            <ChatPanel />
          </div>
          <CommentsPanel />
        </>
      )}
      <ActivityPanel />
    </>
  );
}

function IdentityPanel() {
  const userName = useSettings((s) => s.userName);
  const update = useSettings((s) => s.update);
  const color = useCollab((s) => s.color);
  return (
    <Panel
      title="You"
      icon="users"
      sub="How collaborators see you. The name is also the author of your revisions."
    >
      <div className="row" style={{ gap: 12 }}>
        <Avatar name={userName || 'Me'} color={color} size={40} />
        <Field label="Display name" className="grow">
          <CommitText
            value={userName}
            onCommit={(v) => update({ userName: v.trim() || 'Me' })}
            aria-label="Display name"
          />
        </Field>
      </div>
      <div className="field-label" style={{ marginTop: 10 }}>
        Colour
      </div>
      <div className="row wrap" role="radiogroup" aria-label="Colour">
        {PEER_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === color}
            className={`st-swatch ${c === color ? 'on' : ''}`}
            style={{ background: c }}
            onClick={() => setCollabPrefs({ color: c })}
            aria-label={`Colour ${c}`}
          />
        ))}
      </div>
    </Panel>
  );
}

function ConnectionPanel() {
  const project = useStudio((s) => s.project);
  const server = useRuntime((s) => s.server.status);
  const s = useCollab();
  const connectedHere = s.projectId && project?.meta.id === s.projectId;
  const retryIn = s.retryAt ? Math.max(0, Math.ceil((s.retryAt - Date.now()) / 1000)) : null;
  return (
    <Panel
      title="Live room"
      icon="server"
      testId="collab-connection"
      sub={
        project
          ? `Room for “${project.meta.name}” (${project.meta.id})`
          : 'Open a project to collaborate on it.'
      }
      actions={<CollabPresence />}
    >
      <div className="row" style={{ gap: 10 }}>
        <span
          className={`status-dot ${s.status === 'connected' ? 'ok' : s.status === 'disconnected' ? '' : 'busy'}`}
        />
        <strong data-testid="collab-status">
          {s.status === 'connected'
            ? 'Connected'
            : s.status === 'connecting'
              ? 'Connecting…'
              : s.status === 'reconnecting'
                ? `Reconnecting${retryIn !== null ? ` in ${retryIn}s` : '…'}`
                : 'Not connected'}
        </strong>
        {s.status === 'connected' && <Badge tone="success">{s.peers.length + 1} in the room</Badge>}
        <span className="grow" />
        {s.status === 'disconnected' || !connectedHere ? (
          <Button
            variant="primary"
            icon="users"
            onClick={() => connectCollab()}
            disabled={!project || server === 'unknown'}
          >
            Connect
          </Button>
        ) : (
          <>
            {s.status === 'reconnecting' && (
              <Button size="sm" onClick={() => retryCollabNow()}>
                Retry now
              </Button>
            )}
            <Button icon="close" onClick={() => disconnectCollab()}>
              Disconnect
            </Button>
          </>
        )}
      </div>
      {s.error && s.status !== 'connected' && <div className="callout danger small">{s.error}</div>}
      {s.status === 'connected' && (
        <div className="st-sync">
          <span>
            <strong>{s.roomRevisions}</strong> shared revisions
          </span>
          <span>
            <strong>{s.sent}</strong> sent
          </span>
          <span>
            <strong>{s.received}</strong> received
          </span>
          <span className={s.outbox ? 'warn' : ''}>
            <strong>{s.outbox}</strong> waiting
          </span>
        </div>
      )}
      <Toggle
        on={s.autoConnect}
        onChange={(autoConnect) => setCollabPrefs({ autoConnect })}
        label="Join automatically when I open a project"
      />
      <details className="st-adv">
        <summary>Server access</summary>
        <div className="small dim">
          Room URL: <span className="mono">{collabUrl('').replace(/\?.*$/, '')}</span>
        </div>
        <Field
          label="Access token"
          hint="Only for servers started with --token. Kept for this browser session only."
        >
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            value={s.token}
            onChange={(e) => setCollabPrefs({ token: e.target.value })}
            aria-label="Server access token"
          />
        </Field>
      </details>
    </Panel>
  );
}

function SharePanel() {
  const project = useStudio((s) => s.project);
  const projects = useStudio((s) => s.projects);
  const server = useRuntime((s) => s.server.status);
  const toast = useStudio((s) => s.toast);
  const [shared, setShared] = useState<SharedProjectInfo[] | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [replace, setReplace] = useState<{
    info: SharedProjectInfo;
    bytes: Uint8Array;
    localName: string;
  } | null>(null);
  const [overwrite, setOverwrite] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      const [list, r] = await Promise.all([
        listSharedProjects(),
        listRooms().catch(() => [] as RoomSummary[]),
      ]);
      setShared(list);
      setRooms(r);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  useEffect(() => {
    if (server === 'online') void refresh();
  }, [server]);
  useEffect(() => {
    setName(project?.meta.name ?? '');
  }, [project?.meta.id, project?.meta.name]);

  const share = async (confirmed = false) => {
    const target = (name || project?.meta.name || '').trim();
    if (!confirmed && shared?.some((s) => s.name.toLowerCase() === target.toLowerCase())) {
      setOverwrite(target);
      return;
    }
    setBusy('share');
    try {
      const info = await shareProject(name || undefined);
      toast(
        'success',
        `Shared as “${info.name}” — collaborators can open it from their Collaboration settings.`,
      );
      await refresh();
    } catch (err) {
      toast('error', `Could not share: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };
  const open = async (info: SharedProjectInfo) => {
    setBusy(info.name);
    try {
      const bytes = await fetchSharedProject(info.name);
      const meta = inspectSharedProject(bytes);
      const local = projects.find((p) => p.id === meta.id);
      if (local) {
        setReplace({ info, bytes, localName: local.name });
        return;
      }
      await openSharedProject(info.name, bytes);
      toast('success', `Opened “${meta.name}” (${meta.revisions} revisions)`);
    } catch (err) {
      toast('error', `Could not open ${info.name}: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const liveRooms = rooms.filter((r) => r.peers > 0);

  return (
    <Panel
      title="Shared projects"
      icon="folder"
      testId="shared-projects"
      sub="Projects are uploaded as .songproject packages (no API keys — spec §7) to the server’s project store; everyone who opens one joins the same room."
      actions={
        <Button size="sm" icon="rebuild" onClick={() => void refresh()} disabled={server !== 'online'}>
          Refresh
        </Button>
      }
    >
      {project ? (
        <div className="row st-share-row">
          <TextInput
            value={name}
            onChange={setName}
            aria-label="Shared project name"
            placeholder="Project name on the server"
          />
          <Button
            variant="primary"
            icon="upload"
            onClick={() => void share()}
            disabled={server !== 'online' || busy === 'share'}
          >
            {busy === 'share' ? 'Sharing…' : 'Share project'}
          </Button>
        </div>
      ) : (
        <div className="small muted">Open a project to share it.</div>
      )}
      {error && <div className="callout danger small">{error}</div>}
      <div className="row between" style={{ marginTop: 12 }}>
        <span className="field-label">Open a shared project</span>
        {liveRooms.length > 0 && (
          <span className="small dim">
            {liveRooms.length} live room{liveRooms.length === 1 ? '' : 's'} ·{' '}
            {liveRooms.reduce((n, r) => n + r.peers, 0)} people online
          </span>
        )}
      </div>
      {server !== 'online' ? (
        <div className="small dim">The server is not reachable.</div>
      ) : !shared ? (
        <div className="small dim">Loading…</div>
      ) : shared.length === 0 ? (
        <div className="small dim">Nothing shared on this server yet.</div>
      ) : (
        <div className="st-shared-list">
          {shared.map((s) => {
            return (
              <div key={s.file} className="st-shared" data-testid="shared-project">
                <Icon name="folder" size={14} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 600 }}>
                    {s.name}
                  </div>
                  <div className="small dim">
                    {bytesLabel(s.size)} · updated {timeAgo(s.mtime)}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => void open(s)}
                  disabled={!!busy}
                  aria-label={`Open ${s.name}`}
                >
                  {busy === s.name ? 'Opening…' : 'Open'}
                </Button>
              </div>
            );
          })}
        </div>
      )}
      {overwrite && (
        <ConfirmModal
          title={`Replace the shared “${overwrite}”?`}
          confirmLabel="Replace shared project"
          onClose={() => setOverwrite(null)}
          onConfirm={async () => {
            setOverwrite(null);
            await share(true);
          }}
        >
          A project with this name is already shared on the server. Sharing replaces it — collaborators who
          open it afterwards get your version. Pick another name to keep both.
        </ConfirmModal>
      )}
      {replace && (
        <ConfirmModal
          title="Replace your local copy?"
          confirmLabel="Open shared version"
          onClose={() => setReplace(null)}
          onConfirm={async () => {
            const r = replace;
            setReplace(null);
            try {
              await openSharedProject(r.info.name, r.bytes);
              toast('success', `Opened the shared “${r.info.name}”`);
            } catch (err) {
              toast('error', errorMessage(err));
            }
          }}
        >
          “{replace.localName}” is the same project (same id). Opening the shared package replaces your local
          copy with the shared one — export your local version first if it has work you have not shared.
        </ConfirmModal>
      )}
    </Panel>
  );
}

function PeersPanel() {
  const peers = useCollab((s) => s.peers);
  const color = useCollab((s) => s.color);
  const userName = useSettings((s) => s.userName);
  const song = useStudio((s) => s.project?.song ?? null);
  return (
    <Panel title="In the room" icon="users" testId="collab-peers">
      <ul className="st-peers">
        <li>
          <Avatar name={userName || 'Me'} color={color} />
          <div className="grow">
            <strong>{userName || 'Me'}</strong> <span className="small dim">(you)</span>
          </div>
        </li>
        {peers.map((p) => (
          <li key={p.peerId} data-testid="collab-peer">
            <Avatar name={p.user.name} color={p.user.color} />
            <div className="grow" style={{ minWidth: 0 }}>
              <strong>{p.user.name}</strong>
              <div className="small dim ellipsis">{describePresence(p.presence, song)}</div>
            </div>
            <span className="small dim">{timeAgo(p.joinedAt)}</span>
          </li>
        ))}
      </ul>
      {peers.length === 0 && (
        <div className="small dim">
          Nobody else is here yet. Share the project and ask a collaborator to open it.
        </div>
      )}
    </Panel>
  );
}

function anchorLabel(c: CollabComment, song: Song | null): string {
  const parts: string[] = [];
  if (c.sectionId) parts.push(song?.sections.find((s) => s.id === c.sectionId)?.name ?? 'section');
  if (c.trackId) parts.push(song?.tracks.find((t) => t.id === c.trackId)?.name ?? 'track');
  if (c.tick !== undefined && song) {
    try {
      parts.push(`bar ${tickToMusical(song, c.tick).bar}`);
    } catch {
      /* ignore */
    }
  }
  return parts.join(' · ') || 'Whole song';
}

function CommentsPanel() {
  const comments = useCollab((s) => s.comments);
  const song = useStudio((s) => s.project?.song ?? null);
  const toast = useStudio((s) => s.toast);
  const [text, setText] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [trackId, setTrackId] = useState('');
  const [bar, setBar] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const sections = useMemo(() => (song ? sectionLayout(song) : []), [song]);
  const visible = comments
    .filter((c) => showResolved || !c.resolved)
    .sort((a, b) => a.at.localeCompare(b.at));
  const submit = async () => {
    if (!text.trim() || !song) return;
    let tick: number | undefined;
    const barNum = Number(bar);
    if (bar.trim() && Number.isInteger(barNum) && barNum >= 1) tick = barToTick(song, barNum - 1);
    else if (sectionId) tick = sections.find((s) => s.section.id === sectionId)?.startTick;
    try {
      await addCollabComment(text.trim(), {
        sectionId: sectionId || undefined,
        trackId: trackId || undefined,
        tick,
      });
      setText('');
    } catch (err) {
      toast('error', `Comment not sent: ${errorMessage(err)}`);
    }
  };
  return (
    <Panel
      title="Comments"
      icon="chat"
      testId="collab-comments"
      sub="Anchored to a section, a track and/or a bar — they stay with the room."
      actions={
        <Toggle
          on={showResolved}
          onChange={setShowResolved}
          label={`Show resolved (${comments.filter((c) => c.resolved).length})`}
        />
      }
    >
      <form
        className="st-comment-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextInput value={text} onChange={setText} placeholder="Comment on the song…" aria-label="Comment" />
        <Select
          size="sm"
          value={sectionId}
          onChange={setSectionId}
          options={[
            { value: '', label: 'Any section' },
            ...sections.map((s) => ({
              value: s.section.id,
              label: `${s.section.name} (bar ${s.startBar + 1})`,
            })),
          ]}
          aria-label="Section"
        />
        <Select
          size="sm"
          value={trackId}
          onChange={setTrackId}
          options={[
            { value: '', label: 'Any track' },
            ...(song?.tracks ?? []).map((t) => ({ value: t.id, label: t.name })),
          ]}
          aria-label="Track"
        />
        <input
          className="input sm mono"
          value={bar}
          onChange={(e) => setBar(e.target.value.replace(/[^\d]/g, ''))}
          placeholder="bar"
          aria-label="Bar"
          style={{ width: 64 }}
        />
        <Button type="submit" variant="primary" size="sm" disabled={!text.trim()}>
          Comment
        </Button>
      </form>
      {visible.length === 0 ? (
        <div className="small dim">{comments.length ? 'All comments are resolved.' : 'No comments yet.'}</div>
      ) : (
        <ul className="st-comments">
          {visible.map((c) => (
            <li key={c.id} className={c.resolved ? 'resolved' : ''} data-testid="collab-comment">
              <div className="row between">
                <span className="row" style={{ gap: 6 }}>
                  <strong>{c.author}</strong>
                  <Badge>{anchorLabel(c, song)}</Badge>
                  {c.pending && <span className="small dim">sending…</span>}
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <span className="small dim">{timeAgo(c.at)}</span>
                  <Button
                    size="sm"
                    variant={c.resolved ? 'ghost' : 'success'}
                    icon={c.resolved ? 'undo' : 'check'}
                    onClick={() =>
                      void resolveCollabComment(c.id, !c.resolved).catch((err) =>
                        toast('error', errorMessage(err)),
                      )
                    }
                  >
                    {c.resolved ? 'Reopen' : 'Resolve'}
                  </Button>
                </span>
              </div>
              <div className="st-comment-text">{c.text}</div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ChatPanel() {
  const chat = useCollab((s) => s.chat);
  const toast = useStudio((s) => s.toast);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [chat.length]);
  return (
    <Panel title="Chat" icon="chat" testId="collab-chat">
      <div className="st-chat">
        {chat.length === 0 && <div className="small dim">Say hello.</div>}
        {chat.map((m, i) => (
          <div key={`${m.at}-${i}`} className={`st-chat-msg ${m.mine ? 'mine' : ''}`}>
            <Avatar name={m.user?.name ?? '?'} color={m.user?.color ?? TRACK_NEUTRAL} size={20} />
            <div>
              <div className="small dim">
                {m.user?.name} · {timeAgo(m.at)}
              </div>
              <div>{m.text}</div>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            sendCollabChat(text);
            setText('');
          } catch (err) {
            toast('error', errorMessage(err));
          }
        }}
      >
        <TextInput
          value={text}
          onChange={setText}
          placeholder="Message the room…"
          aria-label="Chat message"
        />
        <Button type="submit" disabled={!text.trim()}>
          Send
        </Button>
      </form>
    </Panel>
  );
}

function ActivityPanel() {
  const activity = useCollab((s) => s.activity);
  if (!activity.length) return null;
  return (
    <Panel title="Room activity" icon="history">
      <ul className="st-activity">
        {activity.slice(0, 20).map((a) => (
          <li key={a.id} className={a.tone}>
            <Icon
              name={
                a.tone === 'error'
                  ? 'alert'
                  : a.tone === 'success'
                    ? 'check'
                    : a.tone === 'warning'
                      ? 'alert'
                      : 'info'
              }
              size={13}
            />
            <span className="grow">{a.text}</span>
            <span className="small dim nowrap">{timeAgo(a.at)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
