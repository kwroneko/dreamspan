// Measure the whole fork lifecycle, not just INSERT INTO forks. Synthetic data only.
// Run: env VITEST_MAX_WORKERS=1 FORKCOST_OUT=/storage/.../results.jsonl
//   npx vitest run --project server-slow packages/server/test/forkCostScale.test.ts
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import { type ForkId, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { newChatNote } from "@rp/shared/editing.ts"
import type { SummaryId } from "@rp/shared/lcm.ts"
import { Effect, Stream } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { slotPlacesQuery } from "../src/db/lcmDisplay.ts"
import { sourceOrdinalsQuery, sourceDepthsQuery } from "../src/db/inspectorReads.ts"
import { client, posted, testConfig } from "./support/config.ts"
import { eventually, finished } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmServer } from "./support/lcmHarness.ts"
import { tempDir } from "./support/tempDir.ts"

interface Fixture {
  slots: number
  versions: number
  overrides: number
  events: number
  generatedBytes: number
  summaryIds: Array<string>
  main: Array<{ id: string; selected: string; versions: number }>
}
interface Sample {
  operation: string
  depth: number
  ms: number
}
const shapes = (process.env.FORKCOST_SHAPES ?? "100:200,1000:200,5000:10,5000:200,5000:600")
  .split(",")
  .map((s) => s.split(":").map(Number) as [number, number])
const median = (ns: ReadonlyArray<number>) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]!

for (const [messages, branches] of shapes) {
  it.live(
    `fork lifecycle: ${messages} messages, ${branches} branches, dense overrides and 20–50 swipes`,
    () => {
      const config = testConfig({ dbReaders: 2 })
      const server = lcmServer(config)
      return Effect.gen(function* () {
        const h = yield* lcmHarness(server, { messages: 0, settings: { spendAhead: false } })
        const api = yield* client()
        const reader = yield* Reader
        const writer = yield* Writer
        const userId = h.userId
        const chatId = h.chat.id
        const main = h.chat.currentForkId!
        const note = yield* writer.CreateEntity({
          userId,
          kind: "note",
          label: "Journey",
          subtitle: "",
          schemaVersion: 1,
          origin: "user",
          sourcePath: null,
          doc: { ...newChatNote(chatId, "Journey"), content: "The travelers seek a synthetic harbor." }
        })
        const work = tempDir("forkcost-fixture")
        const fixture = yield* Effect.promise(
          () =>
            new Promise<Fixture>((resolve, reject) => {
              const worker = new Worker(new URL("./support/forkCostFixtureWorker.ts", import.meta.url), {
                workerData: {
                  dbPath: databaseFile(config.dataDir),
                  root: join(work, "input"),
                  chatId,
                  messages,
                  branches,
                  note: note.ref.entityId,
                  revision: note.ref.headRevisionId
                }
              })
              let result: Fixture | undefined
              worker.once("message", (r: Fixture) => {
                result = r
              })
              worker.once("error", reject)
              worker.once("exit", (code) =>
                code === 0 && result ? resolve(result) : reject(new Error(`fixture worker exited ${code}`))
              )
            })
        )
        console.log("FORKCOST_READY", messages, branches, fixture.slots, fixture.versions, fixture.overrides)
        const [placePlan] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: `EXPLAIN QUERY PLAN ${slotPlacesQuery}`,
              params: [JSON.stringify(fixture.main.slice(0, 50).map((s) => s.id)), chatId]
            }
          ],
          { readOnly: true }
        )
        const placesOfPlan = placePlan!.map((row) => String(row.detail))
        assert.isTrue(
          placesOfPlan.some((detail) => /SEARCH s USING .*\(id=\?\)/.test(detail)),
          "summary slot lookup must probe ids, not scan chat history"
        )
        assert.isFalse(placesOfPlan.some((detail) => /slots_chat_depth|SCAN s$/.test(detail)))
        const inspectionPlans = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: `EXPLAIN QUERY PLAN ${sourceOrdinalsQuery}`,
              params: [JSON.stringify(fixture.main.slice(0, 50).map((s) => s.selected)), chatId, userId]
            },
            {
              sql: `EXPLAIN QUERY PLAN ${sourceDepthsQuery}`,
              params: [JSON.stringify(fixture.main.slice(0, 50).map((s) => s.id)), chatId, userId]
            }
          ],
          { readOnly: true }
        )
        for (const [i, plan] of inspectionPlans.entries()) {
          const details = plan.map((row) => String(row.detail))
          assert.isTrue(
            details.some((detail) => new RegExp(`SEARCH ${i === 0 ? "v" : "s"} USING .*\\(id=\\?\\)`).test(detail)),
            "inspection source metadata must probe ids"
          )
          assert.isFalse(details.some((detail) => /slots_chat_depth/.test(detail)))
        }
        const samples: Array<Sample> = []
        const lineageRows: Array<Record<string, unknown>> = []
        const freshCounts: Array<{ operation: string; depth: number; count: number }> = []
        const measure = <A, E, R>(operation: string, depth: number, action: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const start = performance.now()
            const answer = yield* action
            const sample = { operation, depth, ms: performance.now() - start }
            samples.push(sample)
            console.log("FORKCOST_SAMPLE", messages, branches, JSON.stringify(sample))
            return answer
          })
        const repeated = <A, E, R>(operation: string, depth: number, action: Effect.Effect<A, E, R>, n = 5) =>
          Effect.gen(function* () {
            const start = samples.length
            let answer = yield* measure(operation, depth, action)
            for (let i = 1; i < n; i++) answer = yield* measure(operation, depth, action)
            console.log(
              "FORKCOST_MEDIAN",
              messages,
              branches,
              operation,
              depth,
              median(samples.slice(start).map((s) => s.ms))
            )
            return answer
          })
        const tip = fixture.main.at(-1)!.id as SlotId
        const pickerSlot = fixture.main.find((s) => s.versions >= 20)!.id as SlotId
        const pointSlot = fixture.main[Math.floor(messages / 2) + 1]!.id as SlotId
        const view = {
          entity: null,
          chat: null,
          search: "",
          sort: "recent" as const,
          sections: [{ id: "chats" as const, limit: 100 }]
        }
        const store = (fresh: Parameters<typeof writer.StoreForkSummaries>[0]["chats"]) =>
          writer.StoreForkSummaries({ userId, chats: fresh })
        // Warm every pre-existing fork once, then check exactly which summaries a fork
        // invalidates. Reader results expose fresh rows; the RPC persists the same rows.
        const initial = yield* measure("initial-summary-computation", 0, reader.ShellLibrary({ userId }))
        assert.strictEqual(initial.fresh.flatMap((c) => JSON.parse(c.forks)).length, branches)
        yield* store(initial.fresh)
        const fork = (from: ForkId) => writer.CreateFork({ userId, chatId, fromForkId: from, atSlotId: tip })
        const shallow = (yield* repeated("CreateFork", 1, fork(main), 3)).fork.id
        const post = yield* measure("new-fork-summary-computation", 1, reader.ShellLibrary({ userId }))
        assert.strictEqual(
          post.fresh.flatMap((c) => JSON.parse(c.forks)).length,
          3,
          "fork creation must preserve existing summaries"
        )
        yield* measure("summary-persistence-and-validity", 1, store(post.fresh))
        const interior = yield* measure(
          "CreateFork-interior",
          1,
          writer.CreateFork({
            userId,
            chatId,
            fromForkId: main,
            atSlotId: fixture.main[Math.floor(messages / 2)]!.id as SlotId
          })
        )
        yield* measure("ListForks-newfork-cold", 1, reader.ListForks({ userId, chatId }))
        const interiorRead = yield* measure("interior-summary-computation", 1, reader.ShellLibrary({ userId }))
        const count = interiorRead.fresh.flatMap((c) => JSON.parse(c.forks)).length
        freshCounts.push({ operation: "interior-summary-computation", depth: 1, count })
        assert.strictEqual(count, 1, "excluding insertions in a new fork must preserve existing summaries")
        assert.isTrue(interiorRead.forks.some((f) => f.forkId === interior.fork.id))
        yield* store(interiorRead.fresh)
        yield* repeated("shell-warm", 1, reader.ShellLibrary({ userId }), 3)
        yield* repeated("shell-cards-warm", 1, reader.ShellCards({ userId }), 3)
        yield* repeated("GetChat", 1, reader.GetChat({ userId, chatId }), 3)
        yield* repeated("ListForks", 1, reader.ListForks({ userId, chatId }), 3)
        // Listing cached forks must not sort every message of each path again.
        assert.isBelow(
          median(samples.filter((s) => s.operation === "ListForks").map((s) => s.ms)),
          branches * 20 + 1000
        )
        yield* repeated("chats-list-warm", 1, reader.ShellForks({ userId, view }), 3)
        yield* repeated("ListChats", 1, reader.ListChats({ userId, limit: 100, before: null }), 3)
        const path = (forkId: ForkId) =>
          reader.ReadPath({ userId, chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
        const reads = (forkId: ForkId, depth: number) =>
          Effect.gen(function* () {
            const window = yield* repeated("path-window-100", depth, path(forkId))
            assert.strictEqual(window.entries.at(-1)!.slotId, tip)
            assert.isAtMost(window.entries.length, 100)
            const versions = yield* repeated(
              "version-picker",
              depth,
              reader.ListVersions({ userId, slotId: pickerSlot, forkId })
            )
            assert.isAtLeast(versions.length, 20)
            const point = yield* repeated(
              "effective-selection-flags",
              depth,
              reader.GetSlot({ userId, slotId: pointSlot, forkId })
            )
            assert.strictEqual(point.entry.version.id, fixture.main[Math.floor(messages / 2) + 1]!.selected)
            const state = yield* repeated(
              "state-events",
              depth,
              reader.StateEventsAt({ userId, chatId, forkId, slotId: tip }),
              3
            )
            assert.isAbove(state.length, 0)
            yield* repeated("LCM-state", depth, reader.GetLcmState({ userId, chatId, forkId, leafSlotId: tip }), 3)
            const summary = yield* repeated(
              "summary-read-validity",
              depth,
              reader.GetSummary({ userId, forkId, summaryId: fixture.summaryIds[0]! as typeof SummaryId.Type }),
              3
            )
            assert.isTrue(summary.fresh)
            const next = yield* repeated(
              "next-context",
              depth,
              reader.CacheWarmth({ userId, chatId, forkId, leafSlotId: tip }),
              3
            )
            assert.isNull(next.assemblyError ?? null)
            yield* repeated(
              "first-context-assembly",
              depth,
              reader.AssembleContext({
                userId,
                chatId,
                forkId,
                slotId: tip,
                versionId: fixture.main.at(-1)!.selected as VersionId,
                now: Date.now(),
                timeZone: "UTC",
                frozen: null
              }),
              3
            )
          })
        yield* reads(shallow, 1)
        const ttft = (forkId: ForkId, depth: number) =>
          Effect.gen(function* () {
            const events: Array<ChatEvent> = []
            yield* api.SubscribeChat({ chatId }).pipe(
              Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
              Effect.forkScoped
            )
            yield* eventually(() => events.length > 0)
            const start = performance.now()
            const generated = yield* posted(api.Generate({ chatId, forkId, parentSlotId: tip, branch: false }))
            yield* eventually(
              () =>
                events.some(
                  (e) => e._tag === "Delta" && e.versionId === generated.entry.version.id && e.text.length > 0
                ),
              120_000
            )
            const sample = { operation: "first-reply-TTFT", depth, ms: performance.now() - start }
            samples.push(sample)
            console.log("FORKCOST_SAMPLE", messages, branches, JSON.stringify(sample))
            yield* eventually(() => finished(events, generated.entry.version.id)?.status === "complete", 120_000)
          }).pipe(Effect.scoped)
        yield* ttft(shallow, 1)
        // Each chain link is a real CreateFork. Positive state_seq ensures the lineage
        // cannot collapse away empty bounds. Record both genealogy depth and actual length.
        if (
          (branches === 200 && messages < 5000) ||
          (messages === 5000 && branches === 600) ||
          process.env.FORKCOST_DEPTHS === "1"
        ) {
          let parent = main
          for (let depth = 1; depth <= 200; depth++) {
            const made = yield* measure("CreateFork-chain", depth, fork(parent))
            parent = made.fork.id
            if ([1, 32, 63, 64, 65, 200].includes(depth)) {
              const [rows] = yield* fixtureSql(
                config.dataDir,
                [
                  {
                    sql: `SELECT json_array_length(lineage_json) AS lineage,
              (SELECT count(*) FROM fork_overrides o WHERE o.fork_id=f.id) AS copiedOverrides,
              (SELECT count(*) FROM fork_event_snapshots e WHERE e.fork_id=f.id) AS copiedEvents FROM forks f WHERE id=?`,
                    params: [parent]
                  }
                ],
                { readOnly: true }
              )
              const row = rows![0]!
              lineageRows.push({ depth, ...row })
              assert.isAtMost(Number(row.lineage), 64)
              if (depth === 63) assert.strictEqual(row.lineage, 64)
              if (depth === 64) {
                assert.strictEqual(row.lineage, 1)
                assert.isAbove(Number(row.copiedOverrides), messages)
              }
              console.log("FORKCOST_LINEAGE", depth, JSON.stringify(row))
              const shell = yield* measure("chain-summary-computation", depth, reader.ShellLibrary({ userId }))
              const stale = shell.fresh.flatMap((c) => JSON.parse(c.forks)).length
              freshCounts.push({ operation: "chain-summary-computation", depth, count: stale })
              console.log("FORKCOST_STALE", depth, stale)
              yield* measure("chain-summary-persistence", depth, store(shell.fresh))
            }
            if (depth === 63) {
              yield* reads(parent, depth)
              yield* ttft(parent, depth)
              const afterReply = yield* measure(
                "post-reply-summary-computation",
                depth,
                reader.ShellLibrary({ userId })
              )
              yield* store(afterReply.fresh)
            }
          }
        }
        yield* repeated("splitchat-marker", 1, writer.SetSplitChat({ userId, forkId: shallow, split: true }), 3)
        yield* repeated("splitchat-read", 1, reader.GetSplitChats({ userId, chatId, forkId: shallow }), 3)
        yield* repeated("splitchat-chats-list", 1, reader.ShellForks({ userId, view }), 3)
        // ForkMerge is the library's three-way document merge, not a chat-history merge.
        // Measure its real operations in the same database, keeping document size fixed.
        const source = yield* writer.CreateEntity({
          userId,
          kind: "note",
          label: "Merge source",
          subtitle: "",
          doc: { ...newChatNote(chatId, "Merge source"), content: "base" },
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        const child = yield* writer.ForkRef({ userId, refId: source.ref.id, label: "Merge child", subtitle: "" })
        yield* writer.EditRef({
          userId,
          refId: source.ref.id,
          expectedRowVersion: source.ref.rowVersion,
          doc: { ...newChatNote(chatId, "Merge source"), content: "updated" },
          message: null,
          commitDraft: null
        })
        yield* repeated("ForkMergeStatus", 1, reader.ForkMergeStatus({ userId, refId: child.id }), 3)
        const preview = yield* repeated("PreviewForkMerge", 1, reader.PreviewForkMerge({ userId, refId: child.id }), 3)
        const merged = yield* measure(
          "CommitForkMerge",
          1,
          writer.CommitForkMerge({
            userId,
            refId: child.id,
            theirsRevisionId: preview.theirsRevisionId,
            baseRevisionId: preview.baseRevisionId,
            expectedRowVersion: preview.ref.rowVersion,
            selection: { excluded: [], resolutions: [] },
            message: null
          })
        )
        yield* measure(
          "UndoForkMerge",
          1,
          writer.UndoForkMerge({
            userId,
            refId: child.id,
            mergeRevisionId: merged.ref.headRevisionId,
            expectedRowVersion: merged.ref.rowVersion
          })
        )
        const result = {
          messages,
          branches,
          lineageRows,
          freshCounts,
          placesOfPlan,
          inspectionPlans,
          fixture: { ...fixture, main: undefined },
          samples
        }
        if (process.env.FORKCOST_OUT) appendFileSync(process.env.FORKCOST_OUT, JSON.stringify(result) + "\n")
        console.log("FORKCOST_RESULT", JSON.stringify(result))
      }).pipe(Effect.provide(server.layer), Effect.scoped)
    },
    3_600_000
  )
}
