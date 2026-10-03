import type { TaskHandler } from '@songdeck/core';
import {
  convertVocal,
  renderVocal,
  resingRange,
  type ConvertInput,
  type ConvertOutput,
  type RenderInput,
  type RenderOutput,
  type ResingInput,
  type ResingOutput,
} from '../vocal-render';
import { transcribeTake, type TranscribeTakeInput, type TranscribeTakeOutput } from '../vocal-takes';

/**
 * Vocal tasks on the generation queue (spec §63) — cancellable, retryable, inspectable:
 *
 *   vocals.render           whole vocal track → lead_vocal-vN.wav + render track (spec §34)
 *   vocals.resing           only one phrase / section re-sung and spliced into the render (spec §37)
 *   vocals.convert          neutral built-in performance → authorized target voice (spec §33, §36)
 *   vocals.transcribe-take  recorded take → vocal MIDI proposal (spec §33 recorded vocal)
 *
 * Inputs are small (ids, seeds, ranges); every handler reads the project's current song when it
 * runs, so tasks also resume after a reload. Writes to the same vocal track are serialized.
 */

const render: TaskHandler<RenderInput, RenderOutput> = (ctx) => renderVocal(ctx.input, ctx);
const resing: TaskHandler<ResingInput, ResingOutput> = (ctx) => resingRange(ctx.input, ctx);
const convert: TaskHandler<ConvertInput, ConvertOutput> = (ctx) => convertVocal(ctx.input, ctx);
const transcribe: TaskHandler<TranscribeTakeInput, TranscribeTakeOutput> = (ctx) => transcribeTake(ctx.input, ctx);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, TaskHandler<any, any>> = {
  'vocals.render': render,
  'vocals.resing': resing,
  'vocals.convert': convert,
  'vocals.transcribe-take': transcribe,
};
