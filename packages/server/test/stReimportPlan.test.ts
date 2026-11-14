// The re-import preview (ARCHITECTURE.md §13 "Re-import preview"): a synthetic ST folder
// imported, changed here and in "ST", then previewed and imported again. The preview's counts
// must be what the import then does, nothing may be written by the preview, and an import
// confirmed from a preview the chats changed since must be refused. Folders are read by path
// (StartStImportPlan with `folder`), and one from a browser through the files it asks for.
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { assert, layer } from "@effect/vitest"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import type { StImportPlan } from "@rp/shared/stReimportPlan.ts"
import { Effect } from "effect"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { stImportGraph } from "./support/stImportGraph.ts"
import { importStPath, jobEnded } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const config = testConfig()
const PREFIX = "ST/data/default-user/"

/** Alice and Sam taking turns; Alice's messages with swipes, message 6 with two. */
const turns = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    message({
      name: i % 2 ? "Sam" : "Alice",
      user: i % 2 === 1,
      mes: `m${i}`,
      minute: i,
      ...(i % 2 ? {} : { swipes: i === 6 ? ["m6", "m6b"] : [`m${i}`] })
    })
  )

/** In ST since: a new swipe on message 4, selected there, and two messages more. */
const later = () => {
  const lines = turns(12)
  lines[4] = message({ name: "Alice", mes: "m4 new", minute: 4, swipes: ["m4", "m4 new"], swipeId: 1 })
  return lines
}

const lateCopy = () => {
  const lines = later().slice(0, 11)
  lines[8] = message({ name: "Alice", hidden: true, mes: "m8", minute: 8, swipes: ["m8"] })
  return lines
}

const own = (tag: string, from: number, count: number) =>
  Array.from({ length: count }, (_, i) =>
    message({
      name: (from + i) % 2 ? "Sam" : "Alice",
      user: (from + i) % 2 === 1,
      mes: `${tag} ${from + i}`,
      minute: from + i
    })
  )

const file = (lines: ReadonlyArray<unknown>, mainChat?: string) =>
  jsonl([header(mainChat === undefined ? {} : { main_chat: mainChat }), ...lines])

const firstFolder = () =>
  new Map([
    [`${PREFIX}characters/Alice.png`, card("Alice", "m0")],
    [`${PREFIX}chats/Alice/Main.jsonl`, file(turns(10))],
    // A branch of Main from message 3, merged into Main's chat.
    [`${PREFIX}chats/Alice/Side.jsonl`, file([...turns(4), ...own("side", 4, 2)], "Main")],
    [`${PREFIX}chats/Alice/Gone.jsonl`, file(own("gone", 0, 4))]
  ])

const secondFolder = () =>
  new Map([
    [`${PREFIX}characters/Alice.png`, card("Alice", "m0")],
    [`${PREFIX}chats/Alice/Main.jsonl`, file(later())],
    [`${PREFIX}chats/Alice/Side.jsonl`, file([...turns(4), ...own("side", 4, 3)], "Main")],
    // A new branch from message 10, which Main's own file brings in this same import. It hides
    // message 8 as the user did here: a merged branch that hides differently diverges there.
    [`${PREFIX}chats/Alice/Late.jsonl`, file([...lateCopy(), ...own("late", 11, 2)], "Main")],
    [`${PREFIX}chats/Alice/Gone.jsonl`, file(own("gone", 0, 6))],
    [`${PREFIX}chats/Alice/New.jsonl`, file(own("new", 0, 3))]
  ])

/** The files in a new temporary folder. */
const onDisk = (files: ReadonlyMap<string, Uint8Array>) => {
  const root = tempDir("st-plan")
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  return root
}

const planEnded = (api: Api, planId: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 60_000
    for (;;) {
      const plan = yield* api.GetStImportPlan({ planId })
      if (plan.status !== "running") return plan
      if (Date.now() > deadline) return yield* Effect.die(new Error("preview still running"))
      yield* Effect.sleep(20)
    }
  })

const byPath = (plan: StImportPlan) => new Map(plan.files.map((entry) => [entry.path, entry]))

const chatByTitle = (api: Api, title: string) =>
  Effect.map(api.ListChats({ limit: 100, before: null }), (chats) => chats.find((chat) => chat.title === title))

const path = (api: Api, chatId: ChatId) =>
  Effect.map(api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 200 }), (read) => read.entries)

/** What the graph gained: new slots, and versions new on slots that were there. */
const gained = (
  before: ReadonlyArray<{ id: string; content: string }>,
  after: ReadonlyArray<{ id: string; content: string }>
) => {
  const slots = new Set(before.map((row) => row.id))
  const versions = new Set(before.map((row) => `${row.id}\n${row.content}`))
  return {
    slots: new Set(after.filter((row) => !slots.has(row.id)).map((row) => row.id)).size,
    versions: after.filter((row) => slots.has(row.id) && !versions.has(`${row.id}\n${row.content}`)).length
  }
}

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("ST re-import preview", (it) => {
  it.effect("shows what the import then does, writes nothing, and holds the import to it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const first = yield* importStPath(api, onDisk(firstFolder()), PREFIX)
      assert.strictEqual(first.job.status, "complete")
      const main = (yield* chatByTitle(api, "Main"))!
      const gone = (yield* chatByTitle(api, "Gone"))!
      // Here: another swipe chosen on message 6, message 8 hidden, Gone in the bin.
      const entries = yield* path(api, main.id)
      const sixth = entries[6]!
      const versions = yield* api.ListVersions({ slotId: sixth.slotId })
      yield* api.SelectVersion({
        slotId: sixth.slotId,
        versionId: versions.find((version) => version.content === "m6b")!.id,
        expectedVersionId: sixth.version.id
      })
      yield* api.SetMessageHidden({ slotId: entries[8]!.slotId, hidden: true })
      yield* api.DeleteChat({ chatId: gone.id })

      const root = onDisk(secondFolder())
      const before = yield* stImportGraph(config.dataDir, main.id)
      const chatBefore = yield* api.GetChat({ chatId: main.id })
      const started = yield* api.StartStImportPlan({ folder: { root, prefix: PREFIX } })
      assert.deepStrictEqual(started.wanted, [])
      const plan = yield* planEnded(api, started.plan.planId)
      assert.strictEqual(plan.status, "done")
      assert.strictEqual(plan.newChats, 1)
      const files = byPath(plan)
      assert.deepStrictEqual(
        [...files.values()].map((entry) => [entry.path, entry.target]),
        [
          ["chats/Alice/Gone.jsonl", "bin"],
          ["chats/Alice/Main.jsonl", "existing"],
          ["chats/Alice/Late.jsonl", "branch"],
          ["chats/Alice/Side.jsonl", "existing"]
        ]
      )
      assert.deepStrictEqual(
        { ...files.get("chats/Alice/Main.jsonl")!.counts },
        { unchanged: 7, newMessages: 2, newSwipes: 1, selected: 1, kept: 2, branches: 0 }
      )
      assert.deepStrictEqual(
        { ...files.get("chats/Alice/Side.jsonl")!.counts },
        { unchanged: 6, newMessages: 1, newSwipes: 0, selected: 0, kept: 0, branches: 0 }
      )
      // Late's first eleven messages are Main's, the last two of them new from Main's file in
      // this import: the import matches them, so they aren't new for Late.
      assert.deepStrictEqual(
        { ...files.get("chats/Alice/Late.jsonl")!.counts },
        { unchanged: 10, newMessages: 2, newSwipes: 0, selected: 0, kept: 1, branches: 1 }
      )
      const details = yield* api.GetStImportPlanMessages({
        planId: plan.planId,
        path: "chats/Alice/Main.jsonl",
        offset: 0
      })
      assert.deepStrictEqual(
        details.messages.map((m) => [m.index, m.change, m.swipes, m.kept, m.text]),
        [
          [4, "swipes", 1, null, "m4 new"],
          [6, "kept", 0, "choice", "m6"],
          [8, "kept", 0, "hidden", "m8"],
          [10, "new", 0, null, "m10"],
          [11, "new", 0, null, "m11"]
        ]
      )
      assert.strictEqual(details.total, 5)

      // The preview wrote nothing.
      assert.deepStrictEqual(yield* stImportGraph(config.dataDir, main.id), before)
      assert.deepStrictEqual(yield* api.GetChat({ chatId: main.id }), chatBefore)

      // A change here after the preview: the import it confirms is refused, nothing written.
      yield* api.SetMessageHidden({ slotId: entries[2]!.slotId, hidden: true })
      const refused = yield* api
        .StartStPathImport({ path: root, prefix: PREFIX, plan: { planId: plan.planId, skip: [] } })
        .pipe(Effect.flip)
      assert.strictEqual(refused._tag, "StImportPlanChanged")
      assert.strictEqual((yield* stImportGraph(config.dataDir, main.id)).length, before.length)
      yield* api.SetMessageHidden({ slotId: entries[2]!.slotId, hidden: false })

      // Worked out again, then imported: the import does what it showed.
      const again = yield* planEnded(
        api,
        (yield* api.StartStImportPlan({ folder: { root, prefix: PREFIX } })).plan.planId
      )
      assert.deepStrictEqual(
        again.files.map((entry) => ({ ...entry.counts })),
        plan.files.map((entry) => ({ ...entry.counts }))
      )
      const { importId } = yield* api.StartStPathImport({
        path: root,
        prefix: PREFIX,
        plan: { planId: again.planId, skip: [] }
      })
      const done = yield* jobEnded(api, importId)
      assert.strictEqual(done.job.status, "complete")
      const after = yield* stImportGraph(config.dataDir, main.id)
      const sum = (key: "newMessages" | "newSwipes") =>
        plan.files.filter((entry) => entry.target !== "bin").reduce((n, entry) => n + entry.counts[key], 0)
      assert.deepStrictEqual(gained(before, after), { slots: sum("newMessages"), versions: sum("newSwipes") })
      // On Main's path: its selection applied, the choice and the hiding here kept, its new
      // messages at the end. Gone stays in the bin.
      const tip = after.find((row) => row.content === "m11")!
      const now = (yield* api.ReadPath({
        chatId: main.id,
        leafSlotId: tip.id as SlotId,
        range: { _tag: "Bottom" },
        limit: 200
      })).entries
      assert.strictEqual(now.length, 12)
      assert.strictEqual(now[4]!.version.content, "m4 new")
      assert.strictEqual(now[6]!.version.content, "m6b")
      assert.isTrue(now[8]!.hiddenByUser)
      assert.isUndefined(yield* chatByTitle(api, "Gone"))
      assert.isDefined(yield* chatByTitle(api, "New"))
    })
  )

  it.effect("skips the files the user chose to skip, and refuses a preview the folder changed since", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const files = new Map([
        [`${PREFIX}characters/Bea.png`, card("Bea", "m0")],
        [`${PREFIX}chats/Bea/One.jsonl`, file(turns(4))],
        [`${PREFIX}chats/Bea/Two.jsonl`, file(own("two", 0, 4))]
      ])
      yield* importStPath(api, onDisk(files), PREFIX)
      const one = (yield* chatByTitle(api, "One"))!
      const two = (yield* chatByTitle(api, "Two"))!
      files.set(`${PREFIX}chats/Bea/One.jsonl`, file(turns(6)))
      files.set(`${PREFIX}chats/Bea/Two.jsonl`, file(own("two", 0, 6)))
      const root = onDisk(files)
      const plan = yield* planEnded(
        api,
        (yield* api.StartStImportPlan({ folder: { root, prefix: PREFIX } })).plan.planId
      )
      // The folder changed after the preview: worked out again before anything is imported.
      writeFileSync(join(root, PREFIX, "chats/Bea/One.jsonl"), file(turns(8)))
      const stale = yield* api
        .StartStPathImport({ path: root, prefix: PREFIX, plan: { planId: plan.planId, skip: [] } })
        .pipe(Effect.flip)
      assert.strictEqual(stale._tag, "StImportPlanChanged")
      const fresh = yield* planEnded(
        api,
        (yield* api.StartStImportPlan({ folder: { root, prefix: PREFIX } })).plan.planId
      )
      assert.strictEqual(byPath(fresh).get("chats/Bea/One.jsonl")!.counts.newMessages, 4)
      const { importId } = yield* api.StartStPathImport({
        path: root,
        prefix: PREFIX,
        plan: { planId: fresh.planId, skip: ["chats/Bea/Two.jsonl"] }
      })
      assert.strictEqual((yield* jobEnded(api, importId)).job.status, "complete")
      assert.strictEqual((yield* path(api, one.id)).length, 8)
      assert.strictEqual((yield* path(api, two.id)).length, 4)
    })
  )

  it.effect("previews a browser's folder from the files it asks for", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const files = new Map([
        [`${PREFIX}characters/Cy.png`, card("Cy", "m0")],
        [`${PREFIX}chats/Cy/Up.jsonl`, file(turns(4))]
      ])
      yield* importStPath(api, onDisk(files), PREFIX)
      const bytes = file(later())
      const { plan, wanted } = yield* api.StartStImportPlan({
        files: [
          { path: "chats/Cy/Up.jsonl", size: bytes.byteLength, modifiedMs: null, mainChat: null },
          { path: "chats/Cy/Other.jsonl", size: 10, modifiedMs: null, mainChat: null }
        ]
      })
      assert.deepStrictEqual(wanted, ["chats/Cy/Up.jsonl"])
      assert.strictEqual(plan.newChats, 1)
      const port = yield* serverPort
      const response = yield* Effect.promise(() =>
        fetch(
          `http://127.0.0.1:${port}/st-import/plan-file?${new URLSearchParams({ plan: plan.planId, path: "chats/Cy/Up.jsonl", part: "0", last: "1" })}`,
          { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes }
        )
      )
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), { outcome: "done" })
      const done = yield* planEnded(api, plan.planId)
      assert.deepStrictEqual(
        { ...done.files[0]!.counts },
        { unchanged: 4, newMessages: 8, newSwipes: 0, selected: 0, kept: 0, branches: 0 }
      )
      yield* api.CancelStImportPlan({ planId: plan.planId })
    })
  )
})
