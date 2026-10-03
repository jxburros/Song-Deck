import { describe, expect, it } from 'vitest';
import {
  BUILTIN_GENRES,
  applyPlanToSong,
  composeSong,
  computeArrangement,
  defaultBlueprint,
  parsePromptToBlueprint,
  planComposition,
  regenerateUnlocked,
} from '../src/composer';
import { ENGINE_VERSION } from '../src/ir/defaults';
import { cloneSong, songHash } from '../src/ir/song-utils';
import { sectionLayout } from '../src/timing';
import { parseChordSymbol } from '../src/theory/chords';
import type { Blueprint } from '../src/ir/types';
import { validityProblems } from './composer-helpers';

const SPEC_PROMPT =
  'Make a fast alternative rock song with a melancholy verse and huge cathartic chorus. Drums, bass, two guitars, piano and violin. Male tenor vocal.';

describe('planComposition (§15)', () => {
  const bp = parsePromptToBlueprint(SPEC_PROMPT);
  const plan = planComposition(bp);

  it('produces an abstract plan table for every section', () => {
    expect(plan.key).toEqual(bp.key);
    expect(plan.tempo).toBe(bp.tempo);
    expect(plan.sections.map((s) => s.kind)).toEqual(bp.structure.map((s) => s.kind));
    for (const s of plan.sections) {
      expect(s.harmony.length).toBeGreaterThan(0);
      for (const h of s.harmony) expect(parseChordSymbol(h), h).not.toBeNull();
      expect(s.purpose.length).toBeGreaterThan(0);
      expect(s.energy).toBeGreaterThanOrEqual(0);
      expect(s.energy).toBeLessThanOrEqual(100);
    }
    const p = (k: string) => plan.sections.find((s) => s.kind === k)!.purpose;
    expect(p('intro')).toBe('Establish motif');
    expect(p('pre-chorus')).toBe('Rising tension');
    expect(p('chorus')).toBe('Emotional release');
    expect(p('final-chorus')).toBe('Maximum release');
    expect(p('bridge')).toBe('Build');
    expect(plan.sections.find((s) => s.kind === 'bridge')!.energyEnd).toBeGreaterThan(plan.sections.find((s) => s.kind === 'bridge')!.energy);
  });

  it('repeats harmony for repeated sections and contrasts verse and chorus', () => {
    const verses = plan.sections.filter((s) => s.kind === 'verse');
    const choruses = plan.sections.filter((s) => s.kind === 'chorus' || s.kind === 'final-chorus');
    expect(verses[0].harmony).toEqual(verses[1].harmony);
    expect(choruses[0].harmony).toEqual(choruses[1].harmony);
    expect(choruses[0].harmony).not.toEqual(verses[0].harmony);
    // The verse sits on the tonic (E minor); the chorus lifts away from it.
    const tonic = (sym: string) => parseChordSymbol(sym)!.root === 4;
    expect(tonic(verses[0].harmony[0])).toBe(true);
    expect(tonic(choruses[0].harmony[0])).toBe(false);
    // The song ends on the tonic.
    const last = plan.sections[plan.sections.length - 1].harmony;
    expect(parseChordSymbol(last[last.length - 1])!.root).toBe(4);
  });

  it('is deterministic and seed-dependent', () => {
    expect(planComposition(bp)).toEqual(plan);
    const many = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => JSON.stringify(planComposition({ ...bp, seed }).sections.map((s) => s.harmony))));
    expect(many.size).toBeGreaterThan(1);
  });

  it('honours explicit harmony (symbols or roman numerals)', () => {
    const custom: Blueprint = { ...bp, structure: bp.structure.map((s) => (s.kind === 'verse' ? { ...s, harmony: ['i', 'VI', 'III', 'VII'] } : s.kind === 'chorus' ? { ...s, harmony: ['G', 'D', 'Em', 'C'] } : s)) };
    const p2 = planComposition(custom);
    expect(p2.sections.find((s) => s.kind === 'verse')!.harmony).toEqual(['Em', 'C', 'G', 'D']);
    expect(p2.sections.find((s) => s.kind === 'chorus')!.harmony).toEqual(['G', 'D', 'Em', 'C']);
  });

  it('tension adds colour: jazz extends, punk stays plain', () => {
    const jazz = planComposition(defaultBlueprint({ genreBlend: [{ genreId: 'jazz', weight: 1 }] }));
    const ext = jazz.sections.flatMap((s) => s.harmony).filter((h) => /7|9|6/.test(h)).length;
    expect(ext).toBeGreaterThan(jazz.sections.flatMap((s) => s.harmony).length * 0.5);
    const punk = planComposition(defaultBlueprint({ genreBlend: [{ genreId: 'punk', weight: 1 }] }));
    expect(punk.sections.flatMap((s) => s.harmony).every((h) => !/maj7|m7|9/.test(h))).toBe(true);
  });
});

describe('composeSong — the §73 workflow', () => {
  const bp = parsePromptToBlueprint(SPEC_PROMPT);
  const song = composeSong(bp);

  it('generates a complete, valid song quickly', () => {
    // Warm (JIT) timing of a full composition; best of three to ignore scheduler noise.
    const times = [1, 2, 3].map((k) => {
      const t0 = performance.now();
      composeSong(bp, undefined, { seed: 500 + k });
      return performance.now() - t0;
    });
    expect(Math.min(...times)).toBeLessThan(1000);
    expect(song.tracks.map((t) => t.name)).toEqual(['Lead Vocal', 'Drums', 'Bass', 'Rhythm Guitar L', 'Rhythm Guitar R', 'Piano', 'Violin']);
    for (const t of song.tracks) expect(t.notes.length, t.name).toBeGreaterThan(20);
    expect(validityProblems(song)).toEqual([]);
    expect(song.generation.engineVersion).toBe(ENGINE_VERSION);
    expect(song.generation.seed).toBe(bp.seed);
    expect(song.keyMap[0].key).toEqual({ tonic: 4, mode: 'minor' });
    expect(song.tempoMap[0].bpm).toBe(bp.tempo);
    expect(song.blueprint).toEqual(bp);
    expect(song.plan?.sections.length).toBe(bp.structure.length);
  });

  it('builds sections with repeat relations and chords per section', () => {
    const byName = (n: string) => song.sections.find((s) => s.name === n)!;
    expect(byName('Verse 2').repeatOf).toBe(byName('Verse 1').id);
    expect(byName('Chorus 2').repeatOf).toBe(byName('Chorus 1').id);
    expect(byName('Final Chorus').repeatOf).toBe(byName('Chorus 1').id);
    for (const s of song.sections) expect(s.progression?.length).toBeGreaterThan(0);
  });

  it('puts drums on channel 10, voices the vocal as a tenor and fills the mixer', () => {
    const drums = song.tracks.find((t) => t.role === 'drums')!;
    expect(drums.midiChannel).toBe(9);
    const vocal = song.tracks.find((t) => t.role === 'vocal')!;
    expect(vocal.vocal?.voiceType).toBe('tenor');
    for (const n of vocal.notes) {
      expect(n.pitch).toBeGreaterThanOrEqual(48);
      expect(n.pitch).toBeLessThanOrEqual(72);
    }
    for (const t of song.tracks) expect(song.mixer.channels[t.id]).toBeDefined();
    const l = song.tracks.find((t) => t.name === 'Rhythm Guitar L')!;
    const r = song.tracks.find((t) => t.name === 'Rhythm Guitar R')!;
    expect(song.mixer.channels[l.id].pan).toBeLessThanOrEqual(-0.6);
    expect(song.mixer.channels[r.id].pan).toBeGreaterThanOrEqual(0.6);
    expect(song.mixer.channels[vocal.id].compressor.enabled).toBe(true);
    expect(song.mixer.channels[drums.id].compressor.enabled).toBe(true);
    expect(song.mixer.channels[l.id].eq.highpassHz).toBeGreaterThan(0);
    expect(song.mixer.channels[vocal.id].volumeDb).toBeGreaterThan(song.mixer.channels[l.id].volumeDb);
  });

  it('creates motifs, tags notes with them and records vocal phrases', () => {
    const descs = song.motifs.map((m) => m.description);
    expect(descs).toEqual(expect.arrayContaining(['Verse vocal motif', 'Chorus hook', 'Answering phrase', 'Chorus vocal hook']));
    const vocal = song.tracks.find((t) => t.role === 'vocal')!;
    const motifIds = new Set(song.motifs.map((m) => m.id));
    expect(vocal.notes.some((n) => n.motifId && motifIds.has(n.motifId))).toBe(true);
    const phrases = song.phrases.filter((p) => p.trackId === vocal.id);
    expect(phrases.length).toBeGreaterThan(10);
    for (const p of phrases) {
      expect(p.endTick).toBeGreaterThan(p.startTick);
      expect(song.sections.some((s) => s.id === p.sectionId)).toBe(true);
    }
    for (const n of vocal.notes) if (n.phraseId) expect(phrases.some((p) => p.id === n.phraseId)).toBe(true);
  });

  it('sings choruses higher than verses and repeats the chorus melody', () => {
    const vocal = song.tracks.find((t) => t.role === 'vocal')!;
    const spans = sectionLayout(song);
    const notesOf = (name: string) => {
      const sp = spans.find((s) => s.section.name === name)!;
      return vocal.notes.filter((n) => n.tick >= sp.startTick && n.tick < sp.endTick).map((n) => ({ ...n, rel: n.tick - sp.startTick }));
    };
    const avg = (ns: { pitch: number }[]) => ns.reduce((t, n) => t + n.pitch, 0) / ns.length;
    expect(avg(notesOf('Chorus 1'))).toBeGreaterThan(avg(notesOf('Verse 1')) + 2);
    const c1 = notesOf('Chorus 1').map((n) => n.pitch);
    const c2 = notesOf('Chorus 2').map((n) => n.pitch);
    const same = c1.filter((p, i) => c2[i] === p).length;
    expect(same / c1.length).toBeGreaterThan(0.7);
  });

  it('arranges sparse intros and full choruses', () => {
    const arr = computeArrangement(song);
    const vocal = song.tracks.find((t) => t.role === 'vocal')!;
    const intro = song.sections.find((s) => s.kind === 'intro')!;
    const chorus = song.sections.find((s) => s.kind === 'chorus')!;
    const final = song.sections.find((s) => s.kind === 'final-chorus')!;
    expect(arr[vocal.id]).not.toContain(intro.id);
    expect(arr[vocal.id]).toContain(chorus.id);
    const playing = (sid: string) => song.tracks.filter((t) => arr[t.id].includes(sid)).length;
    expect(playing(final.id)).toBe(song.tracks.length);
    expect(playing(intro.id)).toBeLessThan(playing(chorus.id));
    // Generated notes follow the arrangement.
    const spans = sectionLayout(song);
    for (const t of song.tracks) {
      for (const sp of spans) {
        const has = t.notes.some((n) => n.tick >= sp.startTick && n.tick < sp.endTick);
        if (!arr[t.id].includes(sp.section.id)) expect(has, `${t.name} in ${sp.section.name}`).toBe(false);
      }
    }
  });
});

describe('determinism (§23)', () => {
  const bp = parsePromptToBlueprint(SPEC_PROMPT);
  it('same blueprint + plan + seed ⇒ identical songHash; different seeds differ', () => {
    const plan = planComposition(bp, { seed: 882914 });
    const a = composeSong(bp, plan, { seed: 882914 });
    const b = composeSong(cloneSong(bp), cloneSong(plan), { seed: 882914 });
    expect(songHash(a)).toBe(songHash(b));
    const c = composeSong(bp, plan, { seed: 882915 });
    expect(songHash(c)).not.toBe(songHash(a));
    const hashes = new Set([1, 2, 3, 4, 5].map((seed) => songHash(composeSong(bp, undefined, { seed }))));
    expect(hashes.size).toBe(5);
  });

  it('regenerating with the composition seed reproduces the song', () => {
    const song = composeSong(bp, undefined, { seed: 77 });
    const again = regenerateUnlocked(song, { seed: 77 });
    expect(songHash(again.song)).toBe(songHash(song));
    expect(again.changed).toEqual([]);
  });
});

describe('every genre generates valid material', () => {
  for (const g of BUILTIN_GENRES) {
    it(g.id, () => {
      for (const seed of [1, 99]) {
        const bp = defaultBlueprint({ genreBlend: [{ genreId: g.id, weight: 1 }], seed });
        const song = composeSong(bp, undefined, { seed });
        expect(validityProblems(song)).toEqual([]);
        const notes = song.tracks.reduce((n, t) => n + t.notes.length, 0);
        expect(notes).toBeGreaterThan(200);
        for (const t of song.tracks) expect(t.notes.length, `${g.id} ${t.name}`).toBeGreaterThan(0);
      }
    });
  }

  it('handles odd and compound meters, modal keys and blends', () => {
    const cases: Partial<Blueprint>[] = [
      { meter: { numerator: 7, denominator: 8 }, genreBlend: [{ genreId: 'metal', weight: 1 }] },
      { meter: { numerator: 6, denominator: 8 }, genreBlend: [{ genreId: 'folk', weight: 1 }] },
      { meter: { numerator: 5, denominator: 4 }, genreBlend: [{ genreId: 'jazz', weight: 1 }] },
      { meter: { numerator: 3, denominator: 4 }, genreBlend: [{ genreId: 'country', weight: 1 }] },
      { meter: { numerator: 12, denominator: 8 }, genreBlend: [{ genreId: 'rnb', weight: 1 }] },
      { key: { tonic: 2, mode: 'dorian' }, genreBlend: [{ genreId: 'house', weight: 1 }] },
      { key: { tonic: 7, mode: 'mixolydian' }, genreBlend: [{ genreId: 'rock', weight: 1 }] },
      { key: { tonic: 4, mode: 'phrygian' }, genreBlend: [{ genreId: 'metal', weight: 1 }] },
      { key: { tonic: 9, mode: 'harmonic-minor' }, genreBlend: [{ genreId: 'orchestral', weight: 1 }] },
      { genreBlend: [{ genreId: 'pop-punk', weight: 50 }, { genreId: 'emo', weight: 30 }, { genreId: 'cinematic', weight: 20 }] },
    ];
    for (const c of cases) {
      const song = composeSong(defaultBlueprint({ ...c, seed: 5 }));
      expect(validityProblems(song), JSON.stringify(c)).toEqual([]);
    }
  });
});

describe('constraints, lyrics and plans', () => {
  it('honours instrument constraints (range, sections)', () => {
    const bp = parsePromptToBlueprint(SPEC_PROMPT, { seed: 4 });
    bp.instrumentation = bp.instrumentation.map((t) =>
      t.instrumentId === 'violin' ? { ...t, constraints: { lowest: 67, highest: 88, sectionKinds: ['chorus', 'bridge', 'final-chorus'], avoid: ['double-vocal'] } } : t,
    );
    const song = composeSong(bp);
    const violin = song.tracks.find((t) => t.instrumentId === 'violin')!;
    const spans = sectionLayout(song);
    for (const n of violin.notes) {
      expect(n.pitch).toBeGreaterThanOrEqual(67);
      expect(n.pitch).toBeLessThanOrEqual(88);
      const sp = spans.find((s) => n.tick >= s.startTick && n.tick < s.endTick)!;
      expect(['chorus', 'bridge', 'final-chorus']).toContain(sp.section.kind);
    }
    expect(violin.notes.length).toBeGreaterThan(0);
    // No sustained unison/octave doubling with the vocal.
    const vocal = song.tracks.find((t) => t.role === 'vocal')!;
    const doubled = violin.notes.filter((v) => vocal.notes.some((n) => n.tick < v.tick + v.duration && n.tick + n.duration > v.tick && (n.pitch - v.pitch) % 12 === 0 && n.tick === v.tick));
    expect(doubled.length / violin.notes.length).toBeLessThan(0.1);
  });

  it('restricts tracks to explicit section ids', () => {
    const bp = parsePromptToBlueprint(SPEC_PROMPT, { seed: 6 });
    const song = composeSong(bp);
    const piano = song.tracks.find((t) => t.instrumentId === 'piano')!;
    const only = [song.sections[1].id, song.sections[3].id];
    const constrained = cloneSong(song);
    constrained.tracks.find((t) => t.id === piano.id)!.constraints.sectionIds = only;
    expect(computeArrangement(constrained)[piano.id]).toEqual(only);
    const res = regenerateUnlocked(constrained, { seed: 6, trackIds: [piano.id] });
    const spans = sectionLayout(res.song);
    for (const n of res.song.tracks.find((t) => t.id === piano.id)!.notes) {
      const sp = spans.find((s) => n.tick >= s.startTick && n.tick < s.endTick)!;
      expect(only).toContain(sp.section.id);
    }
  });

  it('matches vocal notes to lyric syllables', () => {
    const song = composeSong(parsePromptToBlueprint(SPEC_PROMPT, { seed: 3 }));
    const verse = song.sections.find((s) => s.kind === 'verse')!;
    const vocal = song.tracks.find((t) => t.role === 'vocal')!;
    const lines = ['Under the streetlights I wait for the rain', 'Counting the cars as they carry my name', 'Nobody answers the call', 'Shadows are taller than all'];
    const withLyrics = cloneSong(song);
    withLyrics.lyrics = lines.map((text, i) => ({ id: `ly${i}`, sectionId: verse.id, text, trackId: vocal.id }));
    const res = regenerateUnlocked(withLyrics, { seed: 3, trackIds: [vocal.id], sectionIds: [verse.id] });
    const v = res.song.tracks.find((t) => t.id === vocal.id)!;
    const sp = sectionLayout(res.song).find((s) => s.section.id === verse.id)!;
    const notes = v.notes.filter((n) => n.tick >= sp.startTick && n.tick < sp.endTick);
    for (const [i] of lines.entries()) {
      const lineNotes = notes.filter((n) => n.lyricLineId === `ly${i}`);
      expect(lineNotes.length, lines[i]).toBeGreaterThan(5);
      expect(lineNotes.every((n) => typeof n.syllable === 'string' && n.syllable.length > 0)).toBe(true);
    }
    expect(res.song.phrases.filter((p) => p.sectionId === verse.id && p.lyricLineId).length).toBe(4);
    expect(validityProblems(res.song)).toEqual([]);
  });

  it('applyPlanToSong applies an edited plan, moving material with sections', () => {
    const song = composeSong(defaultBlueprint({ seed: 2 }));
    const plan = cloneSong(song.plan!);
    plan.sections[1] = { ...plan.sections[1], harmony: ['Am', 'F', 'C', 'G'] };
    plan.sections.splice(0, 1); // drop the intro
    plan.tempo = 100;
    const next = applyPlanToSong(song, plan);
    expect(next.sections.length).toBe(song.sections.length - 1);
    expect(next.sections[0].id).not.toBe(song.sections[0].id);
    expect(next.tempoMap[0].bpm).toBe(100);
    const sp = sectionLayout(next)[0];
    const chords = next.chords.filter((c) => c.tick >= sp.startTick && c.tick < sp.endTick).map((c) => c.symbol);
    expect(chords.slice(0, 4)).toEqual(['Am', 'F', 'C', 'G']);
    expect(validityProblems(next).filter((p) => !p.includes('outside'))).toEqual([]);
    // Locked tempo is not changed.
    const locked = cloneSong(song);
    locked.locks = { 'song.tempo': true };
    expect(applyPlanToSong(locked, plan).tempoMap).toEqual(song.tempoMap);
  });
});
