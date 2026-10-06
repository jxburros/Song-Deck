import { useMemo, useState } from 'react';
import {
  BUILTIN_INSTRUMENTS,
  channelFor,
  colorForRole,
  hasAttachedMidi,
  type MasteringTarget,
  type Song,
  type Track,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useCustomInstruments } from '../../hooks';
import { getRegistry, getRouter, useAiRuntime } from '../../engine/ai';
import { prototypeTargets, queuePrototype } from '../../engine/prototype';
import { allTargets, currentMaster, fmtLufs } from '../../engine/mix-mastering';
import { Badge, Button, Select } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { useRuntime } from '../../engine/runtime';
import { isTaskActive, useTaskRecord } from '../../engine/mix-tasks';
import { setChannel } from '../workbench/tracks';
import {
  adoptCandidate,
  adoptedCandidateId,
  provideProducedAudio,
  removeProducedAudio,
} from '../produce/adopt';
import { useProduceUi } from '../produce/state';
import { openMixTab } from '../mix/MixMode';
import { openSettings } from '../settings/nav';
import { PlaySwitch } from '../shared/AudioMidiPanel';
import { setAudioMidiInstrument } from '../../engine/audio-midi';
import './sound.css';

/**
 * Sound: how the song sounds and how loud each part is. Instrument or voice per track, mute, solo
 * and level; the built-in instruments or an AI audio version; and one Finish switch for loudness.
 * The full console, production plan and mastering report are in More tools.
 */

const MIN_DB = -40;
const MAX_DB = 6;

function TrackLevel({ song, track }: { song: Song; track: Track }) {
  const st = useStudio.getState();
  const customInstruments = useCustomInstruments();
  const ch = channelFor(song, track.id);
  const [db, setDb] = useState<number | null>(null);
  const value = db ?? ch.volumeDb;
  const instruments = useMemo(
    () => [
      ...customInstruments,
      ...BUILTIN_INSTRUMENTS.filter((b) => !customInstruments.some((c) => c.id === b.id)),
    ],
    [customInstruments],
  );
  const commitDb = (v: number) => {
    setDb(null);
    if (Math.abs(v - ch.volumeDb) < 0.01) return;
    st.commit(setChannel(song, track.id, { volumeDb: v }), `Set ${track.name} to ${v.toFixed(1)} dB`, 'mix');
  };
  return (
    <div className="sound-row" data-testid="sound-track">
      <span className="sound-name">
        <span className="sound-swatch" style={{ background: track.color || colorForRole(track.role) }} />
        <span className="ellipsis">{track.name}</span>
      </span>
      {track.kind === 'midi' ? (
        <Select
          aria-label={`${track.name} sound`}
          value={track.instrumentId}
          onChange={(instrumentId) =>
            st.commit(
              {
                ...song,
                tracks: song.tracks.map((t) => (t.id === track.id ? { ...t, instrumentId } : t)),
              },
              `${track.name} now plays ${instruments.find((i) => i.id === instrumentId)?.name ?? instrumentId}`,
              'mix',
            )
          }
          options={instruments.map((i) => ({ value: i.id, label: i.name }))}
        />
      ) : hasAttachedMidi(track) ? (
        // An audio track with MIDI made from it: play the recording or the MIDI on an instrument.
        <span className="row" style={{ gap: 6, minWidth: 0 }}>
          <PlaySwitch track={track} size="sm" />
          {track.audioMidi.play === 'midi' ? (
            <Select
              size="sm"
              aria-label={`${track.name} MIDI sound`}
              value={track.audioMidi.instrumentId}
              onChange={(instrumentId) => setAudioMidiInstrument(track.id, instrumentId)}
              options={instruments.map((i) => ({ value: i.id, label: i.name }))}
            />
          ) : (
            <span className="small muted ellipsis">
              {track.audioMidi.tuning?.enabled && track.audioMidi.mode === 'melody' ? 'Tuned audio' : 'Audio'}
            </span>
          )}
        </span>
      ) : (
        <span className="small muted">Audio · {track.clips.length} clips</span>
      )}
      <span className="row" style={{ gap: 4 }}>
        <button
          type="button"
          className={`ms-btn mute ${ch.mute ? 'on' : ''}`}
          aria-pressed={ch.mute}
          aria-label={`Mute ${track.name}`}
          title="Mute"
          onClick={() =>
            st.commit(
              setChannel(song, track.id, { mute: !ch.mute }),
              `${ch.mute ? 'Unmuted' : 'Muted'} ${track.name}`,
              'mix',
            )
          }
        >
          M
        </button>
        <button
          type="button"
          className={`ms-btn solo ${ch.solo ? 'on' : ''}`}
          aria-pressed={ch.solo}
          aria-label={`Solo ${track.name}`}
          title="Solo"
          onClick={() =>
            st.commit(
              setChannel(song, track.id, { solo: !ch.solo }),
              `${ch.solo ? 'Unsoloed' : 'Soloed'} ${track.name}`,
              'mix',
            )
          }
        >
          S
        </button>
      </span>
      <input
        type="range"
        className="slider accent"
        min={MIN_DB}
        max={MAX_DB}
        step={0.5}
        value={Math.max(MIN_DB, value)}
        aria-label={`${track.name} level`}
        aria-valuetext={`${value.toFixed(1)} dB`}
        onChange={(e) => setDb(parseFloat(e.target.value))}
        onPointerUp={(e) => commitDb(parseFloat((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => commitDb(parseFloat((e.target as HTMLInputElement).value))}
      />
      <span className="mono small muted sound-db">{value.toFixed(1)} dB</span>
    </div>
  );
}

export default function SoundMode() {
  const project = useStudio((s) => s.project);
  const song = project?.song ?? null;
  useAiRuntime((s) => s.version);
  const productionTaskId = useRuntime((s) => {
    const tasks = s.tasks.filter(
      (t) =>
        t.type === 'produce.candidate' &&
        (t.input as { projectId?: string } | undefined)?.projectId === project?.meta.id,
    );
    return (tasks.find(isTaskActive) ?? tasks.at(-1))?.id;
  });
  const productionTask = useTaskRecord(productionTaskId);
  const making = isTaskActive(productionTask);
  if (!project || !song) return null;
  const st = useStudio.getState();
  const targets = prototypeTargets(getRegistry(), getRouter(), song);
  const candidates = song.production?.candidates ?? [];
  const adopted = adoptedCandidateId(song);
  const master = currentMaster(project, song);
  const m = song.mastering;
  const polish = m.method !== 'none';

  const adoptVersion = (id: string) => {
    const cur = useStudio.getState().project!;
    const c = cur.song.production.candidates.find((x) => x.id === id);
    if (!c) return;
    try {
      const r = adoptCandidate(cur.song, c, cur.meta.assets);
      st.commit(r.song, `Using audio version ${c.label}`, 'production');
      void provideProducedAudio(r.song);
      st.toast('success', `Version ${c.label} is now what you hear. The MIDI tracks stay, muted.`);
    } catch (err) {
      st.toast('error', err instanceof Error ? err.message : String(err));
    }
  };
  const backToBuiltIn = () =>
    st.commit(
      removeProducedAudio(song),
      'Back to the built-in instruments (MIDI tracks unmuted)',
      'production',
    );
  const makeVersion = () => {
    try {
      const id = queuePrototype(project.meta.id, 'auto', song.generation?.seed ?? Date.now() % 99999999);
      useProduceUi.getState().set({ batchTaskIds: [id] });
      st.toast('info', 'Making a realistic version. It appears here when it is ready.');
    } catch (err) {
      st.toast('error', err instanceof Error ? err.message : String(err));
    }
  };
  const setMastering = (patch: Partial<typeof m>, message: string) =>
    st.commit({ ...song, mastering: { ...song.mastering, ...patch } }, message, 'mix');

  return (
    <div className="area-page sound-page">
      <div className="area-body sound-body">
        <div className="sound-main col">
          <section className="panel" aria-labelledby="levels-h">
            <div className="right-head">
              <h2 id="levels-h">Instruments and levels</h2>
              <Button variant="ai" icon="sparkles" onClick={() => openMixTab('console')}>
                Suggest a balance
              </Button>
            </div>
            <div className="sound-rows">
              {song.tracks.map((t) => (
                <TrackLevel key={t.id} song={song} track={t} />
              ))}
            </div>
          </section>

          <section className="panel" aria-labelledby="finish-h">
            <div className="right-head">
              <h2 id="finish-h">Finish</h2>
              <span className="small dim grow">Evens out the final mix and sets its loudness.</span>
            </div>
            <div className="panel-body row wrap" style={{ gap: 16 }}>
              <label className="row" style={{ gap: 10, minHeight: 40 }}>
                <input
                  type="checkbox"
                  checked={polish}
                  onChange={(e) =>
                    setMastering(
                      { method: e.target.checked ? 'builtin' : 'none' },
                      e.target.checked ? 'Polish for release' : 'Export without mastering',
                    )
                  }
                />
                Polish for release
              </label>
              <Select
                aria-label="Loudness target"
                value={m.target}
                disabled={!polish}
                onChange={(target: MasteringTarget) =>
                  setMastering({ target }, `Mastering target: ${target}`)
                }
                options={allTargets().map((t) => ({ value: t.id, label: `${t.label} · ${t.lufs} LUFS` }))}
              />
              <div className="spacer" />
              {master?.report && (
                <span className="mono small muted">
                  Last master {fmtLufs(master.report.integratedLufs)}
                  {master.stale ? ' · out of date' : ''}
                </span>
              )}
              <Button icon="wave" disabled={!polish} onClick={() => openMixTab('mastering')}>
                {master ? 'Master again' : 'Master it now'}
              </Button>
            </div>
          </section>
        </div>

        <aside className="panel sound-aside" aria-labelledby="hear-h">
          <div className="right-head">
            <h2 id="hear-h">What you hear</h2>
          </div>
          <div className="panel-body col" style={{ gap: 10 }}>
            <span className="small dim">Pick the sound used when you play and export.</span>
            <div className={`version ${adopted ? '' : 'on'}`}>
              <Icon name="midi" />
              <span className="col grow" style={{ gap: 0 }}>
                <strong>Built-in instruments</strong>
                <span className="small dim">Always matches your latest notes</span>
              </span>
              {adopted ? (
                <Button size="sm" onClick={backToBuiltIn}>
                  Use this
                </Button>
              ) : (
                <span className="scope-chip">In use</span>
              )}
            </div>
            {candidates.map((c) => (
              <div key={c.id} className={`version ${adopted === c.id ? 'on' : ''}`}>
                <Icon name="wave" />
                <span className="col grow" style={{ gap: 0 }}>
                  <strong>Version {c.label}</strong>
                  <span className="small dim">
                    {Object.keys(c.stemAssetIds).length
                      ? `${Object.keys(c.stemAssetIds).length} stems`
                      : 'Full mix'}
                    {c.rating ? ` · ${'★'.repeat(c.rating)}` : ''}
                  </span>
                </span>
                {adopted === c.id ? (
                  <span className="scope-chip">In use</span>
                ) : (
                  <Button size="sm" onClick={() => adoptVersion(c.id)}>
                    Use this
                  </Button>
                )}
              </div>
            ))}
            {candidates.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                icon="eye"
                onClick={() => {
                  useProduceUi.getState().set({ tab: 'candidates' });
                  st.setMode('produce');
                }}
              >
                Compare, rate and inspect versions
              </Button>
            )}
          </div>
          <div className="panel-body col sound-make" style={{ gap: 8 }}>
            {productionTask && (making || productionTask.status === 'failed') && (
              <>
                <span className="small" role={making ? 'status' : 'alert'}>
                  {making
                    ? (productionTask.message ?? 'Making your audio version…')
                    : (productionTask.error ?? 'The audio version could not be made.')}
                </span>
                <Button size="sm" onClick={() => st.setTaskDrawer(true)}>
                  Open generation queue
                </Button>
              </>
            )}
            {targets.length > 0 ? (
              <>
                <Button variant="ai" size="lg" icon="wave" disabled={making} onClick={makeVersion}>
                  Make a realistic version
                </Button>
                <span className="small dim">Follows your notes. Your audio service may charge for this.</span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="sliders"
                  onClick={() => {
                    useProduceUi.getState().set({ tab: 'production' });
                    st.setMode('produce');
                  }}
                >
                  Production plan and options
                </Button>
              </>
            ) : (
              <>
                <span className="small muted">
                  Connect an audio model to make realistic versions of this song.
                </span>
                <Button variant="ai" icon="plug" onClick={() => openSettings('providers', 'connect')}>
                  Connect AI
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="sliders"
                  onClick={() => {
                    useProduceUi.getState().set({ tab: 'guide' });
                    st.setMode('produce');
                  }}
                >
                  Guide sound and sample instruments
                </Button>
              </>
            )}
            {adopted && <Badge tone="accent">Produced audio is playing; the MIDI is muted</Badge>}
          </div>
        </aside>
      </div>
    </div>
  );
}
