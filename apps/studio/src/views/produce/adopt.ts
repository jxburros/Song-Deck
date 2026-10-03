import { defaultChannelStrip, randomId, type AudioAssetMeta, type AudioClip, type ChannelStrip, type ProductionCandidate, type Song, type Track } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { assetStore } from '../../state/assets';
import { player } from '../../engine/player';
import { PRODUCED_MIX_GENERATOR, PRODUCED_STEM_GENERATOR, isProducedTrack, productionSourceSong, type ProducedTrackParams } from '../../engine/produce-model';

/**
 * "Use produced stems in the mix" (spec §38/§54 → §40): a candidate's stems become ordinary audio
 * tracks (clips at bar 1, `sourceTrackId` → the MIDI track they perform) that Mix & Master mixes
 * like anything else. The MIDI tracks stay — the composition is canonical — but are muted so the
 * produced audio replaces them; production always reads the composition through
 * `productionSourceSong`, which ignores produced tracks and restores those mutes.
 */

/** Printed stems already carry their channel strip, sends and pan: unity, dry. */
const unityStrip = (): ChannelStrip => defaultChannelStrip({ volumeDb: 0, reverbSend: 0, delaySend: 0 });

function clipFor(meta: AudioAssetMeta, name: string): AudioClip {
  return { id: randomId('clip'), assetId: meta.id, tick: 0, offsetSeconds: 0, durationSeconds: meta.durationSeconds, gainDb: 0, fadeInSeconds: 0, fadeOutSeconds: 0, name };
}

const params = (t: Track) => (t.generator?.params ?? {}) as ProducedTrackParams;

/** Remove produced tracks of one kind, restoring the mutes they introduced. */
function removeProduced(tracks: Track[], channels: Record<string, ChannelStrip>, generator: string): Track[] {
  const out: Track[] = [];
  for (const t of tracks) {
    if (!(t.kind === 'audio' && t.generator?.id === generator)) {
      out.push(t);
      continue;
    }
    const p = params(t);
    const restore = generator === PRODUCED_STEM_GENERATOR ? (t.sourceTrackId && p.sourceMuted === false ? [t.sourceTrackId] : []) : (p.mutedTrackIds ?? []);
    for (const id of restore) if (channels[id]?.mute) channels[id] = { ...channels[id], mute: false };
    delete channels[t.id];
  }
  return out;
}

export interface AdoptResult {
  song: Song;
  added: number;
  updated: number;
  kind: 'stems' | 'mix';
}

export function adoptCandidate(song: Song, candidate: ProductionCandidate, assets: AudioAssetMeta[]): AdoptResult {
  const channels: Record<string, ChannelStrip> = { ...song.mixer.channels };
  let tracks = [...song.tracks];
  let added = 0;
  let updated = 0;
  const label = candidate.label;
  const meta = (id: string | undefined) => (id ? assets.find((a) => a.id === id) : undefined);
  const stems = Object.entries(candidate.stemAssetIds).filter(([tid]) => tracks.some((t) => t.id === tid && t.kind === 'midi'));

  if (stems.length) {
    tracks = removeProduced(tracks, channels, PRODUCED_MIX_GENERATOR);
    const adopted = new Set<string>();
    for (const [tid, assetId] of stems) {
      const src = tracks.find((t) => t.id === tid)!;
      const m = meta(assetId);
      if (!m) continue;
      const name = `${src.name} · ${label}`;
      const generatorParams = (prev?: ProducedTrackParams): ProducedTrackParams => ({ ...prev, candidateId: candidate.id, candidateLabel: label });
      const idx = tracks.findIndex((t) => t.kind === 'audio' && t.generator?.id === PRODUCED_STEM_GENERATOR && t.sourceTrackId === tid);
      if (idx >= 0) {
        const t = tracks[idx];
        tracks[idx] = { ...t, name, clips: [clipFor(m, m.name)], generator: { id: PRODUCED_STEM_GENERATOR, seed: candidate.seed, params: { ...generatorParams(params(t)) } } };
        updated++;
      } else {
        const id = randomId('trk');
        const t: Track = {
          id,
          name,
          kind: 'audio',
          role: src.role,
          instrumentId: 'audio',
          constraints: {},
          notes: [],
          clips: [clipFor(m, m.name)],
          color: src.color,
          stemGroup: src.stemGroup,
          sourceTrackId: src.id,
          generator: { id: PRODUCED_STEM_GENERATOR, seed: candidate.seed, params: { ...generatorParams(), sourceMuted: !!channels[src.id]?.mute } },
        };
        const at = tracks.findIndex((x) => x.id === src.id);
        tracks.splice(at + 1, 0, t);
        channels[id] = unityStrip();
        added++;
      }
      channels[tid] = { ...(channels[tid] ?? defaultChannelStrip()), mute: true };
      adopted.add(tid);
    }
    // Produced stems of sources this candidate does not cover go away (their MIDI plays again).
    const stale = tracks.filter((t) => t.kind === 'audio' && t.generator?.id === PRODUCED_STEM_GENERATOR && t.sourceTrackId && !adopted.has(t.sourceTrackId));
    if (stale.length) {
      const keep = removeProduced(stale, channels, PRODUCED_STEM_GENERATOR);
      void keep;
      const ids = new Set(stale.map((t) => t.id));
      tracks = tracks.filter((t) => !ids.has(t.id));
    }
    return { song: finish(song, tracks, channels, candidate), added, updated, kind: 'stems' };
  }

  // Full-mix candidate (Strategy A): one audio track replaces the arrangement.
  tracks = removeProduced(tracks, channels, PRODUCED_STEM_GENERATOR);
  const m = meta(candidate.mixAssetId);
  if (!m) throw new Error(`Candidate ${label} has no mix audio`);
  const idx = tracks.findIndex((t) => t.kind === 'audio' && t.generator?.id === PRODUCED_MIX_GENERATOR);
  const muted: string[] = idx >= 0 ? (params(tracks[idx]).mutedTrackIds ?? []) : [];
  for (const t of tracks) {
    if (isProducedTrack(t) || channels[t.id]?.mute) continue;
    channels[t.id] = { ...(channels[t.id] ?? defaultChannelStrip()), mute: true };
    muted.push(t.id);
  }
  const name = `Production ${label} (full mix)`;
  if (idx >= 0) {
    tracks[idx] = { ...tracks[idx], name, clips: [clipFor(m, m.name)], generator: { id: PRODUCED_MIX_GENERATOR, seed: candidate.seed, params: { candidateId: candidate.id, candidateLabel: label, mutedTrackIds: muted } } };
    updated++;
  } else {
    const id = randomId('trk');
    tracks.push({
      id,
      name,
      kind: 'audio',
      role: 'custom',
      instrumentId: 'audio',
      constraints: {},
      notes: [],
      clips: [clipFor(m, m.name)],
      color: '#46c2cb',
      stemGroup: 'others',
      generator: { id: PRODUCED_MIX_GENERATOR, seed: candidate.seed, params: { candidateId: candidate.id, candidateLabel: label, mutedTrackIds: muted } },
    });
    channels[id] = unityStrip();
    added++;
  }
  return { song: finish(song, tracks, channels, candidate), added, updated, kind: 'mix' };
}

function finish(song: Song, tracks: Track[], channels: Record<string, ChannelStrip>, candidate: ProductionCandidate): Song {
  const ids = new Set(tracks.map((t) => t.id));
  return {
    ...song,
    tracks,
    mixer: { ...song.mixer, channels: Object.fromEntries(Object.entries(channels).filter(([id]) => ids.has(id))) },
    automation: song.automation.filter((l) => l.target === 'master' || ids.has(l.target)),
    production: { ...song.production, selectedCandidateId: candidate.id },
  };
}

/** The candidate currently playing in the mix (produced tracks point at it), if any. */
export function adoptedCandidateId(song: Song): string | undefined {
  for (const t of song.tracks) if (isProducedTrack(t)) return params(t).candidateId;
  return undefined;
}

export function removeProducedAudio(song: Song): Song {
  return productionSourceSong(song);
}

/** Hand the produced clips to the playback engine so the transport plays them right away. */
export async function provideProducedAudio(song: Song): Promise<void> {
  const project = useStudio.getState().project;
  if (!project) return;
  for (const t of song.tracks) {
    if (!isProducedTrack(t)) continue;
    for (const c of t.clips) {
      if (player.hasAsset(c.assetId)) continue;
      const meta = project.meta.assets.find((a) => a.id === c.assetId);
      if (!meta) continue;
      try {
        const audio = await assetStore.audio(meta);
        if (audio) player.provideAsset(c.assetId, audio);
      } catch {
        /* undecodable: the track stays silent */
      }
    }
  }
}
