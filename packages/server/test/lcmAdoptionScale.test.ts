import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { lcmTest, lcmHarness } from "./support/lcmHarness.ts"
import { importStFolder } from "./support/stUpload.ts"
import { card, encode, header, jsonl, message } from "./support/stFolder.ts"
import type { SummaryId } from "@dreamspan/shared/lcm.ts"
import { outcome } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

lcmTest(
  "100000 imported hidden messages adoption and writer blocking",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 0 })
      const N = 100000
      const prefix = "ST/data/default-user/"
      const files = new Map([
        [prefix + "settings.json", encode({ username: "Sam" })],
        [prefix + "characters/Bob.png", card("Bob", "Hi")],
        [
          prefix + "chats/Bob/Bob - scale.jsonl",
          jsonl([
            header({}),
            ...Array.from({ length: N }, (_, i) =>
              message({
                name: i % 2 ? "Sam" : "Bob",
                user: i % 2 === 1,
                hidden: i < N - 1,
                mes: `Synthetic ${i}.`,
                minute: i,
                ...(i === N - 2 ? { memory: "A synthetic summary of the whole hidden run." } : {})
              })
            )
          ])
        ]
      ])
      yield* importStFolder(files)
      const chat = (yield* h.api.ListChats({ limit: 50, before: null })).find((c) => c.title === "Bob - scale")!
      assert.isDefined(chat)
      const leaf = (yield* h.api.GetChat({ chatId: chat.id })).activeLeafSlotId!
      const a = { userId: h.userId, chatId: chat.id, leafSlotId: leaf }
      const offer = yield* h.api.GetLcmEnableOffer({ chatId: chat.id, leafSlotId: leaf })
      assert.strictEqual(offer.imported!.hidden, N - 1)
      const imported = yield* h.reader.ReadLcmImported(a)
      const params = {
        ...a,
        choice: "adopt" as const,
        approved: { jobs: 0, tokens: 0, cost: 0, currency: "USD" },
        imported
      }
      const times: number[] = []
      const timed = <A, E, R>(call: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const start = performance.now()
          const result = yield* call
          times.push(performance.now() - start)
          return result
        })
      let stage = yield* timed(h.writer.StageLcmEnable(params))
      while (!stage.ready) stage = yield* timed(h.writer.StageLcmEnable({ ...params, runId: stage.runId }))
      const [before] = yield* fixtureSql(server.config.dataDir, [
        { sql: "SELECT sealed FROM summaries WHERE id=?", params: [stage.runId] }
      ])
      assert.strictEqual(before![0]!.sealed, 0, "partial lineage is never published")
      assert.strictEqual(
        yield* outcome(h.api.GetSummary({ summaryId: stage.runId as typeof SummaryId.Type })),
        "NotFound"
      )
      assert.strictEqual(
        yield* outcome(h.api.ListSummaryRevisions({ summaryId: stage.runId as typeof SummaryId.Type })),
        "NotFound"
      )
      const beforePath = yield* h.api.ReadPath({
        chatId: chat.id,
        leafSlotId: leaf,
        range: { _tag: "Bottom" },
        limit: 3
      })
      assert.isTrue(beforePath.entries[0]!.contextExcluded, "unhide is still staged")
      const result = yield* timed(
        h.writer.EnableLcm({ ...a, choice: "adopt", approved: params.approved, runId: stage.runId })
      )
      const [rows] = yield* fixtureSql(server.config.dataDir, [
        { sql: "SELECT count(*) AS n FROM summary_inputs WHERE summary_id=?", params: [result.summaryId!] }
      ])
      assert.strictEqual(rows![0]!.n, N - 1)
      const path = yield* h.api.ReadPath({ chatId: chat.id, leafSlotId: leaf, range: { _tag: "Bottom" }, limit: 3 })
      assert.isFalse(path.entries[0]!.contextExcluded)
      assert.strictEqual(h.mock.requests().length, 0)
      assert.isBelow(
        Math.max(...times),
        300,
        `every adoption transaction is bounded: slowest ${Math.max(...times).toFixed(1)} ms`
      )
    }).pipe(Effect.scoped),
  { timeout: 240000 }
)
