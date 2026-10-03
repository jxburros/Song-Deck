import { useMemo, useState } from 'react';
import { applyOperations, LockKeys, sectionLayout, songDurationSeconds, type MusicOperation, type SectionKind } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { Badge, Button, CommitNumber, CommitText, Field, LockButton, Select } from '../../ui/kit';
import { EnergyCurve } from '../shared/EnergyCurve';
import { SECTION_KINDS } from '../compose/BlueprintEditor';
import { formatDuration } from '../../hooks';

/** Structure View (spec §18): song sections, proportions, energy curve, repetition. */
export default function StructureView() {
  const song = useStudio((s) => s.project?.song ?? null);
  const st = useStudio.getState();
  const [sel, setSel] = useState<string | null>(null);
  const layout = useMemo(() => (song ? sectionLayout(song) : []), [song]);
  if (!song) return null;
  const locked = !!song.locks[LockKeys.structure];
  const totalBars = layout.reduce((n, s) => n + (s.endBar - s.startBar), 0) || 1;
  const section = song.sections.find((s) => s.id === sel) ?? song.sections[0];

  const run = (ops: MusicOperation[], message: string) => {
    if (locked) return st.toast('warning', 'Structure is locked.');
    const res = applyOperations(song, ops);
    const errors = res.report.issues.filter((i) => i.severity === 'error' && !i.fixed);
    if (!res.applied) return st.toast('error', errors[0]?.message ?? 'Change rejected');
    st.commit(res.song, message, 'structure');
  };

  const energies = song.sections.flatMap((s) => (s.energyEnd !== undefined && s.energyEnd !== s.energy ? [s.energy, s.energyEnd] : [s.energy]));
  const pattern = (() => {
    const labels = new Map<string, string>();
    let next = 65;
    return song.sections
      .map((s) => {
        const key = s.repeatOf ?? s.id;
        if (!labels.has(key)) labels.set(key, String.fromCharCode(next++));
        return labels.get(key)!;
      })
      .join('');
  })();

  return (
    <div className="scroll" style={{ position: 'absolute', inset: 0, padding: 16 }} data-testid="structure-view">
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Structure</h2>
        <Badge>{totalBars} bars</Badge>
        <Badge>{formatDuration(songDurationSeconds(song))}</Badge>
        <Badge tone="ai" title="Repetition pattern (same letter = repeated material)">
          {pattern}
        </Badge>
        <div className="spacer" />
        <LockButton locked={locked} onToggle={() => st.toggleLock(LockKeys.structure, `${locked ? 'Unlocked' : 'Locked'} structure`)} title="Lock song structure" />
      </div>

      <div style={{ display: 'flex', gap: 2, marginBottom: 8 }}>
        {layout.map((span) => {
          const s = span.section;
          const w = ((span.endBar - span.startBar) / totalBars) * 100;
          return (
            <button
              key={s.id}
              onClick={() => setSel(s.id)}
              className={`card selectable ${section?.id === s.id ? 'selected' : ''}`}
              style={{ width: `${w}%`, minWidth: 54, padding: '8px 6px', textAlign: 'left', overflow: 'hidden' }}
              title={s.purpose}
            >
              <div className="ellipsis" style={{ fontWeight: 700, fontSize: 12 }}>
                {s.name}
              </div>
              <div className="small dim">{s.bars} bars</div>
              <div style={{ height: 4, marginTop: 6, borderRadius: 2, background: `linear-gradient(to right, rgba(255,138,61,${s.energy / 100}), rgba(255,138,61,${(s.energyEnd ?? s.energy) / 100}))` }} />
            </button>
          );
        })}
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row between">
          <span className="field-label">Energy curve</span>
          <span className="mono small muted">{energies.map((e) => Math.round(e)).join(' → ')}</span>
        </div>
        <EnergyCurve values={energies} width={Math.min(900, 60 * energies.length + 40)} height={60} />
      </div>

      {section && (
        <div className="panel">
          <div className="panel-header">
            <h3 className="grow">{section.name}</h3>
            <Button
              size="sm"
              icon="copy"
              disabled={locked}
              onClick={() => run([{ op: 'insert_section', after: section.id, section: { name: `${section.name} (copy)`, kind: section.kind, bars: section.bars, energy: section.energy }, copy_from: section.id }], `Duplicated ${section.name}`)}
            >
              Duplicate
            </Button>
            <Button
              size="sm"
              icon="plus"
              disabled={locked}
              onClick={() => run([{ op: 'insert_section', after: section.id, section: { name: 'New section', kind: 'custom', bars: 4, energy: section.energy } }], 'Inserted section')}
            >
              Insert after
            </Button>
            <Button
              size="sm"
              disabled={locked || song.sections.indexOf(section) === 0}
              onClick={() => run([{ op: 'move_section', section: section.id, to_index: song.sections.indexOf(section) - 1 }], `Moved ${section.name} earlier`)}
            >
              ← Move
            </Button>
            <Button
              size="sm"
              disabled={locked || song.sections.indexOf(section) === song.sections.length - 1}
              onClick={() => run([{ op: 'move_section', section: section.id, to_index: song.sections.indexOf(section) + 1 }], `Moved ${section.name} later`)}
            >
              Move →
            </Button>
            <Button size="sm" variant="danger" icon="trash" disabled={locked || song.sections.length < 2} onClick={() => run([{ op: 'remove_section', section: section.id }], `Removed ${section.name}`)}>
              Remove
            </Button>
          </div>
          <div className="panel-body">
            <div className="grid-4">
              <Field label="Name">
                <CommitText value={section.name} onCommit={(name) => run([{ op: 'update_section', section: section.id, changes: { name } }], `Renamed section to ${name}`)} />
              </Field>
              <Field label="Kind">
                <Select value={section.kind} onChange={(kind: SectionKind) => run([{ op: 'update_section', section: section.id, changes: { kind } }], `Section kind → ${kind}`)} options={SECTION_KINDS} />
              </Field>
              <Field label="Bars" hint="Changing length shifts later material">
                <CommitNumber value={section.bars} min={1} max={128} onCommit={(bars) => run([{ op: 'update_section', section: section.id, changes: { bars: Math.round(bars) } }], `${section.name}: ${Math.round(bars)} bars`)} />
              </Field>
              <Field label="Feel">
                <Select
                  value={section.feel ?? 'normal'}
                  onChange={(feel) => run([{ op: 'update_section', section: section.id, changes: { feel } }], `${section.name}: ${feel} feel`)}
                  options={['normal', 'half-time', 'double-time'] as const}
                />
              </Field>
              <Field label="Energy (start)">
                <CommitNumber value={section.energy} min={0} max={100} onCommit={(energy) => run([{ op: 'update_section', section: section.id, changes: { energy } }], `${section.name}: energy ${energy}`)} />
              </Field>
              <Field label="Energy (end)">
                <CommitNumber
                  value={section.energyEnd ?? section.energy}
                  min={0}
                  max={100}
                  onCommit={(energyEnd) => run([{ op: 'update_section', section: section.id, changes: { energyEnd } }], `${section.name}: energy ramp to ${energyEnd}`)}
                />
              </Field>
              <Field label="Purpose" className="grow">
                <CommitText value={section.purpose ?? ''} onCommit={(purpose) => run([{ op: 'update_section', section: section.id, changes: { purpose } }], `${section.name}: purpose`)} />
              </Field>
              <Field label="Mood">
                <CommitText
                  value={(section.mood ?? []).join(', ')}
                  onCommit={(v) => run([{ op: 'update_section', section: section.id, changes: { mood: v.split(',').map((x) => x.trim()).filter(Boolean) } }], `${section.name}: mood`)}
                />
              </Field>
            </div>
            {section.repeatOf && (
              <div className="small muted" style={{ marginTop: 8 }}>
                Repeats material from {song.sections.find((s) => s.id === section.repeatOf)?.name}.
              </div>
            )}
            <div className="small dim" style={{ marginTop: 8 }}>
              Energy and feel guide the generators — use “Regenerate unlocked” after changing them.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
