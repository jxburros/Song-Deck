import { useMemo } from 'react';
import {
  builderGenre,
  countSyllables,
  getTag,
  lyricSectionBars,
  parseLyricSheet,
  suggestMoodsFromLyrics,
  tempoForFeel,
  type SectionKind,
} from '@songdeck/core';
import type { RoleRoute } from '../../engine/ai';
import { Badge, Button, Select, TextArea, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { useCustomGenres } from '../../hooks';
import { SECTION_KINDS } from './BlueprintEditor';
import { choicesFromDraft, draftLyrics, useComposeSession } from './session';

const EXAMPLE = `[Verse 1]
Under the streetlights I wait for the rain
Counting the cars as they carry my name

[Chorus]
Hold on, hold on to me
We were never meant to be free

[Verse 2]
…

[Chorus]`;

const KIND_OPTIONS = SECTION_KINDS.filter((k) => k !== 'custom').map((k) => ({ value: k, label: k }));

/**
 * Lyrics-first input: paste the words (with or without [Verse]/[Chorus] headers), see the detected
 * sections with their syllables and bars, correct a section's kind, and take mood suggestions.
 * The words are never changed; they are sung and locked in the composed song.
 */
export function LyricsInput({
  onSuggest,
  route,
  busy,
}: {
  onSuggest?: () => void;
  route: RoleRoute | null;
  busy: string | null;
}) {
  const session = useComposeSession();
  const { draft, patch } = session;
  const customGenres = useCustomGenres();
  const parsed = useMemo(
    () => (draft.lyricsText.trim() ? parseLyricSheet(draft.lyricsText) : null),
    [draft.lyricsText],
  );
  const lyrics = useMemo(() => draftLyrics(draft), [draft]);
  const genre = useMemo(
    () => builderGenre(choicesFromDraft(draft, lyrics), customGenres),
    [draft, lyrics, customGenres],
  );
  const tempo =
    draft.tempo === 'bpm'
      ? draft.bpm
      : draft.tempo === 'auto'
        ? Math.round(genre.tempo.typical)
        : tempoForFeel(draft.tempo, genre);
  const meter =
    draft.meter === 'auto'
      ? undefined
      : { numerator: Number(draft.meter.split('/')[0]), denominator: Number(draft.meter.split('/')[1]) };
  const mood = useMemo(
    () => (draft.lyricsText.trim() ? suggestMoodsFromLyrics(draft.lyricsText, 4) : null),
    [draft.lyricsText],
  );
  const newMoods = mood?.moods.filter((id) => !draft.moods.some((m) => m.tagId === id)) ?? [];

  return (
    <div className="col" style={{ gap: 12 }} data-testid="lyrics-input">
      <div className="panel">
        <div className="panel-header">
          <Icon name="book" />
          <h3 className="grow">Your lyrics</h3>
          <Toggle
            on={draft.lockLyrics}
            onChange={(lockLyrics) => patch({ lockLyrics })}
            label="Lock my lyrics"
            title="Locked lyrics are never rewritten by AI or regeneration"
          />
        </div>
        <div className="panel-body col">
          <TextArea
            value={draft.lyricsText}
            onChange={(lyricsText) => patch({ lyricsText, lyricKinds: {} })}
            rows={12}
            aria-label="Lyrics"
            placeholder={EXAMPLE}
            spellCheck
            className="textarea cb-lyrics-text"
          />
          <div className="small muted">
            <Icon name="info" size={12} /> Paste the whole song. Headers like [Verse 1], [Chorus], Chorus x2
            or (Bridge) are understood; without them, repeated stanzas become the chorus. Chord lines and
            stage directions are ignored — your words are never changed.
          </div>
        </div>
      </div>

      {parsed && (
        <div className="panel" data-testid="lyrics-preview">
          <div className="panel-header">
            <h3 className="grow">Detected sections</h3>
            <span className="small muted">at {tempo} BPM</span>
          </div>
          <div className="panel-body col">
            {parsed.sections.length === 0 && <div className="small muted">No lyric lines found yet.</div>}
            {parsed.sections.map((s, i) => {
              const kind = draft.lyricKinds[i] ?? s.kind;
              const syl = s.lines.reduce((t, l) => t + countSyllables(l), 0);
              const bars = s.lines.length ? lyricSectionBars(s.lines, tempo, meter) : null;
              return (
                <div key={i} className="cb-lyric-row" data-testid="lyric-preview-section" data-kind={kind}>
                  <Select
                    size="sm"
                    aria-label={`Kind of section ${i + 1} (${s.name})`}
                    value={kind}
                    onChange={(v: SectionKind) => patch({ lyricKinds: { ...draft.lyricKinds, [i]: v } })}
                    options={KIND_OPTIONS}
                  />
                  <div className="cb-lyric-meta">
                    <strong>{s.name}</strong>
                    <span className="small muted">
                      {s.lines.length
                        ? `${s.lines.length} line${s.lines.length > 1 ? 's' : ''} · ${syl} syllables · ${bars} bars`
                        : 'instrumental'}
                    </span>
                  </div>
                  <div className="cb-lyric-first small dim ellipsis" title={s.lines.join('\n')}>
                    {s.lines[0] ?? '—'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {mood && (
        <div className="panel" data-testid="lyrics-moods">
          <div className="panel-header">
            <Icon name="sparkles" />
            <h3 className="grow">What the words feel like</h3>
            {onSuggest && (
              <Button size="sm" variant="ai" icon="sparkles" disabled={!!busy || !lyrics} onClick={onSuggest}>
                {busy ?? `Suggest genres & tags with ${route?.providerName ?? 'the model'}`}
              </Button>
            )}
          </div>
          <div className="panel-body col">
            {mood.evidence === 0 ? (
              <div className="small muted">No strong mood words found — pick moods on the Sound tab.</div>
            ) : (
              <div className="row wrap small">
                <span className="muted">
                  {mood.valence < -0.2 ? 'Darker' : mood.valence > 0.2 ? 'Brighter' : 'Mixed'} ·{' '}
                  {mood.arousal < 0.35 ? 'calm' : mood.arousal > 0.65 ? 'intense' : 'moderate'} (from “
                  {mood.keywords.slice(0, 4).join('”, “')}”)
                </span>
                {newMoods.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="chip"
                    onClick={() => patch({ moods: [...draft.moods, { tagId: id }] })}
                    title="Add this mood"
                  >
                    <Icon name="plus" size={10} /> {getTag(id)?.name ?? id}
                  </button>
                ))}
                {draft.tempo === 'auto' && (
                  <button
                    type="button"
                    className="chip"
                    onClick={() => patch({ tempo: mood.tempoFeel })}
                    title="Use this tempo feel"
                  >
                    <Icon name="metronome" size={10} /> {mood.tempoFeel} tempo
                  </button>
                )}
                {!newMoods.length && mood.moods.length > 0 && <Badge tone="success">moods added</Badge>}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="row">
        <div className="spacer" />
        <Button icon="chevronRight" onClick={() => session.set({ tab: 'sound' })} disabled={!lyrics}>
          Next: choose the sound
        </Button>
      </div>
    </div>
  );
}
