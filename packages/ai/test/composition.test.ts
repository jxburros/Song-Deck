import { describe, expect, it } from 'vitest';
import {
  buildMusicContext,
  LLMCompositionProvider,
  lyricsToOperations,
  parsePlanJson,
  ProviderError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../src';
import { FakeLLM, makeSong } from './helpers';

const ctx = () => buildMusicContext(makeSong(), { instruction: 'Give the bass more movement', sectionId: 'sec_ch1' });

describe('LLMCompositionProvider', () => {
  it('modifyComposition validates operations and runs ONE automatic repair retry', async () => {
    const llm = new FakeLLM([
      // 1st reply: prose + an invalid op (missing region) → repair
      'Sure!\n{"explanation":"busier bass","confidence":0.8,"operations":[{"op":"replace_notes","track":"bass","notes":[{"pitch":"E2","bar":13,"beat":1,"duration_beats":0.5}]}]}',
      // 2nd reply: fixed
      '{"explanation":"busier bass","confidence":0.8,"operations":[{"op":"replace_notes","track":"bass","start_bar":13,"end_bar":13,"notes":[{"pitch":"E2","bar":13,"beat":1,"duration_beats":0.5,"velocity":100}]}]}',
    ]);
    const comp = new LLMCompositionProvider(llm, { providerId: 'fake', model: 'm1' });
    const res = await comp.modifyComposition({ context: ctx() });
    expect(llm.requests).toHaveLength(2);
    // The repair request contains the previous answer and the problem list.
    const repair = llm.requests[1].messages;
    expect(repair).toHaveLength(3);
    expect(repair[1].role).toBe('assistant');
    expect(String(repair[2].content)).toContain('operation 0 (replace_notes): missing region (start_bar/end_bar)');
    expect(res.operations).toEqual([{ op: 'replace_notes', track: 'bass', region: { start_bar: 13, end_bar: 13 }, notes: [{ pitch: 40, bar: 13, beat: 1, duration_beats: 0.5, velocity: 100 }] }]);
    expect(res.errors).toEqual([]);
    expect(res.explanation).toBe('busier bass');
    expect(res.confidence).toBe(0.8);
    expect(res.meta).toMatchObject({ providerId: 'fake', model: 'm1', calls: 2, repaired: true, usage: { inputTokens: 200, outputTokens: 100 } });
    expect(res.meta!.costUsd).toBeCloseTo(0.002, 10);
    // The request: system prompt with conventions, schema, routing hints.
    const first = llm.requests[0];
    expect(first.system).toContain('Bars and beats are 1-BASED');
    expect(first.system).toContain('NEVER modify locked material');
    expect(first.system).toContain('replace_notes {track, start_bar, end_bar, notes[]}');
    expect(first.schemaName).toBe('operations');
    expect(first.responseSchema).toBeDefined();
    expect(first.hints).toEqual({ role: 'midi-editing' });
    expect(String(first.messages[0].content)).toContain('INSTRUCTION: Give the bass more movement');
  });

  it('accepts spec-style operation output (operation + nested region) without a repair round-trip', async () => {
    const llm = new FakeLLM([
      JSON.stringify({ explanation: 'x', confidence: 0.7, operations: [{ operation: 'replace_notes', track: 'bass', region: { start_bar: 17, end_bar: 24 }, notes: [{ pitch: 40, bar: 17, beat: 1, duration_beats: 2 }] }] }),
    ]);
    const res = await new LLMCompositionProvider(llm).modifyComposition({ context: ctx() });
    expect(llm.requests).toHaveLength(1);
    expect(res.operations).toEqual([{ op: 'replace_notes', track: 'bass', region: { start_bar: 17, end_bar: 24 }, notes: [{ pitch: 40, bar: 17, beat: 1, duration_beats: 2 }] }]);
  });

  it('keeps valid operations and reports errors when the repair does not help', async () => {
    const bad = '{"explanation":"x","confidence":0.5,"operations":[{"op":"set_tempo","bpm":128},{"op":"nonsense"}]}';
    const llm = new FakeLLM([bad, bad]);
    const res = await new LLMCompositionProvider(llm).modifyComposition({ context: ctx() });
    expect(res.operations).toEqual([{ op: 'set_tempo', bpm: 128 }]);
    expect(res.errors).toEqual([{ index: 1, message: 'unknown operation "nonsense"' }]);
    expect(res.meta!.repaired).toBe(true);
  });

  it('throws a parse error when no JSON can be obtained', async () => {
    const llm = new FakeLLM(['I am not able to produce JSON today.']);
    const err = (await new LLMCompositionProvider(llm).modifyComposition({ context: ctx() }).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('parse');
    expect(llm.requests).toHaveLength(2);
  });

  it('salvages truncated JSON from a max_tokens stop', async () => {
    let n = 0;
    const llm: LLMProvider = {
      listModels: async () => [],
      complete: async (req: LLMRequest): Promise<LLMResponse> => {
        n++;
        if (n === 1) throw new ProviderError('truncated', 'cut', { partialText: '{"explanation":"long","confidence":0.6,"operations":[{"op":"set_tempo","bpm":100},{"op":"set_key","tonic":"D"' });
        return { text: '{"explanation":"short","confidence":0.6,"operations":[{"op":"set_tempo","bpm":100}]}', model: req.model ?? 'x', stopReason: 'end_turn' };
      },
    };
    const res = await new LLMCompositionProvider(llm).modifyComposition({ context: ctx() });
    expect(n).toBe(2);
    expect(res.operations).toEqual([{ op: 'set_tempo', bpm: 100 }]);
  });

  it('planSong normalizes roman numerals to chord symbols in the key', async () => {
    const llm = new FakeLLM([
      JSON.stringify({
        key: { tonic: 'E', mode: 'minor' },
        tempo: 150,
        meter: { numerator: 4, denominator: 4 },
        sections: [
          { name: 'Verse 1', kind: 'verse', bars: 8, harmony: ['i', 'VI', 'III', 'VII'], energy: 45, purpose: 'Story' },
          { name: 'Chorus', kind: 'Chorus', bars: 8, harmony: ['C', 'G', 'D', 'Em'], energy: 90, energy_end: 95, purpose: 'Release', feel: 'half-time' },
        ],
        notes: 'Motif A returns in the chorus',
        confidence: 0.85,
      }),
    ]);
    const res = await new LLMCompositionProvider(llm, { providerId: 'p' }).planSong({ prompt: 'emo song' });
    expect(llm.requests).toHaveLength(1);
    expect(res.plan).toEqual({
      key: { tonic: 4, mode: 'minor' },
      tempo: 150,
      meter: { numerator: 4, denominator: 4 },
      sections: [
        { name: 'Verse 1', kind: 'verse', bars: 8, harmony: ['Em', 'C', 'G', 'D'], energy: 45, purpose: 'Story' },
        { name: 'Chorus', kind: 'chorus', bars: 8, harmony: ['C', 'G', 'D', 'Em'], energy: 90, energyEnd: 95, purpose: 'Release', feel: 'half-time' },
      ],
      notes: 'Motif A returns in the chorus',
      source: 'p',
    });
    expect(res.confidence).toBe(0.85);
    expect(parsePlanJson({ key: { tonic: 'Q', mode: 'minor' } }).problems[0]).toMatch(/key/);
  });

  it('designBlueprint maps snake_case JSON to a Blueprint and validates ids', async () => {
    const llm = new FakeLLM([
      JSON.stringify({
        title: 'Glass Harbor',
        tempo: 168,
        meter: { numerator: 4, denominator: 4 },
        key: { tonic: 'F#', mode: 'minor' },
        styles: ['Emo'],
        genre_blend: [{ genre_id: 'emo', weight: 0.7 }, { genre_id: 'pop-punk', weight: 0.3 }],
        moods: ['Melancholy verses'],
        instrumentation: [{ name: 'Bass', instrument_id: 'electric-bass', role: 'bass', lowest: 'E1', highest: 'G3', avoid: ['busy-verses'] }],
        structure: [{ name: 'Intro', kind: 'intro', bars: 4, energy: 30, harmony: ['i', 'VI'] }],
        vocal: { voice_type: 'tenor', mode: 'ai-singer' },
        lyrics_theme: 'leaving home',
        macros: { energy: 0.8, melodic_movement: 0.6 },
      }),
    ]);
    const res = await new LLMCompositionProvider(llm).designBlueprint({ prompt: 'emo pop-punk about leaving home', genres: [{ id: 'emo', name: 'Emo' }, { id: 'pop-punk', name: 'Pop-punk' }], defaults: { seed: 99 } });
    const b = res.blueprint;
    expect(b).toMatchObject({ title: 'Glass Harbor', tempo: 168, key: { tonic: 6, mode: 'minor' }, seed: 99, prompt: 'emo pop-punk about leaving home', lyricsTheme: 'leaving home', vocal: { voiceType: 'tenor', mode: 'ai-singer' } });
    expect(b.genreBlend).toEqual([{ genreId: 'emo', weight: 0.7 }, { genreId: 'pop-punk', weight: 0.3 }]);
    expect(b.instrumentation[0]).toEqual({ name: 'Bass', instrumentId: 'electric-bass', role: 'bass', constraints: { lowest: 28, highest: 55, avoid: ['busy-verses'] } });
    expect(b.macros.energy).toBe(0.8);
    expect(b.macros.melodicMovement).toBe(0.6);
    expect(b.macros.complexity).toBe(0.5);
    expect(String(llm.requests[0].system)).toContain('use ONLY these genre ids');
  });

  it('generateLyrics enforces line counts (repair) and keeps locked sections', async () => {
    const llm = new FakeLLM([
      '{"sections":[{"section":"Verse 1","lines":["one line only"]},{"section":"Chorus 1","lines":["x","y"]}]}',
      '{"title":"Harbor","sections":[{"section":"Verse 1","lines":["first line","second line"]},{"section":"Chorus 1","lines":["x","y"]}]}',
    ]);
    const res = await new LLMCompositionProvider(llm).generateLyrics({
      theme: 'leaving',
      sections: [
        { name: 'Verse 1', kind: 'verse', lines: 2, syllables: [7, 8] },
        { name: 'Chorus 1', kind: 'chorus', lines: 2, locked: true, existing: ['Fire in the sky', 'Carry me home'] },
      ],
    });
    expect(llm.requests).toHaveLength(2);
    expect(String(llm.requests[1].messages[2].content)).toContain('section "Verse 1" needs 2 line(s), got 1');
    expect(res.title).toBe('Harbor');
    expect(res.sections).toEqual([
      { section: 'Verse 1', lines: ['first line', 'second line'] },
      { section: 'Chorus 1', lines: ['Fire in the sky', 'Carry me home'] },
    ]);
    expect(lyricsToOperations(res)[0]).toEqual({ op: 'set_lyrics', section: 'Verse 1', lines: ['first line', 'second line'] });
  });

  it('mixAssist only returns mixer/automation operations; chat passes history and proposes edits', async () => {
    const llm = new FakeLLM([
      '{"explanation":"Clearer vocal","confidence":0.7,"operations":[{"op":"set_mixer","track":"Lead Vocal","mixer":[{"param":"eq.highpassHz","value":100},{"param":"eq.highMidDb","value":3}]},{"op":"regenerate","track":"vocal"}]}',
    ]);
    const comp = new LLMCompositionProvider(llm);
    const mix = await comp.mixAssist({ context: ctx(), instruction: 'Make the vocal clearer' });
    expect(mix.operations).toEqual([{ op: 'set_mixer', track: 'Lead Vocal', changes: { 'eq.highpassHz': 100, 'eq.highMidDb': 3 } }]);
    expect(mix.errors.length).toBeGreaterThan(0);
    expect(llm.requests[0].schemaName).toBe('mix_operations');

    const chatLlm = new FakeLLM(['{"answer":"The pre-chorus stays on i","suggestions":["Try iv"],"operations":[{"op":"set_tempo","bpm":"150"}],"confidence":0.75}']);
    const chat = await new LLMCompositionProvider(chatLlm).chat({ context: ctx(), question: 'Why does the pre-chorus feel weak?', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] });
    expect(chat.answer).toBe('The pre-chorus stays on i');
    expect(chat.operations).toEqual([{ op: 'set_tempo', bpm: 150 }]);
    expect(chatLlm.requests[0].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(String(chatLlm.requests[0].messages[2].content)).toContain('INSTRUCTION: Why does the pre-chorus feel weak?');
  });
});
