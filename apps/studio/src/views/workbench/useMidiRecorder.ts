import { useCallback, useEffect, useRef, useState } from 'react';
import { cloneSong, randomId, sortNotes } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { player } from '../../engine/player';
import { MidiCapture, MonitorSynth } from '../../engine/midi-input';
import { takeToNotes } from '../../engine/midi-take';

/**
 * Record a MIDI keyboard into a track over playback (spec §27). The take is overdubbed (existing
 * notes stay), onsets snap to the piano roll's grid, notes in locked material are discarded, and
 * the result is one undoable revision. Recording stops with the Record button or the transport.
 */
export function useMidiRecorder(trackId: string | undefined, grid: { ticks: number; label: string }) {
  const [recording, setRecording] = useState(false);
  const [count, setCount] = useState(0);
  const capture = useRef<MidiCapture | null>(null);
  const target = useRef<string | null>(null);
  const monitor = useRef<MonitorSynth | null>(null);
  const gridRef = useRef(grid);
  gridRef.current = grid;

  const finish = useCallback(() => {
    const cap = capture.current;
    if (!cap) return;
    capture.current = null;
    const take = cap.stop();
    monitor.current?.allOff();
    setRecording(false);
    if (player.playing) player.pause();
    const st = useStudio.getState();
    const song = st.project?.song;
    const track = song?.tracks.find((t) => t.id === target.current);
    if (!song || !track) return;
    if (!take.length) {
      st.toast('info', 'Recording stopped — no notes were played.');
      return;
    }
    const g = gridRef.current;
    const { notes, blocked } = takeToNotes(song, track, take, () => randomId('n'), { grid: g.ticks });
    if (!notes.length) {
      st.toast('warning', `All ${blocked} recorded notes fell in locked material and were discarded.`);
      return;
    }
    const next = cloneSong(song);
    const t = next.tracks.find((x) => x.id === track.id)!;
    t.notes = sortNotes([...t.notes, ...notes]);
    const quantized = g.ticks > 1 ? ` (quantized to ${g.label})` : '';
    st.commit(next, `Recorded ${notes.length} notes from a MIDI keyboard into ${track.name}${quantized}`, 'edit');
    st.toast(blocked ? 'warning' : 'success', `Recorded ${notes.length} notes into ${track.name}.${blocked ? ` ${blocked} notes in locked material were discarded.` : ''}`);
  }, []);

  const start = useCallback(async () => {
    if (capture.current || !trackId) return;
    const st = useStudio.getState();
    monitor.current ??= new MonitorSynth();
    const mon = monitor.current;
    // Song time comes from the player; if playback cannot start, a wall clock from the
    // record position keeps the performance's timing.
    const from = player.position();
    const t0 = performance.now();
    const cap = new MidiCapture({
      clock: () => (player.playing ? player.position() : from + (performance.now() - t0) / 1000),
      onNoteOn: (pitch, velocity) => {
        mon.noteOn(pitch, velocity);
        setCount((c) => c + 1);
      },
      onNoteOff: (pitch) => mon.noteOff(pitch),
    });
    try {
      const inputs = await cap.start();
      if (!inputs) {
        cap.stop();
        st.toast('warning', 'No MIDI keyboard is connected. Plug one in (or enable a virtual MIDI port) and press Record again.');
        return;
      }
    } catch (err) {
      st.toast('error', `MIDI keyboard unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    capture.current = cap;
    target.current = trackId;
    setCount(0);
    setRecording(true);
    if (!player.playing) {
      try {
        await player.play(from);
      } catch (err) {
        st.toast('warning', `Recording without playback: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [trackId]);

  // The transport's Stop/Pause ends the take.
  useEffect(() => player.subscribe(() => !player.playing && capture.current && finish()), [finish]);
  // Leaving the piano roll keeps what was played.
  useEffect(() => () => finish(), [finish]);

  const toggle = useCallback(() => (capture.current ? finish() : void start()), [finish, start]);
  return { recording, count, toggle };
}
