import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { isDirectOpenAI } from "@dreamspan/shared/providerDefinitions.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { loadingWireFor } from "../src/agent/loadingPlan.ts"
import type { ModelInput } from "../src/assembler/types.ts"

it.effect("limits new Automatic defaults to direct OpenAI and the specified model ids", () =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    const selected = (kind: string, api: string, key: string, provider = "openai") =>
      loadingWireFor(registry, {
        kind,
        api,
        key,
        provider,
        openaiDirect: true
      } as unknown as ModelInput)?.id
    for (const key of ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4-pro"])
      assert.strictEqual(selected("openai-responses", "openai-responses", key), "openai-responses", key)
    for (const key of ["gpt-5.4-nano", "gpt-5.4-mini"])
      assert.strictEqual(selected("openai-chat", "openai-completions", key), "dispatcher", key)
    for (const key of [
      "gpt-5.4-nano",
      "gpt-5.4-2026-03-05",
      "gpt-5.4-mini-2026-03-17",
      "gpt-5.4-pro-2026-03-05",
      "gpt-5.5",
      "gpt-5.3",
      "gpt-5.4-mini-test"
    ])
      assert.isUndefined(selected("openai-responses", "openai-responses", key), key)
    for (const key of ["gpt-5.4", "gpt-5.4-pro", "gpt-5.4-nano-2026-03-17", "gpt-5.3", "gpt-5.5"])
      assert.isUndefined(selected("openai-chat", "openai-completions", key), key)
    for (const provider of ["openai-compatible", "openrouter", "openai-bedrock"])
      for (const key of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"])
        for (const [kind, api] of [
          ["openai-chat", "openai-completions"],
          ["openai-responses", "openai-responses"]
        ])
          assert.isUndefined(selected(kind!, api!, key, provider))
  }).pipe(Effect.provide(ExecutionRegistry.layer))
)

it.effect("does not enable OpenAI defaults for a named OpenAI connection pointing at a proxy", () =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    for (const baseUrl of [
      "https://example.invalid/v1",
      "https://api.openai.com.example.invalid/v1",
      "https://example.invalid/openai/deployments/gpt-5.4",
      "https://api.openai.com/v1/proxy",
      undefined
    ]) {
      for (const [kind, api, key] of [
        ["openai-chat", "openai-completions", "gpt-5.4-mini"],
        ["openai-responses", "openai-responses", "gpt-5.4"]
      ])
        assert.isUndefined(
          loadingWireFor(registry, {
            kind,
            api,
            key,
            provider: "openai",
            openaiDirect: isDirectOpenAI("openai", baseUrl)
          } as unknown as ModelInput),
          baseUrl
        )
    }
  }).pipe(Effect.provide(ExecutionRegistry.layer))
)

it.effect("classifies only the default and canonical direct OpenAI address", () =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    for (const baseUrl of [null, "https://api.openai.com/v1", "https://api.openai.com/v1/"]) {
      assert.isTrue(isDirectOpenAI("openai", baseUrl))
      assert.strictEqual(
        loadingWireFor(registry, {
          provider: "openai",
          openaiDirect: isDirectOpenAI("openai", baseUrl),
          kind: "openai-chat",
          api: "openai-completions",
          key: "gpt-5.4-mini"
        } as ModelInput)?.id,
        "dispatcher"
      )
    }
    assert.isFalse(isDirectOpenAI("openai-compatible", "https://api.openai.com/v1"))
    assert.isFalse(isDirectOpenAI("openai", "https://synthetic:secret@example.invalid/v1"))
  }).pipe(Effect.provide(ExecutionRegistry.layer))
)
