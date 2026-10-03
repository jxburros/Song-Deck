/**
 * Song DNA (spec §11): the recognisable characteristics of a song that survive regeneration —
 * harmonic language, principal chord movement, core motifs, rhythmic identity, melodic contour,
 * instrumentation, structural proportions, energy curve, repetition pattern, tempo, meter and tonal
 * centre — and `composeFromDNA` to grow related songs from it.
 */
import type { Blueprint, BlueprintSection, BlueprintTrack, GenreWeight, KeySignature, MusicalFunction, SectionKind, Song, SongDNA, TrackRole } from '../ir/types';
import { CHORD_INTERVALS, isDiatonic } from '../theory/chords';
import { chordToRoman } from '../theory/roman';
import { barToTick, chordAtTick, keyAtTick, sectionLayout, tickToBar } from '../timing';
import { cloneSong } from '../ir/song-utils';
import { defaultMacros } from '../ir/defaults';
import { resolveFunction } from './arrangement';
import { defaultBlueprint, nameBlueprintTracks, nameSections } from './blueprint';
import { composeInternal, type ComposeInternals } from './compose';
import { blendGenres } from './genres';
import { normalizeTagIds, songTags } from './tags';
import { getInstrument } from './instruments';
import { harmonyGroupOf, planComposition } from './planner';
import { clamp01, sectionGroupId } from './util';

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

function triadQualityOf(q: string): 'maj' | 'min' | 'dim' | 'aug' {
  if (q.startsWith('min') || q === 'min6') return 'min';
  if (q === 'dim' || q === 'dim7' || q === 'm7b5') return 'dim';
  if (q.startsWith('aug')) return 'aug';
  return 'maj';
}

/** Shortest cycle that repeats to form the sequence (Em C G D Em C G D → Em C G D). */
function reduceCycle(seq: string[]): string[] {
  for (let len = 1; len <= seq.length / 2; len++) {
    if (seq.length % len !== 0) continue;
    let ok = true;
    for (let i = len; i < seq.length && ok; i++) if (seq[i] !== seq[i % len]) ok = false;
    if (ok) return seq.slice(0, len);
  }
  return seq;
}

/** Roman numeral of every harmonic slot (each bar start and each change inside a bar). */
function sectionRomans(song: Song, start: number, end: number): string[] {
  const slots: number[] = [];
  let bar = tickToBar(song, start).bar;
  for (let t = barToTick(song, bar); t < end; t = barToTick(song, ++bar)) if (t >= start) slots.push(t);
  for (const c of song.chords) if (c.tick > start && c.tick < end && !slots.includes(c.tick)) slots.push(c.tick);
  slots.sort((a, b) => a - b);
  const out: string[] = [];
  for (const t of slots) {
    const c = chordAtTick(song, t);
    if (c) out.push(c.roman ?? chordToRoman(c, keyAtTick(song, c.tick)));
  }
  return out;
}

/**
 * The progression's repeating cycle, one entry per harmonic slot (Em C D Em | Em C D Em →
 * i VI VII i). Slots are kept as-is so the movement can be re-realized bar for bar.
 */
function principalOf(slots: string[]): string[] {
  return reduceCycle(slots);
}

/** Repetition letters ("ABCB…") from repeat relations and harmonic identity. */
export function repetitionOf(song: Song): { pattern: string; repeatRatio: number; letters: string[] } {
  const spans = sectionLayout(song);
  const sigToLetter = new Map<string, string>();
  const letters: string[] = [];
  let repeatedBars = 0;
  let total = 0;
  const sigOf = new Map<string, string>();
  for (const sp of spans) {
    const s = sp.section;
    const root = sectionGroupId(song, s);
    const sig = root !== s.id && sigOf.has(root) ? sigOf.get(root)! : `${harmonyGroupOf(s.kind)}|${principalOf(sectionRomans(song, sp.startTick, sp.endTick)).join('-')}`;
    sigOf.set(s.id, sig);
    let letter = sigToLetter.get(sig);
    if (letter) repeatedBars += s.bars;
    else {
      letter = String.fromCharCode(65 + (sigToLetter.size % 26));
      sigToLetter.set(sig, letter);
    }
    letters.push(letter);
    total += s.bars;
  }
  const grouped = letters.map((l, i) => (i > 0 && i % 4 === 0 ? ` ${l}` : l)).join('');
  return { pattern: grouped, repeatRatio: total ? round(repeatedBars / total) : 0, letters };
}

/** Compute every SongDNA field from a song. */
export function extractSongDNA(song: Song): SongDNA {
  const key: KeySignature = song.keyMap[0]?.key ? { ...song.keyMap[0].key } : { tonic: 0, mode: 'major' };
  const tempo = song.tempoMap[0]?.bpm ?? 120;
  const meter = song.meterMap[0] ? { numerator: song.meterMap[0].numerator, denominator: song.meterMap[0].denominator } : { numerator: 4, denominator: 4 };
  const spans = sectionLayout(song);

  // Harmonic language (duration-weighted).
  const vocab: Record<string, number> = {};
  let totalDur = 0;
  let borrowed = 0;
  let extended = 0;
  for (const c of song.chords) {
    const k = keyAtTick(song, c.tick);
    const r = c.roman ?? chordToRoman(c, k);
    vocab[r] = (vocab[r] ?? 0) + c.duration;
    totalDur += c.duration;
    if (!isDiatonic({ root: c.root, quality: triadQualityOf(c.quality) }, k)) borrowed += c.duration;
    if ((CHORD_INTERVALS[c.quality]?.length ?? 3) >= 4) extended += c.duration;
  }
  const chordVocabulary: Record<string, number> = {};
  for (const [r, d] of Object.entries(vocab).sort((a, b) => b[1] - a[1])) chordVocabulary[r] = totalDur ? round(d / totalDur, 4) : 0;

  // Principal progression per section kind (first occurrence, reduced to its cycle).
  const principalProgressions: SongDNA['principalProgressions'] = [];
  const seenKinds = new Set<SectionKind>();
  for (const sp of spans) {
    if (seenKinds.has(sp.section.kind)) continue;
    const roman = principalOf(sectionRomans(song, sp.startTick, sp.endTick));
    if (!roman.length) continue;
    seenKinds.add(sp.section.kind);
    principalProgressions.push({ sectionKind: sp.section.kind, roman });
  }

  // Rhythmic identity per role: 16-step onset histogram, syncopation index, density.
  const rhythmicIdentity: SongDNA['rhythmicIdentity'] = [];
  const roles = [...new Set(song.tracks.filter((t) => t.kind === 'midi' && t.notes.length).map((t) => t.role))];
  for (const role of roles) {
    const grid = new Array<number>(16).fill(0);
    let onsets = 0;
    let synco = 0;
    const barsWithNotes = new Set<number>();
    for (const t of song.tracks.filter((x) => x.kind === 'midi' && x.role === role)) {
      const ticks = [...new Set(t.notes.map((n) => n.tick))];
      for (const tick of ticks) {
        const pos = tickToBar(song, tick);
        const barTicks = (song.ppq * 4 * pos.meter.numerator) / pos.meter.denominator;
        const step = Math.min(15, Math.floor((pos.tickInBar / barTicks) * 16 + 1e-6));
        grid[step]++;
        onsets++;
        barsWithNotes.add(pos.bar);
        if (step % 2 === 1) synco += 1;
        else if (step % 4 === 2) synco += 0.5;
      }
    }
    const max = Math.max(1, ...grid);
    rhythmicIdentity.push({
      role: role as TrackRole,
      onsetGrid: grid.map((v) => round(v / max)),
      syncopation: onsets ? round(synco / onsets) : 0,
      density: barsWithNotes.size ? round(clamp01(onsets / barsWithNotes.size / 16)) : 0,
    });
  }

  // Melodic contour of the principal melody per section kind.
  const instOf = (id: string) => getInstrument(id);
  const melody =
    song.tracks.find((t) => t.kind === 'midi' && t.role === 'vocal' && resolveFunction(t, instOf(t.instrumentId)) === 'melody' && t.notes.length) ??
    song.tracks.find((t) => t.kind === 'midi' && resolveFunction(t, instOf(t.instrumentId)) === 'melody' && t.notes.length);
  const melodicContour: SongDNA['melodicContour'] = [];
  if (melody) {
    const done = new Set<SectionKind>();
    for (const sp of spans) {
      if (done.has(sp.section.kind)) continue;
      const notes = melody.notes.filter((n) => n.tick >= sp.startTick && n.tick < sp.endTick).sort((a, b) => a.tick - b.tick);
      if (notes.length < 2) continue;
      done.add(sp.section.kind);
      const lo = Math.min(...notes.map((n) => n.pitch));
      const hi = Math.max(...notes.map((n) => n.pitch));
      const len = sp.endTick - sp.startTick;
      const contour: number[] = [];
      for (let k = 0; k < 16; k++) {
        const t = sp.startTick + ((k + 0.5) * len) / 16;
        let cur = notes[0];
        for (const n of notes) if (n.tick <= t) cur = n;
        contour.push(hi > lo ? round((cur.pitch - lo) / (hi - lo)) : 0.5);
      }
      melodicContour.push({ sectionKind: sp.section.kind, contour, range: hi - lo });
    }
  }

  const totalBars = song.sections.reduce((n, s) => n + s.bars, 0) || 1;
  const rep = repetitionOf(song);
  return {
    tonalCenter: key,
    tempo,
    meter,
    harmonicLanguage: {
      mode: key.mode,
      chordVocabulary,
      borrowedChordRate: totalDur ? round(borrowed / totalDur) : 0,
      extensionRate: totalDur ? round(extended / totalDur) : 0,
    },
    principalProgressions,
    motifs: cloneSong(song.motifs),
    rhythmicIdentity,
    melodicContour,
    instrumentation: song.tracks.filter((t) => t.kind === 'midi').map((t) => ({ instrumentId: t.instrumentId, role: t.role })),
    structure: song.sections.map((s) => ({ kind: s.kind, bars: s.bars, proportion: round(s.bars / totalBars) })),
    energyCurve: song.sections.map((s) => s.energy),
    repetition: { pattern: rep.pattern, repeatRatio: rep.repeatRatio },
    genreBlend: song.genreBlend.map((g) => ({ ...g })),
    ...(songTags(song).length ? { tags: songTags(song) } : {}),
  };
}

export interface ComposeFromDnaOptions {
  seed: number;
  title?: string;
  genreBlend?: GenreWeight[];
  instrumentation?: BlueprintTrack[];
  tempo?: number;
  /** Tag ids (default: the DNA's). */
  tags?: string[];
}

function defaultFunctionFor(instrumentId: string, role: TrackRole): MusicalFunction | undefined {
  if (role === 'vocal') return instrumentId === 'lead-vocal' ? 'melody' : instrumentId === 'choir' ? 'pad' : 'harmony';
  return getInstrument(instrumentId).defaultFunction;
}

/** Blueprint that reproduces a DNA's identity (structure, energies, principal progressions, instrumentation). */
export function blueprintFromDNA(dna: SongDNA, opts: ComposeFromDnaOptions): Blueprint {
  const genreBlend = opts.genreBlend && opts.genreBlend.length ? opts.genreBlend : dna.genreBlend.length ? dna.genreBlend : [{ genreId: 'pop', weight: 1 }];
  // Base macros come from the untagged blend: tag deltas apply at generation time.
  const baseGenre = blendGenres(genreBlend);
  const tags = normalizeTagIds(opts.tags ?? dna.tags);
  const progByKind = new Map(dna.principalProgressions.map((p) => [p.sectionKind, p.roman]));
  const progByGroup = new Map(dna.principalProgressions.map((p) => [harmonyGroupOf(p.sectionKind), p.roman]));
  const n = dna.structure.length;
  const energyAt = (i: number) => {
    if (!dna.energyCurve.length) return undefined;
    if (dna.energyCurve.length === n) return dna.energyCurve[i];
    const x = (i / Math.max(1, n - 1)) * (dna.energyCurve.length - 1);
    return Math.round(dna.energyCurve[Math.round(x)]);
  };
  const structure: BlueprintSection[] = nameSections(dna.structure.map((s) => ({ kind: s.kind, bars: Math.max(1, Math.round(s.bars)) }))).map((s, i) => {
    const out: BlueprintSection = { name: s.name, kind: s.kind, bars: s.bars };
    const e = energyAt(i);
    if (e !== undefined) out.energy = e;
    const roman = progByKind.get(s.kind) ?? progByGroup.get(harmonyGroupOf(s.kind));
    if (roman && roman.length) out.harmony = [...roman];
    return out;
  });
  const instrumentation =
    opts.instrumentation && opts.instrumentation.length
      ? opts.instrumentation.map((t) => ({ ...t }))
      : nameBlueprintTracks(dna.instrumentation.map((i) => ({ instrumentId: i.instrumentId, role: i.role, function: defaultFunctionFor(i.instrumentId, i.role) })));
  const synco = dna.rhythmicIdentity.length ? dna.rhythmicIdentity.reduce((t, r) => t + r.syncopation, 0) / dna.rhythmicIdentity.length : 0.4;
  const macros = {
    ...defaultMacros(),
    ...(baseGenre.macros ?? {}),
    syncopation: clamp01(synco * 1.2),
    repetition: clamp01(1 - dna.repetition.repeatRatio),
    harmonicTension: clamp01(0.2 + dna.harmonicLanguage.extensionRate * 0.6 + dna.harmonicLanguage.borrowedChordRate * 0.8),
  };
  const hasLead = instrumentation.some((t) => t.instrumentId === 'lead-vocal');
  const bp = defaultBlueprint({
    title: opts.title ?? 'Untitled',
    tempo: opts.tempo ?? dna.tempo,
    meter: { ...dna.meter },
    key: { ...dna.tonalCenter },
    genreBlend: genreBlend.map((g) => ({ ...g })),
    instrumentation,
    structure,
    macros,
    seed: opts.seed,
  });
  if (tags.length) bp.tags = tags;
  if (hasLead) bp.vocal = { voiceType: bp.vocal?.voiceType ?? 'tenor', mode: 'melody-only' };
  else delete bp.vocal;
  return bp;
}

/**
 * Compose a related song from Song DNA: same tonal centre, tempo, meter, principal progressions,
 * motifs, structure and energy curve (unless overridden) with fresh realisation from the seed.
 */
export function composeFromDNA(dna: SongDNA, opts: ComposeFromDnaOptions): Song {
  const bp = blueprintFromDNA(dna, opts);
  const plan = planComposition(bp, { seed: opts.seed });
  const internals: ComposeInternals = { motifs: dna.motifs };
  return composeInternal(bp, plan, { seed: opts.seed }, internals);
}
