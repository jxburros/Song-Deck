import { useEffect, useMemo, useRef, useState } from 'react';
import {
  assetPathFor,
  attestationNeedsCare,
  getGenre,
  randomId,
  randomSeed,
  sectionLayout,
  songDurationSeconds,
  type AudioAssetMeta,
  type ProductionStrategy,
  type Song,
  type TrackProductionMethod,
} from '@songdeck/core';
import {
  buildProductionPrompt,
  formatCostRange,
  planCandidates,
  CAPABILITY_INFO,
  type Capability,
} from '@songdeck/ai';
import { useStudio } from '../../state/store';
import { decodeAudioBytes, guessMime } from '../../state/assets';
import { useSettings } from '../../state/settings';
import { useAiRuntime } from '../../engine/ai';
import { allCustomGenres } from '../../engine/plugins';
import { isTaskActive, startTask } from '../../engine/mix-tasks';
import { useRuntime } from '../../engine/runtime';
import {
  METHOD_INFO,
  PRODUCTION_CAPABILITIES,
  STRATEGIES,
  estimateOnDeviceSeconds,
  formatSeconds,
  hasSungVocals,
  headRevisionOf,
  isVocalTrack,
  methodFor,
  methodsFor,
  nextLabels,
  productionSourceSong,
  productionUnits,
  strategyInfo,
} from '../../engine/produce-model';
import {
  hardwareView,
  productionEstimate,
  refreshHardware,
  resolveProduction,
  useHardware,
  type ProductionResolution,
} from '../../engine/produce-providers';
import { sampleInstrumentName, useSampleInstruments } from '../../engine/produce-samples';
import { audioSeconds } from '../../engine/produce-assets';
import { attestationForAsset, careLabel, recordAttestation, requestAttestation } from '../../engine/rights';
import type { CandidateInput, CandidateOutput } from '../../engine/handlers/production';
import { Badge, Button, Field, FileButton, NumberInput, Select, Slider, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ProviderPicker } from '../shared/ProviderPicker';
import { CapabilityBadges, SourceTone, TaskLine, mmss } from './widgets';
import { useProduceUi } from './state';
import { guideView } from './GuidePanel';

/**
 * Production engine setup (spec §29 "Perform and produce this composition", §30 providers and
 * capabilities, §31 local models + hardware, §38 strategies A/B/C, §54 candidates, §60 cost).
 */

export function updateProduction(
  change: (p: Song['production']) => Song['production'],
  message: string,
): void {
  const st = useStudio.getState();
  const song = st.project?.song;
  if (!song) return;
  st.commit({ ...song, production: change(song.production) }, message, 'production');
}

/** The resolution of the production provider for the current settings (shared with the summary rail). */
export function useProductionResolution(song: Song): {
  resolution: ProductionResolution;
  units: ReturnType<typeof productionUnits>;
  aiUnits: number;
  singingUnits: number;
  referenceUsed: boolean;
  referenceNote?: string;
} {
  const version = useAiRuntime((s) => s.version);
  const routing = useSettings((s) => s.routing);
  const neverUpload = useStudio((s) => s.project?.meta.settings.neverUpload ?? []);
  const hasRef = useStudio(
    (s) => !!s.project?.meta.assets.some((a) => a.id === s.project?.song.production.referenceAudioAssetId),
  );
  return useMemo(() => {
    const p = song.production;
    const source = productionSourceSong(song);
    const units = productionUnits(source, p.strategy, p.trackMethods);
    const aiUnits = p.strategy === 'full' ? 0 : units.filter((u) => u.method === 'ai').length;
    const singingUnits = p.strategy === 'hybrid' ? units.filter((u) => u.method === 'singing').length : 0;
    const base = {
      vocals: hasSungVocals(source),
      aiUnits,
      aiVocalUnits: units.filter((u) => u.method === 'ai' && isVocalTrack(u.track)).length,
    };
    const choice = p.providerId ?? 'internal';
    let resolution = resolveProduction(choice, p.modelId, p.strategy, { ...base, reference: hasRef });
    let referenceNote: string | undefined;
    let referenceUsed = hasRef && !!resolution.plan.plan?.reference;
    if (
      hasRef &&
      resolution.provider?.location === 'cloud' &&
      (!p.allowReferenceUpload || neverUpload.includes('reference-audio'))
    ) {
      resolution = resolveProduction(choice, p.modelId, p.strategy, { ...base, reference: false });
      referenceUsed = false;
      referenceNote = neverUpload.includes('reference-audio')
        ? 'Project privacy settings never upload reference audio.'
        : 'Not sent: allow sending reference audio to cloud providers to use it.';
    } else if (hasRef && !referenceUsed)
      referenceNote = 'This provider/strategy does not use reference audio.';
    return { resolution, units, aiUnits, singingUnits, referenceUsed, referenceNote };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, version, routing, neverUpload, hasRef]);
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

function StrategyCards({ value }: { value: ProductionStrategy }) {
  return (
    <div className="pd-cards three" role="radiogroup" aria-label="Production strategy">
      {STRATEGIES.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          aria-checked={value === s.id}
          aria-label={`Strategy ${s.letter} — ${s.title}`}
          className={`pd-choice strategy ${value === s.id ? 'on' : ''}`}
          onClick={() =>
            value !== s.id &&
            updateProduction(
              (p) => ({ ...p, strategy: s.id }),
              `Production strategy: ${s.letter} — ${s.title}`,
            )
          }
        >
          <span className="row" style={{ gap: 8 }}>
            <span className="pd-letter">{s.letter}</span>
            <strong>{s.title}</strong>
          </span>
          <span className="pd-flow mono small">{s.flow}</span>
          <span className="row wrap" style={{ gap: 4 }}>
            {s.traits.map((t) => (
              <Badge key={t.label} tone={t.tone}>
                {t.label}
              </Badge>
            ))}
          </span>
          <span className="small muted">{s.description}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function ProviderSection({ song, r }: { song: Song; r: ReturnType<typeof useProductionResolution> }) {
  const p = song.production;
  const { resolution } = r;
  const prov = resolution.provider;
  const wanted = new Set<Capability>(resolution.plan.wanted.map((w) => w.cap));
  const missing = resolution.plan.wanted.filter(
    (w) =>
      !w.have &&
      !(w.cap === 'STEM_CONDITIONING' && prov?.capabilities.includes('AUDIO_TO_AUDIO')) &&
      !(w.cap === 'AUDIO_TO_AUDIO' && prov?.capabilities.includes('STEM_CONDITIONING')),
  );
  const models = prov?.models ?? [];
  return (
    <div className="col">
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        <Field
          label="Production provider"
          hint="Auto follows your routing rules; the on-device producer always works offline."
        >
          <ProviderPicker
            role="production"
            value={p.providerId ?? 'internal'}
            onChange={(v) =>
              updateProduction(
                (x) => ({ ...x, providerId: v, modelId: undefined }),
                `Production provider: ${v}`,
              )
            }
          />
        </Field>
        {models.length > 1 && (
          <Field label="Model">
            <Select
              value={p.modelId ?? ''}
              onChange={(v) =>
                updateProduction(
                  (x) => ({ ...x, modelId: v || undefined }),
                  `Production model: ${v || 'default'}`,
                )
              }
              options={[
                { value: '', label: `Default${prov?.defaultModel ? ` (${prov.defaultModel})` : ''}` },
                ...models.map((m) => ({ value: m.id, label: m.name ?? m.id })),
              ]}
              aria-label="Production model"
            />
          </Field>
        )}
      </div>
      {prov ? (
        <div className="card pd-provider" data-testid="production-provider">
          <div className="row between wrap">
            <div className="row" style={{ gap: 8 }}>
              <Icon
                name={prov.location === 'cloud' ? 'cloud' : prov.location === 'local' ? 'server' : 'cpu'}
              />
              <strong>{prov.name}</strong>
              <SourceTone location={prov.location} />
              {prov.modelId && <Badge>{prov.modelId}</Badge>}
              {prov.status !== 'ready' && <Badge tone="danger">{prov.status}</Badge>}
            </div>
            {(p.providerId ?? 'internal') === 'auto' && prov.reasons && (
              <span className="small dim ellipsis" title={prov.reasons.join(' · ')}>
                Auto: {prov.reasons.slice(0, 2).join(' · ')}
              </span>
            )}
          </div>
          {prov.description && <div className="small muted">{prov.description}</div>}
          <CapabilityBadges caps={prov.capabilities} all={PRODUCTION_CAPABILITIES} wanted={wanted} />
          {missing.length > 0 && (
            <div className="small" data-testid="capability-warnings">
              {missing.map((w) => (
                <div key={w.cap} className="pd-missing">
                  <Icon name="alert" size={12} /> Lacks <span className="mono">{w.cap}</span> — needed to{' '}
                  {w.why}.
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="callout danger small">{resolution.error ?? 'No production provider available.'}</div>
      )}
      {resolution.error && prov && <div className="callout danger small">{resolution.error}</div>}
      {resolution.plan.warnings.map((w, i) => (
        <div
          key={i}
          className={`callout small ${w.level === 'danger' ? 'danger' : w.level === 'warning' ? 'warning' : ''}`}
        >
          {w.text}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hybrid table (Strategy C)
// ---------------------------------------------------------------------------

function HybridTable({ song }: { song: Song }) {
  const source = useMemo(() => productionSourceSong(song), [song]);
  const tracks = source.tracks.filter((t) => (t.kind === 'midi' ? t.notes.length > 0 : t.clips.length > 0));
  const p = song.production;
  const samples = useSampleInstruments();
  const project = useStudio((s) => s.project)!;
  const guide = guideView(project, song);
  const externalGroups = new Set(guide.renderer === 'external' ? guide.stems.map((s) => s.group) : []);
  const singingChoice = useProduceUi((s) => s.singingChoice);
  const set = (id: string, name: string, m: TrackProductionMethod) =>
    updateProduction(
      (x) => ({ ...x, trackMethods: { ...x.trackMethods, [id]: m } }),
      `${name}: produce with ${METHOD_INFO[m].label.toLowerCase()}`,
    );
  const hasSinging = tracks.some((t) => methodFor(t, 'hybrid', p.trackMethods) === 'singing');
  return (
    <div className="col">
      <table className="table pd-methods" aria-label="Per-track production methods">
        <thead>
          <tr>
            <th>Track</th>
            <th>Method</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((t) => {
            const m = methodFor(t, 'hybrid', p.trackMethods);
            let note: string = METHOD_INFO[m].description;
            let warn = false;
            if (m === 'sampled') {
              const name = sampleInstrumentName(samples.assignments[t.id]);
              note = name
                ? `Sample instrument: ${name}`
                : 'No sample instrument assigned (Guide render → User sample instruments) — built-in patch is used.';
              warn = !name;
            } else if (m === 'external') {
              warn = !externalGroups.has(t.stemGroup);
              note = warn
                ? `Import an external render for “${t.stemGroup}” in Guide render — built-in patch is used until then.`
                : `External ${t.stemGroup} stem (covers the whole group).`;
            } else if (m === 'recorded' && t.kind === 'midi') {
              const take = song.vocals.takes.find((k) => k.trackId === t.id && k.active);
              note = take
                ? `Active take: ${take.name}`
                : 'No active recorded take — the guide vocal is used.';
              warn = !take;
            }
            return (
              <tr key={t.id}>
                <td>
                  <span className="pd-dot" style={{ background: t.color }} /> {t.name}{' '}
                  <span className="dim small">{t.stemGroup}</span>
                </td>
                <td style={{ width: 210 }}>
                  <Select
                    size="sm"
                    value={m}
                    onChange={(v) => set(t.id, t.name, v)}
                    options={methodsFor(t).map((x) => ({ value: x, label: METHOD_INFO[x].label }))}
                    aria-label={`Production method for ${t.name}`}
                  />
                </td>
                <td className={`small ${warn ? 'pd-warn-text' : 'muted'}`}>{note}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {hasSinging && (
        <Field
          label="Singing engine (vocal tracks set to singing synthesis)"
          hint="Role “vocals”: the built-in formant singer works offline; DiffSinger and other singing providers plug in here."
        >
          <ProviderPicker
            role="vocals"
            value={singingChoice}
            onChange={(v) => useProduceUi.getState().set({ singingChoice: v })}
          />
        </Field>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompts (spec §29)
// ---------------------------------------------------------------------------

function CommitArea({
  value,
  onCommit,
  label,
  placeholder,
  rows = 2,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  placeholder?: string;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value);
  const prev = useRef(value);
  if (prev.current !== value) {
    prev.current = value;
    if (draft !== value) setDraft(value);
  }
  return (
    <textarea
      className="textarea"
      rows={rows}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
    />
  );
}

function PromptEditor({ song }: { song: Song }) {
  const p = song.production;
  const source = useMemo(() => productionSourceSong(song), [song]);
  const auto = useMemo(
    () =>
      buildProductionPrompt({
        ...source,
        production: { ...source.production, prompt: '', negativePrompt: '' },
      }),
    [source],
  );
  const final = useMemo(() => buildProductionPrompt(source), [source]);
  const layout = useMemo(() => sectionLayout(source), [source]);
  const [open, setOpen] = useState<string | null>(null);
  const suggest = () => {
    const words = new Set<string>();
    for (const g of song.genreBlend)
      for (const k of getGenre(g.genreId, allCustomGenres())?.production.keywords ?? []) words.add(k);
    const text = [...words].slice(0, 10).join(', ');
    if (text)
      updateProduction(
        (x) => ({ ...x, prompt: x.prompt ? `${x.prompt}, ${text}` : text }),
        'Production instructions from genre profile',
      );
    else useStudio.getState().toast('info', 'The genre profile has no production keywords');
  };
  return (
    <div className="col">
      <div>
        <div className="field-label" style={{ marginBottom: 6 }}>
          From the composition{' '}
          <span className="dim">(genre, instruments, vocals, moods, tempo, key, meter)</span>
        </div>
        <div className="chip-list" data-testid="prompt-tags">
          {auto.tags.map((t) => (
            <span key={t} className="pd-tag">
              {t}
            </span>
          ))}
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <div className="row between">
            <span className="field-label">Production instructions</span>
            <Button
              size="sm"
              variant="ghost"
              icon="sparkles"
              onClick={suggest}
              title="Append the genre profile’s production keywords"
            >
              From genre
            </Button>
          </div>
          <CommitArea
            value={p.prompt}
            label="Production instructions"
            placeholder="tight punchy drums, wide double-tracked guitars, warm analog bass, big room reverb on the chorus"
            onCommit={(v) =>
              updateProduction((x) => ({ ...x, prompt: v.trim() }), 'Edited production instructions')
            }
          />
          <div className="hint">
            Comma-separated; added to every generation (spec §29 “production instructions”).
          </div>
        </div>
        <Field label="Negative prompt" hint="What the model must avoid.">
          <CommitArea
            value={p.negativePrompt}
            label="Negative prompt"
            placeholder="lo-fi, distortion on vocals, crowd noise"
            onCommit={(v) =>
              updateProduction((x) => ({ ...x, negativePrompt: v.trim() }), 'Edited negative prompt')
            }
          />
        </Field>
      </div>
      <div className="pd-final" aria-label="Final production prompt">
        <div className="row between">
          <span className="field-label">Prompt sent to the model</span>
          <span className="small dim mono">{final.prompt.length} chars</span>
        </div>
        <div className="mono small" data-testid="final-prompt">
          {final.prompt}
        </div>
        {final.negativePrompt && (
          <div className="mono small pd-neg">
            <span className="dim">negative: </span>
            {final.negativePrompt}
          </div>
        )}
      </div>
      <table className="table pd-sections" aria-label="Per-section production prompts">
        <thead>
          <tr>
            <th>Section</th>
            <th className="num">Bars</th>
            <th className="num">Energy</th>
            <th>Section prompt</th>
          </tr>
        </thead>
        <tbody>
          {layout.map((s) => {
            const sec = s.section;
            const preview =
              open === sec.id ? buildProductionPrompt(source, { sectionId: sec.id }).prompt : null;
            return (
              <tr key={sec.id}>
                <td>
                  <button
                    type="button"
                    className="pd-link"
                    onClick={() => setOpen(open === sec.id ? null : sec.id)}
                    title="Show the assembled section prompt"
                  >
                    {sec.name}
                  </button>
                  <div className="small dim">{sec.purpose ?? sec.kind}</div>
                  {preview && <div className="mono small pd-preview">{preview}</div>}
                </td>
                <td className="num">
                  {s.startBar + 1}–{s.endBar}
                </td>
                <td className="num">
                  {sec.energy}
                  {sec.energyEnd !== undefined && sec.energyEnd !== sec.energy ? `→${sec.energyEnd}` : ''}
                </td>
                <td style={{ width: '46%' }}>
                  <CommitArea
                    rows={1}
                    value={p.sectionPrompts[sec.id] ?? ''}
                    label={`Prompt for ${sec.name}`}
                    placeholder={
                      sec.kind === 'chorus' || sec.kind === 'final-chorus'
                        ? 'e.g. wall of guitars, soaring'
                        : sec.kind === 'verse'
                          ? 'e.g. intimate, dry vocal'
                          : 'e.g. sparse, filtered'
                    }
                    onCommit={(v) =>
                      updateProduction((x) => {
                        const next = { ...x.sectionPrompts };
                        if (v.trim()) next[sec.id] = v.trim();
                        else delete next[sec.id];
                        return { ...x, sectionPrompts: next };
                      }, `Section prompt: ${sec.name}`)
                    }
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reference audio (spec §29 "reference audio where permitted", §50)
// ---------------------------------------------------------------------------

function ReferenceAudio({ song, r }: { song: Song; r: ReturnType<typeof useProductionResolution> }) {
  const project = useStudio((s) => s.project)!;
  const p = song.production;
  const meta = project.meta.assets.find((a) => a.id === p.referenceAudioAssetId);
  const attestation = attestationForAsset(project, meta?.id);
  const never = project.meta.settings.neverUpload?.includes('reference-audio');
  const [busy, setBusy] = useState(false);
  const upload = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const audio = await decodeAudioBytes(bytes);
      const st = useStudio.getState();
      const attested = await requestAttestation([{ name: file.name, bytes, audio }], {
        context: 'produce-reference',
        purpose: 'Add reference audio for the production',
      });
      if (!attested) {
        st.toast('info', `Upload of “${file.name}” cancelled.`);
        return;
      }
      const now = new Date().toISOString();
      const id = randomId('asset');
      const provId = randomId('prov');
      const m: AudioAssetMeta = {
        id,
        name: file.name,
        kind: 'reference',
        path: assetPathFor('reference', `${id.slice(-6)}-${file.name}`),
        mimeType: guessMime(file.name, bytes),
        sampleRate: audio.sampleRate,
        channels: audio.channels.length,
        durationSeconds: audioSeconds(audio),
        bytes: bytes.length,
        createdAt: now,
        provenanceId: provId,
      };
      await st.addAsset(m, bytes);
      st.addProvenance({
        id: provId,
        artifactId: id,
        artifactName: file.name,
        artifactKind: 'audio',
        sources: [{ kind: 'file', ref: file.name }],
        providerId: 'user-import',
        providerName: 'Imported by the user',
        parameters: { purpose: 'production reference' },
        generatedAt: now,
        cloud: false,
      });
      recordAttestation(attested[0], { assetId: id, provenanceId: provId });
      updateProduction((x) => ({ ...x, referenceAudioAssetId: id }), `Reference audio: ${file.name}`);
    } catch (err) {
      useStudio
        .getState()
        .toast('error', `Could not read “${file.name}”: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col">
      <div className="row wrap">
        {meta ? (
          <span className="card row" style={{ padding: '6px 10px' }}>
            <Icon name="wave" size={14} /> <span className="mono small">{meta.name}</span>{' '}
            <span className="small dim">{mmss(meta.durationSeconds)}</span>
            <Button
              size="sm"
              variant="ghost"
              icon="close"
              aria-label="Remove reference audio"
              onClick={() =>
                updateProduction(
                  (x) => ({ ...x, referenceAudioAssetId: undefined }),
                  'Removed reference audio',
                )
              }
            />
          </span>
        ) : (
          <span className="small dim">
            No reference — optional: a recording whose sound/style the production should approach.
          </span>
        )}
        <FileButton accept="audio/*,.wav,.flac,.mp3,.m4a,.ogg" onFile={(f) => void upload(f)} icon="upload">
          {busy ? 'Reading…' : meta ? 'Replace reference' : 'Add reference audio'}
        </FileButton>
      </div>
      <Toggle
        on={p.allowReferenceUpload}
        onChange={(v) =>
          updateProduction(
            (x) => ({ ...x, allowReferenceUpload: v }),
            v ? 'Allowed sending reference audio to cloud providers' : 'Reference audio stays on this device',
          )
        }
        label="Allow sending reference audio to cloud providers"
        title="Data kind “reference-audio” (spec §50). Local and on-device providers never need this permission."
      />
      <div className="small dim">
        Data kind <span className="mono">reference-audio</span>
        {never ? ' — blocked by this project’s privacy settings (never upload).' : '.'}
        {meta &&
          (r.referenceUsed ? (
            <span className="pd-ok"> Will be sent to {r.resolution.provider?.name}.</span>
          ) : r.referenceNote ? (
            ` ${r.referenceNote}`
          ) : (
            ''
          ))}
      </div>
      {attestation && attestationNeedsCare(attestation) && (
        <div className="callout warning small" data-testid="reference-rights-warning">
          Rights reminder: {careLabel(attestation)}.{' '}
          {p.allowReferenceUpload
            ? 'Sending it to a cloud provider may not be covered by your rights to it.'
            : 'Think twice before allowing it to be sent to cloud providers.'}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Estimate + hardware (spec §31, §60, §61)
// ---------------------------------------------------------------------------

function EstimatePanel({
  song,
  r,
  count,
}: {
  song: Song;
  r: ReturnType<typeof useProductionResolution>;
  count: number;
}) {
  const hw = useHardware();
  const server = useRuntime((s) => s.server.status);
  const prov = r.resolution.provider;
  useEffect(() => {
    if (prov && prov.location === 'local') void refreshHardware();
    // Keyed on the provider's identity, not the descriptor object (a new one each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prov?.id, prov?.location, server]);
  const source = useMemo(() => productionSourceSong(song), [song]);
  const seconds = songDurationSeconds(source);
  const strategy = song.production.strategy;
  const perCandidate = strategy === 'full' ? 1 : r.aiUnits;
  const generations = perCandidate * count;
  const estimate = productionEstimate(prov, seconds, generations);
  const view = prov ? hardwareView(prov, hw) : null;
  const wall =
    prov?.location === 'internal'
      ? `≈ ${formatSeconds(estimateOnDeviceSeconds(strategy, seconds, r.units.length, r.aiUnits, count))} on this device`
      : prov?.location === 'local'
        ? 'depends on your GPU (see compatibility)'
        : 'typically 30 s – 3 min per generation (provider queue)';
  return (
    <div className="pd-estimate" data-testid="production-estimate">
      <div className="pd-estimate-main">
        <div className="pd-kv">
          <span>Production model</span>
          <strong>
            {prov?.name ?? '—'}
            {prov?.modelId ? ` · ${prov.modelId}` : ''}
          </strong>
        </div>
        <div className="pd-kv">
          <span>Estimated generation</span>
          <strong className="mono" data-testid="estimate-cost">
            {generations === 0 ? 'free (provider not called)' : formatCostRange(estimate)}
          </strong>
        </div>
        <div className="pd-kv">
          <span>Duration</span>
          <strong className="mono">
            {mmss(seconds)}
            {generations > 0 && (
              <span className="dim small">
                {' '}
                × {count} candidate{count === 1 ? '' : 's'}
                {strategy !== 'full' ? ` × ${r.aiUnits} AI stem${r.aiUnits === 1 ? '' : 's'}` : ''} ={' '}
                {generations} generation{generations === 1 ? '' : 's'}
              </span>
            )}
          </strong>
        </div>
        {r.singingUnits > 0 && (
          <div className="pd-kv">
            <span>Singing</span>
            <strong className="small">
              {r.singingUnits * count} vocal render{r.singingUnits * count === 1 ? '' : 's'}
            </strong>
          </div>
        )}
        <div className="pd-kv">
          <span>Time</span>
          <strong className="small">{wall}</strong>
        </div>
        {estimate.basis && generations > 0 && <div className="small dim">{estimate.basis}</div>}
      </div>
      {view && (
        <div className="pd-hw" aria-label="Hardware requirements">
          <div className="row between">
            <strong className="small">{view.title}</strong>
            {view.ratingLabel && (
              <Badge
                tone={
                  view.rating === 'excellent'
                    ? 'success'
                    : view.rating === 'compatible'
                      ? 'ai'
                      : view.rating === 'slow'
                        ? 'warning'
                        : 'danger'
                }
              >
                {view.ratingLabel}
              </Badge>
            )}
          </div>
          {view.lines.map((l) => (
            <div key={l.label} className="pd-kv small">
              <span>{l.label}</span>
              <span>{l.value}</span>
            </div>
          ))}
          {view.ratingLabel && (
            <div className="pd-kv small">
              <span>Estimated compatibility</span>
              <strong>{view.ratingLabel}</strong>
            </div>
          )}
          {view.reasons.length > 0 && <div className="small dim">{view.reasons.join(' · ')}</div>}
          {view.note && <div className="small dim">{view.note}</div>}
          {view.kind === 'local' && (
            <Button size="sm" variant="ghost" icon="rebuild" onClick={() => void refreshHardware(true)}>
              Re-detect hardware
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function ProductionPanel({ song }: { song: Song }) {
  const project = useStudio((s) => s.project)!;
  const ui = useProduceUi();
  const r = useProductionResolution(song);
  const p = song.production;
  const info = strategyInfo(p.strategy);
  const tasks = useRuntime((s) => s.tasks);
  const running = tasks.filter((t) => t.type === 'produce.candidate' && isTaskActive(t));
  const labels = nextLabels(p.candidates, ui.candidateCount);
  const needsProvider = p.strategy === 'full' || r.aiUnits > 0;
  const blocked = (needsProvider && (!r.resolution.plan.ok || !!r.resolution.error)) || !r.units.length;
  const prefs = useSettings((s) => s.exportPrefs);
  const samples = useSampleInstruments((s) => s.assignments);
  const guide = guideView(project, song);

  const generate = () => {
    const head = headRevisionOf(project);
    const batchId = randomId('batch');
    const seeds = planCandidates(ui.candidateCount, ui.baseSeed);
    const choice = p.providerId ?? 'internal';
    const providerName = r.resolution.provider?.name ?? choice;
    const ids: string[] = [];
    labels.forEach((label, i) => {
      const input: CandidateInput = {
        projectId: project.meta.id,
        batchId,
        sourceRevisionId: head?.id,
        label,
        seed: seeds[i].seed,
        strategy: p.strategy,
        providerChoice: choice,
        modelId: p.modelId,
        singingChoice: ui.singingChoice,
        prompt: p.prompt,
        negativePrompt: p.negativePrompt,
        sectionPrompts: p.sectionPrompts,
        trackMethods: Object.fromEntries(r.units.map((u) => [u.track.id, u.method])) as Record<
          string,
          TrackProductionMethod
        >,
        strength: ui.strength,
        variation: ui.variation,
        levelMatch: ui.levelMatch,
        referenceAssetId: r.referenceUsed ? p.referenceAudioAssetId : undefined,
        allowReferenceUpload: p.allowReferenceUpload,
        sampleRate: prefs.sampleRate,
        bitDepth: prefs.bitDepth,
        sampleAssignments: samples,
      };
      // Keep explicit "off" choices (they are not production units).
      for (const [id, m] of Object.entries(p.trackMethods)) if (m === 'off') input.trackMethods[id] = 'off';
      ids.push(
        startTask<CandidateInput, CandidateOutput>(
          'produce.candidate',
          `Produce candidate ${label} — ${info.title}, ${providerName}`,
          input,
          { providerId: r.resolution.provider?.id },
        ).id,
      );
    });
    ui.set({ batchTaskIds: ids, baseSeed: randomSeed() });
    useStudio
      .getState()
      .toast(
        'info',
        `Producing ${labels.length} candidate${labels.length === 1 ? '' : 's'} (${labels.join(', ')}) from revision v${head?.number ?? '?'} — the composition is identical across all of them.`,
      );
  };

  return (
    <div className="pd-grid">
      <div className="panel">
        <div className="panel-header">
          <Icon name="layers" />
          <h3 className="grow">Production strategy</h3>
          <span className="small dim">
            spec §38 — the composition never changes; only its performance and production do
          </span>
        </div>
        <div className="panel-body col">
          <StrategyCards value={p.strategy} />
          {p.strategy === 'full' && !guide.mix && (
            <div className="callout small">
              Strategy A transforms the guide mix — it is rendered automatically if missing or out of date.
            </div>
          )}
          {p.strategy === 'stems' && (
            <div className="small muted">
              {r.units.length} stem{r.units.length === 1 ? '' : 's'}:{' '}
              {r.units
                .map(
                  (u) =>
                    `${u.track.name}${u.method !== 'ai' ? ` (${METHOD_INFO[u.method].short.toLowerCase()})` : ''}`,
                )
                .join(' · ')}
            </div>
          )}
          {p.strategy === 'hybrid' && <HybridTable song={song} />}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <Icon name="cpu" />
          <h3 className="grow">Production provider</h3>
          <span className="small dim">capabilities (spec §30)</span>
        </div>
        <div className="panel-body">
          <ProviderSection song={song} r={r} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <Icon name="sparkles" />
          <h3 className="grow">Production prompt</h3>
          <span className="small dim">“Perform and produce this composition” — generated from the song</span>
        </div>
        <div className="panel-body">
          <PromptEditor song={song} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <Icon name="wave" />
          <h3 className="grow">Reference audio</h3>
          <span className="small dim">where permitted</span>
        </div>
        <div className="panel-body">
          <ReferenceAudio song={song} r={r} />
        </div>
      </div>

      <div className="panel pd-generate">
        <div className="panel-header">
          <Icon name="produce" />
          <h3 className="grow">Generate candidates</h3>
          <span className="small dim">A/B rendering (spec §54)</span>
        </div>
        <div className="panel-body col">
          <div className="pd-settings">
            <Field label="Candidates" hint={`Next: ${labels.join(', ')}`}>
              <NumberInput
                value={ui.candidateCount}
                min={1}
                max={6}
                onChange={(v) => ui.set({ candidateCount: Math.round(v) })}
                aria-label="Number of candidates"
              />
            </Field>
            <Field label="Base seed" hint="Each candidate derives its own seed (A keeps this one).">
              <div className="row">
                <NumberInput
                  value={ui.baseSeed}
                  min={0}
                  max={99999999}
                  onChange={(v) => ui.set({ baseSeed: Math.round(v) })}
                  aria-label="Base seed"
                />
                <Button
                  icon="dice"
                  title="New seed"
                  aria-label="New seed"
                  onClick={() => ui.set({ baseSeed: randomSeed() })}
                />
              </div>
            </Field>
            <Slider
              label="Performance variation"
              value={ui.variation}
              onChange={(v) => ui.set({ variation: v })}
              format={(v) => `${Math.round(v * 100)}%`}
              left="exact"
              right="loose"
            />
            <Slider
              label="Departure from the guide"
              value={ui.strength}
              onChange={(v) => ui.set({ strength: v })}
              format={(v) => `${Math.round(v * 100)}%`}
              left="faithful"
              right="free"
            />
          </div>
          <Toggle
            on={ui.levelMatch}
            onChange={(v) => ui.set({ levelMatch: v })}
            label="Level-match produced stems to their references (keeps your mix balance)"
          />
          <EstimatePanel song={song} r={r} count={ui.candidateCount} />
          <div className="row wrap">
            <Button
              variant="primary"
              size="lg"
              icon="sparkles"
              onClick={generate}
              disabled={blocked}
              data-testid="generate-candidates"
            >
              Generate {ui.candidateCount} candidate{ui.candidateCount === 1 ? '' : 's'} ({labels.join(', ')})
            </Button>
            <span className="small dim">
              {info.letter} — {info.title} · {r.resolution.provider?.name ?? 'no provider'} · composition v
              {headRevisionOf(project)?.number ?? '?'}
            </span>
          </div>
          {blocked && (
            <div className="small pd-warn-text">
              {!r.units.length
                ? 'Nothing to produce: every track is muted, empty or switched off.'
                : (r.resolution.error ?? 'The selected provider cannot run this strategy.')}
            </div>
          )}
          {ui.batchTaskIds.map((id) => (
            <TaskLine key={id} id={id} />
          ))}
          {running.length > 0 && !ui.batchTaskIds.length && (
            <div className="small dim">{running.length} production task(s) running.</div>
          )}
          <div className="small dim">
            Capabilities requested per generation:{' '}
            {(r.resolution.plan.plan?.caps ?? []).map((c) => (
              <span key={c} className="mono" title={CAPABILITY_INFO[c]?.description}>
                {c}{' '}
              </span>
            ))}
            {!r.resolution.plan.plan && '—'} · Every artifact records provider, model, seed, cost and its
            sources (spec §64).
          </div>
        </div>
      </div>
    </div>
  );
}
