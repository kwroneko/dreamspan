// A confirmed re-import does what its check showed, file by file, or refuses the file and says
// so (ARCHITECTURE.md §13 "Re-import preview"). Synthetic ST chats are imported, checked again
// with changes from "ST", and then changed here, or sent with other bytes, between the import's
// start and the write of the file: nothing of a refused file is written, and the report names
// it. Two imports of the same plan, and an import racing a message sent here, write each file
// at most once, in one transaction.
import { assert, layer } from "@effect/vitest"
import type { ChatId } from "@rp/shared/chat.ts"
import { ST_CHANGED_SINCE_CHECK } from "@rp/shared/stReimportPlan.ts"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { stImportGraph } from "./support/stImportGraph.ts"
import { importStFolder, sendFile, sendStFile } from "./support/stUpload.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const config = testConfig()
const CARD = card("Alice", "m0")

/** Alice and Sam taking turns; message 2 with two swipes, and `extra` more at the end. */
const lines = (count: number) =>
  jsonl([
    header({}),
    ...Array.from({ length: count }, (_, i) =>
      message({
        name: i % 2 ? "Sam" : "Alice",
        user: i % 2 === 1,
        mes: `m${i}`,
        minute: i,
        ...(i === 2 ? { swipes: ["m2", "m2b"], swipeId: 0 } : {})
      })
    )
  ])

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

/** A browser's check: the chat files listed, then those it asks for sent, in its order. */
const check = (api: Api, chats: ReadonlyMap<string, Uint8Array>) =>
  Effect.gen(function* () {
    const { plan, wanted } = yield* api.StartStImportPlan({
      files: [...chats].map(([path, bytes]) => ({ path, size: bytes.byteLength, modifiedMs: null, mainChat: null }))
    })
    const port = yield* serverPort
    for (const path of wanted) {
      const response = yield* Effect.promise(() =>
        fetch(
          `http://127.0.0.1:${port}/st-import/plan-file?${new URLSearchParams({ plan: plan.planId, path, part: "0", last: "1" })}`,
          { method: "POST", headers: { "content-type": "application/octet-stream" }, body: chats.get(path)! }
        )
      )
      assert.strictEqual(response.status, 200)
    }
    return yield* planEnded(api, plan.planId)
  })

const refusedIn = (api: Api, importId: string) =>
  Effect.map(api.GetStImport({ importId }), (detail) =>
    (detail.report?.issues ?? []).filter((issue) => issue.code === ST_CHANGED_SINCE_CHECK).map((issue) => issue.path)
  )

const entries = (api: Api, chatId: ChatId) =>
  Effect.map(
    api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 200 }),
    (read) => read.entries
  )

const stamps = (api: Api) =>
  Effect.gen(function* () {
    const userId = (yield* api.Whoami()).id
    return yield* (yield* Reader).StImportPlanStamp({ userId })
  })

const staged = Effect.map(
  fixtureSql(config.dataDir, [{ sql: "SELECT count(*) AS n FROM st_import_stage", params: [] }], { readOnly: true }),
  ([rows]) => (rows![0] as { n: number }).n
)

/** A chat imported, then checked with two messages more from ST: the plan, ready to import. */
const imported = (title: string) =>
  Effect.gen(function* () {
    const path = `chats/Alice/${title}.jsonl`
    const { api } = yield* importStFolder(new Map([["characters/Alice.png", CARD], [path, lines(6)]]))
    const chat = (yield* api.ListChats({ limit: 200, before: null })).find((c) => c.title === title)!
    const bytes = lines(8)
    const plan = yield* check(api, new Map([[path, bytes]]))
    assert.strictEqual(plan.status, "done")
    assert.deepStrictEqual(
      { ...plan.files[0]!.counts },
      { unchanged: 6, newMessages: 2, newSwipes: 0, selected: 0, kept: 0, branches: 0 }
    )
    const { importId } = yield* api.StartStImport({ unsupported: [], plan: { planId: plan.planId, skip: [] } })
    yield* sendStFile(importId, "characters/Alice.png", CARD)
    return { api, path, chat, bytes, plan, importId }
  })

type Change = (api: Api, chatId: ChatId) => Effect.Effect<unknown, unknown>

/** What the user does here between the import's start and the write of the file. */
const changes: ReadonlyArray<readonly [string, Change]> = [
  [
    "hide",
    (api, chatId) => Effect.flatMap(entries(api, chatId), (rows) => api.SetMessageHidden({ slotId: rows[1]!.slotId, hidden: true }))
  ],
  [
    "edit",
    (api, chatId) =>
      Effect.flatMap(entries(api, chatId), (rows) =>
        api.EditVersion({
          slotId: rows[1]!.slotId,
          sourceVersionId: rows[1]!.version.id,
          expectedRowVersion: rows[1]!.rowVersion,
          content: "Edited here"
        })
      )
  ],
  [
    "swipe",
    (api, chatId) =>
      Effect.gen(function* () {
        const third = (yield* entries(api, chatId))[2]!
        const versions = yield* api.ListVersions({ slotId: third.slotId })
        yield* api.SelectVersion({
          slotId: third.slotId,
          versionId: versions.find((version) => version.content === "m2b")!.id,
          expectedVersionId: third.version.id
        })
      })
  ],
  ["delete", (api, chatId) => Effect.flatMap(entries(api, chatId), (rows) => api.DeleteMessage({ slotId: rows[5]!.slotId }))],
  [
    "send",
    (api, chatId) =>
      Effect.flatMap(api.GetChat({ chatId }), (chat) =>
        posted(api.SendMessage({ chatId, parentSlotId: chat.activeLeafSlotId, branch: false, content: "Sent here" }))
      )
  ]
]

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("ST confirmed re-import", (it) => {
  it.effect("does what the check showed when nothing changed", () =>
    Effect.gen(function* () {
      const { api, path, chat, bytes, importId } = yield* imported("Same")
      const answer = yield* sendStFile(importId, path, bytes)
      assert.strictEqual(answer.outcome, "updated")
      yield* api.FinishStImport({ importId, notSent: [] })
      assert.deepStrictEqual(yield* refusedIn(api, importId), [])
      assert.lengthOf(yield* entries(api, chat.id), 8)
      assert.strictEqual(yield* staged, 0)
    })
  )

  it.effect("takes the checked bytes however the parts fall", () =>
    Effect.gen(function* () {
      const { api, path, chat, bytes, importId } = yield* imported("In parts")
      // Checked whole, sent in small parts.
      const answer = yield* sendStFile(importId, path, bytes, {}, 400)
      assert.strictEqual(answer.outcome, "updated")
      yield* api.FinishStImport({ importId, notSent: [] })
      assert.deepStrictEqual(yield* refusedIn(api, importId), [])
      assert.lengthOf(yield* entries(api, chat.id), 8)
    })
  )

  for (const [kind, change] of changes)
    it.effect(`refuses the file, writing nothing, after a ${kind} here since the check`, () =>
      Effect.gen(function* () {
        const { api, path, chat, bytes, importId } = yield* imported(`Race ${kind}`)
        yield* change(api, chat.id)
        const graph = yield* stImportGraph(config.dataDir, chat.id)
        const before = yield* stamps(api)
        const answer = yield* sendStFile(importId, path, bytes)
        assert.strictEqual(answer.outcome, "skipped")
        assert.strictEqual(answer.message, "Changed since the check. Not imported.")
        yield* api.FinishStImport({ importId, notSent: [] })
        assert.deepStrictEqual(yield* refusedIn(api, importId), [path])
        // Not a row of it: the chat, its record, and what the run held.
        assert.deepStrictEqual(yield* stImportGraph(config.dataDir, chat.id), graph)
        assert.strictEqual((yield* stamps(api))[chat.id], before[chat.id])
        assert.strictEqual(yield* staged, 0)
      })
    )

  it.effect("refuses uploaded bytes other than those checked, in parts or whole", () =>
    Effect.gen(function* () {
      const { api, path, chat, importId } = yield* imported("Other bytes")
      const graph = yield* stImportGraph(config.dataDir, chat.id)
      const answer = yield* sendStFile(importId, path, lines(10), {}, 400)
      assert.strictEqual(answer.outcome, "skipped")
      yield* api.FinishStImport({ importId, notSent: [] })
      assert.deepStrictEqual(yield* refusedIn(api, importId), [path])
      assert.deepStrictEqual(yield* stImportGraph(config.dataDir, chat.id), graph)
      assert.strictEqual(yield* staged, 0)
    })
  )

  it.effect("writes a file once when a second import of the same check starts part way", () =>
    Effect.gen(function* () {
      const { api, path, chat, bytes, plan, importId } = yield* imported("Twice")
      // The first run holds the file's first part, then a second run of the same check starts.
      // The header and two messages: more than a greeting, so they're held, not waited on.
      const cut = bytes.indexOf(10, bytes.indexOf(10, bytes.indexOf(10) + 1) + 1) + 1
      const head = yield* sendFile(importId, path, bytes.subarray(0, cut), { part: "0", last: "0" })
      assert.strictEqual(head.status, 200)
      assert.strictEqual(yield* staged, 1)
      const second = yield* api.StartStImport({ unsupported: [], plan: { planId: plan.planId, skip: [] } })
      // The first run is over: what it held went with it, and the rest of its file isn't taken.
      assert.strictEqual(yield* staged, 0)
      const late = yield* sendFile(importId, path, bytes.subarray(cut), { part: "1", last: "1" })
      assert.notStrictEqual(late.status, 200)
      yield* sendStFile(second.importId, "characters/Alice.png", CARD)
      const answer = yield* sendStFile(second.importId, path, bytes)
      assert.strictEqual(answer.outcome, "updated")
      yield* api.FinishStImport({ importId: second.importId, notSent: [] })
      const rows = yield* stImportGraph(config.dataDir, chat.id)
      assert.lengthOf(new Set(rows.map((row) => row.id)), 8)
      assert.lengthOf(yield* entries(api, chat.id), 8)
      assert.strictEqual(yield* staged, 0)
    })
  )

  it.effect("an import racing a message sent here either writes the file whole or not at all", () =>
    Effect.gen(function* () {
      for (let round = 0; round < 4; round++) {
        const { api, path, chat, bytes, importId } = yield* imported(`Racing ${round}`)
        const leaf = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId
        const before = new Set((yield* stImportGraph(config.dataDir, chat.id)).map((row) => row.id))
        // Sent from the leaf as it was; if the file went in first, from where it left the leaf.
        const send = (parentSlotId: typeof leaf) =>
          api.SendMessage({ chatId: chat.id, parentSlotId, branch: false, content: "Raced" })
        const [answer] = yield* Effect.all(
          [
            sendStFile(importId, path, bytes),
            Effect.andThen(
              Effect.sleep(round * 2),
              send(leaf).pipe(Effect.catchTag("LeafMoved", (moved) => send(moved.activeLeafSlotId as typeof leaf)))
            )
          ],
          { concurrency: 2 }
        )
        yield* api.FinishStImport({ importId, notSent: [] })
        const added = (yield* stImportGraph(config.dataDir, chat.id)).filter((row) => !before.has(row.id))
        const fromFile = new Set(added.filter((row) => row.content === "m6" || row.content === "m7").map((row) => row.id))
        const sent = added.filter((row) => row.content === "Raced")
        const refused = yield* refusedIn(api, importId)
        assert.lengthOf(sent, 1)
        if (answer.outcome === "skipped") {
          assert.deepStrictEqual(refused, [path])
          assert.strictEqual(fromFile.size, 0)
        } else {
          // The file's two new messages, whole, before or after the one sent here.
          assert.strictEqual(answer.outcome, "updated")
          assert.deepStrictEqual(refused, [])
          assert.strictEqual(fromFile.size, 2)
        }
      }
      assert.strictEqual(yield* staged, 0)
    })
  )
})
