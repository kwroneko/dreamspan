// Reading the limit a provider states in its context-length error, so the user can save it as
// the model's context size in one click (never applied without them). Each wording is a
// registered part (spec/PLUGINS.md §3.1); a plugin adds its provider's or a proxy's.

export interface ContextLimitParser {
  readonly id: string
  /** The context size the error text states, or null when it isn't this wording. */
  readonly parse: (text: string) => number | null
}

const number = (text: string | undefined) => {
  const n = Number((text ?? "").replace(/[,_\s]/g, ""))
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

const pattern = (id: string, regex: RegExp): ContextLimitParser => ({
  id,
  parse: (text) => {
    const found = regex.exec(text)
    return found ? number(found.slice(1).find((group) => group !== undefined)) : null
  }
})

/** In registration order; the last is asked first, so the generic wording comes first. */
export const builtinContextLimitParsers: ReadonlyArray<ContextLimitParser> = [
  // Generic: "context window of 131072 tokens", "context length of 32768 tokens"
  pattern("generic", /context (?:window|length|limit)(?: is| of|:)\s*([\d,]+)(?: tokens)?/i),
  // OpenAI, DeepSeek, OpenRouter, vLLM and most OpenAI-compatible servers:
  // "This model's maximum context length is 128000 tokens." / "This endpoint's maximum context length is …"
  pattern("openai", /maximum context length is ([\d,]+) tokens/i),
  // OpenAI's newer wording: "Input tokens exceed the configured limit of 272000 tokens."
  pattern("openai-configured", /exceed(?:s|ed)? the configured limit of ([\d,]+) tokens/i),
  // Anthropic: "prompt is too long: 208310 tokens > 200000 maximum", and
  // "input length and `max_tokens` exceed context limit: 197000 + 8192 > 200000"
  pattern("anthropic", /(?:prompt is too long: [\d,]+ tokens > ([\d,]+) maximum)/i),
  pattern("anthropic-total", /exceed context limit: [\d,]+ \+ [\d,]+ > ([\d,]+)/i),
  // Gemini: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)."
  pattern("google", /exceeds the maximum number of tokens allowed \(([\d,]+)\)/i),
  // llama.cpp: "request (40000 tokens) exceeds the available context size (32768 tokens)"
  pattern("llama.cpp", /exceeds the available context size \(([\d,]+) tokens\)/i),
  // LiteLLM and other proxies: "exceeds maximum context length of 200000 tokens" / "(200000)"
  pattern("litellm", /exceeds (?:the )?(?:model'?s )?maximum context length(?: of ([\d,]+)| ?\(([\d,]+)\))/i),
  // xAI: "This model's maximum prompt length is 131072 but the request contains …"
  pattern("xai", /maximum prompt length is ([\d,]+)/i),
  // Together: "Input (40000 tokens) is longer than the model's context length (32768 tokens)"
  pattern("together", /longer than the model'?s context length \(([\d,]+) tokens\)/i),
  // Mistral: "Prompt contains 140000 tokens … too large for model with 131072 maximum context length"
  pattern("mistral", /too large for model with ([\d,]+) maximum context length/i)
]

export interface OutputLimitParser {
  readonly id: string
  /** The max output tokens the error text states, or null when it isn't this wording. */
  readonly parse: (text: string) => number | null
}

/** In registration order; the last is asked first, so generic wordings come first. */
export const builtinOutputLimitParsers: ReadonlyArray<OutputLimitParser> = [
  // Generic: "maximum output tokens is 16384", "maximum completion length: 4096"
  pattern("generic-output", /maximum (?:output|completion) (?:tokens|length|limit)(?: is| of|:)?\s*\(?([\d,]+)\)?/i),
  // Generic exceeds: "exceeds the model's maximum output tokens of 16384" / "(16384)"
  pattern(
    "generic-output-exceeds",
    /exceeds (?:the )?(?:model'?s )?maximum (?:output|completion) (?:tokens|length|limit)(?: of ([\d,]+)| ?\(([\d,]+)\))/i
  ),
  // DeepSeek / OpenRouter / gateways: "valid range of max_tokens is [1, 8192]", "max_tokens must be between 1 and 8192"
  pattern(
    "range-output",
    /(?:max_tokens|max_completion_tokens|max_output_tokens|maxOutputTokens|maxTokens)[^.\n]{0,80}(?:between\s+[\d,]+\s+and\s+([\d,]+)|\[\s*[\d,]+\s*,\s*([\d,]+)\s*\])/i
  ),
  // OpenAI Chat Completions: "max_tokens is too large: 65536. This model supports at most 16384 completion tokens"
  pattern("openai-output", /supports at most ([\d,]+) (?:completion|output) tokens/i),
  // OpenAI Responses & JSON schema validation: "Invalid 'max_output_tokens': integer above maximum value. Expected a value <= 16384"
  // Also Bedrock / proxies: "maxTokens must be less than or equal to 8192", "max_tokens cannot exceed 8192"
  pattern(
    "param-output",
    /['"`]?(?:max_output_tokens|max_completion_tokens|max_tokens|maxOutputTokens|maxTokens)['"`]?[^\n]{0,120}(?:<=|less than or equal to|at most|must not exceed|cannot exceed|exceeds (?:the )?maximum(?: allowed)?(?: of)?)\s*\(?([\d,]+)\)?/i
  ),
  // Anthropic: "max_tokens: 65536 > 16384, which is the maximum allowed number of output tokens for ..."
  pattern("anthropic-output", /max_tokens:\s*[\d,]+\s*>\s*([\d,]+)/i)
]

/** The limit the first parser that recognizes the text reads, newest registration first. */
export const statedContextLimit = (parsers: ReadonlyArray<ContextLimitParser>, text: string) => {
  for (const parser of [...parsers].reverse()) {
    const limit = parser.parse(text)
    if (limit !== null) return limit
  }
  return null
}

/** The output limit the first parser that recognizes the text reads, newest registration first. */
export const statedOutputLimit = (parsers: ReadonlyArray<OutputLimitParser>, text: string) => {
  for (const parser of [...parsers].reverse()) {
    const limit = parser.parse(text)
    if (limit !== null) return limit
  }
  return null
}
