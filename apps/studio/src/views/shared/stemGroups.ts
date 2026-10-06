import type { StemGroup } from '@songdeck/core';

/** Stem groups as choices (Stems.zip, Instrumental/Acapella exports). */
export const STEM_GROUPS: { value: StemGroup; label: string }[] = [
  { value: 'vocals', label: 'Vocals' },
  { value: 'drums', label: 'Drums' },
  { value: 'bass', label: 'Bass' },
  { value: 'guitars', label: 'Guitars' },
  { value: 'keys', label: 'Keys' },
  { value: 'strings', label: 'Strings' },
  { value: 'others', label: 'Others' },
];
