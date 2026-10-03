/**
 * Offline mood reading of lyrics: a small valence/arousal word lexicon (with negation and
 * intensifiers) averaged over the text, then matched to mood tags from the tag catalog. Only tag
 * ids the catalog actually resolves (`getTag`) are suggested, so this works whatever the catalog
 * contains. It never changes the words.
 */
import { getTag } from '../../composer/tags';

/** word → [valence −1..1, arousal 0..1] */
const LEXICON: Record<string, [number, number]> = {};
const add = (v: number, a: number, words: string) => {
  for (const w of words.split(/\s+/)) if (w) LEXICON[w] = [v, a];
};
// Sadness, loss, loneliness.
add(
  -0.75,
  0.3,
  'sad sorrow sorrows tears tear cry crying cried weep weeping grief grieve mourn mourning lonely alone loneliness empty emptiness gone goodbye goodbyes lost lose losing miss missing missed broken heartbreak heartbroken hollow cold colder grey gray rain raining ache aching hurt hurts hurting pain painful bleed bleeding wound wounds scar scars fade fading faded',
);
add(
  -0.55,
  0.22,
  'tired weary sleep sleepless shadow shadows dark darkness night nights ghost ghosts grave graves dust ashes silence silent quiet hollow nothing nowhere never forgotten forget regret regrets sorry',
);
// Anger, defiance, danger.
add(
  -0.6,
  0.88,
  'hate hatred anger angry rage raging fury furious fight fighting war burn burning fire scream screaming break breaking smash blood bloody kill killing enemy enemies revenge storm storms thunder violent',
);
add(
  0.1,
  0.85,
  'rebel rebels defy defiant rise rising stand unbroken unstoppable louder scream run running fast faster wild riot',
);
// Fear and tension.
add(
  -0.55,
  0.7,
  'fear afraid scared panic nervous anxious trapped chains chained cage caged drown drowning falling fall edge danger lie lies liar',
);
// Joy, celebration.
add(
  0.85,
  0.7,
  'happy happiness joy joyful smile smiling laugh laughing laughter dance dancing party celebrate sunshine sunny sun shine shining bright alive free freedom golden summer',
);
add(
  0.8,
  0.85,
  'jump fly flying high higher sky stars celebrate tonight euphoria euphoric glow glowing electric',
);
// Love, tenderness, warmth.
add(
  0.7,
  0.4,
  'love loving lover loved kiss kisses hold holding embrace tender sweet sweetheart darling baby honey heart hearts warm warmth home together forever gentle soft',
);
// Hope and comfort.
add(
  0.6,
  0.45,
  'hope hopeful faith believe dream dreams dreaming light morning dawn new begin beginning heal healing safe peace peaceful grace pray prayer',
);
// Calm, nature, stillness.
add(
  0.35,
  0.15,
  'calm still slow slowly breathe breathing ocean sea waves river breeze moon moonlight quietly rest float floating drift drifting',
);
// Nostalgia and memory.
add(
  -0.1,
  0.35,
  'remember memories memory yesterday old young younger used childhood photograph letters past back ago again',
);
// Desire, longing.
add(
  -0.25,
  0.6,
  'want wanting need needing long longing yearn yearning wish wishing waiting wait crave burning',
);

const NEGATIONS = new Set([
  'not',
  'no',
  'never',
  "don't",
  'dont',
  "can't",
  'cant',
  "won't",
  'wont',
  'without',
  'nothing',
  "ain't",
  'aint',
  "isn't",
  "wasn't",
]);
const INTENSIFIERS = new Set(['so', 'very', 'too', 'really', 'always', 'all', 'forever']);

/** Prototype moods in valence/arousal space (catalog ids or aliases; unresolvable ones are skipped). */
const MOOD_POINTS: { id: string; v: number; a: number }[] = [
  { id: 'melancholy', v: -0.6, a: 0.35 },
  { id: 'sad', v: -0.8, a: 0.25 },
  { id: 'heartbroken', v: -0.8, a: 0.45 },
  { id: 'lonely', v: -0.7, a: 0.3 },
  { id: 'somber', v: -0.7, a: 0.2 },
  { id: 'bittersweet', v: -0.1, a: 0.45 },
  { id: 'nostalgic', v: -0.1, a: 0.4 },
  { id: 'reflective', v: -0.3, a: 0.35 },
  { id: 'yearning', v: -0.45, a: 0.62 },
  { id: 'dark', v: -0.6, a: 0.5 },
  { id: 'brooding', v: -0.45, a: 0.4 },
  { id: 'haunting', v: -0.5, a: 0.42 },
  { id: 'tense', v: -0.4, a: 0.72 },
  { id: 'angry', v: -0.7, a: 0.9 },
  { id: 'aggressive', v: -0.4, a: 0.95 },
  { id: 'defiant', v: 0.1, a: 0.85 },
  { id: 'cathartic', v: 0.2, a: 0.9 },
  { id: 'intense', v: -0.1, a: 0.9 },
  { id: 'energetic', v: 0.5, a: 0.85 },
  { id: 'euphoric', v: 0.9, a: 0.95 },
  { id: 'triumphant', v: 0.8, a: 0.9 },
  { id: 'anthemic', v: 0.5, a: 0.9 },
  { id: 'uplifting', v: 0.8, a: 0.7 },
  { id: 'happy', v: 0.8, a: 0.65 },
  { id: 'joyful', v: 0.9, a: 0.7 },
  { id: 'playful', v: 0.7, a: 0.6 },
  { id: 'hopeful', v: 0.6, a: 0.55 },
  { id: 'romantic', v: 0.55, a: 0.4 },
  { id: 'warm', v: 0.55, a: 0.35 },
  { id: 'tender', v: 0.45, a: 0.25 },
  { id: 'sensual', v: 0.4, a: 0.45 },
  { id: 'dreamy', v: 0.3, a: 0.25 },
  { id: 'peaceful', v: 0.4, a: 0.15 },
  { id: 'calm', v: 0.35, a: 0.15 },
  { id: 'chill', v: 0.3, a: 0.2 },
];

export interface LyricMoodReading {
  /** −1 (negative) .. 1 (positive). */
  valence: number;
  /** 0 (calm) .. 1 (agitated). */
  arousal: number;
  /** How many lexicon words were found (0 = no signal). */
  evidence: number;
  /** Suggested mood tag ids (resolvable in the tag catalog), best first. */
  moods: string[];
  /** Suggested tempo feel from the arousal. */
  tempoFeel: 'slow' | 'mid' | 'fast';
  /** Words that drove the reading, most frequent first (for "why"). */
  keywords: string[];
}

/**
 * Read the mood of lyrics offline. `max` caps the number of suggested tags. With no lexicon words,
 * the reading is neutral and suggests nothing.
 */
export function suggestMoodsFromLyrics(text: string, max = 3): LyricMoodReading {
  const words = (text ?? '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .split(/[^a-z']+/)
    .filter(Boolean);
  let v = 0;
  let a = 0;
  let n = 0;
  const hits = new Map<string, number>();
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/'s$/, '');
    const e = LEXICON[w];
    if (!e) continue;
    const negated = [words[i - 1], words[i - 2]].some((p) => p && NEGATIONS.has(p));
    const weight = words[i - 1] && INTENSIFIERS.has(words[i - 1]) ? 1.5 : 1;
    v += (negated ? -e[0] * 0.6 : e[0]) * weight;
    a += e[1] * weight;
    n += weight;
    hits.set(w, (hits.get(w) ?? 0) + 1);
  }
  const keywords = [...hits.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([w]) => w)
    .slice(0, 8);
  if (!n) return { valence: 0, arousal: 0.5, evidence: 0, moods: [], tempoFeel: 'mid', keywords };
  const valence = Math.max(-1, Math.min(1, v / n));
  const arousal = Math.max(0, Math.min(1, a / n));
  const ranked = MOOD_POINTS.map((p) => ({ p, d: Math.hypot((p.v - valence) * 0.8, p.a - arousal) })).sort(
    (x, y) => x.d - y.d || x.p.id.localeCompare(y.p.id),
  );
  const moods: string[] = [];
  for (const { p, d } of ranked) {
    // Only moods close to the reading: a far-off tag is no suggestion even if it is the only one.
    if (d > 0.42) break;
    const tag = getTag(p.id);
    if (!tag || tag.kind !== 'mood' || moods.includes(tag.id)) continue;
    moods.push(tag.id);
    if (moods.length >= max) break;
  }
  return {
    valence,
    arousal,
    evidence: n,
    moods,
    tempoFeel: arousal < 0.35 ? 'slow' : arousal > 0.65 ? 'fast' : 'mid',
    keywords,
  };
}
