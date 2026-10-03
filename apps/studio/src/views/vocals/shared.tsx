import { useEffect, useMemo, useState } from 'react';
import type { AudioAssetMeta, Project, Song, TaskRecord } from '@songdeck/core';
import type { AudioData } from '@songdeck/audio';
import { ROLE_INFO, type TaskRole } from '@songdeck/ai';
import { useStudio } from '../../state/store';
import { assetStore } from '../../state/assets';
import { player } from '../../engine/player';
import { getRegistry, getRouter, useAiRuntime } from '../../engine/ai';
import { useTask, isActive } from '../../engine/capture-tasks';
import { taskQueue } from '../../engine/runtime';
import { previewPlayer, usePreviewId, usePreviewPosition } from '../../engine/capture-playback';
import { Badge, Button, Progress, Spinner } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { Waveform } from '../transcribe/widgets';
import { formatDuration } from '../../hooks';

/** Make every audio-track clip (renders, takes, stems) available to playback. */
export function useProvideAudioAssets(song: Song | null) {
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
            /* undecodable asset: the clip stays silent */
          }
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [song?.tracks, assets, song]);
}

/** Decoded audio of an asset (for waveforms and auditioning). */
export function useAssetAudio(meta: AudioAssetMeta | undefined): AudioData | null {
  const [audio, setAudio] = useState<AudioData | null>(() => (meta ? (assetStore.decodedSync(meta.id) ?? null) : null));
  useEffect(() => {
    if (!meta) {
      setAudio(null);
      return;
    }
    let alive = true;
    const hit = assetStore.decodedSync(meta.id);
    if (hit) {
      setAudio(hit);
      return;
    }
    setAudio(null);
    void assetStore
      .audio(meta)
      .then((a) => alive && setAudio(a ?? null))
      .catch(() => alive && setAudio(null));
    return () => {
      alive = false;
    };
  }, [meta?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return audio;
}

export interface ResolvedProvider {
  providerId: string;
  providerName: string;
  location: 'cloud' | 'local' | 'internal';
  adapter?: string;
  extra?: Record<string, unknown>;
  error?: string;
}

/** Who will actually perform a role for a picker choice ('auto' → the router's pick). */
export function useResolvedProvider(role: TaskRole, choice: string): ResolvedProvider | null {
  const version = useAiRuntime((s) => s.version);
  return useMemo(() => {
    try {
      const reg = getRegistry();
      let id = choice;
      if (choice === 'internal') id = role === 'vocals' ? 'internal-singer' : role === 'lyrics' ? 'internal-composer' : '';
      if (!id || choice === 'auto') {
        const d = getRouter().select({ role });
        id = d.providerId;
      }
      const inst = reg.get(id);
      if (!inst) return { providerId: id, providerName: id, location: 'cloud', error: 'Provider not available' };
      const cfg = reg.getConfig(id);
      return { providerId: id, providerName: inst.descriptor.name, location: inst.descriptor.location, adapter: inst.descriptor.adapter, extra: cfg?.extra as Record<string, unknown> | undefined };
    } catch (err) {
      return { providerId: '', providerName: 'none', location: 'cloud', error: err instanceof Error ? err.message : String(err) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, choice, version]);
}

export function locationBadge(p: ResolvedProvider | null) {
  if (!p) return null;
  if (p.error) return <Badge tone="danger">{p.error}</Badge>;
  return (
    <Badge tone={p.location === 'cloud' ? 'warning' : p.location === 'local' ? 'ai' : 'success'} title={p.location === 'cloud' ? 'Data leaves this device (you confirm before sending)' : 'Stays on this machine'}>
      <Icon name={p.location === 'cloud' ? 'cloud' : p.location === 'local' ? 'server' : 'cpu'} size={11} />
      {p.location === 'internal' ? 'on-device' : p.location}
    </Badge>
  );
}

const discovered = new Map<string, number>();

/**
 * Ask a provider for its voices once a minute at most (discovery failures update the registry,
 * which re-renders listeners — never retry in a loop).
 */
export async function discoverVoicesOnce(providerId: string): Promise<void> {
  const last = discovered.get(providerId) ?? 0;
  if (Date.now() - last < 60_000) return;
  discovered.set(providerId, Date.now());
  try {
    await getRegistry().discoverModels(providerId);
  } catch {
    /* unreachable provider: no voices listed */
  }
}

export function roleLabel(role: TaskRole): string {
  return ROLE_INFO[role]?.label ?? role;
}

/** Live status line for a queued vocal task (progress, message, cancel / retry). */
export function TaskLine({ taskId, label, onDone }: { taskId: string | undefined; label?: string; onDone?: (t: TaskRecord) => void }) {
  const task = useTask(taskId ?? null);
  const status = task?.status;
  useEffect(() => {
    if (task && (status === 'succeeded' || status === 'failed' || status === 'cancelled')) onDone?.(task as TaskRecord);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  if (!task) return null;
  const active = isActive(task);
  return (
    <div className={`vx-task ${task.status}`} data-testid="vocal-task" data-status={task.status} role="status" aria-live="polite">
      <div className="row between">
        <div className="row" style={{ minWidth: 0 }}>
          {active ? <Spinner /> : <Icon name={task.status === 'succeeded' ? 'check' : task.status === 'failed' ? 'alert' : 'info'} size={14} />}
          <span className="ellipsis" style={{ fontWeight: 600 }}>
            {label ?? task.title}
          </span>
        </div>
        <div className="row">
          <Badge tone={task.status === 'succeeded' ? 'success' : task.status === 'failed' ? 'danger' : task.status === 'running' ? 'ai' : undefined}>{task.status}</Badge>
          {active && (
            <Button size="sm" variant="ghost" onClick={() => taskQueue.cancel(task.id)}>
              Cancel
            </Button>
          )}
          {(task.status === 'failed' || task.status === 'cancelled') && (
            <Button size="sm" variant="ghost" icon="rebuild" onClick={() => taskQueue.retry(task.id)}>
              Retry
            </Button>
          )}
        </div>
      </div>
      {active && <Progress value={task.progress} ai />}
      {task.message && active && <div className="small dim">{task.message}</div>}
      {task.status === 'failed' && task.error && <div className="small" style={{ color: 'var(--danger)' }}>{task.error}</div>}
      {task.status === 'succeeded' && (task.result as { summary?: string } | undefined)?.summary && <div className="small muted">{(task.result as { summary: string }).summary}</div>}
    </div>
  );
}

/** Audition an asset on its own (preview player), with a waveform and playhead. */
export function AssetAudition({ meta, height = 40, label }: { meta: AudioAssetMeta | undefined; height?: number; label?: string }) {
  const audio = useAssetAudio(meta);
  const id = meta ? `vx:${meta.id}` : null;
  const playing = usePreviewId();
  const pos = usePreviewPosition(id);
  if (!meta) return null;
  const on = playing === id;
  return (
    <div className="vx-audition">
      <Button
        size="sm"
        icon={on ? 'stop' : 'play'}
        onClick={() => (on ? previewPlayer.stop() : audio && void previewPlayer.play(id!, audio))}
        disabled={!audio}
        aria-label={`${on ? 'Stop' : 'Audition'} ${label ?? meta.name}`}
        title="Audition on its own"
      />
      <div className="grow" style={{ minWidth: 0 }}>
        {audio ? <Waveform audio={audio} height={height} position={on ? pos : null} color="var(--accent)" /> : <div className="vx-wave-skeleton" style={{ height }} />}
      </div>
      <span className="small dim mono nowrap">{formatDuration(meta.durationSeconds)}</span>
    </div>
  );
}

export function assetById(project: Project | null, id: string | undefined): AudioAssetMeta | undefined {
  if (!project || !id) return undefined;
  return project.meta.assets.find((a) => a.id === id);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Play the song from a position (seconds), e.g. to hear a phrase in context. */
export function playFrom(seconds: number) {
  previewPlayer.stop();
  void player.play(Math.max(0, seconds));
}
