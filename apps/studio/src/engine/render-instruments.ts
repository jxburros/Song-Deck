import { patchIdForGmProgram } from '@songdeck/audio';
import { useStudio } from '../state/store';
import { useSettings } from '../state/settings';
import { player } from './player';
import { jobs } from './jobs';
import { allCustomInstruments, useExtensions } from './plugins';
import type { RenderInstrumentConfig } from './render-config';

/**
 * The custom instruments a render needs: profiles from plugins, Settings and the open project
 * (so `track.instrumentId` resolves to the profile's patch) and plugin sample sets. A profile
 * whose samples are not loaded falls back to the patch for its General MIDI program.
 */
export function currentRenderInstruments(): RenderInstrumentConfig {
  const sampleInstruments = useExtensions.getState().sampleInstruments;
  const instruments = allCustomInstruments(useStudio.getState().project?.meta.customInstruments).map((p) =>
    p.patchId.startsWith('sfz:') && !sampleInstruments[p.patchId] ? { ...p, patchId: patchIdForGmProgram(p.gmProgram, p.isDrumKit) } : p,
  );
  return { instruments, sampleInstruments };
}

let started = false;

/** Keep live playback and offline render workers in step with the instruments in scope. */
export function initInstrumentSync(): void {
  if (started) return;
  started = true;
  let lastKey = '';
  let lastSamples: RenderInstrumentConfig['sampleInstruments'] | null = null;
  const push = () => {
    const config = currentRenderInstruments();
    // Renders only use id → patch and the sample sets, so compare just those.
    const key = config.instruments.map((i) => `${i.id}=${i.patchId}`).join('|');
    if (key === lastKey && config.sampleInstruments === lastSamples) return;
    lastKey = key;
    lastSamples = config.sampleInstruments;
    player.setInstruments(config);
    jobs.configure(config);
  };
  useExtensions.subscribe(push);
  useSettings.subscribe(push);
  useStudio.subscribe(push);
  push();
}
