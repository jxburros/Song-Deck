import type { TaskRecord } from '@songdeck/core';
import {
  REBUILD_PIPELINE,
  useAnalysisLive,
  type LiveStage,
  type StageStatus,
} from '../../engine/handlers/analysis';
import { Badge, Progress, Spinner } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { confidenceTone, pct } from '../transcribe/widgets';

const STATUS_LABEL: Record<StageStatus, string> = {
  pending: 'waiting',
  running: 'running',
  done: 'done',
  skipped: 'skipped',
  failed: 'failed',
};

function StatusIcon({ status }: { status: StageStatus }) {
  if (status === 'running') return <Spinner />;
  if (status === 'done')
    return (
      <span style={{ color: 'var(--success)', display: 'inline-flex' }}>
        <Icon name="check" size={14} />
      </span>
    );
  if (status === 'failed')
    return (
      <span style={{ color: 'var(--danger)', display: 'inline-flex' }}>
        <Icon name="alert" size={14} />
      </span>
    );
  if (status === 'skipped')
    return (
      <span style={{ color: 'var(--text-dim)', display: 'inline-flex' }}>
        <Icon name="minus" size={14} />
      </span>
    );
  return (
    <span
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: '2px solid var(--border-strong)',
        display: 'inline-block',
        margin: 1,
      }}
    />
  );
}

/**
 * The Rebuild pipeline exactly as the spec draws it (§25):
 * Audio → Source separation → Tempo / beat detection → Key detection → Chord analysis →
 * Pitch transcription → Instrument classification → MIDI reconstruction →
 * Song structure reconstruction → Editable project — with live status, progress and confidence.
 */
export function Pipeline({
  runId,
  task,
  hasAudio,
  opened,
}: {
  runId: string | null;
  task: TaskRecord | null;
  hasAudio: boolean;
  opened: boolean;
}) {
  const run = useAnalysisLive((s) => (runId ? s.runs[runId] : undefined));
  const stages: LiveStage[] = REBUILD_PIPELINE.map((s) => {
    const live = run?.stages[s.id];
    let st: LiveStage = live ?? { id: s.id, label: s.label, status: 'pending', progress: 0 };
    if (s.id === 'audio') st = { ...st, status: hasAudio ? 'done' : 'pending', progress: hasAudio ? 1 : 0 };
    if (s.id === 'project')
      st = {
        ...st,
        status: opened ? 'done' : task?.status === 'succeeded' ? 'pending' : st.status,
        detail: opened
          ? 'Opened in the workbench'
          : task?.status === 'succeeded'
            ? 'Ready — open it as a project'
            : st.detail,
      };
    if (task && (task.status === 'cancelled' || task.status === 'failed') && st.status === 'running')
      st = { ...st, status: task.status === 'failed' ? 'failed' : 'pending' };
    return st;
  });
  return (
    <ol
      className="rebuild-pipeline"
      data-testid="rebuild-pipeline"
      style={{ listStyle: 'none', margin: 0, padding: 0 }}
    >
      {stages.map((s, i) => (
        <li key={s.id} data-stage={s.id} data-status={s.status}>
          <div
            className="row"
            style={{
              alignItems: 'flex-start',
              padding: '7px 10px',
              borderRadius: 'var(--radius)',
              border: `1px solid ${s.status === 'running' ? 'var(--ai)' : s.status === 'failed' ? 'var(--danger)' : 'var(--border)'}`,
              background:
                s.status === 'running'
                  ? 'var(--ai-soft)'
                  : s.status === 'done'
                    ? 'var(--bg-elev-2)'
                    : 'transparent',
              opacity: s.status === 'pending' ? 0.75 : 1,
            }}
          >
            <span style={{ width: 18, display: 'inline-flex', justifyContent: 'center', paddingTop: 1 }}>
              <StatusIcon status={s.status} />
            </span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row between">
                <strong style={{ fontWeight: i === 0 || i === stages.length - 1 ? 700 : 600 }}>
                  {s.label}
                </strong>
                <span className="row" style={{ gap: 6 }}>
                  {s.confidence !== undefined && (
                    <Badge tone={confidenceTone(s.confidence)} title="Stage confidence">
                      {pct(s.confidence)}
                    </Badge>
                  )}
                  <span className="small dim">{STATUS_LABEL[s.status]}</span>
                </span>
              </div>
              {s.detail && (
                <div className="small muted ellipsis" title={s.detail}>
                  {s.detail}
                </div>
              )}
              {s.status === 'running' && (
                <div style={{ marginTop: 5 }}>
                  <Progress
                    value={s.progress > 0 && s.progress < 1 ? s.progress : (task?.progress ?? 0)}
                    ai
                  />
                </div>
              )}
            </div>
          </div>
          {i < stages.length - 1 && (
            <div
              aria-hidden
              style={{
                display: 'flex',
                justifyContent: 'flex-start',
                paddingLeft: 17,
                height: 12,
                color: 'var(--text-dim)',
              }}
            >
              <span
                style={{
                  width: 2,
                  background: s.status === 'done' ? 'var(--success)' : 'var(--border-strong)',
                  height: '100%',
                }}
              />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
