/**
 * Persisted provider configuration (spec §4.1 custom endpoint fields, §7 BYOK).
 *
 * A ProviderConfig NEVER contains secrets: credentials are referenced by `credentialRef` and live
 * in the server vault (OS keychain) or an in-memory session store.
 */
import { stableStringify } from '@songdeck/core';
import { type Capability, isCapability } from './capabilities';
import { ConfigurationError } from './errors';
import type { AdapterKind, AuthSpec, PricingInfo, ModelInfo } from './types';
import { fnvHex, isPlainObject } from './util';

/**
 * How structured JSON is requested:
 *  - `json_schema`: provider-native schema-constrained output (OpenAI `response_format.json_schema`,
 *    Anthropic `output_config.format`, Gemini `responseSchema`, Ollama `format: <schema>`)
 *  - `json_object`: JSON mode without a schema (schema described in the prompt)
 *  - `prompt`: no API-level constraint; schema described in the system prompt
 */
export type StructuredOutputMode = 'json_schema' | 'json_object' | 'prompt';

export type SchemaDialect = 'openai-strict' | 'anthropic' | 'gemini' | 'json-schema' | 'prompt-only';

export interface ProviderBudget {
  perGenerationUsd?: number;
  dailyUsd?: number;
  monthlyUsd?: number;
}

/** A model entered manually (servers that cannot list models, or capability overrides per model). */
export interface ManualModel {
  id: string;
  name?: string;
  capabilities?: Capability[];
  contextLength?: number;
  maxOutputTokens?: number;
  qualityTier?: number;
}

/** Template for the custom HTTP LLM adapter (spec §4.1 "custom HTTP endpoint"). */
export interface CustomHttpTemplate {
  method?: 'POST' | 'PUT' | 'GET';
  /** Full URL; may contain {{model}}. Defaults to the config baseUrl. */
  url?: string;
  headers?: Record<string, string>;
  /**
   * Body template. Placeholders:
   *  {{system}} {{prompt}} {{model}}   — inserted JSON-escaped (place them inside quotes)
   *  {{messages_json}} {{schema_json}} — inserted as raw JSON
   *  {{max_tokens}} {{temperature}}    — inserted as numbers
   *  {{system_json}} {{prompt_json}}   — inserted as quoted JSON strings
   */
  body: string;
  /** Path of the generated text in the response, e.g. `choices[0].message.content`. */
  responseTextPath: string;
  /** Optional usage paths, e.g. `usage.prompt_tokens`. */
  inputTokensPath?: string;
  outputTokensPath?: string;
  /** Optional model listing endpoint (GET) and the path of the id array / objects. */
  modelsUrl?: string;
  modelsPath?: string;
}

/** Adapter-specific settings. Never put secrets here. */
export interface ProviderExtra {
  /** Anthropic: output_config.effort (default 'medium'). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Anthropic: server-side refusal fallbacks for supported models (default true). */
  refusalFallback?: boolean;
  /** OpenAI-compatible: which max-token field to send (default per preset). */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** OpenAI-compatible: schema dialect inside response_format (default openai-strict for cloud, json-schema for local). */
  schemaDialect?: SchemaDialect;
  /** Default max output tokens for LLM calls. */
  maxOutputTokens?: number;
  /** Vertex AI (Lyria): GCP project id and location. */
  vertexProject?: string;
  vertexLocation?: string;
  /**
   * Anthropic adapter: where Claude is served. `bedrock` = Claude in Amazon Bedrock (Messages API at
   * `https://bedrock-mantle.{region}.api.aws/anthropic`, Bedrock API key in `x-api-key`); `vertex` =
   * Claude on Google Cloud Vertex AI (`rawPredict`, OAuth access token). Default `first-party`.
   */
  anthropicPlatform?: 'first-party' | 'bedrock' | 'vertex';
  /** Custom HTTP LLM template. */
  customTemplate?: CustomHttpTemplate;
  /** Audio output format (ElevenLabs `output_format`, Stability `output_format`). */
  outputFormat?: string;
  /** Stability: diffusion steps / CFG scale. */
  steps?: number;
  cfgScale?: number;
  [key: string]: unknown;
}

export interface ProviderConfig {
  /** Last connected model catalog, so text/audio capabilities remain available after reload. */
  modelCatalog?: ModelInfo[];
  id: string;
  presetId?: string;
  name: string;
  adapter: AdapterKind;
  enabled: boolean;
  location: 'cloud' | 'local';
  baseUrl: string;
  /** Vault reference of the API key / access token (never the secret itself). */
  credentialRef?: string;
  auth: AuthSpec;
  organization?: string;
  project?: string;
  region?: string;
  defaultModel?: string;
  /** Manually configured models (merged with discovered ones). */
  models?: ManualModel[];
  /**
   * Models chosen for use in Song Deck (the "Connect a service" flow). When set, discovered and
   * manual models outside this list are ignored by the registry and the router.
   */
  enabledModels?: string[];
  /** Capability override for the provider (replaces preset/discovered provider-level capabilities). */
  capabilities?: Capability[];
  structuredOutput?: StructuredOutputMode;
  timeoutMs: number;
  concurrency: number;
  contextLength?: number;
  requestsPerMinute?: number;
  budget?: ProviderBudget;
  /** 1..5 */
  qualityTier?: number;
  pricing?: PricingInfo;
  extra?: ProviderExtra;
}

const SECRET_KEY_RE =
  /^(api[-_]?key|apikey|secret|client[-_]?secret|password|passwd|token|access[-_]?token|refresh[-_]?token|bearer|authorization|x-api-key|xi-api-key|x-goog-api-key|private[-_]?key)$/i;
const SECRET_VALUE_RE =
  /^(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9_.-]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})$/;

/**
 * Find fields of a config that look like secrets (keys named apiKey/token/…, or values shaped like
 * API keys). Header templates are inspected too. Returns dotted paths.
 */
export function findSecretsInConfig(config: unknown): string[] {
  const found: string[] = [];
  const visit = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (SECRET_VALUE_RE.test(v.trim())) found.push(path);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (isPlainObject(v)) {
      for (const [k, val] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        if (k === 'credentialRef') continue;
        if (SECRET_KEY_RE.test(k) && typeof val === 'string' && val.length > 0 && !/^\{\{.*\}\}$/.test(val)) {
          found.push(p);
          continue;
        }
        visit(val, p);
      }
    }
  };
  visit(config, '');
  return found;
}

/** Throws ConfigurationError if a config contains anything that looks like a secret (spec §7). */
export function assertNoSecrets(config: ProviderConfig): void {
  const secrets = findSecretsInConfig(config);
  if (secrets.length) {
    throw new ConfigurationError(
      `Provider config "${config.id}" must not contain secrets (store them in the vault and reference them with credentialRef)`,
      secrets,
    );
  }
}

/** Remove secret-looking fields (defensive, before persisting configs or project files). */
export function sanitizeConfig<T>(config: T): T {
  const paths = new Set(findSecretsInConfig(config));
  if (!paths.size) return config;
  const strip = (v: unknown, path: string): unknown => {
    if (paths.has(path)) return undefined;
    if (Array.isArray(v)) return v.map((item, i) => strip(item, `${path}[${i}]`));
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        const s = strip(val, p);
        if (s !== undefined) out[k] = s;
      }
      return out;
    }
    return v;
  };
  return strip(config, '') as T;
}

/** Validate a config; returns human-readable problems (empty = valid). */
export function validateProviderConfig(config: ProviderConfig): string[] {
  const problems: string[] = [];
  if (!config.id || !/^[A-Za-z0-9._:-]+$/.test(config.id))
    problems.push('id must be non-empty and contain only letters, digits, . _ : -');
  if (!config.name?.trim()) problems.push('name is required');
  if (!config.adapter) problems.push('adapter is required');
  if (config.location !== 'cloud' && config.location !== 'local')
    problems.push("location must be 'cloud' or 'local'");
  if (config.adapter !== 'managed' && config.adapter !== 'google-lyria' && !config.baseUrl?.trim())
    problems.push('baseUrl is required');
  if (config.baseUrl && !/^(https?:\/\/|\/)/.test(config.baseUrl))
    problems.push('baseUrl must start with http://, https:// or /');
  if (!config.auth || !['bearer', 'header', 'query', 'none'].includes(config.auth.type))
    problems.push('auth.type must be bearer, header, query or none');
  if ((config.auth?.type === 'header' || config.auth?.type === 'query') && !config.auth.name)
    problems.push(`auth.name is required for auth type ${config.auth.type}`);
  if (!(config.timeoutMs > 0)) problems.push('timeoutMs must be > 0');
  if (!(config.concurrency >= 1)) problems.push('concurrency must be >= 1');
  if (config.qualityTier !== undefined && (config.qualityTier < 1 || config.qualityTier > 5))
    problems.push('qualityTier must be 1..5');
  if (config.requestsPerMinute !== undefined && !(config.requestsPerMinute > 0))
    problems.push('requestsPerMinute must be > 0');
  for (const c of config.capabilities ?? [])
    if (!isCapability(c)) problems.push(`unknown capability ${String(c)}`);
  for (const p of findSecretsInConfig(config)) problems.push(`possible secret at ${p} (use credentialRef)`);
  return problems;
}

/** Stable fingerprint of the parts of a config that affect generation (GenerationInfo.providerFingerprint). */
export function configFingerprint(config: ProviderConfig, modelId?: string): string {
  return fnvHex(
    stableStringify({
      adapter: config.adapter,
      presetId: config.presetId,
      baseUrl: config.baseUrl,
      model: modelId ?? config.defaultModel,
      structuredOutput: config.structuredOutput,
      extra: config.extra ?? {},
    }),
  );
}

/** Suggested vault reference for a provider's credential. */
export function defaultCredentialRef(providerId: string): string {
  return `provider:${providerId}`;
}

export function authForConfig(
  config: Pick<ProviderConfig, 'auth' | 'credentialRef'>,
): AuthSpec & { credentialRef?: string } {
  return { ...config.auth, credentialRef: config.auth.type === 'none' ? undefined : config.credentialRef };
}
