import { hashSeed } from './random';

/**
 * Ids.
 *
 * - `randomId()` for user actions (non-deterministic).
 * - `IdFactory` for generators: ids are a pure function of (seed, scope, counter), so the
 *   same seed reproduces byte-identical songs, including ids (spec §23).
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function toBase36(n: number, width: number): string {
  let s = '';
  let v = n >>> 0;
  for (let i = 0; i < width; i++) {
    s = ALPHABET[v % 36] + s;
    v = Math.floor(v / 36);
  }
  return s;
}

export function randomId(prefix = 'id'): string {
  let a: number;
  let b: number;
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    a = buf[0];
    b = buf[1];
  } else {
    a = Math.floor(Math.random() * 0xffffffff);
    b = Math.floor(Math.random() * 0xffffffff);
  }
  return `${prefix}_${toBase36(a, 6)}${toBase36(b, 6)}`;
}

export class IdFactory {
  private counters = new Map<string, number>();

  constructor(
    private readonly seed: number,
    private readonly scope: string = 'g',
  ) {}

  /** Next deterministic id for a prefix, e.g. next('n') → "n_3k9x0a1b". */
  next(prefix: string): string {
    const c = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, c);
    const h = hashSeed(this.seed, this.scope, prefix, c);
    return `${prefix}_${toBase36(h, 6)}${toBase36(c, 3)}`;
  }

  /** A child factory with its own namespace (e.g. per track/section) so counters don't interact. */
  child(scope: string): IdFactory {
    return new IdFactory(this.seed, `${this.scope}/${scope}`);
  }
}
