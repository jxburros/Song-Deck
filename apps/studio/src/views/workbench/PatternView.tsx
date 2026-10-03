import { useMemo, useState } from 'react';
import {
  barToTick,
  cloneSong,
  GM_DRUM_NAMES,
  isNoteLocked,
  midiToNoteName,
  randomId,
  sectionLayout,
  sortNotes,
  type Note,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { Badge, Button, Select } from '../../ui/kit';
import { colorForRole } from './SidePanel';
import { auditionNote } from '../../engine/audition';

/** Pattern View (spec §18): loop & phrase editing with "apply to every repetition". */
export default function PatternView() {
  const song = useStudio((s) => s.project?.song ?? null);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const st = useStudio.getState();
  const track =
    song?.tracks.find((t) => t.id === selectedTrackId && t.kind === 'midi') ??
    song?.tracks.find((t) => t.kind === 'midi');
  const layout = useMemo(() => (song ? sectionLayout(song) : []), [song]);
  const [sectionId, setSectionId] = useState<string>(layout[0]?.section.id ?? '');
  const [lengthBars, setLengthBars] = useState(1);
  const [offsetBar, setOffsetBar] = useState(0);
  const [stepsPerBeat, setStepsPerBeat] = useState(4);

  if (!song || !track) return <div className="empty-state">Select a MIDI track.</div>;
  const span = layout.find((s) => s.section.id === sectionId) ?? layout[0];
  if (!span) return null;
  const sectionBars = span.endBar - span.startBar;
  const patBars = Math.min(lengthBars, sectionBars);
  const startBar = span.startBar + Math.min(offsetBar, Math.max(0, sectionBars - patBars));
  const patStart = barToTick(song, startBar);
  const patEnd = barToTick(song, startBar + patBars);
  const stepTicks = song.ppq / stepsPerBeat;
  const steps = Math.round((patEnd - patStart) / stepTicks);
  const isDrums = track.role === 'drums' || track.role === 'percussion' || track.instrumentId.includes('kit');
  const notesIn = track.notes.filter((n) => n.tick >= patStart && n.tick < patEnd);

  const rows = (() => {
    const used = new Set(notesIn.map((n) => n.pitch));
    if (isDrums) {
      for (const p of [36, 38, 42, 46, 49, 51]) used.add(p);
      return Array.from(used).sort((a, b) => b - a);
    }
    const ps = notesIn.map((n) => n.pitch);
    const lo = ps.length ? Math.min(...ps) - 2 : 55;
    const hi = ps.length ? Math.max(...ps) + 2 : 72;
    return Array.from({ length: hi - lo + 1 }, (_, i) => hi - i);
  })();

  // How many windows of this length in the section are identical to the pattern?
  const signature = (start: number) =>
    track.notes
      .filter((n) => n.tick >= start && n.tick < start + (patEnd - patStart))
      .map((n) => `${n.pitch}@${n.tick - start}:${n.duration}`)
      .sort()
      .join('|');
  const sig = signature(patStart);
  let repeats = 0;
  for (let b = span.startBar; b + patBars <= span.endBar; b += patBars)
    if (signature(barToTick(song, b)) === sig) repeats++;

  const cellNote = (pitch: number, step: number): Note | undefined =>
    notesIn.find((n) => n.pitch === pitch && Math.round((n.tick - patStart) / stepTicks) === step);

  const commit = (notes: Note[], message: string) => {
    const next = cloneSong(song);
    next.tracks.find((t) => t.id === track.id)!.notes = sortNotes(notes);
    st.commit(next, message, 'edit');
  };

  const toggle = (pitch: number, step: number) => {
    const existing = cellNote(pitch, step);
    if (existing) {
      if (isNoteLocked(song, track, existing)) return st.toast('warning', 'That note is locked.');
      commit(
        track.notes.filter((n) => n.id !== existing.id),
        `Pattern: removed ${isDrums ? (GM_DRUM_NAMES[pitch] ?? pitch) : midiToNoteName(pitch)}`,
      );
    } else {
      const note: Note = {
        id: randomId('n'),
        pitch,
        tick: patStart + step * stepTicks,
        duration: isDrums ? Math.round(stepTicks / 2) : stepTicks,
        velocity: isDrums && (pitch === 42 || pitch === 46) ? 80 : 100,
        origin: 'user',
      };
      auditionNote(pitch, note.velocity, isDrums);
      commit(
        [...track.notes, note],
        `Pattern: added ${isDrums ? (GM_DRUM_NAMES[pitch] ?? pitch) : midiToNoteName(pitch)}`,
      );
    }
  };

  const applyToRepetitions = (scope: 'section' | 'kind') => {
    const len = patEnd - patStart;
    const pattern = notesIn.map((n) => ({ ...n, tick: n.tick - patStart }));
    const targets = layout.filter((s) =>
      scope === 'section' ? s.section.id === span.section.id : s.section.kind === span.section.kind,
    );
    let notes = [...track.notes];
    let changedWindows = 0;
    let skipped = 0;
    for (const t of targets) {
      for (let b = t.startBar; b + patBars <= t.endBar; b += patBars) {
        const ws = barToTick(song, b);
        if (ws === patStart) continue;
        const inWindow = notes.filter((n) => n.tick >= ws && n.tick < ws + len);
        if (inWindow.some((n) => isNoteLocked(song, track, n))) {
          skipped++;
          continue;
        }
        notes = notes.filter((n) => !(n.tick >= ws && n.tick < ws + len));
        notes.push(...pattern.map((n) => ({ ...n, id: randomId('n'), tick: ws + n.tick, locked: false })));
        changedWindows++;
      }
    }
    commit(
      notes,
      `Applied ${patBars}-bar pattern to ${changedWindows} repetitions (${scope === 'section' ? span.section.name : `all ${span.section.kind} sections`})`,
    );
    if (skipped) st.toast('warning', `${skipped} locked repetitions were left unchanged.`);
  };

  const color = track.color || colorForRole(track.role);
  const cell = Math.max(14, Math.min(26, Math.floor(900 / Math.max(16, steps))));
  return (
    <div
      className="scroll"
      style={{ position: 'absolute', inset: 0, padding: 14 }}
      data-testid="pattern-view"
    >
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <Select
          size="sm"
          value={track.id}
          onChange={(id) => st.selectTrack(id)}
          options={song.tracks.filter((t) => t.kind === 'midi').map((t) => ({ value: t.id, label: t.name }))}
        />
        <Select
          size="sm"
          value={span.section.id}
          onChange={(v) => {
            setSectionId(v);
            setOffsetBar(0);
          }}
          options={layout.map((s) => ({ value: s.section.id, label: s.section.name }))}
        />
        <Select
          size="sm"
          value={String(lengthBars)}
          onChange={(v) => setLengthBars(parseInt(v, 10))}
          options={[1, 2, 4, 8].map((n) => ({ value: String(n), label: `${n}-bar loop` }))}
        />
        <Select
          size="sm"
          value={String(offsetBar)}
          onChange={(v) => setOffsetBar(parseInt(v, 10))}
          options={Array.from({ length: Math.max(1, Math.floor(sectionBars / patBars)) }, (_, i) => ({
            value: String(i * patBars),
            label: `Bars ${span.startBar + i * patBars + 1}–${span.startBar + (i + 1) * patBars}`,
          }))}
        />
        <Select
          size="sm"
          value={String(stepsPerBeat)}
          onChange={(v) => setStepsPerBeat(parseInt(v, 10))}
          options={[
            { value: '2', label: '1/8 steps' },
            { value: '4', label: '1/16 steps' },
            { value: '3', label: '1/8 triplets' },
            { value: '6', label: '1/16 triplets' },
          ]}
        />
        <Badge tone={repeats > 1 ? 'ai' : undefined}>
          repeats {repeats}× in {span.section.name}
        </Badge>
        <div className="spacer" />
        <Button
          size="sm"
          onClick={() => applyToRepetitions('section')}
          title="Copy this loop over every window of the section"
        >
          Apply to all repetitions in section
        </Button>
        <Button
          size="sm"
          onClick={() => applyToRepetitions('kind')}
          title={`Copy into every ${span.section.kind} section`}
        >
          Apply to every {span.section.kind}
        </Button>
      </div>
      <div
        style={{
          display: 'inline-grid',
          gridTemplateColumns: `110px repeat(${steps}, ${cell}px)`,
          gap: 2,
          userSelect: 'none',
        }}
      >
        {rows.map((pitch) => (
          <div key={pitch} style={{ display: 'contents' }}>
            <div
              className="small ellipsis"
              style={{
                lineHeight: `${cell}px`,
                color: 'var(--text-muted)',
                paddingRight: 6,
                textAlign: 'right',
              }}
            >
              {isDrums ? (GM_DRUM_NAMES[pitch] ?? `drum ${pitch}`) : midiToNoteName(pitch)}
            </div>
            {Array.from({ length: steps }, (_, step) => {
              const n = cellNote(pitch, step);
              const beatStart = step % stepsPerBeat === 0;
              return (
                <button
                  key={step}
                  onClick={() => toggle(pitch, step)}
                  aria-label={`${pitch} step ${step + 1}${n ? ' on' : ''}`}
                  style={{
                    width: cell,
                    height: cell,
                    padding: 0,
                    border: `1px solid ${n?.locked ? 'var(--lock)' : 'var(--border)'}`,
                    borderLeftColor: beatStart ? 'var(--border-strong)' : undefined,
                    borderRadius: 3,
                    cursor: 'pointer',
                    background: n
                      ? color
                      : Math.floor(step / (stepsPerBeat * 4)) % 2
                        ? 'var(--bg-elev-2)'
                        : 'var(--bg-elev-1)',
                    opacity: n ? 0.45 + (n.velocity / 127) * 0.55 : 1,
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>
        Click cells to toggle notes. Use “Apply to all repetitions” to propagate a loop edit; locked bars are
        never overwritten.
      </p>
    </div>
  );
}
