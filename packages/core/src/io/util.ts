import type { KeySignature, ModeName, SectionKind, Song, Track } from '../ir/types';
import { keyPrefersFlats, mod12 } from '../theory/pitch';
import { isMinorMode } from '../theory/scales';

/** Semitones from a mode's parent major (Ionian) tonic to the mode's tonic. */
const MODE_PARENT_OFFSET: Record<ModeName, number> = {
  major: 0,
  dorian: 2,
  phrygian: 4,
  lydian: 5,
  mixolydian: 7,
  minor: 9,
  'harmonic-minor': 9,
  'melodic-minor': 9,
  locrian: 11,
};

/** Major-key pitch class → number of sharps (positive) for the circle of fifths. */
const SHARP_FIFTHS: Record<number, number> = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: 7 };
const FLAT_FIFTHS: Record<number, number> = { 0: 0, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5, 6: -6, 11: -7 };

/** Key signature accidentals (−7…+7) for a key, as used by MIDI (FF 59) and MusicXML <fifths>. */
export function keyFifths(key: KeySignature): number {
  const parent = mod12(key.tonic - MODE_PARENT_OFFSET[key.mode]);
  const flats = keyPrefersFlats(key);
  if (flats && FLAT_FIFTHS[parent] !== undefined) return FLAT_FIFTHS[parent];
  if (SHARP_FIFTHS[parent] !== undefined) return SHARP_FIFTHS[parent];
  return FLAT_FIFTHS[parent] ?? 0;
}

/** MIDI key signature (sharps/flats + minor flag) → key. */
export function keyFromFifths(fifths: number, minor: boolean): KeySignature {
  const f = Math.max(-7, Math.min(7, Math.round(fifths)));
  const majorTonic = mod12(f * 7);
  return minor ? { tonic: mod12(majorTonic + 9), mode: 'minor' } : { tonic: majorTonic, mode: 'major' };
}

export function isMinorKey(key: KeySignature): boolean {
  return isMinorMode(key.mode);
}

export function xmlEscape(s: string): string {
  return (
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // Strip characters that are not allowed in XML 1.0.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  );
}

/** File-system friendly slug: "Lead Vocal #2" → "lead-vocal-2". */
export function slugify(s: string, fallback = 'item'): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

/** Make names unique by appending -2, -3… */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    let name = n;
    for (let i = 2; used.has(name); i++) name = `${n}-${i}`;
    used.add(name);
    return name;
  });
}

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined;

export function utf8(s: string): Uint8Array {
  if (encoder) return encoder.encode(s);
  const out: number[] = [];
  for (const ch of s) {
    let cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else {
      cp = Math.min(cp, 0x10ffff);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
  }
  return Uint8Array.from(out);
}

/** Decode UTF-8, falling back to Latin-1 for legacy MIDI text. */
export function decodeText(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      /* fall through to Latin-1 */
    }
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const KIND_PATTERNS: [RegExp, SectionKind][] = [
  [/pre.?chorus/i, 'pre-chorus'],
  [/post.?chorus/i, 'post-chorus'],
  [/(final|last).?chorus/i, 'final-chorus'],
  [/chorus|refrain|hook/i, 'chorus'],
  [/verse|strophe/i, 'verse'],
  [/bridge|middle.?8/i, 'bridge'],
  [/intro/i, 'intro'],
  [/outro|coda|ending|^end$/i, 'outro'],
  [/breakdown/i, 'breakdown'],
  [/build/i, 'build'],
  [/drop/i, 'drop'],
  [/solo/i, 'solo'],
  [/interlude|instrumental/i, 'interlude'],
];

/** Guess a section kind from a marker / section name. */
export function inferSectionKind(name: string): SectionKind {
  for (const [re, kind] of KIND_PATTERNS) if (re.test(name)) return kind;
  return 'custom';
}

/** Vocal melody track used for lyrics/lead sheets: explicit, else first vocal-role track with notes. */
export function leadTrack(song: Song, trackId?: string): Track | undefined {
  if (trackId) return song.tracks.find((t) => t.id === trackId);
  const midi = song.tracks.filter((t) => t.kind === 'midi');
  return (
    midi.find((t) => t.role === 'vocal' && t.notes.length > 0) ??
    midi.find(
      (t) =>
        (t.role === 'synth-lead' || t.role === 'lead-guitar' || t.constraints?.function === 'melody') &&
        t.notes.length > 0,
    ) ??
    midi.find(
      (t) => t.role !== 'drums' && t.role !== 'percussion' && t.midiChannel !== 9 && t.notes.length > 0,
    )
  );
}

/** Seconds formatted with fixed decimals (no exponent). */
export function fixed(n: number, digits = 3): string {
  return (Math.round(n * 10 ** digits) / 10 ** digits).toFixed(digits);
}
