// An ST re-import that copies a recorded suffix (stImportFork.ts) keeps what the current fork
// shows there, its amends included: before forks owned copies, an amend changed the version
// itself, so the copied suffix carried it. Another fork's copies stay with that fork.
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import type { ForkId, SlotId } from "@rp/shared/chat.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"
import { stImportGraph } from "./support/stImportGraph.ts"

/**
 * A main file and a branch file imported, the branch's line opened (`side`), and a fork made
 * from it at its message 9 (`checkpoint`, current), so both forks show message 9.
 */
const setup = (config: ReturnType<typeof testConfig>) =>
  Effect.gen(function* () {
    const main = Array.from({ length: 10 }, (_, i) =>
      message({
        name: i % 2 ? "Sam" : "Alice",
        user: !!(i % 2),
        mes: `parent ${i}`,
        minute: i,
        ...(!(i % 2) ? { swipes: [`parent ${i}`] } : {})
      })
    )
    const branch = main.map((m, i) =>
      i < 5 ? m : { ...m, mes: `branch ${i}`, ...(m.swipes ? { swipes: [`branch ${i}`] } : {}) }
    )
    const files = new Map([
      ["characters/Alice.png", card("Alice", "Synthetic greeting")],
      ["chats/Alice/main.jsonl", jsonl([header({}), ...main])],
      ["chats/Alice/branch.jsonl", jsonl([header({ main_chat: "main" }), ...branch])]
    ])
    const { api } = yield* importStFolder(files)
    const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === "main")!
    const root = (yield* stImportGraph(config.dataDir, chat.id))[0]!.id as SlotId
    const user = yield* api.Whoami()
    const reader = yield* Reader
    const record = () =>
      Effect.map(reader.StImportSources({ userId: user.id }), (s) =>
        s.chats.find((r) => r.source === "chats/Alice/branch.jsonl")!
      )
    const path = () =>
      Effect.flatMap(record(), ({ end }) =>
        api.ReadPath({ chatId: chat.id, leafSlotId: end, range: { _tag: "Around", slot: root }, limit: 100 })
      )
    const childBefore = yield* path()
    // The branch's line, opened by the switcher as the user would.
    const fifth = childBefore.entries[5]!.slotId
    const index = (yield* api.ListBranches({ slotId: fifth })).findIndex((b) => b.slotId === fifth)
    const side = (yield* api.SwitchBranch({ chatId: chat.id, slotId: fifth, index })).fork.id
    // A fork made from the branch at its message 9 shows message 9 too, and is current.
    const made = yield* api.CreateFork({
      chatId: chat.id,
      fromForkId: side,
      atSlotId: childBefore.entries[9]!.slotId
    })
    const checkpoint = made.fork.id
    // The user's message 9, amended in `forkId`: a copy, since the other fork shows it too.
    const amend = (forkId: ForkId, content: string) =>
      Effect.gen(function* () {
        const entry = childBefore.entries[9]!
        const amended = yield* api.AmendVersion({
          versionId: entry.version.id,
          forkId,
          content,
          expectedRowVersion: entry.version.rowVersion
        })
        assert.notStrictEqual(amended.id, entry.version.id)
        assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).currentForkId, checkpoint)
        // An event attached to the copy, as a tab showing it attaches one.
        yield* (yield* Writer).AddStateEvent({
          userId: user.id,
          chatId: chat.id,
          slotId: entry.slotId,
          versionId: amended.id,
          scope: null,
          data: { key: "var.set", value: { name: "mood", value: "amended" } }
        })
        return { slotId: entry.slotId, versionId: amended.id }
      })
    // The branch file again, with a swipe chosen at message 4, in the prefix it shares with main.
    const reimport = () => {
      const m = branch[4]!
      const at = "2025-01-02T10:04:00.000Z"
      branch[4] = {
        ...m,
        mes: "Only the ST branch chose this",
        send_date: at,
        swipe_id: 1,
        swipes: [...m.swipes!, "Only the ST branch chose this"],
        swipe_info: [...m.swipe_info!, { send_date: at, extra: {} }]
      }
      return importStFolder(
        new Map([
          ["characters/Alice.png", files.get("characters/Alice.png")!],
          ["chats/Alice/branch.jsonl", jsonl([header({ main_chat: "main" }), ...branch])]
        ])
      )
    }
    const eventsAt = (slotId: string) =>
      Effect.map(
        fixtureSql(
          config.dataDir,
          [{ sql: "SELECT version_id AS version FROM state_events WHERE slot_id = ? ORDER BY seq", params: [slotId] }],
          { readOnly: true }
        ),
        ([events]) => events
      )
    const shownAt = (forkId: ForkId) =>
      Effect.map(
        api.ReadPath({ chatId: chat.id, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 }),
        (w) => w.entries.at(-1)!.version.content
      )
    return { api, side, checkpoint, path, amend, reimport, eventsAt, shownAt }
  })

const current = testConfig()
layer(serverLayer(current), { excludeTestServices: true, timeout: "180 seconds" })("fork copies on re-import", (it) => {
  it.effect("a copied suffix keeps the current fork's amend of a message another fork shows", () =>
    Effect.gen(function* () {
      const { api, checkpoint, path, amend, reimport, eventsAt, shownAt } = yield* setup(current)
      const entry = yield* amend(checkpoint, "Amended in the checkpoint")
      yield* reimport()
      const after = yield* path()
      assert.strictEqual(after.entries[4]!.version.content, "Only the ST branch chose this")
      assert.notStrictEqual(after.entries[9]!.slotId, entry.slotId)
      // The copied suffix shows the amend, as it did when an amend changed the version.
      assert.strictEqual(after.entries[9]!.version.content, "Amended in the checkpoint")
      const copied = yield* api.ListVersions({ slotId: after.entries[9]!.slotId })
      assert.deepStrictEqual(
        copied.map((v) => [v.content, v.rowVersion]),
        [["Amended in the checkpoint", 2]]
      )
      assert.deepStrictEqual(yield* eventsAt(after.entries[9]!.slotId), [{ version: copied[0]!.id }])
      // Where the import didn't copy, each fork still shows its own.
      assert.strictEqual(yield* shownAt(checkpoint), "Amended in the checkpoint")
    })
  )
})

const other = testConfig()
layer(serverLayer(other), { excludeTestServices: true, timeout: "180 seconds" })("fork copies on re-import", (it) => {
  it.effect("another fork's copy and its events stay with that fork, out of the copied suffix", () =>
    Effect.gen(function* () {
      const { api, side, checkpoint, path, amend, reimport, eventsAt, shownAt } = yield* setup(other)
      // The branch's fork amends message 9 while the checkpoint is current.
      const entry = yield* amend(side, "Amended in the branch")
      yield* reimport()
      const after = yield* path()
      assert.strictEqual(after.entries[4]!.version.content, "Only the ST branch chose this")
      assert.notStrictEqual(after.entries[9]!.slotId, entry.slotId)
      // The suffix is copied as the current fork shows it: without the branch fork's amend.
      assert.strictEqual(after.entries[9]!.version.content, "branch 9")
      const copied = yield* api.ListVersions({ slotId: after.entries[9]!.slotId })
      assert.deepStrictEqual(
        copied.map((v) => v.content),
        ["branch 9"]
      )
      assert.deepStrictEqual(yield* eventsAt(after.entries[9]!.slotId), [])
      // The amend and the event on it stay at the old message, where the checkpoint shows the original.
      assert.deepStrictEqual(yield* eventsAt(entry.slotId), [{ version: entry.versionId }])
      assert.strictEqual(yield* shownAt(checkpoint), "branch 9")
    })
  )
})
