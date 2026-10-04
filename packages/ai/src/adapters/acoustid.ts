/**
 * Content identification (capability CONTENT_IDENTIFICATION) — the seam for "is this upload a
 * known commercial recording?" checks (docs/RIGHTS.md).
 *
 * The bundled implementation is AcoustID (acoustid.org), which matches a Chromaprint fingerprint
 * against its database and links to MusicBrainz recordings. AcoustID's API is free for
 * NON-COMMERCIAL use only and needs the user's own application API key; commercial users need
 * a paid AcoustID plan or another service. An operator can plug one in by implementing
 * `ContentIdentificationProvider` (same request shape: fingerprint + duration, or extend it).
 *
 * Only the fingerprint and the duration leave the device — never the audio. Results are
 * warn-only: a match never blocks anything, and no match proves nothing (fingerprints only find
 * the exact recording, not covers, re-recordings, humming or melodies).
 */
import { ProviderError, toProviderError } from '../errors';
import { HttpClient } from '../transport/http';
import type { RetryOptions } from '../transport/limiter';
import type { Transport } from '../types';

export interface ContentIdRequest {
  /** Compressed base64 Chromaprint fingerprint (as printed by fpcalc). */
  fingerprint: string;
  /** Duration of the whole file in seconds. */
  durationSeconds: number;
  signal?: AbortSignal;
}

export interface ContentIdMatch {
  service: string;
  /** 0..1 */
  score: number;
  /** Service-side id of the matched fingerprint cluster (AcoustID track id). */
  trackId?: string;
  /** MusicBrainz recording id. */
  recordingId?: string;
  title?: string;
  artists?: string[];
  releaseTitle?: string;
}

export interface ContentIdResult {
  service: string;
  status: 'matched' | 'no-match';
  /** Best first; only matches at or above the provider's minimum score. */
  matches: ContentIdMatch[];
}

export interface ContentIdentificationProvider {
  readonly id: string;
  readonly name: string;
  /** Human statement of what is sent, for consent UIs. */
  readonly sends: string;
  identify(req: ContentIdRequest): Promise<ContentIdResult>;
}

export const ACOUSTID_PROVIDER_ID = 'acoustid';
export const ACOUSTID_LOOKUP_URL = 'https://api.acoustid.org/v2/lookup';
/** Vault / session credential reference for the user's AcoustID application key. */
export const ACOUSTID_CREDENTIAL_REF = 'content-check:acoustid';

export interface AcoustIdOptions {
  transport: Transport;
  /** Credential reference of the application API key (default ACOUSTID_CREDENTIAL_REF). */
  credentialRef?: string;
  /** Lookup endpoint (default ACOUSTID_LOOKUP_URL). */
  url?: string;
  timeoutMs?: number;
  /** Ignore results scoring below this (default 0.5). */
  minScore?: number;
  /** Retry policy (default: one retry on 429/5xx/network). */
  retry?: RetryOptions;
}

interface AcoustIdArtist {
  name?: unknown;
}
interface AcoustIdRecording {
  id?: unknown;
  title?: unknown;
  artists?: AcoustIdArtist[];
  releasegroups?: { title?: unknown }[];
}
interface AcoustIdResultJson {
  id?: unknown;
  score?: unknown;
  recordings?: AcoustIdRecording[];
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Parse an AcoustID v2 lookup response (`meta=recordings releasegroups`). */
export function parseAcoustIdResponse(json: unknown, minScore = 0.5): ContentIdResult {
  const body = json as {
    status?: unknown;
    results?: unknown;
    error?: { code?: unknown; message?: unknown };
  } | null;
  if (!body || typeof body !== 'object')
    throw new ProviderError('parse', 'AcoustID returned an unreadable response', {
      providerId: ACOUSTID_PROVIDER_ID,
    });
  if (body.status !== 'ok') {
    const message = str(body.error?.message) ?? 'unknown error';
    const kind = /api key|client/i.test(message)
      ? 'auth'
      : /rate|too many/i.test(message)
        ? 'rate-limit'
        : 'bad-request';
    throw new ProviderError(kind, `AcoustID: ${message}`, {
      providerId: ACOUSTID_PROVIDER_ID,
      details: body.error,
    });
  }
  const results = Array.isArray(body.results) ? (body.results as AcoustIdResultJson[]) : [];
  const matches: ContentIdMatch[] = [];
  for (const r of results.slice(0, 20)) {
    const score =
      typeof r.score === 'number' && Number.isFinite(r.score) ? Math.max(0, Math.min(1, r.score)) : 0;
    if (score < minScore) continue;
    const recs = Array.isArray(r.recordings) ? r.recordings : [];
    // A fingerprint without linked MusicBrainz metadata is still a match.
    if (!recs.length) matches.push({ service: 'AcoustID', score, trackId: str(r.id) });
    for (const rec of recs.slice(0, 5)) {
      const m: ContentIdMatch = {
        service: 'AcoustID',
        score,
        trackId: str(r.id),
        recordingId: str(rec.id),
        title: str(rec.title),
      };
      const artists = (Array.isArray(rec.artists) ? rec.artists : [])
        .map((a) => str(a?.name))
        .filter((x): x is string => !!x);
      if (artists.length) m.artists = artists;
      const release = Array.isArray(rec.releasegroups) ? str(rec.releasegroups[0]?.title) : undefined;
      if (release) m.releaseTitle = release;
      matches.push(m);
    }
  }
  // Prefer matches with metadata, then by score.
  matches.sort((a, b) => b.score - a.score || Number(!!b.title) - Number(!!a.title));
  return { service: 'AcoustID', status: matches.length ? 'matched' : 'no-match', matches };
}

/** AcoustID lookup through any Transport (direct with a session key, or the local server's vault). */
export function createAcoustIdProvider(opts: AcoustIdOptions): ContentIdentificationProvider {
  const credentialRef = opts.credentialRef ?? ACOUSTID_CREDENTIAL_REF;
  const http = new HttpClient({
    providerId: ACOUSTID_PROVIDER_ID,
    transport: opts.transport,
    // The application key travels as the `client` query parameter (AcoustID's API contract).
    auth: { type: 'query', name: 'client', credentialRef },
    timeoutMs: opts.timeoutMs ?? 20_000,
    retry: { retries: 1, ...(opts.retry ?? {}) },
  });
  const url = opts.url ?? ACOUSTID_LOOKUP_URL;
  return {
    id: ACOUSTID_PROVIDER_ID,
    name: 'AcoustID',
    sends: 'the audio fingerprint and the duration (never the audio itself)',
    async identify(req: ContentIdRequest): Promise<ContentIdResult> {
      if (!req.fingerprint || !/^[A-Za-z0-9_-]+$/.test(req.fingerprint))
        throw new ProviderError('bad-request', 'Invalid fingerprint', { providerId: ACOUSTID_PROVIDER_ID });
      const duration = Math.round(req.durationSeconds);
      if (!(duration > 0))
        throw new ProviderError('bad-request', 'The audio is too short to identify', {
          providerId: ACOUSTID_PROVIDER_ID,
        });
      const body = new URLSearchParams({
        format: 'json',
        meta: 'recordings releasegroups',
        duration: String(duration),
        fingerprint: req.fingerprint,
      }).toString();
      let json: unknown;
      try {
        json = await http.send(
          {
            url,
            method: 'POST',
            body,
            contentType: 'application/x-www-form-urlencoded',
            accept: 'application/json',
            signal: req.signal,
          },
          async (res) => res.json(),
        );
      } catch (err) {
        // AcoustID answers errors with HTTP 400 + a JSON body: surface its message.
        const e = toProviderError(err, ACOUSTID_PROVIDER_ID);
        const details = e.details as { status?: unknown; error?: unknown } | undefined;
        if (details && typeof details === 'object' && details.status === 'error')
          return parseAcoustIdResponse(details, opts.minScore);
        throw e;
      }
      return parseAcoustIdResponse(json, opts.minScore);
    },
  };
}
