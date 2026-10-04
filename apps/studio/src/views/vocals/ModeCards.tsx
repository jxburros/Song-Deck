import type { Project, Track, VocalMode } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';
import {
  VOCAL_MODES,
  activeRender,
  applyVocalMonitoring,
  lyricsOfTrack,
  modeInfo,
  resolveVoice,
  takesTrackFor,
} from '../../engine/vocal-model';
import { hasConversionProvider } from '../../engine/vocal-render';
import { useVocalSession } from './session';
import { useResolvedProvider } from './shared';

/** Vocal modes (spec §33): what each one will do, and what it would use right now. */
export function ModeCards({ project, track }: { project: Project; track: Track }) {
  const song = project.song;
  const mode = song.vocals.mode;
  const session = useVocalSession();
  const singer = useResolvedProvider('vocals', session.singerProvider);
  const render = activeRender(project, track.id);
  const voice = resolveVoice(project, song.vocals.voiceId, track);
  const takes = song.vocals.takes.filter((t) => t.trackId === takesTrackFor(song, track.id)?.id);
  const lines = lyricsOfTrack(song, track.id).length;
  const target = song.vocals.conversionVoiceId
    ? project.meta.voices.find((v) => v.id === song.vocals.conversionVoiceId)
    : undefined;

  const status: Record<VocalMode, string> = {
    none: `${track.name} is silent; lyrics and melody are kept`,
    'melody-only': `${track.notes.length} notes · ${lines} lyric line${lines === 1 ? '' : 's'} → vocal.mid`,
    placeholder: `Built-in formant singer · ${voice.source === 'built-in' ? voice.name : 'stock voice'} · ${render ? `render ${render.asset?.name ?? ''}` : 'sings live'}`,
    'ai-singer': singer?.error
      ? 'No singing provider available'
      : `${singer?.providerName ?? '…'}${singer?.providerId === 'internal-singer' ? ' (placeholder quality — no singing model configured)' : ''}`,
    'voice-conversion': `${target ? `Target: ${target.name}` : 'No target voice chosen'} · ${hasConversionProvider() ? 'conversion provider ready' : 'no voice-conversion provider configured'}`,
    recorded: takes.length
      ? `${takes.length} take${takes.length === 1 ? '' : 's'} · ${takes.filter((t) => t.active).length} active`
      : 'No takes recorded yet',
  };

  const choose = (m: VocalMode) => {
    const info = modeInfo(m);
    session.set({ tab: info.tab });
    if (m === mode) return;
    const st = useStudio.getState();
    const cur = st.project?.song;
    if (!cur) return;
    const mon = applyVocalMonitoring({ ...cur, vocals: { ...cur.vocals, mode: m } }, track.id);
    st.commit(mon.song, `Vocal mode → ${info.label}`, 'vocals');
    if (mon.skipped.length)
      st.toast('warning', `Mixer locked for ${mon.skipped.join(', ')} — its mute state was left as it is.`);
  };

  return (
    <div className="vx-modes" role="radiogroup" aria-label="Vocal mode">
      {VOCAL_MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          role="radio"
          aria-checked={mode === m.mode}
          className={`vx-mode ${mode === m.mode ? 'selected' : ''}`}
          onClick={() => choose(m.mode)}
          data-testid={`vocal-mode-${m.mode}`}
        >
          <div className="vx-mode-head">
            <span className="vx-mode-icon">
              <Icon name={m.icon} size={15} />
            </span>
            <span className="vx-mode-label">{m.label}</span>
            {mode === m.mode && <Icon name="check" size={14} className="icon-svg vx-mode-check" />}
          </div>
          <div className="vx-mode-does">{m.does}</div>
          <div className="vx-mode-status">{status[m.mode]}</div>
        </button>
      ))}
    </div>
  );
}
