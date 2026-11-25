import { assert, it } from "@effect/vitest"
import { applyRouterCacheControl, routerCacheFamily } from "../src/providers/breakpoints.ts"
import { documentedCachePolicy } from "../src/providers/cachePolicy.ts"

for (const model of ["qwen/qwen3.6-plus:nitro", "qwen/qwen3.7-plus:floor", "deepseek/deepseek-v3.2:nitro"])
  it(`${model} keeps its Alibaba marker and TTL`, () => {
    const provider = { only: ["alibaba"] }
    const family = routerCacheFamily(model, provider)
    assert.strictEqual(family, "alibaba")
    const payload = { provider, messages: [{ role: "user", content: "A synthetic prefix." }] }
    applyRouterCacheControl(payload, family!, { breakpoints: [0] })
    assert.include(JSON.stringify(payload), '"cache_control":{"type":"ephemeral"}')
    assert.strictEqual(
      documentedCachePolicy({ provider: "openrouter", api: "openai-completions", model }, payload)?.ttlS,
      300
    )
    assert.isNull(routerCacheFamily(model, { only: ["other"] }))
  })
