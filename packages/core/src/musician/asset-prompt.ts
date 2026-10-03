import type { AssetRequest, Complexity, KeySignature, ModeName, MusicalFunction, TrackRole } from '../ir/types';
import { isDiatonic, parseChordSymbol, triadQuality } from '../theory/chords';
import { parseRoman } from '../theory/roman';
import { parseKey } from '../theory/scales';
import { mod12 } from '../theory/pitch';
import { normalizeText } from './nlp';

/**
 * §25 Generate MIDI mode — parse a free-text asset request ("Create a melancholy 16-bar cello
 * melody in D minor.") into a structured `AssetRequest` for the composer.
 */

interface InstrumentRule {
  re: RegExp;
  id: string;
  role: TrackRole;
  fn: MusicalFunction;
}

const INSTRUMENTS: InstrumentRule[] = [
  { re: /\belectronic (?:drums?|kit|beat)\b|\b808s\b|\btrap beat\b|\bdrum machine\b/, id: 'electronic-kit', role: 'drums', fn: 'rhythm' },
  { re: /\bsynth[\s-]?bass\b|\b808 bass\b|\bsub[\s-]?bass\b/, id: 'synth-bass', role: 'bass', fn: 'bass-line' },
  { re: /\b(?:upright|double|acoustic) bass\b/, id: 'upright-bass', role: 'bass', fn: 'bass-line' },
  { re: /\bcontrabass\b/, id: 'contrabass', role: 'bass', fn: 'bass-line' },
  { re: /\bbass[\s-]?drums?\b|\bdrums?\b|\bdrum (?:pattern|loop|groove|beat|part)\b|\bbreakbeat\b|\bbeat\b|\bgroove\b|\bkit\b/, id: 'drum-kit', role: 'drums', fn: 'rhythm' },
  { re: /\bpercussion\b|\bshakers?\b|\bcongas?\b|\bbongos?\b|\btambourine\b/, id: 'percussion', role: 'percussion', fn: 'rhythm' },
  { re: /\bbass(?:[\s-]?lines?)?\b|\bbasslines?\b/, id: 'electric-bass', role: 'bass', fn: 'bass-line' },
  { re: /\blead guitar\b|\bguitar (?:solo|lead)\b/, id: 'electric-guitar-lead', role: 'lead-guitar', fn: 'melody' },
  { re: /\bacoustic guitar\b|\bstrumm(?:ing|ed)\b/, id: 'acoustic-guitar', role: 'rhythm-guitar', fn: 'accompaniment' },
  { re: /\bclean (?:electric )?guitar\b/, id: 'electric-guitar-clean', role: 'rhythm-guitar', fn: 'accompaniment' },
  { re: /\b(?:distorted|heavy|metal|power[\s-]?chord|rhythm) guitar\b|\bguitar riff\b|\bguitars?\b/, id: 'electric-guitar-distorted', role: 'rhythm-guitar', fn: 'accompaniment' },
  { re: /\belectric piano\b|\brhodes\b|\bwurli(?:tzer)?\b|\be-?piano\b/, id: 'electric-piano', role: 'keys', fn: 'accompaniment' },
  { re: /\borgan\b/, id: 'organ', role: 'keys', fn: 'pad' },
  { re: /\bpiano\b|\bkeys\b|\bkeyboards?\b/, id: 'piano', role: 'keys', fn: 'accompaniment' },
  { re: /\bpizzicato\b/, id: 'pizzicato-strings', role: 'strings', fn: 'accompaniment' },
  { re: /\bstring (?:section|ensemble|pad|quartet)\b|\bstrings\b/, id: 'string-ensemble', role: 'strings', fn: 'pad' },
  { re: /\bviolins?\b|\bfiddle\b/, id: 'violin', role: 'strings', fn: 'melody' },
  { re: /\bviolas?\b/, id: 'viola', role: 'strings', fn: 'melody' },
  { re: /\bcellos?\b|\bvioloncello\b/, id: 'cello', role: 'strings', fn: 'melody' },
  { re: /\btrumpets?\b/, id: 'trumpet', role: 'custom', fn: 'melody' },
  { re: /\btrombones?\b/, id: 'trombone', role: 'custom', fn: 'melody' },
  { re: /\bfrench horns?\b/, id: 'french-horn', role: 'custom', fn: 'melody' },
  { re: /\bbrass\b|\bhorn section\b|\bhorns\b/, id: 'brass-section', role: 'custom', fn: 'harmony' },
  { re: /\bflutes?\b/, id: 'flute', role: 'custom', fn: 'melody' },
  { re: /\bclarinets?\b/, id: 'clarinet', role: 'custom', fn: 'melody' },
  { re: /\bsax(?:ophone)?s?\b/, id: 'saxophone', role: 'custom', fn: 'melody' },
  { re: /\bsynth[\s-]?pads?\b|\bpads?\b/, id: 'synth-pad', role: 'synth-pad', fn: 'pad' },
  { re: /\bsynth[\s-]?arp(?:eggio|eggiator|eggiated)?s?\b|\barp(?:eggio|eggiator|eggiated)?s?\b/, id: 'synth-arp', role: 'synth-arp', fn: 'texture' },
  { re: /\bsequencer?\b|\bsynth seq(?:uence)?\b/, id: 'synth-seq', role: 'synth-seq', fn: 'rhythm' },
  { re: /\blead synth\b|\bsynth lead\b|\bsynth melody\b|\bsynths?\b/, id: 'synth-lead', role: 'synth-lead', fn: 'melody' },
  { re: /\bchoir\b|\bchoral\b/, id: 'choir', role: 'vocal', fn: 'pad' },
  { re: /\bbacking vocals?\b|\bharmony vocals?\b/, id: 'backing-vocal', role: 'vocal', fn: 'harmony' },
  { re: /\bvocals?\b|\btopline\b|\bsinging\b|\bsung\b|\bvoice\b/, id: 'lead-vocal', role: 'vocal', fn: 'melody' },
  { re: /\bharp\b/, id: 'harp', role: 'keys', fn: 'accompaniment' },
  { re: /\btimpani\b/, id: 'timpani', role: 'percussion', fn: 'rhythm' },
  { re: /\bglock(?:enspiel)?\b/, id: 'glockenspiel', role: 'keys', fn: 'melody' },
  { re: /\bmarimba\b/, id: 'marimba', role: 'keys', fn: 'melody' },
];

const FUNCTIONS: [RegExp, MusicalFunction][] = [
  [/\bcounter[\s-]?melod(?:y|ies)\b/, 'counter-melody'],
  [/\bmelod(?:y|ies|ic line)\b|\btopline\b|\blead line\b|\btune\b/, 'melody'],
  [/\bbass[\s-]?lines?\b|\bbasslines?\b/, 'bass-line'],
  [/\bharmony\b|\bharmoni[sz]ation\b/, 'harmony'],
  [/\bchords?\b|\bcomping\b|\baccompaniment\b|\bchord progression\b/, 'accompaniment'],
  [/\bpattern\b|\bbeat\b|\bgroove\b|\brhythm(?: part)?\b|\bloop\b/, 'rhythm'],
  [/\bpads?\b|\bdrone\b|\bsustained\b/, 'pad'],
  [/\briffs?\b|\bhooks?\b/, 'hook'],
  [/\bfills?\b/, 'fills'],
  [/\bsolo\b/, 'solo'],
  [/\btexture\b|\bambient\b|\batmosphere\b/, 'texture'],
];

const GENRES: [RegExp, string][] = [
  [/\bpop[\s-]?punk\b/, 'pop-punk'],
  [/\bsynth[\s-]?pop\b/, 'synth-pop'],
  [/\bindie[\s-]?rock\b|\bindie\b/, 'indie-rock'],
  [/\balt(?:ernative)?[\s-]?rock\b/, 'alternative-rock'],
  [/\bhip[\s-]?hop\b|\brap\b|\btrap\b/, 'hip-hop'],
  [/\br&b\b|\brnb\b|\br'n'b\b|\brhythm and blues\b/, 'rnb'],
  [/\bedm\b|\belectronic dance\b/, 'edm'],
  [/\bhouse\b/, 'house'],
  [/\btrance\b/, 'trance'],
  [/\bjazz(?:y)?\b/, 'jazz'],
  [/\bmetal\b/, 'metal'],
  [/\bfolk\b/, 'folk'],
  [/\bcountry\b/, 'country'],
  [/\borchestral\b/, 'orchestral'],
  [/\bcinematic\b|\bfilm score\b|\bmovie score\b/, 'cinematic'],
  [/\bemo\b/, 'emo'],
  [/\bpunk\b/, 'punk'],
  [/\brock\b/, 'rock'],
  [/\bpop\b/, 'pop'],
];

const GENRE_TEMPO: Record<string, number> = {
  pop: 110,
  'synth-pop': 118,
  punk: 180,
  'pop-punk': 172,
  emo: 150,
  'indie-rock': 125,
  metal: 140,
  folk: 100,
  country: 110,
  edm: 128,
  house: 124,
  trance: 138,
  jazz: 130,
  rnb: 90,
  'hip-hop': 90,
  orchestral: 90,
  cinematic: 95,
  rock: 120,
  'alternative-rock': 125,
};

const MOODS: [RegExp, string][] = [
  [/\bmelanchol(?:y|ic)\b/, 'melancholy'],
  [/\bsad\b/, 'sad'],
  [/\bhappy\b/, 'happy'],
  [/\buplifting\b/, 'uplifting'],
  [/\bdark\b/, 'dark'],
  [/\baggressive\b/, 'aggressive'],
  [/\bangry\b/, 'angry'],
  [/\bdreamy\b/, 'dreamy'],
  [/\bepic\b/, 'epic'],
  [/\bhopeful\b/, 'hopeful'],
  [/\bnostalgic\b/, 'nostalgic'],
  [/\bromantic\b/, 'romantic'],
  [/\btense\b/, 'tense'],
  [/\bcalm\b/, 'calm'],
  [/\benergetic\b/, 'energetic'],
  [/\bplayful\b/, 'playful'],
  [/\bmysterious\b/, 'mysterious'],
  [/\btriumphant\b/, 'triumphant'],
  [/\bcathartic\b/, 'cathartic'],
  [/\bdefiant\b/, 'defiant'],
  [/\bbittersweet\b/, 'bittersweet'],
  [/\beerie\b/, 'eerie'],
  [/\bchill\b/, 'chill'],
  [/\bgroovy\b/, 'groovy'],
  [/\bfunky\b/, 'funky'],
  [/\bhaunting\b/, 'haunting'],
  [/\bgentle\b/, 'gentle'],
  [/\bintense\b/, 'intense'],
  [/\bpeaceful\b/, 'peaceful'],
  [/\bsomb(?:er|re)\b/, 'somber'],
  [/\bjoyful\b/, 'joyful'],
  [/\bheroic\b/, 'heroic'],
  [/\bbrooding\b/, 'brooding'],
  [/\bominous\b/, 'ominous'],
  [/\bethereal\b/, 'ethereal'],
  [/\bdriving\b/, 'driving'],
  [/\bbouncy\b/, 'bouncy'],
  [/\blaid[\s-]?back\b/, 'laid-back'],
  [/\bemotional\b/, 'emotional'],
  [/\blonely\b/, 'lonely'],
  [/\banthemic\b/, 'anthemic'],
  [/\bheavy\b/, 'heavy'],
  [/\bwistful\b/, 'wistful'],
];

const MINORISH = new Set(['melancholy', 'sad', 'dark', 'eerie', 'haunting', 'brooding', 'ominous', 'somber', 'lonely', 'mysterious', 'bittersweet', 'wistful', 'tense']);

const MODE_WORDS = '(major|minor|maj|min|dorian|phrygian|lydian|mixolydian|aeolian|ionian|locrian|harmonic minor|melodic minor)';

function detectKey(raw: string): KeySignature | null {
  const withMode = new RegExp(`\\b([A-Ga-g](?:#|b|♯|♭)?)\\s*${MODE_WORDS}\\b`, 'i').exec(raw);
  if (withMode) {
    const k = parseKey(`${withMode[1][0].toUpperCase()}${withMode[1].slice(1)} ${withMode[2].toLowerCase().replace('aeolian', 'minor').replace('ionian', 'major')}`);
    if (k) return k;
  }
  const m = /\b(?:in|key of|key:?)\s+([A-G](?:#|b|♯|♭)?)(m)?(?![a-z])/.exec(raw);
  if (m) {
    const k = parseKey(`${m[1]}${m[2] ? ' minor' : ''}`);
    if (k) return k;
  }
  return null;
}

function tokens(raw: string): string[] {
  return raw.split(/[\s,|–—]+|\s-\s|(?<=\S)-(?=[A-G])/).map((t) => t.replace(/[.;:!?)(]+$/g, '').replace(/^[(]+/, '')).filter(Boolean);
}

function detectProgression(raw: string): { chords?: string[]; romans?: string[] } {
  const toks = tokens(raw);
  let best: string[] = [];
  let cur: string[] = [];
  for (const t of toks) {
    if (/^[A-G]/.test(t) && parseChordSymbol(t)) cur.push(t);
    else {
      if (cur.length > best.length) best = cur;
      cur = [];
    }
  }
  if (cur.length > best.length) best = cur;
  if (best.length >= 2) return { chords: best };
  let rbest: string[] = [];
  let rcur: string[] = [];
  for (const t of toks) {
    if (/^(?:b|#)?(?:VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(?:°|ø|\+|o)?(?:7|maj7|9|sus2|sus4|6|add9)?$/.test(t) && parseRoman(t)) rcur.push(t);
    else {
      if (rcur.length > rbest.length) rbest = rcur;
      rcur = [];
    }
  }
  if (rcur.length > rbest.length) rbest = rcur;
  const progWord = /\bprogression\b/i.test(raw);
  if (rbest.length >= 3 || (rbest.length >= 2 && progWord)) return { romans: rbest };
  return {};
}

/** Best-fitting major/minor key for a list of chord symbols. */
export function keyFromChords(symbols: string[]): KeySignature | null {
  const specs = symbols.map((s) => parseChordSymbol(s)).filter((x): x is NonNullable<typeof x> => !!x);
  if (!specs.length) return null;
  let best: KeySignature | null = null;
  let bestScore = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as ModeName[]) {
      const key = { tonic, mode };
      let score = 0;
      for (const c of specs) if (isDiatonic({ root: c.root, quality: c.quality }, key)) score += 1;
      const first = specs[0];
      const tq = triadQuality(first.quality);
      if (first.root === tonic && ((mode === 'minor' && tq === 'min') || (mode === 'major' && tq !== 'min'))) score += 1.5;
      const last = specs[specs.length - 1];
      if (last.root === tonic) score += 0.5;
      if (mod12(last.root - tonic) === 7) score += 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = key;
      }
    }
  }
  return best;
}

function earliest<T>(text: string, rules: [RegExp, T][]): { value: T; index: number; length: number } | null {
  let out: { value: T; index: number; length: number } | null = null;
  for (const [re, value] of rules) {
    const m = re.exec(text);
    if (!m) continue;
    if (!out || m.index < out.index || (m.index === out.index && m[0].length > out.length)) out = { value, index: m.index, length: m[0].length };
  }
  return out;
}

export function parseAssetPrompt(prompt: string, opts: { defaultTempo?: number } = {}): AssetRequest {
  const raw = prompt.trim();
  const text = normalizeText(raw);

  // Genres (longest/most specific first; consumed so "pop" does not re-match inside "pop-punk").
  const genreIds: string[] = [];
  let gwork = text;
  for (const [re, id] of GENRES) {
    const m = re.exec(gwork);
    if (!m) continue;
    if (!genreIds.includes(id)) genreIds.push(id);
    gwork = gwork.slice(0, m.index) + ' '.repeat(m[0].length) + gwork.slice(m.index + m[0].length);
  }

  // Instrument: the earliest-mentioned instrument wins (ties → the longer, more specific match).
  const inst = earliest(text, INSTRUMENTS.map((r) => [r.re, r] as [RegExp, InstrumentRule]));
  const instrument: InstrumentRule = inst?.value ?? { re: /$/, id: 'piano', role: 'keys', fn: 'melody' };

  // Musical function: the function word closest to the instrument mention.
  // Matches are consumed so "melody" does not re-match inside "counter-melody".
  let fn: MusicalFunction = instrument.fn;
  let bestDist = Infinity;
  let fwork = text;
  for (const [re, f] of FUNCTIONS) {
    const m = re.exec(fwork);
    if (!m) continue;
    fwork = fwork.slice(0, m.index) + ' '.repeat(m[0].length) + fwork.slice(m.index + m[0].length);
    const d = inst ? Math.abs(m.index - inst.index) : m.index;
    if (d < bestDist) {
      bestDist = d;
      fn = f;
    }
  }
  if (instrument.role === 'drums' || instrument.role === 'percussion') fn = /\bfills?\b/.test(text) ? 'fills' : 'rhythm';
  if (instrument.role === 'bass' && fn !== 'melody' && fn !== 'solo') fn = 'bass-line';

  const progression = detectProgression(raw);
  const progressionList = progression.chords ?? progression.romans;

  // Bars.
  const barsM = /\b(\d+)[\s-]?(?:bars?|measures?)\b/.exec(text);
  const drums = instrument.role === 'drums' || instrument.role === 'percussion';
  const bars = barsM ? Math.max(1, parseInt(barsM[1], 10)) : progressionList ? Math.max(4, progressionList.length) : drums ? 4 : 8;

  // Moods.
  const moods: string[] = [];
  const moodHits = MOODS.map(([re, m]) => ({ m, i: text.search(re) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
  for (const h of moodHits) if (!moods.includes(h.m)) moods.push(h.m);

  // Key.
  let key = detectKey(raw);
  if (!key && progression.chords) key = keyFromChords(progression.chords);
  if (!key) key = moods.some((m) => MINORISH.has(m)) ? { tonic: 9, mode: 'minor' } : { tonic: 0, mode: 'major' };

  // Tempo.
  let tempo: number | undefined;
  const bpm = /\b(\d{2,3})\s*(?:bpm|beats per minute)\b/.exec(text) ?? /\btempo (?:of |at |=\s*)?(\d{2,3})\b/.exec(text);
  if (bpm) tempo = parseInt(bpm[1], 10);
  else if (/\bvery fast\b|\bbreakneck\b/.test(text)) tempo = 175;
  else if (/\bfast\b|\buptempo\b|\bup-tempo\b|\bdriving\b/.test(text)) tempo = 150;
  else if (/\bballad\b|\bvery slow\b/.test(text)) tempo = 70;
  else if (/\bslow\b/.test(text)) tempo = 76;
  else if (/\bmid[\s-]?tempo\b/.test(text)) tempo = 100;
  else if (genreIds.length) tempo = GENRE_TEMPO[genreIds[0]];
  tempo = Math.max(20, Math.min(400, tempo ?? opts.defaultTempo ?? 120));

  // Meter.
  const meterM = /\b(\d{1,2})\/(\d{1,2})\b/.exec(text);
  const meter = meterM
    ? { numerator: parseInt(meterM[1], 10), denominator: parseInt(meterM[2], 10) }
    : /\bwaltz\b/.test(text)
      ? { numerator: 3, denominator: 4 }
      : { numerator: 4, denominator: 4 };

  // Number of alternatives.
  let count = 1;
  const c1 = /\b(\d+)\s+(?:alternative|alternatives|different|variations?|versions?|options?|takes?|ideas?|variants?)\b/.exec(text);
  const c2 = /\b(\d+)\s+(?!(?:bars?|measures?|bpm|beats? per)\b)(?:[a-z-]+\s+){0,3}?(?:lines|melodies|counter-melodies|countermelodies|patterns|riffs|licks|grooves|beats|rhythms|progressions|loops|phrases|parts|basslines|hooks|fills|motifs|arpeggios|arps|sequences|pads|textures|drones|solos|harmonies|voicings|stabs|toplines|ideas|options|versions|variations|takes|alternatives)\b/.exec(text);
  if (c1) count = parseInt(c1[1], 10);
  else if (c2) count = parseInt(c2[1], 10);
  else if (/\bseveral\b/.test(text)) count = 4;
  count = Math.max(1, Math.min(16, count));

  let complexity: Complexity | undefined;
  if (/\b(?:simple|easy|basic|minimal|sparse|beginner)\b/.test(text)) complexity = 'low';
  else if (/\b(?:complex|intricate|busy|virtuosic|technical|elaborate|advanced)\b/.test(text)) complexity = 'high';
  else if (/\b(?:moderate|medium|intermediate)\b/.test(text)) complexity = 'medium';

  const seedM = /\bseed\s*[:=#]?\s*(\d+)\b/.exec(text);
  const req: AssetRequest = {
    description: raw,
    instrumentId: instrument.id,
    role: instrument.role,
    function: fn,
    bars,
    key,
    tempo,
    meter,
    moods,
    genreIds,
    count,
  };
  if (progressionList) req.progression = progressionList;
  if (complexity) req.complexity = complexity;
  if (seedM) req.seed = parseInt(seedM[1], 10);
  return req;
}
