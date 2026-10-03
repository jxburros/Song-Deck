import { lazy, Suspense } from 'react';
import { useStudio, type RightPanel, type WorkbenchView } from '../../state/store';
import { Tabs, Spinner, EmptyState, Button } from '../../ui/kit';
import { WorkbenchToolbar } from './WorkbenchToolbar';
import { SidePanel } from './SidePanel';

const ArrangementView = lazy(() => import('./ArrangementView'));
const PianoRoll = lazy(() => import('./PianoRoll'));
const PatternView = lazy(() => import('./PatternView'));
const ChordView = lazy(() => import('./ChordView'));
const StructureView = lazy(() => import('./StructureView'));
const TheoryView = lazy(() => import('./TheoryView'));

const RightPanels = {
  'ai-edit': lazy(() => import('./panels/AiEditPanel')),
  assistant: lazy(() => import('./panels/AssistantPanel')),
  proposals: lazy(() => import('./panels/ProposalsPanel')),
  macros: lazy(() => import('./panels/MacrosPanel')),
  locks: lazy(() => import('./panels/LocksPanel')),
  variation: lazy(() => import('./panels/VariationPanel')),
  history: lazy(() => import('./panels/HistoryPanel')),
  inspector: lazy(() => import('./panels/InspectorPanel')),
} satisfies Record<RightPanel, unknown>;

const VIEWS: Record<WorkbenchView, React.LazyExoticComponent<React.ComponentType>> = {
  arrangement: ArrangementView,
  'piano-roll': PianoRoll,
  pattern: PatternView,
  chords: ChordView,
  structure: StructureView,
  theory: TheoryView,
};

const RIGHT_TABS: { value: RightPanel; label: string; title: string }[] = [
  { value: 'ai-edit', label: 'AI Edit', title: 'Change the selection with natural language (spec §20)' },
  { value: 'assistant', label: 'Assistant', title: 'Ask about the song (spec §44)' },
  { value: 'proposals', label: 'Proposals', title: 'Accept / reject / modify AI proposals (spec §21)' },
  { value: 'macros', label: 'Macros', title: 'Macro controls (spec §19)' },
  { value: 'locks', label: 'Locks', title: 'Lock components; regenerate unlocked material (spec §22)' },
  { value: 'variation', label: 'Variation', title: 'Seeds, variation levels, Song DNA (spec §23-§24)' },
  { value: 'history', label: 'History', title: 'Versions & branches (spec §52-§53)' },
  { value: 'inspector', label: 'Inspector', title: 'Track & section inspector, provenance' },
];

export default function Workbench() {
  const song = useStudio((s) => s.project?.song ?? null);
  const view = useStudio((s) => s.workbenchView);
  const setView = useStudio((s) => s.setWorkbenchView);
  const rightPanel = useStudio((s) => s.rightPanel);
  const setRightPanel = useStudio((s) => s.setRightPanel);
  const pending = useStudio((s) => s.proposals.filter((p) => p.status === 'pending').length);

  if (!song) return null;
  if (song.sections.length === 0) {
    return (
      <EmptyState
        icon="compose"
        title="This project has no song yet"
        actions={
          <Button variant="primary" icon="sparkles" onClick={() => useStudio.getState().setMode('compose')}>
            Compose
          </Button>
        }
      >
        Start from a prompt in Compose, import MIDI, or rebuild a recording.
      </EmptyState>
    );
  }
  const View = VIEWS[view];
  const Right = RightPanels[rightPanel];
  return (
    <div className="workbench">
      <aside className="wb-left">
        <SidePanel />
      </aside>
      <section className="wb-center">
        <div className="wb-toolbar">
          <Tabs
            value={view}
            onChange={setView}
            tabs={[
              { value: 'arrangement', label: 'Arrangement', icon: 'layers' },
              { value: 'piano-roll', label: 'Piano Roll', icon: 'midi' },
              { value: 'pattern', label: 'Pattern', icon: 'grid' },
              { value: 'chords', label: 'Chords', icon: 'music' },
              { value: 'structure', label: 'Structure', icon: 'workbench' },
              { value: 'theory', label: 'Theory', icon: 'book' },
            ]}
          />
          <WorkbenchToolbar />
        </div>
        <div className="wb-editor">
          <Suspense fallback={<div className="empty-state"><Spinner /></div>}>
            <View />
          </Suspense>
        </div>
      </section>
      <aside className="wb-right">
        <div className="right-tabs">
          {RIGHT_TABS.map((t) => (
            <button key={t.value} className={`tab ${rightPanel === t.value ? 'active' : ''}`} onClick={() => setRightPanel(t.value)} title={t.title}>
              {t.label}
              {t.value === 'proposals' && pending > 0 && <span className="badge ai" style={{ height: 16, padding: '0 5px' }}>{pending}</span>}
            </button>
          ))}
        </div>
        <div className="right-body">
          <Suspense fallback={<Spinner />}>
            <Right />
          </Suspense>
        </div>
      </aside>
    </div>
  );
}
