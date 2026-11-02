// Text token counts with the selected model's own tokenizer, for the counts the editors show
// (ARCHITECTURE §6 "Text tokens"; owner, 2026-11-02: "ideally you'd always use the tokenizer of
// the selected model"). The same registry shape as the image counters beside it, and the same
// endpoints: tried newest registration first, the first that applies counts.
// - OpenAI's models (any host: api.openai.com, OpenRouter's `openai/…`): their own BPE
//   encodings, counted locally (js-tiktoken in the format worker's interactive lane).
// - Anthropic POST /v1/messages/count_tokens, Gemini POST models/{model}:countTokens, OpenAI
//   POST /v1/responses/input_tokens for an OpenAI model the encodings don't know: the model's
//   own count, one request per text. A one-message count includes the message's framing, so a
//   text's tokens are its count less a one-token text's count, plus one.
// Where none applies (DeepSeek, OpenRouter's other models, a plugin's kind without a counter)
// or a count fails, the caller falls back to o200k_base and says so (TextTokens.ts).
import { Effect } from "effect"
import type { LocalEncoding } from "../importer/tokenizer.ts"
import { countField, joinUrl, postJson, TokenCountError } from "./imageCounters.ts"
import type { ListRequest } from "./modelLists.ts"
import type { RequestTarget } from "./registry.ts"

export interface TextCountRequest extends ListRequest {
  readonly model: string
  readonly texts: ReadonlyArray<string>
  /** Counts in a local encoding, off the main thread. */
  readonly encode: (
    encoding: LocalEncoding,
    texts: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<number>, TokenCountError>
}

type TextCountTarget = RequestTarget & { readonly model: string; readonly baseUrl: string }

export interface TextTokenCounter {
  readonly id: string
  /** What counted, for the count's explanation: "GPT-4o's tokenizer (o200k_base)". */
  readonly label: (model: string) => string
  /** Asks the provider, once per text (its rate limits apply); otherwise counted here. */
  readonly remote: boolean
  readonly appliesTo: (target: TextCountTarget) => boolean
  readonly count: (request: TextCountRequest) => Effect.Effect<ReadonlyArray<number>, TokenCountError>
}

/** The model's name without a router's prefix: `openai/gpt-4o` → `gpt-4o`. */
const bare = (model: string) =>
  model
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/^openai\//, "")

/** OpenAI's encoding for a model, as tiktoken maps them; null for a model that isn't OpenAI's. */
const openAiEncoding = (model: string): LocalEncoding | null => {
  const name = bare(model)
  if (/^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o1|o3|o4|chatgpt-4o|gpt-oss)/.test(name)) return "o200k_base"
  if (/^(gpt-4|gpt-3\.5|gpt-35)/.test(name)) return "cl100k_base"
  return null
}

const ENCODING_NAMES: Record<LocalEncoding, string> = {
  o200k_base: "o200k_base, the tokenizer of GPT-4o and later",
  cl100k_base: "cl100k_base, the tokenizer of GPT-4 and GPT-3.5"
}
export const encodingLabel = (encoding: LocalEncoding) => ENCODING_NAMES[encoding]

const tiktoken: TextTokenCounter = {
  id: "openai-encodings",
  label: (model) => `${model}'s own tokenizer (${ENCODING_NAMES[openAiEncoding(model) ?? "o200k_base"]})`,
  remote: false,
  appliesTo: (target) => openAiEncoding(target.model) !== null,
  count: (request) => request.encode(openAiEncoding(request.model) ?? "o200k_base", request.texts)
}

/** Each text's count less a one-token text's, plus one; an empty text is none, uncounted. */
const byDifference =
  (count: (text: string) => Effect.Effect<number, TokenCountError>) => (texts: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (texts.every((text) => text === "")) return texts.map(() => 0)
      const base = yield* count(".")
      return yield* Effect.forEach(
        texts,
        (text) => (text === "" ? Effect.succeed(0) : Effect.map(count(text), (n) => Math.max(0, n - base + 1))),
        { concurrency: 2 }
      )
    })

const anthropic: TextTokenCounter = {
  id: "anthropic-count-tokens",
  label: (model) => `${model}'s own count (Anthropic's token counting)`,
  remote: true,
  appliesTo: (target) => target.api === "anthropic-messages",
  count: (request) => {
    const auth = { "x-api-key": request.apiKey ?? "", "anthropic-version": "2023-06-01" }
    const url = joinUrl(request.baseUrl, "v1/messages/count_tokens")
    return byDifference((text) =>
      postJson(request, url, auth, { model: request.model, messages: [{ role: "user", content: text }] }).pipe(
        Effect.flatMap(countField("input_tokens"))
      )
    )(request.texts)
  }
}

const google: TextTokenCounter = {
  id: "google-count-tokens",
  label: (model) => `${model}'s own count (Gemini's countTokens)`,
  remote: true,
  appliesTo: (target) => target.api === "google-generative-ai",
  count: (request) => {
    const auth: Record<string, string> = request.apiKey ? { "x-goog-api-key": request.apiKey } : {}
    const model = request.model.replace(/^models\//, "")
    const url = joinUrl(request.baseUrl, `models/${encodeURIComponent(model)}:countTokens`)
    return byDifference((text) =>
      postJson(request, url, auth, { contents: [{ role: "user", parts: [{ text }] }] }).pipe(
        Effect.flatMap(countField("totalTokens"))
      )
    )(request.texts)
  }
}

/** Only OpenAI's own API has the endpoint; for its models the encodings don't know yet. */
const openai: TextTokenCounter = {
  id: "openai-input-tokens",
  label: (model) => `${model}'s own count (OpenAI's input token counting)`,
  remote: true,
  appliesTo: (target) =>
    (target.api === "openai-responses" || target.kind === "openai-chat") &&
    URL.canParse(target.baseUrl) &&
    new URL(target.baseUrl).hostname === "api.openai.com",
  count: (request) => {
    const auth: Record<string, string> = request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}
    const url = joinUrl(request.baseUrl, "responses/input_tokens")
    return byDifference((text) =>
      postJson(request, url, auth, {
        model: request.model,
        input: [{ role: "user", content: [{ type: "input_text", text }] }]
      }).pipe(Effect.flatMap(countField("input_tokens")))
    )(request.texts)
  }
}

/** In registration order; the last registered is asked first, so the local encodings win. */
export const builtinTextCounters: ReadonlyArray<TextTokenCounter> = [anthropic, google, openai, tiktoken]

export { TokenCountError }
