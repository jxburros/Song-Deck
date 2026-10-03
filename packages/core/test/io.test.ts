import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync, unzlibSync } from 'fflate';
import {
  audacityLabels,
  estimateKeyFromNotes,
  markersCsv,
  midiToSong,
  parseMidiFile,
  songToChordSheet,
  songToDawProject,
  songToLyricSheet,
  songToMidi,
  songToMusicXML,
  songToNotationPdf,
  songToReaperProject,
  tempoMapCsv,
  trackToMidi,
  writeMidiFile,
  type MidiEvent,
  type MidiFile,
} from '../src/io';
import { applyOperations } from '../src/edit';
import { cloneSong } from '../src/ir/song-utils';
import { IdFactory } from '../src/util/ids';
import { createRng } from '../src/util/random';
import type { MusicOperation, Song, Track } from '../src/ir/types';
import { makeSong, TICKS } from './edit-fixtures';
import { child, children, descendants, parseXml, type XmlNode } from './io-xml';

const { BAR, Q } = TICKS;

function edit(song: Song, ops: unknown[]): Song {
  const r = applyOperations(song, ops as MusicOperation[], { ids: new IdFactory(3, 'io') });
  expect(r.skipped).toBe(0);
  return r.song;
}

/** Song with tempo, meter and key changes for round-trip tests. */
function makeChangingSong(): Song {
  return edit(makeSong(), [
    { op: 'set_tempo', bpm: 140, at_bar: 5 },
    { op: 'set_tempo', bpm: 90.5, at_bar: 13 },
    { op: 'set_key', tonic: 'G', mode: 'major', at_bar: 13 },
    { op: 'set_meter', numerator: 6, denominator: 8, at_bar: 17 },
  ]);
}

function noteSig(t: Track) {
  return t.notes.map((n) => [n.pitch, n.tick, n.duration, n.velocity, n.syllable ?? null]).sort((a, b) => (a[1] as number) - (b[1] as number) || (a[0] as number) - (b[0] as number));
}

describe('MIDI low level', () => {
  const file: MidiFile = {
    format: 1,
    ticksPerQuarter: 480,
    tracks: [
      {
        events: [
          { tick: 0, type: 'text', metaType: 3, text: 'Conductor ✓' },
          { tick: 0, type: 'tempo', microsecondsPerQuarter: 500000 },
          { tick: 0, type: 'timeSignature', numerator: 6, denominator: 8, clocksPerClick: 36, thirtySecondsPerQuarter: 8 },
          { tick: 0, type: 'keySignature', sharps: -3, minor: true },
          { tick: 960, type: 'text', metaType: 6, text: 'Chorus' },
          { tick: 1000, type: 'meta', metaType: 0x7f, data: Uint8Array.of(0x7d, 1, 2, 3) },
          { tick: 1100, type: 'sysex', data: Uint8Array.of(0x7e, 0x7f, 0x09, 0x01, 0xf7) },
        ],
        endTick: 1920,
      },
      {
        events: [
          { tick: 0, type: 'programChange', channel: 3, program: 33 },
          { tick: 0, type: 'controller', channel: 3, controller: 7, value: 100 },
          { tick: 0, type: 'noteOn', channel: 3, note: 40, velocity: 96 },
          { tick: 240, type: 'pitchBend', channel: 3, value: -4096 },
          { tick: 300, type: 'polyAftertouch', channel: 3, note: 40, pressure: 20 },
          { tick: 400, type: 'channelAftertouch', channel: 3, pressure: 10 },
          { tick: 480, type: 'noteOff', channel: 3, note: 40, velocity: 64 },
          { tick: 480, type: 'noteOn', channel: 3, note: 43, velocity: 80 },
          { tick: 960, type: 'noteOff', channel: 3, note: 43, velocity: 0 },
        ],
      },
    ],
  };

  it('writes and parses every event type (with and without running status)', () => {
    for (const runningStatus of [false, true]) {
      const bytes = writeMidiFile(file, { runningStatus });
      const parsed = parseMidiFile(bytes);
      expect(parsed.format).toBe(1);
      expect(parsed.ticksPerQuarter).toBe(480);
      expect(parsed.tracks[0].events).toEqual(file.tracks[0].events);
      expect(parsed.tracks[0].endTick).toBe(1920);
      expect(parsed.tracks[1].events).toEqual(file.tracks[1].events);
    }
    const repeated: MidiFile = {
      format: 0,
      ticksPerQuarter: 480,
      tracks: [{ events: [60, 64, 67].map((note, i) => ({ tick: i * 10, type: 'noteOn' as const, channel: 0, note, velocity: 90 })) }],
    };
    expect(writeMidiFile(repeated, { runningStatus: true }).length).toBe(writeMidiFile(repeated).length - 2);
    expect(parseMidiFile(writeMidiFile(repeated, { runningStatus: true })).tracks[0].events).toEqual(repeated.tracks[0].events);
  });

  it('reads velocity-0 note-offs, tolerates truncation and rejects non-MIDI data', () => {
    const bytes = Uint8Array.from([
      ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96],
      ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 12],
      ...[0x00, 0x90, 60, 100, 0x60, 60, 0, 0x00, 64, 90, 0x30, 64], // running status; note-on vel 0 = note-off
    ]);
    const f = parseMidiFile(bytes);
    expect(f.tracks[0].events).toEqual([
      { tick: 0, type: 'noteOn', channel: 0, note: 60, velocity: 100 },
      { tick: 96, type: 'noteOff', channel: 0, note: 60, velocity: 64 },
      { tick: 96, type: 'noteOn', channel: 0, note: 64, velocity: 90 },
    ]);
    // Unterminated note: ends at the end of the track; 96 PPQ scaled to 480.
    const song = midiToSong(bytes);
    expect(song.tracks).toHaveLength(1);
    expect(song.tracks[0].notes.map((n) => [n.pitch, n.tick, n.duration])).toEqual([
      [60, 0, 480],
      [64, 480, 240],
    ]);
    expect(() => parseMidiFile(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]))).toThrow(/MThd/);
    const good = songToMidi(makeSong());
    expect(() => parseMidiFile(good.slice(0, good.length - 37))).not.toThrow();
    expect(() => midiToSong(good.slice(0, 900))).not.toThrow();
  });
});

describe('songToMidi', () => {
  const song = makeSong();
  const file = parseMidiFile(songToMidi(song));

  it('writes an SMF type 1 with conductor track, names, programs and channels', () => {
    expect(file.format).toBe(1);
    expect(file.ticksPerQuarter).toBe(480);
    expect(file.tracks).toHaveLength(5);
    const conductor = file.tracks[0].events;
    expect(conductor).toContainEqual({ tick: 0, type: 'tempo', microsecondsPerQuarter: 500000 });
    expect(conductor).toContainEqual({ tick: 0, type: 'timeSignature', numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondsPerQuarter: 8 });
    expect(conductor).toContainEqual({ tick: 0, type: 'keySignature', sharps: 1, minor: true });
    const markers = conductor.filter((e): e is Extract<MidiEvent, { type: 'text' }> => e.type === 'text' && e.metaType === 6);
    expect(markers.map((m) => [m.tick, m.text])).toEqual([
      [0, 'Intro'],
      [4 * BAR, 'Verse'],
      [12 * BAR, 'Chorus'],
    ]);
    const names = file.tracks.slice(1).map((t) => t.events.find((e) => e.type === 'text' && e.metaType === 3) as { text: string });
    expect(names.map((n) => n.text)).toEqual(['Bass', 'Drums', 'Vocal', 'Piano']);
    const programs = file.tracks.slice(1).map((t) => t.events.find((e) => e.type === 'programChange') as { program: number; channel: number } | undefined);
    expect(programs.map((p) => p && [p.channel, p.program])).toEqual([[0, 33], undefined, [1, 53], [2, 0]]);
    const drumChannels = new Set(file.tracks[2].events.filter((e) => e.type === 'noteOn').map((e) => (e as { channel: number }).channel));
    expect([...drumChannels]).toEqual([9]);
  });

  it('writes matched note on/off pairs, lyrics before their notes', () => {
    const vocal = file.tracks[3].events;
    const lyrics = vocal.filter((e) => e.type === 'text' && e.metaType === 5) as { tick: number; text: string }[];
    expect(lyrics.map((l) => l.text)).toEqual(['Hold', 'on', 'to', 'the', 'light-', 'ning', 'Hold', 'on', 'to', 'the', 'light-', 'ning']);
    const firstLyric = vocal.findIndex((e) => e.type === 'text' && e.metaType === 5);
    const firstOn = vocal.findIndex((e) => e.type === 'noteOn');
    expect(firstLyric).toBeLessThan(firstOn);
    for (const t of file.tracks.slice(1)) {
      const ons = t.events.filter((e) => e.type === 'noteOn').length;
      const offs = t.events.filter((e) => e.type === 'noteOff').length;
      expect(ons).toBe(offs);
    }
    expect(file.tracks[1].events.filter((e) => e.type === 'noteOn')).toHaveLength(80);
  });

  it('exports selected tracks and single-track type-0 files', () => {
    const only = parseMidiFile(songToMidi(song, { trackIds: ['trk_vocal'], includeMarkers: false, includeLyrics: false }));
    expect(only.tracks).toHaveLength(2);
    expect(only.tracks[0].events.some((e) => e.type === 'text' && e.metaType === 6)).toBe(false);
    expect(only.tracks[1].events.some((e) => e.type === 'text' && e.metaType === 5)).toBe(false);
    const single = parseMidiFile(trackToMidi(song, 'trk_bass'));
    expect(single.format).toBe(0);
    expect(single.tracks).toHaveLength(1);
    expect(single.tracks[0].events.filter((e) => e.type === 'noteOn')).toHaveLength(80);
    expect(single.tracks[0].events).toContainEqual({ tick: 0, type: 'tempo', microsecondsPerQuarter: 500000 });
    const back = midiToSong(trackToMidi(song, 'trk_bass'));
    expect(back.tracks).toHaveLength(1);
    expect(noteSig(back.tracks[0])).toEqual(noteSig(song.tracks[0]));
    expect(back.sections.map((s) => s.name)).toEqual(['Intro', 'Verse', 'Chorus']);
    expect(() => trackToMidi(song, 'nope')).toThrow();
  });
});

describe('MIDI round trip (songToMidi → midiToSong)', () => {
  for (const [label, make] of [
    ['fixture', makeSong],
    ['tempo/meter/key changes', makeChangingSong],
  ] as const) {
    it(`preserves notes, tempo, meter, key, markers and lyrics exactly (${label})`, () => {
      const song = make();
      const back = midiToSong(songToMidi(song), { ids: new IdFactory(9, 'rt') });
      expect(back.title).toBe('Fixture Song');
      expect(back.tempoMap).toEqual(song.tempoMap);
      expect(back.meterMap).toEqual(song.meterMap);
      expect(back.keyMap).toEqual(song.keyMap);
      expect(back.sections.map((s) => [s.name, s.kind, s.bars, s.energy])).toEqual(song.sections.map((s) => [s.name, s.kind, s.bars, s.energy]));
      expect(back.tracks.map((t) => [t.name, t.instrumentId, t.role, t.midiChannel, t.stemGroup])).toEqual(
        song.tracks.map((t) => [t.name, t.instrumentId, t.role, t.midiChannel, t.stemGroup]),
      );
      back.tracks.forEach((t, i) => expect(noteSig(t)).toEqual(noteSig(song.tracks[i])));
      expect(back.chords.map((c) => [c.tick, c.duration, c.symbol, c.root, c.quality])).toEqual(song.chords.map((c) => [c.tick, c.duration, c.symbol, c.root, c.quality]));
      expect(back.lyrics.map((l) => l.text)).toEqual(song.lyrics.map((l) => l.text));
      const vocal = back.tracks.find((t) => t.role === 'vocal')!;
      const lineOfFirst = back.lyrics.find((l) => l.id === vocal.notes[0].lyricLineId);
      expect(lineOfFirst?.text).toBe('Hold on to the lightning');
      expect(back.mixer.channels[back.tracks[0].id].volumeDb).toBeCloseTo(-6, 0);
    });
  }

  it('recovers structure from standard events only (no Song Deck metadata)', () => {
    const song = makeSong();
    const back = midiToSong(songToMidi(song, { includeSongDeckMeta: false }));
    expect(back.keyMap).toEqual([{ bar: 0, key: { tonic: 4, mode: 'minor' } }]);
    expect(back.sections.map((s) => [s.name, s.kind, s.bars])).toEqual([
      ['Intro', 'intro', 4],
      ['Verse', 'verse', 8],
      ['Chorus', 'chorus', 8],
    ]);
    expect(back.tracks.map((t) => [t.instrumentId, t.role])).toEqual([
      ['electric-bass', 'bass'],
      ['drum-kit', 'drums'],
      ['lead-vocal', 'vocal'],
      ['piano', 'keys'],
    ]);
    expect(back.lyrics.map((l) => l.text)).toEqual(['Hold on to the lightning', 'Hold on to the lightning']);
    expect(back.chords).toEqual([]);
    back.tracks.forEach((t, i) => expect(noteSig(t)).toEqual(noteSig(song.tracks[i])));
  });

  it('prefers markers edited in a DAW over stale embedded sections', () => {
    const bytes = songToMidi(makeSong());
    const file = parseMidiFile(bytes);
    for (const e of file.tracks[0].events) if (e.type === 'text' && e.metaType === 6 && e.text === 'Chorus') e.tick = 8 * BAR;
    const back = midiToSong(writeMidiFile(file));
    expect(back.sections.map((s) => [s.name, s.kind, s.bars])).toEqual([
      ['Intro', 'intro', 4],
      ['Verse', 'verse', 4],
      ['Chorus', 'chorus', 12],
    ]);
  });

  it('splits type-0 files by channel, scales PPQ, generates sections and estimates the key', () => {
    const notes: MidiEvent[] = [];
    const cMajor = [60, 62, 64, 65, 67, 69, 71, 72];
    cMajor.forEach((p, i) => {
      notes.push({ tick: i * 96, type: 'noteOn', channel: 0, note: p, velocity: 80 });
      notes.push({ tick: i * 96 + 90, type: 'noteOff', channel: 0, note: p, velocity: 0 });
    });
    for (let bar = 0; bar < 20; bar++) {
      notes.push({ tick: bar * 384, type: 'noteOn', channel: 9, note: 36, velocity: 100 });
      notes.push({ tick: bar * 384 + 24, type: 'noteOff', channel: 9, note: 36, velocity: 0 });
    }
    notes.push({ tick: 0, type: 'programChange', channel: 0, program: 73 });
    const bytes = writeMidiFile({ format: 0, ticksPerQuarter: 96, tracks: [{ events: notes }] });
    const song = midiToSong(bytes, { title: 'Imported' });
    expect(song.title).toBe('Imported');
    expect(song.tracks.map((t) => [t.instrumentId, t.midiChannel])).toEqual([
      ['flute', 0],
      ['drum-kit', 9],
    ]);
    expect(song.tracks[0].notes.map((n) => [n.tick, n.duration])[1]).toEqual([480, 450]);
    expect(song.keyMap[0].key).toEqual({ tonic: 0, mode: 'major' });
    expect(song.sections.map((s) => [s.name, s.bars])).toEqual([
      ['Section 1', 8],
      ['Section 2', 8],
      ['Section 3', 4],
    ]);
    expect(estimateKeyFromNotes([{ pitch: 64, duration: 2 }, { pitch: 67, duration: 1 }, { pitch: 71, duration: 1 }, { pitch: 66, duration: 1 }])).toEqual({ tonic: 4, mode: 'minor' });
  });

  it('treats embedded metadata as untrusted and survives corrupted files', () => {
    const file = parseMidiFile(songToMidi(makeSong()));
    const enc = (o: unknown) => Uint8Array.from([0x7d, ...new TextEncoder().encode('SongDeck:' + JSON.stringify(o))]);
    for (const t of file.tracks) {
      t.events = t.events.map((e) => {
        if (e.type !== 'meta' || e.metaType !== 0x7f) return e;
        return t === file.tracks[0]
          ? { ...e, data: enc({ v: 1, keys: [{ bar: 0, tonic: 4, mode: 'sad' }], sections: [{ name: 'Intro', kind: 'nope', bars: 4 }, 'x'], chords: [{ tick: -5, duration: 1, symbol: 'Em' }, null], lyrics: [{ section: 'a', text: 1 }] }) }
          : { ...e, data: enc({ instrumentId: '../../etc', role: 'boss', stemGroup: 1, color: 'red;', function: 'x' }) };
      });
    }
    const song = midiToSong(writeMidiFile(file));
    expect(song.keyMap[0].key).toEqual({ tonic: 4, mode: 'minor' }); // from the standard key signature
    expect(song.sections.map((s) => [s.name, s.kind])).toEqual([
      ['Intro', 'intro'],
      ['Verse', 'verse'],
      ['Chorus', 'chorus'],
    ]);
    expect(song.chords).toEqual([]);
    expect(song.tracks[0]).toMatchObject({ instrumentId: 'electric-bass', role: 'bass', stemGroup: 'bass' });
    expect(song.tracks[0].color).toMatch(/^#/);
    // Random corruption never crashes the importer (it either imports or rejects the header).
    const rng = createRng(5);
    const good = songToMidi(makeSong());
    for (let i = 0; i < 150; i++) {
      const b = good.slice(0, rng.next() < 0.3 ? Math.floor(rng.next() * good.length) : good.length);
      for (let k = 0; k < 10; k++) b[Math.floor(rng.next() * b.length)] = Math.floor(rng.next() * 256);
      try {
        midiToSong(b);
      } catch (e) {
        expect((e as Error).message).toMatch(/MThd/);
      }
    }
  });

  it('attaches karaoke lyrics from a separate track to the melody', () => {
    const melody: MidiEvent[] = [];
    const lyrics: MidiEvent[] = [];
    ['/Twin', 'kle ', 'twin', 'kle\r', 'lit', 'tle ', 'star'].forEach((text, i) => {
      melody.push({ tick: i * 480, type: 'noteOn', channel: 0, note: 60 + i, velocity: 90 });
      melody.push({ tick: i * 480 + 400, type: 'noteOff', channel: 0, note: 60 + i, velocity: 0 });
      lyrics.push({ tick: i * 480, type: 'text', metaType: 5, text });
    });
    const bytes = writeMidiFile({ format: 1, ticksPerQuarter: 480, tracks: [{ events: lyrics }, { events: melody }] });
    const song = midiToSong(bytes);
    expect(song.tracks).toHaveLength(1);
    expect(song.tracks[0].role).toBe('vocal');
    expect(song.tracks[0].notes.map((n) => n.syllable)).toEqual(['Twin-', 'kle', 'twin-', 'kle', 'lit-', 'tle', 'star']);
    expect(song.lyrics.map((l) => l.text)).toEqual(['Twinkle twinkle', 'little star']);
  });
});

// ---------------------------------------------------------------------------
// MusicXML
// ---------------------------------------------------------------------------

function measureDurations(measure: XmlNode, divisions: number, beats: number, beatType: number) {
  const len = (divisions * 4 * beats) / beatType;
  let pos = 0;
  let max = 0;
  const perVoice = new Map<string, number>();
  for (const el of measure.children) {
    if (el.name === 'note') {
      if (child(el, 'chord') || child(el, 'grace')) continue;
      const d = Number(child(el, 'duration')!.text);
      const v = child(el, 'voice')?.text ?? '1';
      perVoice.set(v, (perVoice.get(v) ?? 0) + d);
      pos += d;
    } else if (el.name === 'backup') pos -= Number(child(el, 'duration')!.text);
    else if (el.name === 'forward') {
      const d = Number(child(el, 'duration')!.text);
      const v = child(el, 'voice')?.text ?? '1';
      perVoice.set(v, (perVoice.get(v) ?? 0) + d);
      pos += d;
    }
    expect(pos).toBeGreaterThanOrEqual(0);
    max = Math.max(max, pos);
  }
  return { len, max, perVoice };
}

describe('songToMusicXML', () => {
  const song = makeChangingSong();
  const xml = songToMusicXML(song);
  const root = parseXml(xml);

  it('is well-formed MusicXML 4.0 partwise with one part per track', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"')).toBe(true);
    expect(xml).toContain('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"');
    expect(root.name).toBe('score-partwise');
    expect(root.attrs.version).toBe('4.0');
    expect(child(child(root, 'work')!, 'work-title')!.text).toBe('Fixture Song');
    const parts = children(root, 'part');
    expect(parts).toHaveLength(4);
    expect(descendants(child(root, 'part-list')!, 'part-name').map((n) => n.text)).toEqual(['Bass', 'Drums', 'Vocal', 'Piano']);
    for (const p of parts) expect(children(p, 'measure')).toHaveLength(20);
  });

  it('fills every measure exactly in every voice', () => {
    const divisions = Number(descendants(root, 'divisions')[0].text);
    expect(divisions).toBe(4);
    for (const part of children(root, 'part')) {
      let beats = 4;
      let beatType = 4;
      for (const m of children(part, 'measure')) {
        const time = descendants(m, 'time')[0];
        if (time) {
          beats = Number(child(time, 'beats')!.text);
          beatType = Number(child(time, 'beat-type')!.text);
        }
        const { len, max, perVoice } = measureDurations(m, divisions, beats, beatType);
        expect(max).toBe(len);
        for (const [, total] of perVoice) expect(total).toBe(len);
      }
    }
  });

  it('writes key, time, clefs, tempo, rehearsal marks, harmony and lyrics', () => {
    const [bass, drums, vocal, piano] = children(root, 'part');
    const firstAttrs = child(children(bass, 'measure')[0], 'attributes')!;
    expect(child(child(firstAttrs, 'key')!, 'fifths')!.text).toBe('1');
    expect(child(child(firstAttrs, 'key')!, 'mode')!.text).toBe('minor');
    expect(child(child(firstAttrs, 'clef')!, 'sign')!.text).toBe('F');
    expect(child(child(firstAttrs, 'clef')!, 'clef-octave-change')!.text).toBe('-1');
    // key change to G major at bar 13 and 6/8 at bar 17
    const m13 = children(vocal, 'measure')[12];
    expect(descendants(m13, 'fifths')[0].text).toBe('1');
    expect(descendants(m13, 'mode')[0].text).toBe('major');
    expect(descendants(children(vocal, 'measure')[16], 'beat-type')[0].text).toBe('8');
    // drums: percussion clef, unpitched notes with instruments
    expect(descendants(drums, 'sign')[0].text).toBe('percussion');
    expect(descendants(drums, 'unpitched').length).toBeGreaterThan(0);
    expect(descendants(drums, 'pitch')).toHaveLength(0);
    expect(descendants(child(root, 'part-list')!, 'midi-unpitched').map((n) => n.text)).toEqual(['37', '39', '43']);
    // piano: grand staff
    expect(descendants(piano, 'staves')[0].text).toBe('2');
    expect(descendants(piano, 'clef')).toHaveLength(2);
    // tempo & rehearsal on the first part
    expect(descendants(bass, 'sound').map((s) => s.attrs.tempo)).toEqual(['120', '140', '90.5']);
    expect(descendants(bass, 'rehearsal').map((r) => r.text)).toEqual(['Intro', 'Verse', 'Chorus']);
    expect(descendants(vocal, 'rehearsal')).toHaveLength(0);
    // harmony
    const harmonies = descendants(bass, 'harmony');
    expect(harmonies.length).toBeGreaterThanOrEqual(19);
    expect(child(child(harmonies[0], 'root')!, 'root-step')!.text).toBe('E');
    expect(child(harmonies[0], 'kind')!.text).toBe('minor');
    expect(descendants(vocal, 'harmony')).toHaveLength(0);
    // lyrics with syllabic
    const lyrics = descendants(vocal, 'lyric').map((l) => [child(l, 'syllabic')!.text, child(l, 'text')!.text]);
    expect(lyrics.slice(0, 6)).toEqual([
      ['single', 'Hold'],
      ['single', 'on'],
      ['single', 'to'],
      ['single', 'the'],
      ['begin', 'light'],
      ['end', 'ning'],
    ]);
  });

  it('ties notes across barlines, marks accidentals and chords', () => {
    const s = edit(makeSong(), [
      { op: 'replace_notes', track: 'vocal', region: { start_bar: 13, end_bar: 14 }, notes: [{ pitch: 'F4', bar: 13, beat: 4, duration_beats: 2 }, { pitch: 'F#4', bar: 14, beat: 3, duration_beats: 1 }] },
      { op: 'add_notes', track: 'piano', notes: [{ pitch: 'C5', bar: 1, beat: 1, duration_beats: 4 }] },
    ]);
    const r = parseXml(songToMusicXML(s, { trackIds: ['trk_vocal', 'trk_piano'] }));
    const [vocal, piano] = children(r, 'part');
    const m13 = children(vocal, 'measure')[12];
    const notes13 = children(m13, 'note').filter((n) => child(n, 'pitch'));
    expect(notes13).toHaveLength(1);
    expect(child(notes13[0], 'accidental')!.text).toBe('natural');
    expect(children(notes13[0], 'tie').map((t) => t.attrs.type)).toEqual(['start']);
    const notes14 = children(children(vocal, 'measure')[13], 'note').filter((n) => child(n, 'pitch'));
    expect(children(notes14[0], 'tie').map((t) => t.attrs.type)).toEqual(['stop']);
    expect(child(notes14[0], 'accidental')).toBeUndefined();
    expect(child(notes14[1], 'accidental')!.text).toBe('sharp');
    // C5 lands on the treble staff of the grand staff alongside the triad below middle C (bass staff).
    const m1 = children(piano, 'measure')[0];
    const staff1 = children(m1, 'note').filter((n) => child(n, 'staff')?.text === '1' && child(n, 'pitch'));
    expect(staff1.map((n) => child(child(n, 'pitch')!, 'step')!.text)).toEqual(['C']);
    const staff2 = children(m1, 'note').filter((n) => child(n, 'staff')?.text === '2' && child(n, 'pitch'));
    expect(staff2.filter((n) => child(n, 'chord'))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Sheets, markers
// ---------------------------------------------------------------------------

describe('chord & lyric sheets, tempo map and markers', () => {
  it('chord sheet shows sections, beat slots and roman numerals', () => {
    const sheet = songToChordSheet(makeChangingSong());
    expect(sheet).toContain('Fixture Song');
    expect(sheet).toContain('Key: E minor · Tempo: 120 BPM · Time: 4/4');
    expect(sheet).toContain('[Verse] (8 bars) — tempo: 140 BPM');
    expect(sheet).toContain('[Chorus] (8 bars) — key: G major, tempo: 90.5 BPM');
    expect(sheet).toMatch(/\| Em +\. +\. +\. +\| C +\. +\. +\. +\| G +\. +\. +\. +\| D +\. +\. +\. +\|/);
    expect(sheet).toMatch(/ i +VI +III +VII/);
    expect(sheet).toMatch(/ vi +IV +I +V/);
    expect(sheet).toMatch(/\| Em +\. +\. +\. +\. +\. +\|/); // 6/8 bars have six slots
  });

  it('lyric sheet lists section lyrics, falling back to sung syllables', () => {
    const song = makeSong();
    expect(songToLyricSheet(song)).toBe('Fixture Song\n============\n\n[Chorus]\nHold on to the lightning\nHold on to the lightning\n');
    const noLines = cloneSong(song);
    noLines.lyrics = [];
    expect(songToLyricSheet(noLines)).toContain('[Chorus]\nHold on to the lightning\nHold on to the lightning\n');
    noLines.tracks[2].notes = [];
    expect(songToLyricSheet(noLines)).toContain('(no lyrics)');
  });

  it('tempo map CSV, marker CSV and Audacity labels', () => {
    const song = makeChangingSong();
    const tempo = tempoMapCsv(song).trim().split('\n');
    expect(tempo[0]).toBe('bar,beat,tick,seconds,bpm,numerator,denominator');
    expect(tempo.slice(1)).toEqual(['1,1,0,0.000000,120,4,4', '5,1,7680,8.000000,140,4,4', '13,1,23040,21.714286,90.5,4,4', '17,1,30720,32.322021,90.5,6,8']);
    const markers = markersCsv(song).trim().split('\n');
    expect(markers).toEqual([
      '#,Name,Kind,Start Bar,End Bar,Start (s),End (s),Length (s)',
      '1,Intro,intro,1,4,0.000,8.000,8.000',
      '2,Verse,verse,5,12,8.000,21.714,13.714',
      '3,Chorus,chorus,13,20,21.714,40.278,18.564',
    ]);
    expect(audacityLabels(makeSong())).toBe('0.000000\t8.000000\tIntro\n8.000000\t24.000000\tVerse\n24.000000\t40.000000\tChorus\n');
  });
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

interface PdfCheck {
  objects: Map<number, string>;
  pageCount: number;
  contents: string[];
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Verify header, xref offsets and trailer; return objects and decompressed page contents. */
function checkPdf(bytes: Uint8Array): PdfCheck {
  const text = latin1(bytes);
  expect(text.startsWith('%PDF-1.4\n')).toBe(true);
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  const sx = /startxref\n(\d+)\n%%EOF\s*$/.exec(text);
  expect(sx).not.toBeNull();
  const xrefAt = Number(sx![1]);
  expect(text.slice(xrefAt, xrefAt + 5)).toBe('xref\n');
  const head = /^xref\n0 (\d+)\n/.exec(text.slice(xrefAt))!;
  const count = Number(head[1]);
  const entriesStart = xrefAt + head[0].length;
  const objects = new Map<number, string>();
  for (let n = 0; n < count; n++) {
    const entry = text.slice(entriesStart + n * 20, entriesStart + (n + 1) * 20);
    expect(entry).toMatch(/^\d{10} \d{5} [nf] \n$/);
    if (n === 0) {
      expect(entry).toBe('0000000000 65535 f \n');
      continue;
    }
    const offset = Number(entry.slice(0, 10));
    expect(text.slice(offset, offset + `${n} 0 obj`.length)).toBe(`${n} 0 obj`);
    const end = text.indexOf('endobj', offset);
    objects.set(n, text.slice(offset, end));
  }
  const trailer = /trailer\n<< \/Size (\d+) \/Root (\d+) 0 R/.exec(text)!;
  expect(Number(trailer[1])).toBe(count);
  expect(objects.get(Number(trailer[2]))).toContain('/Type /Catalog');
  const pagesObj = [...objects.values()].find((o) => o.includes('/Type /Pages'))!;
  const pageCount = Number(/\/Count (\d+)/.exec(pagesObj)![1]);
  const pageObjs = [...objects.values()].filter((o) => /\/Type \/Page\b/.test(o) && !o.includes('/Type /Pages'));
  expect(pageObjs).toHaveLength(pageCount);
  const contents: string[] = [];
  for (const p of pageObjs) {
    const ref = Number(/\/Contents (\d+) 0 R/.exec(p)![1]);
    const obj = objects.get(ref)!;
    const len = Number(/\/Length (\d+)/.exec(obj)![1]);
    const start = obj.indexOf('stream\n') + 'stream\n'.length;
    const raw = obj.slice(start, start + len);
    expect(obj.slice(start + len, start + len + '\nendstream'.length)).toBe('\nendstream');
    const data = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
    contents.push(obj.includes('/FlateDecode') ? latin1(unzlibSync(data)) : raw);
  }
  return { objects, pageCount, contents };
}

describe('songToNotationPdf', () => {
  it('produces a valid PDF with correct xref offsets and a lead sheet', () => {
    const song = makeSong();
    const pdf = checkPdf(songToNotationPdf(song));
    expect(pdf.pageCount).toBe(1);
    const content = pdf.contents[0];
    for (const t of ['(Fixture Song) Tj', '(Hold) Tj', '(light) Tj', '(ning) Tj', '(-) Tj', '(Em) Tj', '(Chorus) Tj', '(= 120) Tj']) expect(content).toContain(t);
    expect(content).toMatch(/ c\n/); // Bézier glyphs
    expect(content).toMatch(/ re\n/); // rests / boxes
    const fonts = [...pdf.objects.values()].filter((o) => o.includes('/Type /Font')).map((o) => /\/BaseFont \/([\w-]+)/.exec(o)![1]);
    expect(fonts).toEqual(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique']);
  });

  it('is deterministic, supports uncompressed output, other tracks and multiple pages', () => {
    const song = makeSong();
    expect(songToNotationPdf(song)).toEqual(songToNotationPdf(song));
    const raw = checkPdf(songToNotationPdf(song, { compress: false, trackId: 'trk_bass', title: 'Bass Part', pageSize: 'a4' }));
    expect(raw.contents[0]).toContain('(Bass Part) Tj');
    expect([...raw.objects.values()].some((o) => o.includes('/MediaBox [0 0 595.28 841.89]'))).toBe(true);
    const long = edit(makeSong(), [
      { op: 'insert_section', section: { name: 'Chorus 2', kind: 'chorus', bars: 64 }, copy_from: 'Chorus' },
      { op: 'insert_section', section: { name: 'Coda', kind: 'outro', bars: 64 }, copy_from: 'Chorus' },
    ]);
    const multi = checkPdf(songToNotationPdf(long));
    expect(multi.pageCount).toBeGreaterThan(1);
    expect(multi.contents[multi.pageCount - 1]).toContain(`(${multi.pageCount} / ${multi.pageCount}) Tj`);
  });

  it('renders a chord chart when there is no melody, and handles odd input', () => {
    const song = makeSong();
    song.tracks = [];
    const pdf = checkPdf(songToNotationPdf(song));
    expect(pdf.contents[0]).toContain('(D) Tj');
    const empty = checkPdf(songToNotationPdf({ ...makeSong(), sections: [], chords: [], tracks: [], title: 'Ünïcødé “quotes” (parens) \\' }));
    expect(empty.pageCount).toBe(1);
    expect(empty.contents[0]).toContain('\\(parens\\) \\\\) Tj');
  });
});

// ---------------------------------------------------------------------------
// DAW formats
// ---------------------------------------------------------------------------

function wav(seconds: number, sampleRate = 8000): Uint8Array {
  const frames = Math.round(seconds * sampleRate);
  const data = new Uint8Array(44 + frames * 2);
  const view = new DataView(data.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => (data[o + i] = c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, frames * 2, true);
  return data;
}

describe('songToDawProject', () => {
  it('writes a DAWproject zip with transport, tracks, channels, notes, markers and audio', () => {
    const song = makeChangingSong();
    song.mixer.channels.trk_bass = { ...song.mixer.channels.trk_bass, volumeDb: 0, pan: -1, mute: true };
    const audio = wav(2.5);
    const zip = unzipSync(songToDawProject(song, { audio: [{ trackId: 'trk_vocal', path: 'audio/vocal.wav', data: audio }] }));
    expect(Object.keys(zip).sort()).toEqual(['audio/vocal.wav', 'metadata.xml', 'project.xml']);
    expect(zip['audio/vocal.wav']).toEqual(audio);
    const project = parseXml(strFromU8(zip['project.xml']));
    expect(project.name).toBe('Project');
    expect(project.attrs.version).toBe('1.0');
    expect(child(project, 'Application')!.attrs.name).toBe('Song Deck');
    const transport = child(project, 'Transport')!;
    expect(child(transport, 'Tempo')!.attrs).toMatchObject({ unit: 'bpm', value: '120.0' });
    expect(child(transport, 'TimeSignature')!.attrs).toMatchObject({ numerator: '4', denominator: '4' });
    const tracks = children(child(project, 'Structure')!, 'Track');
    expect(tracks.map((t) => [t.attrs.name, t.attrs.contentType])).toEqual([
      ['Bass', 'notes'],
      ['Drums', 'notes'],
      ['Vocal', 'notes'],
      ['Vocal (audio)', 'audio'],
      ['Piano', 'notes'],
      ['Master', 'audio notes'],
    ]);
    const master = child(tracks[5], 'Channel')!;
    expect(master.attrs.role).toBe('master');
    const bassChannel = child(tracks[0], 'Channel')!;
    expect(bassChannel.attrs.destination).toBe(master.attrs.id);
    expect(child(bassChannel, 'Volume')!.attrs).toMatchObject({ unit: 'linear', value: '1.0' });
    expect(child(bassChannel, 'Pan')!.attrs).toMatchObject({ unit: 'normalized', value: '0.0' });
    expect(child(bassChannel, 'Mute')!.attrs.value).toBe('true');
    const arrangement = child(project, 'Arrangement')!;
    expect(descendants(arrangement, 'Marker').map((m) => [m.attrs.name, m.attrs.time])).toEqual([
      ['Intro', '0.0'],
      ['Verse', '16.0'],
      ['Chorus', '48.0'],
    ]);
    const tempo = child(arrangement, 'TempoAutomation')!;
    expect(child(tempo, 'Target')!.attrs.parameter).toBe(child(transport, 'Tempo')!.attrs.id);
    expect(children(tempo, 'RealPoint').map((p) => [p.attrs.time, p.attrs.value])).toEqual([
      ['0.0', '120.0'],
      ['16.0', '140.0'],
      ['48.0', '90.5'],
    ]);
    expect(children(child(arrangement, 'TimeSignatureAutomation')!, 'TimeSignaturePoint').map((p) => p.attrs.numerator)).toEqual(['4', '6']);
    const lanes = children(child(arrangement, 'Lanes')!, 'Lanes');
    expect(lanes.map((l) => l.attrs.track)).toEqual(tracks.slice(0, 5).map((t) => t.attrs.id));
    const bassNotes = descendants(lanes[0], 'Note');
    expect(bassNotes).toHaveLength(song.tracks[0].notes.length); // 6/8 re-barring dropped beat 4 of bars 17–20
    expect(bassNotes).toHaveLength(76);
    expect(bassNotes[0].attrs).toMatchObject({ time: '0.0', duration: '1.0', key: '40', channel: '0' });
    expect(Number(bassNotes[0].attrs.vel)).toBeCloseTo(96 / 127, 5);
    expect(descendants(lanes[1], 'Note')[0].attrs.channel).toBe('9');
    const audioNode = descendants(lanes[3], 'Audio')[0];
    expect(audioNode.attrs).toMatchObject({ sampleRate: '8000', channels: '1', duration: '2.5' });
    expect(child(audioNode, 'File')!.attrs.path).toBe('audio/vocal.wav');
    expect(strFromU8(zip['metadata.xml'])).toContain('<Title>Fixture Song</Title>');
    // reproducible archive
    expect(songToDawProject(song)).toEqual(songToDawProject(song));
  });
});

describe('songToReaperProject', () => {
  it('writes balanced RPP blocks with tempo, markers, tracks and in-project MIDI', () => {
    const song = makeChangingSong();
    const rpp = songToReaperProject(song, { audio: [{ trackId: 'trk_vocal', path: 'audio/vocal.wav', durationSeconds: 12 }] });
    const lines = rpp.trim().split('\n');
    expect(lines[0]).toMatch(/^<REAPER_PROJECT 0\.1 /);
    let depth = 0;
    for (const l of lines) {
      if (l.trim().startsWith('<')) depth++;
      if (l.trim() === '>') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(rpp).toContain('  TEMPO 120 4 4');
    expect(rpp).toContain('<TEMPOENVEX');
    expect(lines.filter((l) => l.trim().startsWith('PT '))).toEqual(['    PT 0 120 1 262148', '    PT 8 140 1', '    PT 21.714285714 90.5 1', '    PT 32.322020521 90.5 1 524294']);
    expect(lines.filter((l) => l.startsWith('  MARKER'))).toEqual(['  MARKER 1 0 "Intro" 0 0 1', '  MARKER 2 8 "Verse" 0 0 1', '  MARKER 3 21.714285714 "Chorus" 0 0 1']);
    expect(lines.filter((l) => l.startsWith('  <TRACK'))).toHaveLength(5);
    expect(lines.filter((l) => l.trim() === '<SOURCE MIDI')).toHaveLength(4);
    expect(lines.filter((l) => l.trim() === 'HASDATA 1 480 QN')).toHaveLength(4);
    expect(rpp).toContain('<SOURCE WAVE\n        FILE "audio/vocal.wav"');
    expect(rpp).toContain('NAME "Bass"');
    // Bass: program change + 80 on/off pairs + end-of-item marker; deltas add up to the song length.
    const bassStart = lines.indexOf('    NAME "Bass"');
    const events: string[] = [];
    for (let i = bassStart; !lines[i].startsWith('  >'); i++) if (lines[i].trim().startsWith('E ')) events.push(lines[i].trim());
    expect(events).toHaveLength(1 + 2 * song.tracks[0].notes.length + 1);
    expect(events[0]).toBe('E 0 c0 21 00');
    expect(events[1]).toBe('E 0 90 28 60');
    expect(events[events.length - 1]).toMatch(/^E \d+ b0 7b 00$/);
    const total = events.reduce((sum, e) => sum + Number(e.split(' ')[1]), 0);
    expect(total).toBeGreaterThanOrEqual(20 * BAR - 4 * BAR);
    expect(rpp).toMatch(/E 0 99 24 6e/); // kick on channel 10
  });
});

it('fixture sanity: tick constants', () => {
  expect(BAR).toBe(1920);
  expect(Q).toBe(480);
});
