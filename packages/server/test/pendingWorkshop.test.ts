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

  it.live("ten new workshops opened and left make the seeds once, and nothing more in the library", () =>
    run(
      Effect.gen(function* () {
        const api = yield* client()
        const userId = (yield* api.Whoami()).id as UserId
        const counts = Effect.gen(function* () {
          const [cards, presets, lorebooks] = yield* Effect.all([
            api.ListLibrary({ kind: "card" }),
            api.ListLibrary({ kind: "preset" }),
            api.ListLibrary({ kind: "lorebook" })
          ])
          return { cards: cards.length, presets: presets.length, lorebooks: lorebooks.length }
        })
        const before = yield* counts
        const after: Array<{ cards: number; presets: number; lorebooks: number }> = []
        for (let visit = 0; visit < 10; visit++) {
          const draft = yield* api.OpenDraftChat({ draftFor: "workshop::" })
          yield* api.LeaveDraftChat({ chatId: draft.id })
          yield* (yield* Writer).SweepPendingChat({ userId, chatId: draft.id })
          after.push(yield* counts)
        }
        console.log("library before", before, "after each visit", after)
        // The first visit makes the workshop seeds (its assistant card, its persona and its
        // preset), as the first workshop always did; every later one reuses them.
        assert.deepStrictEqual(after[0], {
          cards: before.cards + 2,
          presets: before.presets + 1,
          lorebooks: before.lorebooks
        })
        for (const visit of after) assert.deepStrictEqual(visit, after[0])
        assert.deepStrictEqual(
          (yield* api.ListChats({ limit: 50, before: null })).filter((chat) => chat.kind === "workshop"),
          []
        )
      })
    )
  )

  it.live("an assistant swapped before the first send greets instead, and is the started workshop's", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, quill } = yield* setup
        const { entityId: wren } = yield* (yield* Writer).CreateEntity({
          userId,
          kind: "card",
          label: "Wren",
          subtitle: "",
          doc: cardDoc("Wren", { first_mes: "Wren opens a ledger." }),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        const draft = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:none` })
        // The Cast tab: the new assistant added, the old one removed.
        for (const change of [
          { _tag: "Join", entityId: wren as EntityId } as const,
          { _tag: "Leave", entityId: quill } as const
        ])
          yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId: draft.currentForkId!, pending: true, change })
        const greeting = yield* api.ReadPath({
          chatId: draft.id,
          forkId: null,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 5
        })
        assert.deepStrictEqual(
          greeting.entries.map((entry) => [entry.version.content, entry.version.speakerEntityId]),
          [["Wren opens a ledger.", wren]]
        )
        const pending = yield* api.GetChat({ chatId: draft.id })
        yield* api.SendMessage({
          chatId: draft.id,
          parentSlotId: pending.activeLeafSlotId!,
          branch: false,
          content: "Tidy my lorebooks."
        })
        const started = yield* api.GetChat({ chatId: draft.id })
        assert.strictEqual(started.status, "active")
        const state = foldState(
          yield* (yield* Reader).StateEventsAt({ userId, chatId: draft.id, slotId: started.activeLeafSlotId })
        )
        assert.deepStrictEqual(state.participants, [wren])
        const read = yield* api.ReadPath({
          chatId: draft.id,
          forkId: null,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 5
        })
        assert.deepStrictEqual(
          read.entries.map((entry) => entry.version.content),
          ["Wren opens a ledger.", "Tidy my lorebooks."]
        )
      })
    )
  )

  it.live("a workshop beside a story is pending until its first message, and only then beside it", () =>
    run(
      Effect.gen(function* () {
        const api = yield* client()
        const story = yield* api.CreateChat({ title: "Harbor" })
        yield* api.SendMessage({ chatId: story.id, parentSlotId: null, branch: false, content: "The tide turns." })
        const fork = (yield* api.GetChat({ chatId: story.id })).currentForkId!
        const beside = () => api.ListAttachedWorkshops({ chatId: story.id, forkId: fork })
        const draft = yield* api.OpenDraftChat({ draftFor: `side:${story.id}:${fork}` })
        assert.strictEqual(draft.status, "pending")
        assert.strictEqual(draft.kind, "workshop")
        assert.deepStrictEqual(yield* beside(), [])
        // A reload reopens it.
        assert.strictEqual(
          (yield* api.OpenDraftChat({ draftFor: `side:${story.id}:${fork}`, reopen: draft.id })).id,
          draft.id
        )
        yield* api.SendMessage({
          chatId: draft.id,
          parentSlotId: draft.activeLeafSlotId!,
          branch: false,
          content: "What happened at the harbor?"
        })
        const started = yield* api.GetChat({ chatId: draft.id })
        assert.strictEqual(started.status, "active")
        assert.strictEqual(started.title, "About Harbor")
        assert.deepStrictEqual(
          (yield* beside()).map((chat) => chat.id),
          [draft.id]
        )
      })
    )
  )
})
