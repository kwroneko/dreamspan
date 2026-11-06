import { assert, it } from "@effect/vitest"
import type { ShellCards, ShellCardsUpdate, ShellForks, ShellForksUpdate } from "@rp/shared/chatSetupApi.ts"
import { applyShellCards, applyShellForks, shellCardsUpdate } from "@rp/shared/shellUpdates.ts"
import { Effect, Stream } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually } from "./support/generation.ts"

const waitFor = (label: string, check: () => boolean) =>
  eventually(check).pipe(Effect.catchCause(() => Effect.die(new Error(`Shell stream: ${label}`))))

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
