/**
 * "Connect a service": recognise which provider an API key belongs to from its format.
 *
 * Only prefixes documented by the provider (or unique enough to be unambiguous) are treated as
 * certain. Everything else becomes a short list of candidates for the user to pick from — a key
 * is never sent anywhere until the user confirms the provider.
 *
 * Formats (as documented / observed, 2026):
 *  - Anthropic          `sk-ant-…` (console keys `sk-ant-api03-…`)
 *  - Google Gemini      `AIza` + 35 characters (Google Cloud API key format)
 *  - Groq               `gsk_…`
 *  - OpenAI             project `sk-proj-…`, service account `sk-svcacct-…`, admin `sk-admin-…`;
 *                       legacy user keys `sk-…` contain the marker `T3BlbkFJ`
 *  - ElevenLabs         `sk_…` (current keys); legacy keys were 32 hex characters
 *  - Together AI        `tgp_v1_…` (community-observed prefix; not in Together's docs)
 *  - Stability AI, Moonshot: plain `sk-…` like other OpenAI-style keys → ambiguous
 *  - Meta Llama API: no documented prefix → not recognised (pick the provider by hand)
 *  - OpenRouter         `sk-or-v1-…`
 *  - xAI                `xai-…`
 *  - DeepSeek           `sk-` + 32 hex characters → possible (other `sk-` services look alike)
 *  - Mistral            32 alphanumeric characters, no prefix → possible
 */

export type KeyConfidence = 'certain' | 'likely' | 'possible';

export interface KeyMatch {
  presetId: string;
  confidence: KeyConfidence;
}

export interface KeyDetection {
  /** The key as it will be stored (whitespace, quotes, `Bearer ` and `NAME=` stripped). */
  key: string;
  /** Candidate presets, most likely first. Empty = unknown format (offer every connectable preset). */
  matches: KeyMatch[];
  /** Set when the key belongs to a service Song Deck has no preset for. */
  unsupported?: string;
  /** Set when the input cannot be a key (empty, spaces inside, far too short). */
  problem?: string;
}

/** Cloud presets the connect flow can validate with a pasted key. */
export const CONNECTABLE_PRESET_IDS: readonly string[] = [
  'openai',
  'anthropic',
  'gemini',
  'groq',
  'together',
  'moonshot',
  'llama-api',
  'openrouter',
  'deepseek',
  'mistral',
  'xai',
  'elevenlabs-music',
  'stability-audio',
];

const UNSUPPORTED: { re: RegExp; name: string }[] = [
  { re: /^hf_/, name: 'Hugging Face' },
  { re: /^r8_/, name: 'Replicate' },
  { re: /^pplx-/, name: 'Perplexity' },
  { re: /^ya29\./, name: 'a Google OAuth access token (use Google Lyria on Vertex AI under Advanced)' },
];

/** Normalise pasted text: trims, drops quotes, `Bearer `, and an `ENV_NAME=` prefix. */
export function cleanPastedKey(raw: string): string {
  let k = (raw ?? '').trim();
  const env = /^(?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*(.+)$/.exec(k);
  if (env) k = env[1].trim();
  k = k.replace(/^["'`]+|["'`;,]+$/g, '').trim();
  k = k.replace(/^Bearer\s+/i, '').trim();
  return k;
}

export function detectKeyProvider(raw: string): KeyDetection {
  const key = cleanPastedKey(raw);
  const out: KeyDetection = { key, matches: [] };
  if (!key) return { ...out, problem: 'Paste an API key' };
  if (/\s/.test(key)) return { ...out, problem: 'That looks like more than one value — paste just the key' };
  if (key.length < 16) return { ...out, problem: 'That is too short to be an API key' };
  const certain = (presetId: string): KeyDetection => ({
    ...out,
    matches: [{ presetId, confidence: 'certain' }],
  });

  if (key.startsWith('sk-ant-')) return certain('anthropic');
  if (/^AIza[0-9A-Za-z_-]{35}$/.test(key)) return certain('gemini');
  if (key.startsWith('AIza')) return { ...out, matches: [{ presetId: 'gemini', confidence: 'likely' }] };
  if (key.startsWith('gsk_')) return certain('groq');
  if (/^sk-(proj|svcacct|admin)-/.test(key) || (key.startsWith('sk-') && key.includes('T3BlbkFJ')))
    return certain('openai');
  if (key.startsWith('tgp_v1_')) return certain('together');
  if (key.startsWith('sk-or-v1-')) return certain('openrouter');
  if (key.startsWith('xai-')) return certain('xai');
  if (/^sk_[0-9a-f]{40,}$/i.test(key)) return certain('elevenlabs-music');
  if (key.startsWith('sk_'))
    return { ...out, matches: [{ presetId: 'elevenlabs-music', confidence: 'likely' }] };
  for (const u of UNSUPPORTED) if (u.re.test(key)) return { ...out, unsupported: u.name };
  if (/^sk-[0-9a-f]{32}$/i.test(key)) {
    return {
      ...out,
      matches: [
        { presetId: 'deepseek', confidence: 'possible' },
        { presetId: 'openai', confidence: 'possible' },
        { presetId: 'moonshot', confidence: 'possible' },
      ],
    };
  }
  if (key.startsWith('sk-')) {
    return {
      ...out,
      matches: [
        { presetId: 'openai', confidence: 'possible' },
        { presetId: 'stability-audio', confidence: 'possible' },
        { presetId: 'moonshot', confidence: 'possible' },
      ],
    };
  }
  if (/^[0-9a-f]{32}$/i.test(key))
    return { ...out, matches: [{ presetId: 'elevenlabs-music', confidence: 'possible' }] };
  if (/^[A-Za-z0-9]{32}$/.test(key))
    return { ...out, matches: [{ presetId: 'mistral', confidence: 'possible' }] };
  if (/^[0-9a-f]{64}$/i.test(key))
    return { ...out, matches: [{ presetId: 'together', confidence: 'possible' }] };
  return out;
}
