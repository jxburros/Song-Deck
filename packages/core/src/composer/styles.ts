/**
 * Traits of each drum style ("groove family"). The original eighteen styles drive most generator
 * decisions directly; the styles added with the genre expansion (one-drop, dembow, bossa nova…)
 * name the closest original family as their `base`, so generators without a dedicated idiom for
 * them still behave sensibly, plus the kit, harmonic flavour, auxiliary percussion family and the
 * preferred tonic family of the prompt parser.
 */
import type { DrumStyle } from '../ir/types';

/** The original groove families every generator knows. */
export type BaseDrumStyle =
  | 'rock'
  | 'punk'
  | 'pop-punk'
  | 'emo'
  | 'metal'
  | 'indie'
  | 'pop'
  | 'synth-pop'
  | 'four-on-floor'
  | 'trance'
  | 'hip-hop'
  | 'trap'
  | 'rnb'
  | 'jazz-swing'
  | 'folk'
  | 'country'
  | 'orchestral'
  | 'cinematic';

export type HarmonicFlavor = 'jazz' | 'soul' | 'pop' | 'rock' | 'ambient' | 'classical';

/** Which auxiliary percussion a `percussion` track plays. */
export type PercussionFamily =
  | 'band'
  | 'electronic'
  | 'urban'
  | 'jazz'
  | 'orchestral'
  | 'latin'
  | 'brazil'
  | 'afro'
  | 'caribbean'
  | 'flamenco'
  | 'celtic'
  | 'south-asian'
  | 'disco';

/** Preferred tonic family for keys chosen by the prompt parser. */
export type TonicFamily = 'guitar' | 'metal' | 'keys' | 'electronic' | 'orchestral' | 'jazz';

export interface DrumStyleInfo {
  base: BaseDrumStyle;
  /** Programmed / drum-machine kit by default ("drums" in a prompt → electronic kit). */
  electronic: boolean;
  flavor: HarmonicFlavor;
  percussion: PercussionFamily;
  tonic: TonicFamily;
  /** Rap is the natural vocal delivery in verses. */
  rap?: boolean;
  /** Heavy, riff-driven guitar music. */
  heavy?: boolean;
}

const I = (
  base: BaseDrumStyle,
  electronic: boolean,
  flavor: HarmonicFlavor,
  percussion: PercussionFamily,
  tonic: TonicFamily,
  extra: Partial<DrumStyleInfo> = {},
): DrumStyleInfo => ({
  base,
  electronic,
  flavor,
  percussion,
  tonic,
  ...extra,
});

export const DRUM_STYLE_INFO: Record<DrumStyle, DrumStyleInfo> = {
  rock: I('rock', false, 'rock', 'band', 'guitar', { heavy: true }),
  punk: I('punk', false, 'rock', 'band', 'guitar', { heavy: true }),
  'pop-punk': I('pop-punk', false, 'rock', 'band', 'guitar', { heavy: true }),
  emo: I('emo', false, 'ambient', 'band', 'guitar', { heavy: true }),
  metal: I('metal', false, 'rock', 'band', 'metal', { heavy: true }),
  indie: I('indie', false, 'ambient', 'band', 'guitar'),
  pop: I('pop', false, 'pop', 'band', 'keys'),
  'synth-pop': I('synth-pop', true, 'pop', 'electronic', 'electronic'),
  'four-on-floor': I('four-on-floor', true, 'pop', 'electronic', 'electronic'),
  trance: I('trance', true, 'ambient', 'electronic', 'electronic'),
  'hip-hop': I('hip-hop', true, 'soul', 'urban', 'electronic', { rap: true }),
  trap: I('trap', true, 'soul', 'urban', 'electronic', { rap: true }),
  rnb: I('rnb', false, 'soul', 'urban', 'keys'),
  'jazz-swing': I('jazz-swing', false, 'jazz', 'jazz', 'jazz'),
  folk: I('folk', false, 'pop', 'band', 'guitar'),
  country: I('country', false, 'pop', 'band', 'guitar'),
  orchestral: I('orchestral', false, 'classical', 'orchestral', 'orchestral'),
  cinematic: I('cinematic', false, 'ambient', 'orchestral', 'orchestral'),
  funk: I('rnb', false, 'soul', 'disco', 'keys'),
  disco: I('four-on-floor', false, 'soul', 'disco', 'keys'),
  soul: I('rnb', false, 'soul', 'band', 'keys'),
  gospel: I('rnb', false, 'soul', 'band', 'keys'),
  shuffle: I('rock', false, 'soul', 'band', 'guitar'),
  'boom-bap': I('hip-hop', false, 'soul', 'urban', 'keys', { rap: true }),
  'one-drop': I('rnb', false, 'pop', 'caribbean', 'keys'),
  ska: I('pop', false, 'pop', 'caribbean', 'keys'),
  dembow: I('hip-hop', true, 'pop', 'latin', 'electronic'),
  'bossa-nova': I('jazz-swing', false, 'jazz', 'brazil', 'jazz'),
  samba: I('pop', false, 'jazz', 'brazil', 'jazz'),
  salsa: I('pop', false, 'pop', 'latin', 'keys'),
  cumbia: I('folk', false, 'pop', 'latin', 'keys'),
  afrobeats: I('hip-hop', true, 'soul', 'afro', 'electronic'),
  amapiano: I('four-on-floor', true, 'soul', 'afro', 'electronic'),
  'drum-and-bass': I('trance', true, 'ambient', 'electronic', 'electronic'),
  breakbeat: I('hip-hop', false, 'pop', 'electronic', 'electronic'),
  dubstep: I('trap', true, 'pop', 'electronic', 'electronic'),
  techno: I('four-on-floor', true, 'ambient', 'electronic', 'electronic'),
  'two-step': I('four-on-floor', true, 'soul', 'electronic', 'electronic'),
  drill: I('trap', true, 'pop', 'urban', 'electronic', { rap: true }),
  phonk: I('trap', true, 'pop', 'urban', 'electronic', { rap: true }),
  'jersey-club': I('four-on-floor', true, 'pop', 'electronic', 'electronic'),
  footwork: I('trap', true, 'soul', 'electronic', 'electronic'),
  'baile-funk': I('hip-hop', true, 'pop', 'brazil', 'electronic', { rap: true }),
  flamenco: I('folk', false, 'pop', 'flamenco', 'guitar'),
  celtic: I('folk', false, 'pop', 'celtic', 'guitar'),
  bhangra: I('folk', false, 'pop', 'south-asian', 'keys'),
  ambient: I('cinematic', true, 'ambient', 'electronic', 'electronic'),
};

/** Traits of a drum style (unknown styles behave like rock). */
export function drumStyleInfo(style: DrumStyle | string | undefined): DrumStyleInfo {
  return DRUM_STYLE_INFO[style as DrumStyle] ?? DRUM_STYLE_INFO.rock;
}

/** The original groove family closest to a drum style. */
export function baseDrumStyle(style: DrumStyle | string | undefined): BaseDrumStyle {
  return drumStyleInfo(style).base;
}

/** Every drum style, in declaration order (for UIs and docs). */
export const ALL_DRUM_STYLES = Object.keys(DRUM_STYLE_INFO) as DrumStyle[];
