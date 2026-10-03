import type { TaskHandler } from '@songdeck/core';

/** Task handlers for this domain are registered with the generation queue (spec §63). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, TaskHandler<any, any>> = {};
