import { useMemo, useState } from 'react';
import { BUILTIN_INSTRUMENTS, GM_PROGRAM_NAMES, midiToNoteName, noteNameToMidi, type InstrumentProfile } from '@songdeck/core';
import { PATCHES } from '@songdeck/audio';
import { Button, Field, Modal, Select, TextInput, Toggle } from '../../ui/kit';
import { ARTICULATIONS, CLEFS, FAMILIES, FUNCTIONS, STEM_GROUPS, TRACK_ROLES } from './constants';
import { ChipSet, OptNumber } from './ui';

/** Custom instrument profiles (spec §17): range, GM program, synth patch, role, stem group… */

export function instrumentProblems(ins: InstrumentProfile, takenIds: Set<string>): string[] {
  const p: string[] = [];
  if (!ins.name.trim()) p.push('Name is required');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(ins.id)) p.push('Id must be lowercase letters, digits and dashes');
  if (takenIds.has(ins.id)) p.push(`Id “${ins.id}” is already used`);
  if (!(ins.range.low >= 0 && ins.range.high <= 127 && ins.range.low < ins.range.high)) p.push('Range must be low < high within MIDI 0..127');
  if (!(ins.gmProgram >= 0 && ins.gmProgram <= 127)) p.push('GM program must be 0..127');
  if (!PATCHES[ins.patchId]) p.push(`Unknown synth patch “${ins.patchId}”`);
  return p;
}

export function normalizeInstrument(raw: unknown): InstrumentProfile {
  if (!raw || typeof raw !== 'object') throw new Error('Not an instrument profile (expected a JSON object)');
  const r = raw as Partial<InstrumentProfile>;
  if (typeof r.name !== 'string' || !r.name.trim()) throw new Error('An instrument profile needs a "name"');
  const base = structuredClone(BUILTIN_INSTRUMENTS.find((i) => i.id === 'piano') ?? BUILTIN_INSTRUMENTS[0]);
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') : r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { ...base, ...r, id, name: r.name.trim(), range: { ...base.range, ...(r.range ?? {}) }, articulations: Array.isArray(r.articulations) ? r.articulations : base.articulations, custom: true };
}

function NoteInput({ value, onChange, label, optional }: { value: number | undefined; onChange: (v: number | undefined) => void; label: string; optional?: boolean }) {
  const [draft, setDraft] = useState(value === undefined ? '' : midiToNoteName(value));
  const [bad, setBad] = useState(false);
  return (
    <input
      className={`input sm mono ${bad ? 'st-bad' : ''}`}
      value={draft}
      aria-label={label}
      placeholder={optional ? '—' : 'C4'}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = e.target.value.trim();
        if (!v && optional) {
          setBad(false);
          return onChange(undefined);
        }
        const m = /^\d+$/.test(v) ? Number(v) : noteNameToMidi(v);
        const ok = m !== null && m >= 0 && m <= 127;
        setBad(!ok);
        if (ok) onChange(m);
      }}
      onBlur={() => {
        setBad(false);
        setDraft(value === undefined ? '' : midiToNoteName(value));
      }}
      style={{ width: 70 }}
    />
  );
}

export function InstrumentEditor({ instrument, takenIds, onSave, onClose }: { instrument: InstrumentProfile; takenIds: Set<string>; onSave: (i: InstrumentProfile) => void; onClose: () => void }) {
  const [ins, setIns] = useState<InstrumentProfile>(() => structuredClone(instrument));
  const problems = useMemo(() => instrumentProblems(ins, takenIds), [ins, takenIds]);
  const set = (patch: Partial<InstrumentProfile>) => setIns((x) => ({ ...x, ...patch }));
  const patchOptions = useMemo(
    () =>
      Object.values(PATCHES)
        .map((p) => ({ value: p.id, label: `${p.name}` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [],
  );
  return (
    <Modal
      title={`Instrument profile — ${ins.name || 'untitled'}`}
      icon="music"
      wide
      onClose={onClose}
      footer={
        <>
          {problems.length > 0 && <span className="small st-provider-error grow">{problems[0]}</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={problems.length > 0} onClick={() => onSave({ ...ins, custom: true })}>
            Save instrument
          </Button>
        </>
      }
    >
      <div className="col" data-testid="instrument-editor">
        <div className="grid-3">
          <Field label="Name">
            <TextInput value={ins.name} onChange={(name) => set({ name })} aria-label="Instrument name" />
          </Field>
          <Field label="Id">
            <TextInput mono value={ins.id} onChange={(id) => set({ id: id.toLowerCase().replace(/[^a-z0-9-]+/g, '-') })} aria-label="Instrument id" />
          </Field>
          <Field label="Family">
            <Select value={ins.family} onChange={(family) => set({ family })} options={FAMILIES} />
          </Field>
        </div>
        <div className="grid-3">
          <Field label="General MIDI program" hint="Used in MIDI exports and DAW projects.">
            <Select value={String(ins.gmProgram)} onChange={(v) => set({ gmProgram: Number(v) })} options={GM_PROGRAM_NAMES.map((n, i) => ({ value: String(i), label: `${i + 1}. ${n}` }))} aria-label="GM program" />
          </Field>
          <Field label="Guide-render patch" hint="Synth voice used for playback and guide renders.">
            <Select value={ins.patchId} onChange={(patchId) => set({ patchId })} options={patchOptions} aria-label="Patch" />
          </Field>
          <Field label="Drum kit">
            <Toggle on={!!ins.isDrumKit} onChange={(isDrumKit) => set({ isDrumKit })} label="Channel 10 (GM drum map)" />
          </Field>
        </div>
        <div className="grid-4">
          <Field label="Lowest note">
            <NoteInput value={ins.range.low} onChange={(v) => v !== undefined && set({ range: { ...ins.range, low: v } })} label="Lowest note" />
          </Field>
          <Field label="Highest note">
            <NoteInput value={ins.range.high} onChange={(v) => v !== undefined && set({ range: { ...ins.range, high: v } })} label="Highest note" />
          </Field>
          <Field label="Comfortable low">
            <NoteInput optional value={ins.range.comfortableLow} onChange={(comfortableLow) => set({ range: { ...ins.range, comfortableLow } })} label="Comfortable low" />
          </Field>
          <Field label="Comfortable high">
            <NoteInput optional value={ins.range.comfortableHigh} onChange={(comfortableHigh) => set({ range: { ...ins.range, comfortableHigh } })} label="Comfortable high" />
          </Field>
        </div>
        <div className="grid-4">
          <Field label="Polyphony">
            <Select value={ins.polyphony} onChange={(polyphony) => set({ polyphony })} options={['mono', 'poly'] as const} />
          </Field>
          <Field label="Default role">
            <Select value={ins.defaultRole} onChange={(defaultRole) => set({ defaultRole })} options={TRACK_ROLES} />
          </Field>
          <Field label="Default function">
            <Select value={ins.defaultFunction} onChange={(defaultFunction) => set({ defaultFunction })} options={FUNCTIONS} />
          </Field>
          <Field label="Stem group">
            <Select value={ins.stemGroup} onChange={(stemGroup) => set({ stemGroup })} options={STEM_GROUPS} />
          </Field>
        </div>
        <div className="grid-3">
          <Field label="Clef">
            <Select value={ins.clef} onChange={(clef) => set({ clef })} options={CLEFS} />
          </Field>
          <Field label="Notation transpose" hint="Written vs sounding, semitones (guitar +12).">
            <OptNumber value={ins.notationTranspose} min={-36} max={36} onChange={(notationTranspose) => set({ notationTranspose })} placeholder="0" />
          </Field>
        </div>
        <Field label="Articulations">
          <ChipSet label="Articulations" options={ARTICULATIONS.map((a) => ({ value: a, label: a }))} value={ins.articulations} onChange={(articulations) => set({ articulations })} />
        </Field>
      </div>
    </Modal>
  );
}
