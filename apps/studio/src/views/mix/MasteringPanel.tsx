import { useEffect, useMemo, useState } from 'react';
import type { MasteringSettings, Song } from '@songdeck/core';
import type { LoudnessReport } from '@songdeck/audio';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { assetStore } from '../../state/assets';
import { taskQueue } from '../../engine/runtime';
import { isTaskActive, startTask, useTaskRecord } from '../../engine/mix-tasks';
import { useMixCache } from '../../engine/mix-cache';
import { mixHash } from '../../engine/mix-render';
import { masteringCandidates } from '../../engine/mix-providers';
import { useAiRuntime } from '../../engine/ai';
import { METHOD_LABELS, allTargets, currentMaster, fmtLufs, latestMixAnalysis, targetInfo, type TargetInfo } from '../../engine/mix-mastering';
import { deliverFile, MIME, songFileBase } from '../../engine/export-files';
import { formatTime } from '../../hooks';
import { Badge, Button, Progress, Slider, Spinner, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ProviderPicker } from '../shared/ProviderPicker';
import { abPlayer, useABPosition, useABState, type Side } from './abPlayer';

/**
 * Mastering (spec §42): modular method (built-in DSP / local AI / cloud / external provider /
 * none), target profiles with their LUFS and true-peak targets, tone and width, loudness
 * analysis, a mastering task that writes Master.wav with provenance, and instant A/B listening.
 */

/** "−14" / "−0.3" — integers without a decimal. */
function fmtCompact(v: number): string {
  const t = Number.isInteger(v) ? String(Math.abs(v)) : Math.abs(v).toFixed(1);
  return `${v < 0 ? '−' : ''}${t}`;
}

const METHODS: { value: MasteringSettings['method']; hint: string }[] = [
  { value: 'builtin', hint: 'EQ, glue compression, width, true-peak limiting, loudness targeting — on this device' },
  { value: 'local-ai', hint: 'A local mastering model (e.g. a mastering bridge on this machine)' },
  { value: 'cloud', hint: 'A cloud mastering service — the mix leaves this device' },
  { value: 'external', hint: 'Any configured mastering provider or plugin' },
  { value: 'none', hint: 'Export the unmastered mix as-is' },
];

function TaskLine({ id, onDone }: { id: string | null; onDone?: () => void }) {
  const t = useTaskRecord(id);
  useEffect(() => {
    if (t?.status === 'succeeded') onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.status]);
  if (!t) return null;
  if (t.status === 'running' || t.status === 'queued' || t.status === 'paused') {
    return (
      <div className="mx-task" role="status" aria-live="polite">
        <div className="row between small">
          <span className="row" style={{ gap: 6 }}>
            <Spinner /> {t.title} — {t.message ?? t.status}
          </span>
          <span className="row" style={{ gap: 6 }}>
            <span className="mono dim">{Math.round(t.progress * 100)}%</span>
            <Button size="sm" variant="ghost" onClick={() => taskQueue.cancel(t.id)}>
              Cancel
            </Button>
          </span>
        </div>
        <Progress value={t.progress} ai />
      </div>
    );
  }
  if (t.status === 'failed')
    return (
      <div className="callout danger small" role="alert">
        {t.title} failed: {t.error}
        <Button size="sm" variant="ghost" onClick={() => taskQueue.retry(t.id)}>
          Retry
        </Button>
      </div>
    );
  if (t.status === 'cancelled') return <div className="small dim">{t.title} cancelled.</div>;
  return null;
}

/** Loudness numbers for the unmastered mix, the master, and the target. */
function LoudnessTable({ mix, master, target, mixCurrent, masterStale }: { mix?: LoudnessReport; master?: LoudnessReport; target: TargetInfo; mixCurrent: boolean; masterStale: boolean }) {
  const rows: { label: string; unit: string; get: (r: LoudnessReport) => number; target?: number; hint: string }[] = [
    { label: 'Integrated', unit: 'LUFS', get: (r) => r.integratedLufs, target: target.lufs, hint: 'Programme loudness (BS.1770 gated)' },
    { label: 'True peak', unit: 'dBTP', get: (r) => r.truePeakDb, target: target.truePeakDb, hint: '4× oversampled inter-sample peak' },
    { label: 'Loudness range', unit: 'LU', get: (r) => r.lra, hint: 'EBU R128 LRA (dynamics over time)' },
    { label: 'Short-term max', unit: 'LUFS', get: (r) => r.shortTermMaxLufs, hint: 'Loudest 3-second window' },
    { label: 'Momentary max', unit: 'LUFS', get: (r) => r.momentaryMaxLufs, hint: 'Loudest 400 ms window' },
    { label: 'Sample peak', unit: 'dBFS', get: (r) => r.samplePeakDb, hint: 'Highest sample value' },
  ];
  const cell = (r: LoudnessReport | undefined, row: (typeof rows)[number], isMaster: boolean) => {
    if (!r) return <span className="dim">—</span>;
    const v = row.get(r);
    let cls = '';
    if (isMaster && row.target !== undefined) {
      if (row.unit === 'dBTP') cls = v <= row.target + 0.05 ? 'ok' : 'bad';
      else cls = Math.abs(v - row.target) <= 1 ? 'ok' : 'warn';
    }
    return <span className={`mx-lv ${cls}`}>{row.unit === 'LU' ? v.toFixed(1) : fmtLufs(v)}</span>;
  };
  return (
    <table className="table mx-loudness" aria-label="Loudness report">
      <thead>
        <tr>
          <th />
          <th className="num">
            Mix{mix && !mixCurrent && <span title="The mix changed since this analysis"> *</span>}
          </th>
          <th className="num">Master{master && masterStale && <span title="The mix changed since this master"> *</span>}</th>
          <th className="num">Target</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} title={row.hint}>
            <td>
              {row.label} <span className="dim small">{row.unit}</span>
            </td>
            <td className="num" data-testid={row.label === 'Integrated' ? 'mix-integrated' : undefined}>
              {cell(mix, row, false)}
            </td>
            <td className="num" data-testid={row.label === 'Integrated' ? 'master-integrated' : undefined}>
              {cell(master, row, true)}
            </td>
            <td className="num dim">{row.target !== undefined ? fmtLufs(row.target) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Horizontal LUFS scale with markers for mix, master and target. */
function LoudnessScale({ mix, master, target }: { mix?: number; master?: number; target: number }) {
  const MIN = -32;
  const MAX = -4;
  const pct = (v: number) => `${(Math.max(0, Math.min(1, (v - MIN) / (MAX - MIN))) * 100).toFixed(1)}%`;
  return (
    <div className="mx-lufs-scale" aria-hidden>
      <div className="mx-lufs-track">
        <div className="mx-lufs-target" style={{ left: pct(target) }} title={`Target ${fmtLufs(target)} LUFS`} />
        {mix !== undefined && mix > -100 && <div className="mx-lufs-mark mix" style={{ left: pct(mix) }} title={`Mix ${fmtLufs(mix)} LUFS`} />}
        {master !== undefined && master > -100 && <div className="mx-lufs-mark master" style={{ left: pct(master) }} title={`Master ${fmtLufs(master)} LUFS`} />}
      </div>
      <div className="row between small dim mono">
        {[-32, -24, -18, -14, -9, -4].map((v) => (
          <span key={v}>{v}</span>
        ))}
      </div>
    </div>
  );
}

function ABSection({ song, mixReport, masterReport }: { song: Song; mixReport?: LoudnessReport; masterReport?: LoudnessReport }) {
  useABState();
  const pos = useABPosition();
  const project = useStudio((s) => s.project);
  const cache = useMixCache();
  const hash = useMemo(() => mixHash(song), [song]);
  const master = currentMaster(project, song);
  const [loading, setLoading] = useState(false);
  const [prepTask, setPrepTask] = useState<string | null>(null);
  const prepRecord = useTaskRecord(prepTask);

  const mixReady = !!cache.mix && cache.mix.projectId === project?.meta.id && cache.mix.hash === hash;
  const mixOld = !!cache.mix && cache.mix.projectId === project?.meta.id && cache.mix.hash !== hash;

  // Keep the player loaded with the newest buffers.
  useEffect(() => {
    if (cache.mix && cache.mix.projectId === project?.meta.id) abPlayer.load('A', cache.mix.audio, `mix:${cache.mix.hash}`);
    else abPlayer.load('A', null, null);
  }, [cache.mix, project?.meta.id]);
  useEffect(() => {
    if (cache.master && cache.master.projectId === project?.meta.id && cache.master.assetId === master?.meta.id) abPlayer.load('B', cache.master.audio, cache.master.assetId);
  }, [cache.master, master?.meta.id, project?.meta.id]);
  useEffect(() => {
    const db = mixReport && masterReport ? mixReport.integratedLufs - masterReport.integratedLufs : 0;
    if (abPlayer.matching) abPlayer.setMatching(true, db);
  }, [mixReport, masterReport]);
  useEffect(() => () => abPlayer.pause(), []);

  const loadMaster = async () => {
    if (!master) return;
    setLoading(true);
    try {
      const audio = await assetStore.audio(master.meta);
      if (audio) abPlayer.load('B', audio, master.meta.id);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (master && abPlayer.loadedId('B') !== master.meta.id && !(cache.master?.assetId === master.meta.id)) void loadMaster();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [master?.meta.id]);

  const prepare = () => {
    if (!project) return;
    const t = startTask('mix.analyze', 'Render mix for A/B', { projectId: project.meta.id });
    setPrepTask(t.id);
  };

  const dur = abPlayer.duration();
  const side = abPlayer.side;
  const canPlay = abPlayer.has('A') || abPlayer.has('B');
  const matchDb = mixReport && masterReport ? mixReport.integratedLufs - masterReport.integratedLufs : 0;
  const choose = (s: Side) => abPlayer.setSide(s);

  return (
    <section className="mx-section mx-ab" aria-label="A/B listening">
      <div className="row between mx-section-head">
        <h4>A/B listening</h4>
        <span className="small dim">Same position, instant switch</span>
      </div>
      {!mixReady && (
        <div className="callout small" style={{ marginBottom: 8 }}>
          {mixOld ? 'The mix changed since the last render. ' : ''}A needs a render of the current unmastered mix.{' '}
          <Button size="sm" variant="ghost" icon="play" onClick={prepare} disabled={isTaskActive(prepRecord)}>
            Render mix for A/B
          </Button>
        </div>
      )}
      <TaskLine id={prepTask} onDone={() => setPrepTask(null)} />
      {!master && <div className="small dim" style={{ marginBottom: 8 }}>B appears after you master the song.</div>}
      <div className="mx-ab-switch" role="radiogroup" aria-label="Listen to">
        <button type="button" role="radio" aria-checked={side === 'A'} className={`mx-ab-btn ${side === 'A' ? 'on' : ''}`} disabled={!abPlayer.has('A')} onClick={() => choose('A')}>
          <span className="mx-ab-letter">A</span>
          <span>
            Mix<span className="small dim"> · unmastered{mixOld ? ' (older)' : ''}</span>
          </span>
        </button>
        <button type="button" role="radio" aria-checked={side === 'B'} className={`mx-ab-btn ${side === 'B' ? 'on' : ''}`} disabled={!abPlayer.has('B')} onClick={() => choose('B')}>
          <span className="mx-ab-letter">B</span>
          <span>
            Master{loading ? <Spinner /> : null}
            <span className="small dim"> · {master ? (master.stale ? 'out of date' : 'current') : 'none yet'}</span>
          </span>
        </button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <Button
          size="sm"
          variant={abPlayer.playing ? 'default' : 'primary'}
          icon={abPlayer.playing ? 'pause' : 'play'}
          disabled={!canPlay}
          onClick={() => (abPlayer.playing ? abPlayer.pause() : void abPlayer.play())}
          aria-label={abPlayer.playing ? 'Pause A/B' : 'Play A/B'}
        >
          {abPlayer.playing ? 'Pause' : 'Play'}
        </Button>
        <Button size="sm" variant="ghost" icon="stop" disabled={!canPlay} onClick={() => abPlayer.stop()} aria-label="Stop A/B" />
        <input
          type="range"
          className="slider grow"
          min={0}
          max={Math.max(0.1, dur)}
          step={0.01}
          value={Math.min(pos, dur)}
          disabled={!canPlay}
          aria-label="A/B position"
          onChange={(e) => abPlayer.seek(parseFloat(e.target.value))}
        />
        <span className="mono small" style={{ minWidth: 92, textAlign: 'right' }}>
          {formatTime(pos)} / {formatTime(dur)}
        </span>
      </div>
      <div className="row between" style={{ marginTop: 8 }}>
        <Toggle
          on={abPlayer.matching}
          onChange={(v) => abPlayer.setMatching(v, matchDb)}
          label={`Level-match B to A${mixReport && masterReport ? ` (${matchDb >= 0 ? '+' : '−'}${Math.abs(matchDb).toFixed(1)} dB)` : ''}`}
          title="Play the master at the mix's loudness so you judge tone and dynamics, not volume"
        />
      </div>
    </section>
  );
}

export function MasteringPanel({ song }: { song: Song }) {
  const project = useStudio((s) => s.project);
  const prefs = useSettings((s) => s.exportPrefs);
  const st = useStudio.getState();
  const m = song.mastering;
  const targets = useMemo(() => allTargets(), []);
  const target = targetInfo(m.target);
  const [providerChoice, setProviderChoice] = useState(m.providerId ?? 'auto');
  const [tone, setTone] = useState(m.tone);
  const [width, setWidth] = useState(m.width);
  const [analyzeId, setAnalyzeId] = useState<string | null>(null);
  const [masterId, setMasterId] = useState<string | null>(null);
  const aiVersion = useAiRuntime((s) => s.version);
  useEffect(() => setTone(m.tone), [m.tone]);
  useEffect(() => setWidth(m.width), [m.width]);

  const external = m.method === 'local-ai' || m.method === 'cloud' || m.method === 'external';
  const availability = useMemo(() => {
    if (!external) return null;
    const list = masteringCandidates(m.method);
    const ready = list.filter((c) => c.ready);
    return { count: ready.length, names: ready.map((c) => c.name), notReady: list.filter((c) => !c.ready).map((c) => c.name) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [external, m.method, aiVersion]);

  const setMastering = (patch: Partial<MasteringSettings>, message: string) => {
    const cur = useStudio.getState().project?.song;
    if (!cur) return;
    st.commit({ ...cur, mastering: { ...cur.mastering, ...patch } }, message, 'mix');
  };

  const analysis = latestMixAnalysis(project, song);
  const master = currentMaster(project, song);
  const cache = useMixCache();
  const hash = useMemo(() => mixHash(song), [song]);
  const mixReport = analysis?.report ?? (cache.mix?.hash === hash ? cache.mix.report : undefined);
  const masterReport = master?.report ?? (cache.master?.assetId === master?.meta.id ? cache.master?.report : undefined);
  const analyzeTask = useTaskRecord(analyzeId);
  const masterTask = useTaskRecord(masterId);

  const analyze = () => {
    if (!project) return;
    const t = startTask('mix.analyze', 'Analyze mix loudness', { projectId: project.meta.id, sampleRate: prefs.sampleRate });
    setAnalyzeId(t.id);
  };
  const runMaster = () => {
    if (!project) return;
    const settings: MasteringSettings = { ...m, providerId: external && providerChoice !== 'auto' ? providerChoice : m.providerId };
    const t = startTask(
      'mix.master',
      `Master for ${target.label} (${fmtLufs(target.lufs)} LUFS)`,
      { projectId: project.meta.id, settings, sampleRate: prefs.sampleRate, bitDepth: prefs.bitDepth, providerChoice },
      { providerId: m.method === 'builtin' ? 'internal-mastering' : providerChoice },
    );
    setMasterId(t.id);
    t.done.then(
      (r) => {
        const out = r as { summary?: string; fallbackReason?: string };
        st.toast('success', `Master ready — ${out.summary ?? 'Master.wav saved'}`);
        if (out.fallbackReason) st.toast('warning', `${out.fallbackReason} Used built-in DSP mastering.`);
      },
      () => undefined,
    );
  };
  const downloadMaster = async () => {
    if (!master) return;
    const bytes = await assetStore.bytes(master.meta);
    if (!bytes) return st.toast('error', 'Master audio is missing from this browser’s storage.');
    deliverFile(`${songFileBase(song)} - Master.wav`, bytes, MIME.wav, { detail: `Master · ${target.label}` });
  };

  return (
    <div className="mx-mastering">
      <div className="panel">
        <div className="panel-header">
          <Icon name="wave" />
          <h3 className="grow">Mastering</h3>
          <Badge tone={m.method === 'builtin' ? 'success' : m.method === 'none' ? undefined : 'ai'}>{METHOD_LABELS[m.method]}</Badge>
        </div>
        <div className="panel-body mx-master-grid">
          <div className="col">
            <div className="field">
              <span className="field-label" id="mx-method-label">
                Method
              </span>
              <div className="mx-seg" role="radiogroup" aria-labelledby="mx-method-label">
                {METHODS.map((x) => (
                  <button
                    key={x.value}
                    type="button"
                    role="radio"
                    aria-checked={m.method === x.value}
                    className={`mx-seg-btn ${m.method === x.value ? 'on' : ''}`}
                    title={x.hint}
                    onClick={() => m.method !== x.value && setMastering({ method: x.value }, `Mastering method: ${METHOD_LABELS[x.value]}`)}
                  >
                    {METHOD_LABELS[x.value]}
                  </button>
                ))}
              </div>
              <div className="hint">{METHODS.find((x) => x.value === m.method)?.hint}</div>
            </div>
            {external && (
              <div className="col" style={{ gap: 6 }}>
                <div className="row">
                  <span className="field-label">Provider</span>
                  <div className="grow">
                    <ProviderPicker role="mastering" value={providerChoice} onChange={setProviderChoice} size="sm" />
                  </div>
                </div>
                {availability && availability.count === 0 && (
                  <div className="callout warning small">
                    No {m.method === 'local-ai' ? 'local AI' : m.method === 'cloud' ? 'cloud' : 'external'} mastering provider is ready
                    {availability.notReady.length ? ` (${availability.notReady.join(', ')} not configured)` : ''}. Add one in Settings → Providers (a mastering
                    HTTP bridge or plugin). Until then <strong>Master</strong> falls back to built-in DSP mastering and records why.
                  </div>
                )}
                {availability && availability.count > 0 && <div className="small dim">Ready: {availability.names.join(', ')}</div>}
              </div>
            )}
            {m.method === 'none' && (
              <div className="callout small">
                No mastering: exports use the unmastered mix through the master bus (“user export”).{' '}
                <Button size="sm" variant="ghost" icon="export" onClick={() => st.setMode('export')}>
                  Open Export
                </Button>
              </div>
            )}
            <div className="field">
              <span className="field-label">Target profile</span>
              <div className="mx-targets" role="radiogroup" aria-label="Mastering target">
                {targets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={m.target === t.id}
                    className={`mx-target ${m.target === t.id ? 'on' : ''}`}
                    onClick={() => m.target !== t.id && setMastering({ target: t.id }, `Mastering target: ${t.label}`)}
                  >
                    <span className="mx-target-name">{t.label}</span>
                    <span className="mx-target-nums mono">
                      {fmtCompact(t.lufs)} LUFS · {fmtCompact(t.truePeakDb)} dBTP
                    </span>
                    <span className="mx-target-desc">{t.description}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="grid-2">
              <Slider
                label="Tone"
                value={tone}
                min={-1}
                max={1}
                step={0.05}
                left="Darker"
                right="Brighter"
                format={(v) => (Math.abs(v) < 0.025 ? 'neutral' : `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`)}
                onChange={setTone}
                onCommit={(v) => v !== m.tone && setMastering({ tone: v }, `Mastering tone ${v > 0 ? 'brighter' : v < 0 ? 'darker' : 'neutral'} (${v.toFixed(2)})`)}
              />
              <Slider
                label="Width"
                value={width}
                min={0}
                max={2}
                step={0.05}
                left="Mono"
                right="Wide"
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={setWidth}
                onCommit={(v) => v !== m.width && setMastering({ width: v }, `Mastering width ${Math.round(v * 100)}%`)}
              />
            </div>
            <div className="row wrap">
              <Button icon="waveform" onClick={analyze} disabled={isTaskActive(analyzeTask) || !song.tracks.length}>
                Analyze mix
              </Button>
              <Button variant="primary" icon="sparkles" onClick={runMaster} disabled={isTaskActive(masterTask) || m.method === 'none' || !song.tracks.length}>
                Master
              </Button>
              <span className="small dim">
                {prefs.sampleRate / 1000} kHz · {prefs.bitDepth}-bit WAV · solo ignored
              </span>
            </div>
            <TaskLine id={analyzeId} />
            <TaskLine id={masterId} />
          </div>
          <div className="col">
            <section className="mx-section" aria-label="Loudness report">
              <div className="row between mx-section-head">
                <h4>Loudness report</h4>
                <span className="small dim">EBU R128 · ITU-R BS.1770</span>
              </div>
              <LoudnessScale mix={mixReport?.integratedLufs} master={masterReport?.integratedLufs} target={target.lufs} />
              <LoudnessTable mix={mixReport} master={masterReport} target={target} mixCurrent={!!analysis?.current} masterStale={!!master?.stale} />
              {!mixReport && <div className="small dim">Run “Analyze mix” to measure the unmastered mix.</div>}
            </section>
            {master && (
              <div className={`card mx-master-card ${master.stale ? 'stale' : ''}`}>
                <div className="row between">
                  <div className="row" style={{ gap: 8 }}>
                    <Icon name="wave" />
                    <div>
                      <div style={{ fontWeight: 600 }}>{master.meta.name}</div>
                      <div className="small dim">
                        {master.provenance?.providerName ?? 'Built-in DSP mastering'} · {String((master.provenance?.parameters as Record<string, unknown> | undefined)?.target ?? m.target)} ·{' '}
                        {(master.meta.sampleRate / 1000).toFixed(1)} kHz · {new Date(master.meta.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <div className="row">
                    {master.stale ? <Badge tone="warning">mix changed — re-master</Badge> : <Badge tone="success">current</Badge>}
                    <Button size="sm" icon="download" onClick={() => void downloadMaster()}>
                      Master.wav
                    </Button>
                  </div>
                </div>
              </div>
            )}
            <ABSection song={song} mixReport={mixReport} masterReport={masterReport} />
          </div>
        </div>
      </div>
    </div>
  );
}
