import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { askModel, listModels, parseAnswer } from "../src/features/board/lib/ai/askModel.ts";
import { activeModel, hasAiKey, readAiSettings, saveAiSettings } from "../src/features/board/lib/ai/providers.ts";
import type { AiSettings } from "../src/features/board/lib/ai/providers.ts";

const SCHEMA = { type: "object", properties: { latex: { type: "string" } } };
const OPENAI: AiSettings = { provider: "openai", keys: { openai: "sk-test" }, models: { openai: "gpt-test" } };

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

// Answers each request with the next of `replies`, and keeps what was sent.
function serve(...replies: [number, unknown][]) {
  const sent: Sent[] = [];
  globalThis.fetch = async (url, init) => {
    sent.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    const [status, body] = replies[Math.min(sent.length, replies.length) - 1]!;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return sent;
}

const completion = (content: string, finish = "stop") => ({
  choices: [{ finish_reason: finish, message: { role: "assistant", content } }],
});

const ask = (settings: AiSettings = OPENAI, image?: string) =>
  askModel({
    settings,
    system: "Read it.",
    text: "What is this?",
    image,
    schema: SCHEMA,
    signal: new AbortController().signal,
  });

describe("OpenAI-compatible providers", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("posts chat completions with the key, the model, the schema and the picture", async () => {
    const sent = serve([200, completion('{"latex":"x"}')]);
    const result = await ask(OPENAI, "data:image/png;base64,AAAA");
    assert.deepEqual(result, { answer: { latex: "x" }, stop: "done" });
    assert.equal(sent[0]!.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(sent[0]!.headers.Authorization, "Bearer sk-test");
    assert.equal(sent[0]!.body.model, "gpt-test");
    assert.equal((sent[0]!.body.response_format as { type: string }).type, "json_schema");
    const [, user] = sent[0]!.body.messages as { content: { type: string }[] }[];
    assert.deepEqual(
      user!.content.map((part) => part.type),
      ["image_url", "text"],
    );
  });

  it("uses each provider's own address", async () => {
    const sent = serve([200, completion("{}")]);
    for (const provider of ["openrouter", "gemini", "groq"] as const) {
      await ask({ provider, keys: { [provider]: "k" }, models: {} });
    }
    assert.deepEqual(
      sent.map((request) => request.url),
      [
        "https://openrouter.ai/api/v1/chat/completions",
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "https://api.groq.com/openai/v1/chat/completions",
      ],
    );
  });

  it("falls back to plain JSON mode, then to the prompt alone, when a model won't take a schema", async () => {
    const rejected: [number, unknown] = [400, { error: { message: "response_format json_schema is not supported" } }];
    const sent = serve(rejected, rejected, [200, completion('```json\n{"latex":"y"}\n```')]);
    assert.deepEqual((await ask()).answer, { latex: "y" });
    assert.deepEqual(
      sent.map((request) => (request.body.response_format as { type?: string } | undefined)?.type),
      ["json_schema", "json_object", undefined],
    );
  });

  it("explains a bad key, an unknown model, a refusal and a cut-off answer", async () => {
    serve([401, { error: { message: "Incorrect API key" } }]);
    await assert.rejects(ask(), /OpenAI didn't accept that key/);
    serve([404, [{ error: { message: "model not found" } }]]);
    await assert.rejects(ask(), /doesn't offer the model "gpt-test"/);
    serve([200, { choices: [{ finish_reason: "stop", message: { content: null, refusal: "No." } }] }]);
    assert.equal((await ask()).stop, "refusal");
    serve([200, completion('{"lat', "length")]);
    assert.equal((await ask()).stop, "too-long");
  });

  it("lists the models a key can use, without Gemini's models/ prefix", async () => {
    const sent = serve([200, { data: [{ id: "models/gemini-b" }, { id: "models/gemini-a" }] }]);
    assert.deepEqual(await listModels({ provider: "gemini", keys: { gemini: "k" }, models: {} }), [
      "gemini-a",
      "gemini-b",
    ]);
    assert.equal(sent[0]!.url, "https://generativelanguage.googleapis.com/v1beta/openai/models");
    serve([401, {}]);
    assert.deepEqual(await listModels(OPENAI), []);
  });

  it("reads JSON answers, with or without a code fence", () => {
    assert.deepEqual(parseAnswer('{"a":1}'), { a: 1 });
    assert.deepEqual(parseAnswer('```json\n{"a":1}\n```'), { a: 1 });
    assert.throws(() => parseAnswer("not json"), /couldn't be read/);
  });
});

describe("AI settings", () => {
  const stored = new Map<string, string>();
  beforeEach(() => {
    stored.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("keeps an Anthropic key saved before there was a choice of provider", () => {
    stored.set("inkboard.anthropicKey", "sk-ant-old");
    assert.deepEqual(readAiSettings(), { provider: "anthropic", keys: { anthropic: "sk-ant-old" }, models: {} });
    assert.ok(hasAiKey());
  });

  it("remembers a key and model per provider, and uses the default model when none is set", () => {
    saveAiSettings({ provider: "groq", keys: { groq: "gsk", anthropic: "sk-ant" }, models: { anthropic: "claude-x" } });
    const settings = readAiSettings();
    assert.equal(settings.keys.anthropic, "sk-ant");
    assert.equal(activeModel(settings), "meta-llama/llama-4-scout-17b-16e-instruct");
    assert.equal(stored.has("inkboard.anthropicKey"), false);
  });

  it("ignores stored settings it doesn't recognise", () => {
    stored.set("inkboard.ai", JSON.stringify({ provider: "nope", keys: { evil: "x", openai: 3 } }));
    assert.deepEqual(readAiSettings(), { provider: "anthropic", keys: {}, models: {} });
  });
});
