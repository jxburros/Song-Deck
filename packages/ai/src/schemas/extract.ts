/**
 * Tolerant JSON extraction from model text (spec §46/§48: bad model output must never corrupt a
 * project — it is parsed defensively, then validated).
 *
 * Handles: code fences, leading/trailing prose, <think> blocks, trailing commas, single-quoted
 * strings, comments, unquoted keys, Python/JS literals (True/None/undefined/NaN), missing commas
 * between members, raw newlines inside strings, and truncated output (closed at the last complete
 * member, flagged `truncated`).
 */

export type ExtractJsonResult =
  | { ok: true; value: unknown; repaired: boolean; truncated: boolean; text: string }
  | { ok: false; error: string; text?: string };

const LITERALS: Record<string, string> = {
  true: 'true',
  false: 'false',
  null: 'null',
  True: 'true',
  False: 'false',
  None: 'null',
  undefined: 'null',
  NaN: 'null',
  Infinity: 'null',
  TRUE: 'true',
  FALSE: 'false',
  NULL: 'null',
};

/** Remove reasoning blocks some local models emit inline. */
export function stripThinking(text: string): string {
  let t = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  // Unclosed think block at the start: drop up to the first JSON-looking character after it.
  if (/^\s*<think(?:ing)?>/i.test(t)) {
    const close = t.search(/<\/think(?:ing)?>/i);
    t = close >= 0 ? t.slice(close).replace(/^<\/think(?:ing)?>/i, '') : t.replace(/^\s*<think(?:ing)?>/i, '');
  }
  return t;
}

function fencedBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const lang = m[1].toLowerCase();
    if (!lang || lang === 'json' || lang === 'jsonc' || lang === 'json5' || lang === 'javascript' || lang === 'js') out.push(m[2]);
  }
  return out;
}

/** Index of the first '{' or '[' that plausibly starts JSON. */
function findJsonStart(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') return i;
    if (c === '[') {
      // Skip things like "[1]" footnotes followed by prose? Accept if next non-space is a JSON value start.
      const next = text.slice(i + 1).trimStart()[0];
      if (next && /[{["'\-0-9tfnTFN\]]/.test(next)) return i;
    }
  }
  return -1;
}

/** Find the end of a balanced JSON value starting at `start` (respects strings). -1 if unbalanced. */
function findBalancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inStr: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

interface RepairResult {
  text: string;
  truncated: boolean;
}

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdentChar = (c: string) => /[A-Za-z0-9_$-]/.test(c);

/**
 * Rewrite near-JSON into strict JSON. Tracks safe cut points so truncated output can be closed at
 * the last complete member.
 */
export function repairJson(input: string): RepairResult {
  let out = '';
  const stack: ('{' | '[')[] = [];
  /** Output length right after each currently open bracket (parallel to `stack`). */
  const openAt: number[] = [];
  /** Last emitted significant token type. */
  let last: 'start' | 'open' | 'comma' | 'colon' | 'value' = 'start';
  /** Safe cut points: output length + stack snapshot after a complete member. */
  const safe: { len: number; stack: ('{' | '[')[] }[] = [];
  let i = 0;
  const n = input.length;
  let truncated = false;

  const emitValueStart = () => {
    if (last === 'value' && stack.length) {
      out += ',';
      safe.push({ len: out.length - 1, stack: [...stack] });
    }
  };

  while (i < n) {
    const c = input[i];
    // Whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      out += c;
      i++;
      continue;
    }
    // Comments
    if (c === '/' && input[i + 1] === '/') {
      while (i < n && input[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && input[i + 1] === '*') {
      const end = input.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    // Strings (double, single, smart quotes)
    if (c === '"' || c === "'" || c === '“' || c === '‘') {
      emitValueStart();
      const close = c === '“' ? '”' : c === '‘' ? '’' : c;
      let s = '"';
      i++;
      let closed = false;
      while (i < n) {
        const ch = input[i];
        if (ch === '\\') {
          const nx = input[i + 1];
          if (nx === undefined) {
            i++;
            break;
          }
          if (nx === "'") s += "'";
          else s += ch + nx;
          i += 2;
          continue;
        }
        if (ch === close) {
          closed = true;
          i++;
          break;
        }
        if (ch === '"') s += '\\"';
        else if (ch === '\n') s += '\\n';
        else if (ch === '\r') s += '\\r';
        else if (ch === '\t') s += '\\t';
        else s += ch;
        i++;
      }
      if (!closed) {
        truncated = true;
        break;
      }
      out += s + '"';
      last = 'value';
      continue;
    }
    if (c === '{' || c === '[') {
      emitValueStart();
      stack.push(c);
      out += c;
      openAt.push(out.length);
      last = 'open';
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      // Drop trailing comma.
      out = out.replace(/,(\s*)$/, '$1');
      const expected = c === '}' ? '{' : '[';
      if (stack[stack.length - 1] === expected) {
        stack.pop();
        openAt.pop();
      } else if (stack.includes(expected)) {
        while (stack.length && stack[stack.length - 1] !== expected) {
          out += stack.pop() === '{' ? '}' : ']';
          openAt.pop();
        }
        stack.pop();
        openAt.pop();
      } else {
        i++;
        continue; // stray closer
      }
      out += c;
      last = 'value';
      i++;
      if (stack.length) safe.push({ len: out.length, stack: [...stack] });
      if (!stack.length) break; // complete top-level value
      continue;
    }
    if (c === ',') {
      if (last === 'comma' || last === 'open') {
        i++;
        continue; // collapse duplicate/leading commas
      }
      safe.push({ len: out.length, stack: [...stack] });
      out += ',';
      last = 'comma';
      i++;
      continue;
    }
    if (c === ':' || c === '=') {
      out += ':';
      last = 'colon';
      i++;
      continue;
    }
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) {
      emitValueStart();
      let j = i;
      while (j < n && /[0-9eE+\-.]/.test(input[j])) j++;
      let tok = input.slice(i, j);
      if (j >= n && stack.length) {
        truncated = true;
        break;
      }
      tok = tok.replace(/^\+/, '');
      if (/^-?\./.test(tok)) tok = tok.replace('.', '0.');
      tok = tok.replace(/\.$/, '').replace(/\.(?=[eE])/, '');
      const num = Number(tok);
      out += Number.isFinite(num) ? String(num) : 'null';
      last = 'value';
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentChar(input[j])) j++;
      const word = input.slice(i, j);
      // Unquoted key?
      let k = j;
      while (k < n && /\s/.test(input[k])) k++;
      const isKey = stack[stack.length - 1] === '{' && (input[k] === ':' || input[k] === '=') && last !== 'colon';
      emitValueStart();
      if (isKey) out += JSON.stringify(word);
      else if (LITERALS[word] !== undefined) out += LITERALS[word];
      else out += JSON.stringify(word);
      last = 'value';
      i = j;
      continue;
    }
    // Anything else (prose after JSON, stray characters) — skip.
    i++;
  }

  if (stack.length) {
    truncated = true;
    let closeStack = [...stack];
    const trimmed = out.replace(/\s+$/, '');
    // A string right after '{' or ',' inside an object is a key whose value never arrived.
    const danglingKey = stack[stack.length - 1] === '{' && last === 'value' && /[{,]\s*"(?:[^"\\]|\\.)*"$/.test(trimmed);
    if (last === 'colon' || last === 'comma' || danglingKey) {
      const point = safe[safe.length - 1];
      if (point) {
        out = out.slice(0, point.len);
        closeStack = point.stack;
      } else {
        // Nothing complete yet: keep the containers but drop their incomplete content.
        out = out.slice(0, openAt[openAt.length - 1] ?? 0);
      }
    }
    out = out.replace(/[\s,]+$/, '');
    for (let s = closeStack.length - 1; s >= 0; s--) out += closeStack[s] === '{' ? '}' : ']';
  }
  return { text: out.trim(), truncated };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Extract the first JSON object/array from model output. */
export function extractJson(raw: string): ExtractJsonResult {
  if (typeof raw !== 'string') return { ok: false, error: 'Model output is not text' };
  const text = stripThinking(raw).trim();
  if (!text) return { ok: false, error: 'Empty model output' };

  const direct = tryParse(text);
  if (direct.ok && typeof direct.value === 'object' && direct.value !== null) return { ok: true, value: direct.value, repaired: false, truncated: false, text };

  const candidates: string[] = [...fencedBlocks(text), text];
  let lastError = 'No JSON object found in model output';
  for (const candidate of candidates) {
    const start = findJsonStart(candidate);
    if (start < 0) continue;
    const end = findBalancedEnd(candidate, start);
    const slice = end >= 0 ? candidate.slice(start, end + 1) : candidate.slice(start);
    const parsed = tryParse(slice);
    if (parsed.ok) return { ok: true, value: parsed.value, repaired: false, truncated: false, text: slice };
    const repaired = repairJson(slice);
    const reparsed = tryParse(repaired.text);
    if (reparsed.ok && typeof reparsed.value === 'object' && reparsed.value !== null) {
      return { ok: true, value: reparsed.value, repaired: true, truncated: repaired.truncated || end < 0, text: repaired.text };
    }
    lastError = `Could not parse JSON${end < 0 ? ' (output looks truncated)' : ''}`;
  }
  return { ok: false, error: lastError, text };
}
