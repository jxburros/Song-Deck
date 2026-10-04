import { useMemo, useState } from 'react';
import {
  BUILTIN_GENRES,
  BUILTIN_INSTRUMENTS,
  romanToChord,
  type GenreProfile,
  type InstrumentProfile,
  type MasteringTarget,
  type ModeName,
  type SectionKind,
} from '@songdeck/core';
import {
  Badge,
  Button,
  CommitText,
  Field,
  Modal,
  Select,
  Slider,
  TextArea,
  TextInput,
  Toggle,
} from '../../ui/kit';
import { DRUM_STYLES, FUNCTIONS, MASTERING_TARGETS, MODES, SECTION_KINDS, TRACK_ROLES } from './constants';
import { ChipSet, OptNumber } from './ui';

/**
 * Custom genre profile editor (spec §14 "editable rule profiles", Phase 2 "custom genre profiles"):
 * tempo range, meters, modes, roman-numeral progressions, structure templates, instruments,
 * rhythm, dynamics, arrangement conventions and production keywords.
 */

const C_MAJOR = { tonic: 0, mode: 'major' as ModeName };

export function validRoman(r: string): boolean {
  return !!r.trim() && romanToChord(r.trim(), C_MAJOR) !== null;
}

function parseRomans(text: string): string[] {
  return text
    .split(/[\s,–—-]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "intro:4, verse:8:Loop A, chorus:8" ⇄ template sections. */
export function formatSections(sections: GenreProfile['structure']['templates'][number]['sections']): string {
  return sections.map((s) => `${s.kind}:${s.bars}${s.name ? `:${s.name}` : ''}`).join(', ');
}

export function parseSections(text: string): {
  sections: GenreProfile['structure']['templates'][number]['sections'];
  errors: string[];
} {
  const errors: string[] = [];
  const sections: GenreProfile['structure']['templates'][number]['sections'] = [];
  for (const part of text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [kindRaw, barsRaw, ...nameParts] = part.split(':').map((x) => x.trim());
    const kind = kindRaw?.toLowerCase() as SectionKind;
    const bars = Number(barsRaw);
    if (!SECTION_KINDS.includes(kind)) errors.push(`“${kindRaw}” is not a section kind`);
    else if (!Number.isInteger(bars) || bars < 1 || bars > 64) errors.push(`${kindRaw}: bars must be 1..64`);
    else
      sections.push({
        kind,
        bars,
        ...(nameParts.length && nameParts.join(':') ? { name: nameParts.join(':') } : {}),
      });
  }
  return { sections, errors };
}

/** Problems that make a profile unusable (empty = valid). */
export function genreProblems(g: GenreProfile, takenIds: Set<string>): string[] {
  const p: string[] = [];
  if (!g.name.trim()) p.push('Name is required');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(g.id)) p.push('Id must be lowercase letters, digits and dashes');
  if (takenIds.has(g.id)) p.push(`Id “${g.id}” is already used`);
  if (!(g.tempo.min > 0 && g.tempo.min <= g.tempo.typical && g.tempo.typical <= g.tempo.max))
    p.push('Tempo must satisfy min ≤ typical ≤ max');
  if (!g.meters.length) p.push('Add at least one meter');
  if (!g.modes.length) p.push('Add at least one mode');
  if (!g.harmony.progressions.length) p.push('Add at least one progression');
  for (const pr of g.harmony.progressions) {
    const bad = pr.roman.filter((r) => !validRoman(r));
    if (!pr.roman.length) p.push('A progression is empty');
    if (bad.length) p.push(`Unknown roman numerals: ${bad.join(' ')}`);
  }
  if (!g.structure.templates.length) p.push('Add at least one structure template');
  for (const t of g.structure.templates)
    if (!t.sections.length) p.push(`Template “${t.name}” has no sections`);
  if (!g.instruments.length) p.push('Add at least one instrument');
  return p;
}

/** Fill a partial / imported profile with sane defaults (based on the pop profile). */
export function normalizeGenre(raw: unknown): GenreProfile {
  if (!raw || typeof raw !== 'object') throw new Error('Not a genre profile (expected a JSON object)');
  const r = raw as Partial<GenreProfile>;
  const base = structuredClone(BUILTIN_GENRES.find((g) => g.id === 'pop') ?? BUILTIN_GENRES[0]);
  if (typeof r.name !== 'string' || !r.name.trim()) throw new Error('A genre profile needs a "name"');
  const id =
    typeof r.id === 'string' && r.id.trim()
      ? r.id
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
      : r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const arr = <T,>(v: unknown, fb: T[]): T[] => (Array.isArray(v) ? (v as T[]) : fb);
  return {
    ...base,
    ...r,
    id,
    name: r.name.trim(),
    builtIn: false,
    tempo: { ...base.tempo, ...(r.tempo ?? {}) },
    meters: arr(r.meters, base.meters),
    modes: arr(r.modes, base.modes),
    harmony: {
      ...base.harmony,
      ...(r.harmony ?? {}),
      progressions: arr(r.harmony?.progressions, base.harmony.progressions),
    },
    structure: { templates: arr(r.structure?.templates, base.structure.templates) },
    instruments: arr(r.instruments, base.instruments),
    rhythm: { ...base.rhythm, ...(r.rhythm ?? {}) },
    dynamics: {
      ...base.dynamics,
      ...(r.dynamics ?? {}),
      energyBySection: { ...base.dynamics.energyBySection, ...(r.dynamics?.energyBySection ?? {}) },
    },
    arrangement: {
      ...base.arrangement,
      ...(r.arrangement ?? {}),
      conventions: arr(r.arrangement?.conventions, base.arrangement.conventions),
    },
    production: {
      ...base.production,
      ...(r.production ?? {}),
      keywords: arr(r.production?.keywords, base.production.keywords),
    },
  };
}

const MODE_OPTIONS = MODES.map((m) => ({ value: m, label: m }));
const SECTION_OPTIONS = SECTION_KINDS.map((k) => ({ value: k, label: k }));

export function GenreEditor({
  genre,
  takenIds,
  customInstruments,
  onSave,
  onClose,
}: {
  genre: GenreProfile;
  takenIds: Set<string>;
  customInstruments: InstrumentProfile[];
  onSave: (g: GenreProfile) => void;
  onClose: () => void;
}) {
  const [g, setG] = useState<GenreProfile>(() => structuredClone(genre));
  const [templateErrors, setTemplateErrors] = useState<Record<number, string[]>>({});
  const problems = useMemo(() => genreProblems(g, takenIds), [g, takenIds]);
  const instruments = useMemo(() => [...BUILTIN_INSTRUMENTS, ...customInstruments], [customInstruments]);
  const set = (patch: Partial<GenreProfile>) => setG((x) => ({ ...x, ...patch }));
  const harmony = (patch: Partial<GenreProfile['harmony']>) => set({ harmony: { ...g.harmony, ...patch } });
  const rhythm = (patch: Partial<GenreProfile['rhythm']>) => set({ rhythm: { ...g.rhythm, ...patch } });
  const dynamics = (patch: Partial<GenreProfile['dynamics']>) =>
    set({ dynamics: { ...g.dynamics, ...patch } });
  const arrangement = (patch: Partial<GenreProfile['arrangement']>) =>
    set({ arrangement: { ...g.arrangement, ...patch } });
  const production = (patch: Partial<GenreProfile['production']>) =>
    set({ production: { ...g.production, ...patch } });

  return (
    <Modal
      title={`Genre profile — ${g.name || 'untitled'}`}
      icon="music"
      wide
      onClose={onClose}
      footer={
        <>
          {problems.length > 0 && (
            <span className="small st-provider-error grow">
              {problems[0]}
              {problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}
            </span>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={problems.length > 0}
            onClick={() =>
              onSave({
                ...g,
                builtIn: false,
                arrangement: {
                  ...g.arrangement,
                  conventions: g.arrangement.conventions.map((c) => c.trim()).filter(Boolean),
                },
              })
            }
          >
            Save profile
          </Button>
        </>
      }
    >
      <div className="col st-genre-editor" data-testid="genre-editor">
        <div className="grid-3">
          <Field label="Name">
            <TextInput value={g.name} onChange={(name) => set({ name })} aria-label="Genre name" />
          </Field>
          <Field label="Id" hint="Used in blends (“50% lofi 50% jazz”).">
            <TextInput
              mono
              value={g.id}
              onChange={(id) => set({ id: id.toLowerCase().replace(/[^a-z0-9-]+/g, '-') })}
              aria-label="Genre id"
            />
          </Field>
          <Field label="Tags" hint="Comma-separated.">
            <CommitText
              value={(g.tags ?? []).join(', ')}
              onCommit={(v) =>
                set({
                  tags: v
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
        </div>
        <Field label="Description">
          <TextArea value={g.description ?? ''} onChange={(description) => set({ description })} rows={2} />
        </Field>

        <h4>Tempo, meter & mode</h4>
        <div className="grid-4">
          <Field label="Min BPM">
            <OptNumber
              value={g.tempo.min}
              min={30}
              max={300}
              onChange={(v) => set({ tempo: { ...g.tempo, min: v ?? g.tempo.min } })}
              aria-label="Minimum tempo"
            />
          </Field>
          <Field label="Typical BPM">
            <OptNumber
              value={g.tempo.typical}
              min={30}
              max={300}
              onChange={(v) => set({ tempo: { ...g.tempo, typical: v ?? g.tempo.typical } })}
              aria-label="Typical tempo"
            />
          </Field>
          <Field label="Max BPM">
            <OptNumber
              value={g.tempo.max}
              min={30}
              max={300}
              onChange={(v) => set({ tempo: { ...g.tempo, max: v ?? g.tempo.max } })}
              aria-label="Maximum tempo"
            />
          </Field>
          <Field label="Harmonic rhythm" hint="Chords per bar.">
            <OptNumber
              value={g.harmony.harmonicRhythm}
              min={0.25}
              max={4}
              step={0.25}
              onChange={(v) => harmony({ harmonicRhythm: v ?? 1 })}
            />
          </Field>
        </div>
        <div className="st-two">
          <div className="col">
            <div className="row between">
              <span className="field-label">Meters (weighted)</span>
              <Button
                size="sm"
                icon="plus"
                onClick={() => set({ meters: [...g.meters, { numerator: 4, denominator: 4, weight: 1 }] })}
              >
                Meter
              </Button>
            </div>
            {g.meters.map((m, i) => (
              <div key={i} className="row">
                <OptNumber
                  size="sm"
                  value={m.numerator}
                  min={1}
                  max={15}
                  onChange={(v) =>
                    set({
                      meters: g.meters.map((x, j) => (j === i ? { ...x, numerator: Math.round(v ?? 4) } : x)),
                    })
                  }
                />
                <span>/</span>
                <Select
                  size="sm"
                  value={String(m.denominator)}
                  onChange={(v) =>
                    set({ meters: g.meters.map((x, j) => (j === i ? { ...x, denominator: Number(v) } : x)) })
                  }
                  options={['2', '4', '8', '16']}
                />
                <span className="small dim">weight</span>
                <OptNumber
                  size="sm"
                  value={m.weight}
                  min={0}
                  step={0.1}
                  onChange={(v) =>
                    set({ meters: g.meters.map((x, j) => (j === i ? { ...x, weight: v ?? 1 } : x)) })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  onClick={() => set({ meters: g.meters.filter((_, j) => j !== i) })}
                  aria-label="Remove meter"
                />
              </div>
            ))}
          </div>
          <div className="col">
            <div className="row between">
              <span className="field-label">Modes (weighted)</span>
              <Button
                size="sm"
                icon="plus"
                onClick={() => set({ modes: [...g.modes, { mode: 'minor', weight: 1 }] })}
              >
                Mode
              </Button>
            </div>
            {g.modes.map((m, i) => (
              <div key={i} className="row">
                <Select
                  size="sm"
                  value={m.mode}
                  onChange={(mode) => set({ modes: g.modes.map((x, j) => (j === i ? { ...x, mode } : x)) })}
                  options={MODE_OPTIONS}
                />
                <span className="small dim">weight</span>
                <OptNumber
                  size="sm"
                  value={m.weight}
                  min={0}
                  step={0.05}
                  onChange={(v) =>
                    set({ modes: g.modes.map((x, j) => (j === i ? { ...x, weight: v ?? 1 } : x)) })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  onClick={() => set({ modes: g.modes.filter((_, j) => j !== i) })}
                  aria-label="Remove mode"
                />
              </div>
            ))}
          </div>
        </div>

        <h4>Harmony — progressions as roman numerals</h4>
        {g.harmony.progressions.map((pr, i) => {
          const bad = pr.roman.filter((r) => !validRoman(r));
          return (
            <div key={i} className="st-prog">
              <div className="row">
                <CommitText
                  mono
                  value={pr.roman.join(' ')}
                  onCommit={(v) =>
                    harmony({
                      progressions: g.harmony.progressions.map((x, j) =>
                        j === i ? { ...x, roman: parseRomans(v) } : x,
                      ),
                    })
                  }
                  placeholder="i VI III VII"
                  aria-label="Progression"
                />
                <span className="small dim">weight</span>
                <OptNumber
                  size="sm"
                  value={pr.weight}
                  min={0}
                  step={0.5}
                  onChange={(v) =>
                    harmony({
                      progressions: g.harmony.progressions.map((x, j) =>
                        j === i ? { ...x, weight: v ?? 1 } : x,
                      ),
                    })
                  }
                  style={{ width: 70 }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  onClick={() => harmony({ progressions: g.harmony.progressions.filter((_, j) => j !== i) })}
                  aria-label="Remove progression"
                />
              </div>
              <div className="row wrap" style={{ gap: 4 }}>
                {pr.roman.map((r, k) => (
                  <Badge key={k} tone={validRoman(r) ? 'ai' : 'danger'}>
                    {r}
                  </Badge>
                ))}
                {bad.length > 0 && (
                  <span className="small st-provider-error">not a roman numeral: {bad.join(' ')}</span>
                )}
                <span className="grow" />
                <details>
                  <summary className="small dim">
                    Only in sections {pr.sectionKinds?.length ? `(${pr.sectionKinds.join(', ')})` : '(any)'}
                  </summary>
                  <ChipSet
                    label="Section kinds"
                    options={SECTION_OPTIONS}
                    value={pr.sectionKinds ?? []}
                    onChange={(kinds) =>
                      harmony({
                        progressions: g.harmony.progressions.map((x, j) =>
                          j === i ? { ...x, sectionKinds: kinds.length ? kinds : undefined } : x,
                        ),
                      })
                    }
                  />
                </details>
              </div>
            </div>
          );
        })}
        <div className="row">
          <Button
            size="sm"
            icon="plus"
            onClick={() =>
              harmony({
                progressions: [...g.harmony.progressions, { roman: ['I', 'V', 'vi', 'IV'], weight: 1 }],
              })
            }
          >
            Progression
          </Button>
          <span className="small dim">e.g. ii7 V7 Imaj7 · i bVI bIII bVII · V/V V I</span>
        </div>
        <div className="grid-3">
          <Slider
            label="Borrowed chords"
            value={g.harmony.borrowedChordRate}
            onChange={(borrowedChordRate) => harmony({ borrowedChordRate })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <Slider
            label="Extensions (7ths, 9ths)"
            value={g.harmony.extensionRate}
            onChange={(extensionRate) => harmony({ extensionRate })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <Toggle
            on={!!g.harmony.powerChords}
            onChange={(powerChords) => harmony({ powerChords })}
            label="Power chords for guitars"
          />
        </div>

        <h4>Structure templates</h4>
        {g.structure.templates.map((t, i) => (
          <div key={i} className="st-template">
            <div className="row">
              <TextInput
                size="sm"
                value={t.name}
                onChange={(name) =>
                  set({
                    structure: {
                      templates: g.structure.templates.map((x, j) => (j === i ? { ...x, name } : x)),
                    },
                  })
                }
                style={{ width: 180 }}
                aria-label="Template name"
              />
              <span className="small dim">weight</span>
              <OptNumber
                size="sm"
                value={t.weight}
                min={0}
                step={0.5}
                onChange={(v) =>
                  set({
                    structure: {
                      templates: g.structure.templates.map((x, j) =>
                        j === i ? { ...x, weight: v ?? 1 } : x,
                      ),
                    },
                  })
                }
                style={{ width: 70 }}
              />
              <span className="small dim grow">{t.sections.reduce((n, s) => n + s.bars, 0)} bars</span>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                onClick={() =>
                  set({ structure: { templates: g.structure.templates.filter((_, j) => j !== i) } })
                }
                aria-label="Remove template"
              />
            </div>
            <CommitText
              mono
              value={formatSections(t.sections)}
              onCommit={(v) => {
                const { sections, errors } = parseSections(v);
                setTemplateErrors((e) => ({ ...e, [i]: errors }));
                if (sections.length)
                  set({
                    structure: {
                      templates: g.structure.templates.map((x, j) => (j === i ? { ...x, sections } : x)),
                    },
                  });
              }}
              aria-label="Template sections"
            />
            {templateErrors[i]?.length ? (
              <div className="small st-provider-error">{templateErrors[i].join('; ')}</div>
            ) : null}
          </div>
        ))}
        <div className="row">
          <Button
            size="sm"
            icon="plus"
            onClick={() =>
              set({
                structure: {
                  templates: [
                    ...g.structure.templates,
                    {
                      name: 'New form',
                      weight: 1,
                      sections: [
                        { kind: 'intro', bars: 4 },
                        { kind: 'verse', bars: 8 },
                        { kind: 'chorus', bars: 8 },
                        { kind: 'outro', bars: 4 },
                      ],
                    },
                  ],
                },
              })
            }
          >
            Template
          </Button>
          <span className="small dim">
            Format: kind:bars[:name], comma-separated — kinds: {SECTION_KINDS.join(', ')}
          </span>
        </div>

        <h4>Instruments</h4>
        {g.instruments.map((ins, i) => (
          <div key={i} className="row">
            <Select
              size="sm"
              value={ins.instrumentId}
              onChange={(instrumentId) =>
                set({ instruments: g.instruments.map((x, j) => (j === i ? { ...x, instrumentId } : x)) })
              }
              options={instruments.map((x) => ({ value: x.id, label: x.name }))}
              aria-label="Instrument"
            />
            <Select
              size="sm"
              value={ins.role}
              onChange={(role) =>
                set({ instruments: g.instruments.map((x, j) => (j === i ? { ...x, role } : x)) })
              }
              options={TRACK_ROLES}
              aria-label="Role"
            />
            <Select
              size="sm"
              value={ins.function ?? ''}
              onChange={(fn) =>
                set({
                  instruments: g.instruments.map((x, j) =>
                    j === i ? { ...x, function: (fn || undefined) as typeof x.function } : x,
                  ),
                })
              }
              options={[
                { value: '', label: '(default function)' },
                ...FUNCTIONS.map((f) => ({ value: f, label: f })),
              ]}
              aria-label="Function"
            />
            <span className="small dim">weight</span>
            <OptNumber
              size="sm"
              value={ins.weight}
              min={0}
              step={0.1}
              onChange={(v) =>
                set({ instruments: g.instruments.map((x, j) => (j === i ? { ...x, weight: v ?? 1 } : x)) })
              }
              style={{ width: 70 }}
            />
            <Toggle
              on={!!ins.essential}
              onChange={(essential) =>
                set({ instruments: g.instruments.map((x, j) => (j === i ? { ...x, essential } : x)) })
              }
              label="essential"
            />
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              onClick={() => set({ instruments: g.instruments.filter((_, j) => j !== i) })}
              aria-label="Remove instrument"
            />
          </div>
        ))}
        <Button
          size="sm"
          icon="plus"
          onClick={() =>
            set({
              instruments: [
                ...g.instruments,
                { instrumentId: instruments[0]?.id ?? 'piano', role: 'keys', weight: 1 },
              ],
            })
          }
        >
          Instrument
        </Button>

        <h4>Rhythm</h4>
        <div className="grid-3">
          <Field label="Drum style">
            <Select
              value={g.rhythm.drumStyle}
              onChange={(drumStyle) => rhythm({ drumStyle })}
              options={DRUM_STYLES}
              aria-label="Drum style"
            />
          </Field>
          <Field label="Subdivision">
            <Select
              value={String(g.rhythm.subdivision)}
              onChange={(v) => rhythm({ subdivision: Number(v) as 8 | 12 | 16 })}
              options={[
                { value: '8', label: '8ths' },
                { value: '12', label: 'triplet 8ths' },
                { value: '16', label: '16ths' },
              ]}
            />
          </Field>
          <Slider
            label="Half-time chance"
            value={g.rhythm.halfTimeChance ?? 0}
            onChange={(halfTimeChance) => rhythm({ halfTimeChance })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <Slider
            label="Swing"
            value={g.rhythm.swing}
            onChange={(swing) => rhythm({ swing })}
            format={(v) => (v < 0.02 ? 'straight' : `${Math.round(v * 100)}%`)}
            left="straight"
            right="triplet"
            accent
          />
          <Slider
            label="Syncopation"
            value={g.rhythm.syncopation}
            onChange={(syncopation) => rhythm({ syncopation })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </div>

        <h4>Dynamics</h4>
        <Slider
          label="Dynamic range"
          value={g.dynamics.dynamicRange}
          onChange={(dynamicRange) => dynamics({ dynamicRange })}
          format={(v) => `${Math.round(v * 100)}%`}
          left="flat"
          right="wide"
        />
        <div className="st-energy-grid">
          {SECTION_KINDS.filter((k) => k !== 'custom').map((k) => (
            <label key={k} className="field">
              <span className="field-label">{k}</span>
              <OptNumber
                size="sm"
                value={g.dynamics.energyBySection[k]}
                min={0}
                max={100}
                placeholder="—"
                onChange={(v) => dynamics({ energyBySection: { ...g.dynamics.energyBySection, [k]: v } })}
              />
            </label>
          ))}
        </div>

        <h4>Arrangement</h4>
        <div className="grid-2">
          <Slider
            label="Density at low energy"
            value={g.arrangement.densityAtLowEnergy}
            onChange={(densityAtLowEnergy) => arrangement({ densityAtLowEnergy })}
            format={(v) => `${Math.round(v * 100)}% of tracks`}
          />
          <Slider
            label="Density at high energy"
            value={g.arrangement.densityAtHighEnergy}
            onChange={(densityAtHighEnergy) => arrangement({ densityAtHighEnergy })}
            format={(v) => `${Math.round(v * 100)}% of tracks`}
          />
        </div>
        <Field label="Conventions" hint="One per line.">
          <TextArea
            value={g.arrangement.conventions.join('\n')}
            onChange={(v) => arrangement({ conventions: v.split('\n') })}
            rows={3}
          />
        </Field>

        <h4>Production</h4>
        <Field label="Description">
          <TextArea
            value={g.production.description}
            onChange={(description) => production({ description })}
            rows={2}
          />
        </Field>
        <div className="grid-3">
          <Field label="Production keywords" hint="Comma-separated; sent to audio-generation providers.">
            <CommitText
              value={g.production.keywords.join(', ')}
              onCommit={(v) =>
                production({
                  keywords: v
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                })
              }
              aria-label="Production keywords"
            />
          </Field>
          <Slider
            label="Reverb"
            value={g.production.reverb}
            onChange={(reverb) => production({ reverb })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <Field label="Mastering target">
            <Select
              value={g.production.masteringTarget ?? ''}
              onChange={(v) =>
                production({ masteringTarget: (v || undefined) as MasteringTarget | undefined })
              }
              options={[
                { value: '', label: '(default)' },
                ...MASTERING_TARGETS.map((m) => ({ value: m, label: m })),
              ]}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
