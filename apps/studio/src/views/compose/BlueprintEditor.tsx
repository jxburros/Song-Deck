import { useMemo } from 'react';
import {
  BUILTIN_INSTRUMENTS,
  FLAT_NAMES,
  midiToNoteName,
  noteNameToMidi,
  type AvoidRule,
  type Blueprint,
  type BlueprintSection,
  type BlueprintTrack,
  type GenreProfile,
  type MacroSettings,
  type ModeName,
  type MusicalFunction,
  type SectionKind,
  type TrackRole,
  type VocalMode,
  type VoiceType,
} from '@songdeck/core';
import { useSettings } from '../../state/settings';
import { Button, Field, NumberInput, Select, Slider, TextInput } from '../../ui/kit';
import { Icon } from '../../ui/icons';

export const SECTION_KINDS: SectionKind[] = [
  'intro',
  'verse',
  'pre-chorus',
  'chorus',
  'post-chorus',
  'bridge',
  'breakdown',
  'build',
  'drop',
  'solo',
  'interlude',
  'final-chorus',
  'outro',
  'custom',
];
export const TRACK_ROLES: TrackRole[] = [
  'drums',
  'percussion',
  'bass',
  'rhythm-guitar',
  'lead-guitar',
  'keys',
  'strings',
  'synth-pad',
  'synth-arp',
  'synth-lead',
  'synth-seq',
  'vocal',
  'custom',
];
export const FUNCTIONS: MusicalFunction[] = [
  'melody',
  'counter-melody',
  'harmony',
  'accompaniment',
  'bass-line',
  'rhythm',
  'pad',
  'hook',
  'fills',
  'solo',
  'texture',
];
export const AVOID_RULES: AvoidRule[] = ['double-vocal', 'parallel-fifths', 'busy-verses', 'high-register', 'low-register', 'chromaticism', 'syncopation', 'large-leaps'];
export const MODES: ModeName[] = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'harmonic-minor', 'melodic-minor'];
const VOICE_TYPES: VoiceType[] = ['soprano', 'mezzo', 'alto', 'tenor', 'baritone', 'bass'];
const VOCAL_MODES: { value: VocalMode; label: string }[] = [
  { value: 'none', label: 'No vocal (instrumental)' },
  { value: 'melody-only', label: 'Vocal melody only (vocal.mid)' },
  { value: 'placeholder', label: 'Placeholder vocal' },
  { value: 'ai-singer', label: 'AI singer' },
  { value: 'voice-conversion', label: 'User voice conversion' },
  { value: 'recorded', label: 'Recorded vocal' },
];

export const MACRO_INFO: { key: keyof MacroSettings; label: string; left: string; right: string }[] = [
  { key: 'complexity', label: 'Complexity', left: 'Simple', right: 'Complex' },
  { key: 'energy', label: 'Energy', left: 'Calm', right: 'Aggressive' },
  { key: 'density', label: 'Density', left: 'Sparse', right: 'Busy' },
  { key: 'humanization', label: 'Humanization', left: 'Mechanical', right: 'Loose' },
  { key: 'melodicMovement', label: 'Melodic movement', left: 'Static', right: 'Active' },
  { key: 'harmonicTension', label: 'Harmonic tension', left: 'Stable', right: 'Dissonant' },
  { key: 'repetition', label: 'Repetition', left: 'Predictable', right: 'Varied' },
  { key: 'syncopation', label: 'Syncopation', left: 'Straight', right: 'Syncopated' },
  { key: 'dynamics', label: 'Dynamics', left: 'Flat', right: 'Expressive' },
];

function NoteField({ value, onChange, placeholder }: { value?: number; onChange: (v: number | undefined) => void; placeholder: string }) {
  return (
    <TextInput
      size="sm"
      value={value === undefined ? '' : midiToNoteName(value)}
      placeholder={placeholder}
      onChange={(v) => {
        if (!v.trim()) return onChange(undefined);
        const m = noteNameToMidi(v);
        if (m !== null) onChange(m);
      }}
      style={{ width: 56 }}
    />
  );
}

export function BlueprintEditor({ blueprint, onChange, genres }: { blueprint: Blueprint; onChange: (b: Blueprint) => void; genres: GenreProfile[] }) {
  const customInstruments = useSettings((s) => s.customInstruments);
  const instruments = useMemo(() => [...BUILTIN_INSTRUMENTS, ...customInstruments], [customInstruments]);
  const bp = blueprint;
  const set = (patch: Partial<Blueprint>) => onChange({ ...bp, ...patch });
  const setTrack = (i: number, patch: Partial<BlueprintTrack>) =>
    set({ instrumentation: bp.instrumentation.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const setSection = (i: number, patch: Partial<BlueprintSection>) => set({ structure: bp.structure.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const totalBars = bp.structure.reduce((n, s) => n + s.bars, 0);
  const seconds = (totalBars * bp.meter.numerator * (4 / bp.meter.denominator) * 60) / bp.tempo;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="panel">
        <div className="panel-header">
          <h3 className="grow">Song Blueprint</h3>
          <span className="small muted">
            {totalBars} bars · ≈{Math.floor(seconds / 60)}:{String(Math.round(seconds % 60)).padStart(2, '0')}
          </span>
        </div>
        <div className="panel-body">
          <div className="grid-4">
            <Field label="Title">
              <TextInput value={bp.title} onChange={(title) => set({ title })} />
            </Field>
            <Field label="Tempo (BPM)">
              <NumberInput value={bp.tempo} min={30} max={300} onChange={(tempo) => set({ tempo })} />
            </Field>
            <Field label="Meter">
              <div className="row">
                <NumberInput value={bp.meter.numerator} min={1} max={15} onChange={(n) => set({ meter: { ...bp.meter, numerator: Math.round(n) } })} />
                <span>/</span>
                <Select
                  value={String(bp.meter.denominator)}
                  onChange={(d) => set({ meter: { ...bp.meter, denominator: parseInt(d, 10) } })}
                  options={['2', '4', '8', '16']}
                />
              </div>
            </Field>
            <Field label="Key">
              <div className="row">
                <Select
                  value={String(bp.key.tonic)}
                  onChange={(t) => set({ key: { ...bp.key, tonic: parseInt(t, 10) } })}
                  options={FLAT_NAMES.map((n, i) => ({ value: String(i), label: n }))}
                />
                <Select value={bp.key.mode} onChange={(mode) => set({ key: { ...bp.key, mode } })} options={MODES} />
              </div>
            </Field>
          </div>
          <div className="grid-4" style={{ marginTop: 10 }}>
            <Field label="Vocal">
              <Select
                value={bp.vocal?.mode ?? 'none'}
                onChange={(mode) => set({ vocal: { voiceType: bp.vocal?.voiceType ?? 'tenor', mode, description: bp.vocal?.description } })}
                options={VOCAL_MODES}
              />
            </Field>
            <Field label="Voice type">
              <Select
                value={bp.vocal?.voiceType ?? 'tenor'}
                onChange={(voiceType) => set({ vocal: { mode: bp.vocal?.mode ?? 'melody-only', voiceType, description: bp.vocal?.description } })}
                options={VOICE_TYPES}
              />
            </Field>
            <Field label="Lyrics theme">
              <TextInput value={bp.lyricsTheme ?? ''} onChange={(lyricsTheme) => set({ lyricsTheme })} placeholder="e.g. leaving home" />
            </Field>
            <Field label="Styles">
              <TextInput value={bp.styles.join(', ')} onChange={(v) => set({ styles: v.split(',').map((x) => x.trim()).filter(Boolean) })} />
            </Field>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-header">
            <h3 className="grow">Genre blend</h3>
            <Button
              size="sm"
              icon="plus"
              onClick={() => {
                const unused = genres.find((g) => !bp.genreBlend.some((w) => w.genreId === g.id));
                if (unused) set({ genreBlend: [...bp.genreBlend, { genreId: unused.id, weight: 0.2 }] });
              }}
            >
              Add
            </Button>
          </div>
          <div className="panel-body col">
            {bp.genreBlend.map((w, i) => {
              const total = bp.genreBlend.reduce((n, x) => n + x.weight, 0) || 1;
              return (
                <div key={i} className="row">
                  <Select
                    size="sm"
                    value={w.genreId}
                    onChange={(genreId) => set({ genreBlend: bp.genreBlend.map((x, j) => (j === i ? { ...x, genreId } : x)) })}
                    options={genres.map((g) => ({ value: g.id, label: g.name }))}
                    style={{ width: 150 }}
                  />
                  <div className="grow">
                    <Slider value={w.weight} min={0} max={1} step={0.05} onChange={(weight) => set({ genreBlend: bp.genreBlend.map((x, j) => (j === i ? { ...x, weight } : x)) })} />
                  </div>
                  <span className="mono small" style={{ width: 38, textAlign: 'right' }}>
                    {Math.round((w.weight / total) * 100)}%
                  </span>
                  <Button size="sm" variant="ghost" icon="close" onClick={() => set({ genreBlend: bp.genreBlend.filter((_, j) => j !== i) })} />
                </div>
              );
            })}
            <Field label="Moods" hint="e.g. “Melancholy verses”, “Cathartic chorus”, “Defiant ending”">
              <TextInput value={bp.moods.join(', ')} onChange={(v) => set({ moods: v.split(',').map((x) => x.trim()).filter(Boolean) })} />
            </Field>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h3 className="grow">Macro controls</h3>
            <span className="small muted">Shape behaviour without editing notes</span>
          </div>
          <div className="panel-body grid-3" style={{ gap: 10 }}>
            {MACRO_INFO.map((m) => (
              <Slider
                key={m.key}
                label={m.label}
                left={m.left}
                right={m.right}
                value={bp.macros[m.key]}
                onChange={(v) => set({ macros: { ...bp.macros, [m.key]: v } })}
                accent
              />
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3 className="grow">Instrumentation & constraints</h3>
          <Button
            size="sm"
            icon="plus"
            onClick={() => set({ instrumentation: [...bp.instrumentation, { name: 'Piano', instrumentId: 'piano', role: 'keys' }] })}
          >
            Add instrument
          </Button>
        </div>
        <div className="panel-body scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Instrument</th>
                <th>Role</th>
                <th>Function</th>
                <th>Range</th>
                <th>Complexity</th>
                <th>Sections</th>
                <th>Avoid</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bp.instrumentation.map((t, i) => (
                <tr key={i}>
                  <td>
                    <TextInput size="sm" value={t.name} onChange={(name) => setTrack(i, { name })} />
                  </td>
                  <td>
                    <Select
                      size="sm"
                      value={t.instrumentId}
                      onChange={(instrumentId) => {
                        const inst = instruments.find((x) => x.id === instrumentId);
                        setTrack(i, { instrumentId, role: inst?.defaultRole ?? t.role });
                      }}
                      options={instruments.map((x) => ({ value: x.id, label: x.name }))}
                    />
                  </td>
                  <td>
                    <Select size="sm" value={t.role} onChange={(role) => setTrack(i, { role })} options={TRACK_ROLES} />
                  </td>
                  <td>
                    <Select
                      size="sm"
                      value={t.function ?? t.constraints?.function ?? 'accompaniment'}
                      onChange={(fn) => setTrack(i, { function: fn, constraints: { ...t.constraints, function: fn } })}
                      options={FUNCTIONS}
                    />
                  </td>
                  <td>
                    <div className="row">
                      <NoteField value={t.constraints?.lowest} placeholder="low" onChange={(lowest) => setTrack(i, { constraints: { ...t.constraints, lowest } })} />
                      <NoteField value={t.constraints?.highest} placeholder="high" onChange={(highest) => setTrack(i, { constraints: { ...t.constraints, highest } })} />
                    </div>
                  </td>
                  <td>
                    <Select
                      size="sm"
                      value={t.constraints?.complexity ?? 'medium'}
                      onChange={(complexity) => setTrack(i, { constraints: { ...t.constraints, complexity } })}
                      options={['low', 'medium', 'high'] as const}
                    />
                  </td>
                  <td>
                    <TextInput
                      size="sm"
                      placeholder="all"
                      value={(t.constraints?.sectionKinds ?? []).join(', ')}
                      onChange={(v) =>
                        setTrack(i, {
                          constraints: {
                            ...t.constraints,
                            sectionKinds: v
                              .split(',')
                              .map((x) => x.trim() as SectionKind)
                              .filter((x) => SECTION_KINDS.includes(x)),
                          },
                        })
                      }
                      title={`Comma-separated: ${SECTION_KINDS.join(', ')}`}
                    />
                  </td>
                  <td>
                    <Select
                      size="sm"
                      value={(t.constraints?.avoid ?? [])[0] ?? ''}
                      onChange={(v) => setTrack(i, { constraints: { ...t.constraints, avoid: v ? [v as AvoidRule] : [] } })}
                      options={[{ value: '', label: '—' }, ...AVOID_RULES.map((a) => ({ value: a, label: a }))]}
                    />
                  </td>
                  <td>
                    <Button size="sm" variant="ghost" icon="trash" onClick={() => set({ instrumentation: bp.instrumentation.filter((_, j) => j !== i) })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3 className="grow">Structure</h3>
          <Button size="sm" icon="plus" onClick={() => set({ structure: [...bp.structure, { name: 'Section', kind: 'verse', bars: 8, energy: 50 }] })}>
            Add section
          </Button>
        </div>
        <div className="panel-body">
          <table className="table">
            <thead>
              <tr>
                <th>Section</th>
                <th>Kind</th>
                <th className="num">Bars</th>
                <th className="num">Energy</th>
                <th>Purpose / mood</th>
                <th>Harmony (optional)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bp.structure.map((s, i) => (
                <tr key={i}>
                  <td>
                    <TextInput size="sm" value={s.name} onChange={(name) => setSection(i, { name })} />
                  </td>
                  <td>
                    <Select size="sm" value={s.kind} onChange={(kind) => setSection(i, { kind })} options={SECTION_KINDS} />
                  </td>
                  <td style={{ width: 80 }}>
                    <NumberInput size="sm" value={s.bars} min={1} max={64} onChange={(bars) => setSection(i, { bars: Math.round(bars) })} />
                  </td>
                  <td style={{ width: 120 }}>
                    <div className="row">
                      <NumberInput size="sm" value={s.energy ?? 50} min={0} max={100} onChange={(energy) => setSection(i, { energy })} />
                      <NumberInput
                        size="sm"
                        value={s.energyEnd ?? s.energy ?? 50}
                        min={0}
                        max={100}
                        onChange={(energyEnd) => setSection(i, { energyEnd })}
                        title="Energy at section end (ramps)"
                      />
                    </div>
                  </td>
                  <td>
                    <TextInput size="sm" value={s.purpose ?? ''} placeholder={(s.mood ?? []).join(', ')} onChange={(purpose) => setSection(i, { purpose })} />
                  </td>
                  <td>
                    <TextInput
                      size="sm"
                      value={(s.harmony ?? []).join(' ')}
                      placeholder="e.g. Em C G D or i VI III VII"
                      onChange={(v) => setSection(i, { harmony: v.split(/[\s,–-]+/).filter(Boolean) })}
                    />
                  </td>
                  <td className="nowrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="chevronDown"
                      title="Move down"
                      disabled={i === bp.structure.length - 1}
                      onClick={() => {
                        const arr = [...bp.structure];
                        [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
                        set({ structure: arr });
                      }}
                    />
                    <Button size="sm" variant="ghost" icon="copy" title="Duplicate" onClick={() => set({ structure: [...bp.structure.slice(0, i + 1), { ...s }, ...bp.structure.slice(i + 1)] })} />
                    <Button size="sm" variant="ghost" icon="trash" title="Remove" onClick={() => set({ structure: bp.structure.filter((_, j) => j !== i) })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="small muted" style={{ marginTop: 8 }}>
            <Icon name="info" size={12} /> Leave harmony empty to let the planner choose genre-appropriate progressions.
          </div>
        </div>
      </div>
    </div>
  );
}
