import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import type { ModelInput } from "../src/assembler/types.ts"
import { loadingWireFor } from "../src/agent/loadingPlan.ts"
import { ExecutionRegistry } from "../src/execution.ts"

for (const [kind, api, key, openRouterResponses] of [
  ["anthropic", "anthropic-messages", "deepseek-v4-flash", false],
  ["anthropic", "anthropic-messages", "opaque-deployment", false],
  ["anthropic-bedrock", "anthropic-messages", "global.anthropic.claude-sonnet-4-7-v1:0", false],
  ["anthropic-vertex", "anthropic-messages", "opaque-deployment", false],
  ["openai-responses", "openai-responses", "opaque-deployment", false],
  ["openai-responses-bedrock", "openai-responses", "global.openai.gpt-5.6-sol", false],
  ["openai-responses", "openai-responses", "openai/gpt-5.6-sol:nitro", true]
] as const)
  it.effect(`${kind} ${key} selects native loading by default and preserves explicit controls`, () =>
    Effect.gen(function* () {
      const execution = yield* ExecutionRegistry
      const model = { kind, api, key, openRouterResponses } as ModelInput
      assert.strictEqual(loadingWireFor(execution, model)?.id, api)
      assert.strictEqual(loadingWireFor(execution, { ...model, toolLoading: "dispatcher" })?.id, "dispatcher")
      assert.isUndefined(loadingWireFor(execution, { ...model, toolLoading: "every" }))
    }).pipe(Effect.provide(ExecutionRegistry.layer))
  )

it.effect("only the recorded Responses model/mechanism failures select dispatcher", () =>
  Effect.gen(function* () {
    const execution = yield* ExecutionRegistry
    for (const [key, router] of [
      ["ft:gpt-5.4-nano:synthetic::deployment", false],
      ["openai/gpt-5.4-mini:nitro", true]
    ] as const) {
      const model = {
        kind: "openai-responses",
        api: "openai-responses",
        key,
        openRouterResponses: router
      } as ModelInput
      assert.strictEqual(loadingWireFor(execution, model)?.id, "dispatcher")
    }
  }).pipe(Effect.provide(ExecutionRegistry.layer))
)
