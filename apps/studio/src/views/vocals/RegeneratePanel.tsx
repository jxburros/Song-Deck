import { useMemo, useState } from 'react';
import { interpretVocalInstruction, randomSeed, sectionLayout, type EditSelection, type Project, type Track } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { activeRender, formatBars, vocalPhrases } from '../../engine/vocal-model';
import { logVocalActivity, proposeVocal, setAutoResing, useVocalJobs } from '../../engine/vocal-sync';
import { Button, Field, Select, TextArea, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { PhrasePicker } from './PhrasePicker';
import { PendingVocalProposals } from './Proposals';
import { TaskLine } from './shared';
import { useVocalSession } from './session';

/** The spec §37 examples. */
export const VOCAL_EXAMPLES = [
  'Make the final line more aggressive.',
  'Add vibrato here.',
  'Sing this note more softly.',
  'Change the melody on the word "fire".',
  'Regenerate only the second chorus vocal.',
];

type Scope = 'phrase' | 'selection' | 'track';

/**
 * Independent vocal regeneration (spec §37): natural-language performance instructions on the
 * vocal only → `interpretVocalInstruction` → a reviewable proposal. Accepting it re-sings ONLY the
 * affected range and splices it into the render with short crossfades; the instrumentation is
 * never regenerated.
 */
export function RegeneratePanel({ project, track }: { project: Project; track: Track }) {
  const song = project.song;
  const session = useVocalSession();
  const selection = useStudio((s) => s.selection);
  const autoResing = useVocalJobs((s) => s.autoResing);
  const activity = useVocalJobs((s) => s.activity);
  const phrases = useMemo(() => vocalPhrases(song, track), [song, track]);
  const selNotes = selection.noteIds.filter((id) => track.notes.some((n) => n.id === id));
  const [scope, setScope] = useState<Scope>('phrase');
  const phrase = phrases.find((p) => p.id === session.phraseId) ?? phrases[0];
  const render = activeRender(project, track.id);
  const lastResing = activity.find((a) => a.kind === 'resing' && a.taskId);

  const selectionFor = (instruction: string): { sel: EditSelection; label: string } => {
    // The phrase / selection is what "here", "this note", "these notes" refer to; other targets
    // ("the final line", "the second chorus", "the word 'fire'") are found in the whole vocal.
    const deictic = /\b(here|this|these|that|those|it)\b/i.test(instruction);
    if (!deictic) return { sel: { trackIds: [track.id] }, label: `the whole ${track.name}` };
    if (scope === 'phrase' && phrase) return { sel: { trackIds: [track.id], noteIds: phrase.noteIds, startTick: phrase.startTick, endTick: phrase.endTick }, label: phrase.label };
    if (scope === 'selection' && selNotes.length) {
      const notes = track.notes.filter((n) => selNotes.includes(n.id));
      const a = Math.min(...notes.map((n) => n.tick));
      const b = Math.max(...notes.map((n) => n.tick + n.duration));
      return { sel: { trackIds: [track.id], noteIds: selNotes, startTick: a, endTick: b }, label: `${selNotes.length} selected notes` };
    }
    return { sel: { trackIds: [track.id] }, label: `the whole ${track.name}` };
  };

  const run = (text = session.instruction) => {
    const instruction = text.trim();
    if (!instruction) return;
    const cur = useStudio.getState().project?.song ?? song;
    const { sel, label } = selectionFor(instruction);
    const r = interpretVocalInstruction(cur, track.id, instruction, sel, { seed: randomSeed() });
    // The interpreter asks for level 'variation', which regenerateUnlocked skips for the song's
    // principal melody (the lead vocal) — so regenerate the vocal with a fresh pass instead.
    r.operations = r.operations.map((op) => (op.op === 'regenerate' && (op.level === 'variation' || op.level === 'reinterpretation') ? { ...op, level: undefined } : op));
    if (!r.operations.length) {
      session.set({ lastInstruction: { text: instruction, explanation: r.explanation, understood: r.understood } });
      return;
    }
    const isMix = r.intents.some((i) => i.startsWith('mix:'));
    const range = isMix ? undefined : r.regenerateRange;
    const rangeLabel = range ? (r.intents.includes('regenerate') ? sectionNames(cur, range) : `${label === `the whole ${track.name}` ? '' : `${label} · `}${formatBars(cur, range.startTick, range.endTick)}`) : undefined;
    const p = proposeVocal(
      cur,
      r.operations,
      { title: instruction, source: 'internal', instruction, explanation: r.explanation },
      { projectId: project.meta.id, trackId: track.id, kind: 'instruction', title: instruction, range, label: rangeLabel, reason: instruction },
    );
    if ('error' in p) {
      session.set({ lastInstruction: { text: instruction, explanation: r.explanation, understood: r.understood, error: p.error } });
      return;
    }
    session.set({ lastInstruction: { text: instruction, explanation: r.explanation, understood: true, proposalId: p.id } });
    logVocalActivity('instruction', `Proposed: “${instruction}”${rangeLabel ? ` (${rangeLabel})` : ''}`);
  };

  return (
    <div className="col" style={{ gap: 12 }} data-testid="regenerate-panel">
      <div className="vx-two">
        <div className="panel">
          <div className="panel-header">
            <Icon name="sparkles" />
            <h3 className="grow">Change the vocal with words</h3>
          </div>
          <div className="panel-body col">
            <Field label="Vocal instruction">
              <TextArea
                value={session.instruction}
                onChange={(v) => session.set({ instruction: v })}
                rows={2}
                placeholder="e.g. Add vibrato here."
                aria-label="Vocal instruction"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    run();
                  }
                }}
              />
            </Field>
            <div className="chip-list" aria-label="Examples">
              {VOCAL_EXAMPLES.map((ex) => (
                <button key={ex} type="button" className="chip" onClick={() => session.set({ instruction: ex })}>
                  {ex}
                </button>
              ))}
            </div>
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <Field label="“Here” means">
                <Select
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: 'phrase', label: phrase ? `Selected phrase — ${phrase.label}` : 'Selected phrase' },
                    { value: 'selection', label: `Piano-roll selection (${selNotes.length} notes)`, disabled: !selNotes.length },
                    { value: 'track', label: `The whole ${track.name}` },
                  ]}
                  aria-label="Instruction scope"
                />
              </Field>
              <Button variant="ai" icon="sparkles" onClick={() => run()} disabled={!session.instruction.trim()}>
                Propose vocal change
              </Button>
            </div>
            <Toggle
              on={autoResing}
              onChange={setAutoResing}
              label={render ? 'After accepting, re-sing only the changed range' : 'After accepting, re-sing only the changed range (once there is a render)'}
            />
            {session.lastInstruction && (
              <div className={`callout ${session.lastInstruction.error ? 'warning' : session.lastInstruction.understood ? '' : 'warning'} small`} data-testid="instruction-result">
                <div className="dim" style={{ marginBottom: 2 }}>
                  “{session.lastInstruction.text}” · on-device vocal interpreter
                </div>
                {session.lastInstruction.error ?? session.lastInstruction.explanation}
              </div>
            )}
            <PendingVocalProposals project={project} />
            {lastResing && <TaskLine taskId={lastResing.taskId} />}
            <div className="small dim">
              Only the vocal changes — expression, pitches or the vocal melody of one section. Drums, harmony and every instrument are never regenerated (spec §37).
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-header">
            <Icon name="music" />
            <h3 className="grow">Phrases</h3>
            <span className="small dim">{phrases.length} in {track.name}</span>
          </div>
          <div className="panel-body">
            <PhrasePicker
              song={song}
              phrases={phrases}
              value={phrase?.id ?? null}
              onChange={(id) => {
                session.set({ phraseId: id });
                setScope('phrase');
              }}
              height={420}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function sectionNames(song: Project['song'], range: { startTick: number; endTick: number }): string {
  const names = sectionLayout(song)
    .filter((s) => s.startTick < range.endTick && s.endTick > range.startTick)
    .map((s) => s.section.name);
  return names.length ? names.join(' + ') : formatBars(song, range.startTick, range.endTick);
}
