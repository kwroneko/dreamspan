// One long swipe-heavy file in a chat with hundreds of independent forks. Synthetic only.
// Opt in: this writes hundreds of thousands of versions, so routine slow gates keep it off.
// ST_REIMPORT_OWNER_DEPTH: the depth the 200 added forks branch at (default 2; 19999 makes
// every fork inherit the whole file). ST_REIMPORT_OWNER_MESSAGES: the file's length (20,000).
// The first import is checked and confirmed too, so both a new 20,000-message chat and the
// re-import's few new messages are measured as the writer pause a concurrent write sees.
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { loadavg } from "node:os"
import { join } from "node:path"
import { assert, it as plain, layer } from "@effect/vitest"
import type { SlotId } from "@rp/shared/chat.ts"
import { ST_CHANGED_SINCE_CHECK } from "@rp/shared/stReimportPlan.ts"
import { Effect, Fiber } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { card, header, message } from "./support/stFolder.ts"
import { jobEnded } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

type Api = Effect.Success<ReturnType<typeof client>>

if (process.env.ST_REIMPORT_OWNER_SCALE !== "1") {
  plain.skip("20,000 messages with 20–50 swipes and 200 forks (ST_REIMPORT_OWNER_SCALE=1)", () => {})
} else {
  const MESSAGES = Number(process.env.ST_REIMPORT_OWNER_MESSAGES ?? 20_000)
  const DEPTH = Number(process.env.ST_REIMPORT_OWNER_DEPTH ?? 2)
  const config = testConfig({ dbReaders: 2 })

  /** Checks the folder, then imports it from the check; the writer pause a rename sees meanwhile. */
  const checkedImport = (api: Api, root: string, probeChat: import("@rp/shared/chat.ts").ChatId) =>
    Effect.gen(function* () {
      const checkStarted = performance.now()
      const { plan } = yield* api.StartStImportPlan({ folder: { root, prefix: "" } })
      let done = plan
      while (done.status === "running") {
        yield* Effect.sleep(100)
        done = yield* api.GetStImportPlan({ planId: plan.planId })
      }
      assert.strictEqual(done.status, "done", done.error ?? "")
      const checkMs = performance.now() - checkStarted
      const samples: number[] = []
      let worst = { ms: 0, at: 0 }
      let stop = false
      const probes = yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (!stop) {
            const at = Date.now()
            const before = performance.now()
            yield* api.RenameChat({ chatId: probeChat, name: `Writer probe ${samples.length}` })
            const ms = performance.now() - before
            samples.push(ms)
            if (ms > worst.ms) worst = { ms, at }
            yield* Effect.sleep(20)
          }
        })
      )
      const importStarted = performance.now()
      const { importId } = yield* api.StartStPathImport({
        path: root,
        prefix: "",
        plan: { planId: done.planId, skip: [] }
      })
      let peakStaged = 0
      let result = yield* api.GetStImport({ importId })
      while (result.job.status === "running") {
        const [rows] = yield* fixtureSql(
          config.dataDir,
          [{ sql: "SELECT coalesce(sum(length(batch_json)),0) AS n FROM st_import_stage" }],
          { readOnly: true }
        )
        peakStaged = Math.max(peakStaged, Number(rows![0]!.n))
        yield* Effect.sleep(250)
        result = yield* api.GetStImport({ importId })
      }
      const importMs = performance.now() - importStarted
      stop = true
      yield* Fiber.join(probes)
      assert.strictEqual(result.job.status, "complete")
      assert.deepStrictEqual(
        result.report!.issues.filter((i) => i.code === ST_CHANGED_SINCE_CHECK),
        []
      )
      const [rows] = yield* fixtureSql(config.dataDir, [{ sql: "SELECT count(*) AS n FROM st_import_stage" }], {
        readOnly: true
      })
      assert.strictEqual(rows![0]!.n, 0)
      assert.isAbove(samples.length, 0)
      yield* jobEnded(api, importId)
      const sorted = [...samples].sort((a, b) => a - b)
      return {
        plan: done,
        refusedUnplanned: result.report!.issues.some((issue) => issue.code === "st.chat_unplanned"),
        checkMs,
        importMs,
        peakStaged,
        writerProbes: samples.length,
        /** When the slowest probe was sent (epoch ms), to line it up with what the writer ran. */
        writerMaxAt: worst.at,
        importStartedAt: Date.now() - (performance.now() - importStarted),
        writerMaxMs: sorted.at(-1)!,
        writerP99Ms: sorted[Math.floor(sorted.length * 0.99)]!
      }
    })

  layer(serverLayer(config), { excludeTestServices: true, timeout: "90 minutes" })("ST owner re-import shape", (it) => {
    it.effect("measures the atomic write, concurrent writer latency, RSS and staging growth", () =>
      Effect.gen(function* () {
        const api = yield* client()
        const root = tempDir("st-owner-shape")
        mkdirSync(join(root, "characters"), { recursive: true })
        mkdirSync(join(root, "chats/Alice"), { recursive: true })
        const file = join(root, "chats/Alice/Owner.jsonl")
        const content = (i: number, swipe: number) =>
          `Message ${i}, swipe ${swipe}. ` + "Synthetic coastal landscape. ".repeat(8)
        writeFileSync(join(root, "characters/Alice.png"), card("Alice", content(0, 0)))
        writeFileSync(file, JSON.stringify(header({})) + "\n")
        let versions = 0
        for (let offset = 0; offset < MESSAGES; offset += 100) {
          const lines = Array.from({ length: Math.min(100, MESSAGES - offset) }, (_, j) => {
            const i = offset + j
            const swipes = Array.from({ length: 20 + (i % 31) }, (_, swipe) => content(i, swipe))
            versions += swipes.length
            return JSON.stringify(
              message({
                name: i % 2 ? "Sam" : "Alice",
                user: i % 2 === 1,
                minute: i,
                mes: swipes[0]!,
                swipes,
                swipeId: 0
              })
            )
          })
          appendFileSync(file, lines.join("\n") + "\n")
        }
        const probe = yield* api.CreateChat({ title: "Writer probe" })
        // The first import, checked and confirmed: a new chat of every message.
        const seedStarted = performance.now()
        const first = yield* checkedImport(api, root, probe.id)
        const seedMs = performance.now() - seedStarted
        const chat = (yield* api.ListChats({ limit: 10, before: null })).find((c) => c.title === "Owner")!
        const [positions] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT id FROM slots WHERE chat_id = ? AND depth = ? ORDER BY id LIMIT 1",
              params: [chat.id, DEPTH]
            }
          ],
          { readOnly: true }
        )
        for (let i = 0; i < 200; i++)
          yield* api.CreateFork({
            chatId: chat.id,
            fromForkId: chat.currentForkId,
            atSlotId: positions![0]!.id as SlotId,
            name: `Independent ${i}`
          })
        assert.lengthOf(yield* api.ListForks({ chatId: chat.id }), 201)
        const [bases] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT s.depth, count(*) AS n FROM forks f JOIN slots s ON s.id = f.base_slot_id WHERE f.chat_id = ? GROUP BY s.depth",
              params: [chat.id]
            }
          ],
          { readOnly: true }
        )
        assert.isTrue(bases!.some((row) => row.depth === DEPTH && row.n === 200))
        // No current import creates forkPrior. Opt in to the persisted legacy marker to
        // measure the unplanned path too; this same-path variant needs no suffix copies.
        if (process.env.ST_REIMPORT_OWNER_FALLBACK === "1")
          yield* fixtureSql(config.dataDir, [
            {
              sql: "UPDATE jobs SET payload_json = json_set(payload_json, '$.forkPrior', json_extract(payload_json, '$.end')) WHERE kind = 'st-import-chat' AND json_extract(payload_json, '$.chatId') = ?",
              params: [chat.id]
            }
          ])
        appendFileSync(
          file,
          [MESSAGES, MESSAGES + 1, MESSAGES + 2]
            .map((i) =>
              JSON.stringify(
                message({
                  name: i % 2 ? "Sam" : "Alice",
                  user: i % 2 === 1,
                  minute: i,
                  mes: `New ${i}`
                })
              )
            )
            .join("\n")
        )
        let rssPeak = process.memoryUsage().rss
        const rssBefore = rssPeak
        const dbBytes = () =>
          [databaseFile(config.dataDir), databaseFile(config.dataDir) + "-wal"].reduce((sum, p) => {
            try {
              return sum + statSync(p).size
            } catch {
              return sum
            }
          }, 0)
        const dbBefore = dbBytes()
        let dbPeak = dbBefore
        const sampler = setInterval(() => {
          rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
          dbPeak = Math.max(dbPeak, dbBytes())
        }, 25)
        yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(sampler)))
        const again = yield* checkedImport(api, root, probe.id)
        assert.strictEqual(again.plan.files[0]!.counts.newMessages, 3)
        const after = yield* api.ReadPath({
          chatId: chat.id,
          forkId: chat.currentForkId,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 3
        })
        if (process.env.ST_REIMPORT_OWNER_FALLBACK === "1") {
          assert.isTrue(again.refusedUnplanned)
          assert.isTrue(after.entries.every((entry) => !entry.version.content.startsWith("New ")))
        } else
          assert.deepStrictEqual(
            after.entries.map((entry) => entry.version.content),
            [`New ${MESSAGES}`, `New ${MESSAGES + 1}`, `New ${MESSAGES + 2}`]
          )
        const measured = {
          loadAverage: loadavg(),
          fallback: process.env.ST_REIMPORT_OWNER_FALLBACK === "1",
          refusedUnplanned: again.refusedUnplanned,
          messages: MESSAGES,
          versions,
          forks: 201,
          forkDepth: DEPTH,
          fileBytes: statSync(file).size,
          seedMs,
          firstCheckMs: first.checkMs,
          firstImportMs: first.importMs,
          firstWriterMaxMs: first.writerMaxMs,
          firstWriterMaxAt: first.writerMaxAt,
          firstImportStartedAt: first.importStartedAt,
          firstWriterP99Ms: first.writerP99Ms,
          firstPeakStaged: first.peakStaged,
          checkMs: again.checkMs,
          reimportMs: again.importMs,
          rssBefore,
          rssPeak,
          rssGrowth: rssPeak - rssBefore,
          dbBefore,
          dbAfter: dbBytes(),
          dbPeak,
          peakStaged: again.peakStaged,
          writerProbes: again.writerProbes,
          writerMaxMs: again.writerMaxMs,
          writerMaxAt: again.writerMaxAt,
          importStartedAt: again.importStartedAt,
          writerP99Ms: again.writerP99Ms
        }
        console.log(JSON.stringify(measured))
        if (process.env.ST_REIMPORT_OWNER_OUT)
          writeFileSync(process.env.ST_REIMPORT_OWNER_OUT, JSON.stringify(measured, null, 2))
      })
    )
  })
}
