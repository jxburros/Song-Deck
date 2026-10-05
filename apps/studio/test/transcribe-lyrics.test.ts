import { describe, expect, it } from 'vitest';
import { normalizeTranscription } from '../src/views/transcribe/model';

describe('transcription view with lyrics', () => {
  it('puts transcribed words on the notes sung under them, honouring the downbeat offset', () => {
    // 120 BPM: quarter = 0.5 s. The take's bar 1 starts 1.0 s into the recording.
    const view = normalizeTranscription(
      {
        bpm: 120,
        offsetSeconds: 1,
        method: 'test',
        notes: [
          { pitch: 60, startSeconds: 1.0, endSeconds: 1.4, velocity: 90, confidence: 0.9 },
          { pitch: 62, startSeconds: 1.5, endSeconds: 1.9, velocity: 90, confidence: 0.4 },
          { pitch: 64, startSeconds: 2.0, endSeconds: 2.9, velocity: 90 },
        ],
        lyrics: {
          text: 'hello you',
          method: 'Whisper (local) · large-v3-turbo',
          wordTimestamps: true,
          segments: [
            {
              start: 1,
              end: 3,
              text: 'hello you',
              words: [
                { word: 'hello', start: 1.0, end: 1.95 },
                { word: 'you', start: 2.0, end: 2.8 },
              ],
            },
          ],
        },
      },
      { source: 'singing', bpmSource: 'detected', gridBeats: 0, durationSeconds: 4 },
    );
    expect(view.notes.map((n) => n.syllable)).toEqual(['hel-', 'lo', 'you']);
    expect(view.notes[1].confidence).toBe(0.4);
    expect(view.lyrics?.matchedWords).toBe(2);
    expect(view.lyrics?.phrases[0].text).toBe('hello you');
    expect(view.lyrics?.method).toMatch(/Whisper/);
  });

  it('keeps the words when there are no timings and says how to align them', () => {
    const view = normalizeTranscription(
      {
        bpm: 100,
        notes: [{ pitch: 60, startSeconds: 0, endSeconds: 0.5, velocity: 90 }],
        lyrics: { text: 'la', wordTimestamps: false, segments: [{ start: 0, end: 1, text: 'la' }] },
      },
      { source: 'singing', bpmSource: 'detected', gridBeats: 0, durationSeconds: 1 },
    );
    expect(view.notes[0].syllable).toBeUndefined();
    expect(view.lyrics?.phrases).toHaveLength(1);
    expect(view.warnings.join(' ')).toMatch(/Align/);
  });
});
