import { Worker } from "node:worker_threads"
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { SummaryId } from "@dreamspan/shared/lcm.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { migrationDefinitions } from "../src/db/migrations.ts"
import { testWorkers } from "./support/bundles.ts"
import { tempDir } from "./support/tempDir.ts"
import type { ReleaseSnapshot } from "./support/upgradeReleaseWorker.ts"

const snapshot = (file: string, seed: boolean) =>
  Effect.tryPromise(() => {
    const worker = new Worker(new URL("./support/upgradeReleaseWorker.ts", import.meta.url), {
      workerData: { file, seed }
    })
    return new Promise<ReleaseSnapshot>((resolve, reject) => {
      let result: ReleaseSnapshot | undefined
      worker.once("message", (value: ReleaseSnapshot) => (result = value))
      worker.once("error", reject)
      worker.once("exit", (code) =>
        code === 0 && result ? resolve(result) : reject(new Error(`Release fixture worker exited ${code}`))
      )
    })
  })

it.live("upgrades a populated release 0 database through the current writer and reads it back", () =>
  Effect.gen(function* () {
    const dataDir = tempDir("upgrade-release")
    const file = databaseFile(dataDir)
    const before = yield* snapshot(file, true)
    const currentLedger = Object.keys(migrationDefinitions)
      .map((key) => Number(key.split("_")[0]))
      .sort((a, b) => a - b)
    assert.deepStrictEqual(before.ledger, currentLedger.slice(0, before.ledger.length))
    assert.isBelow(before.ledger.length, currentLedger.length)
    assert.deepStrictEqual(before.integrity, ["ok"])
    assert.deepStrictEqual(before.foreignKeyErrors, [])
    assert.include(before.counts, { slots: 2997, versions: 3037, forks: 302, summaries: 3, bin_items: 2 })

    yield* Effect.gen(function* () {
      const reader = yield* Database.Reader
      const userId = "keeper" as UserId
      const chatId = "harbor" as ChatId
      const forkId = "harbor-fork-99" as ForkId
      const slotId = "harbor-899" as SlotId
      const chat = yield* reader.GetChat({ userId, chatId })
      assert.strictEqual(chat.title, "harbor")
      assert.strictEqual(chat.activeLeafSlotId, slotId)

      const forks = yield* reader.ListForks({ userId, chatId })
      assert.lengthOf(forks, 100)
      assert.strictEqual(forks.find((fork) => fork.id === forkId)?.name, "Alternate 99")
      const branches = yield* reader.ListBranches({ userId, slotId })
      assert.lengthOf(branches, 100)
      assert.strictEqual(branches.find((branch) => branch.slotId === slotId)?.preview, "Swipe 40")
      const path = yield* reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 3 })
      assert.deepStrictEqual(
        path.entries.map(({ version }) => version.content),
        ["Message at harbor-897", "Message at harbor-898", "Message at harbor-fork-99-reply"]
      )
      const swipes = yield* reader.ListVersions({ userId, slotId })
      assert.deepStrictEqual(
        swipes.map((version) => version.content),
        ["Message at harbor-899", ...Array.from({ length: 40 }, (_, i) => `Swipe ${i + 1}`)]
      )
      const summary = yield* reader.GetSummary({ userId, summaryId: "harbor-summary" as typeof SummaryId.Type })
      assert.strictEqual(summary.content, "The group reached the gate.")
      const queued = yield* reader.ListQueued({ userId, chatId })
      assert.deepStrictEqual(
        queued.map(({ content }) => content),
        ["Search the map."]
      )

      for (const kind of ["card", "lorebook", "preset"] as const) {
        const refId = `${kind}-ref` as RefId
        const refs = yield* reader.ListLibrary({ userId, kind, tag: null, archived: false })
        assert.deepStrictEqual(
          refs.map((ref) => ref.id),
          [refId]
        )
        const { ref, doc } = yield* reader.GetRef({ userId, refId })
        assert.strictEqual(ref.label, `Fixture ${kind}`)
        assert.strictEqual(doc.schema_version, 1)
      }

      const bin = yield* reader.ListBin({ userId, limit: 5, before: null })
      assert.sameMembers(
        bin.map(({ id }) => id),
        ["old-logs-bin", "old-sketches-bin"]
      )
      const files = yield* reader.ListFileVersions({ userId, path: "maps/map.txt", limit: 5 })
      assert.lengthOf(files, 1)
      assert.include(files[0], { id: "map-first", byteSize: 16, hasContent: true })
      assert.include(yield* reader.GetDisplayPrefs({ userId }), { enterSends: "never", coverageRail: true })
      assert.include(yield* reader.GetDisplayPrefs({ userId: "reader" as UserId }), {
        enterSends: "always",
        coverageRail: true
      })
    }).pipe(Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })))

    const after = yield* snapshot(file, false)
    assert.deepStrictEqual(after.ledger, currentLedger)
    assert.deepStrictEqual(after.integrity, ["ok"])
    assert.deepStrictEqual(after.foreignKeyErrors, [])
    for (const [name, count] of Object.entries(before.counts)) assert.strictEqual(after.counts[name], count, name)
  })
)
