import { useMemo, useState } from 'react';
import { zipSync } from 'fflate';
import { markersCsv, removeAsset, sectionLayout, songToMidi, tempoMapCsv, createTimeMap, type AudioAssetMeta, type Project, type ProvenanceRecord, type Song, type StemGroup } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { assetStore, decodeAudioBytes } from '../../state/assets';
import { useSettings } from '../../state/settings';
import { isTaskActive, startTask, useTaskRecord } from '../../engine/mix-tasks';
import { deliverFile, MIME, songFileBase } from '../../engine/export-files';
import { useExtensions } from '../../engine/plugins';
import { recordAttestation, requestAttestation, type PendingAttestation } from '../../engine/rights';
import {
  GUIDE_MIX_FILE,
  GUIDE_RENDERERS,
  GUIDE_STEM_FILES,
  STEM_GROUP_ORDER,
  audibleSourceTracks,
  guideHash,
  productionSourceSong,
  type GuideRenderer,
} from '../../engine/produce-model';
import { provenanceOfAsset, stageExternalStems } from '../../engine/produce-assets';
import { assignSampleInstrument, loadSampleFiles, pluginSampleInstruments, removeSampleInstrument, useSampleInstruments } from '../../engine/produce-samples';
import type { GuideImportInput, GuideInput, GuideOutput } from '../../engine/handlers/render';
import { Badge, Button, Field, FileButton, Select, Spinner } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { CompareDeck, TaskLine, fmtBytes, mmss, relTime, type DeckSource, type Marker } from './widgets';
import { useProduceUi } from './state';

/**
 * Guide rendering (spec §28): render the MIDI into a reference before any generative production —
 * with the built-in instrument library, user sample instruments, or an external DAW — producing
 * guide_mix.wav plus one reference per stem group, each with provenance.
 */

export interface GuideView {
  mix?: { meta: AudioAssetMeta; prov?: ProvenanceRecord };
  stems: { group: StemGroup; meta: AudioAssetMeta; prov?: ProvenanceRecord }[];
  renderer?: GuideRenderer;
  stale: boolean;
  revision?: number;
}

let cache: { song: Song; assets: Project['meta']['assets']; provenance: Project['meta']['provenance']; view: GuideView } | null = null;

/** Current guide assets and whether they are stale (cached per song + asset list: it hashes the song). */
export function guideView(project: Project, song: Song): GuideView {
  if (cache && cache.song === song && cache.assets === project.meta.assets && cache.provenance === project.meta.provenance) return cache.view;
  const view = computeGuideView(project, song);
  cache = { song, assets: project.meta.assets, provenance: project.meta.provenance, view };
  return view;
}

function computeGuideView(project: Project, song: Song): GuideView {
  const find = (id: string | undefined) => (id ? project.meta.assets.find((a) => a.id === id) : undefined);
  const mixMeta = find(song.production.guideMixAssetId);
  const stems = STEM_GROUP_ORDER.flatMap((group) => {
    const meta = find(song.production.guideStemAssetIds?.[group]);
    return meta ? [{ group, meta, prov: provenanceOfAsset(project, meta.id) }] : [];
  });
  const mixProv = mixMeta ? provenanceOfAsset(project, mixMeta.id) : undefined;
  const params = (mixProv?.parameters ?? {}) as { guideHash?: string; renderer?: GuideRenderer };
  return {
    mix: mixMeta ? { meta: mixMeta, prov: mixProv } : undefined,
    stems,
    renderer: params.renderer,
    stale: !!mixMeta && params.guideHash !== guideHash(song),
    revision: mixProv?.sources.find((s) => s.kind === 'song')?.revision,
  };
}

export function sectionMarkers(song: Song): Marker[] {
  const tm = createTimeMap(song);
  return sectionLayout(song).map((s) => ({ seconds: tm.tickToSeconds(s.startTick), label: s.section.name }));
}

function guessGroup(name: string): StemGroup {
  const n = name.toLowerCase();
  if (/vox|vocal|voice|sing|melody|lead ?v|choir/.test(n)) return 'vocals';
  if (/drum|kick|snare|perc|hat|cymbal|tom|kit/.test(n)) return 'drums';
  if (/bass|808|sub/.test(n)) return 'bass';
  if (/guit|gtr/.test(n)) return 'guitars';
  if (/key|piano|organ|rhodes|wurli|epiano/.test(n)) return 'keys';
  if (/string|violin|viola|cello|orch|fiddle/.test(n)) return 'strings';
  return 'others';
}

const GROUP_OPTIONS = STEM_GROUP_ORDER.map((g) => ({ value: g, label: `${GUIDE_STEM_FILES[g].label} → ${GUIDE_STEM_FILES[g].file}` }));

function RendererCards({ value, onChange }: { value: GuideRenderer; onChange: (r: GuideRenderer) => void }) {
  const icons: Record<GuideRenderer, string> = { builtin: 'music', external: 'export', sampled: 'layers' };
  return (
    <div className="pd-cards three" role="radiogroup" aria-label="Guide renderer">
      {(Object.keys(GUIDE_RENDERERS) as GuideRenderer[]).map((r) => (
        <button key={r} type="button" role="radio" aria-checked={value === r} className={`pd-choice ${value === r ? 'on' : ''}`} onClick={() => onChange(r)}>
          <span className="row" style={{ gap: 8 }}>
            <Icon name={icons[r]} />
            <strong>{GUIDE_RENDERERS[r].label}</strong>
            {r === 'builtin' && <Badge tone="success">default</Badge>}
          </span>
          <span className="small muted">{GUIDE_RENDERERS[r].description}</span>
        </button>
      ))}
    </div>
  );
}

function SampleInstrumentsPanel({ song }: { song: Song }) {
  const st = useSampleInstruments();
  const ext = useExtensions();
  const tracks = useMemo(() => audibleSourceTracks(productionSourceSong(song)).filter((t) => t.kind === 'midi'), [song]);
  // Recomputed when the enabled plugins change; the list itself is read from the plugin registry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plugin = useMemo(() => pluginSampleInstruments(), [ext]);
  const instrumentPlugins = ext.available.filter((m) => m.kind === 'instrument');
  const toast = useStudio.getState().toast;
  const load = async (files: File[]) => {
    try {
      // Sample audio needs a rights attestation before it is used (the .sfz text itself does not).
      const audioFiles = files.filter((f) => !/\.sfz$/i.test(f.name));
      const uploads = await Promise.all(audioFiles.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      const attested = await requestAttestation(uploads, { context: 'sample-instrument', purpose: 'Load samples as an instrument' });
      if (!attested) {
        toast('info', 'Loading the samples was cancelled.');
        return;
      }
      const e = await loadSampleFiles(files);
      for (const a of attested) recordAttestation(a);
      toast('success', `Loaded sample instrument “${e.name}” (${e.zones} zone${e.zones === 1 ? '' : 's'})`);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : String(err));
    }
  };
  const options = [
    ...plugin.filter((p) => p.loaded).map((p) => ({ value: p.patchId, label: `${p.name} (plugin)` })),
    ...st.instruments.map((i) => ({ value: i.id, label: `${i.name} (loaded)` })),
  ];
  return (
    <div className="col">
      {plugin.length > 0 ? (
        <table className="table" aria-label="Plugin sample instruments">
          <thead>
            <tr>
              <th>Plugin instrument</th>
              <th className="num">Zones</th>
              <th className="num">Keys</th>
              <th>Plugin</th>
            </tr>
          </thead>
          <tbody>
            {plugin.map((p) => (
              <tr key={p.patchId}>
                <td>
                  {p.name} {!p.loaded && <Badge tone="warning">samples not loaded</Badge>}
                </td>
                <td className="num">{p.zones || '—'}</td>
                <td className="num">{p.zones ? `${p.keyRange[0]}–${p.keyRange[1]}` : '—'}</td>
                <td className="small dim mono">{p.plugin}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="callout small" data-testid="no-plugin-instruments">
          <strong>No plugin sample instruments are installed.</strong> Instrument plugins ship SFZ sample sets (for example the “Felt Keys” example plugin): enable one in
          Settings → Plugins{instrumentPlugins.length ? ` (${instrumentPlugins.map((m) => m.name).join(', ')} available)` : ' — the local Song Deck server lists and serves plugin files'}. Tracks
          using a plugin instrument then render with its samples everywhere. You can also load your own SFZ or WAV samples for this session below.
        </div>
      )}
      <div className="row wrap">
        <FileButton accept=".sfz,.wav,.flac,.aif,.aiff,.mp3,.ogg" multiple onFile={(f) => void load(f)} icon="upload">
          Load SFZ / samples…
        </FileButton>
        <span className="small dim">An .sfz file with its samples, or loose WAVs named by root note (e.g. Violin_A3.wav). Loaded for this session.</span>
        {st.loading && <Spinner />}
      </div>
      {st.error && <div className="callout danger small">{st.error}</div>}
      {st.instruments.length > 0 && (
        <table className="table" aria-label="Loaded sample instruments">
          <thead>
            <tr>
              <th>Instrument</th>
              <th className="num">Zones</th>
              <th className="num">Keys</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {st.instruments.map((i) => (
              <tr key={i.id}>
                <td>{i.name}</td>
                <td className="num">{i.zones}</td>
                <td className="num">
                  {i.keyRange[0]}–{i.keyRange[1]}
                </td>
                <td className="small dim ellipsis" style={{ maxWidth: 260 }} title={i.origin}>
                  {i.origin}
                </td>
                <td className="num">
                  <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${i.name}`} onClick={() => removeSampleInstrument(i.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table className="table" aria-label="Sample instrument assignments">
        <thead>
          <tr>
            <th>Track</th>
            <th>Instrument</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((t) => {
            const viaPlugin = ext.instruments.find((p) => p.id === t.instrumentId && p.patchId?.startsWith('sfz:'));
            return (
              <tr key={t.id}>
                <td>
                  <span className="pd-dot" style={{ background: t.color }} /> {t.name}
                </td>
                <td>
                  <Select
                    size="sm"
                    value={st.assignments[t.id] ?? ''}
                    onChange={(v) => assignSampleInstrument(t.id, v || null)}
                    options={[{ value: '', label: viaPlugin ? `Its plugin instrument (${viaPlugin.name})` : `Built-in (${t.instrumentId})` }, ...options]}
                    aria-label={`Sample instrument for ${t.name}`}
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

interface PendingImport {
  file: File;
  group: StemGroup;
  attestation: PendingAttestation;
}

function ExternalPanel({ song, busy, onStarted }: { song: Song; busy: boolean; onStarted: (id: string) => void }) {
  const project = useStudio((s) => s.project)!;
  const [pending, setPending] = useState<PendingImport[]>([]);
  const [decoding, setDecoding] = useState(false);
  const source = useMemo(() => productionSourceSong(song), [song]);
  const groups = useMemo(() => {
    const tracks = audibleSourceTracks(source).filter((t) => t.kind === 'midi');
    return STEM_GROUP_ORDER.map((g) => ({ group: g, tracks: tracks.filter((t) => (t.stemGroup || 'others') === g) })).filter((g) => g.tracks.length);
  }, [source]);

  const exportMidi = () => {
    const files: Record<string, Uint8Array> = {};
    const enc = (s: string) => new TextEncoder().encode(s);
    for (const g of groups) files[`${g.group}_stem.mid`] = songToMidi(source, { trackIds: g.tracks.map((t) => t.id) });
    files['full_song.mid'] = songToMidi(source);
    files['tempo_map.csv'] = enc(tempoMapCsv(source));
    files['markers.csv'] = enc(markersCsv(source));
    files['README.txt'] = enc(
      [
        `${song.title} — per-stem MIDI for external rendering (Song Deck guide render, spec §28)`,
        '',
        'Render every *_stem.mid from bar 1 with your instruments, at the song tempo (tempo_map.csv),',
        'and export one WAV per stem starting exactly at bar 1. Then use “Import rendered stems” in',
        'Produce → Guide render and map each WAV to its stem group:',
        '',
        ...groups.map((g) => `  ${g.group}_stem.mid  →  ${GUIDE_STEM_FILES[g.group].file}   (${g.tracks.map((t) => t.name).join(', ')})`),
      ].join('\n'),
    );
    deliverFile(`${songFileBase(song)} - stem MIDI.zip`, zipSync(files), MIME.zip, { detail: `${groups.length} stem MIDI files for external rendering` });
  };

  const addFiles = async (files: File[]) => {
    try {
      const uploads = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      const attested = await requestAttestation(uploads, { context: 'guide-stems', purpose: 'Import rendered stems as the guide' });
      if (!attested) return useStudio.getState().toast('info', 'Stem import cancelled.');
      setPending((p) => [...p, ...files.map((file, i) => ({ file, group: guessGroup(file.name), attestation: attested[i] }))]);
    } catch (err) {
      useStudio.getState().toast('error', `Could not read the files: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const importNow = async () => {
    if (!pending.length) return;
    setDecoding(true);
    try {
      const stems = [];
      for (const p of pending) stems.push({ fileName: p.file.name, group: p.group, audio: await decodeAudioBytes(new Uint8Array(await p.file.arrayBuffer())) });
      const stageId = stageExternalStems(stems);
      for (const p of pending) recordAttestation(p.attestation);
      const t = startTask<GuideImportInput, GuideOutput>('produce.guideImport', `Import ${stems.length} rendered stem${stems.length === 1 ? '' : 's'} as guide`, { projectId: project.meta.id, stageId });
      onStarted(t.id);
      setPending([]);
    } catch (err) {
      useStudio.getState().toast('error', `Could not read the files: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDecoding(false);
    }
  };

  return (
    <div className="pd-steps2">
      <div className="card col">
        <div className="row between">
          <strong>1 · Export per-stem MIDI</strong>
          <Button icon="download" onClick={exportMidi}>
            Export stem MIDI (.zip)
          </Button>
        </div>
        <div className="small muted">
          One MIDI file per stem group ({groups.map((g) => g.group).join(', ')}) plus the full song, tempo map and section markers — render them with your VSTs,
          sample libraries or hardware.
        </div>
      </div>
      <div className="card col">
        <div className="row between">
          <strong>2 · Import rendered stems</strong>
          <FileButton accept="audio/*,.wav,.flac,.aif,.aiff,.mp3,.ogg" multiple onFile={(f) => void addFiles(f)} icon="upload">
            Choose WAV files…
          </FileButton>
        </div>
        {pending.length ? (
          <>
            <table className="table" aria-label="Rendered stems to import">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Stem group</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((p, i) => (
                  <tr key={`${p.file.name}-${i}`}>
                    <td className="ellipsis mono small" style={{ maxWidth: 240 }}>
                      {p.file.name}
                    </td>
                    <td>
                      <Select size="sm" value={p.group} onChange={(g) => setPending((all) => all.map((x, j) => (j === i ? { ...x, group: g } : x)))} options={GROUP_OPTIONS} aria-label={`Stem group for ${p.file.name}`} />
                    </td>
                    <td className="num">
                      <Button size="sm" variant="ghost" icon="close" aria-label={`Remove ${p.file.name}`} onClick={() => setPending((all) => all.filter((_, j) => j !== i))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row">
              <Button variant="primary" icon="upload" disabled={busy || decoding} onClick={() => void importNow()}>
                {decoding ? 'Reading files…' : `Import ${pending.length} stem${pending.length === 1 ? '' : 's'} as guide`}
              </Button>
              <span className="small dim">Stems are aligned at bar 1; several files per group are summed. The guide mix is built through your master bus.</span>
            </div>
          </>
        ) : (
          <div className="small dim">Map each rendered WAV to a stem group; it becomes that group’s reference (drums_reference.wav …) and the guide mix is rebuilt from them.</div>
        )}
      </div>
    </div>
  );
}

export function GuidePanel({ song }: { song: Song }) {
  const project = useStudio((s) => s.project)!;
  const ui = useProduceUi();
  const guideTask = useTaskRecord(ui.guideTaskId);
  const busy = isTaskActive(guideTask);
  const assignments = useSampleInstruments((s) => s.assignments);
  const source = useMemo(() => productionSourceSong(song), [song]);
  const tracks = useMemo(() => audibleSourceTracks(source), [source]);
  const groups = STEM_GROUP_ORDER.filter((g) => tracks.some((t) => (t.stemGroup || 'others') === g));
  const view = useMemo(() => guideView(project, song), [project, song]);
  const markers = useMemo(() => sectionMarkers(source), [source]);
  const prefs = useSettings((s) => s.exportPrefs);

  const render = () => {
    const renderer = ui.guideRenderer === 'sampled' ? 'sampled' : 'builtin';
    const t = startTask<GuideInput, GuideOutput>('produce.guide', `Render guide (${GUIDE_RENDERERS[renderer].label})`, {
      projectId: project.meta.id,
      renderer,
      vocalTone: ui.vocalTone,
      assignments: renderer === 'sampled' ? assignments : undefined,
      sampleRate: prefs.sampleRate,
      bitDepth: 16,
    });
    ui.set({ guideTaskId: t.id });
  };

  const superseded = useMemo(() => {
    const current = new Set([song.production.guideMixAssetId, ...Object.values(song.production.guideStemAssetIds ?? {})]);
    const referenced = new Set<string>();
    for (const p of project.meta.provenance) for (const s of p.sources) referenced.add(s.ref);
    for (const t of song.tracks) for (const c of t.clips) referenced.add(c.assetId);
    return project.meta.assets.filter((a) => a.kind === 'guide-render' && !current.has(a.id) && !referenced.has(a.id));
  }, [project, song]);

  const removeSuperseded = async () => {
    const st = useStudio.getState();
    const ok = await st.requestConfirm({
      kind: 'generic',
      title: 'Remove superseded guide renders?',
      body: { message: `${superseded.length} earlier guide file(s), ${fmtBytes(superseded.reduce((n, a) => n + a.bytes, 0))}. Nothing references them; older revisions that pointed at them will show the audio as missing.`, confirmLabel: 'Remove' },
    });
    if (!ok) return;
    for (const a of superseded) await assetStore.remove(a.id);
    st.updateProject((p) => superseded.reduce((acc, a) => removeAsset(acc, a.id), p));
    st.toast('success', `Removed ${superseded.length} superseded guide file(s)`);
  };

  const deckSources: DeckSource[] = [
    ...(view.mix ? [{ key: 'guide:mix', label: 'Mix', sub: GUIDE_MIX_FILE, assetId: view.mix.meta.id, tone: 'guide' as const }] : []),
    ...view.stems.map((s) => ({ key: `guide:${s.group}`, label: GUIDE_STEM_FILES[s.group].label, sub: s.meta.name, assetId: s.meta.id, tone: 'stem' as const })),
  ];

  const download = async (meta: AudioAssetMeta) => {
    const bytes = await assetStore.bytes(meta);
    if (bytes) deliverFile(meta.name, bytes, meta.mimeType || MIME.wav, { detail: 'Guide render' });
  };

  return (
    <div className="pd-grid">
      <div className="panel">
        <div className="panel-header">
          <Icon name="music" />
          <h3 className="grow">Renderer</h3>
          <span className="small dim">
            {tracks.length} tracks → {GUIDE_MIX_FILE} + {groups.length} reference stems
          </span>
        </div>
        <div className="panel-body col">
          <RendererCards value={ui.guideRenderer} onChange={(r) => ui.set({ guideRenderer: r })} />
          {ui.guideRenderer === 'external' ? (
            <ExternalPanel song={song} busy={busy} onStarted={(id) => ui.set({ guideTaskId: id })} />
          ) : (
            <>
              {ui.guideRenderer === 'sampled' && <SampleInstrumentsPanel song={song} />}
              <div className="row wrap">
                <Field label="Vocal melody reference">
                  <Select
                    value={ui.vocalTone}
                    onChange={(v) => ui.set({ vocalTone: v })}
                    options={[
                      { value: 'singer', label: 'Built-in singer (placeholder vocal with lyrics)' },
                      { value: 'melody', label: 'Clean melody tone (pitch reference)' },
                    ]}
                    aria-label="Vocal melody reference"
                  />
                </Field>
                <Field label="Format">
                  <div className="small muted" style={{ height: 30, display: 'flex', alignItems: 'center' }}>
                    {prefs.sampleRate / 1000} kHz · 16-bit WAV · reference quality
                  </div>
                </Field>
                <div className="spacer" />
                <Button variant="primary" size="lg" icon="play" onClick={render} disabled={busy || !tracks.length}>
                  {busy ? 'Rendering…' : view.mix ? 'Re-render guide' : 'Render guide'}
                </Button>
              </div>
            </>
          )}
          <TaskLine id={ui.guideTaskId} onDone={() => useStudio.getState().toast('success', 'Guide rendered: guide_mix.wav and reference stems are in the project')} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <Icon name="waveform" />
          <h3 className="grow">Guide render</h3>
          {view.mix ? (
            view.stale ? (
              <Badge tone="warning" title="The composition or mix changed since this guide was rendered">
                out of date
              </Badge>
            ) : (
              <Badge tone="success">up to date{view.revision ? ` · v${view.revision}` : ''}</Badge>
            )
          ) : (
            <Badge>not rendered</Badge>
          )}
          {view.renderer && <Badge tone="ai">{GUIDE_RENDERERS[view.renderer]?.label ?? view.renderer}</Badge>}
        </div>
        <div className="panel-body col">
          {view.mix ? (
            <>
              <CompareDeck owner="guide" sources={deckSources} markers={markers} title={<span className="small muted">Listen to each — switch instantly at the same position</span>} testId="guide-deck" />
              <table className="table" aria-label="Guide assets" data-testid="guide-assets">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Contents</th>
                    <th className="num">Length</th>
                    <th className="num">Size</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {[...(view.mix ? [{ group: null as StemGroup | null, meta: view.mix.meta, prov: view.mix.prov }] : []), ...view.stems].map((row) => {
                    const params = (row.prov?.parameters ?? {}) as { trackIds?: string[]; files?: string[]; renderer?: string };
                    const names = (params.trackIds ?? []).map((id) => song.tracks.find((t) => t.id === id)?.name).filter(Boolean);
                    const external = params.renderer === 'external';
                    return (
                      <tr key={row.meta.id}>
                        <td className="mono small">{row.meta.name}</td>
                        <td className="small muted ellipsis" style={{ maxWidth: 280 }} title={names.join(', ')}>
                          {row.group
                            ? `${GUIDE_STEM_FILES[row.group].label}${external && params.files?.length ? ` — rendered externally (${params.files.join(', ')})` : names.length ? ` — ${names.join(', ')}` : ''}`
                            : external
                              ? `Full guide mix (${view.stems.length} imported stem${view.stems.length === 1 ? '' : 's'}, master bus)`
                              : `Full guide mix (${names.length || tracks.length} tracks, master bus)`}
                        </td>
                        <td className="num">{mmss(row.meta.durationSeconds)}</td>
                        <td className="num">{fmtBytes(row.meta.bytes)}</td>
                        <td className="num">
                          <Button size="sm" variant="ghost" icon="download" aria-label={`Download ${row.meta.name}`} onClick={() => void download(row.meta)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="row small dim">
                <Icon name="info" size={13} /> Rendered {relTime(view.mix.meta.createdAt)} by {view.mix.prov?.providerName ?? 'the guide renderer'} — every file carries provenance (song revision, tracks,
                renderer, format).
                {superseded.length > 0 && (
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => void removeSuperseded()}>
                    Remove {superseded.length} superseded file{superseded.length === 1 ? '' : 's'}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="pd-empty">
              <Icon name="waveform" size={26} />
              <div>
                <strong>No guide yet.</strong> Render the composition into <span className="mono">guide_mix.wav</span> and per-instrument references — they are the input of
                Strategy A and the reference you compare productions against.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
