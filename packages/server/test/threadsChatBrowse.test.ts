// merge-batch10 seam: the Chats tab's Workshops filter (decisions1113) beside parallel threads'
// rows in the left panel (batch 9). Synthetic data only.
import { assert, describe, it } from "@effect/vitest"
import type { ChatBrowse } from "@rp/shared/chatBrowse.ts"
import { Effect } from "effect"
import { runStory } from "./support/threadStory.ts"

describe("the Workshops filter beside threads", () => {
  it.live("a story chat's threads stay story rows, add no branches and stay out of Workshops", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        const workshop = yield* t.api.CreateWorkshop({})
        const list = (filter: ChatBrowse["filter"]) =>
          t.api.GetShellForks({
            entity: null,
            chat: null,
            search: "",
            sort: "recent",
            sections: [{ id: "chats", limit: 10 }],
            browse: { filter, sort: "recent", reversed: false }
          })
        const want: Record<ChatBrowse["filter"], ReadonlyArray<string>> = {
          all: [t.chatId, workshop.id],
          workshops: [workshop.id],
          pinned: [],
          groups: [t.chatId],
          solo: [],
          // The branch made before the threads; the threads' own forks aren't branches.
          branches: [t.chatId]
        }
        for (const filter of Object.keys(want) as Array<ChatBrowse["filter"]>) {
          const result = yield* list(filter)
          const rows = result.sections[0]!.rows
          assert.deepStrictEqual(rows.map((f) => f.chat.id).sort(), [...want[filter]].sort(), filter)
          assert.deepStrictEqual(result.filterCounts, {
            all: 2,
            workshops: 1,
            pinned: 0,
            groups: 1,
            solo: 0,
            branches: 1
          })
          const story = rows.find((f) => f.chat.id === t.chatId)
          if (story) {
            assert.strictEqual(story.branches, 2, "the story's own branch and the one made before the threads")
            assert.notStrictEqual(story.chat.kind, "workshop")
          }
        }
        // The left panel's Threads group for the story: every thread, as story rows.
        const threads = yield* t.api.GetShellForks({
          entity: null,
          chat: t.chatId,
          search: "",
          sort: "recent",
          sections: [{ id: "threads", limit: 10 }],
          browse: { filter: "workshops", sort: "recent", reversed: false }
        })
        const rows = threads.sections[0]!.rows
        assert.sameMembers(
          rows.map((f) => f.forkId),
          [t.F, t.D, t.U, t.G]
        )
        for (const row of rows) {
          assert.notStrictEqual(row.chat.kind, "workshop")
          assert.isDefined(row.thread, "labelled with its thread")
        }
      })
    )
  )
})
