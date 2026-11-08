// OpenAI's models on Amazon Bedrock (the `openai-bedrock` provider). Bedrock's runtime serves
// OpenAI's own Responses and Chat Completions APIs at `/openai/v1` (AWS, "Responses API": the same
// request and response format as OpenAI's), so pi-ai's OpenAI adapters build the request and read
// the stream unchanged, and every OpenAI transform and usage observer applies. What differs:
//
// - The key: a Bedrock API key is a bearer token, as OpenAI's SDK sends one; an AWS access key
//   signs each request instead (SigV4, service `bedrock`), shared with Claude on Bedrock.
// - The models: closed GPT models must be named by an inference profile (`us.openai.gpt-5.6-sol`,
//   `global.…`), and the runtime has no `GET /models`, so the list is pi-ai's Bedrock catalog.
// - The cache: GPT-5.6 and later take `prompt_cache_breakpoint` markers on the Responses API
//   (`applyBedrockBreakpoints`), at least 30 minutes, 1,024 tokens per marker, four writes per
//   request, writes billed at 1.25 times input. Earlier models and Chat Completions cache
//   automatically only (shims.ts strips markers there).
//
// Sources: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html,
// https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html, and reference-harness's
// ARCHITECTURE "Cache control" (it uses the same markers). Not yet checked
// against a live Bedrock account: recorded shapes only (ARCHITECTURE §6 "OpenAI on AWS Bedrock").
import { Effect } from "effect"
import { bedrockAuthHeaders, bedrockSecretsOf, messageOf, requestUrl } from "./bedrock.ts"
import { defaultCacheRelease } from "./cacheStagger.ts"
import { piCatalogs, withCatalog } from "./catalog.ts"
import type { KindTransportRequest, ProviderKindEntry } from "./registry.ts"
import { openAICompletionsApi, openAIResponsesApi } from "./sdk.ts"

/** Headers of the SDK's own that a signed request leaves out: its bearer key, length and telemetry. */
const dropped = /^(authorization|x-stainless-.*|content-length|host)$/i

/**
 * Wraps the controlled fetch: OpenAI's SDK sends its request to Bedrock's address as it would to
 * OpenAI's; with an AWS access key the request is signed instead of carrying the key. Errors in
 * AWS's shape (`{"message": …}` with an `x-amzn-errortype`) become OpenAI's, which the SDK reads.
 */
const bedrockOpenAITransport =
  (fetch: typeof globalThis.fetch, request: KindTransportRequest): typeof globalThis.fetch =>
  async (input, init) => {
    const url = requestUrl(input)
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? init.body : ""
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      if (!dropped.test(name)) headers[name] = value
    })
    const signed = { "content-type": headers["content-type"] ?? "application/json" }
    Object.assign(headers, bedrockAuthHeaders(request, { method, url, headers: signed, body }))
    const response = await fetch(url.href, {
      method,
      headers,
      body: body === "" ? null : body,
      signal: init?.signal ?? null
    })
    if (response.ok) return response
    const text = await response.text()
    let openai = false
    try {
      openai = typeof (JSON.parse(text) as { error?: unknown }).error === "object"
    } catch {
      openai = false
    }
    if (openai) return new Response(text, { status: response.status, headers: response.headers })
    const exception = (response.headers.get("x-amzn-errortype") ?? "").split(":")[0] ?? ""
    const out = new Headers({ "content-type": "application/json" })
    for (const name of ["x-amzn-requestid", "retry-after"]) {
      const value = response.headers.get(name)
      if (value) out.set(name === "x-amzn-requestid" ? "x-request-id" : name, value)
    }
    return new Response(
      JSON.stringify({
        error: { message: messageOf(text) || exception || response.statusText, type: exception || null, code: null }
      }),
      { status: response.status, headers: out }
    )
  }

const loadCatalog = piCatalogs["amazon-bedrock"]!

/**
 * OpenAI's models in pi-ai's Bedrock catalog that this API serves on the runtime: closed GPT
 * models by their inference profiles (their base IDs aren't served there), and GPT OSS by its
 * own ID on Chat Completions (its Responses API is on Bedrock's other endpoint, Mantle).
 */
export const bedrockOpenAIModels = (keys: ReadonlyArray<string>, responses: boolean) =>
  keys.filter((key) =>
    /^(?:us|us-gov|global|in|eu|apac|jp|au)\.openai\.gpt-(?!oss)/.test(key)
      ? true
      : !responses && /^(?:[a-z-]+\.)?openai\.gpt-oss-/.test(key)
  )

const openAIOnBedrock = (entry: {
  readonly id: string
  readonly label: string
  readonly api: "openai-responses" | "openai-completions"
}): ProviderKindEntry => {
  const self: ProviderKindEntry = {
    id: entry.id,
    label: entry.label,
    piProvider: "amazon-bedrock",
    api: entry.api,
    streams: entry.api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi(),
    acceptsFetch: true,
    defaultBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
    keyOptional: false,
    catalog: loadCatalog,
    cacheRelease: defaultCacheRelease,
    listsCatalog: true,
    transport: bedrockOpenAITransport,
    secretsOf: bedrockSecretsOf,
    listModels: () =>
      Effect.promise(() => loadCatalog().catch(() => ({}))).pipe(
        Effect.map((catalog) =>
          bedrockOpenAIModels(Object.keys(catalog), entry.api === "openai-responses").map((key) => ({
            key,
            upstream: {}
          }))
        ),
        Effect.flatMap((listed) => withCatalog(self, listed))
      )
  }
  return self
}

export const bedrockOpenAIResponsesKind = openAIOnBedrock({
  id: "openai-responses-bedrock",
  label: "OpenAI Responses on AWS Bedrock",
  api: "openai-responses"
})

export const bedrockOpenAIChatKind = openAIOnBedrock({
  id: "openai-chat-bedrock",
  label: "OpenAI Chat Completions on AWS Bedrock",
  api: "openai-completions"
})
