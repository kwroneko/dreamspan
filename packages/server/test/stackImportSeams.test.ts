// Imports use the real reader plans and writer batches, with warm LCM readers and live Auto
// handles. Staging is bookkeeping; publication is foreign story content.
import { assert } from "@effect/vitest"
import { vi } from "vitest"
import { Deferred, Effect, Exit, Fiber } from "effect"
import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest, PAIRS_8K } from "./support/lcmHarness.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder, sendStFile } from "./support/stUpload.ts"

const CARD = card("Alice", "m0")
const path = "chats/Alice/Seam.jsonl"
const lines = (count: number, selected = 0) =>
  jsonl([
    header({ note_prompt: "Original imported note." }),
    ...Array.from({ length: count }, (_, i) =>
      message({
        name: i % 2 ? "Sam" : "Alice",
        user: i % 2 === 1,
        mes:
          i === 2
            ? ["Original summary input.", "Changed summary input."][selected]!
            : `m${i}. ` + "The synthetic road ran on. ".repeat(12),
        minute: i,
        ...(i === 2 ? { swipes: ["Original summary input.", "Changed summary input."], swipeId: selected } : {})
      })
    )
  ])

lcmTest(
  "planned re-imports invalidate kept summary facts and fence Auto only on publication",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 0 })
      yield* importStFolder(
        new Map([
          ["characters/Alice.png", CARD],
          [path, lines(60)]
        ]),
        { checked: true }
      )
      const chat = (yield* h.api.ListChats({ limit: 200, before: null })).find((c) => c.title === "Seam")!
      const chatId = chat.id
      const forkId = (yield* h.api.GetChat({ chatId })).currentForkId! as ForkId
      const read = h.reader.ReadPath({
        userId: h.userId,
        chatId,
        forkId,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 200
      })
      const rows = (yield* read).entries
      yield* h.writer.AddStateEvent({
        userId: h.userId,
        chatId,
        forkId,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "lcm.settings", value: { enabled: true, leafInput: 500, leafTarget: 100, ...PAIRS_8K } }
      })
      yield* completeFixture(
        h.dataDir,
        h.writer,
        h.userId,
        chatId,
        rows.slice(0, 6).map((r) => ({ slotId: r.slotId, versionId: r.version.id, amendCount: 0 }))
      )
      const plans = Effect.gen(function* () {
        const leafSlotId = (yield* read).entries.at(-1)!.slotId
        return yield* Effect.all([
          h.reader.PlanSummaries({ userId: h.userId, chatId, forkId, leafSlotId }),
          h.reader.PlanSummaries({ userId: h.userId, chatId, forkId, leafSlotId, reason: "reply" })
        ])
      })
      const compare = Effect.gen(function* () {
        const kept = yield* plans
        yield* fixtureSql(h.dataDir, [{ sql: "UPDATE chats SET lcm_stamp=lcm_stamp+1 WHERE id=?", params: [chatId] }])
        assert.deepStrictEqual(kept, yield* plans)
      })
      yield* plans
      const stamp = Effect.map(
        fixtureSql(h.dataDir, [{ sql: "SELECT lcm_stamp FROM chats WHERE id=?", params: [chatId] }], {
          readOnly: true
        }),
        (rows) => rows[0]![0]!.lcm_stamp as number
      )
      const beforeSelection = yield* stamp
      const markKeys = ["participant.join", "note.activate", "note.deactivate"]
      const marks = () => h.api.GetStateMarks({ chatId, forkId, slotId: rows.at(-1)!.slotId, keys: markKeys })
      const initialMarks = yield* marks()
      assert.isTrue(initialMarks.events.some((e) => e.key === "note.activate" && e.origin === "import"))
      const initialStage = h.writer.StImportStage
      let stagedReads = 0
      const stageHook = vi.spyOn(h.writer, "StImportStage").mockImplementation((input) =>
        initialStage(input).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              if (input.batchJson === null) return
              stagedReads++
              assert.deepStrictEqual(
                yield* marks().pipe(Effect.orDie),
                initialMarks,
                "unpublished staging must add no marker events"
              )
            })
          )
        )
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => stageHook.mockRestore()))
      yield* importStFolder(
        new Map([
          ["characters/Alice.png", CARD],
          [path, lines(60, 1)]
        ]),
        { checked: true, partBytes: 700 }
      )
      stageHook.mockRestore()
      assert.isAbove(stagedReads, 0)
      const publishedMarks = yield* marks()
      // This re-import changes a selected message, not the imported cast/note state.
      assert.deepStrictEqual(publishedMarks, initialMarks)
      const effective = yield* h.reader.StateEventsAt({ userId: h.userId, chatId, forkId, slotId: rows.at(-1)!.slotId })
      assert.deepStrictEqual(
        publishedMarks.events.map((e) => ({ scope: e.scope, data: { key: e.key, value: e.value } })),
        effective.filter((e) => markKeys.includes(e.data.key))
      )
      assert.strictEqual((yield* read).entries[2]!.version.content, "Changed summary input.")
      assert.isAbove(yield* stamp, beforeSelection, "a re-import changing a summarized selection moves the LCM stamp")
      yield* compare
      yield* plans
      // A real Auto admission, deliberately no reply fiber: the guard must be independent of
      // notifications, provider timing or whether a client observes the import.
      const admitted = yield* h.writer.SendOrQueue({
        userId: h.userId,
        chatId,
        forkId,
        parentSlotId: rows.at(-1)!.slotId,
        branch: false,
        kind: "generate",
        content: "",
        speakerEntityId: null,
        replySpeakerEntityId: null,
        direction: null,
        commitDraft: null,
        immediate: true,
        auto: { token: null }
      })
      if (admitted._tag !== "Posted") return assert.fail("expected Auto admission")
      const token = admitted.auto!.token
      const other = yield* h.writer.SendOrQueue({
        userId: h.userId,
        chatId: h.chat.id as ChatId,
        forkId: h.chat.currentForkId!,
        parentSlotId: null,
        branch: false,
        kind: "generate",
        content: "",
        speakerEntityId: null,
        replySpeakerEntityId: null,
        direction: null,
        commitDraft: null,
        immediate: true,
        auto: { token: null }
      })
      if (other._tag !== "Posted") return assert.fail("expected unrelated Auto admission")
      const original = h.writer.StImportStage
      let stages = 0
      const hook = vi.spyOn(h.writer, "StImportStage").mockImplementation((input) =>
        original(input).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              if (input.batchJson === null) return
              stages++
              yield* h.writer.AuthorizeAutoRequest({ userId: h.userId, token, configuration: "" }).pipe(Effect.orDie)
              yield* h.writer
                .AuthorizeAutoRequest({ userId: h.userId, token: other.auto!.token, configuration: "" })
                .pipe(Effect.orDie)
            })
          )
        )
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => hook.mockRestore()))
      const publication = yield* importStFolder(
        new Map([
          ["characters/Alice.png", CARD],
          [path, lines(62, 1)]
        ]),
        { checked: true, partBytes: 700 }
      )
      assert.strictEqual(publication.answers.get(path)?.outcome, "updated", JSON.stringify(publication.report))
      assert.isAbove(stages, 1)
      const authorization = yield* Effect.exit(
        h.writer.AuthorizeAutoRequest({ userId: h.userId, token, configuration: "" })
      )
      assert.isTrue(Exit.isFailure(authorization), "published re-import must fence the live Auto handle")
      yield* h.writer
        .AuthorizeAutoRequest({ userId: h.userId, token: other.auto!.token, configuration: "" })
        .pipe(Effect.orDie)
      yield* compare
      hook.mockRestore()
      // A second confirmed replay exercises retained plans after the first imported changes.
      yield* plans
      yield* importStFolder(
        new Map([
          ["characters/Alice.png", CARD],
          [path, lines(62, 1)]
        ]),
        { checked: true }
      )
      yield* compare
      assert.lengthOf(h.mock.requests(), 0)
    }),
  { timeout: 180_000 }
)

lcmTest(
  "an unfinished new import plans no summaries and drafts only its committed prefix; later batches fence its Auto handle",
  (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 0 })
      yield* importStFolder(new Map([["characters/Alice.png", CARD]]))
      const bytes = lines(40)
      const started = yield* h.api.StartStImportPlan({
        files: [{ path, size: bytes.byteLength, modifiedMs: null, mainChat: null }]
      })
      let checked = started.plan
      while (checked.status === "running") {
        yield* Effect.sleep(10)
        checked = yield* h.api.GetStImportPlan({ planId: checked.planId })
      }
      assert.strictEqual(checked.status, "done")
      const { importId } = yield* h.api.StartStImport({ unsupported: [], plan: { planId: checked.planId, skip: [] } })
      yield* sendStFile(importId, "characters/Alice.png", CARD)
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      const original = h.writer.StImportCommitBatch
      let first = true
      const hook = vi.spyOn(h.writer, "StImportCommitBatch").mockImplementation((input) =>
        original(input).pipe(
          Effect.tap(() => {
            if (!first) return Effect.void
            first = false
            return Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release))
          })
        )
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => hook.mockRestore()))
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      // Confirmed new chats stage the whole upload, then publish in bounded batches too.
      const sending = yield* sendStFile(importId, path, bytes, {}, 700).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const chat = (yield* h.api.ListChats({ limit: 200, before: null })).find(
        (c) => c.title === "Seam (import unfinished)"
      )!
      const current = yield* h.api.GetChat({ chatId: chat.id })
      const forkId = current.currentForkId!
      const prefix = yield* h.api.ReadPath({
        chatId: chat.id,
        forkId,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 200
      })
      assert.isAbove(prefix.entries.length, 0)
      assert.isBelow(prefix.entries.length, 40)
      const plan = yield* h.reader.PlanSummaries({
        userId: h.userId,
        chatId: chat.id,
        forkId,
        leafSlotId: current.activeLeafSlotId!,
        reason: "reply"
      })
      assert.lengthOf(plan.chunks, 0, "unfinished imports start with LCM off")
      assert.strictEqual((yield* h.api.GetChat({ chatId: chat.id })).title, "Seam (import unfinished)")
      const admitted = yield* h.writer.SendOrQueue({
        userId: h.userId,
        chatId: chat.id,
        forkId,
        parentSlotId: current.activeLeafSlotId,
        branch: false,
        kind: "generate",
        content: "",
        speakerEntityId: null,
        replySpeakerEntityId: null,
        direction: null,
        commitDraft: null,
        immediate: true,
        auto: { token: null }
      })
      if (admitted._tag !== "Posted") return assert.fail("expected Auto admission")
      yield* Deferred.succeed(release, undefined)
      assert.strictEqual((yield* Fiber.join(sending)).outcome, "added")
      yield* h.api.FinishStImport({ importId, notSent: [] })
      const error = yield* h.writer
        .AuthorizeAutoRequest({ userId: h.userId, token: admitted.auto!.token, configuration: "" })
        .pipe(Effect.flip)
      assert.strictEqual(error._tag, "AutoRefused")
      assert.strictEqual((yield* h.api.GetChat({ chatId: chat.id })).title, "Seam")
    }),
  { timeout: 180_000 }
)
