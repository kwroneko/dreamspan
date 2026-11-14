import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { ExecutionRegistry } from "../src/execution.ts"
import { loadingWireFor } from "../src/agent/loadingPlan.ts"
import type { ModelInput } from "../src/assembler/types.ts"

it.effect("limits new Automatic defaults to direct OpenAI and the specified model ids", () =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    const selected = (kind: string, api: string, key: string, provider = "openai") =>
      loadingWireFor(registry, { kind, api, key, provider } as unknown as ModelInput)?.id
    for (const key of ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-2026-03-05"])
      assert.strictEqual(selected("openai-responses", "openai-responses", key), "openai-responses", key)
    for (const key of ["gpt-5.4-nano", "gpt-5.4-mini"])
      assert.strictEqual(selected("openai-chat", "openai-completions", key), "dispatcher", key)
    for (const key of ["gpt-5.4-nano", "gpt-5.4-nano-2026-03-17", "gpt-5.5", "gpt-5.3", "gpt-5.4-mini-test"])
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
