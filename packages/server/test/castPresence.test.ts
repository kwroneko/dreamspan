import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { eventually, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const setup = Effect.gen(function* () {
  const api = yield* client()
  const reader = yield* Reader
  const writer = yield* Writer
  const userId = (yield* api.Whoami()).id as UserId
  const card = (name: string) =>
    writer.CreateEntity({
      userId,
      kind: "card",
      label: name,
      subtitle: "",
      doc: cardDoc(name),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
  const host = yield* card("Host")
  const guest = yield* card("Visitor")
  const chat = yield* writer.CreateChat({
    userId,
    kind: "rp",
    status: "active",
    title: "Synthetic story",
    participants: [host.entityId],
    greeting: null
  })
  const forkId = chat.currentForkId as ForkId
  const version = (speaker: EntityId | null = host.entityId) =>
    new NewVersion({
      speakerEntityId: speaker,
      writer: "human",
      content: "A synthetic turn.",
      status: "complete",
      macroMode: "verbatim",
      origin: "user_written"
    })
  const append = (parentSlotId: SlotId | null, fork = forkId, speaker: EntityId | null = host.entityId) =>
    writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId: fork,
      parentSlotId,
      branch: false,
      version: version(speaker),
      commitDraft: null
    })
  const root = yield* append(null)
  const tip = yield* append(root.slotId)
  const cast = (key: "participant.join" | "participant.leave", slotId = tip.slotId, fork = forkId) =>
    writer.AddStateEvent({
      userId,
      chatId: chat.id,
      forkId: fork,
      slotId,
      versionId: null,
      scope: null,
      data: { key, value: { entity: guest.entityId } }
    })
  const usage = () =>
    Effect.map(reader.CardUsage({ userId }), (rows) => rows.find((c) => c.entityId === guest.entityId)!)
  const shell = () => reader.ShellLibrary({ userId })
  const state = (slotId = tip.slotId, fork = forkId) =>
    Effect.map(reader.StateEventsAt({ userId, chatId: chat.id, slotId, forkId: fork }), foldState)
  const swipe = (slotId: SlotId, speaker: EntityId = host.entityId) =>
    writer.AddVersion({
      userId,
      slotId,
      forkId,
      version: version(speaker),
      select: false,
      commitDraft: null
    })
  return {
    api,
    reader,
    writer,
    userId,
    host,
    guest,
    chatId: chat.id,
    forkId,
    root,
    tip,
    append,
    cast,
    usage,
    shell,
    state,
    swipe
  }
})

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))

describe("cast participation", () => {
  it.live("being away establishes no participation until a retained swipe has the character present", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup
        yield* t.cast("participant.join")
        yield* t.writer.AddStateEvent({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.forkId,
          slotId: t.tip.slotId,
          versionId: null,
          scope: null,
          data: { key: "away.set", value: { entity: t.guest.entityId, away: true } }
        })
        const next = yield* t.append(t.tip.slotId, t.forkId)
        yield* t.cast("participant.leave", next.slotId)
        assert.strictEqual((yield* t.usage()).chats, 0)
        assert.notInclude((yield* t.shell()).forks.find((f) => f.forkId === t.forkId)!.joined, t.guest.entityId)
        // A later positional correction affects new swipes, preserving the old away record.
        yield* t.writer.AddStateEvent({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.forkId,
          slotId: t.tip.slotId,
          versionId: null,
          scope: null,
          data: { key: "away.set", value: { entity: t.guest.entityId, away: false } }
        })
        yield* t.swipe(next.slotId)
        assert.strictEqual((yield* t.usage()).chats, 1)
      })
    )
  )

  it.live("writing as the selected persona establishes presence and dates its usage without generation", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup
        const { api, writer, userId, guest, chatId, forkId } = t
        yield* writer.SetEntityTags({ userId, entityId: guest.entityId, tags: ["persona"] })
        yield* api.ChangeCast({
          chatId,
          forkId,
          slotId: t.tip.slotId,
          change: { _tag: "Persona", entityId: guest.entityId }
        })
        const sent = yield* t.append(t.tip.slotId, forkId, guest.entityId)
        const shell = yield* api.GetShellCards()
        const persona = shell.personas.find((c) => c.card.entityId === guest.entityId)!
        assert.strictEqual(persona.card.chats, 1)
        assert.strictEqual(persona.card.lastMessageAt, sent.version.createdAt)
        assert.strictEqual(persona.open?.slot, sent.slotId)
        assert.isFalse(shell.cards.some((c) => c.card.entityId === guest.entityId))
        assert.deepStrictEqual(
          (yield* api.ListChats({ entityId: guest.entityId, limit: 50, before: null })).map((c) => c.id),
          [chatId]
        )
        // A later alternative written by the user remains evidence after selecting another author.
        const swipe = yield* t.swipe(t.root.slotId, guest.entityId)
        const after = (yield* api.GetShellCards()).personas.find((c) => c.card.entityId === guest.entityId)!
        assert.strictEqual(after.card.lastMessageAt, swipe.createdAt)
        assert.strictEqual(after.open?.slot, t.root.slotId)
        yield* api.CreateFork({ chatId, fromForkId: forkId, atSlotId: sent.slotId })
        const branched = (yield* api.GetShellCards()).personas.find((c) => c.card.entityId === guest.entityId)!
        assert.strictEqual(branched.card.chats, 1, "branches of one chat count once for a persona")
      })
    )
  )

  it.live("add then remove changes none of the membership, recency, group, search, impact or export reads", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup
        const { reader, writer, userId, guest, chatId, forkId } = t
        const observe = Effect.gen(function* () {
          const { fresh: _, ...shell } = yield* t.shell()
          const scoped = yield* reader.ShellForks({
            userId,
            view: {
              entity: guest.entityId,
              chat: null,
              search: "",
              sort: "recent",
              sections: ["card", "was", "just", "with"].map((id) => ({
                id: id as "card" | "was" | "just" | "with",
                limit: 50
              }))
            }
          })
          return {
            shell,
            scoped: scoped.sections,
            usage: yield* reader.CardUsage({ userId }),
            chats: yield* reader.ListChats({ userId, entityId: guest.entityId, limit: 50, before: null }),
            search: yield* reader.ListChats({ userId, search: "Visitor", limit: 50, before: null }),
            groups: yield* reader.ChatGroups({ userId }),
            summaries: yield* reader.ChatSummaries({ userId, chatIds: [chatId] }),
            family: yield* reader.CardFamily({ userId, entityId: guest.entityId }),
            impact: (yield* reader.OpenEditor({ userId, refId: guest.ref.id })).usedByChats,
            replace: yield* reader.CardReplaceSource({ userId, refId: guest.ref.id }),
            export: yield* reader.ExportSource({ userId, refId: guest.ref.id }),
            card: yield* reader.GetRef({ userId, refId: guest.ref.id }),
            cast: yield* t.api.GetCast({ chatId, forkId, slotId: t.tip.slotId })
          }
        })
        const before = yield* observe
        yield* t.cast("participant.join")
        assert.include((yield* t.state()).participants, guest.entityId, "cast changes immediately")
        assert.strictEqual((yield* t.usage()).chats, 0, "configuration alone is not use")
        yield* t.cast("participant.leave")
        assert.deepStrictEqual(yield* observe, before)
        // The retained state events are allowed audit history, not evidence of participation.
        const events = yield* reader.StateEventsAt({ userId, chatId, slotId: t.tip.slotId, forkId })
        assert.strictEqual(events.filter((e) => e.data.key === "participant.join").length, 2)
        const fresh = yield* t.shell()
        yield* writer.StoreForkSummaries({ userId, chats: fresh.fresh })
        assert.deepStrictEqual(yield* observe, before, "stored summaries obey the same rule")
      })
    )
  )

  it.live("a version written while connected counts after removal, including a muted silent member", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup
        yield* t.cast("participant.join")
        yield* t.writer.AddStateEvent({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.forkId,
          slotId: t.tip.slotId,
          versionId: null,
          scope: null,
          data: { key: "presence.set", value: { entity: t.guest.entityId, present: false } }
        })
        const next = yield* t.append(t.tip.slotId)
        yield* t.cast("participant.leave", next.slotId)
        assert.strictEqual((yield* t.usage()).chats, 1)
        const shell = yield* t.shell()
        const row = shell.cards.find((c) => c.card.entityId === t.guest.entityId)!
        assert.strictEqual(row.card.chats, 1)
        assert.isNotNull(row.recentAt)
        assert.include(shell.forks[0]!.departed, t.guest.entityId)
        assert.include(
          (yield* t.api.GetCast({ chatId: t.chatId, forkId: t.forkId, slotId: next.slotId })).cards.map(
            (c) => c.entityId
          ),
          t.guest.entityId
        )
        assert.strictEqual((yield* t.reader.OpenEditor({ userId: t.userId, refId: t.guest.ref.id })).usedByChats, 1)
        assert.strictEqual(
          (yield* t.reader.CardFamily({ userId: t.userId, entityId: t.guest.entityId })).members[0]!.chats,
          1
        )
        assert.strictEqual(
          (yield* t.reader.CardReplaceSource({ userId: t.userId, refId: t.guest.ref.id })).followingChats,
          1
        )
      })
    )
  )

  it.live("an unselected swipe at an earlier position counts when its historical cast includes the card", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup
        yield* t.cast("participant.join", t.root.slotId)
        const swipe = yield* t.swipe(t.tip.slotId)
        yield* t.cast("participant.leave", t.root.slotId)
        assert.strictEqual((yield* t.usage()).chats, 1)
        const slot = yield* t.reader.GetSlot({ userId: t.userId, slotId: t.tip.slotId, forkId: t.forkId })
        assert.notStrictEqual(slot.entry.version.id, swipe.id)
        assert.include((yield* t.shell()).forks[0]!.joined, t.guest.entityId)
      })
    )
  )

  it.live("a tip-only join does not count for an earlier swipe, but writing as that card does", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup
        yield* t.cast("participant.join")
        yield* t.swipe(t.root.slotId)
        yield* t.cast("participant.leave")
        assert.strictEqual((yield* t.usage()).chats, 0)
        assert.notInclude((yield* t.shell()).forks[0]!.joined, t.guest.entityId)
        yield* t.swipe(t.root.slotId, t.guest.entityId)
        assert.strictEqual((yield* t.usage()).chats, 1)
        assert.include((yield* t.shell()).forks[0]!.joined, t.guest.entityId)
      })
    )
  )

  it.live("a branch made while present keeps its cast but gains participation only with an authored version", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup
        yield* t.cast("participant.join")
        const fork = (yield* t.writer.CreateFork({
          userId: t.userId,
          chatId: t.chatId,
          fromForkId: t.forkId,
          atSlotId: t.tip.slotId
        })).fork
        yield* t.cast("participant.leave")
        assert.strictEqual((yield* t.usage()).chats, 0)
        assert.include((yield* t.state(t.tip.slotId, fork.id)).participants, t.guest.entityId)
        const next = yield* t.append(t.tip.slotId, fork.id)
        yield* t.cast("participant.leave", next.slotId, fork.id)
        const shell = yield* t.shell()
        assert.include(shell.forks.find((f) => f.forkId === fork.id)!.joined, t.guest.entityId)
        assert.notInclude(shell.forks.find((f) => f.forkId === t.forkId)!.joined, t.guest.entityId)
        assert.strictEqual((yield* t.usage()).chats, 1)
      })
    )
  )

  it.live("undoing the cast event preserves evidence of the version actually written with it", () =>
    run(
      Effect.gen(function* () {
        const t = yield* setup
        const applied = yield* t.api.ApplyHistoryEdits({
          title: "Cast",
          applications: [
            {
              chatId: t.chatId,
              forkId: t.forkId,
              edits: [
                {
                  kind: "state_event",
                  targetId: "",
                  beforeId: "",
                  before: "",
                  after: JSON.stringify({
                    scope: null,
                    data: { key: "participant.join", value: { entity: t.guest.entityId } }
                  })
                }
              ]
            }
          ]
        })
        assert.strictEqual((yield* t.usage()).chats, 0)
        yield* t.append(t.tip.slotId)
        yield* t.api.UndoHistoryEdit({ chatId: t.chatId, forkId: t.forkId, changesetId: applied.changesetIds[0]! })
        assert.notInclude((yield* t.state()).participants, t.guest.entityId)
        assert.strictEqual((yield* t.usage()).chats, 1)
        assert.include((yield* t.shell()).forks[0]!.joined, t.guest.entityId)
      })
    )
  )

  it.live("an actual earlier-message generation records its assembled cast, not a later tip join", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) =>
            sse(res, completionChunks(["A response."], { prompt_tokens: 10, completion_tokens: 2 }))
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { chat, version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      const guest = yield* api.CreateCard({ label: "Visitor", name: "Visitor" })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: version.slotId,
        change: { _tag: "Join", entityId: guest.entityId }
      })
      const path = yield* api.ReadPath({
        chatId: chat.id,
        leafSlotId: version.slotId,
        limit: 20,
        range: { _tag: "Bottom" }
      })
      const target = path.entries[0]!
      yield* api.Regenerate({ slotId: target.slotId, expectedRowVersion: target.rowVersion })
      yield* eventually(() => mock.requests().length >= 2)
      assert.notInclude(JSON.stringify(mock.requests().at(-1)!.body), "Visitor")
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: version.slotId,
        change: { _tag: "Leave", entityId: guest.entityId }
      })
      assert.strictEqual((yield* api.ListCardUsage()).find((c) => c.entityId === guest.entityId)!.chats, 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
