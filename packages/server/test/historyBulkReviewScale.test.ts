import { Worker } from "node:worker_threads"
import { writeFileSync } from "node:fs"
import { assert, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { composerKey } from "@rp/shared/drafts.ts"
import type { HistoryCursor, HistoryHit } from "@rp/shared/historyApi.ts"
import { prepareHistory } from "../src/historyPreparation.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { client, testConfig, serverLayer } from "./support/config.ts"

it.live(
  "publishes the user Replace all and Undo without delaying another draft on 5,000 messages, 200 branches and 20–50 swipes",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const userId = (yield* api.Whoami()).id
      const writer = yield* Writer
      const reader = yield* Reader
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Synthetic bulk story",
        participants: [],
        greeting: null
      })
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const worker = new Worker(new URL("./support/workshopRewriteFixtureWorker.ts", import.meta.url), {
              workerData: {
                dbPath: databaseFile(config.dataDir),
                chatId: chat.id,
                forkId: chat.currentForkId,
                messages: 5000,
                branches: 200
              }
            })
            worker.once("error", reject)
            worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`))))
          })
      )
      const edits: HistoryHit[] = []
      let cursor: typeof HistoryCursor.Type | undefined
      do {
        const page = yield* reader.PreviewHistory({
          userId,
          chatId: chat.id,
          forkId: chat.currentForkId!,
          search: {
            pairs: [{ find: "Aria", replace: "Ari" }],
            matchCase: true,
            wholeWord: false,
            regex: false,
            preserveCase: false,
            messages: true,
            swipes: false,
            summaries: false
          },
          ...(cursor ? { cursor } : {})
        })
        edits.push(...page.hits)
        cursor = page.next ?? undefined
      } while (cursor)
      assert.strictEqual(edits.length, 5000)
      const observe = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          const other = yield* writer
            .CreateChat({
              userId,
              kind: "rp",
              status: "active",
              title: "Other tab draft",
              participants: [],
              greeting: null
            })
            .pipe(Effect.orDie)
          const start = performance.now()
          let finished = start
          const pending = yield* Effect.forkScoped(
            effect.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  finished = performance.now()
                })
              )
            )
          )
          yield* Effect.sleep(5)
          const draftStart = performance.now()
          const draft = yield* writer
            .SaveDraft({
              userId,
              key: composerKey(other.id, other.currentForkId),
              draftId: null,
              content: "Draft during bulk publication",
              expectedRowVersion: null,
              expectedSession: null,
              baseRevision: null
            })
            .pipe(Effect.orDie)
          const draftMs = performance.now() - draftStart
          const result = yield* Fiber.join(pending)
          const ms = finished - start
          assert.strictEqual(draft.content, "Draft during bulk publication")
          assert.isBelow(ms, 1500, "A whole-chat publication must stay short")
          assert.isBelow(draftMs, 1500, "Another chat's draft must not wait beyond the publication bound")
          return { result, ms, draftMs }
        })
      const preparationStart = performance.now()
      const input = yield* prepareHistory(writer, {
        userId,
        title: "Replace all",
        applications: [{ chatId: chat.id, forkId: chat.currentForkId!, edits }]
      })
      const preparationMs = performance.now() - preparationStart
      const applied = yield* observe(writer.ApplyHistoryEdits(input))
      const result = applied.result
      const applyMs = applied.ms
      const undoResult = yield* observe(
        writer.UndoHistoryEdit({
          userId,
          chatId: chat.id,
          forkId: chat.currentForkId!,
          changesetId: result.changesetIds[0]!
        })
      )
      const undone = undoResult.result
      const undoMs = undoResult.ms
      assert.strictEqual(undone.undone, 5000)
      assert.isEmpty(undone.conflicts)
      if (process.env.HISTORY_BULK_OUTPUT)
        writeFileSync(
          process.env.HISTORY_BULK_OUTPUT,
          JSON.stringify(
            { preparationMs, applyMs, undoMs, applyDraftMs: applied.draftMs, undoDraftMs: undoResult.draftMs },
            null,
            2
          )
        )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  }
)
