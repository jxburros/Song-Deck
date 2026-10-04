import { useState } from 'react';
import type { Song } from '@songdeck/core';
import { saveSongToLibrary, useLibrary, type LibraryDraft } from '../../state/library';
import { useStudio } from '../../state/store';
import { Button } from '../../ui/kit';

export function SaveLibraryButton({
  song,
  trackIds,
  file,
  label = 'Save to Library',
}: {
  song?: Song | (() => Song);
  trackIds?: string[];
  file?: () => Promise<LibraryDraft>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (file) await useLibrary.getState().save(await file());
      else if (song) await saveSongToLibrary(typeof song === 'function' ? song() : song, trackIds);
      useStudio.getState().toast('success', 'Saved to Library');
    } catch (e) {
      useStudio
        .getState()
        .toast('error', `Could not save to Library: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" icon="book" disabled={busy} onClick={() => void save()}>
      {busy ? 'Saving…' : label}
    </Button>
  );
}
