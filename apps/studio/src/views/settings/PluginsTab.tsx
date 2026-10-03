import { useEffect, useMemo, useState } from 'react';
import {
  BUILTIN_GENRES,
  BUILTIN_INSTRUMENTS,
  midiToNoteName,
  type GenreProfile,
  type InstrumentProfile,
} from '@songdeck/core';
import { useSettings } from '../../state/settings';
import { useStudio } from '../../state/store';
import { useRuntime } from '../../engine/runtime';
import { loadPlugin, unloadPlugin, useExtensions, type PluginManifest } from '../../engine/plugins';
import { Badge, Button, FileButton, Modal, Tabs, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { scanPluginRecords, type PluginScan } from './api';
import { GenreEditor, normalizeGenre } from './GenreEditor';
import { InstrumentEditor, normalizeInstrument } from './InstrumentEditor';
import { useSettingsNav } from './nav';
import { ConfirmModal, Empty, Panel, TabHeader, downloadJson, errorMessage, readJsonFile } from './ui';

/** Plugin ecosystem (spec §57, Phase 5) and custom genre / instrument profiles (spec §14, §17, Phase 2). */

type Sub = 'plugins' | 'genres' | 'instruments';

const KIND_LABEL: Record<string, string> = {
  'ai-provider': 'AI provider',
  'music-model': 'Music model',
  'singing-engine': 'Singing engine',
  'transcription-engine': 'Transcription engine',
  instrument: 'Instruments',
  'genre-profile': 'Genre profile',
  exporter: 'Exporter',
};

const PERMISSION_INFO: Record<string, string> = {
  network: 'Make network requests',
  'provider-registry': 'Register AI providers',
  audio: 'Process audio',
  'project-read': 'Read the open project',
  'project-write': 'Change the open project',
  storage: 'Store data in this browser',
  midi: 'Read and write MIDI',
  files: 'Load files shipped with the plugin',
};

let lastSub: Sub = 'plugins';

export default function PluginsTab() {
  const focus = useSettingsNav((s) => s.focus);
  const [sub, setSub] = useState<Sub>(() =>
    focus === 'genres' || focus === 'instruments' ? focus : lastSub,
  );
  useEffect(() => {
    lastSub = sub;
  }, [sub]);
  return (
    <>
      <TabHeader
        icon="layers"
        title="Plugins & profiles"
        spec="§14 §17 §57"
        lede="Extend Song Deck with community plugins — AI providers, music models, singing and transcription engines, instruments, genre profiles, exporters — and shape composition with your own genre and instrument profiles."
      />
      <Tabs
        value={sub}
        onChange={setSub}
        className="st-subtabs"
        tabs={[
          { value: 'plugins', label: 'Plugins', icon: 'plug' },
          { value: 'genres', label: 'Genre profiles', icon: 'music' },
          { value: 'instruments', label: 'Instrument profiles', icon: 'midi' },
        ]}
      />
      {sub === 'plugins' && <PluginsSection />}
      {sub === 'genres' && <GenresSection />}
      {sub === 'instruments' && <InstrumentsSection />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

function PluginsSection() {
  const server = useRuntime((s) => s.server.status);
  const enabled = useSettings((s) => s.enabledPlugins);
  const update = useSettings((s) => s.update);
  const loaded = useExtensions((s) => s.loaded);
  const toast = useStudio((s) => s.toast);
  const [scan, setScan] = useState<PluginScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [trust, setTrust] = useState<PluginManifest | null>(null);

  const rescan = async () => {
    setBusy('scan');
    setError(null);
    try {
      setScan(await scanPluginRecords());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    if (server === 'online') void rescan();
  }, [server]);

  const enable = async (m: PluginManifest) => {
    setTrust(null);
    setBusy(m.id);
    update({ enabledPlugins: [...new Set([...enabled, m.id])] });
    await loadPlugin(m);
    setBusy(null);
    const st = useExtensions.getState().loaded[m.id];
    if (st?.status === 'loaded')
      toast(
        'success',
        `${m.name} enabled${st.contributions.length ? `: ${st.contributions.join(', ')}` : ''}`,
      );
    else toast('error', `${m.name} could not be loaded: ${st?.error ?? 'unknown error'}`);
  };
  const disable = (m: PluginManifest) => {
    update({ enabledPlugins: enabled.filter((id) => id !== m.id) });
    unloadPlugin(m.id);
    toast('info', `${m.name} disabled: everything it added was removed.`);
  };

  if (server !== 'online') {
    return (
      <Panel title="Plugins" icon="plug">
        <Empty icon="server">
          Plugins are discovered by the local server (<code>plugins/</code> in the repository and{' '}
          <code>~/.songdeck/plugins</code>). Start it with <code>npx tsx apps/server/src/cli.ts</code> to
          browse and enable them.
        </Empty>
      </Panel>
    );
  }

  return (
    <>
      <div className="callout warning st-trust-callout">
        <Icon name="alert" size={14} /> Plugin code runs inside the studio with the same access as Song Deck
        itself. The server only serves plugin files — it never executes them. Enable plugins you trust.
      </div>
      <Panel
        title="Available plugins"
        icon="plug"
        testId="plugin-list"
        actions={
          <Button size="sm" icon="rebuild" onClick={() => void rescan()} disabled={busy === 'scan'}>
            {busy === 'scan' ? 'Scanning…' : 'Rescan'}
          </Button>
        }
      >
        {error && <div className="callout danger">{error}</div>}
        {!scan ? (
          <div className="small muted">Scanning…</div>
        ) : scan.plugins.length === 0 ? (
          <Empty icon="plug">
            No plugins found. Put a folder with a songdeck-plugin.json into ~/.songdeck/plugins and rescan.
          </Empty>
        ) : (
          <div className="st-plugin-list">
            {scan.plugins.map((p) => {
              const on = enabled.includes(p.id);
              const st = loaded[p.id];
              return (
                <article
                  key={p.id}
                  className={`st-plugin ${on ? 'on' : ''}`}
                  data-testid={`plugin-${p.id}`}
                  aria-label={p.name}
                >
                  <div className="row between" style={{ alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 8 }}>
                        <strong>{p.name}</strong>
                        <Badge tone="ai">{KIND_LABEL[p.kind] ?? p.kind}</Badge>
                        <span className="small dim mono">v{p.version}</span>
                      </div>
                      <div className="small dim">
                        {p.author || 'Unknown author'} ·{' '}
                        {p.source === 'user' ? 'your plugins folder' : 'bundled'} ·{' '}
                        <span className="mono">{p.id}</span>
                      </div>
                    </div>
                    <div className="row">
                      {busy === p.id ? (
                        <span className="small muted">Loading…</span>
                      ) : st?.status === 'loaded' ? (
                        <Badge tone="success">Loaded</Badge>
                      ) : st?.status === 'error' ? (
                        <Badge tone="danger">Error</Badge>
                      ) : on ? (
                        <Badge tone="warning">Enabled</Badge>
                      ) : null}
                      <Toggle
                        on={on}
                        onChange={(v) => (v ? setTrust(p) : disable(p))}
                        title={on ? 'Disable plugin' : 'Enable plugin'}
                      />
                    </div>
                  </div>
                  {p.description && (
                    <p className="small" style={{ margin: 0 }}>
                      {p.description}
                    </p>
                  )}
                  <div className="st-plugin-meta">
                    <div>
                      <span className="field-label">Permissions</span>
                      {p.permissions?.length ? (
                        <ul className="st-plain">
                          {p.permissions.map((perm) => (
                            <li key={perm}>
                              <Icon name="key" size={11} /> {PERMISSION_INFO[perm] ?? perm}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="small dim">None declared</div>
                      )}
                    </div>
                    <div>
                      <span className="field-label">Files</span>
                      <div className="small mono dim">
                        {(p.files ?? (p.entry ? [p.entry] : [])).join(' · ') || '—'}
                      </div>
                    </div>
                    {st && (
                      <div>
                        <span className="field-label">Contributions</span>
                        {st.contributions.length ? (
                          <ul className="st-plain" data-testid="plugin-contributions">
                            {st.contributions.map((c) => (
                              <li key={c}>
                                <Icon name="check" size={11} /> {c}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="small dim">none</div>
                        )}
                      </div>
                    )}
                  </div>
                  {st?.error && <div className="callout danger small">Load error: {st.error}</div>}
                  {p.warnings && p.warnings.length > 0 && (
                    <div className="small dim">Manifest notes: {p.warnings.join('; ')}</div>
                  )}
                  {p.homepage && (
                    <a className="small" href={p.homepage} target="_blank" rel="noreferrer noopener">
                      {p.homepage} ↗
                    </a>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {scan && scan.errors.length > 0 && (
          <div className="col" style={{ marginTop: 12 }}>
            <span className="field-label">Invalid plugins</span>
            {scan.errors.map((e) => (
              <div key={e.dir} className="callout danger small">
                <strong>{e.id ?? e.dir.split('/').pop()}</strong>: {e.error}
              </div>
            ))}
          </div>
        )}
      </Panel>

      {trust && (
        <Modal
          title={`Enable ${trust.name}?`}
          icon="alert"
          onClose={() => setTrust(null)}
          footer={
            <>
              <Button onClick={() => setTrust(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void enable(trust)}>
                I trust this plugin — enable
              </Button>
            </>
          }
        >
          <div className="col">
            <p>
              <strong>Plugin code runs in the studio</strong> with the same access as Song Deck: it can read
              and change your open project, call your configured providers through the studio, and make
              network requests. Only enable plugins from authors you trust.
            </p>
            <dl className="kv">
              <dt>Plugin</dt>
              <dd>
                {trust.name} v{trust.version} ({KIND_LABEL[trust.kind] ?? trust.kind})
              </dd>
              <dt>Author</dt>
              <dd>{trust.author || 'unknown'}</dd>
              <dt>Entry module</dt>
              <dd className="mono">{trust.entry ?? '— (data only)'}</dd>
              <dt>Permissions</dt>
              <dd>
                {trust.permissions?.length
                  ? trust.permissions.map((p) => PERMISSION_INFO[p] ?? p).join(', ')
                  : 'none declared'}
              </dd>
            </dl>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Genre profiles
// ---------------------------------------------------------------------------

function GenresSection() {
  const custom = useSettings((s) => s.customGenres);
  const customInstruments = useSettings((s) => s.customInstruments);
  const update = useSettings((s) => s.update);
  const plugin = useExtensions((s) => s.genres);
  const toast = useStudio((s) => s.toast);
  const [editing, setEditing] = useState<{ genre: GenreProfile; originalId?: string } | null>(null);
  const [del, setDel] = useState<GenreProfile | null>(null);
  const [q, setQ] = useState('');

  const all = useMemo(
    () => [
      ...custom.map((g) => ({ g, source: 'custom' as const })),
      ...plugin.map((g) => ({ g, source: 'plugin' as const })),
      ...BUILTIN_GENRES.map((g) => ({ g, source: 'built-in' as const })),
    ],
    [custom, plugin],
  );
  const ids = useMemo(() => new Set(all.map((x) => x.g.id)), [all]);
  const visible = all.filter(
    ({ g }) =>
      !q.trim() ||
      `${g.name} ${g.id} ${(g.tags ?? []).join(' ')}`.toLowerCase().includes(q.trim().toLowerCase()),
  );

  const duplicate = (g: GenreProfile) => {
    let id = `${g.id}-custom`;
    for (let i = 2; ids.has(id); i++) id = `${g.id}-custom-${i}`;
    setEditing({ genre: { ...structuredClone(g), id, name: `${g.name} (custom)`, builtIn: false } });
  };
  const save = (g: GenreProfile, originalId?: string) => {
    update({ customGenres: [...custom.filter((x) => x.id !== (originalId ?? g.id)), g] });
    setEditing(null);
    toast('success', `Saved genre profile “${g.name}” — available in Compose and blends`);
  };
  const importFiles = async (files: File[]) => {
    for (const f of files) {
      try {
        const raw = await readJsonFile<unknown>(f);
        const list = Array.isArray(raw) ? raw : [raw];
        const next = [...useSettings.getState().customGenres];
        for (const item of list) {
          const g = normalizeGenre(item);
          if (BUILTIN_GENRES.some((b) => b.id === g.id)) g.id = `${g.id}-custom`;
          const i = next.findIndex((x) => x.id === g.id);
          if (i >= 0) next[i] = g;
          else next.push(g);
        }
        update({ customGenres: next });
        toast('success', `Imported ${list.length} genre profile${list.length > 1 ? 's' : ''} from ${f.name}`);
      } catch (err) {
        toast('error', `Could not import ${f.name}: ${errorMessage(err)}`);
      }
    }
  };

  return (
    <Panel
      title="Genre profiles"
      icon="music"
      testId="genre-list"
      sub="Genres are editable rule profiles — tempo, meters, harmony, form, instrumentation, rhythm, dynamics, arrangement and production (spec §14). Duplicate a built-in to make your own."
      actions={
        <div className="row">
          <input
            className="input sm"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter genres"
            style={{ width: 160 }}
          />
          <FileButton
            accept=".json,application/json"
            onFile={(f) => void importFiles(f)}
            icon="upload"
            multiple
          >
            Import JSON
          </FileButton>
          {custom.length > 0 && (
            <Button icon="download" onClick={() => downloadJson('songdeck-genres.json', custom)}>
              Export custom
            </Button>
          )}
        </div>
      }
    >
      <div className="st-table-wrap">
        <table className="table st-genre-table">
          <thead>
            <tr>
              <th>Genre</th>
              <th>Source</th>
              <th>Tempo</th>
              <th>Meter / modes</th>
              <th>Harmony</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map(({ g, source }) => (
              <tr key={`${source}-${g.id}`} data-testid={`genre-${g.id}`}>
                <td>
                  <div style={{ fontWeight: 600 }}>{g.name}</div>
                  <div className="small dim mono">{g.id}</div>
                </td>
                <td>
                  {source === 'custom' ? (
                    <Badge tone="accent">Custom</Badge>
                  ) : source === 'plugin' ? (
                    <Badge tone="ai">Plugin</Badge>
                  ) : (
                    <Badge>Built-in</Badge>
                  )}
                </td>
                <td className="mono small">
                  {g.tempo.min}–{g.tempo.max} <span className="dim">({g.tempo.typical})</span>
                </td>
                <td className="small">
                  {g.meters.map((m) => `${m.numerator}/${m.denominator}`).join(', ')} ·{' '}
                  {g.modes
                    .slice(0, 3)
                    .map((m) => m.mode)
                    .join(', ')}
                </td>
                <td
                  className="small mono ellipsis"
                  style={{ maxWidth: 220 }}
                  title={g.harmony.progressions.map((p) => p.roman.join(' ')).join(' | ')}
                >
                  {g.harmony.progressions[0]?.roman.join(' ')}
                  {g.harmony.progressions.length > 1 ? ` +${g.harmony.progressions.length - 1}` : ''}
                </td>
                <td style={{ textAlign: 'right' }} className="nowrap">
                  {source === 'custom' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="pencil"
                      onClick={() => setEditing({ genre: g, originalId: g.id })}
                    >
                      Edit
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="copy"
                    onClick={() => duplicate(g)}
                    aria-label={`Duplicate ${g.name}`}
                  >
                    Duplicate
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="download"
                    onClick={() => downloadJson(`${g.id}.genre.json`, { ...g, builtIn: undefined })}
                    aria-label={`Export ${g.name}`}
                  />
                  {source === 'custom' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      onClick={() => setDel(g)}
                      aria-label={`Delete ${g.name}`}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <GenreEditor
          genre={editing.genre}
          takenIds={new Set([...ids].filter((id) => id !== editing.originalId))}
          customInstruments={customInstruments}
          onClose={() => setEditing(null)}
          onSave={(g) => save(g, editing.originalId)}
        />
      )}
      {del && (
        <ConfirmModal
          title={`Delete “${del.name}”?`}
          confirmLabel="Delete profile"
          danger
          onClose={() => setDel(null)}
          onConfirm={() => {
            update({ customGenres: custom.filter((x) => x.id !== del.id) });
            setDel(null);
          }}
        >
          Projects that used it keep a copy of the profile in their project file, so they stay reproducible.
        </ConfirmModal>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Instrument profiles
// ---------------------------------------------------------------------------

function InstrumentsSection() {
  const custom = useSettings((s) => s.customInstruments);
  const update = useSettings((s) => s.update);
  const plugin = useExtensions((s) => s.instruments);
  const toast = useStudio((s) => s.toast);
  const [editing, setEditing] = useState<{ ins: InstrumentProfile; originalId?: string } | null>(null);
  const [q, setQ] = useState('');
  const all = useMemo(
    () => [
      ...custom.map((i) => ({ i, source: 'custom' as const })),
      ...plugin.map((i) => ({ i, source: 'plugin' as const })),
      ...BUILTIN_INSTRUMENTS.map((i) => ({ i, source: 'built-in' as const })),
    ],
    [custom, plugin],
  );
  const ids = useMemo(() => new Set(all.map((x) => x.i.id)), [all]);
  const visible = all.filter(
    ({ i }) => !q.trim() || `${i.name} ${i.id} ${i.family}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const duplicate = (ins: InstrumentProfile) => {
    let id = `${ins.id}-custom`;
    for (let n = 2; ids.has(id); n++) id = `${ins.id}-custom-${n}`;
    setEditing({ ins: { ...structuredClone(ins), id, name: `${ins.name} (custom)`, custom: true } });
  };
  const importFiles = async (files: File[]) => {
    for (const f of files) {
      try {
        const raw = await readJsonFile<unknown>(f);
        const list = Array.isArray(raw) ? raw : [raw];
        const next = [...useSettings.getState().customInstruments];
        for (const item of list) {
          const ins = normalizeInstrument(item);
          if (BUILTIN_INSTRUMENTS.some((b) => b.id === ins.id)) ins.id = `${ins.id}-custom`;
          const k = next.findIndex((x) => x.id === ins.id);
          if (k >= 0) next[k] = ins;
          else next.push(ins);
        }
        update({ customInstruments: next });
        toast('success', `Imported ${list.length} instrument profile${list.length > 1 ? 's' : ''}`);
      } catch (err) {
        toast('error', `Could not import ${f.name}: ${errorMessage(err)}`);
      }
    }
  };
  return (
    <Panel
      title="Instrument profiles"
      icon="midi"
      testId="instrument-list"
      sub="Range, General MIDI program, guide-render patch, role and stem group (spec §17). Custom instruments appear in blueprints and genre profiles."
      actions={
        <div className="row">
          <input
            className="input sm"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter instruments"
            style={{ width: 160 }}
          />
          <FileButton
            accept=".json,application/json"
            onFile={(f) => void importFiles(f)}
            icon="upload"
            multiple
          >
            Import JSON
          </FileButton>
          {custom.length > 0 && (
            <Button icon="download" onClick={() => downloadJson('songdeck-instruments.json', custom)}>
              Export custom
            </Button>
          )}
        </div>
      }
    >
      <div className="st-table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Source</th>
              <th>Family / role</th>
              <th>Range</th>
              <th>Stem</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map(({ i, source }) => (
              <tr key={`${source}-${i.id}`}>
                <td>
                  <div style={{ fontWeight: 600 }}>{i.name}</div>
                  <div className="small dim mono">{i.id}</div>
                </td>
                <td>
                  {source === 'custom' ? (
                    <Badge tone="accent">Custom</Badge>
                  ) : source === 'plugin' ? (
                    <Badge tone="ai">Plugin</Badge>
                  ) : (
                    <Badge>Built-in</Badge>
                  )}
                </td>
                <td className="small">
                  {i.family} · {i.defaultRole}
                </td>
                <td className="mono small">
                  {i.isDrumKit
                    ? 'drum kit'
                    : `${midiToNoteName(i.range.low)}–${midiToNoteName(i.range.high)}`}
                </td>
                <td className="small">{i.stemGroup}</td>
                <td style={{ textAlign: 'right' }} className="nowrap">
                  {source === 'custom' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="pencil"
                      onClick={() => setEditing({ ins: i, originalId: i.id })}
                    >
                      Edit
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="copy"
                    onClick={() => duplicate(i)}
                    aria-label={`Duplicate ${i.name}`}
                  >
                    Duplicate
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="download"
                    onClick={() => downloadJson(`${i.id}.instrument.json`, i)}
                    aria-label={`Export ${i.name}`}
                  />
                  {source === 'custom' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      onClick={() => update({ customInstruments: custom.filter((x) => x.id !== i.id) })}
                      aria-label={`Delete ${i.name}`}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <InstrumentEditor
          instrument={editing.ins}
          takenIds={new Set([...ids].filter((id) => id !== editing.originalId))}
          onClose={() => setEditing(null)}
          onSave={(ins) => {
            update({
              customInstruments: [...custom.filter((x) => x.id !== (editing.originalId ?? ins.id)), ins],
            });
            setEditing(null);
            toast('success', `Saved instrument “${ins.name}”`);
          }}
        />
      )}
    </Panel>
  );
}
