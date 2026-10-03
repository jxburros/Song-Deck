/**
 * Song Blueprint (spec §10) and a deterministic, offline natural-language prompt parser.
 *
 * The parser recognises tempo, key, meter, genres and percentage blends, moods (global and per
 * section), energy words, instruments with counts, vocal type, title, theme, length hints, explicit
 * structures and macro words. Choices among equally valid options use `deriveRng(seed, …)`; without
 * an explicit seed the canonical (most typical) option is chosen so a prompt always reads the same.
 */
import type {
  Blueprint,
  BlueprintSection,
  BlueprintTrack,
  GenreProfile,
  GenreWeight,
  InstrumentConstraints,
  KeySignature,
  MacroSettings,
  ModeName,
  MusicalFunction,
  SectionFeel,
  SectionKind,
  TrackRole,
  VoiceType,
} from '../ir/types';
import { defaultMacros } from '../ir/defaults';
import { hashSeed, deriveRng, type Rng } from '../util/random';
import { pitchClassFromName } from '../theory/pitch';
import { blendGenres, getGenre } from './genres';
import { getInstrument } from './instruments';
import { drumStyleInfo } from './styles';
import { applyTagsToGenre, blendForBlueprint, findTags, normalizeTagIds, type StyleTag } from './tags';
import { clamp, clamp01, lerp } from './util';

// ---------------------------------------------------------------------------
// Section naming & defaults
// ---------------------------------------------------------------------------

export const KIND_LABEL: Record<SectionKind, string> = {
  intro: 'Intro',
  verse: 'Verse',
  'pre-chorus': 'Pre-Chorus',
  chorus: 'Chorus',
  'post-chorus': 'Post-Chorus',
  bridge: 'Bridge',
  breakdown: 'Breakdown',
  build: 'Build',
  drop: 'Drop',
  solo: 'Solo',
  interlude: 'Interlude',
  'final-chorus': 'Final Chorus',
  outro: 'Outro',
  custom: 'Section',
};

const DEFAULT_BARS: Record<SectionKind, number> = {
  intro: 4, verse: 8, 'pre-chorus': 4, chorus: 8, 'post-chorus': 4, bridge: 8, breakdown: 8, build: 8, drop: 16, solo: 8,
  interlude: 4, 'final-chorus': 8, outro: 4, custom: 8,
};

/** "Verse 1", "Verse 2", "Final Chorus"… (numbers only for kinds that repeat). */
export function nameSections<T extends { kind: SectionKind; name?: string }>(sections: T[]): (T & { name: string })[] {
  const totals = new Map<SectionKind, number>();
  for (const s of sections) if (!s.name) totals.set(s.kind, (totals.get(s.kind) ?? 0) + 1);
  const seen = new Map<SectionKind, number>();
  return sections.map((s) => {
    if (s.name) return { ...s, name: s.name };
    const n = (seen.get(s.kind) ?? 0) + 1;
    seen.set(s.kind, n);
    const label = KIND_LABEL[s.kind] ?? 'Section';
    return { ...s, name: (totals.get(s.kind) ?? 0) > 1 ? `${label} ${n}` : label };
  });
}

// ---------------------------------------------------------------------------
// Lexicons
// ---------------------------------------------------------------------------

interface MoodInfo {
  mood: string;
  valence: number;
  arousal: number;
}

const MOODS: Record<string, MoodInfo> = {};
const addMood = (words: string[], mood: string, valence: number, arousal: number) => {
  for (const w of words) MOODS[w] = { mood, valence, arousal };
};
addMood(['melancholy', 'melancholic'], 'melancholy', -0.6, 0.35);
addMood(['sad', 'sorrowful', 'mournful'], 'sad', -0.8, 0.25);
addMood(['heartbroken', 'heartbreaking'], 'heartbroken', -0.8, 0.4);
addMood(['happy', 'cheerful', 'sunny'], 'happy', 0.8, 0.65);
addMood(['joyful', 'joyous'], 'joyful', 0.9, 0.7);
addMood(['uplifting', 'inspiring', 'inspirational'], 'uplifting', 0.8, 0.7);
addMood(['hopeful'], 'hopeful', 0.6, 0.55);
addMood(['dark', 'ominous', 'sinister'], 'dark', -0.6, 0.5);
addMood(['brooding', 'moody'], 'moody', -0.45, 0.4);
addMood(['epic'], 'epic', 0.2, 0.9);
addMood(['dreamy', 'dreamlike', 'hazy'], 'dreamy', 0.3, 0.25);
addMood(['ethereal', 'atmospheric', 'ambient'], 'ethereal', 0.2, 0.25);
addMood(['aggressive'], 'aggressive', -0.4, 0.95);
addMood(['angry', 'furious', 'rage', 'raging'], 'angry', -0.7, 0.9);
addMood(['defiant', 'rebellious'], 'defiant', 0.1, 0.85);
addMood(['cathartic'], 'cathartic', 0.2, 0.9);
addMood(['nostalgic'], 'nostalgic', -0.1, 0.4);
addMood(['romantic', 'loving', 'tender'], 'romantic', 0.5, 0.4);
addMood(['triumphant', 'victorious'], 'triumphant', 0.8, 0.9);
addMood(['anthemic'], 'anthemic', 0.5, 0.9);
addMood(['energetic', 'lively'], 'energetic', 0.5, 0.85);
addMood(['chill', 'relaxed', 'laid-back', 'laidback', 'chilled'], 'chill', 0.3, 0.2);
addMood(['calm', 'peaceful', 'serene', 'tranquil'], 'peaceful', 0.4, 0.15);
addMood(['mysterious', 'mystical'], 'mysterious', -0.2, 0.4);
addMood(['haunting', 'eerie', 'spooky', 'creepy'], 'haunting', -0.5, 0.4);
addMood(['tense', 'suspenseful', 'anxious'], 'tense', -0.4, 0.7);
addMood(['bittersweet'], 'bittersweet', -0.1, 0.45);
addMood(['playful', 'quirky', 'fun'], 'playful', 0.7, 0.6);
addMood(['intense'], 'intense', -0.1, 0.9);
addMood(['emotional'], 'emotional', -0.1, 0.6);
addMood(['euphoric', 'ecstatic'], 'euphoric', 0.9, 0.95);
addMood(['somber', 'sombre', 'bleak', 'gloomy'], 'somber', -0.7, 0.2);
addMood(['lonely', 'lonesome'], 'lonely', -0.7, 0.3);
addMood(['groovy', 'funky'], 'groovy', 0.5, 0.65);
addMood(['powerful'], 'powerful', 0.2, 0.85);
addMood(['gentle', 'soft', 'delicate'], 'gentle', 0.3, 0.2);
addMood(['fierce', 'savage', 'brutal'], 'fierce', -0.3, 0.95);
addMood(['desperate', 'yearning', 'longing'], 'yearning', -0.5, 0.65);
addMood(['wistful', 'reflective', 'introspective', 'pensive'], 'reflective', -0.3, 0.35);
addMood(['bright'], 'bright', 0.7, 0.6);
addMood(['sensual', 'sexy', 'sultry'], 'sensual', 0.4, 0.45);
addMood(['heroic', 'majestic', 'grand'], 'heroic', 0.6, 0.85);
addMood(['warm', 'warmth', 'cozy', 'cosy'], 'warm', 0.5, 0.35);
addMood(['nocturnal', 'late-night'], 'late-night', 0.0, 0.3);
addMood(['hypnotic', 'trance-like'], 'hypnotic', 0.0, 0.45);
addMood(['menacing', 'threatening'], 'menacing', -0.6, 0.65);


/** Intensity adjectives (attach to sections or the whole song). +1 louder, −1 quieter. */
const ENERGY_WORDS: Record<string, number> = {
  huge: 1, massive: 1, big: 0.8, giant: 1, explosive: 1, loud: 0.8, heavy: 0.8, soaring: 0.8, hard: 0.6, driving: 0.5, pounding: 0.8,
  quiet: -1, restrained: -0.8, sparse: -0.7, minimal: -0.7, stripped: -0.8, 'stripped-down': -0.8, subdued: -0.8, intimate: -0.7, mellow: -0.6, low: -0.4,
};

const SECTION_WORDS: [RegExp, SectionKind[]][] = [
  [/^final[\s-]chorus(?:es)?$|^last[\s-]chorus(?:es)?$/, ['final-chorus']],
  [/^pre[\s-]?chorus(?:es)?$/, ['pre-chorus']],
  [/^post[\s-]?chorus(?:es)?$/, ['post-chorus']],
  [/^(?:chorus(?:es)?|hooks?|refrains?)$/, ['chorus', 'final-chorus', 'post-chorus']],
  [/^verses?$/, ['verse']],
  [/^bridges?$/, ['bridge']],
  [/^intros?$|^openings?$/, ['intro']],
  [/^(?:outros?|endings?|end|codas?)$/, ['outro', 'final-chorus']],
  [/^breakdowns?$/, ['breakdown']],
  [/^drops?$/, ['drop']],
  [/^(?:builds?|build-?ups?)$/, ['build']],
  [/^solos?$/, ['solo']],
  [/^interludes?$/, ['interlude']],
];

function sectionKindsForWord(w: string): SectionKind[] | null {
  for (const [re, kinds] of SECTION_WORDS) if (re.test(w)) return kinds;
  return null;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, pair: 2, couple: 2, dual: 2, twin: 2, double: 2,
  'double-tracked': 2, doubled: 2, several: 3, multiple: 2,
};

// Genre patterns, most specific first. Each match claims its span so "pop-punk" never also yields
// "pop". Style tags ("midwest emo", "deep house", "dream pop") are claimed before these and pull the
// blend toward their parent genres (see parseGenres).
const GENRE_PATTERNS: [RegExp, string][] = [
  [/\bk[\s-]?pop\b|\bkorean\s+pop\b|\bidol\s+pop\b/g, 'k-pop'],
  [/\bj[\s-]?pop\b|\bjapanese\s+pop\b/g, 'j-pop'],
  [/\blatin[\s-]?pop\b|\blatin\b|\blatino\b/g, 'latin-pop'],
  [/\bsynth[\s-]?wave\b|\bretro[\s-]?wave\b|\boutrun\b/g, 'synthwave'],
  [/\bhyper[\s-]?pop\b/g, 'hyperpop'],
  [/\blo[\s-]?fi\s+(?:hip[\s-]?hop|beats?|rap|instrumentals?)\b|\bchill[\s-]?hop\b|\blofi\s+girl\b/g, 'lo-fi-hip-hop'],
  [/\balt(?:ernative)?[\s-]?rock\b/g, 'alternative-rock'],
  [/\bpop[\s-]?punk\b/g, 'pop-punk'],
  [/\bpost[\s-]?rock\b/g, 'post-rock'],
  [/\bsynth[\s-]?pop\b|\belectro[\s-]?pop\b/g, 'synth-pop'],
  [/\bshoegaze\b/g, 'shoegaze'],
  [/\bgrunge\b/g, 'grunge'],
  [/\bindie(?:[\s-]?rock|[\s-]?pop)?\b/g, 'indie-rock'],
  [/\b(?:heavy[\s-])?metal(?:core)?\b|\bdjent\b/g, 'metal'],
  [/\bemo\b/g, 'emo'],
  [/\bska\b/g, 'ska'],
  [/\bpunk(?:[\s-]rock)?\b|\bhardcore\b/g, 'punk'],
  [/\bbluegrass\b/g, 'bluegrass'],
  [/\bsinger[\s-]?songwriter\b/g, 'singer-songwriter'],
  [/\bfolk\b/g, 'folk'],
  [/\bcountry\b/g, 'country'],
  [/\bdrum\s*(?:and|&|n|'n')\s*bass\b|\bdnb\b|\bd\s?&\s?b\b|\bjungle\b/g, 'drum-and-bass'],
  [/\bdubstep\b|\bbrostep\b/g, 'dubstep'],
  [/\btechno\b/g, 'techno'],
  [/\buk[\s-]?garage\b|\b2[\s-]?step\b|\bukg\b/g, 'uk-garage'],
  [/\bamapiano\b/g, 'amapiano'],
  [/\bafro[\s-]?beats?\b|\bafro[\s-]?pop\b|\bnaija\b/g, 'afrobeats'],
  [/\breggae[\s-]?ton\b|\breggaet[oó]n\b|\bperreo\b/g, 'reggaeton'],
  [/\breggae\b/g, 'reggae'],
  [/\bsalsa\b/g, 'salsa'],
  [/\bbossa(?:[\s-]?nova)?\b/g, 'bossa-nova'],
  [/\bsamba\b/g, 'samba'],
  [/\bcumbia\b/g, 'cumbia'],
  [/\bflamenco\b|\brumba\b/g, 'flamenco'],
  [/\bceltic\b|\birish\s+(?:folk|trad)\b|\bscottish\s+folk\b/g, 'celtic'],
  [/\bbollywood\b|\bfilmi\b/g, 'bollywood'],
  [/\bchip[\s-]?tune\b|\b8[\s-]?bit\s+music\b|\bvideo[\s-]?game\s+music\b/g, 'chiptune'],
  [/\bmusical[\s-]theat(?:re|er)\b|\bbroadway\b|\bshow[\s-]?tunes?\b/g, 'musical-theatre'],
  [/\bedm\b|\belectronic\s+dance\b|\belectronic\b/g, 'edm'],
  [/\bhouse\b/g, 'house'],
  [/\btrance\b/g, 'trance'],
  [/\bambient\b/g, 'ambient'],
  [/\bjazz(?:y)?\b|\bbebop\b|\bbig[\s-]band\b/g, 'jazz'],
  [/\bgospel\b/g, 'gospel'],
  [/\br\s?&\s?b\b|\brnb\b|\brhythm\s+and\s+blues\b/g, 'rnb'],
  [/\bblues\b/g, 'blues'],
  [/\bfunk\b/g, 'funk'],
  [/\bdisco\b/g, 'disco'],
  [/\bsoul\b/g, 'soul'],
  [/\bdrill\b/g, 'drill'],
  [/\bphonk\b/g, 'phonk'],
  [/\btrap\b/g, 'trap'],
  [/\bhip[\s-]?hop\b|\brap\b/g, 'hip-hop'],
  [/\borchestral\b|\bclassical\b|\bsymphon(?:y|ic)\b/g, 'orchestral'],
  [/\bcinematic\b|\bfilm[\s-]score\b|\bsoundtrack\b|\btrailer\b|\bscore\b/g, 'cinematic'],
  [/\brock\b/g, 'rock'],
  [/\bpop\b/g, 'pop'],
];

const GENRE_STYLE_LABEL: Record<string, string> = {
  'alternative-rock': 'Alternative rock',
  'pop-punk': 'Pop-punk',
  'synth-pop': 'Synth-pop',
  'indie-rock': 'Indie rock',
  rnb: 'R&B',
  'hip-hop': 'Hip-hop',
  edm: 'EDM',
  'lo-fi-hip-hop': 'Lo-fi hip-hop',
  'drum-and-bass': 'Drum and bass',
  'uk-garage': 'UK garage',
  'k-pop': 'K-pop',
  'j-pop': 'J-pop',
  'post-rock': 'Post-rock',
  'latin-pop': 'Latin pop',
  'bossa-nova': 'Bossa nova',
  'musical-theatre': 'Musical theatre',
  'singer-songwriter': 'Singer-songwriter',
};

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

type InstKey =
  | 'lead-guitar' | 'rhythm-guitar' | 'acoustic-guitar' | 'distorted-guitar' | 'clean-guitar' | 'electric-guitar' | 'guitar'
  | 'synth-bass' | 'upright-bass' | 'bass' | 'electronic-kit' | 'drums' | 'percussion' | 'electric-piano' | 'piano' | 'keys' | 'organ'
  | 'violin' | 'viola' | 'cello' | 'strings' | 'pizzicato' | 'harp' | 'trumpet' | 'trombone' | 'french-horn' | 'brass' | 'flute'
  | 'clarinet' | 'saxophone' | 'synth-lead' | 'synth-arp' | 'synth-seq' | 'synth-pad' | 'synth' | 'choir' | 'backing-vocal'
  | 'timpani' | 'glockenspiel' | 'marimba' | 'orchestra' | 'brushed-drums' | 'nylon-guitar' | 'banjo' | 'mandolin' | 'pedal-steel'
  | 'sitar' | 'clavinet' | 'accordion' | 'harmonica' | 'steel-pan' | 'log-drum' | '808' | 'chip-lead';

const INSTRUMENT_PATTERNS: [RegExp, InstKey][] = [
  [/\b(?:pedal|lap)[\s-]steel(?:\s+guitars?)?\b|\bsteel\s+guitars?\b|\bdobro\b/g, 'pedal-steel'],
  [/\b(?:nylon(?:[\s-]string)?|classical|spanish|flamenco)\s+guitars?\b/g, 'nylon-guitar'],
  [/\bbanjos?\b/g, 'banjo'],
  [/\bmandolins?\b|\bbouzouki\b/g, 'mandolin'],
  [/\bsitars?\b/g, 'sitar'],
  [/\bclavinets?\b|\bclavs?\b/g, 'clavinet'],
  [/\b(?:accordions?|bandoneons?|concertinas?|squeezebox|harmonium)\b/g, 'accordion'],
  [/\bharmonicas?\b|\bblues\s+harps?\b/g, 'harmonica'],
  [/\bsteel\s*(?:pans?|drums?)\b|\bsteelpans?\b/g, 'steel-pan'],
  [/\blog\s*drums?\b/g, 'log-drum'],
  [/\b808\s*bass(?:es)?\b|\b808s\b|\b808\b(?!\s*(?:drums?|kit|beats?))/g, '808'],
  [/\b(?:chip(?:tune)?|8[\s-]?bit|square[\s-]wave)\s+(?:leads?|melod(?:y|ies)|synths?)\b/g, 'chip-lead'],
  [/\bbrush(?:ed|es)?\s+(?:drums?|kit|snare)\b|\bdrums?\s+(?:with|on|played\s+with)\s+brushes\b|\bbrushes\b/g, 'brushed-drums'],
  [/\b(?:lead|solo|soloing)\s+guitars?\b/g, 'lead-guitar'],
  [/\brhythm\s+guitars?\b/g, 'rhythm-guitar'],
  [/\b(?:acoustic|nylon|steel[\s-]string)\s+guitars?\b/g, 'acoustic-guitar'],
  [/\b(?:distorted|heavy|crunchy|overdriven|fuzzy|fuzz)\s+guitars?\b/g, 'distorted-guitar'],
  [/\bclean\s+(?:electric\s+)?guitars?\b|\b(?:jangly|twangy|twinkly|chiming)\s+guitars?\b/g, 'clean-guitar'],
  [/\belectric\s+guitars?\b/g, 'electric-guitar'],
  [/\bguitars?\b/g, 'guitar'],
  [/\b(?:synth[\s-]?bass(?:es)?|sub[\s-]?bass|reese(?:\s+bass)?)\b/g, 'synth-bass'],
  [/\b(?:upright|double|acoustic|stand[\s-]?up)\s+bass\b|\bcontrabass\b/g, 'upright-bass'],
  // "bass drum" and a "bass voice/singer" are not the instrument.
  [/\bbass(?:[\s-]?guitar)?\b(?!\s*(?:drums?|voice|vocals?|singer))/g, 'bass'],
  [/\b(?:drum\s+machines?|electronic\s+drums|808\s*(?:drums?|kit)|programmed\s+drums|drum\s+loops?)\b/g, 'electronic-kit'],
  [/\b(?:drums?|drum\s*kit|drummer)\b/g, 'drums'],
  [/\b(?:percussion|shakers?|tambourines?|congas?|bongos?|cajons?)\b/g, 'percussion'],
  [/\b(?:electric\s+pianos?|e-?pianos?|rhodes|wurlitzers?|wurly)\b/g, 'electric-piano'],
  [/\b(?:grand\s+)?pianos?\b/g, 'piano'],
  [/\b(?:keys|keyboards?)\b/g, 'keys'],
  [/\b(?:hammond\s+)?organs?\b/g, 'organ'],
  [/\b(?:violins?|fiddles?)\b/g, 'violin'],
  [/\bviolas?\b/g, 'viola'],
  [/\b(?:cellos?|violoncellos?)\b/g, 'cello'],
  [/\bpizzicato(?:\s+strings)?\b/g, 'pizzicato'],
  [/\b(?:string\s+(?:section|ensemble|quartet)|strings)\b/g, 'strings'],
  [/\bharps?\b/g, 'harp'],
  [/\btrumpets?\b/g, 'trumpet'],
  [/\btrombones?\b/g, 'trombone'],
  [/\bfrench\s+horns?\b/g, 'french-horn'],
  [/\b(?:horn\s+section|horns|brass(?:\s+section)?)\b/g, 'brass'],
  [/\bflutes?\b/g, 'flute'],
  [/\bclarinets?\b/g, 'clarinet'],
  [/\b(?:saxophones?|sax(?:es)?)\b/g, 'saxophone'],
  [/\b(?:synth[\s-]?leads?|lead\s+synths?|supersaw(?:\s+leads?)?|saw\s+leads?)\b/g, 'synth-lead'],
  [/\b(?:arps?|arpeggiat(?:or|ors|ed|ion)|arpeggios?)\b/g, 'synth-arp'],
  [/\b(?:sequencers?|sequenced\s+synths?|synth\s+sequences?)\b/g, 'synth-seq'],
  [/\b(?:synth[\s-]?)?pads?\b/g, 'synth-pad'],
  [/\b(?:synths?|synthesi[sz]ers?)\b/g, 'synth'],
  [/\b(?:choir|choral|chorus\s+of\s+voices)\b/g, 'choir'],
  [/\b(?:backing|background|harmony|gang)\s+vocals?\b|\bvocal\s+harmonies\b|\bharmonies\b/g, 'backing-vocal'],
  [/\btimpani\b/g, 'timpani'],
  [/\b(?:glockenspiel|celesta|bells)\b/g, 'glockenspiel'],
  [/\b(?:marimbas?|vibraphones?|vibes|xylophones?)\b/g, 'marimba'],
  [/\b(?:full\s+)?orchestra\b/g, 'orchestra'],
];

interface InstMention {
  key: InstKey;
  count: number;
  index: number;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

function overlaps(spans: Span[], s: Span): boolean {
  return spans.some((x) => s.start < x.end && x.start < s.end);
}

function titleCase(t: string): string {
  return t
    .trim()
    .split(/\s+/)
    .map((w, i) => (i > 0 && /^(a|an|the|of|in|on|and|to|for|at|by|or)$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function countBefore(text: string, index: number): number | null {
  const before = text.slice(Math.max(0, index - 24), index).trim().split(/\s+/);
  for (let i = before.length - 1; i >= Math.max(0, before.length - 3); i--) {
    const w = before[i].replace(/[^a-z0-9-]/g, '');
    if (!w) continue;
    if (/^\d+$/.test(w)) {
      const n = parseInt(w, 10);
      return n > 0 && n <= 8 ? n : null;
    }
    if (w in NUMBER_WORDS) return NUMBER_WORDS[w];
    if (w === 'of' || w === 'with' || w === 'and' || /^(lead|rhythm|electric|acoustic|clean|distorted|heavy|grand|string|synth|solo)$/.test(w)) continue;
    break;
  }
  return null;
}

function isPlural(match: string): boolean {
  return /s$/.test(match.trim()) && !/(?:bass|brass|keys|strings|drums|harmonies|vibes|percussion|bells|rhodes|horns|arps|pads|synths|brushes|808s|clavs|steelpans|pans)$/.test(match.trim());
}

function pickOne<T>(items: readonly T[], weights: readonly number[], rng: Rng | null): T {
  if (!rng) {
    let best = 0;
    for (let i = 1; i < items.length; i++) if ((weights[i] ?? 0) > (weights[best] ?? 0)) best = i;
    return items[best];
  }
  return rng.weighted(items, weights);
}

// Preferred tonics by genre family (pitch class → weight).
const TONICS: Record<string, { major: Record<number, number>; minor: Record<number, number> }> = {
  guitar: { major: { 7: 4, 4: 3, 9: 3, 2: 3, 0: 2 }, minor: { 4: 10, 9: 3, 11: 2, 2: 2, 6: 1, 1: 1, 7: 1 } },
  metal: { major: { 4: 3, 2: 2 }, minor: { 4: 8, 2: 4, 1: 2, 11: 2, 9: 1.5 } },
  keys: { major: { 0: 3, 7: 3, 2: 2, 5: 2, 9: 2, 10: 2, 3: 1.5, 4: 1.5 }, minor: { 9: 4, 4: 2, 2: 2, 0: 2, 7: 1.5, 11: 1.5, 6: 1 } },
  electronic: { major: { 0: 2, 5: 2, 7: 2, 2: 1.5 }, minor: { 9: 3, 5: 2.5, 7: 2, 0: 2, 2: 2, 6: 1.5, 4: 1.5 } },
  orchestral: { major: { 2: 3, 0: 2, 5: 2, 3: 2, 10: 2 }, minor: { 2: 3, 0: 2.5, 4: 2, 9: 2, 7: 2, 5: 1.5 } },
  jazz: { major: { 5: 3, 10: 3, 3: 2.5, 0: 2, 7: 1.5, 8: 1.5 }, minor: { 0: 2, 2: 2, 7: 2, 5: 2, 9: 1.5 } },
};

function tonicFamily(genre: GenreProfile): keyof typeof TONICS {
  return drumStyleInfo(genre.rhythm.drumStyle).tonic;
}

// ---------------------------------------------------------------------------
// Structure, instrumentation and energy builders (shared with defaultBlueprint)
// ---------------------------------------------------------------------------

function energyFor(genre: GenreProfile, kind: SectionKind): number {
  return genre.dynamics.energyBySection[kind] ?? genre.dynamics.energyBySection.verse ?? 55;
}

/** Fill energies/ramps along the structure (later verses/choruses slightly bigger, bridge builds to the final chorus). */
export function shapeEnergies(sections: BlueprintSection[], genre: GenreProfile, energyShift = 0): BlueprintSection[] {
  const seen = new Map<SectionKind, number>();
  const out = sections.map((s) => ({ ...s }));
  const finalIdx = out.map((s) => s.kind).lastIndexOf('final-chorus');
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    const k = (seen.get(s.kind) ?? 0) + 1;
    seen.set(s.kind, k);
    if (s.energy === undefined) {
      let e = energyFor(genre, s.kind) + energyShift;
      if (s.kind === 'verse') e += 4 * (k - 1);
      if (s.kind === 'chorus' || s.kind === 'drop') e += 3 * (k - 1);
      s.energy = Math.round(clamp(e, 5, 100));
    }
    if (s.energyEnd === undefined) {
      if (s.kind === 'pre-chorus') s.energyEnd = Math.round(clamp(s.energy + 12, 0, 100));
      else if (s.kind === 'build') s.energyEnd = Math.round(clamp(Math.max(s.energy + 20, 92), 0, 100));
      else if (s.kind === 'bridge' && i + 1 === finalIdx) s.energyEnd = Math.round(clamp(Math.max(s.energy + 22, 92), 0, 100));
      else if (s.kind === 'outro' && i === out.length - 1) s.energyEnd = Math.round(clamp(s.energy - 12, 5, 100));
    }
  }
  return out;
}

function structureFromTemplate(genre: GenreProfile, rng: Rng | null): BlueprintSection[] {
  const templates = genre.structure.templates.length ? genre.structure.templates : [];
  if (!templates.length) {
    return nameSections([
      { kind: 'intro' as SectionKind, bars: 4 }, { kind: 'verse' as SectionKind, bars: 8 }, { kind: 'chorus' as SectionKind, bars: 8 },
      { kind: 'verse' as SectionKind, bars: 8 }, { kind: 'chorus' as SectionKind, bars: 8 }, { kind: 'outro' as SectionKind, bars: 4 },
    ]);
  }
  const t = pickOne(templates, templates.map((x) => x.weight), rng);
  return nameSections(t.sections.map((x) => ({ kind: x.kind, bars: x.bars, ...(x.name ? { name: x.name } : {}) })));
}

function totalBars(sections: readonly BlueprintSection[]): number {
  return sections.reduce((n, s) => n + s.bars, 0);
}

/** Shorten (drop optional sections / halve long ones) or lengthen a structure toward a bar target. */
export function fitStructure(sections: BlueprintSection[], targetBars: number): BlueprintSection[] {
  let out = sections.map((s) => ({ ...s }));
  const removable: SectionKind[] = ['post-chorus', 'interlude', 'solo', 'breakdown', 'pre-chorus', 'bridge'];
  let guard = 0;
  while (totalBars(out) > targetBars * 1.1 && guard++ < 20) {
    // 1. Halve 16-bar sections; 2. trim intro/outro; 3. drop optional sections (second occurrences first).
    const long = out.findIndex((s) => s.bars >= 16);
    if (long >= 0) {
      out[long] = { ...out[long], bars: out[long].bars / 2 };
      continue;
    }
    const io = out.findIndex((s) => (s.kind === 'intro' || s.kind === 'outro') && s.bars > 2);
    if (io >= 0 && totalBars(out) - targetBars < 6) {
      out[io] = { ...out[io], bars: 2 };
      continue;
    }
    let dropped = false;
    for (const kind of removable) {
      const idxs = out.map((s, i) => (s.kind === kind ? i : -1)).filter((i) => i >= 0);
      if (idxs.length) {
        out.splice(idxs[idxs.length - 1], 1);
        dropped = true;
        break;
      }
    }
    if (!dropped) {
      // Remove a middle verse/chorus pair as a last resort.
      const v = out.map((s) => s.kind).lastIndexOf('verse');
      if (v > 1) out.splice(v, 1);
      else break;
    }
  }
  guard = 0;
  while (totalBars(out) < targetBars * 0.9 && guard++ < 12) {
    const finalIdx = out.findIndex((s) => s.kind === 'final-chorus');
    const ch = out.find((s) => s.kind === 'chorus');
    const shortChorusIdx = out.findIndex((s) => (s.kind === 'chorus' || s.kind === 'final-chorus') && s.bars < 16);
    if (finalIdx >= 0 && out[finalIdx].bars < 16) out[finalIdx] = { ...out[finalIdx], bars: 16 };
    else if (!out.some((s) => s.kind === 'solo') && finalIdx > 0) out.splice(finalIdx, 0, { name: '', kind: 'solo', bars: 8 });
    else if (ch && out.filter((s) => s.kind === 'chorus').length < 3 && finalIdx > 0) out.splice(finalIdx, 0, { name: '', kind: 'chorus', bars: ch.bars });
    else if (shortChorusIdx >= 0) out[shortChorusIdx] = { ...out[shortChorusIdx], bars: 16 };
    else break;
  }
  return nameSections(out.map((s) => ({ kind: s.kind, bars: s.bars })));
}

function trackName(base: string, used: Map<string, number>): string {
  const n = (used.get(base) ?? 0) + 1;
  used.set(base, n);
  return n === 1 ? base : `${base} ${n}`;
}

const ROLE_DISPLAY_ORDER: TrackRole[] = ['vocal', 'drums', 'percussion', 'bass', 'rhythm-guitar', 'lead-guitar', 'keys', 'strings', 'custom', 'synth-pad', 'synth-arp', 'synth-seq', 'synth-lead'];

function defaultTrackName(instrumentId: string, role: TrackRole, fn?: MusicalFunction): string {
  const inst = getInstrument(instrumentId);
  if (role === 'vocal') return instrumentId === 'choir' ? 'Choir' : fn === 'melody' ? 'Lead Vocal' : 'Backing Vocals';
  if (role === 'drums') return instrumentId === 'electronic-kit' ? 'Drum Machine' : 'Drums';
  if (role === 'bass') return instrumentId === 'electric-bass' ? 'Bass' : inst.name;
  if (role === 'rhythm-guitar') return instrumentId === 'electric-guitar-distorted' || instrumentId === 'electric-guitar-clean' ? 'Rhythm Guitar' : inst.name;
  if (role === 'lead-guitar') return instrumentId === 'pedal-steel' ? inst.name : 'Lead Guitar';
  if (instrumentId === 'string-ensemble') return 'Strings';
  return inst.name;
}

/** Turn a list of (instrument, role, fn) into named blueprint tracks with L/R pairs for doubled rhythm guitars. */
export function nameBlueprintTracks(items: { instrumentId: string; role: TrackRole; function?: MusicalFunction; constraints?: InstrumentConstraints; name?: string }[]): BlueprintTrack[] {
  const sorted = items
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const ra = ROLE_DISPLAY_ORDER.indexOf(a.t.role);
      const rb = ROLE_DISPLAY_ORDER.indexOf(b.t.role);
      const va = a.t.role === 'vocal' && a.t.function !== 'melody' ? 50 : ra;
      const vb = b.t.role === 'vocal' && b.t.function !== 'melody' ? 50 : rb;
      return va - vb || a.i - b.i;
    })
    .map((x) => x.t);
  const used = new Map<string, number>();
  // A pair of identical rhythm guitars is a double-tracked L/R pair.
  const pairCount = new Map<string, number>();
  for (const t of sorted) if (t.role === 'rhythm-guitar' && !t.name) pairCount.set(t.instrumentId, (pairCount.get(t.instrumentId) ?? 0) + 1);
  const pairIndex = new Map<string, number>();
  return sorted.map((t) => {
    const bt: BlueprintTrack = { name: '', instrumentId: t.instrumentId, role: t.role };
    if (t.function) bt.function = t.function;
    if (t.constraints) bt.constraints = { ...t.constraints };
    if (t.name) {
      bt.name = trackName(t.name, used);
    } else if (t.role === 'rhythm-guitar' && pairCount.get(t.instrumentId) === 2) {
      const idx = pairIndex.get(t.instrumentId) ?? 0;
      pairIndex.set(t.instrumentId, idx + 1);
      bt.name = `${defaultTrackName(t.instrumentId, t.role, t.function)} ${idx === 0 ? 'L' : 'R'}`;
      bt.pan = idx === 0 ? -0.7 : 0.7;
    } else {
      bt.name = trackName(defaultTrackName(t.instrumentId, t.role, t.function), used);
    }
    return bt;
  });
}

function instrumentationFromGenre(genre: GenreProfile, rng: Rng | null, includeVocal: boolean, maxTracks = 8): BlueprintTrack[] {
  const chosen: { instrumentId: string; role: TrackRole; function?: MusicalFunction }[] = [];
  for (const i of genre.instruments) {
    if (i.role === 'vocal' && i.instrumentId === 'lead-vocal' && !includeVocal) continue;
    const take = i.essential || (rng ? rng.chance(clamp01(i.weight * 0.85)) : i.weight >= 0.55);
    if (take && chosen.length < maxTracks) chosen.push({ instrumentId: i.instrumentId, role: i.role, ...(i.function ? { function: i.function } : {}) });
  }
  if (includeVocal && !chosen.some((c) => c.instrumentId === 'lead-vocal')) chosen.unshift({ instrumentId: 'lead-vocal', role: 'vocal', function: 'melody' });
  return nameBlueprintTracks(chosen);
}

function vocalExpected(genre: GenreProfile): boolean {
  const v = genre.instruments.find((i) => i.instrumentId === 'lead-vocal');
  return Boolean(v && (v.essential || v.weight >= 0.5));
}

// ---------------------------------------------------------------------------
// defaultBlueprint
// ---------------------------------------------------------------------------

/**
 * A complete, valid blueprint. Missing fields are derived from the genre blend (pop by default):
 * typical tempo, the most common structure, essential instrumentation.
 */
export function defaultBlueprint(opts: Partial<Blueprint> = {}): Blueprint {
  const tags = normalizeTagIds(opts.tags);
  // Style tags pull an empty blend toward their parents; tags shape tempo, structure and line-up,
  // while the base macros come from the untagged blend (tag deltas apply at generation time).
  const genreBlend: GenreWeight[] = blendForBlueprint({ genreBlend: opts.genreBlend ?? [], tags });
  const baseGenre = blendGenres(genreBlend);
  const genre = applyTagsToGenre(baseGenre, tags);
  const minorDefault = (genre.modes[0]?.mode ?? 'major') !== 'major';
  const key: KeySignature = opts.key ?? (minorDefault ? { tonic: 9, mode: 'minor' } : { tonic: 0, mode: 'major' });
  const vocal = opts.vocal === undefined ? (vocalExpected(genre) ? { voiceType: 'tenor' as VoiceType, mode: 'melody-only' as const } : undefined) : opts.vocal;
  const macros: MacroSettings = { ...defaultMacros(), ...(baseGenre.macros ?? {}), ...(opts.macros ?? {}) };
  const structure = opts.structure && opts.structure.length ? opts.structure.map((s) => ({ ...s })) : shapeEnergies(structureFromTemplate(genre, null), genre);
  const instrumentation =
    opts.instrumentation && opts.instrumentation.length ? opts.instrumentation.map((t) => ({ ...t })) : instrumentationFromGenre(genre, null, Boolean(vocal));
  const meter = opts.meter ?? { numerator: genre.meters[0]?.numerator ?? 4, denominator: genre.meters[0]?.denominator ?? 4 };
  const bp: Blueprint = {
    title: opts.title ?? 'Untitled',
    tempo: opts.tempo ?? genre.tempo.typical,
    meter: { ...meter },
    key: { ...key },
    styles: opts.styles ?? genreBlend.map((g) => getGenre(g.genreId)?.name ?? g.genreId),
    genreBlend,
    moods: opts.moods ? [...opts.moods] : [],
    instrumentation,
    structure,
    macros,
    seed: opts.seed ?? 1,
  };
  if (opts.prompt !== undefined) bp.prompt = opts.prompt;
  if (tags.length) bp.tags = tags;
  if (vocal) bp.vocal = { ...vocal };
  if (opts.lyricsTheme !== undefined) bp.lyricsTheme = opts.lyricsTheme;
  return bp;
}

// ---------------------------------------------------------------------------
// parsePromptToBlueprint
// ---------------------------------------------------------------------------

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where one of a tag's names or aliases appears in the lowercased prompt (outside claimed spans). */
function tagSpan(lower: string, tag: StyleTag, claimed: Span[]): Span | null {
  const names = [tag.name, ...(tag.aliases ?? [])]
    .map((n) => n.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
    .filter((w) => w.length)
    .sort((a, b) => b.join(' ').length - a.join(' ').length);
  for (const words of names) {
    const re = new RegExp(`(?<![a-z0-9])${words.map(escapeRe).join('[^a-z0-9]+')}(?![a-z0-9])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower))) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (!overlaps(claimed, span)) return span;
    }
  }
  return null;
}

/**
 * Genres of a prompt: custom genres, then style tags (whose text claims its span, so "midwest emo"
 * is not also "emo"), then the genre patterns. A style tag that names a genre word ("deep house",
 * "dream pop", "latin trap") stands in for that genre and contributes its parent genres; other style
 * tags ("vaporwave", "christmas") only pull the blend when the prompt names no genre at all.
 */
function parseGenres(lower: string, custom: GenreProfile[] | undefined, styleTags: StyleTag[]): { blend: GenreWeight[]; styles: string[]; claimed: Span[]; primary: string[] } {
  const claimed: Span[] = [];
  const found: { genreId: string; index: number; percent: number | null; label: string; share: number; nice?: string }[] = [];
  const percentBefore = (index: number): number | null => {
    const before = lower.slice(Math.max(0, index - 14), index);
    const pm = /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:of\s+)?$/.exec(before);
    return pm ? parseFloat(pm[1]) : null;
  };
  const consider = (re: RegExp, genreId: string, label?: string) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower))) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (overlaps(claimed, span)) continue;
      claimed.push(span);
      found.push({ genreId, index: m.index, percent: percentBefore(m.index), label: label ?? m[0], share: 1 });
    }
  };
  for (const g of custom ?? []) {
    const esc = (x: string) => escapeRe(x.toLowerCase());
    consider(new RegExp(`\\b(?:${esc(g.name)}|${esc(g.id)})\\b`, 'g'), g.id, g.name);
  }
  const deferred: { tag: StyleTag; index: number }[] = [];
  const primary: string[] = [];
  for (const t of styleTags) {
    const span = tagSpan(lower, t, claimed);
    if (!span) continue;
    const text = lower.slice(span.start, span.end);
    const namesGenre = GENRE_PATTERNS.some(([re]) => new RegExp(re.source).test(text));
    // Non-style tags ("rap verses", "electronic version") only hide their genre word.
    if (t.kind !== 'style' || !t.parents?.length) {
      if (namesGenre) claimed.push(span);
      continue;
    }
    claimed.push(span);
    if (!namesGenre) {
      deferred.push({ tag: t, index: span.start });
      continue;
    }
    primary.push(t.id);
    const pct = percentBefore(span.start);
    const total = t.parents.reduce((n, p) => n + p.weight, 0) || 1;
    for (const p of t.parents) found.push({ genreId: p.genreId, index: span.start, percent: pct === null ? null : (pct * p.weight) / total, label: t.name, share: p.weight / total, nice: t.name });
  }
  for (const [re, id] of GENRE_PATTERNS) consider(new RegExp(re.source, 'g'), id);
  if (!found.length) {
    for (const { tag, index } of deferred) {
      const total = tag.parents!.reduce((n, p) => n + p.weight, 0) || 1;
      for (const p of tag.parents!) found.push({ genreId: p.genreId, index, percent: null, label: tag.name, share: p.weight / total, nice: tag.name });
    }
  }
  found.sort((a, b) => a.index - b.index);
  const byId = new Map<string, { genreId: string; share: number; percent: number | null; label: string; nice?: string }>();
  for (const f of found) {
    const e = byId.get(f.genreId);
    if (e) {
      if (f.percent !== null) e.percent = (e.percent ?? 0) + f.percent;
      e.share += f.share;
    } else byId.set(f.genreId, { genreId: f.genreId, share: f.share, percent: f.percent, label: f.label, ...(f.nice ? { nice: f.nice } : {}) });
  }
  const entries = [...byId.values()];
  // Explicit percentages win; unlabelled genres share what is left (or weigh by their share).
  const withPercent = entries.filter((e) => e.percent !== null);
  const pctTotal = withPercent.reduce((t, e) => t + (e.percent ?? 0), 0);
  const without = entries.filter((e) => e.percent === null);
  const withoutShare = without.reduce((t, e) => t + e.share, 0) || 1;
  const remainder = Math.max(0, 100 - pctTotal);
  const blend: GenreWeight[] = entries.map((e) => ({
    genreId: e.genreId,
    weight:
      e.percent !== null ? e.percent : withPercent.length ? (remainder > 0 ? (remainder * e.share) / withoutShare : 10) : Math.round(e.share * 1000) / 1000,
  }));
  const norm = (x: string) => x.toLowerCase().replace(/&/g, 'n').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const styles = [
    ...new Set(
      entries.map((e) => {
        if (e.nice) return e.nice;
        const nice = GENRE_STYLE_LABEL[e.genreId] ?? getGenre(e.genreId, custom)?.name ?? e.label;
        // Sub-styles keep their own name.
        return norm(e.label) === e.genreId || norm(e.label) === norm(nice) ? nice : titleCase(e.label);
      }),
    ),
  ];
  return { blend, styles, claimed, primary };
}

interface ParsedMoods {
  global: MoodInfo[];
  /** Every mood mention once (a "cathartic chorus" counts once, not per chorus kind). */
  mentions: MoodInfo[];
  bySection: Map<SectionKind, MoodInfo[]>;
  energyBySection: Map<SectionKind, number>;
  globalEnergy: number;
  feelBySection: Map<SectionKind, SectionFeel>;
  statements: string[];
}

function parseMoods(lower: string): ParsedMoods {
  const tokens = lower.replace(/[^a-z0-9%\-\s,.;]/g, ' ').split(/\s+|(?=[,.;])|(?<=[,.;])/).filter(Boolean);
  const global: MoodInfo[] = [];
  const bySection = new Map<SectionKind, MoodInfo[]>();
  const energyBySection = new Map<SectionKind, number>();
  const feelBySection = new Map<SectionKind, SectionFeel>();
  const statements: string[] = [];
  const mentions: MoodInfo[] = [];
  const attached = new Set<number>();
  let globalEnergy = 0;
  // Pair "final chorus", "pre chorus" style two-word section names.
  const word = (i: number) => tokens[i] ?? '';
  for (let i = 0; i < tokens.length; i++) {
    let kinds = sectionKindsForWord(word(i));
    let j = i;
    if (!kinds && (word(i) === 'final' || word(i) === 'last') && sectionKindsForWord(word(i + 1))) {
      kinds = ['final-chorus'];
      j = i + 1;
    }
    if (!kinds && (word(i) === 'pre' || word(i) === 'post') && /^chorus/.test(word(i + 1))) {
      kinds = [word(i) === 'pre' ? 'pre-chorus' : 'post-chorus'];
      j = i + 1;
    }
    if (!kinds) continue;
    // Walk back over adjectives: "huge cathartic chorus", "dark and moody verse".
    const adj: { mood?: MoodInfo; energy?: number; feel?: SectionFeel; text: string }[] = [];
    for (let k = i - 1; k >= 0 && k >= i - 5; k--) {
      const w = word(k);
      if (w in MOODS) adj.push({ mood: MOODS[w], text: w });
      else if (w in ENERGY_WORDS) adj.push({ energy: ENERGY_WORDS[w], text: w });
      else if (w === 'half-time' || w === 'halftime') adj.push({ feel: 'half-time', text: w });
      else if (w === 'double-time') adj.push({ feel: 'double-time', text: w });
      else if (/^(a|an|the|very|really|super|more|most|extra|so)$/.test(w)) continue;
      else if (w === 'and' && (word(k - 1) in MOODS || word(k - 1) in ENERGY_WORDS)) continue;
      else break;
      attached.add(k);
    }
    adj.reverse();
    for (const a of adj) if (a.mood) mentions.push(a.mood);
    if (adj.length) {
      for (const kind of kinds) {
        for (const a of adj) {
          if (a.mood) bySection.set(kind, [...(bySection.get(kind) ?? []), a.mood]);
          if (a.energy !== undefined) energyBySection.set(kind, (energyBySection.get(kind) ?? 0) + a.energy);
          if (a.feel) feelBySection.set(kind, a.feel);
        }
      }
      const sectionWord = j > i ? `${word(i)} ${word(j)}` : word(i);
      statements.push(`${adj.map((a) => a.text).join(' ')} ${sectionWord}`.replace(/^\w/, (c) => c.toUpperCase()));
    }
    i = j;
  }
  for (let i = 0; i < tokens.length; i++) {
    if (attached.has(i)) continue;
    const w = word(i);
    if (w in MOODS) {
      if (!global.some((g) => g.mood === MOODS[w].mood)) global.push(MOODS[w]);
      mentions.push(MOODS[w]);
    } else if (w in ENERGY_WORDS && !(w === 'heavy' && /^metal/.test(word(i + 1)))) {
      globalEnergy += ENERGY_WORDS[w];
    }
  }
  for (const g of global) statements.push(g.mood.charAt(0).toUpperCase() + g.mood.slice(1));
  return { global, mentions, bySection, energyBySection, globalEnergy, feelBySection, statements };
}

function parseInstruments(lower: string, genreClaims: Span[]): InstMention[] {
  const claimed: Span[] = [...genreClaims];
  const out: InstMention[] = [];
  for (const [re, key] of INSTRUMENT_PATTERNS) {
    const r = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = r.exec(lower))) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (overlaps(claimed, span)) continue;
      claimed.push(span);
      const explicit = countBefore(lower, m.index);
      const count = explicit ?? (isPlural(m[0]) && key !== 'strings' && key !== 'backing-vocal' ? 2 : 1);
      out.push({ key, count: Math.max(1, Math.min(6, count)), index: m.index });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

function parseKeyText(text: string): KeySignature | null {
  const MODE = '(harmonic\\s+minor|melodic\\s+minor|major|minor|maj|min|ionian|aeolian|dorian|phrygian|lydian|mixolydian|locrian)';
  const ACC = '(#|\u266f|b|\u266d|\\s+sharp|\\s+flat|-sharp|-flat)?';
  const modeOf = (w: string): ModeName | null => {
    const x = w.toLowerCase().replace(/\s+/g, ' ');
    if (x === 'harmonic minor') return 'harmonic-minor';
    if (x === 'melodic minor') return 'melodic-minor';
    if (x === 'major' || x === 'maj' || x === 'ionian') return 'major';
    if (x === 'minor' || x === 'min' || x === 'aeolian' || x === 'm') return 'minor';
    if (['dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian'].includes(x)) return x as ModeName;
    return null;
  };
  const toPc = (letter: string, acc: string | undefined): number | null => {
    const a = (acc ?? '').trim().toLowerCase().replace('-', '');
    const sym = a === 'sharp' || a === '#' || a === '\u266f' ? '#' : a === 'flat' || a === 'b' || a === '\u266d' ? 'b' : '';
    return pitchClassFromName(letter.toUpperCase() + sym);
  };
  const build = (letter: string, acc: string | undefined, modeWord: string | undefined): KeySignature | null => {
    const pc = toPc(letter, acc);
    const mode = modeWord ? modeOf(modeWord) : 'major';
    return pc === null || !mode ? null : { tonic: pc, mode };
  };
  // 1. "in e minor", "key of D dorian", "in F sharp minor" (any letter case after in/key of).
  const r1 = new RegExp(`\\b(?:in|key\\s+of|key:?)\\s+(?:the\\s+key\\s+of\\s+)?([a-g])${ACC}\\s*${MODE}\\b`, 'i').exec(text);
  if (r1) {
    const k = build(r1[1], r1[2], r1[3]);
    if (k) return k;
  }
  // 2. "E minor", "Bb major", "D Dorian" anywhere — the letter must be a capital.
  const r2 = new RegExp(`\\b([a-g])${ACC}\\s*${MODE}\\b`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = r2.exec(text))) {
    if (!/[A-G]/.test(m[1])) continue;
    const k = build(m[1], m[2], m[3]);
    if (k) return k;
  }
  // 3. "in Em", "in F#m", "key of Bb".
  const r3 = /\b(?:in|key\s+of|key:?)\s+([A-G])(#|\u266f|b|\u266d)?(m)?(?![\w#\u266f\u266d])/.exec(text);
  if (r3) return build(r3[1], r3[2], r3[3] ? 'minor' : undefined);
  return null;
}

/**
 * Parse a natural-language request into a Song Blueprint. Works offline and deterministically;
 * unknown text still yields a valid blueprint.
 */
export function parsePromptToBlueprint(prompt: string, opts: { seed?: number; customGenres?: GenreProfile[] } = {}): Blueprint {
  const text = (prompt ?? '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const seed = opts.seed ?? hashSeed(0x5d0c, text);
  const rng = (key: string): Rng | null => (opts.seed === undefined ? null : deriveRng(seed, 'blueprint', key));

  // --- Genres -------------------------------------------------------------------------------
  // --- Tags (style, mood, era, production, vocal, region, rhythm) ------------------------------
  const tags = findTags(text);
  const g = parseGenres(lower, opts.customGenres, tags);
  let blend = g.blend;
  const moods = parseMoods(lower);
  const mentions = parseInstruments(lower, g.claimed);
  // Tags apply in order, later ones winning absolute traits (tempo window, groove): the style tags
  // that stand in for the named genre ("deep house") go last.
  const ordered = [...tags.filter((t) => !g.primary.includes(t.id)), ...tags.filter((t) => g.primary.includes(t.id))];
  const tagIds = normalizeTagIds([...ordered.map((t) => t.id), ...(mentions.some((m) => m.key === 'brushed-drums') ? ['brushed-drums'] : [])]);
  if (!blend.length) {
    const keys = new Set(mentions.map((m) => m.key));
    if (keys.has('orchestra') || (keys.has('strings') && !keys.has('drums') && !keys.has('guitar'))) blend = [{ genreId: 'orchestral', weight: 1 }];
    else if ((keys.has('synth') || keys.has('synth-pad') || keys.has('synth-arp')) && !keys.has('guitar')) blend = [{ genreId: 'synth-pop', weight: 1 }];
    else if (keys.has('acoustic-guitar') && !keys.has('drums')) blend = [{ genreId: 'folk', weight: 1 }];
    else blend = [{ genreId: 'pop', weight: 1 }];
  } else if (blend.length > 1 && blend.some((b) => b.genreId === 'orchestral') && mentions.some((m) => m.key === 'orchestra')) {
    blend = blend.filter((b) => b.genreId !== 'orchestral');
  }
  // Tags shape tempo, meter, mode, structure and line-up; the base macros come from the untagged
  // blend because tag macro deltas are applied at generation time.
  const baseGenre = blendGenres(blend, opts.customGenres);
  const genre = applyTagsToGenre(baseGenre, tagIds);
  const styles = g.styles.length ? g.styles : blend.map((b) => getGenre(b.genreId, opts.customGenres)?.name ?? b.genreId);

  // --- Tempo --------------------------------------------------------------------------------
  let tempo: number;
  const bpm = /(\d{2,3}(?:\.\d+)?)\s*(?:bpm|beats\s+per\s+minute)\b/.exec(lower) ?? /\btempo\s*(?:of|:|=)?\s*(\d{2,3})\b/.exec(lower);
  if (bpm) tempo = clamp(Math.round(parseFloat(bpm[1])), 30, 300);
  else {
    const t = genre.tempo;
    let base = t.typical;
    if (/\b(?:very\s+fast|breakneck|frantic|blistering|super\s+fast)\b/.test(lower)) base = t.max + 8;
    else if (/\b(?:fast|uptempo|up-tempo|quick|speedy|rapid)\b/.test(lower)) base = lerp(t.typical, t.max, 0.75);
    else if (/\b(?:very\s+slow|glacial)\b/.test(lower)) base = t.min - 6;
    else if (/\b(?:slow|ballad|downtempo|slow-burning|slow\s+burn)\b/.test(lower)) base = lerp(t.typical, t.min, 0.7);
    else if (/\b(?:chill|laid[\s-]?back|relaxed|lazy)\b/.test(lower)) base = lerp(t.typical, t.min, 0.4);
    else if (/\b(?:mid[\s-]?tempo|moderate)\b/.test(lower)) base = t.typical;
    else if (/\b(?:energetic|driving|upbeat)\b/.test(lower)) base = lerp(t.typical, t.max, 0.35);
    const r = rng('tempo');
    tempo = clamp(Math.round(base + (r ? r.int(-4, 4) : 0)), 40, 240);
  }

  // --- Meter --------------------------------------------------------------------------------
  let meter = { numerator: genre.meters[0]?.numerator ?? 4, denominator: genre.meters[0]?.denominator ?? 4 };
  const mm = /\b(\d{1,2})\s*\/\s*(\d{1,2})\b(?:\s*(?:time|meter|feel|signature))?/.exec(lower);
  if (mm && [2, 4, 8, 16].includes(parseInt(mm[2], 10)) && parseInt(mm[1], 10) >= 1 && parseInt(mm[1], 10) <= 15) {
    meter = { numerator: parseInt(mm[1], 10), denominator: parseInt(mm[2], 10) };
  } else if (/\bwaltz\b|\bin\s+(?:three|3)\b|\btriple\s+meter\b/.test(lower)) meter = { numerator: 3, denominator: 4 };
  else if (/\bcompound\b/.test(lower)) meter = { numerator: 6, denominator: 8 };
  else if (genre.meters.length > 1) {
    const r = rng('meter');
    if (r) {
      const m = r.weighted(genre.meters, genre.meters.map((x) => x.weight));
      meter = { numerator: m.numerator, denominator: m.denominator };
    }
  }

  // --- Key ----------------------------------------------------------------------------------
  let key = parseKeyText(text);
  if (!key) {
    const valence = moods.mentions.length ? moods.mentions.reduce((t, m) => t + m.valence, 0) / moods.mentions.length : 0;
    let mode: ModeName;
    if (valence < -0.15) mode = 'minor';
    else if (valence > 0.3) mode = 'major';
    else {
      // Mildly coloured moods tilt the genre's own mode preferences.
      const r = rng('mode');
      const candidates = genre.modes.length ? genre.modes : [{ mode: 'major' as ModeName, weight: 1 }];
      const tilt = (m: ModeName) => (m === 'major' || m === 'lydian' || m === 'mixolydian' ? 1 + valence * 2 : 1 - valence * 2);
      mode = pickOne(candidates.map((c) => c.mode), candidates.map((c) => Math.max(0.01, c.weight * tilt(c.mode))), r);
    }
    if (/\bdorian\b/.test(lower)) mode = 'dorian';
    else if (/\bmixolydian\b/.test(lower)) mode = 'mixolydian';
    else if (/\bphrygian\b/.test(lower)) mode = 'phrygian';
    else if (/\blydian\b/.test(lower)) mode = 'lydian';
    const fam = TONICS[tonicFamily(genre)];
    const table = mode === 'major' || mode === 'lydian' || mode === 'mixolydian' ? fam.major : fam.minor;
    const pcs = Object.keys(table).map(Number);
    const tonic = pickOne(pcs, pcs.map((p) => table[p]), rng('tonic'));
    key = { tonic, mode };
  }

  // --- Vocal --------------------------------------------------------------------------------
  const instrumental = /\b(?:instrumental|no\s+vocals?|without\s+vocals?|no\s+singing|no\s+singer)\b/.test(lower);
  const voiceMatch = /\b(soprano|mezzo(?:-soprano)?|contralto|alto|tenor|baritone)\b/.exec(lower) ?? /\bbass\s+(?:voice|vocals?|singer)\b/.exec(lower);
  const male = /\b(?:male|man|men|boy|guy|his)\b/.test(lower);
  const female = /\b(?:female|woman|women|girl|her|diva)\b/.test(lower);
  const vocalWords = /\b(?:vocals?|vocalist|singer|singing|sung|voice|lyrics|rapper|rapping|rap)\b/.test(lower);
  let voiceType: VoiceType | null = null;
  if (voiceMatch) {
    const w = voiceMatch[0].split(/\s+/)[0];
    voiceType = w.startsWith('mezzo') ? 'mezzo' : w === 'contralto' ? 'alto' : w === 'bass' ? 'bass' : (w as VoiceType);
  } else if (female) voiceType = genre.rhythm.drumStyle === 'orchestral' || genre.rhythm.drumStyle === 'cinematic' ? 'soprano' : 'mezzo';
  else if (male) voiceType = /\b(?:deep|low)\b/.test(lower) ? 'baritone' : 'tenor';
  else if (/\bdeep\s+voice\b/.test(lower)) voiceType = 'baritone';
  const listsInstruments = mentions.some((m) => m.key !== 'backing-vocal' && m.key !== 'choir');
  const hasVocal =
    !instrumental && (vocalWords || voiceType !== null || ((!listsInstruments || /\bsong\b/.test(lower)) && vocalExpected(genre)));
  if (hasVocal && !voiceType) voiceType = 'tenor';

  // --- Instrumentation ----------------------------------------------------------------------
  const style = drumStyleInfo(genre.rhythm.drumStyle);
  const drumStyle = style.base;
  const heavy = style.heavy === true && drumStyle !== 'indie' || genre.harmony.powerChords === true;
  const electronic = style.electronic;
  const acousticGenre = drumStyle === 'folk' || drumStyle === 'country';
  const orchestralGenre = drumStyle === 'orchestral' || drumStyle === 'cinematic';
  // Generic instrument words ("bass", "drums", "guitar", "keys") take the genre's own idiomatic
  // choice: the highest-weighted instrument of that role in its pool.
  const fromPool = (role: TrackRole, ids: string[]): string | undefined =>
    genre.instruments.filter((i) => i.role === role && ids.includes(i.instrumentId)).sort((a, b) => b.weight - a.weight)[0]?.instrumentId;
  const defaultGuitar =
    fromPool('rhythm-guitar', ['acoustic-guitar', 'nylon-guitar', 'electric-guitar-clean', 'electric-guitar-distorted']) ??
    (acousticGenre ? 'acoustic-guitar' : heavy ? 'electric-guitar-distorted' : 'electric-guitar-clean');
  const defaultBass =
    fromPool('bass', ['electric-bass', 'upright-bass', 'synth-bass', '808-bass', 'log-drum']) ??
    (orchestralGenre ? 'contrabass' : electronic ? 'synth-bass' : drumStyle === 'jazz-swing' || drumStyle === 'folk' ? 'upright-bass' : 'electric-bass');
  const acousticDrums = /\b(?:live|acoustic|real|brush(?:ed|es)?)\s+(?:drums?|kit)\b|\bbrushes\b/.test(lower);
  const defaultKit = acousticDrums ? 'drum-kit' : fromPool('drums', ['drum-kit', 'electronic-kit']) ?? (electronic ? 'electronic-kit' : 'drum-kit');
  const defaultKeys = fromPool('keys', ['electric-piano', 'piano', 'clavinet', 'organ']) ?? (electronic || drumStyle === 'rnb' ? 'electric-piano' : 'piano');
  type Item = { instrumentId: string; role: TrackRole; function?: MusicalFunction; name?: string; constraints?: InstrumentConstraints };
  let items: Item[] = [];
  let guitarCount = 0;
  let guitarType = defaultGuitar;
  let leadGuitars = 0;
  const add = (instrumentId: string, role: TrackRole, fn?: MusicalFunction, n = 1) => {
    for (let i = 0; i < n; i++) items.push({ instrumentId, role, ...(fn ? { function: fn } : {}) });
  };
  for (const m of mentions) {
    switch (m.key) {
      case 'lead-guitar':
        leadGuitars += m.count;
        break;
      case 'rhythm-guitar':
      case 'guitar':
        guitarCount += m.count;
        break;
      case 'electric-guitar':
        guitarCount += m.count;
        if (!heavy) guitarType = 'electric-guitar-clean';
        break;
      case 'acoustic-guitar':
        add('acoustic-guitar', 'rhythm-guitar', 'accompaniment', m.count);
        break;
      case 'distorted-guitar':
        guitarCount += m.count;
        guitarType = 'electric-guitar-distorted';
        break;
      case 'clean-guitar':
        guitarCount += m.count;
        guitarType = 'electric-guitar-clean';
        break;
      case 'synth-bass':
        add('synth-bass', 'bass', 'bass-line');
        break;
      case '808':
        add('808-bass', 'bass', 'bass-line');
        break;
      case 'log-drum':
        add('log-drum', 'bass', 'bass-line');
        break;
      case 'brushed-drums':
        items.push({ instrumentId: 'drum-kit', role: 'drums', function: 'rhythm', name: 'Drums (Brushes)' });
        break;
      case 'nylon-guitar':
        add('nylon-guitar', 'rhythm-guitar', 'accompaniment', m.count);
        break;
      case 'banjo':
        add('banjo', 'rhythm-guitar', 'accompaniment', m.count);
        break;
      case 'mandolin':
        add('mandolin', 'rhythm-guitar', 'accompaniment', m.count);
        break;
      case 'pedal-steel':
        add('pedal-steel', 'lead-guitar', 'counter-melody');
        break;
      case 'sitar':
        add('sitar', 'custom', 'counter-melody');
        break;
      case 'clavinet':
        add('clavinet', 'keys', 'accompaniment');
        break;
      case 'accordion':
        add('accordion', 'keys', 'accompaniment');
        break;
      case 'harmonica':
        add('harmonica', 'custom', 'counter-melody');
        break;
      case 'steel-pan':
        add('steel-pan', 'keys', 'hook');
        break;
      case 'chip-lead':
        add('chip-lead', 'synth-lead', 'hook');
        break;
      case 'upright-bass':
        add(orchestralGenre ? 'contrabass' : 'upright-bass', orchestralGenre ? 'strings' : 'bass', 'bass-line');
        break;
      case 'bass':
        add(defaultBass, defaultBass === 'contrabass' ? 'strings' : 'bass', 'bass-line');
        break;
      case 'electronic-kit':
        add('electronic-kit', 'drums', 'rhythm');
        break;
      case 'drums':
        add(defaultKit, 'drums', 'rhythm');
        break;
      case 'percussion':
        add('percussion', 'percussion', 'rhythm');
        break;
      case 'electric-piano':
        add('electric-piano', 'keys', 'accompaniment', m.count);
        break;
      case 'piano':
        add('piano', 'keys', 'accompaniment', m.count);
        break;
      case 'keys':
        add(defaultKeys, 'keys', defaultKeys === 'organ' ? 'pad' : 'accompaniment');
        break;
      case 'organ':
        add('organ', 'keys', 'pad');
        break;
      case 'violin':
        if (m.count >= 3) add('string-ensemble', 'strings', 'pad');
        else add('violin', 'strings', undefined, m.count);
        break;
      case 'viola':
        add('viola', 'strings', 'harmony', m.count);
        break;
      case 'cello':
        add('cello', 'strings', undefined, m.count);
        break;
      case 'strings':
        add('string-ensemble', 'strings', 'pad');
        break;
      case 'pizzicato':
        add('pizzicato-strings', 'strings', 'accompaniment');
        break;
      case 'harp':
        add('harp', 'keys', 'accompaniment');
        break;
      case 'trumpet':
        add('trumpet', 'custom', 'counter-melody', m.count);
        break;
      case 'trombone':
        add('trombone', 'custom', 'harmony', m.count);
        break;
      case 'french-horn':
        add('french-horn', 'custom', 'harmony', m.count);
        break;
      case 'brass':
        add('brass-section', 'custom', 'harmony');
        break;
      case 'flute':
        add('flute', 'custom', 'counter-melody', m.count);
        break;
      case 'clarinet':
        add('clarinet', 'custom', 'counter-melody', m.count);
        break;
      case 'saxophone':
        add('saxophone', 'custom', genre.rhythm.drumStyle === 'jazz-swing' ? 'melody' : 'counter-melody', m.count);
        break;
      case 'synth-lead':
        add('synth-lead', 'synth-lead', 'hook');
        break;
      case 'synth-arp':
        add('synth-arp', 'synth-arp', 'texture');
        break;
      case 'synth-seq':
        add('synth-seq', 'synth-seq', 'rhythm');
        break;
      case 'synth-pad':
        add('synth-pad', 'synth-pad', 'pad');
        break;
      case 'synth':
        add('synth-pad', 'synth-pad', 'pad');
        if (m.count > 1) add('synth-arp', 'synth-arp', 'texture');
        break;
      case 'choir':
        add('choir', 'vocal', 'pad');
        break;
      case 'backing-vocal':
        add('backing-vocal', 'vocal', 'harmony');
        break;
      case 'timpani':
        add('timpani', 'percussion', 'rhythm');
        break;
      case 'glockenspiel':
        add('glockenspiel', 'keys', 'hook');
        break;
      case 'marimba':
        add('marimba', 'keys', 'accompaniment');
        break;
      case 'orchestra':
        add('string-ensemble', 'strings', 'pad');
        add('french-horn', 'custom', 'harmony');
        add('timpani', 'percussion', 'rhythm');
        break;
    }
  }
  // Guitars: one → rhythm; two → double-tracked L/R; three+ → L/R + lead.
  if (guitarCount > 0) {
    const rhythmCount = guitarCount >= 3 ? 2 : guitarCount;
    add(guitarType, 'rhythm-guitar', heavy ? 'rhythm' : 'accompaniment', rhythmCount);
    if (guitarCount >= 3) leadGuitars += guitarCount - 2;
  }
  if (leadGuitars > 0) add(heavy ? 'electric-guitar-lead' : 'electric-guitar-clean', 'lead-guitar', heavy ? 'hook' : 'counter-melody', Math.min(2, leadGuitars));

  // A couple of colour instruments without any rhythm section ("…with strings") add to the genre's
  // band; a full list ("drums, bass, two guitars…") or a solo/duet/ballad request replaces it.
  // Generic rhythm-section words describe a line-up; idiomatic flavour instruments ("with 808s",
  // "with log drums", "with brushes") swap into the genre's band instead.
  const RHYTHM_SECTION: InstKey[] = [
    'drums', 'electronic-kit', 'bass', 'synth-bass', 'upright-bass', 'guitar', 'rhythm-guitar', 'acoustic-guitar', 'distorted-guitar', 'clean-guitar', 'electric-guitar',
  ];
  const explicitOnly = /\b(?:solo|only|just|duet|trio|quartet|ballad|a\s+cappella|acapella|unaccompanied|minimal|stripped)\b/.test(lower);
  const additive =
    items.length > 0 &&
    !explicitOnly &&
    mentions.filter((m) => m.key !== 'backing-vocal' && m.key !== 'choir').length <= 2 &&
    !mentions.some((m) => RHYTHM_SECTION.includes(m.key) || m.key === 'piano' || m.key === 'keys' || m.key === 'electric-piano');
  if (items.length === 0 || additive) {
    const fromGenre = instrumentationFromGenre(genre, rng('instruments'), hasVocal);
    const base = fromGenre.map((t) => ({ instrumentId: t.instrumentId, role: t.role, ...(t.function ? { function: t.function } : {}) }) as Item);
    for (const it of items) {
      if (base.some((b) => b.instrumentId === it.instrumentId)) continue;
      // A named bass or kit replaces the genre's own.
      if (it.role === 'bass' || it.role === 'drums') {
        const i = base.findIndex((b) => b.role === it.role);
        if (i >= 0) {
          base.splice(i, 1, it);
          continue;
        }
      }
      base.push(it);
    }
    items = base;
  } else if (hasVocal && !items.some((i) => i.instrumentId === 'lead-vocal')) {
    items.unshift({ instrumentId: 'lead-vocal', role: 'vocal', function: 'melody' });
  }
  items = items.filter((i) => hasVocal || i.instrumentId !== 'lead-vocal');

  // Functions that depend on the line-up: cello is the bass when nothing else is; solo strings/winds
  // carry the melody in instrumental pieces; otherwise they answer the vocal.
  const hasBass = items.some((i) => i.role === 'bass' || i.function === 'bass-line');
  const band = items.some((i) => i.role === 'drums' || i.role === 'rhythm-guitar');
  for (const it of items) {
    if (it.function) continue;
    if (it.instrumentId === 'cello') it.function = hasBass ? 'counter-melody' : 'bass-line';
    else if (it.instrumentId === 'violin') it.function = 'counter-melody';
  }
  if (!hasVocal && !items.some((i) => i.function === 'melody')) {
    const order = ['violin', 'flute', 'saxophone', 'trumpet', 'synth-lead', 'electric-guitar-lead', 'clarinet', 'french-horn', 'cello', 'electric-guitar-clean', 'piano', 'electric-piano', 'marimba'];
    for (const id of order) {
      const it = items.find((i) => i.instrumentId === id && (i.role !== 'keys' || !band || items.length <= 2));
      if (it) {
        it.function = 'melody';
        break;
      }
    }
  }
  const instrumentation = nameBlueprintTracks(items);

  // --- Structure ----------------------------------------------------------------------------
  let structure: BlueprintSection[];
  const SECTION_TOKEN = '(?:intro|verse|pre-?chorus|post-?chorus|chorus|bridge|outro|solo|breakdown|drop|build(?:-?up)?|interlude|hook|final\\s+chorus)';
  const seqRe = new RegExp(`\\b(${SECTION_TOKEN}(?:\\s*(?:[-/>,|→]|then|and)\\s*${SECTION_TOKEN}){2,})\\b`);
  const seq = seqRe.exec(lower);
  if (seq) {
    const parts = seq[1].split(/\s*(?:[-/>,|→]|then|and)\s*/).filter(Boolean);
    const kinds: SectionKind[] = [];
    for (let i = 0; i < parts.length; i++) {
      const pw = parts[i].replace(/\s+/g, ' ');
      if (pw === 'pre' && parts[i + 1]?.startsWith('chorus')) {
        kinds.push('pre-chorus');
        i++;
        continue;
      }
      if (/^final chorus/.test(pw)) kinds.push('final-chorus');
      else {
        const k = sectionKindsForWord(pw.replace(/\s/g, '-'))?.[0] ?? sectionKindsForWord(pw)?.[0];
        if (k) kinds.push(k);
      }
    }
    const chorusIdx = kinds.map((k, i) => (k === 'chorus' ? i : -1)).filter((i) => i >= 0);
    if (chorusIdx.length >= 2 && !kinds.includes('final-chorus')) kinds[chorusIdx[chorusIdx.length - 1]] = 'final-chorus';
    structure = nameSections(kinds.map((kind) => ({ kind, bars: DEFAULT_BARS[kind] })));
  } else {
    structure = structureFromTemplate(genre, rng('structure'));
  }
  // Length hints.
  const beatsPerBar = meter.numerator * (4 / meter.denominator);
  let targetSeconds: number | null = null;
  const mmss = /\b(\d{1,2}):(\d{2})\b/.exec(lower);
  const mins = /\b(\d+(?:\.\d+)?)\s*(?:-\s*)?(?:min(?:ute)?s?)\b/.exec(lower);
  const secs = /\b(\d{2,3})\s*(?:s|sec|secs|seconds)\b/.exec(lower);
  if (mmss) targetSeconds = parseInt(mmss[1], 10) * 60 + parseInt(mmss[2], 10);
  else if (mins) targetSeconds = parseFloat(mins[1]) * 60;
  else if (secs) targetSeconds = parseInt(secs[1], 10);
  if (targetSeconds !== null && targetSeconds > 5) {
    structure = fitStructure(structure, Math.max(4, Math.round((targetSeconds * tempo) / 60 / beatsPerBar)));
  } else if (/\b(?:short|brief|quick\s+song|tiny|sketch|snippet)\b/.test(lower)) {
    structure = fitStructure(structure, Math.round(totalBars(structure) * 0.6));
  } else if (/\b(?:long|extended|epic[\s-]length|lengthy)\b/.test(lower)) {
    structure = fitStructure(structure, Math.round(totalBars(structure) * 1.4));
  }

  // --- Moods & energy per section ----------------------------------------------------------------
  const energyShift = clamp(moods.globalEnergy, -1.5, 1.5) * 8;
  structure = structure.map((s) => {
    const sm = moods.bySection.get(s.kind);
    const mood = sm && sm.length ? sm.map((m) => m.mood) : moods.global.map((m) => m.mood);
    const out: BlueprintSection = { ...s };
    if (mood.length) out.mood = [...new Set(mood)];
    const e = moods.energyBySection.get(s.kind);
    if (e !== undefined) {
      const base = energyFor(genre, s.kind) + energyShift;
      out.energy = Math.round(clamp(e > 0 ? Math.max(base + 10 * e, s.kind === 'chorus' || s.kind === 'final-chorus' ? 94 : base + 12) : base + 14 * e, 8, 100));
      if (s.kind === 'chorus' && e > 0) out.energy = Math.min(out.energy, 97);
    }
    const sectionArousal = sm && sm.length ? sm.reduce((t, m) => t + m.arousal, 0) / sm.length : null;
    if (out.energy === undefined && sectionArousal !== null) {
      out.energy = Math.round(clamp(energyFor(genre, s.kind) + energyShift + (sectionArousal - 0.5) * 18, 8, 100));
    }
    const feel = moods.feelBySection.get(s.kind);
    if (feel) out.feel = feel;
    return out;
  });
  // The final chorus is at least as big as the biggest chorus.
  const chorusMax = Math.max(0, ...structure.filter((s) => s.kind === 'chorus' && s.energy !== undefined).map((s) => s.energy!));
  structure = structure.map((s) => (s.kind === 'final-chorus' && s.energy === undefined && chorusMax > 0 ? { ...s, energy: Math.min(100, chorusMax + 4) } : s));
  structure = shapeEnergies(structure, genre, energyShift);

  // --- Macros ---------------------------------------------------------------------------------
  const macros: MacroSettings = { ...defaultMacros(), ...(baseGenre.macros ?? {}) };
  const allMoodWords = moods.mentions;
  const arousal = allMoodWords.length ? allMoodWords.reduce((t, m) => t + m.arousal, 0) / allMoodWords.length : null;
  if (arousal !== null) macros.energy = clamp01(lerp(macros.energy, arousal, 0.5));
  if (moods.globalEnergy) macros.energy = clamp01(macros.energy + moods.globalEnergy * 0.12);
  const setIf = (re: RegExp, k: keyof MacroSettings, v: number) => {
    if (re.test(lower)) macros[k] = v;
  };
  setIf(/\b(?:complex|intricate|technical|virtuosic|progressive)\b/, 'complexity', 0.82);
  setIf(/\b(?:simple|minimal|minimalist|basic|easy)\b/, 'complexity', 0.22);
  setIf(/\b(?:busy|dense|packed)\b/, 'density', 0.82);
  setIf(/\b(?:sparse|minimal|minimalist|stripped|stripped-down)\b/, 'density', 0.25);
  setIf(/\b(?:loose|human|live\s+feel|organic|sloppy)\b/, 'humanization', 0.62);
  setIf(/\b(?:tight|quantized|robotic|mechanical|precise)\b/, 'humanization', 0.08);
  setIf(/\b(?:syncopated|funky|groovy|bouncy)\b/, 'syncopation', 0.72);
  setIf(/\bstraight\b/, 'syncopation', 0.15);
  setIf(/\b(?:dissonant|jazzy|tense|unsettling|chromatic)\b/, 'harmonicTension', 0.68);
  setIf(/\b(?:consonant|simple\s+harmony|simple\s+chords)\b/, 'harmonicTension', 0.15);
  setIf(/\b(?:dynamic|expressive)\b/, 'dynamics', 0.78);
  setIf(/\b(?:flat\s+dynamics|compressed|steady)\b/, 'dynamics', 0.25);
  setIf(/\b(?:repetitive|hypnotic|loop(?:ed|ing)?)\b/, 'repetition', 0.15);
  setIf(/\b(?:varied|evolving|unpredictable)\b/, 'repetition', 0.82);
  setIf(/\b(?:melodic|soaring\s+melod(?:y|ies)|active\s+melod(?:y|ies))\b/, 'melodicMovement', 0.7);
  setIf(/\b(?:monotone|static\s+melod(?:y|ies)|chant(?:ed|ing)?)\b/, 'melodicMovement', 0.2);
  if (allMoodWords.some((m) => m.mood === 'dreamy' || m.mood === 'ethereal')) macros.density = Math.min(macros.density, 0.42);
  if (allMoodWords.some((m) => m.mood === 'tense' || m.mood === 'mysterious' || m.mood === 'haunting')) macros.harmonicTension = Math.max(macros.harmonicTension, 0.5);
  if (allMoodWords.some((m) => m.mood === 'epic' || m.mood === 'cathartic')) macros.dynamics = Math.max(macros.dynamics, 0.68);
  if (/\bshuffle|swung|swing\s+feel\b/.test(lower)) macros.syncopation = Math.max(macros.syncopation, 0.55);

  // --- Title & theme ----------------------------------------------------------------------------
  let title = 'Untitled';
  const quoted = /\b(?:called|titled|named|entitled)\s+["“'‘]([^"”'’]+)["”'’]/i.exec(text);
  const bare = /\b(?:called|titled|named|entitled)\s+([^.,;!?"“”]+?)(?=[.,;!?]|$|\s(?:with|in|about|at|that|and|featuring|for)\b)/i.exec(text);
  if (quoted) title = quoted[1].trim();
  else if (bare) title = titleCase(bare[1]);
  const theme = /\babout\s+([^.,;!?]+)/i.exec(text);

  const sectionMoodStatements = moods.statements;
  const bp: Blueprint = {
    title,
    prompt: text,
    tempo,
    meter,
    key,
    styles,
    genreBlend: blend,
    moods: sectionMoodStatements,
    instrumentation,
    structure,
    macros,
    seed,
  };
  if (hasVocal && voiceType) {
    const desc = `${male ? 'Male ' : female ? 'Female ' : ''}${voiceType}`;
    bp.vocal = { voiceType, mode: 'melody-only', description: desc.charAt(0).toUpperCase() + desc.slice(1) };
  }
  if (theme) bp.lyricsTheme = theme[1].trim().slice(0, 120);
  if (tagIds.length) bp.tags = tagIds;
  return bp;
}
