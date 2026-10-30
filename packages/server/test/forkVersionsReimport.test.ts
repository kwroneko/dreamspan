// ST re-import changes only the recorded fork selection and retains shared suffix slots.
import { assert, layer } from "@effect/vitest"
import { foldState } from "@rp/shared/state.ts"
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
      Effect.flatMap(record(), ({ end, forkId }) =>
        api.ReadPath({ chatId: chat.id, forkId, leafSlotId: end, range: { _tag: "Around", slot: root }, limit: 100 })
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
          forkId,
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
    const moodAt = (forkId: ForkId, slotId: SlotId) =>
      Effect.map(
        reader.StateEventsAt({ userId: user.id, chatId: chat.id, forkId, slotId }),
        (events) => foldState(events).vars.mood
      )
    return { api, side, checkpoint, path, amend, reimport, eventsAt, shownAt, moodAt }
  })

const current = testConfig()
layer(serverLayer(current), { excludeTestServices: true, timeout: "180 seconds" })(
  "fork amendments on re-import",
  (it) => {
    it.effect("the recorded branch keeps its original while the current checkpoint keeps its amend", () =>
      Effect.gen(function* () {
        const { api, side, checkpoint, path, amend, reimport, eventsAt, shownAt, moodAt } = yield* setup(current)
        const entry = yield* amend(checkpoint, "Amended in the checkpoint")
        yield* reimport()
        const after = yield* path()
        assert.strictEqual(after.entries[4]!.version.content, "Only the ST branch chose this")
        assert.strictEqual(after.entries[9]!.slotId, entry.slotId)
        // Re-import addresses the file's fork even while its checkpoint is current.
        assert.strictEqual(after.entries[9]!.version.content, "branch 9")
        const copied = yield* api.ListVersions({ slotId: after.entries[9]!.slotId, forkId: side })
        assert.deepStrictEqual(
          copied.map((v) => [v.content, v.rowVersion]),
          [["branch 9", 1]]
        )
        assert.deepStrictEqual(yield* eventsAt(after.entries[9]!.slotId), [{ version: entry.versionId }])
        assert.isUndefined(yield* moodAt(side, entry.slotId))
        assert.strictEqual(yield* moodAt(checkpoint, entry.slotId), "amended")
        assert.strictEqual(yield* shownAt(checkpoint), "Amended in the checkpoint")
      })
    )
  }
)

const other = testConfig()
layer(serverLayer(other), { excludeTestServices: true, timeout: "180 seconds" })(
  "fork amendments on re-import",
  (it) => {
    it.effect("the recorded branch retains its own amend and events while another fork is current", () =>
      Effect.gen(function* () {
        const { api, side, checkpoint, path, amend, reimport, eventsAt, shownAt, moodAt } = yield* setup(other)
        // The branch's fork amends message 9 while the checkpoint is current.
        const entry = yield* amend(side, "Amended in the branch")
        yield* reimport()
        const after = yield* path()
        assert.strictEqual(after.entries[4]!.version.content, "Only the ST branch chose this")
        assert.strictEqual(after.entries[9]!.slotId, entry.slotId)
        // The file's fork retains its amend even while another fork is current.
        assert.strictEqual(after.entries[9]!.version.content, "Amended in the branch")
        const copied = yield* api.ListVersions({ slotId: after.entries[9]!.slotId, forkId: side })
        assert.deepStrictEqual(
          copied.map((v) => v.content),
          ["Amended in the branch"]
        )
        assert.strictEqual(yield* moodAt(side, entry.slotId), "amended")
        assert.isUndefined(yield* moodAt(checkpoint, entry.slotId))
        // The checkpoint still shows the original at the same shared message.
        assert.deepStrictEqual(yield* eventsAt(entry.slotId), [{ version: entry.versionId }])
        assert.strictEqual(yield* shownAt(checkpoint), "branch 9")
      })
    )
  }
)

// Messages the user inserted (spec/MESSAGE-INSERT.md §3.3, unit 8) are local changes: a
// re-import of a changed ST chat stops at one, keeping the fork on the path that shows it, and
// never matches one as the file's own message. One that changes nothing after an insertion
// goes on as before, and the insertion stays where it is.
const inserting = testConfig()
layer(serverLayer(inserting), { excludeTestServices: true, timeout: "180 seconds" })(
  "inserted messages on re-import",
  (it) => {
    const lines = (tag: string) =>
      Array.from({ length: 10 }, (_, i) =>
        message({
          name: i % 2 ? "Sam" : "Alice",
          user: i % 2 === 1,
          mes: `${tag} ${i}`,
          minute: i,
          ...(!(i % 2) ? { swipes: [`${tag} ${i}`] } : {})
        })
      )
    const folder = (tag: string, messages: ReadonlyArray<unknown>) =>
      new Map([
        ["characters/Alice.png", card("Alice", "Synthetic greeting")],
        [`chats/Alice/${tag}.jsonl`, jsonl([header({ tainted: true }), ...messages])]
      ])
    /** A chat imported from `tag`'s file, with a message inserted below its message `below` (null: above the first). */
    const imported = (tag: string, below: number | null) =>
      Effect.gen(function* () {
        const file = lines(tag)
        const { api } = yield* importStFolder(folder(tag, file))
        const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === tag)!
        const forkId = (yield* api.GetChat({ chatId: chat.id })).currentForkId! as ForkId
        const before = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
        const user = yield* api.Whoami()
        const made = yield* (yield* Writer).InsertMessage({
          userId: user.id,
          chatId: chat.id,
          forkId,
          anchorSlotId: below === null ? null : before.entries[below]!.slotId,
          expectedRowVersion: 0,
          body: { _tag: "Write", speaker: null, content: "Inserted here" }
        })
        const shown = () =>
          Effect.map(
            api.ReadPath({ chatId: chat.id, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }),
            (w) => w.entries.map((e) => [e.slotId, e.version.content, e.position])
          )
        const slots = () =>
          Effect.map(stImportGraph(inserting.dataDir, chat.id), (rows) => new Set(rows.map((r) => r.id)).size)
        return { api, chat, file, x: made.slotId, shown, slots }
      })
    // ST's message `at` rewritten by the other side: a writer change starts a new path there.
    const rewritten = (tag: string, file: ReadonlyArray<ReturnType<typeof message>>, at: number) =>
      file.map((m, i) =>
        i === at
          ? message({ name: i % 2 ? "Alice" : "Sam", user: i % 2 === 0, mes: `${tag} rewritten ${i}`, minute: 60 + i })
          : m
      )

    for (const [label, below, at] of [
      ["right above the rewritten message", 6, 7],
      ["inside the rewritten suffix", 8, 7],
      ["above the first message, rewritten", null, 0]
    ] as const) {
      it.effect(`a re-import stops at an insertion ${label}`, () =>
        Effect.gen(function* () {
          const tag = `stop-${at}-${below}`
          const { api, chat, file, x, shown, slots } = yield* imported(tag, below)
          const before = yield* shown()
          assert.isTrue(before.some(([slot]) => slot === x))
          const count = yield* slots()
          yield* importStFolder(folder(tag, rewritten(tag, file, at)))
          // The fork keeps the path that shows X; ST's new path is stored beside it.
          assert.deepStrictEqual(yield* shown(), before)
          assert.strictEqual(yield* slots(), count + file.length - at)
          assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId, chat.activeLeafSlotId)
        })
      )
    }

    it.effect("a re-import that changes nothing after an insertion goes on as before", () =>
      Effect.gen(function* () {
        const tag = "below-3"
        const { file, x, shown } = yield* imported(tag, 3)
        yield* importStFolder(folder(tag, rewritten(tag, file, 7)))
        const after = yield* shown()
        // ST's new messages 7 to 9 follow, and X stays below message 3.
        assert.deepStrictEqual(
          after.map(([, content]) => content),
          [
            ...[0, 1, 2, 3].map((i) => `${tag} ${i}`),
            "Inserted here",
            ...[4, 5, 6].map((i) => `${tag} ${i}`),
            `${tag} rewritten 7`,
            `${tag} 8`,
            `${tag} 9`
          ]
        )
        assert.strictEqual(after[4]![0], x)
        assert.deepStrictEqual(
          after.map(([, , position]) => position),
          after.map((_, i) => i)
        )
      })
    )

    it.effect("an appended ST message is never matched to an inserted one", () =>
      Effect.gen(function* () {
        const tag = "append"
        const { file, x, shown, chat } = yield* imported(tag, 9)
        // The file's next message reads exactly like X, with X's writer and time.
        const at = (yield* stImportGraph(inserting.dataDir, chat.id)).find((r) => r.id === x)!.at
        const next = {
          ...message({ name: "Sam", user: true, mes: "Inserted here", minute: 0 }),
          send_date: new Date(at).toISOString()
        }
        yield* importStFolder(folder(tag, [...file, next]))
        const after = yield* shown()
        assert.strictEqual(after.length, 12)
        assert.deepStrictEqual(after[10], [x, "Inserted here", 10])
        assert.notStrictEqual(after[11]![0], x)
        assert.deepStrictEqual(after[11]!.slice(1), ["Inserted here", 11])
      })
    )
  }
)
