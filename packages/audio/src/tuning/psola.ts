/**
 * Time-varying pitch shifting of monophonic audio by TD-PSOLA (pitch-synchronous overlap-add,
 * Moulines & Charpentier 1990), as used for pitch correction.
 *
 * Analysis marks are placed one period apart through voiced regions (each period aligned to the
 * previous one by normalised cross-correlation, so marks follow the true period rather than the
 * pitch estimate) and at a short fixed spacing elsewhere. Synthesis marks are re-spaced by
 * `period / ratio`; each takes the nearest analysis grain (two periods, asymmetric Hann window)
 * and overlap-adds it. Duration and formants are preserved; unvoiced sound passes unchanged. With
 * every ratio 1 the output reproduces the input exactly (the windows sum to one).
 */

export interface PitchMarks {
  /** Analysis mark positions (samples), strictly increasing, from 0 to past the end. */
  marks: Int32Array;
  /** 1 where the mark is in a voiced (pitched) region. */
  voiced: Uint8Array;
}

/** Contour of a pitch track at the signal rate: f0 (Hz, 0 = unvoiced) per frame of `hopSeconds`. */
export interface PitchContour {
  /** Frame `i` is centred at `i * hopSeconds`. */
  hopSeconds: number;
  f0: ArrayLike<number>;
}

/** Spacing of the marks in unvoiced regions (5 ms keeps transients sharp). */
const UNVOICED_SECONDS = 0.005;

function f0At(c: PitchContour, sample: number, sr: number): number {
  const i = Math.round(sample / sr / c.hopSeconds);
  return i >= 0 && i < c.f0.length ? c.f0[i] : 0;
}

/** Voiced regions of the contour as sample ranges [start, end). */
function voicedRegions(c: PitchContour, sr: number, n: number): [number, number][] {
  const out: [number, number][] = [];
  const hop = c.hopSeconds * sr;
  let i = 0;
  while (i < c.f0.length) {
    if (!(c.f0[i] > 0)) {
      i++;
      continue;
    }
    let j = i;
    while (j < c.f0.length && c.f0[j] > 0) j++;
    const a = Math.max(0, Math.round((i - 0.5) * hop));
    const b = Math.min(n, Math.round((j - 0.5) * hop));
    if (b - a > 0) out.push([a, b]);
    i = j;
  }
  return out;
}

/** Offset in [-range, range] that best aligns the window at `cand` with the one at `ref`. */
function alignPeriod(x: Float32Array, ref: number, cand: number, half: number, range: number): number {
  const n = x.length;
  let best = 0;
  let bestScore = -Infinity;
  for (let d = -range; d <= range; d++) {
    let dot = 0;
    let energy = 0;
    const c = cand + d;
    for (let t = -half; t < half; t++) {
      const i = ref + t;
      const j = c + t;
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      const v = x[j];
      dot += x[i] * v;
      energy += v * v;
    }
    const score = energy > 1e-12 ? dot / Math.sqrt(energy) : -Infinity;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Pitch-synchronous analysis marks for a mono signal and its pitch contour. */
export function pitchMarks(x: Float32Array, sr: number, contour: PitchContour): PitchMarks {
  const n = x.length;
  const step = Math.max(8, Math.round(UNVOICED_SECONDS * sr));
  const marks: number[] = [0];
  const voiced: number[] = [0];
  const fillTo = (target: number) => {
    // evenly spaced unvoiced marks from the last mark up to (not including) `target`
    const last = marks[marks.length - 1];
    const gap = target - last;
    if (gap <= 0) return;
    const count = Math.max(1, Math.round(gap / step));
    const spacing = gap / count;
    for (let k = 1; k < count; k++) {
      const m = Math.round(last + k * spacing);
      if (m > marks[marks.length - 1]) {
        marks.push(m);
        voiced.push(0);
      }
    }
  };
  for (const [a, b] of voicedRegions(contour, sr, n)) {
    const f = f0At(contour, a + 0.5 * contour.hopSeconds * sr, sr) || f0At(contour, a, sr);
    if (!(f > 0)) continue;
    let period = sr / f;
    // first mark: the strongest positive peak in the region's first period
    let first = a;
    let peak = -Infinity;
    for (let i = a; i < Math.min(b, a + Math.ceil(period)); i++) {
      if (x[i] > peak) {
        peak = x[i];
        first = i;
      }
    }
    if (first <= marks[marks.length - 1] + step / 2) continue;
    fillTo(first);
    marks.push(first);
    voiced.push(1);
    let m = first;
    while (true) {
      const fm = f0At(contour, m, sr);
      if (fm > 0) period = sr / fm;
      const pred = m + period;
      if (pred >= b) break;
      const half = Math.max(4, Math.min(256, Math.round(period / 2)));
      const range = Math.max(1, Math.min(48, Math.round(period / 8)));
      const next = Math.round(pred) + alignPeriod(x, m, Math.round(pred), half, range);
      if (next <= m + period / 2 || next >= n) break;
      marks.push(next);
      voiced.push(1);
      m = next;
    }
  }
  // unvoiced marks to past the end, so every sample is covered
  fillTo(n + step);
  marks.push(Math.max(n + step, marks[marks.length - 1] + 1));
  voiced.push(0);
  return { marks: Int32Array.from(marks), voiced: Uint8Array.from(voiced) };
}

/**
 * Overlap-add resynthesis with pitch ratios (2^(semitones/12)) given per sample position by
 * `ratioAt`. Every channel uses the same marks, so the stereo image stays intact.
 */
export function psolaResynthesize(
  channels: Float32Array[],
  { marks, voiced }: PitchMarks,
  ratioAt: (sample: number) => number,
): Float32Array[] {
  const n = channels[0]?.length ?? 0;
  const out = channels.map(() => new Float32Array(n));
  const M = marks.length;
  if (!n || M < 2) return channels.map((c) => Float32Array.from(c));
  const spacingAfter = (k: number) => (k + 1 < M ? marks[k + 1] - marks[k] : marks[k] - marks[k - 1]);
  let s = marks[0];
  let k = 0;
  // the last mark lies past the end: grains placed beyond `n` still contribute their left halves
  while (s < marks[M - 1]) {
    while (k + 1 < M && marks[k + 1] <= s) k++;
    // nearest analysis mark to the synthesis position
    const kk = k + 1 < M && marks[k + 1] - s < s - marks[k] ? k + 1 : k;
    const r0 = voiced[kk] ? ratioAt(s) : 1;
    const ratio = Number.isFinite(r0) && r0 > 0 ? Math.max(0.25, Math.min(4, r0)) : 1;
    const left = kk > 0 ? marks[kk] - marks[kk - 1] : spacingAfter(kk);
    const right = spacingAfter(kk);
    const gain = ratio === 1 ? 1 : Math.max(0.5, Math.min(2, 1 / ratio));
    const centre = Math.round(s);
    const src = marks[kk];
    const t0 = Math.max(-left, -centre, -src);
    const t1 = Math.min(right, n - centre, n - src);
    for (let c = 0; c < channels.length; c++) {
      const x = channels[c];
      const y = out[c];
      for (let t = t0; t < t1; t++) {
        const w =
          t < 0 ? 0.5 + 0.5 * Math.cos((Math.PI * t) / left) : 0.5 + 0.5 * Math.cos((Math.PI * t) / right);
        y[centre + t] += gain * w * x[src + t];
      }
    }
    const period = k + 1 < M ? marks[k + 1] - marks[k] : spacingAfter(k);
    s += Math.max(1, period / ratio);
  }
  return out;
}
