import type { ChordSpec, KeySignature, ModeName, SectionKind, Song, Track } from '../ir/types';
import { bpmAtTick, keyAtBar, meterAtBar, sectionLayout, songDurationSeconds, tickToBar, type SectionSpan } from '../timing';
import { chordToRoman, romanToChord } from '../theory/roman';
import { chordFunction, chordTension, detectCadence } from '../theory/analysis';
import { chordPitchClasses, isDiatonic, isDominantQuality, triadQuality } from '../theory/chords';
import { MODE_INTERVALS, isMinorMode, keyName, relativeKey } from '../theory/scales';
import { intervalName, midiToNoteNameInKey, mod12, spellPitchClass } from '../theory/pitch';
import { spellChord, romanOf, MODE_LABEL } from './harmony';
import { avgPitch, beatTicks, chordSpecOf, findMelodyTrack, isDrumTrack, isMelodicTrack, isPitchedTrack } from './op-helpers';
import type { ExplainedChord, SectionExplanation, SongExplanation } from './types';
import { capitalize, listJoin } from './nlp';

/**
 * §43 Theory View — explains the harmony, melody and rhythm of each section in terms of the
 * actual project, the way a teacher would ("I – V – vi – IV in G major…").
 */

interface SectionChord {
  id: string;
  spec: ChordSpec;
  tick: number;
  duration: number;
}

function sectionChords(song: Song, span: SectionSpan): SectionChord[] {
  return song.chords
    .filter((c) => c.tick < span.endTick && c.tick + c.duration > span.startTick)
    .sort((a, b) => a.tick - b.tick)
    .map((c) => {
      const tick = Math.max(c.tick, span.startTick);
      return { id: c.id, spec: chordSpecOf(c), tick, duration: Math.min(c.tick + c.duration, span.endTick) - tick };
    });
}

/** Weighted emphasis per chord (duration, first-chord bonus, hypermetric downbeats). */
function emphasis(song: Song, span: SectionSpan, chords: SectionChord[]): { spec: ChordSpec; weight: number }[] {
  const map = new Map<string, { spec: ChordSpec; weight: number }>();
  chords.forEach((c, i) => {
    const beats = c.duration / beatTicks(song, c.tick);
    let w = beats;
    if (i === 0) w *= 2;
    const relBar = tickToBar(song, c.tick).bar - span.startBar;
    if (relBar % 4 === 0 && tickToBar(song, c.tick).beat === 0) w *= 1.25;
    const tq = triadQuality(c.spec.quality);
    const key = `${c.spec.root}:${tq === 'min' ? 'min' : tq === 'maj' ? 'maj' : tq}`;
    const cur = map.get(key) ?? { spec: { root: c.spec.root, quality: tq === 'min' ? 'min' : tq === 'dim' ? 'dim' : 'maj' }, weight: 0 };
    cur.weight += w;
    map.set(key, cur);
  });
  return [...map.values()].sort((a, b) => b.weight - a.weight);
}

function tonicWeight(key: KeySignature, weights: { spec: ChordSpec; weight: number }[]): number {
  const wantMinor = isMinorMode(key.mode);
  return weights
    .filter((w) => w.spec.root === key.tonic && (wantMinor ? w.spec.quality === 'min' : w.spec.quality === 'maj'))
    .reduce((s, w) => s + w.weight, 0);
}

/** Key the section is heard in: the song key, or its relative major/minor when the section clearly centres there. */
function analysisKey(song: Song, span: SectionSpan, chords: SectionChord[]): { key: KeySignature; local: boolean; songKey: KeySignature } {
  return sectionKeyFor(song, span, chords);
}

/** Key a section is heard in (song key, or its relative major/minor when the section clearly centres there). */
export function sectionAnalysisKey(song: Song, sectionId: string): KeySignature {
  const span = sectionLayout(song).find((s) => s.section.id === sectionId);
  if (!span) return keyAtBar(song, 0);
  return sectionKeyFor(song, span, sectionChords(song, span)).key;
}

function sectionKeyFor(song: Song, span: SectionSpan, chords: SectionChord[]): { key: KeySignature; local: boolean; songKey: KeySignature } {
  const songKey = keyAtBar(song, span.startBar);
  if (!chords.length || (songKey.mode !== 'major' && songKey.mode !== 'minor')) return { key: songKey, local: false, songKey };
  const rel = relativeKey(songKey);
  const fits = chords.every((c) => isDiatonic({ root: c.spec.root, quality: c.spec.quality }, songKey) || isDiatonic({ root: c.spec.root, quality: triadQuality(c.spec.quality) === 'min' ? 'min' : 'maj' }, songKey));
  if (!fits) return { key: songKey, local: false, songKey };
  const w = emphasis(song, span, chords);
  const sK = tonicWeight(songKey, w);
  const sR = tonicWeight(rel, w);
  const first = chords[0].spec;
  const relFirst = first.root === rel.tonic && (isMinorMode(rel.mode) ? triadQuality(first.quality) === 'min' : triadQuality(first.quality) === 'maj');
  if (relFirst && sR > Math.max(0.01, sK) * 1.5) return { key: rel, local: true, songKey };
  return { key: songKey, local: false, songKey };
}

function emphasisCenter(song: Song, span: SectionSpan): { name: string; spec: ChordSpec } | null {
  const chords = sectionChords(song, span);
  if (!chords.length) return null;
  const top = emphasis(song, span, chords)[0];
  const k = keyAtBar(song, span.startBar);
  const name = `${spellPitchClass(top.spec.root, k)} ${top.spec.quality === 'min' ? 'minor' : top.spec.quality === 'dim' ? 'diminished' : 'major'}`;
  return { name, spec: top.spec };
}

/** Shortest repeating unit after collapsing immediate repeats. */
function minimalCycle<T>(items: T[], eq: (a: T, b: T) => boolean): T[] {
  const collapsed: T[] = [];
  for (const it of items) if (!collapsed.length || !eq(collapsed[collapsed.length - 1], it)) collapsed.push(it);
  const n = collapsed.length;
  for (let p = 1; p < n; p++) {
    let ok = n >= 2 * p || n % p === 0;
    for (let i = p; i < n && ok; i++) if (!eq(collapsed[i], collapsed[i % p])) ok = false;
    if (ok && n >= 2 * p) return collapsed.slice(0, p);
  }
  return collapsed;
}

const FAMOUS: { pattern: string[]; text: string }[] = [
  { pattern: ['I', 'V', 'vi', 'IV'], text: "the I–V–vi–IV 'axis' progression heard in countless pop and pop-punk choruses" },
  { pattern: ['vi', 'IV', 'I', 'V'], text: 'a rotation of the axis progression that starts on the relative minor, giving it a wistful, searching colour' },
  { pattern: ['I', 'vi', 'IV', 'V'], text: "the 1950s 'doo-wop' progression" },
  { pattern: ['ii', 'V', 'I'], text: 'the ii–V–I, the strongest cadential formula in tonal harmony' },
  { pattern: ['I', 'IV', 'V'], text: 'a three-chord rock/folk progression' },
  { pattern: ['I', 'IV', 'V', 'IV'], text: 'a three-chord rock progression' },
  { pattern: ['i', 'VI', 'III', 'VII'], text: 'the minor-key (Aeolian) form of the axis progression, a staple of emo, rock and cinematic writing' },
  { pattern: ['i', 'VII', 'VI', 'VII'], text: 'an Aeolian vamp that never needs a leading tone' },
  { pattern: ['i', 'VII', 'VI', 'V'], text: 'the Andalusian cadence — a dramatic descending bass line' },
  { pattern: ['i', 'VI', 'VII'], text: 'the Aeolian bVI–bVII–i climb' },
  { pattern: ['I', 'bVII', 'IV'], text: "a Mixolydian rock progression (the 'double plagal' bVII–IV–I)" },
  { pattern: ['i', 'iv', 'v'], text: 'a natural-minor i–iv–v' },
  { pattern: ['i', 'iv', 'V'], text: 'a harmonic-minor i–iv–V' },
  { pattern: ['IV', 'V', 'vi'], text: 'a rising IV–V–vi climb' },
  { pattern: ['IV', 'V', 'vi', 'V'], text: 'a rising IV–V–vi–V pre-chorus climb' },
  { pattern: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'], text: "the Pachelbel 'Canon' progression" },
];

function baseRoman(r: string): string {
  return r.replace(/(maj7|maj9|M7|7sus4|sus2|sus4|add9|7|9|11|13|6|65|64|43|42|5)$/, '').replace(/[°ø+]$/, '');
}

function famousText(romans: string[]): string | null {
  const base = romans.map(baseRoman);
  for (const f of FAMOUS) {
    if (f.pattern.length !== base.length) continue;
    for (let rot = 0; rot < base.length; rot++) {
      const rotated = [...base.slice(rot), ...base.slice(0, rot)];
      if (rotated.every((r, i) => r === f.pattern[i])) return rot === 0 ? f.text : `a rotation of ${f.text}`;
    }
  }
  return null;
}

function kindWord(kind: SectionKind, name: string): string {
  switch (kind) {
    case 'final-chorus':
      return 'final chorus';
    case 'custom':
      return name;
    default:
      return kind;
  }
}

const BORROW_MODES: ModeName[] = ['minor', 'major', 'mixolydian', 'dorian', 'phrygian', 'lydian', 'harmonic-minor'];

function borrowSources(spec: ChordSpec, key: KeySignature): ModeName[] {
  const base: ChordSpec = { root: spec.root, quality: spec.quality };
  if (isDiatonic(base, key)) return [];
  return BORROW_MODES.filter((m) => m !== key.mode && isDiatonic(base, { tonic: key.tonic, mode: m }));
}

function contrastPartners(layout: SectionSpan[], idx: number): SectionSpan[] {
  const s = layout[idx];
  const kind = s.section.kind;
  const before = layout.slice(0, idx).reverse();
  const after = layout.slice(idx + 1);
  const isChorus = (k: SectionKind) => k === 'chorus' || k === 'final-chorus';
  let partner: SectionSpan | undefined;
  if (isChorus(kind) || kind === 'post-chorus' || kind === 'drop') partner = before.find((x) => x.section.kind === 'verse') ?? layout.find((x) => x.section.kind === 'verse');
  else if (kind === 'verse') partner = after.find((x) => isChorus(x.section.kind)) ?? layout.find((x) => isChorus(x.section.kind));
  else if (kind === 'bridge' || kind === 'breakdown' || kind === 'solo' || kind === 'interlude')
    partner = before.find((x) => isChorus(x.section.kind)) ?? after.find((x) => isChorus(x.section.kind));
  else partner = after.find((x) => isChorus(x.section.kind)) ?? before.find((x) => isChorus(x.section.kind));
  const out: SectionSpan[] = [];
  for (const x of [partner, layout[idx - 1], layout[idx + 1]]) if (x && x !== s && !out.includes(x)) out.push(x);
  return out;
}

// ---------------------------------------------------------------------------
// Melody & rhythm
// ---------------------------------------------------------------------------

function topLine(notes: { tick: number; pitch: number; duration: number }[]) {
  const byTick = new Map<number, { tick: number; pitch: number; duration: number }>();
  for (const n of notes) {
    const cur = byTick.get(n.tick);
    if (!cur || n.pitch > cur.pitch) byTick.set(n.tick, n);
  }
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

function melodyTrackFor(song: Song, span: SectionSpan): Track | undefined {
  const has = (t: Track) => t.notes.some((n) => n.tick >= span.startTick && n.tick < span.endTick);
  const main = findMelodyTrack(song);
  if (main && has(main)) return main;
  return song.tracks.find((t) => isMelodicTrack(t) && has(t));
}

function contourOf(pitches: number[]): string {
  if (pitches.length < 3) return 'static';
  const range = Math.max(...pitches) - Math.min(...pitches);
  if (range <= 2) return 'static (stays within a whole step)';
  const third = Math.max(1, Math.floor(pitches.length / 3));
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const first = mean(pitches.slice(0, third));
  const mid = mean(pitches.slice(third, pitches.length - third).length ? pitches.slice(third, pitches.length - third) : pitches);
  const last = mean(pitches.slice(-third));
  if (mid - first >= 2 && mid - last >= 2) return 'arch (rises to a peak, then falls)';
  if (first - mid >= 2 && last - mid >= 2) return 'inverted arch (dips, then climbs back)';
  if (last - first >= 3) return 'ascending';
  if (first - last >= 3) return 'descending';
  return 'wave-like (oscillates around a centre)';
}

function melodyStats(song: Song, span: SectionSpan, key: KeySignature): SectionExplanation['melody'] & { avg: number } {
  const t = melodyTrackFor(song, span);
  if (!t) return undefined as unknown as SectionExplanation['melody'] & { avg: number };
  const line = topLine(t.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick));
  if (!line.length) return undefined as unknown as SectionExplanation['melody'] & { avg: number };
  const pitches = line.map((n) => n.pitch);
  const lo = Math.min(...pitches);
  const hi = Math.max(...pitches);
  let chordTones = 0;
  for (const n of line) {
    const c = song.chords.find((x) => x.tick <= n.tick && n.tick < x.tick + x.duration);
    if (c && chordPitchClasses(chordSpecOf(c)).includes(mod12(n.pitch))) chordTones++;
  }
  let steps = 0;
  for (let i = 1; i < pitches.length; i++) if (Math.abs(pitches[i] - pitches[i - 1]) <= 2) steps++;
  const lowest = midiToNoteNameInKey(lo, key);
  const highest = midiToNoteNameInKey(hi, key);
  const span12 = hi - lo;
  return {
    trackId: t.id,
    range: `${lowest}–${highest} (${span12} semitone${span12 === 1 ? '' : 's'}, ${intervalLabel(span12)})`,
    lowest,
    highest,
    contour: contourOf(pitches),
    chordToneRatio: round2(chordTones / line.length),
    stepwiseRatio: round2(pitches.length > 1 ? steps / (pitches.length - 1) : 1),
    avg: avgPitch(line),
  };
}

const INTERVAL_WORDS: Record<string, string> = {
  P1: 'a unison',
  m2: 'a minor second',
  M2: 'a major second',
  m3: 'a minor third',
  M3: 'a major third',
  P4: 'a perfect fourth',
  TT: 'a tritone',
  P5: 'a perfect fifth',
  m6: 'a minor sixth',
  M6: 'a major sixth',
  m7: 'a minor seventh',
  M7: 'a major seventh',
  P8: 'an octave',
};

function intervalLabel(semis: number): string {
  const n = intervalName(semis);
  if (INTERVAL_WORDS[n]) return INTERVAL_WORDS[n];
  if (semis > 12) return `an octave and ${INTERVAL_WORDS[intervalName(semis - 12)]?.replace(/^an? /, 'a ') ?? n}`;
  return n;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function rhythmStats(song: Song, span: SectionSpan): { syncopation: number; density: number; activeParts: number; notesPerBar: number; description: string } {
  const bars = Math.max(1, span.endBar - span.startBar);
  const beats = Math.max(1, (span.endTick - span.startTick) / beatTicks(song, span.startTick));
  const tracks = song.tracks.filter((t) => t.kind === 'midi' && t.notes.some((n) => n.tick >= span.startTick && n.tick < span.endTick));
  const pitched = tracks.filter((t) => !isDrumTrack(t));
  const pool = pitched.length ? pitched : tracks;
  let syncSum = 0;
  let syncCount = 0;
  let densSum = 0;
  let total = 0;
  for (const t of tracks) {
    const notes = t.notes.filter((n) => n.tick >= span.startTick && n.tick < span.endTick);
    total += notes.length;
    const onsets = [...new Set(notes.map((n) => n.tick))];
    densSum += onsets.length / beats;
    if (!pool.includes(t)) continue;
    for (const o of onsets) {
      const pos = tickToBar(song, o).beat;
      const f = pos - Math.floor(pos);
      let score = 0;
      if (Math.abs(f) < 0.02 || Math.abs(f - 1) < 0.02) score = 0;
      else if (Math.abs(f - 0.5) < 0.02) score = 0.5;
      else if (Math.abs(f - 0.25) < 0.02 || Math.abs(f - 0.75) < 0.02) score = 0.8;
      else score = 0.6;
      const tpb = beatTicks(song, o);
      const held = notes.some((n) => n.tick === o && score > 0 && n.duration > tpb * (1 - f) + tpb / 8);
      if (held) score += 0.2;
      syncSum += Math.min(1, score);
      syncCount++;
    }
  }
  const syncopation = round2(syncCount ? syncSum / syncCount : 0);
  const density = round2(tracks.length ? densSum / tracks.length : 0);
  const busy = density >= 2.5 ? 'very busy' : density >= 1.5 ? 'busy' : density >= 0.75 ? 'moderately active' : density > 0 ? 'sparse' : 'silent';
  const sync = syncopation >= 0.45 ? 'strongly syncopated' : syncopation >= 0.25 ? 'moderately syncopated' : 'mostly on the beat';
  return {
    syncopation,
    density,
    activeParts: tracks.length,
    notesPerBar: round2(total / bars),
    description: tracks.length
      ? `${capitalize(busy)} (${density} onsets per beat per part across ${tracks.length} part${tracks.length === 1 ? '' : 's'}) and ${sync} (syncopation ${syncopation}).`
      : 'No notes yet.',
  };
}

// ---------------------------------------------------------------------------
// Section explanation
// ---------------------------------------------------------------------------

const CADENCE_TEXT: Record<string, string> = {
  authentic: 'authentic cadence — the strongest sense of arrival',
  plagal: "plagal ('Amen') cadence — a softer, hymn-like resolution",
  'minor-plagal': 'minor plagal cadence — a wistful, cinematic resolution borrowed from the parallel minor',
  deceptive: 'deceptive cadence — the expected resolution is side-stepped, so the music keeps moving',
  half: 'half cadence — open and unresolved, it asks for what comes next',
  aeolian: 'Aeolian cadence — a heroic, modal arrival without a leading tone',
  backdoor: 'backdoor (Mixolydian) cadence — a rock-flavoured arrival without a leading tone',
};

function cadenceBetween(prev: ChordSpec, cur: ChordSpec, key: KeySignature): string | null {
  const c = detectCadence(prev, cur, key);
  if (c === 'plagal' && triadQuality(prev.quality) === 'min' && !isMinorMode(key.mode)) return 'minor-plagal';
  if (c) return c;
  const pi = mod12(prev.root - key.tonic);
  const ci = mod12(cur.root - key.tonic);
  if (ci === 0 && pi === 10 && triadQuality(prev.quality) === 'maj') return isMinorMode(key.mode) ? 'aeolian' : 'backdoor';
  return null;
}

export function explainSection(song: Song, sectionId: string): SectionExplanation {
  const layout = sectionLayout(song);
  const idx = layout.findIndex((s) => s.section.id === sectionId || s.section.name === sectionId);
  if (idx < 0) throw new Error(`Unknown section: ${sectionId}`);
  return explainSpan(song, layout, idx, true);
}

function explainSpan(song: Song, layout: SectionSpan[], idx: number, withComparisons: boolean): SectionExplanation {
  const span = layout[idx];
  const sec = span.section;
  const chords = sectionChords(song, span);
  const { key, local, songKey } = analysisKey(song, span, chords);
  const kn = keyName(key);
  const explained: ExplainedChord[] = chords.map((c) => {
    const roman = romanOf(c.spec, key);
    const secondary = roman.includes('/') && !roman.includes(' over ');
    const sources = secondary ? [] : borrowSources(c.spec, key);
    const e: ExplainedChord = {
      id: c.id,
      symbol: spellChord(c.spec, key),
      roman,
      function: chordFunction(c.spec, key),
      tension: round2(chordTension(c.spec, key)),
      bar: tickToBar(song, c.tick).bar + 1,
    };
    if (sources.length) e.borrowedFrom = sources[0];
    if (secondary) e.secondary = true;
    return e;
  });
  const cycle = minimalCycle(explained, (a, b) => a.symbol === b.symbol);
  const chordSummary = cycle.map((c) => c.symbol).join(' – ');
  const romanSummary = chords.length ? `${cycle.map((c) => c.roman).join(' – ')} in ${kn}.` : 'No chords in this section.';
  const narrative: string[] = [];
  const kw = kindWord(sec.kind, sec.name);
  // 1) Progression.
  if (chords.length) {
    const famous = famousText(cycle.map((c) => c.roman));
    const repeats = explained.length > cycle.length ? ' (repeated)' : '';
    narrative.push(`${sec.name} ${cycle.length > 1 ? 'cycles' : 'sits on'} ${chordSummary}${repeats} — ${cycle.map((c) => c.roman).join(' – ')} in ${kn}${famous ? `, ${famous}` : ''}.`);
    if (local) narrative.push(`Although the song's key is ${keyName(songKey)}, this ${kw} centres on its relative ${isMinorMode(key.mode) ? 'minor' : 'major'}, ${kn}, using the same notes.`);
  } else narrative.push(`${sec.name} has no chords yet.`);

  // 2) Cadences & motion.
  const cadences: SectionExplanation['cadences'] = [];
  const prevSpan = layout[idx - 1];
  const nextSpan = layout[idx + 1];
  const prevChords = prevSpan ? sectionChords(song, prevSpan) : [];
  if (prevChords.length && chords.length) {
    const c = cadenceBetween(prevChords[prevChords.length - 1].spec, chords[0].spec, key);
    if (c && c !== 'half')
      cadences.push({
        bar: explained[0].bar,
        type: c,
        description: `${spellChord(prevChords[prevChords.length - 1].spec, key)} → ${explained[0].symbol} (${romanOf(prevChords[prevChords.length - 1].spec, key)} → ${explained[0].roman}): ${CADENCE_TEXT[c]}, arriving from ${prevSpan.section.name}.`,
      });
  }
  for (let i = 1; i < chords.length; i++) {
    const c = cadenceBetween(chords[i - 1].spec, chords[i].spec, key);
    if (!c) continue;
    const atEnd = i === chords.length - 1;
    const relEnd = tickToBar(song, chords[i].tick + chords[i].duration - 1).bar + 1 - span.startBar;
    const phraseEnd = atEnd || relEnd % 4 === 0;
    if (c === 'half' && !phraseEnd) continue;
    cadences.push({ bar: explained[i].bar, type: c, description: `${explained[i - 1].symbol} → ${explained[i].symbol} (${explained[i - 1].roman} → ${explained[i].roman}): ${CADENCE_TEXT[c]}.` });
  }
  if (chords.length) {
    const last = chords[chords.length - 1];
    const lastE = explained[explained.length - 1];
    const nextChords = nextSpan ? sectionChords(song, nextSpan) : [];
    const lastIsDominant = mod12(last.spec.root - key.tonic) === 7 && (triadQuality(last.spec.quality) === 'maj' || isDominantQuality(last.spec.quality));
    if (lastIsDominant && nextChords.length) {
      const into = cadenceBetween(last.spec, nextChords[0].spec, key);
      narrative.push(
        `It ends on ${lastE.symbol} (${lastE.roman}), a ${into === 'authentic' ? 'dominant that resolves to' : 'dominant that hands over to'} ${spellChord(nextChords[0].spec, key)} at the start of ${nextSpan.section.name}${into === 'authentic' ? ' — a strong arrival' : ''}.`,
      );
    } else if (lastE.function === 'tonic' && nextSpan && (nextSpan.section.kind === 'chorus' || nextSpan.section.kind === 'final-chorus')) {
      narrative.push(`It ends on a tonic-function chord (${lastE.symbol}), which releases tension before ${nextSpan.section.name} instead of pointing at it.`);
    }
    const hasAuthentic = cadences.some((c) => c.type === 'authentic');
    const deceptive = cadences.find((c) => c.type === 'deceptive');
    const loops = explained.length > cycle.length || sec.kind === 'chorus' || sec.kind === 'final-chorus' || sec.kind === 'verse';
    if (!hasAuthentic && cycle.length >= 3 && loops) {
      narrative.push(
        deceptive
          ? `There is no V–I cadence inside the loop: the dominant moves to vi instead (deceptive motion), so the progression keeps cycling rather than closing.`
          : 'There is no strong V–I cadence inside the loop, so the progression feels open and circular rather than final.',
      );
    }
  }

  // 3) Borrowed & secondary chords.
  const borrowed: string[] = [];
  const secondaryDominants: string[] = [];
  explained.forEach((e, i) => {
    if (e.secondary) {
      const target = e.roman.split('/')[1];
      const t = romanToChord(target, key);
      const tName = t ? spellChord(t, key) : target;
      const next = chords[i + 1];
      const resolves = next && t && next.spec.root === t.root;
      secondaryDominants.push(`${e.symbol} (${e.roman}) — secondary dominant that tonicizes ${tName} (${target})${next ? (resolves ? `, resolving to it in bar ${explained[i + 1].bar}` : `, but moves to ${explained[i + 1].symbol} instead`) : ''}.`);
    } else if (e.borrowedFrom) {
      const modes = borrowSources(chords[i].spec, key);
      const parallel = `${spellPitchClass(key.tonic, key)} ${MODE_LABEL[modes[0]]}`;
      const also = modes.slice(1, 3).map((m) => MODE_LABEL[m]);
      const tonicName = spellPitchClass(key.tonic, key);
      borrowed.push(`${e.symbol} (${e.roman}) — borrowed from ${parallel} (modal interchange)${also.length ? `; also found in ${listJoin(also.map((m) => `${tonicName} ${m}`))}` : ''}.`);
    }
  });
  const uniqBorrowed = [...new Set(borrowed)];
  const uniqSecondary = [...new Set(secondaryDominants)];
  if (uniqBorrowed.length)
    narrative.push(`${listJoin(uniqBorrowed.map((b) => b.split(' — ')[0]))} ${uniqBorrowed.length === 1 ? 'is' : 'are'} borrowed from the parallel ${isMinorMode(key.mode) ? 'major' : 'minor'} or a neighbouring mode, adding a bittersweet shade without changing key.`);
  if (uniqSecondary.length) narrative.push(`${listJoin(uniqSecondary.map((b) => b.split(' — ')[0]))} briefly ${uniqSecondary.length === 1 ? 'tonicizes' : 'tonicize'} another chord, adding forward pull.`);

  // 4) Tension.
  const tensionCurve = explained.map((e) => e.tension);
  if (explained.length >= 2) {
    const maxI = tensionCurve.indexOf(Math.max(...tensionCurve));
    const minI = tensionCurve.indexOf(Math.min(...tensionCurve));
    if (maxI !== minI)
      narrative.push(`Harmonic tension peaks on ${explained[maxI].symbol} (${explained[maxI].roman}, ${explained[maxI].function}) in bar ${explained[maxI].bar} and is lowest on ${explained[minI].symbol}.`);
  }

  // 5) Melody & rhythm.
  const mel = melodyStats(song, span, key);
  let melody: SectionExplanation['melody'];
  if (mel) {
    const { avg: _avg, ...rest } = mel;
    void _avg;
    melody = rest;
    narrative.push(
      explained.length
        ? `The melody spans ${mel.range} with ${/^[aeiou]/.test(mel.contour) ? 'an' : 'a'} ${mel.contour} contour; ${Math.round(mel.chordToneRatio * 100)}% of its notes are chord tones and ${Math.round(mel.stepwiseRatio * 100)}% of its motion is stepwise.`
        : `The melody spans ${mel.range} with ${/^[aeiou]/.test(mel.contour) ? 'an' : 'a'} ${mel.contour} contour; ${Math.round(mel.stepwiseRatio * 100)}% of its motion is stepwise.`,
    );
  }
  const r = rhythmStats(song, span);
  const rhythm = r.activeParts ? { syncopation: r.syncopation, density: r.density, description: r.description } : undefined;
  if (rhythm) narrative.push(`Rhythm: ${rhythm.description}`);

  // 6) Comparisons.
  // Each fact is stated once: a sentence promoted to the narrative is not repeated here.
  const comparisons: string[] = [];
  if (withComparisons) {
    const partners = contrastPartners(layout, idx);
    const myCenter = emphasisCenter(song, span);
    const energy = `${sec.energy}${sec.energyEnd !== undefined ? `→${sec.energyEnd}` : ''}`;
    partners.forEach((p, i) => {
      const pName = p.section.name;
      const pe = p.section.energy;
      const de = sec.energy - pe;
      comparisons.push(
        Math.abs(de) < 5
          ? `Energy ${energy} is about the same as ${pName} (${pe}) — little dynamic contrast.`
          : `Energy ${energy} vs ${pe} in ${pName} (${de > 0 ? '+' : ''}${de}): ${de > 0 ? (de >= 25 ? 'a big lift' : 'a step up') : de <= -25 ? 'a big drop' : 'a step down'}.`,
      );
      const pm = melodyStats(song, p, keyAtBar(song, p.startBar));
      if (mel && pm) {
        const d = Math.round(mel.avg - pm.avg);
        if (Math.abs(d) >= 2) comparisons.push(`The melody sits ${Math.abs(d)} semitones ${d > 0 ? 'higher' : 'lower'} than in ${pName} (average ${midiToNoteNameInKey(Math.round(mel.avg), key)} vs ${midiToNoteNameInKey(Math.round(pm.avg), key)}).`);
        else comparisons.push(`The melody stays in the same register as ${pName}.`);
      }
      const pr = rhythmStats(song, p);
      if (pr.activeParts !== r.activeParts) comparisons.push(`${r.activeParts > pr.activeParts ? 'Fuller' : 'Thinner'} arrangement: ${r.activeParts} active parts vs ${pr.activeParts} in ${pName}.`);
      else if (Math.abs(r.notesPerBar - pr.notesPerBar) >= 4) comparisons.push(`${r.notesPerBar > pr.notesPerBar ? 'Denser' : 'Sparser'} writing: ${r.notesPerBar} notes per bar vs ${pr.notesPerBar} in ${pName}.`);
      const pc = emphasisCenter(song, p);
      if (myCenter && pc && i === 0) {
        const pk = kindWord(p.section.kind, p.section.name);
        const sameSig = mod12(myCenter.spec.root - pc.spec.root) === (pc.spec.quality === 'min' ? 3 : 9) && myCenter.spec.quality !== pc.spec.quality;
        let sentence: string;
        if (myCenter.name === pc.name) sentence = `Like the ${pk}, the ${kw} centres on ${myCenter.name}; the contrast comes from energy, register and rhythm rather than harmony.`;
        else if (sameSig && pc.spec.quality === 'min' && myCenter.spec.quality === 'maj')
          sentence = `The ${pk} emphasizes ${pc.name} while the ${kw} places more weight on ${myCenter.name}, producing a perceptual emotional lift without requiring a full modulation.`;
        else if (sameSig && pc.spec.quality === 'maj' && myCenter.spec.quality === 'min')
          sentence = `The ${pk} leans on ${pc.name} while the ${kw} shifts its weight to ${myCenter.name}, darkening the mood without leaving the key.`;
        else sentence = `The ${pk} centres on ${pc.name} while the ${kw} centres on ${myCenter.name}, moving the harmonic centre of gravity.`;
        // A lift or darkening is the headline of the section, so it reads in the narrative instead.
        if (sentence.includes('emotional lift') || sentence.includes('darkening')) narrative.push(sentence);
        else comparisons.push(sentence);
      }
    });
  }

  return {
    sectionId: sec.id,
    sectionName: sec.name,
    key,
    keyName: kn,
    chords: explained,
    chordSummary,
    romanSummary,
    narrative,
    cadences,
    borrowed: uniqBorrowed,
    secondaryDominants: uniqSecondary,
    tensionCurve,
    ...(melody ? { melody } : {}),
    ...(rhythm ? { rhythm } : {}),
    comparisons,
  };
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function explainSong(song: Song): SongExplanation {
  const layout = sectionLayout(song);
  const sections = layout.map((_, i) => explainSpan(song, layout, i, true));
  const key = keyAtBar(song, 0);
  const meter = meterAtBar(song, 0);
  const bars = layout.length ? layout[layout.length - 1].endBar : 0;
  const overview: string[] = [];
  overview.push(
    `${song.title}: ${keyName(key)}, ${Math.round(bpmAtTick(song, 0))} BPM in ${meter.numerator}/${meter.denominator}, ${bars} bars (${fmtTime(songDurationSeconds(song))}).`,
  );
  if (layout.length) overview.push(`Structure: ${layout.map((s) => `${s.section.name} (${s.section.bars})`).join(' – ')}.`);
  const tracks = song.tracks.filter((t) => t.kind === 'midi' || t.clips.length);
  if (tracks.length) overview.push(`Instrumentation: ${tracks.map((t) => t.name).join(', ')}.`);
  if (layout.length) {
    const peak = layout.reduce((a, b) => (b.section.energy > a.section.energy ? b : a));
    const low = layout.reduce((a, b) => (b.section.energy < a.section.energy ? b : a));
    overview.push(`Energy arc: from ${layout[0].section.energy} (${layout[0].section.name}) to a peak of ${peak.section.energy} in ${peak.section.name}; quietest is ${low.section.name} (${low.section.energy}).`);
  }
  const keyChanges = [...song.keyMap].sort((a, b) => a.bar - b.bar).slice(1);
  for (const k of keyChanges) {
    const prev = keyAtBar(song, k.bar - 1);
    const d = mod12(k.key.tonic - prev.tonic);
    const where = layout.find((s) => k.bar >= s.startBar && k.bar < s.endBar)?.section.name;
    overview.push(`Key change at bar ${k.bar + 1}${where ? ` (${where})` : ''}: ${keyName(prev)} → ${keyName(k.key)}${d === 1 || d === 2 ? ` — a ${d === 1 ? 'half' : 'whole'}-step 'truck driver' lift` : ''}.`);
  }
  const borrowedSecs = sections.filter((s) => s.borrowed.length).map((s) => s.sectionName);
  const secondarySecs = sections.filter((s) => s.secondaryDominants.length).map((s) => s.sectionName);
  const sameSecs = borrowedSecs.length > 0 && borrowedSecs.join('|') === secondarySecs.join('|');
  overview.push(
    sameSecs
      ? `Harmony is mostly diatonic, with borrowed chords and secondary dominants in ${listJoin(borrowedSecs)}.`
      : borrowedSecs.length || secondarySecs.length
        ? `Harmony is mostly diatonic${borrowedSecs.length ? `, with borrowed chords in ${listJoin(borrowedSecs)}` : ''}${secondarySecs.length ? `${borrowedSecs.length ? ' and' : ', with'} secondary dominants in ${listJoin(secondarySecs)}` : ''}.`
        : song.chords.length
          ? 'Harmony is entirely diatonic.'
          : 'There are no chords yet.',
  );
  const repeats = layout.filter((s) => s.section.repeatOf).map((s) => `${s.section.name} repeats ${song.sections.find((x) => x.id === s.section.repeatOf)?.name ?? 'an earlier section'}`);
  if (repeats.length) overview.push(`${repeats.join('; ')}.`);
  const melodic = song.tracks.filter(isPitchedTrack).length;
  void melodic;
  void MODE_INTERVALS;
  void chordToRoman;
  return { overview, sections };
}
