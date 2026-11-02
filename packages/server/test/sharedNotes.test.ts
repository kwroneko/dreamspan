// Shared named notes (DESIGN §4.1): a note slot linked to one shows its library head, so one
// edit changes every slot; unlinking makes the slot its own copy, a chat's on its branch only;
// a shared note in the bin sends nothing. Cross-user access is in the isolation matrix.
import { assert, it } from "@effect/vitest"
import { type ChatId, type EntityId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const setup = Effect.gen(function* () {
  const api = yield* client()
  const me = yield* api.Whoami()
  const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
  const tobin = yield* api.CreateCard({ label: "Tobin", name: "Tobin" })
  const start = (content: string) =>
    api.StartChat({
      cards: [mira.entityId],
      persona: tobin.entityId,
      greeting: null,
      first: { _tag: "Send", content, speakerEntityId: null }
    })
  return { api, userId: me.id as UserId, mira, tobin, start }
})

/** The text a reply after `slotId` would be sent with. */
const assembled = (userId: UserId, chatId: ChatId, slotId: SlotId) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const reader = yield* Reader
    const reply = yield* writer.AppendMessage({
      userId,
      chatId,
      parentSlotId: slotId,
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
      chatId,
      slotId: reply.slotId,
      versionId: reply.version.id,
      now: Date.UTC(2026, 9, 27),
      timeZone: "UTC",
      frozen: null
    })
    return (JSON.parse(snapshot) as ContextSnapshot).request.messages.map((m) => m.content).join("\n")
  })

/** A library entry's head with `change` applied, saved as a revision. */
const edit = (api: Api, userId: UserId, refId: RefId, change: Record<string, unknown>) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const opened = yield* api.OpenEditor({ refId })
    return yield* writer.EditRef({
      userId,
      refId,
      doc: { ...opened.doc, ...change },
      expectedRowVersion: opened.ref.rowVersion,
      message: null,
      commitDraft: null
    })
  })

it.live("a slot linked in two chats shows one shared note; unlinking copies it, on that branch only", () =>
  Effect.gen(function* () {
    const { api, userId, start } = yield* setup
    const [a, b] = [yield* start("Morning."), yield* start("Evening.")]
    const shared = yield* api.CreateSharedNote({ title: "Weather", content: "Rain on the roofs." })
    const slots = []
    for (const chat of [a, b]) {
      const slot = yield* api.CreateChatNote({ chatId: chat.chat.id, title: "", link: shared.entityId })
      // A slot takes the shared note's name.
      assert.strictEqual(slot.label, "Weather")
      yield* api.ChangeCast({
        chatId: chat.chat.id,
        slotId: chat.entry.slotId,
        change: { _tag: "Note", entityId: slot.entityId, active: true }
      })
      slots.push(slot)
    }
    const listed = (chat: typeof a, slotId: SlotId | null = chat.entry.slotId) =>
      Effect.map(api.ListChatNotes({ chatId: chat.chat.id, slotId }), (notes) => notes.find((n) => n.card === null)!)
    const noteA = yield* listed(a)
    assert.strictEqual(noteA.doc["content"], "Rain on the roofs.")
    assert.deepInclude(noteA.linked!, { title: "Weather", binned: false, usedBy: 2 })
    assert.include(yield* assembled(userId, a.chat.id, a.entry.slotId), "Rain on the roofs.")
    const [picked] = yield* api.ListSharedNotes({ query: "weath" })
    assert.deepInclude(picked!, { title: "Weather", excerpt: "Rain on the roofs.", usedBy: 2 })
    assert.deepStrictEqual(yield* api.ListSharedNotes({ query: "nothing like it" }), [])

    // One edit to the shared note changes both.
    yield* edit(api, userId, shared.id, { content: "Snow on the roofs." })
    for (const chat of [a, b]) {
      assert.strictEqual((yield* listed(chat)).doc["content"], "Snow on the roofs.")
      assert.include(yield* assembled(userId, chat.chat.id, chat.entry.slotId), "Snow on the roofs.")
    }

    // The assembly helper appended replies. Even a caller naming the first message edits
    // at the branch's latest state (owner, 2026-11-02): A keeps a copy from there on.
    const currentA = yield* api.GetChat({ chatId: a.chat.id })
    const position = { chatId: a.chat.id, forkId: currentA.currentForkId!, slotId: a.entry.slotId }
    const latest = { ...position, slotId: currentA.activeLeafSlotId! }
    yield* api.UnlinkNote({ noteRefId: slots[0]!.id, chatNote: position })
    yield* edit(api, userId, shared.id, { content: "Fog on the roofs." })
    const copied = (yield* api.ListChatNotes(latest)).find((n) => n.card === null)!
    assert.isNull(copied.linked)
    assert.strictEqual(copied.doc["content"], "Snow on the roofs.")
    assert.include(yield* assembled(userId, a.chat.id, latest.slotId), "Snow on the roofs.")
    assert.strictEqual((yield* listed(b)).doc["content"], "Fog on the roofs.")
    assert.include(yield* assembled(userId, b.chat.id, b.entry.slotId), "Fog on the roofs.")
    // Before the current message, A still shows the shared text, including at the stale
    // caller's first message. Earlier forks also keep the link.
    assert.isNotNull((yield* listed(a)).linked)
    assert.strictEqual((yield* listed(a)).doc["content"], "Fog on the roofs.")
    assert.isNotNull((yield* listed(a, null)).linked)
    const original = yield* api.ListChatNotes({
      chatId: a.chat.id,
      forkId: a.chat.currentForkId!,
      slotId: a.entry.slotId
    })
    assert.isNotNull(original.find((n) => n.card === null)!.linked)
    // Its link changes only by its own actions, never through a draft.
    assert.strictEqual(yield* outcome(api.UnlinkNote({ noteRefId: slots[0]!.id, chatNote: position })), "EditRefused")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("a chat note saved as a shared note at its own position counts as a place that uses it", () =>
  Effect.gen(function* () {
    const { api, start } = yield* setup
    const chat = yield* start("Morning.")
    const own = yield* api.CreateChatNote({ chatId: chat.chat.id, title: "Weather" })
    const shared = yield* api.CreateSharedNote({
      title: "",
      content: "",
      fromNoteRefId: own.id,
      chatNote: { chatId: chat.chat.id, slotId: chat.entry.slotId }
    })
    // The slot's library head stays unlinked: only the chat's binding links.
    assert.isUndefined((yield* api.OpenEditor({ refId: own.id })).doc["link"])
    const [listed] = yield* api.ListSharedNotes({})
    assert.strictEqual(listed!.usedBy, 1)
    const linked = (yield* api.ListChatNotes({ chatId: chat.chat.id, slotId: chat.entry.slotId })).find(
      (n) => n.ref.entityId === own.entityId
    )
    assert.strictEqual(linked!.linked!.usedBy, 1)
    assert.strictEqual(linked!.linked!.refId, shared.id)
    // Once the message it was bound at is deleted, that chat no longer uses it.
    yield* api.DeleteMessage({ slotId: chat.entry.slotId })
    assert.strictEqual((yield* api.ListSharedNotes({}))[0]!.usedBy, 0)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)

it.live("a card's note saved as a shared note links to it; in the bin it sends nothing until unlinked", () =>
  Effect.gen(function* () {
    const { api, userId, mira, start } = yield* setup
    const chat = yield* start("Hello.")
    const outfit = yield* api.CreateCardNote({ cardRefId: mira.id, title: "Outfit" })
    yield* edit(api, userId, outfit.id, { content: "A green oilskin coat.", on_by_default: true })
    const shared = yield* api.CreateSharedNote({ title: "", content: "", fromNoteRefId: outfit.id })
    assert.strictEqual(shared.label, "Outfit")
    const slot = (yield* api.OpenEditor({ refId: outfit.id })).doc
    assert.strictEqual(slot["link"], shared.entityId)
    assert.strictEqual((yield* api.OpenEditor({ refId: shared.id })).doc["content"], "A green oilskin coat.")
    // A linked slot or a shared note can't be saved as one again.
    assert.strictEqual(
      yield* outcome(api.CreateSharedNote({ title: "", content: "", fromNoteRefId: outfit.id })),
      "EditRefused"
    )
    assert.strictEqual(
      yield* outcome(api.CreateSharedNote({ title: "", content: "", fromNoteRefId: shared.id })),
      "EditRefused"
    )
    assert.include(yield* assembled(userId, chat.chat.id, chat.entry.slotId), "A green oilskin coat.")
    yield* edit(api, userId, shared.id, { content: "A red oilskin coat." })
    assert.include(yield* assembled(userId, chat.chat.id, chat.entry.slotId), "A red oilskin coat.")
    // An export of the card takes the linked note as its shared note's text. Outfit is the
    // card's first note, which goes as ST's Character's Note where it can.
    const exported = () =>
      Effect.map(Reader.pipe(Effect.flatMap((reader) => reader.ExportSource({ userId, refId: mira.id }))), (source) =>
        [source.noteDocJson, ...source.notesDocJson].flatMap((json) => (json ? [JSON.parse(json)] : []))
      )
    const [carried] = yield* exported()
    assert.strictEqual((carried as Record<string, unknown>)["content"], "A red oilskin coat.")

    // In the bin: the slot says so and sends nothing.
    yield* api.DeleteNote({ noteRefId: shared.id })
    const [listed] = (yield* api.ListChatNotes({ chatId: chat.chat.id, slotId: chat.entry.slotId })).filter(
      (n) => n.ref.entityId === (outfit.entityId as EntityId)
    )
    assert.isTrue(listed!.linked!.binned)
    assert.notInclude(yield* assembled(userId, chat.chat.id, chat.entry.slotId), "oilskin")
    assert.deepStrictEqual(yield* api.ListSharedNotes({}), [])
    // With nothing to send, it's left out of an export too.
    assert.deepStrictEqual(yield* exported(), [])
    // Unlinked, it takes the shared note's last text, binned or not.
    yield* api.UnlinkNote({ noteRefId: outfit.id })
    const own = (yield* api.OpenEditor({ refId: outfit.id })).doc
    assert.notProperty(own, "link")
    assert.strictEqual(own["content"], "A red oilskin coat.")
    assert.include(yield* assembled(userId, chat.chat.id, chat.entry.slotId), "A red oilskin coat.")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)
