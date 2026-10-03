import { create } from 'zustand';
import { stableStringify, type MixerState } from '@songdeck/core';
import { useStudio } from '../../state/store';
import { player } from '../../engine/player';
import { describeMixChange } from './mixModel';

/**
 * Mixer edits in progress. While a control is being dragged the UI shows a draft mixer that is
 * previewed live through `player.setMixer` (the renderer smooths parameter changes, so there is
 * no zipper noise). Releasing the control commits ONE revision with a human message.
 */

interface MixDraftState {
  draft: MixerState | null;
}

export const useMixDraft = create<MixDraftState>(() => ({ draft: null }));

let raf = 0;
let pending: MixerState | null = null;
let commitTimer: ReturnType<typeof setTimeout> | null = null;

function flushPreview() {
  raf = 0;
  if (pending) player.setMixer(pending);
  pending = null;
}

function schedulePreview(m: MixerState) {
  pending = m;
  if (!raf) raf = requestAnimationFrame(flushPreview);
}

function clearScheduled() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  pending = null;
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = null;
}

/** The mixer the UI should display: the draft while editing, otherwise the song's mixer. */
export function useMixer(): MixerState | null {
  const draft = useMixDraft((s) => s.draft);
  const mixer = useStudio((s) => s.project?.song.mixer ?? null);
  return draft ?? mixer;
}

export function currentMixer(): MixerState | null {
  return useMixDraft.getState().draft ?? useStudio.getState().project?.song.mixer ?? null;
}

/** Update the draft and hear it immediately (no revision yet). */
export function previewMixer(fn: (m: MixerState) => MixerState): void {
  const base = currentMixer();
  if (!base) return;
  const next = fn(base);
  useMixDraft.setState({ draft: next });
  schedulePreview(next);
}

/** Commit the draft as one revision (message derived from the change unless given). */
export function commitMixer(message?: string): void {
  const st = useStudio.getState();
  const song = st.project?.song;
  const draft = useMixDraft.getState().draft;
  clearScheduled();
  useMixDraft.setState({ draft: null });
  if (!song || !draft) return;
  if (stableStringify(draft) === stableStringify(song.mixer)) {
    player.setMixer(song.mixer);
    return;
  }
  st.commit({ ...song, mixer: draft }, message ?? describeMixChange(song, song.mixer, draft), 'mix');
}

/** Commit after a short pause (keyboard nudges become one revision). */
export function commitMixerSoon(delayMs = 650): void {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    commitTimer = null;
    commitMixer();
  }, delayMs);
}

/** Preview + commit in one step (toggles, selects, resets). */
export function applyMixer(fn: (m: MixerState) => MixerState, message?: string): void {
  previewMixer(fn);
  commitMixer(message);
}

/** Abandon the draft and restore the committed mixer in the player. */
export function cancelMixerDraft(): void {
  clearScheduled();
  useMixDraft.setState({ draft: null });
  const song = useStudio.getState().project?.song;
  if (song) player.setMixer(song.mixer);
}

/** Temporarily audition another mixer (e.g. a pending AI proposal) without touching the draft. */
export function auditionMixer(mixer: MixerState | null): void {
  const target = mixer ?? currentMixer();
  if (target) player.setMixer(target);
}
