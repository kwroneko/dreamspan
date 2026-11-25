import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { isOpenRouterEndpoint } from "@dreamspan/shared/providerDefinitions.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { loadingWireFor } from "../src/agent/loadingPlan.ts"
import type { ModelInput } from "../src/assembler/types.ts"

it.effect("uses the Responses native wire across supported GPT versions and endpoint aliases", () =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    const selected = (key: string, target: Partial<ModelInput> = {}) =>
      loadingWireFor(registry, {
        kind: "openai-responses",
        api: "openai-responses",
        key,
        provider: "openai",
        ...target
      } as ModelInput)?.id
    for (const key of [
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-pro",
      "gpt-5.4-2026-03-05",
      "gpt-5.4-mini-2026-03-17",
      "gpt-5.5",
      "upstream.gpt-5.6-sol",
      "gpt-6-astra"
    ])
      assert.strictEqual(selected(key), "openai-responses", key)
    for (const key of ["gpt-5.3", "gpt-5.4-nano", "upstream.gpt-5.4-nano-2026-03-17", "opaque-model"])
      assert.strictEqual(selected(key), "dispatcher", key)
    assert.strictEqual(selected("gpt-5.4", { provider: "openai-compatible" }), "openai-responses")
    assert.strictEqual(selected("gpt-5.4", { provider: "openrouter" }), "dispatcher")
    assert.strictEqual(selected("openai/gpt-5.4", { openRouterResponses: true }), "dispatcher")
    assert.strictEqual(selected("gpt-5.4", { toolLoading: "dispatcher" }), "dispatcher")
    assert.isUndefined(selected("gpt-5.4", { toolLoading: "every" }))
    assert.strictEqual(selected("gpt-5.4", { kind: "openai-chat", api: "openai-completions" }), "dispatcher")
  }).pipe(Effect.provide(ExecutionRegistry.layer))
)

it("recognizes OpenRouter's endpoint without treating look-alikes as OpenRouter", () => {
  assert.isTrue(isOpenRouterEndpoint("https://openrouter.ai/api/v1"))
  assert.isFalse(isOpenRouterEndpoint("https://openrouter.ai.example.invalid/api/v1"))
  assert.isFalse(isOpenRouterEndpoint("https://synthetic:secret@example.invalid/v1"))
  assert.isFalse(isOpenRouterEndpoint(null))
})
