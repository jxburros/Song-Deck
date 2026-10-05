import { useState } from 'react';
import { randomSeed, regenerateUnlocked, tickToMusical, lockCount } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useCustomInstruments } from '../../hooks';
import { Badge, Button } from '../../ui/kit';
import { Icon } from '../../ui/icons';

/** Selection scope as text ("bars 9–16"), or null. */
export function useRangeLabel(): string | null {
  const song = useStudio((s) => s.project?.song ?? null);
  const selection = useStudio((s) => s.selection);
  if (!song) return null;
  const hasRange =
    selection.startTick !== undefined &&
    selection.endTick !== undefined &&
    selection.endTick > selection.startTick;
  if (!hasRange) return null;
  const a = tickToMusical(song, selection.startTick!);
  const b = tickToMusical(song, Math.max(selection.startTick!, selection.endTick! - 1));
  return `bars ${a.bar}–${b.bar}`;
}

/** Toolbar for the editors: zoom, the selection scope and the lock count. */
export function WorkbenchToolbar() {
  const song = useStudio((s) => s.project?.song ?? null);
  const view = useStudio((s) => s.view);
  const selection = useStudio((s) => s.selection);
  const rangeLabel = useRangeLabel();
  const st = useStudio.getState();
  if (!song) return null;
  return (
    <>
      <div className="row">
        <Button
          size="sm"
          variant="ghost"
          icon="zoomOut"
          title="Zoom out"
          onClick={() => st.setView({ pxPerBeat: Math.max(4, view.pxPerBeat / 1.4) })}
        />
        <Button
          size="sm"
          variant="ghost"
          icon="zoomIn"
          title="Zoom in"
          onClick={() => st.setView({ pxPerBeat: Math.min(240, view.pxPerBeat * 1.4) })}
        />
      </div>
      {rangeLabel && (
        <Badge tone="accent" title="Selected region">
          {rangeLabel}
        </Badge>
      )}
      {selection.noteIds.length > 0 && <Badge>{selection.noteIds.length} notes selected</Badge>}
      <Badge tone="warning" title="Locked components">
        <Icon name="lock" size={11} /> {lockCount(song.locks)}
      </Badge>
    </>
  );
}

/** "Another version": regenerate the selected bars, the selected track, or all unlocked material. */
export function RegenerateActions() {
  const song = useStudio((s) => s.project?.song ?? null);
  const selection = useStudio((s) => s.selection);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const customInstruments = useCustomInstruments();
  const rangeLabel = useRangeLabel();
  const [busy, setBusy] = useState(false);
  const st = useStudio.getState();
  if (!song) return null;

  const regenerate = (scope: 'all' | 'track' | 'region') => {
    setBusy(true);
    try {
      const seed = randomSeed();
      const res = regenerateUnlocked(song, {
        seed,
        trackIds:
          scope === 'track' && selectedTrackId
            ? [selectedTrackId]
            : selection.trackIds?.length && scope === 'region'
              ? selection.trackIds
              : undefined,
        startTick: scope === 'region' ? selection.startTick : undefined,
        endTick: scope === 'region' ? selection.endTick : undefined,
        customInstruments,
      });
      const changed = res.changed.length;
      if (!changed) {
        st.toast('info', 'Nothing to regenerate — everything in scope is locked.');
        return;
      }
      const what =
        scope === 'region' && rangeLabel
          ? ` (${rangeLabel})`
          : scope === 'track'
            ? ` (${song.tracks.find((t) => t.id === selectedTrackId)?.name})`
            : '';
      st.commit(
        { ...res.song, generation: { ...res.song.generation, seed } },
        `Regenerated unlocked material${what} · seed ${seed}`,
        'regenerate',
      );
      st.toast(
        'success',
        `Regenerated ${changed} track${changed > 1 ? 's' : ''}; locked material unchanged.`,
      );
    } catch (err) {
      st.toast('error', `Regeneration failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {rangeLabel && (
        <Button
          icon="dice"
          disabled={busy}
          onClick={() => regenerate('region')}
          title="A new version of only the selected bars"
        >
          Regenerate {rangeLabel}
        </Button>
      )}
      {selectedTrackId && (
        <Button
          icon="dice"
          disabled={busy}
          onClick={() => regenerate('track')}
          title="A new version of the selected track's unlocked material"
        >
          Regenerate track
        </Button>
      )}
      <Button
        icon="dice"
        disabled={busy}
        onClick={() => regenerate('all')}
        title="A new version of everything that is not locked"
      >
        Regenerate unlocked
      </Button>
    </>
  );
}
