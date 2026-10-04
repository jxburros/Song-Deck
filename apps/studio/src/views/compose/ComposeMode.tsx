import { useState } from 'react';
import {
  BUILTIN_GENRES,
  blueprintFromChoices,
  composeSong,
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
import { Badge, Button, Field, Select, TextArea } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { BlueprintEditor } from './BlueprintEditor';
import { PlanTable } from './PlanTable';
import { Builder } from './Builder';
import { choicesForStart, draftLyrics, useComposeSession } from './session';
import { aiDesignBlueprint, aiPlanSong, aiLyrics, useRoleRoute } from '../../engine/ai';
import { attachLibraryAssets } from '../../state/library';
import { InputsPanel } from './InputsPanel';
import { interpretInput, mergeComposeInputs, useComposeInputs } from './inputs';
import { ProviderPicker } from '../shared/ProviderPicker';
import './compose.css';

type Step = 'build' | 'blueprint' | 'plan';

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
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [plan, setPlan] = useState<CompositionPlan | null>(null);
  const [step, setStep] = useState<Step>('build');
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
    const choices = choicesForStart(draft, session.lyricsMode, inputs.find((i) => i.item.song)?.item.song);
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
        return { bp: res.blueprint, source: res.source };
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
    if (session.lyricsMode === 'generate') {
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
    const composed = mergeComposeInputs(generated, prepared);
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
    if (session.lyricsMode === 'provided' && bp.lyrics?.sections.some((s) => s.lines.length))
      st.updateProject((pr) => creditLyricWriter(pr, userName || 'Me'));
    st.selectTrack(song.tracks[0]?.id ?? null);
    st.setWorkbenchView('arrangement');
    st.toast(
      'success',
      `Composed ${song.tracks.length} tracks across ${song.sections.length} sections${song.lyrics.length ? ` · ${song.lyrics.length} lyric lines` : ''}`,
    );
  };

  /** Primary path: builder → blueprint → plan → MIDI in one go. */
  const generateSong = async () => {
    setBusy('Designing…');
    try {
      const b = await designBlueprint();
      setBlueprint(b.bp);
      setSource(b.source);
      setBusy('Planning…');
      const p = await planFor(b.bp);
      setPlan(p.plan);
      setBusy('Composing MIDI…');
      await compose(b.bp, p.plan);
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

  const destination = project && project.song.tracks.length > 0 && (
    <Field label="Destination">
      <Select
        value={target}
        onChange={setTarget}
        options={[
          { value: 'new', label: 'New project' },
          { value: 'replace', label: `Replace “${project.meta.name}” song (new revision)` },
        ]}
      />
    </Field>
  );

  return (
    <div className="mode-page">
      <div className="mode-page narrow cb-page" style={{ padding: 0 }}>
        <div className="page-header cb-header">
          <div className="grow">
            <h1>Compose</h1>
            <div className="lede">
              Start a song with any combination of a prompt, recordings, MIDI, lyrics, or the composer table.
              Supplied material is preserved by default.
              {model
                ? ' A language model is attached: you can also describe the song in your own words.'
                : ''}
            </div>
          </div>
          <div className="row cb-steps">
            {(['build', 'blueprint', 'plan'] as Step[]).map((s, i) => (
              <Button
                key={s}
                size="sm"
                active={step === s}
                disabled={(s === 'blueprint' && !blueprint) || (s === 'plan' && !plan)}
                onClick={() => setStep(s)}
              >
                {i + 1}. {s === 'build' ? 'Build' : s === 'blueprint' ? 'Fine-tune' : 'Plan'}
              </Button>
            ))}
          </div>
        </div>

        {step === 'build' && (
          <>
            {destination && (
              <div className="row" style={{ marginBottom: 10 }}>
                {destination}
              </div>
            )}
            <InputsPanel disabled={!!busy || inputLoading} onLoadingChange={setInputLoading} />
            <section className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-header">
                <h3>Lyrics</h3>
              </div>
              <div className="panel-body col">
                <Select
                  aria-label="Lyrics starting point"
                  value={session.lyricsMode}
                  disabled={!!busy || inputLoading}
                  onChange={(lyricsMode) => {
                    session.set({ lyricsMode });
                    if (lyricsMode === 'instrumental') session.patch({ vocal: 'none' });
                    else if (lyricsMode === 'placeholder')
                      session.patch({ vocal: 'tenor', vocalMode: 'placeholder' });
                    else session.patch({ vocal: 'auto', vocalMode: 'default' });
                  }}
                  options={[
                    { value: 'provided', label: 'Use my lyrics (Lyrics tab below)' },
                    { value: 'generate', label: 'Generate lyrics from a prompt' },
                    { value: 'placeholder', label: 'Placeholder lyrics' },
                    { value: 'instrumental', label: 'Instrumental' },
                  ]}
                />
                {session.lyricsMode === 'generate' && (
                  <>
                    <Field label="Lyrics model">
                      <ProviderPicker
                        role="lyrics"
                        value={session.lyricsProvider}
                        onChange={(lyricsProvider) => session.set({ lyricsProvider })}
                      />
                    </Field>
                    <TextArea
                      aria-label="Lyrics prompt"
                      value={session.draft.lyricsTheme}
                      onChange={(lyricsTheme) => session.patch({ lyricsTheme })}
                      placeholder="What should the lyrics be about?"
                    />
                    {(!lyricsRoute || lyricsRoute.internal) && (
                      <p className="small muted">
                        Connect a lyrics model in Settings, or choose placeholder lyrics.
                      </p>
                    )}
                  </>
                )}
              </div>
            </section>
            <div className="row wrap" style={{ marginBottom: 12 }}>
              <Button
                disabled={!!busy || inputLoading}
                onClick={() =>
                  void (async () => {
                    setBusy('Preparing composer table…');
                    try {
                      const b = await designBlueprint();
                      setBlueprint(b.bp);
                      const result = await planFor(b.bp);
                      setPlan(result.plan);
                      setSource(result.source);
                      setStep('plan');
                    } catch (e) {
                      st.toast('error', errText(e));
                    } finally {
                      setBusy(null);
                    }
                  })()
                }
              >
                Start with composer table
              </Button>
            </div>
            <fieldset
              disabled={!!busy || inputLoading}
              style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
            >
              <Builder
                route={route}
                busy={busy ?? (inputLoading ? 'Analyzing inputs…' : null)}
                onGenerate={() => void generateSong()}
                onFineTune={() => void fineTune()}
                customGenres={customGenres}
                customInstruments={customInstruments}
                onSuggestFromLyrics={() => void suggestFromLyrics()}
              />
            </fieldset>
          </>
        )}

        {step === 'blueprint' && blueprint && (
          <>
            <div className="row wrap" style={{ marginBottom: 10 }}>
              <Badge tone="ai">
                <Icon name="sparkles" size={11} /> {source || 'On-device engine'}
              </Badge>
              <span className="muted small">
                {blueprint.title} · {blueprint.tempo} BPM · {blueprint.meter.numerator}/
                {blueprint.meter.denominator} · {keyName(blueprint.key)}
              </span>
              <div className="spacer" />
              <Button onClick={() => setStep('build')}>Back</Button>
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
          </>
        )}

        {step === 'plan' && blueprint && plan && (
          <>
            <div className="row wrap" style={{ marginBottom: 10 }}>
              <Badge tone="ai">
                <Icon name="sparkles" size={11} /> Plan by {source || 'On-device engine'}
              </Badge>
              <span className="muted small">
                All MIDI generators consume this same plan (spec §15). Edit harmony, energy or purpose before
                generating.
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
          </>
        )}
      </div>
    </div>
  );
}
