import { it, expect } from 'vitest';
import { composeSong, parsePromptToBlueprint, regenerateUnlocked, createVariation, BRANCH_TEMPLATES, extractSongDNA, composeFromDNA, applyMacroTransforms, computeArrangement } from '../src/composer';
import { createEmptySong } from '../src/ir/defaults';
import { createRng } from '../src/util/random';
import { validityProblems } from './composer-helpers';
import type { Song } from '../src/ir/types';

const WORDS = ['fast', 'slow', 'sad', 'happy', 'dark', 'epic', 'rock', 'pop', 'jazz', 'trance', 'metal', 'folk', 'country', 'house', 'emo', 'punk', 'hip hop', 'orchestral', 'cinematic', 'r&b', 'synth-pop', 'indie',
  'drums', 'bass', 'two guitars', 'piano', 'violin', 'cello', 'strings', 'synth', 'arp', 'choir', 'trumpet', 'sax', 'flute', 'harp', 'timpani', 'marimba', 'organ', 'rhodes', 'percussion', 'backing vocals',
  'in 6/8', 'in 7/8', 'in 5/4', 'waltz', 'in D dorian', 'in F# minor', 'in Bb major', '90 bpm', '200 bpm', 'instrumental', 'female soprano', 'male baritone', 'short', 'long', 'huge chorus', 'quiet verse', 'complex', 'simple', 'sparse', 'busy', 'swing'];

it('fuzzes prompts and edit operations without errors', () => {
  const rng = createRng(12345);
  for (let i = 0; i < 40; i++) {
    const prompt = rng.shuffle(WORDS).slice(0, rng.int(2, 9)).join(' ');
    const bp = parsePromptToBlueprint(prompt, { seed: i });
    const song = composeSong(bp);
    expect(validityProblems(song), prompt).toEqual([]);
    const ops: ((s: Song) => Song)[] = [
      (s) => regenerateUnlocked(s, { seed: i + 1, includeChords: true }).song,
      (s) => regenerateUnlocked(s, { seed: i + 2, startTick: 1920 * 3, endTick: 1920 * 9 + 240 }).song,
      (s) => createVariation(s, rng.pick(['ornament', 'variation', 'reinterpretation', 'mutation'] as const), { seed: i + 3, amount: rng.next() }),
      (s) => BRANCH_TEMPLATES[i % 4].apply(s, i),
      (s) => composeFromDNA(extractSongDNA(s), { seed: i + 4 }),
      (s) => applyMacroTransforms(s, { humanization: rng.next(), dynamics: rng.next() }),
    ];
    const op = ops[i % ops.length];
    const out = op(song);
    expect(validityProblems(out), `${prompt} op ${i % ops.length}`).toEqual([]);
  }
});

it('handles edge-case songs', () => {
  // One-bar sections, a meter change, no chords, an audio track, no motifs.
  const base = composeSong(parsePromptToBlueprint('pop song with drums bass piano and vocal', { seed: 2 }));
  const s: Song = JSON.parse(JSON.stringify(base));
  s.sections = s.sections.slice(0, 4).map((x, i) => ({ ...x, bars: i === 0 ? 1 : x.bars }));
  s.meterMap = [{ bar: 0, numerator: 4, denominator: 4 }, { bar: 3, numerator: 3, denominator: 4 }];
  s.chords = [];
  s.motifs = [];
  s.tracks.forEach((t) => (t.notes = []));
  s.tracks.push({ id: 'audio1', name: 'Recording', kind: 'audio', role: 'custom', instrumentId: 'lead-vocal', constraints: {}, notes: [], clips: [], color: '#fff', stemGroup: 'vocals' });
  const r = regenerateUnlocked(s, { seed: 3 });
  const problems = validityProblems(r.song).filter((p) => !p.startsWith('chords'));
  expect(problems).toEqual([]);
  expect(r.song.tracks.find((t) => t.id === 'audio1')!.notes).toEqual([]);
  expect(computeArrangement(r.song).audio1).toEqual([]);
  // Empty song.
  const empty = createEmptySong({ id: 'e' });
  expect(regenerateUnlocked(empty, { seed: 1 }).song.tracks).toEqual([]);
  expect(createVariation(empty, 'variation', { seed: 1, amount: 1 }).sections).toEqual([]);
  expect(extractSongDNA(empty).structure).toEqual([]);
});
