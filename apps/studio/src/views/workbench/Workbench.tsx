import { lazy, Suspense, useState } from 'react';
import { useStudio, type RightPanel, type WorkbenchView } from '../../state/store';
import { Tabs, Spinner, EmptyState, Button } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { WorkbenchToolbar } from './WorkbenchToolbar';
import { AddTrackModal } from './tracks';
import { ChangePanel, PANEL_LABELS } from './ChangePanel';
import './write.css';

const ArrangementView = lazy(() => import('./ArrangementView'));
const PianoRoll = lazy(() => import('./PianoRoll'));
const PatternView = lazy(() => import('./PatternView'));
const ChordView = lazy(() => import('./ChordView'));
const StructureView = lazy(() => import('./StructureView'));
const TheoryView = lazy(() => import('./TheoryView'));

const RightPanels = {
  assistant: lazy(() => import('./panels/AssistantPanel')),
  proposals: lazy(() => import('./panels/ProposalsPanel')),
  macros: lazy(() => import('./panels/MacrosPanel')),
  locks: lazy(() => import('./panels/LocksPanel')),
  variation: lazy(() => import('./panels/VariationPanel')),
  history: lazy(() => import('./panels/HistoryPanel')),
  inspector: lazy(() => import('./panels/InspectorPanel')),
} satisfies Record<Exclude<RightPanel, 'ai-edit'>, unknown>;

const VIEWS: Record<WorkbenchView, React.LazyExoticComponent<React.ComponentType>> = {
  arrangement: ArrangementView,
  'piano-roll': PianoRoll,
  pattern: PatternView,
  chords: ChordView,
  structure: StructureView,
  theory: TheoryView,
};

const VIEW_LABELS: Record<WorkbenchView, string> = {
  arrangement: 'Arrangement',
  'piano-roll': 'Piano Roll',
  pattern: 'Pattern',
  chords: 'Chords',
  structure: 'Structure',
  theory: 'Theory',
};

const HINTS: Partial<Record<WorkbenchView, string>> = {
  arrangement:
    'Double-click a block to edit its notes. Click a section name to change just that section, or drag across the bar ruler.',
  'piano-roll': 'Draw with D, select with S. L locks notes, Q quantizes, arrows nudge and transpose.',
};

/** Add a track: an empty instrument track, a described part, a part from audio. */
function AddTrackMenu() {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const st = useStudio.getState();
  return (
    <div className="add-track">
      <Button icon="plus" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        Add track
      </Button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu panel add-track-menu" role="menu" aria-label="Add track">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setModal(true);
              }}
            >
              <Icon name="midi" /> Instrument track…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                st.setMode('generate');
              }}
            >
              <Icon name="sparkles" /> Describe a part…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                st.setMode('transcribe');
              }}
            >
              <Icon name="mic" /> A part from audio…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                st.setMode('library');
              }}
            >
              <Icon name="book" /> From the Library…
            </button>
          </div>
        </>
      )}
      {modal && <AddTrackModal onClose={() => setModal(false)} />}
    </div>
  );
}

/** Write: the arrangement (or an editor opened from it) beside the Change panel. */
export default function Workbench() {
  const song = useStudio((s) => s.project?.song ?? null);
  const view = useStudio((s) => s.workbenchView);
  const setView = useStudio((s) => s.setWorkbenchView);
  const rightPanel = useStudio((s) => s.rightPanel);
  const setRightPanel = useStudio((s) => s.setRightPanel);

  if (!song) return null;
  if (song.sections.length === 0) {
    return (
      <EmptyState
        icon="compose"
        title="This project has no song yet"
        actions={
          <Button variant="primary" icon="sparkles" onClick={() => useStudio.getState().setMode('compose')}>
            Start a song
          </Button>
        }
      >
        Start from lyrics, a recording, MIDI or a prompt, or rebuild a recording.
      </EmptyState>
    );
  }
  const View = VIEWS[view];
  const tabs: WorkbenchView[] = ['arrangement', 'piano-roll'];
  if (!tabs.includes(view)) tabs.push(view);
  const Right = rightPanel === 'ai-edit' ? null : RightPanels[rightPanel];
  return (
    <div className="workbench">
      <section className="wb-center">
        <div className="wb-toolbar">
          <Tabs
            value={view}
            onChange={setView}
            tabs={tabs.map((v) => ({
              value: v,
              label: VIEW_LABELS[v],
              icon: v === 'arrangement' ? 'layers' : v === 'piano-roll' ? 'midi' : undefined,
            }))}
          />
          {view !== 'arrangement' && view !== 'piano-roll' && (
            <Button size="sm" variant="ghost" icon="close" onClick={() => setView('arrangement')}>
              Close {VIEW_LABELS[view]}
            </Button>
          )}
          <WorkbenchToolbar />
          <div className="spacer" />
          <AddTrackMenu />
        </div>
        <div className="wb-editor">
          <Suspense
            fallback={
              <div className="empty-state">
                <Spinner />
              </div>
            }
          >
            <View />
          </Suspense>
        </div>
        {HINTS[view] && <div className="wb-hint">{HINTS[view]}</div>}
      </section>
      <aside
        className="wb-right"
        aria-label={Right ? PANEL_LABELS[rightPanel as keyof typeof PANEL_LABELS] : 'Change'}
      >
        {Right ? (
          <>
            <div className="right-head">
              <Button
                size="sm"
                variant="ghost"
                icon="chevronRight"
                className="back-btn"
                onClick={() => setRightPanel('ai-edit')}
              >
                Change
              </Button>
              <h2>{PANEL_LABELS[rightPanel as keyof typeof PANEL_LABELS]}</h2>
            </div>
            <div className="right-body">
              <Suspense fallback={<Spinner />}>
                <Right />
              </Suspense>
            </div>
          </>
        ) : (
          <ChangePanel />
        )}
      </aside>
    </div>
  );
}
