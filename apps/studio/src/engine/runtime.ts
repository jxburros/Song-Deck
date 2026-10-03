import { create } from 'zustand';
import { TaskQueue, type TaskRecord, type TaskStatus } from '@songdeck/core';
import { kvDelete, kvGet, kvSet } from '../state/persistence';
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

/*
 * Task persistence (spec §63 "resumable"). The task list is saved small: audio and songs are
 * stripped from inputs and results. A task that can still run (queued, running, paused, or
 * failed and retryable) has its full input stored once under its own key and restored on load,
 * so work interrupted by a reload resumes with the original audio. Stored inputs are deleted
 * once the task succeeds, is cancelled or is removed.
 */
const INPUT_KEY = 'task-input:';
const INPUT_REF = '__storedInput';
const RESUMABLE: ReadonlySet<TaskStatus> = new Set(['queued', 'running', 'paused', 'failed']);
const storedInputs = new Set<string>();

export const taskQueue = new TaskQueue({
  concurrency: 2,
  // Handlers live in code-split modules; a task enqueued before they load waits for them.
  awaitHandlers: true,
  persistence: {
    async load() {
      const tasks = (await kvGet<TaskRecord[]>('tasks')) ?? [];
      for (const t of tasks) {
        const saved = t.input as Record<string, unknown> | null;
        const ref = saved?.[INPUT_REF];
        if (typeof ref !== 'string') continue;
        const full = await kvGet<unknown>(INPUT_KEY + ref);
        if (full === undefined) {
          t.input = saved?.summary; // handlers see a stripped input and explain what to redo
          continue;
        }
        t.input = full;
        storedInputs.add(t.id);
      }
      return tasks;
    },
    async save(tasks) {
      const kept = tasks.slice(-100);
      const live = new Set<string>();
      const out: TaskRecord[] = [];
      for (const t of kept) {
        let input = stripLarge(t.input);
        if (RESUMABLE.has(t.status) && isLarge(t.input) && (await storeInput(t))) {
          live.add(t.id);
          input = { [INPUT_REF]: t.id, summary: input };
        }
        out.push({ ...t, input, result: stripLarge(t.result) });
      }
      await kvSet('tasks', out);
      for (const id of [...storedInputs]) {
        if (live.has(id)) continue;
        storedInputs.delete(id);
        await kvDelete(INPUT_KEY + id);
      }
    },
  },
});

async function storeInput(t: TaskRecord): Promise<boolean> {
  if (storedInputs.has(t.id)) return true;
  storedInputs.add(t.id);
  try {
    await kvSet(INPUT_KEY + t.id, t.input);
    return true;
  } catch {
    storedInputs.delete(t.id); // e.g. storage quota: the task still runs, it just won't resume
    return false;
  }
}

/** Whether a value holds audio, a song snapshot or a long array (what stripLarge removes). */
function isLarge(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  if (ArrayBuffer.isView(v)) return true;
  if (Array.isArray(v)) return v.length > 200 || v.some(isLarge);
  return Object.entries(v as Record<string, unknown>).some(([k, val]) => k === 'song' || k === 'snapshot' || isLarge(val));
}

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
  const instruments = import('./render-instruments').then(({ initInstrumentSync }) => initInstrumentSync());
  void checkServer();
  setInterval(() => void checkServer(), 15000);
  await Promise.all([handlers, ai, instruments]);
  await taskQueue.restore();
}
