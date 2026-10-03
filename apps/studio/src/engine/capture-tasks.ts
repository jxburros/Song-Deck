import { useMemo } from 'react';
import type { TaskRecord } from '@songdeck/core';
import { taskQueue, useRuntime } from './runtime';
import { handlers as analysisHandlers } from './handlers/analysis';

/**
 * Helpers for running analysis work through the generation queue (spec §63) from a view:
 * enqueue, observe reactively (status/progress/logs, including retries started from the task
 * drawer) and await completion in linear flows.
 */

export interface TaskSpec<I> {
  type: string;
  title: string;
  input: I;
  providerId?: string;
  runner?: string;
  maxAttempts?: number;
  priority?: number;
}

export function enqueueTask<I>(spec: TaskSpec<I>): TaskRecord<I> {
  // initRuntime() registers handlers only after its server health check; make sure ours exist
  // before enqueueing (re-registering the same handler is a no-op), or an early task would fail.
  const handler = analysisHandlers[spec.type];
  if (handler) taskQueue.register(spec.type, handler);
  return taskQueue.enqueue(spec) as TaskRecord<I>;
}

/** Live view of one task (re-renders on status, progress, message, attempts and log changes). */
export function useTask<O = unknown>(id: string | null): TaskRecord<unknown, O> | null {
  const version = useRuntime((s) => {
    if (!id) return '';
    const t = s.tasks.find((x) => x.id === id);
    return t
      ? `${t.status}|${t.progress}|${t.message ?? ''}|${t.attempts}|${t.logs.length}|${t.finishedAt ?? ''}`
      : 'missing';
  });
  return useMemo(() => {
    if (!id) return null;
    const live = taskQueue.get(id) ?? useRuntime.getState().tasks.find((t) => t.id === id);
    return (live as TaskRecord<unknown, O> | undefined) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, version]);
}

/** Resolve with the task's result when it succeeds; reject when it fails or is cancelled. */
export async function awaitTask<O>(id: string): Promise<O> {
  const t = await taskQueue.waitFor(id);
  if (t.status === 'succeeded') return t.result as O;
  if (t.status === 'cancelled') throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
  throw new Error(t.error ?? 'Task failed');
}

/** Enqueue and wait. */
export function runTask<I, O>(spec: TaskSpec<I>): { id: string; done: Promise<O> } {
  const rec = enqueueTask(spec);
  return { id: rec.id, done: awaitTask<O>(rec.id) };
}

export function isActive(t: Pick<TaskRecord, 'status'> | null | undefined): boolean {
  return !!t && (t.status === 'queued' || t.status === 'running' || t.status === 'paused');
}
