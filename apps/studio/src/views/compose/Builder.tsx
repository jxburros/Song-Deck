import { useComposeInputs } from './inputs';
import { useMemo, type ReactNode } from 'react';
import {
  BUILTIN_GENRES,
  BUILTIN_INSTRUMENTS,
  FLAT_NAMES,
  blueprintFromChoices,
  builderGenre,
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
  type MusicalFunction,
  type SectionKind,
  type TrackRole,
  type VocalMode,
} from '@songdeck/core';
import type { RoleRoute } from '../../engine/ai';
import { Badge, Button, Field, NumberInput, Select, Slider, Tabs, TextArea, TextInput } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ProviderPicker } from '../shared/ProviderPicker';
import { FUNCTIONS, MODES, TRACK_ROLES } from './BlueprintEditor';
import { ChipPicker, genreItems, instrumentItems, tagItems } from './ChipPicker';
import { LyricsInput } from './LyricsInput';
import {
  STARTERS,
  choicesForStart,
  draftLyrics,
  useComposeSession,
  type ComposeDraft,
  type Starter,
} from './session';

/**
 * The Compose builder (step 1): pick instruments and how many, genres and how much influence,
 * moods and feelings, any other tags, and the settings — or start from lyrics. Works fully
 * offline; with a language model attached, "Describe it in your own words" adds plain language on
 * top (the builder's choices stay hard constraints).
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

function formatDuration(bp: Blueprint): string {
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
        <strong className="ellipsis">{name}</strong>
      </div>
      <div className="cb-stepper" role="group" aria-label={`${name} count`}>
        <Button
          size="sm"
          variant="ghost"
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
          variant="ghost"
          icon="plus"
          aria-label={`More ${name}`}
          disabled={entry.count >= 8}
          onClick={() => onChange({ count: Math.min(8, entry.count + 1) })}
        />
      </div>
      <Select
        size="sm"
        aria-label={`${name} role`}
        value={entry.role ?? ''}
        onChange={(v) => onChange({ role: (v || undefined) as TrackRole | undefined })}
        options={[
          { value: '', label: `Role: auto${inst ? ` (${inst.defaultRole})` : ''}` },
          ...TRACK_ROLES.map((r) => ({ value: r, label: r })),
        ]}
      />
      <Select
        size="sm"
        aria-label={`${name} function`}
        value={entry.function ?? ''}
        onChange={(v) => onChange({ function: (v || undefined) as MusicalFunction | undefined })}
        options={[
          { value: '', label: `Plays: auto${inst ? ` (${inst.defaultFunction})` : ''}` },
          ...FUNCTIONS.map((f) => ({ value: f, label: f })),
        ]}
      />
      <Button
        size="sm"
        variant="ghost"
        icon="close"
        aria-label={`Remove ${name}`}
        title={`Remove ${name}`}
        onClick={onRemove}
      />
    </div>
  );
}

export function Builder({
  route,
  lyricsControls,
  prototypeControls,
  busy,
  onGenerate,
  onFineTune,
  customGenres,
  customInstruments,
  onSuggestFromLyrics,
}: {
  route: RoleRoute | null;
  lyricsControls: ReactNode;
  prototypeControls: ReactNode;
  busy: string | null;
  onGenerate: () => void;
  onFineTune: () => void;
  customGenres: GenreProfile[];
  customInstruments: InstrumentProfile[];
  onSuggestFromLyrics?: () => void;
}) {
  const session = useComposeSession();
  const { draft, patch } = session;
  const model = Boolean(route && !route.internal);
  const allInstruments = useMemo(
    () => [
      ...customInstruments,
      ...BUILTIN_INSTRUMENTS.filter((b) => !customInstruments.some((c) => c.id === b.id)),
    ],
    [customInstruments],
  );
  const instOf = (id: string) => allInstruments.find((i) => i.id === id);
  const lyrics = useMemo(() => draftLyrics(draft), [draft]);
  const inputs = useComposeInputs((s) => s.inputs);
  const choices = useMemo(
    () => choicesForStart(draft, session.lyricsMode, inputs.find((i) => i.item.song)?.item.song),
    [draft, session.lyricsMode, inputs],
  );
  const genre = useMemo(() => builderGenre(choices, customGenres), [choices, customGenres]);
  const preview = useMemo(() => {
    try {
      return blueprintFromChoices(choices, { seed: session.seed, customGenres, customInstruments });
    } catch {
      return null;
    }
  }, [choices, session.seed, customGenres, customInstruments]);

  const genrePick = useMemo(() => genreItems(BUILTIN_GENRES, customGenres), [customGenres]);
  const instPick = useMemo(
    () => instrumentItems(BUILTIN_INSTRUMENTS, customInstruments),
    [customInstruments],
  );
  const moodPick = useMemo(() => tagItems(['mood']), []);
  const tagPick = useMemo(
    () => tagItems(['style', 'era', 'production', 'vocal', 'region', 'rhythm'], customGenres),
    [customGenres],
  );
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
  const sectionsWithLyrics = lyrics?.sections.filter((s) => s.lines.length).length ?? 0;

  const summary = preview && (
    <div className="cb-summary small" data-testid="builder-summary">
      <span>
        <strong>{preview.instrumentation.length}</strong> tracks
      </span>
      <span>{preview.tempo} BPM</span>
      <span>
        {FLAT_NAMES[preview.key.tonic]} {preview.key.mode}
      </span>
      <span>
        {preview.meter.numerator}/{preview.meter.denominator}
      </span>
      <span>≈{formatDuration(preview)}</span>
      {preview.tags?.length ? (
        <span>{preview.tags.length === 1 ? '1 tag' : `${preview.tags.length} tags`}</span>
      ) : null}
      {lyrics && <span>{sectionsWithLyrics} sung sections</span>}
    </div>
  );

  return (
    <div className="cb-layout" data-testid="compose-builder">
      <div className="cb-main col">
        {model && (
          <div className="panel" data-testid="describe-panel">
            <div className="panel-header">
              <Icon name="sparkles" />
              <h3 className="grow">Describe it in your own words</h3>
              <Badge tone="ai">{route?.providerName}</Badge>
            </div>
            <div className="panel-body col">
              <TextArea
                value={draft.describe}
                onChange={(describe) => patch({ describe })}
                rows={3}
                aria-label="Song description"
                placeholder="e.g. a slow-burning song about leaving home, brushed drums, warm and hopeful, builds to a big last chorus"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onGenerate();
                }}
              />
              <div className="small muted">
                <Icon name="info" size={12} /> {route?.providerName} fills in what you describe; everything
                you pick below is kept exactly.
              </div>
            </div>
          </div>
        )}

        <Tabs
          value={session.tab}
          onChange={(tab) => session.set({ tab })}
          tabs={[
            { value: 'sound', label: 'Sound', icon: 'music' },
            { value: 'lyrics', label: lyrics ? `Lyrics · ${sectionsWithLyrics}` : 'Lyrics', icon: 'book' },
          ]}
          className="cb-tabs"
        />

        {session.tab === 'lyrics' ? (
          <>
            {lyricsControls}
            {session.lyricsMode === 'provided' && (
              <LyricsInput onSuggest={model ? onSuggestFromLyrics : undefined} route={route} busy={busy} />
            )}
          </>
        ) : (
          <>
            <div className="cb-starters row wrap">
              <span className="small muted">Start from:</span>
              {STARTERS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="chip"
                  onClick={() => patch({ ...applyStarter(s, customGenres) })}
                >
                  {s.label}
                </button>
              ))}
              {(draft.instruments.length > 0 ||
                draft.genres.length > 0 ||
                draft.moods.length > 0 ||
                draft.tags.length > 0) && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  onClick={() => patch({ instruments: [], genres: [], moods: [], tags: [] })}
                >
                  Clear
                </Button>
              )}
            </div>

            <details className="cb-disclosure" data-testid="sound-details">
              <summary>Customize instruments, genres &amp; mood</summary>
              <div className="panel" data-testid="builder-instruments">
                <div className="panel-header">
                  <Icon name="midi" />
                  <h3 className="grow">Instruments</h3>
                  <span className="small muted">
                    {draft.instruments.reduce((t, i) => t + i.count, 0) || 'none yet'}
                  </span>
                </div>
                <div className="panel-body col">
                  {draft.instruments.map((entry, i) => (
                    <InstrumentRow
                      key={entry.instrumentId}
                      entry={entry}
                      inst={instOf(entry.instrumentId)}
                      onChange={(p) => setInstrument(i, p)}
                      onRemove={() => patch({ instruments: draft.instruments.filter((_, j) => j !== i) })}
                    />
                  ))}
                  {!draft.instruments.length && suggestion.length > 0 && (
                    <div className="callout small cb-suggest" data-testid="instrument-suggestion">
                      <span>
                        Suggested for {draft.genres.length ? genre.name : 'this style'}:{' '}
                        {suggestion
                          .map(
                            (s) =>
                              `${instOf(s.instrumentId)?.name ?? s.instrumentId}${s.count > 1 ? ` × ${s.count}` : ''}`,
                          )
                          .join(', ')}
                      </span>
                      <Button
                        size="sm"
                        icon="plus"
                        onClick={() =>
                          patch({
                            instruments: suggestion.map((s) => ({
                              instrumentId: s.instrumentId,
                              count: s.count,
                            })),
                          })
                        }
                      >
                        Use these
                      </Button>
                    </div>
                  )}
                  <ChipPicker
                    items={instPick}
                    selected={draft.instruments.map((i) => i.instrumentId)}
                    onToggle={toggleInstrument}
                    label="Search instruments"
                    placeholder="Search instruments (guitar, strings, synth…)"
                    perGroup={8}
                  />
                </div>
              </div>

              <div className="panel" data-testid="builder-genres">
                <div className="panel-header">
                  <Icon name="layers" />
                  <h3 className="grow">Genres</h3>
                  <span className="small muted">
                    {draft.genres.length ? 'influence' : 'pick one or blend several'}
                  </span>
                </div>
                <div className="panel-body col">
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
                        <span className="mono small cb-pct">
                          {Math.round((g.weight / genreTotal) * 100)}%
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="close"
                          aria-label={`Remove ${name}`}
                          onClick={() => patch({ genres: draft.genres.filter((_, j) => j !== i) })}
                        />
                      </div>
                    );
                  })}
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

              <div className="panel" data-testid="builder-moods">
                <div className="panel-header">
                  <Icon name="sparkles" />
                  <h3 className="grow">Moods &amp; feelings</h3>
                </div>
                <div className="panel-body col">
                  {draft.moods.length > 0 && (
                    <div className="cb-moods">
                      {draft.moods.map((m, i) => {
                        const t = getTag(m.tagId);
                        return (
                          <div key={`${m.tagId}-${i}`} className="cb-mood" data-testid="builder-mood">
                            <span className="chip on">{t?.name ?? m.tagId}</span>
                            <Select
                              size="sm"
                              aria-label={`Where ${t?.name ?? m.tagId} applies`}
                              value={m.section ?? ''}
                              onChange={(v) =>
                                patch({
                                  moods: draft.moods.map((x, j) =>
                                    j === i
                                      ? v
                                        ? { ...x, section: v as SectionKind }
                                        : { tagId: x.tagId }
                                      : x,
                                  ),
                                })
                              }
                              options={MOOD_TARGETS}
                            />
                            <Button
                              size="sm"
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

              <div className="panel" data-testid="builder-tags">
                <div className="panel-header">
                  <Icon name="grid" />
                  <h3 className="grow">Style, era &amp; production</h3>
                  <span className="small muted">
                    {draft.tags.length
                      ? `${draft.tags.length} chosen`
                      : tagPick.length === 1
                        ? '1 tag'
                        : `${tagPick.length} tags`}
                  </span>
                </div>
                <div className="panel-body col">
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
                          {getTag(id)?.name ?? id} <Icon name="close" size={10} />
                        </button>
                      ))}
                    </div>
                  )}
                  <ChipPicker
                    items={tagPick}
                    selected={draft.tags}
                    onToggle={toggleTag}
                    label="Search tags"
                    placeholder="Search styles, eras, production, regions, rhythms…"
                    perGroup={8}
                  />
                </div>
              </div>
            </details>
          </>
        )}
      </div>

      <div className="cb-actions panel" data-testid="builder-actions">
        <div className="panel-body col">
          <Field label="Composition planner">
            <ProviderPicker
              role="composition"
              value={session.planner}
              onChange={(planner) => session.set({ planner })}
            />
          </Field>
          {summary}
          {preview && preview.instrumentation.length > 0 && (
            <div
              className="small muted ellipsis-2"
              title={preview.instrumentation.map((t) => t.name).join(', ')}
            >
              {preview.instrumentation.map((t) => t.name).join(' · ')}
            </div>
          )}
          <Button variant="primary" size="lg" icon="sparkles" disabled={!!busy} onClick={onGenerate}>
            {busy ?? 'Generate song'}
          </Button>
          {prototypeControls}
          <Button size="sm" variant="ghost" icon="sliders" disabled={!!busy} onClick={onFineTune}>
            Fine-tune first
          </Button>
          <div className="small dim">
            {model
              ? `With ${route?.providerName}${draft.describe.trim() ? ' (your words + choices)' : ' — add words above, or generate from your choices'}`
              : 'On-device engine · works offline'}
          </div>
        </div>
      </div>

      <div className="cb-side col">
        <details className="cb-disclosure" data-testid="builder-settings">
          <summary>Song settings</summary>
          <div className="panel-body col">
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
                    style={{ width: 76 }}
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
                  options={[
                    { value: 'auto', label: 'Auto' },
                    ...FLAT_NAMES.map((n, i) => ({ value: String(i), label: n })),
                  ]}
                />
                <Select
                  aria-label="Mode"
                  value={draft.mode}
                  onChange={(mode) => patch({ mode })}
                  options={[
                    { value: 'auto', label: 'Auto mode' },
                    ...MODES.map((m) => ({ value: m, label: m })),
                  ]}
                />
              </div>
            </Field>
            <div className="grid-2">
              <Field label="Meter">
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
                      style={{ width: 64 }}
                    />
                  )}
                </div>
              </Field>
            </div>
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
            <Field label="Vocal">
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
                    value={
                      draft.vocalMode === 'default' ? (lyrics ? 'ai-singer' : 'melody-only') : draft.vocalMode
                    }
                    onChange={(vocalMode) => patch({ vocalMode })}
                    options={VOCAL_MODES}
                  />
                ) : null}
              </div>
              {vocalTracks > 0 && (
                <div className="hint">Adds a Lead Vocal track{lyrics ? ' that sings your lyrics' : ''}.</div>
              )}
            </Field>
            <Field label="Title">
              <TextInput
                value={draft.title}
                onChange={(title) => patch({ title })}
                placeholder={preview?.title && preview.title !== 'Untitled' ? preview.title : 'Untitled'}
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
            <div className="grid-2">
              <Field label="Seed" hint="Same choices + seed ⇒ same song.">
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
          </div>
        </details>
      </div>
    </div>
  );
}
