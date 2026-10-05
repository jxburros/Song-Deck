import { describe, expect, it } from 'vitest';
import { applyTimedLyrics } from '../src/musician';
import { applyOperations } from '../src/edit';
import { createEmptySong } from '../src/ir/defaults';
import type { Note, Song } from '../src/ir/types';

function song(): Song {
  const s = createEmptySong({ title: 'T', bpm: 120, key: { tonic: 0, mode: 'major' }, id: 's', seed: 1 });
  s.sections = [
    { id: 'sec-a', name: 'Verse', kind: 'verse', bars: 1, energy: 50 },
    { id: 'sec-b', name: 'Chorus', kind: 'chorus', bars: 2, energy: 80 },
  ];
  const notes: Note[] = [0, 1, 2, 3, 4, 5].map((i) => ({
    id: `n${i}`,
    pitch: 60 + i,
    tick: i * 480,
    duration: 400,
    velocity: 90,
  }));
  s.tracks = [
    {
      id: 'voc',
      name: 'Vocal',
      kind: 'midi',
      role: 'vocal',
      instrumentId: 'lead-vocal',
      constraints: {},
      notes,
      clips: [],
      color: '#fff',
      stemGroup: 'vocals',
    } as Song['tracks'][number],
  ];
  return s;
}

describe('applyTimedLyrics', () => {
  it('puts words on the notes sung under them, with melisma and merged syllables, and writes lyric lines per section', () => {
    const s = song();
    // 120 BPM: a quarter note = 0.5 s; notes at 0, 0.5, 1.0, 1.5, 2.0, 2.5 s. Bar 1 = 0–2 s (Verse).
    const res = applyTimedLyrics(s, 'voc', [
      {
        text: 'Beautiful love',
        startSeconds: 0,
        endSeconds: 2,
        words: [
          { word: 'Beautiful', startSeconds: 0, endSeconds: 0.95 },
          { word: 'love,', startSeconds: 1, endSeconds: 1.95 },
        ],
      },
      {
        text: 'Go now',
        startSeconds: 2,
        endSeconds: 6,
        words: [
          { word: 'go', startSeconds: 2, endSeconds: 2.4 },
          { word: 'now', startSeconds: 5, endSeconds: 5.5 },
        ],
      },
    ]);
    expect(res.lines).toEqual([
      { sectionId: 'sec-a', sectionName: 'Verse', lines: ['Beautiful love'] },
      { sectionId: 'sec-b', sectionName: 'Chorus', lines: ['Go now'] },
    ]);
    expect(res.matchedWords).toBe(3);
    expect(res.unmatchedWords).toEqual(['now']);
    const out = applyOperations(s, res.operations).song;
    const syl = out.tracks[0].notes.map((n) => n.syllable ?? null);
    expect(syl).toEqual(['Beau-', 'tiful', 'love', '_', 'go', null]);
    expect(out.lyrics.map((l) => [l.sectionId, l.text])).toEqual([
      ['sec-a', 'Beautiful love'],
      ['sec-b', 'Go now'],
    ]);
  });

  it('honours the recording offset and asks for alignment when there are no word timings', () => {
    const s = song();
    const res = applyTimedLyrics(s, 'voc', [{ text: 'hello there', startSeconds: 0, endSeconds: 1 }], {
      offsetSeconds: 2.2,
    });
    expect(res.lines[0].sectionId).toBe('sec-b');
    expect(res.needsAlignment).toBe(true);
    expect(res.operations.every((o) => o.op === 'set_lyrics')).toBe(true);
  });

  it('never touches locked notes (or the bars that hold them) and says so', () => {
    const s = song();
    s.tracks[0].notes[0].locked = true;
    s.tracks[0].notes[0].syllable = 'keep';
    const res = applyTimedLyrics(
      s,
      'voc',
      [
        {
          text: 'a b',
          startSeconds: 0,
          endSeconds: 3,
          words: [
            { word: 'a', startSeconds: 0, endSeconds: 0.9 },
            { word: 'b', startSeconds: 2, endSeconds: 2.4 },
          ],
        },
      ],
      { syllablesOnly: true },
    );
    const out = applyOperations(s, res.operations).song;
    expect(res.operations.every((o) => o.op !== 'set_lyrics')).toBe(true);
    expect(out.tracks[0].notes[0].syllable).toBe('keep');
    expect(out.tracks[0].notes[1].syllable).toBeUndefined(); // same bar as the locked note
    expect(out.tracks[0].notes[4].syllable).toBe('b');
    expect(res.warnings.join(' ')).toMatch(/locked/);
  });
});
