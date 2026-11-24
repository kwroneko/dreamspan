// One imported chat at the owner's upper shape, exercised through real WebSocket RPCs
// and the server's writer/reader workers. Synthetic data only. See bigchat.md's method.
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BroadcastChannel, Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { ShellForks } from "@dreamspan/shared/chatSetupApi.ts"
import { applyShellForks } from "@dreamspan/shared/shellUpdates.ts"
import { Effect, Stream } from "effect"
import { StImports } from "../src/importer/StImports.ts"
import * as Fake from "../src/dev/fakeGenerator.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { card, writeStBranchFamily } from "./support/stFolder.ts"
import { tempDir } from "./support/tempDir.ts"

const out = process.env.BIGCHAT_OUT
// Re-run live measurements against this harness's own worker-backed snapshots.
const reuse = process.env.BIGCHAT_REUSE
const previous: Array<{
  size: number
  bytes: number
  lines: number
  slots: number
  versions: number
  importMs: number
  fileTimes: Array<{ path: string; ms: number }>
}> = reuse
  ? readFileSync(reuse + ".jsonl", "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
  : []
const sizes = (process.env.BIGCHAT_SIZES ?? "0.25,0.5,1").split(",").map(Number)
for (const size of sizes) {
  const branches = Math.round(400 * size)
  const messages = Math.round(3000 * size)
  it.live(
    `import and live operations at ${size} of 400 branches / 3000 messages / 40 swipes`,
    () => {
      const root = tempDir("bigchat-input")
      const config = testConfig({ dbReaders: 2 })
      const restored = previous.find((row) => row.size === size)
      if (reuse && !restored) throw new Error(`No synthetic snapshot measurements for ${size}`)
      if (reuse) copyFileSync(`${reuse}-${size}.db`, join(config.dataDir, "dreamspan.db"))
      const fixture = restored
        ? {
            bytes: restored.bytes,
            messageLines: restored.lines,
            uniqueMessages: restored.slots,
            uniqueVersions: restored.versions
          }
        : writeStBranchFamily(root, {
            branches,
            messages,
            swipes: 40,
            swipeShare: 0.6,
            bodyRepeats: 1,
            seed: 12345
          })
      mkdirSync(join(root, "characters"), { recursive: true })
      writeFileSync(join(root, "characters/Alice.png"), card("Alice", "Hello."))
      const result: Record<string, unknown> = {
        size,
        branches,
        longestPath: messages,
        bytes: fixture.bytes,
        lines: fixture.messageLines,
        slots: fixture.uniqueMessages,
        versions: fixture.uniqueVersions,
        ...(reuse ? { reused: reuse } : {})
      }
      return Effect.gen(function* () {
        const api = yield* client()
        if (restored) {
          result.importMs = restored.importMs
          result.fileTimes = restored.fileTimes
        } else {
          const imports = yield* StImports
          const builtin = imports.handlers.get("chat")!
          const fileTimes: Array<{ path: string; ms: number }> = []
          let fileStart = 0
          yield* imports.handlers.register({
            id: "chat",
            run: (call) =>
              Effect.gen(function* () {
                if (call.request.part === 0) fileStart = performance.now()
                const answer = yield* builtin.run(call)
                if (call.request.last) {
                  fileTimes.push({ path: call.path, ms: performance.now() - fileStart })
                  if (fileTimes.length % 25 === 0)
                    console.log("BIGCHAT_PROGRESS", size, fileTimes.length, fileTimes.at(-1)!.ms)
                }
                return answer
              })
          })
          const started = performance.now()
          const { importId } = yield* api.StartStPathImport({ path: root, prefix: "" })
          for (;;) {
            const detail = yield* api.GetStImport({ importId })
            if (detail.job.status !== "running") {
              assert.strictEqual(detail.job.status, "complete")
              assert.strictEqual(detail.report!.counts.chat?.failed, 0)
              assert.strictEqual(detail.report!.messages, fixture.messageLines)
              break
            }
            yield* Effect.sleep(100)
          }
          result.importMs = performance.now() - started
          result.fileTimes = fileTimes
        }
        const profile = (phase: string) => {
          const channel = new BroadcastChannel("bigchat-profile")
          channel.postMessage(`${size}-${phase}`)
          channel.close()
        }
        profile("import")
        const [counts] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: `SELECT
        (SELECT count(*) FROM slots) AS slots, (SELECT count(*) FROM versions) AS versions,
        (SELECT count(*) FROM chats) AS chats, (SELECT count(*) FROM forks) AS forks`
            }
          ],
          { readOnly: true }
        )
        assert.strictEqual(counts![0]!.chats, 1)
        if (!restored) {
          assert.strictEqual(counts![0]!.slots, fixture.uniqueMessages)
          assert.strictEqual(counts![0]!.versions, fixture.uniqueVersions)
          assert.strictEqual(counts![0]!.forks, branches + 1)
        }
        // Free the physical duplicate prefixes before measuring live work.
        rmSync(root, { recursive: true, force: true })
        const samples: Array<{ operation: string; ms: number; refreshMs: number; visibleMs?: number }> = []
        const view = {
          entity: null,
          chat: null,
          search: "",
          sort: "recent" as const,
          sections: [{ id: "chats" as const, limit: 1000 }]
        }
        const refresh = Effect.gen(function* () {
          yield* api.GetShellCards()
          yield* api.GetShellForks(view)
          yield* api.GetShellLibrary()
        })
        const measure = <A, E, R>(operation: string, action: Effect.Effect<A, E, R>, visible?: () => number | null) =>
          Effect.gen(function* () {
            const start = performance.now()
            const answer = yield* action
            const ms = performance.now() - start
            if (visible) yield* eventually(() => visible() !== null)
            const visibleMs = visible ? visible()! - start : undefined
            const refreshStart = performance.now()
            yield* refresh
            const sample = {
              operation,
              ms,
              refreshMs: performance.now() - refreshStart,
              ...(visibleMs === undefined ? {} : { visibleMs })
            }
            samples.push(sample)
            console.log("BIGCHAT_LIVE", size, JSON.stringify(sample))
            return answer
          })
        const shell = yield* api.GetShellLibrary()
        const chatId = shell.forks[0]!.chat.id as ChatId
        const chat = yield* api.GetChat({ chatId })
        const main = (
          restored
            ? shell.forks.find((fork) => !fork.original && fork.messages >= messages)!.forkId
            : chat.currentForkId!
        ) as ForkId
        let visibleRows: ShellForks | undefined
        let visibleAt = 0
        yield* api.WatchShellForks(view).pipe(
          Stream.runForEach((update) =>
            Effect.sync(() => {
              visibleRows = applyShellForks(visibleRows, update)
              visibleAt = performance.now()
            })
          ),
          Effect.forkScoped
        )
        yield* api.WatchShellCards().pipe(Stream.runDrain, Effect.forkScoped)
        const visibleFork = () => visibleRows?.sections[0]?.rows[0]?.forkId
        yield* eventually(() => visibleRows !== undefined)
        const path = (forkId = main, leafSlotId: SlotId | null = null) =>
          api.ReadPath({ chatId, forkId, leafSlotId, range: { _tag: "Bottom" }, limit: 100 })
        const [ids] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT id FROM slots WHERE chat_id = ? AND depth = 20 ORDER BY created_at LIMIT 1",
              params: [chatId]
            }
          ],
          { readOnly: true }
        )
        const old = ids![0]!.id as SlotId
        const events: Array<ChatEvent> = []
        yield* api.SubscribeChat({ chatId }).pipe(
          Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
          Effect.forkScoped
        )
        yield* eventually(() => events.length > 0)
        for (let repeat = 0; repeat < 3; repeat++) {
          yield* measure(
            "open",
            Effect.gen(function* () {
              yield* api.GetChat({ chatId })
              yield* api.ListForks({ chatId })
              yield* path()
              yield* api.GetCast({ chatId, forkId: main, slotId: null })
            })
          )
          const oldPage = yield* measure(
            "old-page",
            api.ReadPath({ chatId, forkId: main, leafSlotId: null, range: { _tag: "Around", slot: old }, limit: 100 })
          )
          assert.isTrue(oldPage.entries.some((e) => e.slotId === old))
          const current = yield* path()
          const sent = yield* measure(
            "send",
            posted(
              api.SendMessage({
                chatId,
                forkId: main,
                parentSlotId: current.leafSlotId,
                branch: false,
                content: `Synthetic live send ${repeat}.`,
                reply: false
              })
            )
          )
          yield* measure(
            "generate-complete",
            Effect.gen(function* () {
              const generated = yield* posted(
                api.Generate({ chatId, forkId: main, parentSlotId: sent.entry.slotId, branch: false })
              )
              yield* eventually(() => finished(events, generated.entry.version.id)?.status === "complete", 120_000)
            })
          )
          const swiped = oldPage.entries.find((e) => e.versionCount > 1)!
          assert.isDefined(swiped)
          yield* measure(
            "swipe",
            Effect.gen(function* () {
              const versions = yield* api.ListVersions({ slotId: swiped.slotId, forkId: main })
              return yield* api.SelectVersion({
                slotId: swiped.slotId,
                forkId: main,
                versionId: versions.find((v) => v.id !== swiped.version.id)!.id,
                expectedVersionId: swiped.version.id
              })
            })
          )
          const forked = yield* measure("fork-old", api.CreateFork({ chatId, fromForkId: main, atSlotId: old }))
          yield* measure("switch-branch", path(forked.fork.id))
          const atOld = (yield* api.ReadPath({
            chatId,
            forkId: main,
            leafSlotId: null,
            range: { _tag: "Around", slot: old },
            limit: 10
          })).entries.find((e) => e.slotId === old)!
          yield* eventually(() => visibleFork() === forked.fork.id)
          const edited = yield* measure(
            "edit-old",
            api.EditVersion({
              slotId: old,
              forkId: main,
              sourceVersionId: atOld.version.id,
              expectedRowVersion: atOld.rowVersion,
              content: `Synthetic live edit ${repeat}.`
            }),
            () => (visibleFork() === main ? visibleAt : null)
          )
          yield* measure(
            "amend-old",
            api.AmendVersion({
              versionId: edited.version.id,
              forkId: main,
              content: `Synthetic live amendment ${repeat}.`,
              expectedRowVersion: edited.version.rowVersion
            })
          )
        }
        result.samples = samples
        // Full-size edit-to-stream samples were 198–343 ms. Across all three sizes
        // the shared-host peaks were 698 ms to the stream and 1,073 ms through the
        // forced reads; amendments peaked at 846 ms. Leave headroom for host load,
        // while catching the former tens-of-seconds whole-chat recomputation.
        const edits = samples.filter((sample) => sample.operation === "edit-old")
        assert.isBelow(Math.max(...edits.map((sample) => sample.visibleMs!)), 1000)
        assert.isBelow(
          Math.max(...edits.map((sample) => Math.max(sample.ms, sample.visibleMs!) + sample.refreshMs)),
          1500
        )
        const amendments = samples.filter((sample) => sample.operation === "amend-old")
        assert.isBelow(Math.max(...amendments.map((sample) => sample.ms + sample.refreshMs)), 1500)
        // A single changed view reads its own paths; the first send must not scan the
        // whole growing chat merely because that fork still has no version overrides.
        assert.isBelow(
          samples.find((sample) => sample.operation === "send")!.refreshMs,
          Math.min(2000, 2000 * size + 1000)
        )
        profile("live")
        // A reusable synthetic DB for SQL-plan/VM-step investigation; copied by SQLite in a worker.
        if (out) {
          const destination = `${out}-${size}.db`
          appendFileSync(out + ".jsonl", JSON.stringify(result) + "\n")
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                const worker = new Worker(
                  `
            const { DatabaseSync, backup } = require('node:sqlite')
            const { workerData } = require('node:worker_threads')
            const db = new DatabaseSync(workerData.source, { readOnly: true })
            backup(db, workerData.destination).then(() => db.close())
          `,
                  { eval: true, workerData: { source: join(config.dataDir, "dreamspan.db"), destination } }
                )
                worker.once("error", reject)
                worker.once("exit", (code) =>
                  code === 0 ? resolve() : reject(new Error(`backup worker exited ${code}`))
                )
              })
          )
        }
        console.log("BIGCHAT_RESULT", JSON.stringify(result))
      }).pipe(Effect.provide(serverLayer(config, Fake.layer({ tokens: 20, tokensPerSecond: 10000 }))), Effect.scoped)
    },
    3_600_000
  )
}
