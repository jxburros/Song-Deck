// Song Deck plugin: a sampled instrument from an SFZ file and WAV samples (spec §57
// "Instruments: Soundfonts"). Tracks using it render with these samples in playback and
// exports; where the plugin is missing they fall back to General MIDI program 4 (electric piano).
export async function register(api) {
  await api.registerSampleInstrument({
    sfz: 'felt-keys.sfz',
    profile: {
      id: 'felt-keys',
      name: 'Felt Keys (sampled)',
      family: 'keys',
      gmProgram: 4,
      range: { low: 21, high: 108, comfortableLow: 36, comfortableHigh: 96 },
      polyphony: 'poly',
      defaultRole: 'keys',
      defaultFunction: 'accompaniment',
      articulations: ['normal', 'staccato', 'legato'],
      patchId: 'epiano',
      clef: 'grand',
      stemGroup: 'keys',
    },
  });
  api.log('registered the Felt Keys sampled instrument');
}
