import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getGenre, keyName, randomId, type GenreProfile } from '@songdeck/core';
import { fileToLibraryDraft, type LibraryItem } from '../../state/library';
import { useStudio } from '../../state/store';
import type { RoleRoute } from '../../engine/ai';
import { Button, FileButton, NumberInput, Select, TextArea } from '../../ui/kit';
import { Icon, type IconName } from '../../ui/icons';
import { LibraryBrowser } from '../library/LibraryMode';
import { RecordPanel } from '../transcribe/RecordPanel';
import { ProviderPicker } from '../shared/ProviderPicker';
import { INTERPRETATIONS, playableItem, useComposeInputs, type ComposeInput } from './inputs';
import { LyricsInput } from './LyricsInput';
import { draftLyrics, useComposeSession } from './session';

/**
 * Start a song, step 1: the starting material — lyrics (full or partial), recordings (live or
 * uploaded), MIDI and Library items, and a prompt when a model is connected — in any mix.
 */

/** What the song has to go on: material added, basics set or found, and whether it can be created. */
export function useReadiness(model: boolean) {
  const session = useComposeSession();
  const inputs = useComposeInputs((s) => s.inputs);
  const d = session.draft;
  const lyrics = useMemo(
    () => (session.lyricsOn && session.lyricsMode === 'provided' ? draftLyrics(d) : undefined),
    [d, session.lyricsOn, session.lyricsMode],
  );
  const lyricsMaterial =
    session.lyricsOn &&
    (session.lyricsMode === 'provided'
      ? !!lyrics
      : session.lyricsMode === 'generate'
        ? !!d.lyricsTheme.trim()
        : true);
  const prompt = model && session.promptOn && !!d.describe.trim();
  const material = (lyricsMaterial ? 1 : 0) + inputs.length + (prompt ? 1 : 0);
  const anchor = inputs.find((i) => i.item.song)?.item.song;
  const found: { k: string; v: string; from: string }[] = [];
  if (anchor?.tempoMap[0]) found.push({ k: 'Tempo', v: `${Math.round(anchor.tempoMap[0].bpm)} BPM`, from: anchor.title });
  if (anchor?.keyMap[0]) found.push({ k: 'Key', v: keyName(anchor.keyMap[0].key), from: anchor.title });
  if (anchor?.meterMap[0])
    found.push({ k: 'Time', v: `${anchor.meterMap[0].numerator}/${anchor.meterMap[0].denominator}`, from: anchor.title });
  const sung = lyrics?.sections.filter((s) => s.lines.length).length ?? 0;
  if (lyrics) found.push({ k: 'Form', v: `${lyrics.sections.length} sections`, from: 'your lyrics' });
  const groups = [
    d.genres.length > 0 || d.tags.length > 0,
    d.moods.length > 0,
    d.instruments.length > 0,
    d.tempo !== 'auto' || !!anchor?.tempoMap[0],
    d.tonic !== 'auto' || d.mode !== 'auto' || !!anchor?.keyMap[0],
    d.meter !== 'auto' || d.length !== 'standard' || !!d.structure || !!lyrics || !!anchor?.meterMap[0],
  ];
  const basics = groups.filter(Boolean).length;
  const ready = material > 0 && basics > 0;
  const blocked =
    material === 0
      ? 'Add some starting material: lyrics, audio, MIDI or a prompt.'
      : basics === 0
        ? 'Set at least one basic: a style, mood, instrument, tempo, key or length.'
        : null;
  return { material, basics, groups, found, sung, ready, blocked };
}

function CardHead({
  icon,
  kind,
  title,
  ai,
  actions,
  onRemove,
  removeLabel,
}: {
  icon: IconName;
  kind: string;
  title: ReactNode;
  ai?: boolean;
  actions?: ReactNode;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <div className="mat-head">
      <span className={`mat-icon ${ai ? 'ai' : ''}`}>
        <Icon name={icon} size={18} />
      </span>
      <span className="col grow" style={{ gap: 0 }}>
        <span className="mat-kind">{kind}</span>
        <strong className="ellipsis">{title}</strong>
      </span>
      {actions}
      <Button variant="ghost" icon="close" aria-label={removeLabel} title={removeLabel} onClick={onRemove} />
    </div>
  );
}

function LyricsCard({
  disabled,
  lyricsRoute,
  route,
  busy,
  onSuggest,
}: {
  disabled: boolean;
  lyricsRoute: RoleRoute | null;
  route: RoleRoute | null;
  busy: string | null;
  onSuggest?: () => void;
}) {
  const session = useComposeSession();
  const lyrics = draftLyrics(session.draft);
  const lyricsModel = Boolean(lyricsRoute && !lyricsRoute.internal);
  return (
    <section className="panel mat-card" data-testid="material-lyrics" aria-label="Lyrics material">
      <CardHead
        icon="book"
        kind="Lyrics"
        title={
          session.lyricsMode === 'generate'
            ? 'Written for you'
            : session.lyricsMode === 'placeholder'
              ? 'Placeholder words'
              : lyrics
                ? `${lyrics.sections.filter((s) => s.lines.length).length} sung sections`
                : 'Your words'
        }
        actions={
          <Select
            aria-label="Lyrics starting point"
            value={session.lyricsMode === 'instrumental' ? 'provided' : session.lyricsMode}
            disabled={disabled}
            onChange={(lyricsMode) => {
              session.set({ lyricsMode });
              if (lyricsMode === 'placeholder') session.patch({ vocal: 'tenor', vocalMode: 'placeholder' });
              else session.patch({ vocal: 'auto', vocalMode: 'default' });
            }}
            options={[
              { value: 'provided', label: 'Use my lyrics' },
              { value: 'generate', label: 'Write them for me' },
              { value: 'placeholder', label: 'Placeholder words' },
            ]}
          />
        }
        removeLabel="Remove lyrics"
        onRemove={() => {
          session.set({ lyricsOn: false, lyricsMode: 'provided' });
          session.patch({ lyricsText: '', lyricKinds: {}, vocal: 'auto', vocalMode: 'default' });
        }}
      />
      <div className="panel-body">
        {session.lyricsMode === 'provided' && <LyricsInput onSuggest={onSuggest} route={route} busy={busy} />}
        {session.lyricsMode === 'generate' && (
          <div className="col" style={{ gap: 10 }}>
            <label className="field">
              <span className="field-label">Lyrics model</span>
              <ProviderPicker
                role="lyrics"
                value={session.lyricsProvider}
                onChange={(lyricsProvider) => session.set({ lyricsProvider })}
              />
            </label>
            <TextArea
              aria-label="Lyrics prompt"
              value={session.draft.lyricsTheme}
              onChange={(lyricsTheme) => session.patch({ lyricsTheme })}
              placeholder="What should the lyrics be about?"
            />
            {!lyricsModel && (
              <p className="small muted">Connect a lyrics model in Settings, or choose placeholder words.</p>
            )}
          </div>
        )}
        {session.lyricsMode === 'placeholder' && (
          <p className="small muted" style={{ margin: 0 }}>
            The vocal melody is sung on placeholder syllables you can replace with real words later.
          </p>
        )}
      </div>
    </section>
  );
}

const KIND_LABEL: Record<LibraryItem['kind'], { label: string; icon: IconName }> = {
  audio: { label: 'Audio', icon: 'mic' },
  midi: { label: 'MIDI', icon: 'midi' },
  collection: { label: 'Track set', icon: 'layers' },
  file: { label: 'File', icon: 'folder' },
};

function InputCard({ input, disabled }: { input: ComposeInput; disabled: boolean }) {
  const state = useComposeInputs();
  const song = input.item.song;
  const kind = KIND_LABEL[input.item.kind];
  const midiTracks = song?.tracks.filter((t) => t.kind === 'midi') ?? [];
  return (
    <section className="panel mat-card" data-testid="compose-input" aria-label={`${kind.label}: ${input.item.name}`}>
      <CardHead
        icon={kind.icon}
        kind={kind.label}
        title={input.item.name}
        removeLabel={`Remove ${input.item.name}`}
        onRemove={() => state.remove(input.id)}
      />
      <div className="panel-body col" style={{ gap: 12 }}>
        {midiTracks.length > 0 && (
          <div className="mat-tracks">
            {midiTracks.slice(0, 8).map((t) => (
              <span key={t.id} className="mat-track">
                <span className="mat-track-color" style={{ background: t.color }} />
                {t.name}
                <span className="dim mono small">{t.notes.length} notes</span>
              </span>
            ))}
          </div>
        )}
        <div className="mat-fields">
          <label className="field compose-start-bar">
            <span className="field-label">Starts at bar</span>
            <NumberInput
              min={1}
              step={1}
              value={input.startBar}
              disabled={disabled}
              onChange={(v) => state.patch(input.id, { startBar: Math.max(1, Math.round(v)) })}
            />
          </label>
          <label className="field">
            <span className="field-label">Follow it</span>
            <Select
              aria-label={`Interpretation for ${input.item.name}`}
              value={input.interpretation}
              disabled={disabled}
              options={INTERPRETATIONS}
              onChange={(interpretation) => state.patch(input.id, { interpretation })}
            />
          </label>
        </div>
        <span className="small muted">
          {INTERPRETATIONS.find((i) => i.value === input.interpretation)?.hint}
          {input.item.kind === 'audio' && input.interpretation !== 'preserve'
            ? ' Audio is transcribed to MIDI first; the original recording is kept with the song.'
            : ''}
        </span>
        {song && (
          <span className="row small muted" style={{ gap: 8 }}>
            <span className="diamond" />
            {Math.round(song.tempoMap[0]?.bpm ?? 120)} BPM
            {song.keyMap[0] ? ` · ${keyName(song.keyMap[0].key)}` : ''}
            {song.meterMap[0] ? ` · ${song.meterMap[0].numerator}/${song.meterMap[0].denominator}` : ''}
          </span>
        )}
      </div>
    </section>
  );
}

function PromptCard({ route, onGenerate }: { route: RoleRoute | null; onGenerate: () => void }) {
  const session = useComposeSession();
  return (
    <section className="panel mat-card ai" data-testid="describe-panel" aria-label="Prompt material">
      <CardHead
        icon="sparkles"
        kind={`Prompt · ${route?.providerName ?? 'AI'}`}
        title="In your own words"
        ai
        removeLabel="Remove prompt"
        onRemove={() => {
          session.set({ promptOn: false });
          session.patch({ describe: '' });
        }}
      />
      <div className="panel-body col" style={{ gap: 8 }}>
        <TextArea
          value={session.draft.describe}
          onChange={(describe) => session.patch({ describe })}
          rows={3}
          aria-label="Song description"
          placeholder="e.g. a slow-burning song about leaving home, brushed drums, warm and hopeful, builds to a big last chorus"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onGenerate();
          }}
        />
        <span className="small dim">
          Your words fill in what you leave open. Anything you pick on the next screen is kept exactly.
        </span>
      </div>
    </section>
  );
}

/** The material cards plus the Add bar. */
export function MaterialSection({
  model,
  route,
  lyricsRoute,
  busy,
  disabled,
  onLoadingChange,
  onSuggestFromLyrics,
  onGenerate,
}: {
  model: boolean;
  route: RoleRoute | null;
  lyricsRoute: RoleRoute | null;
  busy: string | null;
  disabled: boolean;
  onLoadingChange: (loading: boolean) => void;
  onSuggestFromLyrics: () => void;
  onGenerate: () => void;
}) {
  const session = useComposeSession();
  const state = useComposeInputs();
  const [showLibrary, setShowLibrary] = useState(false);
  const [record, setRecord] = useState(false);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onLoadingChange(loading);
    return () => onLoadingChange(false);
  }, [loading, onLoadingChange]);
  // A start picked on the Songs home screen opens that material.
  useEffect(() => {
    if (session.focus === 'audio') setRecord(true);
    if (session.focus === 'midi') fileRef.current?.scrollIntoView({ block: 'center' });
    if (session.focus) session.set({ focus: null });
  }, [session, session.focus]);
  const add = async (item: LibraryItem) => {
    setLoading(true);
    try {
      state.add(await playableItem(item));
    } catch (e) {
      useStudio.getState().toast('error', `Could not add input: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  };
  const off = disabled || loading;
  const empty = !session.lyricsOn && !session.promptOn && state.inputs.length === 0;
  return (
    <section className="col" style={{ gap: 16 }} aria-labelledby="material-h" data-testid="material">
      <div className="rule-title">
        <span className="index">01</span>
        <h2 id="material-h">Starting material</h2>
        <span className="line" />
        <span className="note">One or more. Each keeps its place in the song.</span>
      </div>
      {empty && (
        <div className="mat-empty hatch-soft">Add at least one: lyrics, a recording, MIDI or a prompt.</div>
      )}
      {session.lyricsOn && (
        <LyricsCard
          disabled={disabled}
          lyricsRoute={lyricsRoute}
          route={route}
          busy={busy}
          onSuggest={model ? onSuggestFromLyrics : undefined}
        />
      )}
      {state.inputs.map((input) => (
        <InputCard key={input.id} input={input} disabled={disabled} />
      ))}
      {model && session.promptOn && <PromptCard route={route} onGenerate={onGenerate} />}

      <div className="mat-add hatch" ref={fileRef} aria-label="Add starting material" role="group">
        <span className="mat-add-label">Add</span>
        {!session.lyricsOn && (
          <Button icon="book" disabled={disabled} onClick={() => session.set({ lyricsOn: true })}>
            Lyrics
          </Button>
        )}
        <Button icon="mic" disabled={off} active={record} onClick={() => setRecord(!record)}>
          Record an idea
        </Button>
        <FileButton
          multiple
          accept="audio/*,.mid,.midi,.songproject,.wav,.flac,.mp3"
          disabled={off}
          onFile={(files) => {
            void (async () => {
              setLoading(true);
              try {
                for (const file of files) {
                  const draft = await fileToLibraryDraft(file, true);
                  state.add(
                    await playableItem({ ...draft, id: randomId('input'), createdAt: new Date().toISOString() }),
                  );
                }
              } catch (e) {
                if (!(e instanceof Error && e.name === 'AbortError')) useStudio.getState().toast('error', String(e));
              } finally {
                setLoading(false);
              }
            })();
          }}
          icon="upload"
        >
          Add audio / MIDI files
        </FileButton>
        <Button icon="book" disabled={off} active={showLibrary} onClick={() => setShowLibrary(!showLibrary)}>
          Choose from Library
        </Button>
        {model && !session.promptOn && (
          <Button variant="ai" icon="sparkles" disabled={disabled} onClick={() => session.set({ promptOn: true })}>
            Prompt
          </Button>
        )}
        {loading && (
          <span role="status" className="small muted">
            Analyzing input…
          </span>
        )}
      </div>
      {record && (
        <div className="panel">
          <div className="panel-body">
            <RecordPanel
              kind="record"
              bpm={120}
              beatsPerBar={4}
              onCaptured={(c) => {
                if (c.bytes)
                  void add({
                    id: randomId('input'),
                    name: c.name,
                    kind: 'audio',
                    assets: [],
                    createdAt: c.createdAt,
                    file: { name: c.name, mime: c.mimeType ?? 'audio/webm', bytes: c.bytes },
                  });
                setRecord(false);
              }}
            />
          </div>
        </div>
      )}
      {showLibrary && (
        <div className="panel">
          <div className="panel-body">
            <LibraryBrowser
              onPick={(item) => {
                void add(item);
                setShowLibrary(false);
              }}
            />
          </div>
        </div>
      )}
      <div className="row wrap small muted" style={{ gap: 6 }}>
        More ways to start:
        <Button size="sm" variant="ghost" icon="rebuild" onClick={() => useStudio.getState().setMode('rebuild')}>
          Rebuild a full recording
        </Button>
        <Button size="sm" variant="ghost" icon="layers" onClick={() => useStudio.getState().setMode('expand')}>
          Develop a short clip
        </Button>
      </div>
    </section>
  );
}

const QUICK_STYLES = [
  'folk',
  'country',
  'indie-rock',
  'alternative-rock',
  'pop-punk',
  'synth-pop',
  'hip-hop',
  'cinematic',
];

/** The basics meter: six parallelogram segments. */
export function BasicsMeter({ basics }: { basics: number }) {
  return (
    <div className="basics-meter" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className={i < basics ? 'on' : ''} />
      ))}
    </div>
  );
}

export function ReadinessLines({ material, basics }: { material: number; basics: number }) {
  return (
    <div className="col small" style={{ gap: 6 }}>
      <span className="row" style={{ gap: 8 }}>
        <span className={`diamond ${material ? '' : 'off'}`} />
        <span className="grow">Starting material</span>
        <span className="mono muted">{material ? `${material} added` : 'Add one'}</span>
      </span>
      <span className="row" style={{ gap: 8 }}>
        <span className={`diamond ${basics ? '' : 'off'}`} />
        <span className="grow">Basics</span>
        <span className="mono muted">{basics} of 6 set</span>
      </span>
    </div>
  );
}

/** Right column of the Material step: what was found, a quick style, readiness and next steps. */
export function MaterialAside({
  model,
  customGenres,
  busy,
  onNext,
  onCreate,
}: {
  model: boolean;
  customGenres: GenreProfile[];
  busy: string | null;
  onNext: () => void;
  onCreate: () => void;
}) {
  const session = useComposeSession();
  const { draft, patch } = session;
  const r = useReadiness(model);
  const toggle = (id: string) => {
    const on = draft.genres.some((g) => g.genreId === id);
    patch({
      genres: on
        ? draft.genres.filter((g) => g.genreId !== id)
        : [...draft.genres, { genreId: id, weight: draft.genres.length ? 0.5 : 1 }],
    });
  };
  return (
    <aside className="compose-aside col" aria-labelledby="next-h">
      <div className="rule-title">
        <span className="index">02</span>
        <h2 id="next-h">Next: shape it</h2>
        <span className="line" />
      </div>
      <div className="panel">
        <div className="aside-block">
          <span className="field-label">Found in your material</span>
          {r.found.length ? (
            <dl className="stat-grid">
              {r.found.map((f) => (
                <div key={f.k} title={`From ${f.from}`}>
                  <dt>{f.k}</dt>
                  <dd className="mono">{f.v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <span className="small muted">Nothing yet. Add audio or MIDI and the key and tempo fill in.</span>
          )}
        </div>
        <div className="aside-block">
          <span className="field-label" id="quick-style">
            Quick style
          </span>
          <div className="chip-list" role="group" aria-labelledby="quick-style">
            {QUICK_STYLES.filter((id) => getGenre(id, customGenres)).map((id) => {
              const on = draft.genres.some((g) => g.genreId === id);
              return (
                <button
                  key={id}
                  type="button"
                  className={`chip ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggle(id)}
                >
                  {getGenre(id, customGenres)?.name ?? id}
                </button>
              );
            })}
          </div>
          <span className="small dim">Genre blends, moods, tags, instruments and feel are on the next screen.</span>
        </div>
        <div className="aside-block col" style={{ gap: 12 }}>
          <BasicsMeter basics={r.basics} />
          <ReadinessLines material={r.material} basics={r.basics} />
          <Button variant="primary" size="lg" className="cta" onClick={onNext}>
            Next: shape the song <Icon name="chevronRight" />
          </Button>
          {r.ready ? (
            <Button disabled={!!busy} onClick={onCreate}>
              {busy ?? 'Create now, rest on Auto'}
            </Button>
          ) : (
            <span className="small muted">{r.blocked}</span>
          )}
        </div>
      </div>
    </aside>
  );
}
