import type { Song } from '@songdeck/core';
import { createTimeMap } from '@songdeck/core';
import { formatBars, type VocalPhrase } from '../../engine/vocal-model';
import { Button } from '../../ui/kit';
import { playFrom } from './shared';

/** Phrase list of the vocal track — the "here" of per-phrase expression and vocal instructions. */
export function PhrasePicker({
  song,
  phrases,
  value,
  onChange,
  height = 260,
}: {
  song: Song;
  phrases: VocalPhrase[];
  value: string | null;
  onChange: (id: string) => void;
  height?: number;
}) {
  if (!phrases.length) return <div className="small muted">The vocal track has no notes yet.</div>;
  const tm = createTimeMap(song);
  return (
    <div className="vx-phrases" role="listbox" aria-label="Vocal phrases" style={{ maxHeight: height }}>
      {phrases.map((p) => (
        <div
          key={p.id}
          role="option"
          aria-selected={p.id === value}
          tabIndex={0}
          className={`vx-phrase ${p.id === value ? 'selected' : ''}`}
          onClick={() => onChange(p.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onChange(p.id);
            }
          }}
          data-testid="vocal-phrase"
        >
          <div className="row between" style={{ gap: 6 }}>
            <span className="vx-phrase-label">{p.label}</span>
            <span className="small dim nowrap">
              {formatBars(song, p.startTick, p.endTick)} · {p.noteIds.length} note
              {p.noteIds.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="row between" style={{ gap: 6 }}>
            <span className={`small ellipsis ${p.text ? '' : 'dim'}`}>
              {p.text ? `“${p.text}”` : 'no lyrics attached'}
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon="play"
              aria-label={`Play ${p.label}`}
              title="Play the song from this phrase"
              onClick={(e) => {
                e.stopPropagation();
                playFrom(Math.max(0, tm.tickToSeconds(p.startTick) - 0.5));
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
