import { useEffect, useMemo } from 'react';
import { keyAtTick, keyName, meterAtBar, songDurationSeconds, type Song } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { initAi } from '../../engine/ai';
import {
  GUIDE_RENDERERS,
  audibleSourceTracks,
  compositionHash,
  headRevisionOf,
  productionSourceSong,
  strategyInfo,
} from '../../engine/produce-model';
import { Badge, Button, EmptyState, Tabs } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { GuidePanel, guideView } from './GuidePanel';
import { ProductionPanel, useProductionResolution } from './ProductionPanel';
import { CandidatesPanel } from './CandidatesPanel';
import { RegionPanel } from './RegionPanel';
import { ProductionQueue, SourceTone, money, mmss } from './widgets';
import { adoptedCandidateId } from './adopt';
import { comparePlayer } from './comparePlayer';
import { useProduceUi, type ProduceTab } from './state';
import './produce.css';

/**
 * Produce mode — Phase 3 production (spec §28-§31, §38, §39, §54, §60, §64, §68).
 *
 * "Perform and produce this composition." The composition stays canonical: guide renders,
 * candidates and regenerated regions are renderings of a specific revision, each with provenance,
 * and adopting a production only adds audio tracks next to the MIDI it performs.
 */

function SummaryRail({ song }: { song: Song }) {
  const project = useStudio((s) => s.project)!;
  const set = useProduceUi((s) => s.set);
  const budget = useSettings((s) => s.budget);
  const source = useMemo(() => productionSourceSong(song), [song]);
  const head = headRevisionOf(project);
  const guide = guideView(project, song);
  const r = useProductionResolution(song);
  const info = strategyInfo(song.production.strategy);
  const selected = song.production.candidates.find((c) => c.id === song.production.selectedCandidateId);
  const adopted = song.production.candidates.find((c) => c.id === adoptedCandidateId(song));
  const total = song.production.candidates.reduce((n, c) => n + (c.costUsd ?? 0), 0);
  const meter = meterAtBar(source, 0);
  const hash = useMemo(() => compositionHash(song), [song]);
  return (
    <aside className="pd-rail" aria-label="Production summary">
      <div className="pd-rail-card">
        <h4>Composition</h4>
        <div className="pd-rail-title ellipsis" title={song.title}>
          {song.title}
        </div>
        <div className="pd-kv small">
          <span>Revision</span>
          <strong>v{head?.number ?? '?'}</strong>
        </div>
        <div className="pd-kv small">
          <span>Form</span>
          <span>
            {audibleSourceTracks(source).length} tracks · {source.sections.length} sections ·{' '}
            {mmss(songDurationSeconds(source))}
          </span>
        </div>
        <div className="pd-kv small">
          <span>Feel</span>
          <span>
            {Math.round(source.tempoMap[0]?.bpm ?? 120)} BPM · {keyName(keyAtTick(source, 0))} ·{' '}
            {meter.numerator}/{meter.denominator}
          </span>
        </div>
        <div
          className="pd-kv small"
          title="Productions made from the same composition share this fingerprint"
        >
          <span>Fingerprint</span>
          <span className="mono dim">{hash}</span>
        </div>
      </div>
      <div className="pd-rail-card">
        <h4>Pipeline</h4>
        <button
          type="button"
          className={`pd-step ${guide.mix ? (guide.stale ? 'warn' : 'done') : ''}`}
          onClick={() => set({ tab: 'guide' })}
        >
          <Icon name={guide.mix && !guide.stale ? 'check' : guide.stale ? 'alert' : 'waveform'} size={14} />
          <span className="grow">Guide render</span>
          <span className="small dim">
            {guide.mix
              ? guide.stale
                ? 'out of date'
                : GUIDE_RENDERERS[guide.renderer ?? 'builtin']?.label.split(' ')[0]
              : 'not yet'}
          </span>
        </button>
        <button type="button" className="pd-step done" onClick={() => set({ tab: 'production' })}>
          <Icon name="layers" size={14} />
          <span className="grow">
            {info.letter} — {info.title}
          </span>
          <SourceTone location={r.resolution.provider?.location} />
        </button>
        <button
          type="button"
          className={`pd-step ${song.production.candidates.length ? 'done' : ''}`}
          onClick={() => set({ tab: 'candidates' })}
        >
          <Icon name="produce" size={14} />
          <span className="grow">Candidates</span>
          <span className="small dim">
            {song.production.candidates.length
              ? song.production.candidates
                  .map((c) => c.label)
                  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                  .join(' ')
              : 'none'}
          </span>
        </button>
        <button
          type="button"
          className={`pd-step ${selected ? 'done' : ''}`}
          onClick={() => set({ tab: 'candidates' })}
        >
          <Icon name="check" size={14} />
          <span className="grow">Selected</span>
          <span className="small dim">{selected ? selected.label : '—'}</span>
        </button>
        <button
          type="button"
          className={`pd-step ${adopted ? 'done' : ''}`}
          onClick={() => useStudio.getState().setMode('mix')}
        >
          <Icon name="mixer" size={14} />
          <span className="grow">In Mix &amp; Master</span>
          <span className="small dim">{adopted ? `${adopted.label} stems` : 'MIDI guide'}</span>
        </button>
      </div>
      <div className="pd-rail-card">
        <h4>Production queue</h4>
        <ProductionQueue />
      </div>
      <div className="pd-rail-card">
        <h4>Cost</h4>
        <div className="pd-kv small">
          <span>This song’s productions</span>
          <strong className="mono">{money(total)}</strong>
        </div>
        <div className="pd-kv small">
          <span>Limits</span>
          <span className="mono">
            ${budget.perGenerationUsd}/gen · ${budget.dailyUsd}/day · ${budget.monthlyUsd}/mo
          </span>
        </div>
        <div className="small dim">
          Cloud runs ask before data leaves the device and stop at your budget (Settings).
        </div>
      </div>
    </aside>
  );
}

export default function ProduceMode() {
  const song = useStudio((s) => s.project?.song ?? null);
  const tab = useProduceUi((s) => s.tab);
  const set = useProduceUi((s) => s.set);
  useEffect(() => {
    initAi();
    return () => comparePlayer.stop();
  }, []);

  if (!song) return null;
  if (!song.tracks.length) {
    return (
      <EmptyState
        icon="produce"
        title="Nothing to produce yet"
        actions={
          <Button variant="primary" icon="sparkles" onClick={() => useStudio.getState().setMode('compose')}>
            Compose
          </Button>
        }
      >
        Production performs a composition: compose a song (or rebuild one from a recording) first.
      </EmptyState>
    );
  }
  const count = song.production.candidates.length;
  const tabs: { value: ProduceTab; label: string; icon: string }[] = [
    { value: 'guide', label: '1 · Guide render', icon: 'waveform' },
    { value: 'production', label: '2 · Production', icon: 'layers' },
    { value: 'candidates', label: `3 · Candidates${count ? ` (${count})` : ''}`, icon: 'produce' },
    { value: 'regenerate', label: '4 · Regenerate region', icon: 'scissors' },
  ];
  return (
    <div className="pd-page">
      <div className="pd-main">
        <div className="page-header">
          <div className="grow">
            <h1>Produce</h1>
            <div className="lede">
              <strong>Perform and produce this composition</strong> — not “invent a song resembling this
              prompt”. Render a guide, choose a strategy and provider, generate A/B candidates of the
              identical composition, keep the best, and regenerate just the bars you want.
            </div>
          </div>
          <div className="row">
            <Badge tone="ai">
              <Icon name="shield" size={11} /> composition is canonical
            </Badge>
          </div>
        </div>
        <div className="pd-tabbar">
          <Tabs
            value={tab}
            onChange={(v) => set({ tab: v })}
            tabs={tabs.map((t) => ({ value: t.value, label: t.label, icon: t.icon }))}
          />
        </div>
        {tab === 'guide' && <GuidePanel song={song} />}
        {tab === 'production' && <ProductionPanel song={song} />}
        {tab === 'candidates' && <CandidatesPanel song={song} />}
        {tab === 'regenerate' && <RegionPanel song={song} />}
      </div>
      <SummaryRail song={song} />
    </div>
  );
}
