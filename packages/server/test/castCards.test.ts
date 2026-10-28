// The Cast tab's view of a card is the version the next request reads (ListChatCards,
// GetCast), checked against an actual assembled request. Synthetic cards,
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
  it.live("a pinned revision is shown and sent while the library head changes", () =>
    Effect.gen(function* () {
      const s = yield* setup
      yield* s.bind({ revision: s.made.ref.headRevisionId })
      yield* s.edit(s.made.ref.id, {
        description: "Changed library head.",
        name: "New library name",
        nickname: "New model name",
        character_version: "new"
      })
      const pinnedCast = yield* s.api.GetCast({ chatId: s.chatId, slotId: yield* s.leaf() })
      const pinnedCard = pinnedCast.cards.find((c) => c.entityId === s.entityId)!
      assert.deepStrictEqual([pinnedCard.name, pinnedCard.modelName, pinnedCard.subtitle], ["Mira", "Mira", ""])
      const [summary] = yield* s.api.ListChatSummaries({ chatIds: [s.chatId] })
      const listed = summary!.cast.find((c) => c.entityId === s.entityId)!
      assert.deepStrictEqual([listed.name, listed.modelName, listed.subtitle], ["Mira", "Mira", ""])
      const pinned = yield* s.shown()
      assert.strictEqual(pinned.definition.description, "Original harbor pilot.")
      assert.strictEqual(pinned.binding, "revision")
      assert.include(yield* s.assembled(), "Original harbor pilot.")
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
