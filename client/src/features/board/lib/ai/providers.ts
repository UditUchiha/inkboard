export type ProviderId = "anthropic" | "openai" | "openrouter" | "gemini" | "groq";

export interface Provider {
  id: ProviderId;
  label: string;
  // OpenAI-compatible chat completions endpoint; Anthropic goes through its own SDK instead.
  baseUrl: string | null;
  defaultModel: string;
  keyPlaceholder: string;
  keyUrl: string;
}

// Defaults are suggestions; the dialog lists the models the key can use, since names change often.
export const PROVIDERS: Record<ProviderId, Provider> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: null,
    defaultModel: "claude-opus-5-5",
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.6-terra",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/auto",
    keyPlaceholder: "sk-or-…",
    keyUrl: "https://openrouter.ai/settings/keys",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-flash-latest",
    keyPlaceholder: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  groq: {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    keyPlaceholder: "gsk_…",
    keyUrl: "https://console.groq.com/keys",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export interface AiSettings {
  provider: ProviderId;
  keys: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
}

const STORAGE_KEY = "inkboard.ai";
const LEGACY_KEY = "inkboard.anthropicKey";

const isProvider = (value: unknown): value is ProviderId => typeof value === "string" && value in PROVIDERS;

const stringsOf = (value: unknown): Partial<Record<ProviderId, string>> => {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([id, text]) => isProvider(id) && typeof text === "string" && text),
  );
};

export function readAiSettings(): AiSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<AiSettings> | null;
    if (stored) {
      return {
        provider: isProvider(stored.provider) ? stored.provider : "anthropic",
        keys: stringsOf(stored.keys),
        models: stringsOf(stored.models),
      };
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    return { provider: "anthropic", keys: legacy ? { anthropic: legacy } : {}, models: {} };
  } catch {
    return { provider: "anthropic", keys: {}, models: {} };
  }
}

export function saveAiSettings(settings: AiSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Storage blocked: the settings last until the page closes.
  }
}

export const activeKey = (settings: AiSettings) => settings.keys[settings.provider] ?? "";

export const activeModel = (settings: AiSettings) =>
  settings.models[settings.provider] || PROVIDERS[settings.provider].defaultModel;

export const hasAiKey = () => activeKey(readAiSettings()) !== "";
