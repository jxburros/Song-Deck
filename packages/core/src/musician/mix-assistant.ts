import type { AutomationParam, EditSelection, MasterBus, MixerChange, MusicOperation, Song, Track } from '../ir/types';
import { barToTick, sectionLayout, tickToBar, type SectionSpan } from '../timing';
import { channelFor } from '../ir/song-utils';
import { amountOf, findSectionMentions, findTrackMentions, listJoin, normalizeText, parseDb, splitClauses, type TrackMention } from './nlp';
import { avgPitch, findMelodyTrack, isBassTrack, isDrumTrack, isMixerLocked, isVocalTrack, round2, selectionTracks } from './op-helpers';
import type { EditInterpretation } from './types';

/**
 * §41 AI mix assistant — translates mix requests into ordinary, deterministic mixer changes
 * (`set_mixer` with dot-path fields) and automation (`set_automation`, 1-based bar/beat points)
 * instead of regenerating audio.
 */

type Target = { id: string; name: string; track?: Track };

const AUTOMATABLE = new Set<AutomationParam>(['volumeDb', 'pan', 'reverbSend', 'delaySend', 'width', 'drive', 'eq.lowShelfDb', 'eq.lowMidDb', 'eq.highMidDb', 'eq.highShelfDb', 'eq.lowpassHz', 'eq.highpassHz']);

interface Change {
  field: keyof MixerChange;
  value: number | boolean;
  why: string;
}

interface Plan {
  target: Target;
  changes: Change[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r1 = (x: number) => Math.round(x * 10) / 10;

function current(song: Song, t: Target, state?: Map<string, Record<string, number | boolean>>): Record<string, number | boolean> {
  const base = currentBase(song, t);
  const over = state?.get(t.id);
  return over ? { ...base, ...over } : base;
}

function currentBase(song: Song, t: Target): Record<string, number | boolean> {
  if (t.id === 'master') {
    const m: MasterBus = song.mixer.master;
    return flatten({ volumeDb: m.volumeDb, width: m.width, eq: m.eq, compressor: m.compressor, pan: 0, reverbSend: 0, delaySend: 0, drive: 0 });
  }
  return flatten(channelFor(song, t.id) as unknown as Record<string, unknown>);
}

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') Object.assign(out, flatten(v as Record<string, unknown>, `${prefix}${k}.`));
    else if (typeof v === 'number' || typeof v === 'boolean') out[`${prefix}${k}`] = v;
  }
  return out;
}

const HPF_BY_ROLE = (t: Track): number => {
  if (isVocalTrack(t)) return 100;
  if (t.instrumentId === 'violin' || t.instrumentId === 'flute' || t.instrumentId === 'glockenspiel') return 180;
  if (t.instrumentId === 'viola' || t.instrumentId === 'trumpet' || t.instrumentId === 'saxophone' || t.instrumentId === 'clarinet') return 140;
  if (t.role === 'synth-pad' || t.role === 'synth-arp' || t.role === 'synth-lead') return 120;
  if (t.role === 'rhythm-guitar' || t.role === 'lead-guitar' || /guitar/.test(t.instrumentId)) return 90;
  if (t.role === 'keys' || t.instrumentId === 'piano') return 70;
  if (t.instrumentId === 'cello' || t.instrumentId === 'string-ensemble') return 60;
  return 80;
};

function isMidrange(t: Track): boolean {
  return !isDrumTrack(t) && !isBassTrack(t) && !isVocalTrack(t);
}

function describe(field: keyof MixerChange, before: number | boolean | undefined, after: number | boolean): string {
  const f = String(field);
  if (typeof after === 'boolean') return `${f.replace('compressor.enabled', 'compressor').replace('mute', 'mute').replace('solo', 'solo')} ${after ? 'on' : 'off'}`;
  const b = typeof before === 'number' ? before : undefined;
  const unit = /Db$|volumeDb/.test(f) ? ' dB' : /Hz$/.test(f) ? ' Hz' : /Ms$/.test(f) ? ' ms' : '';
  const label: Record<string, string> = {
    volumeDb: 'volume',
    pan: 'pan',
    reverbSend: 'reverb send',
    delaySend: 'delay send',
    width: 'stereo width',
    drive: 'drive',
    'eq.highpassHz': 'high-pass filter',
    'eq.lowShelfDb': 'low shelf',
    'eq.lowShelfHz': 'low-shelf frequency',
    'eq.lowMidDb': 'low-mid EQ',
    'eq.lowMidHz': 'low-mid frequency',
    'eq.lowMidQ': 'low-mid Q',
    'eq.highMidDb': 'presence EQ',
    'eq.highMidHz': 'presence frequency',
    'eq.highMidQ': 'presence Q',
    'eq.highShelfDb': 'high shelf',
    'eq.highShelfHz': 'high-shelf frequency',
    'eq.lowpassHz': 'low-pass filter',
    'compressor.thresholdDb': 'compressor threshold',
    'compressor.ratio': 'compressor ratio',
    'compressor.attackMs': 'compressor attack',
    'compressor.releaseMs': 'compressor release',
    'compressor.makeupDb': 'compressor make-up gain',
  };
  const name = label[f] ?? f;
  const twoDp = f === 'reverbSend' || f === 'delaySend' || f === 'width' || f === 'drive';
  const fmt = (x: number) =>
    f === 'pan' ? (x === 0 ? 'C' : x < 0 ? `${Math.round(-x * 100)}L` : `${Math.round(x * 100)}R`) : f === 'compressor.ratio' ? `${r1(x)}:1` : twoDp ? `${round2(x)}` : `${r1(x)}${unit}`;
  if (b === undefined || b === after) return `${name} ${fmt(after)}`;
  if (/Db$|volumeDb/.test(f) && unit === ' dB') {
    const d = r1(after - b);
    return `${name} ${d > 0 ? '+' : ''}${d} dB (${fmt(b)} → ${fmt(after)})`;
  }
  return `${name} ${fmt(b)} → ${fmt(after)}`;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

function resolveTargets(song: Song, mentions: TrackMention[], selection?: EditSelection): { targets: Target[]; explicit: boolean; overall: boolean; missing?: string } {
  const specific = mentions.filter((m) => !m.generic || m.generic === 'melody');
  const overall = mentions.some((m) => m.generic === 'all');
  if (specific.length) {
    const tracks = specific.flatMap((m) => m.tracks);
    const uniq = [...new Set(tracks)];
    if (!uniq.length) return { targets: [], explicit: true, overall, missing: specific[0].label };
    return { targets: uniq.map((t) => ({ id: t.id, name: t.name, track: t })), explicit: true, overall };
  }
  const sel = selectionTracks(song, selection);
  if (sel.length && !overall) return { targets: sel.map((t) => ({ id: t.id, name: t.name, track: t })), explicit: true, overall };
  return { targets: [], explicit: false, overall };
}

function trackTargets(song: Song, pred: (t: Track) => boolean): Target[] {
  return song.tracks.filter((t) => (t.kind === 'midi' || t.clips.length > 0) && pred(t)).map((t) => ({ id: t.id, name: t.name, track: t }));
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface RuleCtx {
  song: Song;
  text: string;
  amount: number;
  db: number | null;
  targets: Target[];
  explicit: boolean;
  overall: boolean;
  plans: Map<string, Plan>;
  notes: string[];
  state: Map<string, Record<string, number | boolean>>;
}

function plan(ctx: RuleCtx, t: Target): Plan {
  let p = ctx.plans.get(t.id);
  if (!p) {
    p = { target: t, changes: [] };
    ctx.plans.set(t.id, p);
  }
  return p;
}

function setField(ctx: RuleCtx, t: Target, field: keyof MixerChange, compute: (cur: number | boolean | undefined) => number | boolean, why: string) {
  const p = plan(ctx, t);
  const existing = p.changes.find((c) => c.field === field);
  const cur = existing ? existing.value : current(ctx.song, t, ctx.state)[field as string];
  const value = compute(cur);
  if (existing) {
    existing.value = value;
    existing.why = `${existing.why}; ${why}`;
  } else p.changes.push({ field, value, why });
}

const num = (v: number | boolean | undefined, d = 0) => (typeof v === 'number' ? v : d);

function vocalTargets(ctx: RuleCtx): Target[] {
  if (ctx.targets.length) return ctx.targets;
  const v = trackTargets(ctx.song, isVocalTrack);
  if (v.length) return v;
  const m = findMelodyTrack(ctx.song);
  return m ? [{ id: m.id, name: m.name, track: m }] : [];
}

function defaultTargets(ctx: RuleCtx): Target[] {
  if (ctx.targets.length) return ctx.targets;
  return [{ id: 'master', name: 'Master' }];
}

function vocalRegister(song: Song, vocals: Target[]): number {
  const notes = vocals.flatMap((t) => t.track?.notes ?? []);
  return notes.length ? avgPitch(notes) : 67;
}

type Rule = { id: string; re: RegExp; apply: (ctx: RuleCtx) => void };

const RULES: Rule[] = [
  {
    id: 'clarity',
    re: /\b(clear(er)?|clarity|intelligib(le|ility)|cut through|more present|presence|audible|stand out|pop out|easier to understand)\b/,
    apply: (ctx) => {
      const tgts = vocalTargets(ctx);
      for (const t of tgts) {
        setField(ctx, t, 'eq.highMidHz', () => 3000, 'presence boost around 3 kHz');
        setField(ctx, t, 'eq.highMidDb', (c) => clamp(num(c) + 3 * ctx.amount, -12, 9), 'presence boost for intelligibility');
        setField(ctx, t, 'eq.highMidQ', () => 1, 'broad presence band');
        setField(ctx, t, 'eq.highpassHz', (c) => Math.max(num(c), t.track && !isVocalTrack(t.track) ? HPF_BY_ROLE(t.track) : 100), 'gentle high-pass to remove rumble');
        setField(ctx, t, 'reverbSend', (c) => round2(clamp(num(c, 0.15) - 0.04 * ctx.amount, 0, 1)), 'slightly less reverb so the words stay in front');
      }
      const center = vocalRegister(ctx.song, tgts);
      const competitors = trackTargets(ctx.song, (tr) => isMidrange(tr) && !tgts.some((x) => x.id === tr.id) && (tr.notes.length === 0 || Math.abs(avgPitch(tr.notes) - center) <= 14));
      for (const t of competitors) {
        setField(ctx, t, 'eq.lowMidHz', () => 320, 'carve 250–400 Hz');
        setField(ctx, t, 'eq.lowMidDb', (c) => clamp(num(c) - 2 * ctx.amount, -12, 12), 'cut 250–400 Hz to make room for the vocal');
        setField(ctx, t, 'eq.lowMidQ', () => 1.2, 'focused cut');
      }
      if (competitors.length) ctx.notes.push(`Carved 250–400 Hz in ${listJoin(competitors.map((c) => c.name))}, which share the vocal's register.`);
    },
  },
  {
    id: 'push-back',
    re: /\b(farther|further) back\b|\bpush(ed)? (it |\w+ )?back\b|\bmore distant\b|\bin the background\b|\bsit (further |farther )?back\b|\bless (upfront|forward|present|prominent|in your face)\b|\btuck(ed)? (it )?(in|away)\b|\bbehind the\b/,
    apply: (ctx) => {
      for (const t of defaultTargets(ctx)) {
        setField(ctx, t, 'volumeDb', (c) => r1(num(c, -6) + (ctx.db !== null ? -Math.abs(ctx.db) : -3 * ctx.amount)), 'lower level');
        if (t.id !== 'master') setField(ctx, t, 'reverbSend', (c) => round2(clamp(num(c, 0.15) + 0.15 * ctx.amount, 0, 0.8)), 'more reverb for depth');
        setField(ctx, t, 'eq.highShelfHz', () => 8000, 'air band');
        setField(ctx, t, 'eq.highShelfDb', (c) => clamp(num(c) - 2.5 * ctx.amount, -12, 12), 'duller top end, as distant sounds lose highs');
      }
    },
  },
  {
    id: 'forward',
    re: /\b(bring|move|push|pull)\b[^,]*\b(forward|to the front|up front|closer|out)\b|\bmore (upfront|forward|prominent|in your face)\b|\bcloser\b|\bfeature (the|it)\b/,
    apply: (ctx) => {
      for (const t of defaultTargets(ctx)) {
        setField(ctx, t, 'volumeDb', (c) => r1(num(c, -6) + (ctx.db !== null ? Math.abs(ctx.db) : 2.5 * ctx.amount)), 'higher level');
        if (t.id !== 'master') setField(ctx, t, 'reverbSend', (c) => round2(clamp(num(c, 0.15) - 0.06 * ctx.amount, 0, 1)), 'drier, so it sounds closer');
        setField(ctx, t, 'eq.highMidHz', () => 3000, 'presence band');
        setField(ctx, t, 'eq.highMidDb', (c) => clamp(num(c) + 1.5 * ctx.amount, -12, 9), 'a little presence');
      }
    },
  },
  {
    id: 'punch',
    re: /\bhit harder\b|\bpunch(y|ier)?\b|\bmore (impact|punch|slam|thump)\b|\bslam(ming)?\b|\bhit (hard|harder)\b|\bharder hitting\b|\bfatter\b/,
    apply: (ctx) => {
      const tgts = ctx.targets.length ? ctx.targets : trackTargets(ctx.song, isDrumTrack);
      for (const t of tgts.length ? tgts : defaultTargets(ctx)) {
        const drums = !t.track || isDrumTrack(t.track);
        setField(ctx, t, 'compressor.enabled', () => true, 'compression for punch');
        setField(ctx, t, 'compressor.thresholdDb', () => -20, 'catch the body of each hit');
        setField(ctx, t, 'compressor.ratio', () => 4, 'firm ratio');
        setField(ctx, t, 'compressor.attackMs', () => 30, 'slow attack lets the transient through');
        setField(ctx, t, 'compressor.releaseMs', () => 90, 'fast release recovers between hits');
        setField(ctx, t, 'compressor.makeupDb', () => 2, 'make-up gain');
        if (drums) {
          setField(ctx, t, 'eq.lowShelfHz', () => 80, 'kick body');
          setField(ctx, t, 'eq.lowShelfDb', (c) => clamp(num(c) + 2.5 * ctx.amount, -12, 12), 'more kick body');
          setField(ctx, t, 'eq.highMidHz', () => 4000, 'stick attack');
          setField(ctx, t, 'eq.highMidDb', (c) => clamp(num(c) + 1.5 * ctx.amount, -12, 9), 'more attack/snap');
        }
        setField(ctx, t, 'volumeDb', (c) => r1(num(c, -6) + 1.5 * ctx.amount), 'a touch louder');
      }
    },
  },
  {
    id: 'muddiness',
    re: /\bmudd(y|iness)\b|\bmud\b|\bboomy\b|\bboxy\b|\bmurky\b|\bcloudy\b|\bclean up the low[\s-]?(end|mids)\b|\bless low[\s-]?mids?\b|\btoo much low[\s-]?mids?\b/,
    apply: (ctx) => {
      const tgts = ctx.targets.length ? ctx.targets : trackTargets(ctx.song, (t) => !isDrumTrack(t));
      for (const t of tgts) {
        const bass = t.track ? isBassTrack(t.track) : false;
        setField(ctx, t, 'eq.lowMidHz', () => 300, '250–400 Hz mud region');
        setField(ctx, t, 'eq.lowMidDb', (c) => clamp(num(c) - (bass ? 2 : 3) * ctx.amount, -12, 12), 'cut the 250–400 Hz build-up');
        setField(ctx, t, 'eq.lowMidQ', () => 1, 'moderate width');
        if (!bass && t.track) setField(ctx, t, 'eq.highpassHz', (c) => Math.max(num(c), HPF_BY_ROLE(t.track!)), 'high-pass: leave the low end to bass and kick');
      }
    },
  },
  {
    id: 'drier',
    re: /\bdr(y|ier)\b|\bless (reverb|echo|delay|wet|ambience|room|verb)\b|\bmore intimate\b|\bbone dry\b/,
    apply: (ctx) => {
      const tgts = ctx.targets.length ? ctx.targets : trackTargets(ctx.song, () => true);
      const dry = /\bbone dry\b|\bcompletely dry\b/.test(ctx.text);
      for (const t of tgts) {
        if (t.id === 'master') continue;
        setField(ctx, t, 'reverbSend', (c) => (dry ? 0 : round2(clamp(num(c, 0.15) - 0.08 * ctx.amount, 0, 1))), 'less reverb');
        setField(ctx, t, 'delaySend', (c) => (dry ? 0 : round2(clamp(num(c, 0) - 0.05 * ctx.amount, 0, 1))), 'less delay');
      }
    },
  },
  {
    id: 'wetter',
    re: /\bwet(ter)?\b|\bmore (reverb|space|ambience|room|depth|verb|echo|delay)\b|\bbigger room\b|\bspacious\b|\batmospheric\b|\bwashy\b/,
    apply: (ctx) => {
      const delay = /\b(echo|delay)\b/.test(ctx.text);
      const tgts = ctx.targets.length && !ctx.overall ? ctx.targets : trackTargets(ctx.song, (t) => !isBassTrack(t));
      for (const t of tgts) {
        if (t.id === 'master') continue;
        const drums = t.track ? isDrumTrack(t.track) : false;
        if (delay) setField(ctx, t, 'delaySend', (c) => round2(clamp(num(c, 0) + 0.12 * ctx.amount, 0, 0.7)), 'more delay');
        else setField(ctx, t, 'reverbSend', (c) => round2(clamp(num(c, 0.15) + (drums ? 0.05 : 0.1) * ctx.amount, 0, 0.7)), 'more reverb');
      }
      if (!ctx.targets.length || ctx.overall) ctx.notes.push('The bass was kept dry so the low end stays tight.');
    },
  },
  {
    id: 'wider',
    re: /\bwid(er|en|th)\b|\bmore stereo\b|\bspread (out|wide)\b|\bbigger stereo\b/,
    apply: (ctx) => {
      const tgts = defaultTargets(ctx);
      const guitars = tgts.filter((t) => t.track && (/guitar/.test(t.track.instrumentId) || t.track.role === 'rhythm-guitar'));
      for (const t of tgts) setField(ctx, t, 'width', (c) => round2(clamp(num(c, 1) + 0.4 * ctx.amount, 0, 2)), 'wider stereo image');
      if (guitars.length >= 2) {
        guitars.forEach((g, i) => setField(ctx, g, 'pan', () => (i % 2 === 0 ? -0.7 : 0.7), 'double-tracked guitars panned left/right'));
        ctx.notes.push(`Panned ${listJoin(guitars.map((g) => g.name))} apart for a classic wide guitar wall.`);
      }
    },
  },
  {
    id: 'narrower',
    re: /\bnarrow(er)?\b|\bless wide\b|\bmono\b|\bmore focused\b/,
    apply: (ctx) => {
      for (const t of defaultTargets(ctx)) setField(ctx, t, 'width', (c) => round2(clamp(num(c, 1) - 0.4 * ctx.amount, 0, 2)), 'narrower stereo image');
    },
  },
  {
    id: 'mute',
    re: /\bun-?mute\b|\bmute\b/,
    apply: (ctx) => {
      const on = !/\bun-?mute\b/.test(ctx.text);
      for (const t of ctx.targets) if (t.id !== 'master') setField(ctx, t, 'mute', () => on, on ? 'muted' : 'unmuted');
    },
  },
  {
    id: 'solo',
    re: /\bun-?solo\b|\bsolo\b/,
    apply: (ctx) => {
      const on = !/\bun-?solo\b/.test(ctx.text);
      for (const t of ctx.targets) if (t.id !== 'master') setField(ctx, t, 'solo', () => on, on ? 'soloed' : 'un-soloed');
    },
  },
  {
    id: 'pan',
    re: /\bpan(ned)?\b[^,]*\b(hard )?(left|right|cent(er|re)|middle)\b|\b(to|on) the (left|right)\b/,
    apply: (ctx) => {
      const hard = /\bhard\b/.test(ctx.text) ? 1 : /\bslight(ly)?|a (little )?bit\b/.test(ctx.text) ? 0.25 : 0.5;
      const v = /\bleft\b/.test(ctx.text) ? -hard : /\bright\b/.test(ctx.text) ? hard : 0;
      for (const t of ctx.targets) if (t.id !== 'master') setField(ctx, t, 'pan', () => v, 'pan position');
    },
  },
  {
    id: 'harsh',
    re: /\bharsh(ness)?\b|\bsibilan(t|ce)\b|\bpiercing\b|\bshrill\b|\bbrittle\b|\bfatiguing\b|\btoo bright\b/,
    apply: (ctx) => {
      const tgts = ctx.targets.length ? ctx.targets : trackTargets(ctx.song, (t) => isVocalTrack(t) || /guitar|cymbal|synth-lead|violin/.test(t.instrumentId) || isDrumTrack(t));
      for (const t of tgts) {
        setField(ctx, t, 'eq.highMidHz', () => 3500, 'harshness region');
        setField(ctx, t, 'eq.highMidDb', (c) => clamp(num(c) - 2.5 * ctx.amount, -12, 9), 'tame 3–5 kHz harshness');
      }
    },
  },
  {
    id: 'brighter',
    re: /\bbright(er|en)?\b|\bmore (air|sparkle|top end|treble|highs)\b|\bcrisp(er)?\b|\bairier\b/,
    apply: (ctx) => {
      for (const t of defaultTargets(ctx)) {
        setField(ctx, t, 'eq.highShelfHz', () => 8000, 'air band');
        setField(ctx, t, 'eq.highShelfDb', (c) => clamp(num(c) + 2 * ctx.amount, -12, 12), 'more air/sparkle');
      }
    },
  },
  {
    id: 'warmer',
    re: /\b(dark(er|en)?|warm(er|th)?|less bright|dull(er)?|mellow(er)?|smooth(er)?|less (treble|highs))\b/,
    apply: (ctx) => {
      const warm = /\bwarm/.test(ctx.text);
      for (const t of defaultTargets(ctx)) {
        setField(ctx, t, 'eq.highShelfHz', () => 8000, 'air band');
        setField(ctx, t, 'eq.highShelfDb', (c) => clamp(num(c) - 2 * ctx.amount, -12, 12), 'softer top end');
        if (warm) {
          setField(ctx, t, 'eq.lowShelfHz', () => 200, 'warmth band');
          setField(ctx, t, 'eq.lowShelfDb', (c) => clamp(num(c) + 1.5 * ctx.amount, -12, 12), 'a little low-end warmth');
        }
      }
    },
  },
  {
    id: 'low-end',
    re: /\bmore (low[\s-]?end|bottom|weight|body|sub)\b|\bbass boost\b|\bfuller low end\b|\bless (low[\s-]?end|bottom|boom)\b|\bthinner\b/,
    apply: (ctx) => {
      const less = /\bless\b|\bthinner\b/.test(ctx.text);
      const tgts = ctx.targets.length ? ctx.targets : trackTargets(ctx.song, isBassTrack);
      for (const t of tgts.length ? tgts : [{ id: 'master', name: 'Master' }]) {
        setField(ctx, t, 'eq.lowShelfHz', () => 100, 'low-end band');
        setField(ctx, t, 'eq.lowShelfDb', (c) => clamp(num(c) + (less ? -2 : 2) * ctx.amount, -12, 12), less ? 'less low end' : 'more low end');
      }
    },
  },
  {
    id: 'compress',
    re: /\bcompress(ion|ed)?\b|\bglue\b|\bmore (consistent|even|controlled)\b|\bcontrol the dynamics\b|\bsquash(ed)?\b|\bless compress(ion|ed)?\b/,
    apply: (ctx) => {
      const less = /\bless compress|\bno compress|\bremove (the )?compress/.test(ctx.text);
      for (const t of defaultTargets(ctx)) {
        if (less) {
          setField(ctx, t, 'compressor.ratio', (c) => Math.max(1.5, num(c, 3) - 1.5), 'gentler compression');
          continue;
        }
        setField(ctx, t, 'compressor.enabled', () => true, 'compression');
        setField(ctx, t, 'compressor.ratio', (c) => clamp(Math.max(num(c, 3), 3) + (ctx.amount > 1 ? 2 : 0), 1, 20), 'controls dynamics');
        setField(ctx, t, 'compressor.thresholdDb', (c) => Math.min(num(c, -18), -18), 'threshold');
        setField(ctx, t, 'compressor.attackMs', () => 10, 'medium attack');
        setField(ctx, t, 'compressor.releaseMs', () => 120, 'musical release');
      }
    },
  },
  {
    id: 'drive',
    re: /\b(more )?(drive|distort(ion|ed)?|saturat(e|ion|ed)|grit(ty|tier)?|crunch(y|ier)?|dirt(y|ier)|edgier)\b|\bcleaner\b|\bless (distortion|drive|grit)\b/,
    apply: (ctx) => {
      const less = /\bcleaner\b|\bless (distortion|drive|grit)\b/.test(ctx.text);
      for (const t of defaultTargets(ctx)) setField(ctx, t, 'drive', (c) => round2(clamp(num(c, 0) + (less ? -0.2 : 0.2) * ctx.amount, 0, 1)), less ? 'less saturation' : 'more saturation/grit');
    },
  },
  {
    id: 'louder',
    re: /\blouder\b|\bturn\b[^,]*\bup\b|\bboost\b|\braise\b|\bincrease\b|\bup (the|by|\d)|\bmore (of the|volume)\b|\bmore \w+\b(?! (reverb|delay|echo|space|air|low|bottom|body|punch|impact|compression|drive|distortion|grit))|\+\s?\d+(\.\d+)?\s*db\b/,
    apply: (ctx) => {
      if (!ctx.targets.length) return;
      for (const t of ctx.targets) setField(ctx, t, 'volumeDb', (c) => r1(num(c, -6) + (ctx.db !== null ? Math.abs(ctx.db) : 2 * ctx.amount)), 'louder');
    },
  },
  {
    id: 'quieter',
    re: /\bquieter\b|\bsofter\b|\bturn\b[^,]*\bdown\b|\blower (the|it)\b|\breduce\b|\bdecrease\b|\bless (of the|volume)\b|\bdown (by|\d)|\bpull back\b|-\s?\d+(\.\d+)?\s*db\b/,
    apply: (ctx) => {
      if (!ctx.targets.length) return;
      for (const t of ctx.targets) setField(ctx, t, 'volumeDb', (c) => r1(num(c, -6) - (ctx.db !== null ? Math.abs(ctx.db) : 2 * ctx.amount)), 'quieter');
    },
  },
];

// ---------------------------------------------------------------------------
// Automation for section-scoped requests
// ---------------------------------------------------------------------------

/** Value of an automation lane at a tick (linear/step interpolation, held at the ends). */
function laneValueAt(points: { tick: number; value: number; curve?: 'linear' | 'step' }[], tick: number): number {
  const pts = [...points].sort((a, b) => a.tick - b.tick);
  if (!pts.length) return 0;
  if (tick <= pts[0].tick) return pts[0].value;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (tick >= a.tick && tick < b.tick) return a.curve === 'step' ? a.value : a.value + ((b.value - a.value) * (tick - a.tick)) / Math.max(1, b.tick - a.tick);
  }
  return pts[pts.length - 1].value;
}

function automationOps(
  song: Song,
  p: Plan,
  spans: SectionSpan[],
  reason: string,
  state: Map<string, Record<string, number | boolean>>,
): { ops: MusicOperation[]; staticChanges: Change[]; lines: string[] } {
  const ops: MusicOperation[] = [];
  const staticChanges: Change[] = [];
  const lines: string[] = [];
  const cur = current(song, p.target, state);
  const lastBar = sectionLayout(song).reduce((m, s) => Math.max(m, s.endBar), 0);
  for (const c of p.changes) {
    const param = c.field as AutomationParam;
    if (!AUTOMATABLE.has(param) || typeof c.value !== 'number') {
      staticChanges.push(c);
      continue;
    }
    const lane = song.automation.find((l) => l.target === p.target.id && l.param === param && l.enabled !== false);
    const staticBase = typeof cur[param] === 'number' ? (cur[param] as number) : 0;
    const raised = c.value;
    const delta = raised - staticBase;
    if (delta === 0) continue;
    // With existing automation, the base is the lane's value; the change is applied relative to it.
    const baseAt = (tick: number) => (lane ? laneValueAt(lane.points, tick) : staticBase);
    const points: { bar: number; beat: number; value: number }[] = [];
    for (const s of spans) {
      const startBar = s.startBar + 1;
      const endBar = s.endBar; // last bar of the section (1-based)
      const meterBeats = tickToBar(song, s.startTick).meter.numerator;
      const lastBeatBefore = s.startTick - Math.round((song.ppq * 4) / tickToBar(song, s.startTick).meter.denominator);
      const endTickLastBeat = barToTick(song, endBar) - Math.round((song.ppq * 4) / tickToBar(song, barToTick(song, endBar - 1)).meter.denominator);
      if (startBar > 1) points.push({ bar: startBar - 1, beat: meterBeats, value: round2(baseAt(lastBeatBefore)) });
      points.push({ bar: startBar, beat: 1, value: round2(baseAt(s.startTick) + delta) });
      const endMeter = tickToBar(song, barToTick(song, endBar - 1)).meter.numerator;
      points.push({ bar: endBar, beat: endMeter, value: round2(baseAt(endTickLastBeat) + delta) });
      if (endBar < lastBar) points.push({ bar: endBar + 1, beat: 1, value: round2(baseAt(s.endTick)) });
    }
    points.sort((a, b) => a.bar - b.bar || a.beat - b.beat);
    ops.push({ op: 'set_automation', track: p.target.id, param, points, reason });
    lines.push(`${describe(c.field, staticBase, raised)} during ${listJoin(spans.map((s) => `${s.section.name} (bars ${s.startBar + 1}–${s.endBar})`))}, ramping in over the last beat before it and back afterwards`);
  }
  return { ops, staticChanges, lines };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function interpretMixInstruction(song: Song, instruction: string, opts: { selection?: EditSelection } = {}): EditInterpretation {
  const text = normalizeText(instruction);
  const melody = findMelodyTrack(song);
  const state = new Map<string, Record<string, number | boolean>>();
  const intents: string[] = [];
  const ops: MusicOperation[] = [];
  const lines: string[] = [];
  const notes: string[] = [];
  const skipped = new Set<string>();
  const reason = instruction.trim();
  let prevTargets: Target[] | null = null;
  let missingAll: string | undefined;
  const missingIntents: string[] = [];
  let anyRule = false;
  for (const clause of splitClauses(text)) {
    const mentions = findTrackMentions(song, clause, { melodyTrack: melody });
    const resolved = resolveTargets(song, mentions, opts.selection);
    const { overall, missing } = resolved;
    let { targets, explicit } = resolved;
    if (missing && !targets.length) {
      // Understood, but the named track doesn't exist — still report what was asked for.
      missingAll = missing;
      const asked = RULES.filter((r) => r.id !== 'louder' && r.id !== 'quieter' && r.re.test(clause)).map((r) => r.id);
      if (!asked.length) {
        const level = RULES.find((r) => (r.id === 'louder' || r.id === 'quieter') && r.re.test(clause));
        if (level) asked.push(level.id);
      }
      missingIntents.push(...asked);
      continue;
    }
    if (!explicit && !overall && prevTargets) {
      targets = prevTargets;
      explicit = true;
    }
    const ctx: RuleCtx = {
      song,
      text: clause,
      amount: amountOf(clause),
      db: parseDb(clause),
      targets: overall && !explicit ? trackTargets(song, () => true) : targets,
      explicit,
      overall,
      plans: new Map(),
      notes,
      state,
    };
    const matched: string[] = [];
    let work = clause;
    for (const rule of RULES) {
      if (rule.id === 'louder' || rule.id === 'quieter') continue;
      const m = rule.re.exec(work);
      if (!m) continue;
      if (rule.id === 'warmer' && matched.includes('harsh')) continue;
      matched.push(rule.id);
      rule.apply(ctx);
      work = work.slice(0, m.index) + ' '.repeat(m[0].length) + work.slice(m.index + m[0].length);
    }
    if (!matched.length) {
      // Plain level changes only when nothing more specific was asked.
      for (const rule of RULES.filter((r) => r.id === 'louder' || r.id === 'quieter')) {
        if (rule.re.test(work) && ctx.targets.length) {
          matched.push(rule.id);
          rule.apply(ctx);
          break;
        }
      }
    }
    if (!matched.length) continue;
    anyRule = true;
    intents.push(...matched);
    if (explicit) prevTargets = ctx.targets;
    const sections = findSectionMentions(song, clause).flatMap((m) => m.sections);
    const spans = sectionLayout(song).filter((sp) => sections.some((x) => x.id === sp.section.id));
    for (const p of ctx.plans.values()) {
      if (p.target.id !== 'master' && isMixerLocked(song, p.target.id)) {
        skipped.add(p.target.name);
        continue;
      }
      const cur = current(song, p.target, state);
      let staticChanges = p.changes;
      if (spans.length && p.target.id !== 'master') {
        const auto = automationOps(song, p, spans, reason, state);
        ops.push(...auto.ops);
        if (auto.lines.length) lines.push(`${p.target.name}: ${auto.lines.join('; ')}.`);
        staticChanges = auto.staticChanges;
      }
      const changes: MixerChange = {};
      const descs: string[] = [];
      for (const c of staticChanges) {
        const before = cur[c.field as string];
        if (before === c.value) continue;
        (changes as Record<string, number | boolean>)[c.field] = c.value;
        descs.push(`${describe(c.field, before, c.value)} (${c.why})`);
      }
      if (Object.keys(changes).length) {
        ops.push({ op: 'set_mixer', track: p.target.id, changes, reason });
        lines.push(`${p.target.name}: ${descs.join('; ')}${spans.length ? ' — applies to the whole song (not automatable)' : ''}.`);
        state.set(p.target.id, { ...(state.get(p.target.id) ?? {}), ...(changes as Record<string, number | boolean>) });
      }
    }
  }
  if (!anyRule) {
    if (missingAll && missingIntents.length) return { operations: [], explanation: `There is no ${missingAll} track in this mix.`, intents: [...new Set(missingIntents)], understood: true };
    return {
      operations: [],
      explanation:
        `I couldn't map "${instruction.trim()}" to a mixer change. I can make a track clearer, bring it forward or push it back, make drums hit harder, reduce muddiness or harshness, make things drier/wetter, wider/narrower, brighter/warmer, add low end, compression or drive, change levels ("vocal up 2 dB"), pan, mute or solo — for the whole song or a section ("in the last chorus").`,
      intents: [],
      understood: false,
    };
  }
  const parts = [...lines, ...new Set(notes)];
  if (missingAll) parts.push(`There is no ${missingAll} track, so that part was skipped.`);
  if (skipped.size) parts.push(`Mixer settings of ${listJoin([...skipped])} are locked and were left unchanged.`);
  if (!ops.length && !skipped.size) parts.push('The mix already matches that request — nothing to change.');
  return { operations: ops, explanation: parts.join(' '), intents: [...new Set(intents)], understood: true };
}
