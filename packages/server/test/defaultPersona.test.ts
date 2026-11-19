// Synthetic cards: account settings resolve only live persona-folder cards, and never
// rewrite a chat's selected persona. Settings still share the existing worker RPCs.
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import { Writer, Reader } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"

const setup = Effect.gen(function* () {
  const api = yield* client()
  const writer = yield* Writer
  const userId = (yield* api.Whoami()).id as UserId
  const a = yield* api.CreateCard({ label: "Pilot", name: "Pilot" })
  const b = yield* api.CreateCard({ label: "Cartographer", name: "Cartographer" })
  for (const card of [a, b]) yield* api.SetPersona({ entityId: card.entityId, persona: true })
  return { api, writer, userId, a, b }
})

describe("default persona", () => {
  it.live("sets, reads and clears one account setting while preserving the other settings and existing chats", () =>
    Effect.gen(function* () {
      const { api, a, b } = yield* setup
      assert.isNull((yield* api.GetGenerationDefaults()).persona)
      yield* api.ChangeGenerationDefaults({ change: { persona: a.entityId, tail: "A summary instruction." } })
      assert.strictEqual(
        yield* outcome(api.ChangeGenerationDefaults({ change: { persona: "" as typeof a.entityId } })),
        "NotFound"
      )
      assert.strictEqual((yield* api.GetGenerationDefaults()).persona, a.entityId)
      const { chat } = yield* api.StartChat({
        cards: [b.entityId],
        persona: a.entityId,
        greeting: null,
        first: { _tag: "Send", content: "Hello.", speakerEntityId: a.entityId }
      })
      yield* api.ChangeGenerationDefaults({ change: { persona: b.entityId } })
      assert.strictEqual((yield* api.GetGenerationDefaults()).lcm?.tail, "A summary instruction.")
      assert.deepStrictEqual((yield* api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId })).playedByMe, [
        a.entityId
      ])
      yield* api.SetGenerationDefaults({ defaults: { model: null, preset: null, persona: a.entityId } })
      assert.strictEqual((yield* api.GetGenerationDefaults()).persona, a.entityId)
      yield* api.ChangeGenerationDefaults({ change: { model: null } })
      assert.strictEqual((yield* api.GetGenerationDefaults()).persona, a.entityId)
      yield* api.ChangeGenerationDefaults({ change: { persona: null } })
      assert.isNull((yield* api.GetGenerationDefaults()).persona)
      assert.deepStrictEqual((yield* api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId })).playedByMe, [
        a.entityId
      ])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("ignores a deleted, archived or no-longer-persona default and refuses setting one", () =>
    Effect.gen(function* () {
      const { api, writer, userId, a } = yield* setup
      const select = () => api.ChangeGenerationDefaults({ change: { persona: a.entityId } })
      yield* select()
      yield* writer.SetEntityArchived({ userId, entityId: a.entityId, archived: true })
      assert.isNull((yield* api.GetGenerationDefaults()).persona)
      assert.strictEqual(yield* outcome(select()), "NotFound")
      yield* writer.SetEntityArchived({ userId, entityId: a.entityId, archived: false })
      yield* select()
      yield* api.SetPersona({ entityId: a.entityId, persona: false })
      assert.isNull((yield* api.GetGenerationDefaults()).persona)
      assert.strictEqual(yield* outcome(select()), "NotFound")
      yield* api.SetPersona({ entityId: a.entityId, persona: true })
      yield* select()
      yield* writer.DeleteEntity({ userId, entityId: a.entityId })
      assert.isNull((yield* api.GetGenerationDefaults()).persona)
      assert.strictEqual(yield* outcome(select()), "NotFound")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("keeps accounts separate and refuses another account's persona through both writes", () =>
    Effect.gen(function* () {
      const { api, writer, userId, a } = yield* setup
      yield* api.ChangeGenerationDefaults({ change: { persona: a.entityId } })
      const other = (yield* writer.EnsureUser({ handle: "other", displayName: "Other" })).id as UserId
      assert.strictEqual(
        (yield* Effect.flip(writer.ChangeGenerationDefaults({ userId: other, change: { persona: a.entityId } })))._tag,
        "NotFound"
      )
      assert.strictEqual(
        (yield* Effect.flip(
          writer.SetGenerationDefaults({ userId: other, defaults: { model: null, preset: null, persona: a.entityId } })
        ))._tag,
        "NotFound"
      )
      const reader = yield* Reader
      assert.isNull((yield* reader.GetGenerationDefaults({ userId: other })).persona)
      assert.strictEqual((yield* reader.GetGenerationDefaults({ userId })).persona, a.entityId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
