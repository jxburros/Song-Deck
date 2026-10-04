/**
 * Drum generator (spec §16 "Drums"): groove families per genre, kick/snare relationships, hats vs
 * ride by energy, crashes on section downbeats, fills before section changes (intensity by energy),
 * EDM build-up rolls, ghost notes with complexity, half-time/double-time feels, swing, accents and
 * humanization. 4/4 uses idiomatic 16-step templates; other meters are built from beat groupings.
 */
import type { DrumStyle } from '../../ir/types';
import { GM_DRUM as D } from '../../ir/gm';
import { PPQ } from '../../ir/types';
import type { Rng } from '../../util/random';
import type { Cell } from '../context';
import {
  applySwing,
  clamp01,
  humanize,
  toVelocity,
  type BarInfo,
  type MeterInfo,
  type RawNote,
} from '../util';

type Level = 'low' | 'mid' | 'high';
type Timekeeper = 'hat' | 'ride' | 'crash' | 'open-hat' | 'floor-tom' | 'china' | 'none';
type FillKind =
  | 'snare'
  | 'toms'
  | 'mixed'
  | 'triplet'
  | 'electronic'
  | 'jazz'
  | 'orchestral'
  | 'sparse'
  | 'build'
  | 'timbales';

interface Groove {
  k: string;
  s: string;
  h: string;
  tk?: Timekeeper;
  extra?: [number, string][];
}

interface StyleDef {
  low: Groove[];
  mid: Groove[];
  high: Groove[];
  half: Groove[];
  fills: FillKind[];
  ghosts: boolean;
  hat16: boolean;
  ride: boolean;
  electronic?: boolean;
  sideStickLow?: boolean;
  kick?: number;
  /** Groove family uses its own engine (jazz ride patterns). */
  special?: 'jazz';
  /** Idiomatic pattern: no random syncopated kicks or extra ghost notes (one-drop, dembow, clave grooves). */
  strict?: boolean;
  /** Minimum 8th-note swing regardless of the genre (shuffle). */
  swing8?: number;
}

const G = (k: string, s: string, h: string, tk?: Timekeeper, extra?: [number, string][]): Groove => ({
  k,
  s,
  h,
  ...(tk ? { tk } : {}),
  ...(extra ? { extra } : {}),
});
const EIGHTHS = 'x.x.x.x.x.x.x.x.';
const ROCK_HALF = G('x.........x.....', '........X.......', EIGHTHS);

/*
 * Template rows are 16 steps per 4/4 bar (32 for two-bar patterns such as clave grooves; a row is
 * read at `bar.index % (length / 16)`). Kick: x / X (accent). Snare: x / X, g (ghost), r
 * (cross-stick), c (clap only). Timekeeper: x / X, o (open hat), y (soft), p (pedal hat).
 */
const SIXTEENTHS = 'xxxxxxxxxxxxxxxx';
const OFFBEATS = '..o...o...o...o.';
const DEMBOW_S = '...x..x....x..x.';
const CLAVE_23 = '....x...x.......x.....x.....x...';
const TUMBAO_MUTE = '....x.......x...';

const STYLES: Record<DrumStyle, StyleDef> = {
  rock: {
    low: [
      G('x.......x.......', '....x.......x...', EIGHTHS),
      G('x.......x.x.....', '....x.......x...', EIGHTHS),
    ],
    mid: [
      G('x.....x.x.x.....', '....x.......x...', EIGHTHS),
      G('x.......x.x...x.', '....x.......x...', EIGHTHS),
    ],
    high: [
      G('x.x...x.x.x.....', '....X.......X...', 'X.x.X.x.X.x.X.x.', 'ride'),
      G('x.....x.x.x...x.', '....X.......X...', 'X.x.X.x.X.x.X.x.', 'ride'),
    ],
    half: [ROCK_HALF],
    fills: ['toms', 'mixed', 'snare'],
    ghosts: true,
    hat16: false,
    ride: true,
  },
  punk: {
    low: [G('x.......x.x.....', '....x.......x...', EIGHTHS)],
    mid: [G('x.x...x.x.x...x.', '....x.......x...', EIGHTHS)],
    high: [
      G('x...x...x...x...', '..x...x...x...x.', 'X...X...X...X...', 'crash'),
      G('x...x...x...x...', '..X...X...X...X.', 'X.x.X.x.X.x.X.x.', 'ride'),
    ],
    half: [ROCK_HALF],
    fills: ['snare', 'toms', 'mixed'],
    ghosts: false,
    hat16: false,
    ride: true,
  },
  'pop-punk': {
    low: [
      G('x.....x...x.....', '....x.......x...', EIGHTHS),
      G('x.......x.x.....', '....x.......x...', EIGHTHS, 'floor-tom'),
    ],
    mid: [
      G('x.x.x.x.x.x.x.x.', '....x.......x...', EIGHTHS),
      G('x.....x.x.x.....', '....x.......x...', 'o.x.o.x.o.x.o.x.'),
    ],
    high: [
      G('x...x...x...x...', '..x...x...x...x.', 'X.x.X.x.X.x.X.x.', 'ride'),
      G('x.x...x.x.x...x.', '....X.......X...', 'o.o.o.o.o.o.o.o.', 'open-hat'),
    ],
    half: [G('x.......x.x.....', '........X.......', EIGHTHS)],
    fills: ['toms', 'snare', 'mixed'],
    ghosts: true,
    hat16: false,
    ride: true,
  },
  emo: {
    low: [
      G('x.......x.......', '....g.......x...', EIGHTHS, 'floor-tom'),
      G('x.....x.........', '....x.......x...', 'x...x...x...x...', 'ride'),
    ],
    mid: [G('x.x...x.x.x.....', '....x.......x...', EIGHTHS)],
    high: [
      G('x...x...x...x...', '..x...x...x...x.', 'X.x.X.x.X.x.X.x.', 'ride'),
      G('x.....x.x.x...x.', '....X.......X...', 'X.X.X.X.X.X.X.X.', 'crash'),
    ],
    half: [G('x.......x.x.....', '........X.......', EIGHTHS)],
    fills: ['toms', 'mixed', 'snare'],
    ghosts: true,
    hat16: false,
    ride: true,
  },
  metal: {
    low: [
      G('x.xxx.xxx.xxx.xx', '....x.......x...', 'x...x...x...x...'),
      G('x.x.x.x.x.x.x.x.', '....x.......x...', EIGHTHS),
    ],
    mid: [
      G('x.x.x.x.x.x.x.x.', '....x.......x...', EIGHTHS),
      G('x.xxx.xxx.xxx.xx', '....x.......x...', EIGHTHS, 'ride'),
    ],
    high: [
      G('xxxxxxxxxxxxxxxx', '....X.......X...', 'X...X...X...X...', 'ride'),
      G('xxxxxxxxxxxxxxxx', '....X.......X...', 'X.x.X.x.X.x.X.x.', 'china'),
    ],
    half: [G('x..x..x...x..x..', '........X.......', 'x...x...x...x...', 'china')],
    fills: ['toms', 'mixed', 'snare'],
    ghosts: false,
    hat16: false,
    ride: true,
  },
  indie: {
    low: [
      G('x...x...x...x...', '....x.......x...', EIGHTHS),
      G('x.......x.......', '....x.......x...', EIGHTHS),
    ],
    mid: [
      G('x...x...x...x...', '....x.......x...', 'xxxxxxxxxxxxxxxx'),
      G('x.....x.x.......', '....x.......x...', EIGHTHS, 'floor-tom'),
    ],
    high: [
      G('x...x.x.x...x.x.', '....X.......X...', 'X.x.X.x.X.x.X.x.', 'ride'),
      G('x...x...x...x...', '....X.......X...', EIGHTHS, 'floor-tom'),
    ],
    half: [ROCK_HALF],
    fills: ['toms', 'snare'],
    ghosts: true,
    hat16: true,
    ride: true,
  },
  pop: {
    low: [
      G('x.......x.......', '....x.......x...', EIGHTHS),
      G('x.......x.x.....', '....x.......x...', EIGHTHS),
    ],
    mid: [
      G('x......xx.......', '....x.......x...', EIGHTHS),
      G('x.....x.x.......', '....x.......x...', 'xxxxxxxxxxxxxxxx'),
    ],
    high: [
      G('x......xx.x.....', '....X.......X...', 'xxxxxxxxxxxxxxxx'),
      G('x.....x.x.x.....', '....X.......X...', 'x.o.x.o.x.o.x.o.'),
    ],
    half: [G('x.......x.......', '........X.......', EIGHTHS)],
    fills: ['snare', 'toms', 'mixed'],
    ghosts: true,
    hat16: true,
    ride: false,
    sideStickLow: true,
  },
  'synth-pop': {
    low: [G('x...x...x...x...', '....x.......x...', '..x...x...x...x.')],
    mid: [
      G('x...x...x...x...', '....x.......x...', 'xxxxxxxxxxxxxxxx'),
      G('x.....x.x.......', '....x.......x...', EIGHTHS),
    ],
    high: [G('x...x...x...x...', '....X.......X...', 'x.o.x.o.x.o.x.o.')],
    half: [G('x.......x.......', '........x.......', EIGHTHS)],
    fills: ['electronic', 'snare'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
  },
  'four-on-floor': {
    low: [G('x...x...x...x...', '................', '..o...o...o...o.')],
    mid: [G('x...x...x...x...', '....x.......x...', 'x.o.x.o.x.o.x.o.')],
    high: [G('x...x...x...x...', '....X.......X...', 'xxoxxxoxxxoxxxox')],
    half: [G('x.......x.......', '........x.......', '..o...o...o...o.')],
    fills: ['electronic'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
  },
  trance: {
    low: [G('x...x...x...x...', '................', '..o...o...o...o.')],
    mid: [G('x...x...x...x...', '....x.......x...', 'x.o.x.o.x.o.x.o.')],
    high: [G('x...x...x...x...', '....x.......x...', 'xxoxxxoxxxoxxxox')],
    half: [G('x.......x.......', '................', '..o...o...o...o.')],
    fills: ['electronic'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
  },
  'hip-hop': {
    low: [G('x.........x.....', '....x.......x...', EIGHTHS)],
    mid: [
      G('x......x..x.....', '....x.......x...', EIGHTHS),
      G('x.x.......x..x..', '....x.......x...', EIGHTHS),
    ],
    high: [G('x.x....x..x..x..', '....X.......X...', EIGHTHS)],
    half: [G('x.........x.....', '........x.......', EIGHTHS)],
    fills: ['sparse', 'electronic'],
    ghosts: true,
    hat16: true,
    ride: false,
    electronic: true,
  },
  trap: {
    low: [G('x.........x.....', '........x.......', EIGHTHS)],
    mid: [G('x......x..x.....', '........X.......', 'xxxxxxxxxxxxxxxx')],
    high: [
      G('x.....x...x..x..', '........X.......', 'xxxxxxxxxxxxxxxx'),
      G('x..x......x.x...', '........X.......', 'xxxxxxxxxxxxxxxx'),
    ],
    half: [G('x.........x.....', '........x.......', EIGHTHS)],
    fills: ['sparse', 'electronic'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
  },
  rnb: {
    low: [G('x.........x.....', '....x.......x...', EIGHTHS)],
    mid: [G('x......x.x......', '....x.......x...', 'xxxxxxxxxxxxxxxx')],
    high: [G('x..x...x.x......', '....X.......X...', 'xxxxxxxxxxxxxxxx')],
    half: [G('x.........x.....', '........x.......', EIGHTHS)],
    fills: ['sparse', 'snare'],
    ghosts: true,
    hat16: true,
    ride: false,
    sideStickLow: true,
  },
  'jazz-swing': {
    low: [G('x.......x.......', '................', 'x...x.x.x...x.x.', 'ride')],
    mid: [G('x.......x.......', '................', 'x...x.x.x...x.x.', 'ride')],
    high: [G('x...x...x...x...', '................', 'x...x.x.x...x.x.', 'ride')],
    half: [G('x...............', '................', 'x...x...x...x...', 'ride')],
    fills: ['jazz'],
    ghosts: true,
    hat16: false,
    ride: true,
    special: 'jazz',
  },
  folk: {
    low: [G('x.......x.......', '....x.......x...', 'x...x...x...x...')],
    mid: [G('x.......x.x.....', '....x.......x...', EIGHTHS)],
    high: [G('x.....x.x.......', '....X.......X...', EIGHTHS, 'hat', [[D.TAMBOURINE, EIGHTHS]])],
    half: [G('x...............', '........x.......', 'x...x...x...x...')],
    fills: ['snare', 'toms'],
    ghosts: false,
    hat16: false,
    ride: false,
    sideStickLow: true,
  },
  country: {
    low: [G('x.......x.......', '....x.......x...', EIGHTHS)],
    mid: [
      G('x.......x.......', '....x.......x...', EIGHTHS),
      G('x.....x.x.......', '....x.......x...', EIGHTHS),
    ],
    high: [
      G('x.......x.......', 'ggggXgggggggXggg', '................', 'none'),
      G('x.......x.x.....', '....X.......X...', EIGHTHS),
    ],
    half: [G('x.......x.......', '....x.......x...', 'x...x...x...x...')],
    fills: ['snare', 'toms'],
    ghosts: false,
    hat16: false,
    ride: true,
    sideStickLow: true,
  },
  orchestral: {
    low: [G('x...............', '................', '................', 'none')],
    mid: [G('x.......x.......', '................', '................', 'none')],
    high: [
      G('x.......x.......', '................', '................', 'none', [
        [D.TOM_LOW, 'x...x...x...x...'],
      ]),
    ],
    half: [G('x...............', '................', '................', 'none')],
    fills: ['orchestral'],
    ghosts: false,
    hat16: false,
    ride: false,
    kick: D.KICK_ACOUSTIC,
  },
  cinematic: {
    low: [
      G('x.......x.......', '................', '................', 'none', [
        [D.FLOOR_TOM_LOW, 'x.......x.......'],
      ]),
    ],
    mid: [
      G('x.......x.......', '................', '................', 'none', [
        [D.FLOOR_TOM_HIGH, 'x.xx.xx.x.xx.xx.'],
        [D.FLOOR_TOM_LOW, 'x.......x.......'],
      ]),
    ],
    high: [
      G('x...x...x...x...', '....X.......X...', '................', 'none', [
        [D.FLOOR_TOM_HIGH, 'xxxxxxxxxxxxxxxx'],
        [D.FLOOR_TOM_LOW, 'X..X..X.X..X..X.'],
      ]),
    ],
    half: [
      G('x.......x.......', '........X.......', '................', 'none', [
        [D.FLOOR_TOM_LOW, 'x..x..x.x..x..x.'],
      ]),
    ],
    fills: ['toms', 'orchestral'],
    ghosts: false,
    hat16: false,
    ride: false,
    kick: D.KICK_ACOUSTIC,
  },
  // --- Groove families added with the genre expansion -------------------------------------------
  funk: {
    // Syncopated 16th kick, ghosted snare between the backbeats, 16th hats with an open-hat lift.
    low: [
      G('x.........x.....', '....x..g.g..x...', EIGHTHS),
      G('x.x.......x.....', '....x.......x..g', EIGHTHS),
    ],
    mid: [
      G('x.x.......x..x..', '....x..g.g..x..g', SIXTEENTHS),
      G('x..x..x...x.....', '....x..g....x.g.', SIXTEENTHS),
    ],
    high: [
      G('x.x...x...xx..x.', '....X..g.g..X..g', 'x.xxx.xxx.xxx.xo'),
      G('x..x..x...x..x..', '....X..g.g.gX..g', 'x.xxx.xxx.xxx.xo'),
    ],
    half: [G('x.........x.....', '........X.......', EIGHTHS)],
    fills: ['snare', 'toms', 'mixed'],
    ghosts: true,
    hat16: true,
    ride: false,
  },
  disco: {
    // Four on the floor, snare on 2 & 4, open hat on every off-beat.
    low: [G('x...x...x...x...', '................', OFFBEATS)],
    mid: [G('x...x...x...x...', '....x.......x...', 'x.o.x.o.x.o.x.o.')],
    high: [
      G('x...x...x...x...', '....X.......X...', 'xxoxxxoxxxoxxxox'),
      G('x...x...x...x...', '....X.......X...', 'x.o.x.o.x.o.x.o.'),
    ],
    half: [G('x.......x.......', '........x.......', EIGHTHS)],
    fills: ['toms', 'snare'],
    ghosts: false,
    hat16: true,
    ride: false,
    strict: true,
  },
  soul: {
    // Motown: backbeat with tambourine, snare on all four beats when the chorus lifts.
    low: [G('x.......x.......', '....x.......x...', EIGHTHS)],
    mid: [G('x.....x.x.......', '....x.......x...', EIGHTHS, 'hat', [[D.TAMBOURINE, '....x.......x...']])],
    high: [
      G('x.....x.x.....x.', 'X...X...X...X...', EIGHTHS, 'hat', [[D.TAMBOURINE, 'x.x.x.x.x.x.x.x.']]),
      G('x.....x.x.......', '....X.......X...', EIGHTHS, 'hat', [[D.TAMBOURINE, '....x.......x...']]),
    ],
    half: [G('x.........x.....', '........x.......', EIGHTHS)],
    fills: ['snare', 'toms'],
    ghosts: true,
    hat16: false,
    ride: true,
    sideStickLow: true,
  },
  gospel: {
    // Church backbeat: heavy 2 & 4, busy kick pickups, ghost-note chops and ride/crash choruses.
    low: [G('x.......x.x.....', '....x.......x...', EIGHTHS)],
    mid: [
      G('x..x....x.x.....', '....x..g....x.g.', SIXTEENTHS),
      G('x.....x.x.x.....', '....x.......x.gg', EIGHTHS),
    ],
    high: [
      G('x..x..x.x.x...x.', '....X..g.g..X.gg', 'X.x.X.x.X.x.X.x.', 'ride'),
      G('x.x...x.x..x..x.', '....X..g....X.gg', 'X.x.X.x.X.x.X.x.', 'crash'),
    ],
    half: [G('x.........x.....', '........X.......', EIGHTHS)],
    fills: ['mixed', 'toms', 'snare'],
    ghosts: true,
    hat16: true,
    ride: true,
  },
  shuffle: {
    // Blues/rock shuffle: swung eighths on hat or ride, backbeat, kick on 1 and 3.
    low: [G('x.......x.......', '....x.......x...', EIGHTHS)],
    mid: [
      G('x.....x.x.......', '....x.......x...', EIGHTHS),
      G('x.......x.....x.', '....x.......x...', EIGHTHS),
    ],
    high: [G('x...x...x...x...', '....X.......X...', 'X.x.X.x.X.x.X.x.', 'ride')],
    half: [ROCK_HALF],
    fills: ['triplet', 'snare'],
    ghosts: true,
    hat16: false,
    ride: true,
    swing8: 0.62,
  },
  'boom-bap': {
    // Dusty sampled-break feel: hard snare on 2 & 4, lazy kick doubles, an open hat before the turnaround.
    low: [G('x.........x.....', '....x.......x...', EIGHTHS)],
    mid: [
      G('x......x..x.....', '....x.......x...', EIGHTHS),
      G('x.........x..x..', '....x.......x...', EIGHTHS),
    ],
    high: [G('x.x....x..x..x..', '....X.......X...', EIGHTHS, 'hat', [[D.HIHAT_OPEN, '..............x.']])],
    half: [G('x.........x.....', '........x.......', EIGHTHS)],
    fills: ['sparse', 'snare'],
    ghosts: true,
    hat16: false,
    ride: false,
  },
  'one-drop': {
    // Reggae: beat 1 is empty; kick and cross-stick drop together on beat 3. Steppers kick at high energy.
    low: [G('........x.......', '........r.......', EIGHTHS)],
    mid: [
      G('........x.......', '........r.......', 'x.x.x.x.x.xxx.x.'),
      G('........x.......', '........x.......', EIGHTHS, 'hat', [[D.HIHAT_OPEN, '..............x.']]),
    ],
    high: [
      G('x...x...x...x...', '........X.......', EIGHTHS),
      G('........x.......', '........X.......', 'x.x.x.xxx.x.x.xx'),
    ],
    half: [G('........x.......', '........r.......', 'x...x...x...x...')],
    fills: ['toms', 'snare'],
    ghosts: false,
    hat16: false,
    ride: false,
    strict: true,
  },
  ska: {
    // Fast two-beat: kick on 1 & 3, rim or snare on 2 & 4, hats on the off-beats with the skank.
    low: [G('x.......x.......', '....r.......r...', '..x...x...x...x.')],
    mid: [G('x.......x.......', '....x.......x...', OFFBEATS)],
    high: [G('x...x...x...x...', '....X.......X...', 'x.o.x.o.x.o.x.o.')],
    half: [G('x...............', '........x.......', '..x...x...x...x.')],
    fills: ['snare', 'toms'],
    ghosts: false,
    hat16: false,
    ride: false,
    strict: true,
  },
  dembow: {
    // Reggaetón / dancehall: kick on every beat, snare on the "a" of 1 and the "and" of 2 (and again in 3–4).
    low: [G('x.......x.......', DEMBOW_S, '................', 'none')],
    mid: [G('x...x...x...x...', DEMBOW_S, '..x...x...x...x.')],
    high: [
      G('x...x...x...x...', DEMBOW_S, EIGHTHS),
      G('x...x...x...x...', DEMBOW_S, SIXTEENTHS, 'hat', [[D.TIMBALE_HIGH, '..............xx']]),
    ],
    half: [G('x.......x.......', '...x..x.........', '..x...x...x...x.')],
    fills: ['sparse', 'electronic'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
    strict: true,
  },
  'bossa-nova': {
    // Two-bar bossa clave on the cross-stick, surdo-like kick (1, "and" of 2, 3, "and" of 4), brushed eighths.
    low: [G('x.....x.x.....x.', 'r.....r.....r.......r.....r.....', EIGHTHS)],
    mid: [G('x.....x.x.....x.', 'r.....r.....r.......r.....r.....', SIXTEENTHS)],
    high: [G('x.....x.x.....x.', 'r.....r.....r.......r.....r.....', 'x.x.x.x.x.x.x.x.', 'ride')],
    half: [G('x.......x.......', 'r.....r.....r.......r.....r.....', EIGHTHS)],
    fills: ['snare'],
    ghosts: false,
    hat16: true,
    ride: true,
    strict: true,
  },
  samba: {
    // Surdo kick pattern, tamborim-style cross-stick figure, driving 16ths, agogô bells when it lifts.
    low: [G('x..xx..xx..xx..x', 'r.r..r.r.r.r..r.r.r..r.r..r.r.r.', SIXTEENTHS)],
    mid: [
      G('x..xx..xx..xx..x', 'r.r..r.r.r.r..r.r.r..r.r..r.r.r.', SIXTEENTHS, 'hat', [
        [D.AGOGO_HIGH, 'x.x...x.x.x...x.'],
        [D.AGOGO_LOW, '....x.......x...'],
      ]),
    ],
    high: [
      G('x..xx..xx..xx..x', 'x.x..x.x.x.x..x.x.x..x.x..x.x.x.', SIXTEENTHS, 'hat', [
        [D.AGOGO_HIGH, 'x.x...x.x.x...x.'],
        [D.AGOGO_LOW, '....x.......x...'],
      ]),
    ],
    half: [G('x.......x.......', 'r.....r.....r...', EIGHTHS)],
    fills: ['snare', 'timbales'],
    ghosts: false,
    hat16: true,
    ride: false,
    strict: true,
  },
  salsa: {
    // 2-3 son clave, cascara on the shell (ride), conga tumbao, bongo bell (cowbell) in the montuno.
    low: [
      G('......x.....x...', '................', '....x...x.......x.....x.....x...', 'ride', [
        [D.CLAVES, CLAVE_23],
        [D.CONGA_MUTE, TUMBAO_MUTE],
        [D.CONGA_LOW, '............x.x.'],
      ]),
    ],
    mid: [
      G('......x.....x...', '................', '....x...x.......x.....x.....x...', 'ride', [
        [D.CLAVES, CLAVE_23],
        [D.CONGA_MUTE, TUMBAO_MUTE],
        [D.CONGA_HIGH, '............x.x.'],
        [D.TIMBALE_LOW, '..............x.'],
      ]),
    ],
    high: [
      G('......x.....x...', '................', '................', 'none', [
        [D.CLAVES, CLAVE_23],
        [D.COWBELL, 'X...x...X...x...'],
        [D.CONGA_MUTE, TUMBAO_MUTE],
        [D.CONGA_HIGH, '............x.x.'],
        [D.CONGA_LOW, '..............x.'],
      ]),
    ],
    half: [G('x.......x.......', '................', 'x...x...x...x...', 'ride', [[D.CLAVES, CLAVE_23]])],
    fills: ['timbales'],
    ghosts: false,
    hat16: false,
    ride: true,
    strict: true,
  },
  cumbia: {
    // Kick on 1 & 3, snare on the off-beats of 2 and 4, güiro "ch-chk-chk" over everything.
    low: [
      G('x.......x.......', '......x.......x.', '................', 'none', [
        [D.GUIRO_LONG, 'x...x...x...x...'],
        [D.GUIRO_SHORT, '..xx..xx..xx..xx'],
      ]),
    ],
    mid: [
      G('x.......x.......', '......x.......x.', EIGHTHS, 'hat', [
        [D.GUIRO_LONG, 'x...x...x...x...'],
        [D.GUIRO_SHORT, '..xx..xx..xx..xx'],
      ]),
    ],
    high: [
      G('x...x...x...x...', '....x.x.....x.x.', EIGHTHS, 'hat', [
        [D.GUIRO_LONG, 'x...x...x...x...'],
        [D.GUIRO_SHORT, '..xx..xx..xx..xx'],
        [D.COWBELL, '..x...x...x...x.'],
      ]),
    ],
    half: [
      G('x.......x.......', '..............x.', '................', 'none', [
        [D.GUIRO_LONG, 'x...x...x...x...'],
      ]),
    ],
    fills: ['timbales', 'snare'],
    ghosts: false,
    hat16: false,
    ride: false,
    strict: true,
  },
  afrobeats: {
    // 3+3+2 kick, rim clicks on the off-beats, clap on 2 & 4, rolling 16th hats, congas when it lifts.
    low: [G('x.....x.........', '....r.......r...', SIXTEENTHS)],
    mid: [G('x.....x...x.....', '...r..r....r..r.', 'x.xxx.xxx.xxx.xx')],
    high: [
      G('x.....x...x...x.', '....c..r....c..r', SIXTEENTHS, 'hat', [
        [D.CONGA_HIGH, '..x..x....x..x..'],
        [D.CONGA_LOW, 'x.....x.........'],
      ]),
    ],
    half: [G('x.........x.....', '........c.......', EIGHTHS)],
    fills: ['sparse', 'electronic'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
  },
  amapiano: {
    // Deep, unhurried house: kick, shaker-like 16ths, syncopated rim/clap figures, open-hat lifts.
    low: [
      G('x.......x.......', '....c.......c...', 'yxyxyxyxyxyxyxyx', 'hat', [
        [D.SIDE_STICK, '...x..x....x....'],
      ]),
    ],
    mid: [
      G('x...x...x...x...', '....c.......c...', 'yxyxyxyxyxyxyxyx', 'hat', [
        [D.SIDE_STICK, '...x..x....x..x.'],
        [D.HIHAT_OPEN, '..x...x...x...x.'],
      ]),
    ],
    high: [
      G('x...x...x...x...', '....c..x....c...', 'yxyxyxyxyxyxyxyx', 'hat', [
        [D.SIDE_STICK, '...x..x..x.x..x.'],
        [D.HIHAT_OPEN, '..x...x...x...x.'],
      ]),
    ],
    half: [G('x...............', '........c.......', 'yxyxyxyxyxyxyxyx')],
    fills: ['sparse'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
    strict: true,
  },
  'drum-and-bass': {
    // Two-step break at 170+: kick on 1 and the "and" of 3, snare on 2 & 4, busy 16th hats/ride.
    low: [G('x.........x.....', '....x.......x...', EIGHTHS)],
    mid: [
      G('x.........x.....', '....x.......x...', SIXTEENTHS),
      G('x.x.......x.....', '....x.......x..g', SIXTEENTHS),
    ],
    high: [
      G('x.........xx....', '....X..g.g..X..g', SIXTEENTHS, 'ride'),
      G('x.x.......x.....', '....X.......X...', 'xxoxxxoxxxoxxxox'),
    ],
    half: [G('x...............', '........X.......', EIGHTHS)],
    fills: ['electronic', 'snare'],
    ghosts: true,
    hat16: true,
    ride: true,
    electronic: true,
  },
  breakbeat: {
    // Chopped funk break ("Amen"-style): kick on 1, the "and" of 1 and around 3, snare 2 & 4 with pushes.
    low: [G('x.x.......x.....', '....x.......x...', EIGHTHS)],
    mid: [G('x.x.......xx....', '....x..x.x..x..x', EIGHTHS, 'ride')],
    high: [
      G('x.x.......xx....', '....X..x.x..X..x', 'X.x.X.x.X.x.X.x.', 'ride'),
      G('x.x...x...x.....', '....X..x.x.xX..x', SIXTEENTHS),
    ],
    half: [G('x.........x.....', '........X.......', EIGHTHS)],
    fills: ['snare', 'mixed'],
    ghosts: true,
    hat16: true,
    ride: true,
  },
  dubstep: {
    // Half-time at 140: kick on 1, snare on 3, syncopated kicks and busy hats under the wobble.
    low: [G('x...............', '........x.......', '..x...x...x...x.')],
    mid: [G('x.........x.....', '........X.......', EIGHTHS)],
    high: [
      G('x.....x...x.....', '........X.......', SIXTEENTHS),
      G('x.........x..x..', '........X.....x.', 'x.xxx.xxx.xxx.xx'),
    ],
    half: [G('x...............', '........x.......', '..x...x...x...x.')],
    fills: ['electronic', 'sparse'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
  },
  techno: {
    // Relentless four on the floor, off-beat open hats, clap on 2 & 4, rim syncopation.
    low: [G('x...x...x...x...', '................', OFFBEATS)],
    mid: [
      G('x...x...x...x...', '....c.......c...', 'x.o.x.o.x.o.x.o.', 'hat', [
        [D.SIDE_STICK, '...x.....x....x.'],
      ]),
    ],
    high: [
      G('x...x...x...x...', '....c.......c...', 'xxoxxxoxxxoxxxox', 'hat', [
        [D.SIDE_STICK, '...x.....x.x..x.'],
      ]),
    ],
    half: [G('x...x...x...x...', '................', OFFBEATS)],
    fills: ['electronic'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
    strict: true,
  },
  'two-step': {
    // UK garage: skippy kick that skips beat 3, snare on 2 & 4, shuffled 16th hats with open lifts.
    low: [G('x.........x.....', '....x.......x...', EIGHTHS)],
    mid: [
      G('x......x..x.....', '....x.......x...', 'xxoxxxoxxxoxxxox'),
      G('x.........x..x..', '....x.......x...', SIXTEENTHS),
    ],
    high: [
      G('x......x..x...x.', '....X.......X...', 'xxoxxxoxxxoxxxox'),
      G('x..x......x..x..', '....X.......X...', 'xxoxxxoxxxoxxxox'),
    ],
    half: [G('x.........x.....', '........x.......', EIGHTHS)],
    fills: ['sparse', 'electronic'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
  },
  drill: {
    // Drill at ~140 half-time: sliding kick figure, snare on 3 plus a late snare in the second bar, 3-3-2 hats.
    low: [G('x.........x.....', '........x.......', 'x..x..x.x..x..x.')],
    mid: [G('x.....x...x.....', '........x...............x.....x.', 'x..x..x.x..x..x.')],
    high: [
      G('x.....x...x.....x.........x..x..', '........X...............X.....X.', 'x..x..x.x.xxx..x'),
      G('x..x......x.....', '........X.....X.', 'x..x..x.x..x..xx'),
    ],
    half: [G('x...............', '........x.......', 'x..x..x.x..x..x.')],
    fills: ['sparse'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
    strict: true,
  },
  phonk: {
    // Memphis / drift phonk: trap half-time with a cowbell figure riding on top.
    low: [G('x.........x.....', '........x.......', EIGHTHS)],
    mid: [G('x.........x.....', '........X.......', SIXTEENTHS, 'hat', [[D.COWBELL, 'x..x..x...x..x..']])],
    high: [G('x.....x...x..x..', '........X.......', SIXTEENTHS, 'hat', [[D.COWBELL, 'x..x..x.x..x..x.']])],
    half: [G('x...............', '........x.......', EIGHTHS)],
    fills: ['sparse', 'electronic'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
  },
  'jersey-club': {
    // Jersey club: the bouncing five-kick figure, clap on 2 & 4, sparse hats.
    low: [G('x..x..x.x.......', '....c.......c...', '..x...x...x...x.')],
    mid: [G('x..x..x.x...x...', '....c.......c...', '..x...x...x...x.')],
    high: [G('x..x..x.x...x.x.', '....X.......X...', 'x.x.x.x.x.x.x.x.')],
    half: [G('x.......x.......', '........c.......', '..x...x...x...x.')],
    fills: ['electronic'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
    strict: true,
  },
  footwork: {
    // Footwork / juke at ~160: stuttering 3-3-2 kicks, sparse snare, open-hat accents.
    low: [G('x..x..x...x.....', '........x.......', '..x...x...x...x.')],
    mid: [G('x..x..x...x..x..', '....x.......x...', 'x.x.x.x.x.x.x.x.')],
    high: [G('x..x..x.x..x..x.', '....X.......X...', 'x.o.x.o.x.o.x.o.')],
    half: [G('x.........x.....', '........x.......', '..x...x...x...x.')],
    fills: ['electronic'],
    ghosts: false,
    hat16: true,
    ride: false,
    electronic: true,
    strict: true,
  },
  'baile-funk': {
    // Funk carioca tamborzão: syncopated kick and conga-like drums over a clapped snare.
    low: [
      G('x..x......x..x..', '....x.......x...', '................', 'none', [
        [D.CONGA_LOW, 'x..x..x...x..x..'],
      ]),
    ],
    mid: [
      G('x..x......x..x..', '....x..x....x...', EIGHTHS, 'hat', [
        [D.CONGA_LOW, 'x..x..x...x..x..'],
        [D.CONGA_HIGH, '..x.....x.x.....'],
      ]),
    ],
    high: [
      G('x..x..x...x..x..', '....X..x....X..x', EIGHTHS, 'hat', [
        [D.CONGA_LOW, 'x..x..x...x..x..'],
        [D.CONGA_HIGH, '..x.....x.x.....'],
      ]),
    ],
    half: [G('x.........x.....', '........x.......', EIGHTHS)],
    fills: ['sparse'],
    ghosts: false,
    hat16: false,
    ride: false,
    electronic: true,
    strict: true,
  },
  flamenco: {
    // Rumba flamenca on cajón (kick = bass tone, snare = slap) with off-beat palmas.
    low: [
      G('x.....x.x.......', '....x.......x...', '................', 'none', [[D.CLAP, '..x...x...x...x.']]),
    ],
    mid: [
      G('x.....x.x.....x.', '....x..g....x..g', '................', 'none', [[D.CLAP, '..x...x...x...x.']]),
    ],
    high: [
      G('x..x..x.x.....x.', '....X..g.g..X..g', '................', 'none', [[D.CLAP, '..x.x.x...x.x.x.']]),
    ],
    half: [
      G('x.......x.......', '........x.......', '................', 'none', [[D.CLAP, '..x...x...x...x.']]),
    ],
    fills: ['snare'],
    ghosts: false,
    hat16: false,
    ride: false,
    strict: true,
  },
  celtic: {
    // Bodhrán-style driving eighths on the low drum with accented off-beats; kit backbeat when it lifts.
    low: [
      G('x.......x.......', '................', '................', 'none', [
        [D.FLOOR_TOM_LOW, 'x.x.x.x.x.x.x.x.'],
        [D.TOM_LOW, '..x.......x.....'],
      ]),
    ],
    mid: [
      G('x.......x.......', '....x.......x...', '................', 'none', [
        [D.FLOOR_TOM_LOW, 'x.x.x.x.x.x.x.x.'],
        [D.TOM_LOW, '..x...x...x...x.'],
      ]),
    ],
    high: [
      G('x...x...x...x...', '....X.......X...', EIGHTHS, 'hat', [[D.FLOOR_TOM_LOW, 'x.x.x.x.x.x.x.x.']]),
    ],
    half: [
      G('x...............', '........x.......', '................', 'none', [
        [D.FLOOR_TOM_LOW, 'x...x...x...x...'],
      ]),
    ],
    fills: ['toms', 'snare'],
    ghosts: false,
    hat16: false,
    ride: false,
    strict: true,
  },
  bhangra: {
    // Dhol chaal: 3-3-2 bass-side strokes with the treble stick on the off-beats, clapped backbeat.
    low: [
      G('x.......x.......', '....c.......c...', '................', 'none', [
        [D.FLOOR_TOM_LOW, 'x..x..x.x..x..x.'],
        [D.TOM_HIGH, '..x...x...x...x.'],
      ]),
    ],
    mid: [
      G('x.......x.......', '....c.......c...', EIGHTHS, 'hat', [
        [D.FLOOR_TOM_LOW, 'x..x..x.x..x..x.'],
        [D.TOM_HIGH, '..x...x...x...x.'],
      ]),
    ],
    high: [
      G('x...x...x...x...', '....X.......X...', EIGHTHS, 'hat', [
        [D.FLOOR_TOM_LOW, 'x..x..x.x..x..x.'],
        [D.TOM_HIGH, '.xx..xx..xx..xx.'],
        [D.TAMBOURINE, 'x.x.x.x.x.x.x.x.'],
      ]),
    ],
    half: [
      G('x...............', '........c.......', '................', 'none', [
        [D.FLOOR_TOM_LOW, 'x..x..x.........'],
      ]),
    ],
    fills: ['toms'],
    ghosts: false,
    hat16: false,
    ride: false,
    strict: true,
  },
  ambient: {
    // Barely-there pulse: a soft kick, a distant rim, felt off-beat hats only when the music lifts.
    low: [G('x...............', '................', '................', 'none')],
    mid: [G('x.......x.......', '........r.......', '..y...y...y...y.')],
    high: [G('x...x...x...x...', '....x.......x...', EIGHTHS)],
    half: [G('x...............', '........r.......', '................', 'none')],
    fills: ['sparse'],
    ghosts: false,
    hat16: false,
    ride: false,
    electronic: true,
    strict: true,
  },
};

const TOMS_DESC = [D.TOM_HIGH, D.TOM_HIGH_MID, D.TOM_LOW_MID, D.TOM_LOW, D.FLOOR_TOM_HIGH, D.FLOOR_TOM_LOW];

interface Hit {
  pitch: number;
  tick: number;
  vel: number;
  dur?: number;
  ghost?: boolean;
}

interface DrumCtx {
  c: Cell;
  def: StyleDef;
  style: DrumStyle;
  snare: number;
  kick: number;
  electronic: boolean;
  complexity: number;
  density: number;
  syncopation: number;
  dynamics: number;
}

function levelFor(c: Cell, e: number): Level {
  if (c.kind === 'breakdown' || c.kind === 'intro' || c.kind === 'outro') return e >= 0.75 ? 'mid' : 'low';
  if (e >= 0.78 || c.kind === 'final-chorus' || c.kind === 'drop') return 'high';
  if (e >= 0.5 || c.kind === 'pre-chorus') return 'mid';
  return 'low';
}

function scaleVel(d: DrumCtx, base: number, e: number): number {
  const v = base * (0.72 + 0.32 * e);
  return toVelocity(88 + (v - 88) * (0.65 + 0.7 * d.dynamics));
}

/** 16-step template bar (4/4) → hits. */
function templateBar(d: DrumCtx, g: Groove, bar: BarInfo, level: Level, barRng: Rng, e: number): Hit[] {
  const { c, def } = d;
  const step = bar.meter.barTicks / 16;
  const hits: Hit[] = [];
  let tk: Timekeeper = g.tk ?? 'hat';
  // Ride in big choruses for styles that use it; hats elsewhere.
  if (
    tk === 'hat' &&
    def.ride &&
    level === 'high' &&
    e >= 0.85 &&
    (c.kind === 'chorus' || c.kind === 'final-chorus' || c.kind === 'solo')
  )
    tk = 'ride';
  const sideStick =
    def.sideStickLow && level === 'low' && e < 0.42 && c.kind !== 'chorus' && c.kind !== 'final-chorus';
  const quarterOnly = d.density < 0.28 || (c.kind === 'intro' && e < 0.3);
  const sixteenths = def.hat16 && tk === 'hat' && d.density > 0.68 && e > 0.45 && !def.strict;
  // Two-bar rows (clave grooves) alternate halves bar by bar.
  const at = (row: string, i: number) =>
    row[(bar.index % Math.max(1, Math.floor(row.length / 16))) * 16 + i] ?? '.';
  for (let i = 0; i < 16; i++) {
    const t = bar.tick + Math.round(i * step);
    const kc = at(g.k, i);
    if (kc === 'x' || kc === 'X')
      hits.push({ pitch: d.kick, tick: t, vel: scaleVel(d, kc === 'X' ? 114 : i % 4 === 0 ? 106 : 98, e) });
    const sc = at(g.s, i);
    if (sc === 'x' || sc === 'X') {
      const p = sideStick ? D.SIDE_STICK : d.snare;
      hits.push({ pitch: p, tick: t, vel: scaleVel(d, sc === 'X' ? 120 : 108, e) });
      if (d.electronic && !sideStick && e > 0.55)
        hits.push({ pitch: D.CLAP, tick: t, vel: scaleVel(d, 100, e) });
    } else if (sc === 'g')
      hits.push({ pitch: d.snare, tick: t, vel: 30 + Math.round(barRng.next() * 10), ghost: true });
    else if (sc === 'r') hits.push({ pitch: D.SIDE_STICK, tick: t, vel: scaleVel(d, 98, e) });
    else if (sc === 'c') hits.push({ pitch: D.CLAP, tick: t, vel: scaleVel(d, 104, e) });
    let hc = at(g.h, i);
    if (quarterOnly && i % 4 !== 0) hc = '.';
    if (sixteenths && hc === '.' && i % 2 === 1) hc = 'y';
    if (hc === 'p') {
      hits.push({ pitch: D.HIHAT_PEDAL, tick: t, vel: scaleVel(d, 70, e) });
      hc = '.';
    }
    if (hc !== '.') {
      const accent = hc === 'X' || i % 4 === 0;
      const off = i % 2 === 1;
      let pitch: number;
      let base: number;
      let dur = 60;
      switch (tk) {
        case 'ride':
          pitch = hc === 'X' && i % 8 === 0 && d.complexity > 0.6 ? D.RIDE_BELL : D.RIDE;
          base = accent ? 92 : 80;
          dur = 240;
          break;
        case 'crash':
          pitch = i % 4 === 0 ? D.CRASH : D.HIHAT_CLOSED;
          base = i % 4 === 0 ? 104 : 70;
          dur = i % 4 === 0 ? 480 : 60;
          break;
        case 'open-hat':
          pitch = D.HIHAT_OPEN;
          base = accent ? 90 : 80;
          dur = 200;
          break;
        case 'floor-tom':
          pitch = D.FLOOR_TOM_LOW;
          base = accent ? 96 : 84;
          dur = 120;
          break;
        case 'china':
          pitch = i % 4 === 0 ? D.CHINA : D.HIHAT_CLOSED;
          base = i % 4 === 0 ? 100 : 72;
          break;
        case 'none':
          pitch = -1;
          base = 0;
          break;
        default:
          pitch = hc === 'o' ? D.HIHAT_OPEN : D.HIHAT_CLOSED;
          base = hc === 'o' ? 84 : hc === 'y' ? 54 : accent ? 86 : off ? 64 : 74;
          dur = hc === 'o' ? 200 : 60;
      }
      if (pitch >= 0) hits.push({ pitch, tick: t, vel: scaleVel(d, base, e), dur });
    }
  }
  for (const [pitch, row] of g.extra ?? []) {
    for (let i = 0; i < 16; i++) {
      const ch = at(row, i);
      if (ch === 'x' || ch === 'X')
        hits.push({
          pitch,
          tick: bar.tick + Math.round(i * step),
          vel: scaleVel(d, ch === 'X' ? 112 : 92, e),
          dur: 120,
        });
    }
  }
  // Groove variations: syncopated kicks, 16th pickups, ghost notes.
  const has = (pitch: number, i: number) =>
    hits.some((h) => h.pitch === pitch && h.tick === bar.tick + Math.round(i * step));
  if (def.strict) return hits;
  if (level !== 'low' && barRng.chance(d.syncopation * 0.45)) {
    const i = barRng.pick([6, 14, 10]);
    if (!has(d.kick, i) && !has(d.snare, i))
      hits.push({ pitch: d.kick, tick: bar.tick + Math.round(i * step), vel: scaleVel(d, 94, e) });
  }
  if (d.complexity > 0.62 && barRng.chance((d.complexity - 0.55) * 0.9)) {
    const i = barRng.pick([3, 11, 7, 15]);
    if (!has(d.kick, i) && !has(d.snare, i))
      hits.push({ pitch: d.kick, tick: bar.tick + Math.round(i * step), vel: scaleVel(d, 86, e) });
  }
  if (def.ghosts && d.complexity > 0.42 && !sideStick) {
    const p = (d.complexity - 0.38) * 0.75;
    for (const i of [2, 7, 9, 15, 10, 13]) {
      if (barRng.chance(p) && !has(d.snare, i) && !has(d.kick, i))
        hits.push({
          pitch: d.snare,
          tick: bar.tick + Math.round(i * step),
          vel: 26 + barRng.int(0, 12),
          ghost: true,
        });
    }
  }
  return hits;
}

/** Jazz: spang-a-lang ride, hi-hat on 2 & 4, feathered kick, snare comping. */
function jazzBar(d: DrumCtx, bar: BarInfo, barRng: Rng, e: number): Hit[] {
  const hits: Hit[] = [];
  const m = bar.meter;
  const q = m.unitTicks;
  for (let b = 0; b < m.numerator; b++) {
    const t = bar.tick + b * q;
    hits.push({ pitch: D.RIDE, tick: t, vel: scaleVel(d, b % 2 === 1 ? 88 : 80, e), dur: 240 });
    if (b % 2 === 1) {
      hits.push({ pitch: D.RIDE, tick: t + q / 2, vel: scaleVel(d, 70, e), dur: 120 }); // swung "let" (swing applied later)
      hits.push({ pitch: D.HIHAT_PEDAL, tick: t, vel: scaleVel(d, 70, e) });
    }
    hits.push({ pitch: d.kick, tick: t, vel: Math.round(36 + e * 14) }); // feathered
  }
  // Snare comping on triplet "lets", more with complexity/energy.
  const comps = Math.round((d.complexity * 2 + e * 2) * barRng.next());
  for (let i = 0; i < comps; i++) {
    const b = barRng.int(0, m.numerator - 1);
    const t = bar.tick + b * q + Math.round((q * 2) / 3);
    hits.push({
      pitch: d.snare,
      tick: t,
      vel: barRng.chance(0.3) ? scaleVel(d, 92, e) : 40 + barRng.int(0, 15),
      ghost: true,
    });
  }
  if (e > 0.6 && barRng.chance(0.25))
    hits.push({
      pitch: d.kick,
      tick: bar.tick + (m.numerator - 1) * q + Math.round((q * 2) / 3),
      vel: scaleVel(d, 96, e),
    });
  return hits;
}

/** Any meter: kick on group starts, snare on the alternate groups (backbeat), timekeeper on the pulse. */
function genericBar(d: DrumCtx, bar: BarInfo, level: Level, half: boolean, barRng: Rng, e: number): Hit[] {
  const m = bar.meter;
  const hits: Hit[] = [];
  const groups = m.strong;
  const waltz =
    !m.compound &&
    m.numerator === 3 &&
    (d.style === 'folk' ||
      d.style === 'country' ||
      d.style === 'jazz-swing' ||
      d.style === 'orchestral' ||
      d.style === 'pop');
  const orchestralish = d.style === 'orchestral' || d.style === 'cinematic';
  if (waltz) {
    hits.push({ pitch: d.kick, tick: bar.tick, vel: scaleVel(d, 104, e) });
    for (let b = 1; b < 3; b++)
      hits.push({
        pitch: level === 'low' ? D.SIDE_STICK : d.snare,
        tick: bar.tick + b * m.unitTicks,
        vel: scaleVel(d, level === 'high' ? 100 : 80, e),
      });
  } else if (m.compound) {
    groups.forEach((g, i) => {
      const t = bar.tick + g;
      if (i % 2 === 0) hits.push({ pitch: d.kick, tick: t, vel: scaleVel(d, 106, e) });
      else if (!half || i === groups.length - 1)
        hits.push({ pitch: orchestralish ? D.FLOOR_TOM_LOW : d.snare, tick: t, vel: scaleVel(d, 110, e) });
      if (level !== 'low' && barRng.chance(0.4 + d.syncopation * 0.3))
        hits.push({ pitch: d.kick, tick: t + 2 * m.unitTicks, vel: scaleVel(d, 90, e) });
    });
  } else {
    // Simple / odd meters: alternate kick and snare groups; a 3-group gets a kick on its last beat.
    let acc = 0;
    const sizes = groups.map((g, i) => (i + 1 < groups.length ? groups[i + 1] : m.barTicks) - g);
    groups.forEach((g, i) => {
      const t = bar.tick + g;
      if (i === 0 || i % 2 === 0) hits.push({ pitch: d.kick, tick: t, vel: scaleVel(d, 106, e) });
      if (i % 2 === 1 || (groups.length === 1 && !half)) {
        const st = groups.length === 1 ? t + Math.floor(sizes[0] / m.unitTicks / 2) * m.unitTicks : t;
        if (!half || i === 1)
          hits.push({ pitch: orchestralish ? D.FLOOR_TOM_LOW : d.snare, tick: st, vel: scaleVel(d, 112, e) });
      }
      if (sizes[i] >= 3 * m.unitTicks && level !== 'low')
        hits.push({ pitch: d.kick, tick: t + 2 * m.unitTicks, vel: scaleVel(d, 92, e) });
      acc += sizes[i];
    });
    void acc;
  }
  // Timekeeper on the eighth-note pulse (quarters when sparse).
  if (!orchestralish) {
    const pulse = m.denominator >= 8 ? m.unitTicks : m.unitTicks / 2;
    const stepT =
      d.density < 0.28
        ? m.beatTicks
        : level === 'high' && d.def.hat16 && d.density > 0.68
          ? pulse / 2
          : pulse;
    const ride = d.def.ride && level === 'high' && e >= 0.85;
    for (let t = 0; t < m.barTicks; t += stepT) {
      const onBeat = m.beats.includes(t);
      hits.push({
        pitch: ride ? D.RIDE : D.HIHAT_CLOSED,
        tick: bar.tick + t,
        vel: scaleVel(d, onBeat ? 86 : 66, e),
        dur: ride ? 240 : 60,
      });
    }
  }
  return hits;
}

function fillHits(
  d: DrumCtx,
  kind: FillKind,
  start: number,
  length: number,
  e: number,
  rng: Rng,
  m: MeterInfo,
): Hit[] {
  const hits: Hit[] = [];
  const grid = kind === 'triplet' || kind === 'jazz' ? PPQ / 3 : m.compound ? m.unitTicks / 2 : PPQ / 4;
  const n = Math.max(1, Math.floor(length / grid));
  const v0 = 76 + e * 14;
  const v1 = 108 + e * 14;
  const vel = (i: number) => scaleVel(d, v0 + ((v1 - v0) * i) / Math.max(1, n - 1), e);
  switch (kind) {
    case 'snare':
      for (let i = 0; i < n; i++) hits.push({ pitch: d.snare, tick: start + i * grid, vel: vel(i) });
      break;
    case 'build': {
      // Snare build-up into the chorus: eighths, then sixteenths for the last half, kick on the beats.
      const half = start + Math.round(length / 2);
      for (let t = start; t < start + length; t += t < half ? PPQ / 2 : PPQ / 4) {
        const prog = (t - start) / length;
        hits.push({ pitch: d.snare, tick: Math.round(t), vel: toVelocity(scaleVel(d, 70 + prog * 50, e)) });
      }
      for (const b of m.beats)
        if (b < length) hits.push({ pitch: d.kick, tick: start + b, vel: scaleVel(d, 100, e) });
      break;
    }
    case 'toms':
    case 'triplet': {
      // Descend around the kit across the fill: high tom → floor tom.
      for (let i = 0; i < n; i++) {
        const idx = Math.min(TOMS_DESC.length - 1, Math.floor((i * TOMS_DESC.length) / n));
        hits.push({
          pitch: i === 0 && rng.chance(0.5) ? d.snare : TOMS_DESC[idx],
          tick: start + i * grid,
          vel: vel(i),
        });
      }
      if (e > 0.6) hits.push({ pitch: d.kick, tick: start, vel: scaleVel(d, 100, e) });
      break;
    }
    case 'mixed':
      for (let i = 0; i < n; i++) {
        const tomIdx = Math.min(TOMS_DESC.length - 1, Math.floor((i / n) * TOMS_DESC.length));
        hits.push({ pitch: i % 2 === 0 ? d.snare : TOMS_DESC[tomIdx], tick: start + i * grid, vel: vel(i) });
        if (i % 4 === 0 && e > 0.55)
          hits.push({ pitch: d.kick, tick: start + i * grid, vel: scaleVel(d, 96, e) });
      }
      break;
    case 'electronic': {
      // Snare roll, doubling speed for the last beat; claps on the last hits.
      for (let i = 0; i < n; i++) {
        hits.push({ pitch: d.snare, tick: start + i * grid, vel: vel(i) });
        if (i >= n - 2) hits.push({ pitch: D.CLAP, tick: start + i * grid, vel: vel(i) });
      }
      const last = start + length - PPQ / 2;
      for (let t = last; t < start + length; t += PPQ / 8)
        if (t >= start) hits.push({ pitch: d.snare, tick: Math.round(t), vel: scaleVel(d, 112, e) });
      break;
    }
    case 'sparse': {
      // Hip-hop / R&B: the beat drops out except a kick-snare pickup.
      hits.push({ pitch: d.kick, tick: start, vel: scaleVel(d, 100, e) });
      if (length >= PPQ)
        hits.push({ pitch: d.snare, tick: start + length - PPQ / 2, vel: scaleVel(d, 104, e) });
      if (length >= PPQ && rng.chance(0.5))
        hits.push({ pitch: d.kick, tick: start + length - PPQ / 4, vel: scaleVel(d, 90, e) });
      break;
    }
    case 'timbales':
      // Latin timbale fill: alternating high/low shells, a cowbell-free flam into the downbeat.
      for (let i = 0; i < n; i++)
        if (i % 4 !== 1 || rng.chance(0.6))
          hits.push({
            pitch: i % 2 === 0 ? D.TIMBALE_HIGH : D.TIMBALE_LOW,
            tick: start + i * grid,
            vel: vel(i),
          });
      hits.push({ pitch: D.TIMBALE_HIGH, tick: start + length - grid, vel: scaleVel(d, 116, e), dur: grid });
      break;
    case 'jazz':
      for (let i = 0; i < n; i++)
        if (i % 3 !== 1 || rng.chance(0.5))
          hits.push({
            pitch: i % 3 === 2 ? TOMS_DESC[Math.min(5, Math.floor(i / 2))] : d.snare,
            tick: start + i * grid,
            vel: vel(i) - 6,
          });
      hits.push({ pitch: d.kick, tick: start + length - grid, vel: scaleVel(d, 104, e) });
      break;
    case 'orchestral': {
      // Snare roll (32nds) swelling into the next section, timpani-like low tom at the end.
      const g32 = PPQ / 8;
      const steps = Math.max(1, Math.floor(length / g32));
      for (let i = 0; i < steps; i++)
        hits.push({
          pitch: d.snare,
          tick: start + i * g32,
          vel: toVelocity(40 + (70 * i) / steps),
          dur: g32,
        });
      hits.push({ pitch: D.FLOOR_TOM_LOW, tick: start + length - PPQ / 2, vel: scaleVel(d, 110, e) });
      break;
    }
  }
  return hits;
}

/** Whole-section EDM build: roll rate doubles each quarter of the section, crescendo, kick drops out at the end. */
function buildRoll(d: DrumCtx, c: Cell): Hit[] {
  const hits: Hit[] = [];
  const start = c.span.startTick;
  const len = c.span.endTick - start;
  const rates = [PPQ, PPQ / 2, PPQ / 4, PPQ / 8];
  for (let q = 0; q < 4; q++) {
    const s = start + Math.round((len * q) / 4);
    const e = start + Math.round((len * (q + 1)) / 4);
    for (let t = s; t < e; t += rates[q]) {
      const prog = (t - start) / len;
      hits.push({ pitch: d.snare, tick: Math.round(t), vel: toVelocity(55 + prog * 65) });
    }
  }
  for (const bar of c.bars) {
    if (bar.index === c.bars.length - 1) break;
    for (const b of bar.meter.beats)
      hits.push({ pitch: d.kick, tick: bar.tick + b, vel: scaleVel(d, 104, c.energyAt(bar.tick)) });
  }
  return hits;
}

export function generateDrums(c: Cell): RawNote[] {
  const style = c.g.drumStyle;
  const def = STYLES[style] ?? STYLES.rock;
  const electronic = def.electronic === true || c.inst.id === 'electronic-kit';
  const d: DrumCtx = {
    c,
    def,
    style,
    electronic,
    snare: electronic ? D.SNARE_ELECTRIC : D.SNARE,
    kick: def.kick ?? D.KICK,
    complexity: c.macros.complexity,
    density: c.macros.density,
    syncopation: c.avoid.has('syncopation')
      ? 0
      : clamp01((c.macros.syncopation + c.g.genre.rhythm.syncopation) / 2),
    dynamics: c.macros.dynamics,
  };
  const hits: Hit[] = [];
  const level = levelFor(c, c.intensity);
  const half = c.feel === 'half-time' || (c.kind === 'breakdown' && c.intensity < 0.6);
  const double = c.feel === 'double-time';
  const edmBuild =
    (c.kind === 'build' || (c.kind === 'pre-chorus' && (style === 'four-on-floor' || style === 'trance'))) &&
    def.electronic;
  const pool = half ? def.half : double ? STYLES.punk.high : def[level];
  const groove = c.rng.pick(pool);
  const lastBarIdx = c.bars.length - 1;
  const sparseIntro = c.kind === 'intro' && c.intensity < 0.5 && c.bars.length >= 4;

  if (edmBuild) hits.push(...buildRoll(d, c));
  else {
    for (const bar of c.bars) {
      const barRng = c.rng.fork('bar', bar.index % c.rootBars);
      const e = c.energyAt(bar.tick);
      let barHits: Hit[];
      if (def.special === 'jazz' && !half) barHits = jazzBar(d, bar, barRng, e);
      else if (bar.meter.common) barHits = templateBar(d, groove, bar, level, barRng, e);
      else barHits = genericBar(d, bar, level, half, barRng, e);
      if (sparseIntro && bar.index < c.bars.length / 2) {
        // Intro builds in: timekeeper + downbeat kick only for the first half.
        barHits = barHits.filter(
          (h) => h.pitch !== d.snare && h.pitch !== D.CLAP && (h.pitch !== d.kick || h.tick === bar.tick),
        );
      }
      // 4-bar phrase marker: open hat / kick push on the last eighth of every 4th bar.
      if (bar.index % 4 === 3 && bar.index !== lastBarIdx && level !== 'low' && barRng.chance(0.5)) {
        const t = bar.tick + bar.meter.barTicks - PPQ / 2;
        barHits = barHits.filter(
          (h) => !(h.tick === t && (h.pitch === D.HIHAT_CLOSED || h.pitch === D.RIDE)),
        );
        barHits.push({ pitch: D.HIHAT_OPEN, tick: t, vel: scaleVel(d, 88, e), dur: 200 });
      }
      hits.push(...barHits);
    }
  }

  // Crash on the section downbeat (and every 8 bars in long, loud sections).
  const prevE = c.prev ? (c.prev.section.energyEnd ?? c.prev.section.energy) / 100 : 0;
  const crashStart =
    !edmBuild &&
    (c.e0 >= 0.45 || (c.index > 0 && c.e0 >= 0.35 && prevE < c.e0)) &&
    !(sparseIntro && c.e0 < 0.5) &&
    style !== 'jazz-swing';
  const markCrash = (t: number, e: number) => {
    for (let i = hits.length - 1; i >= 0; i--)
      if (
        hits[i].tick === t &&
        (hits[i].pitch === D.HIHAT_CLOSED || hits[i].pitch === D.HIHAT_OPEN || hits[i].pitch === D.RIDE)
      )
        hits.splice(i, 1);
    hits.push({ pitch: D.CRASH, tick: t, vel: scaleVel(d, 116, e), dur: PPQ * 2 });
    if (!hits.some((h) => h.tick === t && h.pitch === d.kick))
      hits.push({ pitch: d.kick, tick: t, vel: scaleVel(d, 110, e) });
  };
  if (crashStart) markCrash(c.span.startTick, c.e0);
  if (!edmBuild) {
    for (const bar of c.bars) {
      if (bar.index > 0 && bar.index % 8 === 0 && c.energyAt(bar.tick) >= 0.7)
        markCrash(bar.tick, c.energyAt(bar.tick));
    }
  }

  // Fills into the next section; small fills at 8-bar phrase ends inside long sections.
  const fills: { start: number; end: number; kind: FillKind; e: number }[] = [];
  const fillKind = (rng: Rng, m: MeterInfo): FillKind => (m.compound ? 'triplet' : rng.pick(def.fills));
  if (c.next && !edmBuild && !c.isLast) {
    const bar = c.bars[lastBarIdx];
    const nextE = (c.next.section.energy ?? 50) / 100;
    const big =
      c.next.section.kind === 'chorus' ||
      c.next.section.kind === 'final-chorus' ||
      c.next.section.kind === 'drop' ||
      nextE - c.e1 >= 0.15;
    const dropping = nextE < c.e1 - 0.25;
    const beat = bar.meter.beatTicks;
    let beats =
      c.e1 < 0.35 ? (big ? 1 : 0) : c.e1 < 0.65 ? (big ? 2 : 1) : big ? (d.complexity > 0.55 ? 4 : 2) : 2;
    if (dropping) beats = c.e1 > 0.6 ? 1 : 0;
    // A rising pre-chorus builds through its whole last bar into the chorus.
    const rising =
      c.e1 > c.e0 + 0.06 &&
      (c.kind === 'pre-chorus' || c.kind === 'build' || c.kind === 'bridge') &&
      big &&
      !def.electronic &&
      style !== 'jazz-swing' &&
      style !== 'orchestral';
    if (rising && c.vrng.chance(0.6)) {
      fills.push({ start: bar.tick, end: bar.tick + bar.meter.barTicks, kind: 'build', e: c.e1 });
    } else {
      const len = Math.min(bar.meter.barTicks, Math.round(beats * beat));
      if (len > 0)
        fills.push({
          start: bar.tick + bar.meter.barTicks - len,
          end: bar.tick + bar.meter.barTicks,
          kind: fillKind(c.vrng, bar.meter),
          e: c.e1,
        });
    }
  }
  for (const bar of c.bars) {
    if (bar.index % 8 === 7 && bar.index !== lastBarIdx && d.complexity >= 0.35 && !edmBuild) {
      const len = bar.meter.beatTicks;
      fills.push({
        start: bar.tick + bar.meter.barTicks - len,
        end: bar.tick + bar.meter.barTicks,
        kind: fillKind(c.rng.fork('fill', bar.index % c.rootBars), bar.meter),
        e: c.energyAt(bar.tick),
      });
    }
  }
  for (const f of fills) {
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (h.tick >= f.start && h.tick < f.end && !(h.pitch === d.kick && h.tick === f.start))
        hits.splice(i, 1);
    }
    hits.push(
      ...fillHits(
        d,
        f.kind,
        f.start,
        f.end - f.start,
        f.e,
        c.vrng.fork('fill', f.start),
        c.meterAt(f.start).meter,
      ),
    );
  }

  // The song ends on a single hit.
  if (c.isLast) {
    const bar = c.bars[lastBarIdx];
    for (let i = hits.length - 1; i >= 0; i--) if (hits[i].tick >= bar.tick) hits.splice(i, 1);
    if (c.e1 >= 0.25) {
      hits.push({ pitch: D.CRASH, tick: bar.tick, vel: scaleVel(d, 112, c.e1), dur: PPQ * 4 });
      hits.push({ pitch: d.kick, tick: bar.tick, vel: scaleVel(d, 108, c.e1) });
    }
  }

  // One hit per (pitch, tick): grooves, crashes and fills can coincide.
  const seen = new Set<string>();
  const unique = hits.filter((h) => {
    const k = `${h.pitch}@${h.tick}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Swing: delay off-beat subdivisions (and the jazz ride "let").
  const sw8 =
    style === 'jazz-swing'
      ? Math.max(c.swing8, 0.66)
      : def.swing8
        ? Math.max(c.swing8, def.swing8)
        : c.swing8;
  const notes: RawNote[] = unique.map((h) => {
    const { meter, barStart } = c.meterAt(h.tick);
    let off = h.tick - barStart;
    if (!meter.compound && meter.denominator <= 4) {
      if (sw8 > 0) off = applySwing(off, PPQ, sw8);
      else if (c.swing16 > 0) off = applySwing(off, PPQ / 2, c.swing16);
    }
    const n: RawNote = { pitch: h.pitch, tick: barStart + off, duration: h.dur ?? 120, velocity: h.vel };
    if (h.ghost) n.articulation = 'ghost';
    else if (h.vel >= 118) n.articulation = 'accent';
    return n;
  });
  // Brushes: a swishing, softer snare, feathered kick, ride instead of crashes, no claps.
  if (/brush/i.test(c.track.name) || c.g.genre.production.keywords.includes('brushes')) {
    for (const n of notes) {
      if (n.pitch === D.CLAP) n.pitch = d.snare;
      if (n.pitch === D.CRASH || n.pitch === D.CRASH_2 || n.pitch === D.CHINA) n.pitch = D.RIDE;
      const scale = n.pitch === d.snare || n.pitch === D.SIDE_STICK ? 0.7 : n.pitch === d.kick ? 0.75 : 0.8;
      n.velocity = toVelocity(n.velocity * scale);
      if (n.pitch === d.snare) n.duration = Math.max(n.duration, PPQ / 2);
    }
  }
  humanize(notes, c.macros.humanization, c.vrng.fork('humanize'), {
    start: c.span.startTick,
    end: c.span.endTick,
    maxTicks: 8,
    maxVelocity: 8,
  });
  return notes;
}
