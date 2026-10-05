/**
 * Cost awareness (spec §60): estimates before a request, actual cost from usage after it.
 * Pricing is editable data (presets ship defaults); unknown pricing yields `known: false` and the
 * UI shows "unknown cost".
 */
import type { ModelPricing, PricingInfo, ProviderLocation, TaskRole, TokenUsage } from './types';
import { round } from './util';

export interface CostEstimate {
  minUsd: number;
  maxUsd: number;
  /** Human-readable basis, e.g. "~2,400 input + 800–4,000 output tokens @ $4/$20 per MTok". */
  basis: string;
  /** False when the provider's pricing is unknown. */
  known: boolean;
  currency: 'USD';
}

export type CostEstimateInput =
  | {
      kind: 'llm';
      role?: TaskRole;
      /** Prompt size in characters (≈ 4 chars per token) … */
      inputChars?: number;
      /** … or in tokens. */
      inputTokens?: number;
      /** Expected output tokens: exact or [min, max]. Defaults per role. */
      outputTokens?: number | [number, number];
    }
  | {
      kind: 'audio';
      durationSeconds: number;
      /** Number of generations/candidates (A/B, spec §54). */
      generations?: number;
    };

/** Anything with a location and optional pricing: ProviderConfig, ProviderDescriptor… */
export interface CostTarget {
  location?: ProviderLocation;
  pricing?: PricingInfo;
  defaultModel?: string;
  name?: string;
}

/** Typical output tokens per task role ([min, max]) for LLM estimates. */
export const ROLE_OUTPUT_TOKENS: Record<TaskRole, [number, number]> = {
  composition: [1200, 4000],
  harmony: [300, 1500],
  'midi-editing': [400, 6000],
  lyrics: [300, 1500],
  analysis: [300, 1500],
  chat: [200, 1500],
  mixing: [100, 800],
  transcription: [0, 0],
  separation: [0, 0],
  production: [0, 0],
  vocals: [0, 0],
  'voice-conversion': [0, 0],
  mastering: [0, 0],
  'lyric-transcription': [0, 0],
  'instrument-rendering': [0, 0],
};

/**
 * A price-table key may stand in for a longer model id only when the rest of the id is a dated or
 * snapshot suffix: `@…` (Vertex-style versions) or `-` followed by at least four digits
 * (`-2025-08-07`, `-20250807`, `-0905`). Anything else (`.5`, `-mini`, `-pro`, `-turbo`) is a
 * different model with its own price, so it must not inherit the shorter key's rate.
 */
const SNAPSHOT_SUFFIX = /^(?:@|-\d{4})/;

export function isSnapshotOf(modelId: string, key: string): boolean {
  return modelId.startsWith(key) && SNAPSHOT_SUFFIX.test(modelId.slice(key.length));
}

/**
 * Pricing for a model: exact id, else the longest key the id is a dated snapshot of (see
 * `isSnapshotOf`), else provider-level rates.
 */
export function modelPricing(pricing: PricingInfo | undefined, modelId?: string): ModelPricing | undefined {
  if (!pricing) return undefined;
  const base: ModelPricing = {
    inputPerMTok: pricing.inputPerMTok,
    outputPerMTok: pricing.outputPerMTok,
    perGenerationUsd: pricing.perGenerationUsd,
    perSecondUsd: pricing.perSecondUsd,
    perMinuteUsd: pricing.perMinuteUsd,
    perClipUsd: pricing.perClipUsd,
    clipSeconds: pricing.clipSeconds,
  };
  if (modelId && pricing.models) {
    const exact = pricing.models[modelId];
    if (exact) return { ...base, ...exact };
    const prefix = Object.keys(pricing.models)
      .filter((k) => isSnapshotOf(modelId, k))
      .sort((a, b) => b.length - a.length)[0];
    if (prefix) return { ...base, ...pricing.models[prefix] };
  }
  const hasAny = Object.values(base).some((v) => v !== undefined);
  return hasAny ? base : undefined;
}

/** Actual LLM cost from token usage (undefined when pricing is unknown). */
export function llmCostUsd(
  pricing: PricingInfo | undefined,
  modelId: string | undefined,
  usage: TokenUsage | undefined,
): number | undefined {
  if (!usage) return undefined;
  const p = modelPricing(pricing, modelId);
  if (!p || p.inputPerMTok === undefined || p.outputPerMTok === undefined) return undefined;
  return (usage.inputTokens * p.inputPerMTok + usage.outputTokens * p.outputPerMTok) / 1_000_000;
}

/** Actual audio cost for a generated duration (undefined when pricing is unknown). */
export function audioCostUsd(
  pricing: PricingInfo | undefined,
  modelId: string | undefined,
  durationSeconds: number,
  generations = 1,
): number | undefined {
  const p = modelPricing(pricing, modelId);
  if (!p) return undefined;
  if (p.perGenerationUsd !== undefined) return p.perGenerationUsd * generations;
  if (p.perClipUsd !== undefined)
    return p.perClipUsd * Math.max(1, Math.ceil(durationSeconds / (p.clipSeconds ?? 30))) * generations;
  if (p.perSecondUsd !== undefined) return p.perSecondUsd * durationSeconds * generations;
  if (p.perMinuteUsd !== undefined) return p.perMinuteUsd * (durationSeconds / 60) * generations;
  return undefined;
}

const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

export function estimateCost(target: CostTarget, input?: CostEstimateInput, modelId?: string): CostEstimate {
  const unknown = (basis = 'unknown cost'): CostEstimate => ({
    minUsd: 0,
    maxUsd: 0,
    basis,
    known: false,
    currency: 'USD',
  });
  if (target.location === 'local' || target.location === 'internal') {
    return {
      minUsd: 0,
      maxUsd: 0,
      basis: 'Runs on this device — no usage cost',
      known: true,
      currency: 'USD',
    };
  }
  const model = modelId ?? target.defaultModel;
  const p = modelPricing(target.pricing, model);
  if (!p) return unknown();
  if (!input) {
    if (p.perGenerationUsd !== undefined)
      return {
        minUsd: p.perGenerationUsd,
        maxUsd: p.perGenerationUsd,
        basis: `$${p.perGenerationUsd} per generation`,
        known: true,
        currency: 'USD',
      };
    return unknown('cost depends on request size');
  }
  if (input.kind === 'llm') {
    if (p.inputPerMTok === undefined || p.outputPerMTok === undefined) return unknown();
    const inTok =
      input.inputTokens ?? (input.inputChars !== undefined ? Math.ceil(input.inputChars / 4) : 2000);
    const out = input.outputTokens ?? (input.role ? ROLE_OUTPUT_TOKENS[input.role] : [500, 2000]);
    const [outMin, outMax] = Array.isArray(out) ? out : [out, out];
    const minUsd = (inTok * p.inputPerMTok + outMin * p.outputPerMTok) / 1_000_000;
    const maxUsd = (inTok * 1.1 * p.inputPerMTok + outMax * p.outputPerMTok) / 1_000_000;
    return {
      minUsd,
      maxUsd,
      basis: `~${fmtInt(inTok)} input + ${outMin === outMax ? fmtInt(outMin) : `${fmtInt(outMin)}–${fmtInt(outMax)}`} output tokens @ $${p.inputPerMTok}/$${p.outputPerMTok} per MTok${model ? ` (${model})` : ''}`,
      known: true,
      currency: 'USD',
    };
  }
  const gens = Math.max(1, input.generations ?? 1);
  const dur = Math.max(0, input.durationSeconds);
  if (p.perGenerationUsd !== undefined) {
    const c = p.perGenerationUsd * gens;
    return {
      minUsd: c,
      maxUsd: c,
      basis: `${gens} generation(s) × $${p.perGenerationUsd}`,
      known: true,
      currency: 'USD',
    };
  }
  if (p.perClipUsd !== undefined) {
    const clipLen = p.clipSeconds ?? 30;
    const clips = Math.max(1, Math.ceil(dur / clipLen));
    const c = clips * p.perClipUsd * gens;
    return {
      minUsd: c,
      maxUsd: c,
      basis: `${clips} × ${clipLen}s clip(s) × ${gens} @ $${p.perClipUsd}`,
      known: true,
      currency: 'USD',
    };
  }
  if (p.perSecondUsd !== undefined || p.perMinuteUsd !== undefined) {
    const perSec = p.perSecondUsd ?? (p.perMinuteUsd ?? 0) / 60;
    const c = perSec * dur * gens;
    return {
      minUsd: c,
      maxUsd: c * 1.15,
      basis: `${round(dur, 1)} s × ${gens} @ $${round(perSec * 60, 4)}/min`,
      known: true,
      currency: 'USD',
    };
  }
  return unknown();
}

export function formatUsd(v: number): string {
  if (v === 0) return '$0.00';
  if (v < 0.01) return '<$0.01';
  return `$${v.toFixed(2)}`;
}

/** "$0.84–$1.20", "$0.20", "free (runs locally)" or "unknown cost". */
export function formatCostRange(e: CostEstimate): string {
  if (!e.known) return 'unknown cost';
  if (e.maxUsd === 0) return 'free (runs locally)';
  const a = formatUsd(e.minUsd);
  const b = formatUsd(e.maxUsd);
  return a === b ? a : `${a}–${b}`;
}

export function midpointUsd(e: CostEstimate): number | undefined {
  return e.known ? (e.minUsd + e.maxUsd) / 2 : undefined;
}
