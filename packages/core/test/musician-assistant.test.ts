import { describe, expect, it } from 'vitest';
import { answerQuestion, parseAssetPrompt } from '../src/musician';
import { stableStringify } from '../src/ir/song-utils';
import type { MusicOperation } from '../src/ir/types';
import { createEmptySong } from '../src/ir/defaults';
import { deepFreeze, makeSong, opTick, opsOfType } from './musician-fixtures';

const BAR = 1920;

describe('answerQuestion (§44 project-aware assistant)', () => {
  const song = makeSong();

  it('"Why does the pre-chorus feel weak?" diagnoses energy/arrangement and proposes a build', () => {
    const r = answerQuestion(song, 'Why does the pre-chorus feel weak?');
    expect(r.intents).toEqual(['why-weak']);
    expect(r.answer).toMatch(/^Pre-Chorus \(bars 9–12\) may feel weak because:/);
    expect(r.answer).toMatch(/jumps to 90 in Chorus 1/);
    expect(r.answer).toMatch(/no fuller than Verse 1/);
    const ops = r.operations!;
    expect(opsOfType(ops, 'update_section')).toEqual([expect.objectContaining({ section: 'sec-pre', changes: { energyEnd: 82 } })]);
    const drums = opsOfType(ops, 'replace_notes').find((o) => o.track === 't-drums')!;
    expect(drums.region).toEqual({ start_bar: 11, end_bar: 12 });
    // The build ends with a snare run that grows louder.
    const snares = drums.notes.filter((n) => n.pitch === 38 && n.bar === 12 && n.beat >= 3);
    expect(snares.length).toBeGreaterThanOrEqual(4);
    expect(snares[snares.length - 1].velocity!).toBeGreaterThan(snares[0].velocity!);
    expect(r.suggestions?.length).toBeGreaterThan(0);
  });

  it('proposes a dominant when the pre-chorus resolves to the tonic before the chorus', () => {
    const s = makeSong();
    Object.assign(s.chords.find((c) => c.id === 'c8')!, { root: 7, quality: 'maj', symbol: 'G' });
    const r = answerQuestion(s, 'Why does the pre-chorus feel weak?');
    expect(r.answer).toMatch(/it ends on G \(I, tonic function\)/);
    const sc = opsOfType(r.operations!, 'set_chords');
    expect(sc).toHaveLength(1);
    expect(sc[0].region).toEqual({ start_bar: 12, end_bar: 12 });
    expect(sc[0].chords.map((c) => [c.symbol, c.bar, c.beat, c.duration_beats])).toEqual([
      ['G', 12, 1, 2],
      ['D7sus4', 12, 3, 2],
    ]);
  });

  it('"Give the bass more movement but don\'t change the chords" edits only the bass', () => {
    const r = answerQuestion(song, "Give the bass more movement but don't change the chords");
    expect(r.intents).toEqual(['edit', 'busier']);
    expect(r.operations!.every((o) => o.op !== 'set_chords')).toBe(true);
    expect(r.operations!.every((o) => 'track' in o && o.track === 't-bass')).toBe(true);
    expect(r.answer).toMatch(/The chords are unchanged\.$/);
  });

  it('"What would happen if this chorus were in half-time?" explains and prepares the change', () => {
    const r = answerQuestion(song, 'What would happen if this chorus were in half-time?', { sectionIds: ['sec-chorus2'] });
    expect(r.intents).toEqual(['what-if', 'half-time']);
    expect(r.answer).toMatch(/^Chorus 2 runs at 120 BPM/);
    expect(r.answer).toMatch(/~60 BPM/);
    expect(opsOfType(r.operations!, 'update_section')).toEqual([expect.objectContaining({ section: 'sec-chorus2', changes: { feel: 'half-time' } })]);
    const drums = opsOfType(r.operations!, 'replace_notes').find((o) => o.track === 't-drums')!;
    expect(drums.region).toEqual({ start_bar: 29, end_bar: 36 });
    // Backbeat on 3: no snare on beats 2/4 any more.
    const snares = drums.notes.filter((n) => n.pitch === 38 && (n.velocity ?? 0) > 60);
    expect(snares.every((n) => n.beat === 3)).toBe(true);
  });

  it('other "what if" ideas: darker, brighter and faster', () => {
    const dark = answerQuestion(song, 'what if the chorus were darker');
    expect(dark.intents).toEqual(['what-if', 'darker']);
    expect(opsOfType(dark.operations!, 'set_chords')[0].chords.map((c) => c.symbol)).toEqual(['Gm', 'Dm', 'Eb', 'Cm']);
    const fast = answerQuestion(song, 'what if the song was faster');
    expect(fast.intents).toEqual(['what-if', 'tempo']);
    expect(fast.operations).toEqual([expect.objectContaining({ op: 'set_tempo', bpm: 132 })]);
  });

  it('"Make the bridge contrast more strongly with the chorus" re-colours the harmony and the feel', () => {
    const r = answerQuestion(song, 'Make the bridge contrast more strongly with the chorus');
    expect(r.intents).toEqual(['contrast']);
    expect(r.answer).toMatch(/3 of Bridge's 5 chords \(C, G, D\) also appear in Chorus 1/);
    const sc = opsOfType(r.operations!, 'set_chords');
    expect(sc).toHaveLength(1);
    expect(sc[0].region.start_bar).toBeGreaterThanOrEqual(21);
    expect(sc[0].region.end_bar).toBeLessThanOrEqual(28);
    // The bridge's closing D (V) still resolves to the chorus' G: it stays major.
    expect(sc[0].chords.map((c) => c.symbol)).not.toContain('Dm');
    expect(opsOfType(r.operations!, 'update_section')).toEqual([expect.objectContaining({ section: 'sec-bridge', changes: { feel: 'half-time' } })]);
  });

  it('"Add strings without making the arrangement crowded" adds a pad only where there is room', () => {
    const r = answerQuestion(song, 'Add strings without making the arrangement crowded');
    expect(r.intents).toEqual(['add-instrument']);
    const add = opsOfType(r.operations!, 'add_track');
    expect(add).toEqual([expect.objectContaining({ name: 'String Pad', instrument_id: 'string-ensemble', role: 'strings', function: 'pad' })]);
    const notes = opsOfType(r.operations!, 'add_notes')[0];
    expect(notes.track).toBe('String Pad');
    expect(notes.notes.length).toBeGreaterThan(10);
    const bars = new Set(notes.notes.map((n) => n.bar));
    // Pre-Chorus (9–12), Bridge (21–28) and Chorus 2 (29–36) only — not Verse 1 or Chorus 1.
    for (const b of bars) expect((b >= 9 && b <= 12) || (b >= 21 && b <= 36)).toBe(true);
    for (const n of notes.notes) {
      expect(n.pitch).toBeGreaterThanOrEqual(54);
      expect(n.pitch).toBeLessThanOrEqual(67);
    }
    expect(r.answer).toMatch(/Verse 1 and Chorus 1 keep their current arrangement/);
  });

  it('answers facts about the song', () => {
    expect(answerQuestion(song, 'what key is this in').answer).toMatch(/^The song is in G major \(relative minor: E minor\)\./);
    expect(answerQuestion(song, 'what are the chords in the chorus').answer).toBe(
      'Chorus 1 (bars 13–20) and Chorus 2 (bars 29–36): G – D – Em – C — I – V – vi – IV in G major.',
    );
    expect(answerQuestion(song, 'how long is the song').answer).toBe('1:12 — 36 bars at 120 BPM in 4/4, across 5 sections.');
    expect(answerQuestion(song, 'how many bars is the bridge').answer).toBe('Bridge: 8 bars (bars 21–28), 0:16 at 120 BPM.');
    expect(answerQuestion(song, 'what tempo is it').answer).toBe('120 BPM in 4/4.');
    const meter = answerQuestion(song, 'what is the time signature?');
    expect(meter.intents).toEqual(['meter']);
    expect(meter.answer).toBe('4/4 throughout (common time), at 120 BPM.');
    expect(answerQuestion(song, 'what is the structure').answer.split('\n')).toHaveLength(5);
    expect(answerQuestion(song, 'which instruments play in the verse').answer).toBe('In Verse 1 (bars 1–8): Drums, Bass, Lead Vocal, Violin and Piano.');
    const lyrics = answerQuestion(song, 'what are the lyrics of the chorus');
    expect(lyrics.intents).toEqual(['lyrics']);
    expect(lyrics.answer).toMatch(/Chorus 1:\n {2}Hold on to the night sky\n {2}Fire in my heart tonight/);
    expect(answerQuestion(song, 'where is the energy highest').answer).toMatch(/The peak is Chorus 2 \(95\)\./);
    expect(answerQuestion(song, 'what is the vocal range').answer).toMatch(/^Lead Vocal spans B3–E5 \(17 semitones\)/);
  });

  it('explains a section and analyses the melody', () => {
    const ex = answerQuestion(song, 'explain the bridge');
    expect(ex.intents).toEqual(['explain']);
    expect(ex.answer.split('\n')[0]).toBe('Bridge: C – Cm – G – A7 – D — IV – iv – I – V7/V – V in G major.');
    expect(ex.answer).toMatch(/borrowed from the parallel minor/);
    const mel = answerQuestion(song, 'Is the chorus melody too repetitive?');
    expect(mel.intents).toEqual(['melody']);
    expect(mel.answer).toMatch(/Chorus 1 \(bars 13–20\): 4 phrases using one rhythm throughout/);
    expect(mel.answer).toMatch(/suits a chorus/);
    expect(mel.suggestions![0]).toBe('Keep the rhythm but change the pitches in the last 2 bars of Chorus 1');
    // A command about the melody is an edit, not a question.
    expect(answerQuestion(song, 'make the melody more interesting').intents[0]).toBe('edit');
  });

  it('routes mix requests to the mix assistant and falls back to a summary', () => {
    const mix = answerQuestion(song, 'make the vocal clearer');
    expect(mix.intents).toEqual(['mix', 'clarity']);
    expect(opsOfType(mix.operations!, 'set_mixer').some((o) => o.track === 't-vocal')).toBe(true);
    const fallback = answerQuestion(song, 'tell me a joke');
    expect(fallback.intents).toEqual(['summary']);
    expect(fallback.answer).toMatch(/^Fixture Song: G major, 120 BPM in 4\/4, 36 bars \(1:12\)/);
    expect(fallback.suggestions!.length).toBeGreaterThan(0);
  });

  it('is deterministic, pure and fast', () => {
    const frozen = deepFreeze(makeSong());
    const before = stableStringify(frozen);
    const qs = [
      'Why does the pre-chorus feel weak?',
      "Give the bass more movement but don't change the chords",
      'Make the bridge contrast more strongly with the chorus',
      'Add strings without making the arrangement crowded',
      'what if the chorus were in half-time',
      'is the melody too repetitive?',
    ];
    for (const q of qs) expect(stableStringify(answerQuestion(frozen, q))).toBe(stableStringify(answerQuestion(frozen, q)));
    expect(stableStringify(frozen)).toBe(before);
    const t0 = performance.now();
    for (const q of qs) answerQuestion(frozen, q);
    expect((performance.now() - t0) / qs.length).toBeLessThan(50);
  });

  it('copes with an empty song', () => {
    const empty = createEmptySong({ id: 'empty', seed: 1 });
    expect(answerQuestion(empty, 'what are the chords').answer).toMatch(/^There are no chords yet/);
    expect(answerQuestion(empty, 'how long is the song').answer).toMatch(/no sections yet/);
    expect(answerQuestion(empty, 'is the melody repetitive?').answer).toBe('There is no melody yet.');
    expect(answerQuestion(empty, 'Add strings').answer).toMatch(/no sections yet/);
    expect(answerQuestion(empty, 'hello').intents).toEqual(['summary']);
  });

  it('places proposals on real bars/beats (1-based)', () => {
    const r = answerQuestion(song, 'Add strings without making the arrangement crowded');
    const notes = (r.operations!.find((o) => o.op === 'add_notes') as Extract<MusicOperation, { op: 'add_notes' }>).notes;
    const first = notes.reduce((a, b) => (opTick(song, b) < opTick(song, a) ? b : a));
    expect(opTick(song, first)).toBe(8 * BAR); // Pre-Chorus starts at bar 9 (1-based)
  });
});

describe('parseAssetPrompt (§25 Generate MIDI)', () => {
  it('parses the spec examples', () => {
    expect(parseAssetPrompt('Create a melancholy 16-bar cello melody in D minor.')).toEqual({
      description: 'Create a melancholy 16-bar cello melody in D minor.',
      instrumentId: 'cello',
      role: 'strings',
      function: 'melody',
      bars: 16,
      key: { tonic: 2, mode: 'minor' },
      tempo: 120,
      meter: { numerator: 4, denominator: 4 },
      moods: ['melancholy'],
      genreIds: [],
      count: 1,
    });
    const drums = parseAssetPrompt('Make a pop-punk drum pattern at 176 BPM.');
    expect(drums).toMatchObject({ instrumentId: 'drum-kit', role: 'drums', function: 'rhythm', tempo: 176, genreIds: ['pop-punk'], bars: 4, count: 1 });
    const bass = parseAssetPrompt('Generate four alternative bass lines for this progression.');
    expect(bass).toMatchObject({ instrumentId: 'electric-bass', role: 'bass', function: 'bass-line', count: 4, bars: 8 });
    expect(bass.progression).toBeUndefined();
  });

  it('reads progressions, keys, meters, counts, genres and seeds', () => {
    const am = parseAssetPrompt('Create a bass line for Am F C G');
    expect(am.progression).toEqual(['Am', 'F', 'C', 'G']);
    expect(am.key).toEqual({ tonic: 9, mode: 'minor' });
    expect(am.bars).toBe(4);
    const arp = parseAssetPrompt('Write a dreamy synth arpeggio in F# minor in 3/4');
    expect(arp).toMatchObject({ instrumentId: 'synth-arp', role: 'synth-arp', key: { tonic: 6, mode: 'minor' }, meter: { numerator: 3, denominator: 4 }, moods: ['dreamy'] });
    const jazz = parseAssetPrompt('3 jazzy piano comping ideas over ii V I in Bb');
    expect(jazz).toMatchObject({ instrumentId: 'piano', function: 'accompaniment', count: 3, key: { tonic: 10, mode: 'major' }, progression: ['ii', 'V', 'I'], genreIds: ['jazz'], tempo: 130 });
    const flute = parseAssetPrompt('a counter-melody for flute over Dm Bb F C, 6/8, seed 42');
    expect(flute).toMatchObject({ instrumentId: 'flute', function: 'counter-melody', meter: { numerator: 6, denominator: 8 }, seed: 42, key: { tonic: 2, mode: 'minor' } });
    expect(parseAssetPrompt('two dark ambient pad textures in C# minor')).toMatchObject({ instrumentId: 'synth-pad', function: 'pad', count: 2, key: { tonic: 1, mode: 'minor' } });
    expect(parseAssetPrompt('a 4-bar drum fill').function).toBe('fills');
    expect(parseAssetPrompt('a 999 bar cello melody').bars).toBe(256);
  });

  it('uses defaults: minor for sad moods, the song tempo when given', () => {
    const sad = parseAssetPrompt('a sad piano melody', { defaultTempo: 92 });
    expect(sad).toMatchObject({ instrumentId: 'piano', function: 'melody', tempo: 92, key: { tonic: 9, mode: 'minor' }, moods: ['sad'] });
    expect(parseAssetPrompt('something nice').instrumentId).toBe('piano');
    expect(parseAssetPrompt('an uplifting 8 bar piano hook in E major at 128 bpm')).toMatchObject({ function: 'hook', bars: 8, key: { tonic: 4, mode: 'major' }, tempo: 128 });
  });
});
