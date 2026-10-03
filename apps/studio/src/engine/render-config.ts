import type { InstrumentProfile } from '@songdeck/core';
import type { SampleInstrument } from '@songdeck/audio';

/**
 * Instruments a render needs beyond the built-in patches (types only, so workers can import it):
 * custom instrument profiles resolve `track.instrumentId` → `patchId`, and sampled (SFZ)
 * instruments from plugins override the patch with that id.
 */
export interface RenderInstrumentConfig {
  instruments: InstrumentProfile[];
  sampleInstruments: Record<string, SampleInstrument>;
}
