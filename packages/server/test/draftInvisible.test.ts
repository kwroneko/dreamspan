// A pending chat (the new-chat page's chat before its first turn; DESIGN §2.1, owner 2026-11-23:
// "these draft chats do not impact anything", not even a character's last used time) leaves every
// account-wide read as it was. A fixture of real chats is read through each of those reads, then
// pending chats are added for the same cards and group and an empty one, and touched as the
// new-chat page touches them: greetings, an unsaved greeting edit, composer text with an image,
// a cast change, a persona, a rename. Every read must answer exactly as before.
// A new account-wide read belongs in `accountReads` (ARCHITECTURE.md §1); test/chatReaders.test.ts
// checks the SQL itself.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, EntityId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { DraftFor } from "@dreamspan/shared/draftChatApi.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { sizedPng } from "./formats/support.ts"
import { cardDoc } from "./support/docs.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const upload = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}/chat/image`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    assert.strictEqual(response.status, 200)
    return (yield* Effect.promise(() => response.json())) as { mediaId: string }
  })

const shellView = (entity: EntityId | null) => ({
  entity,
  chat: null,
  search: "",
  sort: "recent" as const,
  sections: (["pinned", "chats", "just", "with", "was", "groups", "card", "all"] as const).map((id) => ({
    id,
    limit: 100
  }))
})

/**
 * Every read across the user's chats, cards and library that a chat can change, with arguments
 * that reach the fixture's cards and words. Not ListActiveDrafts: it lists a pending chat's
 * typing on purpose, as unsent text the user can get back to.
 */
const accountReads = (userId: UserId, cards: ReadonlyArray<EntityId>, refs: ReadonlyArray<RefId>, group: ChatId) =>
  Effect.gen(function* () {
    const reader = yield* Reader
    const perCard = <A, E>(read: (entityId: EntityId) => Effect.Effect<A, E>) => Effect.forEach(cards, read)
    const perRef = <A, E>(read: (refId: RefId) => Effect.Effect<A, E>) => Effect.forEach(refs, read)
    const chats = { userId, limit: 100, before: null }
    return {
      ShellEpoch: yield* reader.ShellEpoch({ userId }),
      ShellMaterialize: yield* reader.ShellMaterialize({ userId }),
      ShellLibrary: yield* reader.ShellLibrary({ userId, recompute: true }),
      ShellCards: yield* reader.ShellCards({ userId }),
      ShellForks: yield* reader.ShellForks({ userId, view: shellView(null) }),
      ShellForksByCard: yield* perCard((entity) => reader.ShellForks({ userId, view: shellView(entity) })),
      ListChats: yield* reader.ListChats(chats),
      ListChatsByCard: yield* perCard((entityId) => reader.ListChats({ ...chats, entityId })),
      ListChatsBySearch: yield* reader.ListChats({ ...chats, search: "Mira" }),
      ListCards: yield* reader.ListCards({ userId }),
      CardUsage: yield* reader.CardUsage({ userId }),
      ChatGroups: yield* reader.ChatGroups({ userId }),
      GroupChats: yield* reader.GroupChats({ userId, chatId: group }),
      CardFamilyIndex: yield* reader.CardFamilyIndex({ userId }),
      CardFamily: yield* perCard((entityId) => reader.CardFamily({ userId, entityId })),
      ListLibrary: yield* reader.ListLibrary({
        userId,
        kind: "card",
        tag: null,
        withFilterData: true,
        archived: false
      }),
      GetRef: yield* perRef((refId) => reader.GetRef({ userId, refId })),
      LibraryGenealogy: yield* perRef((refId) => reader.LibraryGenealogy({ userId, refId })),
      GetCardImportNote: yield* perRef((cardRefId) => reader.GetCardImportNote({ userId, cardRefId })),
      ListArchiveCandidates: yield* reader.ListArchiveCandidates({
        userId,
        criteria: { never: 1, inactive: 1, tried: 1 }
      }),
      SearchMessages: yield* reader.SearchMessages({ userId, text: "lighthouse", cursor: null, limit: 50 }),
      SearchMessagesByChat: yield* reader.SearchMessages({
        userId,
        text: "lighthouse",
        cursor: null,
        limit: 50,
        sort: "chat"
      }),
      CountMessages: yield* reader.CountMessages({ userId, text: "lighthouse" }),
      ListBin: yield* reader.ListBin({ userId, limit: 100, before: null }),
      ListRecoveredTexts: yield* reader.ListRecoveredTexts({ userId, source: null, limit: 100, before: null }),
      ListSharedNotes: yield* reader.ListSharedNotes({ userId }),
      ModelBehaviour: yield* reader.ModelBehaviour({ userId }),
      ListModelUse: yield* reader.ListModelUse({ userId }),
      ListLlmRequests: yield* reader.ListLlmRequests({ userId, limit: 100, before: null }),
      StImportSources: yield* reader.StImportSources({ userId }),
      StImportPlanStamp: yield* reader.StImportPlanStamp({ userId }),
      StImportLatestChat: yield* reader.StImportLatestChat({ userId })
    }
  })

const card = (userId: UserId, name: string, persona = false) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const made = yield* writer.CreateEntity({
      userId,
      kind: "card",
      label: name,
      subtitle: "",
      doc: cardDoc(name, { first_mes: `${name} waves from the lighthouse.` }),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    if (persona) yield* writer.SetEntityTags({ userId, entityId: made.entityId, tags: ["persona"] })
    return made
  })

/** A pending chat as the new-chat page leaves it once the user has looked around and typed. */
const touchedDraft = (api: Api, userId: UserId, draftFor: DraftFor, persona: EntityId) =>
  Effect.gen(function* () {
    const reader = yield* Reader
    const chat = yield* api.OpenDraftChat({ draftFor })
    yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [persona] } })
    yield* api.RenameChat({ chatId: chat.id, name: "Lighthouse night" })
    const composer = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
    yield* api.SaveComposer({
      chatId: chat.id,
      draftId: composer.id,
      rowVersion: composer.rowVersion,
      session: composer.session,
      next: false,
      operationId: crypto.randomUUID(),
      content: "Is the lighthouse lit?"
    })
    yield* api.SetComposerImage({
      chatId: chat.id,
      draftId: composer.id,
      id: crypto.randomUUID(),
      mediaId: (yield* upload(sizedPng(64, 64))).mediaId,
      altText: "A lighthouse at dusk"
    })
    const leaf = (yield* reader.GetChat({ userId, chatId: chat.id })).activeLeafSlotId
    if (leaf !== null) {
      const { entry } = yield* reader.GetSlot({ userId, slotId: leaf })
      // An edit of the greeting typed and not saved: draft text, not a version.
      yield* api.SaveMessageDraft({
        target: { _tag: "Edit", versionId: entry.version.id },
        draftId: null,
        content: "The lighthouse keeper, edited, greets you.",
        expectedRowVersion: null,
        expectedSession: null
      })
    }
    return chat
  })

describe("pending chats are invisible", () => {
  it.live("leave every account-wide read exactly as it was", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const userId = (yield* api.Whoami()).id as UserId
      const mira = yield* card(userId, "Mira")
      const ana = yield* card(userId, "Ana")
      const quiet = yield* card(userId, "Quiet")
      const sam = yield* card(userId, "Sam", true)
      const start = (cards: ReadonlyArray<EntityId>, title?: string) =>
        api.StartChat({
          cards,
          persona: sam.entityId,
          greeting: null,
          first: { _tag: "Send", content: "Hello at the lighthouse.", speakerEntityId: sam.entityId },
          ...(title === undefined ? {} : { title })
        })
      yield* start([mira.entityId])
      const group = yield* start([ana.entityId, mira.entityId], "Mira & Ana at the lighthouse")
      yield* Effect.sleep("5 millis")

      const cards = [mira.entityId, ana.entityId, quiet.entityId, sam.entityId]
      const refs = [mira.ref.id, ana.ref.id, quiet.ref.id, sam.ref.id]
      const before = yield* accountReads(userId, cards, refs, group.chat.id)

      yield* touchedDraft(api, userId, `card:${mira.entityId}`, sam.entityId)
      yield* touchedDraft(api, userId, `group:${group.chat.id}`, sam.entityId)
      // A card with no chats yet: nothing may count it used.
      yield* touchedDraft(api, userId, `card:${quiet.entityId}`, sam.entityId)
      yield* touchedDraft(api, userId, "empty", sam.entityId)

      const after = yield* accountReads(userId, cards, refs, group.chat.id)
      for (const key of Object.keys(before) as Array<keyof typeof before>)
        assert.deepStrictEqual(JSON.parse(JSON.stringify(after[key])), JSON.parse(JSON.stringify(before[key])), key)
      // The pending chats' typing is kept as unsent text, the one list that shows it.
      const drafts = yield* (yield* Reader).ListActiveDrafts({ userId })
      assert.isAtLeast(drafts.filter((draft) => draft.content === "Is the lighthouse lit?").length, 4)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("refuses what only a saved chat has: pins, branches, the bin, threads, exports", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const userId = (yield* api.Whoami()).id as UserId
      const writer = yield* Writer
      const mira = yield* card(userId, "Mira")
      const chat = yield* api.OpenDraftChat({ draftFor: `card:${mira.entityId}` })
      const forkId = (yield* (yield* Reader).GetChat({ userId, chatId: chat.id })).currentForkId!
      const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.flip(effect).pipe(Effect.map((error) => (error as { _tag?: string })._tag))
      assert.strictEqual(
        yield* refused(writer.SetChatPin({ userId, chatId: chat.id, pinned: true, leaf: null })),
        "NotFound"
      )
      assert.strictEqual(yield* refused(writer.SetForkPinned({ userId, forkId, pinned: true })), "NotFound")
      assert.strictEqual(
        yield* refused(writer.CreateFork({ userId, chatId: chat.id, fromForkId: null, atSlotId: null })),
        "NotFound"
      )
      assert.strictEqual(yield* refused(writer.DeleteChat({ userId, chatId: chat.id })), "NotFound")
      assert.strictEqual(yield* refused(writer.DeleteFork({ userId, forkId })), "NotFound")
      const leaf = (yield* (yield* Reader).GetChat({ userId, chatId: chat.id })).activeLeafSlotId!
      assert.strictEqual(yield* refused(writer.DeleteMessage({ userId, slotId: leaf, forkId })), "NotFound")
      assert.strictEqual(yield* refused(api.DeleteChat({ chatId: chat.id })), "NotFound")
      // Nothing reached the bin, and the chat is still there for its page.
      assert.lengthOf(yield* (yield* Reader).ListBin({ userId, limit: 10, before: null }), 0)
      assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).status, "pending")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
