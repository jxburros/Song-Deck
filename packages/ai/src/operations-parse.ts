/**
 * parseOperations: flat LLM operation items → typed `MusicOperation`s (spec §46, §48).
 *
 * Every operation is validated individually: invalid operations are dropped and reported, never
 * applied. Tolerates messy model output: nulls for absent fields, numeric strings, pitch names,
 * `operation`/`type` instead of `op`, nested `region` objects or "17-24" ranges, snake/camel case,
 * op-name aliases, folded `params` lists and JSON embedded in prose.
 */
import {
  parseChordSymbol,
  parsePitch,
  pitchClassFromName,
  type Articulation,
  type AutomationParam,
  type MixerChange,
  type ModeName,
  type MusicalFunction,
  type MusicOperation,
  type NoteTransform,
  type OpChord,
  type OpNote,
  type OpRegion,
  type SectionFeel,
  type SectionKind,
  type TrackRole,
  type VariationLevel,
  type VocalExpression,
} from '@songdeck/core';
import {
  ARTICULATIONS,
  AUTOMATION_PARAMS,
  BOOLEAN_MIXER_PARAMS,
  MIXER_PARAMS,
  MODE_NAMES,
  MUSICAL_FUNCTIONS,
  ONSETS,
  OPERATION_ITEM_SCHEMA,
  OPERATION_NAMES,
  RELEASES,
  SECTION_FEELS,
  SECTION_KINDS,
  TRACK_ROLE_NAMES,
  VARIATION_LEVELS,
} from './schemas/canonical';
import { unfoldParams } from './schemas/dialects';
import { extractJson } from './schemas/extract';
import { clamp, isPlainObject } from './util';

export interface OperationParseError {
  /** Index of the item in the model output (-1 for envelope problems). */
  index: number;
  op?: string;
  message: string;
}

export interface ParseOperationsResult {
  operations: MusicOperation[];
  /** Dropped operations and envelope problems. */
  errors: OperationParseError[];
  /** Fixes applied to otherwise valid operations (clamped velocity, dropped invalid note…). */
  warnings: OperationParseError[];
  explanation?: string;
  confidence?: number;
}

export interface ParseOperationsOptions {
  /** Only these op types are accepted (e.g. mix assistant: set_mixer/set_automation). */
  allowedOps?: readonly MusicOperation['op'][];
  /** Default 200. */
  maxOperations?: number;
}

type OpName = MusicOperation['op'];
type Item = Record<string, unknown>;

const OP_ALIASES: Record<string, OpName> = {
  replace: 'replace_notes',
  rewrite_notes: 'replace_notes',
  write_notes: 'replace_notes',
  add: 'add_notes',
  insert_notes: 'add_notes',
  add_note: 'add_notes',
  delete: 'delete_notes',
  remove_notes: 'delete_notes',
  delete_note: 'delete_notes',
  transform: 'transform_notes',
  transpose: 'transform_notes',
  transpose_notes: 'transform_notes',
  quantize: 'transform_notes',
  modify_notes: 'transform_notes',
  chords: 'set_chords',
  set_chord: 'set_chords',
  replace_chords: 'set_chords',
  change_chords: 'set_chords',
  tempo: 'set_tempo',
  change_tempo: 'set_tempo',
  key: 'set_key',
  change_key: 'set_key',
  modulate: 'set_key',
  meter: 'set_meter',
  time_signature: 'set_meter',
  set_time_signature: 'set_meter',
  section: 'update_section',
  edit_section: 'update_section',
  add_section: 'insert_section',
  delete_section: 'remove_section',
  reorder_section: 'move_section',
  lyrics: 'set_lyrics',
  write_lyrics: 'set_lyrics',
  mixer: 'set_mixer',
  mix: 'set_mixer',
  automation: 'set_automation',
  add_automation: 'set_automation',
  expression: 'set_expression',
  vocal_expression: 'set_expression',
  new_track: 'add_track',
  delete_track: 'remove_track',
  change_instrument: 'set_instrument',
  macros: 'set_macros',
  lock: 'set_lock',
  regen: 'regenerate',
  regenerate_region: 'regenerate',
};

const OP_SET = new Set<string>(OPERATION_NAMES);

function normalizeOpName(raw: unknown): OpName | undefined {
  if (typeof raw !== 'string') return undefined;
  const k = raw
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (OP_SET.has(k)) return k as OpName;
  return OP_ALIASES[k];
}

const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Recursively drop nulls and convert camelCase keys to snake_case (the canonical item shape). */
function normalizeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map(normalizeKeys);
  if (!isPlainObject(v)) return v;
  const out: Item = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === null || val === undefined) continue;
    const key = k === 'durationBeats' ? 'duration_beats' : snake(k);
    out[key] = normalizeKeys(val);
  }
  return out;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const t = v.trim().replace(/(bpm|db|hz|ms|%)$/i, '').trim();
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function int(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n);
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === 'string') {
    if (/^(true|yes|on|1)$/i.test(v.trim())) return true;
    if (/^(false|no|off|0)$/i.test(v.trim())) return false;
  }
  return undefined;
}

function strList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.map(str).filter((s): s is string => !!s);
    return out;
  }
  if (typeof v === 'string') return v.split(/\s*[,;\n]\s*/).filter(Boolean);
  return undefined;
}

const normEnum = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');

function enumValue<T extends string>(v: unknown, values: readonly T[], aliases: Record<string, T> = {}): T | undefined {
  if (typeof v !== 'string') return undefined;
  const n = normEnum(v);
  return values.find((x) => normEnum(x) === n) ?? aliases[n];
}

const MODE_ALIASES: Record<string, ModeName> = { ionian: 'major', aeolian: 'minor', maj: 'major', min: 'minor', m: 'minor', 'natural-minor': 'minor' };
const KIND_ALIASES: Record<string, SectionKind> = { prechorus: 'pre-chorus', 'pre chorus': 'pre-chorus', refrain: 'chorus', hook: 'chorus', 'final chorus': 'final-chorus', instrumental: 'interlude', coda: 'outro' };
const ROLE_ALIASES: Record<string, TrackRole> = {
  guitar: 'rhythm-guitar',
  'guitars': 'rhythm-guitar',
  'lead': 'lead-guitar',
  piano: 'keys',
  keyboard: 'keys',
  pad: 'synth-pad',
  arp: 'synth-arp',
  vocals: 'vocal',
  voice: 'vocal',
  drum: 'drums',
  perc: 'percussion',
};

class ItemParser {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  constructor(readonly item: Item) {}

  fail(message: string): undefined {
    this.errors.push(message);
    return undefined;
  }

  track(required = true): string | undefined {
    const t = str(this.item.track ?? this.item.track_id ?? this.item.track_name ?? this.item.target);
    if (!t && required) this.fail('missing "track"');
    return t;
  }

  section(required = true): string | undefined {
    const raw = this.item.section ?? this.item.section_id ?? this.item.section_name;
    const s = typeof raw === 'object' ? undefined : str(raw);
    if (!s && required) this.fail('missing "section"');
    return s;
  }

  region(required: boolean): OpRegion | undefined {
    const it = this.item;
    let start: number | undefined;
    let end: number | undefined;
    const region = it.region;
    if (isPlainObject(region)) {
      start = int(region.start_bar ?? region.start ?? region.from);
      end = int(region.end_bar ?? region.end ?? region.to);
    } else if (typeof region === 'string') {
      const m = /(\d+)\s*(?:-|–|to|\.\.)\s*(\d+)/.exec(region);
      if (m) {
        start = Number(m[1]);
        end = Number(m[2]);
      } else start = end = int(region);
    }
    start = start ?? int(it.start_bar ?? it.region_start_bar ?? it.from_bar ?? it.bar_start);
    end = end ?? int(it.end_bar ?? it.region_end_bar ?? it.to_bar ?? it.bar_end);
    if (start === undefined && end === undefined && typeof it.bars === 'string') {
      const m = /(\d+)\s*(?:-|–|to|\.\.)\s*(\d+)/.exec(it.bars);
      if (m) {
        start = Number(m[1]);
        end = Number(m[2]);
      }
    }
    if (start === undefined && end === undefined) {
      if (required) this.fail('missing region (start_bar/end_bar)');
      return undefined;
    }
    if (start === undefined) start = end;
    if (end === undefined) end = start;
    if (start! < 1 || end! < 1) return this.fail(`region bars are 1-based (got ${start}-${end})`);
    if (end! < start!) {
      this.warnings.push(`swapped reversed region ${start}-${end}`);
      [start, end] = [end, start];
    }
    return { start_bar: start!, end_bar: end! };
  }

  noteIds(): string[] | undefined {
    const ids = strList(this.item.note_ids ?? this.item.notes_ids ?? this.item.ids);
    return ids && ids.length ? ids : undefined;
  }

  note(raw: unknown, idx: number): OpNote | undefined {
    if (!isPlainObject(raw)) {
      this.warnings.push(`note ${idx}: not an object (dropped)`);
      return undefined;
    }
    const pitchRaw = raw.pitch ?? raw.note ?? raw.midi ?? raw.name;
    const pitch = typeof pitchRaw === 'number' || typeof pitchRaw === 'string' ? parsePitch(pitchRaw as number | string) : null;
    const bar = int(raw.bar);
    const beat = num(raw.beat ?? 1);
    const dur = num(raw.duration_beats ?? raw.duration ?? raw.length ?? raw.beats);
    const problems: string[] = [];
    if (pitch === null || pitch < 0 || pitch > 127) problems.push(`invalid pitch ${JSON.stringify(pitchRaw)}`);
    if (bar === undefined || bar < 1) problems.push(`invalid bar ${JSON.stringify(raw.bar)} (1-based)`);
    if (beat === undefined || beat < 1) problems.push(`invalid beat ${JSON.stringify(raw.beat)} (1-based)`);
    if (dur === undefined || dur <= 0) problems.push(`invalid duration ${JSON.stringify(raw.duration_beats ?? raw.duration)}`);
    if (problems.length) {
      this.warnings.push(`note ${idx}: ${problems.join(', ')} (dropped)`);
      return undefined;
    }
    const note: OpNote = { pitch: pitch!, bar: bar!, beat: beat!, duration_beats: dur! };
    const vel = num(raw.velocity ?? raw.vel);
    if (vel !== undefined) {
      const v = clamp(Math.round(vel), 1, 127);
      if (v !== vel) this.warnings.push(`note ${idx}: velocity ${vel} clamped to ${v}`);
      note.velocity = v;
    }
    if (raw.articulation !== undefined) {
      const a = enumValue<Articulation>(raw.articulation, ARTICULATIONS);
      if (a) note.articulation = a;
      else this.warnings.push(`note ${idx}: unknown articulation ${JSON.stringify(raw.articulation)} ignored`);
    }
    const syl = typeof raw.syllable === 'string' ? raw.syllable : typeof raw.lyric === 'string' ? raw.lyric : undefined;
    if (syl) note.syllable = syl;
    if (isPlainObject(raw.expression)) {
      const e = this.expression(raw.expression);
      if (e) note.expression = e;
    }
    return note;
  }

  notes(required: boolean, allowEmpty: boolean): OpNote[] | undefined {
    const raw = this.item.notes;
    if (raw === undefined) {
      if (required) this.fail('missing "notes"');
      return undefined;
    }
    if (!Array.isArray(raw)) return this.fail('"notes" must be a list');
    const notes = raw.map((n, i) => this.note(n, i)).filter((n): n is OpNote => !!n);
    if (!notes.length && raw.length) return this.fail('no valid notes');
    if (!notes.length && !allowEmpty) return this.fail('"notes" is empty');
    return notes;
  }

  expression(raw: unknown): VocalExpression | undefined {
    if (!isPlainObject(raw)) return undefined;
    const e: VocalExpression = {};
    const unit = (k: string) => {
      const v = num(raw[k]);
      return v === undefined ? undefined : clamp(v, 0, 1);
    };
    const b = unit('breathiness');
    if (b !== undefined) e.breathiness = b;
    const t = unit('tension');
    if (t !== undefined) e.tension = t;
    const v = unit('vibrato');
    if (v !== undefined) e.vibrato = v;
    const vr = num(raw.vibrato_rate);
    if (vr !== undefined) e.vibratoRate = clamp(vr, 0, 12);
    const en = unit('energy');
    if (en !== undefined) e.energy = en;
    const onset = enumValue(raw.onset, ONSETS);
    if (onset) e.onset = onset;
    const release = enumValue(raw.release, RELEASES);
    if (release) e.release = release;
    return Object.keys(e).length ? e : undefined;
  }

  transform(raw: unknown): NoteTransform | undefined {
    const src = isPlainObject(raw) ? raw : {};
    const t: NoteTransform = {};
    const set = <K extends keyof NoteTransform>(k: K, v: NoteTransform[K] | undefined) => {
      if (v !== undefined) t[k] = v;
    };
    set('transpose', int(src.transpose ?? src.semitones ?? this.item.transpose ?? this.item.semitones));
    set('transpose_diatonic', int(src.transpose_diatonic ?? src.steps));
    set('velocity_scale', num(src.velocity_scale));
    set('velocity_add', int(src.velocity_add));
    set('time_shift_beats', num(src.time_shift_beats ?? src.shift_beats));
    set('duration_scale', num(src.duration_scale));
    set('quantize_beats', num(src.quantize_beats ?? src.quantize ?? this.item.quantize_beats));
    const qs = num(src.quantize_strength);
    if (qs !== undefined) t.quantize_strength = clamp(qs, 0, 1);
    const h = num(src.humanize);
    if (h !== undefined) t.humanize = clamp(h, 0, 1);
    const a = enumValue<Articulation>(src.articulation, ARTICULATIONS);
    if (a) t.articulation = a;
    return Object.keys(t).length ? t : undefined;
  }

  mixerChanges(): MixerChange | undefined {
    const changes: Record<string, number | boolean> = {};
    const add = (paramRaw: unknown, valueRaw: unknown) => {
      if (typeof paramRaw !== 'string') return;
      const param = MIXER_PARAMS.find((p) => p.toLowerCase() === paramRaw.trim().toLowerCase() || snake(p) === paramRaw.trim().toLowerCase());
      if (!param) {
        this.warnings.push(`unknown mixer parameter ${JSON.stringify(paramRaw)} ignored`);
        return;
      }
      if ((BOOLEAN_MIXER_PARAMS as readonly string[]).includes(param)) {
        const b = bool(valueRaw);
        if (b === undefined) this.warnings.push(`mixer ${param}: expected on/off`);
        else changes[param] = b;
        return;
      }
      const n = num(valueRaw);
      if (n === undefined) {
        this.warnings.push(`mixer ${param}: invalid value ${JSON.stringify(valueRaw)}`);
        return;
      }
      changes[param] = clampMixer(param, n);
    };
    const list = this.item.mixer ?? this.item.mixer_changes;
    if (Array.isArray(list)) for (const c of list) if (isPlainObject(c)) add(c.param ?? c.name ?? c.parameter, c.value);
    const obj = this.item.changes ?? (isPlainObject(this.item.mixer) ? this.item.mixer : undefined);
    if (isPlainObject(obj)) for (const [k, v] of Object.entries(obj)) add(k, v);
    return Object.keys(changes).length ? (changes as MixerChange) : undefined;
  }

  macros(): Partial<Record<string, number>> | undefined {
    const raw = this.item.macros;
    if (!isPlainObject(raw)) return undefined;
    const map: Record<string, string> = {
      complexity: 'complexity',
      energy: 'energy',
      density: 'density',
      humanization: 'humanization',
      melodic_movement: 'melodicMovement',
      harmonic_tension: 'harmonicTension',
      repetition: 'repetition',
      syncopation: 'syncopation',
      dynamics: 'dynamics',
    };
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      const target = map[snake(k)];
      const n = num(v);
      if (!target) {
        this.warnings.push(`unknown macro ${k} ignored`);
        continue;
      }
      if (n === undefined) continue;
      out[target] = clamp(n > 1 && n <= 100 ? n / 100 : n, 0, 1);
    }
    return Object.keys(out).length ? out : undefined;
  }
}

function clampMixer(param: string, v: number): number {
  if (param === 'volumeDb') return clamp(v, -96, 12);
  if (param === 'pan') return clamp(v > 1 || v < -1 ? v / 100 : v, -1, 1);
  if (param === 'reverbSend' || param === 'delaySend' || param === 'drive') return clamp(v > 1 ? v / 100 : v, 0, 1);
  if (param === 'width') return clamp(v, 0, 2);
  if (/Db$/.test(param) && param.startsWith('eq.')) return clamp(v, -24, 24);
  if (/Hz$/.test(param)) return clamp(v, 0, 22000);
  if (param === 'compressor.ratio') return clamp(v, 1, 40);
  return v;
}

function parseItem(item: Item): { op?: MusicOperation; errors: string[]; warnings: string[]; name?: string } {
  const p = new ItemParser(item);
  const name = normalizeOpName(item.op ?? item.operation ?? item.type ?? item.action);
  if (!name) return { errors: [`unknown operation ${JSON.stringify(item.op ?? item.operation ?? item.type ?? null)}`], warnings: [] };
  const reason = str(item.reason);
  let op: MusicOperation | undefined;
  switch (name) {
    case 'replace_notes': {
      const track = p.track();
      const region = p.region(true);
      const notes = p.notes(true, true);
      if (track && region && notes) {
        const outside = notes.filter((n) => n.bar < region.start_bar || n.bar > region.end_bar);
        if (outside.length) p.warnings.push(`${outside.length} note(s) outside region ${region.start_bar}-${region.end_bar}`);
        op = { op: name, track, region, notes };
      }
      break;
    }
    case 'add_notes': {
      const track = p.track();
      const notes = p.notes(true, false);
      if (track && notes) op = { op: name, track, notes };
      break;
    }
    case 'delete_notes': {
      const track = p.track();
      const region = p.region(false);
      const note_ids = p.noteIds();
      const lo = item.pitch_low ?? (Array.isArray(item.pitch_range) ? item.pitch_range[0] : undefined);
      const hi = item.pitch_high ?? (Array.isArray(item.pitch_range) ? item.pitch_range[1] : undefined);
      const pl = lo !== undefined ? parsePitch(lo as number | string) : null;
      const ph = hi !== undefined ? parsePitch(hi as number | string) : null;
      if (track) {
        if (!region && !note_ids && pl === null && ph === null) p.fail('delete_notes needs a region, note_ids or a pitch range');
        else {
          const o: Extract<MusicOperation, { op: 'delete_notes' }> = { op: name, track };
          if (region) o.region = region;
          if (note_ids) o.note_ids = note_ids;
          if (pl !== null || ph !== null) o.pitch_range = [pl ?? 0, ph ?? 127];
          op = o;
        }
      }
      break;
    }
    case 'transform_notes': {
      const track = p.track();
      const transform = p.transform(item.transform);
      const region = p.region(false);
      const note_ids = p.noteIds();
      if (!transform) p.fail('transform_notes needs a transform');
      if (track && transform) {
        const o: Extract<MusicOperation, { op: 'transform_notes' }> = { op: name, track, transform };
        if (region) o.region = region;
        if (note_ids) o.note_ids = note_ids;
        op = o;
      }
      break;
    }
    case 'set_chords': {
      const raw = item.chords;
      let chords: OpChord[] = [];
      if (!Array.isArray(raw)) p.fail('missing "chords"');
      else {
        chords = raw
          .map((c, i) => {
            if (!isPlainObject(c)) return undefined;
            const symbol = str(c.symbol ?? c.chord ?? c.name);
            const bar = int(c.bar);
            const beat = num(c.beat ?? 1);
            const dur = num(c.duration_beats ?? c.duration ?? c.beats);
            if (!symbol || !parseChordSymbol(symbol)) {
              p.warnings.push(`chord ${i}: invalid symbol ${JSON.stringify(c.symbol ?? null)} (dropped)`);
              return undefined;
            }
            if (bar === undefined || bar < 1 || beat === undefined || beat < 1 || dur === undefined || dur <= 0) {
              p.warnings.push(`chord ${i}: invalid position/duration (dropped)`);
              return undefined;
            }
            return { bar, beat, symbol, duration_beats: dur } as OpChord;
          })
          .filter((c): c is OpChord => !!c);
        if (!chords.length) p.fail('no valid chords');
      }
      let region = p.region(false);
      if (!region && chords.length) {
        region = { start_bar: Math.min(...chords.map((c) => c.bar)), end_bar: Math.max(...chords.map((c) => c.bar)) };
        p.warnings.push('region inferred from chord positions');
      }
      if (region && chords.length) op = { op: name, region, chords };
      break;
    }
    case 'set_tempo': {
      const bpm = num(item.bpm ?? item.tempo);
      if (bpm === undefined) p.fail('missing "bpm"');
      else if (bpm < 20 || bpm > 400) p.fail(`bpm ${bpm} out of range 20..400`);
      else {
        const o: Extract<MusicOperation, { op: 'set_tempo' }> = { op: name, bpm };
        const at = int(item.at_bar ?? item.bar);
        if (at !== undefined && at >= 1) o.at_bar = at;
        op = o;
      }
      break;
    }
    case 'set_key': {
      let tonic = str(item.tonic ?? item.key_tonic ?? item.root);
      let mode = enumValue<ModeName>(item.mode, MODE_NAMES, MODE_ALIASES);
      const keyStr = str(item.key);
      if ((!tonic || !mode) && keyStr) {
        const m = /^\s*([A-Ga-g](?:#|b|♯|♭)?)\s*(.*)$/.exec(keyStr);
        if (m) {
          tonic = tonic ?? m[1];
          mode = mode ?? enumValue<ModeName>(m[2] || 'major', MODE_NAMES, MODE_ALIASES);
        }
      }
      if (!tonic || pitchClassFromName(tonic) === null) p.fail(`invalid tonic ${JSON.stringify(item.tonic ?? null)}`);
      else if (!mode) p.fail(`invalid mode ${JSON.stringify(item.mode ?? null)}`);
      else {
        const o: Extract<MusicOperation, { op: 'set_key' }> = { op: name, tonic, mode };
        const at = int(item.at_bar);
        if (at !== undefined && at >= 1) o.at_bar = at;
        const tn = bool(item.transpose_notes);
        if (tn !== undefined) o.transpose_notes = tn;
        op = o;
      }
      break;
    }
    case 'set_meter': {
      const numerator = int(item.numerator);
      const denominator = int(item.denominator);
      if (numerator === undefined || numerator < 1 || numerator > 32) p.fail('invalid numerator');
      else if (denominator === undefined || ![1, 2, 4, 8, 16, 32].includes(denominator)) p.fail('invalid denominator');
      else {
        const o: Extract<MusicOperation, { op: 'set_meter' }> = { op: name, numerator, denominator };
        const at = int(item.at_bar);
        if (at !== undefined && at >= 1) o.at_bar = at;
        op = o;
      }
      break;
    }
    case 'update_section': {
      const section = p.section();
      const src: Item = isPlainObject(item.changes) ? { ...item, ...item.changes } : item;
      const changes: Extract<MusicOperation, { op: 'update_section' }>['changes'] = {};
      const nm = str(src.name ?? src.new_name);
      if (nm) changes.name = nm;
      if (src.kind !== undefined) {
        const k = enumValue<SectionKind>(src.kind, SECTION_KINDS, KIND_ALIASES);
        if (k) changes.kind = k;
        else p.warnings.push(`unknown section kind ${JSON.stringify(src.kind)} ignored`);
      }
      const bars = int(src.bars);
      if (bars !== undefined) {
        if (bars >= 1 && bars <= 256) changes.bars = bars;
        else p.warnings.push(`invalid bars ${bars} ignored`);
      }
      const energy = num(src.energy);
      if (energy !== undefined) changes.energy = clamp(energy, 0, 100);
      const energyEnd = num(src.energy_end);
      if (energyEnd !== undefined) changes.energyEnd = clamp(energyEnd, 0, 100);
      const purpose = str(src.purpose);
      if (purpose) changes.purpose = purpose;
      const mood = strList(src.mood);
      if (mood?.length) changes.mood = mood;
      if (src.feel !== undefined) {
        const f = enumValue<SectionFeel>(src.feel, SECTION_FEELS);
        if (f) changes.feel = f;
      }
      const progression = strList(src.progression);
      if (progression?.length) changes.progression = progression;
      if (section) {
        if (!Object.keys(changes).length) p.fail('update_section has no changes');
        else op = { op: name, section, changes };
      }
      break;
    }
    case 'insert_section': {
      const spec = isPlainObject(item.section) ? (item.section as Item) : item;
      const sname = str(spec.name ?? item.name);
      const kind = enumValue<SectionKind>(spec.kind ?? item.kind, SECTION_KINDS, KIND_ALIASES);
      const bars = int(spec.bars ?? item.bars);
      if (!sname) p.fail('insert_section needs a name');
      else if (!kind) p.fail('insert_section needs a valid kind');
      else if (bars === undefined || bars < 1 || bars > 256) p.fail('insert_section needs bars >= 1');
      else {
        const section: Extract<MusicOperation, { op: 'insert_section' }>['section'] = { name: sname, kind, bars };
        const energy = num(spec.energy ?? item.energy);
        if (energy !== undefined) section.energy = clamp(energy, 0, 100);
        const purpose = str(spec.purpose ?? item.purpose);
        if (purpose) section.purpose = purpose;
        const o: Extract<MusicOperation, { op: 'insert_section' }> = { op: name, section };
        const after = str(item.after ?? item.after_section ?? (typeof item.section === 'string' ? item.section : undefined));
        if (after) o.after = after;
        const copy = str(item.copy_from);
        if (copy) o.copy_from = copy;
        op = o;
      }
      break;
    }
    case 'remove_section': {
      const section = p.section();
      if (section) op = { op: name, section };
      break;
    }
    case 'move_section': {
      const section = p.section();
      const to = int(item.to_index ?? item.index ?? item.position);
      if (to === undefined || to < 0) p.fail('move_section needs to_index >= 0');
      else if (section) op = { op: name, section, to_index: to };
      break;
    }
    case 'set_lyrics': {
      const section = p.section();
      const lines = Array.isArray(item.lines) ? item.lines.map((l) => (typeof l === 'string' ? l : str(l) ?? '')).filter((l) => l !== '') : typeof item.lines === 'string' ? item.lines.split(/\n/).map((l) => l.trim()).filter(Boolean) : undefined;
      if (!lines) p.fail('set_lyrics needs "lines"');
      else if (section) op = { op: name, section, lines };
      break;
    }
    case 'set_mixer': {
      const track = p.track();
      const changes = p.mixerChanges();
      if (!changes) p.fail('set_mixer has no valid mixer changes');
      else if (track) op = { op: name, track, changes };
      break;
    }
    case 'set_automation': {
      const track = p.track();
      const param = enumValue<AutomationParam>(item.param ?? item.parameter, AUTOMATION_PARAMS) ?? (AUTOMATION_PARAMS.find((x) => x.toLowerCase() === String(item.param ?? '').toLowerCase()) as AutomationParam | undefined);
      const pts = Array.isArray(item.points)
        ? item.points
            .map((pt) => (isPlainObject(pt) ? { bar: int(pt.bar), beat: num(pt.beat ?? 1), value: num(pt.value) } : undefined))
            .filter((pt): pt is { bar: number; beat: number; value: number } => !!pt && pt.bar !== undefined && pt.bar >= 1 && pt.beat !== undefined && pt.beat >= 1 && pt.value !== undefined)
        : [];
      if (!param) p.fail(`invalid automation param ${JSON.stringify(item.param ?? null)}`);
      else if (!pts.length) p.fail('set_automation needs points');
      else if (track) op = { op: name, track, param, points: pts };
      break;
    }
    case 'set_expression': {
      const track = p.track();
      const expression = p.expression(item.expression ?? item);
      if (!expression) p.fail('set_expression needs expression values');
      else if (track) {
        const o: Extract<MusicOperation, { op: 'set_expression' }> = { op: name, track, expression };
        const region = p.region(false);
        if (region) o.region = region;
        const ids = p.noteIds();
        if (ids) o.note_ids = ids;
        op = o;
      }
      break;
    }
    case 'add_track': {
      const tname = str(item.name ?? item.track_name ?? item.track);
      const instrument = str(item.instrument_id ?? item.instrument);
      const role = enumValue<TrackRole>(item.role, TRACK_ROLE_NAMES, ROLE_ALIASES);
      if (!tname) p.fail('add_track needs a name');
      else if (!instrument) p.fail('add_track needs instrument_id');
      else if (!role) p.fail(`add_track needs a valid role (got ${JSON.stringify(item.role ?? null)})`);
      else {
        const o: Extract<MusicOperation, { op: 'add_track' }> = { op: name, name: tname, instrument_id: instrument, role };
        const fn = enumValue<MusicalFunction>(item.function, MUSICAL_FUNCTIONS);
        if (fn) o.function = fn;
        op = o;
      }
      break;
    }
    case 'remove_track': {
      const track = p.track();
      if (track) op = { op: name, track };
      break;
    }
    case 'set_instrument': {
      const track = p.track();
      const instrument = str(item.instrument_id ?? item.instrument);
      if (!instrument) p.fail('set_instrument needs instrument_id');
      else if (track) op = { op: name, track, instrument_id: instrument };
      break;
    }
    case 'set_macros': {
      const macros = p.macros();
      if (!macros) p.fail('set_macros needs macro values');
      else {
        const o: Extract<MusicOperation, { op: 'set_macros' }> = { op: name, macros };
        const track = p.track(false);
        if (track) o.track = track;
        op = o;
      }
      break;
    }
    case 'set_lock': {
      const key = str(item.key ?? item.lock);
      const locked = bool(item.locked ?? item.value);
      if (!key) p.fail('set_lock needs a key');
      else if (locked === undefined) p.fail('set_lock needs locked true/false');
      else op = { op: name, key, locked };
      break;
    }
    case 'regenerate': {
      const o: Extract<MusicOperation, { op: 'regenerate' }> = { op: name };
      const track = p.track(false);
      if (track) o.track = track;
      const region = p.region(false);
      if (region) o.region = region;
      const sections = strList(item.sections);
      if (sections?.length) o.sections = sections;
      const level = enumValue<VariationLevel>(item.level, VARIATION_LEVELS);
      if (level) o.level = level;
      const seed = int(item.seed);
      if (seed !== undefined) o.seed = seed >>> 0;
      op = o;
      break;
    }
  }
  if (op && reason) (op as { reason?: string }).reason = reason;
  if (p.errors.length) return { errors: p.errors, warnings: p.warnings, name };
  return { op, errors: op ? [] : ['invalid operation'], warnings: p.warnings, name };
}

/** Pull the operation list (and explanation/confidence) out of whatever envelope the model used. */
function envelope(json: unknown): { items: unknown[]; explanation?: string; confidence?: number; error?: string } {
  if (typeof json === 'string') {
    const ex = extractJson(json);
    if (!ex.ok) return { items: [], error: ex.error };
    return envelope(ex.value);
  }
  if (Array.isArray(json)) return { items: json };
  if (!isPlainObject(json)) return { items: [], error: 'Model output is not an object or list' };
  const explanation = str(json.explanation ?? json.summary ?? json.answer);
  const confRaw = num(json.confidence);
  const confidence = confRaw === undefined ? undefined : clamp(confRaw > 1 && confRaw <= 100 ? confRaw / 100 : confRaw, 0, 1);
  const list = json.operations ?? json.ops ?? json.changes ?? json.edits ?? json.actions;
  if (Array.isArray(list)) return { items: list, explanation, confidence };
  if (json.op !== undefined || json.operation !== undefined) return { items: [json], explanation, confidence };
  return { items: [], explanation, confidence };
}

export function parseOperations(json: unknown, opts: ParseOperationsOptions = {}): ParseOperationsResult {
  const env = envelope(json);
  const result: ParseOperationsResult = { operations: [], errors: [], warnings: [] };
  if (env.explanation) result.explanation = env.explanation;
  if (env.confidence !== undefined) result.confidence = env.confidence;
  if (env.error) result.errors.push({ index: -1, message: env.error });
  const max = opts.maxOperations ?? 200;
  if (env.items.length > max) result.errors.push({ index: -1, message: `too many operations (${env.items.length}); only the first ${max} were read` });
  const allowed = opts.allowedOps ? new Set<string>(opts.allowedOps) : undefined;
  env.items.slice(0, max).forEach((raw, index) => {
    const normalized = normalizeKeys(unfoldParams(raw, OPERATION_ITEM_SCHEMA));
    if (!isPlainObject(normalized)) {
      result.errors.push({ index, message: 'operation is not an object' });
      return;
    }
    const parsed = parseItem(normalized);
    for (const w of parsed.warnings) result.warnings.push({ index, op: parsed.name, message: w });
    if (!parsed.op) {
      for (const e of parsed.errors) result.errors.push({ index, op: parsed.name, message: e });
      return;
    }
    if (allowed && !allowed.has(parsed.op.op)) {
      result.errors.push({ index, op: parsed.op.op, message: `operation "${parsed.op.op}" is not allowed here` });
      return;
    }
    result.operations.push(parsed.op);
  });
  return result;
}

/** One-line description of parse problems (for repair prompts and UI). */
export function describeOperationErrors(errors: readonly OperationParseError[]): string[] {
  return errors.map((e) => `${e.index >= 0 ? `operation ${e.index}` : 'output'}${e.op ? ` (${e.op})` : ''}: ${e.message}`);
}
