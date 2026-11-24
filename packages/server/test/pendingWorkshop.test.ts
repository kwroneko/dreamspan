// A new workshop is a pending chat like a new roleplay chat (spec/WORKSHOP-CARDS.md §3): made by
// OpenDraftChat with its assistant's greeting, listed nowhere and swept like one, and started by
// its first message under its own title.
import { assert, describe, it } from "@effect/vitest"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))

const setup = Effect.gen(function* () {
  const api = yield* client()
  const userId = (yield* api.Whoami()).id as UserId
  const writer = yield* Writer
  const { entityId } = yield* writer.CreateEntity({
    userId,
    kind: "card",
    label: "Quill",
    subtitle: "",
    doc: cardDoc("Quill", { first_mes: "Quill uncaps a pen." }),
    schemaVersion: 1,
    origin: "user",
    sourcePath: null
  })
  return { api, userId, quill: entityId as EntityId }
})

describe("a new workshop's pending chat", () => {
  it.live("opens with its card's greeting, listed nowhere, and starts on its first message", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, quill } = yield* setup
        const draft = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:none` })
        assert.strictEqual(draft.status, "pending")
        assert.strictEqual(draft.kind, "workshop")
        const read = yield* api.ReadPath({
          chatId: draft.id,
          forkId: null,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 5
        })
        assert.deepStrictEqual(
          read.entries.map((entry) => entry.version.content),
          ["Quill uncaps a pen."]
        )
        const state = foldState(
          yield* (yield* Reader).StateEventsAt({ userId, chatId: draft.id, slotId: draft.activeLeafSlotId })
        )
        assert.deepStrictEqual(state.participants, [quill])
        assert.deepStrictEqual(state.playedByMe, [])
        assert.notInclude(
          (yield* api.ListChats({ limit: 50, before: null })).map((chat) => chat.id),
          draft.id
        )
        // A reload reopens it as it is.
        assert.strictEqual(
          (yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:none`, reopen: draft.id })).id,
          draft.id
        )

        yield* api.SendMessage({
          chatId: draft.id,
          parentSlotId: draft.activeLeafSlotId!,
          branch: false,
          content: "Write me a lighthouse keeper."
        })
        const started = yield* api.GetChat({ chatId: draft.id })
        assert.strictEqual(started.status, "active")
        assert.strictEqual(started.title, "Workshop")
        assert.include(
          (yield* api.ListChats({ limit: 50, before: null })).map((chat) => chat.id),
          draft.id
        )
      })
    )
  )

  it.live("a new workshop left behind is swept, and the next visit draws a fresh one", () =>
    run(
      Effect.gen(function* () {
        const { api, quill } = yield* setup
        const first = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:` })
        yield* (yield* Writer).SweepPendingChat({ userId: (yield* api.Whoami()).id, chatId: first.id })
        const again = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:` })
        assert.notStrictEqual(again.id, first.id)
        assert.strictEqual(
          yield* api.GetChat({ chatId: first.id }).pipe(
            Effect.flip,
            Effect.map((e) => e._tag)
          ),
          "NotFound"
        )
      })
    )
  )
})
