// Synthetic cards: a persona locked to a character (DESIGN §2.2, owner 2026-11-18) is stored per
// account and character card, reads as none once it can't be played, and never changes a chat.
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"

const setup = Effect.gen(function* () {
  const api = yield* client()
  const writer = yield* Writer
  const reader = yield* Reader
  const userId = (yield* api.Whoami()).id as UserId
  const harbor = yield* api.CreateCard({ label: "Harbor", name: "Harbor" })
  const pilot = yield* api.CreateCard({ label: "Pilot", name: "Pilot" })
  const mapmaker = yield* api.CreateCard({ label: "Mapmaker", name: "Mapmaker" })
  for (const card of [pilot, mapmaker]) yield* api.SetPersona({ entityId: card.entityId, persona: true })
  return { api, writer, reader, userId, harbor, pilot, mapmaker }
})

describe("persona lock", () => {
  it.live("locks, replaces and clears one persona per character, leaving started chats as they were", () =>
    Effect.gen(function* () {
      const { api, harbor, pilot, mapmaker } = yield* setup
      assert.isNull(yield* api.GetPersonaLock({ entityId: harbor.entityId }))
      const { chat } = yield* api.StartChat({
        cards: [harbor.entityId],
        persona: mapmaker.entityId,
        greeting: null,
        first: { _tag: "Send", content: "Hello.", speakerEntityId: mapmaker.entityId }
      })
      yield* api.SetPersonaLock({ entityId: harbor.entityId, persona: pilot.entityId })
      const locked = yield* api.GetPersonaLock({ entityId: harbor.entityId })
      assert.strictEqual(locked?.entityId, pilot.entityId)
      assert.strictEqual(locked?.name, "Pilot")
      assert.isTrue(locked?.persona)
      // Another character has none; a second lock replaces the first.
      assert.isNull(yield* api.GetPersonaLock({ entityId: pilot.entityId }))
      yield* api.SetPersonaLock({ entityId: harbor.entityId, persona: mapmaker.entityId })
      assert.strictEqual((yield* api.GetPersonaLock({ entityId: harbor.entityId }))?.entityId, mapmaker.entityId)
      assert.deepStrictEqual((yield* api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId })).playedByMe, [
        mapmaker.entityId
      ])
      yield* api.SetPersonaLock({ entityId: harbor.entityId, persona: pilot.entityId })
      assert.deepStrictEqual((yield* api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId })).playedByMe, [
        mapmaker.entityId
      ])
      yield* api.SetPersonaLock({ entityId: harbor.entityId, persona: null })
      assert.isNull(yield* api.GetPersonaLock({ entityId: harbor.entityId }))
      // Clearing twice is harmless.
      yield* api.SetPersonaLock({ entityId: harbor.entityId, persona: null })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("reads a binned, archived or no-longer-persona lock as none, and refuses setting one", () =>
    Effect.gen(function* () {
      const { api, writer, userId, harbor, pilot } = yield* setup
      const lock = () => api.SetPersonaLock({ entityId: harbor.entityId, persona: pilot.entityId })
      const read = () => Effect.map(api.GetPersonaLock({ entityId: harbor.entityId }), (card) => card?.entityId ?? null)
      yield* lock()
      yield* writer.SetEntityArchived({ userId, entityId: pilot.entityId, archived: true })
      assert.isNull(yield* read())
      assert.strictEqual(yield* outcome(lock()), "NotFound")
      yield* writer.SetEntityArchived({ userId, entityId: pilot.entityId, archived: false })
      // The stored row outlived the archive: restoring the card restores the lock.
      assert.strictEqual(yield* read(), pilot.entityId)
      yield* api.SetPersona({ entityId: pilot.entityId, persona: false })
      assert.isNull(yield* read())
      assert.strictEqual(yield* outcome(lock()), "NotFound")
      yield* api.SetPersona({ entityId: pilot.entityId, persona: true })
      yield* lock()
      yield* writer.DeleteEntity({ userId, entityId: pilot.entityId })
      assert.isNull(yield* read())
      assert.strictEqual(yield* outcome(lock()), "NotFound")
      // A character can't be locked to itself, nor to a card that isn't a persona.
      assert.strictEqual(
        yield* outcome(api.SetPersonaLock({ entityId: harbor.entityId, persona: harbor.entityId })),
        "NotFound"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("keeps accounts apart and keys each card fork on its own", () =>
    Effect.gen(function* () {
      const { api, writer, reader, userId, harbor, pilot } = yield* setup
      yield* api.SetPersonaLock({ entityId: harbor.entityId, persona: pilot.entityId })
      const other = (yield* writer.EnsureUser({ handle: "other", displayName: "Other" })).id as UserId
      assert.strictEqual(
        (yield* Effect.flip(reader.GetPersonaLock({ userId: other, entityId: harbor.entityId })))._tag,
        "NotFound"
      )
      assert.strictEqual(
        (yield* Effect.flip(writer.SetPersonaLock({ userId: other, entityId: harbor.entityId, persona: null })))._tag,
        "NotFound"
      )
      assert.strictEqual(
        (yield* reader.GetPersonaLock({ userId, entityId: harbor.entityId }))?.entityId,
        pilot.entityId
      )
      // A fork of the character is a character of its own: no lock until one is set for it.
      const fork = yield* api.ForkCard({ refId: harbor.id, name: "Harbor fork", nickname: "", characterVersion: "" })
      assert.isNull(yield* api.GetPersonaLock({ entityId: fork.entityId }))
      yield* api.SetPersonaLock({ entityId: fork.entityId, persona: null })
      assert.strictEqual((yield* api.GetPersonaLock({ entityId: harbor.entityId }))?.entityId, pilot.entityId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
