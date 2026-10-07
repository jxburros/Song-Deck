import { useEffect, useMemo, useState } from 'react';
import {
  AUDIO_INPUTS,
  AUDIO_PROCESSES,
  PROVIDER_PRESETS,
  audioEngineProfile,
  describeAudioEngine,
  processesForCapabilities,
  type AudioEngineView,
  type AudioProcessId,
  type InputSupport,
  type ProviderPreset,
  type ProviderSummary,
} from '@songdeck/ai';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { initAi, useAiRuntime } from '../../engine/ai';
import { STRATEGIES } from '../../engine/produce-model';
import { openSettings } from '../settings/nav';
import { Badge, Button } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import './audio.css';

/**
 * AI Audio: one place that explains how Song Deck turns a composition into audio, which engines are
 * connected, what each can make, and exactly which inputs and settings each one receives.
 * Generation itself stays with the song (Sound, Production, Vocals); this area links there.
 */

const AUDIO_CATEGORIES = new Set(['music', 'singing', 'voice-conversion', 'instrument-host', 'managed']);

const SUPPORT_LABEL: Record<InputSupport, { label: string; tone: 'success' | 'warning' | undefined }> = {
  used: { label: 'Sent', tone: 'success' },
  partial: { label: 'Partly', tone: 'warning' },
  ignored: { label: 'Not used', tone: undefined },
};

const LOCATION_LABEL: Record<string, { label: string; tone: 'ai' | 'accent' | 'success' }> = {
  cloud: { label: 'Cloud', tone: 'ai' },
  local: { label: 'This computer', tone: 'accent' },
  internal: { label: 'On-device, built in', tone: 'success' },
};

const PIPELINE: { title: string; text: string; icon: string }[] = [
  {
    title: 'Composition',
    text: 'MIDI tracks, chords, sections, tempo, key and lyrics. Always canonical and editable.',
    icon: 'midi',
  },
  {
    title: 'Guide render',
    text: 'On-device instruments play the composition: a guide mix and one reference stem per instrument group.',
    icon: 'waveform',
  },
  {
    title: 'Audio engine',
    text: 'The chosen engine receives the inputs it supports (below) and produces a mix or stems.',
    icon: 'sparkles',
  },
  {
    title: 'Candidates',
    text: 'Each take keeps its seed, engine, cost and source revision. Compare A/B against the guide.',
    icon: 'produce',
  },
  {
    title: 'Into the song',
    text: 'Adopting a take adds audio tracks beside the MIDI they perform; the MIDI stays editable.',
    icon: 'mixer',
  },
];

function formatValue(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function engineSummaries(providers: ProviderSummary[]): AudioEngineView[] {
  return providers
    .filter((p) => p.enabled)
    .map((p) =>
      describeAudioEngine({
        id: p.id,
        name: p.name,
        adapter: p.adapter as AudioEngineView['adapter'],
        location: p.location,
        capabilities: p.capabilities,
        config: p.config,
      }),
    )
    .filter((v): v is AudioEngineView => !!v)
    .sort((a, b) => Number(a.location === 'internal') - Number(b.location === 'internal'));
}

function ProcessChips({ ids }: { ids: AudioProcessId[] }) {
  return (
    <div className="chip-list">
      {ids.map((id) => {
        const p = AUDIO_PROCESSES.find((x) => x.id === id)!;
        return (
          <span key={id} className="chip" title={p.description}>
            {p.label}
          </span>
        );
      })}
    </div>
  );
}

function InputsTable({ view }: { view: Pick<AudioEngineView, 'inputs' | 'selfDescribing'> }) {
  return (
    <table className="table au-table">
      <thead>
        <tr>
          <th scope="col">Input</th>
          <th scope="col">Status</th>
          <th scope="col">How this engine uses it</th>
        </tr>
      </thead>
      <tbody>
        {view.inputs.map(({ input, use }) => (
          <tr key={input.id} className={use.support === 'ignored' ? 'au-ignored' : ''}>
            <th scope="row" title={input.source}>
              {input.label}
            </th>
            <td>
              <Badge tone={SUPPORT_LABEL[use.support].tone}>{SUPPORT_LABEL[use.support].label}</Badge>
            </td>
            <td className="small">{use.note ?? (use.support === 'used' ? input.source : '')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SettingsTable({ view }: { view: AudioEngineView }) {
  if (!view.settings.length)
    return <p className="small dim">No engine-specific settings: it is configured by Song Deck.</p>;
  return (
    <table className="table au-table">
      <thead>
        <tr>
          <th scope="col">Setting</th>
          <th scope="col">Value</th>
          <th scope="col">What it does</th>
        </tr>
      </thead>
      <tbody>
        {view.settings.map((s) => {
          const value = formatValue(s.value);
          const fallback = formatValue(s.defaultValue);
          return (
            <tr key={s.key}>
              <th scope="row">{s.label}</th>
              <td className="mono small">
                {value ||
                  (fallback ? (
                    <span className="dim">{fallback} (default)</span>
                  ) : (
                    <span className="dim">not set</span>
                  ))}
              </td>
              <td className="small">
                {s.description}
                {s.options?.length ? <span className="dim"> Choices: {s.options.join(', ')}.</span> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EngineCard({
  view,
  provider,
  open,
}: {
  view: AudioEngineView;
  provider?: ProviderSummary;
  open: boolean;
}) {
  const loc = LOCATION_LABEL[view.location] ?? LOCATION_LABEL.cloud;
  const used = view.inputs.filter((i) => i.use.support !== 'ignored').length;
  const status = provider?.status ?? 'ready';
  const model = provider?.config?.defaultModel ?? provider?.models[0]?.id;
  return (
    <article className="panel au-engine" aria-labelledby={`au-engine-${view.id}`}>
      <div className="panel-header">
        <span
          className={`status-dot ${status === 'ready' ? 'ok' : status === 'error' ? 'err' : 'warn'}`}
          title={provider?.error ?? status}
        />
        <h3 className="grow" id={`au-engine-${view.id}`}>
          {view.name}
        </h3>
        <Badge tone={loc.tone}>{loc.label}</Badge>
        {view.location !== 'internal' && (
          <Button size="sm" icon="settings" onClick={() => openSettings('providers', view.id)}>
            Change settings
          </Button>
        )}
      </div>
      <div className="panel-body au-engine-body">
        <p className="au-summary">{view.summary}</p>
        {provider?.error && <div className="callout danger small">{provider.error}</div>}
        <div className="au-facts small">
          {model && (
            <span>
              Model <strong className="mono">{model}</strong>
            </span>
          )}
          <span>
            Output <strong>{view.output}</strong>
          </span>
          {view.limits.map((l) => (
            <span key={l} className="dim">
              {l}
            </span>
          ))}
        </div>
        <ProcessChips ids={view.processes} />
        <details className="au-details" open={open}>
          <summary>
            Inputs — {used} of {view.inputs.length} used
            {view.selfDescribing ? ' (from what the engine reports)' : ''}
          </summary>
          <InputsTable view={view} />
        </details>
        <details className="au-details" open={open}>
          <summary>Settings — {view.settings.length || 'none'}</summary>
          <SettingsTable view={view} />
        </details>
      </div>
    </article>
  );
}

function PresetRow({ preset }: { preset: ProviderPreset }) {
  const [open, setOpen] = useState(false);
  const view = useMemo(
    () =>
      describeAudioEngine({
        id: preset.id,
        name: preset.name,
        adapter: preset.adapter,
        location: preset.location,
        capabilities: preset.capabilities,
      }),
    [preset],
  );
  if (!view) return null;
  const profile = audioEngineProfile(preset.adapter);
  return (
    <li className="au-preset">
      <div className="row au-preset-head">
        <div className="grow">
          <strong>{preset.name}</strong>{' '}
          <Badge tone={LOCATION_LABEL[preset.location].tone}>{LOCATION_LABEL[preset.location].label}</Badge>
          <div className="small dim">
            {profile && !profile.selfDescribing ? profile.summary : preset.description}
          </div>
        </div>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide inputs' : 'Inputs'}
        </Button>
        <Button
          size="sm"
          icon="plug"
          onClick={() =>
            openSettings('providers', `${preset.requiresCredential ? 'connect' : 'add'}:${preset.id}`)
          }
        >
          Connect
        </Button>
      </div>
      <ProcessChips ids={view.processes} />
      {open && <InputsTable view={view} />}
    </li>
  );
}

export default function AudioMode() {
  const providers = useAiRuntime((s) => s.providers);
  const configured = useSettings((s) => s.providers);
  const project = useStudio((s) => s.project);
  const setMode = useStudio((s) => s.setMode);
  useEffect(() => initAi(), []);

  const engines = useMemo(() => engineSummaries(providers), [providers]);
  const byId = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);
  const connectable = useMemo(() => {
    const used = new Set(configured.map((c) => c.presetId ?? c.id));
    return PROVIDER_PRESETS.filter((p) => AUDIO_CATEGORIES.has(p.category) && !used.has(p.id));
  }, [configured]);
  const offering = (id: AudioProcessId) => engines.filter((e) => e.processes.includes(id));
  const suggest = (id: AudioProcessId) =>
    connectable.filter((p) => processesForCapabilities(p.capabilities).includes(id)).slice(0, 3);
  const external = engines.filter((e) => e.location !== 'internal');

  return (
    <div className="area-page audio-page">
      <header className="page-band measure-grid">
        <span className="eyebrow-rule">AI Audio</span>
        <h1>How your songs become audio</h1>
        <p className="lede">
          Song Deck writes the composition first, then asks an audio engine to perform it. This page shows the
          whole pipeline, every engine you have connected, what each one can make, and exactly which inputs
          and settings it receives.
        </p>
        <div className="row">
          {project ? (
            <>
              <Button variant="primary" icon="sparkles" onClick={() => setMode('sound')}>
                Make an audio version of “{project.meta.name}”
              </Button>
              <Button icon="layers" onClick={() => setMode('produce')}>
                Open Production
              </Button>
            </>
          ) : (
            <Button variant="primary" icon="music" onClick={() => setMode('home')}>
              Open or start a song
            </Button>
          )}
          <Button icon="plug" onClick={() => openSettings('providers', 'add')}>
            Connect an audio engine
          </Button>
        </div>
      </header>

      <div className="area-body au-body">
        <section aria-labelledby="au-pipeline">
          <h2 id="au-pipeline" className="section-title">
            The pipeline
          </h2>
          <ol className="au-pipeline">
            {PIPELINE.map((s, i) => (
              <li key={s.title} className="card">
                <span className="au-step-num mono">{String(i + 1).padStart(2, '0')}</span>
                <Icon name={s.icon} size={18} />
                <strong>{s.title}</strong>
                <span className="small dim">{s.text}</span>
              </li>
            ))}
          </ol>
          <div className="grid-3 au-strategies">
            {STRATEGIES.map((s) => (
              <div key={s.id} className="card">
                <strong>
                  {s.letter} — {s.title}
                </strong>
                <div className="small mono dim au-flow">{s.flow}</div>
                <div className="small">{s.description}</div>
              </div>
            ))}
          </div>
          <p className="small dim">
            Where to use it: <strong>Sound → Make an audio version</strong> (one click, Auto picks an engine),{' '}
            <strong>Start a song → Also make an audio version</strong>, or{' '}
            <strong>More tools → Production</strong> for the strategy, engine, model, strength, reference
            audio, candidates and region regeneration. Cloud engines ask before anything leaves this device
            and stop at your spending limits.
          </p>
        </section>

        <section aria-labelledby="au-make">
          <h2 id="au-make" className="section-title">
            What you can make now
          </h2>
          <div className="au-processes">
            {AUDIO_PROCESSES.map((p) => {
              const by = offering(p.id);
              const hints = by.length ? [] : suggest(p.id);
              return (
                <div key={p.id} className={`card au-process ${by.length ? '' : 'au-unavailable'}`}>
                  <div className="row">
                    <Icon name={by.length ? 'check' : 'minus'} size={14} />
                    <strong className="grow">{p.label}</strong>
                  </div>
                  <div className="small">{p.description}</div>
                  <div className="small dim">Used in: {p.usedIn}</div>
                  <div className="small">
                    {by.length ? (
                      <>
                        By: <strong>{by.map((e) => e.name).join(', ')}</strong>
                      </>
                    ) : hints.length ? (
                      <>Not connected. Engines that can: {hints.map((h) => h.name).join(', ')}.</>
                    ) : (
                      <>Not connected.</>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="au-engines">
          <h2 id="au-engines" className="section-title">
            Connected audio engines ({engines.length})
          </h2>
          {!external.length && (
            <div className="callout small au-callout">
              Only the built-in engines are available, so audio versions are rendered from your MIDI on this
              device. Connect a music model below (cloud with an API key, or a local bridge) to produce
              performed, sung audio.
            </div>
          )}
          {engines.map((e) => (
            <EngineCard key={e.id} view={e} provider={byId.get(e.id)} open={engines.length <= 3} />
          ))}
        </section>

        <section aria-labelledby="au-inputs">
          <h2 id="au-inputs" className="section-title">
            Inputs Song Deck can send
          </h2>
          <table className="table au-table">
            <thead>
              <tr>
                <th scope="col">Input</th>
                <th scope="col">Comes from</th>
                <th scope="col">Leaves the device as</th>
              </tr>
            </thead>
            <tbody>
              {AUDIO_INPUTS.map((i) => (
                <tr key={i.id}>
                  <th scope="row">{i.label}</th>
                  <td className="small">{i.source}</td>
                  <td className="small dim">
                    {i.dataKind ? i.dataKind.replace(/-/g, ' ') : 'a setting (no project data)'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small dim">
            Choose what may never be uploaded in Settings → Privacy and spending; an engine that needs a
            blocked input is skipped by Auto.
          </p>
        </section>

        {connectable.length > 0 && (
          <section aria-labelledby="au-connect">
            <h2 id="au-connect" className="section-title">
              Engines you can connect
            </h2>
            <ul className="au-presets">
              {connectable.map((p) => (
                <PresetRow key={p.id} preset={p} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
