import { assert, it } from "@effect/vitest"
import type { ShellCards, ShellCardsUpdate, ShellForks, ShellForksUpdate } from "@rp/shared/chatSetupApi.ts"
import { applyShellCards, applyShellForks } from "@rp/shared/shellUpdates.ts"
import { Effect, Stream } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually } from "./support/generation.ts"

const waitFor = (label: string, check: () => boolean) =>
  eventually(check).pipe(Effect.catchCause(() => Effect.die(new Error(`Shell stream: ${label}`))))

it.live("shell streams push changed rows, page movement and deletion without a chat subscription", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const card = yield* api.CreateCard({ label: "Mira", name: "Mira" })
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
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)
