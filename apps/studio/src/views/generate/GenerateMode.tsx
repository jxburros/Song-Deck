import { useMemo, useRef, useState } from 'react';
import {
  generateAsset,
  getInstrument,
  keyName,
  parseAssetPrompt,
  randomId,
  randomSeed,
  sectionLayout,
  type AssetRequest,
  type GenerationRecord,
  type Proposal,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useCustomGenres, useCustomInstruments } from '../../hooks';
import { Badge, Button, Field, Spinner, TextArea } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { useStopPreviewOnUnmount } from '../../engine/capture-playback';
import { COMPOSER_PROVIDER, makeProvenance, type InsertRequest } from '../../engine/capture-song';
import { AssetRequestForm, sectionChords } from './AssetRequestForm';
import { AlternativeCard, type Alternative } from './AlternativeCard';
import { InsertDialog } from './InsertDialog';
import { useGenerateSession } from './session';

/** The spec's own examples (§25 "Generate MIDI"). */
const EXAMPLES = [
  'Create a melancholy 16-bar cello melody in D minor.',
  'Make a pop-punk drum pattern at 176 BPM.',
  'Generate four alternative bass lines for this progression.',
];

const LABELS = 'ABCDEFGH';

export default function GenerateMode() {
  const project = useStudio((s) => s.project);
  const song = project?.song ?? null;
  const st = useStudio.getState();
  const customInstruments = useCustomInstruments();
  const customGenres = useCustomGenres();
  const session = useGenerateSession();
  const { prompt, parsedPrompt, request, seed, alternatives, note } = session;
  const setPrompt = (v: string) => session.set({ prompt: v });
  const setRequest = (v: AssetRequest) => session.set({ request: v });
  const setSeed = (v: number) => session.set({ seed: v });
  const [busy, setBusy] = useState(false);
  const [inserting, setInserting] = useState<Alternative | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  useStopPreviewOnUnmount();

  const interpret = (text: string): AssetRequest => {
    const req = parseAssetPrompt(text);
    let info: string | null = null;
    // "…for this progression" → the open project's chords (spec §25 example 3).
    if (/\bthis (progression|chords?|song|section)\b/i.test(text)) {
      if (song) {
        const spans = sectionLayout(song).filter((s) => sectionChords(song, s.section.id).length);
        const span = spans.find((s) => s.section.kind === 'chorus') ?? spans[0];
        if (span && !req.progression?.length) {
          req.progression = sectionChords(song, span.section.id);
          req.bars = span.endBar - span.startBar;
          req.key = song.keyMap.filter((k) => k.bar <= span.startBar).slice(-1)[0]?.key ?? req.key;
          req.tempo = Math.round(song.tempoMap[0]?.bpm ?? req.tempo);
          req.meter = {
            numerator: song.meterMap[0]?.numerator ?? 4,
            denominator: song.meterMap[0]?.denominator ?? 4,
          };
          info = `Using the chords of “${span.section.name}” (${req.progression.join(' ')}) from the open project.`;
        }
      } else
        info =
          'No project is open, so the generator chooses a progression — open a project to generate over its chords.';
    }
    session.set({ note: info });
    return req;
  };

  const generate = (req: AssetRequest, baseSeed: number) => {
    setBusy(true);
    // Let the busy state paint before the (synchronous, deterministic) generators run.
    setTimeout(() => {
      try {
        const count = Math.max(1, Math.min(8, Math.round(req.count || 1)));
        const alts: Alternative[] = [];
        for (let i = 0; i < count; i++) {
          const s = baseSeed + i;
          const res = generateAsset({ ...req, seed: s }, s, { customGenres, customInstruments });
          alts.push({
            id: randomId('alt'),
            label: LABELS[i] ?? String(i + 1),
            seed: s,
            song: res.song,
            trackId: res.trackId,
            request: req,
          });
        }
        useGenerateSession.getState().set({ alternatives: alts });
        requestAnimationFrame(() =>
          resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        );
      } catch (err) {
        st.toast('error', `Generation failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    }, 10);
  };

  const onGenerate = () => {
    const text = prompt.trim() || EXAMPLES[0];
    let req = request;
    if (!req || parsedPrompt !== text) {
      req = interpret(text);
      session.set({ request: req, parsedPrompt: text, ...(prompt.trim() ? {} : { prompt: text }) });
    }
    generate(req, seed);
  };

  const stale =
    request !== null && parsedPrompt !== null && prompt.trim() !== '' && prompt.trim() !== parsedPrompt;

  const recordGeneration = (alt: Alternative, proposal?: Proposal) => {
    const rec: GenerationRecord = {
      id: randomId('gen'),
      kind: 'generate-midi',
      createdAt: new Date().toISOString(),
      providerId: COMPOSER_PROVIDER.id,
      seed: alt.seed,
      instruction: alt.request.description,
      status: 'succeeded',
      proposalId: proposal?.id,
      details: { request: alt.request, alternative: alt.label },
    };
    useStudio.getState().updateProject((p) => ({ ...p, generations: [...p.generations, rec] }));
  };

  const openAsProject = async (alt: Alternative) => {
    const inst = getInstrument(alt.request.instrumentId, customInstruments);
    const fn =
      alt.request.function ?? (inst.isDrumKit ? 'pattern' : alt.request.role === 'bass' ? 'line' : 'part');
    const what = fn === 'bass-line' ? 'line' : fn === 'rhythm' ? 'pattern' : fn;
    const title = inst.isDrumKit
      ? `${inst.name} ${what} — ${alt.request.tempo} BPM`
      : `${inst.name} ${what} — ${keyName(alt.request.key)}`;
    try {
      const created = await st.newProject(title, alt.song);
      st.commit(
        created.song,
        `Generated ${inst.name.toLowerCase()} (alternative ${alt.label}, seed ${alt.seed})`,
        'generate',
      );
      const track = created.song.tracks.find((t) => t.id === alt.trackId) ?? created.song.tracks[0];
      recordGeneration(alt);
      st.addProvenance(
        makeProvenance({
          artifactId: track?.id ?? created.song.id,
          artifactName: `${slugName(track?.name ?? inst.name)}.mid`,
          artifactKind: 'midi',
          sources: [{ kind: 'prompt', ref: alt.request.description }],
          provider: COMPOSER_PROVIDER,
          seed: alt.seed,
          parameters: { request: alt.request, alternative: alt.label },
        }),
      );
      if (track) st.selectTrack(track.id);
      st.setWorkbenchView('piano-roll');
      st.toast('success', `Opened alternative ${alt.label} as “${title}”`);
    } catch (err) {
      st.toast('error', `Could not create the project: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onInsert = (alt: Alternative) => {
    if (!project) {
      void openAsProject(alt);
      return;
    }
    setInserting(alt);
  };

  const insertingTrack = inserting
    ? (inserting.song.tracks.find((t) => t.id === inserting.trackId) ?? inserting.song.tracks[0])
    : null;
  const insertingInst = inserting
    ? getInstrument(insertingTrack?.instrumentId ?? inserting.request.instrumentId, customInstruments)
    : null;

  const summary = useMemo(() => {
    if (!request) return null;
    const inst = getInstrument(request.instrumentId, customInstruments);
    return `${request.count} × ${request.bars}-bar ${inst.name.toLowerCase()} ${request.function ?? request.role} · ${keyName(request.key)} · ${request.tempo} BPM · ${request.meter.numerator}/${request.meter.denominator}${request.moods.length ? ` · ${request.moods.join(', ')}` : ''}`;
  }, [request, customInstruments]);

  return (
    <div className="mode-page" data-testid="generate-mode">
      <div className="page-header">
        <div className="grow">
          <h1>Generate MIDI</h1>
          <div className="lede">
            Create individual musical assets — a melody, a drum pattern, a bass line — as editable MIDI with a{' '}
            <strong>notation preview</strong> and an <strong>audio preview</strong>. Every alternative is
            reproducible from its seed; nothing enters a project until you accept it.
          </div>
        </div>
        {project && (
          <Badge tone="accent" title="Insert targets this project">
            <Icon name="folder" size={11} /> {project.meta.name}
          </Badge>
        )}
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-body col">
          <Field label="Describe the part">
            <TextArea
              value={prompt}
              onChange={setPrompt}
              rows={2}
              placeholder={EXAMPLES[0]}
              aria-label="Asset prompt"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onGenerate();
              }}
            />
          </Field>
          <div className="chip-list">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="chip" onClick={() => setPrompt(ex)}>
                {ex}
              </button>
            ))}
          </div>
          <div className="row wrap">
            <Button
              variant="primary"
              size="lg"
              icon="sparkles"
              onClick={onGenerate}
              disabled={busy}
              data-testid="generate-run"
            >
              {busy ? 'Generating…' : stale || !request ? 'Generate' : 'Regenerate'}
            </Button>
            {busy && <Spinner />}
            <span className="small dim">Ctrl/⌘+Enter · on-device composer · works offline</span>
            <div className="spacer" />
            {summary && <span className="small muted">{summary}</span>}
          </div>
          {note && <div className="callout small">{note}</div>}
        </div>
      </div>

      {request && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-header">
            <Icon name="sliders" />
            <h3 className="grow">Asset request</h3>
            {stale && (
              <span className="small" style={{ color: 'var(--warning)' }}>
                The prompt changed — Generate re-reads it.
              </span>
            )}
            <Button size="sm" icon="dice" onClick={() => setSeed(randomSeed())} title="New seed">
              New seed
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon="midi"
              disabled={busy}
              onClick={() => generate(request, seed)}
            >
              Generate {request.count} alternative{request.count === 1 ? '' : 's'}
            </Button>
          </div>
          <div className="panel-body">
            <AssetRequestForm
              request={request}
              onChange={setRequest}
              seed={seed}
              onSeed={setSeed}
              song={song}
            />
          </div>
        </div>
      )}

      <div ref={resultsRef}>
        {alternatives.length > 0 && (
          <>
            <div className="section-title">
              <h3>Alternatives</h3>
              <span className="small muted">
                {alternatives.length} result{alternatives.length === 1 ? '' : 's'} · seeds{' '}
                {alternatives[0].seed}–{alternatives[alternatives.length - 1].seed}
              </span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(520px, 1fr))',
                gap: 12,
              }}
            >
              {alternatives.map((alt) => (
                <AlternativeCard
                  key={alt.id}
                  alt={alt}
                  hasProject={!!project}
                  onInsert={onInsert}
                  onOpen={(a) => void openAsProject(a)}
                />
              ))}
            </div>
          </>
        )}
        {!alternatives.length && !request && (
          <div className="card muted small">
            Try one of the examples above. The request is parsed into instrument, role, bars, key, tempo,
            meter, moods, genres and how many alternatives you want — all editable before generating.
          </div>
        )}
      </div>

      {inserting && project && insertingTrack && insertingInst && (
        <InsertDialog
          title={`Insert alternative ${inserting.label} into “${project.meta.name}”`}
          song={project.song}
          material={{
            notes: insertingTrack.notes,
            bars: inserting.song.sections.reduce((a, s) => a + s.bars, 0) || inserting.request.bars,
            ppq: inserting.song.ppq,
            meter: inserting.song.meterMap[0] ?? inserting.request.meter,
            key: inserting.song.keyMap[0]?.key ?? inserting.request.key,
            instrumentId: insertingInst.id,
            role: insertingTrack.role,
            fn: insertingTrack.constraints.function ?? inserting.request.function,
            trackName: insertingTrack.name,
            drums: !!insertingInst.isDrumKit,
          }}
          source="internal"
          instruction={inserting.request.description}
          explanation={`Generated on-device (seed ${inserting.seed}, alternative ${inserting.label}).`}
          proposalTitle={(req: InsertRequest) =>
            req.mode === 'replace'
              ? `Replace bars ${req.targetBar}–${req.endBar} with alternative ${inserting.label}`
              : `Add generated ${insertingInst.name.toLowerCase()} (alt. ${inserting.label})`
          }
          onClose={() => setInserting(null)}
          onProposed={(p) => {
            recordGeneration(inserting, p);
            st.toast('success', 'Proposal created — review it in the piano roll and accept or reject.');
          }}
        />
      )}
    </div>
  );
}

function slugName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'part'
  );
}
