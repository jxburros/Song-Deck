import { useEffect, useMemo, useState } from 'react';
import {
  VOCAL_ZONES,
  VOICE_TYPE_LABELS,
  VOICE_TYPE_ZONES,
  checkSingerRange,
  describeSinger,
  fitToSinger,
  midiToNoteName,
  noteNameToMidi,
  normalizeSinger,
  singerFromVoiceType,
  singerTop,
  singerZone,
  type RangeCheck,
  type SingerProfile,
  type Song,
  type Track,
  type VocalZone,
  type VoiceType,
} from '@songdeck/core';
import { Badge, Button, Field, Modal, Select, TextArea, TextInput } from '../../ui/kit';
import { addSinger, assignSinger, proposeFitToSinger } from '../../engine/singers';
import { useStudio } from '../../state/store';
import { useVocalSession } from '../vocals/session';

/**
 * A singer's range zones, drawn and edited: the zone keyboard, its legend, the editor dialog and
 * the range check of a part (time in each zone, notes outside the easy zones, a better key).
 */

/** Colour of each zone (theme tokens) and its strength. */
export const ZONE_COLOR: Record<VocalZone, { token: string; alpha: number }> = {
  sweet: { token: '--success', alpha: 0.95 },
  comfortable: { token: '--success', alpha: 0.45 },
  stretch: { token: '--warning', alpha: 0.8 },
  falsetto: { token: '--accent', alpha: 0.75 },
  out: { token: '--text-dim', alpha: 0 },
};

const BLACK = new Set([1, 3, 6, 8, 10]);

function zoneStyle(zone: VocalZone): React.CSSProperties {
  const c = ZONE_COLOR[zone];
  return { fill: `var(${c.token})`, fillOpacity: c.alpha };
}

/** The zones on a keyboard strip; optional markers for a part's lowest and highest notes. */
export function RangeKeyboard({
  singer,
  part,
  height = 54,
}: {
  singer: SingerProfile;
  /** The part's lowest and highest notes. */
  part?: { lowest?: number; highest?: number };
  height?: number;
}) {
  const top = singerTop(singer);
  let lo = Math.min(singer.lowest, part?.lowest ?? Infinity) - 2;
  let hi = Math.max(top, part?.highest ?? -Infinity) + 2;
  lo = Math.max(0, Math.floor(lo / 12) * 12);
  hi = Math.min(127, Math.ceil((hi + 1) / 12) * 12 - 1);
  const n = hi - lo + 1;
  const u = 10;
  const W = n * u;
  const pitches = Array.from({ length: n }, (_, i) => lo + i);
  const label = `${singer.name}: ${describeSinger(singer)}${
    part?.lowest !== undefined && part.highest !== undefined
      ? `. This part: ${midiToNoteName(part.lowest)}–${midiToNoteName(part.highest)}`
      : ''
  }`;
  return (
    <svg
      className="singer-keys"
      viewBox={`0 0 ${W} 54`}
      preserveAspectRatio="none"
      style={{ width: '100%', height }}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {part?.lowest !== undefined && part.highest !== undefined && (
        <g>
          <rect
            x={(part.lowest - lo) * u}
            y={2}
            width={(part.highest - part.lowest + 1) * u}
            height={4}
            style={{ fill: 'var(--text)' }}
          />
        </g>
      )}
      {pitches.map((p) => {
        const zone = singerZone(singer, p);
        const x = (p - lo) * u;
        const black = BLACK.has(p % 12);
        return (
          <g key={p}>
            <rect x={x} y={9} width={u} height={12} style={zoneStyle(zone)} />
            <rect
              x={x + 0.5}
              y={22}
              width={u - 1}
              height={black ? 14 : 20}
              style={{
                fill: black ? 'var(--key-black)' : 'var(--key-white)',
                opacity: zone === 'out' ? 0.35 : 1,
              }}
            />
          </g>
        );
      })}
      {pitches
        .filter((p) => p % 12 === 0)
        .map((p) => (
          <text
            key={p}
            x={(p - lo) * u + 1}
            y={52}
            style={{ fill: 'var(--text-muted)', fontSize: 9, fontFamily: 'var(--font-mono)' }}
          >
            {midiToNoteName(p)}
          </text>
        ))}
    </svg>
  );
}

/** Swatches and words for the zones. */
export function ZoneLegend({ zones = VOCAL_ZONES.map((z) => z.zone) }: { zones?: VocalZone[] }) {
  return (
    <ul className="zone-legend">
      {VOCAL_ZONES.filter((z) => zones.includes(z.zone)).map((z) => (
        <li key={z.zone} title={z.description}>
          <svg width="12" height="12" aria-hidden="true">
            <rect
              width="12"
              height="12"
              style={{
                ...zoneStyle(z.zone),
                ...(z.zone === 'out' ? { fillOpacity: 1, fill: 'var(--bg-input)' } : {}),
              }}
              stroke="var(--border-strong)"
            />
          </svg>
          {z.label}
        </li>
      ))}
    </ul>
  );
}

const VERDICT: Record<RangeCheck['verdict'], { label: string; tone?: 'success' | 'warning' | 'danger' }> = {
  empty: { label: 'No notes' },
  comfortable: { label: 'Comfortable', tone: 'success' },
  'mostly-comfortable': { label: 'Mostly comfortable', tone: 'success' },
  demanding: { label: 'Demanding', tone: 'warning' },
  'out-of-range': { label: 'Out of range', tone: 'danger' },
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** How a part sits in its singer's voice, with a better key when there is one. */
export function RangeCheckCard({
  song,
  track,
  singer,
  compact,
}: {
  song: Song;
  track: Track;
  singer: SingerProfile;
  compact?: boolean;
}) {
  const check = useMemo(() => checkSingerRange(song, track, singer), [song, track, singer]);
  const verdict = VERDICT[check.verdict];
  const plan = check.best && track.kind === 'midi' ? fitToSinger(song, track, check.best.semitones) : null;
  const total = check.totalSeconds || 1;
  const groups = groupProblems(check);
  return (
    <div className="col singer-check" data-testid="range-check" style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <Badge tone={verdict.tone}>{verdict.label}</Badge>
        <span className="small">{check.summary}</span>
      </div>
      {check.notes > 0 && (
        <>
          <div
            className="zone-bar"
            role="img"
            aria-label={VOCAL_ZONES.filter((z) => check.zones[z.zone].seconds > 0)
              .map((z) => `${z.label} ${pct(check.zones[z.zone].seconds / total)}`)
              .join(', ')}
          >
            {VOCAL_ZONES.map((z) =>
              check.zones[z.zone].seconds > 0 ? (
                <span
                  key={z.zone}
                  className={`zone-seg zone-${z.zone}`}
                  style={{ flexGrow: check.zones[z.zone].seconds }}
                  title={`${z.label}: ${check.zones[z.zone].notes} notes, ${pct(check.zones[z.zone].seconds / total)} of the time`}
                />
              ) : null,
            )}
          </div>
          <div className="small muted">
            {VOCAL_ZONES.filter((z) => check.zones[z.zone].notes > 0)
              .map((z) => `${z.short} ${pct(check.zones[z.zone].seconds / total)}`)
              .join(' · ')}
            {check.lowest !== undefined && check.highest !== undefined
              ? ` · part ${midiToNoteName(check.lowest)}–${midiToNoteName(check.highest)}`
              : ''}
          </div>
        </>
      )}
      {!compact && check.problems.length > 0 && (
        <ul className="singer-problems small" aria-label="Notes outside the easy zones">
          {groups.slice(0, 6).map((g) => (
            <li key={g.pitch}>
              <strong>{midiToNoteName(g.pitch)}</strong> ·{' '}
              <span className={`zone-word zone-${g.zone}`}>
                {VOCAL_ZONES.find((z) => z.zone === g.zone)!.short}
              </span>{' '}
              · {g.count} note{g.count === 1 ? '' : 's'} · bar{g.bars.length === 1 ? '' : 's'}{' '}
              {g.bars.length > 5 ? `${g.bars.slice(0, 5).join(', ')}…` : g.bars.join(', ')}
            </li>
          ))}
          {groups.length > 6 && <li className="muted">…and {groups.length - 6} more pitches</li>}
        </ul>
      )}
      {plan && check.best && (
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="small">
            Better for {singer.name}: {plan.description.charAt(0).toLowerCase() + plan.description.slice(1)}
            {afterText(checkAfter(song, track, singer, check.best.semitones))}.
          </span>
          <Button
            size="sm"
            icon="sparkles"
            onClick={() => proposeFitToSinger(track.id, check.best!.semitones)}
          >
            Propose this change
          </Button>
        </div>
      )}
    </div>
  );
}

const SEVERITY: Record<RangeCheck['problems'][number]['zone'], number> = { out: 0, falsetto: 1, stretch: 2 };

/** Problem notes grouped by pitch: worst zone first, then the most frequent. */
function groupProblems(check: RangeCheck) {
  const by = new Map<
    number,
    { pitch: number; zone: RangeCheck['problems'][number]['zone']; count: number; bars: number[] }
  >();
  for (const p of check.problems) {
    const g = by.get(p.pitch) ?? { pitch: p.pitch, zone: p.zone, count: 0, bars: [] };
    g.count++;
    if (!g.bars.includes(p.bar)) g.bars.push(p.bar);
    by.set(p.pitch, g);
  }
  return [...by.values()].sort(
    (a, b) => SEVERITY[a.zone] - SEVERITY[b.zone] || b.count - a.count || b.pitch - a.pitch,
  );
}

/** ", which makes it comfortable" / ", which helps (still demanding)". */
function afterText(after: RangeCheck['verdict']): string {
  const label = VERDICT[after].label.toLowerCase();
  return after === 'comfortable' || after === 'mostly-comfortable'
    ? `, which makes it ${label}`
    : `, which helps (still ${label})`;
}

/** Verdict the part would get after moving it by `semitones`. */
function checkAfter(
  song: Song,
  track: Track,
  singer: SingerProfile,
  semitones: number,
): RangeCheck['verdict'] {
  const moved = { ...track, notes: track.notes.map((n) => ({ ...n, pitch: n.pitch + semitones })) };
  return checkSingerRange(song, moved, singer, { maxShift: 0 }).verdict;
}

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

type PitchField =
  'lowest' | 'comfortableLow' | 'comfortableHigh' | 'highest' | 'sweetLow' | 'sweetHigh' | 'falsettoHigh';

const FIELDS: { key: PitchField; label: string; hint?: string; optional?: boolean }[] = [
  { key: 'lowest', label: 'Lowest note', hint: 'The lowest they can sing at all' },
  { key: 'comfortableLow', label: 'Easy from' },
  { key: 'comfortableHigh', label: 'Easy up to' },
  { key: 'highest', label: 'Highest full-voice note', hint: 'Above “easy”: difficult but possible' },
  { key: 'sweetLow', label: 'Sweet spot from', optional: true },
  { key: 'sweetHigh', label: 'Sweet spot to', optional: true, hint: 'Where the voice sounds best' },
  { key: 'falsettoHigh', label: 'Falsetto / head voice up to', optional: true },
];

function NoteField({
  label,
  hint,
  value,
  optional,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number | undefined;
  optional?: boolean;
  onChange: (v: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? '' : midiToNoteName(value));
  useEffect(() => setText(value === undefined ? '' : midiToNoteName(value)), [value]);
  const parsed = text.trim() ? noteNameToMidi(text) : undefined;
  const invalid = parsed === null || (!optional && parsed === undefined);
  return (
    <Field label={label} hint={invalid ? 'A note name such as C3, F#4 or Bb2' : hint}>
      <TextInput
        mono
        value={text}
        placeholder={optional ? '—' : 'C3'}
        aria-label={label}
        aria-invalid={invalid || undefined}
        onChange={(v) => {
          setText(v);
          const p = v.trim() ? noteNameToMidi(v) : undefined;
          if (p !== null && (optional || p !== undefined)) onChange(p);
        }}
      />
    </Field>
  );
}

/** Create or edit a singer: start from a voice type, then set each zone by note name. */
export function SingerEditor({
  initial,
  title,
  onSave,
  onClose,
}: {
  initial: SingerProfile;
  title: string;
  onSave: (singer: SingerProfile) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SingerProfile>(initial);
  const [voice, setVoice] = useState<VoiceType>(initial.voiceType ?? 'tenor');
  const preview = normalizeSinger(draft);
  const set = (key: PitchField, v: number | undefined) => setDraft((d) => ({ ...d, [key]: v }));
  return (
    <Modal
      title={title}
      icon="mic"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" onClick={() => onSave(preview)} data-testid="singer-save">
            Save singer
          </Button>
        </>
      }
    >
      <div className="col" data-testid="singer-editor">
        <div className="grid-2">
          <Field label="Name">
            <TextInput
              value={draft.name}
              onChange={(name) => setDraft({ ...draft, name })}
              aria-label="Singer name"
            />
          </Field>
          <Field label="Voice type" hint="Fills in typical zones to adjust to the real singer">
            <div className="row">
              <Select
                value={voice}
                onChange={setVoice}
                options={(Object.keys(VOICE_TYPE_LABELS) as VoiceType[]).map((v) => ({
                  value: v,
                  label: VOICE_TYPE_LABELS[v],
                }))}
                aria-label="Voice type"
              />
              <Button
                size="sm"
                onClick={() =>
                  setDraft((d) => ({
                    id: d.id,
                    name: d.name,
                    notes: d.notes,
                    voiceType: voice,
                    ...VOICE_TYPE_ZONES[voice],
                  }))
                }
              >
                Use typical zones
              </Button>
            </div>
          </Field>
        </div>
        <RangeKeyboard singer={preview} height={64} />
        <ZoneLegend />
        <div className="small muted">{describeSinger(preview)}</div>
        <div className="singer-fields">
          {FIELDS.map((f) => (
            <NoteField
              key={f.key}
              label={f.label}
              hint={f.hint}
              optional={f.optional}
              value={draft[f.key]}
              onChange={(v) => set(f.key, v)}
            />
          ))}
        </div>
        <Field label="Notes" hint="Anything worth remembering, e.g. “belts up to A4 once warmed up”">
          <TextArea
            value={draft.notes ?? ''}
            onChange={(notes) => setDraft({ ...draft, notes })}
            rows={2}
            aria-label="Notes about the singer"
          />
        </Field>
      </div>
    </Modal>
  );
}

/** A vocal part (MIDI, or audio with MIDI made from it). */
export function isVocalPart(track: Track): boolean {
  return (
    (track.role === 'vocal' || track.stemGroup === 'vocals') && (track.kind === 'midi' || !!track.audioMidi)
  );
}

/** Track details: who sings the part, their zones and how the part sits in them. */
export function TrackSingerSection({ song, track }: { song: Song; track: Track }) {
  const [editing, setEditing] = useState(false);
  const singers = song.vocals.singers ?? [];
  const singer = singers.find((s) => s.id === track.vocal?.singerId);
  if (!isVocalPart(track)) return null;
  const voice: VoiceType = track.vocal?.voiceType ?? 'tenor';
  return (
    <div className="col" data-testid="track-singer" style={{ gap: 6 }}>
      <Field
        label="Singer"
        hint={singer ? undefined : 'Their range shows which notes are easy or out of reach'}
      >
        <div className="row wrap">
          <Select
            value={singer?.id ?? ''}
            onChange={(id) => assignSinger(track.id, id || undefined)}
            options={[
              { value: '', label: `Nobody in particular (${VOICE_TYPE_LABELS[voice].toLowerCase()})` },
              ...singers.map((s) => ({ value: s.id, label: s.name })),
            ]}
            aria-label="Singer"
            style={{ flex: '1 1 140px', minWidth: 0 }}
          />
          <Button size="sm" icon="plus" onClick={() => setEditing(true)}>
            New singer…
          </Button>
        </div>
      </Field>
      {singer && (
        <>
          <RangeKeyboard singer={singer} height={40} />
          <RangeCheckCard song={song} track={track} singer={singer} compact />
          {track.kind === 'midi' && (
            <div>
              <Button
                size="sm"
                variant="ghost"
                icon="music"
                onClick={() => {
                  useVocalSession.getState().set({ tab: 'singers', trackId: track.id });
                  useStudio.getState().setMode('vocals');
                }}
              >
                Singers and range check
              </Button>
            </div>
          )}
        </>
      )}
      {editing && (
        <SingerEditor
          initial={singerFromVoiceType(voice, { id: 'new', name: `${VOICE_TYPE_LABELS[voice]} singer` })}
          title="New singer"
          onClose={() => setEditing(false)}
          onSave={(s) => {
            addSinger(s, track.id);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}
