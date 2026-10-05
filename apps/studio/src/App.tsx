import { Suspense, lazy, useEffect } from 'react';
import { useStudio, type Mode } from './state/store';
import { useSettings } from './state/settings';
import { PlayerBar, Rail, SONG_MODES, SongHeader } from './views/shell/Shell';
import { Toasts } from './views/shell/Toasts';
import { ConfirmDialog } from './views/shell/ConfirmDialog';
import { AttestationDialog } from './views/shared/AttestationDialog';
import { TaskDrawer } from './views/shell/TaskDrawer';
import { ModeErrorBoundary } from './views/shell/ModeErrorBoundary';
import { useHotkeys } from './hooks';
import { Spinner } from './ui/kit';
import { initRuntime } from './engine/runtime';

const LibraryMode = lazy(() => import('./views/library/LibraryMode'));
const SingleTrackMode = lazy(() => import('./views/single/SingleTrackMode'));
const SongsHome = lazy(() => import('./views/project/Home'));
const ComposeMode = lazy(() => import('./views/compose/ComposeMode'));
const Workbench = lazy(() => import('./views/workbench/Workbench'));
const SoundMode = lazy(() => import('./views/sound/SoundMode'));
const MoreTools = lazy(() => import('./views/tools/MoreTools'));
const ExpandMode = lazy(() => import('./views/expand/ExpandMode'));
const GenerateMode = lazy(() => import('./views/generate/GenerateMode'));
const TranscribeMode = lazy(() => import('./views/transcribe/TranscribeMode'));
const RebuildMode = lazy(() => import('./views/rebuild/RebuildMode'));
const ProduceMode = lazy(() => import('./views/produce/ProduceMode'));
const VocalsMode = lazy(() => import('./views/vocals/VocalsMode'));
const MixMode = lazy(() => import('./views/mix/MixMode'));
const ExportMode = lazy(() => import('./views/export/ExportMode'));
const SettingsMode = lazy(() => import('./views/settings/SettingsMode'));

const VIEWS: Record<Mode, React.LazyExoticComponent<React.ComponentType>> = {
  home: SongsHome,
  library: LibraryMode,
  single: SingleTrackMode,
  compose: ComposeMode,
  workbench: Workbench,
  sound: SoundMode,
  tools: MoreTools,
  generate: GenerateMode,
  expand: ExpandMode,
  transcribe: TranscribeMode,
  rebuild: RebuildMode,
  produce: ProduceMode,
  vocals: VocalsMode,
  mix: MixMode,
  export: ExportMode,
  settings: SettingsMode,
};

/** Modes usable without an open song. */
const PROJECTLESS: Mode[] = [
  'library',
  'single',
  'home',
  'settings',
  'generate',
  'transcribe',
  'rebuild',
  'compose',
  'expand',
];

export function App() {
  const mode = useStudio((s) => s.mode);
  const hasProject = useStudio((s) => !!s.project);
  const theme = useSettings((s) => s.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void initRuntime();
    void useStudio.getState().refreshProjects();
  }, []);

  useHotkeys({
    ' ': () => useStudio.getState().togglePlay(),
    'mod+z': () => useStudio.getState().undo(),
    'mod+shift+z': () => useStudio.getState().redo(),
    'mod+y': () => useStudio.getState().redo(),
    enter: () => useStudio.getState().stop(),
  });

  const effective: Mode = !hasProject && !PROJECTLESS.includes(mode) ? 'home' : mode;
  const inSong = hasProject && SONG_MODES.includes(effective);
  const View = VIEWS[effective];

  return (
    <div className={`app ${inSong ? 'in-song' : ''}`}>
      <Rail />
      <div className="app-body">
        {inSong && <SongHeader />}
        <main className="main">
          <ModeErrorBoundary mode={effective}>
            <Suspense
              fallback={
                <div className="empty-state">
                  <Spinner />
                </div>
              }
            >
              <View />
            </Suspense>
          </ModeErrorBoundary>
          <TaskDrawer />
        </main>
        {inSong && <PlayerBar />}
      </div>
      <Toasts />
      <ConfirmDialog />
      <AttestationDialog />
    </div>
  );
}
