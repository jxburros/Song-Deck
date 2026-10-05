import { useEffect, useState } from 'react';
import { configFromPreset } from '@songdeck/ai';
import { useSettings } from '../../state/settings';
import { useStudio } from '../../state/store';
import { refreshPluginHosts, useInstrumentPlugins, WAM_HOST_ID } from '../../engine/instrument-plugins';
import { describeWam } from '../../engine/wam-host';
import { Badge, Button, TextInput, Toggle } from '../../ui/kit';
import { Empty, Panel } from './ui';

const FORMAT_LABEL: Record<string, string> = {
  vst3: 'VST3',
  au: 'Audio Units',
  vst2: 'VST2',
  clap: 'CLAP',
  lv2: 'LV2',
  sf2: 'SoundFonts (SF2)',
  sfz: 'SFZ',
  wam: 'Web Audio Modules',
};

/**
 * Instrument plugins like a DAW: hosts (the native plugin host bridge, the in-browser WAM host),
 * what they found, and the Web Audio Modules you added by URL.
 */
export function InstrumentHostsSection() {
  const hosts = useInstrumentPlugins((s) => s.hosts);
  const refreshing = useInstrumentPlugins((s) => s.refreshing);
  const providers = useSettings((s) => s.providers);
  const wamPlugins = useSettings((s) => s.wamPlugins);
  const autoRender = useSettings((s) => s.autoRenderPlugins);
  const update = useSettings((s) => s.update);
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const st = useStudio.getState();

  useEffect(() => {
    void refreshPluginHosts();
  }, [providers, wamPlugins]);

  const hasNativeHost = providers.some((p) => p.adapter === 'plugin-host-http');
  const addLocalHost = () => {
    useSettings.getState().upsertProvider(configFromPreset('plugin-host-local'));
    st.toast('success', 'Plugin host added — start it with python3 bridges/plugin_host_bridge.py');
  };

  const addWam = async () => {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u) && !u.startsWith('/')) {
      st.toast('error', 'Enter the URL of the module’s index.js (https://… or a path served by Song Deck)');
      return;
    }
    setAdding(true);
    try {
      const d = await describeWam(u);
      update({
        wamPlugins: [
          ...wamPlugins.filter((p) => p.url !== u),
          { url: u, name: d.name, ...(d.vendor ? { vendor: d.vendor } : {}) },
        ],
      });
      setUrl('');
      st.toast('success', `Added ${d.name}`);
    } catch (err) {
      st.toast('error', `Could not load that module: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAdding(false);
    }
  };

  const allPlugins = hosts.flatMap((h) =>
    h.plugins.filter((p) => (p.category ?? 'instrument') !== 'effect').map((p) => ({ ...p, host: h.name })),
  );

  return (
    <>
      <Panel
        title="Plugin hosts"
        icon="plug"
        sub="A host loads your installed instrument plugins and renders MIDI tracks through them (the track is frozen to audio, like a DAW freeze). Pick a plugin in the track inspector."
        actions={
          <Button
            size="sm"
            icon="rebuild"
            onClick={() => void refreshPluginHosts({ rescan: true })}
            disabled={refreshing}
          >
            {refreshing ? 'Scanning…' : 'Rescan plugins'}
          </Button>
        }
      >
        {!hasNativeHost && (
          <div className="callout small">
            Native plugins (VST3, Audio Units, VST2, CLAP, LV2, SoundFonts, SFZ) need the plugin host bridge
            on this computer: <code>pip install pedalboard mido</code>, then{' '}
            <code>python3 bridges/plugin_host_bridge.py</code>.{' '}
            <Button size="sm" variant="primary" icon="plus" onClick={addLocalHost}>
              Add the local plugin host
            </Button>
          </div>
        )}
        {hosts.length === 0 ? (
          <Empty icon="plug">No plugin hosts yet</Empty>
        ) : (
          <div className="col">
            {hosts.map((h) => (
              <div key={h.id} className="card col" style={{ gap: 4 }}>
                <div className="row between wrap">
                  <strong>{h.name}</strong>
                  <Badge
                    tone={h.status === 'ready' ? 'success' : h.status === 'loading' ? 'ai' : 'danger'}
                    title={h.error}
                  >
                    {h.status === 'ready' ? `${h.plugins.length} plugins` : h.status}
                  </Badge>
                </div>
                {h.error && <div className="callout danger small">{h.error}</div>}
                {h.info && (
                  <div className="row wrap" style={{ gap: 4 }}>
                    {h.info.formats.map((f) => (
                      <Badge
                        key={f.format}
                        tone={f.available ? 'success' : undefined}
                        title={f.note ?? f.backend}
                      >
                        {FORMAT_LABEL[f.format] ?? f.format}
                        {f.available ? '' : ' (unavailable)'}
                      </Badge>
                    ))}
                    {h.id !== WAM_HOST_ID && (
                      <span className="small dim">
                        {h.info.editor ? 'Plugin editors open on that computer' : 'No plugin editors'}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <Toggle
          on={autoRender}
          onChange={(autoRenderPlugins) => update({ autoRenderPlugins })}
          label="Re-render plugin tracks automatically after edits"
        />
      </Panel>

      <Panel title="Installed instrument plugins" icon="midi">
        {allPlugins.length === 0 ? (
          <Empty icon="midi">No instrument plugins found</Empty>
        ) : (
          <table className="table small">
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Vendor</th>
                <th>Format</th>
                <th>Host</th>
              </tr>
            </thead>
            <tbody>
              {allPlugins.slice(0, 400).map((p) => (
                <tr key={`${p.host}:${p.id}`}>
                  <td>{p.name}</td>
                  <td>{p.vendor ?? ''}</td>
                  <td>{FORMAT_LABEL[p.format] ?? p.format}</td>
                  <td>{p.host}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="Web Audio Modules"
        icon="wave"
        sub="WAM 2 instruments run in the browser (no host needed). Add the URL of a module’s index.js. Module code runs with the studio’s rights — only add modules you trust."
      >
        {wamPlugins.map((p) => (
          <div key={p.url} className="row between">
            <span>
              <strong>{p.name}</strong> <span className="small dim mono">{p.url}</span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              aria-label={`Remove ${p.name}`}
              onClick={() => update({ wamPlugins: wamPlugins.filter((x) => x.url !== p.url) })}
            />
          </div>
        ))}
        <div className="row">
          <TextInput
            value={url}
            onChange={setUrl}
            placeholder="https://…/index.js"
            aria-label="Web Audio Module URL"
          />
          <Button size="sm" icon="plus" onClick={() => void addWam()} disabled={adding || !url.trim()}>
            {adding ? 'Loading…' : 'Add module'}
          </Button>
        </div>
      </Panel>
    </>
  );
}
