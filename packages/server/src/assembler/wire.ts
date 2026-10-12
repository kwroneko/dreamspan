// From the provider-neutral request to what a provider is sent (DESIGN §1.2: "sampler
// values, mapped per provider"). Chat Completions gets ST's messages exactly, names
// included, and ST's sampler fields for the connection's kind; pi-ai builds the rest of
// the body. The fields here are merged over the payload pi-ai built (PROVIDERS §4).
import type { AssembledRequest, RequestMessage } from "./types.ts"

/** The messages with the prefill appended as the start of the reply, where the model takes one. */
const withPrefill = (request: AssembledRequest): ReadonlyArray<RequestMessage> =>
  request.prefill ? [...request.messages, { role: "assistant", content: request.prefill }] : request.messages

/**
 * The Chat Completions fields the assembler decides, as ST sends them for each source:
 * its custom source for `openai-chat` (ST's other OpenAI-compatible sources send the same
 * fields), OpenRouter's extra samplers, DeepSeek's non-zero top_p. A seed is sent only
 * when the preset sets one.
 */
export const chatCompletionsFields = (request: AssembledRequest, kind: string): Record<string, unknown> => {
  const s = request.samplers
  const fields: Record<string, unknown> = {
    messages: withPrefill(request).map(({ role, content, name }) => ({ role, content, ...(name ? { name } : {}) })),
    temperature: s.temperature,
    frequency_penalty: s.frequency_penalty,
    presence_penalty: s.presence_penalty,
    top_p: s.top_p,
    max_tokens: s.max_tokens,
    ...(s.seed >= 0 ? { seed: s.seed } : {})
  }
  if (kind === "openrouter") {
    Object.assign(fields, { top_k: s.top_k, min_p: s.min_p, repetition_penalty: s.repetition_penalty, top_a: s.top_a })
  }
  if (kind === "deepseek") fields.top_p = s.top_p || Number.EPSILON
  return fields
}
