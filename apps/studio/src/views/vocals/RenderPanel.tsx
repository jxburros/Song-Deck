import { useEffect, useMemo, useState } from 'react';
import { createTimeMap, randomSeed, type Project, type Track, type VocalRender } from '@songdeck/core';
import type { VoiceInfo } from '@songdeck/ai';
import { useStudio } from '../../state/store';
import { getRegistry, useAiRuntime } from '../../engine/ai';
import {
  activeRender,
  applyVocalMonitoring,
  builtInVoices,
  consentSummary,
  formatBars,
  lyricsOfTrack,
  projectVoiceChoices,
  providerVoiceChoices,
  provenanceOf,
  resolveVoice,
  staleSections,
  VOICE_KIND_LABEL,
  type VoiceChoice,
} from '../../engine/vocal-model';
import { enqueueRender, resingStaleSections, useVocalJobs } from '../../engine/vocal-sync';
import { withRenderClip } from '../../engine/vocal-render';
import { Badge, Button, Field, Kv, NumberInput, Select } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ProviderPicker } from '../shared/ProviderPicker';
import { useVocalSession } from './session';
import { AssetAudition, TaskLine, assetById, discoverVoicesOnce, locationBadge, playFrom, useResolvedProvider } from './shared';
import { VoiceModelModal, adoptProviderVoice, chooseSingingVoice, providerName, type VoiceModalRequest } from './VoicesPanel';

/**
 * Render vocals (spec §34): the chosen SINGING_SYNTHESIS provider (on-device formant singer by
 * default) sings the vocal track from lyrics, phonemes, MIDI melody, tempo, expression, voice and
 * dynamics → lead_vocal-vN.wav, a VocalRender, and the "<Vocal> (render)" audio track that Mix &
 * Master mixes like any stem. Provenance follows the spec §64 example.
 */

function useSingerVoices(project: Project, providerId: string | undefined): VoiceChoice[] {
  const version = useAiRuntime((s) => s.version);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const builtin = !providerId || providerId === 'internal-singer';
  useEffect(() => {
    if (builtin || !providerId) return;
    let alive = true;
    const reg = getRegistry();
    setVoices(reg.voices(providerId));
    void discoverVoicesOnce(providerId).then(() => alive && setVoices(reg.voices(providerId)));
    return () => {
      alive = false;
    };
  }, [providerId, builtin, version]);
  return useMemo(() => {
    if (builtin) return builtInVoices();
    const listed = providerVoiceChoices(project, providerId!, voices);
    const extra = projectVoiceChoices(project).filter((v) => v.providerId === providerId && !listed.some((l) => l.key === v.key));
    return [...listed, ...extra];
  }, [builtin, providerId, voices, project]);
}

function RenderHistory({ project, track }: { project: Project; track: Track }) {
  const song = project.song;
  const st = useStudio.getState();
  const current = activeRender(project, track.id);
  const renders = song.vocals.renders.filter((r) => r.trackId === track.id).slice().reverse();
  if (!renders.length) return null;
  const use = (r: VocalRender) => {
    const meta = assetById(project, r.assetId);
    const cur = useStudio.getState().project?.song;
    if (!meta || !cur) return;
    const next = withRenderClip(cur, { midiTrackId: track.id, assetId: r.assetId, durationSeconds: meta.durationSeconds, clipName: meta.name });
    const mode = cur.vocals.mode === 'none' || cur.vocals.mode === 'melody-only' || cur.vocals.mode === 'recorded' ? 'ai-singer' : cur.vocals.mode;
    st.commit(applyVocalMonitoring({ ...next, vocals: { ...next.vocals, mode } }, track.id).song, `Using ${meta.name} as the ${track.name} render`, 'vocals');
  };
  return (
    <div className="panel">
      <div className="panel-header">
        <Icon name="history" />
        <h3 className="grow">Render history</h3>
        <span className="small dim">{renders.length} renders · every render keeps its provenance</span>
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        <table className="table" aria-label="Vocal renders">
          <thead>
            <tr>
              <th>File</th>
              <th>Covers</th>
              <th>Provider · voice</th>
              <th className="num">Seed</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {renders.map((r) => {
              const meta = assetById(project, r.assetId);
              const prov = provenanceOf(project, meta);
              const whole = !r.sectionId && !r.phraseId && r.startTick === 0;
              const kind = (prov?.parameters as { renderKind?: string } | undefined)?.renderKind;
              const isActive = current?.clip.assetId === r.assetId;
              const sectionName = r.sectionId ? song.sections.find((s) => s.id === r.sectionId)?.name : undefined;
              return (
                <tr key={r.id} data-testid="render-row">
                  <td>
                    <div className="mono small" style={{ fontWeight: 600 }}>
                      {meta?.name ?? r.assetId}
                    </div>
                    <div className="small dim">{kind === 'splice' ? 'spliced re-sing' : kind === 'phrase' ? 'phrase render' : kind === 'conversion' ? 'voice conversion' : 'full render'}</div>
                  </td>
                  <td className="small">{whole ? 'Whole vocal' : `${sectionName ?? 'Phrase'} · ${formatBars(song, r.startTick, r.endTick)}`}</td>
                  <td className="small">
                    {prov?.providerName ?? providerName(r.providerId)} · {resolveVoice(project, r.voiceId, track).name}
                  </td>
                  <td className="num small">{r.seed}</td>
                  <td className="small">{new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                  <td style={{ textAlign: 'right' }}>
                    {isActive ? (
                      <Badge tone="accent">in use</Badge>
                    ) : whole && meta ? (
                      <Button size="sm" variant="ghost" onClick={() => use(r)}>
                        Use
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CurrentRender({ project, track, selectedVoice }: { project: Project; track: Track; selectedVoice: VoiceChoice }) {
  const song = project.song;
  const st = useStudio.getState();
  const current = activeRender(project, track.id);
  if (!current) {
    return (
      <div className="card vx-empty-render" data-testid="no-render">
        <Icon name="waveform" size={22} />
        <div>
          <strong>No vocal render yet.</strong>
          <div className="small muted">Playback sings the vocal live with the guide singer. Render to get {track.name.toLowerCase().replace(/\s+/g, '_')}.wav as an audio track you can mix.</div>
        </div>
      </div>
    );
  }
  const params = (current.provenance?.parameters ?? {}) as Record<string, unknown>;
  const renderVoice = current.render?.voiceId ?? current.rendered?.voiceKey;
  const stale = staleSections(song, track, current.rendered, renderVoice ?? selectedVoice.key);
  const voiceChanged = !!renderVoice && renderVoice !== selectedVoice.key;
  const prov = current.provenance;
  return (
    <div className="card col" style={{ gap: 8 }} data-testid="current-render">
      <div className="row between">
        <div className="row" style={{ minWidth: 0 }}>
          <Icon name="waveform" />
          <strong className="ellipsis">{current.track.name}</strong>
          <Badge tone="accent">{current.asset?.name ?? 'render'}</Badge>
          {typeof params.renderKind === 'string' && params.renderKind !== 'full' && <Badge>{params.renderKind === 'splice' ? 'spliced' : String(params.renderKind)}</Badge>}
        </div>
        <div className="row">
          <Button size="sm" icon="play" onClick={() => playFrom(0)} title="Play the song with this vocal">
            Play song
          </Button>
          <Button size="sm" variant="ghost" icon="mixer" onClick={() => st.setMode('mix')} title="Mix the render in Mix & Master">
            Mix
          </Button>
        </div>
      </div>
      <AssetAudition meta={current.asset} height={44} label={current.asset?.name} />
      <Kv
        items={[
          ['Source', String(params.source ?? '—')],
          ['Provider', prov ? `${prov.providerName}${prov.cloud ? ' (cloud)' : ' (on-device)'}` : '—'],
          ['Model / voice', `${prov?.modelId ?? '—'} · ${String(params.voiceName ?? resolveVoice(project, renderVoice, track).name)}`],
          ['Seed', String(prov?.seed ?? current.render?.seed ?? '—')],
          ['Generated', prov ? new Date(prov.generatedAt).toLocaleString() : '—'],
        ]}
      />
      {voiceChanged ? (
        <div className="callout warning small">
          The selected voice is <strong>{selectedVoice.name}</strong>, but this render was sung by <strong>{resolveVoice(project, renderVoice, track).name}</strong> — render again to
          hear the new voice.
        </div>
      ) : stale.sections.length > 0 ? (
        <div className="callout warning small row wrap" data-testid="stale-render">
          <span className="grow">
            {stale.reason === 'timing' ? 'Tempo or meter changed since this render — ' : ''}
            Changed since this render: <strong>{stale.sections.map((s) => s.section.name).join(', ')}</strong>.
          </span>
          <Button
            size="sm"
            variant="primary"
            icon="waveform"
            onClick={() => {
              const ids = resingStaleSections(project.meta.id, track.id);
              st.toast('info', ids.length ? `Re-singing ${ids.length} section${ids.length === 1 ? '' : 's'} — the rest of the render is kept.` : 'Nothing to re-sing.');
            }}
          >
            Re-sing changed sections
          </Button>
        </div>
      ) : (
        <div className="small" style={{ color: 'var(--success)' }}>
          <Icon name="check" size={12} /> In sync with the vocal MIDI, lyrics and expression.
        </div>
      )}
    </div>
  );
}

export function RenderPanel({ project, track }: { project: Project; track: Track }) {
  const song = project.song;
  const st = useStudio.getState();
  const session = useVocalSession();
  const placeholderMode = song.vocals.mode === 'placeholder';
  const choice = placeholderMode ? 'internal' : session.singerProvider;
  const singer = useResolvedProvider('vocals', choice);
  const voices = useSingerVoices(project, singer?.providerId);
  const current = resolveVoice(project, song.vocals.voiceId, track);
  const fallback = singer?.providerId === 'internal-singer' || !singer?.providerId ? resolveVoice(project, undefined, track) : voices[0];
  const selected = voices.find((v) => v.key === current.key) ?? fallback ?? current;
  const [modal, setModal] = useState<VoiceModalRequest | null>(null);
  const activity = useVocalJobs((s) => s.activity);
  const latestTask = activity.find((a) => (a.kind === 'render' || a.kind === 'resing') && a.taskId)?.taskId ?? session.tasks.render;
  const lines = lyricsOfTrack(song, track.id).length;
  const syllables = track.notes.filter((n) => n.syllable && n.syllable !== '_').length;
  const expressive = track.notes.filter((n) => n.expression && Object.keys(n.expression).length).length;
  const bpm = Math.round(createTimeMap(song).bpmAt(0));

  const pickVoice = (key: string) => {
    const v = voices.find((x) => x.key === key);
    if (!v) return;
    if (v.source === 'provider' && v.kind === 'stock') return adoptProviderVoice(v, track);
    if (!v.authorized) {
      setModal(v.record ? { mode: 'attest', initial: v.record, useFor: 'singing' } : { mode: 'add', initial: { id: v.key, name: v.name, kind: v.kind, providerId: v.providerId, modelRef: v.ref, voiceType: v.voiceType }, useFor: 'singing' });
      return;
    }
    chooseSingingVoice(track, v.key, v.name);
  };

  const render = async () => {
    const voice = selected;
    if (!voice.authorized) {
      setModal(voice.record ? { mode: 'attest', initial: voice.record, useFor: 'singing' } : { mode: 'add', initial: { name: voice.name, kind: voice.kind, providerId: voice.providerId, modelRef: voice.ref }, useFor: 'singing' });
      return;
    }
    if (voice.kind !== 'stock') {
      const ok = await st.requestConfirm({
        kind: 'consent',
        title: `Sing with “${voice.name}”?`,
        body: {
          message: `${voice.name} is a ${VOICE_KIND_LABEL[voice.kind].toLowerCase()} voice. Rendering clones it onto this vocal; the attestation below is recorded in the render's provenance.`,
          warning: consentSummary(voice.consent),
          confirmLabel: 'Render',
        },
      });
      if (!ok) return;
    }
    if (song.vocals.voiceId !== voice.key) chooseSingingVoice(track, voice.key, voice.name);
    const seed = session.renderSeed;
    const t = enqueueRender({ projectId: project.meta.id, trackId: track.id, voiceKey: voice.key, seed }, `Render ${track.name} — ${voice.name} (${singer?.providerName ?? 'singer'})`);
    session.set({ tasks: { ...session.tasks, render: t.id }, renderSeed: randomSeed() });
  };

  const inputs: [string, string, boolean][] = [
    ['Lyrics', lines ? `${lines} lines · ${syllables} sung syllables` : 'none — sings “la”', lines > 0],
    ['Phonemes', syllables ? 'from the syllables (G2P)' : '—', syllables > 0],
    ['MIDI melody', `${track.notes.length} notes`, track.notes.length > 0],
    ['Tempo', `${bpm} BPM`, true],
    ['Expression', `default + ${expressive} note overrides`, true],
    ['Voice', selected.name, true],
    ['Dynamics', 'note velocities', true],
  ];

  return (
    <div className="col" style={{ gap: 12 }} data-testid="render-panel">
      <div className="panel">
        <div className="panel-header">
          <Icon name="waveform" />
          <h3 className="grow">Singing synthesis</h3>
          {locationBadge(singer)}
        </div>
        <div className="panel-body col">
          <div className="vx-write-grid">
            <Field label="Singer">
              {placeholderMode ? (
                <Select value="internal" onChange={() => undefined} options={[{ value: 'internal', label: 'Built-in formant singer' }]} disabled aria-label="Singer" />
              ) : (
                <ProviderPicker role="vocals" value={session.singerProvider} onChange={(v) => session.set({ singerProvider: v })} />
              )}
            </Field>
            <Field label="Voice">
              <Select
                value={selected.key}
                onChange={pickVoice}
                options={voices.map((v) => ({ value: v.key, label: `${v.name}${v.kind !== 'stock' ? ` · ${VOICE_KIND_LABEL[v.kind]}${v.authorized ? '' : ' — consent required'}` : ''}` }))}
                aria-label="Singing voice"
              />
            </Field>
            <Field label="Seed">
              <div className="row">
                <NumberInput value={session.renderSeed} onChange={(v) => session.set({ renderSeed: Math.round(v) })} min={0} max={99999999} aria-label="Render seed" />
                <Button icon="dice" title="New seed" onClick={() => session.set({ renderSeed: randomSeed() })} />
              </div>
            </Field>
            <div className="field" style={{ justifyContent: 'flex-end' }}>
              <Button variant="primary" icon="waveform" onClick={() => void render()} disabled={!track.notes.length} data-testid="render-vocal">
                Render {track.name.toLowerCase()}
              </Button>
            </div>
          </div>
          {singer?.providerId === 'internal-singer' && (
            <div className="small muted">
              {placeholderMode ? 'Placeholder mode always uses the built-in formant singer. ' : ''}The built-in formant singer is a source–filter synthesizer: intelligible and
              expressive, but it sounds synthetic — placeholder quality. Configure a singing model (e.g. the DiffSinger bridge) in Settings for a finished vocal.
            </div>
          )}
          <div className="vx-inputs" aria-label="What the singing engine receives">
            {inputs.map(([k, v, ok]) => (
              <span key={k} className={`vx-input ${ok ? 'ok' : ''}`} title={v}>
                <Icon name={ok ? 'check' : 'minus'} size={11} /> <strong>{k}</strong> <span className="dim">{v}</span>
              </span>
            ))}
            <span className="vx-input out">
              → <strong>{track.name.toLowerCase().replace(/\s+/g, '_')}.wav</strong>
            </span>
          </div>
          {selected.kind !== 'stock' && (
            <div className={`callout ${selected.authorized ? 'success' : 'danger'} small`}>
              <Icon name="shield" size={12} /> {selected.authorized ? consentSummary(selected.consent) : 'This voice has no authorization on file — it cannot be used until you attest.'}
            </div>
          )}
          <TaskLine taskId={latestTask} />
        </div>
      </div>
      <CurrentRender project={project} track={track} selectedVoice={selected} />
      <RenderHistory project={project} track={track} />
      {modal && <VoiceModelModal project={project} track={track} request={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
