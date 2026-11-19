import { assert, it } from "@effect/vitest"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

it.live("the Cast Away operation is positional, independent of Mute, owned, and isolated by fork", () =>
  Effect.gen(function* () {
    const api = yield* client(),
      writer = yield* Writer
    const me = yield* api.Whoami()
    const mira = yield* writer.CreateEntity({
      userId: me.id,
      kind: "card",
      label: "Mira",
      subtitle: "",
      doc: cardDoc("Mira"),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const started = yield* api.StartChat({
      cards: [mira.entityId as EntityId],
      persona: null,
      greeting: 0,
      first: { _tag: "Send", content: "The harbor.", speakerEntityId: null }
    })
    const at = { chatId: started.chat.id, slotId: started.entry.slotId, forkId: started.chat.currentForkId! }
    const { fork: peer } = yield* api.CreateFork({ chatId: at.chatId, fromForkId: at.forkId, atSlotId: at.slotId })
    const away = (value: boolean) =>
      api.ChangeCast({ ...at, change: { _tag: "Away", entityId: mira.entityId as EntityId, away: value } })
    const left = yield* away(true)
    assert.deepStrictEqual(left.away, [mira.entityId])
    assert.deepStrictEqual(left.absent, [])
    assert.notProperty(yield* api.GetCast({ ...at, forkId: peer.id }), "away")
    assert.notProperty(yield* api.GetCast({ ...at, slotId: null }), "away", "nothing changes before its position")
    const muted = yield* api.ChangeCast({
      ...at,
      change: { _tag: "Presence", entityId: mira.entityId as EntityId, present: false }
    })
    assert.deepStrictEqual(muted.away, [mira.entityId])
    assert.deepStrictEqual(muted.absent, [mira.entityId])
    const back = yield* away(false)
    assert.notProperty(back, "away")
    assert.deepStrictEqual(back.absent, [mira.entityId], "returning does not unmute")
    yield* away(true)
    const { fork: child } = yield* api.CreateFork({ chatId: at.chatId, fromForkId: at.forkId, atSlotId: at.slotId })
    assert.deepStrictEqual((yield* api.GetCast({ ...at, forkId: child.id })).away, [mira.entityId])
    yield* api.ChangeCast({
      ...at,
      forkId: child.id,
      change: { _tag: "Away", entityId: mira.entityId as EntityId, away: false }
    })
    assert.deepStrictEqual((yield* api.GetCast(at)).away, [mira.entityId])
    assert.notProperty(yield* api.GetCast({ ...at, forkId: child.id }), "away")

    const other = yield* writer.EnsureUser({ handle: "other", displayName: "Other" })
    const foreign = yield* writer.CreateChat({
      userId: other.id,
      kind: "rp",
      status: "active",
      title: "Other synthetic chat",
      participants: [],
      greeting: null
    })
    assert.strictEqual(
      yield* outcome(
        api.ChangeCast({
          ...at,
          chatId: foreign.id,
          change: { _tag: "Away", entityId: mira.entityId as EntityId, away: false }
        })
      ),
      "NotFound"
    )
    assert.strictEqual(
      yield* outcome(
        api.ChangeCast({
          ...at,
          forkId: foreign.currentForkId!,
          change: { _tag: "Away", entityId: mira.entityId as EntityId, away: false }
        })
      ),
      "NotFound"
    )
    const denied = yield* Effect.flip(
      writer.AddStateEvent({
        userId: other.id,
        chatId: at.chatId,
        slotId: at.slotId,
        forkId: at.forkId,
        versionId: null,
        scope: null,
        data: { key: "away.set", value: { entity: mira.entityId as EntityId, away: false } }
      })
    )
    assert.strictEqual(denied._tag, "NotFound")
    assert.deepStrictEqual((yield* api.GetCast(at)).away, [mira.entityId], "refused changes do not clear Away")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
)
