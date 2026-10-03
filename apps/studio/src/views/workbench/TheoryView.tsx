import { useMemo, useState } from 'react';
import { applyTheoryControl, explainSection, explainSong, randomSeed, type TheoryControl } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { Badge, Button, Spinner } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { propose } from '../../engine/proposals';
import { aiExplain } from '../../engine/ai';
import { ProviderPicker } from '../shared/ProviderPicker';

const CONTROLS: { id: TheoryControl; label: string; hint: string }[] = [
  { id: 'darker', label: 'Make darker', hint: 'Modal interchange toward the parallel minor' },
  { id: 'more-tension', label: 'Increase tension', hint: 'Extensions, suspensions, dominant pull' },
  { id: 'less-conventional', label: 'Make less conventional', hint: 'Unexpected but voice-led substitutions' },
  { id: 'modal', label: 'Try modal harmony', hint: 'Re-colour with a mode (Dorian, Mixolydian, Lydian…)' },
  { id: 'brighter', label: 'Make brighter', hint: 'Borrow from the parallel major / Lydian' },
  { id: 'simplify', label: 'Simplify', hint: 'Back to strong diatonic functions' },
];

/** Theory View (spec §43): explains the actual music and offers theory-driven changes as proposals. */
export default function TheoryView() {
  const song = useStudio((s) => s.project?.song ?? null);
  const st = useStudio.getState();
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [aiText, setAiText] = useState<{ sectionId: string; text: string; source: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [explainer, setExplainer] = useState('auto');
  const overview = useMemo(() => (song ? explainSong(song) : null), [song]);
  if (!song || !overview) return null;
  const current = song.sections.find((s) => s.id === sectionId) ?? song.sections.find((s) => s.kind === 'chorus') ?? song.sections[0];
  const ex = explainSection(song, current.id);

  const control = (c: TheoryControl) => {
    const res = applyTheoryControl(song, current.id, c, { seed: randomSeed() });
    if (!res.understood || !res.operations.length) return st.toast('info', res.explanation);
    propose(song, res.operations, { title: `${CONTROLS.find((x) => x.id === c)?.label} — ${current.name}`, source: 'internal', explanation: res.explanation });
  };

  const askAi = async () => {
    setBusy(true);
    try {
      const r = await aiExplain(song, current.id, { providerChoice: explainer });
      setAiText({ sectionId: current.id, text: r.text, source: r.source });
    } catch (err) {
      st.toast('warning', `Explanation unavailable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scroll" style={{ position: 'absolute', inset: 0, padding: 16 }} data-testid="theory-view">
      <div className="row wrap" style={{ marginBottom: 12 }}>
        {song.sections.map((s) => (
          <button key={s.id} className={`chip ${s.id === current.id ? 'on' : ''}`} onClick={() => setSectionId(s.id)}>
            {s.name}
          </button>
        ))}
      </div>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="panel">
          <div className="panel-header">
            <Icon name="book" />
            <h3 className="grow">{ex.sectionName}</h3>
            <Badge>{ex.keyName}</Badge>
          </div>
          <div className="panel-body">
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 2 }}>{ex.chords.map((c) => c.symbol).join(' – ')}</div>
            <div className="muted" style={{ marginBottom: 12 }}>
              {ex.romanSummary}
            </div>
            {ex.narrative.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
            {ex.comparisons.length > 0 && (
              <>
                <h4 style={{ marginTop: 12 }}>Compared with the rest of the song</h4>
                {ex.comparisons.map((p, i) => (
                  <p key={i} className="muted">
                    {p}
                  </p>
                ))}
              </>
            )}
            <h4 style={{ marginTop: 12 }}>Chord by chord</h4>
            <table className="table">
              <thead>
                <tr>
                  <th>Bar</th>
                  <th>Chord</th>
                  <th>Roman</th>
                  <th>Function</th>
                  <th>Tension</th>
                </tr>
              </thead>
              <tbody>
                {ex.chords.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.bar}</td>
                    <td style={{ fontWeight: 600 }}>{c.symbol}</td>
                    <td className="mono">
                      {c.roman}
                      {c.borrowedFrom && (
                        <Badge tone="warning" title={`Borrowed from ${c.borrowedFrom}`}>
                          borrowed
                        </Badge>
                      )}
                      {c.secondary && <Badge tone="ai">secondary</Badge>}
                    </td>
                    <td>{c.function}</td>
                    <td style={{ width: 120 }}>
                      <div className="progress">
                        <div style={{ width: `${Math.round(c.tension * 100)}%`, background: c.tension > 0.6 ? 'var(--danger)' : c.tension > 0.35 ? 'var(--warning)' : 'var(--success)' }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ex.cadences.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <h4>Cadences</h4>
                {ex.cadences.map((c, i) => (
                  <div key={i} className="small">
                    <strong>Bar {c.bar}:</strong> {c.type} — <span className="muted">{c.description}</span>
                  </div>
                ))}
              </div>
            )}
            {ex.melody && (
              <div style={{ marginTop: 10 }}>
                <h4>Melody</h4>
                <div className="small muted">
                  Range {ex.melody.lowest}–{ex.melody.highest} ({ex.melody.range}) · contour {ex.melody.contour} · {Math.round(ex.melody.chordToneRatio * 100)}% chord tones ·{' '}
                  {Math.round(ex.melody.stepwiseRatio * 100)}% stepwise
                </div>
              </div>
            )}
            {ex.rhythm && (
              <div style={{ marginTop: 10 }}>
                <h4>Rhythm</h4>
                <div className="small muted">{ex.rhythm.description}</div>
              </div>
            )}
          </div>
        </div>

        <div className="col">
          <div className="panel">
            <div className="panel-header">
              <h3 className="grow">Theory controls</h3>
              <span className="small muted">Results arrive as proposals</span>
            </div>
            <div className="panel-body grid-2">
              {CONTROLS.map((c) => (
                <Button key={c.id} onClick={() => control(c.id)} title={c.hint} style={{ justifyContent: 'flex-start', height: 'auto', padding: '8px 10px', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <strong>{c.label}</strong>
                  <span className="small dim" style={{ whiteSpace: 'normal', textAlign: 'left' }}>
                    {c.hint}
                  </span>
                </Button>
              ))}
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">
              <h3 className="grow">Ask for a deeper explanation</h3>
            </div>
            <div className="panel-body col">
              <div className="row">
                <div className="grow">
                  <ProviderPicker role="analysis" value={explainer} onChange={setExplainer} size="sm" />
                </div>
                <Button variant="ai" icon="sparkles" onClick={() => void askAi()} disabled={busy}>
                  {busy ? <Spinner /> : 'Explain'}
                </Button>
              </div>
              {aiText && aiText.sectionId === current.id && (
                <div className="callout" style={{ whiteSpace: 'pre-wrap' }}>
                  <div className="small dim" style={{ marginBottom: 4 }}>
                    {aiText.source}
                  </div>
                  {aiText.text}
                </div>
              )}
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">
              <h3 className="grow">Song overview</h3>
            </div>
            <div className="panel-body">
              {overview.overview.map((p, i) => (
                <p key={i} className="small">
                  {p}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
