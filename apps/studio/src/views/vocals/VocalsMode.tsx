import {
  defaultChannelStrip,
  getInstrument,
  randomId,
  randomSeed,
  regenerateUnlocked,
  type Project,
  type Song,
  type Track,
} from '@songdeck/core';
import { useStudio } from '../../state/store';
import { useSettings } from '../../state/settings';
import { useStopPreviewOnUnmount } from '../../engine/capture-playback';
import { uniqueTrackName } from '../../engine/capture-song';
import { defaultVocalTrack, vocalMidiTracks, type VocalTab } from '../../engine/vocal-model';
import { usePlayerState } from '../../hooks';
import { Badge, Button, EmptyState, Select, Tabs } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { colorForRole } from '../workbench/tracks';
import { ConversionPanel } from './ConversionPanel';
import { ExpressionPanel } from './ExpressionPanel';
import { LyricsPanel } from './LyricsPanel';
import { MelodyPanel } from './MelodyPanel';
import { ModeCards } from './ModeCards';
import { RecordingPanel } from './RecordingPanel';
import { RegeneratePanel } from './RegeneratePanel';
import { RenderPanel } from './RenderPanel';
import { SingersPanel } from './SingersPanel';
import { VocalSummary } from './Summary';
import { VoicesPanel } from './VoicesPanel';
import { useVocalSession } from './session';
import { useProvideAudioAssets } from './shared';
import './vocals.css';

/**
 * Vocals mode (spec §32-§37, Phase 4). Vocals are an independent subsystem: lyrics, the vocal
 * melody (vocal.mid), expression, the voice and its singing render can each be changed — and
 * regenerated — without the music-production model ever having to generate the singer.
 */

const TABS: { value: VocalTab; label: string; icon: string; title: string }[] = [
  {
    value: 'lyrics',
    label: 'Lyrics',
    icon: 'book',
    title: 'Write, edit and align lyrics (spec §33-§35, §48)',
  },
  {
    value: 'melody',
    label: 'Melody',
    icon: 'midi',
    title: 'Vocal melody: vocal.mid, regenerate per section',
  },
  {
    value: 'singers',
    label: 'Singers',
    icon: 'music',
    title: 'Who sings each part, and their range: easy, difficult but possible, falsetto, out of reach',
  },
  {
    value: 'expression',
    label: 'Expression',
    icon: 'sliders',
    title: 'Breathiness, tension, vibrato, onset, release (spec §35)',
  },
  {
    value: 'render',
    label: 'Render',
    icon: 'waveform',
    title: 'Dedicated singing synthesis → lead_vocal.wav (spec §34)',
  },
  {
    value: 'regenerate',
    label: 'Regenerate',
    icon: 'sparkles',
    title: 'Independent vocal regeneration with words (spec §37)',
  },
  { value: 'voices', label: 'Voices', icon: 'shield', title: 'Voice library, safety and consent (spec §36)' },
  {
    value: 'conversion',
    label: 'Conversion',
    icon: 'users',
    title: 'User voice conversion to an authorized voice (spec §33)',
  },
  { value: 'recording', label: 'Record', icon: 'mic', title: 'Record your own takes (spec §33)' },
];

function createVocalTrack(
  song: Song,
  customInstruments: ReturnType<typeof useSettings.getState>['customInstruments'],
): { song: Song; track: Track } {
  const inst = getInstrument('lead-vocal', customInstruments);
  const id = randomId('trk');
  const track: Track = {
    id,
    name: uniqueTrackName(song, 'Lead Vocal'),
    kind: 'midi',
    role: 'vocal',
    instrumentId: inst.id,
    constraints: { function: 'melody' },
    notes: [],
    clips: [],
    color: colorForRole('vocal'),
    stemGroup: inst.stemGroup,
    midiChannel: 0,
    vocal: {
      voiceType: song.blueprint?.vocal?.voiceType ?? 'tenor',
      mode: song.vocals.mode === 'none' ? 'melody-only' : song.vocals.mode,
    },
  };
  let next: Song = {
    ...song,
    tracks: [...song.tracks, track],
    mixer: {
      ...song.mixer,
      channels: { ...song.mixer.channels, [id]: defaultChannelStrip({ volumeDb: -3, reverbSend: 0.22 }) },
    },
    vocals: { ...song.vocals, mode: song.vocals.mode === 'none' ? 'melody-only' : song.vocals.mode },
  };
  next = regenerateUnlocked(next, { seed: randomSeed(), trackIds: [id], customInstruments }).song;
  return { song: next, track: next.tracks.find((t) => t.id === id) ?? track };
}

function Panel({ tab, project, track }: { tab: VocalTab; project: Project; track: Track }) {
  switch (tab) {
    case 'lyrics':
      return <LyricsPanel project={project} track={track} />;
    case 'melody':
      return <MelodyPanel project={project} track={track} />;
    case 'singers':
      return <SingersPanel project={project} track={track} />;
    case 'expression':
      return <ExpressionPanel project={project} track={track} />;
    case 'render':
      return <RenderPanel project={project} track={track} />;
    case 'regenerate':
      return <RegeneratePanel project={project} track={track} />;
    case 'voices':
      return <VoicesPanel project={project} track={track} />;
    case 'conversion':
      return <ConversionPanel project={project} track={track} />;
    case 'recording':
      return <RecordingPanel project={project} track={track} />;
  }
}

export default function VocalsMode() {
  const project = useStudio((s) => s.project);
  const session = useVocalSession();
  const customInstruments = useSettings((s) => s.customInstruments);
  const playing = usePlayerState();
  useProvideAudioAssets(project?.song ?? null);
  useStopPreviewOnUnmount();
  if (!project) return null;
  const song = project.song;
  const st = useStudio.getState();

  if (!song.sections.length) {
    return (
      <EmptyState
        icon="music"
        title="No song yet"
        actions={
          <Button variant="primary" icon="sparkles" onClick={() => st.setMode('compose')}>
            Compose
          </Button>
        }
      >
        Vocals need a composition — compose a song (ask for a vocal, e.g. “male tenor vocal”) or import MIDI
        first.
      </EmptyState>
    );
  }

  const tracks = vocalMidiTracks(song);
  const track = tracks.find((t) => t.id === session.trackId) ?? defaultVocalTrack(song);

  const addVocal = () => {
    const cur = useStudio.getState().project?.song;
    if (!cur) return;
    const res = createVocalTrack(cur, customInstruments);
    st.commit(res.song, `Added ${res.track.name} with a generated vocal melody`, 'vocals');
    session.set({ trackId: res.track.id, tab: 'lyrics' });
    st.toast(
      'success',
      `${res.track.name}: ${res.track.notes.length} notes generated over the existing harmony.`,
    );
  };

  if (!track) {
    return (
      <EmptyState
        icon="mic"
        title="This song has no vocal track"
        actions={
          <Button variant="primary" icon="plus" onClick={addVocal}>
            Create vocal track
          </Button>
        }
      >
        Vocals are their own subsystem: add a lead vocal track and Song Deck writes a vocal melody over the
        existing harmony — then lyrics, expression and a singing voice.
      </EmptyState>
    );
  }

  return (
    <div className="mode-page vx-page" data-testid="vocals-mode">
      <div className="page-header">
        <div className="grow">
          <h1>Vocals</h1>
          <div className="lede">
            An independent vocal subsystem: lyrics, the vocal melody, expression and the voice are separate
            layers. Change or regenerate any of them — one phrase at a time if you like — without regenerating
            the instrumentation.
          </div>
        </div>
        <div className="row">
          {tracks.length > 1 ? (
            <Select
              value={track.id}
              onChange={(id) => session.set({ trackId: id })}
              options={tracks.map((t) => ({ value: t.id, label: t.name }))}
              aria-label="Vocal track"
            />
          ) : (
            <Badge tone="accent">
              <Icon name="mic" size={11} /> {track.name}
            </Badge>
          )}
          <Button
            variant="ghost"
            icon="plus"
            onClick={addVocal}
            title="Add another vocal track (e.g. a duet or harmony part)"
            aria-label="Add vocal track"
          />
          <Button
            variant={playing ? 'default' : 'primary'}
            icon={playing ? 'pause' : 'play'}
            onClick={() => st.togglePlay()}
            aria-label={playing ? 'Pause' : 'Play'}
            title="Play / pause (Space)"
          >
            {playing ? 'Pause' : 'Play'}
          </Button>
        </div>
      </div>

      <ModeCards project={project} track={track} />

      <div className="vx-layout">
        <section className="vx-main" aria-label="Vocal tools">
          <div className="vx-tabbar">
            <Tabs value={session.tab} onChange={(tab) => session.set({ tab })} tabs={TABS} />
          </div>
          <Panel tab={session.tab} project={project} track={track} />
        </section>
        <aside className="vx-side" aria-label="Vocal summary">
          <VocalSummary project={project} track={track} />
        </aside>
      </div>
    </div>
  );
}
