// Provider output ceilings, applied after model/preset fields and compatibility transforms.
// A plugin provider must supply its own final-payload limiter to accept a bounded reply.
type Limiter = (payload: Record<string, unknown>, limit: number) => Record<string, unknown>
const cap = (value: unknown, limit: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, limit) : limit

export const outputLimiters: Readonly<Record<string, Limiter>> = {
  "openai-completions": (payload, limit) => {
    const key = "max_completion_tokens" in payload ? "max_completion_tokens" : "max_tokens"
    const bounded: Record<string, unknown> = { ...payload, [key]: cap(payload[key], limit), n: 1 }
    if ("max_tokens" in payload && "max_completion_tokens" in payload)
      bounded["max_tokens"] = cap(payload["max_tokens"], limit)
    return bounded
  },
  "openai-responses": (payload, limit) => ({ ...payload, max_output_tokens: cap(payload["max_output_tokens"], limit) }),
  "anthropic-messages": (payload, limit) => ({ ...payload, max_tokens: cap(payload["max_tokens"], limit) }),
  "google-generative-ai": (payload, limit) => {
    const config = (payload["config"] ?? {}) as Record<string, unknown>
    return {
      ...payload,
      config: { ...config, candidateCount: 1, maxOutputTokens: cap(config["maxOutputTokens"], limit) }
    }
  }
}
