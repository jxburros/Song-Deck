import type {
  Articulation,
  AutomationParam,
  IssueSeverity,
  MacroSettings,
  ModeName,
  MusicalFunction,
  Note,
  SectionFeel,
  SectionKind,
  Song,
  TrackRole,
  ValidationIssue,
  ValidationReport,
} from '../ir/types';
import type { IdFactory } from '../util/ids';
import { randomId } from '../util/ids';
import { sectionLayout, tickToBar, songLengthBars, type SectionSpan } from '../timing';

// ---------------------------------------------------------------------------
// Runtime enumerations of IR string unions (used to validate untrusted model output)
// ---------------------------------------------------------------------------

export const TRACK_ROLES: readonly TrackRole[] = [
  'drums', 'percussion', 'bass', 'rhythm-guitar', 'lead-guitar', 'keys', 'strings', 'synth-pad', 'synth-arp', 'synth-lead', 'synth-seq', 'vocal', 'custom',
];

export const SECTION_KINDS: readonly SectionKind[] = [
  'intro', 'verse', 'pre-chorus', 'chorus', 'post-chorus', 'bridge', 'breakdown', 'build', 'drop', 'solo', 'interlude', 'final-chorus', 'outro', 'custom',
];

export const SECTION_FEELS: readonly SectionFeel[] = ['normal', 'half-time', 'double-time'];

export const ARTICULATIONS: readonly Articulation[] = [
  'normal', 'staccato', 'legato', 'accent', 'marcato', 'tenuto', 'palm-mute', 'pizzicato', 'tremolo', 'ghost', 'slide', 'bend', 'harmonic', 'dead',
];

export const MUSICAL_FUNCTIONS: readonly MusicalFunction[] = [
  'melody', 'counter-melody', 'harmony', 'accompaniment', 'bass-line', 'rhythm', 'pad', 'hook', 'fills', 'solo', 'texture',
];

export const MODE_NAMES: readonly ModeName[] = [
  'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'harmonic-minor', 'melodic-minor',
];

export const AUTOMATION_PARAMS: readonly AutomationParam[] = [
  'volumeDb', 'pan', 'reverbSend', 'delaySend', 'width', 'drive', 'eq.lowShelfDb', 'eq.lowMidDb', 'eq.highMidDb', 'eq.highShelfDb', 'eq.lowpassHz', 'eq.highpassHz',
];

export const MACRO_KEYS: readonly (keyof MacroSettings)[] = [
  'complexity', 'energy', 'density', 'humanization', 'melodicMovement', 'harmonicTension', 'repetition', 'syncopation', 'dynamics',
];

export const VALID_DENOMINATORS = [1, 2, 4, 8, 16, 32] as const;

// ---------------------------------------------------------------------------
// Issue collection
// ---------------------------------------------------------------------------

/** Per (code, track) cap so a badly broken import does not produce tens of thousands of issues. */
const DEFAULT_CAP = 40;

export class IssueList {
  readonly issues: ValidationIssue[] = [];
  private counts = new Map<string, number>();
  private overflow = new Map<string, { issue: ValidationIssue; extra: number }>();

  constructor(private readonly cap = DEFAULT_CAP) {}

  add(issue: ValidationIssue): void {
    const key = `${issue.code}|${issue.trackId ?? ''}|${issue.opIndex ?? ''}|${issue.fixed ? 1 : 0}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (n <= this.cap) {
      this.issues.push(issue);
      return;
    }
    const o = this.overflow.get(key);
    if (o) o.extra++;
    else this.overflow.set(key, { issue, extra: 1 });
  }

  push(severity: IssueSeverity, code: string, message: string, extra: Partial<ValidationIssue> = {}): void {
    this.add({ severity, code, message, ...extra });
  }

  error(code: string, message: string, extra: Partial<ValidationIssue> = {}): void {
    this.push('error', code, message, extra);
  }

  warn(code: string, message: string, extra: Partial<ValidationIssue> = {}): void {
    this.push('warning', code, message, extra);
  }

  info(code: string, message: string, extra: Partial<ValidationIssue> = {}): void {
    this.push('info', code, message, extra);
  }

  addAll(issues: readonly ValidationIssue[]): void {
    for (const i of issues) this.add(i);
  }

  /** Final list (with "…and N more" summary entries for capped codes). */
  list(): ValidationIssue[] {
    const out = this.issues.slice();
    for (const { issue, extra } of this.overflow.values()) {
      out.push({
        severity: issue.severity,
        code: issue.code,
        message: `…and ${extra} more "${issue.code}" issue${extra === 1 ? '' : 's'}`,
        trackId: issue.trackId,
        opIndex: issue.opIndex,
        fixed: issue.fixed,
      });
    }
    return out;
  }

  report(): ValidationReport {
    return makeReport(this.list());
  }
}

export function makeReport(issues: ValidationIssue[]): ValidationReport {
  return { ok: !issues.some((i) => i.severity === 'error' && !i.fixed), issues };
}

/** Merge reports, dropping exact duplicates. */
export function mergeReports(...reports: (ValidationReport | undefined)[]): ValidationReport {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const r of reports) {
    if (!r) continue;
    for (const i of r.issues) {
      const key = `${i.severity}|${i.code}|${i.message}|${i.trackId ?? ''}|${i.noteId ?? ''}|${i.sectionId ?? ''}|${i.opIndex ?? ''}|${i.fixed ? 1 : 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(i);
    }
  }
  return makeReport(issues);
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Every id used anywhere in a song (to keep newly allocated ids unique). */
export function collectIds(song: Song): Set<string> {
  const ids = new Set<string>([song.id]);
  for (const s of song.sections ?? []) ids.add(s.id);
  for (const c of song.chords ?? []) ids.add(c.id);
  for (const t of song.tracks ?? []) {
    ids.add(t.id);
    for (const n of t.notes ?? []) ids.add(n.id);
    for (const c of t.clips ?? []) ids.add(c.id);
  }
  for (const m of song.motifs ?? []) ids.add(m.id);
  for (const p of song.phrases ?? []) ids.add(p.id);
  for (const l of song.lyrics ?? []) ids.add(l.id);
  for (const a of song.automation ?? []) ids.add(a.id);
  return ids;
}

/** Allocates ids that are unique within a song; deterministic when an `IdFactory` is supplied. */
export class IdAllocator {
  private readonly used: Set<string>;

  constructor(
    song: Song,
    private readonly factory?: IdFactory,
  ) {
    this.used = collectIds(song);
  }

  next(prefix: string): string {
    for (let i = 0; i < 1000; i++) {
      const id = this.factory ? this.factory.next(prefix) : randomId(prefix);
      if (!this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
    // Practically unreachable; fall back to a random id with a counter suffix.
    let n = this.used.size;
    let id = `${prefix}_${n}`;
    while (this.used.has(id)) id = `${prefix}_${++n}`;
    this.used.add(id);
    return id;
  }

  reserve(id: string): void {
    this.used.add(id);
  }
}

// ---------------------------------------------------------------------------
// Untrusted value parsing
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Finite number (numeric strings accepted), else undefined. */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function toInt(v: unknown): number | undefined {
  const n = toNumber(v);
  return n === undefined ? undefined : Math.round(n);
}

export function toStr(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

export function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

// ---------------------------------------------------------------------------
// Section-relative positions (lock comparisons survive structure edits)
// ---------------------------------------------------------------------------

/**
 * Maps absolute ticks to a section-relative position key `sectionId:barOffset:tickInBar`.
 * Material inside a section keeps the same key when other sections are inserted, removed,
 * moved or resized, so "locked material unchanged" can be verified across structure edits.
 */
export interface Placement {
  /** Section id containing the position, or "#end" past the last section. */
  sid: string;
  /** `sectionId:barOffset:tickInBar` */
  key: string;
}

export class SectionLocator {
  readonly spans: SectionSpan[];
  private readonly totalBars: number;
  private readonly cache = new Map<number, Placement>();

  constructor(private readonly song: Song) {
    this.spans = sectionLayout(song);
    this.totalBars = songLengthBars(song);
  }

  spanForBar(bar: number): SectionSpan | undefined {
    const spans = this.spans;
    let lo = 0;
    let hi = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = spans[mid];
      if (bar < s.startBar) hi = mid - 1;
      else if (bar >= s.endBar) lo = mid + 1;
      else return s.endBar > s.startBar ? s : undefined;
    }
    return undefined;
  }

  spanForTick(tick: number): SectionSpan | undefined {
    return this.spanForBar(tickToBar(this.song, tick).bar);
  }

  /** Section id containing `tick` (undefined past the end of the song). */
  sectionIdAt(tick: number): string | undefined {
    return this.spanForTick(tick)?.section.id;
  }

  place(tick: number): Placement {
    const cached = this.cache.get(tick);
    if (cached !== undefined) return cached;
    const pos = tickToBar(this.song, tick);
    const span = this.spanForBar(pos.bar);
    const placement: Placement = span
      ? { sid: span.section.id, key: `${span.section.id}:${pos.bar - span.startBar}:${pos.tickInBar}` }
      : { sid: '#end', key: `#end:${pos.bar - this.totalBars}:${pos.tickInBar}` };
    this.cache.set(tick, placement);
    return placement;
  }

  locate(tick: number): string {
    return this.place(tick).key;
  }

  locateBar(bar: number): string {
    const span = this.spanForBar(bar);
    return span ? `${span.section.id}:${bar - span.startBar}` : `#end:${bar - this.totalBars}`;
  }
}

/** Note content without its absolute position (for comparisons). */
export function noteContentKey(n: Note): string {
  let key = `${n.id}\u0001${n.pitch}\u0001${n.duration}\u0001${n.velocity}\u0001${n.articulation ?? ''}\u0001${n.syllable ?? ''}\u0001${n.lyricLineId ?? ''}\u0001${n.locked ? 1 : 0}\u0001${n.motifId ?? ''}\u0001${n.phraseId ?? ''}\u0001${n.confidence ?? ''}\u0001${n.origin ?? ''}`;
  if (n.phonemes) key += `\u0001p${n.phonemes.join(' ')}`;
  if (n.expression) key += `\u0001e${JSON.stringify(sortedEntries(n.expression))}`;
  return key;
}

function sortedEntries(o: object): [string, unknown][] {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Multiset equality of string keys. */
export function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const k of a) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const k of b) {
    const c = counts.get(k);
    if (!c) return false;
    if (c === 1) counts.delete(k);
    else counts.set(k, c - 1);
  }
  return counts.size === 0;
}

/** Rough English syllable count (vowel groups) — used only for warning-level lyric checks. */
export function estimateSyllables(text: string): number {
  let total = 0;
  for (const raw of text.toLowerCase().split(/[^a-z']+/)) {
    const w = raw.replace(/'/g, '');
    if (!w) continue;
    const groups = w.match(/[aeiouy]+/g)?.length ?? 0;
    let n = groups;
    if (w.length > 2 && w.endsWith('e') && !w.endsWith('le') && !w.endsWith('ee') && groups > 1) n--;
    if (/[^aeiouy]ed$/.test(w) && !/[td]ed$/.test(w) && groups > 1) n--;
    total += Math.max(1, n);
  }
  return total;
}

/** 1-based "bars a–b" label for a tick range. */
export function barsLabel(song: Song, startTick: number, endTick: number): string {
  const a = tickToBar(song, startTick).bar + 1;
  const b = tickToBar(song, Math.max(startTick, endTick - 1)).bar + 1;
  return a === b ? `bar ${a}` : `bars ${a}–${b}`;
}
