import { useMemo } from 'react';
import { midiToNoteName, validateLyricAlignment, type Project, type Track } from '@songdeck/core';
import { useTask } from '../../engine/capture-tasks';
import {
  activeRender,
  lyricsOfTrack,
  modeInfo,
  resolveVoice,
  staleSections,
  takesTrackFor,
  VOICE_KIND_LABEL,
} from '../../engine/vocal-model';
import { useVocalJobs, type VocalActivity } from '../../engine/vocal-sync';
import { Badge, Kv } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { PendingVocalProposals } from './Proposals';
import { useVocalSession } from './session';

function ActivityRow({ a }: { a: VocalActivity }) {
  const task = useTask(a.taskId ?? null);
  const time = new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <li>
      <span className="dim mono">{time}</span>
      <span>{a.text}</span>
      {task ? (
        <Badge
          tone={
            task.status === 'succeeded'
              ? 'success'
              : task.status === 'failed'
                ? 'danger'
                : task.status === 'running'
                  ? 'ai'
                  : undefined
          }
        >
          {task.status}
        </Badge>
      ) : (
        <span />
      )}
    </li>
  );
}

/** The vocal at a glance: mode, melody, lyrics alignment, voice + consent, render freshness, takes. */
export function VocalSummary({ project, track }: { project: Project; track: Track }) {
  const song = project.song;
  const session = useVocalSession();
  const activity = useVocalJobs((s) => s.activity);
  const voice = resolveVoice(project, song.vocals.voiceId, track);
  const render = activeRender(project, track.id);
  const validation = useMemo(() => validateLyricAlignment(song, track.id), [song, track.id]);
  const lines = lyricsOfTrack(song, track.id).length;
  const pitches = track.notes.map((n) => n.pitch);
  const range = pitches.length
    ? `${midiToNoteName(Math.min(...pitches))}–${midiToNoteName(Math.max(...pitches))}`
    : '—';
  const renderVoice = render?.render?.voiceId ?? render?.rendered?.voiceKey;
  const stale = render ? staleSections(song, track, render.rendered, renderVoice ?? voice.key) : null;
  const takes = song.vocals.takes.filter((t) => t.trackId === takesTrackFor(song, track.id)?.id);
  const mode = modeInfo(song.vocals.mode);
  return (
    <>
      <div className="panel" data-testid="vocal-summary">
        <div className="panel-header">
          <Icon name="music" />
          <h3 className="grow">Overview</h3>
          <Badge tone="accent">{mode.label}</Badge>
        </div>
        <div className="panel-body col" style={{ gap: 8 }}>
          <Kv
            items={[
              ['Track', `${track.name}${track.vocal?.voiceType ? ` · ${track.vocal.voiceType}` : ''}`],
              ['Melody', `${track.notes.length} notes · ${range}`],
              [
                'Lyrics',
                lines ? (
                  <span key="l">
                    {lines} lines ·{' '}
                    {validation.ok ? (
                      <span style={{ color: 'var(--success)' }}>aligned</span>
                    ) : (
                      <span style={{ color: 'var(--warning)' }} title={validation.issues.join('\n')}>
                        {validation.issues.length} issue{validation.issues.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>
                ) : (
                  'none yet'
                ),
              ],
              [
                'Voice',
                `${voice.name} · ${voice.source === 'built-in' ? 'built-in' : VOICE_KIND_LABEL[voice.kind]}`,
              ],
              [
                'Render',
                render ? (
                  <span key="r" className="mono small">
                    {render.asset?.name ?? 'render'}
                  </span>
                ) : (
                  'none'
                ),
              ],
              [
                'Takes',
                takes.length ? `${takes.length} · ${takes.filter((t) => t.active).length} active` : 'none',
              ],
            ]}
          />
          {stale && stale.sections.length > 0 && (
            <div className="small" style={{ color: 'var(--warning)' }}>
              <Icon name="alert" size={12} /> Render out of date:{' '}
              {stale.sections.map((s) => s.section.name).join(', ')}
              {session.tab !== 'render' && (
                <>
                  {' '}
                  —{' '}
                  <a
                    href="#render"
                    onClick={(e) => {
                      e.preventDefault();
                      session.set({ tab: 'render' });
                    }}
                  >
                    re-sing
                  </a>
                </>
              )}
            </div>
          )}
          {voice.kind !== 'stock' && !voice.authorized && (
            <div className="small" style={{ color: 'var(--danger)' }}>
              <Icon name="shield" size={12} /> {voice.name} has no authorization on file.
            </div>
          )}
        </div>
      </div>
      {/* The Regenerate and Record tabs show their proposals inline. */}
      {session.tab !== 'regenerate' && session.tab !== 'recording' && (
        <PendingVocalProposals project={project} compact />
      )}
      {activity.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <Icon name="history" />
            <h3 className="grow">Vocal activity</h3>
          </div>
          <div className="panel-body">
            <ul className="vx-activity" aria-label="Vocal activity">
              {activity.slice(0, 8).map((a) => (
                <ActivityRow key={a.id} a={a} />
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
