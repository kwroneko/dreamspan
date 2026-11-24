// A pending chat's edges (DESIGN §2.1, db/pendingChats.ts): what a cast change, a leave, a sweep
// and a late save do to the user's typing and to the account, with a reopen or a send in between.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, EntityId, VersionId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { DraftKey } from "@dreamspan/shared/drafts.ts"
import { Effect } from "effect"
import { DatabaseSync } from "node:sqlite"
import { databaseFile } from "../src/db/connection.ts"
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

  it.live("a group-only greeting goes when its character, binned meanwhile, is left alone in the draft", () =>
    run(
      Effect.gen(function* () {
        const { api, make, writer, userId } = yield* setup
        const mira = yield* make("Mira", { group_only_greetings: ["Mira greets everyone."] })
        const tobin = yield* make("Tobin")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const forkId = draft.currentForkId!
        yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Join", entityId: tobin } })
        const [first] = yield* path(api, draft.id)
        const versions = () =>
          Effect.map(api.ListVersions({ slotId: first!.slotId }), (all) => all.map((v) => v.content))
        assert.include(yield* versions(), "Mira greets everyone.")
        // Mira's card goes to the bin in another tab; then Tobin leaves.
        yield* writer.DeleteEntity({ userId, entityId: mira })
        yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Leave", entityId: tobin } })
        assert.notInclude(yield* versions(), "Mira greets everyone.")
        assert.include(yield* versions(), "Mira waves.")
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
  it.live("an old workshop page's first message, saved after the upgrade, goes to recovered texts", () =>
    run(
      Effect.gen(function* () {
        const { api, writer, userId } = yield* setup
        const key = new DraftKey({ targetKind: "user_field", targetId: "pending-workshop:new", field: "First message" })
        yield* writer.SaveDraft({
          userId,
          key,
          draftId: null,
          content: "Typed on the old workshop page.",
          expectedRowVersion: null,
          expectedSession: null,
          baseRevision: null
        })
        const recovered = yield* api.ListRecoveredTexts({ limit: 50, before: null })
        assert.deepInclude(
          recovered.map((text) => [text.content, text.sourceLabel]),
          ["Typed on the old workshop page.", "New workshop"]
        )
        assert.isNull(yield* (yield* Reader).GetDraft({ userId, key }))
      })
    )
  )
  it.live("the old workshop pages' first messages go to recovered texts as the server starts, history and all", () => {
    const config = testConfig()
    const layer = () => serverLayer(config, Generator.none)
    const typed = "Ask the assistant to tidy the harbor lorebook."
    return Effect.gen(function* () {
      // Saved before the upgrade, then cleared: the text is only in its history.
      const { userId, story } = yield* Effect.gen(function* () {
        const { api, writer, userId } = yield* setup
        const story = yield* api.CreateChat({ title: "Harbor" })
        const key = new DraftKey({ targetKind: "user_field", targetId: `before-${story.id}`, field: "First message" })
        const first = yield* writer.SaveDraft({
          userId,
          key,
          draftId: null,
          content: typed,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevision: null
        })
        yield* writer.SaveDraft({
          userId,
          key,
          draftId: first.id,
          content: "",
          expectedRowVersion: first.rowVersion,
          expectedSession: first.session,
          baseRevision: null
        })
        return { userId, story }
      }).pipe(Effect.scoped, Effect.provide(layer()))
      // The key the old Workshop tab used.
      const db = new DatabaseSync(databaseFile(config.dataDir))
      db.prepare(`UPDATE drafts SET target_id = ? WHERE target_id = ?`).run(
        `pending-workshop:${story.id}`,
        `before-${story.id}`
      )
      db.close()
      yield* Effect.gen(function* () {
        const api = yield* client()
        const recovered = yield* api.ListRecoveredTexts({ limit: 50, before: null })
        assert.deepInclude(
          recovered.map((text) => [text.content, text.sourceLabel]),
          [typed, "Workshop about Harbor"]
        )
        const key = new DraftKey({
          targetKind: "user_field",
          targetId: `pending-workshop:${story.id}`,
          field: "First message"
        })
        assert.isNull(yield* (yield* Reader).GetDraft({ userId, key }))
      }).pipe(Effect.scoped, Effect.provide(layer()))
    })
  })
  it.live("purging a card swapped into a pending chat sweeps it", () =>
    run(
      Effect.gen(function* () {
        const { api, make, writer, userId } = yield* setup
        const mira = yield* make("Mira")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        // Fork for this chat: the fork takes Mira's place by a card.swap.
        const other = yield* api.ForkCardForChat({
          chatId: draft.id,
          slotId: null,
          entityId: mira,
          name: "Mira, for here",
          nickname: "",
          characterVersion: ""
        })
        const item = yield* writer.DeleteEntity({ userId, entityId: other.entityId })
        yield* api.PurgeBinItem({ itemId: item.id })
        assert.strictEqual((yield* Effect.flip(api.GetChat({ chatId: draft.id })))._tag, "NotFound")
      })
    )
  )

  it.live("a new chat with a pending chat's cast opens with its characters", () =>
    run(
      Effect.gen(function* () {
        const { api, make } = yield* setup
        const mira = yield* make("Mira")
        const tobin = yield* make("Tobin")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        yield* api.ChangeCast({
          chatId: draft.id,
          slotId: null,
          forkId: draft.currentForkId!,
          change: { _tag: "Join", entityId: tobin }
        })
        const again = yield* api.OpenDraftChat({ draftFor: `group:${draft.id}` })
        const greeters = (yield* path(api, again.id)).map((entry) => entry.version.speakerEntityId)
        assert.deepStrictEqual(greeters, [mira, tobin])
      })
    )
  )
  it.live("a sweep files every text a composer's history holds, not only its last", () =>
    run(
      Effect.gen(function* () {
        const { api, make, writer, userId } = yield* setup
        const mira = yield* make("Mira")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        let composer = yield* api.OpenComposer({ chatId: draft.id, forkId: null })
        for (const content of ["The tide turns at noon, and the bell rings twice.", "The tide turns"]) {
          const saved = yield* api.SaveComposer({
            chatId: draft.id,
            draftId: composer.id,
            rowVersion: composer.rowVersion,
            session: composer.session,
            next: false,
            operationId: crypto.randomUUID(),
            content
          })
          composer = saved.draft!
        }
        assert.isTrue(yield* writer.SweepPendingChat({ userId, chatId: draft.id }))
        assert.include(yield* recoveredTexts(api), "The tide turns at noon, and the bell rings twice.")
      })
    )
  )

  it.live("a sweep files a greeting edit that was cancelled", () =>
    run(
      Effect.gen(function* () {
        const { api, make, writer, userId } = yield* setup
        const mira = yield* make("Mira")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const [greeting] = yield* path(api, draft.id)
        const target = { _tag: "Edit", versionId: greeting!.version.id } as const
        const edit = yield* editGreeting(api, greeting!.version.id, "Mira waves from the pier, edited.")
        yield* api.DiscardMessageDraft({ target, draftId: edit.id, expectedRowVersion: edit.rowVersion })
        assert.isTrue(yield* writer.SweepPendingChat({ userId, chatId: draft.id }))
        assert.include(yield* recoveredTexts(api), "Mira waves from the pier, edited.")
      })
    )
  )

  it.live("a greeting made again keeps its cancelled edit's history", () =>
    run(
      Effect.gen(function* () {
        const { api, make } = yield* setup
        const mira = yield* make("Mira")
        const tobin = yield* make("Tobin")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const forkId = draft.currentForkId!
        yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Join", entityId: tobin } })
        const [, his] = yield* path(api, draft.id)
        const target = { _tag: "Edit", versionId: his!.version.id } as const
        const edit = yield* editGreeting(api, his!.version.id, "Tobin nods at the harbor, edited.")
        yield* api.DiscardMessageDraft({ target, draftId: edit.id, expectedRowVersion: edit.rowVersion })
        // Mira leaves: Tobin's greeting is made again, and its editor still has the cancelled text.
        yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Leave", entityId: mira } })
        const [again] = yield* path(api, draft.id)
        const states = yield* api.MessageDraftHistory({
          target: { _tag: "Edit", versionId: again!.version.id },
          limit: 20
        })
        assert.isTrue(
          states.some((state) => state.inserted.includes("harbor")),
          JSON.stringify(states)
        )
      })
    )
  )
  it.live("a join asked for on the pending page after another tab's first send goes after it", () =>
    run(
      Effect.gen(function* () {
        const { api, make } = yield* setup
        const mira = yield* make("Mira")
        const tobin = yield* make("Tobin")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const forkId = draft.currentForkId!
        const [greeting] = yield* path(api, draft.id)
        // The other tab's first send lands first.
        yield* api.SendMessage({ chatId: draft.id, parentSlotId: greeting!.slotId, branch: false, content: "Hello." })
        // This tab still shows the chat pending: its join names the start.
        yield* api.ChangeCast({
          chatId: draft.id,
          slotId: null,
          forkId,
          pending: true,
          change: { _tag: "Join", entityId: tobin }
        })
        const entries = yield* path(api, draft.id)
        const atStart = yield* api.GetCast({ chatId: draft.id, slotId: greeting!.slotId, forkId })
        assert.notInclude(atStart.participants, tobin)
        const atTip = yield* api.GetCast({ chatId: draft.id, slotId: entries.at(-1)!.slotId, forkId })
        assert.include(atTip.participants, tobin)
      })
    )
  )
  it.live("a character moved to the bin can still be removed from a new chat", () =>
    run(
      Effect.gen(function* () {
        const { api, make, writer, userId } = yield* setup
        const mira = yield* make("Mira")
        const tobin = yield* make("Tobin")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const forkId = draft.currentForkId!
        yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Join", entityId: tobin } })
        yield* writer.DeleteEntity({ userId, entityId: tobin })
        const cast = yield* api.ChangeCast({
          chatId: draft.id,
          slotId: null,
          forkId,
          change: { _tag: "Leave", entityId: tobin }
        })
        assert.deepStrictEqual(cast.participants, [mira])
        assert.deepStrictEqual(
          (yield* path(api, draft.id)).map((entry) => entry.version.content),
          ["Mira waves."]
        )
      })
    )
  )
  it.live("a save after a sweep is held to the composer's size limit, as a live save is", () =>
    run(
      Effect.gen(function* () {
        const { api, make, writer, userId } = yield* setup
        const mira = yield* make("Mira")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const composer = yield* api.OpenComposer({ chatId: draft.id, forkId: null })
        assert.isTrue(yield* writer.SweepPendingChat({ userId, chatId: draft.id }))
        const refused = yield* api
          .SaveComposer({
            chatId: draft.id,
            draftId: composer.id,
            rowVersion: composer.rowVersion,
            session: composer.session,
            next: false,
            operationId: crypto.randomUUID(),
            content: "x".repeat(1_000_001)
          })
          .pipe(Effect.flip)
        assert.strictEqual(refused._tag, "TextTooLong")
        assert.deepStrictEqual(yield* recoveredTexts(api), [])
      })
    )
  )
  it.live("a greeting edit saved late, after its greeting was made again, reaches the draft that moved", () =>
    run(
      Effect.gen(function* () {
        const { api, make } = yield* setup
        const mira = yield* make("Mira")
        const tobin = yield* make("Tobin")
        const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
        const forkId = draft.currentForkId!
        yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Join", entityId: tobin } })
        const [, his] = yield* path(api, draft.id)
        const first = yield* editGreeting(api, his!.version.id, "Tobin nods.")
        // Another tab removes Mira: Tobin's greeting is made again, his draft moved with it.
        yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Leave", entityId: mira } })
        // This tab's next save still names the old greeting.
        yield* api.SaveMessageDraft({
          target: { _tag: "Edit", versionId: his!.version.id },
          draftId: first.id,
          content: "Tobin nods. He points at the boats.",
          expectedRowVersion: first.rowVersion,
          expectedSession: first.session
        })
        const [again] = yield* path(api, draft.id)
        const kept = yield* api.GetMessageDraft({ target: { _tag: "Edit", versionId: again!.version.id } })
        assert.strictEqual(kept.content, "Tobin nods. He points at the boats.")
      })
    )
  )
  it.live("two persona switches at once leave only the last one in the cast", () =>
    run(
      Effect.gen(function* () {
        const { api, make, writer, userId } = yield* setup
        const mira = yield* make("Mira")
        const persona = (name: string) =>
          Effect.tap(make(name), (entityId) => writer.SetEntityTags({ userId, entityId, tags: ["persona"] }))
        const p = yield* persona("Pia")
        for (let round = 0; round < 8; round++) {
          const q = yield* persona(`Quinn ${round}`)
          const r = yield* persona(`Rhea ${round}`)
          const draft = yield* api.OpenDraftChat({ draftFor: `card:${mira}` })
          const forkId = draft.currentForkId!
          yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Persona", entityId: p } })
          yield* Effect.all(
            [q, r].map((entityId) =>
              api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Persona", entityId } })
            ),
            { concurrency: "unbounded" }
          )
          const cast = yield* api.GetCast({ chatId: draft.id, slotId: null, forkId })
          // As one switch after the other: the persona played, and Mira; no persona left as an NPC.
          assert.strictEqual(cast.playedByMe.length, 1, `round ${round}`)
          assert.sameMembers([...cast.participants], [mira, cast.playedByMe[0]!], `round ${round}`)
        }
      })
    )
  )
  it.live("two characters joined at once both offer their group-only greetings", () =>
    run(
      Effect.gen(function* () {
        const { api, make } = yield* setup
        for (let round = 0; round < 6; round++) {
          const mira = yield* make(`Mira ${round}`, { group_only_greetings: [`Mira ${round} greets everyone.`] })
          const tobin = yield* make(`Tobin ${round}`, { group_only_greetings: [`Tobin ${round} greets everyone.`] })
          const draft = yield* api.OpenDraftChat({ draftFor: "empty" })
          const forkId = draft.currentForkId!
          yield* Effect.all(
            [mira, tobin].map((entityId) =>
              api.ChangeCast({ chatId: draft.id, slotId: null, forkId, change: { _tag: "Join", entityId } })
            ),
            { concurrency: "unbounded" }
          )
          const entries = yield* path(api, draft.id)
          assert.strictEqual(entries.length, 2, `round ${round}`)
          for (const entry of entries) {
            const versions = yield* api.ListVersions({ slotId: entry.slotId })
            assert.isTrue(
              versions.some((version) => version.content.endsWith("greets everyone.")),
              `round ${round}: ${versions.map((version) => version.content).join(" | ")}`
            )
          }
        }
      })
    )
  )
})
