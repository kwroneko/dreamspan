import { assert, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { NewVersion } from "@rp/shared/chat.ts"
import { textField } from "@rp/shared/editing.ts"
import { Writer } from "../../src/db/Database.ts"
import { client, posted, post, testConfig, withServer, takenFrom, typeInto } from "../support/config.ts"
import { FakeIndexedDb } from "./fakeIndexedDb.ts"
const idb = new FakeIndexedDb()
globalThis.indexedDB = idb as unknown as IDBFactory
const { keepCopy, makeCopy, copiesOfUser, flushCopies } = await import("../../../client/src/features/editor/backup.ts")
const { EditorStore } = await import("../../../client/src/features/editor/store.ts")

it.live("a send must actually store the text it commits", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateChat({ title: "Mismatch" })
    const d = yield* typeInto(api, chat.id, null, "ONLY ORIGINAL TEXT 59184")
    const sent = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "DIFFERENT PAYLOAD",
        composer: takenFrom(d)
      })
    )
    const after = yield* api.OpenComposer({ chatId: chat.id, forkId: sent.chat.currentForkId })

    assert.strictEqual(after.content, d.content)
  }).pipe(Effect.scoped, withServer(testConfig()))
)

it.live("a send in B must not commit the draft in A", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const a = yield* api.CreateChat({ title: "A" })
    const b = yield* api.CreateChat({ title: "B" })
    const d = yield* typeInto(api, a.id, null, "CHAT A TEXT")
    yield* posted(
      api.SendMessage({
        chatId: b.id,
        parentSlotId: null,
        branch: false,
        content: "CHAT A TEXT",
        composer: takenFrom(d)
      })
    )
    const after = yield* api.OpenComposer({ chatId: a.id, forkId: null })
    assert.strictEqual(after.content, d.content)
  }).pipe(Effect.scoped, withServer(testConfig()))
)

for (const kind of ["message", "generate"] as const) {
  it.live(`a queued ${kind} commits only its stored text in its own chat`, () =>
    Effect.gen(function* () {
      const api = yield* client()
      const user = yield* api.Whoami()
      const writer = yield* Writer
      const chat = yield* api.CreateChat({ title: "Queued binding" })
      const parent = yield* writer.AppendMessage({
        userId: user.id,
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "model",
          content: "",
          status: "generating",
          macroMode: "verbatim",
          origin: "generated"
        })
      })
      const draft = yield* typeInto(api, chat.id, parent.forkId, "Text the queue does not store")
      const result = yield* kind === "message"
        ? api.SendMessage({
            chatId: chat.id,
            parentSlotId: parent.slotId,
            branch: false,
            content: "Stored message",
            composer: takenFrom(draft)
          })
        : api.Generate({
            chatId: chat.id,
            parentSlotId: parent.slotId,
            branch: false,
            direction: "Stored direction",
            composer: takenFrom(draft)
          })
      assert.strictEqual(result._tag, "Queued")
      const after = yield* api.OpenComposer({ chatId: chat.id, forkId: parent.forkId })
      assert.strictEqual(after.content, draft.content)
      assert.strictEqual(after.session, draft.session)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
}

it.live("import advancement must carry the empty-root composer", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const user = yield* api.Whoami()
    const w = yield* Writer
    const chat = yield* api.CreateChat({ title: "Import target" })
    const d = yield* typeInto(api, chat.id, null, "ROOT DRAFT LEFT BEHIND")
    yield* w.StImportBegin({ userId: user.id, importId: "synthetic-run" })
    const start = yield* w.StImportStartChat({
      userId: user.id,
      source: "synthetic.jsonl",
      title: "Synthetic",
      createdAt: 1,
      chatId: chat.id,
      lease: "synthetic-run"
    })
    yield* w.StImportMessages({
      userId: user.id,
      chatId: chat.id,
      recordId: start.recordId,
      lease: "synthetic-run",
      parentSlotId: null,
      advanceLeaf: true,
      strict: false,
      matching: false,
      speakers: {},
      messagesJson: JSON.stringify([
        {
          user: true,
          hidden: false,
          speaker: null,
          selected: 0,
          versions: [{ content: "Imported message", at: 1, reasoning: null }]
        }
      ])
    })
    const atLeaf = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
    assert.strictEqual(atLeaf.id, d.id)
  }).pipe(Effect.scoped, withServer(testConfig()))
)

it.live("Revert must expose recovered text at its source", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const card = yield* api.CreateCard({ label: "Revert", name: "Revert" })
    const store = new EditorStore(
      card.id,
      "n5-user",
      (async (rpc: (client: never) => Effect.Effect<unknown, unknown>) => {
        const exit = await Effect.runPromiseExit(
          rpc(((tag: string, p: unknown) =>
            (api as unknown as Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>)[tag]!(
              p
            )) as never)
        )
        return Exit.isSuccess(exit)
          ? { ok: true, value: exit.value }
          : { ok: false, error: { tag: "error", message: String(exit.cause) } }
      }) as never,
      { setTimer: () => 0, clearTimer: () => {}, now: () => Date.now(), keepalive: async () => false }
    )
    yield* Effect.promise(async () => {
      await store.load()
      store.setText(["description"], "REVERT UNIQUE 724915")
      await store.flush()
      await store.discard(textField(["description"]))
    })

    assert.isAbove(store.state().recovered, 0)
  }).pipe(Effect.scoped, withServer(testConfig()))
)

it.live(
  "history retention must report its recovery",
  () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Retention" })
      const d = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      let last
      for (let i = 0; i < 1003; i++)
        last = yield* api.SaveComposer({
          next: false,
          operationId: crypto.randomUUID(),
          chatId: chat.id,
          draftId: d.id,
          rowVersion: d.rowVersion,
          session: d.session,
          content: `stale ${i}`
        })
      const entries = yield* api.ListRecoveredTexts({ limit: 10, before: null })
      assert.isAbove(entries.length, 0)
      assert.strictEqual(last!.recovered, true)
    }).pipe(Effect.scoped, withServer(testConfig())),
  { timeout: 60000 }
)

it.live(
  "editor saves, restores and keepalive propagate history-retention recovery",
  () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Retention metadata", name: "Synthetic" })
      const field = textField(["description"])
      const initial = yield* api.SaveEditorDraft({
        refId: card.id,
        field,
        draftId: null,
        content: "stale 0",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: card.headRevisionId
      })
      const payload = {
        refId: card.id,
        field,
        draftId: initial.id,
        expectedRowVersion: initial.rowVersion,
        expectedSession: initial.session,
        baseRevisionId: card.headRevisionId
      }
      let latest = initial
      for (let index = 1; index < 1003; index++)
        latest = yield* api.SaveEditorDraft({ ...payload, content: `stale ${index}` })
      assert.isAbove(latest.recovered, 0)
      const states = yield* api.EditorDraftHistory({ refId: card.id, field, limit: 2 })
      const restored = yield* api.RestoreEditorDraft({
        refId: card.id,
        field,
        draftId: latest.id,
        seq: states[1]!.seq,
        expectedRowVersion: latest.rowVersion
      })
      assert.isAbove(restored.recovered, 0)
      const response = yield* post("/library/drafts", {
        drafts: [{ ...payload, content: "kept on leaving" }],
        composers: []
      })
      assert.strictEqual(response.status, 204)
      assert.isAbove(Number(response.headers.get("x-drafts-recovered")), 0)
    }).pipe(Effect.scoped, withServer(testConfig())),
  { timeout: 60_000 }
)

it.live("unsent copies cannot expire unacknowledged", () =>
  Effect.promise(async () => {
    idb.clear()
    const copy = makeCopy(
      "expiry-user",
      "synthetic-ref",
      "description",
      {
        kind: "editor",
        payload: {
          expectedSession: null,
          refId: "synthetic-ref" as never,
          field: "description",
          draftId: null,
          content: "UNSENT EXPIRED TEXT",
          expectedRowVersion: null,
          baseRevisionId: null
        }
      },
      0
    )
    await keepCopy(copy)
    const copies = await copiesOfUser("expiry-user")
    assert.lengthOf(copies, 1)
  })
)

it.live("unsent copies cannot evict another draft unacknowledged", () =>
  Effect.promise(async () => {
    idb.clear()
    for (let i = 0; i < 9; i++)
      await keepCopy(
        makeCopy(
          "capacity-user",
          `ref-${i}`,
          "description",
          {
            kind: "editor",
            payload: {
              expectedSession: null,
              refId: `ref-${i}` as never,
              field: "description",
              draftId: null,
              content: String(i).repeat(1000000),
              expectedRowVersion: null,
              baseRevisionId: null
            }
          },
          i
        )
      )
    const copies = await copiesOfUser("capacity-user")
    assert.lengthOf(copies, 9)
  })
)

it.live("logout and another login must not silently drop unsent copies", () =>
  Effect.promise(async () => {
    const copy = (user: string) =>
      makeCopy(
        user,
        "synthetic-ref",
        "description",
        {
          kind: "editor",
          payload: {
            expectedSession: null,
            refId: "synthetic-ref" as never,
            field: "description",
            draftId: null,
            content: "ONLY UNSENT COPY",
            expectedRowVersion: null,
            baseRevisionId: null
          }
        },
        Date.now()
      )
    idb.clear()
    await keepCopy(copy("logout-user"))
    await flushCopies("logout-user")
    const logout = await copiesOfUser("logout-user")
    await keepCopy(copy("earlier-user"))
    assert.lengthOf(await copiesOfUser("next-user"), 0)
    const login = await copiesOfUser("earlier-user")
    assert.lengthOf(logout, 1)
    assert.lengthOf(login, 1)
  })
)

it.live("the writer reports displacement facts, including a repeated composer receipt", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = yield* api.CreateChat({ title: "Replay conflict" })
    const base = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
    const elsewhere = yield* typeInto(api, chat.id, null, "saved elsewhere")
    const payload = {
      chatId: chat.id,
      draftId: base.id,
      rowVersion: base.rowVersion,
      session: base.session,
      next: false,
      operationId: crypto.randomUUID(),
      content: "offline browser text"
    }
    const replay = yield* api.SaveComposer(payload)
    assert.deepEqual({ ...replay.draft?.displaced }, { at: elsewhere.updatedAt, content: elsewhere.content })
    const duplicate = yield* api.SaveComposer(payload)
    assert.deepEqual(duplicate.draft?.displaced, replay.draft?.displaced)
    const read = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
    assert.isNull(read.displaced)
    const same = yield* api.SaveComposer({ ...payload, operationId: crypto.randomUUID() })
    assert.isNull(same.draft?.displaced)
  }).pipe(Effect.scoped, withServer(testConfig()))
)
