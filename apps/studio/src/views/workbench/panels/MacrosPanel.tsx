import { useEffect, useState } from 'react';
import { applyMacroTransforms, randomSeed, regenerateUnlocked, type MacroSettings } from '@songdeck/core';
import { useStudio } from '../../../state/store';
import { useSettings } from '../../../state/settings';
import { Button, Select, Slider } from '../../../ui/kit';
import { MACRO_INFO } from '../../compose/BlueprintEditor';

/** Macro controls (spec §19): non-musicians shape behaviour without editing notes. */
export default function MacrosPanel() {
  const song = useStudio((s) => s.project?.song ?? null);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const customInstruments = useSettings((s) => s.customInstruments);
  const st = useStudio.getState();
  const [scope, setScope] = useState<'song' | 'track'>('song');
  const track = song?.tracks.find((t) => t.id === selectedTrackId);
  const base: MacroSettings | null = song ? (scope === 'track' && track ? { ...song.macros, ...track.macros } : song.macros) : null;
  const [draft, setDraft] = useState<MacroSettings | null>(base);
  useEffect(() => setDraft(base), [song?.macros, track?.macros, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!song || !draft) return null;

  const withMacros = () => {
    if (scope === 'track' && track) {
      return { ...song, tracks: song.tracks.map((t) => (t.id === track.id ? { ...t, macros: { ...t.macros, ...draft } } : t)) };
    }
    return { ...song, macros: draft };
  };
  const regenerate = () => {
    const seed = randomSeed();
    const res = regenerateUnlocked(withMacros(), { seed, trackIds: scope === 'track' && track ? [track.id] : undefined, customInstruments });
    st.commit(res.song, `Macros applied${scope === 'track' && track ? ` to ${track.name}` : ''} · regenerated unlocked material (seed ${seed})`, 'regenerate');
  };
  const transformOnly = () => {
    const next = applyMacroTransforms(withMacros(), draft, scope === 'track' ? track?.id : undefined);
    st.commit(next, `Applied humanization/dynamics${scope === 'track' && track ? ` to ${track.name}` : ''}`, 'edit');
  };

  return (
    <div className="col">
      <h3>Macro controls</h3>
      <Select
        value={scope}
        onChange={setScope}
        options={[
          { value: 'song', label: 'Whole song' },
          { value: 'track', label: track ? `Track: ${track.name}` : 'Selected track', disabled: !track },
        ]}
      />
      {MACRO_INFO.map((m) => (
        <Slider key={m.key} label={m.label} left={m.left} right={m.right} value={draft[m.key]} onChange={(v) => setDraft({ ...draft, [m.key]: v })} accent />
      ))}
      <Button variant="primary" icon="dice" onClick={regenerate} title="Regenerate unlocked material with these macros">
        Apply & regenerate unlocked
      </Button>
      <Button onClick={transformOnly} title="Humanization and dynamics act on existing notes without regenerating">
        Apply humanization & dynamics only
      </Button>
      <div className="small muted">Locked components never change. Complexity, density and syncopation require regeneration; humanization and dynamics can reshape existing notes.</div>
    </div>
  );
}
