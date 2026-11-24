// A confirmed re-import does what its check showed, file by file, or refuses the file and says
// so (ARCHITECTURE.md §13 "Re-import preview"). Synthetic ST chats are imported, checked again
// with changes from "ST", and then changed here, or sent with other bytes, between the import's
// start and the write of the file: nothing of a refused file is written, and the report names
// it. Two imports of the same plan, and an import racing a message sent here, write each file
// at most once, in one transaction.
import { assert, layer } from "@effect/vitest"
import { vi } from "vitest"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { ST_CHANGED_SINCE_CHECK, ST_UNPLANNED_CHAT_MESSAGE } from "@dreamspan/shared/stReimportPlan.ts"
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { StFileResult } from "@dreamspan/shared/stImportApi.ts"
import { StImports } from "../src/importer/StImports.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, post, posted, serverLayer, serverPort, testConfig } from "./support/config.ts"
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
  Effect.map(api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 200 }), (read) => read.entries)

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
    const { api } = yield* importStFolder(
      new Map([
        ["characters/Alice.png", CARD],
        [path, lines(6)]
      ])
    )
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
  ["rename", (api, chatId) => api.RenameChat({ chatId, name: "Named here" })],
  [
    "multi-delete",
    (api, chatId) =>
      Effect.gen(function* () {
        const rows = yield* entries(api, chatId)
        const forkId = (yield* api.GetChat({ chatId })).currentForkId!
        yield* api.DeleteMessages({ forkId, slotIds: [rows[2]!.slotId, rows[3]!.slotId] })
      })
  ],
  [
    "Undo",
    (api, chatId) =>
      Effect.gen(function* () {
        const rows = yield* entries(api, chatId)
        const forkId = (yield* api.GetChat({ chatId })).currentForkId!
        const deleted = yield* api.DeleteMessages({ forkId, slotIds: [rows[2]!.slotId, rows[3]!.slotId] })
        yield* api.RestoreBinItems({ itemIds: deleted.map((item) => item.id) })
      })
  ],
  [
    "fork",
    (api, chatId) =>
      Effect.gen(function* () {
        const rows = yield* entries(api, chatId)
        yield* api.CreateFork({ chatId, fromForkId: null, atSlotId: rows[2]!.slotId })
      })
  ],
  [
    "hide",
    (api, chatId) =>
      Effect.flatMap(entries(api, chatId), (rows) => api.SetMessageHidden({ slotId: rows[1]!.slotId, hidden: true }))
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
  [
    "delete",
    (api, chatId) => Effect.flatMap(entries(api, chatId), (rows) => api.DeleteMessage({ slotId: rows[5]!.slotId }))
  ],
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

  it.effect("refuses a legacy interrupted-copy file before staging or changing its chat", () =>
    Effect.gen(function* () {
      const { api, path, chat, bytes, importId } = yield* imported("Legacy copy")
      yield* api.CancelStImport({ importId })
      yield* fixtureSql(config.dataDir, [
        {
          sql: "UPDATE jobs SET payload_json = json_set(payload_json, '$.forkPrior', json_extract(payload_json, '$.end')) WHERE kind = 'st-import-chat' AND json_extract(payload_json, '$.source') = ?",
          params: [path]
        }
      ])
      const plan = yield* check(api, new Map([[path, bytes]]))
      const run = yield* api.StartStImport({ unsupported: [], plan: { planId: plan.planId, skip: [] } })
      yield* sendStFile(run.importId, "characters/Alice.png", CARD)
      const before = yield* stImportGraph(config.dataDir, chat.id)
      const beforeStamp = (yield* stamps(api))[chat.id]
      const answer = yield* sendStFile(run.importId, path, bytes)
      assert.strictEqual(answer.outcome, "failed")
      assert.strictEqual(answer.message, ST_UNPLANNED_CHAT_MESSAGE)
      yield* api.FinishStImport({ importId: run.importId, notSent: [] })
      assert.isTrue(
        (yield* api.GetStImportReport({ importId: run.importId })).issues.some(
          (issue) => issue.code === "st.chat_unplanned"
        )
      )
      assert.deepStrictEqual(yield* stImportGraph(config.dataDir, chat.id), before)
      assert.strictEqual((yield* stamps(api))[chat.id], beforeStamp)
      assert.strictEqual(yield* staged, 0)
    })
  )

  it.effect("rolls the whole file back if a preallocated reader id collides with a concurrent write", () =>
    Effect.gen(function* () {
      const { api, path, chat, bytes, importId } = yield* imported("Id collision")
      yield* api.CancelStImport({ importId })
      const records = new TextDecoder()
        .decode(bytes)
        .split("\n")
        .map((line) => JSON.parse(line))
      records[3].swipes.push("another imported swipe")
      const changed = jsonl(records)
      const plan = yield* check(api, new Map([[path, changed]]))
      const run = yield* api.StartStImport({ unsupported: [], plan: { planId: plan.planId, skip: [] } })
      yield* sendStFile(run.importId, "characters/Alice.png", CARD)
      const before = yield* stImportGraph(config.dataDir, chat.id)
      const writer = yield* Writer
      const original = writer.StImportStage
      let other: ChatId | undefined
      const hook = vi.spyOn(writer, "StImportStage").mockImplementation((input) =>
        Effect.gen(function* () {
          if (input.batchJson !== null) {
            const batch = JSON.parse(input.batchJson)
            const version = batch.plan?.ops.find((op: { k: string }) => op.k === "v")
            if (version !== undefined) {
              const concurrent = yield* api.CreateChat({ title: "Concurrent collision" }).pipe(Effect.orDie)
              other = concurrent.id
              const sent = yield* posted(
                api.SendMessage({
                  chatId: concurrent.id,
                  parentSlotId: null,
                  branch: false,
                  content: "Other account-owned chat"
                })
              ).pipe(Effect.orDie)
              // Simulate the cryptographically improbable collision after the reader chose
              // the id and before the final write. The real unique constraint must refuse it.
              version.id = sent.entry.version.id
              return yield* original({ ...input, batchJson: JSON.stringify(batch) })
            }
          }
          return yield* original(input)
        })
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => hook.mockRestore()))
      assert.isTrue(Exit.isFailure(yield* Effect.exit(sendStFile(run.importId, path, changed))))
      yield* api.CancelStImport({ importId: run.importId })
      assert.deepStrictEqual(yield* stImportGraph(config.dataDir, chat.id), before)
      assert.isDefined(other)
      assert.deepStrictEqual(
        (yield* entries(api, other!)).map((row) => row.version.content),
        ["Other account-owned chat"]
      )
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

  for (const change of [false, true])
    it.effect(`holds changed planned batches until the whole existing file ${change ? "is refused" : "commits"}`, () =>
      Effect.gen(function* () {
        const title = `Planned batches ${change}`
        const path = `chats/Alice/${title}.jsonl`
        const { api } = yield* importStFolder(
          new Map([
            ["characters/Alice.png", CARD],
            [path, lines(205)]
          ])
        )
        const chat = (yield* api.ListChats({ limit: 200, before: null })).find((c) => c.title === title)!
        const records = new TextDecoder()
          .decode(lines(208))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        records[3].swipe_id = 1
        records[3].mes = "m2b"
        const bytes = jsonl(records)
        const plan = yield* check(api, new Map([[path, bytes]]))
        const run = yield* api.StartStImport({ unsupported: [], plan: { planId: plan.planId, skip: [] } })
        yield* sendStFile(run.importId, "characters/Alice.png", CARD)
        const prefix = jsonl(records.slice(0, 151))
        const cut = prefix.byteLength
        assert.strictEqual(
          (yield* sendFile(run.importId, path, bytes.subarray(0, cut), { part: "0", last: "0" })).status,
          200
        )
        const [held] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT json_extract(batch_json, '$.plan') AS plan FROM st_import_stage WHERE import_id = ? ORDER BY seq",
              params: [run.importId]
            }
          ],
          { readOnly: true }
        )
        assert.isAtLeast(held!.length, 2)
        assert.isTrue(held!.every((row) => typeof row.plan === "string"))
        const before = yield* stImportGraph(config.dataDir, chat.id)
        const start = () =>
          api.ReadPath({
            chatId: chat.id,
            leafSlotId: null,
            range: { _tag: "Around", slot: before[0]!.id as never },
            limit: 20
          })
        assert.strictEqual((yield* start()).entries[2]!.version.content, "m2")
        // Writes to another chat allocate ids while this reader's ids remain staged.
        const other = yield* api.CreateChat({ title: "Concurrent id allocations" })
        yield* posted(api.SendMessage({ chatId: other.id, parentSlotId: null, branch: false, content: "Other chat" }))
        if (change) yield* api.RenameChat({ chatId: chat.id, name: "Changed between planned batches" })
        const answer = yield* sendStFile(run.importId, path, bytes.subarray(cut), { part: "1" })
        yield* api.FinishStImport({ importId: run.importId, notSent: [] })
        assert.strictEqual(answer.outcome, change ? "skipped" : "updated")
        if (change) {
          assert.deepStrictEqual(yield* stImportGraph(config.dataDir, chat.id), before)
          assert.deepStrictEqual(yield* refusedIn(api, run.importId), [path])
        } else {
          const graph = yield* stImportGraph(config.dataDir, chat.id)
          assert.strictEqual(new Set(graph.map((row) => row.id)).size, 208)
          assert.strictEqual((yield* start()).entries[2]!.version.content, "m2b")
        }
        assert.strictEqual(yield* staged, 0)
      })
    )

  it.effect("reads current sidebar, planning and causal request data before post-commit summaries are stored", () =>
    Effect.gen(function* () {
      const { api, path, chat, bytes, importId } = yield* imported("Summary window")
      yield* api.GetShellLibrary()
      const reader = yield* Reader
      const writer = yield* Writer
      const userId = (yield* api.Whoami()).id
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      const original = reader.StImportChatSummaries
      const hook = vi
        .spyOn(reader, "StImportChatSummaries")
        .mockImplementation((input) =>
          Effect.andThen(Deferred.succeed(entered, undefined), Effect.andThen(Deferred.await(release), original(input)))
        )
      yield* Effect.addFinalizer(() => Effect.sync(() => hook.mockRestore()))
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const sending = yield* Effect.forkScoped(sendStFile(importId, path, bytes))
      yield* Deferred.await(entered)
      assert.strictEqual(yield* staged, 0)
      const rows = yield* entries(api, chat.id)
      assert.lengthOf(rows, 8)
      const cached = yield* reader.ShellLibrary({ userId })
      const computed = yield* reader.ShellLibrary({ userId, recompute: true })
      assert.deepStrictEqual({ ...cached, fresh: [] }, { ...computed, fresh: [] })
      const record = (yield* reader.StImportSources({ userId })).chats.find((r) => r.source === path)!
      const next = yield* reader.StImportPlanBatch({
        userId,
        recordId: record.recordId,
        branch: false,
        parent: null,
        carry: null,
        matching: true,
        strict: false,
        messagesJson: JSON.stringify(
          Array.from({ length: 8 }, (_, i) => ({
            user: i % 2 === 1,
            hidden: false,
            speaker: null,
            selected: 0,
            versions: (i === 2 ? ["m2", "m2b"] : [`m${i}`]).map((content) => ({
              content,
              reasoning: null,
              at: Date.UTC(2025, 0, 1, 10, i)
            }))
          }))
        ),
        firstIndex: 0,
        detailLimit: 0,
        digest: "",
        overlayJson: null,
        virtualPrefix: "virtual:window:",
        track: false
      })
      assert.strictEqual(next.counts.unchanged, 8)
      assert.strictEqual(next.counts.newMessages, 0)
      // A stale sidebar cache must not name an automatic chat using its old cast.
      yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE chats SET title = '' WHERE id = ?", params: [chat.id] },
        { sql: "UPDATE fork_summaries SET cast_json = '[]', stamp = -1 WHERE chat_id = ?", params: [chat.id] }
      ])
      const found = yield* reader.SearchMessages({ userId, text: "m7", cursor: null, limit: 200 })
      assert.strictEqual(found.hits.find((hit) => hit.chatId === chat.id)!.chatName, "Alice")
      for (const [parent, future] of [
        [rows[1]!, true],
        [rows[7]!, false]
      ] as const) {
        const target = yield* writer.AppendMessage({
          userId,
          chatId: chat.id,
          parentSlotId: parent.slotId,
          branch: true,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "model",
            content: "",
            status: "generating",
            macroMode: "verbatim",
            origin: "generated"
          }),
          commitDraft: null
        })
        const { snapshot } = yield* reader.AssembleContext({
          userId,
          chatId: chat.id,
          slotId: target.slotId,
          versionId: target.version.id,
          now: Date.UTC(2026, 0, 1),
          timeZone: "UTC",
          frozen: null
        })
        const sent = JSON.stringify((JSON.parse(snapshot) as ContextSnapshot).request)
        assert.include(sent, "m1")
        if (future) assert.notInclude(sent, "m7")
        else assert.include(sent, "m7")
      }
      yield* Deferred.succeed(release, undefined)
      assert.strictEqual((yield* Fiber.join(sending)).outcome, "updated")
      yield* api.FinishStImport({ importId, notSent: [] })
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

  for (const [kind, change] of changes)
    it.effect(`rechecks the stamp after staging an unchanged prefix, racing ${kind}`, () =>
      Effect.gen(function* () {
        const { api, path, chat, bytes, importId } = yield* imported(`Staged race ${kind}`)
        const cut = bytes.indexOf(10, bytes.indexOf(10, bytes.indexOf(10) + 1) + 1) + 1
        yield* sendFile(importId, path, bytes.subarray(0, cut), { part: "0", last: "0" })
        assert.strictEqual(yield* staged, 1)
        yield* change(api, chat.id)
        const graph = yield* stImportGraph(config.dataDir, chat.id)
        const response = yield* sendFile(importId, path, bytes.subarray(cut), { part: "1", last: "1" })
        assert.strictEqual(response.status, 200)
        assert.strictEqual(
          (yield* Effect.map(
            Effect.promise(() => response.json()),
            Schema.decodeUnknownSync(StFileResult)
          )).outcome,
          "skipped"
        )
        yield* api.FinishStImport({ importId, notSent: [] })
        assert.deepStrictEqual(yield* refusedIn(api, importId), [path])
        assert.deepStrictEqual(yield* stImportGraph(config.dataDir, chat.id), graph)
        assert.strictEqual(yield* staged, 0)
      })
    )

  it.effect("certifies an image-only amendment that changes the matcher's local-history flag", () =>
    Effect.gen(function* () {
      const { api, path, chat, bytes, importId } = yield* imported("Image-only amendment")
      const row = (yield* entries(api, chat.id))[1]!
      const userId = (yield* api.Whoami()).id
      const mediaId = yield* (yield* Writer).RecordMessageImage({
        userId,
        media: {
          sha256: "e".repeat(64) as never,
          mime: "image/png",
          byteSize: 16,
          width: 1,
          height: 1
        }
      })
      const before = (yield* stamps(api))[chat.id]
      yield* api.AmendVersion({
        versionId: row.version.id,
        content: row.version.content,
        images: [{ mediaId }],
        expectedRowVersion: row.version.rowVersion
      })
      assert.notStrictEqual((yield* stamps(api))[chat.id], before)
      assert.strictEqual((yield* sendStFile(importId, path, bytes)).outcome, "skipped")
      yield* api.FinishStImport({ importId, notSent: [] })
    })
  )

  it.effect("refuses a known-stale file before staging any of its parts", () =>
    Effect.gen(function* () {
      const { api, path, chat, bytes, importId } = yield* imported("Already stale")
      yield* api.RenameChat({ chatId: chat.id, name: "Changed before the file arrived" })
      yield* fixtureSql(config.dataDir, [
        { sql: "CREATE TABLE stale_stage_probe (n INTEGER)" },
        {
          sql: "CREATE TRIGGER stale_stage_probe_insert AFTER INSERT ON st_import_stage BEGIN INSERT INTO stale_stage_probe VALUES (1); END"
        }
      ])
      yield* Effect.gen(function* () {
        assert.strictEqual((yield* sendStFile(importId, path, bytes)).outcome, "skipped")
        const [rows] = yield* fixtureSql(config.dataDir, [{ sql: "SELECT count(*) AS n FROM stale_stage_probe" }], {
          readOnly: true
        })
        assert.strictEqual(rows![0]!.n, 0)
        yield* api.FinishStImport({ importId, notSent: [] })
      }).pipe(
        Effect.ensuring(
          fixtureSql(config.dataDir, [
            { sql: "DROP TRIGGER IF EXISTS stale_stage_probe_insert" },
            { sql: "DROP TABLE IF EXISTS stale_stage_probe" }
          ]).pipe(Effect.ignore)
        )
      )
    })
  )

  it.effect("takes BOM, CRLF, Unicode and a trailing newline identically across part boundaries", () =>
    Effect.gen(function* () {
      const { api, path, chat, importId } = yield* imported("Encoded")
      yield* api.CancelStImport({ importId })
      const text = new TextDecoder().decode(lines(8)).replaceAll("m7", "漣 🌊 m7")
      const bytes = new TextEncoder().encode("\uFEFF" + text.replaceAll("\n", "\r\n") + "\r\n")
      const plan = yield* check(api, new Map([[path, bytes]]))
      const run = yield* api.StartStImport({ unsupported: [], plan: { planId: plan.planId, skip: [] } })
      yield* sendStFile(run.importId, "characters/Alice.png", CARD)
      assert.strictEqual((yield* sendStFile(run.importId, path, bytes, {}, 450)).outcome, "updated")
      yield* api.FinishStImport({ importId: run.importId, notSent: [] })
      assert.deepStrictEqual(yield* refusedIn(api, run.importId), [])
      assert.strictEqual((yield* entries(api, chat.id)).at(-1)!.version.content, "漣 🌊 m7")
    })
  )

  it.effect("never stages out-of-order or duplicate parts twice", () =>
    Effect.gen(function* () {
      const { api, path, chat, bytes, importId } = yield* imported("Parts order")
      const cut = bytes.indexOf(10, bytes.indexOf(10, bytes.indexOf(10) + 1) + 1) + 1
      const part = (seq: number, body: Uint8Array, last: boolean) =>
        Effect.gen(function* () {
          const response = yield* sendFile(importId, path, body, { part: String(seq), last: last ? "1" : "0" })
          return yield* Effect.map(
            Effect.promise(() => response.json()),
            Schema.decodeUnknownSync(StFileResult)
          )
        })
      assert.strictEqual((yield* part(1, bytes.subarray(cut), true)).outcome, "restart")
      assert.strictEqual(yield* staged, 0)
      assert.strictEqual((yield* part(0, bytes.subarray(0, cut), false)).outcome, "continue")
      assert.strictEqual((yield* part(2, bytes.subarray(cut), true)).outcome, "restart")
      assert.strictEqual(yield* staged, 1)
      assert.strictEqual((yield* part(1, bytes.subarray(cut), true)).outcome, "updated")
      assert.strictEqual((yield* part(1, bytes.subarray(cut), true)).outcome, "restart")
      yield* api.FinishStImport({ importId, notSent: [] })
      assert.lengthOf(yield* entries(api, chat.id), 8)
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

  it.effect("holds a new chat file until its last part, including on Stop", () =>
    Effect.gen(function* () {
      const { api, path, bytes, plan, importId } = yield* imported("New file base")
      yield* api.CancelStImport({ importId })
      const freshPath = "chats/Alice/New atomic.jsonl"
      const next = yield* check(
        api,
        new Map([
          [path, bytes],
          [freshPath, bytes]
        ])
      )
      assert.strictEqual(next.status, "done")
      const run = yield* api.StartStImport({ unsupported: [], plan: { planId: next.planId, skip: [] } })
      yield* sendStFile(run.importId, "characters/Alice.png", CARD)
      const cut = bytes.indexOf(10, bytes.indexOf(10, bytes.indexOf(10) + 1) + 1) + 1
      yield* sendFile(run.importId, freshPath, bytes.subarray(0, cut), { part: "0", last: "0" })
      assert.isFalse((yield* api.ListChats({ limit: 200, before: null })).some((c) => c.title.includes("New atomic")))
      assert.strictEqual(yield* staged, 1)
      yield* api.CancelStImport({ importId: run.importId })
      assert.strictEqual(yield* staged, 0)
      assert.isFalse((yield* api.ListChats({ limit: 200, before: null })).some((c) => c.title.includes("New atomic")))
      assert.strictEqual(plan.status, "done")
    })
  )

  /** A new 40-message chat checked, then a confirmed run of that check started. */
  const freshRun = (title: string) =>
    Effect.gen(function* () {
      const { api, importId } = yield* imported(`${title} base`)
      yield* api.CancelStImport({ importId })
      const path = `chats/Alice/${title}.jsonl`
      const bytes = lines(40)
      const plan = yield* check(api, new Map([[path, bytes]]))
      assert.strictEqual(plan.status, "done")
      const run = yield* api.StartStImport({ unsupported: [], plan: { planId: plan.planId, skip: [] } })
      yield* sendStFile(run.importId, "characters/Alice.png", CARD)
      return { api, path, bytes, importId: run.importId }
    })

  for (const action of ["open and continue", "bin", "supersede"] as const)
    it.effect(`keeps a partially written new chat coherent when another tab chooses to ${action}`, () =>
      Effect.gen(function* () {
        const title = `Writing ${action}`
        const { api, path, bytes, importId } = yield* freshRun(title)
        const imports = yield* StImports
        const writer = yield* Writer
        const reader = yield* Reader
        const userId = (yield* api.Whoami()).id
        const entered = Deferred.makeUnsafe<void>()
        const release = Deferred.makeUnsafe<void>()
        const original = writer.StImportCommitBatch
        let first = true
        const hook = vi.spyOn(writer, "StImportCommitBatch").mockImplementation((input) =>
          original(input).pipe(
            Effect.tap(() => {
              if (!first) return Effect.void
              first = false
              return Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release))
            })
          )
        )
        const pause = vi.spyOn(imports, "withFilesPaused")
        yield* Effect.addFinalizer(() => Effect.sync(() => pause.mockRestore()))
        yield* Effect.addFinalizer(() => Effect.sync(() => hook.mockRestore()))
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        const sending = yield* Effect.forkScoped(sendStFile(importId, path, bytes, {}, 400))
        yield* Deferred.await(entered)
        const chat = (yield* api.ListChats({ limit: 200, before: null })).find(
          (c) => c.title === `${title} (import unfinished)`
        )!
        assert.isDefined(chat)
        const partial = yield* entries(api, chat.id)
        assert.isAbove(partial.length, 0)
        assert.isBelow(partial.length, 40)
        // Visible unfinished chats expose only their committed messages on every read surface.
        assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).title, `${title} (import unfinished)`)
        const search = yield* reader.SearchMessages({ userId, text: "m0", cursor: null, limit: 200 })
        assert.isTrue(search.hits.some((hit) => hit.chatId === chat.id && hit.chatName.includes("import unfinished")))
        const exported = yield* post("/library/chat-export", {
          chatId: chat.id,
          forkId: null,
          scope: "branch",
          format: "txt"
        })
        assert.strictEqual(exported.status, 200)
        const text = yield* Effect.promise(() => exported.text())
        assert.include(text, "m0")
        assert.notInclude(text, "m39")
        const cached = yield* reader.ShellLibrary({ userId })
        const computed = yield* reader.ShellLibrary({ userId, recompute: true })
        // The sidebar deliberately defers a growing unfinished chat's expensive walk;
        // its marker remains, and an explicit recomputation sees only committed rows.
        assert.strictEqual(
          cached.forks.find((fork) => fork.sourceChatId === chat.id)!.chat.title,
          `${title} (import unfinished)`
        )
        assert.strictEqual(computed.forks.find((fork) => fork.sourceChatId === chat.id)!.messages, partial.length)
        let continued: string | undefined
        const replacement =
          action === "supersede" ? yield* Effect.forkScoped(api.StartStImport({ unsupported: [] })) : null
        if (action === "open and continue") {
          continued = (yield* posted(
            api.SendMessage({
              chatId: chat.id,
              parentSlotId: partial.at(-1)!.slotId,
              branch: false,
              content: "Continued during import"
            })
          )).entry.slotId
        } else if (action === "bin") yield* api.DeleteChat({ chatId: chat.id })
        else
          yield* Effect.promise(() =>
            vi.waitFor(() => assert.isTrue(pause.mock.calls.some(([, id]) => id === importId)))
          )
        yield* Deferred.succeed(release, undefined)
        const answer = yield* Fiber.join(sending)
        if (action === "open and continue") {
          assert.strictEqual(answer.outcome, "added")
          assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId, continued)
          assert.strictEqual(new Set((yield* stImportGraph(config.dataDir, chat.id)).map((row) => row.id)).size, 41)
          yield* api.FinishStImport({ importId, notSent: [] })
        } else if (replacement !== null) {
          const next = yield* Fiber.join(replacement)
          assert.strictEqual(answer.outcome, "added")
          const previous = yield* api.GetStImport({ importId })
          assert.strictEqual(previous.job.status, "interrupted")
          assert.strictEqual(previous.report!.counts.chat?.added, 1)
          assert.strictEqual((yield* sendFile(importId, "characters/Alice.png", CARD)).status, 404)
          yield* sendStFile(next.importId, "characters/Alice.png", CARD)
          assert.strictEqual((yield* sendStFile(next.importId, path, bytes)).outcome, "unchanged")
          yield* api.FinishStImport({ importId: next.importId, notSent: [] })
          assert.lengthOf(yield* entries(api, chat.id), 40)
        } else {
          assert.strictEqual(answer.outcome, "failed")
          assert.strictEqual(
            answer.message,
            "This chat stopped part way and shows as unfinished. Import it again to finish it."
          )
          assert.strictEqual(
            new Set((yield* stImportGraph(config.dataDir, chat.id)).map((row) => row.id)).size,
            partial.length
          )
          assert.isFalse((yield* api.ListChats({ limit: 200, before: null })).some((c) => c.id === chat.id))
          yield* api.CancelStImport({ importId })
        }
        assert.strictEqual(yield* staged, 0)
      })
    )

  it.effect("writes a confirmed new chat batch by batch, then finishes it", () =>
    Effect.gen(function* () {
      const { api, path, bytes, importId } = yield* freshRun("Bounded")
      // Small parts: many staged batches, each written in a transaction of its own.
      assert.strictEqual((yield* sendStFile(importId, path, bytes, {}, 400)).outcome, "added")
      yield* api.FinishStImport({ importId, notSent: [] })
      const chat = (yield* api.ListChats({ limit: 200, before: null })).find((c) => c.title === "Bounded")!
      const rows = yield* entries(api, chat.id)
      assert.deepStrictEqual(
        rows.map((row) => row.version.content),
        Array.from({ length: 40 }, (_, i) => `m${i}`)
      )
      assert.lengthOf(yield* api.ListVersions({ slotId: rows[2]!.slotId }), 2)
      assert.strictEqual(yield* staged, 0)
    })
  )

  it.effect("leaves a new chat that failed part way unfinished, for the next import to finish", () =>
    Effect.gen(function* () {
      const { api, path, bytes, importId } = yield* freshRun("Part way")
      // A write failing at message 30, after earlier batches went in.
      yield* fixtureSql(config.dataDir, [
        {
          sql: "CREATE TRIGGER part_way_probe BEFORE INSERT ON version_texts WHEN NEW.content = 'm30' BEGIN SELECT RAISE(ABORT, 'probe'); END"
        }
      ])
      const failed = yield* Effect.exit(
        sendStFile(importId, path, bytes, {}, 400).pipe(
          Effect.ensuring(
            fixtureSql(config.dataDir, [{ sql: "DROP TRIGGER IF EXISTS part_way_probe" }]).pipe(Effect.ignore)
          )
        )
      )
      assert.isTrue(Exit.isSuccess(failed), "a partial write must return its unfinished explanation")
      if (Exit.isFailure(failed)) return
      assert.strictEqual(failed.value.outcome, "failed")
      assert.strictEqual(
        failed.value.message,
        "This chat stopped part way and shows as unfinished. Import it again to finish it."
      )
      assert.isTrue(
        (yield* api.GetStImportReport({ importId })).issues.some((issue) => issue.code === "st.chat_unfinished")
      )
      yield* api.CancelStImport({ importId }).pipe(Effect.ignore)
      const listed = yield* api.ListChats({ limit: 200, before: null })
      // Shown as unfinished, with the batches written before the failure.
      const chat = listed.find((c) => c.title === "Part way (import unfinished)")
      assert.isDefined(chat, JSON.stringify(listed.map((c) => c.title)))
      if (chat === undefined) return
      const partial = (yield* entries(api, chat.id)).length
      assert.isAbove(partial, 0)
      assert.isBelow(partial, 30)
      assert.strictEqual(yield* staged, 0)
      const resumePlan = yield* check(api, new Map([[path, bytes]]))
      assert.strictEqual(resumePlan.files[0]!.target, "unfinished")
      const again = yield* api.StartStImport({ unsupported: [], plan: { planId: resumePlan.planId, skip: [] } })
      yield* sendStFile(again.importId, "characters/Alice.png", CARD)
      yield* sendStFile(again.importId, path, bytes)
      yield* api.FinishStImport({ importId: again.importId, notSent: [] })
      assert.isTrue(
        (yield* api.GetStImportReport({ importId: again.importId })).issues.some(
          (i) => i.code === "st.unfinished" && i.path === path
        )
      )
      assert.lengthOf(yield* entries(api, chat.id), 40)
      assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).title, "Part way")
      const control = yield* importStFolder(
        new Map([
          ["characters/Alice.png", CARD],
          ["chats/Alice/Part way control.jsonl", bytes]
        ]),
        { checked: true, partBytes: 400 }
      )
      const controlChat = (yield* control.api.ListChats({ limit: 200, before: null })).find(
        (c) => c.title === "Part way control"
      )!
      const semanticState = (id: string) =>
        fixtureSql(
          config.dataDir,
          [
            {
              sql: `SELECT s.depth, v.ordinal, v.writer, v.speaker_entity_id, v.status, v.origin, v.macro_mode,
            v.content, v.reasoning, v.reply_sections, v.recorded_model_json, v.recorded_generation_json,
            v.cast_json, v.presence_json, v.created_at, v.updated_at, s.context_excluded,
            s.deleted_at, s.purged_at, v.id = s.selected_version_id AS selected
          FROM slots s JOIN version_records v ON v.slot_id = s.id WHERE s.chat_id = ? ORDER BY s.depth, v.ordinal`,
              params: [id]
            },
            {
              sql: "SELECT e.key, e.value_json, e.origin, s.depth FROM state_events e LEFT JOIN slots s ON s.id = e.slot_id WHERE e.chat_id = ? ORDER BY e.seq",
              params: [id]
            },
            {
              sql: "SELECT s.depth AS tip, f.deleted_at, f.name FROM forks f LEFT JOIN slots s ON s.id = f.tip_slot_id WHERE f.chat_id = ?",
              params: [id]
            }
          ],
          { readOnly: true }
        )
      assert.deepStrictEqual(yield* semanticState(chat.id), yield* semanticState(controlChat.id))
    })
  )

  it.effect("Stop lets a new chat already being written finish before ending the upload", () =>
    Effect.gen(function* () {
      const { api, path, bytes, importId } = yield* freshRun("Stop while writing")
      const writer = yield* Writer
      const imports = yield* StImports
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      const stopHook = vi.spyOn(imports, "withFilesPaused")
      const original = writer.StImportCommitBatch
      let first = true
      const hook = vi.spyOn(writer, "StImportCommitBatch").mockImplementation((input) =>
        original(input).pipe(
          Effect.tap(() => {
            if (!first) return Effect.void
            first = false
            return Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release))
          })
        )
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => hook.mockRestore()))
      yield* Effect.addFinalizer(() => Effect.sync(() => stopHook.mockRestore()))
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const sending = yield* Effect.forkScoped(sendStFile(importId, path, bytes, {}, 400))
      yield* Deferred.await(entered)
      const chat = (yield* api.ListChats({ limit: 200, before: null })).find(
        (c) => c.title === "Stop while writing (import unfinished)"
      )!
      assert.isDefined(chat)
      const cancelling = yield* Effect.forkScoped(api.CancelStImport({ importId }))
      yield* Effect.promise(() =>
        vi.waitFor(() => assert.isTrue(stopHook.mock.calls.some(([, id]) => id === importId)))
      )
      yield* Deferred.succeed(release, undefined)
      const answer = yield* Fiber.join(sending)
      yield* Fiber.join(cancelling)
      assert.strictEqual(answer.outcome, "added")
      assert.lengthOf(yield* entries(api, chat.id), 40)
      assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).title, "Stop while writing")
      const detail = yield* api.GetStImport({ importId })
      assert.strictEqual(detail.job.status, "cancelled")
      assert.strictEqual(detail.report!.counts.chat!.added, 1)
      assert.strictEqual(yield* staged, 0)
    })
  )

  it.effect(
    "reaps an abandoned upload and its staged rows without another import or restart",
    () =>
      Effect.gen(function* () {
        const { api, path, bytes, importId } = yield* imported("Abandoned")
        const cut = bytes.indexOf(10, bytes.indexOf(10, bytes.indexOf(10) + 1) + 1) + 1
        yield* sendFile(importId, path, bytes.subarray(0, cut), { part: "0", last: "0" })
        assert.strictEqual(yield* staged, 1)
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000)
        yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()))
        // The production sweep runs once a minute. Move idle time, retaining its real schedule.
        yield* Effect.sleep(61_000)
        assert.strictEqual((yield* api.GetStImport({ importId })).job.status, "interrupted")
        assert.strictEqual(yield* staged, 0)
        assert.notStrictEqual(
          (yield* sendFile(importId, path, bytes.subarray(cut), { part: "1", last: "1" })).status,
          200
        )
      }),
    { tags: ["slow"], timeout: 90_000 }
  )

  it.effect("a completed checked upload still accepts its explicit pending card-link choice", () =>
    Effect.gen(function* () {
      const path = "chats/Renamed/Link choice.jsonl"
      const bytes = lines(6)
      const { api, importId, report } = yield* importStFolder(
        new Map([
          ["characters/One.png", CARD],
          ["characters/Two.png", CARD],
          [path, bytes]
        ]),
        { checked: true }
      )
      const choice = report.links.find((choice) => choice.path === path)!
      assert.isDefined(choice)
      const result = yield* sendStFile(importId, path, bytes, { card: choice.candidates[0]!.entityId })
      assert.strictEqual(result.outcome, "added")
      const detail = yield* api.GetStImport({ importId })
      assert.isFalse(detail.report!.links.some((choice) => choice.path === path))
      assert.strictEqual(detail.report!.counts.chat!.added, 1)
      assert.strictEqual(yield* staged, 0)
      const userId = (yield* api.Whoami()).id
      const late = yield* Effect.exit(
        (yield* Writer).StImportStage({
          userId,
          lease: importId,
          path,
          seq: 0,
          batchJson: JSON.stringify({ messagesJson: "[]", speakers: {} })
        })
      )
      assert.isTrue(Exit.isFailure(late))
    })
  )

  it.effect("conservatively refuses a change on another fork of the same chat", () =>
    Effect.gen(function* () {
      const { api, path, chat, bytes, importId } = yield* imported("Independent fork")
      yield* api.CancelStImport({ importId })
      const rows = yield* entries(api, chat.id)
      const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: null, atSlotId: rows[2]!.slotId })
      const plan = yield* check(api, new Map([[path, bytes]]))
      const run = yield* api.StartStImport({ unsupported: [], plan: { planId: plan.planId, skip: [] } })
      yield* sendStFile(run.importId, "characters/Alice.png", CARD)
      yield* posted(
        api.SendMessage({
          chatId: chat.id,
          forkId: fork.id,
          parentSlotId: rows[2]!.slotId,
          branch: false,
          content: "Independent branch"
        })
      )
      assert.strictEqual((yield* sendStFile(run.importId, path, bytes)).outcome, "skipped")
      yield* api.FinishStImport({ importId: run.importId, notSent: [] })
      assert.deepStrictEqual(yield* refusedIn(api, run.importId), [path])
    })
  )

  it.effect(
    "reaps an abandoned card-link upload after its job has already finished",
    () =>
      Effect.gen(function* () {
        const path = "chats/Renamed/Abandoned link.jsonl"
        const bytes = lines(6)
        const { api, importId, report } = yield* importStFolder(
          new Map([
            ["characters/One.png", CARD],
            ["characters/Two.png", CARD],
            [path, bytes]
          ]),
          { checked: true }
        )
        const choice = report.links.find((choice) => choice.path === path)!
        const cut = bytes.indexOf(10, bytes.indexOf(10, bytes.indexOf(10) + 1) + 1) + 1
        yield* sendFile(importId, path, bytes.subarray(0, cut), {
          part: "0",
          last: "0",
          card: choice.candidates[0]!.entityId
        })
        assert.strictEqual(yield* staged, 1)
        assert.strictEqual((yield* api.GetStImport({ importId })).job.status, "complete")
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000)
        yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()))
        yield* Effect.sleep(61_000)
        assert.strictEqual(yield* staged, 0)
        assert.strictEqual((yield* api.GetStImport({ importId })).job.status, "complete")
      }),
    { tags: ["slow"], timeout: 90_000 }
  )

  it.effect("a late staged write after Finish is fenced, so finished jobs cannot accumulate rows", () =>
    Effect.gen(function* () {
      const { api, path, importId } = yield* imported("Late finish")
      const userId = (yield* api.Whoami()).id
      yield* api.FinishStImport({ importId, notSent: [] })
      const late = yield* Effect.exit(
        (yield* Writer).StImportStage({
          userId,
          lease: importId,
          path,
          seq: 0,
          batchJson: JSON.stringify({ messagesJson: "[]", speakers: {} })
        })
      )
      assert.isTrue(Exit.isFailure(late))
      assert.strictEqual(yield* staged, 0)
    })
  )

  it.effect("bounds a staged file and releases it on a size refusal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { path, chat, bytes, importId } = yield* imported("Budget")
        const cut = bytes.indexOf(10, bytes.indexOf(10, bytes.indexOf(10) + 1) + 1) + 1
        yield* sendFile(importId, path, bytes.subarray(0, cut), { part: "0", last: "0" })
        assert.strictEqual(yield* staged, 1)
        const graph = yield* stImportGraph(config.dataDir, chat.id)
        const imports = yield* StImports
        const original = imports.handlers.get("chat")!
        // Put the live file at its resource boundary without allocating 256 MiB in a fast test.
        yield* imports.handlers.register({
          id: "chat",
          run: (call) => {
            if (call.session.chat !== null) call.session.chat.stagedChars = 256 * 1024 * 1024
            return original.run(call)
          }
        })
        const response = yield* sendFile(importId, path, bytes.subarray(cut), { part: "1", last: "1" })
        assert.strictEqual(response.status, 200)
        const answer = yield* Effect.map(
          Effect.promise(() => response.json()),
          Schema.decodeUnknownSync(StFileResult)
        )
        assert.strictEqual(answer.outcome, "failed")
        assert.strictEqual(answer.message, "This chat is too large to import. Not imported.")
        assert.strictEqual(yield* staged, 0)
        assert.deepStrictEqual(yield* stImportGraph(config.dataDir, chat.id), graph)
      })
    )
  )

  for (const action of ["cancel", "finish", "restart", "bad last part"] as const)
    it.effect(`releases staged rows on ${action}`, () =>
      Effect.gen(function* () {
        const { api, path, bytes, importId } = yield* imported(`Cleanup ${action}`)
        const cut = bytes.indexOf(10, bytes.indexOf(10, bytes.indexOf(10) + 1) + 1) + 1
        assert.strictEqual(
          (yield* sendFile(importId, path, bytes.subarray(0, cut), { part: "0", last: "0" })).status,
          200
        )
        assert.strictEqual(yield* staged, 1)
        if (action === "cancel") yield* api.CancelStImport({ importId })
        else if (action === "finish") yield* api.FinishStImport({ importId, notSent: [] })
        else if (action === "restart") {
          // Start again with just the header, holding no parsed message batch yet.
          yield* sendFile(importId, path, bytes.subarray(0, bytes.indexOf(10) + 1), { part: "0", last: "0" })
        } else yield* sendFile(importId, path, new TextEncoder().encode("\n"), { part: "1", last: "1" })
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
        const fromFile = new Set(
          added.filter((row) => row.content === "m6" || row.content === "m7").map((row) => row.id)
        )
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
