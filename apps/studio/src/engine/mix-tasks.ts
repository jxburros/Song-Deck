import { useMemo } from 'react';
import type { TaskRecord } from '@songdeck/core';
import { taskQueue, useRuntime } from './runtime';
import { abortError } from './mix-render';

/**
 * Enqueue a generation-queue task (spec §63) and get a promise for its result. The task stays
 * visible, cancellable and retryable in the queue drawer; the promise settles with its first run.
 */
export interface StartedTask<O> {
  id: string;
  done: Promise<O>;
}

export function startTask<I, O>(
  type: string,
  title: string,
  input: I,
  opts: { priority?: number; maxAttempts?: number; providerId?: string; runner?: string } = {},
): StartedTask<O> {
  const rec = taskQueue.enqueue({
    type,
    title,
    input,
    maxAttempts: opts.maxAttempts ?? 1,
    priority: opts.priority,
    providerId: opts.providerId,
    runner: opts.runner ?? 'local',
  });
  const done = new Promise<O>((resolve, reject) => {
    let settled = false;
    const check = (): boolean => {
      const t = taskQueue.get(rec.id) as TaskRecord<I, O> | undefined;
      if (!t) {
        reject(abortError('Task was removed'));
        return true;
      }
      if (t.status === 'succeeded') {
        resolve(t.result as O);
        return true;
      }
      if (t.status === 'failed') {
        reject(new Error(t.error ?? 'Task failed'));
        return true;
      }
      if (t.status === 'cancelled') {
        reject(abortError());
        return true;
      }
      return false;
    };
    if (check()) return;
    let unsub: (() => void) | null = null;
    unsub = taskQueue.subscribe(() => {
      if (settled) return;
      if (check()) {
        settled = true;
        unsub?.();
      }
    });
    if (settled) unsub?.();
  });
  // Avoid unhandled-rejection noise when the caller only watches the queue.
  done.catch(() => undefined);
  return { id: rec.id, done };
}

/**
 * Live view of one task. Records may be updated in place by the queue, so the selector tracks a
 * version string (status / progress / message / error) to re-render on every change.
 */
export function useTaskRecord(id: string | null | undefined): TaskRecord | undefined {
  const version = useRuntime((s) => {
    if (!id) return '';
    const t = s.tasks.find((x) => x.id === id);
    return t ? `${t.status}|${t.progress}|${t.message ?? ''}|${t.error ?? ''}|${t.attempts}` : 'missing';
  });
  return useMemo(
    () => (id ? (taskQueue.get(id) ?? useRuntime.getState().tasks.find((t) => t.id === id)) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, version],
  );
}

export function isTaskActive(t: Pick<TaskRecord, 'status'> | null | undefined): boolean {
  return !!t && (t.status === 'queued' || t.status === 'running' || t.status === 'paused');
}
