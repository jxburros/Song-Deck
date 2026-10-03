import { create } from 'zustand';
import { TaskQueue, type TaskRecord } from '@songdeck/core';
import { kvGet, kvSet } from '../state/persistence';
import { serverBase } from '../state/settings';

/**
 * Runtime services shared across modes:
 *  - the generation Task Engine (spec §63): cancellable, resumable, retryable, inspectable jobs
 *  - local-server connectivity (vault, proxy, hardware, model manager, render nodes, collaboration)
 */

export interface ServerInfo {
  name: string;
  version: string;
  vault?: { backend: string };
  features?: string[];
}

interface RuntimeState {
  server: { status: 'unknown' | 'online' | 'offline'; info?: ServerInfo; checkedAt?: string };
  tasks: TaskRecord[];
}

export const useRuntime = create<RuntimeState>(() => ({
  server: { status: 'unknown' },
  tasks: [],
}));

export const taskQueue = new TaskQueue({
  concurrency: 2,
  // Handlers live in code-split modules; a task enqueued before they load waits for them.
  awaitHandlers: true,
  persistence: {
    async load() {
      return (await kvGet<TaskRecord[]>('tasks')) ?? [];
    },
    async save(tasks) {
      // Persist only metadata + checkpoints (inputs may hold large audio; strip typed arrays).
      await kvSet(
        'tasks',
        tasks.slice(-100).map((t) => ({ ...t, input: stripLarge(t.input), result: stripLarge(t.result) })),
      );
    },
  },
});

function stripLarge(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) return `[${(v as ArrayBufferView).byteLength} bytes]`;
  if (Array.isArray(v)) return v.length > 200 ? `[array(${v.length})]` : v.map(stripLarge);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'song' || k === 'snapshot') out[k] = '[song]';
    else out[k] = stripLarge(val);
  }
  return out;
}

taskQueue.subscribe((tasks) => useRuntime.setState({ tasks: [...tasks] }));

export async function checkServer(): Promise<void> {
  const base = serverBase();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(String(res.status));
    const info = (await res.json()) as ServerInfo;
    useRuntime.setState({ server: { status: 'online', info, checkedAt: new Date().toISOString() } });
  } catch {
    useRuntime.setState({ server: { status: 'offline', checkedAt: new Date().toISOString() } });
  }
}

let started = false;

export async function initRuntime(): Promise<void> {
  if (started) return;
  started = true;
  // Task handlers and the AI runtime load in parallel with the server probe (the AI runtime
  // reacts to the server status when it arrives), so work queued at startup starts promptly.
  const handlers = import('./taskHandlers').then(({ registerTaskHandlers }) => registerTaskHandlers(taskQueue));
  const ai = import('./ai').then(({ initAi }) => initAi());
  void checkServer();
  setInterval(() => void checkServer(), 15000);
  await Promise.all([handlers, ai]);
  await taskQueue.restore();
}
