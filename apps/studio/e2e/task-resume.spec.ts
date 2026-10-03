import { expect, test, type Page } from '@playwright/test';

/**
 * Generation queue (spec §63): a task interrupted by a page reload resumes with its original
 * audio input and finishes.
 */

interface TaskView {
  status: string;
  progress: number;
  logs: string[];
  error?: string;
}

async function taskState(page: Page, id: string): Promise<TaskView | null> {
  return page.evaluate(
    `import('/src/engine/runtime.ts').then(({ taskQueue }) => {
      const t = taskQueue.get(${JSON.stringify(id)});
      return t ? { status: t.status, progress: t.progress, logs: t.logs.map((l) => l.message), error: t.error } : null;
    })`,
  );
}

test('a rebuild interrupted by a reload resumes from its stored input and succeeds', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await expect(page.getByText('AI that gives you the song back.')).toBeVisible();

  // 60 s of a 120 BPM groove: kick on every beat, a bass line and a sustained chord.
  const id: string = await page.evaluate(`(async () => {
    const sr = 22050, seconds = 60, n = sr * seconds;
    const L = new Float32Array(n), R = new Float32Array(n);
    const bass = [55, 43.65, 65.41, 49];
    for (let i = 0; i < n; i++) {
      const t = i / sr, beat = t * 2, bt = (beat % 1) / 2;
      const kick = Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-bt * 40)) * bt) * Math.exp(-bt * 12) * 0.6;
      const f = bass[Math.floor(beat / 4) % 4];
      const b = Math.sin(2 * Math.PI * f * t) * 0.25;
      const pad = (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.18 * t) + Math.sin(2 * Math.PI * 329.63 * t)) * 0.05;
      L[i] = kick + b + pad;
      R[i] = kick + b + pad * 0.8;
    }
    const { taskQueue } = await import('/src/engine/runtime.ts');
    const rec = taskQueue.enqueue({ type: 'analysis.rebuild', title: 'Rebuild (resume test)', input: { runId: 'resume-test', audio: { sampleRate: sr, channels: [L, R] }, title: 'Resume test' } });
    return rec.id;
  })()`);

  await expect.poll(async () => (await taskState(page, id))?.status, { timeout: 60_000, intervals: [100] }).toBe('running');
  // Reload only once the "running" state is persisted (saves are asynchronous), so the reload
  // really interrupts a running task.
  await expect
    .poll(() => page.evaluate(`import('/src/state/persistence.ts').then(({ kvGet }) => kvGet('tasks')).then((ts) => ts?.find((t) => t.id === '${id}')?.status)`), { timeout: 30_000, intervals: [50] })
    .toBe('running');
  await page.reload();
  await expect(page.getByText('AI that gives you the song back.')).toBeVisible();

  await expect
    .poll(async () => (await taskState(page, id))?.status, { timeout: 180_000, intervals: [500] })
    .toBe('succeeded');
  const done = await taskState(page, id);
  expect(done!.logs.some((m) => /Restored after restart/.test(m))).toBe(true);
  expect(done!.error).toBeUndefined();
  // The stored input is released once the task no longer needs it.
  await expect
    .poll(() => page.evaluate(`import('/src/state/persistence.ts').then(({ kvGet }) => kvGet('task-input:${id}')).then((v) => v === undefined)`))
    .toBe(true);
});
