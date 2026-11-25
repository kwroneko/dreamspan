// Which samplers a request sends, per wire API, provider kind and model: the assembler's mapping
// (server assembler/wire.ts) and the model page, which shows only the samplers that are sent.

const drop = (fields: Record<string, unknown>, ...keys: ReadonlyArray<string>) => {
  for (const key of keys) delete fields[key]
}

/**
 * ST's rules for models that refuse some samplers: OpenAI's o-series, GPT-5 and GPT-6
 * Astra take `max_completion_tokens` and fewer samplers; Claude's newest models take none.
 */
export const modelRules = (fields: Record<string, unknown>, kind: string, key: string) => {
  const gpt = kind === "openai-chat" || kind === "openrouter" || kind === "openai-responses"
  // Responses has its own field for the length, which pi-ai sets.
  const toCompletionTokens = () => {
    if (kind === "openai-responses") return
    fields.max_completion_tokens = fields.max_tokens
    fields.max_tokens = undefined
  }
  if (gpt && (/^(o1|o3|o4)/.test(key) || (kind === "openrouter" && /^openai\/(o1|o3|o4)/.test(key)))) {
    toCompletionTokens()
    drop(fields, "temperature", "top_p", "frequency_penalty", "presence_penalty")
  }
  if (gpt && /gpt-5/.test(key)) {
    toCompletionTokens()
    if (/gpt-5-chat-latest/.test(key)) {
      // As it is.
    } else if (/gpt-5\.(1|2|3|4)/.test(key)) drop(fields, "frequency_penalty", "presence_penalty")
    else drop(fields, "temperature", "top_p", "frequency_penalty", "presence_penalty")
  }
  if (gpt && /gpt-6-astra/.test(key)) {
    toCompletionTokens()
    drop(fields, "temperature", "top_p")
  }
  if (/claude-(fable|opus-5|sonnet-5)/.test(key)) {
    drop(fields, "temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty")
  }
  return fields
}

/**
 * ST's Claude samplers: the limited models take temperature or top_p (top_p when it's below 1),
 * the newest none. `topP` is the request's.
 */
export const claudeRules = (fields: Record<string, unknown>, key: string, topP: number) => {
  if (/^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-6|opus-4-5|sonnet-4-6)/.test(key)) {
    drop(fields, topP < 1 ? "temperature" : "top_p")
  }
  if (/^claude-(opus-4-7|opus-4-8)/.test(key) || /claude-(fable|opus-5|sonnet-5)/.test(key)) {
    drop(fields, "temperature", "top_p", "top_k")
  }
  return fields
}

/** The samplers a model's settings can set, in the order the model page lists them. */
export const SAMPLER_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "top_a",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "seed"
] as const
export type SamplerKey = (typeof SAMPLER_KEYS)[number]

/**
 * The samplers a request to this model sends, as the assembler maps them: Chat Completions sends
 * ST's custom-source set (OpenRouter adds its own), Claude and Google their few, Responses and
 * other APIs temperature and top_p; each within the model rules above. A Claude model that takes
 * temperature or top_p, one at a time, lists both.
 */
export const samplersSent = ({
  kind,
  api,
  key
}: {
  readonly kind: string
  readonly api: string
  readonly key: string
}): ReadonlyArray<SamplerKey> => {
  const fields: Record<string, unknown> =
    api === "anthropic-messages"
      ? claudeRules({ temperature: 1, top_p: 1, top_k: 1 }, key, 0.5)
      : api === "google-generative-ai"
        ? { temperature: 1, top_p: 1, top_k: 1 }
        : api === "openai-responses"
          ? modelRules({ temperature: 1, top_p: 1 }, "openai-responses", key)
          : api === "openai-completions"
            ? modelRules(
                {
                  temperature: 1,
                  frequency_penalty: 0,
                  presence_penalty: 0,
                  top_p: 1,
                  seed: 1,
                  ...(kind === "openrouter" ? { min_p: 0, repetition_penalty: 1, top_a: 0, top_k: 1 } : {})
                },
                kind,
                key
              )
            : { temperature: 1, top_p: 1 }
  // The limited Claude models take one of the two, whichever the user sets.
  if (api === "anthropic-messages" && "top_p" in fields !== "temperature" in fields) {
    fields.temperature = 1
    fields.top_p = 1
  }
  return SAMPLER_KEYS.filter((sampler) => sampler in fields)
}

/**
 * Whether a model takes OpenAI's `verbosity` (how long and detailed the answer is: low, medium,
 * high): on the OpenAI Chat Completions and Responses wires unless explicitly disabled.
 * Separate from reasoning effort, which sets how much it thinks.
 */
export const takesVerbosity = ({
  api,
  supported
}: {
  readonly api: string
  readonly key: string
  readonly supported?: boolean
}) => (api === "openai-responses" || api === "openai-completions") && supported !== false
