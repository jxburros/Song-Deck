#!/usr/bin/env -S node --import tsx
/**
 * songdeck-server — the Song Deck local runtime.
 *
 *   npx tsx apps/server/src/cli.ts [--port 7788] [--host 127.0.0.1] [--data-dir ~/.songdeck]
 *                                  [--static apps/studio/dist] [--token <secret>] [--allow-origin <origin>]…
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_HOST, DEFAULT_PORT, defaultDataDir, isLoopbackHost, REPO_ROOT, SERVER_VERSION, type ServerOptions } from './config';
import type { LogLevel } from './logger';
import { createSongDeckServer } from './server';
import type { VaultPreference } from './vault/types';

const HELP = `songdeck-server ${SERVER_VERSION} — Song Deck local runtime

Usage: songdeck-server [options]

  --port <n>             TCP port (default ${DEFAULT_PORT}; 0 = any free port)
  --host <addr>          Bind address (default ${DEFAULT_HOST}). A non-loopback host requires --token.
  --data-dir <dir>       Data directory (default $SONGDECK_DATA_DIR or ~/.songdeck)
  --static <dir>         Serve a built studio with SPA fallback (default: apps/studio/dist if built)
  --no-static            Do not serve the studio
  --token <secret>       Require "Authorization: Bearer <secret>" on /api (env SONGDECK_TOKEN)
  --allow-origin <url>   Allowed browser origin (repeatable; replaces the defaults
                         ${DEFAULT_ALLOWED_ORIGINS.join(', ')}; same-origin is always allowed)
  --vault <backend>      auto | keychain | encrypted-file | memory (default auto)
  --no-persist           Keep secrets in memory only (forgotten on exit)
  --workers <n>          Render worker threads (default cpus - 1)
  --node-name <name>     Render node display name (default: host name)
  --plugins-dir <dir>    Plugin directory (repeatable; default <repo>/plugins and <data-dir>/plugins)
  --log-level <level>    silent | error | warn | info | debug (default info)
  --quiet                Same as --log-level warn
  --version              Print the version
  --help                 Show this help
`;

export interface CliArgs {
  options: ServerOptions;
  help?: boolean;
  version?: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const options: ServerOptions = {};
  const origins: string[] = [];
  const pluginDirs: string[] = [];
  let staticDir: string | false | undefined;
  const out: CliArgs = { options };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith('--'))) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--port': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('--port must be an integer 0..65535');
        options.port = n;
        break;
      }
      case '--host':
        options.host = value();
        break;
      case '--data-dir':
        options.dataDir = path.resolve(value());
        break;
      case '--static':
        staticDir = path.resolve(value());
        break;
      case '--no-static':
        staticDir = false;
        break;
      case '--token':
        options.token = value();
        break;
      case '--allow-origin':
        origins.push(value());
        break;
      case '--vault': {
        const v = value();
        if (!['auto', 'keychain', 'encrypted-file', 'memory'].includes(v)) throw new Error('--vault must be auto, keychain, encrypted-file or memory');
        options.vault = v as VaultPreference;
        break;
      }
      case '--no-persist':
        options.persist = false;
        break;
      case '--workers': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 256) throw new Error('--workers must be an integer 1..256');
        options.render = { ...(options.render ?? {}), workers: n };
        break;
      }
      case '--node-name':
        options.nodeName = value();
        break;
      case '--plugins-dir':
        pluginDirs.push(path.resolve(value()));
        break;
      case '--log-level': {
        const v = value();
        if (!['silent', 'error', 'warn', 'info', 'debug'].includes(v)) throw new Error('--log-level must be silent, error, warn, info or debug');
        options.logLevel = v as LogLevel;
        break;
      }
      case '--quiet':
        options.logLevel = 'warn';
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--version':
      case '-v':
        out.version = true;
        break;
      default:
        throw new Error(`Unknown option ${arg} (see --help)`);
    }
  }
  if (origins.length) options.allowOrigins = origins;
  if (pluginDirs.length) options.pluginDirs = pluginDirs;
  if (!options.token && env.SONGDECK_TOKEN?.trim()) options.token = env.SONGDECK_TOKEN.trim();
  options.dataDir ??= defaultDataDir(env);
  if (staticDir === undefined) {
    const built = path.join(REPO_ROOT, 'apps', 'studio', 'dist');
    if (existsSync(path.join(built, 'index.html'))) staticDir = built;
  }
  if (staticDir) {
    if (!existsSync(staticDir)) throw new Error(`--static directory ${staticDir} does not exist`);
    options.staticDir = staticDir;
  }
  const host = options.host ?? DEFAULT_HOST;
  if (!isLoopbackHost(host) && !options.token) {
    throw new Error(`--token is required when listening on a non-loopback host (${host}). Example: --token "$(openssl rand -hex 24)"`);
  }
  return out;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`songdeck-server: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  const app = createSongDeckServer(args.options);
  let info: { url: string };
  try {
    info = await app.listen();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.error(`songdeck-server: could not start: ${e.code === 'EADDRINUSE' ? `port ${app.config.port} is already in use (try --port)` : e.message}`);
    process.exitCode = 1;
    await app.close().catch(() => undefined);
    return;
  }
  const lines = [
    `Song Deck server ${SERVER_VERSION} listening on ${info.url}`,
    `  data dir:  ${app.config.dataDir}`,
    `  vault:     ${app.vault.backend}${app.vault.detail ? ` (${app.vault.detail})` : ''}`,
    `  studio:    ${app.config.staticDir ? `${info.url}/ (serving ${app.config.staticDir})` : 'not served (run the Vite dev server or build apps/studio)'}`,
    `  origins:   ${app.config.allowOrigins.join(', ')} + same-origin`,
    `  auth:      ${app.config.token ? 'bearer token required on /api' : 'none (loopback only)'}`,
    `  render:    ${app.services.renderNode.available ? `${app.services.renderNode.pool.size} worker(s)` : 'unavailable'}`,
  ];
  console.log(lines.join('\n'));
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\nReceived ${signal}, shutting down…`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // Resolve symlinks (node_modules/.bin/songdeck-server → apps/server/src/cli.ts).
    const self = realpathSync(fileURLToPath(import.meta.url));
    const target = realpathSync(path.resolve(entry));
    return target === self || target.replace(/\.ts$/, '') === self.replace(/\.ts$/, '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) void main();
