import type { RawNote } from '../util';

/** A phrase produced by a generator; ids are assigned when the cell is written into the song. */
export interface PhraseDraft {
  /** Local key referenced by RawNote.phraseId until real ids exist. */
  key: string;
  startTick: number;
  endTick: number;
  label: string;
  motifId?: string;
  lyricLineId?: string;
}

export interface GenOutput {
  notes: RawNote[];
  phrases?: PhraseDraft[];
}
