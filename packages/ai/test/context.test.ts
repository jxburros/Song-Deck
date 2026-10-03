import { describe, expect, it } from 'vitest';
import { buildMusicContext, contextDataKinds, estimateTokens, musicContextToPrompt, songStyleTags } from '../src';
import { makeSong } from './helpers';

describe('buildMusicContext', () => {
  it('normalizes the song around a section (1-based bars, chords with romans, tracks, constraints)', () => {
    const song = makeSong();
    const ctx = buildMusicContext(song, { instruction: 'Give the bass more movement but keep the chords', sectionId: 'sec_ch1' });
    expect(ctx).toMatchObject({ title: 'Test Song', tempo: 120, meter: '4/4', key: 'E minor', total_bars: 24, duration_seconds: 48 });
    expect(ctx.focus).toEqual({ start_bar: 13, end_bar: 20, description: 'Chorus 1' });
    expect(ctx.section).toMatchObject({ id: 'sec_ch1', name: 'Chorus 1', kind: 'chorus', start_bar: 13, end_bar: 20, energy: 85 });
    expect(ctx.sections.map((s) => [s.name, s.start_bar, s.end_bar])).toEqual([
      ['Intro', 1, 4],
      ['Verse 1', 5, 12],
      ['Chorus 1', 13, 20],
      ['Outro', 21, 24],
    ]);
    expect(ctx.chords).toHaveLength(8);
    expect(ctx.chords[0]).toEqual({ bar: 13, beat: 1, symbol: 'Em', roman: 'i', duration_beats: 4 });
    const bass = ctx.tracks.find((t) => t.name === 'Bass')!;
    expect(bass).toMatchObject({ role: 'bass', instrument: 'electric-bass', range: 'E1-G3', locked: false, note_count: 192, function: 'bass-line' });
    expect(bass.notes).toHaveLength(64);
    expect(bass.notes![1]).toEqual({ id: 'b_12_1', bar: 13, beat: 1.5, pitch: 'E2', duration_beats: 0.5, velocity: 80 });
    const drums = ctx.tracks.find((t) => t.name === 'Drums')!;
    expect(drums.locked).toEqual(['Chorus 1']);
    expect(drums.notes![0]).toMatchObject({ pitch: 'C2', drum: 'kick', locked: true });
    expect(ctx.constraints.locks).toEqual(['Track "Drums" is locked in "Chorus 1"']);
    expect(ctx.constraints.region).toEqual({ start_bar: 13, end_bar: 20 });
    expect(ctx.constraints.instruments).toEqual([{ track: 'Bass', lowest: 'E1', highest: 'G3', complexity: 'medium', function: 'bass-line' }]);
    expect(ctx.lyrics.map((l) => l.text)).toEqual(['Fire in the sky', 'Carry me home']);
    expect(ctx.mixer).toEqual([{ track: 'Bass', volume_db: -6, pan: 0, reverb_send: 0.1, delay_send: 0, eq: 'low-mid -2 dB @400 Hz', compressor: '-14 dB 2:1 attack 25 ms release 200 ms' }]);
    expect(ctx.styles).toEqual(['Emo', 'Pop-punk']);
    expect(ctx.instruction).toBe('Give the bass more movement but keep the chords');
    expect(contextDataKinds(ctx)).toEqual(['song-description', 'chord-progression', 'midi', 'lyrics', 'project-metadata']);
  });

  it('renders a deterministic compact prompt', () => {
    const song = makeSong();
    const a = musicContextToPrompt(buildMusicContext(song, { instruction: 'x', sectionId: 'sec_ch1' }));
    const b = musicContextToPrompt(buildMusicContext(makeSong(), { instruction: 'x', sectionId: 'sec_ch1' }));
    expect(a).toBe(b);
    expect(a).toContain('SONG: "Test Song" — 120 BPM, 4/4, E minor, 24 bars (0:48)');
    expect(a).toContain('3. Chorus 1 [chorus] bars 13-20, energy 85, purpose: Emotional release');
    expect(a).toContain('CHORDS in focus (bar:beat symbol roman beats): 13:1 Em i 4 | 14:1 C VI 4');
    expect(a).toContain('- "Bass" (id trk_bass) role=bass instrument=electric-bass function=bass-line range=E1-G3 notes_total=192');
    expect(a).toContain('13:1 E2 0.5 96, 13:1.5 E2 0.5 80');
    expect(a).toContain('13:1 C2(kick) 0.25 110 L');
    expect(a).toContain('[LOCKED in: Chorus 1]');
    expect(a).toContain('Only change material inside bars 13-20');
    expect(a).toContain('Chorus 1: "Fire in the sky" / "Carry me home"');
    expect(a.trim().endsWith('INSTRUCTION: x')).toBe(true);
  });

  it('truncates by summarizing unselected tracks but never drops the selection', () => {
    const song = makeSong();
    const selected = ['b_20_0', 'b_20_1', 'b_20_2'];
    const ctx = buildMusicContext(song, { instruction: 'Make these notes staccato', selection: { noteIds: selected, trackIds: ['trk_bass'] }, maxNotes: 10 });
    // Focus = the bars of the selected notes.
    expect(ctx.focus).toEqual({ start_bar: 21, end_bar: 21, description: 'selected notes (bars 21-21)' });
    expect(ctx.selected_notes.map((n) => n.id)).toEqual(selected);
    expect(ctx.selected_notes[0]).toMatchObject({ track: 'Bass', bar: 21, beat: 1, pitch: 'E2' });
    const bass = ctx.tracks.find((t) => t.id === 'trk_bass')!;
    expect(bass.selected).toBe(true);
    expect(bass.notes).toHaveLength(8); // selected track listed first and fits the budget
    const drums = ctx.tracks.find((t) => t.id === 'trk_drums')!;
    expect(drums.notes).toBeUndefined();
    expect(drums.summary).toMatch(/^12 notes, hits: hihat-closed×8 kick×2 snare×2/);
    expect(ctx.truncation).toEqual({ omitted_notes: 12, summarized_tracks: ['Drums'] });
    expect(musicContextToPrompt(ctx)).toContain('SELECTED NOTES (id track bar:beat pitch beats velocity): b_20_0 Bass 21:1 E2 0.5 96');

    // Token budget: whole-song context squeezed hard — selection survives, others summarized.
    const whole = { startTick: 0, endTick: 24 * 1920, noteIds: ['v_10_0'] };
    const big = buildMusicContext(song, { instruction: 'Analyze', selection: whole, maxNotes: 10_000, maxTokens: 1500 });
    const prompt = musicContextToPrompt(big);
    expect(big.selected_notes.map((n) => n.id)).toEqual(['v_10_0']);
    expect(prompt).toContain('v_10_0 Lead Vocal');
    expect(big.truncation!.summarized_tracks.length).toBeGreaterThan(0);
    expect(estimateTokens(prompt)).toBeLessThan(estimateTokens(musicContextToPrompt(buildMusicContext(song, { instruction: 'Analyze', selection: whole, maxNotes: 10_000 }))));
    expect(estimateTokens(prompt)).toBeLessThanOrEqual(1500);
  });

  it('handles selection ranges, tempo/key changes and track filters', () => {
    const song = makeSong({ chorusBpm: 90 });
    song.keyMap.push({ bar: 12, key: { tonic: 7, mode: 'major' } });
    for (const c of song.chords) delete c.roman; // romans are computed in the key in effect
    const ctx = buildMusicContext(song, { instruction: 'x', selection: { startTick: 12 * 1920, endTick: 14 * 1920 }, trackIds: ['trk_vox'] });
    expect(ctx.focus).toMatchObject({ start_bar: 13, end_bar: 14, description: 'selected range' });
    expect(ctx.tempo).toBe(90);
    expect(ctx.key).toBe('G major');
    expect(ctx.tempo_changes).toEqual([{ bar: 1, bpm: 120 }, { bar: 13, bpm: 90 }]);
    expect(ctx.key_changes).toEqual([{ bar: 1, key: 'E minor' }, { bar: 13, key: 'G major' }]);
    expect(ctx.tracks.map((t) => t.name)).toEqual(['Lead Vocal']);
    expect(ctx.tracks[0].notes![0].syllable).toBeDefined();
    expect(ctx.chords[0]).toMatchObject({ bar: 13, symbol: 'Em', roman: 'vi' });
  });
});

describe('tags in the AI layers', () => {
  it('lists catalog tags in the context STYLE TAGS line and in the production style tags', () => {
    const song = makeSong();
    song.tags = ['warm', 'lo-fi', 'midwest-emo', 'falsetto', 'unknown-tag'];
    const ctx = buildMusicContext(song, { instruction: 'Describe the style' });
    expect(ctx.tags).toEqual(['Warm (mood)', 'Lo-fi (production)', 'Midwest emo (style)', 'Falsetto (vocal)']);
    expect(musicContextToPrompt(ctx)).toContain('STYLE TAGS: Warm (mood), Lo-fi (production), Midwest emo (style), Falsetto (vocal)');
    const tags = songStyleTags(song);
    expect(tags.genres).toContain('midwest emo');
    expect(tags.moods).toContain('warm');
    expect(tags.production).toContain('lo-fi');
  });
});
