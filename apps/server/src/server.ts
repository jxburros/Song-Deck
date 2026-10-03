/**
 * The Song Deck local runtime server: one node:http server with a tiny router, CORS, token auth,
 * DNS-rebinding protection, uniform JSON errors, request logging, the collaboration WebSocket and
 * (optionally) the built studio as a static SPA.
 *
 *   const s = createSongDeckServer({ port: 0, dataDir });
 *   const { url } = await s.listen();
 *   …
 *   await s.close();
 */
import { promises as fsp } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { registerCollabRoutes } from './collab';
import { CollabHub } from './collab/hub';
import { isLoopbackHost, normalizeOrigin, type ResolvedConfig, resolveConfig, SERVER_NAME, SERVER_VERSION, type ServerOptions } from './config';
import { registerHardwareRoutes, HardwareService } from './hardware';
import { errorPayload, HttpError, redactPath, safeEqual, sendError, sendJson } from './http-util';
import { LocalServices, registerLocalServiceRoutes } from './local-services';
import { ManagedGateway, registerManagedRoutes } from './managed';
import { ModelManager, registerModelRoutes } from './models';
import { PluginHost, registerPluginRoutes } from './plugins';
import { ProjectStore, registerProjectRoutes } from './projects';
import { ProviderStore, registerProviderRoutes } from './providers';
import { registerProxyRoutes } from './proxy';
import { RenderNode, registerRenderRoutes } from './render/node';
import { Router } from './router';
import { createStaticHandler } from './static';
import { createVault, registerVaultRoutes } from './vault';
import type { CredentialVault } from './vault/types';

export interface SongDeckServer {
  readonly server: http.Server;
  readonly config: ResolvedConfig;
  /** Initialize services and start listening. */
  listen(): Promise<{ url: string; host: string; port: number }>;
  close(): Promise<void>;
  /** The active credential vault (after listen()). */
  readonly vault: CredentialVault;
  readonly services: ServerServices;
}

export interface ServerServices {
  providers: ProviderStore;
  hardware: HardwareService;
  models: ModelManager;
  plugins: PluginHost;
  projects: ProjectStore;
  renderNode: RenderNode;
  collab: CollabHub;
  managed: ManagedGateway;
  localServices: LocalServices;
}

const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, DELETE, OPTIONS';
const DEFAULT_ALLOWED_HEADERS = 'authorization, content-type, accept, x-requested-with, x-songdeck-client';
const EXPOSED_HEADERS = [
  'x-songdeck-report',
  'x-songdeck-proxy-error',
  'x-songdeck-node',
  'x-songdeck-render-ms',
  'x-songdeck-duration',
  'x-songdeck-provider',
  'x-songdeck-model',
  'x-songdeck-cost-usd',
  'x-songdeck-seed',
  'retry-after',
  'content-disposition',
  '*',
].join(', ');

/** Parse a request target as a path on this server (`//host/x` is not treated as another host). */
function parseRequestUrl(raw: string | undefined): URL {
  const target = (raw ?? '/').replace(/^\/{2,}/, '/');
  if (!target.startsWith('/')) throw new Error('absolute-form request targets are not supported');
  return new URL(target, 'http://localhost');
}

export function createSongDeckServer(options: ServerOptions = {}): SongDeckServer {
  const config = resolveConfig(options);
  const { logger, limits } = config;
  let vault: CredentialVault | undefined;
  const getVault = (): CredentialVault => {
    if (!vault) throw new HttpError(503, 'starting', 'Server is still starting');
    return vault;
  };

  const providers = new ProviderStore(config.dataDir, logger);
  const hardware = new HardwareService({ dataDir: config.dataDir, detect: config.hardware.detect, run: config.hardware.run, cacheMs: config.hardware.cacheMs });
  const models = new ModelManager({
    dataDir: config.dataDir,
    hardware,
    providers,
    ollamaUrl: config.discovery.ollamaUrl,
    lmStudioUrl: config.discovery.lmStudioUrl,
    timeoutMs: config.discovery.timeoutMs,
    localServices: config.discovery.localServices,
    fetch: config.discovery.fetch,
    logger,
  });
  const localServices = new LocalServices({
    ollamaUrl: config.discovery.ollamaUrl,
    lmStudioUrl: config.discovery.lmStudioUrl,
    extra: config.discovery.localServices,
    timeoutMs: config.discovery.timeoutMs,
    fetch: config.discovery.fetch,
  });
  const plugins = new PluginHost(config.pluginDirs, logger);
  const projects = new ProjectStore(config.dataDir);
  const renderNode = new RenderNode({
    dataDir: config.dataDir,
    name: config.nodeName,
    version: SERVER_VERSION,
    workers: config.render.workers,
    maxQueue: config.render.maxQueue,
    inline: config.render.inline,
    logger,
  });
  const collab = new CollabHub({ dataDir: config.dataDir, maxMessageBytes: limits.wsMessageBytes, logger });
  const managed = new ManagedGateway({ providers, getVault, logger, jsonLimit: limits.renderBytes });
  const features = new Set<string>();

  const router = new Router();
  router.get('/api/health', ({ req, res, url }) => {
    const authorized = !config.token || isAuthorized(req, url);
    sendJson(res, 200, {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      vault: { backend: vault?.backend ?? 'starting' },
      features: [...features],
      ...(authorized ? { dataDir: config.dataDir } : {}),
      auth: { required: Boolean(config.token) },
    });
  });
  registerVaultRoutes(router, getVault, limits.jsonBytes);
  registerProviderRoutes(router, providers, limits.jsonBytes);
  registerProxyRoutes(router, {
    getVault,
    providers,
    fetch: config.proxy.fetch,
    timeoutMs: config.proxy.timeoutMs,
    maxRequestBytes: limits.proxyRequestBytes,
    maxResponseBytes: limits.proxyResponseBytes,
    logger,
  });
  registerHardwareRoutes(router, hardware);
  registerModelRoutes(router, models);
  registerLocalServiceRoutes(router, localServices, { fetch: config.proxy.fetch, jsonLimit: limits.jsonBytes });
  registerRenderRoutes(router, renderNode, limits.renderBytes);
  registerCollabRoutes(router, collab);
  registerPluginRoutes(router, plugins);
  registerManagedRoutes(router, managed, limits.renderBytes);
  registerProjectRoutes(router, projects, limits.projectBytes);

  const staticHandler = config.staticDir ? createStaticHandler(config.staticDir) : undefined;
  const loopbackBound = isLoopbackHost(config.host);
  const allowedOrigins = new Set(config.allowOrigins);

  /** DNS-rebinding protection: on a loopback bind, only loopback Host names are accepted. */
  function hostAllowed(req: IncomingMessage): boolean {
    if (!loopbackBound) return true;
    const host = req.headers.host;
    if (!host) return true;
    try {
      return isLoopbackHost(new URL(`http://${host}`).hostname);
    } catch {
      return false;
    }
  }

  function originAllowed(origin: string, req: IncomingMessage): boolean {
    const o = normalizeOrigin(origin);
    if (allowedOrigins.has(o)) return true;
    // Same-origin (the studio served by this server, or LAN access to a token-protected node).
    try {
      const u = new URL(o);
      return u.protocol === 'http:' && u.host === req.headers.host;
    } catch {
      return false;
    }
  }

  function isAuthorized(req: IncomingMessage, url: URL): boolean {
    if (!config.token) return true;
    const header = req.headers.authorization;
    if (typeof header === 'string') {
      const m = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (m && safeEqual(m[1].trim(), config.token)) return true;
    }
    // Browsers cannot set headers on WebSocket upgrades or module imports: accept a query token.
    const q = url.searchParams.get('access_token');
    return q !== null && safeEqual(q, config.token);
  }

  function applyCors(req: IncomingMessage, res: ServerResponse, origin: string): void {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-expose-headers', EXPOSED_HEADERS);
    if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('access-control-allow-private-network', 'true');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    res.on('finish', () => {
      const line = `${req.method} ${redactPath(req.url)} ${res.statusCode} ${Date.now() - started}ms`;
      if (res.statusCode >= 500) logger.warn(line);
      else if (req.url?.startsWith('/api/') && !req.url.startsWith('/api/health')) logger.info(line);
      else logger.debug(line);
    });
    let url: URL;
    try {
      url = parseRequestUrl(req.url);
    } catch {
      sendJson(res, 400, { error: 'Bad request URL', code: 'bad-request' });
      return;
    }
    try {
      if (!hostAllowed(req)) throw new HttpError(403, 'bad-host', 'Host header not allowed (DNS rebinding protection)');
      const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
      if (!isApi) {
        if (staticHandler) await staticHandler(req, res, url);
        else sendJson(res, 404, { error: 'Not found', code: 'not-found' });
        return;
      }
      const origin = req.headers.origin;
      if (typeof origin === 'string') {
        if (!originAllowed(origin, req)) throw new HttpError(403, 'origin-not-allowed', `Origin ${origin} is not allowed (start the server with --allow-origin ${origin})`);
        applyCors(req, res, origin);
      }
      if (req.method === 'OPTIONS') {
        const requested = String(req.headers['access-control-request-headers'] ?? '');
        res.writeHead(204, {
          'access-control-allow-methods': ALLOWED_METHODS,
          'access-control-allow-headers': /^[\w\s,-]*$/.test(requested) && requested.trim() ? requested : DEFAULT_ALLOWED_HEADERS,
          'access-control-max-age': '600',
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }
      if (config.token && url.pathname !== '/api/health' && !isAuthorized(req, url)) {
        req.resume();
        throw new HttpError(401, 'unauthorized', 'Missing or invalid bearer token', { headers: { 'www-authenticate': 'Bearer realm="songdeck"' } });
      }
      const match = router.match(req.method ?? 'GET', url.pathname);
      if (match.kind === 'not-found') {
        req.resume();
        throw new HttpError(404, 'not-found', `No route for ${req.method} ${url.pathname}`);
      }
      if (match.kind === 'method-not-allowed') {
        req.resume();
        throw new HttpError(405, 'method-not-allowed', `${req.method} is not allowed here`, { headers: { allow: match.allowed.join(', ') } });
      }
      const ctrl = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) ctrl.abort();
      });
      await match.handler({ req, res, url, params: match.params, signal: ctrl.signal });
    } catch (err) {
      if (!(err instanceof HttpError)) logger.error(`${req.method} ${redactPath(req.url)} failed: ${(err as Error)?.stack ?? String(err)}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, err);
    }
  }

  function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
    const body = JSON.stringify({ error: message, code });
    const reason = http.STATUS_CODES[status] ?? 'Error';
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => undefined);
    let url: URL;
    try {
      url = parseRequestUrl(req.url);
    } catch {
      return rejectUpgrade(socket, 400, 'bad-request', 'Bad request URL');
    }
    if (url.pathname !== '/api/collab') return rejectUpgrade(socket, 404, 'not-found', 'No WebSocket endpoint here');
    if (!hostAllowed(req)) return rejectUpgrade(socket, 403, 'bad-host', 'Host header not allowed');
    const origin = req.headers.origin;
    // Browsers do not apply CORS to WebSockets, so the origin check is essential here.
    if (typeof origin === 'string' && !originAllowed(origin, req)) return rejectUpgrade(socket, 403, 'origin-not-allowed', `Origin ${origin} is not allowed`);
    if (!isAuthorized(req, url)) return rejectUpgrade(socket, 401, 'unauthorized', 'Missing or invalid token (use ?access_token=…)');
    collab.handleUpgrade(req, socket, head);
  }

  const server = http.createServer({ requestTimeout: 15 * 60_000 }, (req, res) => {
    void handle(req, res);
  });
  server.on('upgrade', handleUpgrade);
  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      const { status, body } = errorPayload(new HttpError(400, 'bad-request', 'Malformed HTTP request'));
      const text = JSON.stringify(body);
      socket.end(`HTTP/1.1 ${status} Bad Request\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
    } else socket.destroy(err);
  });

  let initialized = false;
  async function init(): Promise<void> {
    if (initialized) return;
    await fsp.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    vault =
      typeof config.vault === 'object'
        ? config.vault
        : await createVault({ dataDir: config.dataDir, prefer: config.vault, keychain: config.keychain, logger });
    await providers.load();
    await renderNode.init();
    await managed.init();
    for (const f of ['vault', 'proxy', 'providers', 'hardware', 'models', 'local-services', 'connect', 'collab', 'plugins', 'projects']) features.add(f);
    if (renderNode.available) features.add('render-node');
    if (managed.available) features.add('managed');
    if (staticHandler) features.add('static');
    if (config.token) features.add('token-auth');
    initialized = true;
  }

  let listening = false;
  let closed = false;

  return {
    server,
    config,
    get vault() {
      return getVault();
    },
    services: { providers, hardware, models, plugins, projects, renderNode, collab, managed, localServices },
    async listen() {
      await init();
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(config.port, config.host);
      });
      listening = true;
      const addr = server.address() as AddressInfo;
      const hostForUrl = addr.family === 'IPv6' || addr.address.includes(':') ? `[${addr.address}]` : addr.address;
      const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : hostForUrl;
      return { url: `http://${shownHost}:${addr.port}`, host: addr.address, port: addr.port };
    },
    async close() {
      if (closed) return;
      closed = true;
      await collab.close();
      await renderNode.close();
      if (listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections?.();
          setTimeout(() => server.closeAllConnections?.(), 1000).unref();
        });
      }
    },
  };
}
