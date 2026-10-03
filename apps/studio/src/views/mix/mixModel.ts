import {
  LockKeys,
  channelFor,
  defaultChannelStrip,
  type AutomationParam,
  type ChannelStrip,
  type MasterBus,
  type MixerState,
  type Song,
} from '@songdeck/core';

/**
 * Pure helpers for the mixer UI: immutable path updates, fader law, value formatting, and
 * human-readable revision messages ("Vocal +2.0 dB", "Bass: EQ low-mid −3.0 dB").
 */

export const MASTER = 'master' as const;
export type StripTarget = string; // track id or 'master'

// ---------------------------------------------------------------------------
// Immutable path helpers
// ---------------------------------------------------------------------------

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function setPath<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  const base = (obj ?? {}) as Record<string, unknown>;
  return { ...base, [head]: rest.length ? setPath(base[head], rest.join('.'), value) : value } as T;
}

/** Channel strip of a track inside a mixer (defaults when missing). */
export function stripOf(mixer: MixerState, trackId: string): ChannelStrip {
  return mixer.channels[trackId] ?? defaultChannelStrip();
}

export function withChannel(mixer: MixerState, trackId: string, fn: (ch: ChannelStrip) => ChannelStrip): MixerState {
  return { ...mixer, channels: { ...mixer.channels, [trackId]: fn(stripOf(mixer, trackId)) } };
}

export function withMaster(mixer: MixerState, fn: (m: MasterBus) => MasterBus): MixerState {
  return { ...mixer, master: fn(mixer.master) };
}

/** Set a dotted field of a track strip or the master bus. */
export function setStripField(mixer: MixerState, target: StripTarget, path: string, value: unknown): MixerState {
  return target === MASTER ? withMaster(mixer, (m) => setPath(m, path, value)) : withChannel(mixer, target, (ch) => setPath(ch, path, value));
}

export function stripField(mixer: MixerState, target: StripTarget, path: string): unknown {
  return getPath(target === MASTER ? mixer.master : stripOf(mixer, target), path);
}

export function isStripLocked(song: Song, target: StripTarget): boolean {
  return !!song.locks[LockKeys.mixer(target)];
}

// ---------------------------------------------------------------------------
// Fader law (position 0..1 ↔ dB), shared by faders and automation lanes
// ---------------------------------------------------------------------------

export const FADER_MIN_DB = -96;
export const FADER_MAX_DB = 12;
const LAW: [number, number][] = [
  [0, -96],
  [0.035, -60],
  [0.14, -40],
  [0.25, -30],
  [0.385, -20],
  [0.555, -10],
  [0.655, -5],
  [0.755, 0],
  [0.875, 6],
  [1, 12],
];

export function dbToPos(db: number): number {
  if (!Number.isFinite(db) || db <= LAW[0][1]) return 0;
  for (let i = 1; i < LAW.length; i++) {
    const [p1, d1] = LAW[i];
    const [p0, d0] = LAW[i - 1];
    if (db <= d1) return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
  }
  return 1;
}

export function posToDb(pos: number): number {
  const p = Math.max(0, Math.min(1, pos));
  for (let i = 1; i < LAW.length; i++) {
    const [p1, d1] = LAW[i];
    const [p0, d0] = LAW[i - 1];
    if (p <= p1) return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
  }
  return FADER_MAX_DB;
}

export const FADER_TICKS = [12, 6, 0, -6, -12, -20, -30, -40, -60];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MINUS = '−';

export function fmtDb(v: number, digits = 1, plus = true): string {
  if (!Number.isFinite(v) || v <= -90) return `${MINUS}∞`;
  const r = Number(v.toFixed(digits));
  if (r === 0) return (0).toFixed(digits);
  return `${r < 0 ? MINUS : plus ? '+' : ''}${Math.abs(r).toFixed(digits)}`;
}

export function fmtPan(v: number): string {
  const p = Math.round(v * 100);
  if (p === 0) return 'C';
  return `${Math.abs(p)}${p < 0 ? 'L' : 'R'}`;
}

export function fmtPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function fmtHz(v: number): string {
  if (!v || v <= 0) return 'off';
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2).replace(/\.?0+$/, '')}k`;
  return `${Math.round(v)}`;
}

export function fmtHzUnit(v: number): string {
  if (!v || v <= 0) return 'off';
  return v >= 1000 ? `${fmtHz(v)}Hz` : `${Math.round(v)} Hz`;
}

export function fmtMs(v: number): string {
  return v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`;
}

export function fmtRatio(v: number): string {
  return `${v >= 10 ? Math.round(v) : Number(v.toFixed(1))}:1`;
}

export function fmtSeconds(v: number): string {
  return `${v.toFixed(v < 10 ? 1 : 0)} s`;
}

// ---------------------------------------------------------------------------
// Field metadata (labels, ranges, formats)
// ---------------------------------------------------------------------------

export interface FieldMeta {
  label: string;
  short: string;
  min: number;
  max: number;
  fmt: (v: number) => string;
  log?: boolean;
  unit?: string;
}

export const FIELD_META: Record<string, FieldMeta> = {
  volumeDb: { label: 'Volume', short: 'Vol', min: -96, max: 12, fmt: (v) => `${fmtDb(v)} dB` },
  pan: { label: 'Pan', short: 'Pan', min: -1, max: 1, fmt: fmtPan },
  reverbSend: { label: 'Reverb send', short: 'Rev', min: 0, max: 1, fmt: fmtPct },
  delaySend: { label: 'Delay send', short: 'Dly', min: 0, max: 1, fmt: fmtPct },
  width: { label: 'Stereo width', short: 'Width', min: 0, max: 2, fmt: fmtPct },
  drive: { label: 'Drive', short: 'Drive', min: 0, max: 1, fmt: fmtPct },
  'eq.highpassHz': { label: 'EQ high-pass', short: 'HPF', min: 0, max: 20000, fmt: fmtHzUnit, log: true },
  'eq.lowShelfHz': { label: 'EQ low shelf freq', short: 'LS Hz', min: 20, max: 2000, fmt: fmtHzUnit, log: true },
  'eq.lowShelfDb': { label: 'EQ low shelf', short: 'LS', min: -24, max: 24, fmt: (v) => `${fmtDb(v)} dB` },
  'eq.lowMidHz': { label: 'EQ low-mid freq', short: 'LM Hz', min: 40, max: 8000, fmt: fmtHzUnit, log: true },
  'eq.lowMidDb': { label: 'EQ low-mid', short: 'LM', min: -24, max: 24, fmt: (v) => `${fmtDb(v)} dB` },
  'eq.lowMidQ': { label: 'EQ low-mid Q', short: 'LM Q', min: 0.1, max: 18, fmt: (v) => `Q ${v.toFixed(2)}`, log: true },
  'eq.highMidHz': { label: 'EQ high-mid freq', short: 'HM Hz', min: 200, max: 16000, fmt: fmtHzUnit, log: true },
  'eq.highMidDb': { label: 'EQ high-mid', short: 'HM', min: -24, max: 24, fmt: (v) => `${fmtDb(v)} dB` },
  'eq.highMidQ': { label: 'EQ high-mid Q', short: 'HM Q', min: 0.1, max: 18, fmt: (v) => `Q ${v.toFixed(2)}`, log: true },
  'eq.highShelfHz': { label: 'EQ high shelf freq', short: 'HS Hz', min: 1000, max: 20000, fmt: fmtHzUnit, log: true },
  'eq.highShelfDb': { label: 'EQ high shelf', short: 'HS', min: -24, max: 24, fmt: (v) => `${fmtDb(v)} dB` },
  'eq.lowpassHz': { label: 'EQ low-pass', short: 'LPF', min: 0, max: 22050, fmt: fmtHzUnit, log: true },
  'compressor.thresholdDb': { label: 'Compressor threshold', short: 'Thresh', min: -60, max: 0, fmt: (v) => `${fmtDb(v, 1, false)} dB` },
  'compressor.ratio': { label: 'Compressor ratio', short: 'Ratio', min: 1, max: 20, fmt: fmtRatio, log: true },
  'compressor.attackMs': { label: 'Compressor attack', short: 'Attack', min: 0.1, max: 300, fmt: fmtMs, log: true },
  'compressor.releaseMs': { label: 'Compressor release', short: 'Release', min: 5, max: 3000, fmt: fmtMs, log: true },
  'compressor.kneeDb': { label: 'Compressor knee', short: 'Knee', min: 0, max: 24, fmt: (v) => `${v.toFixed(1)} dB` },
  'compressor.makeupDb': { label: 'Compressor makeup', short: 'Makeup', min: 0, max: 24, fmt: (v) => `${fmtDb(v)} dB` },
  'limiter.ceilingDb': { label: 'Limiter ceiling', short: 'Ceiling', min: -12, max: 0, fmt: (v) => `${fmtDb(v, 1, false)} dBTP` },
  'limiter.releaseMs': { label: 'Limiter release', short: 'Release', min: 5, max: 1000, fmt: fmtMs, log: true },
  'reverb.size': { label: 'Reverb size', short: 'Size', min: 0, max: 1, fmt: fmtPct },
  'reverb.decaySeconds': { label: 'Reverb decay', short: 'Decay', min: 0.2, max: 12, fmt: fmtSeconds, log: true },
  'reverb.damping': { label: 'Reverb damping', short: 'Damp', min: 0, max: 1, fmt: fmtPct },
  'reverb.preDelayMs': { label: 'Reverb pre-delay', short: 'Pre', min: 0, max: 250, fmt: fmtMs },
  'reverb.returnDb': { label: 'Reverb return', short: 'Return', min: -60, max: 6, fmt: (v) => `${fmtDb(v)} dB` },
  'delay.timeBeats': { label: 'Delay time', short: 'Time', min: 0.0625, max: 4, fmt: fmtBeats, log: true },
  'delay.feedback': { label: 'Delay feedback', short: 'Fdbk', min: 0, max: 0.95, fmt: fmtPct },
  'delay.highCutHz': { label: 'Delay high cut', short: 'Hi cut', min: 1000, max: 20000, fmt: fmtHzUnit, log: true },
  'delay.lowCutHz': { label: 'Delay low cut', short: 'Lo cut', min: 20, max: 2000, fmt: fmtHzUnit, log: true },
  'delay.returnDb': { label: 'Delay return', short: 'Return', min: -60, max: 6, fmt: (v) => `${fmtDb(v)} dB` },
};

export const DELAY_NOTES: { beats: number; label: string }[] = [
  { beats: 0.25, label: '1/16' },
  { beats: 1 / 3, label: '1/8T' },
  { beats: 0.5, label: '1/8' },
  { beats: 0.75, label: '1/8 dotted' },
  { beats: 2 / 3, label: '1/4T' },
  { beats: 1, label: '1/4' },
  { beats: 1.5, label: '1/4 dotted' },
  { beats: 2, label: '1/2' },
];

export function fmtBeats(v: number): string {
  const n = DELAY_NOTES.find((d) => Math.abs(d.beats - v) < 0.004);
  return n ? n.label : `${Number(v.toFixed(3))} beats`;
}

// ---------------------------------------------------------------------------
// Diff → human message
// ---------------------------------------------------------------------------

export interface MixFieldChange {
  /** Track id, 'master', 'reverb' or 'delay'. */
  target: string;
  field: string;
  before: unknown;
  after: unknown;
}

function flatten(obj: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = obj;
  return out;
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b || (a === undefined && b === false) || (a === false && b === undefined);
}

/** Field-level differences between two mixer states. */
export function diffMixer(before: MixerState, after: MixerState): MixFieldChange[] {
  const out: MixFieldChange[] = [];
  const ids = new Set([...Object.keys(before.channels), ...Object.keys(after.channels)]);
  for (const id of ids) {
    const fb = flatten(stripOf(before, id));
    const fa = flatten(stripOf(after, id));
    for (const f of new Set([...Object.keys(fb), ...Object.keys(fa)])) if (!same(fb[f], fa[f])) out.push({ target: id, field: f, before: fb[f], after: fa[f] });
  }
  const groups: [string, unknown, unknown][] = [
    ['master', before.master, after.master],
    ['reverb', before.reverb, after.reverb],
    ['delay', before.delay, after.delay],
  ];
  for (const [target, b, a] of groups) {
    const fb = flatten(b);
    const fa = flatten(a);
    for (const f of new Set([...Object.keys(fb), ...Object.keys(fa)])) if (!same(fb[f], fa[f])) out.push({ target, field: f, before: fb[f], after: fa[f] });
  }
  return out;
}

const EQ_BAND_NAMES: Record<string, string> = {
  lowShelf: 'low shelf',
  lowMid: 'low-mid',
  highMid: 'high-mid',
  highShelf: 'high shelf',
};

/** Short description of one field change, without the target name ("EQ low-mid −3.0 dB"). */
export function describeField(field: string, before: unknown, after: unknown, opts: { master?: boolean } = {}): string {
  const meta = FIELD_META[field];
  if (typeof after === 'boolean' || typeof before === 'boolean') {
    const on = !!after;
    switch (field) {
      case 'mute':
        return on ? 'muted' : 'unmuted';
      case 'solo':
        return on ? 'soloed' : 'unsoloed';
      case 'phaseInvert':
        return on ? 'phase inverted' : 'phase normal';
      case 'eq.enabled':
        return `EQ ${on ? 'on' : 'off'}`;
      case 'compressor.enabled':
        return `${opts.master ? 'glue compressor' : 'compressor'} ${on ? 'on' : 'off'}`;
      case 'limiter.enabled':
        return `limiter ${on ? 'on' : 'off'}`;
      case 'pingPong':
        return `ping-pong ${on ? 'on' : 'off'}`;
      default:
        return `${field} ${on ? 'on' : 'off'}`;
    }
  }
  if (typeof after === 'string') return `${(meta?.label ?? field.replace('.', ' ')).toLowerCase()} ${after}`;
  const a = typeof after === 'number' ? after : NaN;
  const b = typeof before === 'number' ? before : NaN;
  if (field === 'volumeDb') {
    if (Number.isFinite(b) && b > -90 && a > -90) {
      const d = a - b;
      return `${fmtDb(d)} dB`;
    }
    return `fader ${fmtDb(a)} dB`;
  }
  const eq = /^eq\.(lowShelf|lowMid|highMid|highShelf)(Db|Hz|Q)$/.exec(field);
  if (eq) {
    const band = EQ_BAND_NAMES[eq[1]];
    if (eq[2] === 'Db') return `EQ ${band} ${fmtDb(a)} dB`;
    if (eq[2] === 'Hz') return `EQ ${band} ${fmtHzUnit(a)}`;
    return `EQ ${band} Q ${a.toFixed(2)}`;
  }
  if (field === 'eq.highpassHz') return a > 0 ? `high-pass ${fmtHzUnit(a)}` : 'high-pass off';
  if (field === 'eq.lowpassHz') return a > 0 ? `low-pass ${fmtHzUnit(a)}` : 'low-pass off';
  if (field.startsWith('compressor.')) {
    const name = opts.master ? 'glue compressor' : 'compressor';
    const what = field.slice('compressor.'.length).replace(/Db$|Ms$/, '').replace('makeup', 'makeup').toLowerCase();
    return `${name} ${what} ${meta ? meta.fmt(a) : a}`;
  }
  if (field === 'pan') return Math.abs(a) < 0.005 ? 'pan center' : `pan ${Math.round(Math.abs(a) * 100)}% ${a < 0 ? 'left' : 'right'}`;
  if (meta) return `${meta.label.toLowerCase()} ${meta.fmt(a)}`;
  return `${field} ${Number.isFinite(a) ? Number(a.toFixed(3)) : String(after)}`;
}

function c0IsBus(target: string): boolean {
  return target === 'reverb' || target === 'delay';
}

export function targetName(song: Song, target: string): string {
  if (target === 'master') return 'Master';
  if (target === 'reverb') return 'Reverb bus';
  if (target === 'delay') return 'Delay bus';
  return song.tracks.find((t) => t.id === target)?.name ?? 'Track';
}

/** Revision message for a mixer change ("Vocal +2.0 dB", "Bass: EQ low-mid −3.0 dB, 320 Hz"). */
export function describeMixChange(song: Song, before: MixerState, after: MixerState): string {
  const changes = diffMixer(before, after);
  if (!changes.length) return 'Mixer change';
  const byTarget = new Map<string, MixFieldChange[]>();
  for (const c of changes) byTarget.set(c.target, [...(byTarget.get(c.target) ?? []), c]);
  const parts: string[] = [];
  for (const [target, list] of byTarget) {
    const name = targetName(song, target);
    const master = target === 'master';
    const bus = c0IsBus(target);
    const descs = list.map((c) => {
      const d = describeField(bus ? `${target}.${c.field}` : c.field, c.before, c.after, { master });
      return bus && d.startsWith(`${target} `) ? d.slice(target.length + 1) : d;
    });
    // EQ band moves: merge "EQ low-mid 320 Hz" + "EQ low-mid −3.0 dB" → "EQ low-mid 320 Hz, −3.0 dB".
    const merged: string[] = [];
    for (const d of descs) {
      const m = /^(EQ [a-z -]+?) (.+)$/.exec(d);
      const prev = merged[merged.length - 1];
      const pm = prev ? /^(EQ [a-z -]+?) (.+)$/.exec(prev) : null;
      if (m && pm && m[1] === pm[1]) merged[merged.length - 1] = `${prev}, ${m[2]}`;
      else merged.push(d);
    }
    const text = merged.slice(0, 3).join(', ') + (merged.length > 3 ? ` (+${merged.length - 3} more)` : '');
    const firstField = list[0].field;
    if (list.length === 1 && firstField === 'volumeDb') parts.push(`${name} ${text}`);
    else if (list.length === 1 && (firstField === 'mute' || firstField === 'solo')) parts.push(`${text[0].toUpperCase()}${text.slice(1)} ${name}`);
    else parts.push(`${name}: ${text}`);
  }
  return parts.slice(0, 3).join('; ') + (parts.length > 3 ? ` (+${parts.length - 3} more)` : '');
}

// ---------------------------------------------------------------------------
// Automation parameters
// ---------------------------------------------------------------------------

export interface AutomationParamMeta {
  label: string;
  min: number;
  max: number;
  /** Logarithmic vertical scale (frequencies). */
  log?: boolean;
  /** Use the fader law for the vertical scale (volume). */
  fader?: boolean;
  fmt: (v: number) => string;
  /** Default (static) value from a strip. */
  from: (ch: ChannelStrip | MasterBus) => number;
  masterOk: boolean;
}

export const AUTOMATION_META: Record<AutomationParam, AutomationParamMeta> = {
  volumeDb: { label: 'Volume', min: -60, max: 12, fader: true, fmt: (v) => `${fmtDb(v)} dB`, from: (c) => c.volumeDb, masterOk: true },
  pan: { label: 'Pan', min: -1, max: 1, fmt: fmtPan, from: (c) => ('pan' in c ? c.pan : 0), masterOk: false },
  reverbSend: { label: 'Reverb send', min: 0, max: 1, fmt: fmtPct, from: (c) => ('reverbSend' in c ? c.reverbSend : 0), masterOk: false },
  delaySend: { label: 'Delay send', min: 0, max: 1, fmt: fmtPct, from: (c) => ('delaySend' in c ? c.delaySend : 0), masterOk: false },
  width: { label: 'Stereo width', min: 0, max: 2, fmt: fmtPct, from: (c) => c.width, masterOk: true },
  drive: { label: 'Drive', min: 0, max: 1, fmt: fmtPct, from: (c) => ('drive' in c ? c.drive : 0), masterOk: false },
  'eq.lowShelfDb': { label: 'EQ low shelf', min: -24, max: 24, fmt: (v) => `${fmtDb(v)} dB`, from: (c) => c.eq.lowShelfDb, masterOk: true },
  'eq.lowMidDb': { label: 'EQ low-mid', min: -24, max: 24, fmt: (v) => `${fmtDb(v)} dB`, from: (c) => c.eq.lowMidDb, masterOk: true },
  'eq.highMidDb': { label: 'EQ high-mid', min: -24, max: 24, fmt: (v) => `${fmtDb(v)} dB`, from: (c) => c.eq.highMidDb, masterOk: true },
  'eq.highShelfDb': { label: 'EQ high shelf', min: -24, max: 24, fmt: (v) => `${fmtDb(v)} dB`, from: (c) => c.eq.highShelfDb, masterOk: true },
  'eq.lowpassHz': { label: 'EQ low-pass', min: 20, max: 20000, log: true, fmt: fmtHzUnit, from: (c) => c.eq.lowpassHz || 20000, masterOk: true },
  'eq.highpassHz': { label: 'EQ high-pass', min: 20, max: 20000, log: true, fmt: fmtHzUnit, from: (c) => c.eq.highpassHz || 20, masterOk: true },
};

export const AUTOMATION_PARAMS = Object.keys(AUTOMATION_META) as AutomationParam[];

/** Normalized 0..1 vertical position of an automation value. */
export function automationNorm(param: AutomationParam, v: number): number {
  const m = AUTOMATION_META[param];
  if (m.fader) return (dbToPos(v) - dbToPos(m.min)) / (dbToPos(m.max) - dbToPos(m.min));
  if (m.log) return Math.log(Math.max(m.min, v) / m.min) / Math.log(m.max / m.min);
  return (v - m.min) / (m.max - m.min);
}

export function automationDenorm(param: AutomationParam, n: number): number {
  const m = AUTOMATION_META[param];
  const t = Math.max(0, Math.min(1, n));
  if (m.fader) return posToDb(dbToPos(m.min) + t * (dbToPos(m.max) - dbToPos(m.min)));
  if (m.log) return m.min * Math.pow(m.max / m.min, t);
  return m.min + t * (m.max - m.min);
}

/** Round an automation value to a sensible precision for its parameter. */
export function roundAutomation(param: AutomationParam, v: number): number {
  const m = AUTOMATION_META[param];
  if (m.log) return Math.round(v);
  if (param === 'volumeDb' || param.startsWith('eq.')) return Math.round(v * 10) / 10;
  return Math.round(v * 100) / 100;
}

/** Static value of a parameter for a lane target (used before the first point / when disabled). */
export function staticAutomationValue(mixer: MixerState, target: string, param: AutomationParam): number {
  const strip = target === MASTER ? mixer.master : channelFor({ mixer }, target);
  return AUTOMATION_META[param].from(strip);
}
