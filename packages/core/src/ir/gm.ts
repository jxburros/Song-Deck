/** General MIDI constants shared by generators, MIDI IO and the guide renderer. */

export const GM_DRUM = {
  KICK_ACOUSTIC: 35,
  KICK: 36,
  SIDE_STICK: 37,
  SNARE: 38,
  CLAP: 39,
  SNARE_ELECTRIC: 40,
  FLOOR_TOM_LOW: 41,
  HIHAT_CLOSED: 42,
  FLOOR_TOM_HIGH: 43,
  HIHAT_PEDAL: 44,
  TOM_LOW: 45,
  HIHAT_OPEN: 46,
  TOM_LOW_MID: 47,
  TOM_HIGH_MID: 48,
  CRASH: 49,
  TOM_HIGH: 50,
  RIDE: 51,
  CHINA: 52,
  RIDE_BELL: 53,
  TAMBOURINE: 54,
  SPLASH: 55,
  COWBELL: 56,
  CRASH_2: 57,
  VIBRASLAP: 58,
  RIDE_2: 59,
  BONGO_HIGH: 60,
  BONGO_LOW: 61,
  CONGA_MUTE: 62,
  CONGA_HIGH: 63,
  CONGA_LOW: 64,
  TIMBALE_HIGH: 65,
  TIMBALE_LOW: 66,
  AGOGO_HIGH: 67,
  AGOGO_LOW: 68,
  CABASA: 69,
  MARACAS: 70,
  WHISTLE_SHORT: 71,
  WHISTLE_LONG: 72,
  GUIRO_SHORT: 73,
  GUIRO_LONG: 74,
  CLAVES: 75,
  WOODBLOCK_HIGH: 76,
  WOODBLOCK_LOW: 77,
  CUICA_MUTE: 78,
  CUICA_OPEN: 79,
  TRIANGLE_MUTE: 80,
  TRIANGLE_OPEN: 81,
  SHAKER: 82,
} as const;

export const GM_DRUM_CHANNEL = 9;

export const GM_DRUM_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(GM_DRUM).map(([k, v]) => [v, k.toLowerCase().replace(/_/g, ' ')]),
);

export const GM_PROGRAM_NAMES: readonly string[] = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano', 'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)', 'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)', 'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)', 'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

/** GM program family (program / 8). */
export const GM_FAMILIES: readonly string[] = [
  'Piano', 'Chromatic Percussion', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass',
  'Reed', 'Pipe', 'Synth Lead', 'Synth Pad', 'Synth Effects', 'Ethnic', 'Percussive', 'Sound Effects',
];
