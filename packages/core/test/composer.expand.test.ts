import { describe, expect, it } from 'vitest';
import { createEmptySong, defaultChannelStrip } from '../src/ir/defaults';
import { cloneSong, songHash } from '../src/ir/song-utils';
import { expandSong, type ExpansionRequest } from '../src/composer/expand';
import { regenerateUnlocked } from '../src/composer/regenerate';
import { LockKeys } from '../src/locks';
import { barToTick, sectionLayout } from '../src/timing';
import { midiToSong, songToMidi } from '../src/io';
import { validityProblems } from './composer-helpers';
import {
  blendGenres,
  getGenre,
  defaultBlueprint,
  planComposition,
  parsePromptToBlueprint,
  blueprintFromChoices,
} from '../src/composer';

function fixture() {
  const song = createEmptySong({
    id: 'source',
    title: 'My hook',
    seed: 1,
    bpm: 110,
    key: { tonic: 0, mode: 'major' },
  });
  song.sections = [{ id: 'source-sec', name: 'Clip', kind: 'custom', bars: 4, energy: 60 }];
  song.tracks = [
    {
      id: 'piano',
      name: 'Piano',
      instrumentId: 'piano',
      color: '#5599ee',
      stemGroup: 'keys',
      kind: 'midi',
      role: 'keys',
      constraints: {},
      clips: [],
      notes: [60, 64, 67, 65, 62, 64, 67, 60].map((pitch, i) => ({
        id: `n${i}`,
        pitch,
        tick: i * 480,
        duration: 360,
        velocity: 85 + i,
      })),
    },
  ];
  song.mixer.channels.piano = defaultChannelStrip();
  return song;
}
const request = (): ExpansionRequest => ({
  seed: 53,
  variation: 0.35,
  regions: [{ id: 'hook', startBar: 0, endBar: 4, kind: 'hook' }],
  arrangement: [
    { kind: 'intro', bars: 2 },
    { kind: 'hook', bars: 4, sourceRegionId: 'hook', preserve: true },
    { kind: 'verse', bars: 4, sourceRegionId: 'hook' },
    { kind: 'chorus', bars: 4, sourceRegionId: 'hook' },
  ],
});
const musical = (n: { pitch: number; tick: number; duration: number; velocity: number }, offset = 0) => [
  n.pitch,
  n.tick - offset,
  n.duration,
  n.velocity,
];

describe('section-aware expansion', () => {
  it('preserves every source event and rest, even after moving a region, without mutating input', () => {
    const source = fixture();
    source.tracks[0].notes.reverse();
    const before = cloneSong(source);
    const result = expandSong(source, request());
    const span = sectionLayout(result.song)[1];
    expect(
      result.song.tracks[0].notes
        .filter((n) => n.tick >= span.startTick && n.tick < span.endTick)
        .map((n) => musical(n, span.startTick)),
    ).toEqual([...source.tracks[0].notes].reverse().map((n) => musical(n)));
    expect(source).toEqual(before);
    expect(result.preservedSectionIds).toEqual([span.section.id]);
    expect(validityProblems(result.song)).toEqual([]);
  });
  it('locks kept sections for future regeneration and retains lyric/phrase references', () => {
    const source = fixture();
    source.lyrics = [{ id: 'line', sectionId: 'source-sec', text: 'My words', trackId: 'piano' }];
    source.phrases = [
      {
        id: 'phrase',
        trackId: 'piano',
        sectionId: 'source-sec',
        startTick: 0,
        endTick: 360,
        lyricLineId: 'line',
      },
    ];
    source.tracks[0].notes[0].lyricLineId = 'line';
    source.tracks[0].notes[0].phraseId = 'phrase';
    source.tracks[0].notes[0].syllable = 'My';
    const { song } = expandSong(source, request());
    const span = sectionLayout(song)[1];
    expect(song.locks[LockKeys.section(span.section.id)]).toBe(true);
    const kept = song.tracks[0].notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick);
    expect(song.lyrics.find((l) => l.id === kept[0].lyricLineId)?.text).toBe('My words');
    expect(song.phrases.find((p) => p.id === kept[0].phraseId)?.startTick).toBe(span.startTick);
    const regenerated = regenerateUnlocked(song, { seed: 999 }).song;
    expect(
      regenerated.tracks[0].notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick),
    ).toEqual(kept);
  });
  it('develops drum clips from their actual grid without transposing the drums', () => {
    const source = fixture();
    source.tracks[0].role = 'drums';
    source.tracks[0].instrumentId = 'drum-kit';
    source.tracks[0].midiChannel = 9;
    source.tracks[0].notes.forEach((n, i) => {
      n.pitch = i % 2 ? 38 : 36;
      n.duration = 60;
    });
    const req = request();
    req.variation = 0;
    const { song } = expandSong(source, req);
    const span = sectionLayout(song)[2];
    const developed = song.tracks[0].notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick);
    expect(developed.map((n) => musical(n, span.startTick))).toEqual(
      source.tracks[0].notes.map((n) => musical(n)),
    );
  });
  it('reproduces the same seed and changes musical events across seeds', () => {
    const source = fixture(),
      req = request();
    expect(songHash(expandSong(source, req).song)).toEqual(songHash(expandSong(source, req).song));
    const versions = [1, 2, 3, 4, 5].map((seed) => expandSong(source, { ...req, seed }).song);
    const signatures = versions.map((s) =>
      JSON.stringify(s.tracks.flatMap((t) => t.notes.map((n) => musical(n)))),
    );
    expect(new Set(signatures).size).toBe(5);
    for (const s of versions) expect(validityProblems(s)).toEqual([]);
  });
  it('keeps tempo, meter and key changes inside relocated source sections', () => {
    const source = fixture();
    source.meterMap = [
      { bar: 0, numerator: 3, denominator: 4 },
      { bar: 2, numerator: 6, denominator: 8 },
    ];
    source.tempoMap = [
      { tick: 0, bpm: 90 },
      { tick: 1700, bpm: 130 },
    ];
    source.keyMap = [
      { bar: 0, key: { tonic: 0, mode: 'major' } },
      { bar: 2, key: { tonic: 7, mode: 'major' } },
    ];
    const { song } = expandSong(source, request());
    const start = sectionLayout(song)[1].startTick;
    expect(song.meterMap).toContainEqual({ bar: 4, numerator: 6, denominator: 8 });
    expect(song.tempoMap).toContainEqual({ tick: start + 1700, bpm: 130 });
    expect(song.keyMap).toContainEqual({ bar: 4, key: { tonic: 7, mode: 'major' } });
    const imported = midiToSong(songToMidi(song));
    expect(imported.tracks.reduce((sum, t) => sum + t.notes.length, 0)).toBe(
      song.tracks.reduce((sum, t) => sum + t.notes.length, 0),
    );
  });
  it('uses the selected source region for section motifs, including overlapping labels', () => {
    const source = fixture();
    source.tracks[0].notes.push({ id: 'different', pitch: 72, tick: 3840, duration: 1200, velocity: 100 });
    const req = request();
    req.regions.push({ id: 'second', startBar: 2, endBar: 4, kind: 'verse' });
    req.arrangement[2].sourceRegionId = 'second';
    const { song } = expandSong(source, req);
    const sec = song.sections[2];
    const motifs = song.motifs.filter((m) => m.sectionIds?.includes(sec.id));
    expect(motifs.length).toBeGreaterThan(0);
    expect(motifs.every((m) => m.notes.length === 1 && m.notes[0].duration === 1200)).toBe(true);
    expect(
      song.tracks[0].notes.some(
        (n) =>
          n.tick >= sectionLayout(song)[2].startTick && n.motifId && motifs.some((m) => m.id === n.motifId),
      ),
    ).toBe(true);
  });
  it('bounds variation to phrase endings and preserves source sections at both extremes', () => {
    const source = fixture(),
      req = request();
    const a = expandSong(source, { ...req, variation: 0 }).song,
      b = expandSong(source, { ...req, variation: 1 }).song;
    expect(a.motifs[0].notes.slice(0, 4)).toEqual(b.motifs[0].notes.slice(0, 4));
    expect(a.motifs[0].notes).not.toEqual(b.motifs[0].notes);
    const span = sectionLayout(a)[1];
    const kept = (s: typeof a) =>
      s.tracks[0].notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick);
    expect(kept(a)).toEqual(kept(b));
  });
  it('reports boundary trimming and preserves drum pitches', () => {
    const source = fixture();
    source.tracks[0].notes[0] = { id: 'tail', pitch: 60, tick: 0, duration: 2400, velocity: 100 };
    source.tracks.push({
      ...cloneSong(source.tracks[0]),
      id: 'drums',
      role: 'drums',
      instrumentId: 'drum-kit',
      midiChannel: 9,
      notes: [{ id: 'kick', tick: 1920, duration: 60, pitch: 36, velocity: 99 }],
    });
    const req = request();
    req.regions[0].startBar = 1;
    req.arrangement[1].bars = 3;
    const { song, warnings } = expandSong(source, req);
    const start = barToTick(song, 2);
    expect(song.tracks[0].notes).toContainEqual(
      expect.objectContaining({ tick: start, duration: 480, pitch: 60 }),
    );
    expect(song.tracks[1].notes).toContainEqual(expect.objectContaining({ tick: start, pitch: 36 }));
    expect(warnings.join(' ')).toContain('trimmed');
  });
  it.each([NaN, Infinity, -1, 1.5])('rejects invalid source boundaries %s', (startBar) => {
    const req = request();
    req.regions[0].startBar = startBar;
    expect(() => expandSong(fixture(), req)).toThrow(/bar ranges/);
  });
  it('rejects unknown references, invalid seeds, lengths, empty MIDI and invalid keys', () => {
    const source = fixture();
    const req = request();
    req.arrangement[1].sourceRegionId = 'missing';
    expect(() => expandSong(source, req)).toThrow(/missing/);
    expect(() => expandSong(source, { ...request(), seed: NaN })).toThrow(/Seed/);
    expect(() => expandSong(source, { ...request(), variation: Infinity })).toThrow(/Variation/);
    const short = request();
    short.arrangement[1].bars = 3;
    expect(() => expandSong(source, short)).toThrow(/match/);
    expect(() => expandSong(source, { ...request(), key: { tonic: 12, mode: 'major' } })).toThrow(/tonic/);
    source.tracks[0].notes = [];
    expect(() => expandSong(source, request())).toThrow(/notes/);
  });
});

describe('research-driven planner corrections', () => {
  it('respects blend weights independently of progression and template catalog size', () => {
    const a = cloneSong(getGenre('pop')!),
      b = cloneSong(getGenre('jazz')!);
    a.id = 'one';
    b.id = 'many';
    a.harmony.progressions = [{ roman: ['I', 'V'], weight: 100 }];
    b.harmony.progressions = [
      { roman: ['ii', 'V', 'I'], weight: 1 },
      { roman: ['I', 'vi'], weight: 3 },
    ];
    a.structure.templates = [{ ...a.structure.templates[0], weight: 100 }];
    b.structure.templates = [{ ...b.structure.templates[0], weight: 1 }];
    const blend = blendGenres(
      [
        { genreId: 'one', weight: 0.3 },
        { genreId: 'many', weight: 0.7 },
      ],
      [a, b],
    );
    expect(blend.harmony.progressions.find((p) => p.roman.join() === 'I,V')!.weight).toBeCloseTo(0.3);
    expect(
      blend.harmony.progressions
        .filter((p) => p.roman.join() !== 'I,V')
        .reduce((sum, p) => sum + p.weight, 0),
    ).toBeCloseTo(0.7);
    expect(blend.structure.templates.map((t) => t.weight)).toEqual([0.7, 0.3]);
  });
  it('keeps section-only prompt moods out of global tags, key choice and macros', () => {
    const neutral = parsePromptToBlueprint('pop with a bridge', { seed: 12 });
    const dark = parsePromptToBlueprint('pop with a dark bridge', { seed: 12 });
    expect(dark.tags ?? []).not.toContain('dark');
    expect(dark.key).toEqual(neutral.key);
    expect(dark.macros).toEqual(neutral.macros);
    const base = blueprintFromChoices({ genres: [{ genreId: 'pop', weight: 1 }] }, { seed: 12 });
    const targeted = blueprintFromChoices(
      { genres: [{ genreId: 'pop', weight: 1 }], moods: [{ tagId: 'dark', section: 'bridge' }] },
      { seed: 12 },
    );
    expect(
      planComposition(targeted)
        .sections.filter((s) => s.kind !== 'bridge')
        .map((s) => s.harmony),
    ).toEqual(
      planComposition(base)
        .sections.filter((s) => s.kind !== 'bridge')
        .map((s) => s.harmony),
    );
  });
  it('does not leak a bridge mood into verse or chorus harmony', () => {
    const bp = defaultBlueprint({ seed: 7 });
    bp.structure = [
      { name: 'Verse', kind: 'verse', bars: 4 },
      { name: 'Chorus', kind: 'chorus', bars: 4 },
      { name: 'Bridge', kind: 'bridge', bars: 4 },
    ];
    for (let seed = 1; seed <= 20; seed++) {
      const neutral = planComposition(bp, { seed });
      const dark = cloneSong(bp);
      dark.structure[2].mood = ['dark', 'haunting'];
      dark.moods = ['Dark bridge', 'Haunting bridge'];
      expect(planComposition(dark, { seed }).sections.slice(0, 2)).toEqual(neutral.sections.slice(0, 2));
    }
  });
});
