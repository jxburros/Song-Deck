/**
 * Normalized errors. Every adapter maps provider-specific failures to `ProviderError` kinds so
 * the orchestrator, router and UI can react uniformly (retry, fall back, ask for a key…).
 */
import type { Capability } from './capabilities';
import type { TaskRole } from './types';

export type ProviderErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'bad-request'
  | 'unavailable'
  | 'timeout'
  | 'refusal'
  | 'truncated'
  | 'network'
  | 'cancelled'
  | 'unsupported'
  | 'parse'
  | 'unknown';

export interface ProviderErrorOptions {
  providerId?: string;
  status?: number;
  retryAfterMs?: number;
  /** Refusal category (e.g. Anthropic `stop_details.category`). */
  category?: string | null;
  /** Raw provider error body / extra info (never contains secrets). */
  details?: unknown;
  /** Partial model output (e.g. truncated JSON) for diagnostics or salvage. */
  partialText?: string;
  cause?: unknown;
}

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  'rate-limit',
  'unavailable',
  'network',
  'timeout',
]);

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly providerId?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly category?: string | null;
  readonly details?: unknown;
  readonly partialText?: string;

  constructor(kind: ProviderErrorKind, message: string, opts: ProviderErrorOptions = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.providerId = opts.providerId;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.category = opts.category;
    this.details = opts.details;
    this.partialText = opts.partialText;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }

  /** Transient failures worth retrying (429, 5xx, network, timeout). */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

/** Kinds after which the orchestrator may try another provider (the provider is unusable right now). */
export function isAvailabilityError(err: unknown): boolean {
  return (
    err instanceof ProviderError &&
    (err.kind === 'unavailable' ||
      err.kind === 'network' ||
      err.kind === 'rate-limit' ||
      err.kind === 'timeout' ||
      err.kind === 'auth')
  );
}

/** Map an HTTP status to an error kind. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate-limit';
  if (
    status === 400 ||
    status === 404 ||
    status === 405 ||
    status === 409 ||
    status === 413 ||
    status === 415 ||
    status === 422
  )
    return 'bad-request';
  if (status === 402) return 'auth';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return undefined;
}

/** Extract a human-readable message from a provider error body. */
export function messageFromErrorBody(body: unknown, fallback: string): string {
  if (typeof body === 'string') return body.trim().slice(0, 500) || fallback;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const err = b.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      if (typeof e.message === 'string') return e.message;
    }
    if (typeof b.message === 'string') return b.message;
    if (typeof b.detail === 'string') return b.detail;
    if (b.detail && typeof b.detail === 'object') {
      const d = b.detail as Record<string, unknown>;
      if (typeof d.message === 'string') return d.message;
    }
    if (Array.isArray(b.errors) && b.errors.length) return String(b.errors[0]);
    if (Array.isArray(b) && b.length && typeof b[0] === 'object' && b[0])
      return messageFromErrorBody(b[0], fallback);
  }
  return fallback;
}

export function errorFromStatus(
  status: number,
  body: unknown,
  opts: ProviderErrorOptions & { retryAfter?: string | null } = {},
): ProviderError {
  const kind = kindForStatus(status);
  const message = messageFromErrorBody(body, `HTTP ${status}`);
  return new ProviderError(kind, message, {
    ...opts,
    status,
    retryAfterMs: opts.retryAfterMs ?? parseRetryAfter(opts.retryAfter ?? null),
    details: body,
  });
}

/** Normalize anything thrown by fetch/adapters into a ProviderError. */
export function toProviderError(err: unknown, providerId?: string): ProviderError {
  if (err instanceof ProviderError) {
    if (!err.providerId && providerId) {
      return new ProviderError(err.kind, err.message, {
        providerId,
        status: err.status,
        retryAfterMs: err.retryAfterMs,
        category: err.category,
        details: err.details,
        partialText: err.partialText,
        cause: (err as { cause?: unknown }).cause,
      });
    }
    return err;
  }
  const e = err as { name?: string; message?: string } | undefined;
  const name = e?.name ?? '';
  const message = e?.message ?? String(err);
  if (name === 'AbortError' || name === 'APIUserAbortError')
    return new ProviderError('cancelled', 'Request cancelled', { providerId, cause: err });
  if (name === 'TimeoutError')
    return new ProviderError('timeout', 'Request timed out', { providerId, cause: err });
  if (
    err instanceof TypeError ||
    /fetch failed|network|ECONNREFUSED|ENOTFOUND|ECONNRESET|Failed to fetch|socket/i.test(message)
  ) {
    return new ProviderError('network', message || 'Network error', { providerId, cause: err });
  }
  return new ProviderError('unknown', message || 'Unknown error', { providerId, cause: err });
}

/** Thrown by the router when no installed provider can perform a task (spec §59). */
export interface ExcludedCandidate {
  providerId: string;
  providerName: string;
  reasons: string[];
}

export class NoCompatibleProviderError extends Error {
  readonly role: TaskRole;
  readonly requirements: Capability[];
  readonly excluded: ExcludedCandidate[];

  constructor(role: TaskRole, requirements: Capability[], excluded: ExcludedCandidate[], message?: string) {
    const detail = excluded.length
      ? excluded.map((c) => `${c.providerName}: ${c.reasons.join('; ')}`).join(' | ')
      : 'no providers are registered';
    super(
      message ??
        `No compatible provider for ${role} (${requirements.join(', ') || 'no requirements'}): ${detail}`,
    );
    this.name = 'NoCompatibleProviderError';
    this.role = role;
    this.requirements = requirements;
    this.excluded = excluded;
  }
}

/** Voice conversion / cloning without an authorized target voice (spec §36). */
export class ConsentRequiredError extends Error {
  readonly voiceId: string;
  readonly voiceKind: string;
  constructor(voiceId: string, voiceKind: string) {
    super(
      `Voice "${voiceId}" (${voiceKind}) requires a consent attestation confirming you are authorized to use this voice (spec §36).`,
    );
    this.name = 'ConsentRequiredError';
    this.voiceId = voiceId;
    this.voiceKind = voiceKind;
  }
}

export class BudgetExceededError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`Budget limit reached: ${reasons.join('; ')}`);
    this.name = 'BudgetExceededError';
    this.reasons = reasons;
  }
}

/** The user declined the privacy / data-flow confirmation. */
export class PrivacyDeclinedError extends Error {
  readonly providerId: string;
  constructor(providerId: string, message = 'Request cancelled at the privacy confirmation') {
    super(message);
    this.name = 'PrivacyDeclinedError';
    this.providerId = providerId;
  }
}

export class ConfigurationError extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(problems.length ? `${message}: ${problems.join('; ')}` : message);
    this.name = 'ConfigurationError';
    this.problems = problems;
  }
}
