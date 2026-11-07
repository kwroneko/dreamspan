// Exact image token counts from the providers' own counting endpoints (ARCHITECTURE §6).
// Each counts one image as the difference between a one-image message and the same message
// without it, so framing and the model's text tokenizer drop out. Read on 2026-10-30:
// - Anthropic POST /v1/messages/count_tokens: base64 images, free, its own rate limits
//   (https://platform.claude.com/docs/en/build-with-claude/token-counting)
// - Gemini POST models/{model}:countTokens: inline images
//   (https://ai.google.dev/api/tokens, https://ai.google.dev/gemini-api/docs/tokens)
// - OpenAI POST /v1/responses/input_tokens: Responses input, images included
//   (https://developers.openai.com/api/docs/guides/token-counting)
import { Data, Effect } from "effect"
import type { ListRequest } from "./modelLists.ts"
import type { RequestTarget } from "./registry.ts"

export class TokenCountError extends Data.TaggedError("TokenCountError")<{ readonly message: string }> {}

interface ImageCountRequest extends ListRequest {
  readonly model: string
  readonly image: { readonly data: string; readonly mimeType: string }
  /** The detail level our requests send (`auto`). */
  readonly detail: string
}

/**
 * A counting endpoint. Counters are tried newest registration first; the first that applies
 * counts. A plugin registers its own, or disables a built-in, through the provider registry.
 */
export interface ImageTokenCounter {
  readonly id: string
  /**
   * Sends the image to a provider. Such a counter runs only through a connection the user chose
   * to count with (DESIGN §11); a local one (a plugin's formula, say) counts without asking.
   */
  readonly remote: boolean
  readonly appliesTo: (target: RequestTarget & { readonly model: string; readonly baseUrl: string }) => boolean
  readonly count: (request: ImageCountRequest) => Effect.Effect<number, TokenCountError>
}

export const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`

export const postJson = (request: ListRequest, url: string, auth: Record<string, string>, body: unknown) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await request.fetch(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", ...auth, ...request.headers },
        body: JSON.stringify(body),
        signal
      })
      if (!response.ok) {
        const text = await response.text().catch(() => "")
        throw new Error(`${response.status} ${response.statusText}: ${request.scrub(text).slice(0, 300)}`)
      }
      return (await response.json()) as Record<string, unknown>
    },
    catch: (error) =>
      new TokenCountError({ message: request.scrub(error instanceof Error ? error.message : String(error)) })
  })

export const countField = (name: string) => (json: Record<string, unknown>) => {
  const value = json[name]
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(new TokenCountError({ message: `the count has no ${name}` }))
}

/** The image's tokens: the counted message with it, less the same message without it. */
const difference = (
  withImage: Effect.Effect<number, TokenCountError>,
  without: Effect.Effect<number, TokenCountError>
) =>
  Effect.flatMap(Effect.all([withImage, without], { concurrency: 1 }), ([a, b]) =>
    a > b ? Effect.succeed(a - b) : Effect.fail(new TokenCountError({ message: "the image counted zero or negative" }))
  )

const TEXT = "."

const anthropic: ImageTokenCounter = {
  id: "anthropic-count-tokens",
  remote: true,
  // Bedrock counts tokens with its own API, at its own address (not built).
  appliesTo: (target) => target.api === "anthropic-messages" && target.kind !== "anthropic-bedrock",
  count: (request) => {
    const auth = { "x-api-key": request.apiKey ?? "", "anthropic-version": "2023-06-01" }
    const url = joinUrl(request.baseUrl, "v1/messages/count_tokens")
    const count = (content: ReadonlyArray<unknown>) =>
      postJson(request, url, auth, { model: request.model, messages: [{ role: "user", content }] }).pipe(
        Effect.flatMap(countField("input_tokens"))
      )
    const text = { type: "text", text: TEXT }
    return difference(
      count([
        { type: "image", source: { type: "base64", media_type: request.image.mimeType, data: request.image.data } },
        text
      ]),
      count([text])
    )
  }
}

const google: ImageTokenCounter = {
  id: "google-count-tokens",
  remote: true,
  appliesTo: (target) => target.api === "google-generative-ai",
  count: (request) => {
    const auth: Record<string, string> = request.apiKey ? { "x-goog-api-key": request.apiKey } : {}
    const model = request.model.replace(/^models\//, "")
    const url = joinUrl(request.baseUrl, `models/${encodeURIComponent(model)}:countTokens`)
    const count = (parts: ReadonlyArray<unknown>) =>
      postJson(request, url, auth, { contents: [{ role: "user", parts }] }).pipe(
        Effect.flatMap(countField("totalTokens"))
      )
    return difference(
      count([{ inlineData: { mimeType: request.image.mimeType, data: request.image.data } }, { text: TEXT }]),
      count([{ text: TEXT }])
    )
  }
}

/** Only OpenAI's own API has the endpoint; Chat Completions connections to it share the count. */
const openai: ImageTokenCounter = {
  id: "openai-input-tokens",
  remote: true,
  appliesTo: (target) =>
    (target.api === "openai-responses" || target.kind === "openai-chat") &&
    URL.canParse(target.baseUrl) &&
    new URL(target.baseUrl).hostname === "api.openai.com",
  count: (request) => {
    const auth: Record<string, string> = request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}
    const url = joinUrl(request.baseUrl, "responses/input_tokens")
    const count = (content: ReadonlyArray<unknown>) =>
      postJson(request, url, auth, { model: request.model, input: [{ role: "user", content }] }).pipe(
        Effect.flatMap(countField("input_tokens"))
      )
    const text = { type: "input_text", text: TEXT }
    return difference(
      count([
        text,
        {
          type: "input_image",
          image_url: `data:${request.image.mimeType};base64,${request.image.data}`,
          detail: request.detail
        }
      ]),
      count([text])
    )
  }
}

export const builtinImageCounters: ReadonlyArray<ImageTokenCounter> = [anthropic, google, openai]
