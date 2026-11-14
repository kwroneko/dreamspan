// The re-import preview (ARCHITECTURE.md §13 "Re-import preview") on a folder shaped like a
// long-running ST chat: a main file and many branch files of it and of each other, each with a
// long shared prefix and swipe-heavy replies (support/stFolder.ts `writeStBranchFamily`, only
// synthetic text). Imported once, then previewed again with the main file grown by a few
// messages: every message of every file goes through the matcher, which is the preview's
// worst case, as it is the re-import's (ARCHITECTURE.md §13: re-imports use the original
// matching path). Measures the preview's time and the process's resident memory while it
// runs (the database workers are threads of this process), then the re-import's time. ST_PLAN_SCALE_BRANCHES and
// ST_PLAN_SCALE_MESSAGES size it; ST_PLAN_SCALE_OUT writes the measurements as JSON.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assert, layer } from "@effect/vitest"
import { ST_CHANGED_SINCE_CHECK } from "@rp/shared/stReimportPlan.ts"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, message, writeStBranchFamily } from "./support/stFolder.ts"
import { importStPath, jobEnded } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

const BRANCHES = Number(process.env.ST_PLAN_SCALE_BRANCHES ?? 60)
const MESSAGES = Number(process.env.ST_PLAN_SCALE_MESSAGES ?? 1000)
const PREFIX = "ST/data/default-user/"
const MB = 1024 * 1024

layer(serverLayer(testConfig({ dbReaders: 2 })), { excludeTestServices: true, timeout: "60 minutes" })(
  "ST re-import preview at scale",
  (it) => {
    it.effect(
      "previews a large folder already imported, every message matched, in bounded memory",
      () =>
        Effect.gen(function* () {
          const api = yield* client()
          const root = tempDir("st-plan-scale")
          const user = join(root, PREFIX)
          const family = writeStBranchFamily(user, { branches: BRANCHES, messages: MESSAGES, bodyRepeats: 4 })
          mkdirSync(join(user, "characters"), { recursive: true })
          writeFileSync(join(user, "characters/Alice.png"), card("Alice", "A synthetic greeting."))
          const importStarted = Date.now()
          const first = yield* importStPath(api, root, PREFIX)
          const importMs = Date.now() - importStarted
          assert.strictEqual(first.job.status, "complete")
          // In ST since: three messages more at the end of the main file.
          const main = family.files[0]!
          appendFileSync(
            join(user, main.path),
            "\n" +
              [MESSAGES, MESSAGES + 1, MESSAGES + 2]
                .map((i) =>
                  JSON.stringify(
                    message({ name: i % 2 ? "Sam" : "Alice", user: i % 2 === 1, mes: `Later message ${i}.`, minute: i })
                  )
                )
                .join("\n")
          )

          const chat = (yield* api.ListChats({ limit: 10, before: null }))[0]!
          global.gc?.()
          const before = process.memoryUsage().rss
          let peak = before
          const sampler = setInterval(() => {
            peak = Math.max(peak, process.memoryUsage().rss)
          }, 50)
          const started = Date.now()
          const { plan } = yield* api.StartStImportPlan({ folder: { root, prefix: PREFIX } })
          // A real user-message write and foreground read while the check is running.
          const sendStarted = Date.now()
          yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: chat.activeLeafSlotId,
            branch: false,
            content: "A synthetic message sent during the check."
          })
          const sendMs = Date.now() - sendStarted
          const readStarted = Date.now()
          yield* api.GetChat({ chatId: chat.id })
          const readMs = Date.now() - readStarted
          let done = plan
          for (;;) {
            done = yield* api.GetStImportPlan({ planId: plan.planId })
            if (done.status !== "running") break
            yield* Effect.sleep(100)
          }
          const planMs = Date.now() - started
          clearInterval(sampler)
          const planPeak = peak
          // The message sent during the check changed the chat: that check can't be imported.
          const during = yield* api
            .StartStPathImport({ path: root, prefix: PREFIX, plan: { planId: plan.planId, skip: [] } })
            .pipe(Effect.flip)
          assert.strictEqual(during._tag, "StImportPlanChanged")
          const check = Effect.gen(function* () {
            const { plan: started } = yield* api.StartStImportPlan({ folder: { root, prefix: PREFIX } })
            for (;;) {
              const read = yield* api.GetStImportPlan({ planId: started.planId })
              if (read.status !== "running") return read
              yield* Effect.sleep(100)
            }
          })
          // A message sent after a check: every file of the chat is refused, nothing written.
          const earlier = yield* check
          const leaf = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId
          yield* api.SendMessage({ chatId: chat.id, parentSlotId: leaf, branch: false, content: "Sent after the check." })
          const staleStarted = Date.now()
          const stale = yield* jobEnded(
            api,
            (yield* api.StartStPathImport({ path: root, prefix: PREFIX, plan: { planId: earlier.planId, skip: [] } }))
              .importId,
            60 * 60_000
          )
          const staleMs = Date.now() - staleStarted
          assert.strictEqual(
            (stale.report?.issues ?? []).filter((issue) => issue.code === ST_CHANGED_SINCE_CHECK).length,
            family.files.length
          )
          done = yield* check
          // The import the preview was for, of the same folder: it matches every message too.
          const reimportStarted = Date.now()
          const { importId } = yield* api.StartStPathImport({
            path: root,
            prefix: PREFIX,
            plan: { planId: done.planId, skip: [] }
          })
          const again = yield* jobEnded(api, importId, 60 * 60_000)
          const reimportMs = Date.now() - reimportStarted
          assert.strictEqual(again.job.status, "complete")
          assert.deepStrictEqual(
            (again.report?.issues ?? []).filter((issue) => issue.code === ST_CHANGED_SINCE_CHECK),
            []
          )
          // The same folder again without a check, every message matched as before: what a
          // re-import costs when nothing holds it to a check.
          const plainStarted = Date.now()
          const plain = yield* jobEnded(
            api,
            (yield* api.StartStPathImport({ path: root, prefix: PREFIX })).importId,
            60 * 60_000
          )
          const plainReimportMs = Date.now() - plainStarted
          assert.strictEqual(plain.job.status, "complete")
          const measured = {
            files: family.files.length,
            folderMB: Math.round(family.bytes / MB),
            messageLines: family.messageLines + 3,
            uniqueMessages: family.uniqueMessages,
            uniqueVersions: family.uniqueVersions,
            importMs,
            planMs,
            sendMs,
            readMs,
            reimportMs,
            staleMs,
            plainReimportMs,
            rssBeforeMB: Math.round(before / MB),
            rssPeakMB: Math.round(planPeak / MB),
            rssGrowthMB: Math.round((planPeak - before) / MB)
          }
          console.log("st re-import preview at scale", JSON.stringify(measured))
          if (process.env.ST_PLAN_SCALE_OUT)
            writeFileSync(process.env.ST_PLAN_SCALE_OUT, JSON.stringify(measured, null, 1))

          assert.strictEqual(done.status, "done")
          assert.strictEqual(done.files.length, family.files.length)
          const byPath = new Map(done.files.map((file) => [file.path, file]))
          const mainPlan = byPath.get(main.path)!
          assert.strictEqual(mainPlan.counts.newMessages, 3)
          assert.strictEqual(mainPlan.counts.unchanged, MESSAGES)
          for (const file of done.files.slice(1)) {
            assert.strictEqual(file.status, "done", file.path)
            assert.strictEqual(file.counts.newMessages + file.counts.newSwipes + file.counts.selected, 0, file.path)
            assert.strictEqual(file.counts.unchanged, MESSAGES, file.path)
          }
          // One part of a file at a time, and changed messages held up to a bound: memory
          // doesn't grow with the folder.
          assert.isBelow(measured.rssGrowthMB, 1024)
        }),
      { timeout: 60 * 60_000 }
    )
  }
)
