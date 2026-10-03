import { parseChordSymbol, type CompositionPlan, type PlanSection } from '@songdeck/core';
import { NumberInput, Select, TextInput } from '../../ui/kit';
import { EnergyCurve } from '../shared/EnergyCurve';

/** The abstract composition plan table of spec §15 (Section | Bars | Harmony | Energy | Purpose). */
export function PlanTable({ plan, onChange }: { plan: CompositionPlan; onChange: (p: CompositionPlan) => void }) {
  const setRow = (i: number, patch: Partial<PlanSection>) => onChange({ ...plan, sections: plan.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const energies = plan.sections.flatMap((s) => (s.energyEnd !== undefined && s.energyEnd !== s.energy ? [s.energy, s.energyEnd] : [s.energy]));
  return (
    <div className="panel">
      <div className="panel-header">
        <h3 className="grow">Composition Plan</h3>
        <EnergyCurve values={energies} width={260} height={36} />
      </div>
      <div className="panel-body">
        <table className="table">
          <thead>
            <tr>
              <th>Section</th>
              <th className="num">Bars</th>
              <th>Harmony</th>
              <th className="num">Energy</th>
              <th>Purpose</th>
              <th>Feel</th>
            </tr>
          </thead>
          <tbody>
            {plan.sections.map((s, i) => {
              const invalid = s.harmony.filter((h) => !parseChordSymbol(h));
              return (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{s.name}</td>
                  <td style={{ width: 80 }}>
                    <NumberInput size="sm" value={s.bars} min={1} max={64} onChange={(bars) => setRow(i, { bars: Math.round(bars) })} />
                  </td>
                  <td>
                    <TextInput
                      size="sm"
                      mono
                      value={s.harmony.join(' – ')}
                      onChange={(v) => setRow(i, { harmony: v.split(/\s*[–,]\s*|\s+-\s+|\s+/).filter(Boolean) })}
                      style={invalid.length ? { borderColor: 'var(--danger)' } : undefined}
                      title={invalid.length ? `Unrecognized chord: ${invalid.join(', ')}` : 'Chord symbols separated by spaces or dashes'}
                    />
                  </td>
                  <td style={{ width: 130 }}>
                    <div className="row">
                      <NumberInput size="sm" value={s.energy} min={0} max={100} onChange={(energy) => setRow(i, { energy })} />
                      <span className="dim">→</span>
                      <NumberInput size="sm" value={s.energyEnd ?? s.energy} min={0} max={100} onChange={(energyEnd) => setRow(i, { energyEnd })} />
                    </div>
                  </td>
                  <td>
                    <TextInput size="sm" value={s.purpose} onChange={(purpose) => setRow(i, { purpose })} />
                  </td>
                  <td style={{ width: 120 }}>
                    <Select
                      size="sm"
                      value={s.feel ?? 'normal'}
                      onChange={(feel) => setRow(i, { feel })}
                      options={['normal', 'half-time', 'double-time'] as const}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {plan.notes && <div className="callout" style={{ marginTop: 10 }}>{plan.notes}</div>}
      </div>
    </div>
  );
}
