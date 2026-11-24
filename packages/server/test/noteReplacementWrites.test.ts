// Replacement ownership is checked in the writer transaction, including off notes and stale tabs.
import { assert, layer } from "@effect/vitest"
import { type ForkId, NewVersion } from "@dreamspan/shared/chat.ts"
import type { ChatNotePosition } from "@dreamspan/shared/editorApi.ts"
import { valueField } from "@dreamspan/shared/editing.ts"
import type { ReplaceTarget } from "@dreamspan/shared/docs/note.ts"
import type { LibraryRef } from "@dreamspan/shared/library.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

const setup = Effect.gen(function* () {
  const api = yield* client()
  const writer = yield* Writer
  const reader = yield* Reader
  const userId = (yield* api.Whoami()).id
  const card = (yield* writer.CreateEntity({
    userId,
    kind: "card",
    label: "Mira",
    subtitle: "",
    doc: cardDoc("Mira"),
    schemaVersion: 1,
    origin: "user",
    sourcePath: null
  })).ref
  const chat = yield* writer.CreateChat({
    userId,
    kind: "rp",
    status: "active",
    title: "Replacements",
    participants: [card.entityId],
    greeting: null
  })
  const at: ChatNotePosition = { chatId: chat.id, forkId: chat.currentForkId, slotId: null }
  const create = (title: string, replaces?: ReplaceTarget) =>
    api.CreateChatNote({ ...at, title, ...(replaces ? { replaces } : {}) })
  const draft = (note: LibraryRef, replaces: ReplaceTarget | undefined, position: ChatNotePosition | null = at) =>
    Effect.gen(function* () {
      const context = position ? { chatNote: position } : {}
      const opened = yield* api.OpenEditor({ refId: note.id, ...context })
      const saved = yield* api.SaveEditorDraft({
        refId: note.id,
        ...(opened.chatNote ? { scope: opened.chatNote.scope } : {}),
        field: valueField(["replaces"]),
        content: replaces === undefined ? "undefined" : JSON.stringify(replaces),
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: opened.ref.headRevisionId
      })
      return () =>
        api.CommitEditorDrafts({
          refId: note.id,
          ...context,
          expectedRowVersion: opened.ref.rowVersion,
          fields: [{ field: saved.key.field, draftId: saved.id, expectedRowVersion: saved.rowVersion }],
          message: null
        })
    })
  return { api, writer, reader, userId, card, chat, at, create, draft }
})

layer(serverLayer(testConfig()))("replacement writes", (it) => {
  it.effect("refuses a second replacement from a note variant and allows a copy for a new card", () =>
    Effect.gen(function* () {
      const { api, card, draft } = yield* setup
      const target = { kind: "card_field", field: "description" } as const
      const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "Original" })
      yield* (yield* draft(note, target, null))()
      const refused = yield* api
        .ForkVariant({ refId: note.id, label: "Copy", subtitle: "", moveDrafts: false })
        .pipe(Effect.flip)
      assert.strictEqual(refused._tag, "EditRefused")
      if (refused._tag === "EditRefused") assert.match(refused.message, /Only one note can replace this target/)
      const fork = yield* api.ForkCard({ refId: card.id, name: "Mira variant", nickname: "", characterVersion: "" })
      const [copy] = yield* api.ListCardNotes({ cardRefId: fork.id })
      assert.deepStrictEqual(copy?.doc.owner, { card: fork.entityId })
      assert.deepStrictEqual(copy?.doc.replaces, target)
      assert.deepStrictEqual(
        (yield* api.ListCardNotes({ cardRefId: card.id })).map((entry) => entry.ref.id),
        [note.id]
      )
    })
  )
  it.effect("serializes two tabs creating replacements, even while the first note is off", () =>
    Effect.gen(function* () {
      const { create, api, at } = yield* setup
      const target = { kind: "preset_prompt", identifier: "main" } as const
      const results = yield* Effect.all([outcome(create("One", target)), outcome(create("Two", target))], {
        concurrency: 2
      })
      assert.strictEqual(results.filter((r) => r === "ok").length, 1)
      assert.strictEqual((yield* api.ListChatNotes(at)).length, 1)
    })
  )
  it.effect("serializes two tabs assigning the same target to different notes", () =>
    Effect.gen(function* () {
      const { create, draft, api, at } = yield* setup
      const first = yield* create("First")
      const second = yield* create("Second")
      const target = { kind: "preset_prompt", identifier: "main" } as const
      const saveFirst = yield* draft(first, target)
      const saveSecond = yield* draft(second, target)
      const results = yield* Effect.all([outcome(saveFirst()), outcome(saveSecond())], { concurrency: 2 })
      assert.strictEqual(results.filter((r) => r === "ok").length, 1)
      assert.strictEqual((yield* api.ListChatNotes(at)).filter((n) => n.doc["replaces"] !== undefined).length, 1)
      const rejected = results[0] === "ok" ? second : first
      const opened = yield* api.OpenEditor({ refId: rejected.id, chatNote: at })
      assert.isTrue(opened.drafts.some((d) => d.key.field === valueField(["replaces"]) && d.status === "active"))
    })
  )
  it.effect("resolves swapped card targets and allows the target again after unlinking", () =>
    Effect.gen(function* () {
      const { create, draft, writer, userId, card, chat, at } = yield* setup
      const first = yield* create("Outfit", { kind: "card_field", card: card.entityId, field: "description" })
      const fork = yield* writer.ForkCardForChat({
        userId,
        chatId: chat.id,
        forkId: at.forkId ?? null,
        slotId: null,
        entityId: card.entityId,
        name: "Mira fork",
        nickname: "",
        characterVersion: ""
      })
      const target = { kind: "card_field", card: fork.ref.entityId, field: "description" } as const
      assert.notStrictEqual(yield* outcome(create("Duplicate", target)), "ok")
      yield* (yield* draft(first, undefined))()
      yield* create("Allowed", target)
    })
  )
  it.effect("checks the viewed fork's note binding rather than a sibling's target", () =>
    Effect.gen(function* () {
      const { create, draft, api, at } = yield* setup
      const target = { kind: "preset_prompt", identifier: "main" } as const
      const note = yield* create("Original", target)
      const second = yield* create("Main only")
      const sibling = (yield* api.CreateFork({ chatId: at.chatId, fromForkId: at.forkId ?? null, atSlotId: null })).fork
      yield* (yield* draft(note, undefined))()
      yield* (yield* draft(second, target))()
      const result = yield* outcome(
        api.CreateChatNote({ chatId: at.chatId, forkId: sibling.id, title: "Duplicate there", replaces: target })
      )
      assert.notStrictEqual(result, "ok")
      const there = yield* api.ListChatNotes({ ...at, forkId: sibling.id })
      assert.deepStrictEqual(there.find((n) => n.ref.id === note.id)?.doc["replaces"], target)
      assert.isUndefined(there.find((n) => n.ref.id === second.id)?.doc["replaces"])
    })
  )
  it.effect("copying a note refuses a replacement target already claimed in the destination", () =>
    Effect.gen(function* () {
      const { create, draft, api, at } = yield* setup
      const target = { kind: "preset_prompt", identifier: "main" } as const
      const note = yield* create("Original", target)
      const second = yield* create("Other note")
      const sibling = (yield* api.CreateFork({ chatId: at.chatId, fromForkId: at.forkId ?? null, atSlotId: null })).fork
      yield* (yield* draft(note, undefined))()
      yield* (yield* draft(second, target))()
      const before = yield* api.ListChatNotes(at)
      assert.strictEqual(
        yield* outcome(
          api.CopyNoteToBranch({ chatId: at.chatId, noteRefId: note.id, fromForkId: sibling.id, toForkId: at.forkId! })
        ),
        "EditRefused"
      )
      assert.deepStrictEqual(yield* api.ListChatNotes(at), before)
    })
  )
  it.effect("a save with only a slot checks the fork the editor inferred from that slot", () =>
    Effect.gen(function* () {
      const { create, draft, reader, writer, userId, chat, at } = yield* setup
      const target = { kind: "preset_prompt", identifier: "main" } as const
      const first = yield* create("Side replacement")
      const second = yield* create("Another note")
      const { fork: side } = yield* writer.CreateFork({
        userId,
        chatId: chat.id,
        fromForkId: at.forkId!,
        atSlotId: null
      })
      const append = (forkId: ForkId, content: string) =>
        writer.AppendMessage({
          userId,
          chatId: chat.id,
          forkId,
          parentSlotId: null,
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "human",
            content,
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          })
        })
      const sideSlot = yield* append(side.id, "On the side branch.")
      const sideAt = { chatId: chat.id, slotId: sideSlot.slotId }
      yield* (yield* draft(first, target, { ...sideAt, forkId: side.id }))()
      yield* append(at.forkId!, "On the main branch.")
      assert.strictEqual((yield* reader.GetChat({ userId, chatId: chat.id })).currentForkId, at.forkId)
      assert.strictEqual(yield* outcome((yield* draft(second, target, sideAt))()), "InvalidDocument")
    })
  )
  it.effect("serializes off card-note claims and checks them when creating a chat replacement", () =>
    Effect.gen(function* () {
      const { api, card, create, draft } = yield* setup
      const first = yield* api.CreateCardNote({ cardRefId: card.id, title: "First card note" })
      const second = yield* api.CreateCardNote({ cardRefId: card.id, title: "Second card note" })
      const target = { kind: "preset_prompt", identifier: "main" } as const
      const saveFirst = yield* draft(first, target, null)
      const saveSecond = yield* draft(second, target, null)
      const results = yield* Effect.all([outcome(saveFirst()), outcome(saveSecond())], { concurrency: 2 })
      assert.strictEqual(results.filter((r) => r === "ok").length, 1)
      assert.notStrictEqual(yield* outcome(create("Chat duplicate", target)), "ok")
    })
  )
})
