import { describe, expect, it } from 'vitest';
import {
  VOCAL_ZONES,
  VOICE_TYPE_ZONES,
  checkSingerRange,
  describeSinger,
  fitToSinger,
  normalizeSinger,
  singerBands,
  singerFromVoiceType,
  singerTop,
  singerZone,
} from '../src/singers';
import { applyOperations, validateSong } from '../src/edit';
import { composeSong, parsePromptToBlueprint, regenerateUnlocked } from '../src/composer';
import { keyAtTick } from '../src/timing';
import type { SingerProfile, Song, VoiceType } from '../src/ir/types';
import { makeSong } from './edit-fixtures';

/** The fixture song with a singer assigned to its vocal (chorus melody B4 A4 G4 F♯4 E4 G4, twice). */
function withSinger(singer: SingerProfile): Song {
  const song = makeSong();
  song.vocals = { ...song.vocals, singers: [singer] };
  const vocal = song.tracks.find((t) => t.id === 'trk_vocal')!;
  vocal.vocal = { ...vocal.vocal, singerId: singer.id };
  return song;
}

const vocalOf = (song: Song) => song.tracks.find((t) => t.id === 'trk_vocal')!;

describe('singer zones', () => {
  it('voice-type presets are ordered, valid zones', () => {
    for (const v of Object.keys(VOICE_TYPE_ZONES) as VoiceType[]) {
      const s = singerFromVoiceType(v, { id: v });
      expect(normalizeSinger(s)).toEqual(s);
      expect(s.lowest).toBeLessThan(s.comfortableLow);
      expect(s.comfortableHigh).toBeLessThan(s.highest);
      expect(s.sweetLow!).toBeGreaterThanOrEqual(s.comfortableLow);
      expect(s.sweetHigh!).toBeLessThanOrEqual(s.comfortableHigh);
    }
  });

  it('places every pitch in a zone, from sweet spot to out of range', () => {
    const tenor = singerFromVoiceType('tenor', { id: 't' }); // C3 D3 [G3–F4] A4 C5 (falsetto F5)
    const zone = (p: number) => singerZone(tenor, p);
    expect([47, 48, 49, 50, 54, 55, 65, 66, 69, 70, 72, 73, 77, 78].map(zone)).toEqual([
      'out',
      'stretch',
      'stretch',
      'comfortable',
      'comfortable',
      'sweet',
      'sweet',
      'comfortable',
      'comfortable',
      'stretch',
      'stretch',
      'falsetto',
      'falsetto',
      'out',
    ]);
    expect(singerTop(tenor)).toBe(77);
    const bands = singerBands(tenor);
    expect(bands.map((b) => b.zone)).toEqual([
      'stretch',
      'comfortable',
      'sweet',
      'comfortable',
      'stretch',
      'falsetto',
    ]);
    expect(bands[0].low).toBe(48);
    expect(bands.at(-1)!.high).toBe(77);
    for (let i = 1; i < bands.length; i++) expect(bands[i].low).toBe(bands[i - 1].high + 1);
    expect(VOCAL_ZONES.map((z) => z.zone)).toEqual(['sweet', 'comfortable', 'stretch', 'falsetto', 'out']);
  });

  it('describes a singer in words', () => {
    expect(describeSinger(singerFromVoiceType('tenor', { id: 't' }))).toBe(
      'sweet spot G3–F4 · easy D3–A4 · difficult but possible C3–C#3, A#4–C5 · falsetto to F5 · nothing below C3 or above F5',
    );
  });

  it('puts edited zones back in order', () => {
    const fixed = normalizeSinger({
      id: 'x',
      name: '  Sam ',
      lowest: 60,
      comfortableLow: 50,
      comfortableHigh: 70.4,
      highest: 65,
      sweetLow: 80,
      sweetHigh: 40,
      falsettoHigh: 66,
    });
    expect(fixed).toEqual({
      id: 'x',
      name: 'Sam',
      lowest: 50,
      comfortableLow: 60,
      comfortableHigh: 65,
      highest: 70,
      sweetLow: 60,
      sweetHigh: 65,
    });
  });
});

describe('range check', () => {
  it('a tenor finds the chorus mostly comfortable and is offered a small key change', () => {
    const song = withSinger(singerFromVoiceType('tenor', { id: 't', name: 'Alex' }));
    const check = checkSingerRange(song, vocalOf(song), song.vocals.singers![0]);
    expect(check.notes).toBe(12);
    expect(check.zones.stretch.notes).toBe(2); // the two B4s
    expect(check.zones.sweet.notes).toBe(2); // the two E4s
    expect(check.zones.comfortable.notes).toBe(8);
    expect(check.verdict).toBe('mostly-comfortable');
    expect(check.summary).toBe('Mostly comfortable: 2 difficult notes (bar 13, 17).');
    expect(check.problems.map((p) => [p.bar, p.pitch, p.zone])).toEqual([
      [13, 71, 'stretch'],
      [17, 71, 'stretch'],
    ]);
    expect(check.lowest).toBe(64);
    expect(check.highest).toBe(71);
    expect(check.best?.semitones).toBe(-2);
    expect(check.best!.score).toBeGreaterThan(check.score);
  });

  it('a baritone is out of comfort in falsetto and is offered the octave below', () => {
    const song = withSinger(singerFromVoiceType('baritone', { id: 'b', name: 'Bo' }));
    const check = checkSingerRange(song, vocalOf(song), song.vocals.singers![0]);
    expect(check.zones.falsetto.notes).toBe(10);
    expect(check.verdict).toBe('demanding');
    expect(check.best?.semitones).toBe(-12);
    const plan = fitToSinger(song, vocalOf(song), -12);
    expect(plan).toMatchObject({ keyShift: 0, octaves: -1 });
    expect(plan.description).toBe('Sing “Vocal” an octave lower');
  });

  it('reports notes out of range by bar', () => {
    const song = withSinger({
      id: 's',
      name: 'Kim',
      lowest: 62,
      comfortableLow: 64,
      comfortableHigh: 67,
      highest: 69,
    });
    const check = checkSingerRange(song, vocalOf(song), song.vocals.singers![0]);
    expect(check.verdict).toBe('out-of-range');
    expect(check.zones.out.notes).toBe(2);
    expect(check.summary).toBe("2 notes are out of Kim's range (bar 13, 17).");
  });

  it('never suggests a key that puts notes out of reach', () => {
    // Long high notes and one short low note: dropping the part makes the long notes easy but would
    // push the short one below Robin's lowest note.
    const robin: SingerProfile = {
      id: 'r',
      name: 'Robin',
      lowest: 45,
      comfortableLow: 47,
      sweetLow: 50,
      sweetHigh: 60,
      comfortableHigh: 60,
      highest: 65,
      falsettoHigh: 72,
    };
    const song = withSinger(robin);
    const vocal = vocalOf(song);
    vocal.notes = vocal.notes.map((n, i) =>
      i === 0 ? { ...n, pitch: 50, duration: 30 } : { ...n, pitch: 71 },
    );
    const check = checkSingerRange(song, vocal, robin);
    expect(check.zones.out.notes).toBe(0);
    expect(check.fits[0].outNotes).toBe(0);
    // no reachable key helps here, so nothing is suggested…
    expect(check.best).toBeUndefined();
    // …although moving down would score better on the long notes alone
    const unreachable = check.fits.find((f) => f.semitones === -11)!;
    expect(unreachable.outNotes).toBe(1);
    expect(unreachable.score).toBeGreaterThan(check.score);
  });

  it('fitting the song to the singer changes key and moves every pitched part with the vocal', () => {
    const song = withSinger(singerFromVoiceType('tenor', { id: 't', name: 'Alex' }));
    const plan = fitToSinger(song, vocalOf(song), -2);
    expect(plan).toMatchObject({ keyShift: -2, octaves: 0 });
    expect(plan.description).toBe('Move the song down 2 semitones (E minor → D minor)');
    const r = applyOperations(song, plan.ops);
    expect(r.report.ok).toBe(true);
    expect(keyAtTick(r.song, 0)).toEqual({ tonic: 2, mode: 'minor' });
    const shift = (id: string) =>
      r.song.tracks
        .find((t) => t.id === id)!
        .notes.map((n, i) => n.pitch - song.tracks.find((t) => t.id === id)!.notes[i].pitch);
    expect(new Set(shift('trk_vocal'))).toEqual(new Set([-2]));
    expect(new Set(shift('trk_bass'))).toEqual(new Set([-2]));
    expect(new Set(shift('trk_drums'))).toEqual(new Set([0]));
    const after = checkSingerRange(r.song, vocalOf(r.song), r.song.vocals.singers![0]);
    expect(after.verdict).toBe('comfortable');

    // +7 (a fifth up) is the nearer key change, down 5, with the vocal an octave higher
    expect(fitToSinger(song, vocalOf(song), 7)).toMatchObject({ keyShift: -5, octaves: 1 });
  });
});

describe('singers in editing and validation', () => {
  it('flags unreachable and difficult notes against the singer, not the instrument', () => {
    const song = withSinger(singerFromVoiceType('tenor', { id: 't', name: 'Alex' }));
    vocalOf(song).notes[0].pitch = 80; // above Alex's falsetto (F5)
    const issues = validateSong(song).issues.filter((i) => i.trackId === 'trk_vocal');
    expect(issues.find((i) => i.code === 'note.out-of-range')?.message).toMatch(
      /outside Alex's range \(48–77\)/,
    );
    expect(issues.find((i) => i.code === 'vocal.difficult')?.message).toBe(
      '1 note is difficult for Alex on "Vocal".',
    );
  });

  it('reports missing singers and zones out of order', () => {
    const song = makeSong();
    song.vocals = {
      ...song.vocals,
      singers: [{ id: 'z', name: 'Zed', lowest: 60, comfortableLow: 50, comfortableHigh: 70, highest: 72 }],
    };
    vocalOf(song).vocal = { singerId: 'nobody' };
    const codes = validateSong(song).issues.map((i) => i.code);
    expect(codes).toContain('singer.invalid');
    expect(codes).toContain('singer.missing');
  });

  it("folds edited notes into the singer's reach", () => {
    const song = withSinger(singerFromVoiceType('tenor', { id: 't', name: 'Alex' }));
    const r = applyOperations(song, [
      {
        op: 'transform_notes',
        track: 'trk_vocal',
        region: { start_bar: 13, end_bar: 13 },
        transform: { transpose: 12 },
      },
    ]);
    const pitches = vocalOf(r.song)
      .notes.filter((n) => n.tick < 13 * 1920)
      .map((n) => n.pitch);
    expect(Math.max(...pitches)).toBeLessThanOrEqual(77);
    expect(r.report.issues.some((i) => /Alex's range/.test(i.message))).toBe(true);
  });
});

describe('composing for a singer', () => {
  it('writes the vocal inside the singer’s full voice, mostly in the easy zone', () => {
    const song = composeSong(
      parsePromptToBlueprint('A pop song with a male tenor vocal in C major', { seed: 11 }),
    );
    const vocal = song.tracks.find((t) => t.role === 'vocal' && t.kind === 'midi')!;
    expect(vocal.notes.length).toBeGreaterThan(20);
    // a low singer: nothing above A3, easy from D3 to G3
    const singer: SingerProfile = {
      id: 'low',
      name: 'Low',
      lowest: 45,
      comfortableLow: 50,
      comfortableHigh: 55,
      highest: 57,
    };
    song.vocals = { ...song.vocals, singers: [singer] };
    vocal.vocal = { ...vocal.vocal, singerId: singer.id };
    const next = regenerateUnlocked(song, { seed: 5, trackIds: [vocal.id] }).song;
    const notes = next.tracks.find((t) => t.id === vocal.id)!.notes;
    expect(notes.length).toBeGreaterThan(20);
    for (const n of notes) {
      expect(n.pitch).toBeGreaterThanOrEqual(singer.lowest);
      expect(n.pitch).toBeLessThanOrEqual(singer.highest);
    }
    const check = checkSingerRange(
      next,
      next.tracks.find((t) => t.id === vocal.id)!,
      singer,
    );
    expect(check.zones.out.notes).toBe(0);
    expect(check.zones.comfortable.seconds / check.totalSeconds).toBeGreaterThan(0.6);
  });
});
