import { assert, it } from "@effect/vitest"
import { builtinProviders } from "@dreamspan/shared/providerDefinitions.ts"
import { documentedCacheMinimum, documentedCachePolicy } from "../src/providers/cachePolicy.ts"

const hour = { system: [{ cache_control: { type: "ephemeral", ttl: "1h" } }] }
const chatHour = { messages: [{ content: [{ cache_control: { type: "ephemeral", ttl: "1h" } }] }] }
const explicit = { messages: [{ content: [{ cache_control: { type: "ephemeral" } }] }] }
for (const [provider, api, model, payload, ttl, fixed] of [
  ["anthropic", "anthropic-messages", "claude", {}, 300, false],
  ["anthropic", "anthropic-messages", "claude", hour, 3600, false],
  ["openai", "openai-completions", "gpt-4.1", {}, 300, false],
  ["openai", "openai-responses", "gpt-5.5-pro", {}, 1800, false],
  ["openai", "openai-responses", "gpt-5.4", { prompt_cache_retention: "24h" }, 1800, false],
  ["openai", "openai-responses", "gpt-5.6", {}, 1800, false],
  ["openai", "openai-responses", "gpt-6.1-sol", {}, 1800, false],
  ["openai", "openai-completions", "synthetic-local", {}, null, false],
  ["azure", "openai-completions", "gpt-5.6", {}, 1800, false],
  ["azure", "openai-responses", "gpt-4.1", {}, 300, false],
  ["azure", "openai-responses", "gpt-5.4", { prompt_cache_retention: "24h" }, null, false],
  ["openrouter", "openai-completions", "anthropic/claude", {}, null, false],
  ["openrouter", "openai-completions", "anthropic/claude", chatHour, 600, false],
  [
    "openrouter",
    "openai-completions",
    "anthropic/claude",
    { ...chatHour, provider: { only: ["Anthropic"] } },
    3600,
    false
  ],
  ["openrouter", "openai-completions", "google/gemini-2.5-pro", {}, 180, false],
  ["openrouter", "openai-completions", "google/gemini-2.5-pro", explicit, 300, true],
  ["openrouter", "openai-completions", "unknown/claude", {}, null, false],
  ["moonshotai", "openai-completions", "kimi-k3", {}, 300, false],
  [
    "moonshotai-cn",
    "openai-responses",
    "kimi-k3",
    { prompt_cache_options: { mode: "implicit", ttl: "1h" } },
    3600,
    false
  ],
  ["moonshotai", "anthropic-messages", "kimi-k3", { cache_control: { type: "ephemeral", ttl: "1h" } }, 3600, false],
  ["moonshotai", "openai-completions", "kimi-k2.5", {}, null, false],
  ["kimi-coding", "openai-completions", "kimi-k3", {}, null, false],
  ["qwen", "openai-completions", "qwen-plus", explicit, 300, false],
  ["dashscope", "openai-completions", "qwen-plus", {}, null, false],
  ["qwen-token-plan", "openai-completions", "qwen-plus", explicit, null, false],
  ["groq", "openai-completions", "openai/gpt-oss-120b", {}, 7200, false],
  ["groq", "openai-completions", "llama", {}, null, false],
  ["amazon-bedrock", "bedrock-converse-stream", "anthropic.claude", {}, 300, false],
  [
    "amazon-bedrock",
    "bedrock-converse-stream",
    "anthropic.claude",
    { system: [{ cachePoint: { type: "default", ttl: "1h" } }] },
    3600,
    false
  ],
  ["amazon-bedrock", "openai-responses", "openai.gpt-6.1", {}, 1800, false],
  ["google-vertex", "anthropic-messages", "claude-sonnet", hour, 3600, false],
  ["minimax", "anthropic-messages", "MiniMax-M2", explicit, 300, false],
  ["minimax-cn", "openai-completions", "MiniMax-M2", {}, null, false],
  ["cerebras", "openai-completions", "gpt-oss-120b", {}, 300, true],
  ["vercel-ai-gateway", "anthropic-messages", "anthropic/claude", {}, 300, false],
  ["vercel-ai-gateway", "anthropic-messages", "minimax/M2", hour, 3600, false],
  ["google", "google-generative-ai", "gemini-2.5-pro", {}, null, false],
  ["google-vertex", "google-vertex", "gemini-2.5-pro", {}, null, false],
  ["deepseek", "openai-completions", "deepseek", {}, null, false],
  ["xai", "openai-responses", "grok", {}, null, false]
] as const) {
  it(`${provider}/${model} ${JSON.stringify(payload)} uses the documented cache policy`, () => {
    const result = documentedCachePolicy({ provider, api, model }, payload)
    assert.equal(result?.ttlS ?? null, ttl)
    if (result) {
      assert.equal(result.fixed, fixed)
      assert.match(result.source, /^https:\/\//)
    }
  })
}

for (const [provider, api, model, payload, ttl] of [
  ["groq", "openai-completions", "openai/gpt-oss-safeguard-20b", {}, 7200],
  ["qwen", "openai-responses", "qwen-plus", explicit, null],
  ["amazon-bedrock", "bedrock-converse-stream", "openai.gpt-6.1", {}, null],
  ["moonshotai", "anthropic-messages", "kimi-k3", hour, 300],
  ["moonshotai", "openai-completions", "kimi-k3", { prompt_cache_retention: "1h" }, 300],
  ["vercel-ai-gateway", "openai-responses", "anthropic/claude", { cache_ttl: "1h" }, 3600]
] as const)
  it(`${provider} respects the documented API and retention option`, () => {
    assert.equal(documentedCachePolicy({ provider, api, model }, payload)?.ttlS ?? null, ttl)
  })

for (const model of ["gpt-3.5-turbo", "gpt-4", "gpt-custom-local", "gpt-oss-120b"])
  it(`does not assign OpenAI caching to ${model} from the API family alone`, () =>
    assert.isNull(documentedCachePolicy({ provider: "openai", api: "openai-completions", model })))

for (const payload of [
  { tools: [{ function: { parameters: { properties: { cache_control: { type: "string" } } } } }] },
  { messages: [{ content: [{ type: "tool_result", content: { cache_control: { type: "ephemeral" } } }] }] },
  { messages: [{ tool_calls: [{ function: { arguments: { cache_control: { type: "ephemeral" } } } }] }] },
  { cache_control: { type: "string" } },
  { cache_control: {} },
  { cache_control: { type: "ephemeral", ttl: "invalid" } },
  { system: [{ cache_control: { type: "ephemeral" } }] }
])
  it(`ignores data and invalid Chat markers: ${JSON.stringify(payload)}`, () => {
    assert.deepInclude(
      documentedCachePolicy({ provider: "openrouter", api: "openai-completions", model: "google/gemini" }, payload),
      { ttlS: 180, fixed: false }
    )
  })
it("Anthropic schemas and tool arguments do not shorten a real hour marker", () => {
  const payload = {
    ...hour,
    tools: [{ input_schema: { properties: { cache_control: { type: "string" } } } }],
    messages: [{ content: [{ type: "tool_use", input: { cache_control: { type: "ephemeral" } } }] }]
  }
  assert.equal(
    documentedCachePolicy({ provider: "anthropic", api: "anthropic-messages", model: "claude" }, payload)?.ttlS,
    3600
  )
})
it("Bedrock only recognizes shaped markers in system, content and toolConfig.tools", () => {
  const target = { provider: "amazon-bedrock", api: "bedrock-converse-stream", model: "anthropic.claude" }
  const cachePoint = { type: "default", ttl: "1h" }
  for (const payload of [
    { system: [{ cachePoint }] },
    { messages: [{ content: [{ cachePoint }] }] },
    { toolConfig: { tools: [{ cachePoint }] } }
  ])
    assert.equal(documentedCachePolicy(target, payload)?.ttlS, 3600)
  assert.equal(
    documentedCachePolicy(target, { toolConfig: { tools: [{ toolSpec: { inputSchema: { json: { cachePoint } } } }] } })
      ?.ttlS,
    300
  )
})

it("OpenRouter estimates Alibaba's documented TTL only for a pinned, marked route", () => {
  const target = { provider: "openrouter", api: "openai-completions", model: "qwen/qwen3.7-plus" }
  const provider = { only: ["alibaba"] }
  assert.equal(documentedCachePolicy(target, { ...explicit, provider })?.ttlS, 300)
  assert.isNull(documentedCachePolicy(target, explicit))
  assert.isNull(documentedCachePolicy(target, { provider, cache_control: { type: "ephemeral" } }))
})

it("Qwen only opts into caching through shaped content-block markers", () => {
  const target = { provider: "qwen", api: "openai-completions", model: "qwen-plus" }
  for (const payload of [
    { cache_control: { type: "ephemeral" } },
    { messages: [{ cache_control: { type: "ephemeral" }, content: "Synthetic" }] }
  ])
    assert.isNull(documentedCachePolicy(target, payload))
  assert.equal(documentedCachePolicy(target, explicit)?.ttlS, 300)
})

for (const [model, minimum] of [
  ["gemini-2.5-flash", 2048],
  ["gemini-2.5-pro", 2048],
  ["gemini-2.5-flash-lite", null],
  ["gemini-3.1-pro-preview", 4096],
  ["gemini-3.6-flash", 4096],
  ["gemini-3.8-flash", 4096],
  ["gemini-4-carbon", 4096],
  ["gemini-4-argon", 4096],
  ["gemini-future", null]
] as const)
  it(`Google ${model} has its documented implicit minimum and no lifetime promise`, () => {
    const target = { provider: "google", api: "google-generative-ai", model }
    assert.equal(documentedCacheMinimum(target), minimum)
    assert.isNull(documentedCachePolicy(target))
  })

// A model the user adds by hand (not from a list or catalog) gets its lifetime from the
// connection's provider: what the provider kind documents, by its API and the model's family.
// Each built-in provider's own cache contract and API, as a connection made from it has them.
const claudeMarker = { system: [{ cache_control: { type: "ephemeral" } }] }
for (const [providerId, api, model, payload, ttl] of [
  // Anthropic: explicit breakpoints, 5 minutes, or 1 hour when every marker asks for it.
  ["anthropic", "anthropic-messages", "my-claude-finetune", claudeMarker, 300],
  ["anthropic", "anthropic-messages", "my-claude-finetune", hour, 3600],
  // Bedrock and Vertex serve only Claude on Anthropic Messages, whatever the id names.
  [
    "anthropic-bedrock",
    "anthropic-messages",
    "arn:aws:bedrock:eu-west-1:000000000000:application-inference-profile/synthetic",
    claudeMarker,
    300
  ],
  [
    "anthropic-bedrock",
    "anthropic-messages",
    "arn:aws:bedrock:eu-west-1:000000000000:application-inference-profile/synthetic",
    hour,
    3600
  ],
  ["anthropic-vertex", "anthropic-messages", "custom-deployment@001", claudeMarker, 300],
  ["anthropic-vertex", "anthropic-messages", "custom-deployment@001", hour, 3600],
  // OpenAI: automatic prefix caching, by the model's family (a fine-tune is its base model's).
  ["openai", "openai-completions", "ft:gpt-4.1-mini:synthetic-org::abc123", {}, 300],
  ["openai", "openai-responses", "ft:gpt-5.6-mini:synthetic-org::abc123", {}, 1800],
  ["openai", "openai-responses", "o7-mini", {}, 300],
  // OpenAI-compatible: only OpenAI's own models, as a router in front of OpenAI serves them.
  ["openai-compatible", "openai-completions", "openai/gpt-4o-mini", {}, 300],
  ["openai-compatible", "openai-completions", "synthetic-local-model", {}, null],
  ["openai-compatible", "openai-completions", "claude-sonnet-5", {}, null],
  // OpenRouter: by the upstream the id names.
  ["openrouter", "openai-completions", "anthropic/claude-custom", explicit, 300],
  ["openrouter", "openai-completions", "anthropic/claude-custom", {}, null],
  ["openrouter", "openai-completions", "google/gemini-custom", {}, 180],
  ["openrouter", "openai-completions", "openai/gpt-4.1-custom", {}, 300],
  ["openrouter", "openai-completions", "openai/gpt-5.6-custom", {}, 1800],
  ["openrouter", "openai-completions", "deepseek/deepseek-custom", {}, null],
  ["openrouter", "openai-completions", "x-ai/grok-custom", {}, null],
  // No documented lifetime: unknown, so the chip shows only a changed prefix.
  ["deepseek", "openai-completions", "deepseek-custom", {}, null],
  ["google", "google-generative-ai", "gemini-custom", {}, null]
] as const)
  it(`a custom ${model} on ${providerId} gets ${ttl ?? "no"} TTL from its provider`, () => {
    const provider = builtinProviders.find((p) => p.id === providerId)!
    assert.equal(documentedCachePolicy({ provider: provider.cacheContract!, api, model }, payload)?.ttlS ?? null, ttl)
  })
