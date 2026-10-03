import { useMemo, useState } from 'react';
import {
  BUILTIN_GENRES,
  BUILTIN_INSTRUMENTS,
  FLAT_NAMES,
  chordsInRange,
  keyName,
  randomSeed,
  sectionLayout,
  type AssetRequest,
  type Complexity,
  type InstrumentProfile,
  type ModeName,
  type MusicalFunction,
  type Song,
  type TrackRole,
} from '@songdeck/core';
import { useCustomGenres, useCustomInstruments } from '../../hooks';
import { Button, Field, NumberInput, Select, TextInput } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { FUNCTIONS, MODES, TRACK_ROLES } from '../compose/BlueprintEditor';

const MOOD_SUGGESTIONS = [
  'melancholy',
  'uplifting',
  'dark',
  'aggressive',
  'dreamy',
  'tense',
  'calm',
  'triumphant',
  'playful',
  'nostalgic',
  'driving',
  'cathartic',
];

/** Chord symbols of a project section, consecutive duplicates collapsed. */
export function sectionChords(song: Song, sectionId: string): string[] {
  const span = sectionLayout(song).find((s) => s.section.id === sectionId);
  if (!span) return [];
  const out: string[] = [];
  for (const c of chordsInRange(song, span.startTick, span.endTick))
    if (out[out.length - 1] !== c.symbol) out.push(c.symbol);
  return out;
}

export function parseProgression(text: string): string[] | undefined {
  const parts = text
    .split(/[\s,|–—-]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

export function AssetRequestForm({
  request,
  onChange,
  seed,
  onSeed,
  song,
}: {
  request: AssetRequest;
  onChange: (r: AssetRequest) => void;
  seed: number;
  onSeed: (s: number) => void;
  /** Open project (enables "use project chords / key / tempo"). */
  song: Song | null;
}) {
  const customInstruments = useCustomInstruments();
  const customGenres = useCustomGenres();
  const instruments: InstrumentProfile[] = useMemo(
    () => [...BUILTIN_INSTRUMENTS, ...customInstruments],
    [customInstruments],
  );
  const genres = useMemo(() => [...BUILTIN_GENRES, ...customGenres], [customGenres]);
  const [moodDraft, setMoodDraft] = useState('');
  const [progText, setProgText] = useState<string | null>(null);
  const r = request;
  const set = (patch: Partial<AssetRequest>) => onChange({ ...r, ...patch });
  const sections = useMemo(
    () => (song ? sectionLayout(song).filter((s) => sectionChords(song, s.section.id).length > 0) : []),
    [song],
  );
  const progressionText = progText ?? (r.progression ?? []).join(' ');

  const pickInstrument = (id: string) => {
    const inst = instruments.find((i) => i.id === id);
    set({
      instrumentId: id,
      role: inst?.defaultRole ?? r.role,
      function: inst?.defaultFunction ?? r.function,
    });
  };

  const matchProject = () => {
    if (!song) return;
    set({
      key: song.keyMap[0]?.key ?? r.key,
      tempo: Math.round(song.tempoMap[0]?.bpm ?? r.tempo),
      meter: { numerator: song.meterMap[0]?.numerator ?? 4, denominator: song.meterMap[0]?.denominator ?? 4 },
    });
  };

  const applySection = (sectionId: string) => {
    if (!song || !sectionId) return;
    const span = sectionLayout(song).find((s) => s.section.id === sectionId);
    const chords = sectionChords(song, sectionId);
    setProgText(null);
    set({
      progression: chords,
      bars: span ? span.endBar - span.startBar : r.bars,
      key: song.keyMap.filter((k) => k.bar <= (span?.startBar ?? 0)).slice(-1)[0]?.key ?? r.key,
      tempo: Math.round(song.tempoMap[0]?.bpm ?? r.tempo),
      meter: { numerator: song.meterMap[0]?.numerator ?? 4, denominator: song.meterMap[0]?.denominator ?? 4 },
    });
  };

  return (
    <div className="col" style={{ gap: 12 }} data-testid="asset-request-form">
      <div className="grid-4">
        <Field label="Instrument">
          <Select
            value={r.instrumentId}
            onChange={pickInstrument}
            options={
              instruments.some((i) => i.id === r.instrumentId)
                ? instruments.map((i) => ({ value: i.id, label: i.name }))
                : [
                    { value: r.instrumentId, label: r.instrumentId },
                    ...instruments.map((i) => ({ value: i.id, label: i.name })),
                  ]
            }
            aria-label="Instrument"
          />
        </Field>
        <Field label="Role (generator)">
          <Select
            value={r.role}
            onChange={(role) => set({ role: role as TrackRole })}
            options={TRACK_ROLES}
            aria-label="Role"
          />
        </Field>
        <Field label="Musical function">
          <Select
            value={r.function ?? ''}
            onChange={(f) => set({ function: (f || undefined) as MusicalFunction | undefined })}
            options={[{ value: '', label: 'Auto' }, ...FUNCTIONS.map((f) => ({ value: f, label: f }))]}
            aria-label="Musical function"
          />
        </Field>
        <Field label="Complexity">
          <Select
            value={r.complexity ?? ''}
            onChange={(c) => set({ complexity: (c || undefined) as Complexity | undefined })}
            options={[
              { value: '', label: 'Auto' },
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ]}
            aria-label="Complexity"
          />
        </Field>
      </div>
      <div className="grid-4">
        <Field label="Bars">
          <NumberInput
            value={r.bars}
            min={1}
            max={64}
            onChange={(bars) => set({ bars: Math.round(bars) })}
            aria-label="Bars"
          />
        </Field>
        <Field label="Key">
          <div className="row">
            <Select
              value={String(r.key.tonic)}
              onChange={(t) => set({ key: { ...r.key, tonic: parseInt(t, 10) } })}
              options={FLAT_NAMES.map((n, i) => ({ value: String(i), label: n }))}
              aria-label="Key tonic"
            />
            <Select
              value={r.key.mode}
              onChange={(mode) => set({ key: { ...r.key, mode: mode as ModeName } })}
              options={MODES}
              aria-label="Key mode"
            />
          </div>
        </Field>
        <Field label="Tempo (BPM)">
          <NumberInput
            value={r.tempo}
            min={30}
            max={300}
            onChange={(tempo) => set({ tempo: Math.round(tempo) })}
            aria-label="Tempo"
          />
        </Field>
        <Field label="Meter">
          <div className="row">
            <NumberInput
              value={r.meter.numerator}
              min={1}
              max={15}
              onChange={(n) => set({ meter: { ...r.meter, numerator: Math.round(n) } })}
              aria-label="Meter numerator"
            />
            <span>/</span>
            <Select
              value={String(r.meter.denominator)}
              onChange={(d) => set({ meter: { ...r.meter, denominator: parseInt(d, 10) } })}
              options={['2', '4', '8']}
              aria-label="Meter denominator"
            />
          </div>
        </Field>
      </div>

      <Field label="Moods">
        <div className="row wrap">
          <div className="chip-list">
            {r.moods.map((m) => (
              <button
                key={m}
                className="chip on"
                onClick={() => set({ moods: r.moods.filter((x) => x !== m) })}
                title="Remove mood"
              >
                {m} <Icon name="close" size={11} />
              </button>
            ))}
            {MOOD_SUGGESTIONS.filter((m) => !r.moods.includes(m))
              .slice(0, 8)
              .map((m) => (
                <button key={m} className="chip" onClick={() => set({ moods: [...r.moods, m] })}>
                  + {m}
                </button>
              ))}
          </div>
          <TextInput
            size="sm"
            value={moodDraft}
            onChange={setMoodDraft}
            placeholder="Add mood…"
            style={{ width: 140 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && moodDraft.trim()) {
                set({ moods: [...new Set([...r.moods, moodDraft.trim().toLowerCase()])] });
                setMoodDraft('');
              }
            }}
            aria-label="Add mood"
          />
        </div>
      </Field>

      <Field label="Genres" hint="Style profiles that shape rhythm, harmony and articulation.">
        <div className="chip-list" style={{ maxHeight: 64, overflow: 'auto' }}>
          {genres.map((g) => {
            const on = r.genreIds.includes(g.id);
            return (
              <button
                key={g.id}
                className={`chip ${on ? 'on' : ''}`}
                onClick={() =>
                  set({ genreIds: on ? r.genreIds.filter((x) => x !== g.id) : [...r.genreIds, g.id] })
                }
              >
                {g.name}
              </button>
            );
          })}
        </div>
      </Field>

      <div className="grid-2">
        <Field
          label="Chord progression"
          hint="Chord symbols (Dm Bb F C) or roman numerals (i VI III VII); empty = the generator picks one."
        >
          <div className="row">
            <TextInput
              value={progressionText}
              onChange={(v) => setProgText(v)}
              onBlur={() => {
                if (progText !== null) set({ progression: parseProgression(progText) });
                setProgText(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              placeholder="e.g. Dm Bb F C"
              mono
              aria-label="Chord progression"
            />
            {r.progression?.length ? (
              <Button
                size="sm"
                variant="ghost"
                icon="close"
                title="Clear progression"
                onClick={() => set({ progression: undefined })}
              />
            ) : null}
          </div>
        </Field>
        {song ? (
          <Field
            label="From the open project"
            hint={`Project: ${keyName(song.keyMap[0]?.key ?? r.key)} · ${Math.round(song.tempoMap[0]?.bpm ?? 120)} BPM`}
          >
            <div className="row">
              <Select
                value=""
                onChange={applySection}
                options={[
                  {
                    value: '',
                    label: sections.length ? 'Use project chords from section…' : 'No chords in project',
                  },
                  ...sections.map((s) => ({
                    value: s.section.id,
                    label: `${s.section.name} · bars ${s.startBar + 1}–${s.endBar}`,
                  })),
                ]}
                disabled={!sections.length}
                aria-label="Use project chords from section"
              />
              <Button size="sm" onClick={matchProject} title="Copy key, tempo and meter from the project">
                Match key & tempo
              </Button>
            </div>
          </Field>
        ) : (
          <div />
        )}
      </div>

      <div className="grid-4">
        <Field label="Alternatives">
          <NumberInput
            value={r.count}
            min={1}
            max={8}
            onChange={(count) => set({ count: Math.round(count) })}
            aria-label="Alternatives"
          />
        </Field>
        <Field label="Seed" hint="Alternative n uses seed + n − 1.">
          <div className="row">
            <NumberInput
              value={seed}
              min={0}
              max={99999999}
              onChange={(v) => onSeed(Math.round(v))}
              aria-label="Seed"
            />
            <Button icon="dice" title="New seed" onClick={() => onSeed(randomSeed())} />
          </div>
        </Field>
      </div>
    </div>
  );
}
