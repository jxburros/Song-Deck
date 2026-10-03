import { describe, expect, it } from 'vitest';
import { PPQ, keyName, sectionLayout, songHash, type Note, type Song } from '@songdeck/core';
import { rebuildProject, separateSources, transcribeAudio, type RebuildStage } from '../src/analysis';
import type { AudioData } from '../src/types';
import { chordBlocks, clickTrack, hummedMelody, mono, renderDrums, rockBeat, stereo, synthSong, type SynthSong } from './analysis-signals';

const SR = 22050;
const STAGE_ORDER: RebuildStage['id'][] = ['separation', 'tempo', 'key', 'chords', 'pitch', 'instruments', 'midi', 'structure'];

let cached: { song: SynthSong; audio: AudioData } | undefined;

/** First `seconds` of an audio buffer (keeps the slower end-to-end tests short). */
function head(buf: AudioData, seconds: number): AudioData {
  const n = Math.min(buf.channels[0].length, Math.round(seconds * buf.sampleRate));
  return { sampleRate: buf.sampleRate, channels: buf.channels.map((c) => c.slice(0, n)) };
}
function testSong(): { song: SynthSong; audio: AudioData } {
  if (!cached) {
    const song = synthSong(
      SR,
      [
        { label: 'A', bars: 4, chords: ['Em', 'C', 'Em', 'C'], energy: 0.35 },
        { label: 'B', bars: 4, chords: ['G', 'D', 'Em', 'C'], energy: 0.9 },
        { label: 'A', bars: 2, chords: ['Em', 'C'], energy: 0.35 },
      ],
      { lead: 0.4 },
    );
    cached = { song, audio: stereo(SR, song.left, song.right) };
  }
  return cached;
}

/** Fraction of truth notes found with the same pitch within ±1/8 beat. */
function noteRecall(truth: { pitch: number; start: number }[], notes: Note[], offset: number, bpm: number): number {
  const tol = PPQ / 2;
  let ok = 0;
  for (const t of truth) {
    const tick = ((t.start - offset) * bpm * PPQ) / 60;
    if (notes.some((n) => n.pitch === t.pitch && Math.abs(n.tick - tick) <= tol)) ok++;
  }
  return ok / truth.length;
}

function validateSong(song: Song): void {
  expect(song.schemaVersion).toBe(1);
  expect(song.ppq).toBe(PPQ);
  expect(song.tempoMap[0].tick).toBe(0);
  expect(song.sections.length).toBeGreaterThan(0);
  const layout = sectionLayout(song);
  const songEnd = layout[layout.length - 1].endTick;
  for (const t of song.tracks) {
    expect(song.mixer.channels[t.id]).toBeDefined();
    for (const n of t.notes) {
      expect(Number.isInteger(n.tick) && n.tick >= 0).toBe(true);
      expect(Number.isInteger(n.duration) && n.duration > 0).toBe(true);
      expect(n.pitch).toBeGreaterThanOrEqual(0);
      expect(n.pitch).toBeLessThanOrEqual(127);
      expect(n.velocity).toBeGreaterThanOrEqual(1);
      expect(n.velocity).toBeLessThanOrEqual(127);
      expect(n.confidence).toBeGreaterThan(0);
      expect(n.confidence).toBeLessThanOrEqual(1);
      expect(n.tick).toBeLessThan(songEnd);
    }
    for (let i = 1; i < t.notes.length; i++) {
      const a = t.notes[i - 1];
      const b = t.notes[i];
      expect(a.tick < b.tick || (a.tick === b.tick && a.pitch <= b.pitch)).toBe(true);
    }
  }
  for (const c of song.chords) {
    expect(c.duration).toBeGreaterThan(0);
    expect(c.symbol.length).toBeGreaterThan(0);
    expect(c.roman).toBeTruthy();
  }
  const ids = [song.id, ...song.tracks.map((t) => t.id), ...song.sections.map((s) => s.id), ...song.chords.map((c) => c.id), ...song.tracks.flatMap((t) => t.notes.map((n) => n.id))];
  expect(new Set(ids).size).toBe(ids.length);
}

describe('analysis: rebuildProject (end-to-end)', () => {
  it('rebuilds a ~20 s synthetic song into a valid, editable Song with confidences', async () => {
    const { song: truth, audio } = testSong();
    const seen: RebuildStage['id'][] = [];
    const progress: number[] = [];
    const t0 = performance.now();
    const { song, report } = await rebuildProject(audio, {
      title: 'Synthetic Rebuild',
      onProgress: (id, p, stages) => {
        if (seen[seen.length - 1] !== id) seen.push(id);
        progress.push(p);
        expect(stages.length).toBe(8);
      },
    });
    const ms = performance.now() - t0;
    expect(seen).toEqual(STAGE_ORDER);
    expect(report.stages.map((s) => s.status)).toEqual(new Array(8).fill('done'));
    validateSong(song);
    expect(song.title).toBe('Synthetic Rebuild');
    expect(song.generation.seed).toBe(1);
    // tempo / meter / key
    expect(Math.abs(report.bpm - 120)).toBeLessThan(2.4);
    expect(song.tempoMap[0].bpm).toBe(report.bpm);
    expect(song.meterMap[0]).toMatchObject({ numerator: 4, denominator: 4 });
    expect(['E minor', 'G major']).toContain(keyName(report.key));
    expect(song.keyMap[0].key).toEqual(report.key);
    // tracks
    const roles = song.tracks.map((t) => t.role);
    expect(song.tracks.length).toBeGreaterThanOrEqual(3);
    expect(roles).toContain('drums');
    expect(roles).toContain('bass');
    expect(roles).toContain('vocal');
    const drums = song.tracks.find((t) => t.role === 'drums')!;
    expect(drums.instrumentId).toBe('drum-kit');
    expect(drums.midiChannel).toBe(9);
    const vocal = song.tracks.find((t) => t.role === 'vocal')!;
    expect(vocal.instrumentId).toBe('lead-vocal');
    expect(vocal.name).toBe('Vocal Melody');
    expect(song.tracks.find((t) => t.role === 'bass')!.instrumentId).toBe('electric-bass');
    // accuracy against the ground truth
    const bass = song.tracks.find((t) => t.role === 'bass')!;
    expect(noteRecall(truth.bassNotes, bass.notes, report.offsetSeconds, report.bpm)).toBeGreaterThan(0.8);
    expect(noteRecall(truth.melody, vocal.notes, report.offsetSeconds, report.bpm)).toBeGreaterThan(0.75);
    const kicks = truth.drums.filter((d) => d.drum === 'kick').map((d) => ({ pitch: 36, start: d.time }));
    expect(noteRecall(kicks, drums.notes, report.offsetSeconds, report.bpm)).toBeGreaterThan(0.85);
    // chords (one per bar) with roman numerals
    const barTicks = 4 * PPQ;
    let chordHits = 0;
    truth.chords.forEach((c) => {
      const mid = (((c.start + c.end) / 2 - report.offsetSeconds) * report.bpm * PPQ) / 60;
      const ev = song.chords.find((e) => e.tick <= mid && e.tick + e.duration > mid);
      if (ev?.symbol === c.symbol) chordHits++;
    });
    expect(chordHits / truth.chords.length).toBeGreaterThanOrEqual(0.75);
    expect(song.chords[0].tick % (barTicks / 2)).toBe(0);
    // structure: sections cover the song, names from kinds
    expect(song.sections.length).toBeGreaterThanOrEqual(2);
    expect(song.sections.map((s) => s.name)).toContain('Chorus 1');
    expect(song.sections.reduce((a, s) => a + s.bars, 0)).toBeGreaterThanOrEqual(10);
    // report
    expect(report.overallConfidence).toBeGreaterThan(0.3);
    expect(report.overallConfidence).toBeLessThan(0.95);
    expect(report.durationSeconds).toBeCloseTo(truth.left.length / SR, 1);
    for (const t of song.tracks) expect(report.trackConfidence[t.id]).toBeGreaterThan(0);
    for (const r of report.lowConfidenceRegions) {
      expect(song.tracks.some((t) => t.id === r.trackId)).toBe(true);
      expect(r.endTick).toBeGreaterThan(r.startTick);
      expect(r.confidence).toBeLessThan(0.5);
    }
    expect(report.warnings.some((w) => w.includes('DSP'))).toBe(true);
    expect(progress.every((p) => p >= 0 && p <= 1)).toBe(true);
    // ≈ 2–3 s standalone in Node; generous bound because test files run in parallel workers
    expect(ms).toBeLessThan(45000);
  });

  it('is deterministic', async () => {
    const audio = head(testSong().audio, 9);
    const a = await rebuildProject(audio, { title: 'X', seed: 7 });
    const b = await rebuildProject(audio, { title: 'X', seed: 7 });
    expect(songHash(a.song)).toBe(songHash(b.song));
    expect(a.song.generation.seed).toBe(7);
  });

  it('aborts between stages with an AbortError', async () => {
    const { audio } = testSong();
    const ac = new AbortController();
    const seen: string[] = [];
    await expect(
      rebuildProject(audio, {
        signal: ac.signal,
        onProgress: (id) => {
          if (seen[seen.length - 1] !== id) seen.push(id);
          if (id === 'key') ac.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).not.toContain('chords');
    const pre = new AbortController();
    pre.abort();
    await expect(rebuildProject(audio, { signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('accepts a separation provider override', async () => {
    const audio = head(testSong().audio, 9);
    let called = 0;
    const { report } = await rebuildProject(audio, {
      separation: async (buf) => {
        called++;
        return separateSources(buf).stems;
      },
    });
    expect(called).toBe(1);
    expect(report.separationMethod).toBe('provider');
    expect(report.stages[0].detail).toContain('provider');
  });

  it('rejects empty audio', async () => {
    await expect(rebuildProject({ sampleRate: SR, channels: [new Float32Array(100)] })).rejects.toThrow();
  });
});

describe('analysis: transcribeAudio (Transcribe mode)', () => {
  it('humming → lead-vocal notes on the detected grid', async () => {
    const melody = [60, 62, 64, 65, 67, 65, 64, 62, 60, 64, 67, 72].map((p, i) => ({ pitch: p, start: 0.5 + i * 0.5, duration: 0.42 }));
    const x = hummedMelody(SR, melody, { seed: 2 });
    const r = await transcribeAudio(mono(SR, x), { source: 'humming', bpm: 120, offsetSeconds: 0.5 });
    expect(r.suggestedRole).toBe('vocal');
    expect(r.suggestedInstrumentId).toBe('lead-vocal');
    expect(r.notes.map((n) => n.pitch)).toEqual(melody.map((m) => m.pitch));
    expect(r.notes.map((n) => n.tick)).toEqual(melody.map((_, i) => i * PPQ)); // 0.5 s = one beat at 120 BPM
    expect(r.bpm).toBe(120);
    expect(['C major', 'A minor']).toContain(keyName(r.key));
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.notes.every((n) => (n.confidence ?? 0) > 0 && n.origin === 'transcription')).toBe(true);
  });

  it('drums → GM drum notes with detected tempo', async () => {
    const x = renderDrums(SR, 9, rockBeat(100, 3, { offset: 0.4 }));
    const r = await transcribeAudio(mono(SR, x), { source: 'drums' });
    expect(Math.abs(r.bpm - 100)).toBeLessThan(2);
    expect(r.suggestedInstrumentId).toBe('drum-kit');
    expect(r.drumHits!.length).toBeGreaterThan(30);
    const kicks = r.notes.filter((n) => n.pitch === 36).map((n) => n.tick);
    expect(kicks.slice(0, 4)).toEqual([0, 960, 1920, 2880]);
  });

  it('isolated stem → classified, then transcribed with the right path', async () => {
    const x = renderDrums(SR, 6, rockBeat(120, 2, { offset: 0.3 }));
    const r = await transcribeAudio(mono(SR, x), { source: 'isolated', bpm: 120, offsetSeconds: 0.3 });
    expect(r.suggestedRole).toBe('drums');
    expect(r.notes.some((n) => n.pitch === 38)).toBe(true);
  });

  it('full mix → lead melody + warnings', async () => {
    const { audio, song } = testSong();
    const r = await transcribeAudio(audio, { source: 'full-mix' });
    expect(r.warnings.some((w) => w.includes('Rebuild'))).toBe(true);
    expect(r.notes.length).toBeGreaterThan(song.melody.length * 0.6);
    expect(r.drumHits!.length).toBeGreaterThan(20);
    expect(Math.abs(r.bpm - 120)).toBeLessThan(2.4);
  });

  it('piano → polyphonic notes, keys role, key from audio', async () => {
    const x = chordBlocks(SR, ['C', 'F', 'G', 'C'].map((symbol) => ({ symbol, duration: 2 })), { bass: false });
    const r = await transcribeAudio(mono(SR, x), { source: 'piano', bpm: 120, offsetSeconds: 0 });
    expect(r.suggestedRole).toBe('keys');
    expect(r.suggestedInstrumentId).toBe('piano');
    expect(keyName(r.key)).toBe('C major');
    // C major triad (C5 E5 G5 in chordBlocks voicing) at the start, F major at bar 2
    const at = (tick: number) => r.notes.filter((n) => n.tick === tick).map((n) => n.pitch % 12).sort((a, b) => a - b);
    expect(at(0)).toEqual([0, 4, 7]);
    expect(at(4 * PPQ)).toEqual([0, 5, 9]);
    expect(r.warnings.some((w) => w.includes('approximate'))).toBe(true);
  });

  it('bass → monophonic bass line in range', async () => {
    const x = chordBlocks(SR, ['Em', 'C', 'G', 'D'].map((symbol) => ({ symbol, duration: 1 })), { amp: 0 });
    const r = await transcribeAudio(mono(SR, x), { source: 'bass', bpm: 120, offsetSeconds: 0 });
    expect(r.suggestedRole).toBe('bass');
    expect(r.notes.map((n) => n.pitch)).toEqual([40, 36, 43, 38]);
    for (let i = 1; i < r.notes.length; i++) expect(r.notes[i - 1].tick + r.notes[i - 1].duration).toBeLessThanOrEqual(r.notes[i].tick);
  });

  it('click track without notes still reports tempo', async () => {
    const r = await transcribeAudio(mono(SR, clickTrack(SR, 90, 8, { accent: true })), { source: 'drums' });
    expect(Math.abs(r.bpm - 90)).toBeLessThan(1.8);
    expect(r.bpmConfidence).toBeGreaterThan(0.5);
  });
});
