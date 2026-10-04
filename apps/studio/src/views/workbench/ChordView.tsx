import { useMemo, useState } from 'react';
import {
  TRACK_PALETTE,
  applyOperations,
  chordFunction,
  isChordSectionLocked,
  keyAtTick,
  keyName,
  LockKeys,
  parseChordSymbol,
  sectionLayout,
  suggestChordSubstitutions,
  tickToMusical,
  ticksToBeats,
  type ChordEvent,
  type OpChord,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { Badge, Button, LockButton, TextInput } from '../../ui/kit';
import { propose } from '../../engine/proposals';

const FN_COLOR: Record<string, string> = {
  tonic: TRACK_PALETTE[5],
  predominant: TRACK_PALETTE[10],
  dominant: TRACK_PALETTE[1],
  chromatic: TRACK_PALETTE[3],
};

/** Chord View (spec §18): harmony & chord manipulation with theory-aware substitutions. */
export default function ChordView() {
  const song = useStudio((s) => s.project?.song ?? null);
  const st = useStudio.getState();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const layout = useMemo(() => (song ? sectionLayout(song) : []), [song]);
  if (!song) return null;

  const current = song.chords.find((c) => c.id === editing);
  const suggestions = current ? suggestChordSubstitutions(song, current.id) : [];

  const replaceChord = (chord: ChordEvent, symbol: string, asProposal = false) => {
    if (!parseChordSymbol(symbol))
      return st.toast('error', `“${symbol}” is not a chord symbol I understand.`);
    const sectionSpan = layout.find((s) => chord.tick >= s.startTick && chord.tick < s.endTick);
    if (sectionSpan && isChordSectionLocked(song, sectionSpan.section.id))
      return st.toast('warning', 'Chords in this section are locked.');
    const pos = tickToMusical(song, chord.tick);
    const endPos = tickToMusical(song, chord.tick + chord.duration - 1);
    const op = {
      op: 'set_chords' as const,
      region: { start_bar: pos.bar, end_bar: endPos.bar },
      chords: [] as OpChord[],
    };
    // Keep the other chords in those bars, swap only this one.
    for (const c of song.chords) {
      const p = tickToMusical(song, c.tick);
      if (p.bar < pos.bar || p.bar > endPos.bar) continue;
      op.chords.push({
        bar: p.bar,
        beat: p.beat,
        symbol: c.id === chord.id ? symbol : c.symbol,
        duration_beats: ticksToBeats(song, c.duration, c.tick),
      });
    }
    if (asProposal) {
      propose(song, [op], {
        title: `Chord ${chord.symbol} → ${symbol}`,
        source: 'internal',
        instruction: `Substitute ${symbol}`,
      });
      return;
    }
    const res = applyOperations(song, [op]);
    if (!res.applied) return st.toast('error', res.report.issues[0]?.message ?? 'Chord change rejected');
    st.commit(res.song, `Chord ${chord.symbol} → ${symbol} (bar ${pos.bar})`, 'harmony');
    setEditing(null);
  };

  return (
    <div className="scroll" style={{ position: 'absolute', inset: 0, padding: 16 }} data-testid="chord-view">
      {layout.map((span) => {
        const chords = song.chords.filter((c) => c.tick >= span.startTick && c.tick < span.endTick);
        const key = keyAtTick(song, span.startTick);
        const locked = isChordSectionLocked(song, span.section.id);
        return (
          <div key={span.section.id} className="panel" style={{ marginBottom: 12 }}>
            <div className="panel-header">
              <h3>{span.section.name}</h3>
              <span className="small muted">
                bars {span.startBar + 1}–{span.endBar} · {keyName(key)}
              </span>
              <span className="mono small dim">{chords.map((c) => c.roman ?? '?').join(' – ')}</span>
              <div className="spacer" />
              <LockButton
                locked={locked}
                onToggle={() =>
                  st.toggleLock(
                    LockKeys.sectionChords(span.section.id),
                    `${locked ? 'Unlocked' : 'Locked'} chords in ${span.section.name}`,
                  )
                }
                title="Lock this section's harmony"
              />
            </div>
            <div className="panel-body row wrap" style={{ gap: 6 }}>
              {chords.map((c) => {
                const fn = chordFunction(c, key);
                const beats = ticksToBeats(song, c.duration, c.tick);
                return (
                  <button
                    key={c.id}
                    className={`card selectable ${editing === c.id ? 'selected' : ''}`}
                    style={{
                      minWidth: Math.max(64, beats * 18),
                      textAlign: 'left',
                      cursor: locked ? 'not-allowed' : 'pointer',
                      borderTop: `3px solid ${FN_COLOR[fn]}`,
                    }}
                    onClick={() => {
                      if (locked) return st.toast('info', 'Unlock the section harmony to edit chords.');
                      setEditing(c.id);
                      setDraft(c.symbol);
                    }}
                    title={`${fn} · ${beats} beats`}
                  >
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{c.symbol}</div>
                    <div className="small muted mono">{c.roman}</div>
                    <div className="small dim">{beats} beats</div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {current && (
        <div className="panel" style={{ position: 'sticky', bottom: 0, boxShadow: 'var(--shadow)' }}>
          <div className="panel-header">
            <h3 className="grow">
              Edit chord {current.symbol} <span className="muted small">({current.roman})</span>
            </h3>
            <Button size="sm" variant="ghost" icon="close" onClick={() => setEditing(null)} />
          </div>
          <div className="panel-body col">
            <div className="row">
              <TextInput
                value={draft}
                onChange={setDraft}
                mono
                aria-label="Chord symbol"
                onKeyDown={(e) => e.key === 'Enter' && replaceChord(current, draft)}
              />
              <Button variant="primary" onClick={() => replaceChord(current, draft)}>
                Apply
              </Button>
              <Button
                variant="ai"
                onClick={() => replaceChord(current, draft, true)}
                title="Preview as a proposal first"
              >
                Propose
              </Button>
            </div>
            <div className="field-label">Theory suggestions</div>
            <div className="row wrap">
              {suggestions.map((s) => (
                <button
                  key={s.symbol + s.reason}
                  className="chip"
                  onClick={() => setDraft(s.symbol)}
                  title={s.reason}
                >
                  <strong>{s.symbol}</strong> <span className="dim">{s.roman}</span>
                </button>
              ))}
            </div>
            {suggestions.length > 0 && (
              <div className="small muted">
                {suggestions.find((s) => s.symbol === draft)?.reason ??
                  'Hover a suggestion to see why it works.'}
              </div>
            )}
            <div className="small dim">
              <Badge>Tip</Badge> Changing chords does not move existing notes. Use “Regenerate unlocked” to
              refit bass and accompaniment to new harmony.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
