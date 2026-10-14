// The Cast tab's view of a card is the version the next request reads (ListChatCards,
// EditCardForChat, GetCast), checked against an actual assembled request. Synthetic cards,
// a real server and the database workers.
import { assert, describe, it } from "@effect/vitest"
import { NewVersion, type EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

const setup = Effect.gen(function* () {
  const api = yield* client()
  const writer = yield* Writer
  const userId = (yield* api.Whoami()).id as UserId
  const made = yield* writer.CreateEntity({
    userId,
    kind: "card",
    label: "Mira library",
    subtitle: "",
    doc: cardDoc("Mira", { description: "Original harbor pilot." }),
    schemaVersion: 1,
    origin: "user",
    sourcePath: null
  })
  const entityId = made.entityId as EntityId
  const started = yield* api.StartChat({
    cards: [entityId],
    persona: null,
    greeting: 0,
    first: { _tag: "Send", content: "Hello", speakerEntityId: null }
  })
  const chatId = started.chat.id
  const leaf = () => Effect.map(api.GetChat({ chatId }), (chat) => chat.activeLeafSlotId)
  /** Binds the card in the chat's initial state, as an import or an earlier change would. */
  const bind = (value: { ref?: string; revision?: string }) =>
    writer.AddStateEvent({
      userId,
      chatId,
      slotId: null,
      versionId: null,
      scope: null,
      data: {
        key: "card.binding",
        value: {
          entity: entityId,
          ref: value.ref as RefId | undefined,
          revision: value.revision as RevisionId | undefined
        }
      }
    })
  const edit = (refId: string, change: Record<string, unknown>) =>
    Effect.gen(function* () {
      const { doc, ref } = yield* api.OpenEditor({ refId: refId as RefId })
      yield* writer.EditRef({
        userId,
        refId: refId as RefId,
        doc: { ...doc, ...change },
        expectedRowVersion: ref.rowVersion,
        message: null,
        commitDraft: null
      })
    })
  const shown = () =>
    Effect.gen(function* () {
      const [card] = yield* api.ListChatCards({ chatId, slotId: yield* leaf(), entityIds: [entityId] })
      return card!
    })
  /** The request the model would get for the card's next turn: every message's text. */
  const assembled = () =>
    Effect.gen(function* () {
      const target = yield* writer.AppendMessage({
        userId,
        chatId,
        parentSlotId: yield* leaf(),
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: entityId,
          writer: "model",
          content: "",
          status: "generating",
          macroMode: "verbatim",
          origin: "generated"
        })
      })
      const reader = yield* Reader
      const result = yield* reader.AssembleContext({
        userId,
        chatId,
        slotId: target.slotId,
        versionId: target.version.id,
        now: Date.now(),
        timeZone: "UTC",
        frozen: null
      })
      const snapshot = JSON.parse(result.snapshot) as { request: { messages: Array<{ content: string }> } }
      return snapshot.request.messages.map((m) => m.content).join("\n")
    })
  return { api, writer, userId, made, entityId, chatId, leaf, bind, edit, shown, assembled }
})

describe("the Cast tab's cards are the versions the model reads", () => {
  it.live("a name edited only in this chat is the chat's name for the card; the label stays the library's", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const opened = yield* s.api.EditCardForChat({ chatId: s.chatId, slotId: yield* s.leaf(), entityId: s.entityId })
      yield* s.edit(opened.ref.id, { name: "Chat Mira" })
      assert.include(yield* s.assembled(), "Chat Mira")
      const cast = yield* s.api.GetCast({ chatId: s.chatId, slotId: yield* s.leaf() })
      const card = cast.cards.find((c) => c.entityId === s.entityId)!
      assert.strictEqual(card.name, "Chat Mira")
      assert.strictEqual(card.label, "Mira library")
      // Another chat with the card still calls it Mira.
      const other = yield* s.api.StartChat({
        cards: [s.entityId],
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "Hi", speakerEntityId: null }
      })
      const elsewhere = yield* s.api.GetCast({ chatId: other.chat.id, slotId: null })
      assert.strictEqual(elsewhere.cards.find((c) => c.entityId === s.entityId)!.name, "Mira")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("a pinned revision is shown, an edit only here starts from it, and binds the chat's own version", () =>
    Effect.gen(function* () {
      const s = yield* setup
      yield* s.bind({ revision: s.made.ref.headRevisionId })
      yield* s.edit(s.made.ref.id, { description: "Changed library head." })
      const pinned = yield* s.shown()
      assert.strictEqual(pinned.definition.description, "Original harbor pilot.")
      assert.strictEqual(pinned.binding, "revision")
      assert.isFalse(pinned.usesOverride)
      assert.include(yield* s.assembled(), "Original harbor pilot.")

      const opened = yield* s.api.EditCardForChat({ chatId: s.chatId, slotId: yield* s.leaf(), entityId: s.entityId })
      assert.isTrue(opened.bound)
      assert.strictEqual(opened.ref.headRevisionId, s.made.ref.headRevisionId)
      yield* s.edit(opened.ref.id, { description: "Edited local pilot." })
      const local = yield* s.shown()
      assert.isTrue(local.usesOverride)
      assert.strictEqual(local.binding, "ref")
      assert.strictEqual(local.definition.description, "Edited local pilot.")
      assert.include(yield* s.assembled(), "Edited local pilot.")
      // Opened again, nothing more is bound.
      const again = yield* s.api.EditCardForChat({ chatId: s.chatId, slotId: yield* s.leaf(), entityId: s.entityId })
      assert.strictEqual(again.ref.id, opened.ref.id)
      assert.isFalse(again.bound)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("only in this chat starts from the card variant bound in the chat", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const variant = yield* s.writer.ForkRef({
        userId: s.userId,
        refId: s.made.ref.id,
        label: "Forest Mira",
        subtitle: ""
      })
      yield* s.edit(variant.id, { description: "Forest pilot." })
      yield* s.bind({ ref: variant.id })
      assert.strictEqual((yield* s.shown()).definition.description, "Forest pilot.")
      const opened = yield* s.api.EditCardForChat({ chatId: s.chatId, slotId: yield* s.leaf(), entityId: s.entityId })
      assert.strictEqual(opened.ref.followsRefId, variant.id)
      assert.isTrue(opened.bound)
      const local = yield* s.shown()
      assert.isTrue(local.usesOverride)
      assert.strictEqual(local.definition.description, "Forest pilot.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("an existing override that a ref binding hides is bound when edited only here", () =>
    Effect.gen(function* () {
      const s = yield* setup
      yield* s.bind({ ref: s.made.ref.id })
      // Bound to the library entry itself: that's the library entry, not another version.
      assert.strictEqual((yield* s.shown()).binding, "default")
      const opened = yield* s.api.EditCardForChat({ chatId: s.chatId, slotId: yield* s.leaf(), entityId: s.entityId })
      assert.isTrue(opened.bound)
      yield* s.edit(opened.ref.id, { description: "Edited local pilot." })
      const shown = yield* s.shown()
      assert.strictEqual(shown.definition.description, "Edited local pilot.")
      assert.include(yield* s.assembled(), shown.definition.description)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("another user's card, or one in the bin, in an owned chat is NotFound", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const owner = yield* s.writer.EnsureUser({ handle: "other-cast-user", displayName: "Other" })
      const other = yield* s.writer.CreateEntity({
        userId: owner.id,
        kind: "card",
        label: "Other card",
        subtitle: "",
        doc: cardDoc("Other"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const list = (entityIds: Array<EntityId>) => s.api.ListChatCards({ chatId: s.chatId, slotId: null, entityIds })
      assert.strictEqual(yield* outcome(list([other.entityId as EntityId])), "NotFound")
      assert.strictEqual(yield* outcome(list([s.entityId, other.entityId as EntityId])), "NotFound")
      yield* s.writer.DeleteEntity({ userId: s.userId, entityId: s.entityId })
      assert.strictEqual(yield* outcome(list([s.entityId])), "NotFound")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
