/**
 * Server configuration: options accepted by `createSongDeckServer`, defaults, and resolution.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LOCAL_SERVICE_TARGETS, type LocalServiceTarget } from '@songdeck/ai';
import type { CredentialVault, KeychainModuleLoader, VaultPreference } from './vault/types';
import type { CommandRunner, HardwareInfo } from './hardware';
import type { UpdateOptions } from './updates';
import { createLogger, type Logger, type LogLevel } from './logger';

export const SERVER_NAME = 'songdeck-server';

// Defined only in the single-file server of a release download (scripts/release/package.mjs).
declare const __SONGDECK_RELEASE__: { version: string } | undefined;
const RELEASE = typeof __SONGDECK_RELEASE__ === 'undefined' ? undefined : __SONGDECK_RELEASE__;

/** Version of this package: stamped into a release build, else read once from package.json. */
export const SERVER_VERSION: string =
  RELEASE?.version ??
  (() => {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version?: string;
      };
      return pkg.version ?? '0.0.0';
    } catch {
      return '0.0.0';
    }
  })();

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Directory of the monorepo root (apps/server/src → ../../..). */
export const REPO_ROOT = path.resolve(HERE, '../../..');

/**
 * Where the built studio and the bundled plugins live: apps/studio/dist and plugins/ in the
 * monorepo; studio/ and plugins/ beside the server/ folder of a release download.
 */
export const APP_PATHS: { studio: string; plugins: string } = RELEASE
  ? { studio: path.resolve(HERE, '../studio'), plugins: path.resolve(HERE, '../plugins') }
  : { studio: path.join(REPO_ROOT, 'apps', 'studio', 'dist'), plugins: path.join(REPO_ROOT, 'plugins') };

export const DEFAULT_PORT = 7788;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export interface Limits {
  /** JSON bodies of ordinary endpoints. */
  jsonBytes: number;
  /** Render jobs (songs + embedded WAV assets). */
  renderBytes: number;
  /** Proxy envelopes (may carry base64 audio for audio-to-audio providers). */
  proxyRequestBytes: number;
  /** Upstream responses relayed by the proxy. */
  proxyResponseBytes: number;
  /** `.songproject` uploads. */
  projectBytes: number;
  /** Collaboration WebSocket messages (full revision snapshots). */
  wsMessageBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  jsonBytes: 1 * 1024 * 1024,
  renderBytes: 64 * 1024 * 1024,
  proxyRequestBytes: 64 * 1024 * 1024,
  proxyResponseBytes: 512 * 1024 * 1024,
  projectBytes: 1024 * 1024 * 1024,
  wsMessageBytes: 32 * 1024 * 1024,
};

export interface RenderOptionsConfig {
  /** Worker threads (default max(1, cpus - 1)). */
  workers?: number;
  /** Jobs that may wait for a worker before the node answers 429 (default workers * 4). */
  maxQueue?: number;
  /** Render on the main thread instead of worker threads (debugging only). */
  inline?: boolean;
}

export interface DiscoveryOptions {
  /** Ollama base URL (default http://127.0.0.1:11434); false disables. */
  ollamaUrl?: string | false;
  /** LM Studio OpenAI-compatible base URL (default http://127.0.0.1:1234/v1); false disables. */
  lmStudioUrl?: string | false;
  /** Per-request discovery timeout (default 1500 ms). */
  timeoutMs?: number;
  /**
   * Other local services to look for (default: llama.cpp :8080, vLLM :8000, the Song Deck bridges
   * :8810-8815 and a custom audio bridge :8820, all on 127.0.0.1); false disables them. Ollama and
   * LM Studio are configured by `ollamaUrl` / `lmStudioUrl`. Non-loopback URLs are never probed.
   */
  localServices?: LocalServiceTarget[] | false;
  fetch?: typeof fetch;
}

export interface HardwareOptions {
  /** Replace detection entirely (tests). */
  detect?: () => Promise<HardwareInfo>;
  /** Command runner used by the detectors (tests). */
  run?: CommandRunner;
  /** Cache lifetime (default 60 s). */
  cacheMs?: number;
}

export interface ProxyOptions {
  /** Upstream timeout (default 15 min; the client aborts earlier through its own timeout). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface ServerOptions {
  updates?: UpdateOptions;
  /** TCP port (default 7788; 0 = ephemeral). */
  port?: number;
  /** Bind address (default 127.0.0.1). A non-loopback host requires `token`. */
  host?: string;
  /** Data directory (default $SONGDECK_DATA_DIR or ~/.songdeck). */
  dataDir?: string;
  /** Built studio to serve with SPA fallback (false/undefined = none). */
  staticDir?: string | false;
  /** Bearer token required for every /api request except /api/health. */
  token?: string;
  /** Allowed browser origins (default: Vite dev server origins). Same-origin is always allowed. */
  allowOrigins?: string[];
  /** Credential vault backend preference, or a vault instance (tests). */
  vault?: VaultPreference | CredentialVault;
  /** false = keep secrets in memory only (`--no-persist`). */
  persist?: boolean;
  /** Keychain module loader override (tests). */
  keychain?: KeychainModuleLoader;
  logLevel?: LogLevel;
  logger?: Logger;
  /** Plugin directories (default <repo>/plugins and <dataDir>/plugins). */
  pluginDirs?: string[];
  render?: RenderOptionsConfig;
  /** Render node display name (default: host name). */
  nodeName?: string;
  limits?: Partial<Limits>;
  proxy?: ProxyOptions;
  discovery?: DiscoveryOptions;
  hardware?: HardwareOptions;
}

export interface ResolvedConfig {
  port: number;
  host: string;
  dataDir: string;
  staticDir?: string;
  token?: string;
  allowOrigins: string[];
  vault: VaultPreference | CredentialVault;
  keychain?: KeychainModuleLoader;
  pluginDirs: { dir: string; source: 'bundled' | 'user' }[];
  render: Required<Pick<RenderOptionsConfig, 'workers' | 'maxQueue' | 'inline'>>;
  nodeName: string;
  limits: Limits;
  proxy: { timeoutMs: number; fetch: typeof fetch };
  discovery: {
    ollamaUrl: string | false;
    lmStudioUrl: string | false;
    timeoutMs: number;
    localServices: LocalServiceTarget[];
    fetch: typeof fetch;
  };
  hardware: HardwareOptions & { cacheMs: number };
  logger: Logger;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.SONGDECK_DATA_DIR;
  if (dir && dir.trim()) return path.resolve(dir.trim());
  return path.join(os.homedir(), '.songdeck');
}

/** Host names / addresses that only accept connections from this machine. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (h.startsWith('::ffff:') && /^127(?:\.\d{1,3}){3}$/.test(h.slice(7))) return true;
  return false;
}

export function normalizeOrigin(origin: string): string {
  const o = origin.trim();
  if (o === 'null') return o;
  try {
    const u = new URL(o);
    return u.origin;
  } catch {
    return o.replace(/\/+$/, '');
  }
}

export function resolveConfig(opts: ServerOptions = {}): ResolvedConfig {
  const host = opts.host ?? DEFAULT_HOST;
  const token = opts.token?.trim() || undefined;
  if (!isLoopbackHost(host) && !token) {
    throw new Error(
      `A token is required when listening on a non-loopback host (${host}); pass --token <secret>`,
    );
  }
  const dataDir = path.resolve(opts.dataDir ?? defaultDataDir());
  const cpus = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
  const workers = Math.max(1, Math.floor(opts.render?.workers ?? Math.max(1, cpus - 1)));
  const fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init);
  const logger = opts.logger ?? createLogger(opts.logLevel ?? (process.env.VITEST ? 'silent' : 'info'));
  const pluginDirs = opts.pluginDirs
    ? opts.pluginDirs.map((dir) => ({ dir: path.resolve(dir), source: 'user' as const }))
    : [
        { dir: APP_PATHS.plugins, source: 'bundled' as const },
        { dir: path.join(dataDir, 'plugins'), source: 'user' as const },
      ];
  return {
    port: opts.port ?? DEFAULT_PORT,
    host,
    dataDir,
    staticDir: opts.staticDir ? path.resolve(opts.staticDir) : undefined,
    token,
    allowOrigins: (opts.allowOrigins ?? DEFAULT_ALLOWED_ORIGINS).map(normalizeOrigin),
    vault: opts.persist === false ? 'memory' : (opts.vault ?? 'auto'),
    keychain: opts.keychain,
    pluginDirs,
    render: {
      workers,
      maxQueue: Math.max(0, Math.floor(opts.render?.maxQueue ?? workers * 4)),
      inline: opts.render?.inline ?? false,
    },
    nodeName: opts.nodeName?.trim() || os.hostname(),
    limits: { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) },
    proxy: { timeoutMs: opts.proxy?.timeoutMs ?? 15 * 60_000, fetch: opts.proxy?.fetch ?? fetchImpl },
    discovery: {
      ollamaUrl: opts.discovery?.ollamaUrl ?? 'http://127.0.0.1:11434',
      lmStudioUrl: opts.discovery?.lmStudioUrl ?? 'http://127.0.0.1:1234/v1',
      timeoutMs: opts.discovery?.timeoutMs ?? 1500,
      localServices:
        opts.discovery?.localServices === false
          ? []
          : (
              opts.discovery?.localServices ??
              DEFAULT_LOCAL_SERVICE_TARGETS.filter(
                (t) => t.presetId !== 'ollama' && t.presetId !== 'lm-studio',
              )
            ).map((t) => ({ ...t })),
      fetch: opts.discovery?.fetch ?? fetchImpl,
    },
    hardware: { ...(opts.hardware ?? {}), cacheMs: opts.hardware?.cacheMs ?? 60_000 },
    logger,
  };
}
