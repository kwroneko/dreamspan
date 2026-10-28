import { assert, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { ExecutionRegistry } from "../src/execution.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

it.live(
  "reply output overrides affect persisted generations and scope exit restores the decoder",
  () =>
    Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider((_r, res) => sse(res, completionChunks(["Original."], {})))),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const run = Effect.gen(function* () {
        const { version } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {}
        })
        return version
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* registry.replies.register({
            id: "reply",
            create: () => ({
              decode: (event) => Effect.succeed(event.type === "text" ? Result.succeed("Plugin.") : Result.failVoid)
            })
          })
          assert.strictEqual((yield* run).content, "Plugin.")
        })
      )
      assert.strictEqual((yield* run).content, "Original.")
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* registry.replies.disable("reply")
          const version = yield* run
          assert.strictEqual(version.status, "failed")
          assert.strictEqual(version.error?.class, "unavailable")
        })
      )
      assert.strictEqual((yield* run).content, "Original.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
  60_000
)

for (const style of ["direct", "tool"] as const) {
  lcmTest(`${style} summary strategy overrides run through durable jobs and restore on scope exit`, (server) =>
    Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      const builtinTool = registry.summaryTools.get("summary_tool")
      const h = yield* lcmHarness(server, { settings: { style }, messages: 12 })
      const read = Effect.gen(function* () {
        const [rows] = yield* fixtureSql(h.dataDir, [
          {
            sql: "SELECT r.content FROM summaries s JOIN summary_revisions r ON r.id=s.selected_revision_id WHERE s.chat_id=? ORDER BY s.created_at,s.id",
            params: [h.chat.id]
          }
        ])
        return rows!.map((r) => r.content)
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* registry.summaries.register({
            id: style,
            create: () => ({
              candidate: () => "Plugin summary.",
              beginTurn: () => {},
              onText: () => {},
              accept: () => ({ done: true, content: "Plugin summary.", appended: [] })
            })
          })
          yield* h.enqueue(0, 2)
          yield* h.runNext
          assert.deepStrictEqual(yield* read, ["Plugin summary."])
        })
      )
      // Use a replacement tool against the text-only mock to prove definition and executor dispatch.
      if (style === "tool") {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* registry.summaryTools.register({
              id: "summary_tool",
              create: () => ({
                definition: {
                  name: "plugin_summary",
                  description: "Synthetic",
                  parameters: { type: "object", properties: {} }
                },
                content: () => "Tool factory summary.",
                execute: () => ({ text: "saved", done: true, isError: false })
              })
            })
            yield* h.enqueue(3, 5)
            yield* h.runNext
            assert.deepStrictEqual(yield* read, ["Plugin summary.", "Tool factory summary."])
            const body = h.mock.requests().at(-1)!.body!
            assert.include(JSON.stringify(body.tools), "plugin_summary")
          })
        )
        assert.strictEqual(registry.summaryTools.get("summary_tool"), builtinTool)
      } else {
        yield* h.enqueue(3, 5)
        yield* h.runNext
        assert.deepStrictEqual(yield* read, ["Plugin summary.", "A summary."])
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* registry.summaries.disable(style)
          const job = yield* h.enqueue(6, 8)
          yield* h.runNext
          const [rows] = yield* fixtureSql(h.dataDir, [
            { sql: "SELECT error FROM summarization_jobs WHERE id=?", params: [job.id] }
          ])
          assert.include(JSON.stringify(rows), "unavailable")
        })
      )
    })
  )
}
