/**
 * LLMCompositionProvider — implements CompositionProvider (spec §58) over ANY LLMProvider:
 * prompt templates + canonical schemas + tolerant parsing + one automatic JSON repair retry.
 * Model output always passes through validation; invalid parts are reported, never applied.
 */
import {
  defaultMacros,
  formatChordSymbol,
  noteNameToMidi,
  parseChordSymbol,
  parseKey,
  parseRoman,
  pitchClassFromName,
  romanToChord,
  type Blueprint,
  type BlueprintSection,
  type BlueprintTrack,
  type CompositionPlan,
  type KeySignature,
  type MacroSettings,
  type ModeName,
  type MusicalFunction,
  type MusicOperation,
  type PlanSection,
  type SectionFeel,
  type SectionKind,
  type TrackRole,
  type VocalMode,
  type VoiceType,
} from '@songdeck/core';
import { ProviderError } from './errors';
import { describeOperationErrors, parseOperations, type OperationParseError } from './operations-parse';
import {
  analyzeMusicPrompt,
  chatPrompt,
  designBlueprintPrompt,
  explainMusicPrompt,
  generateLyricsPrompt,
  mixAssistPrompt,
  modifyCompositionPrompt,
  planSongPrompt,
  repairPrompt,
} from './prompts/templates';
import {
  AVOID_RULES,
  CANONICAL_SCHEMAS,
  MODE_NAMES,
  MUSICAL_FUNCTIONS,
  SECTION_FEELS,
  SECTION_KINDS,
  TRACK_ROLE_NAMES,
  VOCAL_MODES,
  VOICE_TYPES,
  type CanonicalSchemaName,
} from './schemas/canonical';
import { unfoldParams } from './schemas/dialects';
import { extractJson } from './schemas/extract';
import { formatSchemaIssues, validateJson } from './schemas/validate';
import type {
  AnalyzeMusicRequest,
  AnalyzeMusicResult,
  CallMeta,
  ChatMessage,
  ChatRequest,
  ChatResult,
  CompositionProvider,
  ContentPart,
  DesignBlueprintRequest,
  DesignBlueprintResult,
  ExplainMusicRequest,
  ExplainMusicResult,
  GenerateLyricsRequest,
  GenerateLyricsResult,
  LLMProvider,
  LLMResponse,
  MixAssistRequest,
  MixAssistResult,
  ModifyCompositionRequest,
  ModifyCompositionResult,
  PlanSongRequest,
  PlanSongResult,
  RequestHints,
  TaskRole,
} from './types';
import { clamp, isPlainObject } from './util';

export type CompositionTask = 'plan' | 'blueprint' | 'modify' | 'analyze' | 'explain' | 'lyrics' | 'chat' | 'mix';

export interface LLMCompositionOptions {
  providerId?: string;
  /** Model used when a request does not name one. */
  model?: string;
  /** Max output tokens per task. */
  maxTokens?: Partial<Record<CompositionTask, number>>;
  /** Only sent when set (many current models reject sampling parameters). */
  temperature?: number;
  /** Automatic JSON repair retry (default true). */
  repair?: boolean;
}

export const DEFAULT_TASK_MAX_TOKENS: Record<CompositionTask, number> = {
  plan: 4096,
  blueprint: 4096,
  modify: 8192,
  analyze: 2048,
  explain: 2048,
  lyrics: 2048,
  chat: 4096,
  mix: 2048,
};

interface DomainParse<T> {
  value?: T;
  /** Problems worth one repair retry. */
  problems: string[];
}

const TASK_ROLE: Record<CompositionTask, TaskRole> = {
  plan: 'composition',
  blueprint: 'composition',
  modify: 'midi-editing',
  analyze: 'analysis',
  explain: 'analysis',
  lyrics: 'lyrics',
  chat: 'chat',
  mix: 'mixing',
};

interface StructuredCall<T> {
  task: CompositionTask;
  hints?: RequestHints;
  system: string;
  user: string | ContentPart[];
  history?: ChatMessage[];
  schemaName: CanonicalSchemaName;
  model?: string;
  signal?: AbortSignal;
  parse: (value: unknown) => DomainParse<T>;
  /**
   * Run generic schema validation/coercion before `parse` (default true). Operation-bearing
   * outputs skip it: parseOperations validates per operation and tolerates more shapes
   * (e.g. `operation` instead of `op`, nested `region` objects) than a closed schema would.
   */
  validate?: boolean;
}

function addUsage(meta: CallMeta, res: LLMResponse): void {
  meta.calls = (meta.calls ?? 0) + 1;
  meta.model = res.model || meta.model;
  meta.structured = res.structured ?? meta.structured;
  if (res.usage) {
    meta.usage = {
      inputTokens: (meta.usage?.inputTokens ?? 0) + res.usage.inputTokens,
      outputTokens: (meta.usage?.outputTokens ?? 0) + res.usage.outputTokens,
    };
  }
  if (res.costUsd !== undefined) meta.costUsd = (meta.costUsd ?? 0) + res.costUsd;
}

export class LLMCompositionProvider implements CompositionProvider {
  constructor(
    readonly llm: LLMProvider,
    readonly opts: LLMCompositionOptions = {},
  ) {}

  private maxTokens(task: CompositionTask): number {
    return this.opts.maxTokens?.[task] ?? DEFAULT_TASK_MAX_TOKENS[task];
  }

  /** One structured call with schema validation and (once) a repair retry. */
  private async structured<T>(call: StructuredCall<T>): Promise<{ value: T; meta: CallMeta; problems: string[] }> {
    const schema = CANONICAL_SCHEMAS[call.schemaName];
    const meta: CallMeta = { providerId: this.opts.providerId };
    const messages: ChatMessage[] = [...(call.history ?? []), { role: 'user', content: call.user }];
    const attempt = async (msgs: ChatMessage[]): Promise<{ text: string; parsed: DomainParse<T> }> => {
      let res: LLMResponse;
      try {
        res = await this.llm.complete({
          model: call.model ?? this.opts.model,
          system: call.system,
          messages: msgs,
          responseSchema: schema,
          schemaName: call.schemaName,
          maxTokens: this.maxTokens(call.task),
          temperature: this.opts.temperature,
          signal: call.signal,
          hints: { role: TASK_ROLE[call.task], ...(call.hints ?? {}) },
        });
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'truncated' && err.partialText) {
          meta.calls = (meta.calls ?? 0) + 1;
          return { text: err.partialText, parsed: this.interpret(err.partialText, undefined, schema, call.parse, call.validate !== false, ['the reply was cut off (too long) — be more concise']) };
        }
        throw err;
      }
      addUsage(meta, res);
      return { text: res.text, parsed: this.interpret(res.text, res.json, schema, call.parse, call.validate !== false) };
    };

    const first = await attempt(messages);
    if ((first.parsed.problems.length === 0 && first.parsed.value !== undefined) || this.opts.repair === false) {
      if (first.parsed.value === undefined) throw new ProviderError('parse', `Could not use model output: ${first.parsed.problems.join('; ')}`, { providerId: this.opts.providerId, partialText: first.text });
      return { value: first.parsed.value, meta, problems: first.parsed.problems };
    }
    const repairMessages: ChatMessage[] = [...messages, { role: 'assistant', content: first.text || '(empty reply)' }, { role: 'user', content: repairPrompt(first.parsed.problems) }];
    let second: { text: string; parsed: DomainParse<T> } | undefined;
    try {
      second = await attempt(repairMessages);
    } catch (err) {
      if (first.parsed.value === undefined) throw err;
    }
    meta.repaired = true;
    const pick = second && second.parsed.value !== undefined && (second.parsed.problems.length <= first.parsed.problems.length || first.parsed.value === undefined) ? second : first;
    if (pick.parsed.value === undefined) {
      throw new ProviderError('parse', `Could not use model output after a repair attempt: ${pick.parsed.problems.join('; ')}`, { providerId: this.opts.providerId, partialText: pick.text });
    }
    return { value: pick.parsed.value, meta, problems: pick.parsed.problems };
  }

  private interpret<T>(text: string, json: unknown, schema: (typeof CANONICAL_SCHEMAS)[CanonicalSchemaName], parse: (v: unknown) => DomainParse<T>, validate: boolean, extra: string[] = []): DomainParse<T> {
    let value = json;
    if (value === undefined) {
      const ex = extractJson(text);
      if (!ex.ok) return { problems: [...extra, ex.error] };
      value = ex.value;
      if (ex.truncated) extra = [...extra, 'the JSON was incomplete (cut off)'];
    }
    value = unfoldParams(value, schema);
    if (!validate) {
      const domain = parse(value);
      return { value: domain.value, problems: [...extra, ...domain.problems] };
    }
    const v = validateJson(value, schema, { coerce: true });
    const domain = parse(v.value);
    const schemaProblems = v.errors.length ? [`schema: ${formatSchemaIssues(v.errors, 8).replace(/\n/g, '; ')}`] : [];
    return { value: domain.value, problems: [...extra, ...schemaProblems, ...domain.problems] };
  }

  // -------------------------------------------------------------------------

  async planSong(req: PlanSongRequest): Promise<PlanSongResult> {
    const p = planSongPrompt(req);
    const fallbackKey = req.blueprint?.key;
    const { value, meta } = await this.structured({
      task: 'plan',
      ...p,
      schemaName: 'composition_plan',
      hints: req.hints,
      model: req.model,
      signal: req.signal,
      parse: (v) => parsePlanJson(v, { fallbackKey, source: this.opts.providerId }),
    });
    return { plan: value.plan, explanation: value.notes, confidence: value.confidence, meta };
  }

  async designBlueprint(req: DesignBlueprintRequest): Promise<DesignBlueprintResult> {
    const p = designBlueprintPrompt(req);
    const { value, meta } = await this.structured({
      task: 'blueprint',
      ...p,
      schemaName: 'blueprint',
      hints: req.hints,
      model: req.model,
      signal: req.signal,
      parse: (v) =>
        parseBlueprintJson(v, { prompt: req.prompt, defaults: req.defaults, genreIds: req.genres?.map((g) => g.id), instrumentIds: req.instruments?.map((i) => i.id), tagIds: req.tags?.map((t) => t.id) }),
    });
    return { blueprint: value.blueprint, explanation: value.explanation, confidence: value.confidence, meta };
  }

  private async operationsCall(task: CompositionTask, system: string, user: string, schemaName: CanonicalSchemaName, allowedOps: MusicOperation['op'][] | undefined, model?: string, signal?: AbortSignal, hints?: RequestHints) {
    return this.structured<{ operations: MusicOperation[]; errors: OperationParseError[]; explanation: string; confidence?: number; raw: Record<string, unknown> }>({
      task,
      system,
      user,
      hints,
      schemaName,
      model,
      signal,
      validate: false,
      parse: (v) => {
        const parsed = parseOperations(v, { allowedOps });
        const raw = isPlainObject(v) ? v : {};
        return {
          value: { operations: parsed.operations, errors: parsed.errors, explanation: parsed.explanation ?? '', confidence: parsed.confidence, raw },
          problems: describeOperationErrors(parsed.errors),
        };
      },
    });
  }

  async modifyComposition(req: ModifyCompositionRequest): Promise<ModifyCompositionResult> {
    const p = modifyCompositionPrompt(req);
    const { value, meta } = await this.operationsCall('modify', p.system, p.user, 'operations', req.allowedOps, req.model, req.signal, req.hints);
    return { operations: value.operations, explanation: value.explanation, errors: value.errors, confidence: value.confidence, meta };
  }

  async analyzeMusic(req: AnalyzeMusicRequest): Promise<AnalyzeMusicResult> {
    const p = analyzeMusicPrompt(req);
    const user: string | ContentPart[] = req.audio ? [{ type: 'audio', audio: req.audio, label: 'recording' }, { type: 'text', text: p.user }] : p.user;
    const { value, meta } = await this.structured<AnalyzeMusicResult>({
      task: 'analyze',
      system: p.system,
      user,
      schemaName: 'music_analysis',
      hints: req.hints,
      model: req.model,
      signal: req.signal,
      parse: (v) => {
        if (!isPlainObject(v) || typeof v.summary !== 'string') return { problems: ['missing "summary"'] };
        const observations = Array.isArray(v.observations)
          ? v.observations.filter(isPlainObject).map((o) => ({ topic: String(o.topic ?? ''), detail: String(o.detail ?? ''), ...(typeof o.section === 'string' ? { section: o.section } : {}) }))
          : [];
        const out: AnalyzeMusicResult = { summary: v.summary, observations };
        if (typeof v.key === 'string') out.key = v.key;
        if (typeof v.tempo === 'number') out.tempo = v.tempo;
        if (typeof v.genre === 'string') out.genre = v.genre;
        if (typeof v.confidence === 'number') out.confidence = clamp(v.confidence, 0, 1);
        return { value: out, problems: [] };
      },
    });
    return { ...value, meta };
  }

  async explainMusic(req: ExplainMusicRequest): Promise<ExplainMusicResult> {
    const p = explainMusicPrompt(req);
    const { value, meta } = await this.structured<ExplainMusicResult>({
      task: 'explain',
      ...p,
      schemaName: 'music_explanation',
      hints: req.hints,
      model: req.model,
      signal: req.signal,
      parse: (v) => {
        if (!isPlainObject(v) || typeof v.explanation !== 'string') return { problems: ['missing "explanation"'] };
        const harmony = Array.isArray(v.harmony)
          ? v.harmony.filter(isPlainObject).map((h) => ({
              section: String(h.section ?? ''),
              chords: Array.isArray(h.chords) ? h.chords.map(String) : [],
              romans: Array.isArray(h.romans) ? h.romans.map(String) : [],
              ...(typeof h.comment === 'string' ? { comment: h.comment } : {}),
            }))
          : [];
        const out: ExplainMusicResult = { explanation: v.explanation, harmony, suggestions: Array.isArray(v.suggestions) ? v.suggestions.map(String) : [] };
        if (typeof v.confidence === 'number') out.confidence = clamp(v.confidence, 0, 1);
        return { value: out, problems: [] };
      },
    });
    return { ...value, meta };
  }

  async generateLyrics(req: GenerateLyricsRequest): Promise<GenerateLyricsResult> {
    const p = generateLyricsPrompt(req);
    const { value, meta } = await this.structured<GenerateLyricsResult>({
      task: 'lyrics',
      ...p,
      schemaName: 'lyrics',
      hints: req.hints,
      model: req.model,
      signal: req.signal,
      parse: (v) => parseLyricsJson(v, req),
    });
    return { ...value, meta };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const p = chatPrompt(req);
    const { value, meta } = await this.structured<ChatResult>({
      task: 'chat',
      ...p,
      history: req.history,
      schemaName: 'chat_answer',
      hints: req.hints,
      model: req.model,
      signal: req.signal,
      validate: false,
      parse: (v) => {
        if (!isPlainObject(v) || typeof v.answer !== 'string') return { problems: ['missing "answer"'] };
        const ops = parseOperations({ operations: Array.isArray(v.operations) ? v.operations : v.operations ? [v.operations] : [] });
        const out: ChatResult = {
          answer: v.answer,
          suggestions: Array.isArray(v.suggestions) ? v.suggestions.map(String) : typeof v.suggestions === 'string' ? [v.suggestions] : [],
          operations: ops.operations,
          errors: ops.errors,
        };
        const conf = typeof v.confidence === 'string' ? Number(v.confidence) : v.confidence;
        if (typeof conf === 'number' && Number.isFinite(conf)) out.confidence = clamp(conf > 1 && conf <= 100 ? conf / 100 : conf, 0, 1);
        return { value: out, problems: describeOperationErrors(ops.errors) };
      },
    });
    return { ...value, meta };
  }

  async mixAssist(req: MixAssistRequest): Promise<MixAssistResult> {
    const p = mixAssistPrompt(req);
    const { value, meta } = await this.operationsCall('mix', p.system, p.user, 'mix_operations', ['set_mixer', 'set_automation'], req.model, req.signal, req.hints);
    return { operations: value.operations, explanation: value.explanation, errors: value.errors, confidence: value.confidence, meta };
  }
}

/** Name used in docs/ARCHITECTURE.md §3.10 for the LLM-backed composition provider. */
export const CompositionService = LLMCompositionProvider;
export type CompositionService = LLMCompositionProvider;

// ---------------------------------------------------------------------------
// Domain parsers (exported for tests and for internal providers)
// ---------------------------------------------------------------------------

const normEnum = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/[\s_]+/g, '-') : '');
function pickEnum<T extends string>(v: unknown, values: readonly T[]): T | undefined {
  const n = normEnum(v);
  return values.find((x) => x === n);
}

const MODE_ALIASES: Record<string, ModeName> = { ionian: 'major', aeolian: 'minor', maj: 'major', min: 'minor' };

function parseKeyObject(v: unknown): KeySignature | undefined {
  if (typeof v === 'string') return parseKey(v) ?? undefined;
  if (!isPlainObject(v)) return undefined;
  const tonicRaw = typeof v.tonic === 'string' ? v.tonic.trim() : undefined;
  if (!tonicRaw) return undefined;
  if (/\s/.test(tonicRaw)) return parseKey(tonicRaw) ?? undefined;
  const tonic = pitchClassFromName(tonicRaw);
  const mode = pickEnum<ModeName>(v.mode, MODE_NAMES) ?? MODE_ALIASES[normEnum(v.mode)];
  if (tonic === null || !mode) return undefined;
  return { tonic, mode };
}

/** Normalize a chord or roman numeral to a chord symbol in the key. */
export function normalizeHarmonySymbol(raw: string, key: KeySignature): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const chord = parseChordSymbol(s);
  if (chord) return formatChordSymbol(chord, key);
  if (parseRoman(s)) {
    const c = romanToChord(s, key);
    if (c) return formatChordSymbol(c, key);
  }
  return undefined;
}

export function parsePlanJson(v: unknown, opts: { fallbackKey?: KeySignature; source?: string } = {}): DomainParse<{ plan: CompositionPlan; notes?: string; confidence?: number }> {
  const problems: string[] = [];
  if (!isPlainObject(v)) return { problems: ['the reply is not a JSON object'] };
  const key = parseKeyObject(v.key) ?? opts.fallbackKey;
  if (!key) return { problems: ['missing or invalid "key" (tonic note name + mode)'] };
  const tempo = typeof v.tempo === 'number' && v.tempo > 0 ? clamp(v.tempo, 30, 300) : undefined;
  if (tempo === undefined) problems.push('missing or invalid "tempo"');
  const meterRaw = isPlainObject(v.meter) ? v.meter : {};
  const numerator = typeof meterRaw.numerator === 'number' ? Math.round(meterRaw.numerator) : 4;
  const denominator = typeof meterRaw.denominator === 'number' ? Math.round(meterRaw.denominator) : 4;
  const sectionsRaw = Array.isArray(v.sections) ? v.sections : [];
  if (!sectionsRaw.length) return { problems: [...problems, 'no sections'] };
  const sections: PlanSection[] = [];
  sectionsRaw.forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      problems.push(`section ${i + 1} is not an object`);
      return;
    }
    const kind = pickEnum<SectionKind>(raw.kind, SECTION_KINDS) ?? 'custom';
    if (raw.kind !== undefined && kind === 'custom' && normEnum(raw.kind) !== 'custom') problems.push(`section ${i + 1}: unknown kind "${String(raw.kind)}"`);
    const bars = typeof raw.bars === 'number' ? Math.round(raw.bars) : NaN;
    if (!(bars >= 1 && bars <= 128)) {
      problems.push(`section ${i + 1}: invalid bars ${JSON.stringify(raw.bars)}`);
      return;
    }
    const harmonyRaw = Array.isArray(raw.harmony) ? raw.harmony : typeof raw.harmony === 'string' ? raw.harmony.split(/[\s,|–-]+/) : [];
    const harmony: string[] = [];
    for (const h of harmonyRaw) {
      if (typeof h !== 'string') continue;
      const sym = normalizeHarmonySymbol(h, key);
      if (sym) harmony.push(sym);
      else problems.push(`section ${i + 1}: invalid chord "${h}"`);
    }
    if (!harmony.length) problems.push(`section ${i + 1}: no valid harmony`);
    const section: PlanSection = {
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `${kind[0].toUpperCase()}${kind.slice(1)} ${i + 1}`,
      kind,
      bars,
      harmony,
      energy: typeof raw.energy === 'number' ? clamp(raw.energy, 0, 100) : 50,
      purpose: typeof raw.purpose === 'string' ? raw.purpose : '',
    };
    if (typeof raw.energy_end === 'number') section.energyEnd = clamp(raw.energy_end, 0, 100);
    const feel = pickEnum<SectionFeel>(raw.feel, SECTION_FEELS);
    if (feel) section.feel = feel;
    sections.push(section);
  });
  if (!sections.length) return { problems };
  const plan: CompositionPlan = { key, tempo: tempo ?? 120, meter: { numerator, denominator }, sections };
  if (typeof v.notes === 'string' && v.notes) plan.notes = v.notes;
  if (opts.source) plan.source = opts.source;
  return { value: { plan, notes: typeof v.notes === 'string' ? v.notes : undefined, confidence: typeof v.confidence === 'number' ? clamp(v.confidence, 0, 1) : undefined }, problems };
}

const MACRO_KEYS: Record<string, keyof MacroSettings> = {
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

export function parseBlueprintJson(
  v: unknown,
  opts: { prompt?: string; defaults?: Partial<Blueprint>; genreIds?: string[]; instrumentIds?: string[]; tagIds?: string[] } = {},
): DomainParse<{ blueprint: Blueprint; explanation?: string; confidence?: number }> {
  const problems: string[] = [];
  if (!isPlainObject(v)) return { problems: ['the reply is not a JSON object'] };
  const d = opts.defaults ?? {};
  const key = parseKeyObject(v.key) ?? d.key;
  if (!key) problems.push('missing or invalid "key"');
  const tempo = typeof v.tempo === 'number' && v.tempo > 0 ? clamp(v.tempo, 30, 300) : d.tempo;
  if (!tempo) problems.push('missing or invalid "tempo"');
  const meterRaw = isPlainObject(v.meter) ? v.meter : undefined;
  const meter = meterRaw && typeof meterRaw.numerator === 'number' && typeof meterRaw.denominator === 'number' ? { numerator: Math.round(meterRaw.numerator), denominator: Math.round(meterRaw.denominator) } : (d.meter ?? { numerator: 4, denominator: 4 });
  const genreSet = opts.genreIds?.length ? new Set(opts.genreIds) : undefined;
  const genreBlend = (Array.isArray(v.genre_blend) ? v.genre_blend : [])
    .filter(isPlainObject)
    .map((g) => ({ genreId: String(g.genre_id ?? g.genreId ?? ''), weight: typeof g.weight === 'number' ? Math.max(0, g.weight) : 1 }))
    .filter((g) => {
      if (!g.genreId) return false;
      if (genreSet && !genreSet.has(g.genreId)) {
        problems.push(`unknown genre id "${g.genreId}"`);
        return false;
      }
      return true;
    });
  const instrumentSet = opts.instrumentIds?.length ? new Set(opts.instrumentIds) : undefined;
  const instrumentation: BlueprintTrack[] = [];
  (Array.isArray(v.instrumentation) ? v.instrumentation : []).forEach((t, i) => {
    if (!isPlainObject(t)) return;
    const instrumentId = String(t.instrument_id ?? t.instrumentId ?? '');
    const role = pickEnum<TrackRole>(t.role, TRACK_ROLE_NAMES);
    if (!instrumentId || !role) {
      problems.push(`instrumentation ${i + 1}: needs instrument_id and a valid role`);
      return;
    }
    if (instrumentSet && !instrumentSet.has(instrumentId)) problems.push(`instrumentation ${i + 1}: unknown instrument id "${instrumentId}"`);
    const track: BlueprintTrack = { name: typeof t.name === 'string' && t.name ? t.name : instrumentId, instrumentId, role };
    const fn = pickEnum<MusicalFunction>(t.function, MUSICAL_FUNCTIONS);
    if (fn) track.function = fn;
    const constraints: NonNullable<BlueprintTrack['constraints']> = {};
    if (typeof t.lowest === 'string') {
      const p = noteNameToMidi(t.lowest);
      if (p !== null) constraints.lowest = p;
    }
    if (typeof t.highest === 'string') {
      const p = noteNameToMidi(t.highest);
      if (p !== null) constraints.highest = p;
    }
    const cx = pickEnum(t.complexity, ['low', 'medium', 'high'] as const);
    if (cx) constraints.complexity = cx;
    if (Array.isArray(t.avoid)) {
      const avoid = t.avoid.map((a) => pickEnum(a, AVOID_RULES)).filter((a): a is NonNullable<typeof a> => !!a);
      if (avoid.length) constraints.avoid = avoid;
    }
    if (fn) constraints.function = fn;
    if (Object.keys(constraints).length) track.constraints = constraints;
    instrumentation.push(track);
  });
  if (!instrumentation.length && !d.instrumentation?.length) problems.push('no valid instrumentation');
  const structure: BlueprintSection[] = [];
  (Array.isArray(v.structure) ? v.structure : []).forEach((s, i) => {
    if (!isPlainObject(s)) return;
    const kind = pickEnum<SectionKind>(s.kind, SECTION_KINDS);
    const bars = typeof s.bars === 'number' ? Math.round(s.bars) : NaN;
    if (!kind || !(bars >= 1 && bars <= 128)) {
      problems.push(`structure ${i + 1}: needs a valid kind and bars`);
      return;
    }
    const sec: BlueprintSection = { name: typeof s.name === 'string' && s.name ? s.name : kind, kind, bars };
    if (typeof s.energy === 'number') sec.energy = clamp(s.energy, 0, 100);
    if (typeof s.energy_end === 'number') sec.energyEnd = clamp(s.energy_end, 0, 100);
    if (typeof s.purpose === 'string' && s.purpose) sec.purpose = s.purpose;
    if (Array.isArray(s.mood)) sec.mood = s.mood.map(String);
    if (Array.isArray(s.harmony)) {
      const h = s.harmony.map(String).filter((x) => parseChordSymbol(x) || parseRoman(x));
      if (h.length) sec.harmony = h;
    }
    const feel = pickEnum<SectionFeel>(s.feel, SECTION_FEELS);
    if (feel) sec.feel = feel;
    structure.push(sec);
  });
  if (!structure.length && !d.structure?.length) problems.push('no valid structure');
  const macros: MacroSettings = { ...defaultMacros(), ...(d.macros ?? {}) };
  if (isPlainObject(v.macros)) {
    for (const [k, val] of Object.entries(v.macros)) {
      const target = MACRO_KEYS[k];
      if (target && typeof val === 'number') macros[target] = clamp(val, 0, 1);
    }
  }
  if (!key || !tempo) return { problems };
  const blueprint: Blueprint = {
    title: typeof v.title === 'string' && v.title.trim() ? v.title.trim() : (d.title ?? 'Untitled'),
    tempo,
    meter,
    key,
    styles: Array.isArray(v.styles) ? v.styles.map(String) : (d.styles ?? []),
    genreBlend: genreBlend.length ? genreBlend : (d.genreBlend ?? []),
    moods: Array.isArray(v.moods) ? v.moods.map(String) : (d.moods ?? []),
    instrumentation: instrumentation.length ? instrumentation : (d.instrumentation ?? []),
    structure: structure.length ? structure : (d.structure ?? []),
    macros,
    seed: d.seed ?? 1,
  };
  const prompt = opts.prompt ?? d.prompt;
  if (prompt) blueprint.prompt = prompt;
  if (isPlainObject(v.vocal)) {
    const voiceType = pickEnum<VoiceType>(v.vocal.voice_type, VOICE_TYPES);
    const mode = pickEnum<VocalMode>(v.vocal.mode, VOCAL_MODES);
    if (voiceType && mode) blueprint.vocal = { voiceType, mode, ...(typeof v.vocal.description === 'string' ? { description: v.vocal.description } : {}) };
  } else if (d.vocal) blueprint.vocal = d.vocal;
  if (typeof v.lyrics_theme === 'string' && v.lyrics_theme) blueprint.lyricsTheme = v.lyrics_theme;
  else if (d.lyricsTheme) blueprint.lyricsTheme = d.lyricsTheme;
  // Tags: only ids the caller offered (unknown ones are dropped, not fatal).
  const tagSet = opts.tagIds?.length ? new Set(opts.tagIds) : undefined;
  const tags = [...new Set((Array.isArray(v.tags) ? v.tags : []).filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim()))].filter((t) => !tagSet || tagSet.has(t));
  if (tags.length) blueprint.tags = tags;
  else if (d.tags?.length) blueprint.tags = [...d.tags];
  return {
    value: { blueprint, explanation: typeof v.explanation === 'string' ? v.explanation : undefined, confidence: typeof v.confidence === 'number' ? clamp(v.confidence, 0, 1) : undefined },
    problems,
  };
}

export function parseLyricsJson(v: unknown, req: GenerateLyricsRequest): DomainParse<GenerateLyricsResult> {
  if (!isPlainObject(v) || !Array.isArray(v.sections)) return { problems: ['missing "sections"'] };
  const problems: string[] = [];
  const returned = v.sections.filter(isPlainObject).map((s) => ({ section: String(s.section ?? ''), lines: Array.isArray(s.lines) ? s.lines.map(String).map((l) => l.trim()).filter(Boolean) : [] }));
  const norm = (s: string) => s.trim().toLowerCase();
  const sections = req.sections.map((want, i) => {
    const got = returned.find((r) => norm(r.section) === norm(want.name)) ?? returned[i];
    if (want.locked && want.existing) return { section: want.name, lines: [...want.existing] };
    if (!got) {
      problems.push(`missing section "${want.name}"`);
      return { section: want.name, lines: want.existing ? [...want.existing] : [] };
    }
    if (got.lines.length !== want.lines) problems.push(`section "${want.name}" needs ${want.lines} line(s), got ${got.lines.length}`);
    return { section: want.name, lines: got.lines };
  });
  const out: GenerateLyricsResult = { sections };
  if (typeof v.title === 'string' && v.title) out.title = v.title;
  if (typeof v.notes === 'string' && v.notes) out.notes = v.notes;
  if (typeof v.confidence === 'number') out.confidence = clamp(v.confidence, 0, 1);
  return { value: out, problems };
}

/** Convert generated lyrics to set_lyrics operations (section names resolved by the edit engine). */
export function lyricsToOperations(result: GenerateLyricsResult): MusicOperation[] {
  return result.sections.filter((s) => s.lines.length).map((s) => ({ op: 'set_lyrics' as const, section: s.section, lines: s.lines }));
}
