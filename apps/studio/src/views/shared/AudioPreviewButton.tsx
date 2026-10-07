import { useEffect, useRef, useState } from 'react';
import type { AudioData } from '@songdeck/audio';
import { previewPlayer, usePreviewId } from '../../engine/capture-playback';
import { comparePlayer } from '../produce/comparePlayer';
import { useStudio } from '../../state/store';
import { Button } from '../../ui/kit';

let latestRequest = 0;

/** Load on demand, with stop and unmount cancellation even while decoding. */
export function AudioPreviewButton({
  id,
  label,
  load,
}: {
  id: string;
  label: string;
  load: () => Promise<AudioData | undefined>;
}) {
  const playing = usePreviewId() === id;
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
      if (previewPlayer.playingId === id) previewPlayer.stop();
    },
    [id],
  );
  const toggle = async () => {
    if (playing || loading) {
      request.current++;
      setLoading(false);
      if (playing) previewPlayer.stop();
      return;
    }
    const token = ++request.current;
    const ticket = ++latestRequest;
    previewPlayer.stop();
    comparePlayer.pause();
    setLoading(true);
    try {
      await previewPlayer.prepare();
      const audio = await load();
      if (request.current !== token || ticket !== latestRequest) return;
      if (!audio) throw new Error('Audio is missing from browser storage.');
      comparePlayer.pause();
      await previewPlayer.play(id, audio);
    } catch (e) {
      if (request.current === token)
        useStudio
          .getState()
          .toast('error', `Could not preview ${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (request.current === token) setLoading(false);
    }
  };
  return (
    <Button
      size="sm"
      icon={playing || loading ? 'stop' : 'play'}
      aria-label={`${playing || loading ? 'Stop' : 'Listen to'} ${label}`}
      onClick={() => void toggle()}
    >
      {playing ? 'Stop' : loading ? 'Cancel preview' : 'Listen'}
    </Button>
  );
}
