import { ENGINE_VERSION, pluginRenderIsCurrent, type Song } from '@songdeck/core';
import { decodeWav, encodeWav, type AudioData } from '@songdeck/audio';
import { base64ToBytes, bytesToBase64 } from '@songdeck/ai';
import { serverBase, useSettings, type RenderNodeConfig } from '../state/settings';
import { jobs } from './jobs';
import { currentRenderInstruments } from './render-instruments';
import { abortError, isAbortError, renderStemsAudio, renderableSong, throwIfAborted } from './mix-render';

/**
 * Distributed / local render nodes (spec §70 Phase 5, apps/server README "Render jobs").
 *
 * A render node is any Song Deck server (this machine's, or another one started with
 * `--host 0.0.0.0 --token …`). Renders are deterministic, so stem groups rendered on different
 * nodes with `options.trackIds` are identical to a single-machine render and can be combined.
 *
 * `renderStemsDistributed` splits the stem groups of a song across the enabled, healthy nodes
 * (one `POST /api/render { kind: 'stems' }` per group, as many in flight per node as it has free
 * workers), retries busy nodes, and renders whatever is left — or everything, when no node is
 * usable — on this device's job worker. It is a drop-in for `renderStemsAudio`.
 */

export interface NodeInfo {
  id: string;
  name: string;
  version: string;
  engineVersion?: string;
  cpuCores: number;
  loadAvg: number[];
  busyJobs: number;
  queuedJobs: number;
  maxJobs: number;
  maxQueue: number;
  capabilities: string[];
  mode: 'workers' | 'inline';
  platform?: string;
  arch?: string;
  totalMemGb?: number;
  freeMemGb?: number;
}

export interface NodeHealth {
  node: RenderNodeConfig;
  ok: boolean;
  info?: NodeInfo;
  latencyMs?: number;
  /** Why the node is not used (offline, busy, wrong engine version…). */
  reason?: string;
}

/** Base URL of a node ('' = this page's origin / the configured local server). */
export function nodeBaseUrl(node: Pick<RenderNodeConfig, 'url'>): string {
  const url = (node.url ?? '').trim().replace(/\/+$/, '');
  return url || serverBase();
}

export function nodeHeaders(
  node: Pick<RenderNodeConfig, 'token'>,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...extra, ...(node.token ? { authorization: `Bearer ${node.token}` } : {}) };
}

function timeoutSignal(ms: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  const onAbort = () => ctrl.abort(outer?.reason);
  outer?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (body?.error) return `${body.error}${body.code ? ` (${body.code})` : ''}`;
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}`;
}

/** `GET {node}/api/node/info`. */
export async function fetchNodeInfo(
  node: Pick<RenderNodeConfig, 'url' | 'token'>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<NodeInfo> {
  const t = timeoutSignal(opts.timeoutMs ?? 4000, opts.signal);
  try {
    const res = await fetch(`${nodeBaseUrl(node)}/api/node/info`, {
      headers: nodeHeaders(node),
      signal: t.signal,
    });
    if (!res.ok) throw new Error(await errorText(res));
    return (await res.json()) as NodeInfo;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') throw new Error('No answer within 4 s');
    if (err instanceof TypeError)
      throw new Error('Unreachable (not running, wrong URL, or the node does not allow this origin)');
    throw err;
  } finally {
    t.done();
  }
}

/** Health of one node for stem renders. */
export async function checkNode(node: RenderNodeConfig, signal?: AbortSignal): Promise<NodeHealth> {
  const t0 = performance.now();
  try {
    const info = await fetchNodeInfo(node, { signal });
    const latencyMs = Math.round(performance.now() - t0);
    if (!info.capabilities?.includes('render-stems'))
      return { node, ok: false, info, latencyMs, reason: 'audio engine unavailable on this node' };
    if (info.engineVersion && info.engineVersion !== ENGINE_VERSION) {
      return {
        node,
        ok: false,
        info,
        latencyMs,
        reason: `engine ${info.engineVersion} ≠ this studio's ${ENGINE_VERSION} (renders would not match)`,
      };
    }
    if (info.queuedJobs >= info.maxQueue) return { node, ok: false, info, latencyMs, reason: 'queue full' };
    return { node, ok: true, info, latencyMs };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw abortError();
    return { node, ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function checkNodes(nodes: RenderNodeConfig[], signal?: AbortSignal): Promise<NodeHealth[]> {
  return Promise.all(nodes.map((n) => checkNode(n, signal)));
}

/** `POST {node}/api/render` with a JSON job. */
export function postRender(
  node: Pick<RenderNodeConfig, 'url' | 'token'>,
  job: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${nodeBaseUrl(node)}/api/render`, {
    method: 'POST',
    headers: nodeHeaders(node, { 'content-type': 'application/json' }),
    body: JSON.stringify(job),
    signal,
  });
}

export interface NodeTestResult {
  kind: 'loudness' | 'mix';
  /** Round trip in ms. */
  ms: number;
  /** Render time reported by the node. */
  renderMs?: number;
  durationSeconds?: number;
  report?: Record<string, unknown>;
  wav?: Uint8Array;
}

/** A small test render: the loudness report or a WAV of `song` (limit with `endTick`). */
export async function testRenderNode(
  node: Pick<RenderNodeConfig, 'url' | 'token'>,
  song: Song,
  kind: 'loudness' | 'mix',
  opts: { endTick?: number; signal?: AbortSignal } = {},
): Promise<NodeTestResult> {
  const t0 = performance.now();
  const res = await postRender(
    node,
    {
      kind,
      song,
      options: {
        sampleRate: 44100,
        tailSeconds: 1,
        ...(opts.endTick ? { startTick: 0, endTick: opts.endTick } : {}),
        ...(kind === 'mix' ? { bitDepth: 16 } : {}),
      },
    },
    opts.signal,
  );
  if (!res.ok) throw new Error(await errorText(res));
  const renderMs = Number(res.headers.get('x-songdeck-render-ms') ?? '') || undefined;
  const durationSeconds = Number(res.headers.get('x-songdeck-duration') ?? '') || undefined;
  if (kind === 'mix') {
    const wav = new Uint8Array(await res.arrayBuffer());
    return { kind, ms: Math.round(performance.now() - t0), renderMs, durationSeconds, wav };
  }
  const report = (await res.json()) as Record<string, unknown>;
  return {
    kind,
    ms: Math.round(performance.now() - t0),
    renderMs,
    durationSeconds: durationSeconds ?? (report.durationSeconds as number | undefined),
    report,
  };
}

// ---------------------------------------------------------------------------
// Distributed stems
// ---------------------------------------------------------------------------

export interface StemPlacement {
  /** Stem name (stem group or track id) as returned by the render. */
  stem: string;
  trackIds: string[];
  /** Node name, or "this device". */
  where: string;
  nodeId?: string;
  ms: number;
  /** Set when the stem was rendered locally because a node failed or none was usable. */
  fallback?: string;
}

export interface DistributedStemOptions {
  by?: 'stemGroup' | 'track';
  sampleRate?: number;
  /** WAV bit depth used on the wire (default 24; 32 = float, bit-exact). */
  bitDepth?: 16 | 24 | 32;
  /** Nodes to use (default: Settings → Render nodes, when "use render nodes" is on). */
  nodes?: RenderNodeConfig[];
  /** Upload audio-track assets to nodes (default false: groups with audio clips render here). */
  uploadAssets?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: number, message?: string) => void;
  onPlacement?: (p: StemPlacement) => void;
  /** Health of the nodes that were considered (after the check). */
  onNodes?: (health: NodeHealth[]) => void;
}

interface StemJob {
  stem: string;
  trackIds: string[];
  assetIds: string[];
  weight: number;
  busyRetries: number;
}

const MAX_SLOTS_PER_NODE = 4;
/** Render requests above this size are kept local (servers accept 64 MB). */
const MAX_REQUEST_BYTES = 56 * 1024 * 1024;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });

/** Enabled render nodes from settings (empty when distribution is switched off). */
export function configuredRenderNodes(): RenderNodeConfig[] {
  const s = useSettings.getState();
  return s.useRenderNodes ? s.renderNodes.filter((n) => n.enabled) : [];
}

/**
 * Render stems, splitting stem groups across enabled healthy render nodes; falls back to the local
 * job worker per group (node failure) or entirely (no usable node). Same result shape as
 * `renderStemsAudio`: `{ [stemGroup | trackId]: AudioData }`.
 */
export async function renderStemsDistributed(
  song: Song,
  assets: Record<string, AudioData>,
  opts: DistributedStemOptions = {},
): Promise<Record<string, AudioData>> {
  const by = opts.by ?? 'stemGroup';
  const sampleRate = opts.sampleRate ?? 44100;
  const bitDepth = opts.bitDepth ?? 24;
  const signal = opts.signal;
  throwIfAborted(signal);
  const s = renderableSong(song);

  // Work units: one per stem (group), heaviest first.
  const groups = new Map<string, StemJob>();
  for (const t of s.tracks) {
    const key = by === 'track' ? t.id : t.stemGroup || 'others';
    const job = groups.get(key) ?? { stem: key, trackIds: [], assetIds: [], weight: 0, busyRetries: 0 };
    job.trackIds.push(t.id);
    job.weight += t.kind === 'audio' ? t.clips.length * 50 : t.notes.length + 20;
    for (const c of t.clips ?? [])
      if (assets[c.assetId] && !job.assetIds.includes(c.assetId)) job.assetIds.push(c.assetId);
    // A frozen instrument-plugin render is audio too (nodes have neither the plugin nor the render).
    const plugin = t.instrumentPlugin?.render;
    if (
      plugin &&
      pluginRenderIsCurrent(s, t) &&
      assets[plugin.assetId] &&
      !job.assetIds.includes(plugin.assetId)
    )
      job.assetIds.push(plugin.assetId);
    groups.set(key, job);
  }
  const all = [...groups.values()].sort((a, b) => b.weight - a.weight);
  const total = all.length || 1;
  let done = 0;
  const progress = (msg?: string) => opts.onProgress?.(Math.min(0.99, done / total), msg);

  const nodes = opts.nodes ?? configuredRenderNodes();
  const health = nodes.length ? await checkNodes(nodes, signal) : [];
  opts.onNodes?.(health);
  const healthy = health.filter((h) => h.ok && h.info);

  const localAll = async (reason: string): Promise<Record<string, AudioData>> => {
    const t0 = performance.now();
    const out = await renderStemsAudio(s, {
      by,
      sampleRate,
      signal,
      assets,
      onProgress: (p) => opts.onProgress?.(p, 'Rendering stems on this device'),
    });
    const ms = Math.round(performance.now() - t0);
    for (const j of all)
      opts.onPlacement?.({ stem: j.stem, trackIds: j.trackIds, where: 'this device', ms, fallback: reason });
    opts.onProgress?.(1);
    return out;
  };
  if (!healthy.length)
    return localAll(nodes.length ? 'no render node available' : 'no render nodes configured');

  const results: Record<string, AudioData> = {};
  const queue: StemJob[] = [];
  const local: { job: StemJob; reason: string }[] = [];
  // Nodes get the custom instrument profiles; plugin sample sets stay on this device, so stems
  // using sampled instruments render here (identical output either way).
  const { instruments, sampleInstruments } = currentRenderInstruments();
  const sampled = new Set(instruments.filter((p) => sampleInstruments[p.patchId]).map((p) => p.id));
  const usesSamples = (job: StemJob) =>
    job.trackIds.some((id) => sampled.has(s.tracks.find((t) => t.id === id)?.instrumentId ?? ''));
  for (const j of all) {
    if (j.assetIds.length && !opts.uploadAssets)
      local.push({ job: j, reason: 'audio clips render on this device' });
    else if (usesSamples(j))
      local.push({ job: j, reason: 'sampled plugin instruments render on this device' });
    else queue.push(j);
  }

  const encoded = new Map<string, string>();
  const assetPayload = (job: StemJob): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const id of job.assetIds) {
      let b64 = encoded.get(id);
      if (!b64) {
        b64 = bytesToBase64(encodeWav(assets[id], { bitDepth: 32 }));
        encoded.set(id, b64);
      }
      out[id] = b64;
    }
    return out;
  };
  const songJson = JSON.stringify(s);

  const runOnNode = async (h: NodeHealth, alive: { value: boolean }) => {
    const name = h.node.name || h.info?.name || nodeBaseUrl(h.node);
    while (alive.value && queue.length) {
      throwIfAborted(signal);
      const job = queue.shift()!;
      const payloadAssets = assetPayload(job);
      const body = `{"kind":"stems","song":${songJson},"options":${JSON.stringify({ sampleRate, by, trackIds: job.trackIds, applyMaster: false, bitDepth, ...(instruments.length ? { instruments } : {}) })},"assets":${JSON.stringify(payloadAssets)}}`;
      if (body.length > MAX_REQUEST_BYTES) {
        local.push({ job, reason: 'request too large for a render node' });
        continue;
      }
      const t0 = performance.now();
      try {
        progress(`Rendering ${job.stem} on ${name}`);
        const res = await fetch(`${nodeBaseUrl(h.node)}/api/render`, {
          method: 'POST',
          headers: nodeHeaders(h.node, { 'content-type': 'application/json' }),
          body,
          signal,
        });
        if (res.status === 429) {
          job.busyRetries++;
          if (job.busyRetries > 3) local.push({ job, reason: `${name} stayed busy` });
          else queue.push(job);
          const retryAfter = Number(res.headers.get('retry-after') ?? '2');
          await sleep(Math.min(5000, Math.max(250, retryAfter * 1000)), signal);
          continue;
        }
        if (!res.ok) throw new Error(await errorText(res));
        const json = (await res.json()) as { stems?: Record<string, string> };
        const stems = json.stems ?? {};
        if (!Object.keys(stems).length) throw new Error('empty stems response');
        for (const [stem, b64] of Object.entries(stems)) results[stem] = decodeWav(base64ToBytes(b64));
        done++;
        opts.onPlacement?.({
          stem: job.stem,
          trackIds: job.trackIds,
          where: name,
          nodeId: h.info?.id,
          ms: Math.round(performance.now() - t0),
        });
        progress();
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) throw abortError();
        // This node is unusable: stop sending it work; the job goes to another node or this device.
        alive.value = false;
        const reason = `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
        if (healthyAlive() > 0) queue.unshift(job);
        else local.push({ job, reason });
        h.reason = reason;
      }
    }
  };

  const aliveFlags = healthy.map(() => ({ value: true }));
  const healthyAlive = () => aliveFlags.filter((a) => a.value).length;
  const workers: Promise<void>[] = [];
  healthy.forEach((h, i) => {
    const free = Math.max(1, (h.info?.maxJobs ?? 1) - (h.info?.busyJobs ?? 0));
    const slots = Math.max(1, Math.min(MAX_SLOTS_PER_NODE, free));
    for (let k = 0; k < slots; k++) workers.push(runOnNode(h, aliveFlags[i]));
  });
  await Promise.all(workers);
  // Anything the nodes could not take (all failed mid-way) renders here.
  for (const j of queue.splice(0)) local.push({ job: j, reason: 'render nodes failed' });

  for (const { job, reason } of local) {
    throwIfAborted(signal);
    const t0 = performance.now();
    progress(`Rendering ${job.stem} on this device`);
    const audio = await jobs.call<AudioData>(
      'renderMix',
      { song: s, assets, sampleRate, applyMaster: false, trackIds: job.trackIds },
      { signal },
    );
    results[job.stem] = audio;
    done++;
    opts.onPlacement?.({
      stem: job.stem,
      trackIds: job.trackIds,
      where: 'this device',
      ms: Math.round(performance.now() - t0),
      fallback: reason,
    });
    progress();
  }
  opts.onProgress?.(1);
  return results;
}
