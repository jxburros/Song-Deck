import { lazy, Suspense } from 'react';
import { LockKeys, sectionLayout } from '@songdeck/core';
import { useStudio, type RightPanel } from '../../state/store';
import { Button, Spinner } from '../../ui/kit';
import { SaveLibraryButton } from '../library/SaveLibraryButton';
import { RegenerateActions, useRangeLabel } from './WorkbenchToolbar';

const AiEditPanel = lazy(() => import('./panels/AiEditPanel'));
const ProposalsPanel = lazy(() => import('./panels/ProposalsPanel'));

/** Where the other right-hand panels live now: More tools, one click from Write. */
export const PANEL_LABELS: Record<Exclude<RightPanel, 'ai-edit'>, string> = {
  assistant: 'Assistant',
  proposals: 'Proposal history',
  macros: 'Macros',
  locks: 'Locks',
  variation: 'Variations and Song DNA',
  history: 'History and branches',
  inspector: 'Track details',
};

/**
 * Write's single right-hand panel: what is selected, a change in words (AI or on-device), the
 * pending proposals to keep or discard, and the quick actions — another version, lock, edit notes,
 * save to the Library.
 */
export function ChangePanel() {
  const song = useStudio((s) => s.project?.song ?? null);
  const selection = useStudio((s) => s.selection);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const rangeLabel = useRangeLabel();
  const st = useStudio.getState();
  if (!song) return null;
  const section = selection.sectionIds?.length
    ? sectionLayout(song).find((s) => s.section.id === selection.sectionIds![0])
    : undefined;
  const track = song.tracks.find((t) => t.id === selectedTrackId);
  const sectionLocked = section ? !!song.locks[LockKeys.section(section.section.id)] : false;
  const scope = section
    ? `${section.section.name} · bars ${section.startBar + 1}–${section.endBar}`
    : rangeLabel
      ? rangeLabel
      : 'Whole song';
  return (
    <>
      <div className="right-head">
        <h2>Change</h2>
        <span className="scope-chip" title="What a change or a new version applies to">
          {scope}
        </span>
        {(section || rangeLabel) && (
          <Button
            size="sm"
            variant="ghost"
            icon="close"
            aria-label="Clear selection"
            title="Clear selection"
            onClick={() =>
              st.setSelection({ startTick: undefined, endTick: undefined, sectionIds: [], noteIds: [] })
            }
          />
        )}
      </div>
      <div className="right-body col" style={{ gap: 16 }}>
        <Suspense fallback={<Spinner />}>
          <AiEditPanel />
          <ProposalsPanel pendingOnly />
        </Suspense>
        <div className="change-actions">
          <span className="field-label">Or</span>
          <div className="change-grid">
            <RegenerateActions />
            {section && (
              <Button
                icon={sectionLocked ? 'unlock' : 'lock'}
                onClick={() =>
                  st.toggleLock(
                    LockKeys.section(section.section.id),
                    `${sectionLocked ? 'Unlocked' : 'Locked'} section ${section.section.name}`,
                  )
                }
              >
                {sectionLocked ? 'Unlock section' : 'Lock section'}
              </Button>
            )}
            {track?.kind === 'midi' && (
              <Button icon="pencil" onClick={() => st.setWorkbenchView('piano-roll')}>
                Edit notes
              </Button>
            )}
            {track && (
              <SaveLibraryButton
                song={song}
                trackIds={
                  selection.trackIds && selection.trackIds.length > 1 ? selection.trackIds : [track.id]
                }
                label={
                  selection.trackIds && selection.trackIds.length > 1
                    ? 'Save selection to Library'
                    : 'Save track to Library'
                }
              />
            )}
          </div>
        </div>
        <div className="change-more small">
          <span className="dim">More for this song:</span>
          {(Object.keys(PANEL_LABELS) as (keyof typeof PANEL_LABELS)[]).map((p) => (
            <button key={p} type="button" className="link-btn" onClick={() => st.setRightPanel(p)}>
              {PANEL_LABELS[p]}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
