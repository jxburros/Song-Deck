/**
 * Heuristic model capability inference for endpoints that report little metadata
 * (OpenAI-compatible `/models`, Ollama tags). Results are marked `capabilitiesInferred` and are
 * overridable per model in the provider config (spec §3.1: capabilities are discovered, not
 * hard-coded into routing).
 */
import { type Capability, LLM_BASE_CAPABILITIES, unionCapabilities } from './capabilities';
import type { ModelInfo } from './types';

/** Model ids that are not chat/completion LLMs (embeddings, speech, images, moderation…). */
const NON_CHAT =
  /(embed|embedding|whisper|tts|text-to-speech|transcribe|dall-e|dalle|gpt-image|imagen|image-gen|stable-diffusion|sdxl|flux|sora|veo|moderation|rerank|guard|bge-|^e5-|clip|davinci|babbage|realtime|computer-use|search-preview|aqa|lyria)/i;

const LONG_CONTEXT_FAMILIES =
  /(gpt-4o|gpt-4\.1|gpt-5|^o[1-9]|o[1-9]-|llama-?3\.[1-9]|llama-?4|llama3\.[1-9]|llama4|kimi|moonshot|mistral-(large|small|medium)|mistral-small3|deepseek|gemini|claude|qwen-?2\.5|command-r|jamba|phi-?4|128k|200k|1m\b|long)/i;
const TOOL_FAMILIES =
  /(gpt-|^o[1-9]|o[1-9]-|llama-?3\.[1-9]|llama3\.[1-9]|llama-?4|qwen|mistral|mixtral|kimi|moonshot|deepseek|command-r|hermes|functionary|granite|gemini|claude|glm|phi-?4)/i;
const AUDIO_FAMILIES = /(audio|gemini|qwen2-audio|qwen2\.5-omni|qwen-omni|voxtral|phi-4-multimodal)/i;

/** Parameter count in billions parsed from an id ("llama-3.1-70b", "qwen3:8b", "8x7b"). */
export function parameterBillions(id: string, parameterSize?: string): number | undefined {
  const fromSize = parameterSize ? /([\d.]+)\s*([bm])/i.exec(parameterSize) : null;
  if (fromSize) return fromSize[2].toLowerCase() === 'm' ? Number(fromSize[1]) / 1000 : Number(fromSize[1]);
  const moe = /(\d+)x(\d+(?:\.\d+)?)b/i.exec(id);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const m = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?:[^a-z]|$)/i.exec(id);
  return m ? Number(m[1]) : undefined;
}

/** Quality tier 1..5 from family names and size. */
export function inferQualityTier(id: string, parameterSize?: string): number {
  const s = id.toLowerCase();
  if (
    /(opus|fable|mythos|gpt-5(?![.\d]*-(mini|nano))|^o3(?!-mini)|gpt-4\.1(?!-(mini|nano))|gpt-4o(?!-mini)|gemini-[\d.]+-pro|kimi-k2|deepseek-r1|405b|qwen3-235b|llama-4-maverick)/.test(
      s,
    )
  )
    return 5;
  if (
    /(sonnet|gpt-[\d.]+-mini|o4-mini|o3-mini|flash(?!-lite)|mistral-large|llama-4-scout|deepseek-v3|deepseek-chat|qwen3-32b|qwen3-30b|command-r-plus)/.test(
      s,
    )
  )
    return 4;
  if (/(haiku|nano|flash-lite)/.test(s)) return 3;
  const b = parameterBillions(s, parameterSize);
  if (b !== undefined) {
    if (b >= 200) return 5;
    if (b >= 60) return 4;
    if (b >= 20) return 3;
    if (b >= 6) return 2;
    return 1;
  }
  return 3;
}

export interface InferOptions {
  /** Server-reported context window. */
  contextLength?: number;
  /** Ollama "8.0B" style size. */
  parameterSize?: string;
  /** Whether the endpoint can produce structured JSON (schema or JSON mode). Default true. */
  structuredOutput?: boolean;
  /** Explicit server-reported capability hints (e.g. Ollama: completion, tools, vision, embedding). */
  serverCapabilities?: string[];
}

/**
 * Infer capabilities of a chat model from its id and metadata. Returns undefined for models that
 * are not chat LLMs (embeddings, speech, images…).
 */
export function inferModelCapabilities(
  id: string,
  opts: InferOptions = {},
): Pick<ModelInfo, 'capabilities' | 'qualityTier' | 'contextLength' | 'capabilitiesInferred'> | undefined {
  const server = (opts.serverCapabilities ?? []).map((c) => c.toLowerCase());
  if (server.length && !server.includes('completion') && !server.includes('chat')) return undefined;
  if (!server.length && NON_CHAT.test(id)) return undefined;
  const caps: Capability[] = [...LLM_BASE_CAPABILITIES];
  if (opts.structuredOutput !== false) caps.push('STRUCTURED_JSON');
  if (server.includes('tools') || (!server.length && TOOL_FAMILIES.test(id))) caps.push('TOOL_CALLING');
  if (
    (opts.contextLength !== undefined && opts.contextLength >= 100_000) ||
    (opts.contextLength === undefined && LONG_CONTEXT_FAMILIES.test(id))
  )
    caps.push('LONG_CONTEXT');
  if (server.includes('audio') || AUDIO_FAMILIES.test(id)) caps.push('AUDIO_INPUT', 'AUDIO_UNDERSTANDING');
  const out: Pick<ModelInfo, 'capabilities' | 'qualityTier' | 'contextLength' | 'capabilitiesInferred'> = {
    capabilities: unionCapabilities(caps),
    qualityTier: inferQualityTier(id, opts.parameterSize),
    capabilitiesInferred: true,
  };
  if (opts.contextLength) out.contextLength = opts.contextLength;
  return out;
}
