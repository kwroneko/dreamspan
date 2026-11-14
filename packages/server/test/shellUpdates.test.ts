import { isDeepStrictEqual } from "node:util"
import { assert, it } from "@effect/vitest"
import type { ShellCards, ShellCardsUpdate, ShellForks, ShellForksUpdate } from "@rp/shared/chatSetupApi.ts"
import { applyShellCards, applyShellForks, shellCardsUpdate, shellForksUpdate } from "@rp/shared/shellUpdates.ts"
import { Deferred, Effect, Stream } from "effect"
import { CurrentUser } from "@rp/shared/api.ts"
import { makeChatSetupHandlers } from "../src/api/chatSetup.ts"
import { Writer } from "../src/db/Database.ts"
import { CacheWarmth } from "../src/chat/CacheWarmth.ts"
import { Generations } from "../src/chat/Generations.ts"
import { Generator } from "../src/chat/Generator.ts"
import { ChatHub } from "../src/chat/ChatHub.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually } from "./support/generation.ts"

const waitFor = (label: string, check: () => boolean) =>
  eventually(check).pipe(Effect.catchCause(() => Effect.die(new Error(`Shell stream: ${label}`))))

it.live("replaying a shared shell snapshot persists its summaries once", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const me = yield* api.Whoami()
    yield* api.CreateChat({ title: "Shared persistence fixture" })
    const writer = yield* Writer
    const stored = yield* Deferred.make<void>()
    let writes = 0
    const original = writer.StoreForkSummaries
    const counted: typeof original = (payload, options) =>
      Effect.suspend(() => {
        writes++
        return original(payload, options).pipe(Effect.tap(() => Deferred.succeed(stored, undefined)))
      })
    // These one-shot display reads must never start generation or estimates.
    const unused = <A extends object>(): A =>
      new Proxy(
        {},
        {
          get: () => {
            throw new Error("shell read accessed generation")
          }
        }
      ) as A
    const handlers = yield* makeChatSetupHandlers.pipe(
      Effect.provideService(Writer, { ...writer, StoreForkSummaries: counted }),
      Effect.provideService(CacheWarmth, unused<CacheWarmth["Service"]>()),
      Effect.provideService(Generations, unused<Generations["Service"]>()),
      Effect.provideService(Generator, unused<Generator["Service"]>()),
      Effect.provide(ChatHub.layer)
    )
    yield* handlers.GetShellCards().pipe(Effect.provideService(CurrentUser, me))
    yield* Deferred.await(stored)
    yield* handlers.GetShellLibrary().pipe(Effect.provideService(CurrentUser, me))
    yield* handlers
      .GetShellForks({ entity: null, chat: null, search: "", sort: "recent", sections: [{ id: "chats", limit: 100 }] })
      .pipe(Effect.provideService(CurrentUser, me))
    yield* writer.Ready()
    assert.strictEqual(writes, 1)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)

it.live("shell streams push changed rows, page movement and deletion without a chat subscription", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const card = yield* api.CreateCard({ label: "Mira", name: "Mira" })
    const archived = yield* api.CreateCard({ label: "Archived pilot", name: "Archived pilot" })
    const persona = yield* api.CreateCard({ label: "Archived persona", name: "Archived persona" })
    yield* api.SetPersona({ entityId: persona.entityId, persona: true })
    yield* api.SetRefArchived({ refId: archived.id, archived: true })
    yield* api.SetRefArchived({ refId: persona.id, archived: true })
    const start = (content: string) =>
      api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content, speakerEntityId: null }
      })
    const first = yield* start("First")
    const other = yield* start("Other")
    const updates: Array<ShellForksUpdate> = []
    const cards: Array<ShellCardsUpdate> = []
    let rows: ShellForks | undefined
    let library: ShellCards | undefined
    yield* api
      .WatchShellForks({ entity: null, chat: null, search: "", sort: "recent", sections: [{ id: "chats", limit: 2 }] })
      .pipe(
        Stream.runForEach((update) =>
          Effect.sync(() => {
            updates.push(update)
            rows = applyShellForks(rows, update)
          })
        ),
        Effect.forkScoped
      )
    yield* api.WatchShellCards().pipe(
      Stream.runForEach((update) =>
        Effect.sync(() => {
          cards.push(update)
          library = applyShellCards(library, update)
        })
      ),
      Effect.forkScoped
    )
    yield* waitFor("initial snapshots", () => updates.length > 0 && cards.length > 0)
    assert.deepStrictEqual(library, { ...(yield* api.GetShellCards()) })
    assert.deepStrictEqual(
      new Set(library!.archived.map((row) => row.card.entityId)),
      new Set([archived.entityId, persona.entityId])
    )
    const archivedRows = library!.archived
    const unchanged = rows!.sections[0]!.rows.find((row) => row.chat.id === other.chat.id)!
    yield* posted(
      api.SendMessage({
        chatId: first.chat.id,
        parentSlotId: first.chat.activeLeafSlotId,
        branch: false,
        content: "Changed",
        reply: false
      })
    )
    yield* waitFor("changed sidebar row", () => rows!.sections[0]!.rows[0]?.preview === "Changed")
    const update = updates.at(-1)!
    assert.deepStrictEqual(
      update.sections[0]!.rows.map((row) => row.chat.id),
      [first.chat.id]
    )
    assert.strictEqual(
      rows!.sections[0]!.rows.find((row) => row.chat.id === other.chat.id),
      unchanged
    )
    yield* waitFor("changed card activity", () => library!.cards[0]!.card.latestChatId === first.chat.id)
    assert.lengthOf(cards.at(-1)!.cards, 1)
    assert.lengthOf(cards.at(-1)!.archived, 0)
    assert.deepStrictEqual(library!.archived, archivedRows)
    for (const row of library!.archived) assert.isTrue(archivedRows.includes(row))
    yield* api.DeleteChat({ chatId: first.chat.id })
    yield* waitFor("deleted row", () => rows!.sections[0]!.total === 1)
    assert.deepStrictEqual(
      rows!.sections[0]!.rows.map((row) => row.chat.id),
      [other.chat.id]
    )
    const snapshot = yield* api.GetShellForks({
      entity: null,
      chat: null,
      search: "",
      sort: "recent",
      sections: [{ id: "chats", limit: 2 }]
    })
    assert.deepStrictEqual(rows, { ...snapshot })
    // A reconnect starts with a complete current snapshot, independent of prior deltas.
    const initial = yield* api
      .WatchShellForks({ entity: null, chat: null, search: "", sort: "recent", sections: [{ id: "chats", limit: 2 }] })
      .pipe(Stream.take(1), Stream.runCollect)
    assert.deepStrictEqual(applyShellForks(undefined, initial[0]!), { ...snapshot })
    const cardInitial = yield* api.WatchShellCards().pipe(Stream.take(1), Stream.runCollect)
    let current = applyShellCards(undefined, cardInitial[0]!)
    assert.deepStrictEqual(current, { ...(yield* api.GetShellCards()) })
    const reordered = { ...current, archived: [...current.archived].reverse() }
    const orderOnly = shellCardsUpdate(current, reordered)
    assert.lengthOf(orderOnly.archived, 0)
    assert.deepStrictEqual(applyShellCards(current, orderOnly), reordered)
    // Explicit archive actions restart the client stream. The same delta/reducer
    // path must also handle moves in either direction without retaining old rows.
    for (const [refId, isArchived] of [
      [card.id, true],
      [persona.id, false],
      [card.id, false],
      [archived.id, false]
    ] as const) {
      yield* api.SetRefArchived({ refId, archived: isArchived })
      const next = yield* api.GetShellCards()
      current = applyShellCards(current, shellCardsUpdate(current, next))
      assert.deepStrictEqual(current, { ...next })
    }
    assert.lengthOf(current.archived, 0)
    assert.lengthOf(current.cards, 2)
    assert.strictEqual(current.cards.find((row) => row.card.entityId === archived.entityId)!.persona, false)
    assert.strictEqual(current.personas[0]!.card.entityId, persona.entityId)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)

it.live("thread labels survive shell deltas when the same fork appears in several sections", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const card = yield* api.CreateCard({ label: "Mira", name: "Mira" })
    const made = yield* api.StartChat({
      cards: [card.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "At the quay", speakerEntityId: null }
    })
    const chatId = made.chat.id
    const forkId = made.chat.currentForkId!
    const entry = (yield* api.ReadPath({ chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 }))
      .entries[0]!
    const started = yield* api.StartThreads({
      chatId,
      forkId,
      slotId: entry.slotId,
      expectedRowVersion: entry.rowVersion,
      threads: [
        { name: "Quay", cast: [card.entityId], writesAs: null },
        { name: "Docks", cast: [card.entityId], writesAs: null }
      ]
    })
    const view = {
      entity: null,
      chat: chatId,
      search: "",
      sort: "recent" as const,
      sections: [
        { id: "threads" as const, limit: 100 },
        { id: "current" as const, limit: 100 }
      ]
    }
    let watched: ShellForks | undefined
    yield* api.WatchShellForks(view).pipe(
      Stream.runForEach((update) =>
        Effect.sync(() => {
          watched = applyShellForks(watched, update)
        })
      ),
      Effect.forkScoped
    )
    const first = yield* api.GetShellForks(view)
    yield* waitFor("thread snapshot", () => isDeepStrictEqual(watched, { ...first }))
    let applied = applyShellForks(undefined, shellForksUpdate(undefined, first))
    assert.deepStrictEqual(applied, { ...first })
    const set = (yield* api.ThreadsOf({ chatId, forkId }))[0]!
    yield* api.RenameThread({
      chatId,
      splitId: started.splitId,
      ordinal: 1,
      name: "Harbor",
      rowVersion: set.threads[1]!.rowVersion
    })
    const next = yield* api.GetShellForks(view)
    applied = applyShellForks(applied, shellForksUpdate(first, next))
    assert.deepStrictEqual(applied, { ...next })
    yield* waitFor("renamed thread labels", () => isDeepStrictEqual(watched, { ...next }))
    const item = yield* api.UndoThreads({ chatId, splitId: started.splitId })
    const undone = yield* api.GetShellForks(view)
    yield* waitFor("undone thread rows", () => isDeepStrictEqual(watched, { ...undone }))
    assert.lengthOf(undone.sections[0]!.rows, 0)
    yield* api.RestoreBinItem({ itemId: item.id })
    const restored = yield* api.GetShellForks(view)
    yield* waitFor("restored thread rows", () => isDeepStrictEqual(watched, { ...restored }))
    const again = yield* api.UndoThreads({ chatId, splitId: started.splitId })
    yield* api.PurgeBinItem({ itemId: again.id })
    const purged = yield* api.GetShellForks(view)
    yield* waitFor("purged thread rows", () => isDeepStrictEqual(watched, { ...purged }))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)
