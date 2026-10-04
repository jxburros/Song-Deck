import { useMemo, useState } from 'react';
import {
  BUILTIN_INSTRUMENTS,
  LockKeys,
  barToTick,
  getInstrument,
  keyName,
  type InstrumentProfile,
  type KeySignature,
  type MusicalFunction,
  type Note,
  type Proposal,
  type Song,
  type TrackRole,
} from '@songdeck/core';
import { useSettings } from '../../state/settings';
import { useStudio } from '../../state/store';
import { Button, Field, Modal, NumberInput, Select, Tabs, TextInput, Toggle } from '../../ui/kit';
import { NoteStrip } from '../shared/NoteStrip';
import {
  keyAtBar1,
  proposeInsertion,
  sectionChoices,
  songBars,
  transposeBetween,
  type InsertMode,
  type InsertRequest,
} from '../../engine/capture-song';

export interface InsertMaterial {
  notes: Note[];
  /** Bars of material (its own timeline, starting at its bar 1). */
  bars: number;
  ppq: number;
  meter: { numerator: number; denominator: number };
  key?: KeySignature;
  instrumentId: string;
  role?: TrackRole;
  fn?: MusicalFunction;
  trackName: string;
  drums: boolean;
}

export interface InsertDialogProps {
  title: string;
  song: Song;
  material: InsertMaterial;
  defaultMode?: InsertMode;
  /** Let the user pick which bars of the material to use (transcriptions). */
  allowSourceRange?: boolean;
  proposalTitle: (req: InsertRequest) => string;
  source?: string;
  explanation?: string;
  instruction?: string;
  onClose: () => void;
  onProposed?: (p: Proposal, req: InsertRequest) => void;
}

export function InsertDialog(props: InsertDialogProps) {
  const { song, material } = props;
  const customInstruments = useSettings((s) => s.customInstruments);
  const instruments: InstrumentProfile[] = useMemo(
    () => [...BUILTIN_INSTRUMENTS, ...customInstruments],
    [customInstruments],
  );
  const sections = useMemo(() => sectionChoices(song), [song]);
  const totalBars = songBars(song);
  const midiTracks = song.tracks.filter((t) => t.kind === 'midi');
  const compatible = midiTracks.filter((t) => {
    const drumTrack =
      getInstrument(t.instrumentId, customInstruments).isDrumKit ||
      t.role === 'drums' ||
      t.role === 'percussion';
    return drumTrack === material.drums;
  });
  const preferredTrack =
    compatible.find((t) => t.role === (material.role ?? '')) ??
    compatible.find((t) => t.role === 'vocal') ??
    compatible[0];

  const [mode, setMode] = useState<InsertMode>(
    props.defaultMode === 'replace' && compatible.length ? 'replace' : 'new-track',
  );
  const [trackName, setTrackName] = useState(material.trackName);
  const [instrumentId, setInstrumentId] = useState(material.instrumentId);
  const [trackId, setTrackId] = useState(preferredTrack?.id ?? '');
  const [srcFrom, setSrcFrom] = useState(1);
  const [srcTo, setSrcTo] = useState(Math.max(1, material.bars));
  const srcBars = Math.max(1, srcTo - srcFrom + 1);
  const [targetBar, setTargetBar] = useState(() => {
    if (props.defaultMode === 'replace') return Math.max(1, totalBars - srcBars + 1);
    return 1;
  });
  const [endBar, setEndBar] = useState<number | null>(null);
  const effectiveEnd = endBar ?? Math.min(Math.max(totalBars, targetBar), targetBar + srcBars - 1);
  const targetTrack = song.tracks.find((t) => t.id === trackId);
  const isVocal = targetTrack?.role === 'vocal';
  const [keepSyllables, setKeepSyllables] = useState(true);

  const projectKey = keyAtBar1(song, targetBar);
  const shift = material.key && !material.drums ? transposeBetween(material.key, projectKey) : 0;
  const [transpose, setTranspose] = useState(shift !== 0);

  const projMeter = song.meterMap[0] ?? { numerator: 4, denominator: 4 };
  const meterMismatch =
    projMeter.numerator !== material.meter.numerator || projMeter.denominator !== material.meter.denominator;
  const materialBarTicks = (material.meter.numerator * 4 * material.ppq) / material.meter.denominator;
  const srcStartTick = (srcFrom - 1) * materialBarTicks;
  const srcEndTick = srcTo * materialBarTicks;
  const usedNotes = material.notes.filter((n) => n.tick >= srcStartTick && n.tick < srcEndTick).length;
  const lastBar = mode === 'replace' ? effectiveEnd : targetBar + srcBars - 1;
  const beyondEnd = lastBar > totalBars;
  const locked = mode === 'replace' && targetTrack ? !!song.locks[LockKeys.track(targetTrack.id)] : false;

  const request = (): InsertRequest => ({
    mode,
    song,
    notes: material.notes,
    sourceStartTick: props.allowSourceRange ? srcStartTick : undefined,
    sourceEndTick: props.allowSourceRange ? srcEndTick : undefined,
    targetBar,
    endBar: mode === 'replace' ? effectiveEnd : undefined,
    trackId: mode === 'replace' ? trackId : undefined,
    trackName,
    instrumentId,
    role: material.role,
    fn: material.fn,
    transpose: transpose ? shift : 0,
    keepSyllables: isVocal && keepSyllables,
    meta: {
      title: '',
      source: props.source ?? 'internal',
      instruction: props.instruction,
      explanation: props.explanation,
    },
  });

  const submit = () => {
    const req = request();
    req.meta.title = props.proposalTitle(req);
    try {
      const p = proposeInsertion(req);
      if (p) {
        props.onProposed?.(p, req);
        props.onClose();
      }
    } catch (err) {
      useStudio.getState().toast('error', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal
      title={props.title}
      icon="plus"
      wide
      onClose={props.onClose}
      footer={
        <>
          <span className="small muted grow">
            Nothing changes until you accept the proposal in the workbench (spec §21).
          </span>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon="check"
            onClick={submit}
            disabled={(mode === 'replace' && !targetTrack) || usedNotes === 0}
          >
            Create proposal
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }} data-testid="insert-dialog">
        <Tabs
          value={mode}
          onChange={setMode}
          tabs={[
            { value: 'new-track', label: 'Add as a new track', icon: 'plus' },
            { value: 'replace', label: 'Replace a phrase in a track', icon: 'scissors' },
          ]}
        />
        {mode === 'new-track' ? (
          <div className="grid-2">
            <Field label="Track name">
              <TextInput value={trackName} onChange={setTrackName} aria-label="Track name" />
            </Field>
            <Field label="Instrument">
              <Select
                value={instrumentId}
                onChange={setInstrumentId}
                options={instruments.map((i) => ({ value: i.id, label: i.name }))}
                aria-label="Insert instrument"
              />
            </Field>
          </div>
        ) : (
          <div className="grid-2">
            <Field
              label="Track"
              hint={
                compatible.length
                  ? undefined
                  : material.drums
                    ? 'The project has no drum track.'
                    : 'The project has no melodic MIDI track.'
              }
            >
              <Select
                value={trackId}
                onChange={setTrackId}
                options={
                  compatible.length
                    ? compatible.map((t) => ({ value: t.id, label: `${t.name} (${t.notes.length} notes)` }))
                    : [{ value: '', label: 'No compatible track' }]
                }
                aria-label="Target track"
              />
            </Field>
            {isVocal ? (
              <Field label="Lyrics" hint="Re-use the replaced notes' syllables, in order.">
                <Toggle
                  on={keepSyllables}
                  onChange={setKeepSyllables}
                  label="Keep the phrase's lyric syllables"
                />
              </Field>
            ) : (
              <div />
            )}
          </div>
        )}

        <div className="grid-4">
          <Field label="Start at section">
            <Select
              value={sections.find((s) => s.startBar === targetBar)?.id ?? ''}
              onChange={(id) => {
                const s = sections.find((x) => x.id === id);
                if (!s) return;
                setTargetBar(s.startBar);
                if (mode === 'replace') setEndBar(s.startBar + Math.min(s.bars, srcBars) - 1);
              }}
              options={[
                { value: '', label: 'Custom bar' },
                ...sections.map((s) => ({ value: s.id, label: `${s.name} · bar ${s.startBar}` })),
              ]}
              aria-label="Start section"
            />
          </Field>
          <Field label="Start bar">
            <NumberInput
              value={targetBar}
              min={1}
              max={Math.max(1, totalBars + 64)}
              onChange={(v) => setTargetBar(Math.round(v))}
              aria-label="Start bar"
            />
          </Field>
          {mode === 'replace' ? (
            <Field label="Replace through bar" hint={`Bars ${targetBar}–${effectiveEnd} are replaced.`}>
              <NumberInput
                value={effectiveEnd}
                min={targetBar}
                max={Math.max(targetBar, totalBars + 64)}
                onChange={(v) => setEndBar(Math.round(v))}
                aria-label="End bar"
              />
            </Field>
          ) : (
            <Field label="Ends at bar">
              <div className="mono" style={{ paddingTop: 6 }}>
                {lastBar}
              </div>
            </Field>
          )}
          {material.key && !material.drums && (
            <Field label="Key" hint={`Material: ${keyName(material.key)} · project: ${keyName(projectKey)}`}>
              <Toggle
                on={transpose && shift !== 0}
                onChange={setTranspose}
                label={shift === 0 ? 'Already in key' : `Transpose ${shift > 0 ? '+' : ''}${shift} st`}
              />
            </Field>
          )}
        </div>

        {props.allowSourceRange && (
          <div className="grid-4">
            <Field label="Use material from bar">
              <NumberInput
                value={srcFrom}
                min={1}
                max={srcTo}
                onChange={(v) => setSrcFrom(Math.round(v))}
                aria-label="Source from bar"
              />
            </Field>
            <Field label="to bar">
              <NumberInput
                value={srcTo}
                min={srcFrom}
                max={Math.max(srcFrom, material.bars)}
                onChange={(v) => setSrcTo(Math.round(v))}
                aria-label="Source to bar"
              />
            </Field>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>Material</label>
              <NoteStrip
                notes={material.notes}
                ppq={material.ppq}
                meter={material.meter}
                totalTicks={material.bars * materialBarTicks}
                height={70}
                drums={material.drums}
                highlight={{ startTick: srcStartTick, endTick: srcEndTick }}
                onBarClick={(b) => {
                  if (b < srcFrom) setSrcFrom(b);
                  else setSrcTo(b);
                }}
                testId="insert-source-strip"
              />
            </div>
          </div>
        )}

        <div className="callout small">
          {mode === 'new-track' ? (
            <>
              Adds <strong>{usedNotes}</strong> notes as a new track “{trackName || 'New track'}” at bars{' '}
              {targetBar}–{lastBar}.
            </>
          ) : (
            <>
              Replaces bars {targetBar}–{effectiveEnd} of “{targetTrack?.name ?? '—'}” with{' '}
              <strong>{usedNotes}</strong> notes
              {targetTrack
                ? ` (currently ${targetTrack.notes.filter((n) => n.tick >= barToTick(song, targetBar - 1) && n.tick < barToTick(song, effectiveEnd)).length} notes there)`
                : ''}
              .
            </>
          )}
        </div>
        {(meterMismatch || beyondEnd || locked) && (
          <div className="callout warning small">
            {meterMismatch && (
              <div>
                The material is in {material.meter.numerator}/{material.meter.denominator} but the project is
                in {projMeter.numerator}/{projMeter.denominator}; bar lines will not line up.
              </div>
            )}
            {beyondEnd && (
              <div>
                The material runs past the end of the song (bar {totalBars}); notes beyond the last section
                may be flagged by validation.
              </div>
            )}
            {locked && (
              <div>
                “{targetTrack?.name}” is locked — the proposal will be rejected by the validation engine
                unless you unlock it.
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
