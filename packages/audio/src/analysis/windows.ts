/** Analysis windows (cached). Periodic windows are the default: they are COLA-friendly for STFT. */

export type WindowType = 'hann' | 'hamming' | 'blackman' | 'rect' | 'sqrt-hann';

const cache = new Map<string, Float32Array>();

export function analysisWindow(type: WindowType, size: number, periodic = true): Float32Array {
  const key = `${type}:${size}:${periodic ? 'p' : 's'}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const w = new Float32Array(size);
  const denom = periodic ? size : Math.max(1, size - 1);
  for (let i = 0; i < size; i++) {
    const x = (2 * Math.PI * i) / denom;
    switch (type) {
      case 'hann':
        w[i] = 0.5 - 0.5 * Math.cos(x);
        break;
      case 'sqrt-hann':
        w[i] = Math.sqrt(0.5 - 0.5 * Math.cos(x));
        break;
      case 'hamming':
        w[i] = 0.54 - 0.46 * Math.cos(x);
        break;
      case 'blackman':
        w[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
        break;
      default:
        w[i] = 1;
    }
  }
  if (cache.size > 64) cache.clear();
  cache.set(key, w);
  return w;
}

export function hannWindow(size: number, periodic = true): Float32Array {
  return analysisWindow('hann', size, periodic);
}

export function windowSum(w: Float32Array): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i];
  return s;
}
