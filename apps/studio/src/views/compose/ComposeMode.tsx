import { useMemo, useState } from 'react';
import {
  BUILTIN_GENRES,
  composeSong,
  keyName,
  parsePromptToBlueprint,
  planComposition,
  randomSeed,
  type Blueprint,
  type CompositionPlan,
  type GenreProfile,
  type Song,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useCustomGenres, useCustomInstruments } from '../../hooks';
import { Badge, Button, Field, NumberInput, Select, TextArea } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { BlueprintEditor } from './BlueprintEditor';
import { PlanTable } from './PlanTable';
import { ProviderPicker } from '../shared/ProviderPicker';
import { aiDesignBlueprint, aiPlanSong } from '../../engine/ai';

const EXAMPLES = [
  'Make a fast alternative rock song with a melancholy verse and huge cathartic chorus. Drums, bass, two guitars, piano and violin. Male tenor vocal.',
  'Emo pop-punk at 164 BPM in E minor: melancholy verses, cathartic chorus, defiant ending. Lead vocal, drums, bass, rhythm guitars L and R, lead guitar, violin, piano.',
  'Dreamy synth-pop in D major, 108 BPM, female vocal, warm pads, arpeggios and a punchy electronic kit.',
  'Slow cinematic orchestral piece in C minor with strings, brass, piano and timpani that builds to an epic finale. Instrumental.',
  'Laid-back hip-hop beat at 88 BPM with jazzy electric piano, upright bass and swung drums.',
  '50% folk 30% country 20% indie rock, acoustic guitar, upright bass, light drums, fiddle, baritone vocal.',
];

type Step = 'intent' | 'blueprint' | 'plan';

/** A descriptive working title ("Pop-Punk in E minor") for songs whose prompt named none. */
function workingTitle(song: Song, genres: GenreProfile[]): string {
  const main = [...song.genreBlend].sort((a, b) => b.weight - a.weight)[0];
  const genre = main ? genres.find((g) => g.id === main.genreId)?.name : undefined;
  const key = song.keyMap[0] ? keyName(song.keyMap[0].key) : '';
  return [genre ?? 'Song', key && `in ${key}`].filter(Boolean).join(' ');
}

export default function ComposeMode() {
  const project = useStudio((s) => s.project);
  const st = useStudio.getState();
  const customGenres = useCustomGenres();
  const customInstruments = useCustomInstruments();
  const [prompt, setPrompt] = useState('');
  const [seed, setSeed] = useState(() => randomSeed());
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [plan, setPlan] = useState<CompositionPlan | null>(null);
  const [step, setStep] = useState<Step>('intent');
  const [planner, setPlanner] = useState('auto');
  const [busy, setBusy] = useState<string | null>(null);
  const [source, setSource] = useState<string>('');
  const [target, setTarget] = useState<'new' | 'replace'>('new');

  const allGenres = useMemo(() => [...BUILTIN_GENRES, ...customGenres], [customGenres]);

  const draftBlueprint = async () => {
    setBusy('Designing blueprint…');
    try {
      const res = await aiDesignBlueprint(prompt.trim() || EXAMPLES[0], { providerChoice: planner, seed });
      setBlueprint(res.blueprint);
      setSource(res.source);
      setPlan(null);
      setStep('blueprint');
    } catch (err) {
      // Always fall back to the deterministic on-device parser (spec §51: project stays usable).
      const bp = parsePromptToBlueprint(prompt.trim() || EXAMPLES[0], { seed, customGenres });
      setBlueprint(bp);
      setSource('On-device engine');
      setStep('blueprint');
      if (!(err instanceof Error && err.name === 'AbortError')) st.toast('warning', `AI planner unavailable — used the on-device engine. ${err instanceof Error ? err.message : ''}`);
    } finally {
      setBusy(null);
    }
  };

  const makePlan = async (bp: Blueprint) => {
    setBusy('Planning composition…');
    try {
      const res = await aiPlanSong(bp, { providerChoice: planner, seed });
      setPlan(res.plan);
      setSource(res.source);
    } catch (err) {
      setPlan(planComposition(bp, { seed, customGenres }));
      setSource('On-device engine');
      if (!(err instanceof Error && err.name === 'AbortError')) st.toast('warning', `AI planner unavailable — planned on-device. ${err instanceof Error ? err.message : ''}`);
    } finally {
      setBusy(null);
      setStep('plan');
    }
  };

  const generate = async () => {
    if (!blueprint) return;
    setBusy('Composing MIDI…');
    try {
      const p = plan ?? planComposition(blueprint, { seed, customGenres });
      const composed = composeSong({ ...blueprint, seed }, p, { seed, customGenres, customInstruments });
      const song = composed.title && composed.title !== 'Untitled' ? composed : { ...composed, title: workingTitle(composed, allGenres) };
      if (target === 'replace' && project) {
        st.commit({ ...song, id: project.song.id }, `Composed “${song.title}” (seed ${seed})`, 'generate');
      } else {
        const created = await st.newProject(song.title, song);
        st.commit(created.song, `Composed “${song.title}” (seed ${seed})`, 'generate');
      }
      st.selectTrack(song.tracks[0]?.id ?? null);
      st.setWorkbenchView('arrangement');
      st.toast('success', `Composed ${song.tracks.length} tracks across ${song.sections.length} sections`);
    } catch (err) {
      st.toast('error', `Composition failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mode-page">
      <div className="mode-page narrow" style={{ padding: 0 }}>
        <div className="page-header">
          <div className="grow">
            <h1>Compose</h1>
            <div className="lede">
              Creative intent → <strong>Song Blueprint</strong> → <strong>Composition Plan</strong> → <strong>MIDI</strong>. Nothing is rendered yet — you get
              the composition first, fully editable.
            </div>
          </div>
          <div className="row">
            {(['intent', 'blueprint', 'plan'] as Step[]).map((s, i) => (
              <Button key={s} size="sm" active={step === s} disabled={(s === 'blueprint' && !blueprint) || (s === 'plan' && !plan)} onClick={() => setStep(s)}>
                {i + 1}. {s === 'intent' ? 'Intent' : s === 'blueprint' ? 'Blueprint' : 'Plan'}
              </Button>
            ))}
          </div>
        </div>

        {step === 'intent' && (
          <div className="panel">
            <div className="panel-body col">
              <Field label="Describe the song">
                <TextArea
                  value={prompt}
                  onChange={setPrompt}
                  rows={4}
                  placeholder={EXAMPLES[0]}
                  aria-label="Song prompt"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void draftBlueprint();
                  }}
                />
              </Field>
              <div className="chip-list">
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="chip" onClick={() => setPrompt(ex)} title={ex}>
                    {ex.length > 64 ? `${ex.slice(0, 62)}…` : ex}
                  </button>
                ))}
              </div>
              <div className="grid-3">
                <Field label="Composition planner" hint="Auto follows your routing rules; the on-device engine always works offline.">
                  <ProviderPicker role="composition" value={planner} onChange={setPlanner} />
                </Field>
                <Field label="Composition seed" hint="Same blueprint + seed + engine version ⇒ same song.">
                  <div className="row">
                    <NumberInput value={seed} onChange={(v) => setSeed(Math.round(v))} min={0} max={99999999} />
                    <Button icon="dice" title="New seed" onClick={() => setSeed(randomSeed())} />
                  </div>
                </Field>
                <Field label="Genres available">
                  <div className="small muted">{allGenres.length} genre profiles · blendable</div>
                </Field>
              </div>
              <div className="row">
                <Button variant="primary" size="lg" icon="sparkles" onClick={() => void draftBlueprint()} disabled={!!busy}>
                  {busy ?? 'Draft Song Blueprint'}
                </Button>
                <span className="small dim">Ctrl/⌘+Enter</span>
              </div>
            </div>
          </div>
        )}

        {step === 'blueprint' && blueprint && (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <Badge tone="ai">
                <Icon name="sparkles" size={11} /> {source || 'On-device engine'}
              </Badge>
              <span className="muted small">
                {blueprint.title} · {blueprint.tempo} BPM · {blueprint.meter.numerator}/{blueprint.meter.denominator} · {keyName(blueprint.key)}
              </span>
              <div className="spacer" />
              <Button onClick={() => setStep('intent')}>Back</Button>
              <Button variant="primary" icon="layers" disabled={!!busy} onClick={() => void makePlan(blueprint)}>
                {busy ?? 'Plan composition'}
              </Button>
            </div>
            <BlueprintEditor blueprint={blueprint} onChange={(b) => { setBlueprint(b); setPlan(null); }} genres={allGenres} />
          </>
        )}

        {step === 'plan' && blueprint && plan && (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <Badge tone="ai">
                <Icon name="sparkles" size={11} /> Plan by {source || 'On-device engine'}
              </Badge>
              <span className="muted small">All MIDI generators consume this same plan (spec §15). Edit harmony, energy or purpose before generating.</span>
              <div className="spacer" />
              <Button onClick={() => setStep('blueprint')}>Back</Button>
              <Button icon="rebuild" disabled={!!busy} onClick={() => void makePlan(blueprint)}>
                Re-plan
              </Button>
            </div>
            <PlanTable plan={plan} onChange={setPlan} />
            <div className="panel" style={{ marginTop: 14 }}>
              <div className="panel-body row wrap">
                {project && project.song.tracks.length > 0 && (
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
                )}
                <div className="spacer" />
                <span className="muted small">Seed {seed}</span>
                <Button variant="primary" size="lg" icon="midi" disabled={!!busy} onClick={() => void generate()}>
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
