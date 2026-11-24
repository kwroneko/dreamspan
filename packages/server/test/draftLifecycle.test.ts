// A pending chat's life (DESIGN §2.1, owner 2026-11-23; db/pendingChats.ts): the new-chat page
// opens one, its first turn commits it as if it had been made then, a saved greeting edit is a
// turn, and one left behind is swept with its typing filed to recovered texts.
import { assert, describe, it } from "@effect/vitest"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import { PENDING_LEFT_MS } from "../src/api/draftChats.ts"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const card = (userId: UserId, name: string) =>
  Effect.gen(function* () {
    const made = yield* (yield* Writer).CreateEntity({
      userId,
      kind: "card",
      label: name,
      subtitle: "",
      doc: cardDoc(name, { first_mes: `${name} waves from the pier.` }),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    return made.entityId
  })

const listed = (api: Api) =>
  Effect.map(api.ListChats({ limit: 100, before: null }), (chats) => chats.map((chat) => chat.id))

const greetingOf = (userId: UserId, chatId: string) =>
  Effect.gen(function* () {
    const reader = yield* Reader
    const chat = yield* reader.GetChat({ userId, chatId: chatId as never })
    return yield* reader.GetSlot({ userId, slotId: chat.activeLeafSlotId! })
  })

const setup = Effect.gen(function* () {
  const api = yield* client()
  const userId = (yield* api.Whoami()).id as UserId
  const mira = yield* card(userId, "Mira")
  return { api, userId, mira }
})

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))

describe("pending chats", () => {
  it.live("open with the card's greeting, unlisted, and commit on the first message as if made then", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, mira } = yield* setup
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        assert.strictEqual(draft.status, "pending")
        assert.isNull(draft.lastMessageAt)
        const greeting = yield* greetingOf(userId, draft.id)
        assert.strictEqual(greeting.entry.version.content, "Mira waves from the pier.")
        assert.notInclude(yield* listed(api), draft.id)
        // Reopening it from its URL gives the same chat; the same URL for another entry doesn't.
        assert.strictEqual((yield* api.OpenDraftChat({ draftFor: `card:${mira}`, reopen: draft.id })).id, draft.id)
        const other = yield* api.OpenDraftChat({ draftFor: "empty", reopen: draft.id })
        assert.notStrictEqual(other.id, draft.id)

        yield* Effect.sleep("20 millis")
        const sentAt = Date.now()
        yield* api.SendMessage({
          chatId: draft.id,
          parentSlotId: greeting.entry.slotId,
          branch: false,
          content: "Hello from the boat."
        })
        const chat = yield* api.GetChat({ chatId: draft.id })
        assert.strictEqual(chat.status, "active")
        assert.isAtLeast(chat.createdAt, sentAt)
        assert.isAtLeast(chat.lastMessageAt!, sentAt)
        assert.match(chat.title, /^Mira, /)
        assert.include(yield* listed(api), draft.id)
        // Its page's URL now names a saved chat: reopening it returns it as it is.
        assert.strictEqual((yield* api.OpenDraftChat({ draftFor: `card:${mira}`, reopen: draft.id })).id, draft.id)
        // A committed chat is never swept.
        assert.isFalse(yield* (yield* Writer).SweepPendingChat({ userId, chatId: draft.id }))
        assert.strictEqual((yield* api.GetChat({ chatId: draft.id })).status, "active")
      })
    )
  )

  it.live("a saved edit of the greeting commits it", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, mira } = yield* setup
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const greeting = yield* greetingOf(userId, draft.id)
        yield* api.EditVersion({
          slotId: greeting.entry.slotId,
          sourceVersionId: greeting.entry.version.id,
          expectedRowVersion: greeting.entry.rowVersion,
          content: "Mira waves twice."
        })
        assert.strictEqual((yield* api.GetChat({ chatId: draft.id })).status, "active")
        assert.include(yield* listed(api), draft.id)
      })
    )
  )

  it.live("a group's keeps the group's name when committed", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, mira } = yield* setup
        const ana = yield* card(userId, "Ana")
        const group = yield* api.StartChat({
          cards: [mira, ana],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "Hi both.", speakerEntityId: null },
          title: "Pier friends"
        })
        const draft = yield* api.OpenDraftChat({ draftFor: `group:${group.chat.id}` })
        assert.strictEqual(draft.title, "Pier friends")
        const cast = yield* api.GetCast({ chatId: draft.id, slotId: null })
        const members = new Set<EntityId>(cast.participants)
        assert.isTrue(members.has(mira) && members.has(ana))
        const leaf = (yield* api.GetChat({ chatId: draft.id })).activeLeafSlotId
        yield* api.SendMessage({ chatId: draft.id, parentSlotId: leaf, branch: false, content: "Again." })
        const chat = yield* api.GetChat({ chatId: draft.id })
        assert.strictEqual(chat.status, "active")
        assert.strictEqual(chat.title, "Pier friends")
      })
    )
  )

  it.live("one left behind is swept, its typing filed to recovered texts", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, mira } = yield* setup
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const composer = yield* api.OpenComposer({ chatId: draft.id, forkId: null })
        yield* api.SaveComposer({
          chatId: draft.id,
          draftId: composer.id,
          rowVersion: composer.rowVersion,
          session: composer.session,
          next: false,
          operationId: crypto.randomUUID(),
          content: "Remember the tide tables."
        })
        const greeting = yield* greetingOf(userId, draft.id)
        yield* api.SaveMessageDraft({
          target: { _tag: "Edit", versionId: greeting.entry.version.id },
          draftId: null,
          content: "Mira waves, edited but not saved.",
          expectedRowVersion: null,
          expectedSession: null
        })
        yield* api.LeaveDraftChat({ chatId: draft.id })
        yield* Effect.sleep(PENDING_LEFT_MS + 500)
        const gone = yield* Effect.flip(api.GetChat({ chatId: draft.id }))
        assert.strictEqual(gone._tag, "NotFound")
        const recovered = yield* api.ListRecoveredTexts({ limit: 10, before: null })
        const texts = recovered.map((text) => [text.content, text.sourceLabel])
        assert.deepInclude(texts, ["Remember the tide tables.", "New chat with Mira"])
        assert.deepInclude(texts, ["Mira waves, edited but not saved.", "New chat with Mira"])
        // An untouched one files nothing; neither reaches the bin.
        const untouched = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        assert.isTrue(yield* (yield* Writer).SweepPendingChat({ userId, chatId: untouched.id }))
        assert.lengthOf(yield* api.ListRecoveredTexts({ limit: 10, before: null }), recovered.length)
        assert.lengthOf(yield* (yield* Reader).ListBin({ userId, limit: 10, before: null }), 0)
        assert.lengthOf(yield* (yield* Reader).PendingChats({ userId }), 0)
      })
    )
  )

  it.live("duplicating the greeting commits it", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, mira } = yield* setup
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const greeting = yield* greetingOf(userId, draft.id)
        const inserted = yield* api.InsertMessage({
          chatId: draft.id,
          forkId: draft.currentForkId!,
          anchor: greeting.entry.slotId,
          expectedRowVersion: greeting.entry.rowVersion,
          body: { _tag: "Duplicate", versionId: greeting.entry.version.id }
        })
        assert.strictEqual(inserted.chat.status, "active")
        assert.strictEqual((yield* api.GetChat({ chatId: draft.id })).status, "active")
        assert.isFalse(yield* (yield* Writer).SweepPendingChat({ userId, chatId: draft.id }))
      })
    )
  )

  it.live("a History replacement in its greetings commits it, one at a time or in bulk", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, mira } = yield* setup
        const replace = (chatId: string, forkId: string, versions: ReadonlyArray<{ id: string; content: string }>) =>
          api.ApplyHistoryEdits({
            title: "Rename",
            applications: [
              {
                chatId: chatId as never,
                forkId: forkId as never,
                edits: versions.map((version) => ({
                  kind: "version_replace" as const,
                  targetId: version.id,
                  beforeId: version.id,
                  before: version.content,
                  after: version.content.replace("waves", "nods")
                }))
              }
            ]
          })
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const greeting = yield* greetingOf(userId, draft.id)
        yield* replace(draft.id, draft.currentForkId!, [greeting.entry.version])
        assert.strictEqual((yield* api.GetChat({ chatId: draft.id })).status, "active")
        assert.isFalse(yield* (yield* Writer).SweepPendingChat({ userId, chatId: draft.id }))

        // Two greetings at once take the bulk path.
        const ana = yield* card(userId, "Ana")
        const group = yield* api.StartChat({
          cards: [mira, ana],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "Hi both.", speakerEntityId: null },
          title: "Pier friends"
        })
        const both = yield* api.OpenDraftChat({ draftFor: `group:${group.chat.id}` })
        const last = yield* greetingOf(userId, both.id)
        const first = yield* (yield* Reader).GetSlot({ userId, slotId: last.entry.parentSlotId! })
        yield* replace(both.id, both.currentForkId!, [first.entry.version, last.entry.version])
        assert.strictEqual((yield* api.GetChat({ chatId: both.id })).status, "active")
      })
    )
  )

  it.live("a sweep files the composer's protected history, even once it was cleared", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, mira } = yield* setup
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const composer = yield* api.OpenComposer({ chatId: draft.id, forkId: null })
        const paragraph = "The lighthouse keeper counted the boats twice before dawn, then wrote them down."
        const typed = yield* api.SaveComposer({
          chatId: draft.id,
          draftId: composer.id,
          rowVersion: composer.rowVersion,
          session: composer.session,
          next: false,
          operationId: crypto.randomUUID(),
          content: paragraph
        })
        // Select all and clear it: the paragraph is only in the draft's history now.
        yield* api.SaveComposer({
          chatId: draft.id,
          draftId: composer.id,
          rowVersion: typed.draft!.rowVersion,
          session: typed.draft!.session,
          next: false,
          operationId: crypto.randomUUID(),
          content: ""
        })
        assert.isTrue(yield* (yield* Writer).SweepPendingChat({ userId, chatId: draft.id }))
        const recovered = yield* api.ListRecoveredTexts({ limit: 10, before: null })
        assert.deepInclude(
          recovered.map((text) => [text.content, text.sourceLabel]),
          [paragraph, "New chat with Mira"]
        )
      })
    )
  )
})
