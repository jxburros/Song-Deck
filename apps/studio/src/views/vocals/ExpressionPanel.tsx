import { useMemo, useRef, useState } from 'react';
import { applyOperations, type MusicOperation, type Project, type Song, type Track, type VocalExpression } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import {
  EXPRESSION_FALLBACK,
  EXPRESSION_FIELDS,
  activeRender,
  effectiveExpression,
  expressionSupport,
  formatBars,
  vocalPhrases,
  type ExpressionKey,
  type ExpressionSupport,
} from '../../engine/vocal-model';
import { logVocalActivity, requestResing, useVocalJobs } from '../../engine/vocal-sync';
import { Badge, Button, Field, Select, Slider } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { PhrasePicker } from './PhrasePicker';
import { useVocalSession } from './session';
import { useResolvedProvider } from './shared';

/**
 * Vocal expression (spec §35): the lead vocal's default expression and per-phrase / per-selection
 * overrides (breathiness, tension, vibrato depth & rate, energy, onset, release), applied as
 * validated `set_expression` operations. Shows which parameters the chosen singer honors —
 * unsupported parameters are kept in the project and simply ignored by that provider.
 */

type Values = Required<Pick<VocalExpression, 'breathiness' | 'tension' | 'vibrato' | 'vibratoRate' | 'energy' | 'onset' | 'release'>>;

function fmt(key: ExpressionKey, v: number | string | undefined): string {
  if (v === undefined) return '—';
  if (typeof v === 'string') return v;
  return key === 'vibratoRate' ? `${v.toFixed(1)} Hz` : v.toFixed(2);
}

function summarize(song: Song, notes: Track['notes']): { values: Values; mixed: Set<ExpressionKey> } {
  const values: Values = { ...EXPRESSION_FALLBACK, ...(song.vocals.defaultExpression as Partial<Values>) };
  const mixed = new Set<ExpressionKey>();
  if (!notes.length) return { values, mixed };
  for (const f of EXPRESSION_FIELDS) {
    const vals = notes.map((n) => (effectiveExpression(song, n) as Record<string, unknown>)[f.key] ?? (EXPRESSION_FALLBACK as Record<string, unknown>)[f.key]);
    if (f.kind === 'choice') {
      const counts = new Map<string, number>();
      for (const v of vals) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      (values as Record<string, unknown>)[f.key] = top[0];
      if (counts.size > 1) mixed.add(f.key);
    } else {
      const nums = vals.map(Number).filter(Number.isFinite);
      const avg = nums.reduce((a, b) => a + b, 0) / Math.max(1, nums.length);
      (values as Record<string, unknown>)[f.key] = Math.round(avg * 100) / 100;
      if (nums.some((x) => Math.abs(x - avg) > 0.02)) mixed.add(f.key);
    }
  }
  return { values, mixed };
}

function ExpressionControls({
  values,
  draft,
  mixed,
  support,
  onChange,
  onCommit,
  idPrefix,
}: {
  values: Values;
  draft: Partial<Values>;
  mixed?: Set<ExpressionKey>;
  support: ExpressionSupport;
  onChange: (key: ExpressionKey, v: number | string) => void;
  onCommit?: (key: ExpressionKey, v: number | string) => void;
  idPrefix: string;
}) {
  return (
    <div className="vx-expr-grid">
      {EXPRESSION_FIELDS.map((f) => {
        const v = (draft as Record<string, number | string | undefined>)[f.key] ?? (values as Record<string, number | string>)[f.key];
        const ignored = !support.unknown && !support.supported.includes(f.key);
        const edited = (draft as Record<string, unknown>)[f.key] !== undefined;
        const label = (
          <span className={`row ${ignored ? 'vx-ignored' : ''}`} style={{ gap: 5 }}>
            {f.label}
            {edited && <span className="vx-dot" title="Changed" />}
            {mixed?.has(f.key) && !edited && (
              <span className="small dim" style={{ textTransform: 'none', letterSpacing: 0 }}>
                (mixed)
              </span>
            )}
            {ignored && (
              <span className="small dim" style={{ textTransform: 'none', letterSpacing: 0 }}>
                · ignored by this singer
              </span>
            )}
          </span>
        );
        if (f.kind === 'choice') {
          return (
            <Field key={f.key} label={label}>
              <Select
                size="sm"
                value={String(v)}
                onChange={(x) => {
                  onChange(f.key, x);
                  onCommit?.(f.key, x);
                }}
                options={(f.options ?? []).map((o) => ({ value: o, label: o }))}
                aria-label={`${idPrefix} ${f.label}`}
              />
            </Field>
          );
        }
        return (
          <div key={f.key} aria-label={`${idPrefix} ${f.label}`}>
            <Slider
              label={label}
              value={Number(v)}
              min={f.kind === 'rate' ? 3 : 0}
              max={f.kind === 'rate' ? 8 : 1}
              step={f.kind === 'rate' ? 0.1 : 0.01}
              format={(x) => fmt(f.key, x)}
              accent={edited}
              onChange={(x) => onChange(f.key, x)}
              onCommit={(x) => onCommit?.(f.key, x)}
            />
          </div>
        );
      })}
    </div>
  );
}

function SupportChips({ support, providerName }: { support: ExpressionSupport; providerName: string }) {
  return (
    <div className="card col" style={{ gap: 6 }} data-testid="expression-support">
      <div className="row between">
        <strong className="small">What {providerName} does with expression</strong>
        <Badge tone={support.unknown ? 'warning' : 'ai'}>{support.unknown ? 'not declared' : `${support.supported.length}/${EXPRESSION_FIELDS.length} supported`}</Badge>
      </div>
      <div className="chip-list">
        {EXPRESSION_FIELDS.map((f) => {
          const ok = support.unknown || support.supported.includes(f.key);
          return (
            <span key={f.key} className={`vx-param ${ok ? 'ok' : 'off'}`} title={ok ? 'Sent and honored' : 'Ignored by this provider'}>
              {ok ? '✓' : '–'} {f.label}
            </span>
          );
        })}
      </div>
      <div className="small muted">
        {support.note} Unsupported parameters are ignored (spec §35) — they stay in the project, so a singer that supports them will use them later.
      </div>
    </div>
  );
}

export function ExpressionPanel({ project, track }: { project: Project; track: Track }) {
  const song = project.song;
  const st = useStudio.getState();
  const session = useVocalSession();
  const selection = useStudio((s) => s.selection);
  const customInstruments = useSettings((s) => s.customInstruments);
  const autoResing = useVocalJobs((s) => s.autoResing);
  const singer = useResolvedProvider('vocals', session.singerProvider);
  const support = expressionSupport(singer?.providerId, singer?.adapter, singer?.extra?.expressionParams);
  const phrases = useMemo(() => vocalPhrases(song, track), [song, track]);
  const selNotes = selection.noteIds.filter((id) => track.notes.some((n) => n.id === id));
  const [scope, setScope] = useState<'phrase' | 'selection'>(selNotes.length ? 'selection' : 'phrase');
  const phrase = phrases.find((p) => p.id === session.phraseId) ?? phrases[0];
  const noteIds = scope === 'selection' && selNotes.length ? selNotes : (phrase?.noteIds ?? []);
  const idSet = new Set(noteIds);
  const notes = track.notes.filter((n) => idSet.has(n.id));
  const { values, mixed } = useMemo(() => summarize(song, notes), [song, notes.map((n) => n.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<Partial<Values>>({});
  const scopeKey = `${scope}:${noteIds.join(',')}`;
  const lastScope = useRef(scopeKey);
  if (lastScope.current !== scopeKey) {
    lastScope.current = scopeKey;
    if (Object.keys(draft).length) setDraft({});
  }
  const defaults: Values = { ...EXPRESSION_FALLBACK, ...(song.vocals.defaultExpression as Partial<Values>) };
  const [defDraft, setDefDraft] = useState<Partial<Values>>({});
  const render = activeRender(project, track.id);
  const scopeLabel = scope === 'selection' && selNotes.length ? `${selNotes.length} selected note${selNotes.length === 1 ? '' : 's'}` : (phrase?.label ?? '—');
  const range = notes.length ? { startTick: Math.min(...notes.map((n) => n.tick)), endTick: Math.max(...notes.map((n) => n.tick + n.duration)) } : null;

  const commitDefault = (key: ExpressionKey, v: number | string) => {
    const cur = useStudio.getState().project?.song;
    if (!cur) return;
    if ((cur.vocals.defaultExpression as Record<string, unknown>)[key] === v) return;
    st.commit({ ...cur, vocals: { ...cur.vocals, defaultExpression: { ...cur.vocals.defaultExpression, [key]: v } } }, `Default vocal expression: ${key} ${fmt(key, v)}`, 'vocals');
    setDefDraft({});
    logVocalActivity('expression', `Default ${key} → ${fmt(key, v)}`);
  };

  const apply = () => {
    const cur = useStudio.getState().project?.song;
    if (!cur || !noteIds.length || !Object.keys(draft).length) return;
    const ops: MusicOperation[] = [{ op: 'set_expression', track: track.id, note_ids: noteIds, expression: draft as VocalExpression, reason: `Vocal expression on ${scopeLabel}` }];
    const r = applyOperations(cur, ops, { customInstruments });
    const errors = r.report.issues.filter((i) => i.severity === 'error' && !i.fixed);
    if (!r.applied || errors.length) {
      st.toast('warning', errors[0]?.message ?? 'Nothing changed (the notes may be locked).');
      if (!r.applied) return;
    }
    const what = Object.entries(draft)
      .map(([k, v]) => `${k} ${fmt(k as ExpressionKey, v as number | string)}`)
      .join(', ');
    st.commit(r.song, `Vocal expression on ${scopeLabel}: ${what}`, 'vocals');
    logVocalActivity('expression', `${scopeLabel}: ${what}`);
    setDraft({});
    if (render && autoResing && range) {
      const label = scope === 'phrase' && phrase ? phrase.label : `${formatBars(cur, range.startTick, range.endTick)}`;
      requestResing({ projectId: project.meta.id, trackId: track.id, startTick: range.startTick, endTick: range.endTick, label, reason: `expression: ${what}` });
    }
  };

  return (
    <div className="col" style={{ gap: 12 }} data-testid="expression-panel">
      <SupportChips support={support} providerName={singer?.providerName ?? 'the singer'} />
      <div className="vx-two">
        <div className="panel">
          <div className="panel-header">
            <Icon name="sliders" />
            <h3 className="grow">Default expression</h3>
            <span className="small dim">every note, unless overridden</span>
          </div>
          <div className="panel-body">
            <ExpressionControls
              values={defaults}
              draft={defDraft}
              support={support}
              idPrefix="Default"
              onChange={(k, v) => setDefDraft((d) => ({ ...d, [k]: v }))}
              onCommit={commitDefault}
            />
          </div>
        </div>
        <div className="panel">
          <div className="panel-header">
            <Icon name="pencil" />
            <h3 className="grow">Phrase expression</h3>
            <Select
              size="sm"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'phrase', label: 'Selected phrase' },
                { value: 'selection', label: `Piano-roll selection (${selNotes.length})`, disabled: !selNotes.length },
              ]}
              aria-label="Expression scope"
              style={{ width: 'auto' }}
            />
          </div>
          <div className="panel-body col">
            {scope === 'phrase' && <PhrasePicker song={song} phrases={phrases} value={phrase?.id ?? null} onChange={(id) => session.set({ phraseId: id })} height={180} />}
            <div className="row between">
              <strong className="small">{scopeLabel}</strong>
              <span className="small dim">{notes.length} notes</span>
            </div>
            <ExpressionControls values={values} draft={draft} mixed={mixed} support={support} idPrefix="Phrase" onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))} />
            <div className="row wrap">
              <Button variant="primary" icon="check" onClick={apply} disabled={!Object.keys(draft).length || !notes.length}>
                Apply to {notes.length} note{notes.length === 1 ? '' : 's'}
              </Button>
              <Button variant="ghost" onClick={() => setDraft({ ...defaults })} disabled={!notes.length} title="Set every parameter to the default expression">
                Match defaults
              </Button>
              {Object.keys(draft).length > 0 && (
                <Button variant="ghost" onClick={() => setDraft({})}>
                  Discard
                </Button>
              )}
              <div className="spacer" />
              <Button
                size="sm"
                variant="ghost"
                icon="midi"
                onClick={() => {
                  st.selectTrack(track.id);
                  if (noteIds.length) st.setSelection({ noteIds, trackIds: [track.id] });
                  st.setWorkbenchView('piano-roll');
                }}
                title="Draw breathiness / tension / vibrato lanes per note in the piano roll"
              >
                Expression lanes
              </Button>
            </div>
            <div className="small dim">
              Applied as a validated <code>set_expression</code> operation — locked notes are never touched.
              {render ? (autoResing ? ' The render is re-sung for this phrase only.' : ' Re-sing the phrase from the Render tab.') : ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
