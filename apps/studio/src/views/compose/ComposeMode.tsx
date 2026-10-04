import { useState } from 'react';
import {
  BUILTIN_GENRES,
  blueprintFromChoices,
  composeSong,
  creditLyricWriter,
  getTag,
  keyName,
  planComposition,
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
import { BlueprintEditor } from './BlueprintEditor';
import { PlanTable } from './PlanTable';
import { Builder } from './Builder';
import { choicesFromDraft, draftLyrics, useComposeSession } from './session';
import { aiDesignBlueprint, aiPlanSong, useRoleRoute } from '../../engine/ai';
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
  const [source, setSource] = useState<string>('');
  const [target, setTarget] = useState<'new' | 'replace'>('new');
  const route = useRoleRoute('composition', planner);
  const model = Boolean(route && !route.internal);
  const allGenres = [...BUILTIN_GENRES, ...customGenres];
  const custom = { customGenres, customInstruments };

  /** Builder → blueprint: on-device, or with the model when the user also described the song in words. */
  const designBlueprint = async (): Promise<{ bp: Blueprint; source: string }> => {
    const draft = useComposeSession.getState().draft;
    const choices = choicesFromDraft(draft, draftLyrics(draft));
    const words = draft.describe.trim();
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
    const composed = composeSong({ ...bp, seed }, p, { seed, customGenres, customInstruments });
    const song =
      composed.title && composed.title !== 'Untitled'
        ? composed
        : { ...composed, title: workingTitle(composed, allGenres) };
    if (target === 'replace' && project) {
      st.commit({ ...song, id: project.song.id }, `Composed “${song.title}” (seed ${seed})`, 'generate');
    } else {
      const created = await st.newProject(song.title, song);
      st.commit(created.song, `Composed “${song.title}” (seed ${seed})`, 'generate');
    }
    // Up-front lyrics are the user's words: credit them (not an AI) as the lyric writer.
    if (bp.lyrics?.sections.some((s) => s.lines.length))
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
              Pick the <strong>instruments</strong>, <strong>genres</strong>, <strong>moods</strong> and
              settings — or start from your <strong>lyrics</strong>. You get the composition first, as MIDI
              you can edit.
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
            <Builder
              route={route}
              busy={busy}
              onGenerate={() => void generateSong()}
              onFineTune={() => void fineTune()}
              customGenres={customGenres}
              customInstruments={customInstruments}
              onSuggestFromLyrics={() => void suggestFromLyrics()}
            />
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
                disabled={!!busy}
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
              <Button icon="rebuild" disabled={!!busy} onClick={() => void makePlan(blueprint)}>
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
                  disabled={!!busy}
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
