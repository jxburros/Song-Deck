import { useEffect } from 'react';
import { createTimeMap } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { player } from '../../engine/player';

/** When looping is enabled, loop the selected region (or the whole song if nothing is selected). */
export function useLoopSync() {
  const song = useStudio((s) => s.project?.song ?? null);
  const loopEnabled = useStudio((s) => s.transport.loop.enabled);
  const start = useStudio((s) => s.selection.startTick);
  const end = useStudio((s) => s.selection.endTick);
  useEffect(() => {
    if (!song) return;
    if (!loopEnabled || start === undefined || end === undefined || end <= start) {
      player.setLoop(null);
      return;
    }
    const tm = createTimeMap(song);
    player.setLoop({ start: tm.tickToSeconds(start), end: tm.tickToSeconds(end) });
  }, [song, loopEnabled, start, end]);
}
