import { useEffect, useMemo, useRef, useState } from 'react';
import { ENGINE_VERSION, barToTick, generateAsset, parseAssetPrompt, type Song } from '@songdeck/core';
import { useSettings, type RenderNodeConfig } from '../../state/settings';
import { useStudio } from '../../state/store';
import { useRuntime } from '../../engine/runtime';
import { collectAssets } from '../../engine/mix-render';
import {
  checkNode,
  nodeBaseUrl,
  renderStemsDistributed,
  testRenderNode,
  type NodeHealth,
  type StemPlacement,
} from '../../engine/collab-render';
import { Badge, Button, Field, Progress, TextInput, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ConfirmModal, Empty, Panel, TabHeader, bytesLabel, errorMessage } from './ui';

/** Distributed / local render nodes (spec §70 Phase 5). */

function testSong(project: Song | null): { song: Song; endTick?: number; label: string } {
  if (project && project.tracks.some((t) => t.notes.length)) {
    return {
      song: project,
      endTick: barToTick(
        project,
        Math.min(
          4,
          Math.max(
            1,
            project.sections.reduce((n, s) => n + s.bars, 0),
          ),
        ),
      ),
      label: 'first 4 bars of the open song',
    };
  }
  const { song } = generateAsset(parseAssetPrompt('4 bar piano chord progression in C major at 100 bpm'), 7);
  return { song, label: 'a generated 4-bar piano phrase' };
}

export default function NodesTab() {
  const nodes = useSettings((s) => s.renderNodes);
  const useNodes = useSettings((s) => s.useRenderNodes);
  const update = useSettings((s) => s.update);
  const server = useRuntime((s) => s.server.status);
  const [health, setHealth] = useState<Record<string, NodeHealth | 'checking'>>({});
  const [form, setForm] = useState<{ name: string; url: string; token: string } | null>(null);
  const [remove, setRemove] = useState<RenderNodeConfig | null>(null);

  const setNodes = (renderNodes: RenderNodeConfig[]) => update({ renderNodes });
  const check = async (n: RenderNodeConfig) => {
    setHealth((h) => ({ ...h, [n.id]: 'checking' }));
    const r = await checkNode(n).catch((err): NodeHealth => ({
      node: n,
      ok: false,
      reason: errorMessage(err),
    }));
    setHealth((h) => ({ ...h, [n.id]: r }));
  };
  const nodesKey = nodes.map((n) => `${n.id}|${n.url}|${n.token ?? ''}`).join(',');
  useEffect(() => {
    for (const n of nodes) void check(n);
    const t = setInterval(() => {
      for (const n of useSettings.getState().renderNodes) void check(n);
    }, 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesKey]);

  const hasLocal = nodes.some((n) => !n.url.trim());
  const add = () => {
    if (!form) return;
    const id = `node_${Date.now().toString(36)}`;
    setNodes([
      ...nodes,
      {
        id,
        name: form.name.trim() || form.url.trim() || 'Render node',
        url: form.url.trim().replace(/\/+$/, ''),
        token: form.token.trim() || undefined,
        enabled: true,
      },
    ]);
    setForm(null);
  };

  return (
    <>
      <TabHeader
        icon="server"
        title="Render nodes"
        lede="Spread stem renders across this machine’s server and other computers running Song Deck. Renders are deterministic, so stems rendered on different nodes are identical to a single-machine render."
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setForm({ name: '', url: 'http://', token: '' })}
          >
            Add node
          </Button>
        }
      />

      <Panel title="Distribution" icon="sliders">
        <div className="row between wrap">
          <Toggle
            on={useNodes}
            onChange={(useRenderNodes) => update({ useRenderNodes })}
            label={<strong>Use render nodes for stem renders</strong>}
          />
          <span className="small muted">
            {useNodes
              ? `${nodes.filter((n) => n.enabled).length} enabled node${nodes.filter((n) => n.enabled).length === 1 ? '' : 's'} · unhealthy nodes are skipped and this device takes over`
              : 'Off — stems render on this device’s job worker'}
          </span>
        </div>
        <div className="small dim" style={{ marginTop: 8 }}>
          A remote node:{' '}
          <code>
            songdeck-server --host 0.0.0.0 --token "$(openssl rand -hex 24)" --allow-origin{' '}
            {typeof window !== 'undefined' ? window.location.origin : 'http://studio-host:5173'}
          </code>
          , then add its URL and token here. Nodes must run engine {ENGINE_VERSION} so their renders match.
        </div>
      </Panel>

      {form && (
        <Panel title="Add a render node" icon="plus">
          <div className="grid-3">
            <Field label="Name">
              <TextInput
                value={form.name}
                onChange={(name) => setForm({ ...form, name })}
                placeholder="Studio PC"
                aria-label="Node name"
              />
            </Field>
            <Field label="URL" hint="Empty = this page’s local server.">
              <TextInput
                mono
                value={form.url}
                onChange={(url) => setForm({ ...form, url })}
                placeholder="http://192.168.1.20:7788"
                aria-label="Node URL"
              />
            </Field>
            <Field label="Token" hint="Stored in settings on this device.">
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
                aria-label="Node token"
              />
            </Field>
          </div>
          <div className="row">
            <Button
              variant="primary"
              onClick={add}
              disabled={!form.url.trim() || form.url.trim() === 'http://'}
            >
              Add node
            </Button>
            {!hasLocal && server === 'online' && (
              <Button
                icon="cpu"
                onClick={() => {
                  setNodes([
                    ...nodes,
                    {
                      id: `node_${Date.now().toString(36)}`,
                      name: 'This machine (local server)',
                      url: '',
                      enabled: true,
                    },
                  ]);
                  setForm(null);
                }}
              >
                Add this machine’s server
              </Button>
            )}
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </Panel>
      )}

      {nodes.length === 0 ? (
        <Panel title="Nodes" icon="server">
          <Empty icon="server">
            No render nodes yet.{' '}
            {server === 'online' ? (
              <Button
                size="sm"
                onClick={() =>
                  setNodes([
                    {
                      id: `node_${Date.now().toString(36)}`,
                      name: 'This machine (local server)',
                      url: '',
                      enabled: true,
                    },
                  ])
                }
              >
                Add this machine’s server
              </Button>
            ) : (
              'Start the local server or add a remote node.'
            )}
          </Empty>
        </Panel>
      ) : (
        <div className="st-node-grid">
          {nodes.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              health={health[n.id]}
              onCheck={() => void check(n)}
              onChange={(patch) => setNodes(nodes.map((x) => (x.id === n.id ? { ...x, ...patch } : x)))}
              onRemove={() => setRemove(n)}
            />
          ))}
        </div>
      )}

      <DistributedTest />

      {remove && (
        <ConfirmModal
          title={`Remove ${remove.name}?`}
          confirmLabel="Remove node"
          danger
          onClose={() => setRemove(null)}
          onConfirm={() => {
            setNodes(nodes.filter((n) => n.id !== remove.id));
            setRemove(null);
          }}
        >
          The node is no longer used for renders. The machine itself is not affected.
        </ConfirmModal>
      )}
    </>
  );
}

function NodeCard({
  node,
  health,
  onCheck,
  onChange,
  onRemove,
}: {
  node: RenderNodeConfig;
  health?: NodeHealth | 'checking';
  onCheck: () => void;
  onChange: (p: Partial<RenderNodeConfig>) => void;
  onRemove: () => void;
}) {
  const project = useStudio((s) => s.project?.song ?? null);
  const [test, setTest] = useState<{
    busy?: string;
    text?: string;
    tone?: 'success' | 'danger';
    audio?: string;
  } | null>(null);
  const audioUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
    },
    [],
  );
  const h = health === 'checking' ? undefined : health;
  const info = h?.info;
  const run = async (kind: 'loudness' | 'mix') => {
    setTest({ busy: kind });
    const { song, endTick, label } = testSong(project);
    try {
      const r = await testRenderNode(node, song, kind, { endTick });
      if (kind === 'mix' && r.wav) {
        if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
        audioUrl.current = URL.createObjectURL(new Blob([new Uint8Array(r.wav)], { type: 'audio/wav' }));
        setTest({
          tone: 'success',
          text: `Rendered ${label}: ${r.durationSeconds?.toFixed(1) ?? '?'} s of audio (${bytesLabel(r.wav.byteLength)}) in ${r.renderMs ?? '?'} ms on the node, ${r.ms} ms round trip.`,
          audio: audioUrl.current,
        });
      } else {
        const lufs = r.report?.integratedLufs;
        const peak = r.report?.truePeakDb;
        setTest({
          tone: 'success',
          text: `Loudness of ${label}: ${typeof lufs === 'number' && Number.isFinite(lufs) ? lufs.toFixed(1) : '−∞'} LUFS${typeof peak === 'number' && Number.isFinite(peak) ? ` · ${peak.toFixed(1)} dBTP` : ''} — rendered in ${r.renderMs ?? '?'} ms on the node, ${r.ms} ms round trip.`,
        });
      }
    } catch (err) {
      setTest({ tone: 'danger', text: errorMessage(err) });
    }
  };
  const statusDot = health === 'checking' ? 'busy' : h?.ok ? 'ok' : h ? 'err' : '';
  return (
    <article
      className={`st-node ${node.enabled ? '' : 'off'}`}
      data-testid="render-node"
      aria-label={node.name}
    >
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className={`status-dot ${statusDot}`} />
            <strong className="ellipsis">{node.name}</strong>
          </div>
          <div className="small mono dim ellipsis">
            {node.url || `${nodeBaseUrl(node) || window.location.origin} (local server)`}
          </div>
        </div>
        <Toggle
          on={node.enabled}
          onChange={(enabled) => onChange({ enabled })}
          title={node.enabled ? 'Disable' : 'Enable'}
        />
      </div>
      {info ? (
        <div className="st-node-stats">
          <div>
            <span className="dim">CPU</span>
            <strong>{info.cpuCores} cores</strong>
          </div>
          <div>
            <span className="dim">Load</span>
            <strong>{info.loadAvg?.[0]?.toFixed(2) ?? '—'}</strong>
          </div>
          <div>
            <span className="dim">Jobs</span>
            <strong>
              {info.busyJobs}/{info.maxJobs}
              {info.queuedJobs ? ` +${info.queuedJobs}` : ''}
            </strong>
          </div>
          <div
            title={
              info.totalMemGb !== undefined ? `${info.freeMemGb} of ${info.totalMemGb} GB free` : undefined
            }
          >
            <span className="dim">Free RAM</span>
            <strong>{info.freeMemGb !== undefined ? `${Math.round(info.freeMemGb)} GB` : '—'}</strong>
          </div>
        </div>
      ) : (
        <div className="small muted">
          {health === 'checking' ? 'Checking…' : (h?.reason ?? 'Not checked yet')}
        </div>
      )}
      {info && (
        <div className="row wrap" style={{ gap: 4 }}>
          <Badge tone={h?.ok ? 'success' : 'danger'}>{h?.ok ? 'Healthy' : 'Not used'}</Badge>
          <Badge>{info.name}</Badge>
          <Badge title="Server version">v{info.version}</Badge>
          {info.engineVersion && (
            <Badge tone={info.engineVersion === ENGINE_VERSION ? undefined : 'danger'}>
              engine {info.engineVersion}
            </Badge>
          )}
          <Badge>{info.mode === 'workers' ? 'worker threads' : 'inline'}</Badge>
        </div>
      )}
      {h && !h.ok && info && <div className="small st-provider-error">{h.reason}</div>}
      {info && (
        <div className="small dim">
          {info.capabilities.map((c) => c.replace('render-', '')).join(' · ')}
          {h?.latencyMs !== undefined ? ` · ${h.latencyMs} ms` : ''}
        </div>
      )}
      {test?.text && (
        <div className={`callout ${test.tone ?? ''} small`} data-testid="node-test-result">
          {test.text}
          {test.audio && (
            <audio
              controls
              src={test.audio}
              style={{ display: 'block', width: '100%', marginTop: 6, height: 32 }}
            />
          )}
        </div>
      )}
      <details className="st-adv">
        <summary>Edit</summary>
        <div className="grid-2">
          <Field label="Name">
            <TextInput size="sm" value={node.name} onChange={(name) => onChange({ name })} />
          </Field>
          <Field label="URL">
            <TextInput
              size="sm"
              mono
              value={node.url}
              onChange={(url) => onChange({ url })}
              placeholder="(this page’s server)"
            />
          </Field>
        </div>
        <Field label="Token">
          <input
            className="input sm mono"
            type="password"
            autoComplete="off"
            value={node.token ?? ''}
            onChange={(e) => onChange({ token: e.target.value || undefined })}
          />
        </Field>
      </details>
      <div className="row" style={{ marginTop: 'auto' }}>
        <Button size="sm" icon="rebuild" onClick={onCheck} disabled={health === 'checking'}>
          Check
        </Button>
        <Button size="sm" icon="waveform" onClick={() => void run('loudness')} disabled={!!test?.busy}>
          {test?.busy === 'loudness' ? 'Rendering…' : 'Test render'}
        </Button>
        <Button
          size="sm"
          icon="play"
          onClick={() => void run('mix')}
          disabled={!!test?.busy}
          title="Render a short mix on the node and play it here"
        >
          {test?.busy === 'mix' ? 'Rendering…' : 'Render audio'}
        </Button>
        <span className="grow" />
        <Button
          size="sm"
          variant="ghost"
          icon="trash"
          onClick={onRemove}
          aria-label={`Remove ${node.name}`}
        />
      </div>
    </article>
  );
}

function DistributedTest() {
  const project = useStudio((s) => s.project);
  const nodes = useSettings((s) => s.renderNodes);
  const useNodes = useSettings((s) => s.useRenderNodes);
  const [state, setState] = useState<{
    running: boolean;
    progress: number;
    message?: string;
    placements: StemPlacement[];
    ms?: number;
    error?: string;
    stems?: number;
  } | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const enabled = useMemo(() => nodes.filter((n) => n.enabled), [nodes]);
  const run = async () => {
    if (!project) return;
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    const t0 = performance.now();
    setState({ running: true, progress: 0, placements: [] });
    try {
      const assets = await collectAssets(project.song, project);
      // Same node selection as exports: the enabled nodes when "use render nodes" is on.
      const stems = await renderStemsDistributed(project.song, assets, {
        signal: ac.signal,
        onProgress: (p, message) =>
          setState((s) => (s ? { ...s, progress: p, message: message ?? s.message } : s)),
        onPlacement: (pl) => setState((s) => (s ? { ...s, placements: [...s.placements, pl] } : s)),
      });
      setState((s) =>
        s
          ? {
              ...s,
              running: false,
              progress: 1,
              ms: Math.round(performance.now() - t0),
              stems: Object.keys(stems).length,
              message: undefined,
            }
          : s,
      );
    } catch (err) {
      setState((s) => (s ? { ...s, running: false, error: errorMessage(err) } : s));
    }
  };
  useEffect(() => () => ctrl.current?.abort(), []);
  return (
    <Panel
      title="Distributed stem render"
      icon="layers"
      sub="Render the open song’s stem groups across the enabled nodes (falls back to this device) — the same path exports can use."
      actions={
        state?.running ? (
          <Button size="sm" variant="danger" onClick={() => ctrl.current?.abort()}>
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon="play"
            onClick={() => void run()}
            disabled={!project || !project.song.tracks.length}
          >
            Render stems
          </Button>
        )
      }
      testId="distributed-test"
    >
      {!project ? (
        <Empty icon="folder">Open a project to try a distributed stem render.</Empty>
      ) : !state ? (
        <div className="small muted">
          {!useNodes
            ? 'Render nodes are switched off above — everything renders on this device.'
            : enabled.length
              ? `${enabled.length} enabled node${enabled.length === 1 ? '' : 's'} will share the work; unhealthy ones are skipped.`
              : 'No enabled nodes — everything renders on this device.'}
        </div>
      ) : (
        <div className="col">
          {state.running && (
            <>
              <Progress value={state.progress} ai />
              <div className="small muted">{state.message ?? 'Checking nodes…'}</div>
            </>
          )}
          {state.error && <div className="callout danger">{state.error}</div>}
          {state.ms !== undefined && (
            <div className="callout success">
              {state.stems} stems in {(state.ms / 1000).toFixed(1)} s.
            </div>
          )}
          {state.placements.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Stem</th>
                  <th>Rendered on</th>
                  <th className="num">Time</th>
                </tr>
              </thead>
              <tbody>
                {state.placements.map((p) => (
                  <tr key={p.stem}>
                    <td>
                      {p.stem}{' '}
                      <span className="small dim">
                        ({p.trackIds.length} track{p.trackIds.length === 1 ? '' : 's'})
                      </span>
                    </td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <Icon name={p.where === 'this device' ? 'cpu' : 'server'} size={12} />
                        <span>{p.where}</span>
                        {p.fallback && <span className="small dim">— {p.fallback}</span>}
                      </span>
                    </td>
                    <td className="num">{p.ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}
