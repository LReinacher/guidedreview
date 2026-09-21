/**
 * Canonical registry of AI providers and models for Guided Review.
 *
 * UI labels, icons, key placeholders, and model lists all come from here.
 * Adding a model is a single MODELS row. Adding a provider also requires a
 * client in this package (`providers/`).
 */

export type ProviderId = "anthropic" | "openai" | "grok";

interface ProviderDefinition {
  id: ProviderId;
  /** Human-readable label shown in the provider dropdown. */
  displayName: string;
  /** Example key format for the API key input. */
  keyPlaceholder: string;
  /**
   * Path under the extension root (public/) for the provider icon.
   * Resolve with chrome.runtime.getURL(iconSrc) in extension pages.
   */
  iconSrc: string;
  /** Default model id when this provider is selected. */
  defaultModelId: string;
}

interface ModelDefinition {
  /** Exact string passed to the provider API. */
  id: string;
  /** Human-readable label shown in the model dropdown. */
  displayName: string;
  provider: ProviderId;
  /**
   * Model accepts a reasoning-effort setting. Omitted means it does not —
   * sending one anyway is a hard request error, so we leave it off and take
   * the provider default.
   */
  supportsEffort?: boolean;
}

/**
 * Reasoning effort every provider is asked for. Planning the walkthrough is
 * the intelligence-sensitive step of the product, so it always runs high
 * rather than trading review quality for tokens.
 */
export const REVIEW_EFFORT = "high";

/** Providers keyed by id. Key order is display order. */
export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  anthropic: {
    id: "anthropic",
    displayName: "Claude (Anthropic)",
    keyPlaceholder: "sk-ant-…",
    iconSrc: "providers/claude.svg",
    defaultModelId: "claude-opus-5",
  },
  openai: {
    id: "openai",
    displayName: "OpenAI",
    keyPlaceholder: "sk-…",
    iconSrc: "providers/openai.svg",
    defaultModelId: "gpt-4.1",
  },
  grok: {
    id: "grok",
    displayName: "Grok (xAI)",
    keyPlaceholder: "xai-…",
    iconSrc: "providers/grok.svg",
    defaultModelId: "grok-4",
  },
};

/** Providers in display order, for dropdowns. */
export const PROVIDER_LIST: readonly ProviderDefinition[] = Object.values(PROVIDERS);

/**
 * Text-generation models available for PR review annotation.
 * Keep in sync with known provider API model ids as they ship or retire.
 */
export const MODELS: readonly ModelDefinition[] = [
  // --- Anthropic ---
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    provider: "anthropic",
    supportsEffort: true,
  },
  {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    provider: "anthropic",
    supportsEffort: true,
  },
  {
    id: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    provider: "anthropic",
    supportsEffort: true,
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    provider: "anthropic",
    supportsEffort: true,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    provider: "anthropic",
    supportsEffort: true,
  },
  // Haiku 4.5 has no effort knob — the Messages API rejects one.
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", provider: "anthropic" },

  // --- OpenAI ---
  { id: "gpt-5", displayName: "GPT-5", provider: "openai" },
  { id: "gpt-5-mini", displayName: "GPT-5 Mini", provider: "openai" },
  { id: "gpt-4.1", displayName: "GPT-4.1", provider: "openai" },
  { id: "gpt-4.1-mini", displayName: "GPT-4.1 Mini", provider: "openai" },
  { id: "gpt-4o", displayName: "GPT-4o", provider: "openai" },
  { id: "o3", displayName: "o3", provider: "openai" },
  { id: "o4-mini", displayName: "o4 Mini", provider: "openai" },

  // --- Grok (xAI) ---
  { id: "grok-4.6", displayName: "Grok 4.6", provider: "grok" },
  { id: "grok-4.5", displayName: "Grok 4.5", provider: "grok" },
  { id: "grok-4", displayName: "Grok 4", provider: "grok" },
  { id: "grok-3", displayName: "Grok 3", provider: "grok" },
  { id: "grok-3-mini", displayName: "Grok 3 Mini", provider: "grok" },
] as const;

export function getProvider(id: ProviderId): ProviderDefinition {
  return PROVIDERS[id];
}

/**
 * Whether `REVIEW_EFFORT` may be sent for this model. Unknown ids (a coding
 * agent's configured model, a hand-edited config) are treated as unsupported.
 */
export function modelSupportsEffort(modelId: string): boolean {
  return MODELS.some((model) => model.id === modelId && model.supportsEffort === true);
}

export function modelsForProvider(id: ProviderId): ModelDefinition[] {
  return MODELS.filter((m) => m.provider === id);
}

export function defaultModelFor(id: ProviderId): string {
  return getProvider(id).defaultModelId;
}

/**
 * Normalize partially stored settings against the catalog (unknown provider →
 * anthropic; unknown/stale model → provider default).
 */
export function normalizeProviderSettings(stored: {
  provider?: string;
  model?: string;
  apiKey?: string;
  authScheme?: "api-key" | "bearer";
  extraHeaders?: Record<string, string>;
}): {
  provider: ProviderId;
  model: string;
  apiKey: string;
  authScheme?: "api-key" | "bearer";
  extraHeaders?: Record<string, string>;
} {
  const provider =
    stored.provider && stored.provider in PROVIDERS ? (stored.provider as ProviderId) : "anthropic";
  // Keep the stored model only if it still exists for this provider.
  const model = MODELS.find((m) => m.id === stored.model && m.provider === provider);
  return {
    provider,
    model: model?.id ?? defaultModelFor(provider),
    apiKey: stored.apiKey ?? "",
    ...(stored.authScheme ? { authScheme: stored.authScheme } : {}),
    ...(stored.extraHeaders ? { extraHeaders: stored.extraHeaders } : {}),
  };
}
