import { useMemo, useState, type ReactNode } from 'react';
import {
  BUILTIN_GENRES,
  BUILTIN_INSTRUMENTS,
  FLAT_NAMES,
  blueprintFromChoices,
  builderGenre,
  defaultMacros,
  genreExpectsVocal,
  getGenre,
  getTag,
  structureTemplateNames,
  suggestInstruments,
  tempoForFeel,
  type Blueprint,
  type BuilderInstrument,
  type GenreProfile,
  type InstrumentProfile,
  type MacroSettings,
  type MusicalFunction,
  type SectionKind,
  type TagKind,
  type TrackRole,
  type VocalMode,
} from '@songdeck/core';
import { Button, Field, NumberInput, Select, Slider, Tabs, TextInput } from '../../ui/kit';
import { FUNCTIONS, MACRO_INFO, MODES, TRACK_ROLES } from './BlueprintEditor';
import { ChipPicker, genreItems, instrumentItems, tagItems, tagKindLabel } from './ChipPicker';
import { STARTERS, choicesForStart, draftLyrics, useComposeSession, type ComposeDraft, type Starter } from './session';
import { useComposeInputs } from './inputs';

/**
 * Start a song, step 2: every composer setting on one page, in numbered sections — starting
 * points, genre blend, moods, tags, instruments, song settings, feel and advanced options — with a
 * live summary of the song so far. Works fully offline; with a language model attached, the prompt
 * from step 1 adds plain language on top (these choices stay hard constraints).
 */

const MOOD_TARGETS: { value: '' | SectionKind; label: string }[] = [
  { value: '', label: 'Whole song' },
  { value: 'intro', label: 'Intro' },
  { value: 'verse', label: 'Verses' },
  { value: 'pre-chorus', label: 'Pre-chorus' },
  { value: 'chorus', label: 'Choruses' },
  { value: 'bridge', label: 'Bridge' },
  { value: 'drop', label: 'Drop' },
  { value: 'outro', label: 'Outro' },
];

const METERS = ['4/4', '3/4', '6/8', '2/4', '12/8', '5/4', '7/8'];
const VOICES = ['soprano', 'mezzo', 'alto', 'tenor', 'baritone', 'bass'] as const;
const VOCAL_MODES: { value: VocalMode; label: string }[] = [
  { value: 'melody-only', label: 'Vocal melody only' },
  { value: 'ai-singer', label: 'AI singer' },
  { value: 'placeholder', label: 'Placeholder vocal' },
];
const TAG_KINDS: TagKind[] = ['style', 'era', 'production', 'vocal', 'region', 'rhythm'];

export const SHAPE_SECTIONS = [
  { id: 'shape-start', n: '01', label: 'Starting point' },
  { id: 'shape-genres', n: '02', label: 'Genre blend' },
  { id: 'shape-moods', n: '03', label: 'Moods' },
  { id: 'shape-tags', n: '04', label: 'Style and production' },
  { id: 'shape-instruments', n: '05', label: 'Instruments' },
  { id: 'shape-settings', n: '06', label: 'Song settings' },
  { id: 'shape-feel', n: '07', label: 'Feel' },
  { id: 'shape-advanced', n: '08', label: 'Advanced' },
] as const;

export function formatDuration(bp: Blueprint): string {
  const bars = bp.structure.reduce((n, s) => n + s.bars, 0);
  const sec = (bars * bp.meter.numerator * (4 / bp.meter.denominator) * 60) / bp.tempo;
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
}

/** Apply a starting point, keeping only catalog entries that exist (genres, tags and moods vary by catalog). */
export function applyStarter(s: Starter, custom: GenreProfile[]): Partial<ComposeDraft> {
  const d = s.draft;
  return {
    ...d,
    genres: (d.genres ?? []).filter((g) => getGenre(g.genreId, custom)),
    tags: (d.tags ?? []).map((t) => getTag(t)?.id).filter((t): t is string => !!t),
    moods: (d.moods ?? []).flatMap((m) => {
      const t = getTag(m.tagId);
      return t ? [{ ...m, tagId: t.id }] : [];
    }),
  };
}

function SectionHead({ index, title, note }: { index: number; title: string; note?: ReactNode }) {
  const s = SHAPE_SECTIONS[index];
  return (
    <div className="rule-title">
      <span className="index">{s.n}</span>
      <h2 id={`${s.id}-h`}>{title}</h2>
      <span className="line" />
      {note && <span className="note">{note}</span>}
    </div>
  );
}

function InstrumentRow({
  entry,
  inst,
  onChange,
  onRemove,
}: {
  entry: BuilderInstrument;
  inst: InstrumentProfile | undefined;
  onChange: (patch: Partial<BuilderInstrument>) => void;
  onRemove: () => void;
}) {
  const name = inst?.name ?? entry.instrumentId;
  return (
    <div className="cb-inst-row" data-testid="builder-instrument" data-instrument={entry.instrumentId}>
      <div className="cb-inst-name">
        <span className="cb-inst-swatch" aria-hidden="true" />
        <strong className="ellipsis">{name}</strong>
      </div>
      <div className="cb-stepper" role="group" aria-label={`${name} count`}>
        <Button
          size="sm"
          icon="minus"
          aria-label={`Fewer ${name}`}
          disabled={entry.count <= 1}
          onClick={() => onChange({ count: Math.max(1, entry.count - 1) })}
        />
        <span className="mono" aria-live="polite" data-testid="instrument-count">
          × {entry.count}
        </span>
        <Button
          size="sm"
          icon="plus"
          aria-label={`More ${name}`}
          disabled={entry.count >= 8}
          onClick={() => onChange({ count: Math.min(8, entry.count + 1) })}
        />
      </div>
      <Select
        aria-label={`${name} role`}
        value={entry.role ?? ''}
        onChange={(v) => onChange({ role: (v || undefined) as TrackRole | undefined })}
        options={[
          { value: '', label: `Role: auto${inst ? ` (${inst.defaultRole})` : ''}` },
          ...TRACK_ROLES.map((r) => ({ value: r, label: r })),
        ]}
      />
      <Select
        aria-label={`${name} function`}
        value={entry.function ?? ''}
        onChange={(v) => onChange({ function: (v || undefined) as MusicalFunction | undefined })}
        options={[
          { value: '', label: `Plays: auto${inst ? ` (${inst.defaultFunction})` : ''}` },
          ...FUNCTIONS.map((f) => ({ value: f, label: f })),
        ]}
      />
      <Button
        variant="ghost"
        icon="close"
        aria-label={`Remove ${name}`}
        title={`Remove ${name}`}
        onClick={onRemove}
      />
    </div>
  );
}

/** The live blueprint preview the Shape page summarises (shared with the summary rail). */
export function useShapePreview(customGenres: GenreProfile[], customInstruments: InstrumentProfile[]) {
  const session = useComposeSession();
  const inputs = useComposeInputs((s) => s.inputs);
  const choices = useMemo(
    () => choicesForStart(session.draft, session.lyricsMode, inputs.find((i) => i.item.song)?.item.song),
    [session.draft, session.lyricsMode, inputs],
  );
  const genre = useMemo(() => builderGenre(choices, customGenres), [choices, customGenres]);
  const preview = useMemo(() => {
    try {
      return blueprintFromChoices(choices, { seed: session.seed, customGenres, customInstruments });
    } catch {
      return null;
    }
  }, [choices, session.seed, customGenres, customInstruments]);
  return { choices, genre, preview };
}

export function ShapeSections({
  customGenres,
  customInstruments,
  advanced,
}: {
  customGenres: GenreProfile[];
  customInstruments: InstrumentProfile[];
  /** Destination, planner, audio model and review controls (owned by ComposeMode). */
  advanced: ReactNode;
}) {
  const session = useComposeSession();
  const { draft, patch } = session;
  const [tagKind, setTagKind] = useState<TagKind>('style');
  const allInstruments = useMemo(
    () => [
      ...customInstruments,
      ...BUILTIN_INSTRUMENTS.filter((b) => !customInstruments.some((c) => c.id === b.id)),
    ],
    [customInstruments],
  );
  const instOf = (id: string) => allInstruments.find((i) => i.id === id);
  const lyrics = useMemo(() => (session.lyricsOn ? draftLyrics(draft) : undefined), [draft, session.lyricsOn]);
  const { genre, preview } = useShapePreview(customGenres, customInstruments);

  const genrePick = useMemo(() => genreItems(BUILTIN_GENRES, customGenres), [customGenres]);
  const instPick = useMemo(
    () => instrumentItems(BUILTIN_INSTRUMENTS, customInstruments),
    [customInstruments],
  );
  const moodPick = useMemo(() => tagItems(['mood']), []);
  const tagPick = useMemo(() => tagItems([tagKind], customGenres), [tagKind, customGenres]);
  const suggestion = useMemo(
    () => (draft.instruments.length ? [] : suggestInstruments(genre)),
    [draft.instruments.length, genre],
  );
  const templates = useMemo(() => structureTemplateNames(genre), [genre]);

  const setInstrument = (i: number, p: Partial<BuilderInstrument>) =>
    patch({ instruments: draft.instruments.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const toggleInstrument = (id: string) => {
    const at = draft.instruments.findIndex((x) => x.instrumentId === id);
    patch({
      instruments:
        at >= 0
          ? draft.instruments.filter((_, j) => j !== at)
          : [...draft.instruments, { instrumentId: id, count: 1 }],
    });
  };
  const toggleGenre = (id: string) => {
    const on = draft.genres.some((g) => g.genreId === id);
    patch({
      genres: on
        ? draft.genres.filter((g) => g.genreId !== id)
        : [...draft.genres, { genreId: id, weight: draft.genres.length ? 0.5 : 1 }],
    });
  };
  const genreTotal = draft.genres.reduce((t, g) => t + g.weight, 0) || 1;
  const toggleMood = (id: string) => {
    const on = draft.moods.some((m) => m.tagId === id);
    patch({ moods: on ? draft.moods.filter((m) => m.tagId !== id) : [...draft.moods, { tagId: id }] });
  };
  const toggleTag = (id: string) =>
    patch({ tags: draft.tags.includes(id) ? draft.tags.filter((t) => t !== id) : [...draft.tags, id] });
  const vocalTracks =
    preview?.instrumentation.filter((t) => t.role === 'vocal' && t.instrumentId === 'lead-vocal').length ?? 0;
  const autoVocal = lyrics || genreExpectsVocal(genre) ? 'lead vocal' : 'instrumental';
  const tempoHint = (f: 'slow' | 'mid' | 'fast') => `≈${tempoForFeel(f, genre)} BPM`;
  const macroBase: MacroSettings = { ...defaultMacros(), ...(preview?.macros ?? {}) };
  const tagCounts = TAG_KINDS.map((k) => ({
    k,
    n: draft.tags.filter((id) => getTag(id)?.kind === k).length,
  }));

  return (
    <div className="shape col" style={{ gap: 30 }}>
      <section id="shape-start" aria-labelledby="shape-start-h" className="col" style={{ gap: 12 }}>
        <SectionHead index={0} title="Starting point" note="Fills in everything below. Change any of it after." />
        <div className="row wrap cb-starters">
          {STARTERS.map((s) => (
            <Button key={s.id} onClick={() => patch({ ...applyStarter(s, customGenres) })}>
              {s.label}
            </Button>
          ))}
          {(draft.instruments.length > 0 ||
            draft.genres.length > 0 ||
            draft.moods.length > 0 ||
            draft.tags.length > 0) && (
            <Button
              variant="ghost"
              icon="close"
              onClick={() => patch({ instruments: [], genres: [], moods: [], tags: [], macros: {} })}
            >
              Clear all
            </Button>
          )}
        </div>
      </section>

      <section id="shape-genres" aria-labelledby="shape-genres-h" className="col" style={{ gap: 12 }}>
        <SectionHead index={1} title="Genre blend" note="One genre, or blend several" />
        <div className="panel" data-testid="builder-genres">
          <div className="panel-body col" style={{ gap: 14 }}>
            {draft.genres.length > 0 && (
              <div className="col" style={{ gap: 4 }}>
                {draft.genres.map((g, i) => {
                  const p = getGenre(g.genreId, customGenres);
                  const name = p?.name ?? g.genreId;
                  return (
                    <div key={g.genreId} className="cb-genre-row" data-testid="builder-genre">
                      <strong className="cb-genre-name ellipsis">{name}</strong>
                      <div className="grow">
                        <Slider
                          value={g.weight}
                          min={0.05}
                          max={1}
                          step={0.05}
                          ariaLabel={`${name} influence`}
                          onChange={(weight) =>
                            patch({ genres: draft.genres.map((x, j) => (j === i ? { ...x, weight } : x)) })
                          }
                          accent
                        />
                      </div>
                      <span className="mono small cb-pct">{Math.round((g.weight / genreTotal) * 100)}%</span>
                      <Button
                        variant="ghost"
                        icon="close"
                        aria-label={`Remove ${name}`}
                        onClick={() => patch({ genres: draft.genres.filter((_, j) => j !== i) })}
                      />
                    </div>
                  );
                })}
                <div className="cb-blend-bar" aria-hidden="true">
                  {draft.genres.map((g, i) => (
                    <span key={g.genreId} style={{ flexGrow: g.weight }} className={`shade-${i % 4}`} />
                  ))}
                </div>
              </div>
            )}
            <ChipPicker
              items={genrePick}
              selected={draft.genres.map((g) => g.genreId)}
              onToggle={toggleGenre}
              label="Search genres"
              placeholder="Search genres"
              perGroup={8}
            />
          </div>
        </div>
      </section>

      <section id="shape-moods" aria-labelledby="shape-moods-h" className="col" style={{ gap: 12 }}>
        <SectionHead index={2} title="Moods and feelings" note="For the whole song, or one part of it" />
        <div className="panel" data-testid="builder-moods">
          <div className="panel-body col" style={{ gap: 14 }}>
            {draft.moods.length > 0 && (
              <div className="cb-moods">
                {draft.moods.map((m, i) => {
                  const t = getTag(m.tagId);
                  return (
                    <div key={`${m.tagId}-${i}`} className="cb-mood" data-testid="builder-mood">
                      <span className="chip on">{t?.name ?? m.tagId}</span>
                      <Select
                        aria-label={`Where ${t?.name ?? m.tagId} applies`}
                        value={m.section ?? ''}
                        onChange={(v) =>
                          patch({
                            moods: draft.moods.map((x, j) =>
                              j === i ? (v ? { ...x, section: v as SectionKind } : { tagId: x.tagId }) : x,
                            ),
                          })
                        }
                        options={MOOD_TARGETS}
                      />
                      <Button
                        variant="ghost"
                        icon="close"
                        aria-label={`Remove ${t?.name ?? m.tagId}`}
                        onClick={() => patch({ moods: draft.moods.filter((_, j) => j !== i) })}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            {moodPick.length ? (
              <ChipPicker
                items={moodPick}
                selected={draft.moods.map((m) => m.tagId)}
                onToggle={toggleMood}
                label="Search moods"
                placeholder="Search moods and feelings"
                perGroup={14}
              />
            ) : (
              <div className="small muted">No mood tags in the catalog yet.</div>
            )}
          </div>
        </div>
      </section>

      <section id="shape-tags" aria-labelledby="shape-tags-h" className="col" style={{ gap: 12 }}>
        <SectionHead
          index={3}
          title="Style, era and production"
          note={draft.tags.length ? `${draft.tags.length} chosen` : 'Optional'}
        />
        <div className="panel" data-testid="builder-tags">
          <div className="panel-body col" style={{ gap: 14 }}>
            <Tabs
              value={tagKind}
              onChange={setTagKind}
              tabs={tagCounts.map(({ k, n }) => ({
                value: k,
                label: n ? `${tagKindLabel(k)} · ${n}` : tagKindLabel(k),
              }))}
            />
            {draft.tags.length > 0 && (
              <div className="chip-list" aria-label="Chosen tags">
                {draft.tags.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="chip on"
                    onClick={() => toggleTag(id)}
                    aria-label={`Remove tag ${getTag(id)?.name ?? id}`}
                  >
                    {getTag(id)?.name ?? id} ×
                  </button>
                ))}
              </div>
            )}
            <ChipPicker
              key={tagKind}
              items={tagPick}
              selected={draft.tags}
              onToggle={toggleTag}
              label="Search tags"
              placeholder={`Search ${tagKindLabel(tagKind).toLowerCase()} tags`}
              perGroup={10}
            />
          </div>
        </div>
      </section>

      <section id="shape-instruments" aria-labelledby="shape-instruments-h" className="col" style={{ gap: 12 }}>
        <SectionHead
          index={4}
          title="Instruments"
          note={
            draft.instruments.length
              ? `${draft.instruments.reduce((t, i) => t + i.count, 0)} chosen`
              : 'How many of each, and what they play'
          }
        />
        <div className="panel" data-testid="builder-instruments">
          <div className="panel-body col" style={{ gap: 12 }}>
            {!draft.instruments.length && suggestion.length > 0 && (
              <div className="callout small cb-suggest row wrap" data-testid="instrument-suggestion">
                <span className="grow">
                  <strong>Suggested for {draft.genres.length ? genre.name : 'this style'}:</strong>{' '}
                  {suggestion
                    .map(
                      (s) => `${instOf(s.instrumentId)?.name ?? s.instrumentId}${s.count > 1 ? ` × ${s.count}` : ''}`,
                    )
                    .join(', ')}
                </span>
                <Button
                  icon="plus"
                  onClick={() =>
                    patch({
                      instruments: suggestion.map((s) => ({ instrumentId: s.instrumentId, count: s.count })),
                    })
                  }
                >
                  Use these
                </Button>
              </div>
            )}
            {draft.instruments.map((entry, i) => (
              <InstrumentRow
                key={entry.instrumentId}
                entry={entry}
                inst={instOf(entry.instrumentId)}
                onChange={(p) => setInstrument(i, p)}
                onRemove={() => patch({ instruments: draft.instruments.filter((_, j) => j !== i) })}
              />
            ))}
            <ChipPicker
              items={instPick}
              selected={draft.instruments.map((i) => i.instrumentId)}
              onToggle={toggleInstrument}
              label="Search instruments"
              placeholder="Add an instrument: guitar, strings, synth…"
              perGroup={8}
            />
          </div>
        </div>
      </section>

      <section id="shape-settings" aria-labelledby="shape-settings-h" className="col" style={{ gap: 12 }}>
        <SectionHead index={5} title="Song settings" note="Auto picks what fits the genre" />
        <div className="panel" data-testid="builder-settings">
          <div className="panel-body shape-fields">
            <Field label="Tempo">
              <div className="row">
                <Select
                  aria-label="Tempo"
                  value={draft.tempo}
                  onChange={(tempo) => patch({ tempo })}
                  options={[
                    { value: 'auto', label: `Auto (≈${Math.round(genre.tempo.typical)} BPM)` },
                    { value: 'slow', label: `Slow (${tempoHint('slow')})` },
                    { value: 'mid', label: `Mid (${tempoHint('mid')})` },
                    { value: 'fast', label: `Fast (${tempoHint('fast')})` },
                    { value: 'bpm', label: 'Exact BPM' },
                  ]}
                />
                {draft.tempo === 'bpm' && (
                  <NumberInput
                    aria-label="BPM"
                    value={draft.bpm}
                    min={30}
                    max={300}
                    onChange={(bpm) => patch({ bpm: Math.round(bpm) })}
                    style={{ width: 80 }}
                  />
                )}
              </div>
            </Field>
            <Field label="Key">
              <div className="row">
                <Select
                  aria-label="Key"
                  value={String(draft.tonic)}
                  onChange={(v) => patch({ tonic: v === 'auto' ? 'auto' : parseInt(v, 10) })}
                  options={[{ value: 'auto', label: 'Auto' }, ...FLAT_NAMES.map((n, i) => ({ value: String(i), label: n }))]}
                />
                <Select
                  aria-label="Mode"
                  value={draft.mode}
                  onChange={(mode) => patch({ mode })}
                  options={[{ value: 'auto', label: 'Auto mode' }, ...MODES.map((m) => ({ value: m, label: m }))]}
                />
              </div>
            </Field>
            <Field label="Time signature">
              <Select
                aria-label="Meter"
                value={draft.meter}
                onChange={(meter) => patch({ meter })}
                options={[{ value: 'auto', label: 'Auto' }, ...METERS]}
              />
            </Field>
            <Field label="Length" hint={lyrics ? 'Set by your lyrics' : undefined}>
              <div className="row">
                <Select
                  aria-label="Length"
                  disabled={!!lyrics}
                  value={draft.length}
                  onChange={(length) => patch({ length })}
                  options={[
                    { value: 'standard', label: 'Standard' },
                    { value: 'short', label: 'Short' },
                    { value: 'long', label: 'Long' },
                    { value: 'minutes', label: 'Minutes…' },
                  ]}
                />
                {draft.length === 'minutes' && !lyrics && (
                  <NumberInput
                    aria-label="Minutes"
                    value={draft.minutes}
                    min={0.5}
                    max={12}
                    step={0.5}
                    onChange={(minutes) => patch({ minutes })}
                    style={{ width: 70 }}
                  />
                )}
              </div>
            </Field>
            <Field label="Structure" hint={lyrics ? 'Follows your lyrics' : undefined}>
              <Select
                aria-label="Structure"
                disabled={!!lyrics}
                value={templates.includes(draft.structure) ? draft.structure : ''}
                onChange={(structure) => patch({ structure })}
                options={[
                  { value: '', label: 'Auto (most common for the genre)' },
                  ...templates.map((t) => ({ value: t, label: t })),
                ]}
              />
            </Field>
            <Field
              label="Vocal"
              hint={vocalTracks > 0 ? `Adds a Lead Vocal track${lyrics ? ' that sings your lyrics' : ''}.` : undefined}
            >
              <div className="row">
                <Select
                  aria-label="Vocal"
                  value={draft.vocal}
                  onChange={(vocal) => patch({ vocal })}
                  options={[
                    { value: 'auto', label: `Auto (${autoVocal})` },
                    { value: 'none', label: 'Instrumental' },
                    ...VOICES.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) })),
                  ]}
                />
                {(draft.vocal !== 'none' && draft.vocal !== 'auto') || (draft.vocal === 'auto' && lyrics) ? (
                  <Select
                    aria-label="Vocal mode"
                    value={draft.vocalMode === 'default' ? (lyrics ? 'ai-singer' : 'melody-only') : draft.vocalMode}
                    onChange={(vocalMode) => patch({ vocalMode })}
                    options={VOCAL_MODES}
                  />
                ) : null}
              </div>
            </Field>
            <Field label="Title">
              <TextInput
                value={draft.title}
                onChange={(title) => patch({ title })}
                placeholder={preview?.title && preview.title !== 'Untitled' ? preview.title : 'Named for you'}
                aria-label="Title"
              />
            </Field>
            <Field label="Lyrics theme">
              <TextInput
                value={draft.lyricsTheme}
                onChange={(lyricsTheme) => patch({ lyricsTheme })}
                placeholder="e.g. leaving home"
                aria-label="Lyrics theme"
              />
            </Field>
          </div>
        </div>
      </section>

      <section id="shape-feel" aria-labelledby="shape-feel-h" className="col" style={{ gap: 12 }}>
        <SectionHead
          index={6}
          title="Feel"
          note={
            Object.keys(draft.macros).length ? (
              <Button size="sm" variant="ghost" onClick={() => patch({ macros: {} })}>
                Reset to the genre
              </Button>
            ) : (
              'Shape how it plays without touching notes'
            )
          }
        />
        <div className="panel" data-testid="builder-feel">
          <div className="panel-body shape-fields">
            {MACRO_INFO.map((m) => (
              <Slider
                key={m.key}
                label={m.label}
                left={m.left}
                right={m.right}
                value={draft.macros[m.key] ?? macroBase[m.key]}
                onChange={(v) => patch({ macros: { ...draft.macros, [m.key]: v } })}
                accent
              />
            ))}
          </div>
        </div>
      </section>

      <section id="shape-advanced" aria-labelledby="shape-advanced-h" className="col" style={{ gap: 12 }}>
        <SectionHead index={7} title="Advanced" note="Who composes it, and how repeatable it is" />
        <div className="panel quiet">
          <div className="panel-body col" style={{ gap: 16 }}>
            <div className="shape-fields">
              {advanced}
              <Field label="Seed" hint="Same choices and seed make the same song.">
                <div className="row">
                  <NumberInput
                    aria-label="Composition seed"
                    value={session.seed}
                    onChange={(v) => session.set({ seed: Math.round(v) })}
                    min={0}
                    max={99999999}
                  />
                  <Button
                    icon="dice"
                    title="New seed"
                    aria-label="New seed"
                    onClick={() => session.set({ seed: Math.floor(Math.random() * 99999999) })}
                  />
                </div>
              </Field>
            </div>
            <label className="shape-review">
              <input
                type="checkbox"
                checked={session.review}
                onChange={(e) => session.set({ review: e.target.checked })}
              />
              <span className="col" style={{ gap: 2 }}>
                <strong>Review the blueprint and plan before composing</strong>
                <span className="small muted">
                  Adds two steps: the song blueprint (sections, energy, instrument ranges, things to avoid) and
                  the plan for each section (harmony, energy, purpose, feel).
                </span>
              </span>
            </label>
          </div>
        </div>
      </section>
    </div>
  );
}
