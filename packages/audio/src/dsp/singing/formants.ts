/**
 * Vowel formant data (Hillenbrand et al. 1995 American English averages for men / women, F1–F3;
 * F4/F5 typical values) scaled per voice type, plus bandwidths.
 */
export type VowelKey = 'i' | 'I' | 'e' | 'E' | 'ae' | 'a' | 'O' | 'o' | 'U' | 'u' | 'V' | 'er';

const MEN: Record<VowelKey, [number, number, number]> = {
  i: [342, 2322, 3000],
  I: [427, 2034, 2684],
  e: [476, 2089, 2691],
  E: [580, 1799, 2605],
  ae: [588, 1952, 2601],
  a: [768, 1333, 2522],
  O: [652, 997, 2538],
  o: [497, 910, 2459],
  U: [469, 1122, 2434],
  u: [378, 997, 2343],
  V: [623, 1200, 2550],
  er: [474, 1379, 1710],
};

const WOMEN: Record<VowelKey, [number, number, number]> = {
  i: [437, 2761, 3372],
  I: [483, 2365, 3053],
  e: [536, 2530, 3047],
  E: [731, 2058, 2979],
  ae: [669, 2349, 2972],
  a: [936, 1551, 2815],
  O: [781, 1136, 2824],
  o: [555, 1035, 2828],
  U: [519, 1225, 2827],
  u: [459, 1105, 2735],
  V: [753, 1426, 2933],
  er: [523, 1588, 1929],
};

export const BANDWIDTHS_MALE = [70, 85, 130, 180, 250];
export const BANDWIDTHS_FEMALE = [80, 95, 145, 200, 280];

export type FormantBase = 'male' | 'female';

/** Writes F1..F5 (Hz) for a vowel into `out`. */
export function vowelFormants(
  v: VowelKey,
  base: FormantBase,
  scale: number,
  out: Float64Array,
  offset = 0,
): void {
  const t = base === 'male' ? MEN[v] : WOMEN[v];
  out[offset] = t[0] * scale;
  out[offset + 1] = t[1] * scale;
  out[offset + 2] = t[2] * scale;
  out[offset + 3] = (base === 'male' ? 3350 : 4100) * scale;
  out[offset + 4] = (base === 'male' ? 4250 : 4950) * scale;
}

/** Consonant locus formants (male reference) scaled to the voice. */
export function scaledLocus(
  f: [number, number, number],
  base: FormantBase,
  scale: number,
  out: Float64Array,
  offset = 0,
): void {
  const k = base === 'male' ? 1 : 1.15;
  out[offset] = f[0] * k * scale;
  out[offset + 1] = f[1] * k * scale;
  out[offset + 2] = f[2] * k * scale;
  out[offset + 3] = (base === 'male' ? 3350 : 4100) * scale;
  out[offset + 4] = (base === 'male' ? 4250 : 4950) * scale;
}
