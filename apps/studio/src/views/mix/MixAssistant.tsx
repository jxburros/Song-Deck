import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { TRACK_NEUTRAL, interpretMixInstruction, stableStringify, tickToMusical, type AutomationLane, type Proposal, type Song } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { propose } from '../../engine/proposals';
import { aiMix } from '../../engine/ai';
import { Badge, Button, Field, Spinner, TextArea } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ProviderPicker } from '../shared/ProviderPicker';
import { auditionMixer } from './mixDraft';
import { AUTOMATION_META, FIELD_META, fmtDb, targetName } from './mixModel';

/**
 * AI Mix Assistant (spec §41): natural-language requests become ordinary mixer and automation
 * changes — never audio regeneration — shown as a field-level diff to accept or reject.
 */

export const MIX_EXAMPLES = [
  'Make the vocal clearer.',
  'Put the violin farther back.',
  'Make the drums hit harder.',
  'Reduce muddiness.',
  'Bring the violin forward in the last chorus and make the vocal slightly drier.',
];

interface LogEntry {
  id: string;
  instruction: string;
  explanation: string;
  source: string;
  proposalId?: string;
  at: string;
}

const useAssistantLog = create<{ entries: LogEntry[]; provider: string }>(() => ({ entries: [], provider: 'auto' }));

let seq = 0;

/** Proposals that only touch the mix (mixer fields and/or automation). */
export function isMixProposal(p: Proposal): boolean {
  const d = p.diff;
  const notes = d.tracks.some((t) => t.added.length || t.removed.length || t.modified.length);
  return !notes && !d.sectionsChanged && !d.tempoChanged && !d.keyChanged && (d.mixerChanged.length > 0 || d.automationChanged);
}

function fmtValue(field: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') {
    const meta = FIELD_META[field];
    return meta ? meta.fmt(v) : String(Number(v.toFixed(3)));
  }
  if (v === undefined || v === null) return '—';
  return String(v);
}

function fieldLabel(field: string, master: boolean): string {
  if (field === 'compressor.enabled') return master ? 'Glue compressor' : 'Compressor';
  if (field === 'eq.enabled') return 'EQ';
  if (field === 'limiter.enabled') return 'Limiter';
  if (field === 'phaseInvert') return 'Phase invert';
  if (field === 'mute') return 'Mute';
  if (field === 'solo') return 'Solo';
  const meta = FIELD_META[field];
  if (meta) return master && field.startsWith('compressor.') ? meta.label.replace('Compressor', 'Glue compressor') : meta.label;
  return field;
}

function delta(field: string, before: unknown, after: unknown): { text: string; dir: 'up' | 'down' | 'none' } {
  if (typeof before !== 'number' || typeof after !== 'number') return { text: '', dir: 'none' };
  const d = after - before;
  if (Math.abs(d) < 1e-9) return { text: '', dir: 'none' };
  const dir = d > 0 ? 'up' : 'down';
  if (field === 'volumeDb' || /Db$/.test(field)) return { text: `${fmtDb(d)} dB`, dir };
  if (field === 'pan') return { text: d > 0 ? '→ R' : '→ L', dir };
  if (/Send$|^width$|^drive$|feedback|size|damping/.test(field)) return { text: `${d > 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100)}%`, dir };
  return { text: '', dir };
}

interface LaneChange {
  title: string;
  detail: string;
  kind: 'added' | 'changed' | 'removed';
}

function automationChanges(song: Song, before: AutomationLane[], after: AutomationLane[]): LaneChange[] {
  const key = (l: AutomationLane) => `${l.target}|${l.param}`;
  const b = new Map(before.map((l) => [key(l), l]));
  const a = new Map(after.map((l) => [key(l), l]));
  const out: LaneChange[] = [];
  const bars = (l: AutomationLane) => {
    if (!l.points.length) return '';
    const first = tickToMusical(song, l.points[0].tick).bar;
    const last = tickToMusical(song, l.points[l.points.length - 1].tick).bar;
    return first === last ? ` at bar ${first}` : ` over bars ${first}–${last}`;
  };
  const title = (l: AutomationLane) => `${targetName(song, l.target)} · ${AUTOMATION_META[l.param]?.label ?? l.param}`;
  for (const [k, l] of a) {
    const prev = b.get(k);
    if (!prev) {
      const vals = l.points.map((p) => p.value);
      const meta = AUTOMATION_META[l.param];
      const range = vals.length && meta ? ` (${meta.fmt(Math.min(...vals))} … ${meta.fmt(Math.max(...vals))})` : '';
      out.push({ title: title(l), detail: `new lane, ${l.points.length} point${l.points.length === 1 ? '' : 's'}${bars(l)}${range}`, kind: 'added' });
    } else if (stableStringify(prev) !== stableStringify(l)) {
      out.push({ title: title(l), detail: `${prev.points.length} → ${l.points.length} points${bars(l)}${prev.enabled !== l.enabled ? (l.enabled ? ', enabled' : ', disabled') : ''}`, kind: 'changed' });
    }
  }
  for (const [k, l] of b) if (!a.has(k)) out.push({ title: title(l), detail: 'lane removed', kind: 'removed' });
  return out;
}

/** Long assistant explanations collapse to four lines. */
function Explanation({ text, className = 'small mx-proposal-explain' }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220;
  return (
    <div className={className}>
      <div className={long && !open ? 'mx-clamp' : undefined}>{text}</div>
      {long && (
        <button type="button" className="mx-more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function ProposalCard({ proposal, song }: { proposal: Proposal; song: Song }) {
  const [auditioning, setAuditioning] = useState(false);
  const st = useStudio.getState();
  useEffect(() => () => void (auditioning && auditionMixer(null)), [auditioning]);
  const rows = proposal.diff.mixerChanged;
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(r.target, [...(groups.get(r.target) ?? []), r]);
  const lanes = automationChanges(song, proposal.before.automation, proposal.after.automation);
  const issues = proposal.validation.issues.filter((i) => i.severity !== 'info');
  const stopAudition = () => {
    if (auditioning) auditionMixer(null);
    setAuditioning(false);
  };
  return (
    <div className="card mx-proposal" data-testid="mix-proposal">
      <div className="row between">
        <strong className="ellipsis" title={proposal.title}>
          {proposal.title}
        </strong>
        <Badge tone="ai">{proposal.source === 'internal' ? 'on-device' : proposal.source}</Badge>
      </div>
      {proposal.instruction && <div className="small muted">“{proposal.instruction}”</div>}
      {proposal.explanation && <Explanation text={proposal.explanation} />}
      {rows.length > 0 && (
        <div className="mx-diff" role="table" aria-label="Proposed mixer changes">
          {[...groups].map(([target, list]) => {
            const track = song.tracks.find((t) => t.id === target);
            return (
              <div className="mx-diff-group" role="rowgroup" key={target}>
                <div className="mx-diff-target" role="row">
                  <span className="mx-color-dot" style={{ background: target === 'master' ? 'var(--accent)' : (track?.color ?? TRACK_NEUTRAL) }} />
                  <span role="rowheader">{targetName(song, target)}</span>
                </div>
                {list.map((r) => {
                  const d = delta(r.field, r.before, r.after);
                  return (
                    <div className="mx-diff-row" role="row" key={r.field}>
                      <span className="mx-diff-field" role="cell" title={fieldLabel(r.field, target === 'master')}>
                        {fieldLabel(r.field, target === 'master')}
                      </span>
                      <span className="mx-diff-vals" role="cell">
                        <span className="dim">{fmtValue(r.field, r.before)}</span> → {fmtValue(r.field, r.after)}
                      </span>
                      <span className={`mx-delta ${d.dir}`} role="cell">
                        {d.text}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      {lanes.length > 0 && (
        <ul className="mx-lane-changes small">
          {lanes.map((l) => (
            <li key={l.title} className={l.kind}>
              <Icon name="sliders" size={12} /> <strong>{l.title}</strong> — {l.detail}
            </li>
          ))}
        </ul>
      )}
      {issues.length > 0 && (
        <div className="callout warning small" style={{ margin: '6px 0' }}>
          {issues.slice(0, 4).map((i, k) => (
            <div key={k}>
              {i.fixed ? 'Adjusted: ' : i.severity === 'error' ? 'Blocked: ' : 'Note: '}
              {i.message}
            </div>
          ))}
        </div>
      )}
      <div className="row wrap" style={{ marginTop: 8 }}>
        <Button
          size="sm"
          variant="success"
          icon="check"
          onClick={() => {
            stopAudition();
            st.acceptProposal(proposal.id);
            st.toast('success', 'Mix change applied — undo restores the previous mix.');
          }}
        >
          Accept
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon="close"
          onClick={() => {
            stopAudition();
            st.rejectProposal(proposal.id);
          }}
        >
          Reject
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={auditioning ? 'pause' : 'play'}
          active={auditioning}
          aria-pressed={auditioning}
          title="Hear the proposed mixer settings in playback before accepting (automation applies after accepting)"
          onClick={() => {
            const next = !auditioning;
            setAuditioning(next);
            auditionMixer(next ? proposal.after.mixer : null);
            if (next && !useStudio.getState().transport.playing) useStudio.getState().togglePlay();
          }}
        >
          {auditioning ? 'Auditioning' : 'Audition'}
        </Button>
      </div>
    </div>
  );
}

export function MixAssistant({ song }: { song: Song }) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const entries = useAssistantLog((s) => s.entries);
  const provider = useAssistantLog((s) => s.provider);
  const proposals = useStudio((s) => s.proposals);
  const pending = proposals.filter((p) => p.status === 'pending' && isMixProposal(p));
  const st = useStudio.getState();

  const run = async (text: string) => {
    const instr = text.trim();
    if (!instr || busy) return;
    setBusy(true);
    const before = useStudio.getState().activeProposalId;
    let explanation = '';
    let source = 'On-device mix assistant';
    let proposalId: string | undefined;
    try {
      try {
        const res = await aiMix(song, instr, { providerChoice: provider });
        explanation = res.explanation;
        source = res.source || source;
        if (res.proposalCreated) {
          const active = useStudio.getState().activeProposalId;
          proposalId = res.proposalId ?? (active && active !== before ? active : undefined);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        // Always fall back to the deterministic on-device interpreter (spec §51).
        const interp = interpretMixInstruction(song, instr);
        explanation = interp.explanation;
        source = 'On-device mix assistant';
        const p = propose(song, interp.operations, { title: `Mix: ${instr}`, source: 'internal', instruction: instr, explanation: interp.explanation });
        proposalId = p?.id;
        if (!(err instanceof Error && /no provider|not configured|unavailable/i.test(err.message))) {
          st.toast('warning', `AI mix provider unavailable — used the on-device assistant. ${err instanceof Error ? err.message : ''}`);
        }
      }
      useAssistantLog.setState((s) => ({
        entries: [...s.entries, { id: `mx${seq++}`, instruction: instr, explanation: explanation || 'No mixer change was needed.', source, proposalId, at: new Date().toISOString() }].slice(-20),
      }));
      setInstruction('');
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) st.toast('error', `Mix assistant failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-assistant">
      <div className="panel-header">
        <Icon name="sparkles" />
        <h3 className="grow">AI Mix Assistant</h3>
        <Badge tone="ai">mixer moves only</Badge>
      </div>
      <div className="mx-assistant-body">
        <div className="small muted">
          Describe the sound you want. Requests become ordinary mixer and automation changes you can review — audio is never regenerated, so the result
          stays deterministic.
        </div>
        <Field label="Mix instruction">
          <TextArea
            value={instruction}
            onChange={setInstruction}
            rows={3}
            placeholder="e.g. Make the vocal clearer."
            aria-label="Mix instruction"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void run(instruction);
              }
            }}
          />
        </Field>
        <div className="chip-list">
          {MIX_EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="chip" onClick={() => setInstruction(ex)} title="Use this example">
              {ex.length > 44 ? `${ex.slice(0, 42)}…` : ex}
            </button>
          ))}
        </div>
        <div className="row">
          <div className="grow">
            <ProviderPicker role="mixing" value={provider} onChange={(v) => useAssistantLog.setState({ provider: v })} size="sm" />
          </div>
          <Button variant="ai" icon="sparkles" onClick={() => void run(instruction)} disabled={busy || !instruction.trim()}>
            {busy ? <Spinner /> : null}
            {busy ? 'Thinking…' : 'Propose mix change'}
          </Button>
        </div>

        {pending.length > 0 && (
          <div className="col" style={{ marginTop: 6 }}>
            <h4 style={{ margin: 0 }}>Pending proposals</h4>
            {pending.map((p) => (
              <ProposalCard key={p.id} proposal={p} song={song} />
            ))}
          </div>
        )}

        {entries.length > 0 && (
          <div className="col" style={{ marginTop: 6 }}>
            <div className="row between">
              <h4 style={{ margin: 0 }}>Conversation</h4>
              <Button size="sm" variant="ghost" onClick={() => useAssistantLog.setState({ entries: [] })}>
                Clear
              </Button>
            </div>
            {[...entries].reverse().map((e) => {
              const p = e.proposalId ? proposals.find((x) => x.id === e.proposalId) : undefined;
              return (
                <div key={e.id} className="mx-log-entry">
                  <div className="mx-log-user">“{e.instruction}”</div>
                  <Explanation text={e.explanation} className="small" />
                  <div className="row small dim" style={{ marginTop: 4 }}>
                    <span>{e.source}</span>
                    {p && <Badge tone={p.status === 'accepted' ? 'success' : p.status === 'pending' ? 'ai' : undefined}>{p.status}</Badge>}
                    {!e.proposalId && <Badge>no change</Badge>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
