import { assert, it } from "@effect/vitest"
import { documentedCachePolicy } from "../src/providers/cachePolicy.ts"

const hour = { system: [{ cache_control: { type: "ephemeral", ttl: "1h" } }] }
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
  ["openrouter", "openai-completions", "anthropic/claude", {}, 300, false],
  ["openrouter", "openai-completions", "anthropic/claude", hour, 600, false],
  ["openrouter", "openai-completions", "anthropic/claude", { ...hour, provider: { only: ["Anthropic"] } }, 3600, false],
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
