/**
 * A tiny router: method + path patterns with `:param` and trailing `*rest` segments.
 *
 * Patterns are matched against the raw (percent-encoded) path segments; parameters are decoded
 * per segment, so an encoded slash (`%2F`) stays inside one parameter value and handlers that
 * map parameters to files must validate them (see `resolveInside`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './http-util';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Aborted when the client disconnects before the response is finished. */
  signal: AbortSignal;
}

export type Handler = (ctx: RouteContext) => Promise<void> | void;

type Segment =
  { kind: 'static'; value: string } | { kind: 'param'; name: string } | { kind: 'rest'; name: string };

interface Route {
  method: string;
  pattern: string;
  segments: Segment[];
  handler: Handler;
}

export type MatchResult =
  | { kind: 'found'; handler: Handler; params: Record<string, string>; pattern: string }
  | { kind: 'method-not-allowed'; allowed: string[] }
  | { kind: 'not-found' };

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

function compile(pattern: string): Segment[] {
  const parts = pattern.split('/').filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith(':')) return { kind: 'param', name: p.slice(1) };
    if (p.startsWith('*')) {
      if (i !== parts.length - 1) throw new Error(`Rest segment must be last in ${pattern}`);
      return { kind: 'rest', name: p.slice(1) || 'rest' };
    }
    return { kind: 'static', value: p };
  });
}

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new HttpError(400, 'bad-path', 'Malformed percent-encoding in the request path');
  }
}

function matchSegments(segments: Segment[], parts: string[]): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === 'rest') {
      const rest = parts.slice(i);
      if (!rest.length) return undefined;
      params[seg.name] = rest.map(decode).join('/');
      return params;
    }
    const part = parts[i];
    if (part === undefined) return undefined;
    if (seg.kind === 'static') {
      if (part !== seg.value) return undefined;
    } else {
      if (part === '') return undefined;
      params[seg.name] = decode(part);
    }
  }
  return parts.length === segments.length ? params : undefined;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string | string[], pattern: string, handler: Handler): this {
    const methods = Array.isArray(method) ? method : [method];
    const segments = compile(pattern);
    for (const m of methods) this.routes.push({ method: m.toUpperCase(), pattern, segments, handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add(['GET', 'HEAD'], pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  put(pattern: string, handler: Handler): this {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  match(method: string, pathname: string): MatchResult {
    const parts = splitPath(pathname);
    const allowed = new Set<string>();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      if (route.method === method.toUpperCase())
        return { kind: 'found', handler: route.handler, params, pattern: route.pattern };
      allowed.add(route.method);
    }
    if (allowed.size) return { kind: 'method-not-allowed', allowed: [...allowed] };
    return { kind: 'not-found' };
  }
}
