// One long swipe-heavy file in a chat with hundreds of independent forks. Synthetic only.
// Opt in: this writes hundreds of thousands of versions, so routine slow gates keep it off.
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assert, it as plain, layer } from "@effect/vitest"
import { ST_CHANGED_SINCE_CHECK } from "@rp/shared/stReimportPlan.ts"
import { Effect, Fiber } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { card, header, message } from "./support/stFolder.ts"
import { importStPath, jobEnded } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

if (process.env.ST_REIMPORT_OWNER_SCALE !== "1") {
  plain.skip("20,000 messages with 20–50 swipes and 200 forks (ST_REIMPORT_OWNER_SCALE=1)", () => {})
} else {
  const config = testConfig({ dbReaders: 2 })
  layer(serverLayer(config), { excludeTestServices: true, timeout: "60 minutes" })("ST owner re-import shape", (it) => {
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
        for (let offset = 0; offset < 20_000; offset += 100) {
          const lines = Array.from({ length: 100 }, (_, j) => {
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
        const seedStarted = performance.now()
        const first = yield* importStPath(api, root)
        assert.strictEqual(first.job.status, "complete")
        const seedMs = performance.now() - seedStarted
        const chat = (yield* api.ListChats({ limit: 10, before: null }))[0]!
        const [positions] = yield* fixtureSql(
          config.dataDir,
          [{ sql: "SELECT id FROM slots WHERE chat_id = ? AND depth = 2 ORDER BY id LIMIT 1", params: [chat.id] }],
          { readOnly: true }
        )
        for (let i = 0; i < 200; i++)
          yield* api.CreateFork({
            chatId: chat.id,
            fromForkId: chat.currentForkId,
            atSlotId: positions![0]!.id as import("@rp/shared/chat.ts").SlotId,
            name: `Independent ${i}`
          })
        assert.lengthOf(yield* api.ListForks({ chatId: chat.id }), 201)
        appendFileSync(
          file,
          [20_000, 20_001, 20_002]
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
        const checkStarted = performance.now()
        const { plan } = yield* api.StartStImportPlan({ folder: { root, prefix: "" } })
        let done = plan
        while (done.status === "running") {
          yield* Effect.sleep(100)
          done = yield* api.GetStImportPlan({ planId: plan.planId })
        }
        assert.strictEqual(done.status, "done")
        assert.strictEqual(done.files[0]!.counts.newMessages, 3)
        const checkMs = performance.now() - checkStarted
        const probe = yield* api.CreateChat({ title: "Writer probe" })
        const samples: number[] = []
        let stop = false
        const probes = yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (!stop) {
              const before = performance.now()
              yield* api.RenameChat({ chatId: probe.id, name: `Writer probe ${samples.length}` })
              samples.push(performance.now() - before)
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
        const reimportMs = performance.now() - importStarted
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
        const measured = {
          messages: 20_000,
          versions,
          forks: 201,
          fileBytes: statSync(file).size,
          seedMs,
          checkMs,
          reimportMs,
          rssBefore,
          rssPeak,
          rssGrowth: rssPeak - rssBefore,
          dbBefore,
          dbAfter: dbBytes(),
          dbPeak,
          peakStaged,
          writerProbes: samples.length,
          writerMaxMs: Math.max(...samples),
          writerP99Ms: samples.sort((a, b) => a - b)[Math.floor(samples.length * 0.99)]
        }
        console.log(JSON.stringify(measured))
        if (process.env.ST_REIMPORT_OWNER_OUT)
          writeFileSync(process.env.ST_REIMPORT_OWNER_OUT, JSON.stringify(measured, null, 2))
        // Every file is still a single transaction, with no partial writes to reduce latency.
        assert.isAbove(samples.length, 0)
        yield* jobEnded(api, importId)
      })
    )
  })
}
