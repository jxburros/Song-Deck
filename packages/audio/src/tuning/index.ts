/**
 * @songdeck/audio — tuning: pitch correction of monophonic recordings towards target notes
 * (TD-PSOLA resynthesis driven by YIN pitch tracking).
 */
export { pitchMarks, psolaResynthesize, type PitchMarks, type PitchContour } from './psola';
export {
  planRetune,
  retuneAudio,
  type RetuneNote,
  type RetuneSettings,
  type RetuneOptions,
  type RetuneReport,
  type RetunePlan,
} from './retune';
