/**
 * Small JSON-schema subset validator with optional coercion of typical LLM deviations
 * (numeric strings, "true"/"false", enum case/spacing, null optional fields, scalars where an
 * array is expected, unknown properties).
 */
import type { JsonSchema, JsonSchemaType } from '../types';
import { isPlainObject } from '../util';

export interface SchemaIssue {
  path: string;
  message: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaIssue[];
  /** Problems that coercion fixed (or dropped unknown fields). */
  warnings: SchemaIssue[];
  /** The (coerced) value. */
  value: unknown;
}

export interface ValidateOptions {
  /** Coerce near-misses instead of failing (default false). */
  coerce?: boolean;
  /** Drop properties not in the schema when additionalProperties is false (default: same as coerce). */
  stripUnknown?: boolean;
}

function typesOf(s: JsonSchema): JsonSchemaType[] {
  if (Array.isArray(s.type)) return s.type;
  return s.type ? [s.type] : [];
}

function jsonType(v: unknown): JsonSchemaType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'string';
  return 'object';
}

function typeMatches(v: unknown, t: JsonSchemaType): boolean {
  const jt = jsonType(v);
  // Non-integral numbers for integer fields are handled (rounded or reported) after the type check.
  if (t === 'number' || t === 'integer') return jt === 'number' || jt === 'integer';
  return jt === t;
}

const normalizeEnum = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

class Validator {
  errors: SchemaIssue[] = [];
  warnings: SchemaIssue[] = [];
  constructor(private readonly opts: Required<ValidateOptions>) {}

  run(v: unknown, s: JsonSchema, path: string): unknown {
    if (s.anyOf) return this.anyOf(v, s, path);
    const types = typesOf(s);
    const nullable = s.nullable === true || types.includes('null');
    if (v === null || v === undefined) {
      if (nullable || types.length === 0) return v;
      this.errors.push({ path, message: 'is null/missing' });
      return v;
    }
    let value: unknown = v;
    const wanted = types.filter((t) => t !== 'null');
    if (wanted.length && !wanted.some((t) => typeMatches(value, t))) {
      const coerced = this.opts.coerce ? this.coerceType(value, wanted) : undefined;
      if (coerced !== undefined) {
        this.warnings.push({ path, message: `coerced ${jsonType(value)} to ${jsonType(coerced)}` });
        value = coerced;
      } else {
        this.errors.push({ path, message: `expected ${wanted.join('|')}, got ${jsonType(value)}` });
        return value;
      }
    }
    if (
      wanted.includes('integer') &&
      !wanted.includes('number') &&
      typeof value === 'number' &&
      !Number.isInteger(value)
    ) {
      if (this.opts.coerce) {
        this.warnings.push({ path, message: `rounded ${value} to an integer` });
        value = Math.round(value);
      } else this.errors.push({ path, message: 'expected integer' });
    }
    if (s.enum && !s.enum.includes(value as never)) {
      const match =
        this.opts.coerce && typeof value === 'string'
          ? s.enum.find((e) => typeof e === 'string' && normalizeEnum(e) === normalizeEnum(value as string))
          : undefined;
      if (match !== undefined) {
        this.warnings.push({ path, message: `normalized "${String(value)}" to "${String(match)}"` });
        value = match;
      } else {
        this.errors.push({
          path,
          message: `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')} (got ${JSON.stringify(value)})`,
        });
      }
    }
    if (s.const !== undefined && value !== s.const)
      this.errors.push({ path, message: `must equal ${JSON.stringify(s.const)}` });
    if (typeof value === 'number') value = this.numberBounds(value, s, path);
    if (typeof value === 'string') {
      if (s.minLength !== undefined && value.length < s.minLength)
        this.errors.push({ path, message: `shorter than ${s.minLength}` });
      if (s.maxLength !== undefined && value.length > s.maxLength)
        this.errors.push({ path, message: `longer than ${s.maxLength}` });
      if (s.pattern && !new RegExp(s.pattern).test(value))
        this.errors.push({ path, message: `does not match ${s.pattern}` });
    }
    if (Array.isArray(value)) value = this.array(value, s, path);
    else if (isPlainObject(value) && (s.properties || wanted.includes('object')))
      value = this.object(value, s, path);
    return value;
  }

  private numberBounds(value: number, s: JsonSchema, path: string): number {
    let v = value;
    const fix = (bound: number, msg: string) => {
      if (this.opts.coerce) {
        this.warnings.push({ path, message: `${msg}; clamped to ${bound}` });
        v = bound;
      } else this.errors.push({ path, message: msg });
    };
    if (s.minimum !== undefined && v < s.minimum) fix(s.minimum, `below minimum ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) fix(s.maximum, `above maximum ${s.maximum}`);
    if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum)
      this.errors.push({ path, message: `must be > ${s.exclusiveMinimum}` });
    if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum)
      this.errors.push({ path, message: `must be < ${s.exclusiveMaximum}` });
    return v;
  }

  private array(value: unknown[], s: JsonSchema, path: string): unknown[] {
    if (s.minItems !== undefined && value.length < s.minItems)
      this.errors.push({ path, message: `needs at least ${s.minItems} item(s)` });
    if (s.maxItems !== undefined && value.length > s.maxItems)
      this.errors.push({ path, message: `allows at most ${s.maxItems} item(s)` });
    if (!s.items) return value;
    return value.map((item, i) => this.run(item, s.items!, `${path}[${i}]`));
  }

  private object(value: Record<string, unknown>, s: JsonSchema, path: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const props = s.properties ?? {};
    const required = new Set(s.required ?? []);
    for (const [k, v] of Object.entries(value)) {
      const childPath = path ? `${path}.${k}` : k;
      const ps = props[k];
      if (!ps) {
        if (s.additionalProperties === false) {
          if (this.opts.stripUnknown) {
            this.warnings.push({ path: childPath, message: 'unknown property removed' });
            continue;
          }
          this.errors.push({ path: childPath, message: 'unknown property' });
        } else if (isPlainObject(s.additionalProperties)) {
          out[k] = this.run(v, s.additionalProperties, childPath);
          continue;
        }
        out[k] = v;
        continue;
      }
      if (v === null && !required.has(k) && !(ps.nullable === true || typesOf(ps).includes('null'))) {
        // Optional fields sent as null (strict dialects) mean "absent".
        continue;
      }
      out[k] = this.run(v, ps, childPath);
    }
    for (const k of required) {
      if (out[k] === undefined) this.errors.push({ path: path ? `${path}.${k}` : k, message: 'is required' });
    }
    return out;
  }

  private anyOf(v: unknown, s: JsonSchema, path: string): unknown {
    for (const branch of s.anyOf ?? []) {
      const sub = new Validator(this.opts);
      const out = sub.run(v, branch, path);
      if (!sub.errors.length) {
        this.warnings.push(...sub.warnings);
        return out;
      }
    }
    this.errors.push({ path, message: 'does not match any allowed shape' });
    return v;
  }

  private coerceType(v: unknown, wanted: JsonSchemaType[]): unknown {
    for (const t of wanted) {
      if ((t === 'number' || t === 'integer') && typeof v === 'string') {
        const n = Number(v.trim());
        if (v.trim() !== '' && Number.isFinite(n)) return t === 'integer' ? Math.round(n) : n;
      }
      if (t === 'boolean') {
        if (typeof v === 'string' && /^(true|yes|on)$/i.test(v.trim())) return true;
        if (typeof v === 'string' && /^(false|no|off)$/i.test(v.trim())) return false;
        if (v === 1 || v === 0) return v === 1;
      }
      if (t === 'string' && (typeof v === 'number' || typeof v === 'boolean')) return String(v);
      if (t === 'array') {
        if (typeof v === 'string' && v.trim().startsWith('[')) {
          try {
            const parsed = JSON.parse(v);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            /* ignore */
          }
        }
        return [v];
      }
      if (t === 'object' && typeof v === 'string' && v.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(v);
          if (isPlainObject(parsed)) return parsed;
        } catch {
          /* ignore */
        }
      }
    }
    return undefined;
  }
}

/** Validate (and optionally coerce) a value against a JSON-schema subset. */
export function validateJson(
  value: unknown,
  schema: JsonSchema,
  opts: ValidateOptions = {},
): SchemaValidationResult {
  const coerce = opts.coerce ?? false;
  const v = new Validator({ coerce, stripUnknown: opts.stripUnknown ?? coerce });
  const out = v.run(value, schema, '');
  return { valid: v.errors.length === 0, errors: v.errors, warnings: v.warnings, value: out };
}

export function formatSchemaIssues(issues: readonly SchemaIssue[], max = 12): string {
  const lines = issues.slice(0, max).map((i) => `- ${i.path || '(root)'} ${i.message}`);
  if (issues.length > max) lines.push(`- … ${issues.length - max} more`);
  return lines.join('\n');
}
