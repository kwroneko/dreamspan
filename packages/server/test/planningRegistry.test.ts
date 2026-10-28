import { cardDoc } from "./support/docs.ts"
import { assert, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { AssemblyModules } from "../src/assembler/modules.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { Commands, makeCommand } from "../src/commands.ts"
import { RenameHistoryInput, historyReadRpcs } from "@rp/shared/historyApi.ts"
import { lcmHarness, lcmServer, lcmTest } from "./support/lcmHarness.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import type * as Plugin from "./support/planningPlugin.ts"

const source = (exportName: keyof typeof Plugin) => ({
  id: "synthetic-planning",
  module: new URL("./support/planningPlugin.ts", import.meta.url).href,
  exportName
})

for (const dbWorkers of ["source", "bundle"] as const) {
  it.live(
    `worker planning policies override, disable and restore in ${dbWorkers} readers`,
    () => {
      const server = lcmServer({ ...testConfig(), dbWorkers })
      return Effect.gen(function* () {
        const modules = yield* AssemblyModules
        const h = yield* lcmHarness(server, {
          messages: 30,
          settings: { recentTarget: 200, recentMax: 600, leafInput: 100, fanout: 2 }
        })
        const plan = () =>
          h.reader.PlanSummaries({
            userId: h.userId,
            chatId: h.chat.id,
            leafSlotId: h.rows.at(-1)!.slotId,
            reason: "reply"
          })
        const before = yield* plan()
        assert.isAbove(before.chunks.length, 0)
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* modules.register(source("leaf"))
            assert.isTrue((yield* plan()).chunks.every((c) => c.target === 37))
          })
        )
        assert.deepStrictEqual((yield* plan()).chunks, before.chunks)
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* modules.register(source("disableLeaf"))
            assert.strictEqual(yield* outcome(plan()), "AssemblyFailed:invalid_document")
          })
        )
        // Make two adjacent summaries, so the built-in maintenance planner condenses them.
        yield* h.enqueue(0, 2)
        yield* h.runNext
        yield* h.enqueue(3, 5)
        yield* h.runNext
        const ordinary = yield* plan()
        assert.isAbove(ordinary.condensations.length, 0)
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* modules.register(source("maintenance"))
            assert.lengthOf((yield* plan()).condensations, 0)
          })
        )
        assert.deepStrictEqual((yield* plan()).condensations, ordinary.condensations)
      }).pipe(Effect.provide(server.layer))
    },
    60_000
  )
}

lcmTest("registered base instructions and style selection reach durable requests and replay after unload", (server) =>
  Effect.gen(function* () {
    const modules = yield* AssemblyModules
    const execution = yield* ExecutionRegistry
    const h = yield* lcmHarness(server, { messages: 18, settings: { fanout: 2 } })
    const snapshot = Effect.gen(function* () {
      const [rows] = yield* fixtureSql(h.dataDir, [
        {
          sql: "SELECT context_snapshot_json AS snapshot FROM rollout_payloads WHERE context_snapshot_json LIKE '%Synthetic%' ORDER BY rowid DESC LIMIT 1"
        }
      ])
      return JSON.parse(rows![0]!.snapshot as string) as ContextSnapshot
    })
    let frozen: ContextSnapshot | undefined
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* modules.register(source("instructions"))
        yield* h.enqueue(0, 2)
        yield* h.runNext
        assert.include(
          JSON.stringify(h.mock.requests().at(-1)!.body?.messages),
          "Synthetic leaf instruction: 75 words."
        )
        yield* h.enqueue(3, 5)
        yield* h.runNext
        const jobs = yield* h.plan()
        assert.isTrue(jobs.some((j) => j.level === 2))
        yield* h.runNext
        assert.include(JSON.stringify(h.mock.requests().at(-1)!.body?.messages), "Synthetic condensation instruction")
        frozen = yield* snapshot
      })
    )
    const rebuilt = yield* h.reader.RebuildContext({ userId: h.userId, snapshot: JSON.stringify(frozen) })
    assert.strictEqual(rebuilt._tag, "Rebuilt")
    if (rebuilt._tag === "Rebuilt")
      assert.deepStrictEqual((JSON.parse(rebuilt.snapshot) as ContextSnapshot).request, frozen!.request)
    yield* h.enqueue(6, 8)
    yield* h.runNext
    assert.notInclude(JSON.stringify(h.mock.requests().at(-1)!.body?.messages), "Synthetic leaf instruction")
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* modules.register(source("style"))
        yield* execution.summaries.register({
          ...execution.summaries.get("direct")!,
          id: "synthetic",
          instruction: () => "Synthetic output contract"
        })
        yield* h.enqueue(9, 11)
        yield* h.runNext
        assert.include(JSON.stringify(h.mock.requests().at(-1)!.body?.messages), "Synthetic output contract")
      })
    )
    yield* h.enqueue(12, 14)
    yield* h.runNext
    assert.notInclude(JSON.stringify(h.mock.requests().at(-1)!.body?.messages), "Synthetic output contract")
  })
)

lcmTest("an additional persisted summary style executes through its registered strategy", (server) =>
  Effect.gen(function* () {
    const execution = yield* ExecutionRegistry
    const h = yield* lcmHarness(server, { settings: { style: "plugin/style" }, messages: 6 })
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* execution.summaries.register({
          ...execution.summaries.get("direct")!,
          id: "plugin/style",
          instruction: () => "Persisted plugin style"
        })
        yield* h.enqueue(0, 2)
        yield* h.runNext
        assert.include(JSON.stringify(h.mock.requests().at(-1)!.body?.messages), "Persisted plugin style")
      })
    )
    const count = h.mock.requests().length
    const job = yield* h.enqueue(3, 5)
    yield* h.runNext
    assert.strictEqual(h.mock.requests().length, count)
    const [rows] = yield* fixtureSql(h.dataDir, [
      { sql: "SELECT error FROM summarization_jobs WHERE id=?", params: [job.id] }
    ])
    assert.include(JSON.stringify(rows), "Summary strategy plugin/style is unavailable")
  })
)

it.live(
  "reply orchestration replaces actual generation and restores the provider turn",
  () =>
    Effect.gen(function* () {
      const execution = yield* ExecutionRegistry
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider((_r, res) => sse(res, completionChunks(["Original."], {})))),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const run = Effect.map(
        generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} }),
        (r) => r.version
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* execution.replyStrategies.register({
            id: "reply",
            run: () => Stream.make("Synthetic turn.")
          })
          assert.strictEqual((yield* run).content, "Synthetic turn.")
          assert.lengthOf(mock.requests(), 0)
        })
      )
      assert.strictEqual((yield* run).content, "Original.")
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* execution.replyStrategies.disable("reply")
          assert.strictEqual((yield* run).error?.class, "unavailable")
        })
      )
      assert.strictEqual((yield* run).content, "Original.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
  60_000
)

lcmTest("registered history commands affect the RPC workflows and restore on scope exit", (server) =>
  Effect.gen(function* () {
    const commands = yield* Commands
    const h = yield* lcmHarness(server)
    const params = {
      chatId: h.chat.id,
      forkId: h.chat.currentForkId!,
      search: {
        pairs: [{ find: "Message", replace: "Scene" }],
        matchCase: true,
        wholeWord: false,
        regex: false,
        preserveCase: false,
        messages: true,
        swipes: false,
        summaries: false
      }
    }
    const before = yield* h.api.PreviewHistory(params)
    assert.isAbove(before.hits.length, 0)
    const card = yield* h.writer.CreateEntity({
      userId: h.userId,
      kind: "card",
      label: "Synthetic",
      subtitle: "",
      doc: cardDoc("Synthetic"),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const original = commands.get("history.rename")!
    const renameParams = {
      entityId: card.ref.entityId,
      oldName: "Old",
      newName: "New",
      scope: "none" as const,
      chatId: h.chat.id,
      forkId: h.chat.currentForkId!
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* commands.register(
          makeCommand({
            id: "history.search",
            description: "Synthetic",
            input: historyReadRpcs[0].payloadSchema,
            output: historyReadRpcs[0].successSchema,
            execute: () => Effect.succeed({ ...before, hits: [] })
          })
        )
        yield* commands.register(
          makeCommand({
            id: "history.rename",
            description: "Synthetic",
            input: RenameHistoryInput,
            output: Schema.Int,
            execute: () => Effect.succeed(23)
          })
        )
        assert.lengthOf((yield* h.api.PreviewHistory(params)).hits, 0)
        assert.strictEqual(yield* h.api.RenameHistory(renameParams), 23)
      })
    )
    assert.strictEqual(commands.get("history.rename"), original)
    assert.strictEqual(yield* h.api.RenameHistory(renameParams), 0)
    assert.deepStrictEqual((yield* h.api.PreviewHistory(params)).hits, before.hits)
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* commands.disable("history.search")
        assert.strictEqual(yield* outcome(h.api.PreviewHistory(params)), "HistoryRejected")
      })
    )
    assert.deepStrictEqual((yield* h.api.PreviewHistory(params)).hits, before.hits)
  })
)

lcmTest("disabled instruction and style policies fail before provider execution and restore", (server) =>
  Effect.gen(function* () {
    const modules = yield* AssemblyModules
    for (const [exportName, message] of [
      ["disableInstruction", "Summary instruction leaf is unavailable"],
      ["disableStyle", "Summary style selection is unavailable"]
    ] as const) {
      const h = yield* lcmHarness(server, { messages: 3 })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* modules.register(source(exportName))
          const count = h.mock.requests().length
          const job = yield* h.enqueue(0, 2)
          yield* h.runNext
          assert.strictEqual(h.mock.requests().length, count)
          const [rows] = yield* fixtureSql(h.dataDir, [
            { sql: "SELECT error FROM summarization_jobs WHERE id=?", params: [job.id] }
          ])
          assert.include(JSON.stringify(rows), message)
        })
      )
      yield* h.runNext
      assert.lengthOf(h.mock.requests(), 1)
    }
  })
)
