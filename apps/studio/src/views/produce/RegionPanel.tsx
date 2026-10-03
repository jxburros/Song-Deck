import { useEffect, useMemo } from 'react';
import { randomId, randomSeed, sectionLayout, songLengthBars, tickToBar, type Song } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { useAiRuntime } from '../../engine/ai';
import { isTaskActive, startTask, useTaskRecord } from '../../engine/mix-tasks';
import { INTERNAL_FOR_ROLE } from '../../engine/internalDescriptors';
import { candidateSourceSong, hasSungVocals, isVocalTrack, methodFor, nextVersionLabel, productionSourceSong, regionLabel, regionSpan, strategyInfo, type ProductionUnit } from '../../engine/produce-model';
import { resolveProduction } from '../../engine/produce-providers';
import { provenanceOfAsset } from '../../engine/produce-assets';
import { useSampleInstruments } from '../../engine/produce-samples';
import type { RegionInput, RegionOutput } from '../../engine/handlers/production';
import { Badge, Button, Field, NumberInput, Select, Slider, TextInput } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ProviderPicker } from '../shared/ProviderPicker';
import { CompareDeck, TaskLine, type DeckSource } from './widgets';
import { sectionMarkers } from './GuidePanel';
import { useProduceUi } from './state';

/**
 * Selective regeneration (spec §39 "Regenerate bars 33–41"): provider inpainting when supported,
 * otherwise Song Deck re-produces only that region and splices it into the candidate with
 * crossfades. Everything outside the region is preserved sample for sample; the result is a new
 * candidate version (B → B2) with its own provenance.
 */

export function RegionPanel({ song }: { song: Song }) {
  const project = useStudio((s) => s.project)!;
  const ui = useProduceUi();
  const loop = useStudio((s) => s.transport.loop);
  const version = useAiRuntime((s) => s.version);
  const routing = useSettings((s) => s.routing);
  const samples = useSampleInstruments((s) => s.assignments);
  const candidates = song.production.candidates.filter((c) => c.mixAssetId);
  const parent = candidates.find((c) => c.id === ui.regionCandidateId) ?? candidates.find((c) => c.id === song.production.selectedCandidateId) ?? candidates[candidates.length - 1];
  const task = useTaskRecord(ui.regionTaskId);
  const busy = isTaskActive(task);

  const source = useMemo(() => (parent ? productionSourceSong(candidateSourceSong(project, parent)) : productionSourceSong(song)), [parent, project, song]);
  const totalBars = Math.max(1, songLengthBars(source));
  const region = regionSpan(source, ui.startBar, ui.endBar);
  const markers = useMemo(() => sectionMarkers(source), [source]);
  const sections = useMemo(() => sectionLayout(source), [source]);

  useEffect(() => {
    if (ui.endBar > totalBars || ui.startBar > totalBars) ui.set({ startBar: Math.min(ui.startBar, totalBars), endBar: Math.min(Math.max(ui.endBar, ui.startBar), totalBars) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalBars]);

  const stems = parent ? Object.keys(parent.stemAssetIds) : [];
  const methods = ((parent ? provenanceOfAsset(project, parent.mixAssetId)?.parameters : undefined) as { methods?: Record<string, string> } | undefined)?.methods ?? {};
  const scopeOptions = [
    { value: 'all', label: stems.length ? 'Complete arrangement region (all stems)' : 'Complete mix region' },
    ...stems.map((id) => {
      const t = source.tracks.find((x) => x.id === id);
      const m = methods[id];
      return { value: id, label: `One stem: ${t?.name ?? id}${m ? ` (${m})` : ''}`, disabled: m === 'recorded' || m === 'external' };
    }),
  ];
  const scope = scopeOptions.some((o) => o.value === ui.regionScope) ? ui.regionScope : 'all';
  const defaultChoice = parent ? (parent.providerId === INTERNAL_FOR_ROLE.production ? 'internal' : parent.providerId.startsWith('song-deck') || parent.providerId === 'external-daw' ? 'internal' : parent.providerId) : 'internal';
  const choice = ui.regionChoice ?? defaultChoice;

  const resolution = useMemo(() => {
    if (!parent) return null;
    const targets = stems.length ? (scope === 'all' ? stems : [scope]) : [];
    const tracks = targets.map((id) => source.tracks.find((t) => t.id === id)).filter((t): t is ProductionUnit['track'] => !!t);
    const aiUnits = stems.length ? tracks.filter((t) => (methods[t.id] ?? methodFor(t, parent.strategy, song.production.trackMethods)) === 'ai').length : 1;
    return resolveProduction(choice, undefined, parent.strategy, { vocals: hasSungVocals(source), reference: false, aiUnits, aiVocalUnits: tracks.filter((t) => isVocalTrack(t) && methods[t.id] === 'ai').length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parent, choice, scope, version, routing, source]);

  if (!parent) {
    return (
      <div className="panel">
        <div className="panel-body pd-empty">
          <Icon name="scissors" size={26} />
          <div>
            <strong>Nothing to regenerate yet.</strong> Produce a candidate first; then regenerate any bar range of it without touching the rest.
          </div>
        </div>
      </div>
    );
  }

  const what = regionLabel(region);
  const inpaint = resolution?.plan.region === 'inpaint' && !resolution.error;
  const versions = candidates.filter((c) => c.id === parent.id || (provenanceOfAsset(project, c.mixAssetId)?.parameters as { parentCandidateId?: string } | undefined)?.parentCandidateId === parent.id);
  const deck: DeckSource[] = versions.map((c) => ({ key: `cand:${c.id}`, label: c.label, sub: c.id === parent.id ? 'original' : 'regenerated', assetId: c.mixAssetId!, tone: c.id === parent.id ? 'guide' : 'candidate', lufs: (provenanceOfAsset(project, c.mixAssetId)?.parameters as { integratedLufs?: number } | undefined)?.integratedLufs }));
  const needsProvider = !stems.length || (scope === 'all' ? stems : [scope]).some((id) => (methods[id] ?? 'ai') === 'ai');
  const blocked = busy || (needsProvider && (!resolution?.plan.plan || (!!resolution?.error && choice !== 'auto')));

  const run = () => {
    const input: RegionInput = {
      projectId: project.meta.id,
      candidateId: parent.id,
      startBar: region.startBar,
      endBar: region.endBar,
      scope,
      providerChoice: choice,
      singingChoice: ui.singingChoice,
      seed: ui.regionSeed,
      variation: ui.variation,
      strength: ui.strength,
      levelMatch: ui.levelMatch,
      crossfadeMs: ui.crossfadeMs,
      prompt: ui.regionPrompt.trim() || undefined,
      batchId: randomId('batch'),
      sampleAssignments: samples,
    };
    const t = startTask<RegionInput, RegionOutput>('produce.region', `Regenerate ${what} of ${parent.label}`, input, { providerId: resolution?.provider?.id });
    ui.set({ regionTaskId: t.id, regionSeed: randomSeed() });
  };

  return (
    <div className="pd-grid">
      <div className="panel">
        <div className="panel-header">
          <Icon name="scissors" />
          <h3 className="grow">Regenerate a region</h3>
          <span className="small dim">spec §39 — everything outside the region is preserved</span>
        </div>
        <div className="panel-body col">
          <div className="pd-settings">
            <Field label="Candidate">
              <Select
                value={parent.id}
                onChange={(v) => ui.set({ regionCandidateId: v, regionScope: 'all', regionChoice: null })}
                options={candidates.map((c) => ({ value: c.id, label: `${c.label} — ${strategyInfo(c.strategy).title}${Object.keys(c.stemAssetIds).length ? ` · ${Object.keys(c.stemAssetIds).length} stems` : ' · mix'}` }))}
                aria-label="Candidate to regenerate"
              />
            </Field>
            <Field label="From bar" hint={`1 – ${totalBars}`}>
              <NumberInput value={ui.startBar} min={1} max={totalBars} onChange={(v) => ui.set({ startBar: Math.round(v), endBar: Math.max(Math.round(v), ui.endBar) })} aria-label="From bar" />
            </Field>
            <Field label="To bar" hint="inclusive">
              <NumberInput value={ui.endBar} min={1} max={totalBars} onChange={(v) => ui.set({ endBar: Math.round(v), startBar: Math.min(ui.startBar, Math.round(v)) })} aria-label="To bar" />
            </Field>
            <Field label="Scope" hint="spec §39 levels: complete arrangement region, one instrument / stem">
              <Select value={scope} onChange={(v) => ui.set({ regionScope: v })} options={scopeOptions} aria-label="Regeneration scope" />
            </Field>
          </div>
          <div className="chip-list" aria-label="Sections">
            {sections.map((s) => {
              const on = region.startBar === s.startBar + 1 && region.endBar === s.endBar;
              return (
                <button key={s.section.id} type="button" className={`chip ${on ? 'on' : ''}`} onClick={() => ui.set({ startBar: s.startBar + 1, endBar: s.endBar })} title={`Bars ${s.startBar + 1}–${s.endBar}`}>
                  {s.section.name} <span className="dim">{s.startBar + 1}–{s.endBar}</span>
                </button>
              );
            })}
            {loop.enabled && loop.endTick > loop.startTick && (
              <button
                type="button"
                className="chip"
                onClick={() => {
                  const from = tickToBar(source, loop.startTick).bar + 1;
                  const to = tickToBar(source, Math.max(loop.startTick, loop.endTick - 1)).bar + 1;
                  ui.set({ startBar: Math.min(from, totalBars), endBar: Math.min(Math.max(from, to), totalBars) });
                }}
                title="Use the transport loop range"
              >
                <Icon name="loop" size={12} /> Loop region
              </button>
            )}
          </div>
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <Field label="Provider for the region">
              <ProviderPicker role="production" value={choice} onChange={(v) => ui.set({ regionChoice: v })} />
            </Field>
            <Field label="Seed">
              <div className="row">
                <NumberInput value={ui.regionSeed} min={0} max={99999999} onChange={(v) => ui.set({ regionSeed: Math.round(v) })} aria-label="Region seed" />
                <Button icon="dice" aria-label="New region seed" onClick={() => ui.set({ regionSeed: randomSeed() })} />
              </div>
            </Field>
            <div style={{ width: 220 }}>
              <Slider label="Crossfade" value={ui.crossfadeMs} min={5} max={200} step={5} onChange={(v) => ui.set({ crossfadeMs: v })} format={(v) => `${Math.round(v)} ms`} />
            </div>
            <Field label="Instructions for this region (optional)">
              <TextInput value={ui.regionPrompt} onChange={(v) => ui.set({ regionPrompt: v })} placeholder="more aggressive drum fill, half-time feel" aria-label="Region instructions" />
            </Field>
          </div>
          <div className={`callout small ${inpaint ? 'success' : ''}`} data-testid="region-method">
            {inpaint ? (
              <>
                <strong>Inpainting</strong> — {resolution?.provider?.name} regenerates only {what} inside the existing audio; the result is spliced back so nothing outside the region changes.
              </>
            ) : (
              <>
                <strong>Re-produce the region</strong> — {resolution?.provider?.name ?? 'the provider'} has no inpainting, so Song Deck renders just {what} (with a bar of context),{' '}
                {resolution?.plan.plan?.op === 'render-song' ? 're-performs it on-device' : 'transforms it'}, level-matches it and splices it in with {Math.round(ui.crossfadeMs)} ms crossfades. Everything outside the region is
                preserved sample for sample.
              </>
            )}
          </div>
          {resolution?.error && choice !== 'auto' && <div className="callout danger small">{resolution.error}</div>}
          <div className="row wrap">
            <Button variant="primary" size="lg" icon="rebuild" disabled={blocked} onClick={run} data-testid="regenerate-region">
              Regenerate {what}
            </Button>
            <span className="small dim">
              of {parent.label} → new version <strong>{nextVersionLabel(song.production.candidates, parent.label)}</strong> · {region.startSeconds.toFixed(1)}–{region.endSeconds.toFixed(1)} s
            </span>
          </div>
          <TaskLine
            id={ui.regionTaskId}
            onDone={(t) => {
              const r = t.result as RegionOutput | undefined;
              if (r) {
                useStudio.getState().toast('success', r.summary);
                ui.set({ compareActive: `cand:${r.candidateId}` });
              }
            }}
          />
        </div>
      </div>
      <div className="panel">
        <div className="panel-header">
          <Icon name="waveform" />
          <h3 className="grow">
            {parent.label} {versions.length > 1 ? `and its versions` : ''}
          </h3>
          <Badge tone="ai">{what}</Badge>
        </div>
        <div className="panel-body">
          <CompareDeck owner={`region:${parent.id}`} sources={deck} markers={markers} region={{ start: region.startSeconds, end: region.endSeconds }} hint="The shaded region is what changes; compare the original and its regenerated versions at the same position." />
        </div>
      </div>
    </div>
  );
}
