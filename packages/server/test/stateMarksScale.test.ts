// The change markers' read at the owner's scale: a 5,000-message path among hundreds of
// branches (the fork-cost fixture: 20–50 swipes, dense overrides, insertions and events) with
// 400 more state changes along the main path. What opening the timeline reads before
// (its window, the away marks) and with the markers' read, each timed. Synthetic data only.
// Run: env VITEST_MAX_WORKERS=1 npx vitest run --project server-slow
//   packages/server/test/stateMarksScale.test.ts
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import type { ForkId, SlotId } from "@rp/shared/chat.ts"
import { newChatNote } from "@rp/shared/editing.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { client, testConfig } from "./support/config.ts"
import { lcmHarness, lcmServer } from "./support/lcmHarness.ts"
import { tempDir } from "./support/tempDir.ts"

interface Fixture {
  slots: number
  events: number
  main: Array<{ id: string }>
}
const KEYS = [
  "participant.join",
  "participant.leave",
  "played_by_me.set",
  "cast.role",
  "presence.set",
  "note.activate",
  "note.deactivate",
  "model.binding",
  "model.unbind",
  "preset.binding",
  "preset.unbind",
  "preset_overlay.binding",
  "lorebook.attach",
  "lorebook.detach",
  "lorebook.remove",
  "lorebook.embedded",
  "context.per_speaker",
  "cards.rotation",
  "agent.enabled",
  "roles.projection",
  "merge.layout",
  "context.html_depth",
  "lorebook.below_history",
  "reply.order",
  "reply.single"
]
const MESSAGES = 5000
const BRANCHES = 200
const CHANGES = 400
const median = (ns: ReadonlyArray<number>) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)]!

it.live(
  `change markers: ${MESSAGES} messages, ${BRANCHES} branches, ${CHANGES} state changes on the path`,
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
      const forkId = h.chat.currentForkId as ForkId
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
      const work = tempDir("statemarks-fixture")
      const fixture = yield* Effect.promise(
        () =>
          new Promise<Fixture>((resolve, reject) => {
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
      const tip = fixture.main.at(-1)!.id as SlotId
      // The message windows before any of the changes below: the newest page and the one above it.
      const pages = Effect.gen(function* () {
        const bottom = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
        const above = yield* api.ReadPath({
          chatId,
          leafSlotId: null,
          range: { _tag: "Older", from: bottom.older! },
          limit: 100
        })
        return [bottom, above].map((page) => ({
          older: page.older,
          newer: page.newer,
          leaf: page.leafSlotId,
          entries: page.entries.map((entry) => [entry.slotId, entry.depth, entry.position ?? null, entry.version.id])
        }))
      })
      const pagesBefore = yield* pages
      // The changes a long chat gathers: settings flipped, a note switched, along the whole path.
      const addedEvents = new Set<string>()
      for (let i = 0; i < CHANGES; i++) {
        const slotId = fixture.main[Math.floor((i * fixture.main.length) / CHANGES)]!.id as SlotId
        const data =
          i % 4 === 0
            ? ({ key: "cards.rotation", value: { on: i % 8 === 0 } } as const)
            : i % 4 === 1
              ? ({ key: "context.per_speaker", value: i % 8 === 1 ? "separate" : "shared" } as const)
              : i % 4 === 2
                ? ({ key: "reply.single", value: { on: i % 8 === 2 } } as const)
                : ({
                    key: i % 8 === 3 ? "note.activate" : "note.deactivate",
                    value: { note: note.ref.entityId }
                  } as const)
        const added = yield* writer.AddStateEvent({
          userId,
          chatId,
          forkId,
          slotId,
          versionId: null,
          scope: null,
          data: data as never
        })
        addedEvents.add(added.id)
      }
      const timed = <A, E, R>(label: string, action: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const samples: Array<number> = []
          const coldStart = performance.now()
          let answer = yield* action
          const coldMs = performance.now() - coldStart
          for (let i = 0; i < 7; i++) {
            const start = performance.now()
            answer = yield* action
            samples.push(performance.now() - start)
          }
          const ms = median(samples)
          console.log("STATEMARKS_TIMING", label, JSON.stringify({ coldMs, medianMs: ms, samples }))
          return { answer, ms }
        })
      // Measure marks before AwayMarks has warmed the same event query.
      const marks = yield* timed("state-marks", reader.StateMarks({ userId, chatId, forkId, slotId: tip, keys: KEYS }))
      const window = yield* timed(
        "timeline-window",
        api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
      )
      // The fixture deletes the message at every depth of 101n + 10 in each branch, and a window
      // walks through deleted messages without returning them: the newest 100 depths
      // (4900–4999) hold one, 4959, so the page has 99 entries. Nothing to do with the changes:
      // the pages are the same, entry for entry and cursor for cursor, as before any was recorded.
      const depths = new Set(window.answer.entries.map((entry) => entry.depth))
      const missing = Array.from({ length: 100 }, (_, i) => MESSAGES - 100 + i).filter((depth) => !depths.has(depth))
      console.log("STATEMARKS_WINDOW", window.answer.entries.length, JSON.stringify(missing))
      assert.deepStrictEqual(
        missing.map((depth) => depth % 101),
        missing.map(() => 10)
      )
      assert.deepStrictEqual(yield* pages, pagesBefore)
      const away = yield* timed("away-marks", reader.AwayMarks({ userId, chatId, forkId, slotId: tip }))
      // The fixture already activates its note once. Count the 400 newly written events by
      // identity rather than mistaking that pre-existing activation for one of these changes.
      const placed = marks.answer.events.filter((event) => addedEvents.has(event.eventId))
      // A change recorded at a message the fixture deleted doesn't apply, as in every state read,
      // so a few of the changes (those that landed on a deleted message) are not placed.
      const deletedCarriers = Array.from({ length: CHANGES }, (_, i) => Math.floor((i * MESSAGES) / CHANGES)).filter(
        (depth) => depth % 101 === 10
      ).length
      assert.lengthOf(placed, CHANGES - deletedCarriers)
      assert.strictEqual(marks.answer.names[note.ref.entityId], "Journey")
      console.log(
        "STATEMARKS_RESULT",
        JSON.stringify({
          slots: fixture.slots,
          fixtureEvents: fixture.events,
          returned: marks.answer.events.length,
          windowMs: window.ms,
          awayMs: away.ms,
          marksMs: marks.ms
        })
      )
      // One read a branch, of the path's events: the same order as the away marks' read beside
      // it, and never the path's length.
      assert.isBelow(marks.ms, Math.max(250, away.ms * 3))
    }).pipe(Effect.scoped, Effect.provide(server.layer))
  },
  600_000
)
