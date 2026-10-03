import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptySong, LockKeys, type Song, type Track } from '@songdeck/core';
import { takeToNotes, type CapturedNote } from '../src/engine/midi-take';
import { MidiCapture } from '../src/engine/midi-input';

/** 120 BPM 4/4: one second = two beats = 960 ticks; bars 1–4 intro, 5–8 verse. */
function fixture(): { song: Song; track: Track } {
  const song = createEmptySong({ title: 'Take', bpm: 120 });
  song.sections = [
    { id: 'sec_a', name: 'Intro', kind: 'intro', bars: 4, energy: 40 },
    { id: 'sec_b', name: 'Verse', kind: 'verse', bars: 4, energy: 60 },
  ];
  const track = { id: 'trk_keys', name: 'Keys', kind: 'midi', notes: [] } as unknown as Track;
  song.tracks = [track];
  return { song, track };
}

let n = 0;
const newId = () => `n${++n}`;

describe('takeToNotes', () => {
  it('converts seconds to ticks, snaps onsets to the grid and keeps performed lengths', () => {
    const { song, track } = fixture();
    const take: CapturedNote[] = [
      { pitch: 60, velocity: 100, start: 0.52, end: 1.02 }, // tick 499 → 480, length 480
      { pitch: 64, velocity: 200, start: 1.0, end: 1.01 }, // velocity clamps, length → minimum
    ];
    const { notes, blocked } = takeToNotes(song, track, take, newId, { grid: 120 });
    expect(blocked).toBe(0);
    expect(notes.map((x) => [x.pitch, x.tick, x.duration, x.velocity])).toEqual([
      [60, 480, 480, 100],
      [64, 960, 30, 127],
    ]);
    expect(notes.every((x) => x.origin === 'performance')).toBe(true);
  });

  it('honours quantize strength and keeps raw timing without a grid', () => {
    const { song, track } = fixture();
    const take = [{ pitch: 60, velocity: 90, start: 0.52, end: 1 }];
    expect(takeToNotes(song, track, take, newId, { grid: 120, strength: 0.5 }).notes[0].tick).toBe(490);
    expect(takeToNotes(song, track, take, newId).notes[0].tick).toBe(499);
  });

  it('discards notes that land in locked material and skips invalid input', () => {
    const { song, track } = fixture();
    song.locks[LockKeys.trackSection(track.id, 'sec_b')] = true;
    const take: CapturedNote[] = [
      { pitch: 60, velocity: 90, start: 1, end: 1.5 }, // bar 1: kept
      { pitch: 62, velocity: 90, start: 8.5, end: 9 }, // bar 5 (verse, locked): dropped
      { pitch: 200, velocity: 90, start: 2, end: 3 }, // invalid pitch: skipped
      { pitch: 64, velocity: 90, start: Number.NaN, end: 3 }, // invalid time: skipped
    ];
    const { notes, blocked } = takeToNotes(song, track, take, newId, { grid: 120 });
    expect(notes.map((x) => x.pitch)).toEqual([60]);
    expect(blocked).toBe(1);
  });
});

/** A fake MIDI input that delivers messages with explicit timestamps (ms). */
class FakeInput extends EventTarget {
  readonly id = 'in1';
  readonly type = 'input';
  readonly name = 'Fake keys';
  readonly manufacturer = 'Test';
  send(bytes: number[], timeStamp: number) {
    const e = new Event('midimessage') as Event & { data: Uint8Array };
    Object.defineProperty(e, 'data', { value: new Uint8Array(bytes) });
    Object.defineProperty(e, 'timeStamp', { value: timeStamp });
    this.dispatchEvent(e);
  }
}

describe('MidiCapture', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('captures notes with sustain pedal, re-strikes and timestamp-based lengths', async () => {
    const input = new FakeInput();
    const access = Object.assign(new EventTarget(), { inputs: new Map([[input.id, input]]) });
    vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve(access) });
    let songClock = 2; // seconds; the delivery-delay correction is clamped to 0 by future timestamps
    const now = performance.now() + 10_000;
    const cap = new MidiCapture({ clock: () => songClock });
    expect(await cap.start()).toBe(1);

    input.send([0x90, 60, 100], now); // C4 on at song 2.0 s
    songClock = 2.5;
    input.send([0xb0, 64, 127], now + 400); // pedal down
    input.send([0x80, 60, 0], now + 500); // released, but sustained
    input.send([0x90, 64, 80], now + 500); // E4 on at 2.5 s
    input.send([0x90, 64, 0], now + 1000); // E4 off (velocity-0 note-on), sustained
    songClock = 0.1; // loop wrapped back to the start
    input.send([0x90, 64, 90], now + 1200); // E4 re-struck: previous E4 ends now
    input.send([0xb0, 64, 0], now + 1500); // pedal up: the sustained C4 ends here
    input.send([0x80, 64, 0], now + 1500); // the re-struck E4 is released

    const take = cap.stop();
    expect(take).toEqual([
      { pitch: 64, velocity: 90, start: 0.1, end: 0.4 },
      { pitch: 60, velocity: 100, start: 2, end: 3.5 },
      { pitch: 64, velocity: 80, start: 2.5, end: 3.2 },
    ]);
  });
});
