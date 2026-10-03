import { useState } from 'react';
import {
  ROLE_COLORS,
  LockKeys,
  isTrackSectionLocked,
  midiToNoteName,
  randomSeed,
  regenerateUnlocked,
  sectionLayout,
  songLengthTicks,
  trackToMidi,
  type Project,
  type Track,
  type VariationLevel,
  type VoiceType,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { downloadBytes } from '../../engine/capture-files';
import { activeRender, lyricsOfTrack, vocalMidiName } from '../../engine/vocal-model';
import { logVocalActivity, requestResing, useVocalJobs } from '../../engine/vocal-sync';
import { Badge, Button, Field, LockButton, Select } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { NoteStrip } from '../shared/NoteStrip';
import { errorText } from './shared';

const VOICE_TYPES: { value: VoiceType; label: string }[] = [
  { value: 'soprano', label: 'Soprano' },
  { value: 'mezzo', label: 'Mezzo-soprano' },
  { value: 'alto', label: 'Alto' },
  { value: 'tenor', label: 'Tenor' },
  { value: 'baritone', label: 'Baritone' },
  { value: 'bass', label: 'Bass' },
];

type Level = 'fresh' | Extract<VariationLevel, 'ornament'>;

/**
 * 'variation' / 'reinterpretation' keep the song's principal melody (the lead vocal) and
 * 'mutation' re-plans the harmony, so vocal-only regeneration offers a fresh pass or ornaments.
 */
const LEVELS: { value: Level; label: string }[] = [
  { value: 'fresh', label: 'New melody (fresh pass)' },
  { value: 'ornament', label: 'Ornament (embellish only)' },
];

/**
 * Vocal melody (spec §16 "Vocal Melody", Phase 4 "vocal melody"): vocal.mid at a glance and
 * regeneration of the vocal track only — whole or per section — with the composer's
 * `regenerateUnlocked` restricted to this track, so locks hold and nothing else changes.
 */
export function MelodyPanel({ project, track }: { project: Project; track: Track }) {
  const song = project.song;
  const st = useStudio.getState();
  const customInstruments = useSettings((s) => s.customInstruments);
  const autoResing = useVocalJobs((s) => s.autoResing);
  const [level, setLevel] = useState<Level>('fresh');
  const [focus, setFocus] = useState<string | null>(null);
  const spans = sectionLayout(song);
  const pitches = track.notes.map((n) => n.pitch);
  const low = pitches.length ? Math.min(...pitches) : null;
  const high = pitches.length ? Math.max(...pitches) : null;
  const render = activeRender(project, track.id);
  const focusSpan = spans.find((s) => s.section.id === focus);
  const lines = lyricsOfTrack(song, track.id);
  const midiName = vocalMidiName(song, track.id);

  const regenerate = (sectionIds?: string[]) => {
    const cur = useStudio.getState().project?.song;
    if (!cur) return;
    try {
      const seed = randomSeed();
      const res = regenerateUnlocked(cur, { seed, trackIds: [track.id], sectionIds, level: level === 'fresh' ? undefined : level, customInstruments });
      const changed = res.changed.find((c) => c.trackId === track.id)?.sectionIds ?? [];
      if (!changed.length) {
        st.toast('info', 'Nothing to regenerate — the vocal is locked there.');
        return;
      }
      const names = cur.sections.filter((s) => changed.includes(s.id)).map((s) => s.name);
      const where = sectionIds?.length ? ` in ${names.join(', ')}` : '';
      st.commit(res.song, `Regenerated the vocal melody${where}${level === 'ornament' ? ' (ornaments)' : ''} · seed ${seed}`, 'vocals');
      logVocalActivity('melody', `Regenerated the vocal melody${where || ' (all unlocked sections)'} · seed ${seed}`);
      let resung = 0;
      if (render && autoResing) {
        for (const span of sectionLayout(res.song).filter((s) => changed.includes(s.section.id))) {
          if (requestResing({ projectId: project.meta.id, trackId: track.id, startTick: span.startTick, endTick: span.endTick, label: span.section.name, reason: 'new vocal melody' })) resung++;
        }
      }
      st.toast('success', `New vocal melody${where}; instrumentation, chords and lyrics untouched${resung ? ` — re-singing ${resung} section${resung === 1 ? '' : 's'}` : ''}.`);
    } catch (err) {
      st.toast('error', `Regeneration failed: ${errorText(err)}`);
    }
  };

  const setVoiceType = (voiceType: VoiceType) => {
    const cur = useStudio.getState().project?.song;
    if (!cur) return;
    st.commit({ ...cur, tracks: cur.tracks.map((t) => (t.id === track.id ? { ...t, vocal: { ...(t.vocal ?? {}), voiceType } } : t)) }, `${track.name}: voice type → ${voiceType}`, 'vocals');
  };

  const openPianoRoll = () => {
    st.selectTrack(track.id);
    st.setWorkbenchView('piano-roll');
  };

  return (
    <div className="col" style={{ gap: 12 }} data-testid="melody-panel">
      <div className="panel">
        <div className="panel-header">
          <Icon name="midi" />
          <h3 className="grow">
            Vocal melody <span className="dim mono small">{midiName}</span>
          </h3>
          <Button size="sm" icon="midi" onClick={openPianoRoll} title="Edit notes, syllables and the vocal expression lanes in the piano roll">
            Open in piano roll
          </Button>
          <Button size="sm" icon="download" onClick={() => downloadBytes(trackToMidi(song, track.id), midiName, 'audio/midi')} title={`Download ${midiName} (melody + lyric syllables)`}>
            {midiName}
          </Button>
        </div>
        <div className="panel-body col">
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <Field label="Voice type">
              <Select value={track.vocal?.voiceType ?? 'tenor'} onChange={setVoiceType} options={VOICE_TYPES} aria-label="Voice type" />
            </Field>
            <Field label="Regeneration">
              <Select value={level} onChange={setLevel} options={LEVELS} aria-label="Regeneration level" />
            </Field>
            <div className="field">
              <span className="field-label">Range</span>
              <span className="mono">{low !== null && high !== null ? `${midiToNoteName(low)}–${midiToNoteName(high)}` : '—'}</span>
            </div>
            <div className="field">
              <span className="field-label">Material</span>
              <span>
                {track.notes.length} notes · {lines.length} lyric lines
              </span>
            </div>
            <div className="spacer" />
            <Button variant="primary" icon="dice" onClick={() => regenerate()} title="Regenerate the vocal melody in every unlocked section">
              Regenerate whole vocal melody
            </Button>
          </div>
          <NoteStrip
            notes={track.notes}
            ppq={song.ppq}
            meter={song.meterMap[0] ?? { numerator: 4, denominator: 4 }}
            totalTicks={Math.max(songLengthTicks(song), 1)}
            height={140}
            colorBy="velocity"
            color={track.color || ROLE_COLORS.vocal}
            highlight={focusSpan ? { startTick: focusSpan.startTick, endTick: focusSpan.endTick } : null}
            ariaLabel={`${track.name}: ${track.notes.length} notes`}
            onBarClick={(bar1) => {
              const s = spans.find((x) => bar1 - 1 >= x.startBar && bar1 - 1 < x.endBar);
              if (s) setFocus(s.section.id);
            }}
            testId="vocal-melody-strip"
          />
          <table className="table vx-sections" aria-label="Vocal melody by section">
            <thead>
              <tr>
                <th>Section</th>
                <th className="num">Bars</th>
                <th className="num">Notes</th>
                <th className="num">Lyric lines</th>
                <th>Lock</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {spans.map((s) => {
                const n = track.notes.filter((x) => x.tick >= s.startTick && x.tick < s.endTick).length;
                const locked = isTrackSectionLocked(song, track.id, s.section.id);
                const ly = lines.filter((l) => l.sectionId === s.section.id).length;
                return (
                  <tr key={s.section.id} className={focus === s.section.id ? 'vx-row-focus' : ''} onMouseEnter={() => setFocus(s.section.id)}>
                    <td>
                      <strong>{s.section.name}</strong>
                    </td>
                    <td className="num">
                      {s.startBar + 1}–{s.endBar}
                    </td>
                    <td className="num">{n || <span className="dim">—</span>}</td>
                    <td className="num">{ly || <span className="dim">—</span>}</td>
                    <td>
                      <LockButton
                        locked={locked}
                        onToggle={() => st.toggleLock(LockKeys.trackSection(track.id, s.section.id), `${locked ? 'Unlocked' : 'Locked'} ${track.name} in ${s.section.name}`)}
                        title={locked ? `${track.name} is locked in ${s.section.name}` : `Lock ${track.name} in ${s.section.name}`}
                      />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Button size="sm" icon="dice" disabled={locked} onClick={() => regenerate([s.section.id])} aria-label={`Regenerate the vocal melody in ${s.section.name}`}>
                        Regenerate
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="small muted">
            Only {track.name} is regenerated: drums, harmony, every other track and the lyrics stay exactly as they are, and locked sections (here, in the Workbench or note
            locks) are kept byte-identical. With lyrics, new melodies are rhythm-matched to the syllables.
            {render ? (autoResing ? ' The vocal render is re-sung for the regenerated sections only.' : ' Re-sing changed sections from the Render tab.') : ''}
          </div>
          {track.vocal?.mode === 'none' && <Badge tone="warning">Vocal mode: none — the track is silent in playback</Badge>}
        </div>
      </div>
    </div>
  );
}
