import { useMemo, useRef, useState } from 'react';
import {
  LockKeys,
  alignLyrics,
  createTimeMap,
  applyOperations,
  isLocked,
  isLyricsSectionLocked,
  lyricTokens,
  randomId,
  sectionLayout,
  validateLyricAlignment,
  wordsToPhonemes,
  type LyricAlignmentEntry,
  type LyricLine,
  type Project,
  type SectionSpan,
  type Song,
  type Track,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { aiLyrics, recordProvenance, sourceLabel } from '../../engine/ai';
import { artifactVersions, vocalMidiName, vocalPhrases, withRights } from '../../engine/vocal-model';
import { logVocalActivity, proposeVocal } from '../../engine/vocal-sync';
import { Badge, Button, Field, LockButton, Select, Spinner, TextInput, Toggle } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ProviderPicker } from '../shared/ProviderPicker';
import { useVocalSession } from './session';
import { errorText, locationBadge, playFrom, useResolvedProvider } from './shared';

/**
 * Lyrics (spec §33-§35, §48): per-section lyric editor with live syllable counts against the vocal
 * notes, phoneme preview, AI/placeholder lyric writing (honestly labelled), alignment of syllables
 * to notes and "fit the melody's rhythm to the lyrics" as a reviewable proposal. Lyric locks are
 * respected everywhere; authorship is recorded per line and in the rights metadata (spec §65).
 */

export function linesFor(song: Song, sectionId: string, trackId: string): LyricLine[] {
  return song.lyrics.filter((l) => l.sectionId === sectionId && (!l.trackId || l.trackId === trackId));
}

function replaceSectionLines(
  song: Song,
  sectionId: string,
  trackId: string,
  lines: LyricLine[],
): LyricLine[] {
  const order = new Map(song.sections.map((s, i) => [s.id, i] as const));
  const kept = song.lyrics.filter(
    (l) => !(l.sectionId === sectionId && (!l.trackId || l.trackId === trackId)),
  );
  const idx = order.get(sectionId) ?? Infinity;
  let at = kept.findIndex((l) => (order.get(l.sectionId) ?? Infinity) > idx);
  if (at < 0) at = kept.length;
  return [...kept.slice(0, at), ...lines, ...kept.slice(at)];
}

/** Attach lyric syllables to the vocal notes (alignLyrics 'assign'), validated and lock-safe. */
export function alignInto(
  song: Song,
  trackId: string,
  sectionIds?: string[],
): { song: Song; report: LyricAlignmentEntry[]; warnings: string[]; errors: string[] } {
  const r = alignLyrics(song, trackId, { mode: 'assign', sectionIds });
  if (!r.operations.length) return { song, report: r.report, warnings: r.warnings, errors: [] };
  const applied = applyOperations(song, r.operations, {
    customInstruments: useSettings.getState().customInstruments,
  });
  const errors = applied.report.issues
    .filter((i) => i.severity === 'error' && !i.fixed)
    .map((i) => i.message);
  return { song: applied.song, report: r.report, warnings: r.warnings, errors };
}

interface LineStat {
  syllables: number;
  notes: number;
  status: LyricAlignmentEntry['status'] | 'empty';
}

/** Syllables per draft line vs. the vocal notes alignment would give it. */
function lineStats(song: Song, track: Track, sectionId: string, texts: string[]): LineStat[] {
  const tmp: LyricLine[] = [];
  texts.forEach((t, i) => {
    if (t.trim()) tmp.push({ id: `__draft${i}`, sectionId, text: t, trackId: track.id });
  });
  let report: LyricAlignmentEntry[] = [];
  try {
    report = alignLyrics({ ...song, lyrics: replaceSectionLines(song, sectionId, track.id, tmp) }, track.id, {
      sectionIds: [sectionId],
    }).report;
  } catch {
    report = [];
  }
  return texts.map((t, i) => {
    if (!t.trim()) return { syllables: 0, notes: 0, status: 'empty' as const };
    const e = report.find((r) => r.lineId === `__draft${i}`);
    return e
      ? { syllables: e.syllables, notes: e.notes, status: e.status }
      : { syllables: lyricTokens(t).length, notes: 0, status: 'too-many-syllables' as const };
  });
}

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ko', label: 'Korean' },
];

function authorLabel(author: string | undefined): { label: string; tone?: 'ai' | 'warning' } {
  if (!author || author === 'human') return { label: 'you' };
  if (author === 'placeholder') return { label: 'placeholder', tone: 'warning' };
  return { label: 'AI', tone: 'ai' };
}

function SectionLyrics({
  song,
  track,
  span,
  noteCount,
  onCommit,
}: {
  song: Song;
  track: Track;
  span: SectionSpan;
  noteCount: number;
  onCommit: (span: SectionSpan, texts: string[]) => void;
}) {
  const lines = linesFor(song, span.section.id, track.id);
  const original = lines.map((l) => l.text).join('\n');
  const [draft, setDraft] = useState(original);
  const prev = useRef(original);
  if (prev.current !== original) {
    prev.current = original;
    if (draft !== original) setDraft(original);
  }
  const [caret, setCaret] = useState<number | null>(null);
  const locked = isLyricsSectionLocked(song, span.section.id);
  const texts = draft.split('\n');
  const stats = useMemo(
    () => lineStats(song, track, span.section.id, texts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [song, track, span.section.id, draft],
  );
  const syl = stats.reduce((a, s) => a + s.syllables, 0);
  const mismatched = stats.filter(
    (s) => s.status === 'too-many-syllables' || s.status === 'too-few-syllables',
  ).length;
  const focusLine =
    caret !== null && texts[caret]?.trim() ? texts[caret] : (texts.find((t) => t.trim()) ?? '');
  const focusIndex = caret !== null && texts[caret]?.trim() ? caret : texts.findIndex((t) => t.trim());
  const st = useStudio.getState();
  const updateCaret = (el: HTMLTextAreaElement) =>
    setCaret(el.value.slice(0, el.selectionStart).split('\n').length - 1);
  const bars = `${span.startBar + 1}–${span.endBar}`;

  return (
    <div
      className={`vx-lyric-section ${locked ? 'locked' : ''}`}
      data-testid="lyric-section"
      data-section={span.section.name}
    >
      <div className="vx-lyric-head">
        <strong>{span.section.name}</strong>
        <span className="small dim">bars {bars}</span>
        <Badge title="Vocal notes in this section">{noteCount} notes</Badge>
        {lines.length > 0 && (
          <Badge
            tone={mismatched ? 'warning' : syl === noteCount ? 'success' : undefined}
            title="Lyric syllables vs vocal notes"
          >
            {syl} syl / {noteCount} notes
          </Badge>
        )}
        <div className="spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon="play"
          title={`Play from ${span.section.name}`}
          onClick={() => playFrom(createTimeMap(song).tickToSeconds(span.startTick))}
          aria-label={`Play ${span.section.name}`}
        />
        <LockButton
          locked={locked}
          onToggle={() =>
            st.toggleLock(
              LockKeys.sectionLyrics(span.section.id),
              `${locked ? 'Unlocked' : 'Locked'} lyrics of ${span.section.name}`,
            )
          }
          title={
            locked ? `Lyrics of ${span.section.name} are locked` : `Lock the lyrics of ${span.section.name}`
          }
        />
      </div>
      <div className="vx-lyric-body">
        <textarea
          className="vx-lyric-text"
          wrap="off"
          spellCheck
          rows={Math.max(2, texts.length + (locked ? 0 : 1))}
          value={draft}
          readOnly={locked}
          placeholder={
            noteCount ? `Write the lines for ${span.section.name} — one line per row` : 'No vocal notes here'
          }
          aria-label={`Lyrics for ${span.section.name}`}
          onChange={(e) => {
            setDraft(e.target.value);
            updateCaret(e.target);
          }}
          onSelect={(e) => updateCaret(e.currentTarget)}
          onFocus={(e) => updateCaret(e.currentTarget)}
          onBlur={() => {
            if (draft !== original) onCommit(span, texts);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
            if (e.key === 'Escape') setDraft(original);
          }}
        />
        <div className="vx-gutter" role="group" aria-label={`Syllable counts for ${span.section.name}`}>
          {texts.map((t, i) => {
            const s = stats[i];
            const line = lines[i];
            const edited = !line || line.text !== t;
            const author = authorLabel(edited ? 'human' : line.author);
            if (!s || s.status === 'empty') return <div key={i} className="vx-gutter-row" />;
            const diff = s.syllables - s.notes;
            return (
              <div
                key={i}
                className={`vx-gutter-row ${s.status === 'aligned' ? 'ok' : s.status === 'too-many-syllables' ? 'err' : 'warn'} ${caret === i ? 'focus' : ''}`}
                title={`${s.syllables} syllables · ${s.notes} vocal notes${s.status === 'too-many-syllables' ? ' — too many syllables: adjacent syllables will be merged on one note' : s.status === 'too-few-syllables' ? ' — fewer syllables than notes: the extra notes become melismas (“_”)' : ' — one syllable per note'}`}
                data-testid="syllable-count"
              >
                <span className="mono">
                  {s.syllables}/{s.notes}
                </span>
                <span className="vx-gutter-diff">
                  {s.status === 'aligned' ? '✓' : diff > 0 ? `+${diff} syl` : `${diff} syl`}
                </span>
                <span className={`vx-author ${author.tone ?? ''}`}>{author.label}</span>
              </div>
            );
          })}
        </div>
      </div>
      {focusLine && (
        <div className="vx-phonemes small" aria-label="Phoneme preview" data-testid="phoneme-preview">
          <span className="dim">Line {focusIndex + 1}:</span>{' '}
          <span className="mono">
            {lyricTokens(focusLine)
              .map((t) => t.text.replace(/-$/, '·'))
              .join(' ')
              .replace(/· /g, '·')}
          </span>
          <span className="dim"> → </span>
          {wordsToPhonemes(focusLine).map((w, i) => (
            <span key={i} className="vx-ph" title={w.word}>
              {w.phonemes.join(' ')}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function AlignmentReport({ song, track }: { song: Song; track: Track }) {
  const alignment = useVocalSession((s) => s.alignment);
  const validation = useMemo(() => validateLyricAlignment(song, track.id), [song, track.id]);
  // The table always describes the current song (e.g. after a fit-rhythm proposal was accepted).
  const liveReport = useMemo(
    () => (alignment ? alignLyrics(song, track.id).report : []),
    [song, track.id, alignment],
  );
  const hasLyrics = song.lyrics.some((l) => !l.trackId || l.trackId === track.id);
  if (!alignment && !hasLyrics) {
    return (
      <div className="callout small" data-testid="lyric-validation">
        No lyrics yet — write them below (or let the lyricist draft them); their syllables are attached to the
        vocal notes so the singer knows what to sing.
      </div>
    );
  }
  if (!alignment) {
    return (
      <div
        className={`callout ${validation.ok ? 'success' : 'warning'} small`}
        data-testid="lyric-validation"
      >
        <strong>Lyrics ↔ vocal events (spec §48): </strong>
        {validation.ok
          ? 'every syllable sits on a vocal note.'
          : `${validation.issues.length} issue${validation.issues.length === 1 ? '' : 's'} — ${validation.issues[0]}`}
      </div>
    );
  }
  const names = new Map(song.sections.map((s) => [s.id, s.name] as const));
  const bySection = new Map<string, LyricAlignmentEntry[]>();
  for (const e of liveReport) bySection.set(e.sectionId, [...(bySection.get(e.sectionId) ?? []), e]);
  const aligned = liveReport.filter((e) => e.status === 'aligned').length;
  return (
    <div className="card vx-report" data-testid="alignment-report">
      <div className="row between" style={{ marginBottom: 6 }}>
        <strong>Alignment report</strong>
        <span className="small muted">
          {alignment.mode === 'fit-rhythm'
            ? 'Fit rhythm proposed'
            : alignment.applied
              ? 'Syllables attached'
              : 'Syllables already attached'}{' '}
          · {aligned}/{liveReport.length} lines one-syllable-per-note
        </span>
      </div>
      <table className="table" aria-label="Lyric alignment report">
        <thead>
          <tr>
            <th>Section</th>
            <th className="num">Lines</th>
            <th className="num">Syllables</th>
            <th className="num">Notes</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {[...bySection.entries()].map(([sid, rows]) => {
            const syl = rows.reduce((a, r) => a + r.syllables, 0);
            const notes = rows.reduce((a, r) => a + r.notes, 0);
            const many = rows.filter((r) => r.status === 'too-many-syllables').length;
            const few = rows.filter((r) => r.status === 'too-few-syllables').length;
            return (
              <tr key={sid}>
                <td>{names.get(sid) ?? sid}</td>
                <td className="num">{rows.length}</td>
                <td className="num">{syl}</td>
                <td className="num">{notes}</td>
                <td className="small">
                  {!many && !few ? (
                    <Badge tone="success">aligned</Badge>
                  ) : (
                    <>
                      {many > 0 && (
                        <Badge tone="danger">
                          {many} line{many > 1 ? 's' : ''}: syllables merged
                        </Badge>
                      )}{' '}
                      {few > 0 && (
                        <Badge tone="warning">
                          {few} line{few > 1 ? 's' : ''}: melismas
                        </Badge>
                      )}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {[...alignment.warnings].slice(0, 4).map((w, i) => (
        <div key={i} className="small" style={{ color: 'var(--warning)' }}>
          ⚠ {w}
        </div>
      ))}
      <div
        className={`small ${validation.ok ? '' : 'muted'}`}
        style={{ marginTop: 6 }}
        data-testid="lyric-validation"
      >
        <Icon name={validation.ok ? 'check' : 'alert'} size={12} /> Validation (spec §48):{' '}
        {validation.ok
          ? 'lyrics align with the vocal events.'
          : `${validation.issues.length} issue${validation.issues.length === 1 ? '' : 's'}: ${validation.issues.slice(0, 2).join(' ')}`}
      </div>
    </div>
  );
}

export function LyricsPanel({ project, track }: { project: Project; track: Track }) {
  const song = project.song;
  const session = useVocalSession();
  const userName = useSettings((s) => s.userName);
  const lyricist = useResolvedProvider('lyrics', session.lyricsProvider);
  const [busy, setBusy] = useState<string | null>(null);
  const st = useStudio.getState();
  const spans = sectionLayout(song);
  const countIn = (span: SectionSpan) =>
    track.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick).length;
  const shown = spans.filter((s) => countIn(s) > 0 || linesFor(song, s.section.id, track.id).length > 0);
  const hidden = spans.length - shown.length;
  const allLocked = isLocked(song.locks, LockKeys.lyrics);
  const theme = session.lyricsTheme || song.blueprint?.lyricsTheme || '';

  const latest = () => useStudio.getState().project?.song ?? song;

  const commitSection = (span: SectionSpan, texts: string[]) => {
    const cur = latest();
    if (isLyricsSectionLocked(cur, span.section.id)) {
      st.toast('warning', `The lyrics of ${span.section.name} are locked.`);
      return;
    }
    const old = linesFor(cur, span.section.id, track.id);
    const used = new Set<string>();
    const clean = texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const next: LyricLine[] = clean.map((text, i) => {
      const same =
        old[i] && old[i].text === text && !used.has(old[i].id)
          ? old[i]
          : old.find((o) => o.text === text && !used.has(o.id));
      if (same) {
        used.add(same.id);
        return same;
      }
      return { id: randomId('ly'), sectionId: span.section.id, text, trackId: track.id, author: 'human' };
    });
    let song2: Song = { ...cur, lyrics: replaceSectionLines(cur, span.section.id, track.id, next) };
    if (session.autoAlign) song2 = alignInto(song2, track.id, [span.section.id]).song;
    st.commit(
      song2,
      `Lyrics: ${span.section.name}${session.autoAlign ? ' (syllables re-attached)' : ''}`,
      'lyrics',
    );
    if (next.some((l) => l.author === 'human' && !old.includes(l)))
      st.updateProject((p) => withRights(p, { lyricWriters: [userName || 'Me'] }));
    logVocalActivity('lyrics', `Edited the lyrics of ${span.section.name}`);
  };

  const write = async () => {
    const cur = latest();
    const targets = sectionLayout(cur).filter(
      (s) =>
        countIn(s) > 0 &&
        !isLyricsSectionLocked(cur, s.section.id) &&
        (session.lyricsScope === 'all' || linesFor(cur, s.section.id, track.id).length === 0),
    );
    if (!targets.length) {
      st.toast(
        'info',
        session.lyricsScope === 'empty'
          ? 'Every sung section already has lyrics — choose “All unlocked sections” to rewrite them.'
          : 'Every sung section has locked lyrics.',
      );
      return;
    }
    const phrases = vocalPhrases(cur, track);
    const req = targets.map((s) => {
      const ph = phrases.filter((p) => p.sectionId === s.section.id);
      const n = Math.max(1, Math.min(8, ph.length || Math.round((s.endBar - s.startBar) / 2)));
      return {
        sectionId: s.section.id,
        name: s.section.name,
        kind: s.section.kind,
        lines: n,
        syllables: ph.slice(0, n).map((p) => Math.max(2, p.noteIds.length)),
        existing: linesFor(cur, s.section.id, track.id).map((l) => l.text),
        locked: false,
      };
    });
    setBusy('Writing lyrics…');
    try {
      const res = await aiLyrics(cur, req, {
        providerChoice: session.lyricsProvider,
        theme: theme || undefined,
        style: cur.blueprint?.moods.join(', '),
      });
      const placeholder = res.provenance.location === 'internal';
      const author = placeholder ? 'placeholder' : res.provenance.providerId;
      let song2 = latest();
      let lines = 0;
      for (const out of res.sections) {
        const texts = out.lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
        if (!texts.length || isLyricsSectionLocked(song2, out.sectionId)) continue;
        lines += texts.length;
        const fresh: LyricLine[] = texts.map((text) => ({
          id: randomId('ly'),
          sectionId: out.sectionId,
          text,
          trackId: track.id,
          author,
        }));
        song2 = { ...song2, lyrics: replaceSectionLines(song2, out.sectionId, track.id, fresh) };
      }
      if (!lines) {
        st.toast('warning', 'The lyricist returned no lines.');
        return;
      }
      const sectionIds = res.sections.map((s) => s.sectionId);
      if (session.autoAlign) song2 = alignInto(song2, track.id, sectionIds).song;
      st.commit(
        song2,
        `Lyrics written by ${placeholder ? 'the on-device placeholder engine' : res.provenance.providerName} (${sectionIds.length} sections${session.autoAlign ? ', syllables attached' : ''})`,
        'lyrics',
      );
      const project2 = useStudio.getState().project!;
      const v = artifactVersions(project2, track.id);
      recordProvenance(res.provenance, {
        artifactId: `lyrics:${project2.song.id}:v${v.lyrics}`,
        artifactName: 'lyrics.txt',
        artifactKind: 'lyrics',
        sources: [{ kind: 'midi', ref: vocalMidiName(project2.song, track.id), revision: v.midi }],
        parameters: {
          version: v.lyrics,
          sections: targets.map((s) => s.section.name),
          lines,
          theme: theme || undefined,
          placeholder,
          notes: res.notes,
        },
      });
      st.updateProject((p) =>
        withRights(p, {
          lyricWriters: [
            placeholder
              ? 'Placeholder lyrics (Song Deck on-device engine)'
              : `${res.provenance.providerName} (AI)`,
          ],
        }),
      );
      session.set({
        lastLyrics: {
          source: sourceLabel(res.provenance),
          placeholder,
          notes: res.notes,
          sections: sectionIds.length,
          lines,
        },
      });
      logVocalActivity(
        'lyrics',
        `${placeholder ? 'Placeholder lyrics' : 'Lyrics'} for ${sectionIds.length} sections (${res.provenance.providerName})`,
      );
      st.toast(
        placeholder ? 'info' : 'success',
        `${lines} lines written into ${sectionIds.length} sections${placeholder ? ' — placeholder quality' : ''}.`,
      );
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError'))
        st.toast('error', `Lyrics failed: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const align = () => {
    const cur = latest();
    const r = alignInto(cur, track.id);
    const applied = r.song !== cur;
    if (applied)
      st.commit(r.song, 'Aligned the lyrics to the vocal melody (syllables attached to notes)', 'lyrics');
    const issues = validateLyricAlignment(r.song, track.id).issues;
    session.set({
      alignment: {
        at: new Date().toISOString(),
        mode: 'assign',
        report: r.report,
        warnings: [...r.warnings, ...r.errors],
        issues,
        applied,
      },
    });
    if (!r.report.length) st.toast('info', 'There are no lyric lines to align yet — write lyrics first.');
    else
      st.toast(
        applied ? 'success' : 'info',
        applied
          ? `Aligned ${r.report.length} lyric lines to the melody.`
          : 'The lyrics were already aligned.',
      );
    logVocalActivity(
      'lyrics',
      `Aligned lyrics (${r.report.filter((e) => e.status === 'aligned').length}/${r.report.length} lines exact)`,
    );
  };

  const fitRhythm = () => {
    const cur = latest();
    const r = alignLyrics(cur, track.id, { mode: 'fit-rhythm' });
    const issues = validateLyricAlignment(cur, track.id).issues;
    session.set({
      alignment: {
        at: new Date().toISOString(),
        mode: 'fit-rhythm',
        report: r.report,
        warnings: r.warnings,
        issues,
        applied: false,
      },
    });
    if (!r.operations.length) {
      st.toast('info', r.report.length ? 'The melody already fits the lyrics.' : 'Write lyrics first.');
      return;
    }
    const p = proposeVocal(
      cur,
      r.operations,
      {
        title: 'Fit the vocal rhythm to the lyrics',
        source: 'internal',
        instruction: 'Fit melody rhythm to lyrics',
        explanation: 'Notes are split or merged (contour kept) so every lyric syllable gets its own note.',
      },
      {
        projectId: project.meta.id,
        trackId: track.id,
        kind: 'fit-rhythm',
        title: 'Fit the vocal rhythm to the lyrics',
        reason: 'fit rhythm to lyrics',
      },
    );
    if ('error' in p) st.toast('info', p.error);
    else st.toast('success', 'Proposal ready — review it in the panel on the right.');
  };

  return (
    <div className="col" style={{ gap: 12 }} data-testid="lyrics-panel">
      <div className="panel">
        <div className="panel-header">
          <Icon name="sparkles" />
          <h3 className="grow">Write lyrics</h3>
          {locationBadge(lyricist)}
        </div>
        <div className="panel-body col">
          <div className="vx-write-grid">
            <Field label="Lyricist">
              <ProviderPicker
                role="lyrics"
                value={session.lyricsProvider}
                onChange={(v) => session.set({ lyricsProvider: v })}
              />
            </Field>
            <Field label="Theme">
              <TextInput
                value={session.lyricsTheme}
                onChange={(v) => session.set({ lyricsTheme: v })}
                placeholder={
                  song.blueprint?.lyricsTheme || song.blueprint?.moods.join(', ') || 'e.g. leaving home'
                }
                aria-label="Lyrics theme"
              />
            </Field>
            <Field label="Language">
              <Select
                value={LANGUAGES.some((l) => l.value === song.vocals.language) ? song.vocals.language : 'en'}
                onChange={(language) => {
                  const cur = useStudio.getState().project?.song;
                  if (cur && cur.vocals.language !== language)
                    st.commit(
                      { ...cur, vocals: { ...cur.vocals, language } },
                      `Vocal language → ${language}`,
                      'vocals',
                    );
                }}
                options={LANGUAGES}
                aria-label="Vocal language"
              />
            </Field>
            <Field label="Write into">
              <Select
                value={session.lyricsScope}
                onChange={(v) => session.set({ lyricsScope: v })}
                options={[
                  { value: 'empty', label: 'Sections without lyrics' },
                  { value: 'all', label: 'All unlocked sections' },
                ]}
                aria-label="Write lyrics into"
              />
            </Field>
            <div className="field" style={{ justifyContent: 'flex-end' }}>
              <Button
                variant="ai"
                icon="sparkles"
                onClick={() => void write()}
                disabled={!!busy || allLocked}
              >
                {busy ? <Spinner /> : 'Write lyrics'}
              </Button>
            </div>
          </div>
          {lyricist?.providerId === 'internal-composer' && !session.lastLyrics ? (
            <div className="small muted">
              No language model is configured for lyrics, so the on-device engine will write{' '}
              <strong>placeholder</strong> lyrics — rhymed and fitted to each phrase&apos;s syllable count so
              you can hear the melody sung, but generic.
            </div>
          ) : (
            !session.lastLyrics && (
              <div className="small dim">
                Auto follows your routing rules; the on-device engine always works offline.
              </div>
            )
          )}
          {song.vocals.language !== 'en' && (
            <div className="small" style={{ color: 'var(--warning)' }}>
              The built-in syllable counter, phonemes, placeholder lyricist and formant singer are
              English-only —{' '}
              {LANGUAGES.find((l) => l.value === song.vocals.language)?.label ?? song.vocals.language} needs a
              lyricist and singing provider that support it (the language is sent with every request).
            </div>
          )}
          {session.lastLyrics && (
            <div
              className={`callout ${session.lastLyrics.placeholder ? 'warning' : 'success'} small`}
              data-testid="lyrics-source"
            >
              <strong>{session.lastLyrics.placeholder ? 'Placeholder lyrics' : 'Lyrics written'}</strong> ·{' '}
              {session.lastLyrics.source} · {session.lastLyrics.lines} lines in {session.lastLyrics.sections}{' '}
              sections.
              {session.lastLyrics.placeholder ? (
                <div>
                  These are stock phrases from the on-device engine, not real lyric writing — configure a
                  language model in Settings → AI providers, or write your own below. Lines are marked{' '}
                  <em>placeholder</em> until you edit them.
                </div>
              ) : (
                session.lastLyrics.notes && <div>{session.lastLyrics.notes}</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <Icon name="book" />
          <h3 className="grow">Lyrics ↔ vocal melody</h3>
          <Toggle
            on={session.autoAlign}
            onChange={(v) => session.set({ autoAlign: v })}
            label="Re-attach syllables after edits"
            title="After writing or editing a section, attach its syllables to the vocal notes"
          />
          <LockButton
            locked={allLocked}
            onToggle={() => st.toggleLock(LockKeys.lyrics, `${allLocked ? 'Unlocked' : 'Locked'} all lyrics`)}
            title={allLocked ? 'All lyrics are locked' : 'Lock all lyrics'}
          />
        </div>
        <div className="panel-body col">
          <div className="row wrap">
            <Button
              variant="primary"
              icon="music"
              onClick={align}
              title="Attach one syllable per note (melismas “_” for extra notes, merged syllables for missing notes)"
            >
              Align lyrics to melody
            </Button>
            <Button
              icon="midi"
              onClick={fitRhythm}
              title="Split / merge notes so every syllable has a note — as a proposal"
            >
              Fit melody rhythm to lyrics
            </Button>
            <span className="small dim">
              {track.name} · {vocalMidiName(song, track.id)} ·{' '}
              {song.lyrics.filter((l) => !l.trackId || l.trackId === track.id).length} lines
            </span>
          </div>
          <AlignmentReport song={song} track={track} />
        </div>
      </div>

      <div className="col" style={{ gap: 10 }}>
        {shown.map((span) => (
          <SectionLyrics
            key={span.section.id}
            song={song}
            track={track}
            span={span}
            noteCount={countIn(span)}
            onCommit={commitSection}
          />
        ))}
        {hidden > 0 && (
          <div className="small dim">
            {hidden} section{hidden === 1 ? '' : 's'} without vocal notes (
            {spans
              .filter((s) => !shown.includes(s))
              .map((s) => s.section.name)
              .join(', ')}
            ).
          </div>
        )}
        {!shown.length && (
          <div className="small muted">
            The vocal track has no notes yet — generate a vocal melody in the Melody tab.
          </div>
        )}
      </div>
    </div>
  );
}
