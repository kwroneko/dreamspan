// Adversarial join regressions; all story text is synthetic.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { ForkId, SlotId, VersionId } from "@rp/shared/chat.ts"
import { STRETCH_VIEW } from "@rp/shared/knowledge.ts"
import { generationOf } from "../src/assembler/types.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { historyTools } from "../src/agent/tools/history.ts"
import { outcome } from "./support/config.ts"
import { runStory } from "./support/threadStory.ts"

describe("thread join review", () => {
  it.live("agent reads preserve a separate join's boundary in a shared-context chat", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "LANTERN-SECRET")
        yield* t.append(t.D, t.wren, "DOCKS-SECRET")
        yield* t.join(t.F, [t.D], null, "separate")
        const snapshot = yield* t.requestFor(t.F, t.wren)
        const context: ToolContext = {
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.F,
          slotId: snapshot.inputs.slotId as SlotId,
          versionId: "unused" as VersionId,
          leafSlotId: snapshot.inputs.leafSlotId as SlotId,
          viewers: generationOf(snapshot).viewers,
          rolloutId: "test",
          toolCallId: "test",
          cache: new Map(),
          reader: t.reader,
          writer: t.writer
        }
        for (const [id, args] of [
          ["search_chat", { query: "LANTERN-SECRET" }],
          ["read_messages", { from: 1, count: 20 }],
          ["expand_summary", { messages: "1–20" }],
          ["search_summaries", { query: "LANTERN-SECRET" }]
        ] as const) {
          const result = yield* historyTools.find((tool) => tool.id === id)!.execute(context, args as never)
          assert.notInclude(result.text.replaceAll("“LANTERN-SECRET”", "“query”"), "LANTERN-SECRET", id)
          assert.isTrue(result.isError, "joined character reads remain refused until metadata follows the view")
        }
      })
    )
  )

  it.live("insertions before and after a join stay inside its private boundary", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        const first = yield* t.append(t.F, t.mira, "LANTERN-FIRST")
        const last = yield* t.append(t.F, t.mira, "LANTERN-LAST")
        const inserted = yield* t.writer.InsertMessage({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.F,
          anchorSlotId: first.slotId,
          expectedRowVersion: (yield* t.reader.GetSlot({ userId: t.userId, slotId: first.slotId, forkId: t.F })).entry
            .rowVersion,
          body: { _tag: "Write", speaker: t.mira, content: "LANTERN-INSERT" }
        })
        yield* t.append(t.D, t.wren, "DOCKS-SECRET")
        const J = (yield* t.join(t.F, [t.D], last.slotId, "separate")).entries[0]!
        const late = yield* t.writer.InsertMessage({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.F,
          anchorSlotId: first.slotId,
          expectedRowVersion: (yield* t.reader.GetSlot({ userId: t.userId, slotId: first.slotId, forkId: t.F })).entry
            .rowVersion,
          body: { _tag: "Write", speaker: t.mira, content: "LANTERN-LATE" }
        })
        const known = yield* t.reader.KnowersOf({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.F,
          versionIds: [first.version.id, inserted.version.id, late.version.id, J.version.id],
          viewers: [t.wren, STRETCH_VIEW]
        })
        assert.isTrue(
          known.every((k) => k.stretched),
          "all display messages in the stretch are classified"
        )
        const text = yield* t.contextFor(t.F, t.wren)
        assert.notInclude(text, "LANTERN-FIRST")
        assert.notInclude(text, "LANTERN-INSERT")
        assert.notInclude(text, "LANTERN-LATE")
        assert.include(text, "DOCKS-SECRET")
      })
    )
  )

  it.live("joins are atomic when a later source changes, and retrying cannot duplicate them", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        const end = yield* t.append(t.F, t.mira, "LANTERN-END")
        yield* t.append(t.D, t.wren, "DOCKS-ONE")
        yield* t.append(t.U, t.pell, "UPSTAIRS-ONE")
        const previews = yield* Effect.forEach([t.D, t.U], (fork) => t.preview(t.F, fork))
        yield* t.append(t.U, t.pell, "UPSTAIRS-TWO")
        const stale = t.api.JoinThreads({
          chatId: t.chatId,
          forkId: t.F,
          at: null,
          includeLeftOut: false,
          joins: previews.map((p, i) => ({
            forkId: [t.D, t.U][i]!,
            title: p.sourceTitle,
            framing: null,
            digest: p.digest
          }))
        })
        assert.strictEqual(yield* outcome(stale), "MergeChanged")
        const path = yield* t.reader.ReadPath({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.F,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 100
        })
        assert.strictEqual(path.entries.at(-1)!.slotId, end.slotId, "the first join rolled back with the second")
        const joined = yield* t.join(t.F, [t.D, t.U], null, "separate")
        assert.lengthOf(joined.entries, 2)
        assert.strictEqual(yield* outcome(t.join(t.F, [t.D, t.U], null, "separate")), "MergeRefused")
        const mira = yield* t.contextFor(t.F, t.mira)
        const wren = yield* t.contextFor(t.F, t.wren)
        const pell = yield* t.contextFor(t.F, t.pell)
        assert.notMatch(mira, /DOCKS-|UPSTAIRS-/)
        assert.include(wren, "DOCKS-ONE")
        assert.notMatch(wren, /LANTERN-|UPSTAIRS-/)
        assert.include(pell, "UPSTAIRS-TWO")
        assert.notMatch(pell, /LANTERN-|DOCKS-/)
      })
    )
  )

  it.live("live stretches belong to the viewed fork, including delete and restore", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        const first = yield* t.append(t.F, t.mira, "LANTERN-PRIVATE")
        yield* t.append(t.D, t.wren, "DOCKS-PRIVATE")
        const J = (yield* t.join(t.F, [t.D], null, "separate")).entries[0]!
        const branch = (yield* t.writer.CreateFork({
          userId: t.userId,
          chatId: t.chatId,
          fromForkId: t.F,
          atSlotId: J.slotId
        })).fork.id as ForkId
        const deleted = yield* t.api.DeleteMessage({ slotId: J.slotId, forkId: t.F })
        const probe = (forkId: typeof branch) =>
          t.reader.KnowersOf({
            userId: t.userId,
            chatId: t.chatId,
            forkId,
            versionIds: [first.version.id],
            viewers: [t.wren, STRETCH_VIEW]
          })
        assert.isUndefined((yield* probe(t.F))[0]!.stretched, "a fork-local deletion removes its boundary")
        assert.isTrue((yield* probe(branch))[0]!.stretched, "a frozen child retains the join and its boundary")
        assert.isUndefined((yield* probe(t.before))[0]!.stretched, "a join on another branch cannot restrict this view")
        const snapshot = yield* t.requestFor(branch, t.wren)
        const rebuilt = yield* t.reader.RebuildContext({ userId: t.userId, snapshot: JSON.stringify(snapshot) })
        if (rebuilt._tag !== "Rebuilt") throw new Error("Expected a rebuilt context from the current assembler")
        assert.deepStrictEqual(JSON.parse(rebuilt.snapshot).request, snapshot.request)
        yield* t.api.RestoreBinItem({ itemId: deleted.id })
        assert.isTrue((yield* probe(t.F))[0]!.stretched, "restoring the join restores its boundary")
      })
    )
  )
})
