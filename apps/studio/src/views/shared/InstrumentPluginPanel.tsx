import { useEffect, useMemo, useRef, useState } from 'react';
import type { InstrumentPluginDescription } from '@songdeck/ai';
import type { Song, Track } from '@songdeck/core';
import {
  WAM_HOST_ID,
  assignPlugin,
  describePlugin,
  openPluginEditor,
  pluginRenderStale,
  refreshPluginHosts,
  removePlugin,
  renderTrackPlugin,
  savePluginState,
  setPluginOptions,
  useInstrumentPlugins,
} from '../../engine/instrument-plugins';
import type { WamEditorSession } from '../../engine/wam-host';
import { useStudio } from '../../state/store';
import { openSettings } from '../settings/nav';
import { Badge, Button, Field, Modal, Select, Slider, Spinner, Toggle } from '../../ui/kit';

const FORMAT_LABEL: Record<string, string> = {
  vst3: 'VST3',
  au: 'Audio Unit',
  vst2: 'VST2',
  clap: 'CLAP',
  lv2: 'LV2',
  sf2: 'SoundFont',
  sfz: 'SFZ',
  wam: 'Web Audio Module',
};

/**
 * Instrument plugin of a MIDI track (DAW-style instrument insert): choose a plugin from any
 * connected host, edit it in its own editor, and keep its frozen render up to date.
 */
export function InstrumentPluginPanel({ song, track }: { song: Song; track: Track }) {
  const hosts = useInstrumentPlugins((s) => s.hosts);
  const refreshing = useInstrumentPlugins((s) => s.refreshing);
  const render = useInstrumentPlugins((s) => s.renders[track.id]);
  const slot = track.instrumentPlugin;
  const [hostId, setHostId] = useState<string>('');
  const [pluginId, setPluginId] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [desc, setDesc] = useState<InstrumentPluginDescription | null>(null);
  const [wam, setWam] = useState<WamEditorSession | null>(null);
  const st = useStudio.getState();

  useEffect(() => {
    if (!hosts.length) void refreshPluginHosts();
  }, [hosts.length]);

  const readyHosts = hosts.filter((h) => h.status === 'ready');
  const host =
    readyHosts.find((h) => h.id === hostId) ?? readyHosts.find((h) => h.plugins.length) ?? readyHosts[0];
  const choices = useMemo(
    () =>
      (host?.plugins ?? []).filter((p) => (p.category ?? 'instrument') !== 'effect' && p.loadable !== false),
    [host],
  );
  const chosen = choices.find((p) => p.id === pluginId) ?? choices[0];

  if (track.kind !== 'midi') return null;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      st.toast('error', `${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  if (!slot) {
    return (
      <div className="col" data-testid="instrument-plugin-panel">
        <div className="row between">
          <span className="field-label">Instrument plugin</span>
          <Button
            size="sm"
            icon="rebuild"
            onClick={() => void refreshPluginHosts({ rescan: true })}
            disabled={refreshing}
          >
            {refreshing ? 'Scanning…' : 'Rescan'}
          </Button>
        </div>
        {readyHosts.length === 0 ? (
          <div className="small muted">
            No plugin host is connected. Start the plugin host bridge (VST3, Audio Units, CLAP, LV2,
            SoundFonts) or add Web Audio Modules in Settings → Plugins.{' '}
            <Button
              size="sm"
              variant="ghost"
              icon="plug"
              onClick={() => openSettings('plugins', 'instrument-plugins')}
            >
              Set up
            </Button>
          </div>
        ) : (
          <>
            <div className="grid-2">
              <Field label="Host">
                <Select
                  value={host?.id ?? ''}
                  onChange={(v) => {
                    setHostId(v);
                    setPluginId('');
                  }}
                  options={readyHosts.map((h) => ({ value: h.id, label: `${h.name} (${h.plugins.length})` }))}
                  aria-label="Plugin host"
                />
              </Field>
              <Field label="Plugin">
                <Select
                  value={chosen?.id ?? ''}
                  onChange={setPluginId}
                  options={
                    choices.length
                      ? choices.map((p) => ({
                          value: p.id,
                          label: `${p.name}${p.vendor ? ` — ${p.vendor}` : ''} · ${FORMAT_LABEL[p.format] ?? p.format}`,
                        }))
                      : [{ value: '', label: 'No instrument plugins found', disabled: true }]
                  }
                  aria-label="Plugin"
                />
              </Field>
            </div>
            <div className="row">
              <Button
                size="sm"
                variant="primary"
                icon="plug"
                disabled={!host || !chosen}
                onClick={() => host && chosen && assignPlugin(track.id, host.id, chosen)}
                data-testid="use-instrument-plugin"
              >
                Use plugin
              </Button>
              <span className="small dim">
                The track is rendered through it; the built-in sound plays until the render is ready.
              </span>
            </div>
          </>
        )}
      </div>
    );
  }

  const stale = pluginRenderStale(song, track);
  const status = slot.bypass
    ? { tone: 'warning' as const, text: 'Bypassed — built-in sound' }
    : render?.status === 'running' || render?.status === 'queued'
      ? { tone: 'ai' as const, text: 'Rendering…' }
      : render?.status === 'failed'
        ? { tone: 'danger' as const, text: 'Render failed' }
        : stale
          ? { tone: 'warning' as const, text: slot.render ? 'Out of date' : 'Not rendered' }
          : { tone: 'success' as const, text: 'Rendered' };

  const loadParams = () =>
    run('Loading parameters', async () => {
      setDesc(await describePlugin(slot.hostId, slot.pluginId));
    });

  return (
    <div className="col" data-testid="instrument-plugin-panel">
      <div className="row between wrap">
        <span className="field-label">Instrument plugin</span>
        <Badge tone={status.tone} title={render?.error}>
          {status.text}
        </Badge>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <strong>{slot.name}</strong>
        {slot.vendor && <span className="small muted">{slot.vendor}</span>}
        <Badge>{FORMAT_LABEL[slot.format] ?? slot.format}</Badge>
        <span className="small dim">on {hosts.find((h) => h.id === slot.hostId)?.name ?? slot.hostId}</span>
      </div>
      {render?.status === 'failed' && render.error && (
        <div className="callout danger small">{render.error}</div>
      )}
      <div className="row wrap" style={{ gap: 6 }}>
        <Button
          size="sm"
          icon="sliders"
          disabled={!!busy}
          onClick={() =>
            void run('Opening the plugin editor', async () => {
              const r = await openPluginEditor(track.id);
              if (r.wam) setWam(r.wam);
            })
          }
          title={
            slot.hostId === WAM_HOST_ID
              ? 'Opens the plugin here'
              : 'Opens a window on the computer running the plugin host'
          }
        >
          {busy === 'Opening the plugin editor' ? 'Editor open…' : 'Edit plugin'}
        </Button>
        <Button
          size="sm"
          icon="rebuild"
          disabled={slot.bypass || !!busy}
          onClick={() => renderTrackPlugin(track.id)}
        >
          Render now
        </Button>
        <Button size="sm" variant="ghost" icon="trash" onClick={() => removePlugin(track.id)}>
          Remove
        </Button>
        {busy && <Spinner />}
      </div>
      <div className="row wrap" style={{ gap: 12 }}>
        <Toggle
          on={!!slot.bypass}
          onChange={(bypass) =>
            setPluginOptions(
              track.id,
              { bypass },
              `${track.name}: ${bypass ? 'bypassed' : 'enabled'} ${slot.name}`,
            )
          }
          label="Bypass"
        />
        <Toggle
          on={slot.autoRender !== false}
          onChange={(autoRender) =>
            setPluginOptions(
              track.id,
              { autoRender },
              `${track.name}: auto re-render ${autoRender ? 'on' : 'off'}`,
            )
          }
          label="Re-render after edits"
        />
      </div>
      <details onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && !desc && void loadParams()}>
        <summary className="small">Parameters{slot.preset ? ` · preset ${slot.preset}` : ''}</summary>
        {!desc ? (
          <div className="small dim">Loading…</div>
        ) : (
          <div className="col" style={{ maxHeight: 280, overflow: 'auto' }}>
            {desc.presets?.length ? (
              <Field label="Preset">
                <Select
                  value={slot.preset ?? ''}
                  onChange={(preset) =>
                    setPluginOptions(
                      track.id,
                      { preset: preset || undefined },
                      `${track.name}: preset → ${preset}`,
                    )
                  }
                  options={[
                    { value: '', label: '(plugin state)' },
                    ...desc.presets.map((p) => ({ value: p, label: p })),
                  ]}
                />
              </Field>
            ) : null}
            {desc.parameters.slice(0, 64).map((p) => (
              <ParamSlider
                key={p.id}
                name={p.name}
                min={p.min ?? 0}
                max={p.max ?? 1}
                value={slot.parameters?.[p.id] ?? p.value}
                onCommit={(v) =>
                  setPluginOptions(
                    track.id,
                    { parameters: { ...(slot.parameters ?? {}), [p.id]: v } },
                    `${track.name}: ${slot.name} ${p.name}`,
                  )
                }
              />
            ))}
            {desc.parameters.length > 64 && (
              <div className="small dim">
                {desc.parameters.length - 64} more parameters — use Edit plugin.
              </div>
            )}
            {!desc.parameters.length && <div className="small dim">This plugin exposes no parameters.</div>}
          </div>
        )}
      </details>
      {wam && <WamEditorModal session={wam} onDone={() => setWam(null)} trackId={track.id} />}
    </div>
  );
}

function ParamSlider({
  name,
  min,
  max,
  value,
  onCommit,
}: {
  name: string;
  min: number;
  max: number;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <Slider
      label={name}
      min={min}
      max={max}
      step={(max - min) / 200 || 0.01}
      value={v}
      onChange={setV}
      onCommit={onCommit}
      format={(x) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2))}
    />
  );
}

function WamEditorModal({
  session,
  onDone,
  trackId,
}: {
  session: WamEditorSession;
  onDone: () => void;
  trackId: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (el && session.gui) el.appendChild(session.gui);
    return () => {
      if (el && session.gui && session.gui.parentNode === el) el.removeChild(session.gui);
    };
  }, [session]);
  const close = (save: boolean) => {
    void (async () => {
      if (save) await savePluginState(trackId, await session.state());
      session.close();
      onDone();
    })();
  };
  const notes = [60, 62, 64, 65, 67, 69, 71, 72];
  return (
    <Modal
      wide
      icon="sliders"
      title={session.name}
      onClose={() => close(false)}
      footer={
        <>
          <span className="small dim grow">
            Changes are saved with the project and the track is re-rendered.
          </span>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => close(true)}>
            Save
          </Button>
        </>
      }
    >
      <div ref={host} className="wam-gui" style={{ minHeight: 200, overflow: 'auto' }}>
        {!session.gui && <div className="muted">This module has no editor of its own.</div>}
      </div>
      <div className="row wrap" style={{ gap: 4, marginTop: 8 }}>
        <span className="small dim">Try it:</span>
        {notes.map((n) => (
          <Button
            key={n}
            size="sm"
            onPointerDown={() => session.midi([0x90, n, 100])}
            onPointerUp={() => session.midi([0x80, n, 0])}
            onPointerLeave={() => session.midi([0x80, n, 0])}
          >
            {['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C'][notes.indexOf(n)]}
          </Button>
        ))}
      </div>
    </Modal>
  );
}
