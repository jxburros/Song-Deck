import { useCallback, useState } from 'react';
import {
  BUILTIN_GENRES,
  blueprintFromChoices,
  composeSong,
  regenerateUnlocked,
  creditLyricWriter,
  getTag,
  keyName,
  planComposition,
  parseLyricSheet,
  type Blueprint,
  type CompositionPlan,
  type GenreProfile,
  type Song,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { useCustomGenres, useCustomInstruments } from '../../hooks';
import { Badge, Button, Field, Select } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { sectionColor } from '../../ui/theme';
import { BlueprintEditor } from './BlueprintEditor';
import { PlanTable } from './PlanTable';
import { SHAPE_SECTIONS, ShapeSections, formatDuration, useShapePreview } from './Shape';
import { BasicsMeter, MaterialAside, MaterialSection, ReadinessLines, useReadiness } from './Material';
import { SongTypeSwitch } from './SongType';
import {
  activeLyricsMode,
  choicesForStart,
  draftLyrics,
  lyricsActive,
  useComposeSession,
  type ComposeStep,
} from './session';
import { aiDesignBlueprint, aiPlanSong, aiLyrics, useRoleRoute, useAiRuntime } from '../../engine/ai';
import { attachLibraryAssets } from '../../state/library';
import { interpretInput, mergeComposeInputs, useComposeInputs } from './inputs';
import { ProviderPicker } from '../shared/ProviderPicker';
import { prototypeTargets, queuePrototype } from '../../engine/prototype';
import { useProduceUi } from '../produce/state';
import { openSettings } from '../settings/nav';
import './compose.css';

/** A descriptive working title ("Pop-Punk in E minor") for songs whose prompt named none. */
function workingTitle(song: Song, genres: GenreProfile[]): string {
  const main = [...song.genreBlend].sort((a, b) => b.weight - a.weight)[0];
  const genre = main ? genres.find((g) => g.id === main.genreId)?.name : undefined;
  const key = song.keyMap[0] ? keyName(song.keyMap[0].key) : '';
  return [genre ?? 'Song', key && `in ${key}`].filter(Boolean).join(' ');
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const aborted = (err: unknown) => err instanceof Error && err.name === 'AbortError';

/** Model plans may reshape the form; with up-front lyrics the sections must stay the lyrics' sections. */
function planFitsLyrics(plan: CompositionPlan, bp: Blueprint): boolean {
  if (!bp.lyrics?.sections.length) return true;
  const a = plan.sections.filter((s) => s.bars > 0).map((s) => s.kind);
  const b = bp.structure.filter((s) => s.bars > 0).map((s) => s.kind);
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

export default function ComposeMode() {
  const project = useStudio((s) => s.project);
  const st = useStudio.getState();
  const userName = useSettings((s) => s.userName);
  const customGenres = useCustomGenres();
  const customInstruments = useCustomInstruments();
  const session = useComposeSession();
  const { seed, planner } = session;
  useAiRuntime((s) => s.version);
  useSettings((s) => s.routing);
  const audioTargets = prototypeTargets();
  const [audioTarget, setAudioTarget] = useState('auto');
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [plan, setPlan] = useState<CompositionPlan | null>(null);
  const step = session.step;
  const setStep = useCallback((s: ComposeStep) => useComposeSession.getState().set({ step: s }), []);
  const [prototype, setPrototype] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [inputLoading, setInputLoading] = useState(false);
  const [source, setSource] = useState<string>('');
  const [target, setTarget] = useState<'new' | 'replace'>('new');
  const route = useRoleRoute('composition', planner);
  const lyricsRoute = useRoleRoute('lyrics', session.lyricsProvider);
  const inputs = useComposeInputs((s) => s.inputs);
  const model = Boolean(route && !route.internal);
  const allGenres = [...BUILTIN_GENRES, ...customGenres];
  const custom = { customGenres, customInstruments };

  /** Builder → blueprint: on-device, or with the model when the user also described the song in words. */
  const designBlueprint = async (): Promise<{ bp: Blueprint; source: string }> => {
    const draft = useComposeSession.getState().draft;
    const choices = choicesForStart(
      draft,
      activeLyricsMode(useComposeSession.getState()),
      inputs.find((i) => i.item.song)?.item.song,
    );
    const inputContext = inputs
      .map((i) =>
        JSON.stringify({
          name: i.item.name,
          interpretation: i.interpretation,
          startBar: i.startBar,
          tempo: i.item.song?.tempoMap,
          key: i.item.song?.keyMap,
          chords: i.item.song?.chords.slice(0, 64),
          tracks: i.item.song?.tracks.map((t) => ({
            name: t.name,
            role: t.role,
            ppq: i.item.song?.ppq,
            notes: t.notes.slice(0, 128).map((n) => ({ pitch: n.pitch, tick: n.tick, duration: n.duration })),
          })),
        }),
      )
      .join('\n');
    const words = [
      draft.describe.trim(),
      inputContext &&
        `Compose around these supplied tracks, which will be inserted after generation. Fill out the arrangement around them.\n${inputContext}`,
    ]
      .filter(Boolean)
      .join('\n');
    if (model && words) {
      try {
        const res = await aiDesignBlueprint(words, { providerChoice: planner, seed, choices });
        // Instrumental is a promise: whatever the model suggested, no vocal and no lyrics.
        const bp = useComposeSession.getState().instrumental
          ? {
              ...res.blueprint,
              vocal: undefined,
              lyrics: undefined,
              instrumentation: res.blueprint.instrumentation.filter((t) => t.instrumentId !== 'lead-vocal'),
            }
          : res.blueprint;
        return { bp, source: res.source };
      } catch (err) {
        if (aborted(err)) throw err;
        st.toast(
          'warning',
          `${route?.providerName ?? 'The model'} is unavailable — built the blueprint on-device from your choices. ${errText(err)}`,
        );
      }
    }
    return { bp: blueprintFromChoices(choices, { seed, ...custom }), source: 'On-device engine' };
  };

  const planFor = async (bp: Blueprint): Promise<{ plan: CompositionPlan; source: string }> => {
    if (model) {
      try {
        const res = await aiPlanSong(bp, { providerChoice: planner, seed });
        if (planFitsLyrics(res.plan, bp)) return { plan: res.plan, source: res.source };
      } catch (err) {
        if (aborted(err)) throw err;
        st.toast('warning', `AI planner unavailable — planned on-device. ${errText(err)}`);
      }
    }
    return { plan: planComposition(bp, { seed, customGenres }), source: 'On-device engine' };
  };

  const compose = async (bp: Blueprint, p: CompositionPlan) => {
    let effectiveBlueprint = bp;
    let generatedAuthor: string | undefined;
    if (activeLyricsMode(session) === 'generate') {
      if (!lyricsRoute || lyricsRoute.internal)
        throw new Error('Configure a lyrics model or choose placeholder lyrics.');
      if (!session.draft.lyricsTheme.trim()) throw new Error('Describe the lyrics you want to generate.');
      setBusy('Writing lyrics…');
      const guide = composeSong({ ...bp, seed }, p, { seed, customGenres, customInstruments });
      const result = await aiLyrics(
        guide,
        guide.sections.map((s) => ({
          sectionId: s.id,
          name: s.name,
          kind: s.kind,
          lines: Math.max(2, Math.min(8, Math.ceil(s.bars / 2))),
        })),
        { providerChoice: session.lyricsProvider, theme: session.draft.lyricsTheme, seed },
      );
      const text = result.sections
        .map((s, i) => `[${guide.sections[i].kind}]\n${s.lines.join('\n')}`)
        .join('\n\n');
      if (!result.sections.some((s) => s.lines.length))
        throw new Error('The lyrics model returned no lyrics. Try again or select placeholder lyrics.');
      effectiveBlueprint = {
        ...bp,
        lyrics: { ...parseLyricSheet(text), lock: true },
        vocal: bp.vocal ?? { voiceType: 'tenor', mode: 'ai-singer' },
      };
      generatedAuthor = result.provenance.providerId;
    }
    setBusy('Preparing supplied tracks…');
    const prepared = [];
    for (const input of inputs) prepared.push(await interpretInput(input, seed));
    const generated = composeSong({ ...effectiveBlueprint, seed }, p, {
      seed,
      customGenres,
      customInstruments,
    });
    if (generatedAuthor) generated.lyrics = generated.lyrics.map((l) => ({ ...l, author: generatedAuthor }));
    let composed = mergeComposeInputs(generated, prepared);
    if (prepared.some((i) => i.item.song?.tracks.some((t) => t.audioMidi && t.notes.length))) {
      // Write the new parts with the supplied recording's notes available as musical context.
      composed = regenerateUnlocked(composed, {
        seed,
        customGenres,
        customInstruments,
        trackIds: generated.tracks.map((t) => t.id),
      }).song;
    }
    const song =
      composed.title && composed.title !== 'Untitled'
        ? composed
        : { ...composed, title: workingTitle(composed, allGenres) };
    if (target === 'replace' && project) {
      if (useStudio.getState().project?.meta.id !== project.meta.id)
        throw new Error(
          'The active project changed. Return to the intended project before replacing its song.',
        );
      st.commit({ ...song, id: project.song.id }, `Composed “${song.title}” (seed ${seed})`, 'generate');
    } else {
      const created = await st.newProject(song.title, song);
      st.commit(created.song, `Composed “${song.title}” (seed ${seed})`, 'generate');
    }
    await attachLibraryAssets(
      prepared.map((i) => i.item),
      useStudio.getState().project!.meta.id,
    );
    // Up-front lyrics are the user's words: credit them (not an AI) as the lyric writer.
    if (activeLyricsMode(session) === 'provided' && bp.lyrics?.sections.some((s) => s.lines.length))
      st.updateProject((pr) => creditLyricWriter(pr, userName || 'Me'));
    const projectId = useStudio.getState().project!.meta.id;
    st.selectTrack(song.tracks[0]?.id ?? null);
    st.setWorkbenchView('arrangement');
    useComposeSession.getState().set({ step: 'material' });
    st.toast(
      'success',
      `Composed ${song.tracks.length} tracks across ${song.sections.length} sections${song.lyrics.length ? ` · ${song.lyrics.length} lyric lines` : ''}`,
    );
    return projectId;
  };

  /** Primary path: builder → blueprint → plan → MIDI in one go. */
  const generateSong = async (prototype = false) => {
    setBusy('Designing…');
    try {
      const b = await designBlueprint();
      setBlueprint(b.bp);
      setSource(b.source);
      setBusy('Planning…');
      const p = await planFor(b.bp);
      setPlan(p.plan);
      setBusy('Composing MIDI…');
      const projectId = await compose(b.bp, p.plan);
      if (prototype) {
        try {
          const id = queuePrototype(projectId, audioTarget, seed);
          useProduceUi.getState().set({ tab: 'candidates', batchTaskIds: [id] });
          st.setMode('produce');
          st.toast('info', 'MIDI saved. Producing your audio prototype — edit or regenerate it any time.');
        } catch (err) {
          st.toast('error', errText(err));
        }
      }
    } catch (err) {
      if (!aborted(err)) st.toast('error', `Composition failed: ${errText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const fineTune = async () => {
    setBusy('Designing…');
    try {
      const b = await designBlueprint();
      setBlueprint(b.bp);
      setSource(b.source);
      setPlan(null);
      setStep('blueprint');
    } catch (err) {
      if (!aborted(err)) st.toast('error', `Could not build the blueprint: ${errText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  /** With a model: suggest genres, tags, moods and tempo for the pasted lyrics (the words are never sent back changed). */
  const suggestFromLyrics = async () => {
    const draft = useComposeSession.getState().draft;
    const lyrics = draftLyrics(draft);
    if (!lyrics) return;
    setBusy('Listening to your lyrics…');
    try {
      const res = await aiDesignBlueprint(
        'Suggest genres, style/mood tags and a tempo that suit these lyrics.',
        { providerChoice: planner, seed, choices: { lyrics } },
      );
      const bp = res.blueprint;
      const tags = (bp.tags ?? []).map((id) => getTag(id)).filter((t): t is NonNullable<typeof t> => !!t);
      const cur = useComposeSession.getState().draft;
      session.patch({
        genres: cur.genres.length
          ? cur.genres
          : bp.genreBlend.map((g) => ({ genreId: g.genreId, weight: g.weight })),
        moods: [
          ...cur.moods,
          ...tags
            .filter((t) => t.kind === 'mood' && !cur.moods.some((m) => m.tagId === t.id))
            .map((t) => ({ tagId: t.id })),
        ],
        tags: [...new Set([...cur.tags, ...tags.filter((t) => t.kind !== 'mood').map((t) => t.id)])],
        ...(cur.tempo === 'auto' ? { tempo: 'bpm' as const, bpm: bp.tempo } : {}),
      });
      st.toast('success', `Suggestions from ${res.source} added — adjust them on the Sound tab.`);
    } catch (err) {
      if (!aborted(err)) st.toast('warning', `No suggestions: ${errText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const makePlan = async (bp: Blueprint) => {
    setBusy('Planning composition…');
    try {
      const p = await planFor(bp);
      setPlan(p.plan);
      setSource(p.source);
    } finally {
      setBusy(null);
      setStep('plan');
    }
  };

  const generate = async () => {
    if (!blueprint) return;
    setBusy('Composing MIDI…');
    try {
      await compose(blueprint, plan ?? planComposition(blueprint, { seed, customGenres }));
    } catch (err) {
      st.toast('error', `Composition failed: ${errText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const destination = (
    <Field label="Make it as">
      <Select
        aria-label="Destination"
        value={project && project.song.tracks.length > 0 ? target : 'new'}
        disabled={!project || project.song.tracks.length === 0}
        onChange={setTarget}
        options={[
          { value: 'new', label: 'A new song' },
          ...(project && project.song.tracks.length > 0
            ? [{ value: 'replace' as const, label: `A new version of “${project.meta.name}”` }]
            : []),
        ]}
      />
    </Field>
  );

  const advanced = (
    <>
      {destination}
      <Field label="Composition planner">
        <ProviderPicker
          role="composition"
          value={session.planner}
          onChange={(planner) => session.set({ planner })}
        />
      </Field>
      <Field label="Audio version model" hint="Used when you also make an audio version">
        {audioTargets.length > 0 ? (
          <Select
            aria-label="Audio prototype model"
            value={audioTarget}
            onChange={setAudioTarget}
            options={[
              { value: 'auto', label: 'Auto · connected audio models' },
              ...audioTargets.map((t) => ({ value: t.value, label: t.label })),
              ...(audioTarget !== 'auto' && !audioTargets.some((t) => t.value === audioTarget)
                ? [{ value: audioTarget, label: 'Selected model unavailable', disabled: true }]
                : []),
            ]}
          />
        ) : (
          <Button icon="plug" onClick={() => openSettings('providers', 'connect')}>
            Connect an audio model
          </Button>
        )}
      </Field>
    </>
  );

  const readiness = useReadiness(model);
  const { preview } = useShapePreview(customGenres, customInstruments);
  const working = busy ?? (inputLoading ? 'Analyzing inputs…' : null);
  const create = () => {
    if (session.review) void fineTune();
    else void generateSong(prototype && audioTargets.length > 0);
  };
  const lyrics = lyricsActive(session) ? draftLyrics(session.draft) : undefined;
  const sung = lyrics?.sections.filter((s) => s.lines.length).length ?? 0;
  /** Going to Shape with no material means composing from the style settings alone. */
  const goStep = (s: ComposeStep) =>
    useComposeSession
      .getState()
      .set(s === 'shape' && readiness.material === 0 ? { step: s, fromStyle: true } : { step: s });

  const steps: { step: ComposeStep; label: string; num: string; enabled: boolean }[] = [
    { step: 'material', label: 'Material', num: '01', enabled: true },
    { step: 'shape', label: 'Shape', num: '02', enabled: true },
    ...(session.review || step === 'blueprint' || step === 'plan'
      ? [
          { step: 'blueprint' as const, label: 'Blueprint', num: '03', enabled: !!blueprint },
          { step: 'plan' as const, label: 'Plan', num: '04', enabled: !!plan },
        ]
      : []),
  ];
  const order = steps.map((s) => s.step);

  const summary = (
    <aside className="compose-aside col" aria-labelledby="summary-h">
      <div className="panel" data-testid="builder-actions">
        <div className="aside-block">
          <h2 id="summary-h" className="aside-title">
            Your song so far
          </h2>
          <span className="aside-song">
            {session.draft.title.trim() ||
              (preview?.title && preview.title !== 'Untitled' ? preview.title : 'New song')}
          </span>
          {preview && (
            <div className="aside-ribbon" aria-hidden="true">
              {preview.structure
                .filter((s) => s.bars > 0)
                .map((s, i) => (
                  <span
                    key={i}
                    style={{ flexGrow: s.bars, background: sectionColor(s.kind) }}
                    title={s.name}
                  />
                ))}
            </div>
          )}
          {preview && (
            <div className="cb-summary small" data-testid="builder-summary">
              <span>
                <strong>{preview.instrumentation.length}</strong> tracks
              </span>
              <span>{preview.tempo} BPM</span>
              <span>{keyName(preview.key)}</span>
              <span>
                {preview.meter.numerator}/{preview.meter.denominator}
              </span>
              <span>≈{formatDuration(preview)}</span>
              {preview.tags?.length ? (
                <span>{preview.tags.length === 1 ? '1 tag' : `${preview.tags.length} tags`}</span>
              ) : null}
              {sung > 0 && <span>{sung} sung sections</span>}
            </div>
          )}
          {preview && preview.instrumentation.length > 0 && (
            <div
              className="small muted ellipsis-2"
              title={preview.instrumentation.map((t) => t.name).join(', ')}
            >
              {preview.instrumentation.map((t) => t.name).join(' · ')}
            </div>
          )}
        </div>
        <div className="aside-block col" style={{ gap: 12 }}>
          <BasicsMeter basics={readiness.basics} />
          <ReadinessLines
            material={readiness.material}
            basics={readiness.basics}
            fromStyle={readiness.fromStyle}
          />
          <Button
            variant="primary"
            size="lg"
            className="cta"
            icon="sparkles"
            disabled={!readiness.ready || !!working}
            onClick={create}
          >
            {working ?? (session.review ? 'Review the blueprint' : 'Create song')}
          </Button>
          {!readiness.ready && <span className="small muted">{readiness.blocked}</span>}
          {audioTargets.length > 0 && !session.review && (
            <label className="row small" style={{ gap: 8, minHeight: 32 }}>
              <input type="checkbox" checked={prototype} onChange={(e) => setPrototype(e.target.checked)} />
              Also make an audio version
              <span className="dim">· provider charges may apply</span>
            </label>
          )}
          <span className="small dim">
            {model
              ? `With ${route?.providerName}${session.draft.describe.trim() ? ' (your words + choices)' : ''}`
              : 'On-device engine · works offline'}
          </span>
          <Button
            variant="ghost"
            icon="chevronRight"
            className="back-btn"
            onClick={() => setStep('material')}
          >
            Back to material
          </Button>
        </div>
      </div>
    </aside>
  );

  return (
    <div className="area-page compose-page" data-testid="compose-builder">
      <header className="page-band measure-grid">
        <svg className="band-art" width="420" height="210" viewBox="0 0 420 210" aria-hidden="true">
          <path d="M60 70 L300 14 L384 176 L140 216 Z" />
          <path d="M96 92 L330 58 L356 204 L122 236 Z" />
          <path d="M140 120 L380 120 L380 230 L140 230 Z" className="lit" />
        </svg>
        <nav aria-label="Breadcrumb" className="crumbs">
          <button type="button" className="crumb" onClick={() => st.setMode('home')}>
            Songs
          </button>
          <span aria-hidden="true">/</span>
          <span className="crumb-current">New song</span>
        </nav>
        <div className="row wrap" style={{ gap: '14px 32px', alignItems: 'flex-end' }}>
          <h1>
            {step === 'material'
              ? 'Start a song'
              : step === 'shape'
                ? 'Shape the song'
                : 'Review before composing'}
          </h1>
          <nav className="steps" aria-label="New song steps">
            {steps.map((s) => (
              <button
                key={s.step}
                type="button"
                className={`step ${order.indexOf(s.step) < order.indexOf(step) ? 'done' : ''}`}
                aria-current={step === s.step ? 'step' : undefined}
                disabled={!s.enabled}
                onClick={() => goStep(s.step)}
              >
                <span className="num" aria-hidden="true">
                  {s.num}
                </span>
                {s.label}
              </button>
            ))}
          </nav>
        </div>
        {(step === 'material' || step === 'shape') && (
          <div className="row wrap" style={{ gap: '10px 20px' }}>
            <SongTypeSwitch />
            {step === 'material' && (
              <p className="lede">
                Bring what you have, or skip straight to style settings. Next, shape the style, instruments
                and feel.
              </p>
            )}
          </div>
        )}
        {step === 'shape' && (
          <nav className="section-index" aria-label="Sections">
            {SHAPE_SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="chip">
                <span className="mono">{s.n}</span> {s.label}
              </a>
            ))}
          </nav>
        )}
      </header>

      <div className="area-body compose-body">
        {step === 'material' && (
          <>
            <div className="compose-main">
              <MaterialSection
                model={model}
                route={route}
                lyricsRoute={lyricsRoute}
                busy={busy}
                disabled={!!busy || inputLoading}
                onLoadingChange={setInputLoading}
                onSuggestFromLyrics={() => void suggestFromLyrics()}
                onGenerate={create}
              />
            </div>
            <MaterialAside
              model={model}
              customGenres={customGenres}
              busy={working}
              onNext={() => goStep('shape')}
              onCreate={() => void generateSong()}
            />
          </>
        )}

        {step === 'shape' && (
          <>
            <fieldset className="compose-main" disabled={!!busy || inputLoading}>
              <ShapeSections
                customGenres={customGenres}
                customInstruments={customInstruments}
                advanced={advanced}
              />
            </fieldset>
            {summary}
          </>
        )}

        {step === 'blueprint' && blueprint && (
          <div className="compose-wide">
            <div className="row wrap" style={{ marginBottom: 10 }}>
              <Badge tone="ai">
                <Icon name="sparkles" size={11} /> {source || 'On-device engine'}
              </Badge>
              <span className="muted small">
                {blueprint.title} · {blueprint.tempo} BPM · {blueprint.meter.numerator}/
                {blueprint.meter.denominator} · {keyName(blueprint.key)}
              </span>
              <div className="spacer" />
              <Button onClick={() => setStep('shape')}>Back</Button>
              <Button
                variant="primary"
                icon="layers"
                disabled={!!busy || inputLoading}
                onClick={() => void makePlan(blueprint)}
              >
                {busy ?? 'Plan composition'}
              </Button>
            </div>
            <BlueprintEditor
              blueprint={blueprint}
              onChange={(b) => {
                setBlueprint(b);
                setPlan(null);
              }}
              genres={allGenres}
            />
          </div>
        )}

        {step === 'plan' && blueprint && plan && (
          <div className="compose-wide">
            <div className="row wrap" style={{ marginBottom: 10 }}>
              <Badge tone="ai">
                <Icon name="sparkles" size={11} /> Plan by {source || 'On-device engine'}
              </Badge>
              <span className="muted small">
                Every part is written from this plan. Edit harmony, energy or purpose before generating.
              </span>
              <div className="spacer" />
              <Button onClick={() => setStep('blueprint')}>Back</Button>
              <Button
                icon="rebuild"
                disabled={!!busy || inputLoading}
                onClick={() => void makePlan(blueprint)}
              >
                Re-plan
              </Button>
            </div>
            <PlanTable plan={plan} onChange={setPlan} />
            <div className="panel" style={{ marginTop: 14 }}>
              <div className="panel-body row wrap">
                {destination}
                <div className="spacer" />
                <span className="muted small">Seed {seed}</span>
                <Button
                  variant="primary"
                  size="lg"
                  icon="midi"
                  disabled={!!busy || inputLoading}
                  onClick={() => void generate()}
                >
                  {busy ?? 'Generate MIDI composition'}
                </Button>
              </div>
            </div>
          </div>
        )}
        {(step === 'blueprint' && !blueprint) || (step === 'plan' && (!blueprint || !plan)) ? (
          <div className="compose-wide">
            <Button onClick={() => setStep('shape')}>Back to Shape</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
