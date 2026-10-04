/**
 * Plugin host (spec §57, Phase 5 "plugin ecosystem").
 *
 * Scans plugin directories (`<repo>/plugins/*`, `<dataDir>/plugins/*`) for `songdeck-plugin.json`
 * manifests, validates them and serves plugin files to the studio. The server NEVER executes
 * plugin code: an `entry` module only ever runs in the browser, after the user enables it.
 */
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { HttpError, isPlainObject, isWithin, mimeFor, resolveInside, sendJson } from './http-util';
import type { Logger } from './logger';
import type { Router } from './router';

export const PLUGIN_MANIFEST = 'songdeck-plugin.json';

export const PLUGIN_KINDS = [
  'ai-provider',
  'music-model',
  'singing-engine',
  'transcription-engine',
  'instrument',
  'genre-profile',
  'exporter',
] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/** Permissions a plugin may declare (informational; shown to the user before enabling). */
export const KNOWN_PERMISSIONS = [
  'network',
  'provider-registry',
  'audio',
  'project-read',
  'project-write',
  'storage',
  'midi',
  'files',
] as const;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  description: string;
  author: string;
  entry?: string;
  files?: string[];
  permissions?: string[];
  homepage?: string;
}

export interface PluginRecord extends PluginManifest {
  source: 'bundled' | 'user';
  /** Absolute plugin directory on this machine. */
  dir: string;
  /** URL of the entry module relative to the server (for `import()` in the studio). */
  entryUrl?: string;
  warnings: string[];
}

export interface PluginLoadError {
  dir: string;
  id?: string;
  error: string;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const MANIFEST_MAX_BYTES = 256 * 1024;

function validRelativePath(p: string): boolean {
  if (
    !p ||
    p.length > 512 ||
    p.startsWith('/') ||
    p.includes('\\') ||
    p.includes('\0') ||
    /^[a-zA-Z]:/.test(p)
  )
    return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Validate a parsed manifest; resolves the manifest or throws a list of problems. */
export async function validateManifest(
  raw: unknown,
  dir: string,
): Promise<{ manifest: PluginManifest; warnings: string[] }> {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isPlainObject(raw)) throw new Error('manifest must be a JSON object');
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !ID_RE.test(m.id))
    problems.push(`id must match ${ID_RE} (lowercase letters, digits, . _ -)`);
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 100)
    problems.push('name is required (max 100 chars)');
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version))
    problems.push('version must be semver (e.g. 1.0.0)');
  if (typeof m.kind !== 'string' || !(PLUGIN_KINDS as readonly string[]).includes(m.kind))
    problems.push(`kind must be one of ${PLUGIN_KINDS.join(', ')}`);
  for (const key of ['description', 'author'] as const) {
    if (m[key] === undefined) warnings.push(`${key} is missing`);
    else if (typeof m[key] !== 'string' || (m[key] as string).length > 2000)
      problems.push(`${key} must be a string (max 2000 chars)`);
  }
  if (m.entry !== undefined) {
    if (typeof m.entry !== 'string' || !validRelativePath(m.entry))
      problems.push('entry must be a relative path inside the plugin directory');
    else if (!/\.(m?js)$/i.test(m.entry)) problems.push('entry must be an ES module (.js or .mjs)');
    else {
      const file = resolveInside(dir, m.entry.split('/'));
      const st = file ? await fsp.stat(file).catch(() => undefined) : undefined;
      if (!st?.isFile()) problems.push(`entry file ${m.entry} does not exist`);
    }
  }
  if (m.files !== undefined) {
    if (!Array.isArray(m.files) || m.files.some((f) => typeof f !== 'string' || !validRelativePath(f))) {
      problems.push('files must be an array of relative paths inside the plugin directory');
    } else {
      for (const f of m.files as string[]) {
        const file = resolveInside(dir, f.split('/'));
        if (!file || !(await fsp.stat(file).catch(() => undefined)))
          warnings.push(`listed file ${f} does not exist`);
      }
    }
  }
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions) || m.permissions.some((p) => typeof p !== 'string'))
      problems.push('permissions must be an array of strings');
    else
      for (const p of m.permissions as string[])
        if (!(KNOWN_PERMISSIONS as readonly string[]).includes(p)) warnings.push(`unknown permission "${p}"`);
  }
  if (m.homepage !== undefined) {
    let ok = false;
    try {
      ok = typeof m.homepage === 'string' && ['http:', 'https:'].includes(new URL(m.homepage).protocol);
    } catch {
      ok = false;
    }
    if (!ok) problems.push('homepage must be an http(s) URL');
  }
  if (
    !m.entry &&
    (m.kind === 'ai-provider' ||
      m.kind === 'music-model' ||
      m.kind === 'singing-engine' ||
      m.kind === 'transcription-engine' ||
      m.kind === 'exporter')
  ) {
    warnings.push(`a ${String(m.kind)} plugin normally needs an entry module`);
  }
  if (problems.length) throw new Error(problems.join('; '));
  const manifest: PluginManifest = {
    id: m.id as string,
    name: (m.name as string).trim(),
    version: m.version as string,
    kind: m.kind as PluginKind,
    description: typeof m.description === 'string' ? m.description : '',
    author: typeof m.author === 'string' ? m.author : '',
    ...(typeof m.entry === 'string' ? { entry: m.entry } : {}),
    ...(Array.isArray(m.files) ? { files: m.files as string[] } : {}),
    ...(Array.isArray(m.permissions) ? { permissions: m.permissions as string[] } : {}),
    ...(typeof m.homepage === 'string' ? { homepage: m.homepage } : {}),
  };
  return { manifest, warnings };
}

export function pluginFileUrl(id: string, relPath: string): string {
  return `/api/plugins/${encodeURIComponent(id)}/files/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

export class PluginHost {
  private last?: { plugins: PluginRecord[]; errors: PluginLoadError[] };

  constructor(
    private readonly dirs: { dir: string; source: 'bundled' | 'user' }[],
    private readonly logger?: Logger,
  ) {}

  async scan(): Promise<{ plugins: PluginRecord[]; errors: PluginLoadError[] }> {
    const plugins: PluginRecord[] = [];
    const errors: PluginLoadError[] = [];
    const ids = new Map<string, string>();
    for (const { dir: root, source } of this.dirs) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fsp.readdir(root, { withFileTypes: true });
      } catch {
        continue; // directory absent
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const dir = path.join(root, e.name);
        const manifestFile = path.join(dir, PLUGIN_MANIFEST);
        let text: string;
        try {
          const st = await fsp.stat(manifestFile);
          if (st.size > MANIFEST_MAX_BYTES)
            throw new Error(`manifest is larger than ${MANIFEST_MAX_BYTES} bytes`);
          text = await fsp.readFile(manifestFile, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // not a plugin directory
          errors.push({ dir, error: (err as Error).message });
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          errors.push({ dir, error: `${PLUGIN_MANIFEST} is not valid JSON: ${(err as Error).message}` });
          continue;
        }
        try {
          const { manifest, warnings } = await validateManifest(parsed, dir);
          const previous = ids.get(manifest.id);
          if (previous) {
            errors.push({
              dir,
              id: manifest.id,
              error: `duplicate plugin id "${manifest.id}" (already provided by ${previous})`,
            });
            continue;
          }
          ids.set(manifest.id, dir);
          plugins.push({
            ...manifest,
            source,
            dir,
            ...(manifest.entry ? { entryUrl: pluginFileUrl(manifest.id, manifest.entry) } : {}),
            warnings,
          });
        } catch (err) {
          const id = isPlainObject(parsed) && typeof parsed.id === 'string' ? parsed.id : undefined;
          errors.push({ dir, ...(id ? { id } : {}), error: (err as Error).message });
        }
      }
    }
    for (const err of errors) this.logger?.debug(`plugin ${err.dir}: ${err.error}`);
    this.last = { plugins, errors };
    return this.last;
  }

  async find(id: string): Promise<PluginRecord | undefined> {
    const hit = this.last?.plugins.find((p) => p.id === id);
    if (hit) return hit;
    return (await this.scan()).plugins.find((p) => p.id === id);
  }
}

export function registerPluginRoutes(router: Router, host: PluginHost): void {
  router.get('/api/plugins', async ({ res }) => {
    sendJson(res, 200, await host.scan());
  });

  router.get('/api/plugins/:id/files/*path', async ({ req, res, params }) => {
    const plugin = await host.find(params.id);
    if (!plugin) throw new HttpError(404, 'not-found', `Plugin "${params.id}" not found`);
    const segments = params.path.split('/');
    // No hidden files (.git, .env…), no traversal, no absolute paths.
    if (segments.some((s) => s.startsWith('.'))) throw new HttpError(404, 'not-found', 'File not found');
    const file = resolveInside(plugin.dir, segments);
    if (!file) throw new HttpError(400, 'bad-path', 'Invalid plugin file path');
    let real: string;
    let st: import('node:fs').Stats;
    try {
      real = await fsp.realpath(file);
      const realDir = await fsp.realpath(plugin.dir);
      if (!isWithin(realDir, real)) throw new HttpError(404, 'not-found', 'File not found');
      st = await fsp.stat(real);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(404, 'not-found', 'File not found');
    }
    if (!st.isFile()) throw new HttpError(404, 'not-found', 'File not found'); // no directory listings
    res.writeHead(200, {
      'content-type': mimeFor(real),
      'content-length': String(st.size),
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await new Promise<void>((resolve) => {
      const stream = createReadStream(real);
      stream.on('error', () => {
        res.destroy();
        resolve();
      });
      stream.on('end', () => resolve());
      res.on('close', () => {
        stream.destroy();
        resolve();
      });
      stream.pipe(res);
    });
  });
}
