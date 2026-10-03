/**
 * The built-in tag catalog (see tags.ts for the contract). Genre and style names are facts; the
 * musical descriptions and effects are our own. Style tags name parent genres that exist in
 * genres.ts and describe how the style differs from them (tempo window, modes, groove, harmony,
 * instrumentation, macros, production). Mood tags map a feeling to valence/arousal-style changes;
 * era, production, vocal, region and rhythm tags each carry a musical change too.
 *
 * Row helpers: par('punk:0.6 indie-rock:0.4') → parents, md('minor:0.6 dorian:0.2') → modes,
 * tp(min, max, typical?) → tempo window, pr('i VI III VII', w) → progression, add(…) → instrument.
 */
import type { GenreWeight, ModeName, MusicalFunction, TrackRole } from '../ir/types';
import type { StyleTag, TagEffect, TagKind } from './tags';

type Added = NonNullable<NonNullable<TagEffect['instruments']>['add']>[number];

const add = (
  instrumentId: string,
  role: TrackRole,
  weight = 0.7,
  fn?: MusicalFunction,
  essential?: boolean,
): Added => ({
  instrumentId,
  role,
  weight,
  ...(fn ? { function: fn } : {}),
  ...(essential ? { essential: true } : {}),
});

const par = (spec: string): GenreWeight[] =>
  spec
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => {
      const [genreId, w] = x.split(':');
      return { genreId, weight: w ? Number(w) : 1 };
    });

const md = (spec: string): { mode: ModeName; weight: number }[] =>
  spec
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => {
      const [mode, w] = x.split(':');
      return { mode: mode as ModeName, weight: w ? Number(w) : 0.5 };
    });

const tp = (min: number, max: number, typical?: number): TagEffect['tempo'] => ({
  min,
  max,
  typical: typical ?? Math.round((min + max) / 2),
});

const pr = (roman: string, weight = 1.5) => ({ roman: roman.split(/\s+/), weight });

const m34 = { numerator: 3, denominator: 4, weight: 1.5 };
const m68 = { numerator: 6, denominator: 8, weight: 1.5 };
const m128 = { numerator: 12, denominator: 8, weight: 1.5 };
const m54 = { numerator: 5, denominator: 4, weight: 0.8 };
const m78 = { numerator: 7, denominator: 8, weight: 0.8 };

interface RowExtra {
  parents?: string;
  aliases?: string[];
}

function kindOf(kind: TagKind, group: string) {
  return (
    id: string,
    name: string,
    description: string,
    effect: TagEffect,
    extra: RowExtra = {},
  ): StyleTag => ({
    id,
    name,
    kind,
    group,
    description,
    ...(extra.aliases?.length ? { aliases: extra.aliases } : {}),
    ...(extra.parents ? { parents: par(extra.parents) } : {}),
    effect,
  });
}

const DRUM_KITS = ['drum-kit', 'electronic-kit'];
const SYNTHS = ['synth-pad', 'synth-lead', 'synth-arp', 'synth-seq', 'synth-bass', '808-bass'];

// ---------------------------------------------------------------------------------------------
// Style tags (microgenres)
// ---------------------------------------------------------------------------------------------

const rock = kindOf('style', 'Rock & alternative');
const metal = kindOf('style', 'Metal');
const punk = kindOf('style', 'Punk & hardcore');
const pop = kindOf('style', 'Pop');
const indie = kindOf('style', 'Indie');
const house = kindOf('style', 'House & techno');
const bass = kindOf('style', 'Bass music & breaks');
const retro = kindOf('style', 'Synth & retro');
const downtempo = kindOf('style', 'Downtempo & ambient');
const hiphop = kindOf('style', 'Hip-hop & rap');
const soul = kindOf('style', 'R&B, soul & funk');
const jazz = kindOf('style', 'Jazz & blues');
const roots = kindOf('style', 'Folk, country & roots');
const latin = kindOf('style', 'Latin');
const caribbean = kindOf('style', 'Caribbean');
const african = kindOf('style', 'African');
const asian = kindOf('style', 'Asian');
const world = kindOf('style', 'World & traditional');
const classical = kindOf('style', 'Classical & cinematic');
const special = kindOf('style', 'Occasions & media');

const ROCK_TAGS: StyleTag[] = [
  rock(
    'post-punk',
    'Post-punk',
    'Angular guitars, a driving melodic bass up front and cold, roomy drums',
    {
      tempo: tp(120, 166, 142),
      modes: md('minor:0.6'),
      rhythm: { drumStyle: 'indie', bassStyle: 'eighths' },
      instruments: {
        add: [add('electric-guitar-clean', 'rhythm-guitar', 0.9, 'accompaniment')],
        remove: ['piano', 'acoustic-guitar'],
      },
      macros: { repetition: -0.12, humanization: -0.05 },
      production: { keywords: ['post-punk', 'angular guitars', 'driving bass', 'chorus pedal'], reverb: 0.4 },
    },
    { parents: 'punk:0.5 indie-rock:0.5', aliases: ['post punk', 'post-punk revival'] },
  ),
  rock(
    'new-wave',
    'New wave',
    'Jittery late-70s/80s pop-rock: synths, chorus guitars, robotic eighths',
    {
      tempo: tp(118, 160, 136),
      rhythm: { drumStyle: 'synth-pop', bassStyle: 'eighths' },
      instruments: {
        add: [add('synth-lead', 'synth-lead', 0.6, 'hook'), add('synth-pad', 'synth-pad', 0.5, 'pad')],
      },
      macros: { humanization: -0.15 },
      production: { keywords: ['new wave', '80s', 'chorus guitars', 'synths'] },
    },
    { parents: 'synth-pop:0.5 rock:0.5', aliases: ['new-wave'] },
  ),
  rock(
    'darkwave',
    'Darkwave',
    'Cold minor-key drum machines, gothic synth pads and a baritone gloom',
    {
      tempo: tp(100, 140, 120),
      modes: md('minor:0.8 phrygian:0.2'),
      rhythm: { drumStyle: 'synth-pop', bassStyle: 'eighths' },
      instruments: {
        add: [add('synth-pad', 'synth-pad', 0.8, 'pad'), add('electronic-kit', 'drums', 0.9, 'rhythm')],
        remove: ['drum-kit', 'acoustic-guitar'],
      },
      macros: { energy: -0.05, humanization: -0.2 },
      production: { keywords: ['darkwave', 'coldwave', 'gothic', 'cold synths'], reverb: 0.5 },
    },
    { parents: 'synth-pop:0.7 indie-rock:0.3', aliases: ['coldwave', 'dark wave'] },
  ),
  rock(
    'gothic-rock',
    'Gothic rock',
    'Brooding minor-key rock: tom-heavy grooves, flanged guitars, cavernous reverb',
    {
      tempo: tp(100, 145, 124),
      modes: md('minor:0.8 phrygian:0.2'),
      harmony: { borrowedChordRate: 0.3, progressions: [pr('i bII i VII', 1.2)] },
      macros: { harmonicTension: 0.15, energy: -0.05 },
      production: { keywords: ['goth', 'gothic rock', 'cavernous reverb', 'flanger'], reverb: 0.55 },
    },
    { parents: 'alternative-rock:0.6 synth-pop:0.4', aliases: ['goth rock', 'goth'] },
  ),
  rock(
    'garage-rock',
    'Garage rock',
    'Raw, fast, fuzzy and a little sloppy: three chords and a cheap amp',
    {
      tempo: tp(130, 180, 156),
      harmony: { extensionRate: 0, progressions: [pr('I IV V IV', 2), pr('I bVII IV I', 1.5)] },
      instruments: { add: [add('organ', 'keys', 0.4, 'pad')], remove: ['synth-pad', 'string-ensemble'] },
      macros: { humanization: 0.25, complexity: -0.15, energy: 0.1 },
      production: { keywords: ['garage rock', 'raw', 'fuzz', 'lo-fi'], reverb: 0.15 },
    },
    { parents: 'rock:0.6 punk:0.4' },
  ),
  rock(
    'psychedelic-rock',
    'Psychedelic rock',
    'Modal drones, swirling organ, phased guitars and long jams',
    {
      tempo: tp(90, 135, 112),
      modes: md('mixolydian:0.5 dorian:0.4'),
      harmony: { borrowedChordRate: 0.3, progressions: [pr('I bVII IV I', 1.5), pr('i IV', 1.5)] },
      instruments: {
        add: [add('organ', 'keys', 0.8, 'pad'), add('electric-guitar-lead', 'lead-guitar', 0.7, 'solo')],
      },
      macros: { repetition: -0.1, complexity: 0.1 },
      production: { keywords: ['psychedelic', 'phaser', 'swirling organ', '60s'], reverb: 0.5 },
    },
    { parents: 'rock:0.7 indie-rock:0.3', aliases: ['psych rock', 'psychedelia', 'acid rock'] },
  ),
  rock(
    'stoner-rock',
    'Stoner rock',
    'Slow, fuzzed-out, down-tuned riffs that lock into a heavy groove',
    {
      tempo: tp(68, 112, 88),
      modes: md('minor:0.6 dorian:0.3'),
      rhythm: { halfTimeChance: 0.5 },
      harmony: { powerChords: true, progressions: [pr('i bIII IV i', 1.5)] },
      macros: { energy: 0.1, repetition: -0.1, density: 0.1 },
      production: {
        keywords: ['stoner rock', 'desert rock', 'fuzz', 'down-tuned'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'rock:0.6 metal:0.4', aliases: ['desert rock', 'stoner'] },
  ),
  rock(
    'surf-rock',
    'Surf rock',
    'Reverb-soaked twangy lead guitar, galloping drums, minor-key drama',
    {
      tempo: tp(150, 190, 168),
      modes: md('harmonic-minor:0.4 minor:0.3'),
      harmony: { progressions: [pr('i iv V i', 1.5), pr('I bVII bVI V', 1.2)] },
      instruments: {
        add: [add('electric-guitar-clean', 'lead-guitar', 1, 'melody', true)],
        remove: ['synth-pad', 'piano'],
      },
      macros: { energy: 0.1 },
      production: { keywords: ['surf rock', 'spring reverb', 'twang', 'tremolo picking'], reverb: 0.6 },
    },
    { parents: 'rock:1', aliases: ['surf'] },
  ),
  rock(
    'southern-rock',
    'Southern rock',
    'Bluesy, twin-guitar rock with a swagger and a country accent',
    {
      tempo: tp(90, 140, 112),
      modes: md('mixolydian:0.5 major:0.3'),
      rhythm: { swing: 0.15 },
      harmony: { progressions: [pr('I bVII IV I', 2)] },
      instruments: {
        add: [
          add('electric-guitar-lead', 'lead-guitar', 0.9, 'solo'),
          add('piano', 'keys', 0.5, 'accompaniment'),
          add('organ', 'keys', 0.4, 'pad'),
        ],
      },
      macros: { humanization: 0.15 },
      production: { keywords: ['southern rock', 'twin guitars', 'bluesy', 'slide guitar'] },
    },
    { parents: 'rock:0.7 country:0.3' },
  ),
  rock(
    'classic-rock',
    'Classic rock',
    '70s radio rock: riffs, Hammond organ, big drums and guitar solos',
    {
      tempo: tp(96, 140, 118),
      modes: md('mixolydian:0.3 major:0.3'),
      harmony: { progressions: [pr('I bVII IV I', 1.5), pr('I IV V IV', 1)] },
      instruments: {
        add: [add('organ', 'keys', 0.6, 'pad'), add('electric-guitar-lead', 'lead-guitar', 0.8, 'solo')],
        remove: ['synth-pad', 'synth-arp'],
      },
      macros: { humanization: 0.15 },
      production: { keywords: ['classic rock', '70s', 'analog', 'hammond organ'] },
    },
    { parents: 'rock:1' },
  ),
  rock(
    'hard-rock',
    'Hard rock',
    'Loud, riff-first rock with swagger: crunchy guitars, big drums, belted vocals',
    {
      tempo: tp(100, 150, 124),
      harmony: { powerChords: true, extensionRate: 0.02 },
      rhythm: { halfTimeChance: 0.15 },
      macros: { energy: 0.15, density: 0.1 },
      energyShift: 5,
      production: { keywords: ['hard rock', 'crunchy', 'riff-driven'], masteringTarget: 'loud-rock' },
    },
    { parents: 'rock:0.8 metal:0.2' },
  ),
  rock(
    'glam-rock',
    'Glam rock',
    'Stomping, handclapped boogie rock with glitter and big singalong hooks',
    {
      tempo: tp(100, 140, 120),
      rhythm: { swing: 0.15 },
      harmony: { progressions: [pr('I bVII IV I', 1.5)] },
      instruments: {
        add: [
          add('percussion', 'percussion', 0.7, 'rhythm'),
          add('piano', 'keys', 0.6, 'accompaniment'),
          add('backing-vocal', 'vocal', 0.7, 'harmony'),
        ],
      },
      macros: { syncopation: -0.1 },
      production: { keywords: ['glam rock', 'stomp', 'handclaps', '70s'] },
    },
    { parents: 'rock:0.7 pop:0.3', aliases: ['glam'] },
  ),
  rock(
    'arena-rock',
    'Arena rock',
    'Stadium-sized anthems: power ballads, big gated drums, keyboards and gang choruses',
    {
      tempo: tp(80, 140, 116),
      instruments: {
        add: [add('synth-pad', 'synth-pad', 0.7, 'pad'), add('backing-vocal', 'vocal', 0.8, 'harmony')],
      },
      macros: { dynamics: 0.15, energy: 0.1 },
      energyShift: 4,
      production: { keywords: ['arena rock', 'stadium', 'anthemic', '80s'], reverb: 0.4 },
    },
    { parents: 'rock:0.7 pop:0.3', aliases: ['stadium rock', 'aor'] },
  ),
  rock(
    'prog-rock',
    'Progressive rock',
    'Long-form rock with odd meters, extended harmony, keyboard solos and suites',
    {
      tempo: tp(80, 150, 116),
      meters: [m78, m54],
      modes: md('dorian:0.3 lydian:0.2'),
      harmony: { extensionRate: 0.35, borrowedChordRate: 0.35 },
      instruments: { add: [add('organ', 'keys', 0.7, 'pad'), add('synth-lead', 'synth-lead', 0.5, 'solo')] },
      macros: { complexity: 0.3, repetition: 0.2 },
      production: { keywords: ['progressive rock', 'prog', 'odd meters', 'concept album'] },
    },
    { parents: 'rock:0.8 cinematic:0.2', aliases: ['prog', 'progressive rock'] },
  ),
  rock(
    'math-rock',
    'Math rock',
    'Intricate odd-meter riffs, tapped clean guitars and stop-start dynamics',
    {
      tempo: tp(110, 170, 138),
      meters: [m78, m54, { numerator: 7, denominator: 4, weight: 0.5 }],
      rhythm: { syncopation: 0.7, compStyle: 'arpeggio' },
      instruments: { add: [add('electric-guitar-clean', 'lead-guitar', 0.9, 'counter-melody')] },
      macros: { complexity: 0.35, syncopation: 0.2 },
      production: { keywords: ['math rock', 'tapping', 'odd time signatures', 'clean guitars'] },
    },
    { parents: 'indie-rock:0.7 emo:0.3', aliases: ['math-rock', 'mathrock'] },
  ),
  rock(
    'midwest-emo',
    'Midwest emo',
    'Twinkly interlocking clean guitars, maj7 shimmer, odd bars and confessional yelps',
    {
      tempo: tp(120, 176, 148),
      meters: [{ numerator: 7, denominator: 8, weight: 0.3 }],
      harmony: { extensionRate: 0.5, progressions: [pr('IVmaj7 Imaj7 vi7 V', 2)] },
      rhythm: { compStyle: 'arpeggio' },
      instruments: {
        add: [
          add('electric-guitar-clean', 'lead-guitar', 1, 'counter-melody', true),
          add('trumpet', 'custom', 0.3, 'counter-melody'),
        ],
      },
      macros: { complexity: 0.15, dynamics: 0.1 },
      production: { keywords: ['midwest emo', 'twinkly guitars', 'emo revival'], reverb: 0.25 },
    },
    { parents: 'emo:0.8 indie-rock:0.2', aliases: ['twinkly emo', 'emo revival', 'twinkle emo'] },
  ),
  rock(
    'screamo',
    'Screamo',
    'Frantic emo-hardcore: blast-fast sections, dissonant chords, screamed catharsis',
    {
      tempo: tp(150, 210, 176),
      modes: md('minor:0.7'),
      harmony: { borrowedChordRate: 0.35 },
      rhythm: { halfTimeChance: 0.4 },
      macros: { energy: 0.2, harmonicTension: 0.2, dynamics: 0.15 },
      energyShift: 6,
      production: {
        keywords: ['screamo', 'screamed vocals', 'skramz', 'chaotic'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'emo:0.6 punk:0.4', aliases: ['skramz'] },
  ),
  rock(
    'post-hardcore',
    'Post-hardcore',
    'Hardcore energy with melodic hooks, clean/screamed contrast and dynamic builds',
    {
      tempo: tp(130, 190, 160),
      modes: md('minor:0.6'),
      rhythm: { halfTimeChance: 0.45 },
      harmony: { powerChords: true },
      macros: { dynamics: 0.2, energy: 0.1 },
      production: {
        keywords: ['post-hardcore', 'dynamic', 'screamed and sung'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'emo:0.5 punk:0.3 metal:0.2' },
  ),
  rock(
    'britpop',
    'Britpop',
    '90s British guitar pop: jangly-to-crunchy guitars, singalong choruses, swagger',
    {
      tempo: tp(96, 140, 118),
      modes: md('major:0.6'),
      harmony: { progressions: [pr('I V vi IV', 1), pr('I iii IV iv', 1.5)] },
      instruments: {
        add: [add('piano', 'keys', 0.5, 'accompaniment'), add('string-ensemble', 'strings', 0.3, 'pad')],
      },
      macros: { melodicMovement: 0.1 },
      production: { keywords: ['britpop', '90s', 'british', 'singalong'] },
    },
    { parents: 'indie-rock:0.6 rock:0.4', aliases: ['brit pop'] },
  ),
  rock(
    'noise-rock',
    'Noise rock',
    'Abrasive, dissonant guitars and pounding repetition',
    {
      tempo: tp(100, 160, 132),
      harmony: { borrowedChordRate: 0.45, progressions: [pr('i bII i bV', 1)] },
      macros: { harmonicTension: 0.3, energy: 0.15, repetition: -0.15 },
      production: {
        keywords: ['noise rock', 'feedback', 'abrasive', 'dissonant'],
        reverb: 0.2,
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'indie-rock:0.6 punk:0.4' },
  ),
  rock(
    'slowcore',
    'Slowcore',
    'Glacial tempos, sparse clean guitars and hushed, heavy-hearted songs',
    {
      tempo: tp(56, 84, 70),
      modes: md('minor:0.4 major:0.3'),
      rhythm: { halfTimeChance: 0.5, compStyle: 'sustain' },
      macros: { density: -0.3, energy: -0.3, dynamics: -0.1 },
      energyShift: -15,
      production: { keywords: ['slowcore', 'sadcore', 'sparse', 'hushed'], reverb: 0.4 },
    },
    { parents: 'indie-rock:0.7 singer-songwriter:0.3', aliases: ['sadcore'] },
  ),
  rock(
    'krautrock',
    'Krautrock',
    'Hypnotic motorik beat, droning repetition and analog synth textures',
    {
      tempo: tp(120, 150, 136),
      rhythm: { drumStyle: 'indie', syncopation: 0.15, bassStyle: 'eighths' },
      harmony: { harmonicRhythm: 0.25, progressions: [pr('i', 2), pr('I bVII', 1)] },
      instruments: { add: [add('synth-seq', 'synth-seq', 0.7, 'rhythm'), add('organ', 'keys', 0.5, 'pad')] },
      macros: { repetition: -0.3, humanization: -0.05 },
      production: { keywords: ['krautrock', 'motorik', 'hypnotic', 'kosmische'] },
    },
    { parents: 'indie-rock:0.6 techno:0.4', aliases: ['motorik rock', 'kosmische'] },
  ),
  rock(
    'space-rock',
    'Space rock',
    'Cosmic drones, delay-drenched guitars and swirling synths over a steady pulse',
    {
      tempo: tp(90, 140, 116),
      modes: md('mixolydian:0.3 dorian:0.3'),
      instruments: {
        add: [add('synth-pad', 'synth-pad', 0.8, 'pad'), add('synth-arp', 'synth-arp', 0.5, 'texture')],
      },
      macros: { repetition: -0.15, density: 0.1 },
      production: { keywords: ['space rock', 'cosmic', 'delay', 'swirling'], reverb: 0.65 },
    },
    { parents: 'rock:0.6 post-rock:0.4' },
  ),
  rock(
    'blues-rock',
    'Blues rock',
    'Overdriven blues licks, shuffles and pentatonic solos at rock volume',
    {
      tempo: tp(80, 140, 108),
      modes: md('mixolydian:0.4 minor:0.3'),
      rhythm: { swing: 0.35, subdivision: 12 },
      harmony: {
        progressions: [pr('V7/IV V7/bVII V7/IV V7/IV V7/bVII V7/bVII V7/IV V7/IV V7 V7/bVII V7/IV V7', 1.5)],
      },
      instruments: { add: [add('electric-guitar-lead', 'lead-guitar', 0.9, 'solo', true)] },
      macros: { humanization: 0.15 },
      production: { keywords: ['blues rock', 'overdriven', 'pentatonic solos'] },
    },
    { parents: 'rock:0.6 blues:0.4' },
  ),
  rock(
    'rockabilly',
    'Rockabilly',
    '50s rock and roll meets hillbilly boogie: slap upright bass, twangy leads, fast shuffle',
    {
      tempo: tp(150, 200, 176),
      modes: md('major:0.8'),
      rhythm: { swing: 0.45, subdivision: 12, drumStyle: 'shuffle', bassStyle: 'walking' },
      harmony: { progressions: [pr('V7/IV V7/IV V7/bVII V7/IV V7 V7/bVII V7/IV V7', 1.5)] },
      instruments: {
        add: [
          add('upright-bass', 'bass', 1, 'bass-line', true),
          add('electric-guitar-clean', 'lead-guitar', 0.9, 'hook'),
        ],
        remove: ['electric-bass', 'synth-bass', 'synth-pad'],
      },
      macros: { energy: 0.1, humanization: 0.2 },
      production: { keywords: ['rockabilly', 'slapback echo', 'slap bass', '50s'], reverb: 0.3 },
    },
    { parents: 'rock:0.6 country:0.4', aliases: ['rock and roll', "rock 'n' roll", 'rock n roll'] },
  ),
  rock(
    'power-pop',
    'Power pop',
    'Crunchy guitars with Beatles-sweet melodies and stacked harmonies',
    {
      tempo: tp(120, 160, 140),
      modes: md('major:0.8'),
      harmony: { progressions: [pr('I iii IV V', 1.5), pr('I V vi iii IV', 1)] },
      instruments: { add: [add('backing-vocal', 'vocal', 0.8, 'harmony')] },
      macros: { melodicMovement: 0.15, energy: 0.05 },
      production: { keywords: ['power pop', 'jangly', 'harmonies', 'crunchy'] },
    },
    { parents: 'rock:0.5 pop:0.5', aliases: ['powerpop'] },
  ),
  rock(
    'yacht-rock',
    'Yacht rock',
    'Smooth late-70s soft rock: Rhodes, maj7 chords, slick session grooves',
    {
      tempo: tp(86, 116, 100),
      modes: md('major:0.6 dorian:0.2'),
      rhythm: { drumStyle: 'rnb', swing: 0.1 },
      harmony: {
        extensionRate: 0.8,
        progressions: [pr('IVmaj7 iii7 ii7 Imaj7', 2), pr('ii7 V7 Imaj7 IVmaj7', 1.5)],
      },
      instruments: {
        add: [
          add('electric-piano', 'keys', 0.9, 'accompaniment', true),
          add('saxophone', 'custom', 0.4, 'counter-melody'),
        ],
        remove: ['electric-guitar-distorted'],
      },
      macros: { harmonicTension: 0.15, energy: -0.1 },
      production: { keywords: ['yacht rock', 'smooth', 'west coast', 'rhodes', 'soft rock'] },
    },
    { parents: 'pop:0.5 soul:0.3 rock:0.2', aliases: ['west coast aor', 'yacht'] },
  ),
  rock(
    'soft-rock',
    'Soft rock',
    'Mellow, melodic rock with acoustic guitars, piano and warm harmonies',
    {
      tempo: tp(72, 112, 92),
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 0.8, 'accompaniment'),
          add('piano', 'keys', 0.7, 'accompaniment'),
        ],
        remove: ['electric-guitar-distorted'],
      },
      harmony: { powerChords: false, extensionRate: 0.25 },
      macros: { energy: -0.15 },
      energyShift: -6,
      production: { keywords: ['soft rock', 'mellow', 'warm'] },
    },
    { parents: 'rock:0.5 pop:0.5', aliases: ['mellow rock'] },
  ),
  rock(
    'heartland-rock',
    'Heartland rock',
    'Earnest American storytelling rock: driving eighths, organ, harmonica and big choruses',
    {
      tempo: tp(110, 150, 128),
      modes: md('major:0.7'),
      rhythm: { bassStyle: 'eighths' },
      instruments: {
        add: [
          add('organ', 'keys', 0.6, 'pad'),
          add('harmonica', 'custom', 0.4, 'counter-melody'),
          add('piano', 'keys', 0.5, 'accompaniment'),
        ],
      },
      production: { keywords: ['heartland rock', 'americana', 'anthemic', 'driving'] },
      macros: { energy: 0.05 },
    },
    { parents: 'rock:0.7 country:0.3', aliases: ['heartland'] },
  ),
  rock(
    'post-grunge',
    'Post-grunge',
    'Radio-friendly heavy rock: drop-tuned crunch, polished production, big hooks',
    {
      tempo: tp(80, 130, 104),
      modes: md('minor:0.5'),
      harmony: { powerChords: true },
      macros: { humanization: -0.15, dynamics: -0.1 },
      production: {
        keywords: ['post-grunge', 'radio rock', 'polished', 'drop-tuned'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'grunge:0.6 alternative-rock:0.4' },
  ),
  rock(
    'dance-punk',
    'Dance-punk',
    'Punk energy on a disco beat: cowbell, four-on-the-floor kick, wiry guitars',
    {
      tempo: tp(116, 134, 124),
      rhythm: { drumStyle: 'disco', bassStyle: 'octave' },
      instruments: {
        add: [add('percussion', 'percussion', 0.7, 'rhythm'), add('synth-lead', 'synth-lead', 0.4, 'hook')],
      },
      macros: { syncopation: 0.1 },
      production: { keywords: ['dance-punk', 'cowbell', 'disco beat', 'wiry guitars'] },
    },
    { parents: 'punk:0.5 disco:0.5', aliases: ['dance punk', 'disco punk'] },
  ),
  rock(
    'blackgaze',
    'Blackgaze',
    'Black-metal blast beats under shoegaze walls of major-key shimmer',
    {
      tempo: tp(140, 200, 168),
      modes: md('major:0.3 lydian:0.2'),
      rhythm: { drumStyle: 'metal' },
      macros: { density: 0.2, energy: 0.15 },
      production: { keywords: ['blackgaze', 'tremolo picking', 'wall of sound', 'blast beats'], reverb: 0.6 },
    },
    { parents: 'shoegaze:0.5 metal:0.5' },
  ),
  rock(
    'alt-country',
    'Alt-country',
    'Country songwriting with indie-rock grit: twangy guitars, ragged harmonies',
    {
      tempo: tp(80, 130, 104),
      modes: md('major:0.5 mixolydian:0.2'),
      instruments: {
        add: [
          add('pedal-steel', 'lead-guitar', 0.6, 'counter-melody'),
          add('acoustic-guitar', 'rhythm-guitar', 0.8, 'accompaniment'),
        ],
      },
      macros: { humanization: 0.15 },
      production: { keywords: ['alt-country', 'twang', 'ragged', 'americana'] },
    },
    { parents: 'country:0.5 indie-rock:0.5', aliases: ['alt country', 'insurgent country'] },
  ),
  rock(
    'rap-rock',
    'Rap rock',
    'Distorted riffs under rapped verses and shouted hooks',
    {
      tempo: tp(86, 110, 98),
      rhythm: { drumStyle: 'hip-hop', syncopation: 0.55 },
      harmony: { powerChords: true },
      macros: { melodicMovement: -0.2, energy: 0.15 },
      production: { keywords: ['rap rock', 'rap metal', 'distorted riffs'], masteringTarget: 'loud-rock' },
    },
    { parents: 'rock:0.5 hip-hop:0.5', aliases: ['rap metal'] },
  ),
];

const METAL_TAGS: StyleTag[] = [
  metal(
    'nu-metal',
    'Nu metal',
    'Drop-tuned groove riffs, hip-hop beats, turntable scratches and angst',
    {
      tempo: tp(84, 116, 100),
      modes: md('phrygian:0.4 minor:0.4'),
      rhythm: { drumStyle: 'hip-hop', syncopation: 0.6, halfTimeChance: 0.4 },
      harmony: { powerChords: true, progressions: [pr('i bII i', 2)] },
      macros: { melodicMovement: -0.15, complexity: -0.1 },
      production: {
        keywords: ['nu metal', 'drop-tuned', 'groove', 'turntables'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'metal:0.7 hip-hop:0.3', aliases: ['nu-metal', 'numetal'] },
  ),
  metal(
    'djent',
    'Djent',
    'Palm-muted polyrhythmic chugs on extended-range guitars, ambient clean interludes',
    {
      tempo: tp(100, 150, 124),
      meters: [m78, { numerator: 7, denominator: 4, weight: 0.4 }],
      modes: md('phrygian:0.4 minor:0.3 lydian:0.2'),
      rhythm: { syncopation: 0.8 },
      instruments: { add: [add('synth-pad', 'synth-pad', 0.6, 'pad')] },
      macros: { complexity: 0.3, syncopation: 0.3, humanization: -0.1 },
      production: { keywords: ['djent', 'polyrhythmic', 'extended-range guitars', 'tight'] },
    },
    { parents: 'metal:1' },
  ),
  metal(
    'sludge-metal',
    'Sludge metal',
    'Crushing, slow and filthy: down-tuned riffs, hardcore shouts, feedback',
    {
      tempo: tp(56, 96, 76),
      modes: md('minor:0.5 phrygian:0.3'),
      rhythm: { halfTimeChance: 0.6 },
      macros: { energy: 0.1, humanization: 0.2 },
      production: {
        keywords: ['sludge', 'down-tuned', 'feedback', 'crushing'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'metal:0.7 grunge:0.3', aliases: ['sludge'] },
  ),
  metal(
    'doom-metal',
    'Doom metal',
    'Funereal tempos, enormous minor riffs and mournful melodies',
    {
      tempo: tp(48, 80, 64),
      modes: md('minor:0.4 phrygian:0.3 harmonic-minor:0.3'),
      rhythm: { halfTimeChance: 0.6 },
      harmony: { harmonicRhythm: 0.5, progressions: [pr('i bVI bII i', 1.5)] },
      macros: { energy: -0.05, harmonicTension: 0.2 },
      energyShift: -5,
      production: {
        keywords: ['doom', 'funereal', 'crushing riffs'],
        reverb: 0.35,
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'metal:1', aliases: ['doom'] },
  ),
  metal(
    'black-metal',
    'Black metal',
    'Tremolo-picked minor chords, blast beats, cold lo-fi production, shrieked vocals',
    {
      tempo: tp(160, 220, 190),
      modes: md('minor:0.4 harmonic-minor:0.3 phrygian:0.3'),
      harmony: { powerChords: false, progressions: [pr('i VI VII i', 1.5), pr('i bII VII i', 1)] },
      instruments: { add: [add('synth-pad', 'synth-pad', 0.4, 'pad')] },
      macros: { energy: 0.2, harmonicTension: 0.15 },
      production: {
        keywords: ['black metal', 'tremolo picking', 'blast beats', 'raw', 'cold'],
        reverb: 0.45,
      },
    },
    { parents: 'metal:1' },
  ),
  metal(
    'death-metal',
    'Death metal',
    'Brutal, chromatic riffing, blast beats and guttural growls',
    {
      tempo: tp(150, 220, 180),
      modes: md('phrygian:0.5 harmonic-minor:0.3'),
      harmony: { borrowedChordRate: 0.4, progressions: [pr('i bII bV i', 1)] },
      macros: { energy: 0.2, complexity: 0.15, harmonicTension: 0.25 },
      energyShift: 6,
      production: {
        keywords: ['death metal', 'growled vocals', 'blast beats', 'brutal'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'metal:1', aliases: ['death metal', 'deathmetal'] },
  ),
  metal(
    'thrash-metal',
    'Thrash metal',
    'Fast palm-muted gallops, shouted gang choruses and shredding solos',
    {
      tempo: tp(170, 230, 196),
      modes: md('minor:0.4 phrygian:0.3'),
      instruments: { add: [add('electric-guitar-lead', 'lead-guitar', 1, 'solo', true)] },
      macros: { energy: 0.15, complexity: 0.1 },
      production: {
        keywords: ['thrash', 'speed metal', 'palm-muted', 'gallop'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'metal:0.8 punk:0.2', aliases: ['thrash', 'speed metal'] },
  ),
  metal(
    'power-metal',
    'Power metal',
    'Galloping double-kick, soaring operatic melodies, harmonized leads and choirs',
    {
      tempo: tp(150, 200, 172),
      modes: md('minor:0.3 harmonic-minor:0.3 major:0.3'),
      harmony: { progressions: [pr('i VI VII i', 1.5), pr('VI VII V i', 1)] },
      instruments: { add: [add('choir', 'vocal', 0.6, 'pad'), add('synth-pad', 'synth-pad', 0.6, 'pad')] },
      macros: { melodicMovement: 0.2, energy: 0.1 },
      production: { keywords: ['power metal', 'epic', 'soaring vocals', 'double kick'] },
    },
    { parents: 'metal:0.8 cinematic:0.2' },
  ),
  metal(
    'symphonic-metal',
    'Symphonic metal',
    'Metal band plus orchestra and choir: bombastic, cinematic, operatic',
    {
      tempo: tp(100, 170, 136),
      modes: md('harmonic-minor:0.4 minor:0.4'),
      instruments: {
        add: [
          add('string-ensemble', 'strings', 0.9, 'pad', true),
          add('choir', 'vocal', 0.8, 'pad'),
          add('timpani', 'percussion', 0.5, 'rhythm'),
        ],
      },
      macros: { dynamics: 0.15, density: 0.15 },
      production: { keywords: ['symphonic metal', 'orchestral', 'operatic', 'bombastic'], reverb: 0.4 },
    },
    { parents: 'metal:0.6 cinematic:0.4' },
  ),
  metal(
    'metalcore',
    'Metalcore',
    'Breakdowns, melodic choruses, screams versus cleans, palm-muted chugs',
    {
      tempo: tp(130, 180, 150),
      modes: md('minor:0.6'),
      rhythm: { halfTimeChance: 0.5 },
      harmony: { progressions: [pr('VI VII i i', 1.5)] },
      macros: { dynamics: 0.15, energy: 0.1 },
      production: {
        keywords: ['metalcore', 'breakdowns', 'screamed and clean vocals'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'metal:0.6 emo:0.4' },
  ),
  metal(
    'deathcore',
    'Deathcore',
    'Death-metal heaviness with slamming half-time breakdowns and low growls',
    {
      tempo: tp(120, 200, 150),
      modes: md('phrygian:0.5'),
      rhythm: { halfTimeChance: 0.7 },
      macros: { energy: 0.25, harmonicTension: 0.2 },
      energyShift: 8,
      production: { keywords: ['deathcore', 'slam', 'breakdowns', 'guttural'], masteringTarget: 'loud-rock' },
    },
    { parents: 'metal:1' },
  ),
  metal(
    'progressive-metal',
    'Progressive metal',
    'Virtuosic, odd-metered metal epics with keyboard and guitar duels',
    {
      tempo: tp(90, 170, 130),
      meters: [m78, m54, { numerator: 11, denominator: 8, weight: 0.3 }],
      harmony: { extensionRate: 0.2, borrowedChordRate: 0.35 },
      instruments: {
        add: [add('synth-lead', 'synth-lead', 0.5, 'solo'), add('piano', 'keys', 0.4, 'accompaniment')],
      },
      macros: { complexity: 0.3 },
      production: { keywords: ['progressive metal', 'prog metal', 'virtuosic', 'odd meters'] },
    },
    { parents: 'metal:1', aliases: ['prog metal'] },
  ),
  metal(
    'glam-metal',
    'Glam metal',
    '80s hair metal: big hooks, flashy solos, gang choruses and power ballads',
    {
      tempo: tp(110, 150, 128),
      modes: md('major:0.5 mixolydian:0.3'),
      harmony: { progressions: [pr('I bVII IV I', 1.5), pr('I V vi IV', 1)] },
      instruments: {
        add: [add('backing-vocal', 'vocal', 0.8, 'harmony'), add('synth-pad', 'synth-pad', 0.4, 'pad')],
      },
      macros: { energy: 0.05, melodicMovement: 0.1 },
      production: { keywords: ['glam metal', 'hair metal', '80s', 'gang vocals'], reverb: 0.4 },
    },
    { parents: 'metal:0.5 rock:0.5', aliases: ['hair metal'] },
  ),
  metal(
    'industrial-metal',
    'Industrial metal',
    'Mechanical, sequenced metal: drum machines, samples, distorted synths and riffs',
    {
      tempo: tp(100, 140, 120),
      rhythm: { drumStyle: 'four-on-floor' },
      instruments: {
        add: [
          add('synth-seq', 'synth-seq', 0.8, 'rhythm'),
          add('electronic-kit', 'drums', 0.9, 'rhythm', true),
        ],
        remove: ['drum-kit'],
      },
      macros: { humanization: -0.3, repetition: -0.15 },
      production: {
        keywords: ['industrial', 'mechanical', 'distorted synths', 'samples'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'metal:0.6 edm:0.4', aliases: ['industrial rock'] },
  ),
  metal(
    'folk-metal',
    'Folk metal',
    'Metal riffs carrying folk melodies on fiddle, whistle and accordion',
    {
      tempo: tp(130, 190, 160),
      meters: [{ numerator: 6, denominator: 8, weight: 0.5 }],
      modes: md('dorian:0.3 minor:0.3'),
      instruments: {
        add: [
          add('violin', 'strings', 0.8, 'counter-melody'),
          add('flute', 'custom', 0.6, 'counter-melody'),
          add('accordion', 'keys', 0.4, 'accompaniment'),
        ],
      },
      macros: { melodicMovement: 0.15 },
      production: { keywords: ['folk metal', 'pagan', 'fiddle', 'tin whistle'] },
    },
    { parents: 'metal:0.6 celtic:0.4', aliases: ['pagan metal', 'viking metal'] },
  ),
  metal(
    'post-metal',
    'Post-metal',
    'Slow-building, crushing crescendos of sludgy riffs and atmospheric swells',
    {
      tempo: tp(60, 110, 84),
      rhythm: { halfTimeChance: 0.5 },
      instruments: { add: [add('synth-pad', 'synth-pad', 0.6, 'pad')] },
      macros: { dynamics: 0.25, repetition: -0.15 },
      production: { keywords: ['post-metal', 'atmospheric sludge', 'crescendo'], reverb: 0.55 },
    },
    { parents: 'metal:0.5 post-rock:0.5', aliases: ['atmospheric sludge'] },
  ),
  metal(
    'grindcore',
    'Grindcore',
    'Ultra-fast blast beats and noisy micro-songs',
    {
      tempo: tp(200, 260, 230),
      harmony: { borrowedChordRate: 0.5 },
      macros: { energy: 0.3, harmonicTension: 0.3, complexity: -0.1 },
      energyShift: 10,
      production: {
        keywords: ['grindcore', 'blast beats', 'noisy', 'short songs'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'metal:0.6 punk:0.4', aliases: ['grind'] },
  ),
  metal(
    'trap-metal',
    'Trap metal',
    'Screamed trap: distorted 808s, half-time drums and metal guitars',
    {
      tempo: tp(130, 160, 145),
      rhythm: { drumStyle: 'trap' },
      instruments: {
        add: [
          add('808-bass', 'bass', 1, 'bass-line', true),
          add('electric-guitar-distorted', 'rhythm-guitar', 0.8, 'rhythm'),
        ],
        remove: ['electric-bass'],
      },
      macros: { energy: 0.2 },
      production: { keywords: ['trap metal', 'distorted 808', 'screamed'], masteringTarget: 'loud-rock' },
    },
    { parents: 'trap:0.6 metal:0.4', aliases: ['scream rap'] },
  ),
];

const PUNK_TAGS: StyleTag[] = [
  punk(
    'hardcore-punk',
    'Hardcore punk',
    'Short, ferocious, ultra-fast songs with gang shouts and breakdown stomps',
    {
      tempo: tp(180, 250, 210),
      harmony: { extensionRate: 0 },
      rhythm: { halfTimeChance: 0.3 },
      macros: { energy: 0.2, complexity: -0.15, density: 0.1 },
      energyShift: 8,
      production: { keywords: ['hardcore', 'gang vocals', 'fast', 'raw'], masteringTarget: 'loud-rock' },
    },
    { parents: 'punk:1', aliases: ['hardcore', 'hxc', 'hc punk'] },
  ),
  punk(
    'skate-punk',
    'Skate punk',
    'Fast, melodic, technically tight punk with soaring harmonized choruses',
    {
      tempo: tp(180, 230, 200),
      modes: md('major:0.5'),
      instruments: { add: [add('backing-vocal', 'vocal', 0.7, 'harmony')] },
      macros: { complexity: 0.1, melodicMovement: 0.1 },
      production: { keywords: ['skate punk', 'melodic hardcore', 'fast', '90s'] },
    },
    { parents: 'punk:0.6 pop-punk:0.4', aliases: ['skatepunk'] },
  ),
  punk(
    'melodic-hardcore',
    'Melodic hardcore',
    'Hardcore urgency with minor-key melodies and emotional spoken/screamed builds',
    {
      tempo: tp(150, 210, 178),
      modes: md('minor:0.6'),
      rhythm: { halfTimeChance: 0.4 },
      macros: { dynamics: 0.15, energy: 0.1 },
      production: {
        keywords: ['melodic hardcore', 'emotional', 'gang vocals'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'punk:0.6 emo:0.4' },
  ),
  punk(
    'street-punk',
    'Street punk / Oi!',
    'Mid-tempo terrace chants, simple power chords and shouted gang choruses',
    {
      tempo: tp(130, 170, 150),
      instruments: { add: [add('backing-vocal', 'vocal', 0.9, 'harmony', true)] },
      macros: { melodicMovement: -0.15, complexity: -0.15 },
      production: { keywords: ['oi!', 'street punk', 'gang chorus', 'terrace chant'] },
    },
    { parents: 'punk:1', aliases: ['oi', 'oi!', 'street punk'] },
  ),
  punk(
    'ska-punk',
    'Ska-punk',
    'Punk energy alternating with off-beat skank and horn lines',
    {
      tempo: tp(150, 210, 180),
      rhythm: { drumStyle: 'ska', compStyle: 'skank', bassStyle: 'walking' },
      instruments: {
        add: [
          add('brass-section', 'custom', 0.9, 'harmony', true),
          add('electric-guitar-distorted', 'rhythm-guitar', 0.6, 'rhythm'),
        ],
      },
      macros: { energy: 0.1 },
      production: { keywords: ['ska-punk', 'horns', 'skank', 'third wave'] },
    },
    { parents: 'ska:0.6 punk:0.4', aliases: ['ska punk', 'third wave ska'] },
  ),
  punk(
    'folk-punk',
    'Folk-punk',
    'Acoustic guitars played punk-fast with ragged singalong vocals, banjo and fiddle',
    {
      tempo: tp(140, 200, 168),
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 1, 'accompaniment', true),
          add('banjo', 'rhythm-guitar', 0.5, 'accompaniment'),
          add('accordion', 'keys', 0.3, 'accompaniment'),
        ],
        remove: ['electric-guitar-distorted', 'synth-pad'],
      },
      macros: { humanization: 0.3 },
      production: { keywords: ['folk punk', 'acoustic', 'ragged', 'singalong'], reverb: 0.2 },
    },
    { parents: 'punk:0.5 folk:0.5', aliases: ['folk punk'] },
  ),
  punk(
    'emo-pop',
    'Emo pop',
    'Glossy pop-punk with emo heartbreak, synth touches and huge hooks',
    {
      tempo: tp(130, 180, 156),
      modes: md('major:0.5'),
      instruments: { add: [add('synth-pad', 'synth-pad', 0.5, 'pad')] },
      macros: { humanization: -0.15, melodicMovement: 0.1 },
      production: { keywords: ['emo pop', 'pop-punk', '2000s', 'polished'] },
    },
    { parents: 'pop-punk:0.7 emo:0.3', aliases: ['emo-pop'] },
  ),
  punk(
    'easycore',
    'Easycore',
    'Pop-punk choruses colliding with metalcore breakdowns',
    {
      tempo: tp(150, 200, 174),
      rhythm: { halfTimeChance: 0.5 },
      harmony: { powerChords: true },
      macros: { energy: 0.15, dynamics: 0.15 },
      production: { keywords: ['easycore', 'pop-punk', 'breakdowns'], masteringTarget: 'loud-rock' },
    },
    { parents: 'pop-punk:0.6 metal:0.4', aliases: ['pop-core'] },
  ),
  punk(
    'crust-punk',
    'Crust punk',
    'Filthy, d-beat-driven punk with metallic riffs and political fury',
    {
      tempo: tp(160, 210, 184),
      modes: md('minor:0.7'),
      harmony: { powerChords: true, borrowedChordRate: 0.35 },
      macros: { energy: 0.2, humanization: 0.2 },
      production: { keywords: ['crust', 'd-beat', 'raw', 'political'], masteringTarget: 'loud-rock' },
    },
    { parents: 'punk:0.6 metal:0.4', aliases: ['crust', 'd-beat'] },
  ),
];

const POP_TAGS: StyleTag[] = [
  pop(
    'bubblegum-pop',
    'Bubblegum pop',
    'Sugary, simple, major-key earworms with handclaps and bright synths',
    {
      tempo: tp(110, 140, 124),
      modes: md('major:1'),
      harmony: { extensionRate: 0.05, progressions: [pr('I V vi IV', 2), pr('I IV V IV', 1)] },
      instruments: {
        add: [add('percussion', 'percussion', 0.6, 'rhythm'), add('glockenspiel', 'keys', 0.4, 'hook')],
      },
      macros: { complexity: -0.25, repetition: -0.2 },
      production: { keywords: ['bubblegum', 'sugary', 'handclaps', 'catchy'] },
    },
    { parents: 'pop:1', aliases: ['bubblegum', 'bubblegum bass'] },
  ),
  pop(
    'dance-pop',
    'Dance-pop',
    'Club-ready pop: four-on-the-floor, sidechained synths and a big chorus drop',
    {
      tempo: tp(116, 130, 122),
      rhythm: { drumStyle: 'four-on-floor', bassStyle: 'offbeat' },
      instruments: {
        add: [
          add('synth-lead', 'synth-lead', 0.6, 'hook'),
          add('electronic-kit', 'drums', 1, 'rhythm', true),
        ],
        remove: ['drum-kit'],
      },
      macros: { energy: 0.15, humanization: -0.15 },
      production: { keywords: ['dance-pop', 'club', 'sidechain', 'four on the floor'] },
    },
    { parents: 'pop:0.6 edm:0.4', aliases: ['dance pop', 'club pop'] },
  ),
  pop(
    'electropop',
    'Electropop',
    'Pop built entirely from synths and drum machines: crisp, quirky, bright',
    {
      tempo: tp(105, 130, 118),
      rhythm: { drumStyle: 'synth-pop' },
      instruments: {
        add: [
          add('synth-arp', 'synth-arp', 0.7, 'texture'),
          add('electronic-kit', 'drums', 1, 'rhythm', true),
        ],
        remove: ['drum-kit', 'acoustic-guitar', 'electric-guitar-clean'],
      },
      macros: { humanization: -0.2 },
      production: { keywords: ['electropop', 'synthy', 'crisp'] },
    },
    { parents: 'synth-pop:0.7 pop:0.3', aliases: ['electro-pop', 'electro pop'] },
  ),
  pop(
    'teen-pop',
    'Teen pop',
    'Y2K-style bright pop with tight harmonies, guitar-pop chords and big choruses',
    {
      tempo: tp(96, 126, 112),
      modes: md('major:0.6'),
      instruments: { add: [add('backing-vocal', 'vocal', 0.7, 'harmony')] },
      macros: { complexity: -0.1 },
      production: { keywords: ['teen pop', 'bright', 'polished', 'y2k'] },
    },
    { parents: 'pop:1' },
  ),
  pop(
    'art-pop',
    'Art pop',
    'Adventurous pop with unusual harmony, textures and arrangements',
    {
      harmony: { borrowedChordRate: 0.35, extensionRate: 0.45 },
      modes: md('lydian:0.2 dorian:0.2'),
      instruments: {
        add: [add('string-ensemble', 'strings', 0.5, 'pad'), add('synth-arp', 'synth-arp', 0.4, 'texture')],
      },
      macros: { complexity: 0.25, repetition: 0.2 },
      production: { keywords: ['art pop', 'experimental', 'textural'] },
    },
    { parents: 'pop:0.6 indie-rock:0.4', aliases: ['avant-pop'] },
  ),
  pop(
    'power-ballad',
    'Power ballad',
    'Slow-building ballad that explodes into a huge, belted final chorus',
    {
      tempo: tp(64, 86, 74),
      meters: [{ numerator: 12, denominator: 8, weight: 0.2 }],
      instruments: {
        add: [
          add('piano', 'keys', 0.9, 'accompaniment', true),
          add('string-ensemble', 'strings', 0.6, 'pad'),
        ],
      },
      macros: { dynamics: 0.3 },
      energyShift: -4,
      production: { keywords: ['power ballad', 'belted', 'epic', 'big final chorus'], reverb: 0.4 },
    },
    { parents: 'pop:0.5 rock:0.5', aliases: ['ballad', 'big ballad'] },
  ),
  pop(
    'sophisti-pop',
    'Sophisti-pop',
    '80s jazz-tinged adult pop: sax, Rhodes, maj9 chords and smooth grooves',
    {
      tempo: tp(88, 118, 102),
      harmony: { extensionRate: 0.8, progressions: [pr('Imaj7 IVmaj7 iii7 vi7', 1.5)] },
      instruments: {
        add: [
          add('saxophone', 'custom', 0.6, 'counter-melody'),
          add('electric-piano', 'keys', 0.8, 'accompaniment'),
        ],
      },
      macros: { harmonicTension: 0.15 },
      production: { keywords: ['sophisti-pop', '80s', 'smooth', 'jazzy'] },
    },
    { parents: 'pop:0.6 soul:0.4' },
  ),
  pop(
    'city-pop',
    'City pop',
    '80s Tokyo urban pop: funky bass, glassy keys, maj7 chords and night-drive glamour',
    {
      tempo: tp(96, 128, 112),
      modes: md('major:0.5 dorian:0.2'),
      rhythm: { drumStyle: 'funk', bassStyle: 'funk', compStyle: 'funk' },
      harmony: {
        extensionRate: 0.85,
        progressions: [pr('IVmaj7 iii7 vi7 V7/V', 1), pr('IVmaj7 V7 iii7 vi', 2)],
      },
      instruments: {
        add: [
          add('electric-piano', 'keys', 0.9, 'accompaniment', true),
          add('brass-section', 'custom', 0.4, 'harmony'),
        ],
      },
      macros: { syncopation: 0.15 },
      production: { keywords: ['city pop', '80s japan', 'glassy keys', 'night drive'] },
    },
    { parents: 'j-pop:0.5 funk:0.3 disco:0.2', aliases: ['citypop'] },
  ),
  pop(
    'girl-group',
    'Girl-group pop',
    '60s Wall-of-Sound girl groups: castanet-backbeat, strings, harmonized "ooh"s',
    {
      tempo: tp(100, 140, 120),
      modes: md('major:0.7'),
      meters: [{ numerator: 12, denominator: 8, weight: 0.3 }],
      rhythm: { drumStyle: 'soul' },
      instruments: {
        add: [
          add('backing-vocal', 'vocal', 1, 'harmony', true),
          add('string-ensemble', 'strings', 0.6, 'pad'),
          add('percussion', 'percussion', 0.6, 'rhythm'),
        ],
      },
      production: { keywords: ['girl group', '60s', 'wall of sound', 'harmonies'], reverb: 0.5 },
      macros: { humanization: 0.1 },
    },
    { parents: 'pop:0.5 soul:0.5', aliases: ['girl group'] },
  ),
  pop(
    'doo-wop',
    'Doo-wop',
    '50s vocal-group R&B in 12/8 over I–vi–IV–V with nonsense-syllable backing harmonies',
    {
      tempo: tp(60, 132, 84),
      meters: [m128],
      modes: md('major:1'),
      rhythm: { swing: 0.5, subdivision: 12, compStyle: 'chop' },
      harmony: { progressions: [pr('I vi IV V', 4), pr('I vi ii V', 2)] },
      instruments: {
        add: [add('backing-vocal', 'vocal', 1, 'harmony', true), add('piano', 'keys', 0.8, 'accompaniment')],
        remove: SYNTHS,
      },
      macros: { complexity: -0.15 },
      production: { keywords: ['doo-wop', '50s', 'vocal group', 'harmonies'], reverb: 0.35 },
    },
    { parents: 'soul:0.6 pop:0.4', aliases: ['doowop', 'doo wop'] },
  ),
  pop(
    'adult-contemporary',
    'Adult contemporary',
    'Smooth, mature, mid-tempo pop with piano and gentle grooves',
    {
      tempo: tp(70, 110, 90),
      harmony: { extensionRate: 0.35 },
      instruments: { add: [add('piano', 'keys', 0.9, 'accompaniment', true)] },
      macros: { energy: -0.15, dynamics: -0.05 },
      energyShift: -5,
      production: { keywords: ['adult contemporary', 'smooth', 'mature'] },
    },
    { parents: 'pop:1', aliases: ['ac', 'easy listening'] },
  ),
  pop(
    'pop-rock',
    'Pop rock',
    'Guitar-led pop with crunchy rhythm guitars and a radio chorus',
    {
      tempo: tp(100, 140, 120),
      rhythm: { drumStyle: 'rock' },
      instruments: { add: [add('electric-guitar-distorted', 'rhythm-guitar', 0.9, 'rhythm', true)] },
      harmony: { powerChords: true },
      macros: { energy: 0.1 },
      production: { keywords: ['pop rock', 'guitar pop', 'radio'] },
    },
    { parents: 'pop:0.6 rock:0.4', aliases: ['pop/rock'] },
  ),
  pop(
    'dark-pop',
    'Dark pop',
    'Moody minor-key pop with sparse trap-influenced beats and breathy vocals',
    {
      modes: md('minor:0.8'),
      rhythm: { drumStyle: 'trap', halfTimeChance: 0.3 },
      instruments: { add: [add('808-bass', 'bass', 0.9, 'bass-line')], remove: ['acoustic-guitar'] },
      macros: { density: -0.15, energy: -0.05 },
      production: { keywords: ['dark pop', 'moody', 'sparse', 'breathy'] },
    },
    { parents: 'pop:0.7 trap:0.3', aliases: ['alt-pop', 'alt pop'] },
  ),
  pop(
    'k-ballad',
    'K-ballad',
    'Korean piano-and-strings ballad with an emotional key-lifted climax',
    {
      tempo: tp(64, 84, 72),
      harmony: { extensionRate: 0.5, progressions: [pr('IVmaj7 V7 iii7 vi', 2)] },
      instruments: {
        add: [add('piano', 'keys', 1, 'accompaniment', true), add('string-ensemble', 'strings', 0.8, 'pad')],
        remove: ['electronic-kit', 'synth-lead'],
      },
      macros: { energy: -0.2, dynamics: 0.2 },
      energyShift: -8,
      production: { keywords: ['k-ballad', 'ost', 'emotional', 'piano and strings'], reverb: 0.4 },
    },
    { parents: 'k-pop:0.6 pop:0.4', aliases: ['korean ballad', 'drama ost'] },
  ),
  pop(
    'mandopop',
    'Mandopop / C-pop',
    'Chinese-language pop: pentatonic-tinged melodies, lush ballad arrangements',
    {
      modes: md('major:0.5'),
      harmony: { progressions: [pr('I V vi iii IV I IV V', 2)] },
      instruments: {
        add: [
          add('piano', 'keys', 0.8, 'accompaniment'),
          add('flute', 'custom', 0.3, 'counter-melody'),
          add('string-ensemble', 'strings', 0.5, 'pad'),
        ],
      },
      macros: { melodicMovement: 0.1 },
      production: { keywords: ['c-pop', 'mandopop', 'cantopop', 'pentatonic'] },
    },
    { parents: 'pop:1', aliases: ['c-pop', 'cpop', 'cantopop'] },
  ),
  pop(
    'j-rock',
    'J-rock',
    'Japanese rock: fast melodic riffs, busy bass, dramatic anime-style choruses',
    {
      tempo: tp(140, 190, 168),
      rhythm: { drumStyle: 'pop-punk' },
      harmony: { powerChords: true },
      instruments: {
        add: [
          add('electric-guitar-distorted', 'rhythm-guitar', 1, 'rhythm', true),
          add('electric-guitar-lead', 'lead-guitar', 0.7, 'hook'),
        ],
      },
      macros: { energy: 0.15, complexity: 0.1 },
      production: { keywords: ['j-rock', 'anime opening', 'fast', 'melodic'] },
    },
    { parents: 'j-pop:0.6 rock:0.4', aliases: ['jrock', 'japanese rock'] },
  ),
  pop(
    'anime',
    'Anime opening',
    'High-octane anime theme: fast tempo, dense chords, a dramatic key-lifted chorus',
    {
      tempo: tp(150, 190, 172),
      harmony: { harmonicRhythm: 2, progressions: [pr('IVmaj7 V7 iii7 vi', 3), pr('bVI bVII I I', 1.5)] },
      instruments: {
        add: [
          add('electric-guitar-distorted', 'rhythm-guitar', 0.8, 'rhythm'),
          add('string-ensemble', 'strings', 0.5, 'pad'),
        ],
      },
      macros: { energy: 0.2, density: 0.15, complexity: 0.1 },
      energyShift: 6,
      production: { keywords: ['anime', 'anime opening', 'dramatic', 'op'] },
    },
    { parents: 'j-pop:1', aliases: ['anime', 'anime op', 'anime theme', 'anisong'] },
  ),
  pop(
    'vocaloid',
    'Vocaloid',
    'Hyper-fast, dense J-pop with synthesized voice, glittering synths and rock drums',
    {
      tempo: tp(150, 210, 180),
      instruments: {
        add: [add('synth-lead', 'synth-lead', 0.7, 'hook'), add('synth-arp', 'synth-arp', 0.7, 'texture')],
      },
      macros: { complexity: 0.2, melodicMovement: 0.2, density: 0.2, humanization: -0.2 },
      production: { keywords: ['vocaloid', 'synthesized vocals', 'fast', 'dense'] },
    },
    { parents: 'j-pop:0.7 edm:0.3', aliases: ['miku', 'utaite'] },
  ),
  pop(
    'visual-kei',
    'Visual kei',
    'Theatrical Japanese rock/metal: gothic drama, fast double-kick, symphonic keys',
    {
      tempo: tp(150, 200, 176),
      modes: md('harmonic-minor:0.4 minor:0.4'),
      rhythm: { drumStyle: 'metal' },
      instruments: {
        add: [add('string-ensemble', 'strings', 0.5, 'pad'), add('piano', 'keys', 0.4, 'accompaniment')],
      },
      macros: { dynamics: 0.15 },
      production: { keywords: ['visual kei', 'gothic', 'theatrical'] },
    },
    { parents: 'j-pop:0.4 metal:0.6' },
  ),
  pop(
    'shibuya-kei',
    'Shibuya-kei',
    'Kitschy, sample-collage Japanese pop mixing bossa, lounge and 60s pop',
    {
      tempo: tp(110, 140, 124),
      rhythm: { drumStyle: 'bossa-nova', compStyle: 'bossa' },
      harmony: { extensionRate: 0.75 },
      instruments: {
        add: [
          add('nylon-guitar', 'rhythm-guitar', 0.7, 'accompaniment'),
          add('flute', 'custom', 0.4, 'counter-melody'),
          add('glockenspiel', 'keys', 0.4, 'hook'),
        ],
      },
      macros: { complexity: 0.1 },
      production: { keywords: ['shibuya-kei', 'kitsch', 'lounge', 'collage'] },
    },
    { parents: 'j-pop:0.5 bossa-nova:0.5', aliases: ['shibuya kei'] },
  ),
  pop(
    'k-indie',
    'K-indie',
    'Korean indie: intimate, jazzy-to-dreamy band pop with soft vocals',
    {
      tempo: tp(80, 124, 100),
      harmony: { extensionRate: 0.5 },
      rhythm: { drumStyle: 'indie' },
      instruments: {
        add: [
          add('electric-guitar-clean', 'rhythm-guitar', 0.8, 'accompaniment'),
          add('electric-piano', 'keys', 0.5, 'accompaniment'),
        ],
        remove: ['synth-lead'],
      },
      macros: { energy: -0.15, humanization: 0.15 },
      production: { keywords: ['k-indie', 'korean indie', 'intimate', 'dreamy'] },
    },
    { parents: 'k-pop:0.4 indie-rock:0.6', aliases: ['korean indie'] },
  ),
  pop(
    'europop',
    'Europop',
    'Bright, melodic continental pop with simple dance grooves and big sing-along hooks',
    {
      tempo: tp(110, 130, 120),
      modes: md('minor:0.4'),
      rhythm: { drumStyle: 'four-on-floor' },
      instruments: { add: [add('synth-lead', 'synth-lead', 0.7, 'hook')] },
      macros: { complexity: -0.15 },
      production: { keywords: ['europop', 'eurovision', 'catchy'] },
    },
    { parents: 'pop:0.6 edm:0.4', aliases: ['eurovision', 'euro pop'] },
  ),
];

const INDIE_TAGS: StyleTag[] = [
  indie(
    'bedroom-pop',
    'Bedroom pop',
    'Home-recorded, lo-fi pop: soft vocals, chorusy guitars, cheap drum machines',
    {
      tempo: tp(80, 116, 96),
      rhythm: { drumStyle: 'synth-pop' },
      instruments: {
        add: [
          add('electric-guitar-clean', 'rhythm-guitar', 0.8, 'accompaniment'),
          add('electronic-kit', 'drums', 0.9, 'rhythm'),
        ],
        remove: ['drum-kit', 'brass-section', 'string-ensemble'],
      },
      macros: { energy: -0.2, density: -0.15, humanization: 0.1 },
      energyShift: -6,
      production: { keywords: ['bedroom pop', 'lo-fi', 'home recorded', 'soft vocals'], reverb: 0.35 },
    },
    { parents: 'indie-rock:0.5 pop:0.5', aliases: ['bedroom-pop'] },
  ),
  indie(
    'dream-pop',
    'Dream pop',
    'Hazy, reverb-washed pop: chorused guitars, breathy vocals, slow-motion grooves',
    {
      tempo: tp(80, 120, 100),
      modes: md('major:0.3 lydian:0.3'),
      harmony: { extensionRate: 0.5, progressions: [pr('Imaj7 IVmaj7', 2)] },
      instruments: {
        add: [
          add('synth-pad', 'synth-pad', 0.8, 'pad'),
          add('electric-guitar-clean', 'lead-guitar', 0.7, 'counter-melody'),
        ],
      },
      macros: { energy: -0.15, density: -0.05 },
      production: { keywords: ['dream pop', 'hazy', 'reverb-washed', 'ethereal'], reverb: 0.65 },
    },
    { parents: 'shoegaze:0.5 indie-rock:0.5', aliases: ['dreampop', 'dream-pop'] },
  ),
  indie(
    'jangle-pop',
    'Jangle pop',
    'Bright chiming 12-string-style clean guitars over sunny major chords',
    {
      tempo: tp(110, 150, 128),
      modes: md('major:0.8'),
      rhythm: { compStyle: 'arpeggio' },
      instruments: {
        add: [add('electric-guitar-clean', 'rhythm-guitar', 1, 'accompaniment', true)],
        remove: ['electric-guitar-distorted', 'synth-pad'],
      },
      harmony: { powerChords: false },
      production: { keywords: ['jangle pop', 'chiming guitars', 'rickenbacker', 'sunny'] },
      macros: { energy: 0.05 },
    },
    { parents: 'indie-rock:0.8 pop:0.2', aliases: ['jangle', 'jangly'] },
  ),
  indie(
    'indie-pop',
    'Indie pop',
    'Melodic, homespun pop with clean guitars, keys and earnest charm',
    {
      tempo: tp(100, 140, 120),
      modes: md('major:0.5'),
      instruments: {
        add: [
          add('glockenspiel', 'keys', 0.4, 'hook'),
          add('electric-guitar-clean', 'rhythm-guitar', 0.8, 'accompaniment'),
        ],
      },
      macros: { humanization: 0.1 },
      production: { keywords: ['indie pop', 'charming', 'homespun'] },
    },
    { parents: 'indie-rock:0.5 pop:0.5', aliases: ['indiepop'] },
  ),
  indie(
    'twee-pop',
    'Twee pop',
    'Sweet, innocent indie pop with glockenspiel, handclaps and boy-girl vocals',
    {
      tempo: tp(110, 150, 132),
      modes: md('major:1'),
      instruments: {
        add: [
          add('glockenspiel', 'keys', 0.8, 'hook'),
          add('percussion', 'percussion', 0.5, 'rhythm'),
          add('backing-vocal', 'vocal', 0.5, 'harmony'),
        ],
      },
      macros: { complexity: -0.2, energy: -0.05 },
      production: { keywords: ['twee', 'sweet', 'glockenspiel', 'handclaps'] },
    },
    { parents: 'indie-rock:0.6 pop:0.4', aliases: ['twee', 'c86'] },
  ),
  indie(
    'indie-folk',
    'Indie folk',
    'Fingerpicked acoustic guitars, stacked harmonies and swelling rustic arrangements',
    {
      tempo: tp(76, 124, 98),
      meters: [{ numerator: 3, denominator: 4, weight: 0.3 }],
      rhythm: { drumStyle: 'folk', compStyle: 'arpeggio' },
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 1, 'accompaniment', true),
          add('backing-vocal', 'vocal', 0.7, 'harmony'),
          add('banjo', 'rhythm-guitar', 0.3, 'accompaniment'),
        ],
        remove: ['synth-lead', 'electric-guitar-distorted'],
      },
      macros: { humanization: 0.2 },
      production: { keywords: ['indie folk', 'fingerpicked', 'harmonies', 'rustic'], reverb: 0.4 },
    },
    { parents: 'folk:0.6 indie-rock:0.4', aliases: ['indie-folk', 'stomp clap folk'] },
  ),
  indie(
    'chamber-pop',
    'Chamber pop',
    'Pop songs dressed in strings, woodwinds and piano with orchestral care',
    {
      instruments: {
        add: [
          add('string-ensemble', 'strings', 0.9, 'pad', true),
          add('flute', 'custom', 0.5, 'counter-melody'),
          add('cello', 'strings', 0.5, 'counter-melody'),
          add('piano', 'keys', 0.7, 'accompaniment'),
        ],
      },
      harmony: { extensionRate: 0.35, borrowedChordRate: 0.2 },
      macros: { complexity: 0.15, dynamics: 0.1 },
      production: { keywords: ['chamber pop', 'strings', 'woodwinds', 'ornate'], reverb: 0.35 },
    },
    { parents: 'indie-rock:0.5 orchestral:0.3 pop:0.2' },
  ),
  indie(
    'baroque-pop',
    'Baroque pop',
    '60s-style pop with harpsichord-like keys, string quartets and descending basslines',
    {
      tempo: tp(90, 130, 110),
      harmony: { progressions: [pr('I V vi iii IV I IV V', 2), pr('i VII VI V', 1)] },
      instruments: {
        add: [
          add('string-ensemble', 'strings', 0.8, 'pad'),
          add('harp', 'keys', 0.5, 'accompaniment'),
          add('french-horn', 'custom', 0.3, 'counter-melody'),
        ],
      },
      macros: { complexity: 0.1 },
      production: { keywords: ['baroque pop', '60s', 'string quartet', 'ornate'] },
    },
    { parents: 'pop:0.5 orchestral:0.5', aliases: ['baroque rock'] },
  ),
  indie(
    'sunshine-pop',
    'Sunshine pop',
    'Late-60s California pop: lush harmonies, bright major chords, breezy grooves',
    {
      tempo: tp(110, 140, 124),
      modes: md('major:1'),
      harmony: { extensionRate: 0.35, progressions: [pr('I iii IV V', 1.5), pr('Imaj7 IVmaj7', 1)] },
      instruments: {
        add: [add('backing-vocal', 'vocal', 1, 'harmony', true), add('glockenspiel', 'keys', 0.3, 'hook')],
      },
      macros: { energy: 0.05 },
      production: { keywords: ['sunshine pop', 'california', '60s', 'harmonies'] },
    },
    { parents: 'pop:0.6 indie-rock:0.4', aliases: ['sunshine'] },
  ),
  indie(
    'freak-folk',
    'Freak folk',
    'Psychedelic, off-kilter acoustic music with drones and odd textures',
    {
      meters: [m68, m54],
      modes: md('dorian:0.3 mixolydian:0.3'),
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 1, 'accompaniment', true),
          add('harp', 'keys', 0.3, 'accompaniment'),
          add('flute', 'custom', 0.4, 'counter-melody'),
        ],
      },
      macros: { complexity: 0.2, repetition: 0.1 },
      production: { keywords: ['freak folk', 'psychedelic folk', 'drones'] },
    },
    { parents: 'folk:0.6 indie-rock:0.4', aliases: ['psych folk', 'psychedelic folk'] },
  ),
];

const ELECTRONIC_TAGS: StyleTag[] = [
  // --- House & techno ---------------------------------------------------------------------------
  house(
    'deep-house',
    'Deep house',
    'Warm, unhurried house: muted kicks, jazzy minor-ninth chords, soulful hums',
    {
      tempo: tp(118, 124, 121),
      modes: md('dorian:0.4 minor:0.4'),
      harmony: { extensionRate: 0.9, progressions: [pr('i9 iv9', 2), pr('ii9 V9 Imaj9', 1)] },
      rhythm: { swing: 0.12, compStyle: 'stabs' },
      instruments: {
        add: [add('electric-piano', 'keys', 0.8, 'accompaniment'), add('synth-pad', 'synth-pad', 0.7, 'pad')],
      },
      macros: { energy: -0.15, harmonicTension: 0.1 },
      energyShift: -6,
      production: { keywords: ['deep house', 'warm', 'jazzy chords', 'late night'] },
    },
    { parents: 'house:1', aliases: ['deep-house'] },
  ),
  house(
    'tech-house',
    'Tech house',
    'Minimal, percussive house with rolling basslines and groovy vocal chops',
    {
      tempo: tp(122, 128, 125),
      modes: md('minor:0.6'),
      rhythm: { drumStyle: 'techno', bassStyle: 'rolling' },
      harmony: { harmonicRhythm: 0.25, extensionRate: 0.3 },
      instruments: { add: [add('percussion', 'percussion', 0.8, 'rhythm')], remove: ['piano'] },
      macros: { repetition: -0.15, syncopation: 0.1 },
      production: { keywords: ['tech house', 'rolling bass', 'groovy', 'percussive'] },
    },
    { parents: 'house:0.6 techno:0.4', aliases: ['tech-house'] },
  ),
  house(
    'acid-house',
    'Acid house',
    'Squelching TB-303-style resonant bassline over a jacking drum machine',
    {
      tempo: tp(120, 130, 124),
      modes: md('minor:0.6 phrygian:0.2'),
      rhythm: { bassStyle: 'rolling' },
      harmony: { harmonicRhythm: 0.25, progressions: [pr('i', 2)] },
      instruments: { add: [add('synth-seq', 'synth-seq', 0.9, 'rhythm', true)] },
      macros: { repetition: -0.2, humanization: -0.1 },
      production: { keywords: ['acid house', 'tb-303', 'squelchy', 'resonant'] },
    },
    { parents: 'house:0.7 techno:0.3', aliases: ['acid', '303', 'acid techno'] },
  ),
  house(
    'progressive-house',
    'Progressive house',
    'Long, melodic builds, evolving arps and emotional breakdowns',
    {
      tempo: tp(122, 130, 126),
      modes: md('minor:0.6'),
      instruments: {
        add: [add('synth-arp', 'synth-arp', 0.8, 'texture'), add('synth-pad', 'synth-pad', 0.8, 'pad')],
      },
      harmony: { progressions: [pr('i VI III VII', 2)] },
      macros: { repetition: -0.1, dynamics: 0.1 },
      production: { keywords: ['progressive house', 'melodic', 'builds', 'emotional'], reverb: 0.45 },
    },
    { parents: 'house:0.6 trance:0.4', aliases: ['prog house', 'melodic house'] },
  ),
  house(
    'tropical-house',
    'Tropical house',
    'Laid-back, sunny house at a slower tempo with marimba plucks and pan-flute leads',
    {
      tempo: tp(100, 115, 106),
      modes: md('major:0.6'),
      instruments: {
        add: [
          add('marimba', 'keys', 0.8, 'hook'),
          add('steel-pan', 'keys', 0.4, 'hook'),
          add('flute', 'custom', 0.4, 'counter-melody'),
        ],
      },
      macros: { energy: -0.15 },
      production: { keywords: ['tropical house', 'sunny', 'marimba', 'chill'] },
    },
    { parents: 'house:0.6 pop:0.4', aliases: ['trop house'] },
  ),
  house(
    'afro-house',
    'Afro house',
    'House with African percussion, chanted vocals and hypnotic minor grooves',
    {
      tempo: tp(118, 126, 122),
      modes: md('minor:0.6 dorian:0.3'),
      rhythm: { drumStyle: 'afrobeats', syncopation: 0.7 },
      instruments: { add: [add('percussion', 'percussion', 0.9, 'rhythm', true)] },
      macros: { syncopation: 0.15, repetition: -0.1 },
      production: { keywords: ['afro house', 'tribal percussion', 'hypnotic', 'chants'] },
    },
    { parents: 'house:0.6 afrobeats:0.4', aliases: ['afro-house', 'afro tech'] },
  ),
  house(
    'electro-house',
    'Electro house',
    'Big-room-leaning house with distorted, buzzy saw basslines',
    {
      tempo: tp(124, 130, 128),
      modes: md('minor:0.7'),
      rhythm: { bassStyle: 'offbeat' },
      instruments: { add: [add('synth-lead', 'synth-lead', 0.8, 'hook')] },
      macros: { energy: 0.15 },
      energyShift: 5,
      production: { keywords: ['electro house', 'buzzy bass', 'distorted saw'] },
    },
    { parents: 'house:0.6 edm:0.4', aliases: ['electro-house', 'complextro'] },
  ),
  house(
    'future-house',
    'Future house',
    'Bouncy house with metallic, pitch-bent bass plucks and pop toplines',
    {
      tempo: tp(122, 128, 126),
      rhythm: { bassStyle: 'octave' },
      instruments: { add: [add('synth-lead', 'synth-lead', 0.6, 'hook')] },
      macros: { syncopation: 0.1, energy: 0.05 },
      production: { keywords: ['future house', 'bouncy', 'metallic bass'] },
    },
    { parents: 'house:0.6 edm:0.4' },
  ),
  house(
    'chicago-house',
    'Chicago house',
    'The original: jacking 909 drums, piano chords, diva vocals, raw and soulful',
    {
      tempo: tp(118, 126, 122),
      harmony: { extensionRate: 0.6, progressions: [pr('i7 iv7', 2)] },
      rhythm: { swing: 0.18, compStyle: 'stabs' },
      instruments: { add: [add('piano', 'keys', 1, 'accompaniment', true)] },
      macros: { humanization: 0.05 },
      production: { keywords: ['chicago house', 'jacking', '909', 'piano house', 'diva'] },
    },
    { parents: 'house:1', aliases: ['piano house', 'jackin house'] },
  ),
  house(
    'french-house',
    'French house',
    'Filtered disco loops, phased pumping sidechain and funky guitar licks',
    {
      tempo: tp(118, 126, 122),
      rhythm: { drumStyle: 'disco', bassStyle: 'octave', compStyle: 'funk' },
      harmony: { extensionRate: 0.7 },
      instruments: {
        add: [
          add('electric-guitar-clean', 'rhythm-guitar', 0.8, 'accompaniment'),
          add('electric-piano', 'keys', 0.5, 'accompaniment'),
        ],
      },
      macros: { repetition: -0.15 },
      production: { keywords: ['french house', 'filter house', 'filtered disco', 'pumping'] },
    },
    { parents: 'house:0.5 disco:0.5', aliases: ['filter house', 'french touch'] },
  ),
  house(
    'soulful-house',
    'Soulful house',
    'Gospel-tinged house with live keys, strings and powerhouse vocals',
    {
      tempo: tp(120, 126, 123),
      harmony: { extensionRate: 0.75, progressions: [pr('ii7 V7 Imaj7 vi7', 2)] },
      instruments: {
        add: [
          add('piano', 'keys', 0.9, 'accompaniment'),
          add('string-ensemble', 'strings', 0.5, 'pad'),
          add('backing-vocal', 'vocal', 0.6, 'harmony'),
        ],
      },
      macros: { dynamics: 0.1, humanization: 0.1 },
      production: { keywords: ['soulful house', 'gospel house', 'live keys'] },
    },
    { parents: 'house:0.6 gospel:0.4', aliases: ['gospel house', 'garage house'] },
  ),
  house(
    'nu-disco',
    'Nu-disco',
    'Modern disco revival: slick filtered grooves, octave bass and analog synths',
    {
      tempo: tp(112, 124, 118),
      rhythm: { drumStyle: 'disco', bassStyle: 'octave' },
      instruments: {
        add: [
          add('synth-pad', 'synth-pad', 0.7, 'pad'),
          add('electric-guitar-clean', 'rhythm-guitar', 0.6, 'accompaniment'),
        ],
      },
      macros: { humanization: -0.1 },
      production: { keywords: ['nu-disco', 'slick', 'analog synths', 'disco revival'] },
    },
    { parents: 'disco:0.6 house:0.4', aliases: ['nu disco', 'disco house'] },
  ),
  house(
    'minimal-techno',
    'Minimal techno',
    'Stripped-back clicks and pulses: tiny variations over a hypnotic kick',
    {
      tempo: tp(120, 128, 124),
      harmony: { harmonicRhythm: 0.25, progressions: [pr('i', 3)] },
      instruments: { remove: ['synth-pad', 'synth-lead', 'piano'] },
      macros: { density: -0.3, repetition: -0.25 },
      energyShift: -6,
      production: { keywords: ['minimal techno', 'microhouse', 'clicks', 'hypnotic'], reverb: 0.25 },
    },
    { parents: 'techno:1', aliases: ['microhouse'] },
  ),
  house(
    'detroit-techno',
    'Detroit techno',
    'Soulful machine funk: 909 grooves, futuristic strings and minor-seventh pads',
    {
      tempo: tp(124, 134, 128),
      harmony: { extensionRate: 0.7, progressions: [pr('i7 iv7', 2)] },
      instruments: {
        add: [add('string-ensemble', 'strings', 0.6, 'pad'), add('synth-pad', 'synth-pad', 0.7, 'pad')],
      },
      macros: { harmonicTension: 0.1 },
      production: { keywords: ['detroit techno', 'futuristic', 'soulful', '909'] },
    },
    { parents: 'techno:1' },
  ),
  house(
    'industrial-techno',
    'Industrial techno',
    'Distorted, pounding kicks, metallic percussion and harsh noise',
    {
      tempo: tp(128, 145, 136),
      modes: md('phrygian:0.5 minor:0.5'),
      harmony: { harmonicRhythm: 0.25 },
      macros: { energy: 0.2, harmonicTension: 0.2, density: 0.1 },
      energyShift: 6,
      production: {
        keywords: ['industrial techno', 'distorted kick', 'warehouse', 'harsh'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'techno:1', aliases: ['warehouse techno', 'hard techno'] },
  ),
  house(
    'melodic-techno',
    'Melodic techno',
    'Dark, emotive techno with arpeggiated leads and slow-moving minor chords',
    {
      tempo: tp(120, 128, 124),
      modes: md('minor:0.8'),
      instruments: {
        add: [add('synth-arp', 'synth-arp', 0.9, 'texture', true), add('synth-pad', 'synth-pad', 0.7, 'pad')],
      },
      harmony: { harmonicRhythm: 0.5, progressions: [pr('i VI III VII', 1.5)] },
      macros: { dynamics: 0.15 },
      production: { keywords: ['melodic techno', 'emotive', 'arpeggios', 'dark'], reverb: 0.45 },
    },
    { parents: 'techno:0.7 trance:0.3' },
  ),
  house(
    'dub-techno',
    'Dub techno',
    'Echoing minor chord stabs dissolving into reverb over a muffled kick',
    {
      tempo: tp(116, 126, 120),
      modes: md('minor:0.5 dorian:0.5'),
      rhythm: { compStyle: 'stabs' },
      harmony: { extensionRate: 0.6, harmonicRhythm: 0.25 },
      instruments: { add: [add('synth-pad', 'synth-pad', 0.8, 'accompaniment')] },
      macros: { density: -0.2, energy: -0.15 },
      production: { keywords: ['dub techno', 'echo chords', 'deep', 'reverb'], reverb: 0.7 },
    },
    { parents: 'techno:0.7 reggae:0.3' },
  ),
  house(
    'psytrance',
    'Psytrance',
    'Driving 140+ BPM trance with rolling 16th basslines and psychedelic phrygian leads',
    {
      tempo: tp(138, 148, 144),
      modes: md('phrygian:0.6 harmonic-minor:0.3'),
      rhythm: { drumStyle: 'techno', bassStyle: 'rolling' },
      harmony: { harmonicRhythm: 0.25, progressions: [pr('i bII', 1.5), pr('i', 1.5)] },
      macros: { energy: 0.15, repetition: -0.15 },
      production: { keywords: ['psytrance', 'goa', 'rolling bass', 'psychedelic'] },
    },
    { parents: 'trance:0.7 techno:0.3', aliases: ['psy trance', 'goa trance', 'goa', 'psy'] },
  ),
  house(
    'uplifting-trance',
    'Uplifting trance',
    'Euphoric supersaw anthems with long emotional breakdowns and key-lifted climaxes',
    {
      tempo: tp(136, 140, 138),
      modes: md('minor:0.6'),
      harmony: { progressions: [pr('VI VII i i', 2), pr('i VI III VII', 2)] },
      instruments: {
        add: [add('string-ensemble', 'strings', 0.5, 'pad'), add('piano', 'keys', 0.4, 'accompaniment')],
      },
      macros: { dynamics: 0.2 },
      energyShift: 4,
      production: { keywords: ['uplifting trance', 'euphoric', 'supersaw', 'emotional'], reverb: 0.5 },
    },
    { parents: 'trance:1', aliases: ['epic trance', 'vocal trance'] },
  ),
  house(
    'hardstyle',
    'Hardstyle',
    'Distorted reverse-bass kicks at 150 BPM with euphoric screeching leads',
    {
      tempo: tp(148, 158, 150),
      modes: md('minor:0.8'),
      rhythm: { drumStyle: 'four-on-floor', bassStyle: 'offbeat' },
      instruments: { add: [add('synth-lead', 'synth-lead', 1, 'hook', true)] },
      macros: { energy: 0.25 },
      energyShift: 8,
      production: {
        keywords: ['hardstyle', 'reverse bass', 'distorted kick', 'euphoric'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'edm:0.7 trance:0.3', aliases: ['rawstyle', 'hard dance'] },
  ),
  house(
    'gabber',
    'Gabber / hardcore techno',
    'Brutal 180+ BPM distorted kicks and rave stabs',
    {
      tempo: tp(170, 200, 185),
      modes: md('minor:0.8'),
      rhythm: { drumStyle: 'techno' },
      macros: { energy: 0.3, density: 0.1 },
      energyShift: 10,
      production: {
        keywords: ['gabber', 'hardcore techno', 'distorted kick', 'rave'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'techno:0.7 edm:0.3', aliases: ['gabber', 'hardcore techno', 'frenchcore'] },
  ),
  house(
    'big-room',
    'Big room',
    'Festival EDM: huge minimal drops, snare-roll builds, simple anthemic leads',
    {
      tempo: tp(126, 130, 128),
      modes: md('minor:0.7'),
      rhythm: { drumStyle: 'four-on-floor' },
      harmony: { harmonicRhythm: 0.5 },
      instruments: { add: [add('synth-lead', 'synth-lead', 1, 'hook', true)] },
      macros: { energy: 0.2, complexity: -0.2 },
      energyShift: 6,
      production: { keywords: ['big room', 'festival', 'mainstage', 'drop'] },
    },
    { parents: 'edm:1', aliases: ['bigroom', 'festival edm', 'mainstage'] },
  ),
  house(
    'eurodance',
    'Eurodance',
    '90s Euro rave-pop: four-on-the-floor, rap verses, diva hooks and stabby synths',
    {
      tempo: tp(130, 145, 138),
      modes: md('minor:0.8'),
      rhythm: { drumStyle: 'four-on-floor', bassStyle: 'offbeat' },
      harmony: { progressions: [pr('i VI VII i', 2), pr('i VI III VII', 2)] },
      instruments: {
        add: [add('synth-lead', 'synth-lead', 0.9, 'hook'), add('piano', 'keys', 0.5, 'accompaniment')],
      },
      macros: { energy: 0.15 },
      production: { keywords: ['eurodance', '90s', 'rave', 'euro'] },
    },
    { parents: 'edm:0.6 pop:0.4', aliases: ['euro dance', 'euro house', '90s dance'] },
  ),
  house(
    'italo-disco',
    'Italo disco',
    '80s Italian synth-disco: octave basslines, vocoders and arpeggiated sequencers',
    {
      tempo: tp(112, 128, 120),
      modes: md('minor:0.6'),
      rhythm: { drumStyle: 'disco', bassStyle: 'octave' },
      instruments: {
        add: [
          add('synth-arp', 'synth-arp', 0.8, 'texture'),
          add('synth-lead', 'synth-lead', 0.7, 'hook'),
          add('electronic-kit', 'drums', 1, 'rhythm', true),
        ],
        remove: ['drum-kit', 'string-ensemble', 'brass-section'],
      },
      macros: { humanization: -0.15 },
      production: { keywords: ['italo disco', 'vocoder', '80s', 'octave bass'] },
    },
    { parents: 'disco:0.5 synth-pop:0.5', aliases: ['italo', 'italo-disco'] },
  ),
  house(
    'hi-nrg',
    'Hi-NRG',
    'Fast, high-energy 80s club music with relentless octave bass',
    {
      tempo: tp(125, 140, 132),
      rhythm: { drumStyle: 'disco', bassStyle: 'octave' },
      macros: { energy: 0.2, humanization: -0.15 },
      energyShift: 5,
      production: { keywords: ['hi-nrg', 'high energy', '80s club'] },
    },
    { parents: 'disco:0.6 synth-pop:0.4', aliases: ['hi nrg'] },
  ),
  house(
    'gqom',
    'Gqom',
    "Durban's dark, broken-kick house: tribal toms, sparse and ominous",
    {
      tempo: tp(120, 128, 124),
      modes: md('minor:0.6 phrygian:0.3'),
      rhythm: { drumStyle: 'afrobeats', syncopation: 0.75 },
      harmony: { harmonicRhythm: 0.25, progressions: [pr('i', 2)] },
      instruments: { add: [add('percussion', 'percussion', 0.9, 'rhythm')], remove: ['piano', 'synth-lead'] },
      macros: { density: -0.15, energy: 0.05 },
      production: { keywords: ['gqom', 'durban', 'broken beat', 'dark'] },
    },
    { parents: 'house:0.5 amapiano:0.5' },
  ),
  house(
    'kwaito',
    'Kwaito',
    'Slowed-down South African house with chanted vocals and deep bass',
    {
      tempo: tp(100, 112, 106),
      rhythm: { drumStyle: 'four-on-floor' },
      macros: { energy: -0.1, melodicMovement: -0.15 },
      production: { keywords: ['kwaito', 'south african', 'slow house', 'chanted'] },
    },
    { parents: 'house:0.5 amapiano:0.3 hip-hop:0.2' },
  ),
  house(
    'private-school-piano',
    'Private school amapiano',
    'Jazzier, softer amapiano: lush piano, saxophone, gentle log drums',
    {
      harmony: { extensionRate: 0.95 },
      instruments: {
        add: [
          add('saxophone', 'custom', 0.7, 'counter-melody'),
          add('electric-piano', 'keys', 0.6, 'accompaniment'),
        ],
      },
      macros: { energy: -0.15, harmonicTension: 0.15 },
      energyShift: -5,
      production: { keywords: ['private school', 'jazzy amapiano', 'soulful'] },
    },
    { parents: 'amapiano:1', aliases: ['private school', 'private school amapiano'] },
  ),
  // --- Bass music & breaks ------------------------------------------------------------------------
  bass(
    'future-bass',
    'Future bass',
    'Half-time trap drums under huge detuned, pitch-bent supersaw chords',
    {
      tempo: tp(140, 170, 150),
      modes: md('major:0.5'),
      rhythm: { drumStyle: 'trap', halfTimeChance: 0.5 },
      harmony: { extensionRate: 0.7, progressions: [pr('IVmaj7 V7 iii7 vi', 2)] },
      instruments: {
        add: [add('synth-pad', 'synth-pad', 1, 'pad', true), add('synth-lead', 'synth-lead', 0.7, 'hook')],
      },
      macros: { syncopation: 0.1 },
      production: { keywords: ['future bass', 'supersaw chords', 'vocal chops', 'pitch bends'] },
    },
    { parents: 'edm:0.5 dubstep:0.5', aliases: ['future-bass', 'kawaii future bass'] },
  ),
  bass(
    'riddim',
    'Riddim',
    'Minimal, repetitive, metallic dubstep bass hits with lots of space',
    {
      tempo: tp(140, 150, 145),
      rhythm: { drumStyle: 'dubstep' },
      harmony: { harmonicRhythm: 0.25, progressions: [pr('i', 2)] },
      macros: { repetition: -0.3, density: -0.15 },
      production: { keywords: ['riddim', 'metallic bass', 'minimal'] },
    },
    { parents: 'dubstep:1' },
  ),
  bass(
    'brostep',
    'Brostep',
    'Aggressive mid-range growl basses and screeching drops',
    {
      tempo: tp(140, 150, 145),
      modes: md('phrygian:0.4'),
      macros: { energy: 0.2, density: 0.1 },
      energyShift: 6,
      production: { keywords: ['brostep', 'growl bass', 'aggressive'], masteringTarget: 'loud-rock' },
    },
    { parents: 'dubstep:1', aliases: ['tearout'] },
  ),
  bass(
    'festival-trap',
    'EDM trap',
    'Festival trap: brass stabs, 808 drops, snare rolls and hype chants',
    {
      tempo: tp(140, 155, 150),
      rhythm: { drumStyle: 'trap' },
      instruments: {
        add: [add('808-bass', 'bass', 1, 'bass-line', true), add('brass-section', 'custom', 0.6, 'hook')],
      },
      macros: { energy: 0.15 },
      production: { keywords: ['edm trap', 'festival trap', 'brass stabs', '808'] },
    },
    { parents: 'edm:0.5 trap:0.5', aliases: ['edm trap', 'trap edm'] },
  ),
  bass(
    'moombahton',
    'Moombahton',
    'House slowed to 108 BPM with a reggaetón dembow swing',
    {
      tempo: tp(105, 112, 108),
      rhythm: { drumStyle: 'dembow' },
      instruments: { add: [add('synth-lead', 'synth-lead', 0.7, 'hook')] },
      macros: { syncopation: 0.1 },
      production: { keywords: ['moombahton', 'dembow', 'dutch house'] },
    },
    { parents: 'reggaeton:0.5 house:0.5' },
  ),
  bass(
    'jersey-club',
    'Jersey club',
    'Bouncy 140 BPM club music: five-kick bounce, bed-squeak samples, chopped vocals',
    {
      tempo: tp(136, 145, 140),
      rhythm: { drumStyle: 'jersey-club', syncopation: 0.7 },
      macros: { syncopation: 0.15, repetition: -0.15 },
      production: { keywords: ['jersey club', 'bed squeak', 'vocal chops', 'bouncy'] },
    },
    { parents: 'edm:0.5 hip-hop:0.5', aliases: ['jersey'] },
  ),
  bass(
    'footwork',
    'Footwork',
    'Chicago juke at 160: stuttering triplet kicks, chopped vocal loops, sparse 808s',
    {
      tempo: tp(155, 165, 160),
      rhythm: { drumStyle: 'footwork', syncopation: 0.8 },
      instruments: { add: [add('808-bass', 'bass', 0.9, 'bass-line')] },
      macros: { syncopation: 0.2, repetition: -0.2 },
      production: { keywords: ['footwork', 'juke', 'chopped samples', 'chicago'] },
    },
    { parents: 'hip-hop:0.5 edm:0.5', aliases: ['juke', 'chicago juke'] },
  ),
  bass(
    'grime',
    'Grime',
    'London 140 BPM: cold square-wave basslines, eskibeat synths and rapid-fire MCs',
    {
      tempo: tp(138, 142, 140),
      modes: md('minor:0.6 phrygian:0.3'),
      rhythm: { drumStyle: 'drill', halfTimeChance: 0.2 },
      instruments: {
        add: [add('synth-lead', 'synth-lead', 0.7, 'hook'), add('synth-bass', 'bass', 1, 'bass-line', true)],
        remove: ['808-bass', 'string-ensemble'],
      },
      macros: { melodicMovement: -0.2 },
      production: { keywords: ['grime', 'london', 'eskibeat', 'square bass'] },
    },
    { parents: 'drill:0.5 uk-garage:0.5', aliases: ['uk grime'] },
  ),
  bass(
    'speed-garage',
    'Speed garage',
    'Pitched-up garage with four-on-the-floor kicks and warping "rubber" bass',
    {
      tempo: tp(130, 138, 134),
      rhythm: { drumStyle: 'four-on-floor', bassStyle: 'offbeat' },
      macros: { energy: 0.1 },
      production: { keywords: ['speed garage', 'rubber bass', 'warping'] },
    },
    { parents: 'uk-garage:0.7 house:0.3', aliases: ['bassline', 'bassline house'] },
  ),
  bass(
    'future-garage',
    'Future garage',
    'Ghostly, reverb-soaked 2-step with pitched vocal snippets and vinyl hiss',
    {
      tempo: tp(128, 136, 132),
      harmony: { extensionRate: 0.7 },
      instruments: { add: [add('synth-pad', 'synth-pad', 0.9, 'pad', true)] },
      macros: { energy: -0.2, density: -0.15 },
      energyShift: -8,
      production: { keywords: ['future garage', 'ghostly', 'vinyl crackle', 'pitched vocals'], reverb: 0.65 },
    },
    { parents: 'uk-garage:0.6 ambient:0.4' },
  ),
  bass(
    'breakbeat',
    'Breaks',
    'Chopped funk breakbeats driving rave stabs and bass',
    {
      tempo: tp(125, 140, 132),
      rhythm: { drumStyle: 'breakbeat' },
      macros: { syncopation: 0.15 },
      production: { keywords: ['breakbeat', 'breaks', 'chopped drums'] },
    },
    { parents: 'edm:0.6 hip-hop:0.4', aliases: ['breaks', 'nu skool breaks'] },
  ),
  bass(
    'big-beat',
    'Big beat',
    '90s block-rocking breakbeats, distorted riffs and sampled hooks',
    {
      tempo: tp(110, 135, 124),
      rhythm: { drumStyle: 'breakbeat' },
      instruments: {
        add: [
          add('electric-guitar-distorted', 'rhythm-guitar', 0.5, 'rhythm'),
          add('synth-lead', 'synth-lead', 0.6, 'hook'),
        ],
      },
      macros: { energy: 0.15, repetition: -0.15 },
      production: { keywords: ['big beat', '90s', 'breakbeat', 'distorted'] },
    },
    { parents: 'edm:0.5 hip-hop:0.5' },
  ),
  bass(
    'jungle',
    'Jungle',
    'Frenetic chopped Amen breaks at 165+, ragga vocals and deep reggae sub-bass',
    {
      tempo: tp(160, 175, 168),
      rhythm: { drumStyle: 'breakbeat', bassStyle: 'reggae' },
      modes: md('minor:0.6'),
      macros: { complexity: 0.15, syncopation: 0.2 },
      production: { keywords: ['jungle', 'amen break', 'ragga', 'sub bass'] },
    },
    { parents: 'drum-and-bass:0.7 reggae:0.3', aliases: ['ragga jungle', 'oldschool jungle'] },
  ),
  bass(
    'liquid-dnb',
    'Liquid drum and bass',
    'Smooth, melodic drum and bass with soulful pads, pianos and vocals',
    {
      modes: md('dorian:0.3 major:0.3'),
      harmony: { extensionRate: 0.8, progressions: [pr('ii7 V7 Imaj7 vi7', 2)] },
      instruments: {
        add: [
          add('piano', 'keys', 0.8, 'accompaniment'),
          add('lead-vocal', 'vocal', 0.6, 'melody'),
          add('string-ensemble', 'strings', 0.4, 'pad'),
        ],
      },
      macros: { energy: -0.15, harmonicTension: 0.1 },
      energyShift: -6,
      production: { keywords: ['liquid funk', 'liquid dnb', 'soulful', 'smooth'], reverb: 0.45 },
    },
    { parents: 'drum-and-bass:1', aliases: ['liquid', 'liquid funk', 'liquid dnb'] },
  ),
  bass(
    'neurofunk',
    'Neurofunk',
    'Technical, dark drum and bass with surgical, modulated reese basses',
    {
      modes: md('phrygian:0.4 minor:0.4'),
      harmony: { harmonicRhythm: 0.25, progressions: [pr('i bII', 1.5)] },
      macros: { energy: 0.2, complexity: 0.2, harmonicTension: 0.2 },
      energyShift: 5,
      production: { keywords: ['neurofunk', 'reese', 'technical', 'dark'] },
    },
    { parents: 'drum-and-bass:1', aliases: ['neuro'] },
  ),
  bass(
    'jump-up',
    'Jump-up',
    'Bouncy, cartoonish drum and bass with wobbling bass riffs built for the crowd',
    {
      rhythm: { bassStyle: 'wobble' },
      macros: { energy: 0.15, repetition: -0.15, complexity: -0.15 },
      production: { keywords: ['jump up', 'bouncy', 'wobble'] },
    },
    { parents: 'drum-and-bass:1', aliases: ['jump up'] },
  ),
  bass(
    'breakcore',
    'Breakcore',
    'Chaotic hyper-chopped breakbeats at 180+ colliding with pretty melodies and noise',
    {
      tempo: tp(170, 220, 190),
      rhythm: { drumStyle: 'breakbeat', syncopation: 0.85 },
      macros: { complexity: 0.35, repetition: 0.3, energy: 0.2 },
      energyShift: 6,
      production: {
        keywords: ['breakcore', 'chaotic', 'amen chops', 'glitch'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'drum-and-bass:0.7 hyperpop:0.3' },
  ),
  bass(
    'baile-funk',
    'Baile funk',
    "Rio's funk carioca: tamborzão drums, booming 808 hits and chanted MC hooks",
    {
      tempo: tp(125, 135, 130),
      rhythm: { drumStyle: 'baile-funk', syncopation: 0.7 },
      instruments: {
        add: [add('808-bass', 'bass', 1, 'bass-line', true)],
        remove: ['electric-bass', 'synth-bass'],
      },
      macros: { melodicMovement: -0.2, repetition: -0.15 },
      production: { keywords: ['baile funk', 'funk carioca', 'tamborzão', 'rio'] },
    },
    {
      parents: 'hip-hop:0.5 samba:0.5',
      aliases: ['funk carioca', 'brazilian funk', 'funk brasileiro', 'mandelão'],
    },
  ),
  // --- Synth & retro -----------------------------------------------------------------------------
  retro(
    'darksynth',
    'Darksynth',
    'Aggressive, horror-tinged synthwave with distorted bass and metal energy',
    {
      tempo: tp(100, 140, 120),
      modes: md('phrygian:0.3 minor:0.6'),
      rhythm: { bassStyle: 'eighths' },
      macros: { energy: 0.2, harmonicTension: 0.15 },
      energyShift: 6,
      production: {
        keywords: ['darksynth', 'distorted synths', 'horror', 'aggressive'],
        masteringTarget: 'loud-rock',
      },
    },
    { parents: 'synthwave:1', aliases: ['dark synth', 'cyberpunk'] },
  ),
  retro(
    'chillwave',
    'Chillwave',
    'Hazy, nostalgic, lo-fi synth-pop with warped tape and summer haze',
    {
      tempo: tp(86, 112, 98),
      modes: md('major:0.5'),
      harmony: { extensionRate: 0.5 },
      instruments: { add: [add('synth-pad', 'synth-pad', 0.9, 'pad', true)] },
      macros: { energy: -0.2, humanization: 0.1 },
      energyShift: -6,
      production: { keywords: ['chillwave', 'hazy', 'warped tape', 'nostalgic'], reverb: 0.55 },
    },
    { parents: 'synth-pop:0.6 ambient:0.4', aliases: ['glo-fi'] },
  ),
  retro(
    'vaporwave',
    'Vaporwave',
    'Slowed, pitched-down 80s muzak and smooth-jazz samples drenched in reverb',
    {
      tempo: tp(64, 96, 80),
      harmony: { extensionRate: 0.85, progressions: [pr('IVmaj7 iii7 ii7 Imaj7', 2)] },
      rhythm: { swing: 0.1 },
      instruments: {
        add: [
          add('electric-piano', 'keys', 0.8, 'accompaniment'),
          add('saxophone', 'custom', 0.4, 'counter-melody'),
        ],
      },
      macros: { energy: -0.25, repetition: -0.2 },
      energyShift: -8,
      production: { keywords: ['vaporwave', 'slowed', 'mall music', 'aesthetic'], reverb: 0.7 },
    },
    { parents: 'synth-pop:0.4 ambient:0.3 lo-fi-hip-hop:0.3', aliases: ['vapourwave', 'mallsoft'] },
  ),
  retro(
    'witch-house',
    'Witch house',
    'Occult, slowed trap beats with droning synths and ghostly pitched vocals',
    {
      tempo: tp(60, 80, 70),
      modes: md('minor:0.5 phrygian:0.4'),
      rhythm: { drumStyle: 'trap', halfTimeChance: 0.6 },
      instruments: {
        add: [add('synth-pad', 'synth-pad', 0.9, 'pad', true), add('choir', 'vocal', 0.4, 'pad')],
      },
      macros: { energy: -0.15, harmonicTension: 0.2 },
      production: { keywords: ['witch house', 'occult', 'dark', 'drag'], reverb: 0.65 },
    },
    { parents: 'trap:0.5 ambient:0.5', aliases: ['witch-house'] },
  ),
  retro(
    'electro',
    'Electro',
    '808 electro-funk: robotic syncopated kicks, vocoders and laser synths',
    {
      tempo: tp(110, 130, 122),
      rhythm: { drumStyle: 'breakbeat', syncopation: 0.65 },
      instruments: {
        add: [
          add('electronic-kit', 'drums', 1, 'rhythm', true),
          add('synth-lead', 'synth-lead', 0.6, 'hook'),
        ],
        remove: ['drum-kit'],
      },
      macros: { humanization: -0.25 },
      production: { keywords: ['electro', 'electro-funk', 'vocoder', '808'] },
    },
    { parents: 'edm:0.5 funk:0.5', aliases: ['electro funk', 'electro-funk'] },
  ),
  retro(
    'ebm',
    'EBM / industrial',
    'Electronic body music: sequenced bass, marching drum machines, shouted vocals',
    {
      tempo: tp(110, 130, 120),
      modes: md('minor:0.7'),
      rhythm: { drumStyle: 'techno', bassStyle: 'eighths' },
      instruments: { add: [add('synth-seq', 'synth-seq', 0.8, 'rhythm')] },
      macros: { humanization: -0.3, repetition: -0.2 },
      production: { keywords: ['ebm', 'industrial', 'body music', 'mechanical'] },
    },
    { parents: 'synth-pop:0.5 techno:0.5', aliases: ['industrial', 'electronic body music'] },
  ),
  retro(
    'electroclash',
    'Electroclash',
    'Deadpan punk attitude over cheap 80s drum machines and buzzing synths',
    {
      tempo: tp(118, 132, 126),
      rhythm: { drumStyle: 'synth-pop', bassStyle: 'octave' },
      macros: { complexity: -0.2, humanization: -0.15 },
      production: { keywords: ['electroclash', 'deadpan', 'cheap synths'] },
    },
    { parents: 'synth-pop:0.6 punk:0.4' },
  ),
  retro(
    'nightcore',
    'Nightcore',
    'Sped-up, pitched-up dance tracks with euphoric trance energy',
    {
      tempo: { shift: 24 },
      modes: md('major:0.3'),
      macros: { energy: 0.2 },
      energyShift: 5,
      production: { keywords: ['nightcore', 'sped up', 'pitched up'] },
    },
    { parents: 'edm:0.6 hyperpop:0.4' },
  ),
  retro(
    'digicore',
    'Digicore',
    'Online-born pop-rap: glitchy, pitched-up, emo-melodic with hyperpop drums',
    {
      tempo: tp(140, 170, 156),
      rhythm: { drumStyle: 'trap' },
      instruments: { add: [add('electric-guitar-clean', 'rhythm-guitar', 0.4, 'accompaniment')] },
      macros: { melodicMovement: 0.15, complexity: 0.1 },
      production: { keywords: ['digicore', 'glitchy', 'pitched vocals', 'emo'] },
    },
    { parents: 'hyperpop:0.6 trap:0.4', aliases: ['glitchcore'] },
  ),
  // --- Downtempo & ambient ----------------------------------------------------------------------
  downtempo(
    'trip-hop',
    'Trip-hop',
    'Slow, smoky breakbeats with dark jazz chords, strings and cinematic gloom',
    {
      tempo: tp(70, 96, 84),
      modes: md('minor:0.8'),
      rhythm: { drumStyle: 'boom-bap', swing: 0.25 },
      harmony: { extensionRate: 0.6, borrowedChordRate: 0.3 },
      instruments: {
        add: [
          add('string-ensemble', 'strings', 0.6, 'pad'),
          add('electric-piano', 'keys', 0.5, 'accompaniment'),
        ],
      },
      macros: { energy: -0.15, harmonicTension: 0.15 },
      production: { keywords: ['trip-hop', 'bristol', 'smoky', 'cinematic', 'vinyl'], reverb: 0.4 },
    },
    { parents: 'hip-hop:0.5 ambient:0.3 cinematic:0.2', aliases: ['trip hop', 'triphop', 'bristol sound'] },
  ),
  downtempo(
    'downtempo',
    'Downtempo',
    'Relaxed, groove-led electronica at walking pace',
    {
      tempo: tp(80, 105, 92),
      rhythm: { drumStyle: 'boom-bap', swing: 0.15 },
      instruments: { add: [add('electric-piano', 'keys', 0.6, 'accompaniment')] },
      macros: { energy: -0.2 },
      energyShift: -6,
      production: { keywords: ['downtempo', 'relaxed', 'groovy', 'chill'] },
    },
    { parents: 'ambient:0.5 hip-hop:0.5', aliases: ['down tempo'] },
  ),
  downtempo(
    'chillout',
    'Chillout',
    'Balearic sunset electronica: lush pads, guitars and slow grooves',
    {
      tempo: tp(84, 110, 96),
      modes: md('major:0.4 dorian:0.3'),
      harmony: { extensionRate: 0.6 },
      instruments: {
        add: [
          add('nylon-guitar', 'rhythm-guitar', 0.5, 'accompaniment'),
          add('synth-pad', 'synth-pad', 0.8, 'pad'),
        ],
      },
      macros: { energy: -0.25 },
      energyShift: -8,
      production: { keywords: ['chillout', 'balearic', 'sunset', 'lush'], reverb: 0.5 },
    },
    { parents: 'ambient:0.6 house:0.4', aliases: ['chill out', 'balearic', 'café del mar'] },
  ),
  downtempo(
    'idm',
    'IDM',
    'Intricate, glitchy electronic "listening" music with complex programmed rhythms',
    {
      meters: [m54, m78],
      rhythm: { drumStyle: 'breakbeat', syncopation: 0.8 },
      instruments: { add: [add('synth-arp', 'synth-arp', 0.8, 'texture')] },
      macros: { complexity: 0.35, repetition: 0.25, humanization: -0.3 },
      production: { keywords: ['idm', 'glitch', 'intricate', 'warp records'] },
    },
    { parents: 'edm:0.5 ambient:0.5', aliases: ['intelligent dance music', 'glitch music'] },
  ),
  downtempo(
    'electronica',
    'Electronica',
    'Melodic, textural electronic music between club and home listening',
    {
      rhythm: { drumStyle: 'synth-pop' },
      instruments: {
        add: [add('synth-arp', 'synth-arp', 0.7, 'texture'), add('synth-pad', 'synth-pad', 0.7, 'pad')],
      },
      macros: { complexity: 0.1, repetition: -0.05 },
      production: { keywords: ['electronica', 'textural', 'melodic'] },
    },
    { parents: 'edm:0.5 ambient:0.5' },
  ),
  downtempo(
    'dark-ambient',
    'Dark ambient',
    'Ominous drones, sub rumbles and dissonant textures',
    {
      modes: md('phrygian:0.5 locrian:0.2 minor:0.3'),
      harmony: { borrowedChordRate: 0.5, progressions: [pr('i bII', 1.5)] },
      macros: { harmonicTension: 0.35, energy: -0.1 },
      production: { keywords: ['dark ambient', 'drone', 'ominous', 'industrial textures'], reverb: 0.8 },
    },
    { parents: 'ambient:1', aliases: ['drone ambient'] },
  ),
  downtempo(
    'drone',
    'Drone',
    'Sustained tones and slowly shifting overtones with almost no harmonic movement',
    {
      harmony: { harmonicRhythm: 0.25, progressions: [pr('I', 3), pr('i', 2)] },
      instruments: { remove: DRUM_KITS },
      macros: { repetition: -0.3, density: -0.2, melodicMovement: -0.3 },
      production: { keywords: ['drone', 'sustained', 'overtones'], reverb: 0.75 },
    },
    { parents: 'ambient:1' },
  ),
  downtempo(
    'new-age',
    'New age',
    'Gentle, consonant, meditative music with pads, piano, harp and flute',
    {
      modes: md('major:0.5 lydian:0.4'),
      harmony: { borrowedChordRate: 0.02, progressions: [pr('Iadd9 IVadd9', 2)] },
      instruments: {
        add: [add('harp', 'keys', 0.6, 'accompaniment'), add('flute', 'custom', 0.5, 'melody')],
        remove: DRUM_KITS,
      },
      macros: { harmonicTension: -0.2, energy: -0.2 },
      production: { keywords: ['new age', 'meditative', 'healing', 'consonant'], reverb: 0.7 },
    },
    { parents: 'ambient:1', aliases: ['meditation', 'healing music'] },
  ),
  downtempo(
    'lounge',
    'Lounge',
    'Cocktail-hour easy listening: brushed bossa grooves, vibraphone, smooth keys',
    {
      tempo: tp(90, 126, 108),
      rhythm: { drumStyle: 'bossa-nova', compStyle: 'bossa' },
      harmony: { extensionRate: 0.85 },
      instruments: {
        add: [
          add('marimba', 'keys', 0.5, 'counter-melody'),
          add('electric-piano', 'keys', 0.6, 'accompaniment'),
        ],
      },
      macros: { energy: -0.2 },
      production: { keywords: ['lounge', 'cocktail', 'easy listening', 'exotica'] },
    },
    { parents: 'jazz:0.5 bossa-nova:0.5', aliases: ['cocktail lounge', 'exotica'] },
  ),
  downtempo(
    'electro-swing',
    'Electro swing',
    'Vintage swing samples and horns on a house beat',
    {
      tempo: tp(118, 130, 124),
      rhythm: { drumStyle: 'four-on-floor', swing: 0.6, subdivision: 12 },
      instruments: {
        add: [
          add('brass-section', 'custom', 0.8, 'hook'),
          add('upright-bass', 'bass', 0.6, 'bass-line'),
          add('piano', 'keys', 0.5, 'accompaniment'),
        ],
      },
      macros: { syncopation: 0.1 },
      production: { keywords: ['electro swing', '1930s samples', 'horns', 'house beat'] },
    },
    { parents: 'jazz:0.5 house:0.5', aliases: ['electroswing'] },
  ),
  downtempo(
    'nu-jazz',
    'Nu jazz',
    'Jazz harmony and improvisation over broken-beat and downtempo electronics',
    {
      rhythm: { drumStyle: 'breakbeat', swing: 0.2 },
      harmony: { extensionRate: 0.9 },
      instruments: {
        add: [
          add('electric-piano', 'keys', 0.8, 'accompaniment'),
          add('trumpet', 'custom', 0.5, 'counter-melody'),
        ],
      },
      macros: { complexity: 0.15 },
      production: { keywords: ['nu jazz', 'broken beat', 'jazztronica'] },
    },
    { parents: 'jazz:0.6 edm:0.4', aliases: ['jazztronica', 'broken beat'] },
  ),
];

const URBAN_TAGS: StyleTag[] = [
  // --- Hip-hop & rap -------------------------------------------------------------------------------
  hiphop(
    'boom-bap',
    'Boom bap',
    'Hard-hitting sampled kicks and snares, swung 16ths, chopped soul and jazz loops',
    {
      tempo: tp(84, 98, 90),
      rhythm: { drumStyle: 'boom-bap', swing: 0.3 },
      harmony: { extensionRate: 0.6 },
      instruments: {
        add: [
          add('drum-kit', 'drums', 1, 'rhythm', true),
          add('electric-piano', 'keys', 0.6, 'accompaniment'),
        ],
        remove: ['electronic-kit', '808-bass'],
      },
      macros: { humanization: 0.1 },
      production: { keywords: ['boom bap', 'sampled drums', 'dusty', '90s'] },
    },
    { parents: 'hip-hop:1', aliases: ['boom-bap', 'boombap'] },
  ),
  hiphop(
    'golden-age-hip-hop',
    'Golden age hip-hop',
    'Late-80s/early-90s rap: breakbeats, funk and jazz samples, scratches',
    {
      tempo: tp(88, 104, 96),
      rhythm: { drumStyle: 'boom-bap', swing: 0.2 },
      instruments: { add: [add('brass-section', 'custom', 0.4, 'hook')] },
      macros: { humanization: 0.1, syncopation: 0.05 },
      production: { keywords: ['golden age', 'old school', 'breakbeats', 'scratches'] },
    },
    { parents: 'hip-hop:0.8 funk:0.2', aliases: ['old school hip hop', 'oldschool rap', 'golden era'] },
  ),
  hiphop(
    'east-coast-hip-hop',
    'East Coast hip-hop',
    'Gritty New York boom bap: dark piano loops, hard snares, dense lyricism',
    {
      modes: md('minor:0.8'),
      rhythm: { drumStyle: 'boom-bap' },
      instruments: {
        add: [add('piano', 'keys', 0.7, 'accompaniment'), add('string-ensemble', 'strings', 0.4, 'pad')],
      },
      macros: { harmonicTension: 0.1 },
      production: { keywords: ['east coast', 'new york', 'gritty', 'boom bap'] },
    },
    { parents: 'hip-hop:1', aliases: ['east coast rap', 'new york rap'] },
  ),
  hiphop(
    'g-funk',
    'G-funk',
    'West Coast funk-rap: whiny portamento synth leads, P-funk bass, laid-back swing',
    {
      tempo: tp(88, 100, 94),
      modes: md('dorian:0.5 minor:0.3'),
      rhythm: { swing: 0.2, bassStyle: 'funk' },
      harmony: { extensionRate: 0.6, progressions: [pr('i7 IV9', 2)] },
      instruments: {
        add: [
          add('synth-lead', 'synth-lead', 0.9, 'hook', true),
          add('synth-bass', 'bass', 1, 'bass-line', true),
        ],
      },
      macros: { energy: -0.1 },
      production: { keywords: ['g-funk', 'west coast', 'talkbox', 'laid back'] },
    },
    { parents: 'hip-hop:0.6 funk:0.4', aliases: ['west coast hip hop', 'west coast rap', 'gfunk'] },
  ),
  hiphop(
    'jazz-rap',
    'Jazz rap',
    'Mellow hip-hop over jazz samples: upright bass, muted trumpet, Rhodes',
    {
      harmony: { extensionRate: 0.9, progressions: [pr('ii7 V7 Imaj7 vi7', 2)] },
      rhythm: { swing: 0.3, drumStyle: 'boom-bap' },
      instruments: {
        add: [
          add('upright-bass', 'bass', 1, 'bass-line', true),
          add('trumpet', 'custom', 0.5, 'counter-melody'),
          add('electric-piano', 'keys', 0.7, 'accompaniment'),
        ],
        remove: ['808-bass', 'synth-bass'],
      },
      macros: { harmonicTension: 0.2, energy: -0.1 },
      production: { keywords: ['jazz rap', 'jazzy samples', 'mellow', 'conscious'] },
    },
    {
      parents: 'hip-hop:0.6 jazz:0.4',
      aliases: ['jazz hop', 'jazzhop', 'conscious rap', 'abstract hip hop'],
    },
  ),
  hiphop(
    'emo-rap',
    'Emo rap',
    'Sad, melodic rap over trap drums and lo-fi emo guitar loops',
    {
      tempo: tp(130, 160, 145),
      modes: md('minor:0.7'),
      rhythm: { drumStyle: 'trap' },
      instruments: {
        add: [
          add('electric-guitar-clean', 'rhythm-guitar', 0.9, 'accompaniment', true),
          add('808-bass', 'bass', 1, 'bass-line', true),
        ],
      },
      macros: { melodicMovement: 0.1, energy: -0.05 },
      production: { keywords: ['emo rap', 'sad', 'guitar loops', 'soundcloud'] },
    },
    { parents: 'trap:0.6 emo:0.4', aliases: ['sad rap', 'emo trap', 'soundcloud rap'] },
  ),
  hiphop(
    'cloud-rap',
    'Cloud rap',
    'Dreamy, reverb-drowned trap with ethereal pads and floating vocals',
    {
      tempo: tp(120, 150, 136),
      harmony: { extensionRate: 0.5 },
      rhythm: { drumStyle: 'trap', halfTimeChance: 0.4 },
      instruments: {
        add: [add('synth-pad', 'synth-pad', 1, 'pad', true), add('choir', 'vocal', 0.3, 'pad')],
      },
      macros: { energy: -0.2, density: -0.1 },
      energyShift: -6,
      production: { keywords: ['cloud rap', 'dreamy', 'ethereal', 'reverb'], reverb: 0.6 },
    },
    { parents: 'trap:0.6 ambient:0.4', aliases: ['cloud-rap'] },
  ),
  hiphop(
    'rage-trap',
    'Rage',
    'Hyperactive trap with blown-out, distorted supersaw leads and moshing energy',
    {
      tempo: tp(145, 170, 156),
      rhythm: { drumStyle: 'trap' },
      instruments: {
        add: [
          add('synth-lead', 'synth-lead', 1, 'hook', true),
          add('808-bass', 'bass', 1, 'bass-line', true),
        ],
      },
      macros: { energy: 0.25, repetition: -0.2 },
      energyShift: 6,
      production: { keywords: ['rage', 'distorted synths', 'mosh', 'hyper'], masteringTarget: 'loud-rock' },
    },
    { parents: 'trap:0.8 hyperpop:0.2', aliases: ['rage beat', 'rage rap'] },
  ),
  hiphop(
    'plugg',
    'Plugg',
    'Soft, twinkly trap: pluggy square-wave melodies, sparse 808s and airy pads',
    {
      tempo: tp(140, 160, 150),
      modes: md('major:0.5'),
      rhythm: { drumStyle: 'trap' },
      instruments: {
        add: [add('chip-lead', 'synth-lead', 0.7, 'hook'), add('synth-pad', 'synth-pad', 0.6, 'pad')],
      },
      macros: { density: -0.15, energy: -0.1 },
      production: { keywords: ['plugg', 'pluggnb', 'twinkly', 'soft'] },
    },
    { parents: 'trap:0.8 rnb:0.2', aliases: ['pluggnb'] },
  ),
  hiphop(
    'trap-soul',
    'Trap soul',
    'R&B vocals floating over minimal trap drums and moody minor chords',
    {
      tempo: tp(60, 80, 70),
      modes: md('minor:0.7'),
      rhythm: { drumStyle: 'trap', halfTimeChance: 0.2 },
      harmony: { extensionRate: 0.75 },
      instruments: {
        add: [
          add('808-bass', 'bass', 1, 'bass-line', true),
          add('electric-piano', 'keys', 0.6, 'accompaniment'),
        ],
      },
      macros: { energy: -0.15 },
      production: { keywords: ['trap soul', 'trapsoul', 'moody', 'r&b'] },
    },
    { parents: 'rnb:0.6 trap:0.4', aliases: ['trapsoul', 'trap&b', 'trap rnb'] },
  ),
  hiphop(
    'pop-rap',
    'Pop rap',
    'Radio rap with sung pop hooks and bright production',
    {
      modes: md('major:0.4'),
      rhythm: { drumStyle: 'hip-hop' },
      instruments: {
        add: [add('piano', 'keys', 0.5, 'accompaniment'), add('synth-lead', 'synth-lead', 0.4, 'hook')],
      },
      macros: { melodicMovement: 0.1 },
      production: { keywords: ['pop rap', 'radio', 'catchy hook'] },
    },
    { parents: 'hip-hop:0.6 pop:0.4', aliases: ['pop-rap'] },
  ),
  hiphop(
    'crunk',
    'Crunk',
    'Dirty-south party rap: chanted hooks, synth stabs, booming 808s',
    {
      tempo: tp(70, 82, 76),
      rhythm: { drumStyle: 'trap' },
      instruments: {
        add: [add('808-bass', 'bass', 1, 'bass-line', true), add('synth-lead', 'synth-lead', 0.6, 'hook')],
      },
      macros: { energy: 0.2, melodicMovement: -0.25 },
      production: { keywords: ['crunk', 'dirty south', 'chants', 'party'] },
    },
    { parents: 'trap:0.6 hip-hop:0.4', aliases: ['dirty south', 'snap music'] },
  ),
  hiphop(
    'memphis-rap',
    'Memphis rap',
    'Lo-fi, horror-tinged 90s Memphis tapes: cowbells, 808s and triplet flows',
    {
      tempo: tp(130, 150, 140),
      modes: md('phrygian:0.4 minor:0.5'),
      rhythm: { drumStyle: 'phonk' },
      macros: { humanization: 0.1, harmonicTension: 0.1 },
      production: { keywords: ['memphis rap', 'tape hiss', 'cowbell', 'horrorcore'] },
    },
    { parents: 'phonk:0.6 hip-hop:0.4', aliases: ['memphis rap', 'horrorcore'] },
  ),
  hiphop(
    'chopped-and-screwed',
    'Chopped & screwed',
    'Houston-style: slowed-down, pitched-down tracks with chopped, stuttering repeats',
    {
      tempo: { shift: -24 },
      rhythm: { halfTimeChance: 0.4 },
      macros: { energy: -0.2, repetition: -0.2 },
      energyShift: -6,
      production: { keywords: ['chopped and screwed', 'slowed', 'houston', 'syrupy'], reverb: 0.4 },
    },
    { parents: 'hip-hop:1', aliases: ['chopped and screwed', 'screwed', 'screw music'] },
  ),
  hiphop(
    'latin-trap',
    'Latin trap',
    'Spanish-language trap: dark minor loops, 808s and reggaetón-flavoured hooks',
    {
      modes: md('minor:0.7 harmonic-minor:0.2'),
      rhythm: { drumStyle: 'trap' },
      instruments: {
        add: [
          add('808-bass', 'bass', 1, 'bass-line', true),
          add('nylon-guitar', 'rhythm-guitar', 0.4, 'accompaniment'),
        ],
      },
      production: { keywords: ['latin trap', 'trap latino', 'urbano'] },
      macros: { syncopation: 0.05 },
    },
    { parents: 'trap:0.6 reggaeton:0.4', aliases: ['trap latino', 'urbano'] },
  ),
  hiphop(
    'afro-trap',
    'Afro trap',
    'French/UK rap over afrobeats-flavoured percussion and trap 808s',
    {
      tempo: tp(100, 120, 110),
      rhythm: { drumStyle: 'afrobeats' },
      instruments: {
        add: [add('808-bass', 'bass', 1, 'bass-line'), add('percussion', 'percussion', 0.7, 'rhythm')],
      },
      macros: { syncopation: 0.1 },
      production: { keywords: ['afro trap', 'afroswing', 'percussive'] },
    },
    { parents: 'afrobeats:0.5 trap:0.5', aliases: ['afroswing', 'afro swing'] },
  ),
  hiphop(
    'hyphy',
    'Hyphy',
    'Bay Area party rap: slapping, bouncing 808s, synth stabs and chants',
    {
      tempo: tp(98, 110, 104),
      rhythm: { drumStyle: 'hip-hop', syncopation: 0.7 },
      instruments: { add: [add('808-bass', 'bass', 1, 'bass-line')] },
      macros: { energy: 0.2 },
      production: { keywords: ['hyphy', 'bay area', 'slaps', 'party'] },
    },
    { parents: 'hip-hop:1', aliases: ['bay area rap'] },
  ),
  hiphop(
    'bounce',
    'New Orleans bounce',
    'Call-and-response party rap on the Triggerman and Brown beats',
    {
      tempo: tp(98, 108, 104),
      rhythm: { drumStyle: 'dembow' },
      instruments: { add: [add('backing-vocal', 'vocal', 0.7, 'harmony')] },
      macros: { energy: 0.2, melodicMovement: -0.2 },
      production: { keywords: ['bounce', 'new orleans', 'call and response', 'triggerman'] },
    },
    { parents: 'hip-hop:1', aliases: ['bounce music', 'new orleans bounce'] },
  ),
  hiphop(
    'desi-hip-hop',
    'Desi hip-hop',
    'South Asian rap: dhol and tabla flavours, sampled Bollywood strings',
    {
      rhythm: { drumStyle: 'bhangra' },
      instruments: {
        add: [
          add('sitar', 'custom', 0.5, 'counter-melody'),
          add('percussion', 'percussion', 0.7, 'rhythm'),
          add('808-bass', 'bass', 0.8, 'bass-line'),
        ],
      },
      macros: { syncopation: 0.1 },
      production: { keywords: ['desi hip hop', 'gully rap', 'dhol', 'punjabi'] },
    },
    { parents: 'hip-hop:0.6 bollywood:0.4', aliases: ['desi rap', 'gully rap', 'punjabi rap'] },
  ),
  hiphop(
    'nerdcore',
    'Nerdcore',
    'Playful, wordy rap about games and geekdom over chiptune-flavoured beats',
    {
      instruments: { add: [add('chip-lead', 'synth-lead', 0.7, 'hook')] },
      macros: { complexity: 0.1, melodicMovement: -0.1 },
      production: { keywords: ['nerdcore', 'chiptune samples', 'playful'] },
    },
    { parents: 'hip-hop:0.7 chiptune:0.3' },
  ),
  // --- R&B, soul & funk --------------------------------------------------------------------------
  soul(
    'neo-soul',
    'Neo-soul',
    'Organic, jazz-inflected soul: lazy swung grooves, Rhodes, extended chords, live bass',
    {
      tempo: tp(68, 96, 82),
      modes: md('dorian:0.4 minor:0.3'),
      rhythm: { swing: 0.35, drumStyle: 'boom-bap' },
      harmony: {
        extensionRate: 0.95,
        borrowedChordRate: 0.3,
        progressions: [pr('IVmaj7 iii7 vi7 V7/V', 1.2), pr('i9 iv9', 2)],
      },
      instruments: {
        add: [
          add('electric-piano', 'keys', 1, 'accompaniment', true),
          add('electric-bass', 'bass', 1, 'bass-line', true),
        ],
        remove: ['808-bass', 'synth-bass'],
      },
      macros: { harmonicTension: 0.2, humanization: 0.2 },
      production: { keywords: ['neo-soul', 'organic', 'rhodes', 'behind the beat'] },
    },
    { parents: 'soul:0.5 rnb:0.5', aliases: ['neo soul', 'neosoul'] },
  ),
  soul(
    'quiet-storm',
    'Quiet storm',
    'Late-night 80s slow jams: silky vocals, soft keys, sax and gentle grooves',
    {
      tempo: tp(60, 80, 70),
      harmony: { extensionRate: 0.85, progressions: [pr('Imaj7 vi7 ii7 V7', 2)] },
      instruments: {
        add: [
          add('saxophone', 'custom', 0.6, 'counter-melody'),
          add('electric-piano', 'keys', 0.8, 'accompaniment'),
          add('synth-pad', 'synth-pad', 0.5, 'pad'),
        ],
      },
      macros: { energy: -0.25, dynamics: -0.05 },
      energyShift: -8,
      production: { keywords: ['quiet storm', 'slow jam', 'late night', 'silky'] },
    },
    { parents: 'rnb:0.7 soul:0.3', aliases: ['slow jam', 'slow jams'] },
  ),
  soul(
    'new-jack-swing',
    'New jack swing',
    'Late-80s swung drum machines, gospel chords, synth stabs and dance-floor R&B',
    {
      tempo: tp(98, 112, 104),
      rhythm: { drumStyle: 'hip-hop', swing: 0.45, subdivision: 16 },
      harmony: { extensionRate: 0.6 },
      instruments: {
        add: [
          add('electronic-kit', 'drums', 1, 'rhythm', true),
          add('synth-lead', 'synth-lead', 0.5, 'hook'),
          add('brass-section', 'custom', 0.4, 'hook'),
        ],
        remove: ['drum-kit'],
      },
      macros: { syncopation: 0.15, energy: 0.1 },
      production: { keywords: ['new jack swing', 'swingbeat', '80s', 'swung drum machine'] },
    },
    { parents: 'rnb:0.6 hip-hop:0.4', aliases: ['swingbeat', 'new jack'] },
  ),
  soul(
    'contemporary-rnb',
    'Contemporary R&B',
    'Modern R&B: crisp programmed drums, atmospheric keys, layered runs',
    {
      rhythm: { drumStyle: 'trap', halfTimeChance: 0.3 },
      instruments: {
        add: [add('synth-pad', 'synth-pad', 0.7, 'pad'), add('backing-vocal', 'vocal', 0.6, 'harmony')],
      },
      macros: { humanization: -0.15 },
      production: { keywords: ['contemporary r&b', 'modern', 'layered vocals', 'crisp'] },
    },
    { parents: 'rnb:1', aliases: ['modern rnb', 'modern r&b'] },
  ),
  soul(
    'alternative-rnb',
    'Alternative R&B',
    'Moody, experimental R&B: hazy pads, sparse beats, falsetto and reverb',
    {
      modes: md('minor:0.5 dorian:0.3'),
      rhythm: { halfTimeChance: 0.5 },
      instruments: { add: [add('synth-pad', 'synth-pad', 1, 'pad', true)] },
      macros: { density: -0.2, energy: -0.15, repetition: 0.1 },
      production: { keywords: ['alternative r&b', 'pbr&b', 'hazy', 'moody'], reverb: 0.55 },
    },
    { parents: 'rnb:0.7 ambient:0.3', aliases: ['alt r&b', 'alt-rnb', 'pbr&b'] },
  ),
  soul(
    'motown',
    'Motown',
    '60s Detroit soul: four-on-the-snare backbeat, tambourine, melodic bass and strings',
    {
      tempo: tp(110, 132, 120),
      modes: md('major:0.8'),
      rhythm: { drumStyle: 'soul' },
      instruments: {
        add: [
          add('percussion', 'percussion', 0.8, 'rhythm'),
          add('string-ensemble', 'strings', 0.5, 'pad'),
          add('backing-vocal', 'vocal', 0.8, 'harmony'),
        ],
      },
      macros: { energy: 0.1 },
      production: { keywords: ['motown', 'tambourine', '60s', 'detroit'] },
    },
    { parents: 'soul:1', aliases: ['motown sound', 'detroit soul'] },
  ),
  soul(
    'northern-soul',
    'Northern soul',
    'Uptempo, stomping soul for all-nighters: driving four-to-the-floor snare',
    {
      tempo: tp(112, 130, 122),
      modes: md('major:0.7'),
      rhythm: { drumStyle: 'soul' },
      macros: { energy: 0.2 },
      energyShift: 5,
      production: { keywords: ['northern soul', 'stomper', 'all-nighter'] },
    },
    { parents: 'soul:1' },
  ),
  soul(
    'philly-soul',
    'Philly soul',
    'Lush 70s Philadelphia soul: sweeping strings, horns, hi-hat-driven grooves',
    {
      tempo: tp(100, 122, 112),
      rhythm: { drumStyle: 'disco', bassStyle: 'octave' },
      harmony: { extensionRate: 0.7 },
      instruments: {
        add: [
          add('string-ensemble', 'strings', 0.9, 'pad', true),
          add('brass-section', 'custom', 0.6, 'harmony'),
        ],
      },
      production: { keywords: ['philly soul', 'lush strings', '70s', 'sweet soul'] },
      macros: { dynamics: 0.1 },
    },
    { parents: 'soul:0.6 disco:0.4', aliases: ['philadelphia soul', 'sweet soul'] },
  ),
  soul(
    'southern-soul-style',
    'Southern soul',
    'Gritty Memphis/Muscle Shoals soul: horn punches, organ, gospel fire',
    {
      tempo: tp(80, 116, 98),
      rhythm: { swing: 0.2, compStyle: 'chop' },
      instruments: {
        add: [add('organ', 'keys', 0.8, 'pad'), add('brass-section', 'custom', 0.8, 'harmony')],
      },
      macros: { humanization: 0.15, dynamics: 0.1 },
      production: { keywords: ['southern soul', 'stax', 'memphis', 'gritty'] },
    },
    { parents: 'soul:0.7 blues:0.3', aliases: ['stax', 'memphis soul', 'muscle shoals'] },
  ),
  soul(
    'psychedelic-soul',
    'Psychedelic soul',
    'Late-60s soul with fuzz guitars, wah, long jams and political swagger',
    {
      modes: md('dorian:0.4 minor:0.3'),
      rhythm: { bassStyle: 'funk' },
      instruments: {
        add: [
          add('electric-guitar-distorted', 'rhythm-guitar', 0.6, 'rhythm'),
          add('organ', 'keys', 0.6, 'pad'),
        ],
      },
      macros: { repetition: -0.1 },
      production: { keywords: ['psychedelic soul', 'wah-wah', 'fuzz'], reverb: 0.4 },
    },
    { parents: 'soul:0.5 funk:0.5' },
  ),
  soul(
    'p-funk',
    'P-funk',
    'Parliament-style funk: squelchy synth bass, chanted hooks, cosmic weirdness',
    {
      tempo: tp(96, 112, 104),
      rhythm: { bassStyle: 'funk' },
      instruments: {
        add: [add('synth-bass', 'bass', 1, 'bass-line', true), add('synth-lead', 'synth-lead', 0.7, 'hook')],
        remove: ['electric-bass'],
      },
      macros: { repetition: -0.15, syncopation: 0.1 },
      production: { keywords: ['p-funk', 'mothership', 'synth bass', 'chants'] },
    },
    { parents: 'funk:1', aliases: ['pfunk', 'parliament funk'] },
  ),
  soul(
    'go-go',
    'Go-go',
    'Washington DC funk: non-stop conga-driven swing beat and call-and-response',
    {
      tempo: tp(90, 104, 96),
      rhythm: { swing: 0.3 },
      instruments: {
        add: [
          add('percussion', 'percussion', 1, 'rhythm', true),
          add('brass-section', 'custom', 0.6, 'hook'),
        ],
      },
      macros: { syncopation: 0.15, repetition: -0.2 },
      production: { keywords: ['go-go', 'washington dc', 'congas', 'call and response'] },
    },
    { parents: 'funk:1', aliases: ['gogo', 'go go'] },
  ),
  soul(
    'boogie-funk',
    'Boogie',
    'Early-80s post-disco funk: synth bass, vocoders, slick drum machines',
    {
      tempo: tp(104, 118, 110),
      rhythm: { bassStyle: 'octave' },
      instruments: {
        add: [add('synth-bass', 'bass', 1, 'bass-line', true), add('synth-pad', 'synth-pad', 0.6, 'pad')],
        remove: ['electric-bass'],
      },
      macros: { humanization: -0.15 },
      production: { keywords: ['boogie', 'post-disco', 'synth funk', '80s'] },
    },
    { parents: 'funk:0.6 disco:0.4', aliases: ['post-disco', 'synth funk'] },
  ),
  soul(
    'funk-rock',
    'Funk rock',
    'Slap bass and distorted guitar riffs, big drums and syncopated swagger',
    {
      rhythm: { drumStyle: 'funk' },
      instruments: { add: [add('electric-guitar-distorted', 'rhythm-guitar', 0.9, 'rhythm', true)] },
      harmony: { powerChords: true },
      macros: { energy: 0.15 },
      production: { keywords: ['funk rock', 'slap bass', 'riffs'] },
    },
    { parents: 'funk:0.6 rock:0.4', aliases: ['funk metal'] },
  ),
  soul(
    'afrobeat-fela',
    'Afrobeat (Fela)',
    'Long, hypnotic Afro-funk jams: interlocking guitars, horn riffs, polyrhythmic percussion',
    {
      tempo: tp(100, 122, 110),
      modes: md('dorian:0.5'),
      rhythm: { drumStyle: 'afrobeats', compStyle: 'highlife' },
      instruments: {
        add: [
          add('brass-section', 'custom', 0.9, 'hook', true),
          add('percussion', 'percussion', 0.8, 'rhythm'),
          add('organ', 'keys', 0.5, 'pad'),
        ],
      },
      macros: { repetition: -0.25, syncopation: 0.15 },
      production: { keywords: ['afrobeat', 'fela', 'afro-funk', 'horn riffs'] },
    },
    { parents: 'funk:0.5 afrobeats:0.5', aliases: ['fela', 'afro-funk', 'afro funk'] },
  ),
  soul(
    'contemporary-gospel',
    'Contemporary gospel',
    'Modern gospel: R&B production, stacked choir, big key changes',
    {
      rhythm: { drumStyle: 'gospel' },
      instruments: { add: [add('synth-pad', 'synth-pad', 0.5, 'pad')] },
      macros: { humanization: -0.1, dynamics: 0.1 },
      production: { keywords: ['contemporary gospel', 'urban gospel', 'polished'] },
    },
    { parents: 'gospel:0.6 rnb:0.4', aliases: ['urban gospel'] },
  ),
  soul(
    'southern-gospel',
    'Southern gospel',
    'Quartet harmonies over country-tinged piano and steady two-beat',
    {
      modes: md('major:1'),
      rhythm: { drumStyle: 'country' },
      instruments: {
        add: [
          add('backing-vocal', 'vocal', 1, 'harmony', true),
          add('acoustic-guitar', 'rhythm-guitar', 0.6, 'accompaniment'),
        ],
      },
      macros: { harmonicTension: -0.1 },
      production: { keywords: ['southern gospel', 'quartet', 'harmonies'] },
    },
    { parents: 'gospel:0.6 country:0.4' },
  ),
  soul(
    'worship',
    'Worship',
    'Modern praise and worship: ambient guitars, swelling pads, anthemic congregational choruses',
    {
      tempo: tp(68, 84, 74),
      modes: md('major:0.9'),
      rhythm: { drumStyle: 'pop', halfTimeChance: 0.3 },
      instruments: {
        add: [
          add('synth-pad', 'synth-pad', 0.8, 'pad'),
          add('electric-guitar-clean', 'lead-guitar', 0.6, 'counter-melody'),
          add('piano', 'keys', 0.8, 'accompaniment'),
        ],
      },
      macros: { dynamics: 0.25 },
      production: { keywords: ['worship', 'praise', 'ccm', 'anthemic'], reverb: 0.5 },
    },
    { parents: 'pop:0.5 gospel:0.5', aliases: ['praise and worship', 'ccm', 'christian contemporary'] },
  ),
  // --- Jazz & blues --------------------------------------------------------------------------------
  jazz(
    'bebop',
    'Bebop',
    'Fast, virtuosic small-group jazz: rhythm changes, dense ii–V lines, horn heads',
    {
      tempo: tp(180, 280, 220),
      harmony: { harmonicRhythm: 2, progressions: [pr('Imaj7 vi7 ii7 V7', 2), pr('iii7 VI7 ii7 V7', 1.5)] },
      instruments: {
        add: [add('saxophone', 'custom', 1, 'melody', true), add('trumpet', 'custom', 0.7, 'counter-melody')],
      },
      macros: { complexity: 0.25, melodicMovement: 0.2 },
      production: { keywords: ['bebop', 'virtuosic', 'small combo'] },
    },
    { parents: 'jazz:1', aliases: ['bop', 'hard bop'] },
  ),
  jazz(
    'cool-jazz',
    'Cool jazz',
    'Relaxed, airy West Coast jazz with soft tones and gentle swing',
    {
      tempo: tp(100, 150, 124),
      rhythm: { swing: 0.55 },
      instruments: {
        add: [add('trumpet', 'custom', 0.8, 'melody'), add('saxophone', 'custom', 0.5, 'counter-melody')],
      },
      macros: { energy: -0.2, dynamics: -0.1 },
      production: { keywords: ['cool jazz', 'west coast jazz', 'airy'] },
    },
    { parents: 'jazz:1' },
  ),
  jazz(
    'modal-jazz',
    'Modal jazz',
    'Long stretches on one mode: dorian vamps, quartal voicings, spacious solos',
    {
      modes: md('dorian:1 lydian:0.3'),
      harmony: { harmonicRhythm: 0.25, progressions: [pr('i7', 2), pr('i7 bII7', 1)] },
      macros: { repetition: -0.15, complexity: 0.1 },
      production: { keywords: ['modal jazz', 'dorian', 'spacious'] },
    },
    { parents: 'jazz:1', aliases: ['modal vamp'] },
  ),
  jazz(
    'smooth-jazz',
    'Smooth jazz',
    'Polished, radio-friendly jazz-pop: soprano sax, Rhodes, gentle backbeat',
    {
      tempo: tp(80, 110, 94),
      rhythm: { drumStyle: 'rnb', swing: 0.1 },
      instruments: {
        add: [
          add('saxophone', 'custom', 1, 'melody', true),
          add('electric-piano', 'keys', 0.9, 'accompaniment'),
        ],
        remove: ['upright-bass'],
      },
      macros: { energy: -0.15, complexity: -0.15 },
      production: { keywords: ['smooth jazz', 'polished', 'soprano sax'] },
    },
    { parents: 'jazz:0.6 rnb:0.4', aliases: ['smooth jazz'] },
  ),
  jazz(
    'jazz-fusion',
    'Jazz fusion',
    'Electric jazz-rock: odd meters, virtuoso solos, synths and slap bass',
    {
      meters: [m78],
      rhythm: { drumStyle: 'funk', swing: 0 },
      instruments: {
        add: [
          add('synth-lead', 'synth-lead', 0.6, 'solo'),
          add('electric-guitar-lead', 'lead-guitar', 0.7, 'solo'),
          add('electric-bass', 'bass', 1, 'bass-line', true),
        ],
        remove: ['upright-bass'],
      },
      macros: { complexity: 0.25 },
      production: { keywords: ['fusion', 'jazz-rock', 'virtuosic'] },
    },
    { parents: 'jazz:0.6 funk:0.2 rock:0.2', aliases: ['fusion', 'jazz rock'] },
  ),
  jazz(
    'big-band',
    'Big band swing',
    'Swing-era orchestra: riffing saxes and brass sections, walking bass, shout choruses',
    {
      tempo: tp(130, 220, 168),
      rhythm: { swing: 0.66 },
      instruments: {
        add: [
          add('brass-section', 'custom', 1, 'harmony', true),
          add('trombone', 'custom', 0.6, 'counter-melody'),
          add('saxophone', 'custom', 0.7, 'counter-melody'),
        ],
      },
      macros: { dynamics: 0.15, density: 0.15 },
      production: { keywords: ['big band', 'swing era', 'brass section', 'shout chorus'] },
    },
    { parents: 'jazz:1', aliases: ['swing music', 'swing era', 'big band'] },
  ),
  jazz(
    'latin-jazz',
    'Latin jazz',
    'Jazz harmony over Afro-Cuban clave grooves, congas and montunos',
    {
      rhythm: { drumStyle: 'salsa', swing: 0, compStyle: 'montuno', bassStyle: 'tumbao' },
      instruments: { add: [add('percussion', 'percussion', 0.9, 'rhythm')] },
      macros: { syncopation: 0.2 },
      production: { keywords: ['latin jazz', 'afro-cuban', 'clave', 'congas'] },
    },
    { parents: 'jazz:0.6 salsa:0.4', aliases: ['afro-cuban jazz'] },
  ),
  jazz(
    'gypsy-jazz',
    'Gypsy jazz',
    'Hot-club swing: driving acoustic "la pompe" rhythm guitar, violin and virtuoso leads',
    {
      tempo: tp(160, 240, 200),
      modes: md('minor:0.5 harmonic-minor:0.3'),
      rhythm: { swing: 0.5, drumStyle: 'jazz-swing', compStyle: 'chop' },
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 1, 'accompaniment', true),
          add('violin', 'strings', 0.8, 'counter-melody'),
        ],
        remove: ['drum-kit', 'piano', 'saxophone'],
      },
      macros: { complexity: 0.15 },
      production: { keywords: ['gypsy jazz', 'manouche', 'hot club', 'la pompe'] },
    },
    { parents: 'jazz:1', aliases: ['jazz manouche', 'manouche', 'hot club'] },
  ),
  jazz(
    'acid-jazz',
    'Acid jazz',
    'Groovy jazz-funk with breakbeats, Hammond organ and horns',
    {
      tempo: tp(96, 116, 106),
      rhythm: { drumStyle: 'funk', swing: 0.15, bassStyle: 'funk' },
      instruments: {
        add: [add('organ', 'keys', 0.8, 'accompaniment'), add('brass-section', 'custom', 0.5, 'hook')],
      },
      macros: { syncopation: 0.15 },
      production: { keywords: ['acid jazz', 'jazz-funk', 'hammond', 'groovy'] },
    },
    { parents: 'jazz:0.5 funk:0.5', aliases: ['jazz funk', 'jazz-funk'] },
  ),
  jazz(
    'free-jazz',
    'Free jazz',
    'Unbound improvisation: dissonance, shifting time, collective blowing',
    {
      harmony: { borrowedChordRate: 0.6, extensionRate: 1 },
      macros: { harmonicTension: 0.4, complexity: 0.35, repetition: 0.4 },
      production: { keywords: ['free jazz', 'avant-garde', 'dissonant', 'collective improvisation'] },
    },
    { parents: 'jazz:1', aliases: ['avant-garde jazz'] },
  ),
  jazz(
    'vocal-jazz',
    'Vocal jazz',
    'Standards sung by a crooner over piano trio: ballads and medium swing',
    {
      tempo: tp(70, 140, 108),
      instruments: { add: [add('lead-vocal', 'vocal', 1, 'melody', true)], remove: ['trumpet'] },
      macros: { melodicMovement: 0.1 },
      production: { keywords: ['vocal jazz', 'standards', 'crooner', 'piano trio'] },
    },
    { parents: 'jazz:1', aliases: ['jazz standards', 'jazz vocals'] },
  ),
  jazz(
    'dixieland',
    'Dixieland',
    'New Orleans trad jazz: two-beat feel, collective polyphony of trumpet, clarinet and trombone',
    {
      tempo: tp(160, 220, 190),
      modes: md('major:1'),
      rhythm: { swing: 0.6 },
      harmony: { progressions: [pr('I VI7 II7 V7', 2)] },
      instruments: {
        add: [
          add('trumpet', 'custom', 1, 'melody', true),
          add('clarinet', 'custom', 0.8, 'counter-melody'),
          add('trombone', 'custom', 0.7, 'counter-melody'),
        ],
      },
      production: { keywords: ['dixieland', 'new orleans jazz', 'trad jazz', 'second line'] },
      macros: { humanization: 0.15 },
    },
    { parents: 'jazz:1', aliases: ['new orleans jazz', 'trad jazz', 'second line'] },
  ),
  jazz(
    'ragtime',
    'Ragtime',
    'Syncopated stride piano: oom-pah left hand, ragged right-hand melodies',
    {
      tempo: tp(90, 130, 108),
      modes: md('major:1'),
      meters: [{ numerator: 2, denominator: 4, weight: 1 }],
      harmony: { progressions: [pr('I VI7 II7 V7', 2)] },
      instruments: { add: [add('piano', 'keys', 1, 'melody', true)], remove: ['saxophone', 'trumpet'] },
      macros: { syncopation: 0.25 },
      production: { keywords: ['ragtime', 'stride piano', 'honky-tonk'] },
    },
    { parents: 'jazz:1', aliases: ['stride', 'stride piano'] },
  ),
  jazz(
    'delta-blues',
    'Delta blues',
    'Raw acoustic slide guitar and voice, free-flowing time, deep moans',
    {
      tempo: tp(64, 100, 80),
      rhythm: { drumStyle: 'folk' },
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 1, 'accompaniment', true),
          add('harmonica', 'custom', 0.5, 'counter-melody'),
        ],
        remove: ['drum-kit', 'electric-bass', 'piano', 'electric-guitar-clean'],
      },
      macros: { humanization: 0.3, density: -0.2 },
      production: { keywords: ['delta blues', 'slide guitar', 'acoustic', 'raw'], reverb: 0.2 },
    },
    { parents: 'blues:0.7 folk:0.3', aliases: ['country blues', 'acoustic blues'] },
  ),
  jazz(
    'chicago-blues',
    'Chicago blues',
    'Electric band blues: amplified harmonica, piano, shuffling rhythm section',
    {
      instruments: {
        add: [
          add('harmonica', 'custom', 0.9, 'counter-melody', true),
          add('piano', 'keys', 0.7, 'accompaniment'),
        ],
      },
      macros: { energy: 0.1 },
      production: { keywords: ['chicago blues', 'electric blues', 'amplified harp'] },
    },
    { parents: 'blues:1', aliases: ['electric blues'] },
  ),
  jazz(
    'jump-blues',
    'Jump blues',
    'Uptempo jumping R&B with honking sax, horn riffs and boogie bass',
    {
      tempo: tp(150, 200, 172),
      rhythm: { swing: 0.6 },
      instruments: {
        add: [add('saxophone', 'custom', 0.9, 'counter-melody'), add('brass-section', 'custom', 0.6, 'hook')],
      },
      macros: { energy: 0.2 },
      production: { keywords: ['jump blues', 'honking sax', '40s'] },
    },
    { parents: 'blues:0.6 jazz:0.4' },
  ),
  jazz(
    'boogie-woogie',
    'Boogie-woogie',
    'Rolling eighth-note piano bass figures under bluesy right-hand riffs',
    {
      tempo: tp(140, 190, 164),
      rhythm: { swing: 0.6, bassStyle: 'boogie', compStyle: 'boogie' },
      instruments: { add: [add('piano', 'keys', 1, 'melody', true)] },
      macros: { energy: 0.15 },
      production: { keywords: ['boogie-woogie', 'piano', 'rolling bass'] },
    },
    { parents: 'blues:0.6 jazz:0.4', aliases: ['boogie woogie'] },
  ),
  jazz(
    'desert-blues',
    'Desert blues',
    'Tuareg guitar trance: hypnotic modal riffs, handclaps and rolling grooves',
    {
      modes: md('dorian:0.4 minor:0.4'),
      meters: [{ numerator: 6, denominator: 8, weight: 0.5 }],
      harmony: { harmonicRhythm: 0.25, progressions: [pr('i', 2), pr('i VII', 1)] },
      instruments: {
        add: [
          add('electric-guitar-clean', 'lead-guitar', 1, 'counter-melody', true),
          add('percussion', 'percussion', 0.8, 'rhythm'),
        ],
      },
      macros: { repetition: -0.25 },
      production: { keywords: ['desert blues', 'tuareg', 'assouf', 'hypnotic'] },
    },
    { parents: 'blues:0.6 afrobeats:0.4', aliases: ['tuareg', 'assouf'] },
  ),
  jazz(
    'ethio-jazz',
    'Ethio-jazz',
    'Ethiopian pentatonic modes over jazz-funk grooves with vibraphone and horns',
    {
      modes: md('minor:0.5 phrygian:0.3'),
      instruments: {
        add: [
          add('marimba', 'keys', 0.8, 'melody'),
          add('brass-section', 'custom', 0.6, 'hook'),
          add('organ', 'keys', 0.5, 'pad'),
        ],
      },
      rhythm: { drumStyle: 'funk' },
      macros: { repetition: -0.1 },
      production: { keywords: ['ethio-jazz', 'vibraphone', 'pentatonic', 'addis'] },
    },
    { parents: 'jazz:0.5 funk:0.5', aliases: ['ethiojazz', 'ethiopian jazz'] },
  ),
];

const ROOTS_TAGS: StyleTag[] = [
  roots(
    'americana',
    'Americana',
    'Roots-rock storytelling: acoustic and electric guitars, pedal steel, harmonica, warm room',
    {
      tempo: tp(76, 124, 98),
      modes: md('major:0.6 mixolydian:0.2'),
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 0.9, 'accompaniment'),
          add('pedal-steel', 'lead-guitar', 0.5, 'counter-melody'),
          add('harmonica', 'custom', 0.3, 'counter-melody'),
        ],
      },
      macros: { humanization: 0.2 },
      production: { keywords: ['americana', 'roots', 'warm', 'storytelling'] },
    },
    { parents: 'folk:0.5 country:0.5', aliases: ['roots rock', 'roots music'] },
  ),
  roots(
    'outlaw-country',
    'Outlaw country',
    '70s rebel country: twangy Telecasters, loose shuffles, baritone swagger',
    {
      tempo: tp(90, 130, 108),
      rhythm: { swing: 0.2 },
      instruments: {
        add: [
          add('electric-guitar-clean', 'lead-guitar', 0.8, 'counter-melody'),
          add('pedal-steel', 'lead-guitar', 0.4, 'counter-melody'),
        ],
        remove: ['synth-pad', 'string-ensemble'],
      },
      macros: { humanization: 0.2, complexity: -0.1 },
      production: { keywords: ['outlaw country', '70s', 'twang', 'rebel'] },
    },
    { parents: 'country:1', aliases: ['outlaw'] },
  ),
  roots(
    'bro-country',
    'Bro-country',
    '2010s arena country: hip-hop drum loops, big guitars, party hooks',
    {
      tempo: tp(80, 112, 96),
      rhythm: { drumStyle: 'hip-hop', syncopation: 0.5 },
      instruments: {
        add: [
          add('electric-guitar-distorted', 'rhythm-guitar', 0.7, 'rhythm'),
          add('electronic-kit', 'drums', 0.6, 'rhythm'),
        ],
      },
      macros: { humanization: -0.15, energy: 0.1 },
      production: { keywords: ['bro-country', 'party', 'polished', 'trap hats'] },
    },
    { parents: 'country:0.7 pop:0.3', aliases: ['bro country', 'country rap', 'hick hop'] },
  ),
  roots(
    'country-pop',
    'Country pop',
    'Glossy crossover country: pop hooks, acoustic strums and big choruses',
    {
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 0.9, 'accompaniment'),
          add('synth-pad', 'synth-pad', 0.3, 'pad'),
        ],
      },
      macros: { humanization: -0.15 },
      production: { keywords: ['country pop', 'crossover', 'polished'] },
      rhythm: { drumStyle: 'pop' },
    },
    { parents: 'country:0.6 pop:0.4', aliases: ['pop country'] },
  ),
  roots(
    'honky-tonk',
    'Honky-tonk',
    'Barroom country: two-step shuffle, crying fiddle and pedal steel, piano rolls',
    {
      tempo: tp(110, 160, 132),
      rhythm: { swing: 0.35, subdivision: 12 },
      instruments: {
        add: [
          add('pedal-steel', 'lead-guitar', 0.8, 'counter-melody'),
          add('piano', 'keys', 0.7, 'accompaniment'),
          add('violin', 'strings', 0.7, 'counter-melody'),
        ],
      },
      production: { keywords: ['honky-tonk', 'two-step', 'barroom', 'pedal steel'] },
      macros: { humanization: 0.15 },
    },
    { parents: 'country:1', aliases: ['honky tonk', 'two-step', 'texas two step'] },
  ),
  roots(
    'western-swing',
    'Western swing',
    'Swinging country dance band: fiddles, steel guitar and jazz chords',
    {
      tempo: tp(130, 190, 160),
      rhythm: { swing: 0.6, drumStyle: 'jazz-swing' },
      harmony: { extensionRate: 0.6 },
      instruments: {
        add: [
          add('violin', 'strings', 1, 'melody', true),
          add('pedal-steel', 'lead-guitar', 0.7, 'counter-melody'),
        ],
      },
      production: { keywords: ['western swing', 'fiddle', 'steel guitar', 'dancehall'] },
      macros: { complexity: 0.1 },
    },
    { parents: 'country:0.6 jazz:0.4' },
  ),
  roots(
    'cowboy',
    'Cowboy / western',
    'Wide-open western ballads: galloping rhythm, campfire guitar, lonesome whistle',
    {
      tempo: tp(90, 130, 108),
      meters: [m34],
      modes: md('major:0.6'),
      rhythm: { drumStyle: 'country', compStyle: 'boogie' },
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 1, 'accompaniment', true),
          add('harmonica', 'custom', 0.5, 'counter-melody'),
        ],
      },
      production: { keywords: ['cowboy', 'western', 'campfire', 'gallop'], reverb: 0.4 },
      macros: { humanization: 0.2 },
    },
    { parents: 'country:0.7 folk:0.3', aliases: ['western', 'country western'] },
  ),
  roots(
    'folk-rock',
    'Folk rock',
    'Folk songs with an electric band: jangly guitars, harmonies, steady backbeat',
    {
      rhythm: { drumStyle: 'rock' },
      instruments: {
        add: [
          add('electric-guitar-clean', 'rhythm-guitar', 0.8, 'accompaniment'),
          add('electric-bass', 'bass', 1, 'bass-line', true),
        ],
      },
      macros: { energy: 0.1 },
      production: { keywords: ['folk rock', 'jangly', '60s', 'harmonies'] },
    },
    { parents: 'folk:0.6 rock:0.4' },
  ),
  roots(
    'folk-pop',
    'Folk-pop',
    'Bright acoustic pop with stomps, claps and singalong "hey"s',
    {
      modes: md('major:0.7'),
      instruments: {
        add: [add('percussion', 'percussion', 0.7, 'rhythm'), add('backing-vocal', 'vocal', 0.6, 'harmony')],
      },
      macros: { energy: 0.1 },
      production: { keywords: ['folk pop', 'stomp clap', 'singalong'] },
    },
    { parents: 'folk:0.5 pop:0.5', aliases: ['stomp and holler'] },
  ),
  roots(
    'neofolk',
    'Neofolk',
    'Dark, martial acoustic folk with drones and ritual percussion',
    {
      modes: md('minor:0.6 dorian:0.3'),
      rhythm: { drumStyle: 'celtic' },
      instruments: { add: [add('cello', 'strings', 0.5, 'counter-melody')] },
      macros: { energy: -0.1, harmonicTension: 0.1 },
      production: { keywords: ['neofolk', 'dark folk', 'martial', 'ritual'], reverb: 0.45 },
    },
    { parents: 'folk:1', aliases: ['dark folk'] },
  ),
  roots(
    'appalachian-folk',
    'Appalachian folk',
    'Old mountain ballads: modal melodies, banjo and fiddle, lonesome harmony',
    {
      modes: md('dorian:0.4 mixolydian:0.3'),
      instruments: {
        add: [
          add('banjo', 'rhythm-guitar', 0.8, 'accompaniment'),
          add('violin', 'strings', 0.8, 'counter-melody'),
        ],
      },
      macros: { humanization: 0.2, density: -0.1 },
      production: { keywords: ['appalachian', 'old-time', 'mountain music', 'modal'] },
    },
    { parents: 'folk:0.6 bluegrass:0.4', aliases: ['old-time', 'old time', 'mountain music'] },
  ),
  roots(
    'newgrass',
    'Newgrass',
    'Progressive bluegrass: jazz and rock harmony, extended jams on acoustic strings',
    {
      harmony: { extensionRate: 0.4, borrowedChordRate: 0.2 },
      macros: { complexity: 0.25 },
      production: { keywords: ['newgrass', 'progressive bluegrass', 'virtuosic'] },
    },
    { parents: 'bluegrass:1', aliases: ['progressive bluegrass'] },
  ),
  roots(
    'zydeco',
    'Zydeco',
    'Louisiana Creole dance music: accordion, rubboard and a syncopated two-step',
    {
      tempo: tp(110, 150, 128),
      modes: md('major:0.7'),
      rhythm: { drumStyle: 'country', swing: 0.2 },
      instruments: {
        add: [
          add('accordion', 'keys', 1, 'counter-melody', true),
          add('percussion', 'percussion', 0.8, 'rhythm'),
        ],
      },
      production: { keywords: ['zydeco', 'accordion', 'rubboard', 'louisiana'] },
      macros: { syncopation: 0.1 },
    },
    { parents: 'folk:0.5 blues:0.5', aliases: ['cajun'] },
  ),
  roots(
    'tejano',
    'Tejano / norteño',
    'Texas-Mexican polka-cumbia: button accordion, bajo sexto, bouncy two-beat',
    {
      tempo: tp(100, 150, 124),
      rhythm: { drumStyle: 'cumbia', compStyle: 'stabs' },
      instruments: {
        add: [
          add('accordion', 'keys', 1, 'counter-melody', true),
          add('acoustic-guitar', 'rhythm-guitar', 0.6, 'accompaniment'),
        ],
      },
      production: { keywords: ['tejano', 'norteño', 'button accordion', 'bajo sexto'] },
      macros: { energy: 0.1 },
    },
    { parents: 'cumbia:0.6 country:0.4', aliases: ['norteño', 'norteno', 'tex-mex', 'regional mexican'] },
  ),
  roots(
    'polka',
    'Polka',
    'Oom-pah two-beat dance: accordion, tuba-like bass on 1 and 3, chords on the off-beats',
    {
      tempo: tp(110, 140, 124),
      meters: [{ numerator: 2, denominator: 4, weight: 2 }],
      modes: md('major:1'),
      rhythm: { drumStyle: 'ska', bassStyle: 'root-fifth', compStyle: 'stabs' },
      instruments: {
        add: [
          add('accordion', 'keys', 1, 'melody', true),
          add('clarinet', 'custom', 0.5, 'counter-melody'),
          add('brass-section', 'custom', 0.5, 'harmony'),
        ],
      },
      production: { keywords: ['polka', 'oom-pah', 'accordion', 'beer hall'] },
      macros: { complexity: -0.15 },
    },
    { parents: 'folk:1', aliases: ['oom-pah', 'oompah'] },
  ),
  roots(
    'sea-shanty',
    'Sea shanty',
    'Call-and-response work songs: stomping 6/8, gang choruses, squeezebox',
    {
      tempo: tp(90, 120, 104),
      meters: [m68],
      modes: md('dorian:0.4 minor:0.3'),
      rhythm: { drumStyle: 'celtic' },
      instruments: {
        add: [
          add('backing-vocal', 'vocal', 1, 'harmony', true),
          add('accordion', 'keys', 0.6, 'accompaniment'),
          add('percussion', 'percussion', 0.6, 'rhythm'),
        ],
        remove: ['synth-pad', 'electric-guitar-clean'],
      },
      macros: { melodicMovement: -0.1, complexity: -0.2 },
      production: { keywords: ['sea shanty', 'work song', 'gang vocals', 'stomping'] },
    },
    { parents: 'folk:0.5 celtic:0.5', aliases: ['shanty', 'sea shanties', 'shanties'] },
  ),
  roots(
    'nordic-folk',
    'Nordic folk',
    'Scandinavian folk: droning fiddles, minor modes, ritual drums and kulning',
    {
      modes: md('minor:0.4 dorian:0.4'),
      rhythm: { drumStyle: 'celtic' },
      instruments: {
        add: [add('violin', 'strings', 0.9, 'counter-melody'), add('choir', 'vocal', 0.3, 'pad')],
      },
      macros: { repetition: -0.1 },
      production: { keywords: ['nordic folk', 'scandinavian', 'drone', 'viking'], reverb: 0.5 },
    },
    { parents: 'folk:0.6 celtic:0.4', aliases: ['scandinavian folk', 'viking folk'] },
  ),
  roots(
    'chanson',
    'Chanson',
    'French cabaret song: accordion waltzes, wry lyrics, intimate piano',
    {
      meters: [m34],
      modes: md('minor:0.4'),
      instruments: {
        add: [
          add('accordion', 'keys', 0.9, 'accompaniment', true),
          add('upright-bass', 'bass', 0.6, 'bass-line'),
        ],
        remove: ['electronic-kit', 'synth-pad'],
      },
      macros: { energy: -0.1 },
      production: { keywords: ['chanson', 'french', 'cabaret', 'accordion'] },
    },
    { parents: 'singer-songwriter:0.6 folk:0.4', aliases: ['french chanson', 'cabaret', 'musette'] },
  ),
  roots(
    'fado',
    'Fado',
    'Portuguese saudade: mournful voice over Portuguese guitar and nylon guitar',
    {
      tempo: tp(60, 96, 76),
      modes: md('harmonic-minor:0.4 minor:0.5'),
      rhythm: { compStyle: 'arpeggio' },
      instruments: {
        add: [
          add('nylon-guitar', 'rhythm-guitar', 1, 'accompaniment', true),
          add('mandolin', 'rhythm-guitar', 0.6, 'counter-melody'),
        ],
        remove: DRUM_KITS,
      },
      macros: { energy: -0.2, dynamics: 0.15 },
      production: { keywords: ['fado', 'saudade', 'portuguese guitar', 'lisbon'] },
    },
    { parents: 'singer-songwriter:0.5 flamenco:0.5' },
  ),
  // --- Latin ---------------------------------------------------------------------------------------
  latin(
    'bachata',
    'Bachata',
    'Dominican romance: chiming requinto guitar arpeggios, bongó and güira, syncopated bass',
    {
      tempo: tp(120, 140, 128),
      modes: md('minor:0.6'),
      rhythm: { drumStyle: 'cumbia', compStyle: 'arpeggio', bassStyle: 'reggae' },
      instruments: {
        add: [
          add('nylon-guitar', 'lead-guitar', 1, 'counter-melody', true),
          add('percussion', 'percussion', 0.9, 'rhythm'),
        ],
      },
      production: { keywords: ['bachata', 'requinto', 'romantic', 'güira'] },
      macros: { syncopation: 0.1 },
    },
    { parents: 'latin-pop:0.6 cumbia:0.4' },
  ),
  latin(
    'merengue',
    'Merengue',
    'Fast Dominican two-beat: tambora, güira and saxophone/accordion riffs',
    {
      tempo: tp(140, 170, 156),
      meters: [{ numerator: 2, denominator: 4, weight: 1 }],
      rhythm: { drumStyle: 'cumbia', compStyle: 'stabs' },
      instruments: {
        add: [
          add('saxophone', 'custom', 0.7, 'hook'),
          add('accordion', 'keys', 0.5, 'counter-melody'),
          add('percussion', 'percussion', 0.9, 'rhythm'),
        ],
      },
      macros: { energy: 0.2 },
      production: { keywords: ['merengue', 'tambora', 'güira', 'dominican'] },
    },
    { parents: 'cumbia:0.5 salsa:0.5' },
  ),
  latin(
    'mambo',
    'Mambo',
    '1950s big-band mambo: brass riffs, piano montuno and syncopated horn hits',
    {
      tempo: tp(170, 210, 190),
      instruments: {
        add: [
          add('brass-section', 'custom', 1, 'hook', true),
          add('saxophone', 'custom', 0.6, 'counter-melody'),
        ],
      },
      macros: { energy: 0.1 },
      production: { keywords: ['mambo', 'big band', 'brass riffs', 'havana'] },
    },
    { parents: 'salsa:1' },
  ),
  latin(
    'cha-cha-cha',
    'Cha-cha-chá',
    'Elegant mid-tempo Cuban dance: güiro on the beats, "one-two-cha-cha-cha" bass',
    {
      tempo: tp(112, 128, 120),
      rhythm: { drumStyle: 'cumbia' },
      instruments: {
        add: [add('flute', 'custom', 0.7, 'melody'), add('violin', 'strings', 0.6, 'counter-melody')],
      },
      macros: { energy: -0.1 },
      production: { keywords: ['cha-cha-cha', 'charanga', 'flute and violins'] },
    },
    { parents: 'salsa:1', aliases: ['cha cha', 'chachacha', 'charanga'] },
  ),
  latin(
    'bolero',
    'Bolero',
    'Slow Latin romance in 4/4: soft guitars, strings, gentle bongó',
    {
      tempo: tp(64, 88, 76),
      modes: md('minor:0.5'),
      harmony: { extensionRate: 0.6 },
      rhythm: { drumStyle: 'bossa-nova', compStyle: 'arpeggio' },
      instruments: {
        add: [
          add('nylon-guitar', 'rhythm-guitar', 0.9, 'accompaniment'),
          add('string-ensemble', 'strings', 0.6, 'pad'),
        ],
      },
      macros: { energy: -0.25 },
      energyShift: -8,
      production: { keywords: ['bolero', 'romantic', 'trio', 'serenata'] },
    },
    { parents: 'latin-pop:0.6 bossa-nova:0.4' },
  ),
  latin(
    'son-cubano',
    'Son cubano',
    'Rootsy Cuban son: tres guitar, bongó, maracas and call-and-response coro',
    {
      tempo: tp(100, 150, 124),
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 0.8, 'accompaniment'),
          add('trumpet', 'custom', 0.6, 'counter-melody'),
        ],
        remove: ['brass-section', 'drum-kit'],
      },
      macros: { humanization: 0.2, energy: -0.1 },
      production: { keywords: ['son cubano', 'tres', 'buena vista', 'havana'] },
    },
    { parents: 'salsa:1', aliases: ['cuban son', 'trova'] },
  ),
  latin(
    'timba',
    'Timba',
    'Modern Cuban salsa: aggressive bass, funk-influenced drums, gear changes',
    {
      tempo: tp(180, 215, 198),
      rhythm: { drumStyle: 'funk', bassStyle: 'funk' },
      macros: { energy: 0.2, complexity: 0.15 },
      production: { keywords: ['timba', 'cuban', 'funky', 'aggressive'] },
    },
    { parents: 'salsa:0.7 funk:0.3' },
  ),
  latin(
    'mpb',
    'MPB',
    'Brazilian popular music: sophisticated bossa-derived harmony with pop and folk colours',
    {
      harmony: { extensionRate: 0.8 },
      rhythm: { compStyle: 'bossa' },
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 0.6, 'accompaniment'),
          add('string-ensemble', 'strings', 0.3, 'pad'),
        ],
      },
      macros: { complexity: 0.1, energy: 0.05 },
      production: { keywords: ['mpb', 'brazilian', 'tropicália'] },
    },
    { parents: 'bossa-nova:0.6 pop:0.4', aliases: ['música popular brasileira', 'tropicalia', 'tropicália'] },
  ),
  latin(
    'forro',
    'Forró',
    'Northeast Brazilian dance music: accordion, zabumba drum and triangle',
    {
      tempo: tp(110, 150, 128),
      rhythm: { drumStyle: 'samba', compStyle: 'stabs' },
      instruments: {
        add: [add('accordion', 'keys', 1, 'melody', true), add('percussion', 'percussion', 0.9, 'rhythm')],
      },
      production: { keywords: ['forró', 'zabumba', 'triangle', 'accordion'] },
      macros: { energy: 0.1 },
    },
    { parents: 'samba:0.6 cumbia:0.4', aliases: ['forró', 'baião'] },
  ),
  latin(
    'sertanejo',
    'Sertanejo',
    'Brazilian country-pop: duet harmonies, accordion and acoustic guitar',
    {
      instruments: {
        add: [
          add('accordion', 'keys', 0.6, 'counter-melody'),
          add('acoustic-guitar', 'rhythm-guitar', 0.9, 'accompaniment'),
          add('backing-vocal', 'vocal', 0.8, 'harmony'),
        ],
      },
      macros: { melodicMovement: 0.1 },
      production: { keywords: ['sertanejo', 'brazilian country', 'duet harmonies'] },
    },
    { parents: 'country:0.5 latin-pop:0.5' },
  ),
  latin(
    'tango',
    'Tango',
    'Argentine tango: bandoneon, marcato four-beat, dramatic minor harmony and string staccatos',
    {
      tempo: tp(110, 130, 118),
      modes: md('harmonic-minor:0.5 minor:0.4'),
      rhythm: { drumStyle: 'flamenco', compStyle: 'chop', bassStyle: 'root-fifth' },
      harmony: { progressions: [pr('i iv V i', 2), pr('i VI V7 i', 1)] },
      instruments: {
        add: [
          add('accordion', 'keys', 1, 'melody', true),
          add('violin', 'strings', 0.8, 'counter-melody'),
          add('piano', 'keys', 0.7, 'accompaniment'),
          add('upright-bass', 'bass', 0.8, 'bass-line'),
        ],
        remove: DRUM_KITS,
      },
      macros: { dynamics: 0.2 },
      production: { keywords: ['tango', 'bandoneon', 'buenos aires', 'dramatic'] },
    },
    { parents: 'flamenco:0.5 orchestral:0.5', aliases: ['tango nuevo', 'argentine tango'] },
  ),
  latin(
    'vallenato',
    'Vallenato',
    'Colombian accordion music: caja, guacharaca and storytelling vocals',
    {
      instruments: { add: [add('accordion', 'keys', 1, 'counter-melody', true)] },
      macros: { melodicMovement: 0.1 },
      production: { keywords: ['vallenato', 'accordion', 'colombian'] },
      rhythm: { syncopation: 0.6 },
    },
    { parents: 'cumbia:1' },
  ),
  latin(
    'mariachi',
    'Mariachi',
    'Mexican mariachi: trumpets, violins, vihuela and guitarrón in 3/4 and 6/8',
    {
      meters: [m34, m68],
      modes: md('major:0.7'),
      rhythm: { drumStyle: 'country', compStyle: 'chop', bassStyle: 'root-fifth' },
      instruments: {
        add: [
          add('trumpet', 'custom', 1, 'counter-melody', true),
          add('violin', 'strings', 0.9, 'counter-melody'),
          add('acoustic-guitar', 'rhythm-guitar', 0.9, 'accompaniment'),
        ],
        remove: DRUM_KITS,
      },
      production: { keywords: ['mariachi', 'trumpets', 'vihuela', 'ranchera'] },
      macros: { dynamics: 0.15 },
    },
    { parents: 'latin-pop:0.5 folk:0.5', aliases: ['ranchera', 'son jarocho'] },
  ),
  latin(
    'corridos-tumbados',
    'Corridos tumbados',
    'Regional Mexican guitars and tuba meet trap swagger',
    {
      rhythm: { compStyle: 'roll' },
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 1, 'accompaniment', true),
          add('nylon-guitar', 'lead-guitar', 0.8, 'counter-melody'),
        ],
      },
      macros: { syncopation: 0.1 },
      production: { keywords: ['corridos tumbados', 'regional mexican', 'requinto', 'tuba'] },
    },
    { parents: 'latin-pop:0.5 trap:0.5', aliases: ['corridos', 'sad sierreño', 'banda'] },
  ),
  latin(
    'dembow-dominicano',
    'Dominican dembow',
    'Frenetic, minimal Dominican dembow: fast drum loops, chanted hooks',
    {
      tempo: tp(115, 130, 122),
      rhythm: { drumStyle: 'dembow' },
      macros: { energy: 0.2, melodicMovement: -0.25, density: -0.1 },
      production: { keywords: ['dembow', 'dominican', 'chanted'] },
    },
    { parents: 'reggaeton:1', aliases: ['dominican dembow'] },
  ),
  // --- Caribbean -----------------------------------------------------------------------------------
  caribbean(
    'dancehall',
    'Dancehall',
    'Digital riddims with dembow-like drums, toasting MCs and booming bass',
    {
      tempo: tp(90, 110, 100),
      modes: md('minor:0.6'),
      rhythm: { drumStyle: 'dembow', compStyle: 'stabs' },
      instruments: {
        add: [
          add('electronic-kit', 'drums', 1, 'rhythm', true),
          add('synth-bass', 'bass', 1, 'bass-line', true),
        ],
        remove: ['drum-kit', 'electric-bass', 'organ'],
      },
      macros: { melodicMovement: -0.15 },
      production: { keywords: ['dancehall', 'riddim', 'toasting', 'digital'] },
    },
    { parents: 'reggae:0.5 reggaeton:0.5', aliases: ['ragga', 'raggamuffin'] },
  ),
  caribbean(
    'dub',
    'Dub',
    'Reggae deconstructed: bass and drums up front, everything else in and out on echo and reverb',
    {
      rhythm: { bassStyle: 'reggae' },
      instruments: { remove: ['lead-vocal', 'backing-vocal'] },
      macros: { density: -0.25, repetition: -0.2 },
      production: { keywords: ['dub', 'tape echo', 'spring reverb', 'sound system'], reverb: 0.65 },
    },
    { parents: 'reggae:1', aliases: ['dub reggae'] },
  ),
  caribbean(
    'rocksteady',
    'Rocksteady',
    'Late-60s Jamaican bridge between ska and reggae: slower skank, sweet harmonies',
    {
      tempo: tp(90, 112, 100),
      rhythm: { drumStyle: 'ska', compStyle: 'skank' },
      instruments: { add: [add('backing-vocal', 'vocal', 0.8, 'harmony')] },
      production: { keywords: ['rocksteady', '60s', 'sweet harmonies', 'jamaica'] },
      macros: { energy: -0.1 },
    },
    { parents: 'reggae:0.6 ska:0.4', aliases: ['rock steady'] },
  ),
  caribbean(
    'lovers-rock',
    'Lovers rock',
    'Romantic UK reggae: soft soul vocals, sweet chords, gentle one-drop',
    {
      harmony: { extensionRate: 0.5 },
      instruments: {
        add: [
          add('electric-piano', 'keys', 0.6, 'accompaniment'),
          add('backing-vocal', 'vocal', 0.6, 'harmony'),
        ],
      },
      macros: { energy: -0.15 },
      production: { keywords: ['lovers rock', 'romantic', 'sweet'] },
    },
    { parents: 'reggae:0.7 rnb:0.3' },
  ),
  caribbean(
    'roots-reggae',
    'Roots reggae',
    'Conscious 70s reggae: Nyabinghi drums, horn lines, minor modes and message songs',
    {
      modes: md('minor:0.4 dorian:0.3'),
      instruments: {
        add: [add('brass-section', 'custom', 0.6, 'hook'), add('percussion', 'percussion', 0.7, 'rhythm')],
      },
      production: { keywords: ['roots reggae', 'conscious', 'nyabinghi', 'rasta'] },
      macros: { humanization: 0.1 },
    },
    { parents: 'reggae:1', aliases: ['conscious reggae'] },
  ),
  caribbean(
    'steppers',
    'Steppers',
    'Four-on-the-floor reggae/dub: kick on every beat, militant drive',
    {
      rhythm: { drumStyle: 'four-on-floor', bassStyle: 'reggae' },
      macros: { energy: 0.15 },
      production: { keywords: ['steppers', 'militant', 'dub'] },
    },
    { parents: 'reggae:1', aliases: ['rockers'] },
  ),
  caribbean(
    'soca',
    'Soca',
    'Trinidadian carnival music: fast four-on-the-floor, brass, whistles and jump-and-wave chants',
    {
      tempo: tp(150, 165, 158),
      modes: md('major:0.7'),
      rhythm: { drumStyle: 'disco', bassStyle: 'offbeat' },
      instruments: {
        add: [
          add('brass-section', 'custom', 0.8, 'hook'),
          add('percussion', 'percussion', 0.9, 'rhythm'),
          add('steel-pan', 'keys', 0.4, 'hook'),
        ],
      },
      macros: { energy: 0.25 },
      energyShift: 6,
      production: { keywords: ['soca', 'carnival', 'trinidad', 'power soca'] },
    },
    { parents: 'reggae:0.5 edm:0.5', aliases: ['power soca'] },
  ),
  caribbean(
    'calypso',
    'Calypso',
    'Trinidadian topical song: steel pans, bouncy two-beat, wry lyrics',
    {
      tempo: tp(100, 130, 116),
      modes: md('major:0.9'),
      rhythm: { drumStyle: 'ska', compStyle: 'stabs' },
      instruments: {
        add: [
          add('steel-pan', 'keys', 1, 'hook', true),
          add('acoustic-guitar', 'rhythm-guitar', 0.6, 'accompaniment'),
        ],
      },
      production: { keywords: ['calypso', 'steel pan', 'trinidad', 'tropical'] },
      macros: { complexity: -0.1 },
    },
    { parents: 'reggae:0.5 folk:0.5', aliases: ['steelband', 'steel band'] },
  ),
  caribbean(
    'zouk',
    'Zouk',
    'French Antilles dance pop: syncopated tom grooves, lush synths and romance',
    {
      tempo: tp(80, 130, 104),
      rhythm: { drumStyle: 'afrobeats' },
      instruments: {
        add: [add('synth-pad', 'synth-pad', 0.7, 'pad'), add('percussion', 'percussion', 0.7, 'rhythm')],
      },
      production: { keywords: ['zouk', 'kizomba', 'antilles'] },
      macros: { syncopation: 0.1 },
    },
    { parents: 'latin-pop:0.5 afrobeats:0.5', aliases: ['kizomba', 'kompa'] },
  ),
  // --- African -------------------------------------------------------------------------------------
  african(
    'highlife',
    'Highlife',
    'Ghanaian/Nigerian guitar-band music: bright interlocking guitars and horns',
    {
      modes: md('major:0.8'),
      rhythm: { drumStyle: 'afrobeats', compStyle: 'highlife', swing: 0.1 },
      instruments: {
        add: [
          add('electric-guitar-clean', 'rhythm-guitar', 1, 'accompaniment', true),
          add('brass-section', 'custom', 0.6, 'hook'),
        ],
      },
      production: { keywords: ['highlife', 'palm-wine', 'interlocking guitars', 'horns'] },
      macros: { energy: 0.05 },
    },
    { parents: 'afrobeats:1', aliases: ['palm-wine', 'palm wine'] },
  ),
  african(
    'soukous',
    'Soukous',
    'Congolese rumba gone fast: cascading high guitar lines and the sebene dance break',
    {
      tempo: tp(130, 160, 146),
      modes: md('major:0.8'),
      rhythm: { drumStyle: 'afrobeats', compStyle: 'highlife' },
      instruments: { add: [add('electric-guitar-clean', 'lead-guitar', 1, 'counter-melody', true)] },
      macros: { energy: 0.2, melodicMovement: 0.15 },
      production: { keywords: ['soukous', 'congolese rumba', 'sebene', 'ndombolo'] },
    },
    { parents: 'afrobeats:1', aliases: ['congolese rumba', 'ndombolo'] },
  ),
  african(
    'alte',
    'Alté',
    'Nigerian alternative: genre-fluid, laid-back afro-R&B with indie textures',
    {
      harmony: { extensionRate: 0.7 },
      instruments: {
        add: [
          add('synth-pad', 'synth-pad', 0.6, 'pad'),
          add('electric-guitar-clean', 'rhythm-guitar', 0.5, 'accompaniment'),
        ],
      },
      macros: { energy: -0.15, density: -0.1 },
      production: { keywords: ['alté', 'alternative afro', 'laid back'] },
    },
    { parents: 'afrobeats:0.6 rnb:0.4', aliases: ['alte'] },
  ),
  african(
    'afro-soul',
    'Afro-soul',
    'Soulful African pop with acoustic guitars, warm keys and gospel harmonies',
    {
      harmony: { extensionRate: 0.6 },
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 0.7, 'accompaniment'),
          add('backing-vocal', 'vocal', 0.7, 'harmony'),
        ],
      },
      macros: { energy: -0.1 },
      production: { keywords: ['afro-soul', 'warm', 'soulful'] },
    },
    { parents: 'afrobeats:0.6 soul:0.4', aliases: ['afrosoul'] },
  ),
  // --- Asian ---------------------------------------------------------------------------------------
  asian(
    'qawwali',
    'Qawwali',
    'Sufi devotional music: harmonium drones, tabla, handclaps, rising call-and-response',
    {
      modes: md('harmonic-minor:0.4 phrygian:0.3'),
      rhythm: { drumStyle: 'bhangra' },
      instruments: {
        add: [
          add('accordion', 'keys', 0.9, 'accompaniment', true),
          add('percussion', 'percussion', 0.9, 'rhythm'),
          add('backing-vocal', 'vocal', 0.9, 'harmony'),
        ],
        remove: ['synth-pad', 'electric-bass'],
      },
      macros: { repetition: -0.2, dynamics: 0.2 },
      production: { keywords: ['qawwali', 'sufi', 'harmonium', 'devotional'] },
    },
    { parents: 'bollywood:1', aliases: ['sufi'] },
  ),
  asian(
    'bhangra-style',
    'Bhangra',
    'Punjabi dance music: dhol chaal, tumbi riffs, shouted "hoy!" calls',
    {
      tempo: tp(96, 120, 108),
      rhythm: { drumStyle: 'bhangra', swing: 0.35 },
      instruments: {
        add: [add('sitar', 'custom', 0.6, 'hook'), add('percussion', 'percussion', 1, 'rhythm', true)],
      },
      macros: { energy: 0.25 },
      energyShift: 5,
      production: { keywords: ['bhangra', 'punjabi', 'dhol', 'tumbi'] },
    },
    { parents: 'bollywood:1', aliases: ['punjabi', 'punjabi pop'] },
  ),
  asian(
    'indian-classical',
    'Indian classical',
    'Raga-based: sitar and tabla over a tanpura-like drone, unfolding slowly',
    {
      modes: md('phrygian:0.3 dorian:0.3 harmonic-minor:0.3'),
      harmony: { harmonicRhythm: 0.25, progressions: [pr('i', 3), pr('I', 2)] },
      instruments: {
        add: [
          add('sitar', 'custom', 1, 'melody', true),
          add('percussion', 'percussion', 0.9, 'rhythm'),
          add('synth-pad', 'synth-pad', 0.5, 'pad'),
        ],
        remove: [...DRUM_KITS, 'electric-bass', 'string-ensemble'],
      },
      macros: { repetition: -0.2, complexity: 0.2 },
      production: { keywords: ['raga', 'sitar', 'tabla', 'drone', 'hindustani'] },
    },
    { parents: 'bollywood:1', aliases: ['raga', 'hindustani', 'carnatic'] },
  ),
  asian(
    'arabic-pop',
    'Arabic pop',
    'Middle Eastern pop: maqam-flavoured melodies, darbuka grooves, string swells',
    {
      modes: md('harmonic-minor:0.6 phrygian:0.4'),
      rhythm: { drumStyle: 'bhangra', swing: 0.1 },
      instruments: {
        add: [
          add('string-ensemble', 'strings', 0.8, 'pad'),
          add('percussion', 'percussion', 0.9, 'rhythm'),
          add('flute', 'custom', 0.4, 'counter-melody'),
        ],
      },
      macros: { melodicMovement: 0.15 },
      production: { keywords: ['arabic pop', 'maqam', 'darbuka', 'oud'] },
    },
    { parents: 'pop:0.6 bollywood:0.4', aliases: ['khaleeji', 'arab pop'] },
  ),
  asian(
    'j-indie',
    'Japanese city folk',
    'Gentle Japanese acoustic pop with soft vocals and glockenspiel sparkle',
    {
      modes: md('major:0.7'),
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 0.9, 'accompaniment'),
          add('glockenspiel', 'keys', 0.5, 'hook'),
        ],
        remove: ['electric-guitar-distorted'],
      },
      macros: { energy: -0.2 },
      production: { keywords: ['japanese folk', 'gentle', 'acoustic'] },
    },
    { parents: 'j-pop:0.5 folk:0.5', aliases: ['j-folk', 'japanese folk'] },
  ),
  // --- World & traditional ---------------------------------------------------------------------
  world(
    'balkan-brass',
    'Balkan brass',
    'Wild Balkan brass band: odd-meter dances, harmonic-minor horn lines',
    {
      tempo: tp(130, 180, 156),
      meters: [m78, { numerator: 9, denominator: 8, weight: 0.5 }],
      modes: md('harmonic-minor:0.7'),
      instruments: {
        add: [
          add('brass-section', 'custom', 1, 'hook', true),
          add('trumpet', 'custom', 0.8, 'melody'),
          add('clarinet', 'custom', 0.4, 'counter-melody'),
        ],
      },
      macros: { energy: 0.2, complexity: 0.15 },
      production: { keywords: ['balkan brass', 'gypsy brass', 'odd meters'] },
    },
    { parents: 'ska:0.5 folk:0.5', aliases: ['balkan', 'gypsy brass', 'balkan beat'] },
  ),
  world(
    'klezmer',
    'Klezmer',
    'Jewish dance music: crying clarinet, freygish (phrygian dominant) mode, accelerating freylekhs',
    {
      modes: md('harmonic-minor:0.8'),
      instruments: {
        add: [
          add('clarinet', 'custom', 1, 'melody', true),
          add('violin', 'strings', 0.7, 'counter-melody'),
          add('accordion', 'keys', 0.6, 'accompaniment'),
        ],
      },
      macros: { melodicMovement: 0.2 },
      production: { keywords: ['klezmer', 'freygish', 'clarinet', 'freylekhs'] },
    },
    { parents: 'folk:0.6 jazz:0.4' },
  ),
  world(
    'tarantella',
    'Tarantella',
    'Breakneck Italian folk dance in 6/8 with mandolin and tambourine',
    {
      tempo: tp(150, 190, 170),
      meters: [m68],
      modes: md('minor:0.7'),
      instruments: {
        add: [
          add('mandolin', 'rhythm-guitar', 1, 'accompaniment', true),
          add('accordion', 'keys', 0.6, 'counter-melody'),
          add('percussion', 'percussion', 0.8, 'rhythm'),
        ],
      },
      macros: { energy: 0.2 },
      production: { keywords: ['tarantella', 'italian folk', 'mandolin', 'tambourine'] },
    },
    { parents: 'folk:1', aliases: ['italian folk'] },
  ),
  world(
    'flamenco-pop',
    'Flamenco pop',
    'Spanish pop with rumba guitars, palmas and handclap grooves',
    {
      rhythm: { drumStyle: 'flamenco', compStyle: 'rasgueado' },
      instruments: { add: [add('nylon-guitar', 'rhythm-guitar', 1, 'accompaniment', true)] },
      macros: { syncopation: 0.1 },
      production: { keywords: ['flamenco pop', 'rumba', 'palmas', 'spanish pop'] },
    },
    { parents: 'flamenco:0.5 latin-pop:0.5', aliases: ['rumba catalana', 'nuevo flamenco', 'gipsy kings'] },
  ),
  world(
    'hawaiian',
    'Hawaiian',
    'Island slack-key and steel guitar, ukulele strums and gentle waltzes',
    {
      modes: md('major:1'),
      meters: [{ numerator: 3, denominator: 4, weight: 0.3 }],
      instruments: {
        add: [
          add('pedal-steel', 'lead-guitar', 0.9, 'counter-melody'),
          add('acoustic-guitar', 'rhythm-guitar', 0.9, 'accompaniment'),
        ],
        remove: ['electric-guitar-distorted'],
      },
      macros: { energy: -0.2 },
      production: { keywords: ['hawaiian', 'slack-key', 'lap steel', 'ukulele'] },
    },
    { parents: 'folk:0.6 country:0.4', aliases: ['slack key'] },
  ),
  world(
    'polynesian-reggae',
    'Island reggae',
    'Pacific "island reggae": sunny ukulele-and-skank love songs',
    {
      modes: md('major:0.8'),
      instruments: { add: [add('acoustic-guitar', 'rhythm-guitar', 0.7, 'accompaniment')] },
      macros: { energy: -0.1 },
      production: { keywords: ['island reggae', 'jawaiian', 'sunny'] },
    },
    { parents: 'reggae:0.7 pop:0.3', aliases: ['jawaiian'] },
  ),
  world(
    'celtic-rock',
    'Celtic rock',
    'Rock band with pipes-and-fiddle melodies and jig-driven energy',
    {
      rhythm: { drumStyle: 'rock' },
      instruments: {
        add: [
          add('electric-guitar-distorted', 'rhythm-guitar', 0.8, 'rhythm'),
          add('electric-bass', 'bass', 1, 'bass-line', true),
          add('drum-kit', 'drums', 1, 'rhythm', true),
        ],
      },
      macros: { energy: 0.2 },
      production: { keywords: ['celtic rock', 'celtic punk', 'pipes', 'fiddle'] },
    },
    { parents: 'celtic:0.6 rock:0.4', aliases: ['celtic punk', 'irish punk'] },
  ),
];

const CLASSICAL_TAGS: StyleTag[] = [
  classical(
    'baroque',
    'Baroque',
    'Bach-era counterpoint: busy harmonic rhythm, sequences, walking continuo bass',
    {
      tempo: tp(70, 130, 100),
      harmony: {
        harmonicRhythm: 2,
        extensionRate: 0.05,
        progressions: [pr('I IV vii° iii vi ii V I', 2), pr('I V vi iii IV I IV V', 2)],
      },
      rhythm: { bassStyle: 'walking', compStyle: 'arpeggio' },
      instruments: {
        add: [add('harp', 'keys', 0.6, 'accompaniment'), add('violin', 'strings', 0.8, 'melody')],
        remove: [...DRUM_KITS, ...SYNTHS],
      },
      macros: { complexity: 0.2, melodicMovement: 0.2 },
      production: { keywords: ['baroque', 'counterpoint', 'harpsichord', 'continuo'] },
    },
    { parents: 'orchestral:1', aliases: ['baroque period', 'bach'] },
  ),
  classical(
    'romantic-era',
    'Romantic era',
    '19th-century lyricism: sweeping strings, chromatic harmony, big dynamics',
    {
      harmony: { borrowedChordRate: 0.4, extensionRate: 0.3 },
      instruments: {
        add: [
          add('piano', 'keys', 0.7, 'accompaniment'),
          add('french-horn', 'custom', 0.6, 'counter-melody'),
        ],
      },
      macros: { dynamics: 0.2, harmonicTension: 0.15 },
      production: { keywords: ['romantic era', 'lyrical', 'sweeping', '19th century'] },
    },
    { parents: 'orchestral:1', aliases: ['romantic period', 'late romantic'] },
  ),
  classical(
    'minimalism',
    'Minimalism',
    'Glass/Reich-style process music: repeating arpeggio cells, slowly shifting harmony',
    {
      harmony: { harmonicRhythm: 0.5 },
      rhythm: { compStyle: 'arpeggio' },
      instruments: {
        add: [add('marimba', 'keys', 0.8, 'accompaniment'), add('piano', 'keys', 0.8, 'accompaniment')],
        remove: DRUM_KITS,
      },
      macros: { repetition: -0.35, density: 0.1 },
      production: { keywords: ['minimalism', 'phasing', 'process music', 'ostinato'] },
    },
    { parents: 'orchestral:0.6 ambient:0.4', aliases: ['phase music', 'process music'] },
  ),
  classical(
    'neoclassical',
    'Neoclassical',
    'Modern piano-and-strings: intimate felt piano, cello lines, cinematic restraint',
    {
      tempo: tp(60, 100, 76),
      harmony: { extensionRate: 0.3 },
      rhythm: { compStyle: 'arpeggio' },
      instruments: {
        add: [
          add('piano', 'keys', 1, 'accompaniment', true),
          add('cello', 'strings', 0.7, 'counter-melody'),
          add('string-ensemble', 'strings', 0.5, 'pad'),
        ],
        remove: [...DRUM_KITS, ...SYNTHS],
      },
      macros: { energy: -0.2, dynamics: 0.15 },
      production: { keywords: ['neoclassical', 'felt piano', 'modern classical', 'intimate'], reverb: 0.5 },
    },
    {
      parents: 'orchestral:0.6 ambient:0.4',
      aliases: ['modern classical', 'neo-classical', 'post-classical'],
    },
  ),
  classical(
    'chamber-music',
    'Chamber music',
    'Small ensemble classical: string quartet or piano trio in conversation',
    {
      instruments: {
        add: [
          add('violin', 'strings', 1, 'melody', true),
          add('viola', 'strings', 0.7, 'harmony'),
          add('cello', 'strings', 0.8, 'bass-line'),
        ],
        remove: ['timpani', 'brass-section', 'choir', 'french-horn'],
      },
      macros: { density: -0.15, complexity: 0.1 },
      production: { keywords: ['chamber music', 'string quartet', 'intimate'], reverb: 0.4 },
    },
    { parents: 'orchestral:1', aliases: ['string quartet', 'piano trio'] },
  ),
  classical(
    'opera',
    'Opera',
    'Operatic aria: soaring classical voice, orchestra, dramatic recitative and climaxes',
    {
      instruments: {
        add: [add('lead-vocal', 'vocal', 1, 'melody', true), add('choir', 'vocal', 0.5, 'pad')],
      },
      macros: { melodicMovement: 0.25, dynamics: 0.2 },
      production: { keywords: ['opera', 'aria', 'operatic vocals', 'bel canto'] },
    },
    { parents: 'orchestral:0.7 musical-theatre:0.3', aliases: ['aria'] },
  ),
  classical(
    'choral',
    'Choral',
    'A choir carries the music: SATB harmony, sacred or secular',
    {
      instruments: { add: [add('choir', 'vocal', 1, 'pad', true)] },
      harmony: { extensionRate: 0.2 },
      macros: { dynamics: 0.15 },
      production: { keywords: ['choral', 'choir', 'satb', 'cathedral'], reverb: 0.65 },
    },
    { parents: 'orchestral:1', aliases: ['choir music', 'sacred choral'] },
  ),
  classical(
    'epic-trailer',
    'Epic trailer',
    'Hybrid trailer music: massive drums, braams, rising strings, choir and impacts',
    {
      tempo: tp(80, 130, 100),
      modes: md('minor:0.8'),
      rhythm: { halfTimeChance: 0.4 },
      instruments: {
        add: [
          add('timpani', 'percussion', 0.9, 'rhythm'),
          add('choir', 'vocal', 0.7, 'pad'),
          add('brass-section', 'custom', 0.9, 'harmony'),
        ],
      },
      macros: { dynamics: 0.25, energy: 0.15 },
      energyShift: 5,
      production: { keywords: ['epic trailer', 'braams', 'hybrid orchestral', 'impacts'], reverb: 0.6 },
    },
    { parents: 'cinematic:1', aliases: ['trailer music', 'epic music', 'hybrid orchestral'] },
  ),
  classical(
    'game-score',
    'Game score',
    'Video-game orchestral: adventurous themes, ostinatos and loopable sections',
    {
      instruments: {
        add: [
          add('string-ensemble', 'strings', 0.9, 'pad'),
          add('french-horn', 'custom', 0.7, 'melody'),
          add('synth-arp', 'synth-arp', 0.3, 'texture'),
        ],
      },
      macros: { repetition: -0.1, melodicMovement: 0.15 },
      production: { keywords: ['video game soundtrack', 'adventure', 'orchestral', 'loopable'] },
    },
    {
      parents: 'cinematic:0.7 orchestral:0.3',
      aliases: ['video game soundtrack', 'game music', 'rpg music'],
    },
  ),
  classical(
    'horror-score',
    'Horror score',
    'Dread and dissonance: clusters, tremolo strings, sub hits, music-box creepiness',
    {
      modes: md('locrian:0.2 phrygian:0.4 harmonic-minor:0.4'),
      harmony: { borrowedChordRate: 0.6, progressions: [pr('i bII', 2), pr('i bV', 1)] },
      instruments: { add: [add('glockenspiel', 'keys', 0.4, 'hook')] },
      macros: { harmonicTension: 0.4, energy: -0.1 },
      production: { keywords: ['horror', 'dissonant', 'dread', 'suspense'], reverb: 0.6 },
    },
    { parents: 'cinematic:1', aliases: ['horror', 'suspense score', 'thriller score'] },
  ),
  classical(
    'western-score',
    'Spaghetti western',
    'Morricone-style: twangy guitar, whistling, choir shouts and galloping rhythm',
    {
      modes: md('minor:0.7'),
      rhythm: { drumStyle: 'country' },
      instruments: {
        add: [
          add('electric-guitar-clean', 'lead-guitar', 0.9, 'melody'),
          add('trumpet', 'custom', 0.6, 'counter-melody'),
          add('choir', 'vocal', 0.4, 'pad'),
        ],
      },
      production: { keywords: ['spaghetti western', 'morricone', 'twang', 'whistling'], reverb: 0.55 },
      macros: { dynamics: 0.15 },
    },
    { parents: 'cinematic:0.7 country:0.3', aliases: ['western score', 'morricone'] },
  ),
  classical(
    'noir',
    'Noir',
    'Smoky film-noir jazz: muted trumpet, brushed drums, minor-key menace',
    {
      modes: md('minor:0.7'),
      rhythm: { drumStyle: 'jazz-swing', swing: 0.6 },
      harmony: { extensionRate: 0.8 },
      instruments: {
        add: [
          add('trumpet', 'custom', 0.8, 'melody'),
          add('upright-bass', 'bass', 0.9, 'bass-line'),
          add('piano', 'keys', 0.7, 'accompaniment'),
        ],
      },
      macros: { energy: -0.2, harmonicTension: 0.2 },
      production: { keywords: ['noir', 'smoky', 'detective', 'muted trumpet'] },
    },
    { parents: 'jazz:0.6 cinematic:0.4', aliases: ['film noir', 'detective'] },
  ),
  classical(
    'sci-fi-score',
    'Sci-fi score',
    'Synth-orchestral futurism: pulsing sequences, vast pads, cold brass',
    {
      instruments: {
        add: [add('synth-seq', 'synth-seq', 0.8, 'rhythm'), add('synth-pad', 'synth-pad', 0.9, 'pad')],
      },
      macros: { repetition: -0.15, humanization: -0.2 },
      production: { keywords: ['sci-fi', 'futuristic', 'synth orchestral', 'space'], reverb: 0.65 },
    },
    { parents: 'cinematic:0.6 synthwave:0.4', aliases: ['sci-fi', 'space opera'] },
  ),
  classical(
    'marching-band',
    'Marching band',
    'Brass and drumline in 2/4: snare cadences, sousaphone and fanfares',
    {
      tempo: tp(110, 130, 120),
      meters: [{ numerator: 2, denominator: 4, weight: 2 }],
      modes: md('major:0.9'),
      rhythm: { drumStyle: 'punk' },
      instruments: {
        add: [
          add('brass-section', 'custom', 1, 'harmony', true),
          add('trumpet', 'custom', 0.8, 'melody'),
          add('drum-kit', 'drums', 1, 'rhythm', true),
        ],
      },
      production: { keywords: ['marching band', 'drumline', 'fanfare', 'brass'] },
      macros: { energy: 0.15 },
    },
    { parents: 'orchestral:1', aliases: ['drumline', 'military march'] },
  ),
];

const SPECIAL_TAGS: StyleTag[] = [
  special(
    'christmas',
    'Christmas',
    'Holiday cheer: sleigh-bell shuffle, glockenspiel, warm strings and swing',
    {
      modes: md('major:1'),
      rhythm: { swing: 0.35 },
      instruments: {
        add: [
          add('glockenspiel', 'keys', 0.8, 'hook'),
          add('percussion', 'percussion', 0.8, 'rhythm'),
          add('string-ensemble', 'strings', 0.5, 'pad'),
        ],
      },
      harmony: { extensionRate: 0.4, progressions: [pr('I vi ii V', 2)] },
      production: { keywords: ['christmas', 'holiday', 'sleigh bells', 'festive'] },
      macros: { harmonicTension: -0.05 },
    },
    { parents: 'pop:0.6 jazz:0.4', aliases: ['holiday', 'xmas', 'christmas song'] },
  ),
  special(
    'lullaby',
    'Lullaby',
    'Gentle cradle song: slow 3/4 or 6/8, music box, soft voice',
    {
      tempo: tp(56, 80, 66),
      meters: [m34, m68],
      modes: md('major:1'),
      instruments: {
        add: [add('glockenspiel', 'keys', 0.7, 'hook'), add('harp', 'keys', 0.6, 'accompaniment')],
        remove: [...DRUM_KITS, 'electric-guitar-distorted'],
      },
      macros: { energy: -0.35, density: -0.25, complexity: -0.2 },
      energyShift: -15,
      production: { keywords: ['lullaby', 'music box', 'gentle', 'soothing'] },
    },
    { parents: 'folk:0.5 pop:0.5', aliases: ['cradle song', 'music box'] },
  ),
  special(
    'kids',
    "Children's music",
    'Bright, simple singalongs: clear melody, major key, playful instruments',
    {
      modes: md('major:1'),
      harmony: { extensionRate: 0, borrowedChordRate: 0, progressions: [pr('I IV V I', 2)] },
      instruments: {
        add: [add('glockenspiel', 'keys', 0.6, 'hook'), add('marimba', 'keys', 0.4, 'counter-melody')],
      },
      macros: { complexity: -0.3, melodicMovement: -0.1 },
      production: { keywords: ["children's music", 'kids', 'singalong', 'playful'] },
    },
    { parents: 'pop:0.7 folk:0.3', aliases: ["children's", 'kids song', 'nursery rhyme'] },
  ),
  special(
    'video-game-boss',
    'Boss battle',
    'Intense video-game boss theme: driving minor ostinatos, odd accents, choir and rock band',
    {
      tempo: tp(150, 190, 168),
      modes: md('harmonic-minor:0.5 minor:0.4'),
      instruments: {
        add: [
          add('electric-guitar-distorted', 'rhythm-guitar', 0.7, 'rhythm'),
          add('choir', 'vocal', 0.4, 'pad'),
        ],
      },
      macros: { energy: 0.25, complexity: 0.15 },
      energyShift: 8,
      production: { keywords: ['boss battle', 'video game', 'intense'] },
    },
    { parents: 'chiptune:0.5 cinematic:0.5', aliases: ['boss fight', 'boss music'] },
  ),
  special(
    'jingle',
    'Jingle',
    'Short, upbeat ad music: instant hook, bright major chords, tight arrangement',
    {
      tempo: tp(110, 140, 124),
      modes: md('major:1'),
      macros: { repetition: -0.3, energy: 0.1, complexity: -0.2 },
      production: { keywords: ['jingle', 'commercial', 'upbeat', 'catchy'] },
    },
    { parents: 'pop:1', aliases: ['advert music', 'commercial jingle'] },
  ),
  special(
    'wedding',
    'Wedding / first dance',
    'Romantic slow-dance ballad: tender, warm, swelling strings',
    {
      tempo: tp(60, 84, 72),
      meters: [{ numerator: 3, denominator: 4, weight: 0.3 }],
      instruments: {
        add: [add('string-ensemble', 'strings', 0.7, 'pad'), add('piano', 'keys', 0.8, 'accompaniment')],
      },
      macros: { energy: -0.2, dynamics: 0.15 },
      production: { keywords: ['wedding', 'first dance', 'romantic'] },
    },
    { parents: 'pop:0.6 singer-songwriter:0.4', aliases: ['first dance', 'wedding song'] },
  ),
  special(
    'workout',
    'Workout',
    'High-BPM motivational energy: relentless beat, pumping drops',
    {
      tempo: tp(126, 150, 136),
      rhythm: { drumStyle: 'four-on-floor' },
      macros: { energy: 0.3, repetition: -0.1 },
      energyShift: 10,
      production: { keywords: ['workout', 'gym', 'motivational', 'high energy'] },
    },
    { parents: 'edm:0.6 pop:0.4', aliases: ['gym music', 'running music'] },
  ),
  special(
    'study',
    'Study beats',
    'Unobtrusive background focus music: steady, mellow, low-contrast',
    {
      tempo: tp(70, 90, 80),
      macros: { energy: -0.25, dynamics: -0.2, density: -0.15 },
      energyShift: -10,
      production: { keywords: ['study music', 'focus', 'background', 'calm'] },
    },
    {
      parents: 'lo-fi-hip-hop:0.7 ambient:0.3',
      aliases: ['study music', 'focus music', 'beats to study to'],
    },
  ),
];

// ---------------------------------------------------------------------------------------------
// Mood tags: valence (modes, harmony) × arousal (tempo, energy, density, dynamics)
// ---------------------------------------------------------------------------------------------

const feel = kindOf('mood', 'Feelings');
const bright = kindOf('mood', 'Bright & uplifting');
const darkish = kindOf('mood', 'Dark & heavy');
const calm = kindOf('mood', 'Calm & dreamy');
const intense = kindOf('mood', 'Intense & driven');
const sad = kindOf('mood', 'Sad & reflective');

const MOOD_TAGS: StyleTag[] = [
  feel('warm', 'Warm', 'Comforting, round and major-leaning', {
    modes: md('major:0.5'),
    harmony: { extensionRate: 0.4 },
    macros: { harmonicTension: -0.1, energy: -0.05 },
    production: { keywords: ['warm'] },
  }),
  sad(
    'melancholy',
    'Melancholy',
    'Wistful sadness: minor keys, slower, gentle',
    {
      modes: md('minor:0.7'),
      tempo: { shift: -6 },
      harmony: { borrowedChordRate: 0.25 },
      macros: { energy: -0.15, harmonicTension: 0.1 },
      energyShift: -5,
      production: { keywords: ['melancholic'] },
    },
    { aliases: ['melancholic'] },
  ),
  bright(
    'euphoric',
    'Euphoric',
    'Peak-time elation: bright, big, driving',
    {
      modes: md('major:0.6'),
      tempo: { shift: 6 },
      macros: { energy: 0.25, dynamics: 0.15, density: 0.1 },
      energyShift: 8,
      production: { keywords: ['euphoric'] },
    },
    { aliases: ['ecstatic', 'elated'] },
  ),
  intense(
    'anxious',
    'Anxious',
    'Nervous, restless energy: tense harmony, busy rhythms',
    {
      modes: md('minor:0.4 phrygian:0.2'),
      tempo: { shift: 8 },
      macros: { harmonicTension: 0.25, syncopation: 0.15, density: 0.1 },
      production: { keywords: ['anxious', 'tense'] },
    },
    { aliases: ['nervous', 'restless', 'uneasy'] },
  ),
  sad(
    'nostalgic',
    'Nostalgic',
    'Looking back fondly: maj7 warmth with a borrowed-chord ache',
    {
      harmony: { extensionRate: 0.5, borrowedChordRate: 0.3, progressions: [pr('IV iv I', 1.2)] },
      macros: { energy: -0.1 },
      production: { keywords: ['nostalgic'] },
    },
    { aliases: ['sentimental', 'reminiscent'] },
  ),
  sad('bittersweet', 'Bittersweet', 'Happy and sad at once: major keys with minor-iv turns', {
    modes: md('major:0.3 minor:0.3'),
    harmony: { borrowedChordRate: 0.4, progressions: [pr('I iv I', 1), pr('IV iv I V', 1.2)] },
    macros: { harmonicTension: 0.1 },
    production: { keywords: ['bittersweet'] },
  }),
  intense(
    'defiant',
    'Defiant',
    'Standing your ground: punchy, loud, rhythmically firm',
    {
      modes: md('minor:0.3 mixolydian:0.2'),
      macros: { energy: 0.2, syncopation: -0.05, dynamics: 0.1 },
      energyShift: 6,
      production: { keywords: ['defiant', 'rebellious'] },
    },
    { aliases: ['rebellious'] },
  ),
  calm(
    'dreamy',
    'Dreamy',
    'Floaty and soft-focus: lydian colour, extended chords, washes of reverb',
    {
      modes: md('lydian:0.3 major:0.3'),
      tempo: { shift: -6 },
      harmony: { extensionRate: 0.6 },
      macros: { density: -0.15, energy: -0.15 },
      production: { keywords: ['dreamy', 'hazy'], reverb: 0.55 },
    },
    { aliases: ['dreamlike', 'hazy'] },
  ),
  bright(
    'triumphant',
    'Triumphant',
    'Victory lap: major key, fanfare brass, big dynamics',
    {
      modes: md('major:0.6 mixolydian:0.2'),
      harmony: { progressions: [pr('I bVII IV I', 1.2), pr('bVI bVII I', 1.2)] },
      instruments: { add: [add('brass-section', 'custom', 0.5, 'harmony')] },
      macros: { energy: 0.2, dynamics: 0.15 },
      energyShift: 6,
      production: { keywords: ['triumphant', 'victorious'] },
    },
    { aliases: ['victorious', 'heroic'] },
  ),
  darkish(
    'menacing',
    'Menacing',
    'Threatening and heavy: phrygian/harmonic-minor, low, slow-burning',
    {
      modes: md('phrygian:0.4 harmonic-minor:0.3'),
      tempo: { shift: -4 },
      harmony: { progressions: [pr('i bII i', 1.5)] },
      macros: { harmonicTension: 0.3, energy: 0.05 },
      production: { keywords: ['menacing', 'sinister'] },
    },
    { aliases: ['sinister', 'threatening', 'villainous'] },
  ),
  bright(
    'playful',
    'Playful',
    'Bouncy and cheeky: syncopated, light, major',
    {
      modes: md('major:0.6'),
      tempo: { shift: 4 },
      macros: { syncopation: 0.15, complexity: -0.05, density: -0.05 },
      production: { keywords: ['playful', 'bouncy'] },
    },
    { aliases: ['cheeky', 'quirky', 'fun'] },
  ),
  calm(
    'tender',
    'Tender',
    'Gentle and loving: soft dynamics, sparse, warm chords',
    {
      modes: md('major:0.4'),
      tempo: { shift: -6 },
      harmony: { extensionRate: 0.35 },
      macros: { energy: -0.2, density: -0.15, dynamics: -0.05 },
      energyShift: -6,
      production: { keywords: ['tender', 'gentle'] },
    },
    { aliases: ['gentle', 'loving', 'soft'] },
  ),
  intense('cathartic', 'Cathartic', 'Everything released: quiet-to-loud dynamics and a huge final chorus', {
    macros: { dynamics: 0.3, energy: 0.1 },
    energyShift: 4,
    rhythm: { halfTimeChance: 0.3 },
    production: { keywords: ['cathartic', 'emotional release'] },
  }),
  calm(
    'hypnotic',
    'Hypnotic',
    'Trance-like repetition: one chord or a loop, steady pulse',
    {
      harmony: { harmonicRhythm: 0.5 },
      macros: { repetition: -0.3, melodicMovement: -0.15 },
      production: { keywords: ['hypnotic', 'trance-like', 'repetitive'] },
    },
    { aliases: ['trance-like', 'mesmerizing', 'mesmerising'] },
  ),
  darkish(
    'eerie',
    'Eerie',
    'Uncanny and unsettling: dissonant colour, sparse, cold reverb',
    {
      modes: md('phrygian:0.3 locrian:0.15 harmonic-minor:0.2'),
      macros: { harmonicTension: 0.35, density: -0.15 },
      production: { keywords: ['eerie', 'unsettling'], reverb: 0.6 },
    },
    { aliases: ['uncanny', 'creepy', 'spooky', 'unsettling'] },
  ),
  bright(
    'hopeful',
    'Hopeful',
    'Looking up: rising major progressions, building energy',
    {
      modes: md('major:0.5'),
      harmony: { progressions: [pr('IV V vi', 1), pr('vi IV I V', 1)] },
      macros: { energy: 0.05, melodicMovement: 0.1 },
      energyShift: 2,
      production: { keywords: ['hopeful', 'optimistic'] },
    },
    { aliases: ['optimistic'] },
  ),
  intense(
    'angry',
    'Angry',
    'Furious: fast, loud, dissonant, distorted',
    {
      modes: md('minor:0.4 phrygian:0.3'),
      tempo: { shift: 10 },
      macros: { energy: 0.3, harmonicTension: 0.2, dynamics: -0.05 },
      energyShift: 10,
      production: { keywords: ['angry', 'furious', 'aggressive'] },
    },
    { aliases: ['furious', 'enraged'] },
  ),
  calm(
    'serene',
    'Serene',
    'Still water: slow, consonant, spacious',
    {
      modes: md('major:0.4 lydian:0.2'),
      tempo: { shift: -10 },
      macros: { energy: -0.3, harmonicTension: -0.15, density: -0.2 },
      energyShift: -10,
      production: { keywords: ['serene', 'tranquil'], reverb: 0.5 },
    },
    { aliases: ['tranquil', 'calm'] },
  ),
  feel(
    'sensual',
    'Sensual',
    'Slow, sultry and close: rich extensions, laid-back groove',
    {
      modes: md('dorian:0.3 minor:0.3'),
      tempo: { shift: -8 },
      harmony: { extensionRate: 0.8 },
      macros: { syncopation: 0.1, energy: -0.1, humanization: 0.1 },
      production: { keywords: ['sensual', 'sultry'] },
    },
    { aliases: ['sultry', 'seductive', 'sexy'] },
  ),
  sad(
    'lonely',
    'Lonely',
    'Isolation: sparse arrangement, minor, slow, lots of space',
    {
      modes: md('minor:0.5'),
      tempo: { shift: -8 },
      macros: { density: -0.3, energy: -0.2 },
      energyShift: -8,
      production: { keywords: ['lonely', 'isolated'], reverb: 0.5 },
    },
    { aliases: ['lonesome', 'isolated'] },
  ),
  bright(
    'happy',
    'Happy',
    'Simply joyful: bright major key, bouncy tempo',
    {
      modes: md('major:0.8'),
      tempo: { shift: 6 },
      macros: { energy: 0.1, harmonicTension: -0.1 },
      production: { keywords: ['happy', 'cheerful'] },
    },
    { aliases: ['cheerful', 'joyful', 'joyous', 'sunny'] },
  ),
  sad(
    'sad',
    'Sad',
    'Sorrowful: minor key, slow, soft',
    {
      modes: md('minor:0.8'),
      tempo: { shift: -10 },
      macros: { energy: -0.25, dynamics: -0.05 },
      energyShift: -8,
      production: { keywords: ['sad', 'sorrowful'] },
    },
    { aliases: ['sorrowful', 'mournful', 'grieving'] },
  ),
  darkish(
    'dark',
    'Dark',
    'Shadowy: minor and phrygian colour, low register, heavy',
    {
      modes: md('minor:0.6 phrygian:0.2'),
      harmony: { borrowedChordRate: 0.25 },
      macros: { harmonicTension: 0.15, energy: 0.05 },
      production: { keywords: ['dark', 'moody'] },
    },
    { aliases: ['ominous', 'shadowy'] },
  ),
  bright(
    'uplifting',
    'Uplifting',
    'Inspiring: rising progressions, open voicings, swelling dynamics',
    {
      modes: md('major:0.6'),
      macros: { energy: 0.15, dynamics: 0.15, melodicMovement: 0.1 },
      energyShift: 5,
      production: { keywords: ['uplifting', 'inspiring'] },
    },
    { aliases: ['inspiring', 'inspirational'] },
  ),
  intense(
    'epic',
    'Epic',
    'Larger than life: wide dynamics, big percussion and brass, slow-burning builds',
    {
      instruments: {
        add: [add('string-ensemble', 'strings', 0.6, 'pad'), add('timpani', 'percussion', 0.4, 'rhythm')],
      },
      macros: { dynamics: 0.3, energy: 0.15 },
      energyShift: 5,
      production: { keywords: ['epic', 'grand'], reverb: 0.5 },
    },
    { aliases: ['grand', 'larger than life'] },
  ),
  calm(
    'chill',
    'Chill',
    'Laid-back and easy: slower, softer, swung a little',
    {
      tempo: { shift: -8 },
      rhythm: { swing: 0.2 },
      macros: { energy: -0.25, humanization: 0.1, density: -0.1 },
      energyShift: -8,
      production: { keywords: ['chill', 'laid back', 'relaxed'] },
    },
    { aliases: ['chilled', 'relaxed', 'mellow'] },
  ),
  intense(
    'energetic',
    'Energetic',
    'Lots of drive: faster, denser, louder',
    {
      tempo: { shift: 10 },
      macros: { energy: 0.25, density: 0.15 },
      energyShift: 8,
      production: { keywords: ['energetic', 'high energy'] },
    },
    { aliases: ['lively', 'high energy', 'upbeat'] },
  ),
  intense(
    'aggressive',
    'Aggressive',
    'Attacking: loud, distorted, hard-hitting and tense',
    {
      modes: md('minor:0.4 phrygian:0.2'),
      tempo: { shift: 8 },
      macros: { energy: 0.3, harmonicTension: 0.15, density: 0.1 },
      energyShift: 10,
      production: { keywords: ['aggressive', 'hard-hitting'] },
    },
    { aliases: ['hard-hitting', 'brutal', 'savage', 'fierce'] },
  ),
  darkish(
    'mysterious',
    'Mysterious',
    'Something hidden: modal ambiguity, sparse, unresolved',
    {
      modes: md('dorian:0.3 phrygian:0.2 harmonic-minor:0.2'),
      harmony: { extensionRate: 0.4 },
      macros: { harmonicTension: 0.2, density: -0.1 },
      production: { keywords: ['mysterious', 'enigmatic'] },
    },
    { aliases: ['enigmatic', 'mystical', 'cryptic'] },
  ),
  darkish(
    'haunting',
    'Haunting',
    'Lingering and ghostly: minor, echoing, slow',
    {
      modes: md('minor:0.5 harmonic-minor:0.2'),
      tempo: { shift: -6 },
      macros: { harmonicTension: 0.2, energy: -0.1 },
      production: { keywords: ['haunting', 'ghostly'], reverb: 0.65 },
    },
    { aliases: ['ghostly'] },
  ),
  intense(
    'tense',
    'Tense',
    'Suspense: unresolved harmony, pulsing ostinatos',
    {
      modes: md('minor:0.3 harmonic-minor:0.3'),
      macros: { harmonicTension: 0.3, repetition: -0.1 },
      production: { keywords: ['tense', 'suspenseful'] },
    },
    { aliases: ['suspenseful', 'suspense'] },
  ),
  sad(
    'heartbroken',
    'Heartbroken',
    'Raw heartbreak: minor ballad pacing, exposed voice, swelling choruses',
    {
      modes: md('minor:0.7'),
      tempo: { shift: -10 },
      macros: { dynamics: 0.2, energy: -0.15 },
      energyShift: -5,
      production: { keywords: ['heartbroken', 'heartbreak'] },
    },
    { aliases: ['heartbreak', 'heartbreaking', 'broken-hearted'] },
  ),
  sad(
    'wistful',
    'Wistful',
    'Quiet longing: soft, modal, slightly unresolved',
    {
      modes: md('dorian:0.3 minor:0.3'),
      harmony: { borrowedChordRate: 0.2 },
      macros: { energy: -0.15, harmonicTension: 0.05 },
      production: { keywords: ['wistful', 'longing'] },
    },
    { aliases: ['longing', 'yearning'] },
  ),
  sad(
    'reflective',
    'Reflective',
    'Thoughtful and inward: mid-slow, sparse, gentle extensions',
    {
      tempo: { shift: -6 },
      harmony: { extensionRate: 0.35 },
      macros: { energy: -0.15, density: -0.15 },
      production: { keywords: ['reflective', 'introspective'] },
    },
    { aliases: ['introspective', 'pensive', 'contemplative', 'thoughtful'] },
  ),
  calm('intimate', 'Intimate', 'Up close: sparse, quiet, close-miked feel', {
    macros: { density: -0.3, energy: -0.2, dynamics: -0.05 },
    energyShift: -8,
    instruments: { remove: ['brass-section', 'string-ensemble', 'synth-lead'] },
    production: { keywords: ['intimate', 'close'], reverb: 0.2 },
  }),
  bright(
    'majestic',
    'Majestic',
    'Regal grandeur: broad tempo, horns and strings, slow harmonic rhythm',
    {
      modes: md('major:0.5'),
      tempo: { shift: -6 },
      harmony: { harmonicRhythm: 0.5 },
      instruments: {
        add: [add('french-horn', 'custom', 0.5, 'harmony'), add('string-ensemble', 'strings', 0.5, 'pad')],
      },
      macros: { dynamics: 0.2 },
      production: { keywords: ['majestic', 'regal', 'noble'] },
    },
    { aliases: ['regal', 'noble', 'stately'] },
  ),
  bright(
    'carefree',
    'Carefree',
    'Breezy and easy: light syncopation, major, sunny',
    {
      modes: md('major:0.6'),
      macros: { syncopation: 0.1, harmonicTension: -0.15, energy: 0.05 },
      production: { keywords: ['carefree', 'breezy'] },
    },
    { aliases: ['breezy', 'easygoing', 'easy-going'] },
  ),
  bright(
    'summery',
    'Summery',
    'Sun-soaked: bright, bouncy, tropical-tinged',
    {
      modes: md('major:0.6'),
      macros: { syncopation: 0.1, energy: 0.1 },
      instruments: { add: [add('percussion', 'percussion', 0.4, 'rhythm')] },
      production: { keywords: ['summer', 'sunny', 'beach'] },
    },
    { aliases: ['summer', 'beachy', 'sun-soaked'] },
  ),
  calm(
    'wintry',
    'Wintry',
    'Cold and crystalline: sparse, bell-like, slow',
    {
      tempo: { shift: -6 },
      instruments: { add: [add('glockenspiel', 'keys', 0.4, 'hook')] },
      macros: { density: -0.15, energy: -0.15 },
      production: { keywords: ['wintry', 'cold', 'crystalline'], reverb: 0.55 },
    },
    { aliases: ['winter', 'snowy', 'frosty'] },
  ),
  calm(
    'rainy',
    'Rainy day',
    'Grey-sky mellowness: soft piano, gentle minor, slow',
    {
      modes: md('minor:0.3'),
      tempo: { shift: -8 },
      instruments: { add: [add('piano', 'keys', 0.6, 'accompaniment')] },
      macros: { energy: -0.2 },
      production: { keywords: ['rainy day', 'grey', 'cozy'] },
    },
    { aliases: ['rainy', 'rainy day', 'cozy', 'cosy'] },
  ),
  calm(
    'late-night',
    'Late-night',
    'After hours: dim, smoky, slow grooves and extended chords',
    {
      tempo: { shift: -6 },
      harmony: { extensionRate: 0.6 },
      macros: { energy: -0.15, density: -0.1 },
      production: { keywords: ['late night', 'after hours', 'nocturnal'] },
    },
    { aliases: ['nocturnal', 'after hours', 'midnight', 'night drive'] },
  ),
  feel(
    'spiritual',
    'Spiritual',
    'Transcendent: drones, choirs, plagal cadences',
    {
      harmony: { progressions: [pr('IV I', 1.5), pr('IV iv I', 1)] },
      instruments: { add: [add('choir', 'vocal', 0.5, 'pad')] },
      macros: { repetition: -0.1, dynamics: 0.1 },
      production: { keywords: ['spiritual', 'transcendent'], reverb: 0.55 },
    },
    { aliases: ['transcendent', 'sacred', 'devotional'] },
  ),
  darkish(
    'apocalyptic',
    'Apocalyptic',
    'End-of-the-world scale: crushing low end, choirs, relentless drums',
    {
      modes: md('minor:0.5 phrygian:0.3'),
      instruments: { add: [add('choir', 'vocal', 0.5, 'pad'), add('timpani', 'percussion', 0.4, 'rhythm')] },
      macros: { energy: 0.25, harmonicTension: 0.25, dynamics: 0.2 },
      energyShift: 8,
      production: { keywords: ['apocalyptic', 'doom'] },
    },
    { aliases: ['doomsday', 'cataclysmic'] },
  ),
  sad(
    'vulnerable',
    'Vulnerable',
    'Exposed and fragile: sparse, quiet, close',
    {
      macros: { density: -0.25, energy: -0.2, dynamics: 0.1 },
      energyShift: -6,
      production: { keywords: ['vulnerable', 'fragile'] },
    },
    { aliases: ['fragile', 'raw emotion'] },
  ),
  bright(
    'empowering',
    'Empowering',
    'Anthem of strength: four-on-the-floor confidence, big chorus lift',
    {
      modes: md('major:0.4'),
      macros: { energy: 0.2, dynamics: 0.15 },
      energyShift: 6,
      production: { keywords: ['empowering', 'anthem', 'confident'] },
    },
    { aliases: ['confident', 'anthemic', 'self-love'] },
  ),
  intense(
    'swagger',
    'Swagger',
    'Cocky strut: laid-back but punchy, syncopated groove',
    {
      rhythm: { swing: 0.15 },
      macros: { syncopation: 0.2, energy: 0.1 },
      production: { keywords: ['swagger', 'cocky', 'strut'] },
    },
    { aliases: ['cocky', 'strut', 'braggadocious'] },
  ),
  intense(
    'chaotic',
    'Chaotic',
    'Controlled chaos: unpredictable, dense, abrupt changes',
    {
      macros: { repetition: 0.3, complexity: 0.25, density: 0.2, harmonicTension: 0.2 },
      production: { keywords: ['chaotic', 'frantic'] },
    },
    { aliases: ['frantic', 'manic', 'frenzied'] },
  ),
  calm(
    'lush',
    'Lush',
    'Rich and enveloping: dense pads and strings, extended harmony',
    {
      harmony: { extensionRate: 0.6 },
      instruments: {
        add: [add('string-ensemble', 'strings', 0.6, 'pad'), add('synth-pad', 'synth-pad', 0.6, 'pad')],
      },
      macros: { density: 0.2 },
      production: { keywords: ['lush', 'rich'], reverb: 0.5 },
    },
    { aliases: ['rich', 'velvety', 'silky'] },
  ),
  darkish(
    'cold',
    'Cold',
    'Detached and icy: minor, mechanical, sparse',
    {
      modes: md('minor:0.5'),
      macros: { humanization: -0.2, density: -0.1, harmonicTension: 0.1 },
      production: { keywords: ['cold', 'icy', 'detached'] },
    },
    { aliases: ['icy', 'detached', 'clinical'] },
  ),
  intense(
    'gritty',
    'Gritty',
    'Rough edges: loose, distorted, raw',
    {
      macros: { humanization: 0.2, energy: 0.1 },
      production: { keywords: ['gritty', 'raw', 'dirty'] },
      harmony: { extensionRate: 0.05 },
    },
    { aliases: ['dirty', 'grimy', 'rough'] },
  ),
  bright(
    'celebratory',
    'Celebratory',
    'Party time: festive, bright, percussive, loud',
    {
      modes: md('major:0.7'),
      tempo: { shift: 6 },
      instruments: {
        add: [add('percussion', 'percussion', 0.6, 'rhythm'), add('brass-section', 'custom', 0.3, 'hook')],
      },
      macros: { energy: 0.25 },
      energyShift: 6,
      production: { keywords: ['celebratory', 'festive', 'party'] },
    },
    { aliases: ['festive', 'party', 'jubilant'] },
  ),
  sad(
    'somber',
    'Somber',
    'Grave and heavy-hearted: slow, low, minor',
    {
      modes: md('minor:0.7'),
      tempo: { shift: -10 },
      macros: { energy: -0.25, density: -0.1 },
      energyShift: -10,
      production: { keywords: ['somber', 'grave'] },
    },
    { aliases: ['sombre', 'gloomy', 'bleak', 'grave'] },
  ),
  darkish(
    'brooding',
    'Brooding',
    'Simmering tension: minor vamps, low-register pulse',
    {
      modes: md('minor:0.5 dorian:0.2'),
      macros: { harmonicTension: 0.15, energy: -0.05, repetition: -0.1 },
      production: { keywords: ['brooding', 'moody'] },
    },
    { aliases: ['moody', 'smouldering', 'smoldering'] },
  ),
  sad(
    'desperate',
    'Desperate',
    'Urgent pleading: rising tension, louder, faster',
    {
      modes: md('minor:0.5 harmonic-minor:0.2'),
      tempo: { shift: 6 },
      macros: { energy: 0.15, harmonicTension: 0.2, dynamics: 0.15 },
      production: { keywords: ['desperate', 'urgent'] },
    },
    { aliases: ['urgent', 'pleading'] },
  ),
  calm(
    'ethereal',
    'Ethereal',
    'Weightless and airy: high register, pads, long reverb',
    {
      modes: md('lydian:0.3'),
      harmony: { extensionRate: 0.5 },
      instruments: { add: [add('synth-pad', 'synth-pad', 0.7, 'pad'), add('choir', 'vocal', 0.3, 'pad')] },
      macros: { density: -0.1, energy: -0.15 },
      production: { keywords: ['ethereal', 'airy', 'atmospheric'], reverb: 0.65 },
    },
    { aliases: ['airy', 'atmospheric', 'celestial', 'otherworldly'] },
  ),
  bright(
    'romantic',
    'Romantic',
    'Love song warmth: lush chords, singing melody, gentle groove',
    {
      modes: md('major:0.5'),
      harmony: { extensionRate: 0.5 },
      macros: { melodicMovement: 0.1, energy: -0.1 },
      production: { keywords: ['romantic', 'love song'] },
    },
    { aliases: ['love song', 'amorous'] },
  ),
  intense(
    'dramatic',
    'Dramatic',
    'Theatrical contrasts: big dynamics, harmonic surprises',
    {
      harmony: { borrowedChordRate: 0.35 },
      macros: { dynamics: 0.3, harmonicTension: 0.15 },
      production: { keywords: ['dramatic', 'theatrical'] },
    },
    { aliases: ['theatrical', 'operatic drama'] },
  ),
  bright(
    'groovy',
    'Groovy',
    'Makes you move: syncopated, locked-in, a little swung',
    {
      rhythm: { swing: 0.15 },
      macros: { syncopation: 0.25, humanization: 0.05 },
      production: { keywords: ['groovy'] },
    },
    { aliases: ['funky', 'in the pocket'] },
  ),
  calm(
    'peaceful',
    'Peaceful',
    'At rest: consonant, slow, open',
    {
      modes: md('major:0.5'),
      tempo: { shift: -8 },
      macros: { harmonicTension: -0.2, energy: -0.25 },
      energyShift: -10,
      production: { keywords: ['peaceful'] },
    },
    { aliases: ['restful', 'still'] },
  ),
  feel(
    'mischievous',
    'Mischievous',
    'Sneaky fun: chromatic tiptoes, staccato, minor-major games',
    {
      modes: md('minor:0.3 dorian:0.2'),
      macros: { syncopation: 0.15, harmonicTension: 0.15, density: -0.1 },
      production: { keywords: ['mischievous', 'sneaky', 'pizzicato'] },
      instruments: { add: [add('pizzicato-strings', 'strings', 0.5, 'accompaniment')] },
    },
    { aliases: ['sneaky', 'sly'] },
  ),
  feel(
    'determined',
    'Determined',
    'Unstoppable resolve: steady driving pulse, building',
    {
      macros: { energy: 0.15, repetition: -0.05, syncopation: -0.05 },
      energyShift: 4,
      rhythm: { bassStyle: 'eighths' },
      production: { keywords: ['determined', 'driving'] },
    },
    { aliases: ['resolute', 'driven'] },
  ),
  feel(
    'whimsical',
    'Whimsical',
    'Storybook fancy: bells, pizzicato, lilting 6/8',
    {
      meters: [{ numerator: 6, denominator: 8, weight: 0.4 }],
      modes: md('major:0.4 lydian:0.2'),
      instruments: {
        add: [
          add('glockenspiel', 'keys', 0.5, 'hook'),
          add('pizzicato-strings', 'strings', 0.4, 'accompaniment'),
        ],
      },
      macros: { complexity: 0.05 },
      production: { keywords: ['whimsical', 'storybook', 'fairytale'] },
    },
    { aliases: ['fairytale', 'storybook', 'magical'] },
  ),
  feel(
    'sentimental-ballad',
    'Tear-jerker',
    'Built to make you cry: slow, swelling strings, lifted last chorus',
    {
      tempo: { shift: -12 },
      instruments: {
        add: [add('string-ensemble', 'strings', 0.7, 'pad'), add('piano', 'keys', 0.7, 'accompaniment')],
      },
      macros: { dynamics: 0.25, energy: -0.15 },
      production: { keywords: ['tear-jerker', 'emotional', 'swelling strings'] },
    },
    { aliases: ['tear jerker', 'tearjerker'] },
  ),
];

// ---------------------------------------------------------------------------------------------
// Era tags
// ---------------------------------------------------------------------------------------------

const era = kindOf('era', 'Era');

const ERA_TAGS: StyleTag[] = [
  era(
    '1920s',
    '1920s',
    'Jazz-age: ragtime syncopation, banjo and brass, 2-beat swing',
    {
      rhythm: { swing: 0.55 },
      instruments: {
        add: [
          add('banjo', 'rhythm-guitar', 0.6, 'accompaniment'),
          add('trumpet', 'custom', 0.6, 'counter-melody'),
        ],
        remove: SYNTHS,
      },
      production: { keywords: ['1920s', 'jazz age', 'gramophone', 'mono'], reverb: 0.15 },
      macros: { humanization: 0.2 },
    },
    { aliases: ['20s', 'roaring twenties', 'jazz age'] },
  ),
  era(
    '1940s',
    '1940s',
    'Swing era and big bands: crooners, brass sections, warm mono',
    {
      rhythm: { swing: 0.6 },
      instruments: {
        add: [add('brass-section', 'custom', 0.6, 'harmony'), add('upright-bass', 'bass', 0.6, 'bass-line')],
        remove: SYNTHS,
      },
      production: { keywords: ['1940s', 'swing era', 'crooner', 'vintage'] },
      macros: { humanization: 0.15 },
    },
    { aliases: ['40s', 'forties'] },
  ),
  era(
    '50s',
    '1950s',
    'Doo-wop and early rock and roll: 12/8 ballads, slapback echo, I–vi–IV–V',
    {
      meters: [{ numerator: 12, denominator: 8, weight: 0.4 }],
      harmony: { progressions: [pr('I vi IV V', 2)] },
      rhythm: { swing: 0.35 },
      instruments: {
        add: [
          add('saxophone', 'custom', 0.4, 'counter-melody'),
          add('backing-vocal', 'vocal', 0.5, 'harmony'),
        ],
        remove: SYNTHS,
      },
      production: { keywords: ['1950s', 'slapback echo', 'vintage', 'mono'], reverb: 0.3 },
      macros: { complexity: -0.1 },
    },
    { aliases: ['1950s', 'fifties'] },
  ),
  era(
    '60s',
    '1960s',
    'Beat groups and soul: tambourine, organ, spring reverb, harmony vocals',
    {
      instruments: {
        add: [
          add('organ', 'keys', 0.6, 'pad'),
          add('percussion', 'percussion', 0.5, 'rhythm'),
          add('backing-vocal', 'vocal', 0.5, 'harmony'),
        ],
        remove: ['synth-pad', 'synth-arp', 'synth-seq', '808-bass'],
      },
      production: { keywords: ['1960s', 'spring reverb', 'tape', 'vintage'] },
      macros: { humanization: 0.2 },
    },
    { aliases: ['1960s', 'sixties'] },
  ),
  era(
    '70s',
    '1970s',
    'Analog warmth: live band, electric piano, wah, string sections',
    {
      harmony: { extensionRate: 0.4 },
      instruments: {
        add: [
          add('electric-piano', 'keys', 0.6, 'accompaniment'),
          add('string-ensemble', 'strings', 0.4, 'pad'),
        ],
        remove: ['808-bass', 'synth-seq'],
      },
      production: { keywords: ['1970s', 'analog', 'warm', 'tape'] },
      macros: { humanization: 0.2 },
    },
    { aliases: ['1970s', 'seventies'] },
  ),
  era(
    '80s',
    '1980s',
    'Gated-reverb drums, analog poly synths, chorus guitars, drum machines',
    {
      instruments: {
        add: [
          add('synth-pad', 'synth-pad', 0.7, 'pad'),
          add('synth-lead', 'synth-lead', 0.4, 'hook'),
          add('electronic-kit', 'drums', 0.5, 'rhythm'),
        ],
      },
      production: { keywords: ['1980s', 'gated reverb', 'analog synths', 'chorus'], reverb: 0.45 },
      macros: { humanization: -0.15 },
    },
    { aliases: ['1980s', 'eighties'] },
  ),
  era(
    '90s',
    '1990s',
    'Breakbeats, grunge guitars, R&B swing and sampler culture',
    {
      rhythm: { swing: 0.15 },
      macros: { humanization: 0.05, syncopation: 0.1 },
      production: { keywords: ['1990s', 'sampler', 'breakbeats'] },
    },
    { aliases: ['1990s', 'nineties'] },
  ),
  era(
    'y2k',
    'Y2K / 2000s',
    'Glossy early-2000s pop: shiny synths, crisp drums, autotune shimmer',
    {
      instruments: { add: [add('synth-arp', 'synth-arp', 0.5, 'texture')] },
      macros: { humanization: -0.2, density: 0.1 },
      production: { keywords: ['y2k', '2000s', 'glossy', 'shiny'] },
    },
    { aliases: ['2000s', 'noughties', 'aughts'] },
  ),
  era(
    '2010s',
    '2010s',
    'EDM-pop drops, trap hi-hats and stadium "woah-oh" hooks',
    {
      rhythm: { halfTimeChance: 0.3 },
      instruments: { add: [add('synth-lead', 'synth-lead', 0.5, 'hook')] },
      macros: { humanization: -0.2 },
      production: { keywords: ['2010s', 'edm-pop', 'drop'] },
    },
    { aliases: ['twenty-tens', '2010s pop'] },
  ),
  era(
    'modern',
    'Modern',
    'Current production: tight, loud, crisp, sub-heavy, minimal verses',
    {
      macros: { humanization: -0.15, density: -0.05 },
      production: { keywords: ['modern', 'contemporary', 'crisp'], masteringTarget: 'streaming' },
    },
    { aliases: ['contemporary', '2020s'] },
  ),
  era(
    'vintage',
    'Vintage',
    'Old-records feel: warmer, looser, less processing',
    {
      macros: { humanization: 0.25 },
      instruments: { remove: ['808-bass', 'synth-seq'] },
      production: { keywords: ['vintage', 'old-school', 'warm'], masteringTarget: 'dynamic' },
    },
    { aliases: ['old-school', 'old school', 'classic'] },
  ),
  era(
    'retro',
    'Retro',
    'A knowing throwback: classic forms with modern clarity',
    {
      harmony: { extensionRate: 0.3 },
      macros: { humanization: 0.1, complexity: -0.05 },
      production: { keywords: ['retro', 'throwback'] },
    },
    { aliases: ['throwback'] },
  ),
  era(
    'futuristic',
    'Futuristic',
    'Forward-looking: synthetic textures, unusual sounds, precise timing',
    {
      instruments: {
        add: [add('synth-arp', 'synth-arp', 0.6, 'texture'), add('synth-pad', 'synth-pad', 0.5, 'pad')],
      },
      macros: { humanization: -0.3, complexity: 0.1 },
      production: { keywords: ['futuristic', 'synthetic', 'cutting-edge'] },
    },
    { aliases: ['future', 'cyber'] },
  ),
];

// ---------------------------------------------------------------------------------------------
// Production tags
// ---------------------------------------------------------------------------------------------

const prod = kindOf('production', 'Production');

const PRODUCTION_TAGS: StyleTag[] = [
  prod(
    'lo-fi',
    'Lo-fi',
    'Dusty, laid-back and slightly behind the beat',
    {
      tempo: { shift: -8 },
      rhythm: { swing: 0.35 },
      harmony: { extensionRate: 0.6 },
      macros: { humanization: 0.2, energy: -0.15, density: -0.1 },
      production: { keywords: ['lo-fi', 'tape hiss', 'vinyl crackle', 'warm'], reverb: 0.3 },
    },
    { aliases: ['lofi', 'lo fi'] },
  ),
  prod(
    'tape-saturated',
    'Tape-saturated',
    'Warm analog tape: rounded transients, gentle wow and flutter',
    {
      macros: { humanization: 0.15, dynamics: -0.1 },
      production: { keywords: ['tape saturation', 'analog', 'warm', 'wow and flutter'] },
    },
    { aliases: ['tape', 'analog tape', 'tape saturation'] },
  ),
  prod(
    'live-room',
    'Live room',
    'A band playing together in a room: looser timing, natural ambience',
    {
      instruments: { remove: ['electronic-kit', 'synth-seq'] },
      macros: { humanization: 0.3, dynamics: 0.1 },
      production: {
        keywords: ['live room', 'live band', 'natural ambience'],
        reverb: 0.3,
        masteringTarget: 'dynamic',
      },
    },
    { aliases: ['live band', 'live recording', 'room sound'] },
  ),
  prod(
    'polished',
    'Polished',
    'Radio-ready gloss: tight edits, quantized, bright and loud',
    {
      macros: { humanization: -0.25 },
      production: { keywords: ['polished', 'radio-ready', 'glossy'], masteringTarget: 'streaming' },
    },
    { aliases: ['glossy', 'radio-ready', 'slick'] },
  ),
  prod(
    'bedroom',
    'Bedroom production',
    'Made at home: soft, a little rough, intimate and quiet',
    {
      macros: { energy: -0.15, density: -0.15, humanization: 0.1 },
      instruments: { remove: ['brass-section', 'string-ensemble'] },
      production: { keywords: ['bedroom', 'home recorded', 'diy'] },
    },
    { aliases: ['home recorded', 'diy'] },
  ),
  prod('wall-of-sound', 'Wall of sound', 'Dense, layered, echo-drenched production: everything doubled', {
    instruments: {
      add: [
        add('string-ensemble', 'strings', 0.6, 'pad'),
        add('percussion', 'percussion', 0.5, 'rhythm'),
        add('backing-vocal', 'vocal', 0.5, 'harmony'),
      ],
    },
    macros: { density: 0.3 },
    production: { keywords: ['wall of sound', 'layered', 'dense'], reverb: 0.6 },
  }),
  prod(
    'minimal',
    'Minimal',
    'Less is more: few elements, lots of space',
    {
      macros: { density: -0.35, complexity: -0.15 },
      energyShift: -5,
      production: { keywords: ['minimal', 'sparse', 'spacious'] },
    },
    { aliases: ['minimalist', 'sparse', 'stripped-back', 'stripped back'] },
  ),
  prod(
    'maximal',
    'Maximal',
    'More is more: layered, busy, everything at once',
    {
      macros: { density: 0.35, complexity: 0.15 },
      energyShift: 5,
      production: { keywords: ['maximalist', 'layered', 'busy'] },
    },
    { aliases: ['maximalist', 'huge production'] },
  ),
  prod(
    'widescreen',
    'Widescreen',
    'Cinematic production: wide stereo, deep reverb, orchestral swells',
    {
      instruments: {
        add: [add('string-ensemble', 'strings', 0.6, 'pad'), add('timpani', 'percussion', 0.3, 'rhythm')],
      },
      macros: { dynamics: 0.25 },
      production: { keywords: ['cinematic', 'widescreen', 'wide stereo'], reverb: 0.6 },
    },
    { aliases: ['cinematic production', 'cinematic mix', 'big cinematic'] },
  ),
  prod(
    'orchestral-hybrid',
    'Orchestral hybrid',
    'Synths and orchestra layered: pulses under strings and brass',
    {
      instruments: {
        add: [
          add('string-ensemble', 'strings', 0.8, 'pad'),
          add('brass-section', 'custom', 0.5, 'harmony'),
          add('synth-seq', 'synth-seq', 0.5, 'rhythm'),
        ],
      },
      macros: { dynamics: 0.15, density: 0.15 },
      production: { keywords: ['hybrid orchestral', 'synths and orchestra'] },
    },
    { aliases: ['orchestral hybrid'] },
  ),
  prod(
    'unplugged',
    'Unplugged',
    'Acoustic version: no synths or drum machines, acoustic guitar and piano',
    {
      instruments: {
        add: [
          add('acoustic-guitar', 'rhythm-guitar', 0.9, 'accompaniment'),
          add('piano', 'keys', 0.6, 'accompaniment'),
        ],
        remove: [...SYNTHS, 'electronic-kit', 'electric-guitar-distorted'],
      },
      harmony: { powerChords: false },
      macros: { energy: -0.15, humanization: 0.2 },
      production: { keywords: ['unplugged', 'acoustic', 'organic'] },
    },
    { aliases: ['acoustic version', 'acoustic set', 'mtv unplugged'] },
  ),
  prod(
    'electronic-production',
    'Electronic production',
    'Programmed everything: drum machine, synth bass, sequenced parts',
    {
      instruments: {
        add: [
          add('electronic-kit', 'drums', 1, 'rhythm', true),
          add('synth-bass', 'bass', 0.8, 'bass-line'),
          add('synth-pad', 'synth-pad', 0.6, 'pad'),
        ],
        remove: ['drum-kit', 'electric-bass', 'upright-bass'],
      },
      macros: { humanization: -0.3 },
      production: { keywords: ['electronic', 'programmed', 'drum machine'] },
    },
    { aliases: ['programmed', 'electronic version'] },
  ),
  prod(
    'distorted',
    'Distorted',
    'Saturated and overdriven: crushed drums, fuzz, clipping',
    {
      macros: { energy: 0.2, dynamics: -0.15 },
      instruments: { add: [add('electric-guitar-distorted', 'rhythm-guitar', 0.6, 'rhythm')] },
      production: { keywords: ['distorted', 'overdriven', 'saturated'], masteringTarget: 'loud-rock' },
    },
    { aliases: ['overdriven', 'saturated', 'blown out', 'fuzzy'] },
  ),
  prod(
    'dry',
    'Dry',
    'Close and dead: almost no reverb, upfront and present',
    {
      macros: { density: -0.1, humanization: -0.1 },
      production: { keywords: ['dry', 'upfront', 'close-miked'], reverb: 0.05 },
    },
    { aliases: ['close-miked', 'dead room', 'upfront'] },
  ),
  prod(
    'reverb-drenched',
    'Reverb-drenched',
    'Huge spaces: long tails, washes, cathedral ambience',
    {
      macros: { density: -0.2, humanization: 0.1 },
      production: { keywords: ['reverb-drenched', 'cavernous', 'washy'], reverb: 0.8 },
    },
    { aliases: ['washed out', 'cavernous', 'drenched in reverb', 'spacious'] },
  ),
  prod(
    'vinyl',
    'Vinyl',
    'Record-crackle texture and a gentle, sample-like warmth',
    {
      macros: { humanization: 0.1 },
      rhythm: { swing: 0.15 },
      production: { keywords: ['vinyl crackle', 'record', 'sampled'] },
    },
    { aliases: ['vinyl crackle', 'record crackle'] },
  ),
  prod(
    'glitch',
    'Glitchy',
    'Stutters, buffer edits and digital artifacts',
    {
      macros: { repetition: 0.2, complexity: 0.2, humanization: -0.2 },
      rhythm: { syncopation: 0.7 },
      production: { keywords: ['glitch', 'stutter edits', 'digital artifacts'] },
    },
    { aliases: ['glitchy', 'stutter'] },
  ),
  prod(
    'sidechain',
    'Sidechain pump',
    'Everything ducks to the kick: pumping, breathing dance production',
    {
      rhythm: { drumStyle: 'four-on-floor' },
      macros: { humanization: -0.15 },
      production: { keywords: ['sidechain', 'pumping'] },
    },
    { aliases: ['pumping', 'sidechained'] },
  ),
  prod(
    'slowed-reverb',
    'Slowed + reverb',
    'TikTok-era slowed edit: lower tempo, longer tails, dreamy haze',
    {
      tempo: { shift: -16 },
      macros: { energy: -0.2 },
      energyShift: -6,
      production: { keywords: ['slowed', 'slowed and reverb', 'dreamy'], reverb: 0.7 },
    },
    { aliases: ['slowed', 'slowed and reverb', 'slowed reverb'] },
  ),
  prod(
    'sped-up',
    'Sped up',
    'Nightcore-ish sped-up edit: faster, brighter, more urgent',
    {
      tempo: { shift: 18 },
      macros: { energy: 0.15 },
      production: { keywords: ['sped up'] },
    },
    { aliases: ['speed up', 'sped-up version'] },
  ),
  prod(
    'eight-bit',
    '8-bit',
    'Console-chip sounds: square leads and fast arpeggios',
    {
      instruments: {
        add: [add('chip-lead', 'synth-lead', 0.9, 'hook'), add('synth-arp', 'synth-arp', 0.6, 'texture')],
      },
      macros: { humanization: -0.3 },
      production: { keywords: ['8-bit', 'chiptune', 'retro game'] },
    },
    { aliases: ['8 bit', 'eight bit', '16-bit', 'chip sounds'] },
  ),
  prod(
    'analog-synths',
    'Analog synths',
    'Warm, drifting analog poly synths and mono basses',
    {
      instruments: {
        add: [add('synth-pad', 'synth-pad', 0.8, 'pad'), add('synth-bass', 'bass', 0.6, 'bass-line')],
      },
      macros: { humanization: 0.05 },
      production: { keywords: ['analog synths', 'moog', 'juno'] },
    },
    { aliases: ['moog', 'juno', 'analog synth'] },
  ),
  prod(
    'loud',
    'Loud master',
    'Squashed for loudness: dense, compressed, little dynamic range',
    {
      macros: { dynamics: -0.3, energy: 0.1 },
      production: { keywords: ['loud', 'compressed', 'brickwalled'], masteringTarget: 'loud-rock' },
    },
    { aliases: ['compressed', 'brickwalled', 'squashed'] },
  ),
  prod(
    'dynamic-master',
    'Dynamic',
    'Plenty of headroom: wide dynamics, natural transients',
    {
      macros: { dynamics: 0.3 },
      production: { keywords: ['dynamic', 'natural', 'headroom'], masteringTarget: 'dynamic' },
    },
    { aliases: ['wide dynamics', 'audiophile', 'hi-fi', 'hifi'] },
  ),
  prod(
    'sample-based',
    'Sample-based',
    'Built from loops and chops: repetitive, swung, crate-digging feel',
    {
      rhythm: { swing: 0.2 },
      macros: { repetition: -0.25, humanization: 0.05 },
      production: { keywords: ['sample-based', 'chopped samples', 'crate digging'] },
    },
    { aliases: ['sampled', 'chopped samples', 'sample flip'] },
  ),
  prod(
    'gated-reverb',
    'Gated reverb',
    '80s gated snare: huge, abruptly cut-off drum ambience',
    {
      rhythm: { halfTimeChance: 0.1 },
      macros: { energy: 0.05 },
      production: { keywords: ['gated reverb', 'big snare', '80s drums'], reverb: 0.45 },
    },
    { aliases: ['gated drums', 'gated snare'] },
  ),
  prod(
    'stereo-wide',
    'Wide stereo',
    'Wide, immersive image: doubled guitars, panned layers',
    {
      instruments: { add: [add('electric-guitar-clean', 'rhythm-guitar', 0.5, 'accompaniment')] },
      macros: { density: 0.1 },
      production: { keywords: ['wide stereo', 'immersive', 'doubled'] },
    },
    { aliases: ['immersive', 'spatial'] },
  ),
  prod(
    'mono-vintage',
    'Mono',
    'Old-school mono mix: centered, punchy, narrow',
    {
      macros: { density: -0.1, humanization: 0.1 },
      production: { keywords: ['mono', 'vintage mix', 'narrow'], reverb: 0.15 },
    },
    { aliases: ['mono mix'] },
  ),
  prod(
    'raw',
    'Raw',
    'Unpolished first-take energy: loose, live, unprocessed',
    {
      macros: { humanization: 0.3, complexity: -0.1 },
      production: { keywords: ['raw', 'unpolished', 'first take'], masteringTarget: 'dynamic' },
    },
    { aliases: ['unpolished', 'first take'] },
  ),
  prod(
    'brushed-drums',
    'Brushed drums',
    'Drums played with brushes: soft swishing snare, feathered kick, no crashing',
    {
      instruments: { add: [add('drum-kit', 'drums', 1, 'rhythm', true)], remove: ['electronic-kit'] },
      macros: { energy: -0.1, dynamics: -0.1, humanization: 0.1 },
      production: { keywords: ['brushes', 'brushed drums', 'soft'] },
    },
    { aliases: ['brushes', 'brushed', 'brush kit'] },
  ),
  prod(
    'crisp',
    'Crisp',
    'Bright, clean, tight transients and sparkle',
    {
      macros: { humanization: -0.1, density: -0.05 },
      production: { keywords: ['crisp', 'clean', 'bright'] },
    },
    { aliases: ['sparkly', 'bright mix'] },
  ),
];

// ---------------------------------------------------------------------------------------------
// Vocal tags
// ---------------------------------------------------------------------------------------------

const vox = kindOf('vocal', 'Vocals');

const VOCAL_TAGS: StyleTag[] = [
  vox(
    'falsetto',
    'Falsetto',
    'Light head-voice leads: higher, floaty melodies',
    {
      macros: { melodicMovement: 0.15, energy: -0.05 },
      production: { keywords: ['falsetto', 'head voice'] },
    },
    { aliases: ['head voice'] },
  ),
  vox(
    'rap-verses',
    'Rap verses',
    'Rhythmic spoken-flow verses: flatter melodies, busier syncopated rhythm',
    {
      macros: { melodicMovement: -0.3, syncopation: 0.2, density: 0.1 },
      production: { keywords: ['rap verses', 'rapping'] },
    },
    { aliases: ['rap verse', 'rapping', 'rapped verses', 'with a rap verse'] },
  ),
  vox(
    'choir-vocals',
    'Choir',
    'A choir adds harmony pads and big choruses',
    {
      instruments: { add: [add('choir', 'vocal', 0.9, 'pad', true)] },
      macros: { dynamics: 0.1 },
      production: { keywords: ['choir', 'choral backing'] },
    },
    { aliases: ['choir backing', 'with a choir', 'gospel choir'] },
  ),
  vox(
    'spoken-word',
    'Spoken word',
    'Spoken rather than sung: rhythmic speech over sparse music',
    {
      macros: { melodicMovement: -0.4, density: -0.2 },
      energyShift: -5,
      production: { keywords: ['spoken word', 'poetry'] },
    },
    { aliases: ['spoken', 'poetry', 'narration'] },
  ),
  vox(
    'harmonies',
    'Harmonies',
    'Stacked backing harmonies on the choruses',
    {
      instruments: { add: [add('backing-vocal', 'vocal', 1, 'harmony', true)] },
      macros: { dynamics: 0.1 },
      production: { keywords: ['vocal harmonies', 'stacked vocals'] },
    },
    { aliases: ['vocal harmonies', 'stacked vocals', 'harmony vocals'] },
  ),
  vox(
    'belted',
    'Belted',
    'Full-voiced power singing: big range, loud climaxes',
    {
      macros: { dynamics: 0.2, melodicMovement: 0.15, energy: 0.1 },
      production: { keywords: ['belted vocals', 'powerhouse'] },
    },
    { aliases: ['belting', 'powerhouse vocals', 'diva vocals'] },
  ),
  vox(
    'breathy',
    'Breathy',
    'Airy, close, soft vocal delivery',
    {
      macros: { energy: -0.15, density: -0.1 },
      production: { keywords: ['breathy vocals', 'airy'] },
    },
    { aliases: ['airy vocals', 'soft vocals'] },
  ),
  vox(
    'whispered',
    'Whispered',
    'Hushed, near-whispered delivery over a quiet arrangement',
    {
      macros: { energy: -0.25, dynamics: -0.1, density: -0.15 },
      energyShift: -8,
      production: { keywords: ['whispered', 'hushed'] },
    },
    { aliases: ['whisper', 'hushed'] },
  ),
  vox(
    'gang-vocals',
    'Gang vocals',
    'Shouted group chants on the hooks',
    {
      instruments: { add: [add('backing-vocal', 'vocal', 0.9, 'harmony')] },
      macros: { energy: 0.1, melodicMovement: -0.1 },
      production: { keywords: ['gang vocals', 'group shouts'] },
    },
    { aliases: ['group vocals', 'group shouts', 'chant along'] },
  ),
  vox(
    'screamed',
    'Screamed vocals',
    'Harsh screams for maximum intensity',
    {
      macros: { energy: 0.25, melodicMovement: -0.15 },
      energyShift: 6,
      production: { keywords: ['screamed vocals', 'harsh vocals'] },
    },
    { aliases: ['screaming', 'harsh vocals', 'screams', 'unclean vocals'] },
  ),
  vox(
    'growled',
    'Growled vocals',
    'Guttural death growls',
    {
      macros: { energy: 0.2, melodicMovement: -0.3 },
      production: { keywords: ['growled vocals', 'guttural'] },
    },
    { aliases: ['growls', 'guttural', 'death growl'] },
  ),
  vox(
    'crooned',
    'Crooner',
    'Smooth, intimate crooning with gentle vibrato',
    {
      macros: { energy: -0.1, melodicMovement: 0.05 },
      rhythm: { swing: 0.2 },
      production: { keywords: ['crooner', 'smooth vocals'] },
    },
    { aliases: ['crooning', 'crooned'] },
  ),
  vox(
    'operatic',
    'Operatic vocals',
    'Classically trained, wide-vibrato, soaring',
    {
      macros: { melodicMovement: 0.25, dynamics: 0.2 },
      instruments: { add: [add('string-ensemble', 'strings', 0.4, 'pad')] },
      production: { keywords: ['operatic vocals', 'soprano'] },
    },
    { aliases: ['classical vocals', 'bel canto'] },
  ),
  vox(
    'autotuned',
    'Auto-tuned',
    'Hard pitch-corrected vocals: robotic glides and stepped melodies',
    {
      macros: { humanization: -0.25, melodicMovement: -0.05 },
      production: { keywords: ['autotune', 'pitch corrected'] },
    },
    { aliases: ['autotune', 'auto-tune', 'auto tune', 't-pain'] },
  ),
  vox(
    'vocal-chops',
    'Vocal chops',
    'Pitched, sliced vocal samples used as a hook instrument',
    {
      instruments: { add: [add('synth-lead', 'synth-lead', 0.6, 'hook')] },
      macros: { syncopation: 0.15 },
      production: { keywords: ['vocal chops', 'chopped vocals'] },
    },
    { aliases: ['chopped vocals', 'vocal samples'] },
  ),
  vox(
    'call-and-response',
    'Call and response',
    'Lead lines answered by a group or instrument',
    {
      instruments: { add: [add('backing-vocal', 'vocal', 0.8, 'harmony')] },
      macros: { repetition: -0.2, syncopation: 0.15, melodicMovement: 0.1 },
      production: { keywords: ['call and response'] },
    },
    { aliases: ['call-and-response', 'call & response'] },
  ),
  vox(
    'duet',
    'Duet',
    'Two lead voices trading lines and harmonizing',
    {
      instruments: { add: [add('backing-vocal', 'vocal', 1, 'harmony', true)] },
      macros: { melodicMovement: 0.05 },
      production: { keywords: ['duet', 'two voices'] },
    },
    { aliases: ['two singers'] },
  ),
  vox(
    'scat',
    'Scat singing',
    'Wordless jazz improvisation on syllables',
    {
      rhythm: { swing: 0.5 },
      macros: { melodicMovement: 0.2, complexity: 0.15 },
      production: { keywords: ['scat', 'vocal improvisation'] },
    },
    { aliases: ['scatting'] },
  ),
  vox(
    'a-cappella',
    'A cappella',
    'Voices only: no instruments',
    {
      instruments: {
        add: [add('choir', 'vocal', 1, 'pad', true), add('backing-vocal', 'vocal', 1, 'harmony', true)],
        remove: [
          ...DRUM_KITS,
          'electric-bass',
          'synth-bass',
          '808-bass',
          'upright-bass',
          'electric-guitar-distorted',
          'electric-guitar-clean',
          'acoustic-guitar',
          'piano',
          'electric-piano',
          ...SYNTHS,
          'string-ensemble',
          'organ',
        ],
      },
      production: { keywords: ['a cappella', 'voices only'] },
      macros: { humanization: 0.1 },
    },
    { aliases: ['acapella', 'a capella', 'voices only'] },
  ),
  vox(
    'chanted',
    'Chanted',
    'Repetitive chant-like hooks with narrow melodies',
    {
      macros: { melodicMovement: -0.35, repetition: -0.2 },
      production: { keywords: ['chanted', 'chant'] },
    },
    { aliases: ['chant', 'chanting'] },
  ),
  vox(
    'melismatic',
    'Melismatic runs',
    'Soulful runs and riffs across many notes per syllable',
    {
      macros: { melodicMovement: 0.25, complexity: 0.15 },
      production: { keywords: ['runs', 'riffs', 'melisma'] },
    },
    { aliases: ['vocal runs', 'riffs and runs', 'melisma'] },
  ),
  vox(
    'instrumental-only',
    'Instrumental',
    'No lead vocal: an instrument carries the melody',
    {
      instruments: {
        remove: ['lead-vocal', 'backing-vocal'],
        add: [add('synth-lead', 'synth-lead', 0.3, 'melody')],
      },
      macros: { melodicMovement: 0.1 },
      production: { keywords: ['instrumental'] },
    },
    { aliases: ['no vocals'] },
  ),
  vox(
    'vocoder',
    'Vocoder / talkbox',
    'Robotic vocoder or talkbox voice',
    {
      instruments: { add: [add('synth-lead', 'synth-lead', 0.6, 'hook')] },
      macros: { humanization: -0.15 },
      production: { keywords: ['vocoder', 'talkbox', 'robotic vocals'] },
    },
    { aliases: ['talkbox', 'talk box', 'robot voice'] },
  ),
  vox(
    'yodel',
    'Yodel',
    'Alpine/cowboy yodeling leaps between chest and head voice',
    {
      macros: { melodicMovement: 0.35 },
      production: { keywords: ['yodel'] },
    },
    { aliases: ['yodeling', 'yodelling'] },
  ),
];

// ---------------------------------------------------------------------------------------------
// Region tags
// ---------------------------------------------------------------------------------------------

const place = kindOf('region', 'Places');

const REGION_TAGS: StyleTag[] = [
  place('nashville', 'Nashville', 'Music Row polish: pedal steel, fiddle and clean twang', {
    instruments: {
      add: [
        add('pedal-steel', 'lead-guitar', 0.6, 'counter-melody'),
        add('violin', 'strings', 0.4, 'counter-melody'),
      ],
    },
    macros: { humanization: -0.05 },
    production: { keywords: ['nashville', 'twang'] },
  }),
  place('memphis', 'Memphis', 'Soulful Southern grit: horns, organ and greasy grooves', {
    instruments: { add: [add('organ', 'keys', 0.6, 'pad'), add('brass-section', 'custom', 0.5, 'hook')] },
    rhythm: { swing: 0.15 },
    production: { keywords: ['memphis'] },
  }),
  place(
    'detroit',
    'Detroit',
    'Motor City: tambourine-driven soul and machine-funk techno',
    {
      instruments: {
        add: [add('percussion', 'percussion', 0.6, 'rhythm'), add('synth-pad', 'synth-pad', 0.4, 'pad')],
      },
      macros: { syncopation: 0.1, humanization: -0.1 },
      production: { keywords: ['detroit'] },
    },
    { aliases: ['motor city'] },
  ),
  place('chicago', 'Chicago', 'Electric blues and jacking house: raw, soulful, piano-led', {
    instruments: { add: [add('piano', 'keys', 0.6, 'accompaniment')] },
    rhythm: { swing: 0.12 },
    production: { keywords: ['chicago'] },
  }),
  place(
    'new-orleans',
    'New Orleans',
    'Second-line swing, brass bands and rolling piano',
    {
      rhythm: { swing: 0.45 },
      instruments: {
        add: [add('brass-section', 'custom', 0.7, 'hook'), add('piano', 'keys', 0.5, 'accompaniment')],
      },
      production: { keywords: ['new orleans', 'second line', 'brass band'] },
    },
    { aliases: ['nola', 'big easy'] },
  ),
  place(
    'atlanta',
    'Atlanta',
    'Trap capital: 808s and rattling hi-hats',
    {
      rhythm: { drumStyle: 'trap' },
      instruments: { add: [add('808-bass', 'bass', 0.8, 'bass-line')] },
      production: { keywords: ['atlanta', 'atl'] },
    },
    { aliases: ['atl'] },
  ),
  place(
    'new-york',
    'New York',
    'Gritty city energy: boom-bap, salsa and punk on the same block',
    {
      rhythm: { syncopation: 0.55 },
      macros: { energy: 0.1 },
      production: { keywords: ['new york', 'nyc', 'gritty'] },
    },
    { aliases: ['nyc', 'brooklyn', 'bronx'] },
  ),
  place(
    'los-angeles',
    'Los Angeles',
    'Sunny West Coast gloss: laid-back grooves and session-player polish',
    {
      rhythm: { swing: 0.1 },
      macros: { energy: -0.05, humanization: -0.1 },
      production: { keywords: ['los angeles', 'la', 'west coast'] },
    },
    { aliases: ['hollywood', 'west coast', 'california'] },
  ),
  place(
    'london',
    'London',
    'UK club lineage: garage shuffles, grime basslines, cheeky pop',
    {
      rhythm: { swing: 0.2 },
      macros: { syncopation: 0.1 },
      production: { keywords: ['london', 'uk'] },
    },
    { aliases: ['uk', 'british'] },
  ),
  place(
    'manchester',
    'Manchester',
    'Madchester baggy beats and jangly northern guitars',
    {
      rhythm: { swing: 0.25, drumStyle: 'breakbeat' },
      instruments: { add: [add('electric-guitar-clean', 'rhythm-guitar', 0.6, 'accompaniment')] },
      production: { keywords: ['manchester', 'madchester', 'baggy'] },
    },
    { aliases: ['madchester', 'baggy'] },
  ),
  place('berlin', 'Berlin', 'Warehouse techno and cold synth minimalism', {
    rhythm: { drumStyle: 'techno' },
    macros: { repetition: -0.2, humanization: -0.2 },
    production: { keywords: ['berlin', 'warehouse'] },
  }),
  place(
    'ibiza',
    'Ibiza',
    'Balearic sunsets and festival house',
    {
      rhythm: { drumStyle: 'four-on-floor' },
      instruments: { add: [add('nylon-guitar', 'rhythm-guitar', 0.4, 'accompaniment')] },
      production: { keywords: ['ibiza', 'balearic', 'sunset'] },
    },
    { aliases: ['white isle'] },
  ),
  place(
    'jamaica',
    'Jamaica',
    'Island bass culture: skank, one-drop and sound-system weight',
    {
      rhythm: { compStyle: 'skank' },
      macros: { syncopation: 0.1 },
      production: { keywords: ['jamaica', 'jamaican', 'sound system'] },
    },
    { aliases: ['jamaican', 'kingston'] },
  ),
  place(
    'brazil',
    'Brazil',
    'Samba swing, bossa harmony and carnival percussion',
    {
      instruments: {
        add: [
          add('percussion', 'percussion', 0.7, 'rhythm'),
          add('nylon-guitar', 'rhythm-guitar', 0.5, 'accompaniment'),
        ],
      },
      harmony: { extensionRate: 0.5 },
      production: { keywords: ['brazil', 'brazilian', 'rio'] },
    },
    { aliases: ['rio', 'são paulo', 'sao paulo'] },
  ),
  place(
    'cuba',
    'Cuba',
    'Clave rhythm, montuno piano and Afro-Cuban percussion',
    {
      instruments: { add: [add('percussion', 'percussion', 0.8, 'rhythm')] },
      rhythm: { syncopation: 0.65, compStyle: 'montuno' },
      production: { keywords: ['cuba', 'cuban', 'havana'] },
    },
    { aliases: ['cuban', 'havana'] },
  ),
  place(
    'puerto-rico',
    'Puerto Rico',
    'Reggaetón and salsa homeland: dembow and clave',
    {
      rhythm: { drumStyle: 'dembow' },
      production: { keywords: ['puerto rico', 'boricua'] },
      macros: { syncopation: 0.1 },
    },
    { aliases: ['boricua', 'san juan'] },
  ),
  place(
    'mexico',
    'Mexico',
    'Mariachi trumpets, norteño accordion and corrido guitars',
    {
      instruments: {
        add: [
          add('trumpet', 'custom', 0.5, 'counter-melody'),
          add('accordion', 'keys', 0.4, 'counter-melody'),
        ],
      },
      macros: { energy: 0.1 },
      production: { keywords: ['mexico', 'mexican'] },
    },
    { aliases: ['mexican'] },
  ),
  place(
    'colombia',
    'Colombia',
    'Cumbia, vallenato and champeta: accordion and tropical percussion',
    {
      instruments: {
        add: [
          add('accordion', 'keys', 0.6, 'counter-melody'),
          add('percussion', 'percussion', 0.6, 'rhythm'),
        ],
      },
      rhythm: { syncopation: 0.65 },
      macros: { syncopation: 0.2 },
      production: { keywords: ['colombia', 'colombian'] },
    },
    { aliases: ['colombian', 'medellín', 'medellin'] },
  ),
  place(
    'argentina',
    'Argentina',
    'Tango bandoneon drama and rock nacional',
    {
      instruments: {
        add: [
          add('accordion', 'keys', 0.6, 'counter-melody'),
          add('violin', 'strings', 0.4, 'counter-melody'),
        ],
      },
      modes: md('harmonic-minor:0.3'),
      macros: { dynamics: 0.15 },
      production: { keywords: ['argentina', 'buenos aires'] },
    },
    { aliases: ['argentinian', 'buenos aires'] },
  ),
  place(
    'lagos',
    'Lagos',
    'Afrobeats and highlife bounce',
    {
      rhythm: { drumStyle: 'afrobeats', compStyle: 'highlife' },
      production: { keywords: ['lagos', 'nigeria', 'naija'] },
      macros: { syncopation: 0.1 },
    },
    { aliases: ['nigeria', 'nigerian'] },
  ),
  place(
    'johannesburg',
    'Johannesburg',
    'Amapiano log drums and South African house',
    {
      rhythm: { drumStyle: 'amapiano' },
      instruments: { add: [add('log-drum', 'bass', 0.7, 'bass-line')] },
      production: { keywords: ['johannesburg', 'south africa', 'joburg'] },
    },
    { aliases: ['joburg', 'south africa', 'south african', 'durban'] },
  ),
  place(
    'ghana',
    'Ghana',
    'Highlife guitars and hiplife bounce',
    {
      rhythm: { compStyle: 'highlife' },
      instruments: { add: [add('electric-guitar-clean', 'rhythm-guitar', 0.6, 'accompaniment')] },
      production: { keywords: ['ghana', 'accra'] },
    },
    { aliases: ['ghanaian', 'accra'] },
  ),
  place(
    'seoul',
    'Seoul',
    'K-pop gloss: precision, layered vocals and dance breaks',
    {
      macros: { humanization: -0.2, density: 0.1 },
      instruments: { add: [add('backing-vocal', 'vocal', 0.6, 'harmony')] },
      production: { keywords: ['seoul', 'korea', 'korean'] },
    },
    { aliases: ['korea', 'korean'] },
  ),
  place(
    'tokyo',
    'Tokyo',
    'City-pop sheen and busy J-pop arrangements',
    {
      harmony: { extensionRate: 0.5, harmonicRhythm: 2 },
      macros: { complexity: 0.1 },
      production: { keywords: ['tokyo', 'japan', 'japanese'] },
    },
    { aliases: ['japan', 'japanese'] },
  ),
  place(
    'mumbai',
    'Mumbai',
    'Bollywood strings and dhol grooves',
    {
      instruments: {
        add: [add('string-ensemble', 'strings', 0.6, 'pad'), add('percussion', 'percussion', 0.6, 'rhythm')],
      },
      modes: md('harmonic-minor:0.3'),
      macros: { melodicMovement: 0.15 },
      production: { keywords: ['mumbai', 'bollywood', 'india'] },
    },
    { aliases: ['india', 'bombay'] },
  ),
  place(
    'ireland',
    'Ireland',
    'Fiddle, whistle and bodhrán lilt',
    {
      instruments: {
        add: [add('violin', 'strings', 0.6, 'counter-melody'), add('flute', 'custom', 0.4, 'counter-melody')],
      },
      rhythm: { swing: 0.15 },
      production: { keywords: ['ireland', 'irish', 'dublin'] },
    },
    { aliases: ['dublin', 'scotland', 'scottish', 'highlands'] },
  ),
  place(
    'andalusia',
    'Andalusia',
    'Flamenco guitars, palmas and the Phrygian cadence',
    {
      modes: md('phrygian:0.3 harmonic-minor:0.3'),
      harmony: { progressions: [pr('i VII VI V', 1.5)] },
      instruments: { add: [add('nylon-guitar', 'rhythm-guitar', 0.6, 'accompaniment')] },
      production: { keywords: ['andalusia', 'spain', 'spanish'] },
    },
    { aliases: ['spain', 'seville', 'sevilla', 'madrid'] },
  ),
  place(
    'paris',
    'Paris',
    'Accordion musette and French-touch filter disco',
    {
      instruments: { add: [add('accordion', 'keys', 0.5, 'counter-melody')] },
      harmony: { extensionRate: 0.4 },
      production: { keywords: ['paris', 'france', 'french'] },
    },
    { aliases: ['france', 'french', 'parisian'] },
  ),
  place(
    'scandinavia',
    'Scandinavia',
    'Nordic melancholy pop and icy synths',
    {
      modes: md('minor:0.4'),
      instruments: { add: [add('synth-pad', 'synth-pad', 0.5, 'pad')] },
      macros: { melodicMovement: 0.1 },
      production: { keywords: ['scandinavian', 'nordic', 'swedish pop'] },
    },
    { aliases: ['nordic', 'sweden', 'swedish', 'norway', 'norwegian', 'iceland', 'icelandic'] },
  ),
  place(
    'middle-east',
    'Middle East',
    'Maqam melodies, darbuka and oud colour',
    {
      modes: md('harmonic-minor:0.5 phrygian:0.3'),
      instruments: { add: [add('percussion', 'percussion', 0.6, 'rhythm')] },
      macros: { melodicMovement: 0.1, harmonicTension: 0.1 },
      production: { keywords: ['middle east', 'arabic', 'maqam'] },
    },
    { aliases: ['middle eastern', 'arabian', 'egypt', 'egyptian', 'turkish', 'persian'] },
  ),
  place(
    'appalachia',
    'Appalachia',
    'Mountain modal ballads, banjo and fiddle',
    {
      modes: md('dorian:0.3 mixolydian:0.3'),
      instruments: {
        add: [
          add('banjo', 'rhythm-guitar', 0.6, 'accompaniment'),
          add('violin', 'strings', 0.5, 'counter-melody'),
        ],
      },
      macros: { humanization: 0.15 },
      production: { keywords: ['appalachian', 'mountain'] },
    },
    { aliases: ['appalachian', 'kentucky', 'tennessee'] },
  ),
  place(
    'texas',
    'Texas',
    'Texas swing, blues shuffles and red-dirt twang',
    {
      rhythm: { swing: 0.3 },
      instruments: { add: [add('electric-guitar-lead', 'lead-guitar', 0.5, 'counter-melody')] },
      production: { keywords: ['texas', 'lone star'] },
    },
    { aliases: ['austin', 'houston', 'red dirt'] },
  ),
  place(
    'caribbean-islands',
    'Caribbean',
    'Island rhythm: steel pan, off-beat chops and syncopated percussion',
    {
      instruments: {
        add: [add('steel-pan', 'keys', 0.5, 'hook'), add('percussion', 'percussion', 0.5, 'rhythm')],
      },
      macros: { syncopation: 0.15 },
      production: { keywords: ['caribbean', 'island', 'tropical'] },
    },
    { aliases: ['island', 'tropical', 'trinidad'] },
  ),
  place(
    'hawaii',
    'Hawaii',
    'Slack-key and steel guitar, gentle island sway',
    {
      instruments: { add: [add('pedal-steel', 'lead-guitar', 0.6, 'counter-melody')] },
      macros: { energy: -0.1 },
      production: { keywords: ['hawaii', 'aloha'] },
    },
    { aliases: ['hawaiian islands', 'aloha'] },
  ),
];

// ---------------------------------------------------------------------------------------------
// Rhythm & meter tags
// ---------------------------------------------------------------------------------------------

const groove = kindOf('rhythm', 'Rhythm & meter');

const RHYTHM_TAGS: StyleTag[] = [
  groove(
    'half-time',
    'Half-time',
    'Snare on 3: heavier, slower-feeling groove at the same tempo',
    {
      rhythm: { halfTimeChance: 0.85 },
      macros: { energy: -0.05 },
      production: { keywords: ['half-time'] },
    },
    { aliases: ['halftime', 'half time'] },
  ),
  groove(
    'double-time',
    'Double-time',
    'Twice the pulse: driving, urgent',
    {
      tempo: { shift: 12 },
      rhythm: { halfTimeChance: 0 },
      macros: { energy: 0.2, density: 0.15 },
      production: { keywords: ['double-time'] },
    },
    { aliases: ['double time'] },
  ),
  groove(
    'shuffle-feel',
    'Shuffle',
    'Triplet shuffle: long-short swung eighths',
    {
      rhythm: { swing: 0.62, subdivision: 12 },
      production: { keywords: ['shuffle'] },
    },
    { aliases: ['shuffle', 'shuffle groove', 'triplet shuffle'] },
  ),
  groove(
    'swing',
    'Swing',
    'Swung eighths and a lilt in every part',
    {
      rhythm: { swing: 0.55 },
      macros: { syncopation: 0.1 },
      production: { keywords: ['swing', 'swung'] },
    },
    { aliases: ['swung', 'swing feel'] },
  ),
  groove(
    'straight',
    'Straight feel',
    'Straight, even eighths: no swing',
    {
      rhythm: { swing: 0 },
      macros: { syncopation: -0.15 },
      production: { keywords: ['straight eighths'] },
    },
    { aliases: ['straight eighths', 'even eighths'] },
  ),
  groove(
    'odd-meter',
    'Odd meter',
    'Asymmetric time signatures (5/4, 7/8) keep the listener guessing',
    {
      meters: [m54, m78],
      macros: { complexity: 0.15 },
      production: { keywords: ['odd time', 'odd meter'] },
    },
    { aliases: ['odd time', 'odd time signature', 'odd time signatures', 'irregular meter'] },
  ),
  groove(
    'five-four',
    '5/4 time',
    'Five beats to the bar (3+2)',
    {
      meters: [{ numerator: 5, denominator: 4, weight: 4 }],
      production: { keywords: ['5/4'] },
    },
    { aliases: ['five four', 'in five', 'quintuple meter'] },
  ),
  groove(
    'seven-eight',
    '7/8 time',
    'Seven eighths (2+2+3): limping, propulsive',
    {
      meters: [{ numerator: 7, denominator: 8, weight: 4 }],
      production: { keywords: ['7/8'] },
    },
    { aliases: ['seven eight', 'in seven'] },
  ),
  groove(
    'waltz',
    'Waltz',
    'Three-four time: strong downbeat, two light beats',
    {
      meters: [{ numerator: 3, denominator: 4, weight: 4 }],
      production: { keywords: ['waltz', '3/4'] },
    },
    { aliases: ['3/4', 'three four', 'triple meter'] },
  ),
  groove(
    'six-eight',
    '6/8 feel',
    'Compound two-beat feel: rolling triplets',
    {
      meters: [{ numerator: 6, denominator: 8, weight: 4 }],
      production: { keywords: ['6/8', 'compound time'] },
    },
    { aliases: ['6/8', 'compound', 'compound time', 'jig'] },
  ),
  groove(
    'twelve-eight',
    '12/8 feel',
    'Slow-blues/soul-ballad triplet feel',
    {
      meters: [{ numerator: 12, denominator: 8, weight: 4 }],
      production: { keywords: ['12/8'] },
    },
    { aliases: ['12/8', 'twelve eight'] },
  ),
  groove(
    'polyrhythmic',
    'Polyrhythmic',
    'Layered cross-rhythms: 3 against 2, interlocking parts',
    {
      meters: [{ numerator: 12, denominator: 8, weight: 0.5 }],
      macros: { complexity: 0.2, syncopation: 0.25 },
      rhythm: { syncopation: 0.75 },
      production: { keywords: ['polyrhythmic', 'cross-rhythms'] },
    },
    { aliases: ['polyrhythm', 'polyrhythms', 'cross-rhythm', 'cross-rhythms'] },
  ),
  groove(
    'four-on-the-floor',
    'Four on the floor',
    'Kick on every beat: steady dance pulse',
    {
      rhythm: { drumStyle: 'four-on-floor' },
      production: { keywords: ['four on the floor'] },
      macros: { syncopation: -0.05 },
    },
    { aliases: ['4 on the floor', '4/4 kick', 'four-to-the-floor'] },
  ),
  groove(
    'breakbeat-drums',
    'Breakbeat drums',
    'Syncopated chopped breaks instead of a straight beat',
    {
      rhythm: { drumStyle: 'breakbeat' },
      macros: { syncopation: 0.15 },
      production: { keywords: ['breakbeat'] },
    },
    { aliases: ['chopped breaks', 'amen break'] },
  ),
  groove(
    'syncopated',
    'Syncopated',
    'Off-beat accents and anticipations everywhere',
    {
      rhythm: { syncopation: 0.75 },
      macros: { syncopation: 0.25 },
      production: { keywords: ['syncopated'] },
    },
    { aliases: ['offbeat', 'off-beat accents'] },
  ),
  groove(
    'laid-back',
    'Behind the beat',
    'Lazy, late-sitting groove: relaxed and human',
    {
      tempo: { shift: -4 },
      rhythm: { swing: 0.2 },
      macros: { humanization: 0.25, energy: -0.1 },
      production: { keywords: ['behind the beat', 'laid back groove'] },
    },
    { aliases: ['behind the beat', 'lazy groove'] },
  ),
  groove(
    'driving',
    'Driving rhythm',
    'Relentless eighth-note momentum',
    {
      rhythm: { bassStyle: 'eighths' },
      macros: { energy: 0.15, syncopation: -0.1 },
      production: { keywords: ['driving'] },
    },
    { aliases: ['propulsive', 'driving beat', 'driving groove', 'driving eighths'] },
  ),
  groove(
    'motorik',
    'Motorik',
    'Krautrock autobahn beat: steady, hypnotic, unchanging',
    {
      rhythm: { drumStyle: 'indie', bassStyle: 'eighths' },
      macros: { repetition: -0.25 },
      production: { keywords: ['motorik'] },
    },
    { aliases: ['motorik beat', 'apache beat'] },
  ),
  groove(
    'triplet-flow',
    'Triplet feel',
    'Triplets in the hats and melody: rolling, Migos-style flow',
    {
      rhythm: { subdivision: 12, swing: 0.33 },
      macros: { syncopation: 0.1 },
      production: { keywords: ['triplet flow', 'triplets'] },
    },
    { aliases: ['triplets', 'triplet flow', 'migos flow'] },
  ),
  groove(
    'blast-beats',
    'Blast beats',
    'Extreme-metal 16th blasting at high tempo',
    {
      rhythm: { drumStyle: 'metal' },
      tempo: { shift: 30 },
      macros: { energy: 0.3, density: 0.2 },
      energyShift: 8,
      production: { keywords: ['blast beats'] },
    },
    { aliases: ['blastbeats', 'blast beat'] },
  ),
  groove(
    'clave',
    'Clave',
    'Built on the clave: 3-2 / 2-3 son-clave syncopation',
    {
      rhythm: { drumStyle: 'salsa', syncopation: 0.7 },
      instruments: { add: [add('percussion', 'percussion', 0.7, 'rhythm')] },
      production: { keywords: ['clave', 'son clave'] },
    },
    { aliases: ['son clave', '3-2 clave', '2-3 clave', 'rumba clave'] },
  ),
  groove(
    'tresillo',
    'Tresillo',
    '3+3+2 syncopation in bass and chords',
    {
      rhythm: { compStyle: 'highlife', syncopation: 0.7 },
      macros: { syncopation: 0.2 },
      production: { keywords: ['tresillo', '3-3-2'] },
    },
    { aliases: ['3-3-2', '3+3+2', 'habanera'] },
  ),
  groove(
    'stomp-clap',
    'Stomp-clap',
    'Foot-stomp kick and handclap backbeat',
    {
      rhythm: { drumStyle: 'folk' },
      instruments: { add: [add('percussion', 'percussion', 0.8, 'rhythm')] },
      macros: { syncopation: -0.1 },
      production: { keywords: ['stomp clap', 'handclaps'] },
    },
    { aliases: ['stomp and clap', 'handclaps', 'stomps and claps'] },
  ),
  groove(
    'beatless',
    'Beatless',
    'No drums at all: free-floating time',
    {
      instruments: { remove: [...DRUM_KITS, 'percussion'] },
      macros: { energy: -0.15 },
      production: { keywords: ['beatless', 'no drums'] },
    },
    { aliases: ['no drums', 'drumless', 'without drums'] },
  ),
  groove(
    'bouncy',
    'Bouncy',
    'Springy, swung, off-beat-heavy groove',
    {
      rhythm: { swing: 0.2 },
      macros: { syncopation: 0.2, energy: 0.05 },
      production: { keywords: ['bouncy'] },
    },
    { aliases: ['springy'] },
  ),
];

// ---------------------------------------------------------------------------------------------

export const TAG_CATALOG: StyleTag[] = [
  ...ROCK_TAGS,
  ...METAL_TAGS,
  ...PUNK_TAGS,
  ...POP_TAGS,
  ...INDIE_TAGS,
  ...ELECTRONIC_TAGS,
  ...URBAN_TAGS,
  ...ROOTS_TAGS,
  ...CLASSICAL_TAGS,
  ...SPECIAL_TAGS,
  ...MOOD_TAGS,
  ...ERA_TAGS,
  ...PRODUCTION_TAGS,
  ...VOCAL_TAGS,
  ...REGION_TAGS,
  ...RHYTHM_TAGS,
];
