import type { TaskQueue } from '@songdeck/core';
import { handlers as render } from './handlers/render';
import { handlers as production } from './handlers/production';
import { handlers as vocals } from './handlers/vocals';
import { handlers as mastering } from './handlers/mastering';
import { handlers as analysis } from './handlers/analysis';
import { handlers as exporting } from './handlers/exporting';

/**
 * Registers every long-running job type with the generation queue (spec §63).
 * Each domain keeps its handlers in engine/handlers/<domain>.ts.
 */
export function registerTaskHandlers(queue: TaskQueue): void {
  for (const group of [render, production, vocals, mastering, analysis, exporting]) {
    for (const [type, handler] of Object.entries(group)) queue.register(type, handler);
  }
}
