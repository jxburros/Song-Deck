/**
 * Schema "compiler": canonical JSON schema → provider dialects (spec §46).
 *
 *  - `openai-strict`  OpenAI `response_format.json_schema` with `strict: true`: every property is
 *                     listed in `required`, optional ones become nullable, additionalProperties false.
 *  - `anthropic`      Anthropic `output_config.format`: additionalProperties false on every object,
 *                     no numeric/string/array constraints, no nullable unions (optional = not required).
 *                     If the schema has more optional properties than the API accepts, rarely-used
 *                     optional fields are folded into a `params: [{name, value}]` list
 *                     (`unfoldParams` restores them).
 *  - `gemini`         Gemini `responseSchema` (OpenAPI subset): uppercase types, `nullable: true`,
 *                     no additionalProperties, `propertyOrdering`.
 *  - `json-schema`    Plain JSON schema for grammar-constrained local servers (Ollama `format`,
 *                     llama.cpp, vLLM, LM Studio).
 *  - `prompt-only`    Schema is described in the system prompt (`describeSchemaForPrompt`).
 */
import type { SchemaDialect } from '../config';
import type { JsonSchema, JsonSchemaType } from '../types';
import { isPlainObject } from '../util';

export interface CompileOptions {
  /** Keep numeric/string/array constraints (json-schema / openai-strict only). Default false. */
  keepConstraints?: boolean;
  /** Anthropic: max optional properties before folding (default 24). */
  maxOptionalProperties?: number;
}

const CONSTRAINT_KEYS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'format',
] as const;

/** Default Anthropic limit on optional parameters across a structured-output schema. */
export const ANTHROPIC_MAX_OPTIONAL_PROPERTIES = 24;

function typesOf(s: JsonSchema): JsonSchemaType[] {
  if (Array.isArray(s.type)) return s.type;
  return s.type ? [s.type] : [];
}

/** Copy without annotations/constraints that no LLM dialect needs. */
function baseCopy(s: JsonSchema, keepConstraints: boolean): JsonSchema {
  const out: JsonSchema = {};
  if (s.type !== undefined) out.type = Array.isArray(s.type) ? [...s.type] : s.type;
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = [...s.enum];
  if (s.const !== undefined) out.const = s.const;
  if (keepConstraints)
    for (const k of CONSTRAINT_KEYS) if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

function nonNullType(s: JsonSchema): JsonSchemaType | undefined {
  return typesOf(s).find((t) => t !== 'null');
}

function isNullable(s: JsonSchema): boolean {
  return s.nullable === true || typesOf(s).includes('null');
}

// ---------------------------------------------------------------------------
// OpenAI strict
// ---------------------------------------------------------------------------

function toOpenAI(s: JsonSchema, keepConstraints: boolean): JsonSchema {
  if (s.anyOf)
    return {
      anyOf: s.anyOf.map((b) => toOpenAI(b, keepConstraints)),
      ...(s.description ? { description: s.description } : {}),
    };
  const out = baseCopy(s, keepConstraints);
  const t = nonNullType(s);
  if (t === 'object' || s.properties) {
    out.type = 'object';
    const props: Record<string, JsonSchema> = {};
    const required = new Set(s.required ?? []);
    for (const [k, child] of Object.entries(s.properties ?? {})) {
      const compiled = toOpenAI(child, keepConstraints);
      props[k] = required.has(k) && !isNullable(child) ? compiled : makeNullableOpenAI(compiled);
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  } else if (t === 'array') {
    out.type = 'array';
    if (s.items) out.items = toOpenAI(s.items, keepConstraints);
  } else if (t) {
    out.type = isNullable(s) ? [t, 'null'] : t;
  }
  return out;
}

function makeNullableOpenAI(s: JsonSchema): JsonSchema {
  if (s.anyOf)
    return s.anyOf.some((b) => b.type === 'null') ? s : { ...s, anyOf: [...s.anyOf, { type: 'null' }] };
  const t = nonNullType(s);
  if (t === 'object' || t === 'array') {
    const { description, ...rest } = s;
    return { anyOf: [rest, { type: 'null' }], ...(description ? { description } : {}) };
  }
  if (!t) return s;
  const out: JsonSchema = { ...s, type: [t, 'null'] };
  if (s.enum && !s.enum.includes(null)) out.enum = [...s.enum, null];
  return out;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

function toAnthropic(s: JsonSchema): JsonSchema {
  if (s.anyOf)
    return {
      anyOf: s.anyOf.filter((b) => b.type !== 'null').map(toAnthropic),
      ...(s.description ? { description: s.description } : {}),
    };
  const out = baseCopy(s, false);
  const t = nonNullType(s);
  if (t === 'object' || s.properties) {
    out.type = 'object';
    const props: Record<string, JsonSchema> = {};
    for (const [k, child] of Object.entries(s.properties ?? {})) props[k] = toAnthropic(child);
    out.properties = props;
    // Nullable-but-required properties become optional (no union types).
    out.required = (s.required ?? []).filter((k) => props[k] && !isNullable(s.properties![k]));
    out.additionalProperties = false;
    if (s['x-keep']) out['x-keep'] = true;
  } else if (t === 'array') {
    out.type = 'array';
    if (s.items) out.items = toAnthropic(s.items);
  } else if (t) {
    out.type = t;
  }
  if (out.enum) out.enum = out.enum.filter((v) => v !== null);
  if (s['x-keep']) out['x-keep'] = true;
  return out;
}

/** Number of optional (not required) properties anywhere in the schema. */
export function countOptionalProperties(s: JsonSchema): number {
  let n = 0;
  if (s.properties) {
    const req = new Set(s.required ?? []);
    for (const [k, child] of Object.entries(s.properties)) {
      if (!req.has(k)) n++;
      n += countOptionalProperties(child);
    }
  }
  if (s.items) n += countOptionalProperties(s.items);
  for (const b of s.anyOf ?? []) n += countOptionalProperties(b);
  return n;
}

interface FoldedField {
  name: string;
  schema: JsonSchema;
}

function typeLabel(s: JsonSchema): string {
  if (s.enum)
    return s.enum
      .filter((v) => v !== null)
      .map((v) => JSON.stringify(v))
      .join('|');
  const t = nonNullType(s) ?? 'any';
  if (t === 'array') return `${s.items ? typeLabel(s.items) : 'any'}[]`;
  return t;
}

/** Flatten optional foldable properties (nested objects become dotted names). */
function foldableFields(s: JsonSchema): FoldedField[] {
  const out: FoldedField[] = [];
  const req = new Set(s.required ?? []);
  for (const [k, child] of Object.entries(s.properties ?? {})) {
    if (req.has(k) || child['x-keep'] || k === 'params') continue;
    const t = nonNullType(child);
    if (t === 'object' && child.properties) {
      for (const [ck, cchild] of Object.entries(child.properties)) {
        const ct = nonNullType(cchild);
        if (ct === 'object' || (ct === 'array' && cchild.items && nonNullType(cchild.items) === 'object'))
          continue;
        out.push({ name: `${k}.${ck}`, schema: cchild });
      }
      continue;
    }
    if (t === 'array' && child.items && nonNullType(child.items) === 'object') continue;
    out.push({ name: k, schema: child });
  }
  return out;
}

function foldObject(s: JsonSchema): boolean {
  const fields = foldableFields(s);
  if (fields.length < 2) return false;
  const roots = new Set(fields.map((f) => f.name.split('.')[0]));
  const props: Record<string, JsonSchema> = {};
  for (const [k, child] of Object.entries(s.properties ?? {})) if (!roots.has(k)) props[k] = child;
  const listing = fields
    .map(
      (f) => `${f.name} (${typeLabel(f.schema)})${f.schema.description ? `: ${f.schema.description}` : ''}`,
    )
    .join('; ');
  props.params = {
    type: 'array',
    description: `Any other field of this object as name/value pairs. Values are text: numbers as digits, booleans as true/false, lists as JSON arrays. Fields: ${listing}`,
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: fields.map((f) => f.name) },
        value: { type: 'string' },
      },
      required: ['name', 'value'],
      additionalProperties: false,
    },
  };
  s.properties = props;
  s.required = (s.required ?? []).filter((k) => props[k]);
  return true;
}

function objectNodes(s: JsonSchema, out: JsonSchema[] = []): JsonSchema[] {
  if (s.properties) out.push(s);
  for (const child of Object.values(s.properties ?? {})) objectNodes(child, out);
  if (s.items) objectNodes(s.items, out);
  for (const b of s.anyOf ?? []) objectNodes(b, out);
  return out;
}

function foldUntilWithin(s: JsonSchema, max: number): void {
  const tried = new Set<JsonSchema>();
  while (countOptionalProperties(s) > max) {
    const nodes = objectNodes(s)
      .filter((n) => !tried.has(n))
      .map((n) => ({ n, count: foldableFields(n).length }))
      .filter((x) => x.count >= 2)
      .sort((a, b) => b.count - a.count);
    if (!nodes.length) return;
    tried.add(nodes[0].n);
    foldObject(nodes[0].n);
  }
}

function stripAnnotations(s: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...s };
  delete out['x-keep'];
  if (out.properties)
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => [k, stripAnnotations(v)]),
    );
  if (out.items) out.items = stripAnnotations(out.items);
  if (out.anyOf) out.anyOf = out.anyOf.map(stripAnnotations);
  return out;
}

// ---------------------------------------------------------------------------
// Gemini (OpenAPI subset)
// ---------------------------------------------------------------------------

const GEMINI_TYPES: Record<JsonSchemaType, string> = {
  object: 'OBJECT',
  array: 'ARRAY',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  null: 'NULL',
};

function toGemini(s: JsonSchema, optional = false): Record<string, unknown> {
  if (s.anyOf) {
    const nonNull = s.anyOf.filter((b) => b.type !== 'null');
    if (nonNull.length === 1)
      return toGemini(
        { ...nonNull[0], description: s.description ?? nonNull[0].description },
        optional || nonNull.length < s.anyOf.length,
      );
    return { anyOf: nonNull.map((b) => toGemini(b)), ...(optional ? { nullable: true } : {}) };
  }
  const out: Record<string, unknown> = {};
  const t = nonNullType(s) ?? (s.properties ? 'object' : 'string');
  out.type = GEMINI_TYPES[t];
  if (s.description) out.description = s.description;
  if (s.enum && t === 'string') out.enum = s.enum.filter((v): v is string => typeof v === 'string');
  if (s.const !== undefined && typeof s.const === 'string') out.enum = [s.const];
  if (optional || isNullable(s)) out.nullable = true;
  if (t === 'object') {
    const props: Record<string, unknown> = {};
    const req = new Set(s.required ?? []);
    for (const [k, child] of Object.entries(s.properties ?? {})) props[k] = toGemini(child, !req.has(k));
    out.properties = props;
    const required = (s.required ?? []).filter((k) => k in props);
    if (required.length) out.required = required;
    out.propertyOrdering = Object.keys(props);
  } else if (t === 'array' && s.items) {
    out.items = toGemini(s.items);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plain JSON schema (local grammar-constrained servers)
// ---------------------------------------------------------------------------

function toJsonSchema(s: JsonSchema, keepConstraints: boolean): JsonSchema {
  if (s.anyOf)
    return {
      anyOf: s.anyOf.map((b) => toJsonSchema(b, keepConstraints)),
      ...(s.description ? { description: s.description } : {}),
    };
  const out = baseCopy(s, keepConstraints);
  const t = nonNullType(s);
  if (t === 'object' || s.properties) {
    out.type = 'object';
    const props: Record<string, JsonSchema> = {};
    for (const [k, child] of Object.entries(s.properties ?? {}))
      props[k] = toJsonSchema(child, keepConstraints);
    out.properties = props;
    out.required = (s.required ?? []).filter((k) => k in props);
    out.additionalProperties = false;
  } else if (t === 'array') {
    out.type = 'array';
    if (s.items) out.items = toJsonSchema(s.items, keepConstraints);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Compile a canonical schema to a provider dialect. The input is never mutated. */
export function compileSchema(
  schema: JsonSchema,
  dialect: SchemaDialect,
  opts: CompileOptions = {},
): JsonSchema {
  const keepConstraints = opts.keepConstraints ?? false;
  switch (dialect) {
    case 'openai-strict':
      return toOpenAI(schema, keepConstraints);
    case 'anthropic': {
      const compiled = toAnthropic(schema);
      foldUntilWithin(compiled, opts.maxOptionalProperties ?? ANTHROPIC_MAX_OPTIONAL_PROPERTIES);
      return stripAnnotations(compiled);
    }
    case 'gemini':
      return toGemini(schema) as JsonSchema;
    case 'json-schema':
      return toJsonSchema(schema, keepConstraints);
    case 'prompt-only':
    default:
      return stripAnnotations(schema);
  }
}

/** OpenAI requires schema names matching ^[a-zA-Z0-9_-]{1,64}$. */
export function sanitizeSchemaName(name: string | undefined): string {
  const n = (name ?? 'response').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64);
  return n || 'response';
}

// ---------------------------------------------------------------------------
// Folded params → fields
// ---------------------------------------------------------------------------

function coerceFolded(value: unknown, schema: JsonSchema | undefined): unknown {
  if (typeof value !== 'string' || !schema) return value;
  const t = nonNullType(schema);
  const v = value.trim();
  if (t === 'number' || t === 'integer') {
    const n = Number(v);
    return Number.isFinite(n) ? n : value;
  }
  if (t === 'boolean') {
    if (/^(true|yes|1|on)$/i.test(v)) return true;
    if (/^(false|no|0|off)$/i.test(v)) return false;
    return value;
  }
  if (t === 'array') {
    if (v.startsWith('[')) {
      try {
        return JSON.parse(v);
      } catch {
        /* fall through */
      }
    }
    return v ? v.split(/\s*[,;\n]\s*/).filter(Boolean) : [];
  }
  if (t === 'object' && v.startsWith('{')) {
    try {
      return JSON.parse(v);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Expand `params: [{name, value}]` lists produced by a folded dialect back into fields, using the
 * canonical schema to coerce values. Objects whose canonical schema defines `params` are untouched.
 */
export function unfoldParams(value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema) return value;
  if (Array.isArray(value)) return value.map((v) => unfoldParams(v, schema.items ?? schema));
  if (!isPlainObject(value)) return value;
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'params' && !props.params) continue;
    out[k] = unfoldParams(v, props[k]);
  }
  const params = value.params;
  if (Array.isArray(params) && !props.params) {
    for (const p of params) {
      if (!isPlainObject(p) || typeof p.name !== 'string') continue;
      const path = p.name.split('.');
      if (path.length === 1) {
        if (out[path[0]] === undefined || out[path[0]] === null)
          out[path[0]] = coerceFolded(p.value, props[path[0]]);
      } else {
        const [root, leaf] = path;
        const container = isPlainObject(out[root]) ? (out[root] as Record<string, unknown>) : {};
        container[leaf] = coerceFolded(p.value, props[root]?.properties?.[leaf]);
        out[root] = container;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt-only description
// ---------------------------------------------------------------------------

function describeType(s: JsonSchema, indent: string, depth: number): string {
  if (s.anyOf) return s.anyOf.map((b) => describeType(b, indent, depth)).join(' | ');
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const t = nonNullType(s) ?? (s.properties ? 'object' : 'any');
  if (t === 'object' && s.properties) {
    const req = new Set(s.required ?? []);
    const inner = indent + '  ';
    const lines = Object.entries(s.properties).map(([k, child]) => {
      const opt = req.has(k) ? '' : '?';
      const desc = child.description ? `  // ${child.description}` : '';
      return `${inner}"${k}"${opt}: ${describeType(child, inner, depth + 1)}${desc}`;
    });
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
  if (t === 'array') return `${s.items ? describeType(s.items, indent, depth + 1) : 'any'}[]`;
  return t === 'integer' ? 'integer' : t;
}

/**
 * Compact, deterministic description of a schema for prompt-only structured output
 * (TypeScript-like notation; `?` marks optional fields).
 */
export function describeSchemaForPrompt(schema: JsonSchema): string {
  return describeType(schema, '', 0);
}

/** System-prompt paragraph instructing JSON output for a schema. */
export function schemaInstructions(schema: JsonSchema, name?: string): string {
  return [
    `Respond with a single JSON object${name ? ` (${name})` : ''} and nothing else: no prose before or after, no code fences, no comments.`,
    'Use double quotes for all keys and strings. Omit optional fields you do not need (or set them to null).',
    'JSON shape (fields marked ? are optional):',
    describeSchemaForPrompt(schema),
  ].join('\n');
}
