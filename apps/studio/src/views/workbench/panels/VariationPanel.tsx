import { useMemo, useState } from 'react';
import {
  BRANCH_TEMPLATES,
  composeFromDNA,
  createVariation,
  extractSongDNA,
  keyName,
  randomSeed,
  type VariationLevel,
} from '@songdeck/core';
import { useStudio } from '../../../state/store';
import { Badge, Button, Field, NumberInput, Select, Slider, Toggle } from '../../../ui/kit';
import { EnergyCurve } from '../../shared/EnergyCurve';

const LEVELS: { value: VariationLevel; label: string; keeps: string; changes: string }[] = [
  {
    value: 'ornament',
    label: 'Ornament',
    keeps: 'Almost everything',
    changes: 'Fills, ornamentation, velocity, articulations',
  },
  {
    value: 'variation',
    label: 'Variation',
    keeps: 'Harmony, motifs, structure',
    changes: 'Accompaniment details',
  },
  {
    value: 'reinterpretation',
    label: 'Reinterpretation',
    keeps: 'Main melody, recognizable motifs, broad structure',
    changes: 'Substantially different arrangement',
  },
  {
    value: 'mutation',
    label: 'Mutation',
    keeps: 'Only the Song DNA',
    changes: 'Everything else — a related song',
  },
];

/** Generation seeds (spec §23), variation system (§24), Song DNA (§11) and branch templates (§53). */
export default function VariationPanel() {
  const song = useStudio((s) => s.project?.song ?? null);
  const st = useStudio.getState();
  const [level, setLevel] = useState<VariationLevel>('variation');
  const [amount, setAmount] = useState(0.2);
  const [seed, setSeed] = useState(() => randomSeed());
  const [asBranch, setAsBranch] = useState(true);
  const dna = useMemo(() => (song ? extractSongDNA(song) : null), [song]);
  if (!song || !dna) return null;
  const info = LEVELS.find((l) => l.value === level)!;

  const apply = (next: typeof song, message: string, branchName: string) => {
    if (asBranch) st.createBranch(branchName);
    st.commit(next, message, 'variation');
  };

  return (
    <div className="col">
      <h3>Variation</h3>
      <Field
        label="Seed"
        hint={`Current composition seed: ${song.generation.seed} · engine ${song.generation.engineVersion}`}
      >
        <div className="row">
          <NumberInput value={seed} onChange={(v) => setSeed(Math.round(v))} min={0} />
          <Button icon="dice" onClick={() => setSeed(randomSeed())} title="New seed" />
        </div>
      </Field>
      <Field label="Level">
        <Select
          value={level}
          onChange={setLevel}
          options={LEVELS.map((l) => ({ value: l.value, label: l.label }))}
        />
      </Field>
      <div className="card small">
        <div>
          <span className="muted">Keeps:</span> {info.keeps}
        </div>
        <div>
          <span className="muted">Changes:</span> {info.changes}
        </div>
      </div>
      <Slider
        label="Variation amount"
        value={amount}
        onChange={setAmount}
        format={(v) => `${Math.round(v * 100)}%`}
        accent
      />
      <Toggle on={asBranch} onChange={setAsBranch} label="Create as a new branch" />
      <Button
        variant="primary"
        icon="sparkles"
        onClick={() => {
          try {
            const next = createVariation(song, level, { seed, amount });
            apply(next, `${info.label} ${Math.round(amount * 100)}% · seed ${seed}`, `${info.label} ${seed}`);
          } catch (err) {
            st.toast('error', err instanceof Error ? err.message : String(err));
          }
        }}
      >
        Generate {info.label.toLowerCase()}
      </Button>

      <h3 style={{ marginTop: 10 }}>Song DNA</h3>
      <div className="card small col" style={{ gap: 6 }}>
        <div className="row wrap">
          <Badge>{keyName(dna.tonalCenter)}</Badge>
          <Badge>{dna.tempo} BPM</Badge>
          <Badge>
            {dna.meter.numerator}/{dna.meter.denominator}
          </Badge>
          <Badge tone="ai">{dna.repetition.pattern}</Badge>
        </div>
        <div>
          <span className="muted">Harmonic language:</span>{' '}
          {Object.entries(dna.harmonicLanguage.chordVocabulary)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([r]) => r)
            .join(' · ')}
        </div>
        {dna.principalProgressions.slice(0, 3).map((p) => (
          <div key={p.sectionKind}>
            <span className="muted">{p.sectionKind}:</span>{' '}
            <span className="mono">{p.roman.join(' – ')}</span>
          </div>
        ))}
        <div>
          <span className="muted">Motifs:</span>{' '}
          {dna.motifs.map((m) => `${m.name}${m.description ? ` (${m.description})` : ''}`).join(', ') || '—'}
        </div>
        <div>
          <span className="muted">Instrumentation:</span>{' '}
          {dna.instrumentation.map((i) => i.instrumentId).join(', ')}
        </div>
        <EnergyCurve values={dna.energyCurve} width={280} height={36} />
      </div>
      <Button
        onClick={() => {
          const next = composeFromDNA(dna, { seed, title: `${song.title} (DNA ${seed})` });
          apply({ ...next, id: song.id }, `New version from Song DNA · seed ${seed}`, `DNA ${seed}`);
        }}
      >
        Compose a related version from DNA
      </Button>

      <h3 style={{ marginTop: 10 }}>Branch templates</h3>
      {BRANCH_TEMPLATES.map((t) => (
        <div key={t.id} className="card row">
          <div className="grow">
            <strong>{t.name}</strong>
            <div className="small muted">{t.description}</div>
          </div>
          <Button
            size="sm"
            onClick={() => {
              const next = t.apply(song, seed);
              st.createBranch(t.name);
              st.commit(next, `${t.name} (from ${song.title}) · seed ${seed}`, 'branch');
            }}
          >
            Create
          </Button>
        </div>
      ))}
    </div>
  );
}
