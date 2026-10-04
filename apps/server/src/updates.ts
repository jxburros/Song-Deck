/** Verified GitHub release downloads. Activation belongs to the launcher, never the running server. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { isLoopbackHost, SERVER_VERSION } from './config';
import { writeFileAtomic, HttpError, readJson, readJsonFile, sendJson } from './http-util';
import type { Router, RouteContext } from './router';

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value) + '\n');
}

const API = 'https://api.github.com/repos/jxburros/Song-Deck';
export const RELEASES_URL = 'https://github.com/jxburros/Song-Deck/releases';
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_ARCHIVE = 128 * 1024 * 1024;
const INTERVAL = 6 * 60 * 60_000;

interface Asset {
  id: number;
  name: string;
}
interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: Asset[];
}
export interface UpdateStatus {
  currentVersion: string;
  latestVersion?: string;
  pendingVersion?: string;
  available: boolean;
  automatic: boolean;
  supported: boolean;
  busy: boolean;
  checkedAt?: string;
  error?: string;
  releasesUrl: string;
}
export interface UpdateOptions {
  installRoot?: string;
  fetch?: typeof fetch;
  token?: string;
  version?: string;
  restart?: () => void;
  isBusy?: () => boolean;
}

export function newerVersion(candidate: string, current: string): boolean {
  if (!STABLE.test(candidate)) return false;
  const base = current.split('-')[0].split('+')[0];
  if (!STABLE.test(base)) return false;
  const a = candidate.split('.').map(BigInt);
  const b = base.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return current.includes('-');
}

export class UpdateService {
  private readonly options: UpdateOptions;
  private readonly settingsFile: string;
  private readonly updateDir?: string;
  private timer?: ReturnType<typeof setInterval>;
  private operation?: Promise<void>;
  private release?: Release;
  private stopped = false;
  private state: UpdateStatus;

  constructor(dataDir: string, options: UpdateOptions = {}) {
    this.options = options;
    this.settingsFile = path.join(dataDir, 'updates.json');
    this.updateDir = options.installRoot ? path.join(options.installRoot, '.songdeck-updates') : undefined;
    this.state = {
      currentVersion: options.version ?? SERVER_VERSION,
      automatic: false,
      available: false,
      supported: Boolean(this.updateDir && options.restart),
      busy: false,
      releasesUrl: RELEASES_URL,
    };
  }

  status(): UpdateStatus {
    return { ...this.state };
  }

  async init(): Promise<void> {
    const settings = await readJsonFile<{ automatic?: boolean }>(this.settingsFile);
    this.state.automatic = settings?.automatic === true;
    if (this.updateDir) {
      const pending = await readJsonFile<{ version?: string }>(path.join(this.updateDir, 'pending.json'));
      if (pending?.version && newerVersion(pending.version, this.state.currentVersion))
        this.state.pendingVersion = pending.version;
    }
    this.timer = setInterval(() => this.tick(), INTERVAL);
    this.timer.unref();
    this.tick();
  }

  private tick(): void {
    if (!this.stopped && this.state.automatic && this.state.supported && !this.state.busy)
      void this.run(true, true).catch(() => undefined);
  }

  async setAutomatic(automatic: boolean): Promise<void> {
    if (automatic && !this.state.supported)
      throw new HttpError(
        409,
        'updates-unavailable',
        'Start Song Deck with npm run start:server (or the release launcher) to enable updates.',
      );
    await writeJsonAtomic(this.settingsFile, { automatic });
    this.state.automatic = automatic;
    this.tick();
  }

  private async download(url: string, limit: number, accept: string): Promise<Buffer> {
    // Only the fixed repository API receives credentials. fetch strips Authorization on cross-origin redirects.
    const res = await (this.options.fetch ?? fetch)(url, {
      headers: {
        Accept: accept,
        'User-Agent': 'Song-Deck-Updater',
        ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
      },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok)
      throw new Error(
        res.status === 404
          ? 'No published release is accessible. For a private repository, set SONGDECK_UPDATE_TOKEN on the server with read access to repository contents.'
          : `GitHub update request failed (HTTP ${res.status}). Try again later.`,
      );
    if (Number(res.headers.get('content-length')) > limit) {
      await res.body?.cancel();
      throw new Error('Update download is too large.');
    }
    if (!res.body) throw new Error('Empty update response.');
    const chunks: Uint8Array[] = [];
    const reader = res.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw new Error('Update download is too large.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }

  private async check(): Promise<void> {
    this.state.available = false;
    this.state.latestVersion = undefined;
    this.release = undefined;
    const bytes = await this.download(`${API}/releases/latest`, 1024 * 1024, 'application/vnd.github+json');
    const release = JSON.parse(bytes.toString()) as Release;
    const version = release.tag_name?.replace(/^v/, '');
    if (
      !version ||
      !STABLE.test(version) ||
      release.draft ||
      release.prerelease ||
      !Array.isArray(release.assets)
    )
      throw new Error('GitHub did not return a stable Song Deck release.');
    this.release = release;
    this.state.latestVersion = version;
    this.state.available = newerVersion(version, this.state.currentVersion);
    this.state.checkedAt = new Date().toISOString();
  }

  private asset(name: string): string {
    const asset = this.release?.assets.find((a) => a.name === name);
    if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0)
      throw new Error(`The release is missing ${name}.`);
    return `${API}/releases/assets/${asset.id}`;
  }

  private async stage(): Promise<void> {
    const version = this.state.latestVersion!;
    if (!this.updateDir || !this.state.supported) throw new Error('Updates require the Song Deck launcher.');
    if (!this.state.available || this.state.pendingVersion === version) return;
    const name = `song-deck-${version}.zip`;
    const sums = (
      await this.download(this.asset('SHA256SUMS.txt'), 64 * 1024, 'application/octet-stream')
    ).toString();
    const expected = sums
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .find((p) => p[1] === name)?.[0];
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected))
      throw new Error('Release checksum is missing or invalid.');
    const archive = await this.download(this.asset(name), MAX_ARCHIVE, 'application/octet-stream');
    if (createHash('sha256').update(archive).digest('hex') !== expected.toLowerCase())
      throw new Error('Release checksum verification failed. Nothing was installed.');
    let expanded = 0;
    const files = unzipSync(archive, {
      filter(entry) {
        expanded += entry.originalSize;
        if (expanded > 512 * 1024 * 1024) throw new Error('Expanded update is too large.');
        const parts = entry.name.split('/');
        if (
          parts[0] !== `song-deck-${version}` ||
          parts.some((p) => p === '..' || p === '.') ||
          /[\\:\x00]/.test(entry.name)
        )
          throw new Error('Unsafe path in update archive.');
        return true;
      },
    });
    const prefix = `song-deck-${version}/`;
    for (const required of [
      'package.json',
      'server/songdeck-runtime.mjs',
      'server/worker-entry.mjs',
      'studio/index.html',
    ])
      if (!files[prefix + required]) throw new Error(`Update is missing ${required}.`);
    const pkg = JSON.parse(Buffer.from(files[prefix + 'package.json']).toString()) as {
      name?: string;
      version?: string;
    };
    if (pkg.name !== 'song-deck' || pkg.version !== version)
      throw new Error('Release package identity does not match its tag.');
    await fs.mkdir(this.updateDir, { recursive: true, mode: 0o700 });
    const stage = await fs.mkdtemp(path.join(this.updateDir, '.stage-'));
    try {
      for (const [name, bytes] of Object.entries(files)) {
        const relative = name.slice(prefix.length);
        if (!relative || name.endsWith('/')) continue;
        const target = path.join(stage, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes, { mode: 0o644 });
      }
      // Unique directories avoid mutating a running version, including after a failed activation.
      const directory = path.basename(stage).replace('.stage-', `version-${version}-`);
      await fs.rename(stage, path.join(this.updateDir, directory));
      await writeJsonAtomic(path.join(this.updateDir, 'pending.json'), { version, directory });
      this.state.pendingVersion = version;
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }

  async run(install: boolean, automatic = false): Promise<void> {
    if (this.state.busy) throw new HttpError(409, 'update-busy', 'An update operation is already running.');
    if (install && !this.state.supported)
      throw new HttpError(
        409,
        'updates-unavailable',
        'Start Song Deck with npm run start:server (or the release launcher) to install updates.',
      );
    this.state.busy = true;
    this.state.error = undefined;
    this.operation = (async () => {
      try {
        await this.check();
        if (install && !this.stopped && (!automatic || this.state.automatic)) await this.stage();
      } catch (error) {
        this.state.error = error instanceof Error ? error.message : 'Update failed.';
        throw new HttpError(502, 'update-failed', this.state.error);
      } finally {
        this.state.busy = false;
      }
    })();
    await this.operation;
  }

  restart(): void {
    if (!this.state.pendingVersion || !this.options.restart || this.state.busy)
      throw new HttpError(409, 'update-not-ready', 'No update is ready to restart.');
    if (this.options.isBusy?.())
      throw new HttpError(
        409,
        'server-busy',
        'Finish server jobs and disconnect collaboration before restarting.',
      );
    this.options.restart();
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.operation?.catch(() => undefined);
  }
}

export function registerUpdateRoutes(router: Router, service: UpdateService): void {
  const local = ({ req }: RouteContext, mutation = false) => {
    if (!isLoopbackHost(req.socket.remoteAddress))
      throw new HttpError(403, 'local-only', 'Manage updates from the computer running Song Deck.');
    if (mutation && req.headers['x-songdeck-client'] !== 'updates')
      throw new HttpError(403, 'update-header-required', 'Missing update request header.');
  };
  router.get('/api/updates', (ctx) => {
    local(ctx);
    sendJson(ctx.res, 200, service.status());
  });
  for (const action of ['check', 'install'] as const)
    router.post(`/api/updates/${action}`, async (ctx) => {
      local(ctx, true);
      await service.run(action === 'install');
      sendJson(ctx.res, 200, service.status());
    });
  router.put('/api/updates/settings', async (ctx) => {
    local(ctx, true);
    const body = await readJson<{ automatic?: unknown }>(ctx.req, 1024);
    if (!body || typeof body.automatic !== 'boolean')
      throw new HttpError(400, 'invalid-settings', 'automatic must be a boolean.');
    await service.setAutomatic(body.automatic);
    sendJson(ctx.res, 200, service.status());
  });
  router.post('/api/updates/restart', (ctx) => {
    local(ctx, true);
    service.restart();
    sendJson(ctx.res, 202, { restarting: true });
  });
}
