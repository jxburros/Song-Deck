/**
 * Singers and their range zones. A `SingerProfile` describes a real voice as zones — sweet spot,
 * comfortable (easy), stretch (difficult but possible), falsetto / head voice only, out of range —
 * rather than two limits. Vocal tracks name their singer (`vocal.singerId`); the composer writes
 * inside the singer's zones, validation flags unreachable notes, and `checkSingerRange` reports
 * how a part sits in the voice and which key would suit the singer best.
 */
import type {
  KeySignature,
  MusicOperation,
  SingerProfile,
  Song,
  Track,
  VocalZone,
  VoiceType,
} from './ir/types';
import { createTimeMap, keyAtTick, songLengthBars, tickToBar } from './timing';
import { midiToNoteName, mod12, spellPitchClass } from './theory/pitch';
import { keyName } from './theory/scales';

export interface VocalZoneInfo {
  zone: VocalZone;
  label: string;
  short: string;
  description: string;
}

/** The zones from best to unreachable, with the words the studio uses for them. */
export const VOCAL_ZONES: readonly VocalZoneInfo[] = [
  {
    zone: 'sweet',
    label: 'Sweet spot',
    short: 'Sweet spot',
    description: 'Where the voice sounds best: ideal for the most important notes.',
  },
  {
    zone: 'comfortable',
    label: 'Easy',
    short: 'Easy',
    description: 'Comfortable to sing, sustain and repeat.',
  },
  {
    zone: 'stretch',
    label: 'Difficult but possible',
    short: 'Difficult',
    description: 'Reachable with effort: keep these notes short and rare.',
  },
  {
    zone: 'falsetto',
    label: 'Falsetto / head voice only',
    short: 'Falsetto',
    description: 'Only in a light falsetto or head voice, not in full voice.',
  },
  {
    zone: 'out',
    label: 'Out of range',
    short: 'Out of range',
    description: 'The singer cannot reach these notes.',
  },
];

export function vocalZoneInfo(zone: VocalZone): VocalZoneInfo {
  return VOCAL_ZONES.find((z) => z.zone === zone)!;
}

type Zones = Omit<SingerProfile, 'id' | 'name' | 'voiceType' | 'notes'>;

/**
 * Typical zones per voice type (popular singing): a starting point to adjust to the real singer.
 * Full-voice limits match the composer's voice ranges, so a preset singer composes like the voice
 * type it came from.
 */
export const VOICE_TYPE_ZONES: Record<VoiceType, Zones> = {
  soprano: { lowest: 60, comfortableLow: 62, sweetLow: 67, sweetHigh: 76, comfortableHigh: 79, highest: 84 },
  mezzo: { lowest: 57, comfortableLow: 59, sweetLow: 64, sweetHigh: 72, comfortableHigh: 76, highest: 81 },
  alto: { lowest: 53, comfortableLow: 55, sweetLow: 60, sweetHigh: 69, comfortableHigh: 72, highest: 74 },
  tenor: {
    lowest: 48,
    comfortableLow: 50,
    sweetLow: 55,
    sweetHigh: 65,
    comfortableHigh: 69,
    highest: 72,
    falsettoHigh: 77,
  },
  baritone: {
    lowest: 45,
    comfortableLow: 47,
    sweetLow: 50,
    sweetHigh: 60,
    comfortableHigh: 62,
    highest: 65,
    falsettoHigh: 72,
  },
  bass: {
    lowest: 40,
    comfortableLow: 43,
    sweetLow: 45,
    sweetHigh: 55,
    comfortableHigh: 60,
    highest: 64,
    falsettoHigh: 69,
  },
};

export const VOICE_TYPE_LABELS: Record<VoiceType, string> = {
  soprano: 'Soprano',
  mezzo: 'Mezzo-soprano',
  alto: 'Alto',
  tenor: 'Tenor',
  baritone: 'Baritone',
  bass: 'Bass',
};

/** A singer with the typical zones of a voice type. */
export function singerFromVoiceType(
  voiceType: VoiceType,
  opts: { id: string; name?: string },
): SingerProfile {
  return {
    id: opts.id,
    name: opts.name ?? VOICE_TYPE_LABELS[voiceType],
    voiceType,
    ...VOICE_TYPE_ZONES[voiceType],
  };
}

const pitchOf = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(127, Math.round(v))) : fallback;

/**
 * Valid zones: whole MIDI pitches in order (`lowest ≤ comfortableLow ≤ comfortableHigh ≤ highest`),
 * a sweet spot inside the comfortable zone (dropped when empty), falsetto only above `highest`.
 */
export function normalizeSinger(s: SingerProfile): SingerProfile {
  const [lowest, comfortableLow, comfortableHigh, highest] = [
    pitchOf(s.lowest, 48),
    pitchOf(s.comfortableLow, 50),
    pitchOf(s.comfortableHigh, 67),
    pitchOf(s.highest, 72),
  ].sort((a, b) => a - b);
  const out: SingerProfile = {
    id: s.id,
    name: (s.name ?? '').trim() || 'Singer',
    lowest,
    comfortableLow,
    comfortableHigh,
    highest,
  };
  if (s.voiceType) out.voiceType = s.voiceType;
  if (s.notes?.trim()) out.notes = s.notes.trim();
  if (s.sweetLow !== undefined && s.sweetHigh !== undefined) {
    let a = Math.max(comfortableLow, Math.min(comfortableHigh, pitchOf(s.sweetLow, comfortableLow)));
    let b = Math.max(comfortableLow, Math.min(comfortableHigh, pitchOf(s.sweetHigh, comfortableHigh)));
    if (a > b) [a, b] = [b, a];
    out.sweetLow = a;
    out.sweetHigh = b;
  }
  if (s.falsettoHigh !== undefined) {
    const f = pitchOf(s.falsettoHigh, highest);
    if (f > highest) out.falsettoHigh = f;
  }
  return out;
}

/** The highest note the singer can reach at all (falsetto included). */
export function singerTop(s: SingerProfile): number {
  return Math.max(s.highest, s.falsettoHigh ?? s.highest);
}

/** Where `pitch` sits in the singer's voice. */
export function singerZone(s: SingerProfile, pitch: number): VocalZone {
  if (pitch < s.lowest || pitch > singerTop(s)) return 'out';
  if (pitch > s.highest) return 'falsetto';
  if (s.sweetLow !== undefined && s.sweetHigh !== undefined && pitch >= s.sweetLow && pitch <= s.sweetHigh)
    return 'sweet';
  if (pitch >= s.comfortableLow && pitch <= s.comfortableHigh) return 'comfortable';
  return 'stretch';
}

export interface ZoneBand {
  zone: VocalZone;
  /** Inclusive MIDI pitches. */
  low: number;
  high: number;
}

/** The singer's reachable pitches as contiguous zone bands, low to high. */
export function singerBands(s: SingerProfile): ZoneBand[] {
  const bands: ZoneBand[] = [];
  for (let p = s.lowest; p <= singerTop(s); p++) {
    const zone = singerZone(s, p);
    const last = bands[bands.length - 1];
    if (last && last.zone === zone && last.high === p - 1) last.high = p;
    else bands.push({ zone, low: p, high: p });
  }
  return bands;
}

function span(low: number, high: number, flats = false): string {
  return low === high
    ? midiToNoteName(low, flats)
    : `${midiToNoteName(low, flats)}–${midiToNoteName(high, flats)}`;
}

/** One line per singer, e.g. "sweet spot G3–D4 · easy D3–A4 · difficult C3–C♯3, B♭4–C5 · falsetto to F5". */
export function describeSinger(s: SingerProfile): string {
  const parts: string[] = [];
  if (s.sweetLow !== undefined && s.sweetHigh !== undefined)
    parts.push(`sweet spot ${span(s.sweetLow, s.sweetHigh)}`);
  parts.push(`easy ${span(s.comfortableLow, s.comfortableHigh)}`);
  const hard: string[] = [];
  if (s.lowest < s.comfortableLow) hard.push(span(s.lowest, s.comfortableLow - 1));
  if (s.highest > s.comfortableHigh) hard.push(span(s.comfortableHigh + 1, s.highest));
  if (hard.length) parts.push(`difficult but possible ${hard.join(', ')}`);
  if (s.falsettoHigh !== undefined && s.falsettoHigh > s.highest)
    parts.push(`falsetto to ${midiToNoteName(s.falsettoHigh)}`);
  parts.push(`nothing below ${midiToNoteName(s.lowest)} or above ${midiToNoteName(singerTop(s))}`);
  return parts.join(' · ');
}

export function findSinger(song: Pick<Song, 'vocals'>, id: string | undefined): SingerProfile | undefined {
  return id ? song.vocals?.singers?.find((s) => s.id === id) : undefined;
}

/** The singer assigned to a track, if any. */
export function singerForTrack(song: Pick<Song, 'vocals'>, track: Track): SingerProfile | undefined {
  return findSinger(song, track.vocal?.singerId);
}

// ---------------------------------------------------------------------------------------------
// Range check
// ---------------------------------------------------------------------------------------------

export interface RangeProblem {
  noteId: string;
  pitch: number;
  tick: number;
  /** 1-based bar. */
  bar: number;
  zone: 'stretch' | 'falsetto' | 'out';
  seconds: number;
}

export interface RangeFit {
  /** Transposition of the part in semitones. */
  semitones: number;
  /** 0..1, 1 = every note in the sweet spot. */
  score: number;
  outNotes: number;
  /** Seconds sung in the difficult and falsetto zones. */
  difficultSeconds: number;
}

export type RangeVerdict = 'empty' | 'comfortable' | 'mostly-comfortable' | 'demanding' | 'out-of-range';

export interface RangeCheck {
  singerId: string;
  trackId: string;
  notes: number;
  totalSeconds: number;
  /** Notes and seconds sung in each zone. */
  zones: Record<VocalZone, { notes: number; seconds: number }>;
  lowest?: number;
  highest?: number;
  /** Duration-weighted average pitch: where the part sits. */
  tessitura?: number;
  score: number;
  verdict: RangeVerdict;
  /** One sentence for the UI. */
  summary: string;
  /** Notes outside the easy zones, in time order. */
  problems: RangeProblem[];
  /** Scores of transpositions (−12…+12 semitones), best first: fewest unreachable notes, then score. */
  fits: RangeFit[];
  /**
   * The transposition to suggest, when it clearly helps: of those scoring within 0.03 of the best,
   * the least disruptive (`fitToSinger`: semitones of key change, an octave of the vocal alone
   * counting as three).
   */
  best?: RangeFit;
}

/** Cost per second sung in each zone (out of range dominates). */
const ZONE_COST: Record<VocalZone, number> = {
  sweet: 0,
  comfortable: 0.08,
  stretch: 1,
  falsetto: 1.3,
  out: 10,
};

interface TimedPitch {
  pitch: number;
  seconds: number;
}

function fitOf(s: SingerProfile, notes: TimedPitch[], semitones: number, total: number): RangeFit {
  let cost = 0;
  let out = 0;
  let difficult = 0;
  for (const n of notes) {
    const z = singerZone(s, n.pitch + semitones);
    cost += ZONE_COST[z] * n.seconds;
    if (z === 'out') out++;
    if (z === 'stretch' || z === 'falsetto') difficult += n.seconds;
  }
  return {
    semitones,
    score: Math.round(Math.exp(-(total > 0 ? cost / total : 0)) * 1000) / 1000,
    outNotes: out,
    difficultSeconds: Math.round(difficult * 100) / 100,
  };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** A move of the vocal by `semitones` as a key change (−6…+5) plus whole octaves of the vocal. */
function splitShift(semitones: number): { keyShift: number; octaves: number } {
  let keyShift = mod12(Math.round(semitones));
  if (keyShift > 5) keyShift -= 12;
  return { keyShift, octaves: Math.round((semitones - keyShift) / 12) };
}

/** How much a fit changes the song: semitones of key change, three per vocal-only octave. */
function disruption(semitones: number): number {
  const { keyShift, octaves } = splitShift(semitones);
  return Math.abs(keyShift) + 3 * Math.abs(octaves);
}

function barsList(problems: RangeProblem[]): string {
  const bars = [...new Set(problems.map((p) => p.bar))];
  return bars.length > 4 ? `${bars.slice(0, 4).join(', ')}…` : bars.join(', ');
}

/**
 * How a part sits in a singer's voice: time in each zone, the notes outside the easy zones, a
 * verdict and score, and the transpositions that would suit the singer better.
 */
export function checkSingerRange(
  song: Song,
  track: Track,
  singer: SingerProfile,
  opts: { maxShift?: number } = {},
): RangeCheck {
  const tm = createTimeMap(song);
  const zones = Object.fromEntries(VOCAL_ZONES.map((z) => [z.zone, { notes: 0, seconds: 0 }])) as Record<
    VocalZone,
    { notes: number; seconds: number }
  >;
  const timed: TimedPitch[] = [];
  const problems: RangeProblem[] = [];
  let total = 0;
  let weighted = 0;
  let lowest: number | undefined;
  let highest: number | undefined;
  const notes = [...track.notes]
    .filter((n) => n.duration > 0 && Number.isFinite(n.pitch))
    .sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  for (const n of notes) {
    const seconds = Math.max(0, tm.tickToSeconds(n.tick + n.duration) - tm.tickToSeconds(n.tick));
    const zone = singerZone(singer, n.pitch);
    zones[zone].notes++;
    zones[zone].seconds += seconds;
    timed.push({ pitch: n.pitch, seconds });
    total += seconds;
    weighted += n.pitch * seconds;
    lowest = lowest === undefined ? n.pitch : Math.min(lowest, n.pitch);
    highest = highest === undefined ? n.pitch : Math.max(highest, n.pitch);
    if (zone === 'stretch' || zone === 'falsetto' || zone === 'out')
      problems.push({
        noteId: n.id,
        pitch: n.pitch,
        tick: n.tick,
        bar: tickToBar(song, n.tick).bar + 1,
        zone,
        seconds: Math.round(seconds * 100) / 100,
      });
  }
  for (const z of Object.values(zones)) z.seconds = Math.round(z.seconds * 100) / 100;
  const max = Math.max(0, Math.min(24, opts.maxShift ?? 12));
  const fits: RangeFit[] = [];
  for (let t = -max; t <= max; t++) fits.push(fitOf(singer, timed, t, total));
  // Reachable first: no score makes up for a note the singer cannot sing.
  fits.sort(
    (a, b) => a.outNotes - b.outNotes || b.score - a.score || Math.abs(a.semitones) - Math.abs(b.semitones),
  );
  const current = fits.find((f) => f.semitones === 0) ?? fitOf(singer, timed, 0, total);
  // The least disruptive move that is about as good as the best one.
  const top = fits[0];
  const pick = top
    ? fits
        .filter((f) => f.outNotes === top.outNotes && f.score >= top.score - 0.03)
        .sort((a, b) => disruption(a.semitones) - disruption(b.semitones) || b.score - a.score)[0]
    : undefined;
  const best =
    notes.length &&
    pick &&
    pick.semitones !== 0 &&
    pick.outNotes <= current.outNotes &&
    (pick.outNotes < current.outNotes || pick.score - current.score >= 0.05)
      ? pick
      : undefined;

  const hard = zones.stretch.seconds + zones.falsetto.seconds;
  const hardNotes = zones.stretch.notes + zones.falsetto.notes;
  let verdict: RangeVerdict;
  let summary: string;
  const outs = problems.filter((p) => p.zone === 'out');
  if (!notes.length) {
    verdict = 'empty';
    summary = 'No notes to check yet.';
  } else if (outs.length) {
    verdict = 'out-of-range';
    summary = `${outs.length} note${outs.length === 1 ? ' is' : 's are'} out of ${singer.name}'s range (bar ${barsList(outs)}).`;
  } else if (total > 0 && hard / total > 0.2) {
    verdict = 'demanding';
    summary = `Demanding: ${pct(hard / total)} of the singing is difficult for ${singer.name} (${hardNotes} notes).`;
  } else if (hardNotes) {
    verdict = 'mostly-comfortable';
    summary = `Mostly comfortable: ${hardNotes} difficult note${hardNotes === 1 ? '' : 's'} (bar ${barsList(problems)}).`;
  } else {
    verdict = 'comfortable';
    summary =
      zones.sweet.seconds > 0 && total > 0
        ? `Comfortable: everything is easy for ${singer.name}, ${pct(zones.sweet.seconds / total)} in the sweet spot.`
        : `Comfortable: everything is easy for ${singer.name}.`;
  }
  return {
    singerId: singer.id,
    trackId: track.id,
    notes: notes.length,
    totalSeconds: Math.round(total * 100) / 100,
    zones,
    lowest,
    highest,
    tessitura: total > 0 ? Math.round((weighted / total) * 10) / 10 : undefined,
    score: current.score,
    verdict,
    summary,
    problems,
    fits,
    best,
  };
}

// ---------------------------------------------------------------------------------------------
// Fitting a song to a singer
// ---------------------------------------------------------------------------------------------

export interface SingerFitPlan {
  semitones: number;
  /** Key change of the whole song, −6…+5 semitones (pitched tracks and chords move with it). */
  keyShift: number;
  /** Extra octaves for the vocal track only. */
  octaves: number;
  from: KeySignature;
  to: KeySignature;
  description: string;
  ops: MusicOperation[];
}

function semis(n: number): string {
  const a = Math.abs(n);
  return `${a} semitone${a === 1 ? '' : 's'}`;
}

/**
 * Operations that move a vocal part by `semitones` for its singer: the song changes key by the
 * nearest interval (every pitched part and the chords follow, so the harmony stays intact) and the
 * vocal track alone moves by whole octaves for the rest.
 */
export function fitToSinger(song: Song, track: Track, semitones: number): SingerFitPlan {
  const { keyShift, octaves } = splitShift(semitones);
  const from = keyAtTick(song, 0);
  const toPc = mod12(from.tonic + keyShift);
  const to: KeySignature = { tonic: toPc, mode: from.mode };
  const ops: MusicOperation[] = [];
  const parts: string[] = [];
  if (keyShift) {
    ops.push({
      op: 'set_key',
      tonic: spellPitchClass(toPc, to),
      mode: from.mode,
      transpose_notes: true,
      reason: `fit the vocal to ${track.name}'s singer`,
    });
    parts.push(
      `move the song ${keyShift > 0 ? 'up' : 'down'} ${semis(keyShift)} (${keyName(from)} → ${keyName(to)})`,
    );
  }
  if (octaves) {
    ops.push({
      op: 'transform_notes',
      track: track.id,
      region: { start_bar: 1, end_bar: Math.max(1, songLengthBars(song)) },
      transform: { transpose: 12 * octaves },
      reason: `sing ${track.name} ${Math.abs(octaves) === 1 ? 'an octave' : `${Math.abs(octaves)} octaves`} ${octaves > 0 ? 'higher' : 'lower'}`,
    });
    parts.push(
      `sing “${track.name}” ${Math.abs(octaves) === 1 ? 'an octave' : `${Math.abs(octaves)} octaves`} ${octaves > 0 ? 'higher' : 'lower'}`,
    );
  }
  const text = parts.join(' and ');
  return {
    semitones,
    keyShift,
    octaves,
    from,
    to,
    description: text ? text[0].toUpperCase() + text.slice(1) : 'Keep the current key',
    ops,
  };
}
