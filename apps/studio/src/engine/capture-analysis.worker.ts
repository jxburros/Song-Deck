/// <reference lib="webworker" />
/**
 * Capture/Rebuild analysis worker. Runs the Rebuild pipeline with stems that were separated by a
 * provider (spec §30 / §59: a neural separator replaces the built-in DSP stage) — the shared job
 * worker cannot receive a separation callback, so the stems are passed in as data instead.
 */
import { rebuildProject, type AudioData } from '@songdeck/audio';

declare const self: DedicatedWorkerGlobalScope;

export type CaptureWorkerRequest =
  | {
      id: number;
      method: 'rebuildWithStems';
      args: {
        audio: AudioData;
        title?: string;
        stems: { drums: AudioData; bass: AudioData; vocals: AudioData; other: AudioData };
      };
    }
  | { id: number; method: 'cancel'; args: { target: number } };

export type CaptureWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; aborted?: boolean }
  | { id: number; progress: number; stage?: string; detail?: unknown };

const controllers = new Map<number, AbortController>();

self.onmessage = async (ev: MessageEvent<CaptureWorkerRequest>) => {
  const req = ev.data;
  if (req.method === 'cancel') {
    controllers.get(req.args.target)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(req.id, controller);
  try {
    const { audio, title, stems } = req.args;
    const result = await rebuildProject(audio, {
      title,
      signal: controller.signal,
      separation: async () => stems,
      onProgress: (stage, p, stages) =>
        self.postMessage({ id: req.id, progress: p, stage, detail: stages } satisfies CaptureWorkerResponse),
    });
    self.postMessage({ id: req.id, ok: true, result } satisfies CaptureWorkerResponse);
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    self.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      aborted,
    } satisfies CaptureWorkerResponse);
  } finally {
    controllers.delete(req.id);
  }
};
