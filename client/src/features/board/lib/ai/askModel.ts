import type Anthropic from "@anthropic-ai/sdk";
import { activeKey, activeModel, PROVIDERS } from "./providers";
import type { AiSettings, Provider } from "./providers";

// Why the AI couldn't help, in a sentence for the person.
export class AiError extends Error {}

export interface AiRequest {
  settings: AiSettings;
  system: string;
  text: string;
  // A PNG data URL, sent before the text.
  image?: string;
  schema: Record<string, unknown>;
  signal: AbortSignal;
}

export interface AiAnswer {
  answer: unknown;
  stop: "done" | "refusal" | "too-long";
}

const UNREADABLE = "The answer couldn't be read. Try again.";

// Only these Claude models take server-side fallbacks and the effort setting.
const FALLBACK_MODELS = /^claude-(opus-5|fable-5|sonnet-5-5)/;

export function parseAnswer(text: string | null | undefined): unknown {
  // Models answering in plain JSON mode sometimes wrap it in a code fence.
  const json = (text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, "")
    .trim();
  try {
    return JSON.parse(json);
  } catch {
    throw new AiError(UNREADABLE);
  }
}

export async function askModel(request: AiRequest): Promise<AiAnswer> {
  const provider = PROVIDERS[request.settings.provider];
  return provider.baseUrl ? askCompatible(provider, request) : askAnthropic(request);
}

async function askAnthropic({ settings, system, text, image, schema, signal }: AiRequest): Promise<AiAnswer> {
  // Loaded only when someone uses Claude, not with every board.
  const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
  // The key is the person's own, typed into this browser for this.
  const client = new AnthropicClient({ apiKey: activeKey(settings), dangerouslyAllowBrowser: true });
  const model = activeModel(settings);
  const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text }];
  if (image) {
    const data = image.slice(image.indexOf(",") + 1);
    content.unshift({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  }
  const withFallback = FALLBACK_MODELS.test(model);
  try {
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: 16000,
        ...(withFallback && { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
        output_config: { ...(withFallback && { effort: "medium" as const }), format: { type: "json_schema", schema } },
        system,
        messages: [{ role: "user", content }],
      },
      { signal },
    );
    if (response.stop_reason === "refusal") return { answer: null, stop: "refusal" };
    if (response.stop_reason === "max_tokens") return { answer: null, stop: "too-long" };
    const answerText = response.content.find((block) => block.type === "text")?.text;
    return { answer: parseAnswer(answerText), stop: "done" };
  } catch (error) {
    if (error instanceof AnthropicClient.APIUserAbortError) throw new DOMException("Cancelled", "AbortError");
    if (error instanceof AnthropicClient.APIConnectionError) throw unreachable(PROVIDERS.anthropic);
    if (error instanceof AnthropicClient.APIError)
      throw statusError(PROVIDERS.anthropic, error.status, error.message, model);
    throw error;
  }
}

type ResponseFormat = Record<string, unknown> | null;

async function askCompatible(provider: Provider, request: AiRequest): Promise<AiAnswer> {
  // Not every model takes a JSON schema; fall back to plain JSON mode, then to the prompt alone.
  const formats: ResponseFormat[] = [
    { type: "json_schema", json_schema: { name: "answer", schema: request.schema, strict: false } },
    { type: "json_object" },
    null,
  ];
  for (const [index, format] of formats.entries()) {
    try {
      return await chatCompletion(provider, request, format);
    } catch (error) {
      if (!(error instanceof FormatRejected)) throw error;
      if (index === formats.length - 1) throw error.cause;
    }
  }
  throw new AiError(UNREADABLE);
}

class FormatRejected extends Error {}

async function chatCompletion(provider: Provider, request: AiRequest, format: ResponseFormat): Promise<AiAnswer> {
  const { settings, system, text, image, schema, signal } = request;
  const model = activeModel(settings);
  const userContent = image
    ? [
        { type: "image_url", image_url: { url: image } },
        { type: "text", text },
      ]
    : text;
  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeKey(settings)}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: `${system}\n\nAnswer with JSON matching this schema: ${JSON.stringify(schema)}` },
          { role: "user", content: userContent },
        ],
        ...(format && { response_format: format }),
      }),
    });
  } catch (error) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    throw error instanceof TypeError ? unreachable(provider) : error;
  }
  const body = (await response.json().catch(() => null)) as CompletionBody | null;
  if (!response.ok) {
    const message = errorMessage(body) ?? response.statusText;
    const error = statusError(provider, response.status, message, model);
    if (response.status === 400 && /response_format|json_schema|json_object|schema|structured/i.test(message)) {
      throw new FormatRejected(message, { cause: error });
    }
    throw error;
  }
  const choice = body?.choices?.[0];
  if (choice?.message?.refusal || choice?.finish_reason === "content_filter") return { answer: null, stop: "refusal" };
  if (choice?.finish_reason === "length") return { answer: null, stop: "too-long" };
  return { answer: parseAnswer(choice?.message?.content), stop: "done" };
}

interface CompletionBody {
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  error?: { message?: string };
  data?: { id?: string }[];
}

// Gemini wraps its error in a one-item list; the others send it as an object.
const errorMessage = (body: unknown): string | undefined => {
  const error = (Array.isArray(body) ? body[0] : body) as CompletionBody | null;
  return error?.error?.message;
};

const unreachable = (provider: Provider) =>
  new AiError(`Couldn't reach ${provider.label}. Check your connection and try again.`);

function statusError(provider: Provider, status: number | undefined, message: string, model: string) {
  const { label } = provider;
  // Gemini answers a bad key with 400 rather than 401.
  const badKey = status === 401 || (status === 400 && /api key/i.test(message));
  if (badKey) return new AiError(`${label} didn't accept that key. Check it, or make a new one.`);
  if (status === 403) return new AiError(`That ${label} key isn't allowed to use ${model}.`);
  if (status === 404) return new AiError(`${label} doesn't offer the model "${model}". Pick another one.`);
  if (status === 429) return new AiError(`Your ${label} account has reached a limit for now. Wait, or check billing.`);
  if (status === 400) return new AiError(`${label} refused the request: ${message}`);
  return new AiError(`${label} had a problem. Try again in a moment.`);
}

// The models a key can use, for the picker; empty when the list can't be fetched.
export async function listModels(settings: AiSettings, signal?: AbortSignal): Promise<string[]> {
  const provider = PROVIDERS[settings.provider];
  if (!provider.baseUrl) return [];
  try {
    const response = await fetch(`${provider.baseUrl}/models`, {
      signal,
      headers: { Authorization: `Bearer ${activeKey(settings)}` },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as CompletionBody;
    // Gemini lists its models as "models/<id>", but chat completions take the bare id.
    const ids = (body.data ?? []).flatMap((model) => (model.id ? [model.id.replace(/^models\//, "")] : []));
    return [...new Set(ids)].sort();
  } catch {
    return [];
  }
}
