import type { AssistantMessage } from "@earendil-works/pi-ai"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import type { SummaryExecutionInput } from "../src/lcm/strategies.ts"
import { ExecutionRegistry } from "../src/execution.ts"

const reply = (name: string, args: Record<string, string | boolean>): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id: "call", name, arguments: args }],
  api: "openai-completions",
  provider: "openai",
  model: "synthetic",
  stopReason: "toolUse",
  timestamp: 0,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
})
// Only target is read by these factories. No real chat or card is needed.
const input = { job: { target: 100 }, snapshot: {} } as SummaryExecutionInput

it.effect(
  "the tool strategy uses the registered definition and executor, and restores an isolated built-in draft",
  () =>
    Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      const strategy = registry.summaries.get("tool")!
      const before = strategy.create(input, registry.summaryTools)
      yield* Effect.scoped(
        Effect.gen(function* () {
          let content = ""
          yield* registry.summaryTools.register({
            id: "summary_tool",
            create: () => ({
              definition: { ...before.tools![0]!, name: "synthetic_tool" },
              content: () => content,
              execute: (args) => {
                content = `Plugin ${args.value}.`
                return { text: "saved", done: true, isError: false }
              }
            })
          })
          const output = strategy.create(input, registry.summaryTools)
          assert.notInclude(strategy.instruction!(registry.summaryTools), "summary_tool")
          assert.strictEqual(output.tools![0]!.name, "synthetic_tool")
          const denied = output.accept(reply("summary_tool", {}))
          assert.isFalse(denied.done)
          assert.deepInclude(denied.appended[1], { isError: true })
          const result = output.accept(reply("synthetic_tool", { value: "draft" }))
          assert.isTrue(result.done)
          assert.strictEqual(result.content, "Plugin draft.")
          assert.strictEqual(output.candidate(), "Plugin draft.")
        })
      )
      const restored = strategy.create(input, registry.summaryTools)
      assert.include(strategy.instruction!(registry.summaryTools), "Write the summary with summary_tool.")
      assert.strictEqual(restored.tools![0]!.name, "summary_tool")
      assert.strictEqual(restored.candidate(), "")
      assert.strictEqual(
        restored.accept(reply("summary_tool", { command: "create", file_text: "Original.", finalize: true })).content,
        "Original."
      )
      assert.strictEqual(before.candidate(), "", "attempts have separate drafts")
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* registry.summaryTools.disable("summary_tool")
          assert.throws(() => strategy.create(input, registry.summaryTools), "unavailable")
        })
      )
      assert.strictEqual(strategy.create(input, registry.summaryTools).tools![0]!.name, "summary_tool")
    }).pipe(Effect.provide(ExecutionRegistry.layer))
)
