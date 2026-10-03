import { useEffect, useMemo, useState } from 'react';
import type { Song } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { assetStore } from '../../state/assets';
import { player } from '../../engine/player';
import { Badge, Button, EmptyState, Tabs } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { usePlayerState } from '../../hooks';
import { AutomationEditor } from './AutomationEditor';
import { ImportStemButton } from './ImportStem';
import { BusesPanel, Inspector } from './Inspector';
import { MasteringPanel } from './MasteringPanel';
import { MixAssistant } from './MixAssistant';
import { ChannelStripView, MasterStripView, type InspectTab } from './Strips';
import { cancelMixerDraft, useMixer } from './mixDraft';
import { MASTER } from './mixModel';
import './mix.css';

/**
 * Mix & Master mode (spec §40-§42, Phase 5 stem mixing): conventional mixer console with
 * live metering and zipper-free previews, automation, the AI Mix Assistant and modular mastering.
 */

type Tab = 'console' | 'automation' | 'mastering';

let lastTab: Tab = 'console';

/** Make every audio-track clip (stems, recordings, produced audio) available to playback. */
function useProvideAssets(song: Song | null) {
  const assets = useStudio((s) => s.project?.meta.assets);
  useEffect(() => {
    if (!song || !assets) return;
    let alive = true;
    void (async () => {
      for (const t of song.tracks) {
        if (t.kind !== 'audio') continue;
        for (const c of t.clips) {
          if (player.hasAsset(c.assetId)) continue;
          const meta = assets.find((a) => a.id === c.assetId);
          if (!meta) continue;
          try {
            const audio = await assetStore.audio(meta);
            if (alive && audio) player.provideAsset(c.assetId, audio);
          } catch {
            /* undecodable asset: the track simply stays silent */
          }
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [song?.tracks, assets, song]);
}

function Console({ song }: { song: Song }) {
  const mixer = useMixer();
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const [inspect, setInspect] = useState<string | null>(null);
  const target = inspect === MASTER ? MASTER : inspect && song.tracks.some((t) => t.id === inspect) ? inspect : selectedTrackId && song.tracks.some((t) => t.id === selectedTrackId) ? selectedTrackId : (song.tracks[0]?.id ?? MASTER);
  if (!mixer) return null;
  const select = (id: string) => {
    if (id !== target) setInspect(id);
    if (id !== MASTER && useStudio.getState().selectedTrackId !== id) useStudio.getState().selectTrack(id);
  };
  const open = (id: string, _tab: InspectTab) => {
    select(id);
    requestAnimationFrame(() => document.querySelector('.mx-inspector')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };
  return (
    <>
      <div className="panel mx-console" aria-label="Mixer console">
        <div className="mx-strips" role="list" aria-label="Channel strips">
          {song.tracks.map((t) => (
            <div role="listitem" key={t.id} style={{ display: 'contents' }}>
              <ChannelStripView song={song} mixer={mixer} track={t} selected={target === t.id} onSelect={() => select(t.id)} onOpen={(tab) => open(t.id, tab)} />
            </div>
          ))}
        </div>
        <div className="mx-master-slot">
          <MasterStripView song={song} mixer={mixer} selected={target === MASTER} onSelect={() => select(MASTER)} onOpen={(tab) => open(MASTER, tab)} />
        </div>
      </div>
      <Inspector song={song} mixer={mixer} target={target} />
      <BusesPanel song={song} mixer={mixer} />
    </>
  );
}

export default function MixMode() {
  const song = useStudio((s) => s.project?.song ?? null);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const playing = usePlayerState();
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (t: Tab) => {
    lastTab = t;
    setTabState(t);
  };
  useProvideAssets(song);
  // Leaving the mode mid-gesture must not leave a half-applied preview in the player.
  useEffect(() => () => cancelMixerDraft(), []);

  const stats = useMemo(() => {
    if (!song) return null;
    const audio = song.tracks.filter((t) => t.kind === 'audio').length;
    const lanes = song.automation.filter((l) => l.enabled && l.points.length).length;
    const locked = Object.keys(song.locks).filter((k) => k.startsWith('mixer:') && song.locks[k]).length;
    return { tracks: song.tracks.length, audio, lanes, locked };
  }, [song]);

  if (!song) return null;
  if (!song.tracks.length) {
    return (
      <EmptyState
        icon="mixer"
        title="Nothing to mix yet"
        actions={
          <>
            <Button variant="primary" icon="sparkles" onClick={() => useStudio.getState().setMode('compose')}>
              Compose
            </Button>
            <ImportStemButton />
          </>
        }
      >
        Compose a song, or import stems / audio to mix them here.
      </EmptyState>
    );
  }

  return (
    <div className="mx-page">
      <div className="mx-main">
        <div className="page-header">
          <div className="grow">
            <h1>Mix &amp; Master</h1>
            <div className="lede">
              A conventional mixer for every track — MIDI parts and audio stems alike — plus automation, an AI assistant that only ever makes ordinary mixer
              moves, and modular mastering with loudness targets.
            </div>
          </div>
          <div className="row">
            <ImportStemButton />
            <Button
              variant={playing ? 'default' : 'primary'}
              icon={playing ? 'pause' : 'play'}
              onClick={() => useStudio.getState().togglePlay()}
              title="Play / pause (Space)"
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? 'Pause' : 'Play'}
            </Button>
          </div>
        </div>
        <div className="mx-tabbar">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'console', label: 'Console', icon: 'mixer' },
              { value: 'automation', label: 'Automation', icon: 'sliders' },
              { value: 'mastering', label: 'Mastering', icon: 'wave' },
            ]}
          />
          {stats && (
            <div className="row small dim">
              <span>
                {stats.tracks} tracks{stats.audio ? ` · ${stats.audio} audio` : ''}
              </span>
              {stats.lanes > 0 && <Badge tone="ai">{stats.lanes} automation lanes</Badge>}
              {stats.locked > 0 && (
                <Badge tone="warning">
                  <Icon name="lock" size={11} /> {stats.locked} locked
                </Badge>
              )}
              <span title="Every change is a revision — undo/redo from the top bar">
                <Icon name="history" size={12} /> changes are versioned
              </span>
            </div>
          )}
        </div>
        {tab === 'console' && <Console song={song} />}
        {tab === 'automation' && <AutomationEditor song={song} defaultTarget={selectedTrackId} />}
        {tab === 'mastering' && <MasteringPanel song={song} />}
      </div>
      <aside className="mx-side" aria-label="AI Mix Assistant">
        <MixAssistant song={song} />
      </aside>
    </div>
  );
}
