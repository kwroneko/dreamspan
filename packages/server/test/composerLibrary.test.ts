// A workshop composer's attached cards, lorebooks and presets (spec/WORKSHOP-CARDS.md §4.4) at
// the RPC boundary: they survive a reload in attach order, a send takes off only the items it
// carries, and the message then shows them by the name they had when sent. A story's composer and
// an id the library doesn't have are refused; an archived item is left out. Synthetic cards only.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"

const notFound = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    assert.isTrue(Exit.isFailure(exit))
    assert.include(JSON.stringify(exit), "NotFound")
  })

describe("composer library items", () => {
  it.live("keep a workshop composer's items until a send carries them", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const wren = yield* api.CreateCard({ label: "Wren Hollow", name: "Wren Hollow", description: "Keeps maps." })
      const tide = yield* api.CreateCard({ label: "Tide Clerk", name: "Tide Clerk", description: "Counts boats." })
      const book = yield* api.CreateLorebook({ label: "Harbor Lore" })
      const chat = yield* api.CreateWorkshop({ title: "Card work" })
      const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
      const key = { chatId: chat.id, draftId: draft.id }

      yield* api.SetComposerLibrary({
        ...key,
        add: [tide.id, book.id],
        remove: []
      })
      // Attached again: it stays where it was; a new one goes last.
      const after = yield* api.SetComposerLibrary({
        ...key,
        add: [tide.id, wren.id],
        remove: []
      })
      assert.deepStrictEqual(
        after.map((item) => item.name),
        ["Tide Clerk", "Harbor Lore", "Wren Hollow"]
      )
      assert.deepStrictEqual(yield* api.GetComposerLibrary(key), after)

      assert.deepStrictEqual(
        after.map((item) => item.kind),
        ["card", "lorebook", "card"]
      )
      // Refused: an id the library doesn't have, and anything in a story's composer.
      yield* notFound(api.SetComposerLibrary({ ...key, add: ["ref_missing" as typeof wren.id], remove: [] }))
      const story = yield* api.CreateChat({ title: "Story" })
      const storyDraft = yield* api.OpenComposer({ chatId: story.id, forkId: null })
      yield* notFound(
        api.SetComposerLibrary({
          chatId: story.id,
          draftId: storyDraft.id,
          add: [wren.id],
          remove: []
        })
      )

      // A send carries two of the three; the third stays for the next message.
      const { entry } = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: chat.activeLeafSlotId,
          branch: false,
          content: "Tighten these.",
          library: [
            { kind: "card", refId: tide.id },
            { kind: "lorebook", refId: book.id }
          ],
          composer: { draftId: draft.id, session: draft.session },
          reply: false
        })
      )
      assert.deepStrictEqual(
        (yield* api.GetComposerLibrary(key)).map((item) => item.refId),
        [wren.id]
      )
      // The message shows them by the names they had when sent, a rename after or not.
      yield* api.RenameRef({
        refId: tide.id,
        label: "Tide Clerk (old)",
        subtitle: "",
        expectedRowVersion: tide.rowVersion
      })
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 })
      const shown = path.entries.find((row) => row.slotId === entry.slotId)!
      assert.deepStrictEqual(entry.version.library, [
        { kind: "card", refId: tide.id, name: "Tide Clerk" },
        { kind: "lorebook", refId: book.id, name: "Harbor Lore" }
      ])
      assert.deepStrictEqual(shown.version.library, entry.version.library)

      // Archived, it's left out of the composer's list; removed, it's gone.
      yield* api.SetComposerLibrary({ ...key, add: [tide.id], remove: [] })
      yield* api.SetRefArchived({ refId: tide.id, archived: true })
      assert.deepStrictEqual(
        (yield* api.GetComposerLibrary(key)).map((item) => item.refId),
        [wren.id]
      )
      assert.deepStrictEqual(yield* api.SetComposerLibrary({ ...key, add: [], remove: [wren.id] }), [])
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )
})
