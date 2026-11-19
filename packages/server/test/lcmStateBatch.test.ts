import type { AppendResult } from "../src/db/ops.ts"
// Cold state reads with insertions retain the independent summary proof while batching facts.
import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import type { LcmState } from "@dreamspan/shared/lcm.ts"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { completeFixture } from "./support/lcmFixtures.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

it.live("a cold inserted path batches its summaries and refreshes after a branch edit", () => {
  const dataDir = tempDir("lcm-state-batch")
  return Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const userId = (yield* writer.EnsureUser({ handle: "synthetic", displayName: "Synthetic" })).id
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Synthetic",
      participants: [],
      greeting: null
    })
    const forkId = chat.currentForkId!
    const entries: Array<AppendResult> = []
    let parent = null
    for (let n = 0; n < 12; n++) {
      const made: AppendResult = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        forkId,
        parentSlotId: parent,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: `Synthetic ${n}`,
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      entries.push(made)
      parent = made.slotId
    }
    const inserted = yield* writer.InsertMessage({
      userId,
      chatId: chat.id,
      forkId,
      anchorSlotId: entries[0]!.slotId,
      expectedRowVersion: entries[0]!.version.rowVersion,
      body: { _tag: "Write", speaker: null, content: "Inserted synthetic" }
    })
    const path = yield* reader.GetPath({ userId, chatId: chat.id, forkId, leafSlotId: null, limit: 100 })
    assert.isTrue(path.entries.some((e) => e.slotId === inserted.slotId))
    for (const entry of path.entries.slice(0, -1))
      yield* completeFixture(dataDir, writer, userId, chat.id, [
        { slotId: entry.slotId, versionId: entry.version.id, amendCount: 0 }
      ])
    const payload = { userId, chatId: chat.id, forkId, leafSlotId: parent! }
    const probe = () =>
      Effect.promise(
        () =>
          new Promise<{ state: LcmState; inputReads: number }>((resolve, reject) => {
            const worker = new Worker(new URL("./support/lcmStateProbeWorker.ts", import.meta.url), {
              workerData: { file: databaseFile(dataDir), payload }
            })
            let result: { state: LcmState; inputReads: number } | undefined
            worker.once("message", (value) => {
              result = value
            })
            worker.once("error", reject)
            worker.once("exit", (code) =>
              code === 0 && result ? resolve(result) : reject(new Error(`state probe exited ${code}`))
            )
          })
      )
    const before = yield* probe()
    assert.lengthOf(before.state.layer, 12)
    assert.isAtMost(before.inputReads, 1, "one input batch, including summaries ending at an inserted slot")
    const sibling = (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: forkId, atSlotId: parent })).fork
      .id
    const other = yield* reader.GetLcmState({ ...payload, forkId: sibling })
    const entry = yield* reader.GetSlot({ userId, slotId: entries[1]!.slotId, forkId })
    yield* writer.AmendVersion({
      userId,
      forkId,
      versionId: entry.entry.version.id,
      expectedRowVersion: entry.entry.version.rowVersion,
      content: "Changed only here"
    })
    const after = yield* probe()
    assert.isTrue(before.state.layer.every((s) => s.fresh))
    assert.isFalse(after.state.layer.find((s) => s.firstSlotId === entries[1]!.slotId)!.fresh)
    assert.deepStrictEqual(yield* reader.GetLcmState({ ...payload, forkId: sibling }), other)
    for (const row of after.state.layer) {
      const independent = yield* reader.GetSummary({ userId, summaryId: row.id, forkId })
      assert.strictEqual(row.fresh, independent.fresh)
      assert.strictEqual(row.content, independent.content)
      assert.strictEqual(row.from, independent.from)
      assert.strictEqual(row.to, independent.to)
    }
  }).pipe(Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })), Effect.scoped)
})
