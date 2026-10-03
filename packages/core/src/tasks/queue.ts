import type { TaskLogEntry, TaskRecord, TaskStatus } from '../ir/types';
import { randomId } from '../util/ids';

/**
 * Task engine (spec §63): expensive operations (separation, transcription, generation,
 * rendering, mastering…) run through a queue whose tasks are cancellable, resumable,
 * retryable and independently inspectable. Works in browsers and Node (AbortController +
 * microtasks only).
 */

export interface TaskContext<I = unknown> {
  input: I;
  /** Aborted when the task is cancelled, paused or removed. */
  signal: AbortSignal;
  /** 1-based attempt number. */
  attempt: number;
  /** Last checkpoint saved by a previous attempt (resume / retry / restore). */
  previousCheckpoint?: unknown;
  /** Progress 0..1 (clamped) with an optional status message. */
  progress(p: number, message?: string): void;
  log(level: TaskLogEntry['level'], message: string): void;
  /** Save resumable state; it survives pause, retry and (with persistence) restarts. */
  checkpoint(data: unknown): void;
  /** Add to the task's accumulated cost in USD (spec §60). */
  addCost(usd: number): void;
}

export type TaskHandler<I = unknown, O = unknown> = (ctx: TaskContext<I>) => Promise<O>;

export interface TaskPersistence {
  load(): Promise<TaskRecord[]>;
  save(tasks: TaskRecord[]): Promise<void>;
}

export interface TaskSpec<I = unknown> {
  type: string;
  title: string;
  input: I;
  dependsOn?: string[];
  /** Higher runs first (default 0). */
  priority?: number;
  /** Automatic attempts before the task fails (default 1 = no automatic retry). */
  maxAttempts?: number;
  providerId?: string;
  runner?: string;
  /** Explicit id (default generated). */
  id?: string;
}

export interface TaskQueueOptions {
  /** Maximum tasks running at once (default 2). */
  concurrency?: number;
  persistence?: TaskPersistence;
  now?: () => string;
  ids?: () => string;
  /** Log entries kept per task (default 500, oldest dropped). */
  maxLogEntries?: number;
  /** Called with persistence or listener errors (they never break the queue). */
  onError?: (error: unknown) => void;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function abortError(message: string): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

const schedule: (fn: () => void) => void =
  typeof queueMicrotask === 'function' ? queueMicrotask : (fn) => void Promise.resolve().then(fn);

interface RunState {
  controller: AbortController;
  token: number;
}

export class TaskQueue {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly order = new Map<string, number>();
  private readonly handlers = new Map<string, TaskHandler<any, any>>();
  private readonly running = new Map<string, RunState>();
  private readonly waiters = new Map<string, ((t: TaskRecord) => void)[]>();
  private readonly listeners = new Set<(tasks: TaskRecord[]) => void>();
  private concurrency: number;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly maxLogs: number;
  private seq = 0;
  private runToken = 0;
  private pumpScheduled = false;
  private notifyScheduled = false;

  constructor(private readonly opts: TaskQueueOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 2));
    this.now = opts.now ?? (() => new Date().toISOString());
    this.newId = opts.ids ?? (() => randomId('task'));
    this.maxLogs = Math.max(1, opts.maxLogEntries ?? 500);
  }

  // ---- registration & submission ---------------------------------------------------------

  register<I, O>(type: string, handler: TaskHandler<I, O>): void {
    this.handlers.set(type, handler as TaskHandler<any, any>);
    this.schedulePump();
  }

  enqueue<I>(spec: TaskSpec<I>): TaskRecord<I> {
    if (!spec || typeof spec.type !== 'string' || !spec.type) throw new Error('enqueue: a task "type" is required.');
    const id = spec.id ?? this.newId();
    if (this.tasks.has(id)) throw new Error(`enqueue: a task with id "${id}" already exists.`);
    const task: TaskRecord<I> = {
      id,
      type: spec.type,
      title: spec.title || spec.type,
      status: 'queued',
      progress: 0,
      input: spec.input,
      attempts: 0,
      maxAttempts: Math.max(1, Math.floor(spec.maxAttempts ?? 1)),
      createdAt: this.now(),
      dependsOn: [...new Set(spec.dependsOn ?? [])],
      priority: Number.isFinite(spec.priority) ? (spec.priority as number) : 0,
      logs: [],
    };
    if (spec.providerId !== undefined) task.providerId = spec.providerId;
    if (spec.runner !== undefined) task.runner = spec.runner;
    this.tasks.set(id, task as TaskRecord);
    this.order.set(id, this.seq++);
    this.addLog(task as TaskRecord, 'info', 'Queued');
    this.changed();
    this.schedulePump();
    return this.snapshot(task as TaskRecord) as TaskRecord<I>;
  }

  // ---- control ---------------------------------------------------------------------------------

  /** Cancel a queued, paused or running task (running handlers are aborted). */
  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (!task || isTerminalTaskStatus(task.status)) return;
    this.abortRun(id, 'Cancelled');
    task.status = 'cancelled';
    task.finishedAt = this.now();
    this.addLog(task, 'warn', 'Cancelled');
    this.settled(task);
  }

  /** Re-queue a failed or cancelled task (attempts are kept; the last checkpoint is reused). */
  retry(id: string): void {
    const task = this.tasks.get(id);
    if (!task || (task.status !== 'failed' && task.status !== 'cancelled')) return;
    this.requeue(task, 'Retry requested');
    // Dependents that failed because of this task get another chance too.
    for (const t of this.tasks.values()) {
      if (t.status === 'failed' && t.dependsOn.includes(id) && /^dependency/i.test(t.error ?? '')) this.retry(t.id);
    }
    this.changed();
    this.schedulePump();
  }

  /** Pause: a running task is aborted but keeps its checkpoint; a queued task is held back. */
  pause(id: string): void {
    const task = this.tasks.get(id);
    if (!task || (task.status !== 'running' && task.status !== 'queued')) return;
    if (task.status === 'running') {
      this.abortRun(id, 'Paused');
      task.attempts = Math.max(0, task.attempts - 1); // a pause is not a failed attempt
    }
    task.status = 'paused';
    this.addLog(task, 'info', 'Paused');
    this.changed();
    this.schedulePump();
  }

  /** Resume a paused task; it continues from its last checkpoint. */
  resume(id: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'paused') return;
    task.status = 'queued';
    this.addLog(task, 'info', 'Resumed');
    this.changed();
    this.schedulePump();
  }

  /** Remove a task from the queue (a running task is aborted first). */
  remove(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (!isTerminalTaskStatus(task.status)) {
      this.abortRun(id, 'Removed');
      task.status = 'cancelled';
      task.finishedAt = this.now();
      this.addLog(task, 'warn', 'Removed');
      this.resolveWaiters(task);
    }
    this.tasks.delete(id);
    this.order.delete(id);
    this.changed();
    this.schedulePump();
  }

  /** Remove all succeeded, failed and cancelled tasks. */
  clearFinished(): void {
    let any = false;
    for (const [id, t] of this.tasks) {
      if (!isTerminalTaskStatus(t.status)) continue;
      this.tasks.delete(id);
      this.order.delete(id);
      any = true;
    }
    if (any) this.changed();
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.floor(n));
    this.schedulePump();
  }

  // ---- inspection ------------------------------------------------------------------------------

  get(id: string): TaskRecord | undefined {
    const t = this.tasks.get(id);
    return t ? this.snapshot(t) : undefined;
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].map((t) => this.snapshot(t));
  }

  subscribe(listener: (tasks: TaskRecord[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolves when the task succeeds, fails or is cancelled. */
  waitFor(id: string): Promise<TaskRecord> {
    const task = this.tasks.get(id);
    if (!task) return Promise.reject(new Error(`Unknown task "${id}".`));
    if (isTerminalTaskStatus(task.status)) return Promise.resolve(this.snapshot(task));
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  /** Resolves when no task is queued or running (paused tasks are ignored). */
  idle(): Promise<void> {
    const isIdle = () => ![...this.tasks.values()].some((t) => t.status === 'queued' || t.status === 'running');
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      const unsubscribe = this.subscribe(() => {
        if (!isIdle()) return;
        unsubscribe();
        resolve();
      });
    });
  }

  /** Load persisted tasks; tasks that were running become queued (resumable from their checkpoint). */
  async restore(): Promise<void> {
    const loaded = (await this.opts.persistence?.load()) ?? [];
    for (const raw of loaded) {
      if (!raw || typeof raw.id !== 'string' || this.tasks.has(raw.id)) continue;
      const task: TaskRecord = {
        ...raw,
        title: raw.title ?? raw.type,
        progress: Number.isFinite(raw.progress) ? Math.min(1, Math.max(0, raw.progress)) : 0,
        attempts: raw.attempts ?? 0,
        maxAttempts: Math.max(1, raw.maxAttempts ?? 1),
        dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn : [],
        priority: Number.isFinite(raw.priority) ? raw.priority : 0,
        logs: Array.isArray(raw.logs) ? raw.logs : [],
      };
      if (task.status === 'running') {
        task.status = 'queued';
        if (task.attempts > 0) task.attempts--; // the interrupted run does not count as a failure
        this.addLog(task, 'info', 'Restored after restart; resuming from the last checkpoint');
      }
      this.tasks.set(task.id, task);
      this.order.set(task.id, this.seq++);
    }
    this.changed();
    this.schedulePump();
  }

  // ---- internals ---------------------------------------------------------------------------

  private snapshot(t: TaskRecord): TaskRecord {
    return { ...t, dependsOn: t.dependsOn.slice(), logs: t.logs.slice() };
  }

  private addLog(task: TaskRecord, level: TaskLogEntry['level'], message: string): void {
    task.logs.push({ t: this.now(), level, message });
    if (task.logs.length > this.maxLogs) task.logs.splice(0, task.logs.length - this.maxLogs);
  }

  private requeue(task: TaskRecord, why: string): void {
    task.status = 'queued';
    delete task.error;
    delete task.finishedAt;
    task.maxAttempts = Math.max(task.maxAttempts, task.attempts + 1);
    this.addLog(task, 'info', why);
  }

  private abortRun(id: string, reason: string): void {
    const run = this.running.get(id);
    if (!run) return;
    this.running.delete(id);
    try {
      run.controller.abort(abortError(reason));
    } catch (e) {
      this.opts.onError?.(e);
    }
  }

  private settled(task: TaskRecord): void {
    this.changed();
    this.resolveWaiters(task);
    this.schedulePump();
  }

  private resolveWaiters(task: TaskRecord): void {
    const list = this.waiters.get(task.id);
    if (!list) return;
    this.waiters.delete(task.id);
    const snap = this.snapshot(task);
    for (const w of list) w(snap);
  }

  private fail(task: TaskRecord, message: string): void {
    task.status = 'failed';
    task.error = message;
    task.finishedAt = this.now();
    this.addLog(task, 'error', message);
    this.settled(task);
  }

  private changed(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    schedule(() => {
      this.notifyScheduled = false;
      const list = this.list();
      for (const l of [...this.listeners]) {
        try {
          l(list);
        } catch (e) {
          this.opts.onError?.(e);
        }
      }
      const p = this.opts.persistence;
      if (p) {
        try {
          p.save(list).catch((e) => this.opts.onError?.(e));
        } catch (e) {
          this.opts.onError?.(e);
        }
      }
    });
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    schedule(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private hasCycle(start: TaskRecord): boolean {
    const seen = new Set<string>();
    const stack = [...start.dependsOn];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === start.id) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(this.tasks.get(id)?.dependsOn ?? []));
    }
    return false;
  }

  private pump(): void {
    // Fail tasks whose dependencies can never succeed.
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of this.tasks.values()) {
        if (t.status !== 'queued' || !t.dependsOn.length) continue;
        for (const depId of t.dependsOn) {
          const dep = this.tasks.get(depId);
          let why: string | undefined;
          if (!dep) why = `Dependency failed: task "${depId}" does not exist`;
          else if (dep.status === 'failed') why = `Dependency failed: "${dep.title}"`;
          else if (dep.status === 'cancelled') why = `Dependency failed: "${dep.title}" was cancelled`;
          if (why) {
            this.fail(t, why);
            changed = true;
            break;
          }
        }
        if (t.status === 'queued' && this.hasCycle(t)) {
          this.fail(t, 'Dependency failed: circular dependency');
          changed = true;
        }
      }
    }
    while (this.running.size < this.concurrency) {
      const next = this.pickNext();
      if (!next) break;
      this.start(next);
    }
  }

  private pickNext(): TaskRecord | undefined {
    let best: TaskRecord | undefined;
    for (const t of this.tasks.values()) {
      if (t.status !== 'queued') continue;
      if (!t.dependsOn.every((d) => this.tasks.get(d)?.status === 'succeeded')) continue;
      if (!best || t.priority > best.priority || (t.priority === best.priority && this.order.get(t.id)! < this.order.get(best.id)!)) best = t;
    }
    return best;
  }

  private start(task: TaskRecord): void {
    const handler = this.handlers.get(task.type);
    if (!handler) {
      this.fail(task, `No handler registered for task type "${task.type}"`);
      return;
    }
    const controller = new AbortController();
    const token = ++this.runToken;
    this.running.set(task.id, { controller, token });
    const active = () => this.running.get(task.id)?.token === token;
    task.status = 'running';
    task.attempts++;
    task.startedAt = this.now();
    delete task.finishedAt;
    this.addLog(task, 'info', `Started (attempt ${task.attempts}/${task.maxAttempts})`);
    const ctx: TaskContext = {
      input: task.input,
      signal: controller.signal,
      attempt: task.attempts,
      previousCheckpoint: task.checkpoint,
      progress: (p, message) => {
        if (!active()) return;
        if (typeof p === 'number' && !Number.isNaN(p)) task.progress = Math.min(1, Math.max(0, p));
        if (message !== undefined) task.message = message;
        this.changed();
      },
      log: (level, message) => {
        if (!active()) return;
        this.addLog(task, level === 'debug' || level === 'info' || level === 'warn' || level === 'error' ? level : 'info', String(message));
        this.changed();
      },
      checkpoint: (data) => {
        if (!active()) return;
        task.checkpoint = data;
        this.changed();
      },
      addCost: (usd) => {
        if (!active() || !Number.isFinite(usd)) return;
        task.costUsd = Math.round(((task.costUsd ?? 0) + usd) * 1e6) / 1e6;
        this.changed();
      },
    };
    this.changed();
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(handler(ctx));
    } catch (e) {
      result = Promise.reject(e);
    }
    result.then(
      (value) => this.finish(task.id, token, true, value),
      (error) => this.finish(task.id, token, false, error),
    );
  }

  private finish(id: string, token: number, ok: boolean, value: unknown): void {
    const run = this.running.get(id);
    if (!run || run.token !== token) return; // cancelled, paused or removed meanwhile
    this.running.delete(id);
    const task = this.tasks.get(id);
    if (!task) {
      this.schedulePump();
      return;
    }
    if (ok) {
      task.status = 'succeeded';
      task.result = value;
      task.progress = 1;
      task.finishedAt = this.now();
      delete task.error;
      this.addLog(task, 'info', 'Succeeded');
      this.settled(task);
      return;
    }
    const message = errorMessage(value);
    task.error = message;
    if (task.attempts < task.maxAttempts) {
      task.status = 'queued';
      this.addLog(task, 'warn', `Attempt ${task.attempts} failed: ${message}; retrying from the last checkpoint`);
      this.changed();
      this.schedulePump();
      return;
    }
    task.status = 'failed';
    task.finishedAt = this.now();
    this.addLog(task, 'error', `Failed: ${message}`);
    this.settled(task);
  }
}

/** In-memory persistence (tests, or a base for custom stores). */
export function createMemoryPersistence(initial: TaskRecord[] = []): TaskPersistence & { saved: TaskRecord[] } {
  const store = {
    saved: JSON.parse(JSON.stringify(initial)) as TaskRecord[],
    async load() {
      return JSON.parse(JSON.stringify(store.saved)) as TaskRecord[];
    },
    async save(tasks: TaskRecord[]) {
      store.saved = JSON.parse(JSON.stringify(tasks)) as TaskRecord[];
    },
  };
  return store;
}

/** Persistence on any Storage-like object (e.g. `window.localStorage`). */
export function createStoragePersistence(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }, key = 'songdeck.tasks'): TaskPersistence {
  return {
    async load() {
      const raw = storage.getItem(key);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as TaskRecord[]) : [];
      } catch {
        return [];
      }
    },
    async save(tasks) {
      storage.setItem(key, JSON.stringify(tasks));
    },
  };
}
