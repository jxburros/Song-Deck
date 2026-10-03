import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_SCHEMA,
  CANONICAL_SCHEMAS,
  compileSchema,
  countOptionalProperties,
  describeSchemaForPrompt,
  extractJson,
  OPERATIONS_SCHEMA,
  parseOperations,
  repairJson,
  unfoldParams,
  validateJson,
  type JsonSchema,
} from '../src';

const CONSTRAINTS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format'];

function nodes(s: JsonSchema, out: JsonSchema[] = []): JsonSchema[] {
  out.push(s);
  for (const c of Object.values(s.properties ?? {})) nodes(c, out);
  if (s.items) nodes(s.items, out);
  for (const b of s.anyOf ?? []) nodes(b, out);
  return out;
}

describe('schema dialect compiler', () => {
  it('anthropic: additionalProperties false on every object, no constraints, no nullable unions', () => {
    for (const [name, schema] of Object.entries(CANONICAL_SCHEMAS)) {
      const compiled = compileSchema(schema, 'anthropic');
      for (const n of nodes(compiled)) {
        if (n.type === 'object' || n.properties) expect(n.additionalProperties, name).toBe(false);
        for (const k of CONSTRAINTS) expect(n, `${name}.${k}`).not.toHaveProperty(k);
        expect(Array.isArray(n.type), name).toBe(false);
        expect(n).not.toHaveProperty('nullable');
        expect(n).not.toHaveProperty('x-keep');
      }
      expect(countOptionalProperties(compiled), name).toBeLessThanOrEqual(24);
    }
  });

  it('anthropic: folds rarely-used optional fields into params and unfoldParams restores them', () => {
    const compiled = compileSchema(OPERATIONS_SCHEMA, 'anthropic');
    const item = (compiled.properties!.operations as JsonSchema).items!;
    expect(Object.keys(item.properties!)).toEqual(expect.arrayContaining(['op', 'track', 'start_bar', 'end_bar', 'notes', 'chords', 'lines', 'mixer', 'reason', 'params']));
    expect(item.properties).not.toHaveProperty('bpm');
    const names = (item.properties!.params.items!.properties!.name.enum ?? []) as string[];
    expect(names).toEqual(expect.arrayContaining(['bpm', 'tonic', 'mode', 'transform.transpose', 'expression.vibrato', 'macros.energy', 'to_index']));
    const folded = { explanation: 'x', confidence: 0.8, operations: [{ op: 'set_tempo', params: [{ name: 'bpm', value: '140' }, { name: 'at_bar', value: '17' }] }, { op: 'transform_notes', track: 'bass', params: [{ name: 'transform.transpose', value: '12' }] }, { op: 'update_section', section: 'Chorus 1', params: [{ name: 'mood', value: '["dark","tense"]' }] }] };
    const restored = unfoldParams(folded, OPERATIONS_SCHEMA) as { operations: Record<string, unknown>[] };
    expect(restored.operations[0]).toEqual({ op: 'set_tempo', bpm: 140, at_bar: 17 });
    expect(restored.operations[1]).toEqual({ op: 'transform_notes', track: 'bass', transform: { transpose: 12 } });
    expect(restored.operations[2]).toEqual({ op: 'update_section', section: 'Chorus 1', mood: ['dark', 'tense'] });
    const parsed = parseOperations(folded);
    expect(parsed.errors).toEqual([]);
    expect(parsed.operations[0]).toEqual({ op: 'set_tempo', bpm: 140, at_bar: 17 });
    expect(parsed.operations[1]).toEqual({ op: 'transform_notes', track: 'bass', transform: { transpose: 12 } });
  });

  it('openai-strict: every property required, optional ones nullable, objects closed', () => {
    for (const schema of Object.values(CANONICAL_SCHEMAS)) {
      const compiled = compileSchema(schema, 'openai-strict');
      for (const n of nodes(compiled)) {
        if (n.properties) {
          expect(n.additionalProperties).toBe(false);
          expect(n.required).toEqual(Object.keys(n.properties));
        }
        for (const k of CONSTRAINTS) expect(n).not.toHaveProperty(k);
      }
    }
    const bp = compileSchema(BLUEPRINT_SCHEMA, 'openai-strict');
    expect(bp.properties!.title.type).toBe('string');
    expect(bp.properties!.lyrics_theme.type).toEqual(['string', 'null']);
    expect(bp.properties!.vocal.anyOf).toHaveLength(2);
    const instr = bp.properties!.instrumentation.items!.properties!;
    expect(instr.function.enum).toContain(null);
    expect(compileSchema(BLUEPRINT_SCHEMA, 'openai-strict', { keepConstraints: true }).properties!.tempo.minimum).toBe(30);
  });

  it('gemini: OpenAPI subset (uppercase types, nullable, no additionalProperties, propertyOrdering)', () => {
    const g = compileSchema(CANONICAL_SCHEMAS.lyrics, 'gemini') as Record<string, any>;
    expect(g.type).toBe('OBJECT');
    expect(g.required).toEqual(['sections']);
    expect(g.properties.title).toEqual({ type: 'STRING', description: 'Suggested title', nullable: true });
    expect(g.propertyOrdering).toEqual(['title', 'sections', 'notes', 'confidence']);
    expect(JSON.stringify(g)).not.toMatch(/additionalProperties|minimum|maximum/);
    const plan = compileSchema(CANONICAL_SCHEMAS.composition_plan, 'gemini') as Record<string, any>;
    // integer enums are dropped (Gemini enums are strings only)
    expect(plan.properties.meter.properties.denominator).toEqual({ type: 'INTEGER', description: 'Beat unit (4 = quarter note, 8 = eighth note)' });
    expect(plan.properties.key.properties.mode.enum).toContain('dorian');
  });

  it('json-schema keeps optional properties optional and objects closed; prompt-only describes the shape', () => {
    const j = compileSchema(CANONICAL_SCHEMAS.chat_answer, 'json-schema');
    expect(j.required).toEqual(['answer', 'suggestions', 'operations', 'confidence']);
    expect(j.additionalProperties).toBe(false);
    const text = describeSchemaForPrompt(CANONICAL_SCHEMAS.lyrics);
    expect(text).toContain('"title"?: string');
    expect(text).toContain('"sections": {');
    expect(text).toContain('"lines": string[]');
  });
});

describe('validateJson', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      bpm: { type: 'number', minimum: 20, maximum: 300 },
      bars: { type: 'integer' },
      mode: { type: 'string', enum: ['major', 'minor', 'pre-chorus'] },
      on: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
      note: { type: 'string' },
    },
    required: ['bpm', 'mode'],
    additionalProperties: false,
  };
  it('reports errors without coercion', () => {
    const r = validateJson({ bpm: '120', mode: 'Minor', extra: 1 }, schema);
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.path)).toEqual(['bpm', 'mode', 'extra']);
  });
  it('coerces typical LLM deviations', () => {
    const r = validateJson({ bpm: '400', bars: 7.6, mode: 'Pre Chorus', on: 'yes', tags: 'solo', note: null, extra: 1 }, schema, { coerce: true });
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({ bpm: 300, bars: 8, mode: 'pre-chorus', on: true, tags: ['solo'] });
    expect(r.warnings.length).toBeGreaterThanOrEqual(5);
    const missing = validateJson({ mode: 'major' }, schema, { coerce: true });
    expect(missing.errors).toEqual([{ path: 'bpm', message: 'is required' }]);
  });
});

describe('extractJson', () => {
  it('handles code fences and leading prose', () => {
    const r = extractJson('Sure! Here is the plan:\n```json\n{"a": 1, "b": [1, 2]}\n```\nLet me know.');
    expect(r).toMatchObject({ ok: true, value: { a: 1, b: [1, 2] }, repaired: false });
  });
  it('repairs trailing commas, single quotes, comments, python literals and bare keys', () => {
    const messy = `Here you go:
    {
      // operations for the bass
      'explanation': 'It\\'s "punchier" now',
      ops: [ { op: 'add_notes', velocity: +96, ok: True, none: None, ratio: .5, }, ],
      /* trailing */ "x": NaN,
    }
    Hope that helps!`;
    const r = extractJson(messy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      expect(r.value).toEqual({ explanation: 'It\'s "punchier" now', ops: [{ op: 'add_notes', velocity: 96, ok: true, none: null, ratio: 0.5 }], x: null });
    }
  });
  it('inserts missing commas, strips <think> blocks and closes truncated output at the last complete member', () => {
    expect(extractJson('<think>let me think {not json}</think>{"a": 1\n "b": 2}')).toMatchObject({ ok: true, value: { a: 1, b: 2 } });
    const truncated = extractJson('{"explanation":"x","operations":[{"op":"add_notes","notes":[{"pitch":"E2","bar":1},{"pitch":"G');
    expect(truncated).toMatchObject({ ok: true, truncated: true, value: { explanation: 'x', operations: [{ op: 'add_notes', notes: [{ pitch: 'E2', bar: 1 }] }] } });
    // A number at the very end may be cut off → dropped; a complete one is kept.
    expect(repairJson('{"a": {"b": [1, 2').text).toBe('{"a": {"b": [1]}}');
    expect(repairJson('{"a": {"b": [1, 2 ').text).toBe('{"a": {"b": [1, 2]}}');
    expect(repairJson('{"a": 1, "b"').text).toBe('{"a": 1}');
    expect(repairJson('{"a": "unterminated').text).toBe('{}');
    expect(extractJson('no json here')).toMatchObject({ ok: false });
    expect(extractJson('')).toMatchObject({ ok: false });
  });
});

describe('parseOperations', () => {
  it('converts messy model output into typed operations, dropping invalid ones', () => {
    const output = `I made the bass busier:
\`\`\`json
{
  "explanation": "Busier bass in the chorus",
  "confidence": "85",
  "operations": [
    { "operation": "replace_notes", "track": "bass", "region": {"start_bar": "17", "end_bar": 24},
      "notes": [ {"pitch": "E2", "bar": 17, "beat": 1, "duration_beats": "0.5", "velocity": 140},
                 {"pitch": 40, "bar": 17, "beat": "1.5", "duration": 0.5, "articulation": "Palm Mute"},
                 {"pitch": "H9", "bar": 17, "beat": 2, "duration_beats": 1},
                 {"pitch": "G2", "bar": 0, "beat": 1, "duration_beats": 1} ], "reason": "more movement" },
    { "op": "set_chords", "start_bar": 17, "end_bar": 18, "chords": [ {"bar": 17, "beat": 1, "symbol": "Em", "duration_beats": 4}, {"bar": 18, "beat": 1, "symbol": "Xyz7", "duration_beats": 4} ] },
    { "op": "set-tempo", "bpm": "140 bpm", "at_bar": null },
    { "op": "set_key", "key": "D dorian", "transpose_notes": "true" },
    { "op": "set_mixer", "track": "Lead Vocal", "mixer": [ {"param": "volumeDb", "value": "-3"}, {"param": "mute", "value": 0}, {"param": "warmth", "value": 1} ] },
    { "op": "set_mixer", "track": "master", "changes": { "eq.highShelfDb": 2 } },
    { "op": "transform_notes", "track": "drums", "transform": { "quantize_beats": 0.25, "humanize": 2 } },
    { "op": "update_section", "section": "Chorus 1", "changes": { "energy": 120, "kind": "Final Chorus" } },
    { "op": "set_lyrics", "section": "Verse 1", "lines": "line one\\nline two" },
    { "op": "add_track", "name": "Strings", "instrument_id": "string-ensemble", "role": "strings", "function": "pad" },
    { "op": "delete_notes", "track": "bass" },
    { "op": "explode_song" },
    { "op": "set_automation", "track": "Lead Vocal", "param": "volumeDb", "points": [ {"bar": 1, "beat": 1, "value": -6}, {"bar": 4, "value": 0} ] },
    { "op": "set_macros", "macros": { "melodicMovement": 0.8, "energy": 70 } },
    { "op": "regenerate", "track": "keys", "sections": ["Bridge"], "level": "Variation", "seed": "42" }
  ]
}
\`\`\``;
    const r = parseOperations(output);
    expect(r.explanation).toBe('Busier bass in the chorus');
    expect(r.confidence).toBe(0.85);
    const ops = r.operations;
    expect(ops.map((o) => o.op)).toEqual(['replace_notes', 'set_chords', 'set_tempo', 'set_key', 'set_mixer', 'set_mixer', 'transform_notes', 'update_section', 'set_lyrics', 'add_track', 'set_automation', 'set_macros', 'regenerate']);
    expect(ops[0]).toEqual({
      op: 'replace_notes',
      track: 'bass',
      region: { start_bar: 17, end_bar: 24 },
      notes: [
        { pitch: 40, bar: 17, beat: 1, duration_beats: 0.5, velocity: 127 },
        { pitch: 40, bar: 17, beat: 1.5, duration_beats: 0.5, articulation: 'palm-mute' },
      ],
      reason: 'more movement',
    });
    expect(ops[1]).toEqual({ op: 'set_chords', region: { start_bar: 17, end_bar: 18 }, chords: [{ bar: 17, beat: 1, symbol: 'Em', duration_beats: 4 }] });
    expect(ops[2]).toEqual({ op: 'set_tempo', bpm: 140 });
    expect(ops[3]).toEqual({ op: 'set_key', tonic: 'D', mode: 'dorian', transpose_notes: true });
    expect(ops[4]).toEqual({ op: 'set_mixer', track: 'Lead Vocal', changes: { volumeDb: -3, mute: false } });
    expect(ops[5]).toEqual({ op: 'set_mixer', track: 'master', changes: { 'eq.highShelfDb': 2 } });
    expect(ops[6]).toEqual({ op: 'transform_notes', track: 'drums', transform: { quantize_beats: 0.25, humanize: 1 } });
    expect(ops[7]).toEqual({ op: 'update_section', section: 'Chorus 1', changes: { energy: 100, kind: 'final-chorus' } });
    expect(ops[8]).toEqual({ op: 'set_lyrics', section: 'Verse 1', lines: ['line one', 'line two'] });
    expect(ops[9]).toEqual({ op: 'add_track', name: 'Strings', instrument_id: 'string-ensemble', role: 'strings', function: 'pad' });
    expect(ops[10]).toEqual({ op: 'set_automation', track: 'Lead Vocal', param: 'volumeDb', points: [{ bar: 1, beat: 1, value: -6 }, { bar: 4, beat: 1, value: 0 }] });
    expect(ops[11]).toEqual({ op: 'set_macros', macros: { melodicMovement: 0.8, energy: 0.7 } });
    expect(ops[12]).toEqual({ op: 'regenerate', track: 'keys', sections: ['Bridge'], level: 'variation', seed: 42 });
    // Dropped operations are reported with their index.
    expect(r.errors).toEqual([
      { index: 10, op: 'delete_notes', message: 'delete_notes needs a region, note_ids or a pitch range' },
      { index: 11, message: 'unknown operation "explode_song"' },
    ]);
    // Fixes are reported as warnings.
    const warnings = r.warnings.map((w) => w.message).join('\n');
    expect(warnings).toMatch(/velocity 140 clamped to 127/);
    expect(warnings).toMatch(/invalid pitch "H9"/);
    expect(warnings).toMatch(/invalid bar 0 \(1-based\)/);
    expect(warnings).toMatch(/invalid symbol "Xyz7"/);
    expect(warnings).toMatch(/unknown mixer parameter "warmth"/);
  });

  it('accepts a bare list, a single op and restricts op types when asked', () => {
    expect(parseOperations([{ op: 'remove_track', track: 'Drums' }]).operations).toEqual([{ op: 'remove_track', track: 'Drums' }]);
    expect(parseOperations({ op: 'move_section', section: 'Bridge', to_index: '2' }).operations).toEqual([{ op: 'move_section', section: 'Bridge', to_index: 2 }]);
    const r = parseOperations({ operations: [{ op: 'set_tempo', bpm: 100 }, { op: 'set_mixer', track: 'bass', mixer: [{ param: 'pan', value: -0.3 }] }] }, { allowedOps: ['set_mixer', 'set_automation'] });
    expect(r.operations).toEqual([{ op: 'set_mixer', track: 'bass', changes: { pan: -0.3 } }]);
    expect(r.errors[0].message).toBe('operation "set_tempo" is not allowed here');
    expect(parseOperations('total garbage').errors[0].index).toBe(-1);
  });
});
