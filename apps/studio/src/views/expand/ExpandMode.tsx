import { useEffect, useRef, useState } from 'react';
import {
  keyName,
  midiToSong,
  parseKey,
  parsePromptToBlueprint,
  randomId,
  randomSeed,
  sectionLayout,
  songToMidi,
  type ExpansionKind,
  type ExpansionRequest,
  type ExpansionResult,
  type Song,
} from '@songdeck/core';
import type { RebuildReport } from '@songdeck/audio';
import { useStudio } from '../../state/store';
import { decodeAudioBytes, guessMime } from '../../state/assets';
import { useCustomGenres, useCustomInstruments } from '../../hooks';
import { jobs } from '../../engine/jobs';
import { previewPlayer, usePreviewId, useStopPreviewOnUnmount } from '../../engine/capture-playback';
import { AUDIO_ACCEPT, baseName, downloadBytes, readFileBytes, slugify } from '../../engine/capture-files';
import { requestAttestation, recordAttestation } from '../../engine/rights';
import { COMPOSER_PROVIDER, makeProvenance, makeAssetMeta } from '../../engine/capture-song';
import { renderAlternative } from '../generate/AlternativeCard';
import { Badge, Button, Field, FileButton, NumberInput, Select, TextInput } from '../../ui/kit';
import { useExpandSession } from './session';
import './expand.css';

const kinds: ExpansionKind[] = [
  'intro',
  'verse',
  'pre-chorus',
  'chorus',
  'hook',
  'post-chorus',
  'bridge',
  'breakdown',
  'build',
  'drop',
  'solo',
  'interlude',
  'final-chorus',
  'outro',
  'custom',
];
const kindOptions = kinds.map((value) => ({
  value,
  label: value.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
}));

export default function ExpandMode() {
  const s = useExpandSession();
  const project = useStudio((st) => st.project);
  const customGenres = useCustomGenres(),
    customInstruments = useCustomInstruments();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const playing = usePreviewId();
  useStopPreviewOnUnmount();
  useEffect(() => () => controller.current?.abort(), []);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const edit = (patch: Parameters<typeof s.set>[0]) => {
    previewPlayer.stop();
    s.set({ ...patch, result: null, resultRequest: null });
    setError('');
  };
  const totalBars = s.source?.sections.reduce((sum, x) => sum + x.bars, 0) ?? 1;

  const importFiles = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setBusy('Reading clip…');
    setError('');
    previewPlayer.stop();
    const abort = new AbortController();
    controller.current = abort;
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error('Choose a clip smaller than 32 MB.');
      const bytes = await readFileBytes(file);
      if (/\.(mid|midi)$/i.test(file.name)) {
        const song = midiToSong(bytes, { title: baseName(file.name) });
        if (!song.tracks.some((t) => t.notes.length)) throw new Error('This MIDI file contains no notes.');
        if (!abort.signal.aborted)
          s.load(song, file.name, 'Check the imported key, tempo and section labels before expanding.');
      } else {
        const audio = await decodeAudioBytes(bytes);
        const seconds = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
        if (seconds < 1 || seconds > 60) throw new Error('Choose an audio clip between 1 and 60 seconds.');
        const attested = await requestAttestation([{ name: file.name, bytes, audio }], {
          context: 'expand',
          purpose: 'Transcribe and expand a short clip into MIDI',
        });
        if (!attested || abort.signal.aborted) return;
        setBusy('Transcribing audio on this device…');
        const result = await jobs.call<{ song: Song; report: RebuildReport }>(
          'rebuild',
          { audio, title: baseName(file.name) },
          { signal: abort.signal },
        );
        if (!result.song.tracks.some((t) => t.notes.length))
          throw new Error('No notes could be transcribed. Try an isolated instrument or import MIDI.');
        if (!abort.signal.aborted) {
          s.load(
            result.song,
            file.name,
            `Audio transcription is approximate (estimated confidence ${Math.round(result.report.overallConfidence * 100)}%). Check notes, tempo, key and bar boundaries in the source preview. Isolated instruments work best.`,
          );
          s.set({
            sourceUpload: {
              bytes,
              mimeType: guessMime(file.name, bytes),
              sampleRate: audio.sampleRate,
              channels: audio.channels.length,
              durationSeconds: seconds,
              attestation: attested[0],
            },
          });
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) fail(e);
    } finally {
      setBusy('');
    }
  };

  const generate = async (newSeed?: number) => {
    if (!s.source) return;
    const key = parseKey(s.keyText);
    if (!key) {
      setError('Enter a key such as D minor or F# major.');
      return;
    }
    const seed = newSeed ?? s.seed;
    setBusy('Developing the arrangement…');
    setError('');
    previewPlayer.stop();
    const abort = new AbortController();
    controller.current = abort;
    try {
      const style = s.style.trim() ? parsePromptToBlueprint(s.style, { seed, customGenres }) : null;
      const request: ExpansionRequest = {
        regions: s.regions,
        arrangement: s.arrangement,
        seed,
        variation: s.variation,
        ...(keyName(key) !== keyName(s.source.keyMap[0].key) ? { key } : {}),
        ...(style ? { genreBlend: style.genreBlend, tags: style.tags } : {}),
      };
      const result = await jobs.call<ExpansionResult>(
        'expand',
        { source: s.source, request, options: { customGenres, customInstruments } },
        { signal: abort.signal },
      );
      if (!abort.signal.aborted) s.set({ result, resultRequest: request, seed });
    } catch (e) {
      if (!abort.signal.aborted) fail(e);
    } finally {
      setBusy('');
    }
  };
  const preview = async (song: Song, id: string) => {
    if (playing === id) {
      previewPlayer.stop();
      return;
    }
    setBusy('Rendering preview…');
    setError('');
    const abort = new AbortController();
    controller.current = abort;
    try {
      const audio = await renderAlternative(song);
      if (!abort.signal.aborted) await previewPlayer.play(id, audio);
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  };
  const open = async () => {
    if (!s.result) return;
    setBusy('Opening project…');
    try {
      const st = useStudio.getState();
      const created = await st.newProject(s.result.song.title, s.result.song);
      st.commit(created.song, `Expanded from ${s.sourceName}`, 'generate');
      if (s.sourceUpload) {
        const upload = s.sourceUpload;
        const provenanceId = randomId('prov');
        const meta = makeAssetMeta({ ...upload, name: s.sourceName, kind: 'reference', provenanceId });
        await st.addAsset(meta, upload.bytes);
        st.addProvenance({
          id: provenanceId,
          artifactId: meta.id,
          artifactName: s.sourceName,
          artifactKind: 'audio',
          sources: [{ kind: 'file', ref: s.sourceName }],
          providerId: 'user-import',
          providerName: 'Imported by the user',
          parameters: { purpose: 'expansion source' },
          generatedAt: new Date().toISOString(),
          cloud: false,
        });
        if (upload.attestation) recordAttestation(upload.attestation, { assetId: meta.id, provenanceId });
      }
      st.addProvenance(
        makeProvenance({
          artifactId: created.song.id,
          artifactName: `${slugify(created.song.title)}.mid`,
          artifactKind: 'midi',
          sources: [{ kind: 'file', ref: s.sourceName }],
          provider: COMPOSER_PROVIDER,
          seed: s.resultRequest?.seed,
          parameters: { request: s.resultRequest, sourceNotice: s.sourceNotice },
        }),
      );
      st.setMode('workbench');
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mode-page expand-page" data-testid="expand-mode">
      <div className="page-header">
        <div>
          <h1>Expand</h1>
          <p className="lede">
            Turn a short idea into an arrangement. Label the parts you have, keep the moments you love, and
            develop what comes next.
          </p>
        </div>
      </div>
      <fieldset disabled={!!busy} className="expand-controls">
        <section className="card stack">
          <h2>1. Start with a clip</h2>
          <div className="row wrap">
            <FileButton accept={`.mid,.midi,${AUDIO_ACCEPT}`} onFile={(files) => void importFiles(files)}>
              Import MIDI or audio
            </FileButton>
            <Button
              disabled={!project?.song.tracks.some((t) => t.kind === 'midi' && t.notes.length)}
              onClick={() => {
                if (project) {
                  previewPlayer.stop();
                  s.load(project.song, project.meta.name);
                  setError('');
                }
              }}
            >
              Use current project
            </Button>
          </div>
          <p className="small muted">
            MIDI retains its imported notes. Audio clips (1–60 seconds) are transcribed locally before
            expansion.
          </p>
          {s.source && (
            <>
              <div className="row wrap">
                <strong>{s.sourceName}</strong>
                <Badge>{totalBars} bars</Badge>
                <Badge>{Math.round(s.source.tempoMap[0]?.bpm ?? 120)} BPM</Badge>
                <Button onClick={() => void preview(s.source!, 'expand-source')}>
                  {playing === 'expand-source' ? 'Stop source' : 'Preview source'}
                </Button>
              </div>
              {s.sourceNotice && <p className="small muted">{s.sourceNotice}</p>}
              <Field label="Key" hint="Correct an uncertain estimate. Original pitches stay unchanged.">
                <TextInput
                  aria-label="Expansion key"
                  value={s.keyText}
                  onChange={(keyText) => edit({ keyText })}
                />
              </Field>
            </>
          )}
        </section>
        {s.source && (
          <>
            <section className="card stack">
              <h2>2. Label your source</h2>
              <p className="small muted">
                Bar numbers are inclusive. Add overlapping labels when a hook sits inside a verse or chorus.
              </p>
              {s.regions.map((r, i) => (
                <div className="expand-row" key={r.id}>
                  <Field label={`Part ${i + 1}`}>
                    <Select
                      aria-label={`Source part ${i + 1}`}
                      value={r.kind}
                      options={kindOptions}
                      onChange={(kind) =>
                        edit({
                          regions: s.regions.map((x) => (x.id === r.id ? { ...x, kind } : x)),
                          arrangement: s.arrangement.map((x) =>
                            x.preserve && x.sourceRegionId === r.id ? { ...x, kind } : x,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field label="From bar">
                    <NumberInput
                      aria-label={`Source ${i + 1} first bar`}
                      value={r.startBar + 1}
                      min={1}
                      max={r.endBar}
                      onChange={(v) =>
                        edit({
                          regions: s.regions.map((x) => (x.id === r.id ? { ...x, startBar: v - 1 } : x)),
                          arrangement: s.arrangement.map((x) =>
                            x.preserve && x.sourceRegionId === r.id ? { ...x, bars: r.endBar - v + 1 } : x,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field label="Through bar">
                    <NumberInput
                      aria-label={`Source ${i + 1} last bar`}
                      value={r.endBar}
                      min={r.startBar + 1}
                      max={totalBars}
                      onChange={(endBar) =>
                        edit({
                          regions: s.regions.map((x) => (x.id === r.id ? { ...x, endBar } : x)),
                          arrangement: s.arrangement.map((x) =>
                            x.preserve && x.sourceRegionId === r.id ? { ...x, bars: endBar - r.startBar } : x,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Button
                    disabled={s.regions.length === 1}
                    aria-label={`Remove source ${i + 1}`}
                    onClick={() =>
                      edit({
                        regions: s.regions.filter((x) => x.id !== r.id),
                        arrangement: s.arrangement.filter((x) => x.sourceRegionId !== r.id),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                onClick={() =>
                  edit({
                    regions: [
                      ...s.regions,
                      { id: randomId('region'), kind: 'hook', startBar: 0, endBar: totalBars },
                    ],
                  })
                }
              >
                Add source label
              </Button>
            </section>
            <section className="card stack">
              <h2>3. Build the expansion</h2>
              <p className="small muted">
                Keep source copies the selected bars, including rests. Develop writes a new section using the
                source as inspiration. Hook is treated as a recurring chorus motif.
              </p>
              {s.arrangement.map((a, i) => (
                <div className="expand-row arrangement-row" key={i}>
                  <Field label={`Section ${i + 1}`}>
                    <Select
                      aria-label={`Section ${i + 1} type`}
                      value={a.kind}
                      options={kindOptions}
                      onChange={(kind) =>
                        edit({ arrangement: s.arrangement.map((x, j) => (j === i ? { ...x, kind } : x)) })
                      }
                    />
                  </Field>
                  <Field label="Source">
                    <Select
                      aria-label={`Section ${i + 1} source`}
                      value={a.sourceRegionId ?? s.regions[0].id}
                      options={s.regions.map((r, j) => ({
                        value: r.id,
                        label: `${j + 1}. ${r.kind} · bars ${r.startBar + 1}–${r.endBar}`,
                      }))}
                      onChange={(sourceRegionId) => {
                        const r = s.regions.find((x) => x.id === sourceRegionId)!;
                        edit({
                          arrangement: s.arrangement.map((x, j) =>
                            j === i
                              ? {
                                  ...x,
                                  sourceRegionId,
                                  ...(x.preserve ? { bars: r.endBar - r.startBar } : {}),
                                }
                              : x,
                          ),
                        });
                      }}
                    />
                  </Field>
                  <Field label="Action">
                    <Select
                      aria-label={`Section ${i + 1} action`}
                      value={a.preserve ? 'keep' : 'develop'}
                      options={[
                        { value: 'keep', label: 'Keep source' },
                        { value: 'develop', label: 'Develop' },
                      ]}
                      onChange={(value) => {
                        const r = s.regions.find((x) => x.id === a.sourceRegionId) ?? s.regions[0];
                        edit({
                          arrangement: s.arrangement.map((x, j) =>
                            j === i
                              ? {
                                  ...x,
                                  preserve: value === 'keep',
                                  sourceRegionId: r.id,
                                  ...(value === 'keep' ? { bars: r.endBar - r.startBar } : {}),
                                }
                              : x,
                          ),
                        });
                      }}
                    />
                  </Field>
                  <Field label="Bars">
                    <NumberInput
                      aria-label={`Section ${i + 1} bars`}
                      value={a.bars}
                      min={1}
                      max={128}
                      disabled={a.preserve}
                      onChange={(bars) =>
                        edit({ arrangement: s.arrangement.map((x, j) => (j === i ? { ...x, bars } : x)) })
                      }
                    />
                  </Field>
                  <div className="row">
                    <Button
                      aria-label={`Move section ${i + 1} up`}
                      disabled={i === 0}
                      onClick={() => {
                        const arrangement = [...s.arrangement];
                        [arrangement[i - 1], arrangement[i]] = [arrangement[i], arrangement[i - 1]];
                        edit({ arrangement });
                      }}
                    >
                      ↑
                    </Button>
                    <Button
                      aria-label={`Remove section ${i + 1}`}
                      onClick={() => edit({ arrangement: s.arrangement.filter((_, j) => i !== j) })}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                onClick={() =>
                  edit({
                    arrangement: [
                      ...s.arrangement,
                      { kind: 'chorus', bars: 8, sourceRegionId: s.regions[0].id },
                    ],
                  })
                }
              >
                Add section
              </Button>
              <div className="expand-options">
                <Field label="Genres, tags and mood" hint="Optional: e.g. dreamy synth-pop, syncopated, warm">
                  <TextInput
                    aria-label="Expansion style"
                    value={s.style}
                    onChange={(style) => edit({ style })}
                  />
                </Field>
                <Field label="Phrase variation" hint="Keeps the opening motif; develops phrase endings.">
                  <input
                    aria-label="Phrase variation"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={s.variation}
                    onChange={(e) => edit({ variation: Number(e.target.value) })}
                  />
                  <span>{Math.round(s.variation * 100)}%</span>
                </Field>
                <Field label="Seed" hint="Same source, settings and seed reproduce the result.">
                  <NumberInput
                    aria-label="Expansion seed"
                    min={0}
                    max={4294967295}
                    value={s.seed}
                    onChange={(seed) => edit({ seed })}
                  />
                </Field>
              </div>
              <div className="row wrap">
                <Button variant="primary" disabled={!s.arrangement.length} onClick={() => void generate()}>
                  Expand MIDI
                </Button>
                <Button disabled={!s.arrangement.length} onClick={() => void generate(randomSeed())}>
                  New variation
                </Button>
                <span className="small muted">
                  {s.arrangement.reduce((sum, x) => sum + x.bars, 0)} bars requested
                </span>
              </div>
            </section>
          </>
        )}
        {s.result && (
          <section className="card stack" data-testid="expansion-result">
            <h2>Your expanded MIDI</h2>
            <div className="row wrap">
              {sectionLayout(s.result.song).map((span) => (
                <Badge key={span.section.id}>
                  {span.section.name} · {span.section.bars} bars
                  {s.result!.preservedSectionIds.includes(span.section.id) ? ' · kept' : ''}
                </Badge>
              ))}
            </div>
            {s.result.warnings.map((w) => (
              <p className="small muted" key={w}>
                {w}
              </p>
            ))}
            <div className="row wrap">
              <Button onClick={() => void preview(s.result!.song, 'expand-result')}>
                {playing === 'expand-result' ? 'Stop preview' : 'Preview expansion'}
              </Button>
              <Button
                onClick={() => {
                  try {
                    downloadBytes(
                      songToMidi(s.result!.song),
                      `${slugify(s.result!.song.title)}.mid`,
                      'audio/midi',
                    );
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                Download MIDI
              </Button>
              <Button variant="primary" onClick={() => void open()}>
                Open as new project
              </Button>
            </div>
          </section>
        )}
      </fieldset>
      {busy && <p role="status">{busy}</p>}
      {error && (
        <p role="alert" className="expand-error">
          {error}
        </p>
      )}
    </div>
  );
}
