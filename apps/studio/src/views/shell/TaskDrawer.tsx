import { useState } from 'react';
import type { TaskRecord } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { taskQueue, useRuntime } from '../../engine/runtime';
import { Badge, Button, Progress } from '../../ui/kit';

const TONE: Record<TaskRecord['status'], 'ai' | 'success' | 'danger' | 'warning' | undefined> = {
  queued: undefined,
  running: 'ai',
  paused: 'warning',
  succeeded: 'success',
  failed: 'danger',
  cancelled: undefined,
};

/** Generation queue (spec §63): cancellable, resumable, retryable, independently inspectable. */
export function TaskDrawer() {
  const open = useStudio((s) => s.taskDrawerOpen);
  const setOpen = useStudio((s) => s.setTaskDrawer);
  const tasks = useRuntime((s) => s.tasks);
  const [inspect, setInspect] = useState<string | null>(null);
  if (!open) return null;
  const ordered = [...tasks].reverse();
  const current = ordered.find((t) => t.id === inspect);
  return (
    <div className="drawer" role="region" aria-label="Generation queue">
      <div className="panel-header">
        <h3 className="grow">Generation queue</h3>
        <Button size="sm" onClick={() => taskQueue.clearFinished()}>
          Clear finished
        </Button>
        <Button size="sm" variant="ghost" icon="close" onClick={() => setOpen(false)} />
      </div>
      <div className="row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch' }}>
        <div className="scroll grow" style={{ padding: 8 }}>
          {ordered.length === 0 && <div className="muted" style={{ padding: 12 }}>No tasks yet. Renders, generations, transcriptions and rebuilds appear here.</div>}
          <table className="table">
            <tbody>
              {ordered.map((t) => (
                <tr key={t.id} onClick={() => setInspect(t.id)} style={{ cursor: 'pointer', background: inspect === t.id ? 'var(--bg-elev-3)' : undefined }}>
                  <td style={{ width: 90 }}>
                    <Badge tone={TONE[t.status]}>{t.status}</Badge>
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{t.title}</div>
                    <div className="small dim">
                      {t.type}
                      {t.runner ? ` · ${t.runner}` : ''}
                      {t.attempts > 1 ? ` · attempt ${t.attempts}` : ''}
                      {t.message ? ` · ${t.message}` : ''}
                    </div>
                  </td>
                  <td style={{ width: 160 }}>{t.status === 'running' || t.status === 'paused' ? <Progress value={t.progress} ai /> : null}</td>
                  <td style={{ width: 210, textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                    {(t.status === 'running' || t.status === 'queued') && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => taskQueue.pause(t.id)}>
                          Pause
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => taskQueue.cancel(t.id)}>
                          Cancel
                        </Button>
                      </>
                    )}
                    {t.status === 'paused' && (
                      <Button size="sm" variant="ghost" onClick={() => taskQueue.resume(t.id)}>
                        Resume
                      </Button>
                    )}
                    {(t.status === 'failed' || t.status === 'cancelled') && (
                      <Button size="sm" variant="ghost" onClick={() => taskQueue.retry(t.id)}>
                        Retry
                      </Button>
                    )}
                    {t.status !== 'running' && (
                      <Button size="sm" variant="ghost" icon="trash" onClick={() => taskQueue.remove(t.id)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {current && (
          <div className="scroll" style={{ width: 380, borderLeft: '1px solid var(--border)', padding: 10, fontSize: 12 }}>
            <h4>Inspect</h4>
            <div className="kv" style={{ marginBottom: 8 }}>
              <dt>Task</dt>
              <dd>{current.title}</dd>
              <dt>Created</dt>
              <dd>{new Date(current.createdAt).toLocaleTimeString()}</dd>
              {current.finishedAt && (
                <>
                  <dt>Finished</dt>
                  <dd>{new Date(current.finishedAt).toLocaleTimeString()}</dd>
                </>
              )}
              {current.providerId && (
                <>
                  <dt>Provider</dt>
                  <dd>{current.providerId}</dd>
                </>
              )}
              {current.costUsd !== undefined && (
                <>
                  <dt>Cost</dt>
                  <dd>${current.costUsd.toFixed(4)}</dd>
                </>
              )}
              {current.error && (
                <>
                  <dt>Error</dt>
                  <dd style={{ color: 'var(--danger)' }}>{current.error}</dd>
                </>
              )}
            </div>
            <h4>Log</h4>
            <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
              {current.logs.map((l) => `${l.t.slice(11, 19)} ${l.level.toUpperCase()} ${l.message}`).join('\n') || '—'}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
