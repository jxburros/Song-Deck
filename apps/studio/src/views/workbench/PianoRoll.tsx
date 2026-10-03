import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  barToTick,
  cloneSong,
  createTimeMap,
  isNoteLocked,
  keyAtTick,
  LockKeys,
  midiToNoteName,
  quantizeTick,
  randomId,
  scalePitchClasses,
  sectionLayout,
  songLengthBars,
  songLengthTicks,
  sortNotes,
  chordPitchClasses,
  type Note,
  type Song,
  type Track,
  type VocalExpression,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { usePlayhead } from '../../hooks';
import { Badge, Button, Select } from '../../ui/kit';
import { colorForRole } from './SidePanel';
import { auditionNote } from '../../engine/audition';
import { useLoopSync } from './useLoopSync';
import { useMidiRecorder } from './useMidiRecorder';

const KEY_W = 56;
const RULER_H = 32;
const LANE_H = 92;
const BLACK = new Set([1, 3, 6, 8, 10]);

type Tool = 'pointer' | 'pencil';
type LaneParam = 'velocity' | 'breathiness' | 'tension' | 'vibrato';
type Drag =
  | { kind: 'move'; startTick: number; startPitch: number; ids: Set<string>; dTick: number; dPitch: number; clientX: number; clientY: number }
  | { kind: 'resize'; startTick: number; ids: Set<string>; dTick: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: 'create'; note: Note }
  | { kind: 'lane'; values: Map<string, number> }
  | { kind: 'ruler'; startTick: number; moved: boolean; x0: number };

const SNAPS: { value: string; label: string; ticks: (ppq: number) => number }[] = [
  { value: '1', label: '1 bar', ticks: (p) => p * 4 },
  { value: '1/4', label: '1/4', ticks: (p) => p },
  { value: '1/8', label: '1/8', ticks: (p) => p / 2 },
  { value: '1/16', label: '1/16', ticks: (p) => p / 4 },
  { value: '1/32', label: '1/32', ticks: (p) => p / 8 },
  { value: '1/8T', label: '1/8 triplet', ticks: (p) => p / 3 },
  { value: '1/16T', label: '1/16 triplet', ticks: (p) => p / 6 },
  { value: 'off', label: 'No snap', ticks: () => 1 },
];

function expressionValue(n: Note, param: LaneParam): number {
  if (param === 'velocity') return n.velocity / 127;
  return (n.expression?.[param as keyof VocalExpression] as number | undefined) ?? 0;
}

export default function PianoRoll() {
  const project = useStudio((s) => s.project);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const selection = useStudio((s) => s.selection);
  const view = useStudio((s) => s.view);
  const follow = useStudio((s) => s.transport.follow);
  const proposal = useStudio((s) => s.proposals.find((p) => p.id === s.activeProposalId && p.status === 'pending') ?? null);
  const st = useStudio.getState();
  useLoopSync();

  const baseSong = project?.song ?? null;
  // When an AI proposal is pending, the roll shows (and edits) the proposed song — "Modify" (spec §21).
  const song: Song | null = proposal ? proposal.after : baseSong;
  const track: Track | undefined = song?.tracks.find((t) => t.id === selectedTrackId) ?? song?.tracks.find((t) => t.kind === 'midi');

  const [tool, setTool] = useState<Tool>('pointer');
  const [snap, setSnap] = useState('1/16');
  const [laneParam, setLaneParam] = useState<LaneParam>('velocity');
  const [ghostId, setGhostId] = useState<string>('');
  const [showChordTones, setShowChordTones] = useState(true);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [size, setSize] = useState({ w: 800, h: 400, laneW: 800 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const laneRef = useRef<HTMLCanvasElement>(null);
  const lastLen = useRef<number>(240);
  const pos = usePlayhead();

  const ppq = song?.ppq ?? 480;
  const pxPerTick = view.pxPerBeat / ppq;
  const keyH = view.keyHeight;
  const totalTicks = song ? songLengthTicks(song) : 0;
  const contentW = Math.ceil(totalTicks * pxPerTick) + 240;
  const contentH = 128 * keyH;
  const snapTicks = Math.max(1, Math.round((SNAPS.find((s) => s.value === snap) ?? SNAPS[3]).ticks(ppq)));
  const tm = useMemo(() => (song ? createTimeMap(song) : null), [song]);
  const layout = useMemo(() => (song ? sectionLayout(song) : []), [song]);
  const selected = useMemo(() => new Set(selection.noteIds), [selection.noteIds]);
  const isVocal = track?.role === 'vocal';
  const snapLabel = (SNAPS.find((s) => s.value === snap) ?? SNAPS[3]).label;
  const recorder = useMidiRecorder(track?.kind === 'midi' ? track.id : undefined, { ticks: snapTicks, label: snapLabel });

  const diffForTrack = useMemo(() => {
    if (!proposal || !track) return null;
    const td = proposal.diff.tracks.find((t) => t.trackId === track.id);
    if (!td) return null;
    return {
      added: new Set(td.added.map((n) => n.id)),
      modified: new Set(td.modified.map((m) => m.after.id)),
      removed: td.removed,
    };
  }, [proposal, track]);

  // Resize observer for the canvas viewport.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height), laneW: Math.floor(r.width) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Centre vertically on the track's notes when the track changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !track) return;
    const pitches = track.notes.map((n) => n.pitch);
    const mid = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60;
    el.scrollTop = Math.max(0, (127 - mid) * keyH - (el.clientHeight - RULER_H) / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  // Follow playhead.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !tm || !follow) return;
    const x = tm.secondsToTick(pos) * pxPerTick;
    const vis = el.clientWidth - KEY_W;
    if (x < el.scrollLeft || x > el.scrollLeft + vis - 30) el.scrollLeft = Math.max(0, x - 60);
  }, [pos, tm, pxPerTick, follow]);

  /** Commit a modified copy of the displayed song (to the project, or to the pending proposal). */
  const commitTrackNotes = useCallback(
    (notes: Note[], message: string) => {
      if (!song || !track) return;
      const next = cloneSong(song);
      const t = next.tracks.find((x) => x.id === track.id)!;
      t.notes = sortNotes(notes);
      if (proposal) st.updateProposal(proposal.id, next);
      else st.commit(next, message, 'edit');
    },
    [song, track, proposal, st],
  );

  const yToPitch = (y: number) => 127 - Math.floor((y - RULER_H + scroll.y) / keyH);
  const xToTick = (x: number) => (x - KEY_W + scroll.x) / pxPerTick;
  const tickToX = (t: number) => KEY_W + t * pxPerTick - scroll.x;
  const pitchToY = (p: number) => RULER_H + (127 - p) * keyH - scroll.y;

  const noteAt = (x: number, y: number): { note: Note; edge: boolean } | null => {
    if (!track) return null;
    const pitch = yToPitch(y);
    const tick = xToTick(x);
    for (let i = track.notes.length - 1; i >= 0; i--) {
      const n = track.notes[i];
      if (n.pitch === pitch && tick >= n.tick && tick <= n.tick + n.duration) {
        const right = tickToX(n.tick + n.duration);
        return { note: n, edge: right - x < 7 };
      }
    }
    return null;
  };

  // ---------------------------------------------------------------- drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !song || !tm) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (v: string) => css.getPropertyValue(v).trim();
    g.fillStyle = col('--bg');
    g.fillRect(0, 0, size.w, size.h);

    const viewStartTick = Math.max(0, xToTick(KEY_W));
    const viewEndTick = xToTick(size.w);
    const key = keyAtTick(song, viewStartTick);
    const scale = new Set(scalePitchClasses(key));
    const topPitch = Math.min(127, yToPitch(RULER_H) + 1);
    const bottomPitch = Math.max(0, yToPitch(size.h) - 1);

    // Rows
    for (let p = bottomPitch; p <= topPitch; p++) {
      const y = pitchToY(p);
      const pc = p % 12;
      g.fillStyle = BLACK.has(pc) ? col('--bg') : col('--bg-elev-1');
      g.fillRect(KEY_W, y, size.w - KEY_W, keyH);
      if (scale.has(pc)) {
        g.fillStyle = 'rgba(70,194,203,0.035)';
        g.fillRect(KEY_W, y, size.w - KEY_W, keyH);
      }
      g.fillStyle = col('--grid-line');
      g.fillRect(KEY_W, y + keyH - 1, size.w - KEY_W, 1);
    }

    // Chord-tone highlighting (theory overlay)
    if (showChordTones && track && !track.instrumentId.includes('kit') && track.role !== 'drums') {
      for (const c of song.chords) {
        if (c.tick + c.duration < viewStartTick || c.tick > viewEndTick) continue;
        const pcs = new Set(chordPitchClasses(c));
        const x0 = tickToX(c.tick);
        const x1 = tickToX(c.tick + c.duration);
        for (let p = bottomPitch; p <= topPitch; p++) {
          if (!pcs.has(p % 12)) continue;
          g.fillStyle = p % 12 === c.root ? 'rgba(255,138,61,0.09)' : 'rgba(255,138,61,0.045)';
          g.fillRect(Math.max(KEY_W, x0), pitchToY(p), x1 - Math.max(KEY_W, x0), keyH - 1);
        }
      }
    }

    // Vertical grid: snap, beats, bars
    const bars = songLengthBars(song);
    if (snapTicks * pxPerTick >= 6) {
      g.fillStyle = col('--grid-line');
      for (let t = Math.floor(viewStartTick / snapTicks) * snapTicks; t <= viewEndTick; t += snapTicks) g.fillRect(Math.round(tickToX(t)), RULER_H, 1, size.h);
    }
    if (ppq * pxPerTick >= 5) {
      g.fillStyle = col('--grid-beat');
      for (let t = Math.floor(viewStartTick / ppq) * ppq; t <= viewEndTick; t += ppq) g.fillRect(Math.round(tickToX(t)), RULER_H, 1, size.h);
    }
    g.fillStyle = col('--grid-bar');
    for (let b = 0; b <= bars; b++) {
      const t = barToTick(song, b);
      if (t < viewStartTick - ppq * 8 || t > viewEndTick) continue;
      g.fillRect(Math.round(tickToX(t)), RULER_H, 1, size.h);
    }

    // Selection range shading
    if (selection.startTick !== undefined && selection.endTick !== undefined && selection.endTick > selection.startTick) {
      g.fillStyle = 'rgba(255,138,61,0.06)';
      const x0 = Math.max(KEY_W, tickToX(selection.startTick));
      g.fillRect(x0, RULER_H, tickToX(selection.endTick) - x0, size.h - RULER_H);
    }

    // Locked section overlay
    if (track) {
      for (const span of layout) {
        const locked =
          song.locks[LockKeys.track(track.id)] || song.locks[LockKeys.section(span.section.id)] || song.locks[LockKeys.trackSection(track.id, span.section.id)];
        if (!locked) continue;
        const x0 = Math.max(KEY_W, tickToX(span.startTick));
        const x1 = tickToX(span.endTick);
        if (x1 < KEY_W || x0 > size.w) continue;
        g.fillStyle = 'rgba(245,196,81,0.05)';
        g.fillRect(x0, RULER_H, x1 - x0, size.h - RULER_H);
      }
    }

    // Ghost track
    const ghost = song.tracks.find((t) => t.id === ghostId);
    if (ghost) {
      g.fillStyle = 'rgba(160,170,190,0.25)';
      for (const n of ghost.notes) {
        if (n.tick + n.duration < viewStartTick || n.tick > viewEndTick) continue;
        g.fillRect(tickToX(n.tick), pitchToY(n.pitch) + 1, Math.max(2, n.duration * pxPerTick), keyH - 2);
      }
    }

    // Removed notes (proposal diff)
    if (diffForTrack) {
      g.setLineDash([3, 3]);
      g.strokeStyle = col('--diff-removed');
      g.lineWidth = 1.5;
      for (const n of diffForTrack.removed) {
        g.strokeRect(tickToX(n.tick) + 0.5, pitchToY(n.pitch) + 1.5, Math.max(3, n.duration * pxPerTick) - 1, keyH - 3);
      }
      g.setLineDash([]);
    }

    // Notes
    if (track) {
      const color = track.color || colorForRole(track.role);
      const moving = drag?.kind === 'move' ? drag : null;
      const resizing = drag?.kind === 'resize' ? drag : null;
      g.font = `${Math.max(9, Math.min(11, keyH - 2))}px ${col('--font-ui') || 'sans-serif'}`;
      for (const n of track.notes) {
        let tick = n.tick;
        let pitch = n.pitch;
        let dur = n.duration;
        if (moving && moving.ids.has(n.id)) {
          tick += moving.dTick;
          pitch += moving.dPitch;
        }
        if (resizing && resizing.ids.has(n.id)) dur = Math.max(snapTicks, dur + resizing.dTick);
        if (tick + dur < viewStartTick || tick > viewEndTick || pitch < bottomPitch - 1 || pitch > topPitch + 1) continue;
        const x = tickToX(tick);
        const y = pitchToY(pitch);
        const w = Math.max(3, dur * pxPerTick - 1);
        const lowConf = n.confidence !== undefined && n.confidence < 0.6;
        g.globalAlpha = lowConf ? 0.45 : 0.45 + (n.velocity / 127) * 0.55;
        g.fillStyle = color;
        g.fillRect(x, y + 1, w, keyH - 2);
        g.globalAlpha = 1;
        let stroke: string | null = null;
        if (selected.has(n.id)) stroke = '#ffffff';
        else if (diffForTrack?.added.has(n.id)) stroke = col('--diff-added');
        else if (diffForTrack?.modified.has(n.id)) stroke = col('--diff-modified');
        else if (n.locked) stroke = col('--lock');
        if (stroke) {
          g.strokeStyle = stroke;
          g.lineWidth = 1.5;
          g.strokeRect(x + 0.75, y + 1.75, w - 1.5, keyH - 3.5);
        }
        if (lowConf) {
          g.setLineDash([2, 2]);
          g.strokeStyle = col('--warning');
          g.strokeRect(x + 0.5, y + 1.5, w - 1, keyH - 3);
          g.setLineDash([]);
        }
        if (isVocal && n.syllable && w > 12) {
          g.fillStyle = '#0b0d11';
          g.fillText(n.syllable, x + 3, y + keyH - 3, w - 4);
        }
      }
    }

    // Marquee
    if (drag?.kind === 'marquee') {
      g.strokeStyle = col('--accent');
      g.fillStyle = 'rgba(255,138,61,0.08)';
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      g.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      g.strokeRect(x + 0.5, y + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    }

    // Ruler
    g.fillStyle = col('--bg-elev-1');
    g.fillRect(KEY_W, 0, size.w - KEY_W, RULER_H);
    for (const span of layout) {
      const x0 = tickToX(span.startTick);
      const x1 = tickToX(span.endTick);
      if (x1 < KEY_W || x0 > size.w) continue;
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(Math.max(KEY_W, x0), 0, x1 - Math.max(KEY_W, x0), 14);
      g.fillStyle = col('--text-muted');
      g.font = `600 10px ${col('--font-ui')}`;
      g.fillText(span.section.name, Math.max(KEY_W, x0) + 4, 10.5);
    }
    g.font = `10px ${col('--font-mono')}`;
    for (let b = 0; b <= bars; b++) {
      const x = tickToX(barToTick(song, b));
      if (x < KEY_W - 1 || x > size.w) continue;
      g.fillStyle = col('--grid-bar');
      g.fillRect(Math.round(x), 14, 1, RULER_H - 14);
      if (view.pxPerBeat * 4 >= 26 || b % 4 === 0) {
        g.fillStyle = col('--text-muted');
        g.fillText(String(b + 1), x + 3, 26);
      }
    }
    if (selection.startTick !== undefined && selection.endTick !== undefined) {
      g.fillStyle = col('--accent');
      const x0 = Math.max(KEY_W, tickToX(selection.startTick));
      g.fillRect(x0, RULER_H - 3, tickToX(selection.endTick) - x0, 3);
    }
    g.fillStyle = col('--border');
    g.fillRect(KEY_W, RULER_H - 1, size.w - KEY_W, 1);

    // Keyboard
    for (let p = bottomPitch; p <= topPitch; p++) {
      const y = pitchToY(p);
      const pc = p % 12;
      g.fillStyle = BLACK.has(pc) ? '#1b1f27' : '#d9dde5';
      g.fillRect(0, y, KEY_W - 1, keyH - (BLACK.has(pc) ? 0 : 1));
      if (pc === 0 && keyH >= 9) {
        g.fillStyle = '#3a404c';
        g.font = `${Math.min(10, keyH - 2)}px ${col('--font-mono')}`;
        g.fillText(midiToNoteName(p), 4, y + keyH - 2);
      }
    }
    g.fillStyle = col('--bg-elev-1');
    g.fillRect(0, 0, KEY_W, RULER_H);

    // Playhead
    const px = tickToX(tm.secondsToTick(pos));
    if (px >= KEY_W && px <= size.w) {
      g.fillStyle = col('--playhead');
      g.fillRect(Math.round(px), 0, 2, size.h);
    }
  });

  // Lane (velocity / vocal expression)
  useEffect(() => {
    const canvas = laneRef.current;
    if (!canvas || !track) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.laneW * dpr;
    canvas.height = LANE_H * dpr;
    canvas.style.width = `${size.laneW}px`;
    canvas.style.height = `${LANE_H}px`;
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue('--bg-elev-1').trim();
    g.fillRect(0, 0, size.laneW, LANE_H);
    g.fillStyle = css.getPropertyValue('--text-dim').trim();
    g.font = '10px sans-serif';
    g.fillText(laneParam, 4, 12);
    const color = track.color || colorForRole(track.role);
    const laneDrag = drag?.kind === 'lane' ? drag : null;
    for (const n of track.notes) {
      const x = tickToX(n.tick);
      if (x < KEY_W - 4 || x > size.laneW) continue;
      const v = laneDrag?.values.get(n.id) ?? expressionValue(n, laneParam);
      const h = v * (LANE_H - 16);
      g.fillStyle = selected.has(n.id) ? '#ffffff' : color;
      g.fillRect(x, LANE_H - 4 - h, 3, h);
      g.beginPath();
      g.arc(x + 1.5, LANE_H - 4 - h, 2.5, 0, Math.PI * 2);
      g.fill();
    }
  });

  // ---------------------------------------------------------------- interaction
  const localXY = (e: React.PointerEvent | PointerEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!song || !track || !tm) return;
    const { x, y } = localXY(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (y < RULER_H && x >= KEY_W) {
      setDrag({ kind: 'ruler', startTick: xToTick(x), moved: false, x0: x });
      return;
    }
    if (x < KEY_W) {
      auditionNote(yToPitch(y), 100, track.role === 'drums');
      return;
    }
    const hit = noteAt(x, y);
    if (hit) {
      const n = hit.note;
      if (!selected.has(n.id)) st.setSelection({ noteIds: e.shiftKey ? [...selection.noteIds, n.id] : [n.id], trackIds: [track.id] });
      const ids = new Set(selected.has(n.id) ? selection.noteIds : e.shiftKey ? [...selection.noteIds, n.id] : [n.id]);
      auditionNote(n.pitch, n.velocity, track.role === 'drums');
      if (hit.edge) setDrag({ kind: 'resize', startTick: xToTick(x), ids, dTick: 0 });
      else setDrag({ kind: 'move', startTick: xToTick(x), startPitch: yToPitch(y), ids, dTick: 0, dPitch: 0, clientX: e.clientX, clientY: e.clientY });
      return;
    }
    if (tool === 'pencil' || e.detail >= 2) {
      const tick = Math.max(0, Math.floor(xToTick(x) / snapTicks) * snapTicks);
      const note: Note = { id: randomId('n'), pitch: yToPitch(y), tick, duration: Math.max(snapTicks, lastLen.current), velocity: 96, origin: 'user' };
      auditionNote(note.pitch, 96, track.role === 'drums');
      setDrag({ kind: 'create', note });
      return;
    }
    setDrag({ kind: 'marquee', x0: x, y0: y, x1: x, y1: y, additive: e.shiftKey });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !song || !track) {
      const el = scrollRef.current;
      if (el && track) {
        const { x, y } = localXY(e);
        const hit = x > KEY_W && y > RULER_H ? noteAt(x, y) : null;
        el.style.cursor = hit ? (hit.edge ? 'ew-resize' : 'grab') : tool === 'pencil' ? 'crosshair' : 'default';
      }
      return;
    }
    const { x, y } = localXY(e);
    if (drag.kind === 'move') {
      const raw = xToTick(x) - drag.startTick;
      const dTick = e.altKey ? Math.round(raw) : Math.round(raw / snapTicks) * snapTicks;
      const dPitch = yToPitch(y) - drag.startPitch;
      if (dTick !== drag.dTick || dPitch !== drag.dPitch) setDrag({ ...drag, dTick, dPitch });
    } else if (drag.kind === 'resize') {
      const dTick = Math.round((xToTick(x) - drag.startTick) / snapTicks) * snapTicks;
      if (dTick !== drag.dTick) setDrag({ ...drag, dTick });
    } else if (drag.kind === 'marquee') {
      setDrag({ ...drag, x1: x, y1: y });
    } else if (drag.kind === 'create') {
      const end = Math.max(drag.note.tick + snapTicks, Math.round(xToTick(x) / snapTicks) * snapTicks);
      setDrag({ kind: 'create', note: { ...drag.note, duration: end - drag.note.tick } });
    } else if (drag.kind === 'ruler') {
      if (Math.abs(x - drag.x0) > 4) {
        const a = Math.floor(Math.min(drag.startTick, xToTick(x)) / snapTicks) * snapTicks;
        const b = Math.ceil(Math.max(drag.startTick, xToTick(x)) / snapTicks) * snapTicks;
        st.setSelection({ startTick: Math.max(0, a), endTick: b, sectionIds: [] });
        if (!drag.moved) setDrag({ ...drag, moved: true });
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag || !song || !track || !tm) return setDrag(null);
    const d = drag;
    setDrag(null);
    if (d.kind === 'ruler') {
      if (!d.moved) st.seek(tm.tickToSeconds(Math.max(0, d.startTick)));
      return;
    }
    if (d.kind === 'move') {
      if (d.dTick === 0 && d.dPitch === 0) return;
      const blocked = track.notes.filter((n) => d.ids.has(n.id) && isNoteLocked(song, track, n));
      if (blocked.length) {
        st.toast('warning', `${blocked.length} locked note${blocked.length > 1 ? 's' : ''} not moved — unlock first.`);
      }
      const notes = track.notes.map((n) =>
        d.ids.has(n.id) && !isNoteLocked(song, track, n)
          ? { ...n, tick: Math.max(0, n.tick + d.dTick), pitch: Math.max(0, Math.min(127, n.pitch + d.dPitch)) }
          : n,
      );
      commitTrackNotes(notes, `Moved ${d.ids.size} note${d.ids.size > 1 ? 's' : ''} in ${track.name}`);
    } else if (d.kind === 'resize') {
      if (d.dTick === 0) return;
      const notes = track.notes.map((n) => {
        if (!d.ids.has(n.id) || isNoteLocked(song, track, n)) return n;
        const duration = Math.max(snapTicks, n.duration + d.dTick);
        lastLen.current = duration;
        return { ...n, duration };
      });
      commitTrackNotes(notes, `Resized ${d.ids.size} note${d.ids.size > 1 ? 's' : ''} in ${track.name}`);
    } else if (d.kind === 'create') {
      lastLen.current = d.note.duration;
      commitTrackNotes([...track.notes, d.note], `Added ${midiToNoteName(d.note.pitch)} to ${track.name}`);
      st.setSelection({ noteIds: [d.note.id], trackIds: [track.id] });
    } else if (d.kind === 'marquee') {
      const t0 = xToTick(Math.min(d.x0, d.x1));
      const t1 = xToTick(Math.max(d.x0, d.x1));
      const p0 = yToPitch(Math.max(d.y0, d.y1));
      const p1 = yToPitch(Math.min(d.y0, d.y1));
      const ids = track.notes.filter((n) => n.tick + n.duration >= t0 && n.tick <= t1 && n.pitch >= p0 && n.pitch <= p1).map((n) => n.id);
      if (Math.abs(d.x1 - d.x0) < 3 && Math.abs(d.y1 - d.y0) < 3) {
        st.setSelection({ noteIds: [] });
        st.seek(tm.tickToSeconds(Math.max(0, xToTick(d.x0))));
      } else {
        st.setSelection({ noteIds: d.additive ? Array.from(new Set([...selection.noteIds, ...ids])) : ids, trackIds: [track.id] });
      }
    }
    void e;
  };

  // Lane interaction (velocity / expression painting)
  const onLaneDown = (e: React.PointerEvent) => {
    if (!track) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: 'lane', values: new Map() });
    onLaneMove(e, true);
  };
  const onLaneMove = (e: React.PointerEvent, force = false) => {
    if (!track || (!force && drag?.kind !== 'lane')) return;
    const r = laneRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const v = Math.max(0, Math.min(1, (LANE_H - 4 - (e.clientY - r.top)) / (LANE_H - 16)));
    const values = new Map(drag?.kind === 'lane' ? drag.values : []);
    for (const n of track.notes) {
      const nx = tickToX(n.tick);
      if (Math.abs(nx - x) <= 4 && (selected.size === 0 || selected.has(n.id))) values.set(n.id, v);
    }
    setDrag({ kind: 'lane', values });
  };
  const onLaneUp = () => {
    if (!track || drag?.kind !== 'lane' || !song) return setDrag(null);
    const values = drag.values;
    setDrag(null);
    if (!values.size) return;
    const notes = track.notes.map((n) => {
      const v = values.get(n.id);
      if (v === undefined || isNoteLocked(song, track, n)) return n;
      if (laneParam === 'velocity') return { ...n, velocity: Math.max(1, Math.round(v * 127)) };
      return { ...n, expression: { ...n.expression, [laneParam]: Math.round(v * 100) / 100 } };
    });
    commitTrackNotes(notes, `Edited ${laneParam} of ${values.size} note${values.size > 1 ? 's' : ''}`);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (!song || !track) return;
      const sel = new Set(useStudio.getState().selection.noteIds);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        st.setSelection({ noteIds: track.notes.map((n) => n.id), trackIds: [track.id] });
        return;
      }
      if (!sel.size) return;
      const editable = (n: Note) => sel.has(n.id) && !isNoteLocked(song, track, n);
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        commitTrackNotes(track.notes.filter((n) => !editable(n)), `Deleted ${sel.size} note${sel.size > 1 ? 's' : ''}`);
        st.setSelection({ noteIds: [] });
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        commitTrackNotes(track.notes.map((n) => (editable(n) ? { ...n, pitch: Math.max(0, Math.min(127, n.pitch + d)) } : n)), `Transposed ${d > 0 ? '+' : ''}${d}`);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const d = (e.key === 'ArrowRight' ? 1 : -1) * snapTicks;
        commitTrackNotes(track.notes.map((n) => (editable(n) ? { ...n, tick: Math.max(0, n.tick + d) } : n)), 'Nudged notes');
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const chosen = track.notes.filter((n) => sel.has(n.id));
        const start = Math.min(...chosen.map((n) => n.tick));
        const end = Math.max(...chosen.map((n) => n.tick + n.duration));
        const span = Math.ceil((end - start) / snapTicks) * snapTicks;
        const copies = chosen.map((n) => ({ ...n, id: randomId('n'), tick: n.tick + span, locked: false }));
        commitTrackNotes([...track.notes, ...copies], `Duplicated ${copies.length} notes`);
        st.setSelection({ noteIds: copies.map((c) => c.id) });
      } else if (e.key.toLowerCase() === 'q' && !mod) {
        commitTrackNotes(track.notes.map((n) => (editable(n) ? { ...n, tick: quantizeTick(n.tick, snapTicks) } : n)), `Quantized to ${snap}`);
      } else if (e.key.toLowerCase() === 'l' && !mod) {
        const allLocked = track.notes.filter((n) => sel.has(n.id)).every((n) => n.locked);
        commitTrackNotes(track.notes.map((n) => (sel.has(n.id) ? { ...n, locked: !allLocked } : n)), `${allLocked ? 'Unlocked' : 'Locked'} ${sel.size} notes`);
      } else if (e.key === 'Escape') {
        st.setSelection({ noteIds: [] });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [song, track, snapTicks, snap, commitTrackNotes, st]);

  if (!song || !track) return <div className="empty-state">Select a MIDI track to edit.</div>;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }} data-testid="piano-roll">
      <div className="row wrap" style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', gap: 8 }}>
        <Select
          size="sm"
          value={track.id}
          onChange={(id) => st.selectTrack(id)}
          options={song.tracks.filter((t) => t.kind === 'midi').map((t) => ({ value: t.id, label: t.name }))}
          style={{ width: 170 }}
        />
        <div className="tabs">
          <button className={`tab ${tool === 'pointer' ? 'active' : ''}`} onClick={() => setTool('pointer')} title="Select / move / resize (double-click to add)">
            Select
          </button>
          <button className={`tab ${tool === 'pencil' ? 'active' : ''}`} onClick={() => setTool('pencil')} title="Draw notes">
            Draw
          </button>
        </div>
        <Select size="sm" value={snap} onChange={setSnap} options={SNAPS.map((s) => ({ value: s.value, label: `Snap ${s.label}` }))} style={{ width: 130 }} />
        <Button
          size="sm"
          variant={recorder.recording ? 'danger' : 'ghost'}
          icon="record"
          onClick={recorder.toggle}
          disabled={!!proposal && !recorder.recording}
          aria-pressed={recorder.recording}
          title={
            proposal
              ? 'Accept or reject the pending proposal before recording'
              : recorder.recording
                ? 'Stop recording and keep the take'
                : `Record a MIDI keyboard into ${track.name} over playback (overdub; onsets snap to ${snapLabel})`
          }
        >
          {recorder.recording ? `Stop · ${recorder.count} notes` : 'Record'}
        </Button>
        <Select
          size="sm"
          value={laneParam}
          onChange={setLaneParam}
          options={[
            { value: 'velocity', label: 'Lane: velocity' },
            { value: 'breathiness', label: 'Lane: breathiness', disabled: !isVocal },
            { value: 'tension', label: 'Lane: tension', disabled: !isVocal },
            { value: 'vibrato', label: 'Lane: vibrato', disabled: !isVocal },
          ]}
          style={{ width: 150 }}
        />
        <Select
          size="sm"
          value={ghostId}
          onChange={setGhostId}
          options={[{ value: '', label: 'No ghost track' }, ...song.tracks.filter((t) => t.id !== track.id && t.kind === 'midi').map((t) => ({ value: t.id, label: `Ghost: ${t.name}` }))]}
          style={{ width: 160 }}
        />
        <Button size="sm" variant={showChordTones ? 'ai' : 'ghost'} onClick={() => setShowChordTones(!showChordTones)} title="Highlight chord tones under the harmony">
          Chord tones
        </Button>
        <Button size="sm" variant="ghost" onClick={() => st.setView({ keyHeight: Math.max(6, keyH - 2) })} title="Shorter rows">
          −
        </Button>
        <Button size="sm" variant="ghost" onClick={() => st.setView({ keyHeight: Math.min(24, keyH + 2) })} title="Taller rows">
          +
        </Button>
        <div className="spacer" />
        {proposal && (
          <>
            <Badge tone="ai">Proposal: {proposal.title}</Badge>
            <span className="small" style={{ color: 'var(--diff-added)' }}>■ added</span>
            <span className="small" style={{ color: 'var(--diff-modified)' }}>■ changed</span>
            <span className="small" style={{ color: 'var(--diff-removed)' }}>▢ removed</span>
            <Button size="sm" variant="success" icon="check" onClick={() => st.acceptProposal(proposal.id)}>
              Accept
            </Button>
            <Button size="sm" variant="danger" icon="close" onClick={() => st.rejectProposal(proposal.id)}>
              Reject
            </Button>
          </>
        )}
      </div>
      <div ref={wrapRef} style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <canvas ref={canvasRef} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} aria-label={`Piano roll for ${track.name}`} />
        <div
          ref={scrollRef}
          style={{ position: 'absolute', inset: 0, overflow: 'auto' }}
          onScroll={(e) => setScroll({ x: (e.target as HTMLElement).scrollLeft, y: (e.target as HTMLElement).scrollTop })}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              st.setView({ pxPerBeat: Math.max(4, Math.min(240, view.pxPerBeat * (e.deltaY < 0 ? 1.15 : 1 / 1.15))) });
            }
          }}
          tabIndex={0}
          data-testid="piano-roll-surface"
        >
          <div style={{ width: KEY_W + contentW, height: RULER_H + contentH }} />
        </div>
      </div>
      <canvas
        ref={laneRef}
        style={{ borderTop: '1px solid var(--border)', cursor: 'ns-resize', flex: 'none' }}
        onPointerDown={onLaneDown}
        onPointerMove={(e) => onLaneMove(e)}
        onPointerUp={onLaneUp}
        aria-label={`${laneParam} lane`}
      />
    </div>
  );
}
