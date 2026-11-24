// A pending chat's edges (DESIGN §2.1, db/pendingChats.ts): what a cast change, a leave, a sweep
// and a late save do to the user's typing and to the account, with a reopen or a send in between.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, EntityId, VersionId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { DraftKey } from "@dreamspan/shared/drafts.ts"
import { Effect } from "effect"
import { PENDING_LEFT_MS } from "../src/api/draftChats.ts"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))

const setup = Effect.gen(function* () {
  const api = yield* client()
  const userId = (yield* api.Whoami()).id as UserId
  const writer = yield* Writer
  const make = (name: string, fields: Record<string, unknown> = {}) =>
    Effect.map(
      writer.CreateEntity({
        userId,
        kind: "card",
        label: name,
        subtitle: "",
        doc: cardDoc(name, { first_mes: `${name} waves.`, ...fields }),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      }),
      (made) => made.entityId as EntityId
    )
  return { api, userId, writer, make }
})

const path = (api: Api, chatId: ChatId) =>
  Effect.map(
    api.ReadPath({ chatId, forkId: null, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 }),
    (read) => read.entries
  )

const recoveredTexts = (api: Api) =>
  Effect.map(api.ListRecoveredTexts({ limit: 50, before: null }), (rows) => rows.map((row) => row.content))

const editGreeting = (api: Api, versionId: VersionId, content: string) =>
  api.SaveMessageDraft({
    target: { _tag: "Edit", versionId },
    draftId: null,
    content,
    expectedRowVersion: null,
    expectedSession: null
  })

describe("a pending chat's edges", () => {
  it.live("a cast change keeps another greeting's unsaved edit", () =>
    run(
      Effect.gen(function* () {
        const { api, make } = yield* setup
        const mira = yield* make("Mira")
        const tobin = yield* make("Tobin", { group_only_greetings: ["Tobin greets everyone."] })
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const forkId = draft.currentForkId!
        yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Join", entityId: tobin } })
        const [, his] = yield* path(api, draft.id)
        yield* editGreeting(api, his!.version.id, "Tobin nods, edited.")
        // Mira leaves: Tobin's message is made again, and his edit goes along with his greeting.
        yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Leave", entityId: mira } })
        const [again] = yield* path(api, draft.id)
        assert.strictEqual(again!.version.content, "Tobin waves.")
        const kept = yield* api.GetMessageDraft({ target: { _tag: "Edit", versionId: again!.version.id } })
        assert.strictEqual(kept.content, "Tobin nods, edited.")
        // A group greeting edited and then no longer offered: its edit is kept in recovered texts.
        yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Join", entityId: mira } })
        const [first] = yield* path(api, draft.id)
        const group = (yield* api.ListVersions({ slotId: first!.slotId })).find(
          (version) => version.content === "Tobin greets everyone."
        )!
        yield* editGreeting(api, group.id, "Tobin greets the crew, edited.")
        yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Leave", entityId: mira } })
        assert.include(yield* recoveredTexts(api), "Tobin greets the crew, edited.")
      })
    )
  )

  it.live("a send racing a join starts the chat with the greetings of the cast it starts with", () =>
    run(
      Effect.gen(function* () {
        const { api, make } = yield* setup
        const mira = yield* make("Mira")
        for (let round = 0; round < 8; round++) {
          const tobin = yield* make(`Tobin ${round}`)
          const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
          const forkId = draft.currentForkId!
          const leaf = draft.activeLeafSlotId
          yield* Effect.all(
            [
              api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Join", entityId: tobin } }),
              api.SendMessage({ chatId: draft.id, parentSlotId: leaf, branch: false, content: "Hello." })
            ],
            { concurrency: "unbounded", mode: "result" }
          )
          // Whoever is in the starting cast greets there; nobody greets who isn't in it.
          const entries = yield* path(api, draft.id)
          const cast = yield* api.GetCast({ chatId: draft.id, slotId: entries[0]!.slotId })
          const greeters = entries
            .filter((entry) => entry.version.origin === "greeting")
            .map((entry) => entry.version.speakerEntityId)
          assert.deepStrictEqual(
            greeters,
            cast.participants.filter((entity) => !cast.playedByMe.includes(entity)),
            `round ${round}`
          )
        }
      })
    )
  )

  it.live("two cast changes at once leave the greetings of the cast they leave", () =>
    run(
      Effect.gen(function* () {
        const { api, make } = yield* setup
        const mira = yield* make("Mira")
        const tobin = yield* make("Tobin")
        const wren = yield* make("Wren")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const forkId = draft.currentForkId!
        yield* Effect.all(
          [tobin, wren].map((entityId) =>
            api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Join", entityId } })
          ),
          { concurrency: "unbounded" }
        )
        const cast = yield* api.GetCast({ chatId: draft.id, slotId: null })
        const greeters = (yield* path(api, draft.id)).map((entry) => entry.version.speakerEntityId)
        assert.deepStrictEqual(greeters, [...cast.participants])
        assert.lengthOf(greeters, 3)
      })
    )
  )

  it.live("a leave doesn't sweep the chat a tab has just reopened", () =>
    run(
      Effect.gen(function* () {
        const { api, make } = yield* setup
        const mira = yield* make("Mira")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        yield* api.LeaveDraftChat({ chatId: draft.id })
        // Another tab opens its URL just before the leave's timer, and hasn't subscribed yet.
        yield* Effect.sleep(PENDING_LEFT_MS - 500)
        const reopened = yield* api.OpenDraftChat({ draftFor: `card:${mira}`, reopen: draft.id })
        assert.strictEqual(reopened.id, draft.id)
        yield* Effect.sleep(1_500)
        assert.strictEqual((yield* api.GetChat({ chatId: draft.id })).status, "pending")
      })
    )
  )

  it.live("a composer save after a sweep reaches recovered texts", () =>
    run(
      Effect.gen(function* () {
        const { api, make, writer, userId } = yield* setup
        const mira = yield* make("Mira")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const composer = yield* api.OpenComposer({ chatId: draft.id, forkId: null })
        assert.isTrue(yield* writer.SweepPendingChat({ userId, chatId: draft.id }))
        // The tab typed on, offline; its save arrives after the sweep.
        const saved = yield* api.SaveComposer({
          chatId: draft.id,
          draftId: composer.id,
          rowVersion: composer.rowVersion,
          session: composer.session,
          next: false,
          operationId: crypto.randomUUID(),
          content: "Typed while offline."
        })
        assert.isTrue(saved.recovered)
        assert.include(yield* recoveredTexts(api), "Typed while offline.")
      })
    )
  )

  it.live("a character removed before the first send gains no chat", () =>
    run(
      Effect.gen(function* () {
        const { api, make } = yield* setup
        const mira = yield* make("Mira")
        const tobin = yield* make("Tobin")
        const group = yield* api.StartChat({
          cards: [mira, tobin],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "An earlier group chat.", speakerEntityId: null }
        })
        // A group's new chat greets with both; Tobin leaves before the first send.
        const draft = yield* api.OpenDraftChat({ draftFor: `group:${group.chat.id}` })
        const forkId = draft.currentForkId!
        yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Leave", entityId: tobin } })
        const leaf = (yield* api.GetChat({ chatId: draft.id })).activeLeafSlotId
        yield* api.SendMessage({ chatId: draft.id, parentSlotId: leaf, branch: false, content: "Hello." })
        const usage = yield* api.ListCardUsage()
        const chatsOf = (entityId: EntityId) => usage.find((row) => row.entityId === entityId)?.chats ?? 0
        assert.strictEqual(chatsOf(mira), 2)
        assert.strictEqual(chatsOf(tobin), 1)
      })
    )
  )

  it.live("a card forked in a pending chat doesn't name it", () =>
    run(
      Effect.gen(function* () {
        const { api, make } = yield* setup
        const mira = yield* make("Mira")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const fork = yield* api.ForkCardForChat({
          chatId: draft.id,
          slotId: null,
          entityId: mira,
          name: "Mira for this chat",
          nickname: "",
          characterVersion: ""
        })
        const family = yield* api.CardFamily({ entityId: fork.entityId })
        assert.isTrue(family.members.every((member) => member.forkedInChatId === null))
      })
    )
  )
  it.live("an old new-chat page's first message, saved after the upgrade, goes to recovered texts", () =>
    run(
      Effect.gen(function* () {
        const { api, writer, userId, make } = yield* setup
        const mira = yield* make("Mira")
        const key = new DraftKey({ targetKind: "user_field", targetId: `pending-chat:${mira}`, field: "First message" })
        const save = writer.SaveDraft({
          userId,
          key,
          draftId: null,
          content: "Typed on the old page.",
          expectedRowVersion: null,
          expectedSession: null,
          baseRevision: null
        })
        yield* save
        yield* save
        assert.deepStrictEqual(
          (yield* recoveredTexts(api)).filter((text) => text === "Typed on the old page."),
          ["Typed on the old page."]
        )
        assert.isNull(yield* (yield* Reader).GetDraft({ userId, key }))
      })
    )
  )
})
