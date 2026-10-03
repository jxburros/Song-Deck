/**
 * Optional online content check (docs/RIGHTS.md): `POST /api/content-check/acoustid` looks an
 * audio fingerprint up at AcoustID with the user's application key from the vault (the key never
 * reaches the browser). The studio computes the Chromaprint fingerprint itself, so only the
 * fingerprint and the duration arrive here — never audio — and only when the user turned the
 * check on in Settings → Privacy → Content check.
 *
 * Body: `{ "fingerprint": "AQAA…", "duration": 211 }` → `ContentIdResult` JSON.
 * Errors: 400 invalid body, 412 no key stored, 502 AcoustID failure (`{ error, code, kind }`).
 */
import {
  ACOUSTID_CREDENTIAL_REF,
  DirectTransport,
  ProviderError,
  createAcoustIdProvider,
} from '@songdeck/ai';
import { HttpError, isPlainObject, readJson, sendJson } from './http-util';
import type { Router } from './router';
import { vaultCredentialReader } from './vault';
import type { CredentialVault } from './vault/types';

export interface ContentCheckDeps {
  getVault: () => CredentialVault;
  fetch: typeof fetch;
  /** Lookup endpoint override (tests). */
  acoustIdUrl?: string;
  timeoutMs?: number;
}

const MAX_FINGERPRINT_CHARS = 200_000;

export function registerContentCheckRoutes(router: Router, deps: ContentCheckDeps): void {
  router.post('/api/content-check/acoustid', async ({ req, res, signal }) => {
    const body = await readJson<unknown>(req, MAX_FINGERPRINT_CHARS + 4096);
    if (!isPlainObject(body))
      throw new HttpError(400, 'bad-request', 'Body must be { fingerprint, duration }');
    const fingerprint = body.fingerprint;
    const duration = body.duration;
    if (
      typeof fingerprint !== 'string' ||
      !fingerprint ||
      fingerprint.length > MAX_FINGERPRINT_CHARS ||
      !/^[A-Za-z0-9_-]+$/.test(fingerprint)
    ) {
      throw new HttpError(400, 'bad-request', 'fingerprint must be a Chromaprint base64 string');
    }
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 24 * 3600) {
      throw new HttpError(400, 'bad-request', 'duration must be a positive number of seconds');
    }
    const credentials = vaultCredentialReader(deps.getVault);
    if (!(await credentials.get(ACOUSTID_CREDENTIAL_REF))) {
      throw new HttpError(
        412,
        'no-credential',
        'No AcoustID API key is stored in the vault (Settings → Privacy → Content check)',
      );
    }
    const provider = createAcoustIdProvider({
      transport: new DirectTransport(credentials, { fetch: deps.fetch }),
      url: deps.acoustIdUrl,
      timeoutMs: deps.timeoutMs,
    });
    try {
      const result = await provider.identify({ fingerprint, durationSeconds: duration, signal });
      sendJson(res, 200, result);
    } catch (err) {
      const e =
        err instanceof ProviderError
          ? err
          : new ProviderError('unknown', (err as Error)?.message ?? String(err));
      throw new HttpError(502, 'acoustid-failed', e.message, { details: { kind: e.kind } });
    }
  });
}
