import { Icon, type IconName } from '../../ui/icons';
import { useComposeSession } from './session';

const SONG_TYPES: { instrumental: boolean; label: string; icon: IconName }[] = [
  { instrumental: false, label: 'With vocals', icon: 'mic' },
  { instrumental: true, label: 'Instrumental', icon: 'music' },
];

/** The first choice for a song: with vocals, or instrumental (which hides every lyrics option). */
export function SongTypeSwitch() {
  const instrumental = useComposeSession((s) => s.instrumental);
  const setInstrumental = useComposeSession((s) => s.setInstrumental);
  return (
    <div className="song-type" role="radiogroup" aria-label="Song type">
      {SONG_TYPES.map((t) => (
        <button
          key={t.label}
          type="button"
          role="radio"
          aria-checked={instrumental === t.instrumental}
          className={`song-type-opt ${instrumental === t.instrumental ? 'on' : ''}`}
          onClick={() => setInstrumental(t.instrumental)}
        >
          <Icon name={t.icon} size={16} />
          {t.label}
        </button>
      ))}
    </div>
  );
}
