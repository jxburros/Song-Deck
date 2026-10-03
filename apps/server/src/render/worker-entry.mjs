// Worker-thread bootstrap for render jobs. Plain JavaScript so Node can load it without a
// TypeScript loader; it registers tsx (the workspace packages are TypeScript with extensionless
// imports) and then starts the job loop from worker.ts. The pool spawns workers with
// `execArgv: []`, so this registration is the only loader in the worker.
import { parentPort } from 'node:worker_threads';

if (!parentPort) throw new Error('worker-entry.mjs must run in a worker thread');

try {
  const { register } = await import('tsx/esm/api');
  register();
} catch (err) {
  parentPort.postMessage({ type: 'boot-error', message: `tsx is not available: ${err?.message ?? err}` });
  throw err;
}

const { startWorkerLoop } = await import('./worker.ts');
startWorkerLoop(parentPort);
