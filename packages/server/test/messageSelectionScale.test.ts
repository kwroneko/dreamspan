// A multi-delete at the owner's scale (job msgactions1): 3,000 messages, 300 branches sharing the
// main fork's history, 20–50 swipes on most messages. Deleting 1,000 messages, at the branch's end
// and in its shared middle, and their Undo, then hiding and showing them (selecthide1), each one
// writer transaction. Synthetic data only.
// Run: env VITEST_MAX_WORKERS=1 npx vitest run --project server-slow \
//   packages/server/test/messageSelectionScale.test.ts
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import type { ForkId, SlotId } from "@rp/shared/chat.ts"
import { newChatNote } from "@rp/shared/editing.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { testConfig } from "./support/config.ts"
import { lcmHarness, lcmServer } from "./support/lcmHarness.ts"
import { tempDir } from "./support/tempDir.ts"

const MESSAGES = 3000
const BRANCHES = 300
const RANGE = 1000

it.live(
  `deleting ${RANGE} of ${MESSAGES} messages with ${BRANCHES} branches, and Undo`,
  () => {
    const config = testConfig({ dbReaders: 2 })
    const server = lcmServer(config)
    return Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 0, settings: { spendAhead: false } })
      const reader = yield* Reader
      const writer = yield* Writer
      const userId = h.userId
      const chatId = h.chat.id
      const main = h.chat.currentForkId! as ForkId
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
      const work = tempDir("multidelete-fixture")
      const fixture = yield* Effect.promise(
        () =>
          new Promise<{ main: ReadonlyArray<{ id: string }> }>((resolve, reject) => {
            const worker = new Worker(new URL("./support/forkCostFixtureWorker.ts", import.meta.url), {
              workerData: {
                dbPath: databaseFile(config.dataDir),
                root: join(work, "input"),
                chatId,
                messages: MESSAGES,
                branches: BRANCHES,
                note: note.ref.entityId,
                revision: note.ref.headRevisionId
              }
            })
            let result: { main: ReadonlyArray<{ id: string }> } | undefined
            worker.once("message", (r: typeof result) => void (result = r))
            worker.once("error", reject)
            worker.once("exit", (code) =>
              code === 0 && result ? resolve(result) : reject(new Error(`fixture worker exited ${code}`))
            )
          })
      )
      const window = (leafSlotId: SlotId | null) =>
        Effect.gen(function* () {
          const last = yield* reader.GetPath({ userId, chatId, forkId: main, leafSlotId, limit: 1000 })
          const older =
            last.olderLeafSlotId === null
              ? []
              : (yield* reader.GetPath({
                  userId,
                  chatId,
                  forkId: main,
                  leafSlotId: last.olderLeafSlotId,
                  limit: 1000
                })).entries
          return [...older, ...last.entries].map((e) => e.slotId)
        })
      const timed = <A, E, R>(label: string, action: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const start = performance.now()
          const answer = yield* action
          const ms = performance.now() - start
          console.log("MULTIDELETE_SAMPLE", label, Math.round(ms))
          return { answer, ms }
        })
      // The branch's last 1,000, then 1,000 in the middle that the branches share.
      const middleLeaf = fixture.main[Math.floor(fixture.main.length * 0.75)]!.id as SlotId
      for (const [label, leaf] of [
        ["end", null],
        ["middle", middleLeaf]
      ] as const) {
        const shown = yield* window(leaf)
        // Two pages leave room around the range (the fixture deletes a few messages on the way).
        assert.isAtLeast(shown.length, RANGE + 201)
        const from = leaf === null ? shown.length - RANGE : 200
        const slotIds = shown.slice(from, from + RANGE)
        const deleted = yield* timed(
          `DeleteMessages-${label}`,
          writer.DeleteMessages({ userId, forkId: main, slotIds })
        )
        assert.strictEqual(deleted.answer.length, RANGE)
        const after = yield* window(leaf === null ? null : leaf)
        const gone = new Set(slotIds)
        assert.isFalse(after.some((id) => gone.has(id)))
        // What was before the range now runs straight on to what came after it.
        const kept = after.indexOf(shown[from - 1]!)
        assert.isAtLeast(kept, 0)
        // At the end, the tip went up to it.
        assert.strictEqual(after[kept + 1], shown[from + RANGE])
        if (leaf === null) assert.strictEqual(after.at(-1), shown[from - 1])
        const restored = yield* timed(
          `RestoreBinItems-${label}`,
          writer.RestoreBinItems({ userId, itemIds: deleted.answer.map((item) => item.id) })
        )
        assert.strictEqual(restored.answer.length, RANGE)
        assert.deepStrictEqual(yield* window(leaf), shown)
        // Bounded: one writer transaction each, well under the writer's patience on a busy host.
        assert.isBelow(deleted.ms, 30_000)
        assert.isBelow(restored.ms, 30_000)
        // Hide from the model, then Show (job selecthide1): one writer transaction each. The fixture
        // hid some messages already: those don't change, and stay hidden after the Show.
        const range = new Set<string>(slotIds)
        const hiddenInRange = () =>
          Effect.gen(function* () {
            const page = yield* reader.GetPath({
              userId,
              chatId,
              forkId: main,
              leafSlotId: slotIds.at(-1)!,
              limit: RANGE
            })
            // One page: inserted messages can push the range's first few into the page before.
            const seen = page.entries.filter((e) => range.has(e.slotId))
            return { seen: seen.length, hidden: seen.filter((e) => e.contextExcluded).map((e) => e.slotId) }
          })
        const before = yield* hiddenInRange()
        const hidden = yield* timed(
          `SetSlotsHidden-${label}`,
          writer.SetSlotsHidden({ userId, forkId: main, slotIds, hidden: true })
        )
        assert.isAtMost(hidden.answer.changed.length, RANGE - before.hidden.length)
        assert.isAtLeast(hidden.answer.changed.length, before.seen - before.hidden.length)
        const hiddenAfter = yield* hiddenInRange()
        assert.strictEqual(hiddenAfter.hidden.length, hiddenAfter.seen)
        const shownAgain = yield* timed(
          `SetSlotsShown-${label}`,
          writer.SetSlotsHidden({ userId, forkId: main, slotIds: hidden.answer.changed, hidden: false })
        )
        assert.strictEqual(shownAgain.answer.changed.length, hidden.answer.changed.length)
        assert.deepStrictEqual(yield* hiddenInRange(), before)
        assert.isBelow(hidden.ms, 30_000)
        assert.isBelow(shownAgain.ms, 30_000)
      }
    }).pipe(Effect.provide(server.layer), Effect.scoped)
  },
  1_800_000
)
