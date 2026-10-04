import { useMemo, useState } from 'react';
import { removeAsset, type ProductionCandidate, type ProvenanceRecord, type Song } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { assetStore } from '../../state/assets';
import { deliverFile, MIME } from '../../engine/export-files';
import {
  GUIDE_MIX_FILE,
  METHOD_INFO,
  candidateSourceSong,
  compositionHash,
  productionSourceSong,
  strategyInfo,
  type ProducedTrackParams,
} from '../../engine/produce-model';
import { describeProvider } from '../../engine/produce-providers';
import { provenanceOfAsset, revisionNumber } from '../../engine/produce-assets';
import { Badge, Button, CommitText } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { CompareDeck, SourceTone, Stars, money, mmss, relTime, type DeckSource } from './widgets';
import { adoptCandidate, adoptedCandidateId, provideProducedAudio, removeProducedAudio } from './adopt';
import { guideView, sectionMarkers } from './GuidePanel';
import { updateProduction } from './ProductionPanel';
import { useProduceUi } from './state';
import { comparePlayer } from './comparePlayer';

/**
 * A/B rendering (spec §54): candidates A, B, C… of the identical composition, compared instantly
 * at the same playback position; rated, annotated, selected and adopted into the mix.
 */

const STRATEGY_SHORT: Record<ProductionCandidate['strategy'], string> = {
  full: 'Full mix',
  stems: 'Stems',
  hybrid: 'Hybrid',
};

interface CandidateMeta {
  prov?: ProvenanceRecord;
  lufs?: number;
  composition?: string;
  parentLabel?: string;
  region?: { startBar: number; endBar: number };
  methods: Record<string, string>;
  providerName: string;
  location?: string;
}

function candidateMeta(
  project: NonNullable<ReturnType<typeof useStudio.getState>['project']>,
  c: ProductionCandidate,
): CandidateMeta {
  const prov = provenanceOfAsset(project, c.mixAssetId);
  const params = (prov?.parameters ?? {}) as {
    integratedLufs?: number;
    compositionHash?: string;
    parentLabel?: string;
    region?: { startBar: number; endBar: number };
    methods?: Record<string, string>;
  };
  const d = describeProvider(c.providerId);
  return {
    prov,
    lufs: params.integratedLufs,
    composition: params.compositionHash,
    parentLabel: params.parentLabel,
    region: params.region,
    methods: params.methods ?? {},
    providerName: prov?.providerName ?? d?.name ?? c.providerId,
    location: d?.location ?? (prov?.cloud ? 'cloud' : undefined),
  };
}

function ProvenanceDetails({ c, m, song }: { c: ProductionCandidate; m: CandidateMeta; song: Song }) {
  const project = useStudio((s) => s.project)!;
  const params = (m.prov?.parameters ?? {}) as Record<string, unknown>;
  const stems = Object.entries(c.stemAssetIds);
  return (
    <div className="pd-details" aria-label={`Provenance of candidate ${c.label}`}>
      <dl className="kv">
        <dt>Artifact</dt>
        <dd className="mono">{m.prov?.artifactName ?? '—'}</dd>
        <dt>Provider</dt>
        <dd>
          {m.providerName}
          {c.modelId ? ` · ${c.modelId}` : ''} {m.prov?.cloud ? '(cloud)' : '(stayed on this device)'}
        </dd>
        <dt>Seed</dt>
        <dd className="mono">{c.seed}</dd>
        <dt>Source</dt>
        <dd>
          {(m.prov?.sources ?? [])
            .map((s) => {
              if (s.kind === 'song') return `song v${s.revision ?? '?'}`;
              const a = project.meta.assets.find((x) => x.id === s.ref);
              return a ? a.name : `${s.kind}: ${s.ref}`;
            })
            .slice(0, 6)
            .join(' · ')}
          {(m.prov?.sources.length ?? 0) > 6 ? ` · +${(m.prov?.sources.length ?? 0) - 6} more` : ''}
        </dd>
        {typeof params.prompt === 'string' && (
          <>
            <dt>Prompt</dt>
            <dd className="small mono">{params.prompt as string}</dd>
          </>
        )}
        {m.region && (
          <>
            <dt>Regenerated</dt>
            <dd>
              bars {m.region.startBar}–{m.region.endBar} of {m.parentLabel} ({String(params.mode ?? '')})
            </dd>
          </>
        )}
        <dt>Generated</dt>
        <dd>{m.prov ? new Date(m.prov.generatedAt).toLocaleString() : '—'}</dd>
        <dt>Cost</dt>
        <dd className="mono">{money(c.costUsd ?? 0)}</dd>
      </dl>
      {stems.length > 0 && (
        <table className="table" aria-label={`Stems of candidate ${c.label}`}>
          <thead>
            <tr>
              <th>Stem</th>
              <th>Method</th>
              <th>Produced by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {stems.map(([tid, aid]) => {
              const t = song.tracks.find((x) => x.id === tid);
              const sp = provenanceOfAsset(project, aid);
              const a = project.meta.assets.find((x) => x.id === aid);
              const method = m.methods[tid] as keyof typeof METHOD_INFO | undefined;
              return (
                <tr key={tid}>
                  <td>
                    <span className="pd-dot" style={{ background: t?.color }} /> {t?.name ?? tid}
                  </td>
                  <td className="small">{method ? (METHOD_INFO[method]?.label ?? method) : '—'}</td>
                  <td className="small muted">
                    {sp?.providerName ?? '—'}
                    {sp?.costUsd ? ` · ${money(sp.costUsd)}` : ''}
                  </td>
                  <td className="num">
                    {a && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="download"
                        aria-label={`Download ${a.name}`}
                        onClick={() =>
                          void assetStore
                            .bytes(a)
                            .then(
                              (b) =>
                                b &&
                                deliverFile(a.name, b, MIME.wav, { detail: `Stem of candidate ${c.label}` }),
                            )
                        }
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CandidateCard({
  c,
  m,
  song,
  currentHash,
  adopted,
  onListen,
}: {
  c: ProductionCandidate;
  m: CandidateMeta;
  song: Song;
  currentHash: string;
  adopted: boolean;
  onListen: () => void;
}) {
  const project = useStudio((s) => s.project)!;
  const [open, setOpen] = useState(false);
  const [showStems, setShowStems] = useState(false);
  const selected = song.production.selectedCandidateId === c.id;
  const info = strategyInfo(c.strategy);
  const mix = project.meta.assets.find((a) => a.id === c.mixAssetId);
  const rev = revisionNumber(project, c.sourceRevisionId);
  const changed = m.composition ? m.composition !== currentHash : false;
  const stems = Object.entries(c.stemAssetIds);
  const midiStems = stems.filter(([tid]) => song.tracks.find((t) => t.id === tid)?.kind === 'midi');
  const set = (patch: Partial<ProductionCandidate>, message: string) =>
    updateProduction(
      (p) => ({ ...p, candidates: p.candidates.map((x) => (x.id === c.id ? { ...x, ...patch } : x)) }),
      message,
    );

  const adopt = () => {
    const st = useStudio.getState();
    const cur = st.project!;
    try {
      const r = adoptCandidate(cur.song, c, cur.meta.assets);
      st.commit(
        r.song,
        r.kind === 'stems'
          ? `Using produced stems of candidate ${c.label} in the mix (${r.added + r.updated} audio tracks; source MIDI muted)`
          : `Using produced mix of candidate ${c.label} in the mix`,
        'production',
      );
      void provideProducedAudio(r.song);
      st.toast(
        'success',
        `${r.kind === 'stems' ? `${r.added + r.updated} produced stems` : 'The produced mix'} of ${c.label} ${r.kind === 'stems' ? 'are' : 'is'} now in Mix & Master (${r.added} added, ${r.updated} updated). The MIDI tracks stay, muted.`,
      );
    } catch (err) {
      st.toast('error', err instanceof Error ? err.message : String(err));
    }
  };

  const discard = async () => {
    const st = useStudio.getState();
    if (adopted) {
      st.toast(
        'warning',
        `Candidate ${c.label} is playing in the mix — remove the produced audio from the mix first.`,
      );
      return;
    }
    const ok = await st.requestConfirm({
      kind: 'generic',
      title: `Discard candidate ${c.label}?`,
      body: {
        message:
          'Its audio files are deleted from the project (stems shared with other candidates are kept). Earlier revisions keep their record of it.',
        confirmLabel: 'Discard',
      },
    });
    if (!ok) return;
    const cur = st.project!;
    const others = cur.song.production.candidates.filter((x) => x.id !== c.id);
    const keep = new Set<string>();
    for (const o of others) {
      if (o.mixAssetId) keep.add(o.mixAssetId);
      for (const a of Object.values(o.stemAssetIds)) keep.add(a);
    }
    for (const t of cur.song.tracks) for (const cl of t.clips) keep.add(cl.assetId);
    const drop = [c.mixAssetId, ...Object.values(c.stemAssetIds)].filter(
      (x): x is string => !!x && !keep.has(x),
    );
    st.commit(
      {
        ...cur.song,
        production: {
          ...cur.song.production,
          candidates: others,
          selectedCandidateId:
            cur.song.production.selectedCandidateId === c.id
              ? undefined
              : cur.song.production.selectedCandidateId,
        },
      },
      `Discarded production candidate ${c.label}`,
      'production',
    );
    for (const id of drop) await assetStore.remove(id);
    st.updateProject((p) => drop.reduce((acc, id) => removeAsset(acc, id), p));
  };

  return (
    <div
      className={`pd-cand ${selected ? 'selected' : ''}`}
      data-testid={`candidate-${c.label}`}
      aria-label={`Candidate ${c.label}`}
    >
      <div className="pd-cand-head">
        <span className="pd-cand-letter">{c.label}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <Badge tone="accent" title={info.flow}>
              Strategy {info.letter} · {info.title}
            </Badge>
            <SourceTone location={m.location} />
            {selected && <Badge tone="success">Selected</Badge>}
            {adopted && <Badge tone="ai">In the mix</Badge>}
          </div>
          <div className="small muted ellipsis" title={m.providerName}>
            {m.providerName}
            {c.modelId ? ` · ${c.modelId}` : ''}
          </div>
        </div>
        <div className="pd-cand-cost mono" title="Cost of this candidate (spec §60)">
          {money(c.costUsd ?? 0)}
        </div>
      </div>
      <div className="pd-cand-facts small">
        <span title="Seed (spec §23)">
          <Icon name="dice" size={12} /> {c.seed}
        </span>
        <span>{mix ? mmss(mix.durationSeconds) : '—'}</span>
        {m.lufs !== undefined && <span className="mono">{m.lufs.toFixed(1)} LUFS</span>}
        <span>{stems.length ? `${stems.length} stems` : 'full mix'}</span>
        <span title={new Date(c.createdAt).toLocaleString()}>{relTime(c.createdAt)}</span>
      </div>
      {m.parentLabel && m.region && (
        <div className="small pd-lineage pd-line">
          <Icon name="branch" size={12} /> from {m.parentLabel} · bars {m.region.startBar}–{m.region.endBar}{' '}
          regenerated
        </div>
      )}
      <div className={`small pd-line ${changed ? 'pd-warn-text' : 'pd-ok'}`}>
        {changed ? (
          <>
            <Icon name="alert" size={12} /> Composition changed since this candidate (made from v{rev ?? '?'})
            — produce again to hear the current version.
          </>
        ) : (
          <>
            <Icon name="check" size={12} /> Same composition as the current song
            {rev ? ` — produced from v${rev}` : ''}
          </>
        )}
      </div>
      <div className="row between">
        <Stars
          value={c.rating}
          onChange={(v) =>
            set(
              { rating: v },
              v ? `Rated candidate ${c.label} ${'★'.repeat(v)}` : `Cleared rating of candidate ${c.label}`,
            )
          }
          label={`Rating for candidate ${c.label}`}
        />
      </div>
      <CommitText
        value={c.notes ?? ''}
        placeholder="Notes — e.g. “better chorus guitars, drums too roomy”"
        onCommit={(v) => set({ notes: v.trim() || undefined }, `Notes on candidate ${c.label}`)}
        aria-label={`Notes for candidate ${c.label}`}
      />
      <div className="row wrap pd-cand-actions">
        <Button size="sm" icon="play" onClick={onListen} aria-label={`Listen to ${c.label}`}>
          Listen
        </Button>
        <Button
          size="sm"
          variant={selected ? 'success' : 'default'}
          icon="check"
          onClick={() =>
            updateProduction(
              (p) => ({ ...p, selectedCandidateId: selected ? undefined : c.id }),
              selected ? `Unselected candidate ${c.label}` : `Selected production candidate ${c.label}`,
            )
          }
          aria-label={selected ? `Unselect ${c.label}` : `Select ${c.label}`}
        >
          {selected ? 'Selected' : 'Select'}
        </Button>
        <Button size="sm" variant="ai" icon="mixer" onClick={adopt} disabled={!c.mixAssetId}>
          {midiStems.length ? 'Use produced stems in the mix' : 'Use produced mix in the mix'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="scissors"
          onClick={() => useProduceUi.getState().set({ tab: 'regenerate', regionCandidateId: c.id })}
        >
          Regenerate bars…
        </Button>
        {stems.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon="layers"
            active={showStems}
            onClick={() => setShowStems(!showStems)}
          >
            Stems
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={open ? 'chevronDown' : 'chevronRight'}
          onClick={() => setOpen(!open)}
        >
          Provenance
        </Button>
        <div className="spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon="trash"
          aria-label={`Discard ${c.label}`}
          onClick={() => void discard()}
        />
      </div>
      {showStems && (
        <CompareDeck
          owner={`stems:${c.id}`}
          keyboard={false}
          sources={[
            ...(c.mixAssetId
              ? [{ key: `mix:${c.id}`, label: 'Mix', assetId: c.mixAssetId, tone: 'candidate' as const }]
              : []),
            ...stems.map(([tid, aid]) => ({
              key: `stem:${aid}`,
              label: song.tracks.find((t) => t.id === tid)?.name ?? tid,
              assetId: aid,
              tone: 'stem' as const,
            })),
          ]}
          title={<span className="small muted">Stems of {c.label}</span>}
        />
      )}
      {open && <ProvenanceDetails c={c} m={m} song={song} />}
    </div>
  );
}

export function CandidatesPanel({ song }: { song: Song }) {
  const project = useStudio((s) => s.project)!;
  const ui = useProduceUi();
  const candidates = song.production.candidates;
  const currentHash = useMemo(() => compositionHash(song), [song]);
  const metas = useMemo(
    () => new Map(candidates.map((c) => [c.id, candidateMeta(project, c)])),
    [candidates, project],
  );
  const guide = guideView(project, song);
  const adoptedId = adoptedCandidateId(song);
  const source = useMemo(() => productionSourceSong(song), [song]);
  const markers = useMemo(() => sectionMarkers(source), [source]);
  const total = candidates.reduce((n, c) => n + (c.costUsd ?? 0), 0);
  const sorted = useMemo(
    () => [...candidates].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [candidates],
  );

  const deck: DeckSource[] = [
    ...(guide.mix
      ? [
          {
            key: 'guide',
            label: 'Guide',
            sub: GUIDE_MIX_FILE,
            assetId: guide.mix.meta.id,
            tone: 'guide' as const,
            lufs: (guide.mix.prov?.parameters as { integratedLufs?: number } | undefined)?.integratedLufs,
          },
        ]
      : []),
    ...sorted
      .filter((c) => c.mixAssetId)
      .map((c) => ({
        key: `cand:${c.id}`,
        label: c.label,
        sub: `${STRATEGY_SHORT[c.strategy]} · ${metas.get(c.id)?.providerName ?? ''}`,
        assetId: c.mixAssetId!,
        lufs: metas.get(c.id)?.lufs,
        tone: 'candidate' as const,
      })),
  ];

  if (!candidates.length) {
    return (
      <div className="panel">
        <div className="panel-body pd-empty">
          <Icon name="produce" size={26} />
          <div>
            <strong>No candidates yet.</strong> Generate A/B candidates in{' '}
            <button className="pd-link" onClick={() => ui.set({ tab: 'production' })}>
              Production
            </button>
            : the same composition, produced with different seeds (and providers), so the comparison is fair.
          </div>
        </div>
      </div>
    );
  }

  const listen = (c: ProductionCandidate) => {
    const key = `cand:${c.id}`;
    ui.set({ compareActive: key });
    requestAnimationFrame(() => {
      if (comparePlayer.owner === 'candidates' && comparePlayer.has(key)) {
        comparePlayer.setActive(key);
        if (!comparePlayer.playing) void comparePlayer.play();
      }
    });
    document
      .querySelector('[data-testid="candidate-deck"]')
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="panel">
        <div className="panel-header">
          <Icon name="waveform" />
          <h3 className="grow">Compare</h3>
          <span className="small dim">
            {candidates.length} candidate{candidates.length === 1 ? '' : 's'} · total {money(total)} · keys 1–
            {Math.min(9, deck.length)} switch instantly
          </span>
          {adoptedId && (
            <Button
              size="sm"
              variant="ghost"
              icon="close"
              onClick={() => {
                const st = useStudio.getState();
                st.commit(
                  removeProducedAudio(st.project!.song),
                  'Removed produced audio from the mix (MIDI tracks unmuted)',
                  'production',
                );
              }}
            >
              Remove produced audio from the mix
            </Button>
          )}
        </div>
        <div className="panel-body">
          <CompareDeck
            owner="candidates"
            sources={deck}
            markers={markers}
            testId="candidate-deck"
            hint="The composition is identical across candidates — only performance and production differ (spec §54)."
          />
        </div>
      </div>
      <div className="pd-cand-grid">
        {sorted.map((c) => (
          <CandidateCard
            key={c.id}
            c={c}
            m={metas.get(c.id)!}
            song={song}
            currentHash={currentHash}
            adopted={adoptedId === c.id}
            onListen={() => listen(c)}
          />
        ))}
      </div>
      <div className="small dim">
        <Icon name="info" size={12} /> Produced from{' '}
        {[...new Set(candidates.map((c) => revisionNumber(project, c.sourceRevisionId)))]
          .map((n) => `v${n ?? '?'}`)
          .join(', ')}{' '}
        of the composition. {candidateSourceSong(project, candidates[0]).title}
        {(() => {
          const t = song.tracks.find(
            (x) => x.generator?.id && (x.generator.params as ProducedTrackParams | undefined)?.candidateLabel,
          );
          return t
            ? ` · Mix & Master currently plays ${(t.generator!.params as ProducedTrackParams).candidateLabel}.`
            : '';
        })()}
      </div>
    </div>
  );
}
