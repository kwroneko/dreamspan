import { assert, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { ExecutionRegistry } from "../src/execution.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"

lcmTest("an unavailable instruction fails only its selected strategy before a provider call", (server) =>
  Effect.gen(function* () {
    const registry = yield* ExecutionRegistry
    const h = yield* lcmHarness(server, { messages: 6 })
    const unavailable = () => {
      throw new Error("Synthetic instruction dependency missing.")
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* registry.summaries.register({ ...registry.summaries.get("tool")!, instruction: unavailable })
        yield* h.enqueue(0, 2)
        yield* h.runNext
        assert.strictEqual(h.mock.requests().length, 1, "the unselected tool strategy must not block direct output")
      })
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* registry.summaries.register({ ...registry.summaries.get("direct")!, instruction: unavailable })
        const requests = h.mock.requests().length
        const job = yield* h.enqueue(3, 5)
        yield* h.runNext
        const [rows] = yield* fixtureSql(h.dataDir, [
          {
            sql: "SELECT error FROM summarization_jobs WHERE id=?",
            params: [job.id]
          }
        ])
        assert.include(JSON.stringify(rows), "Summary strategy direct is unavailable")
        assert.strictEqual(h.mock.requests().length, requests)
      })
    )
  })
)

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

for (const withPreset of [true, false])
  for (const style of ["direct", "tool"] as const) {
    lcmTest(
      `${style} summary strategy withPreset=${withPreset} overrides run through durable jobs and restore on scope exit`,
      (server) =>
        Effect.gen(function* () {
          const registry = yield* ExecutionRegistry
          const builtinTool = registry.summaryTools.get("summary_tool")
          const h = yield* lcmHarness(server, {
            settings: { style, withPreset },
            messages: 18,
            summarizer: (request) =>
              style === "direct" || !request.body?.tools
                ? { text: "A summary." }
                : {
                    tool: {
                      name: JSON.stringify(request.body?.tools).includes("plugin_summary")
                        ? "plugin_summary"
                        : "summary_tool",
                      arguments: { command: "create", file_text: "A summary.", finalize: true }
                    }
                  }
          })
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
                instruction: () => "Use the plugin output contract.",
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
              assert.include(
                JSON.stringify(h.mock.requests().at(-1)!.body?.messages),
                "Use the plugin output contract."
              )
            })
          )
          // The provider calls the offered tool; the replacement must control its instructions too.
          if (style === "tool") {
            let pluginSnapshot: ContextSnapshot | undefined
            yield* Effect.scoped(
              Effect.gen(function* () {
                let content: string | null = null
                let calls = 0
                const factory = {
                  id: "summary_tool",
                  instruction: "Write the summary with plugin_summary; follow its schema.",
                  create: () => ({
                    definition: {
                      name: "plugin_summary",
                      description: "Synthetic",
                      parameters: { type: "object", properties: {} }
                    },
                    content: () => content,
                    execute: () => {
                      calls++
                      content = "Tool factory summary."
                      return { text: "saved", done: true, isError: false }
                    }
                  })
                }
                yield* registry.summaryTools.register(factory)
                yield* h.enqueue(3, 5)
                yield* h.runNext
                assert.deepStrictEqual(yield* read, ["Plugin summary.", "Tool factory summary."])
                const body = h.mock.requests().at(-1)!.body!
                assert.include(JSON.stringify(body.tools), "plugin_summary")
                assert.include(JSON.stringify(body.messages), factory.instruction)
                assert.notInclude(JSON.stringify(body.messages), "summary_tool")
                assert.strictEqual(calls, 1)
                const [rows] = yield* fixtureSql(h.dataDir, [
                  {
                    sql: "SELECT p.context_snapshot_json AS snapshot FROM summaries s JOIN rollout_payloads p ON p.rollout_id=s.rollout_id WHERE s.chat_id=? ORDER BY s.created_at DESC,s.id DESC LIMIT 1",
                    params: [h.chat.id]
                  }
                ])
                pluginSnapshot = JSON.parse(rows![0]!.snapshot as string) as ContextSnapshot
                assert.include(pluginSnapshot.summaryJob!.tail, factory.instruction)
              })
            )
            assert.strictEqual(registry.summaryTools.get("summary_tool"), builtinTool)
            const rebuilt = yield* h.reader.RebuildContext({
              userId: h.userId,
              snapshot: JSON.stringify(pluginSnapshot)
            })
            assert.strictEqual(rebuilt._tag, "Rebuilt")
            if (rebuilt._tag === "Rebuilt")
              assert.deepStrictEqual(JSON.parse(rebuilt.snapshot).request, pluginSnapshot!.request)
            yield* h.enqueue(6, 8)
            yield* h.runNext
            assert.deepStrictEqual(yield* read, ["Plugin summary.", "Tool factory summary.", "A summary."])
            assert.include(
              JSON.stringify(h.mock.requests().at(-1)!.body?.messages),
              "Write the summary with summary_tool."
            )
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* registry.summaryTools.disable("summary_tool")
                const requests = h.mock.requests().length
                const job = yield* h.enqueue(12, 14)
                yield* h.runNext
                const [rows] = yield* fixtureSql(h.dataDir, [
                  {
                    sql: "SELECT error FROM summarization_jobs WHERE id=?",
                    params: [job.id]
                  }
                ])
                assert.include(JSON.stringify(rows), "Summary tool summary_tool is unavailable")
                assert.strictEqual(h.mock.requests().length, requests)
              })
            )
            yield* h.runNext
            assert.strictEqual((yield* read).at(-1), "A summary.")
          } else {
            yield* h.enqueue(3, 5)
            yield* h.runNext
            assert.deepStrictEqual(yield* read, ["Plugin summary.", "A summary."])
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* registry.summaries.disable(style)
              const requests = h.mock.requests().length
              const job = yield* h.enqueue(9, 11)
              yield* h.runNext
              const [rows] = yield* fixtureSql(h.dataDir, [
                { sql: "SELECT error FROM summarization_jobs WHERE id=?", params: [job.id] }
              ])
              assert.include(JSON.stringify(rows), "unavailable")
              assert.strictEqual(h.mock.requests().length, requests)
            })
          )
        })
    )
  }
