// merge-batch10 seams: a presence correction local to one branch (review-branchundo1) beside
// threads6's private views after a separate join, their frozen snapshots and the join reads.
// Mira at the Lantern, Wren at the docks. Synthetic data only.
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { type ContextSnapshot, generationOf } from "../src/assembler/types.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { historyTools } from "../src/agent/tools/history.ts"
import { runStory, sentText, type ThreadStory } from "./support/threadStory.ts"

/** The history tools of a reply by `speaker` at the tip of `fork`, with its request. */
const replyAt = (t: ThreadStory, fork: ForkId, speaker: EntityId) =>
  Effect.gen(function* () {
    const tip = (yield* t.reader.ReadPath({
      userId: t.userId,
      chatId: t.chatId,
      forkId: fork,
      leafSlotId: null,
      range: { _tag: "Bottom" },
      limit: 1
    })).entries.at(-1)!.slotId
    const placeholder = yield* t.writer.AppendMessage({
      userId: t.userId,
      chatId: t.chatId,
      forkId: fork,
      parentSlotId: tip,
      branch: true,
      commitDraft: null,
      version: new NewVersion({
        speakerEntityId: speaker,
        writer: "model",
        content: "",
        status: "generating",
        macroMode: "verbatim",
        origin: "generated"
      })
    })
    const built = yield* t.reader.AssembleContext({
      userId: t.userId,
      chatId: t.chatId,
      slotId: placeholder.slotId,
      versionId: placeholder.version.id,
      now: 1,
      timeZone: "UTC",
      frozen: null,
      forkId: placeholder.forkId
    })
    const snapshot = JSON.parse(built.snapshot) as ContextSnapshot
    const context: ToolContext = {
      userId: t.userId,
      chatId: t.chatId,
      forkId: placeholder.forkId as ForkId,
      slotId: placeholder.slotId,
      versionId: placeholder.version.id,
      leafSlotId: snapshot.inputs.leafSlotId as SlotId,
      viewers: generationOf(snapshot).viewers,
      rolloutId: "test",
      toolCallId: "test",
      cache: new Map(),
      reader: t.reader,
      writer: t.writer
    }
    const run = (id: string, args: object) =>
      Effect.map(historyTools.find((tool) => tool.id === id)!.execute(context, args as never), (out) => out.text)
    return Object.assign(run, { context, sent: sentText(snapshot) })
  })

const hook = historyTools.find((tool) => tool.id === "read_messages")!.snapshot!

/** The tools as a Resume, step edit or replay of that reply reads them from its frozen form. */
const thawed = (context: ToolContext, frozen: unknown) =>
  Effect.gen(function* () {
    const replay = { ...context, cache: new Map<string, unknown>() }
    yield* hook.prepare(replay, JSON.parse(JSON.stringify(frozen)))
    return (id: string, args: object) =>
      Effect.map(historyTools.find((tool) => tool.id === id)!.execute(replay, args as never), (out) => out.text)
  })

/**
 * After a separate join, the scene check sends Wren away in the story's branch and Mira says
 * something; branch B is made there. Returns the scene check's event and both branches.
 */
const setup = (t: ThreadStory) =>
  Effect.gen(function* () {
    yield* t.append(t.D, t.wren, "DOCKSKNOWN")
    yield* t.append(t.F, t.mira, "LANTERNMISSED")
    const join = (yield* t.join(t.F, [t.D])).entries[0]!
    const mark = yield* t.writer.AddStateEvent({
      userId: t.userId,
      chatId: t.chatId,
      forkId: t.F,
      slotId: join.slotId,
      versionId: null,
      scope: null,
      data: { key: "away.set", value: { entity: t.wren, away: true, source: "decision" } }
    })
    const last = yield* t.append(t.F, t.mira, "HERONPASSWORD")
    const B = (yield* t.writer.CreateFork({
      userId: t.userId,
      chatId: t.chatId,
      fromForkId: t.F,
      atSlotId: last.slotId
    })).fork.id as ForkId
    return { mark, B }
  })

const correct = (t: ThreadStory, forkId: ForkId, eventId: string) =>
  Effect.gen(function* () {
    const corrected = yield* t.writer.CorrectPresence({ userId: t.userId, chatId: t.chatId, forkId, eventId })
    assert.isNotNull(corrected, "the scene check's departure is correctable")
  })

describe("branch-local presence corrections with private views after a join", () => {
  it.live("a correction changes the corrected branch's private view and no other", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        const { mark, B } = yield* setup(t)
        const onF = yield* replyAt(t, t.F, t.wren)
        const beforeF = yield* onF("search_chat", { query: "HERONPASSWORD" })
        assert.notInclude(beforeF, "HERONPASSWORD", "Wren was away for it")
        assert.include(yield* onF("search_chat", { query: "DOCKSKNOWN" }), "DOCKSKNOWN", "her own joined row")
        yield* correct(t, B, mark.id)
        const onB = yield* replyAt(t, B, t.wren)
        assert.include(yield* onB("search_chat", { query: "HERONPASSWORD" }), "HERONPASSWORD", "B counts her there")
        assert.include(yield* onB("search_chat", { query: "DOCKSKNOWN" }), "DOCKSKNOWN")
        assert.notInclude(yield* onB("search_chat", { query: "LANTERNMISSED" }), "LANTERNMISSED")
        const laterF = yield* replyAt(t, t.F, t.wren)
        assert.notInclude(yield* laterF("search_chat", { query: "HERONPASSWORD" }), "HERONPASSWORD", "F unchanged")
        assert.strictEqual(
          yield* laterF("read_messages", { from: 1, count: 50 }),
          yield* onF("read_messages", { from: 1, count: 50 }),
          "F's private view reads the same rows and addresses"
        )
      })
    )
  )

  it.live("an earlier reply's frozen private view still resolves on both branches after the correction", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        const { mark, B } = yield* setup(t)
        const onF = yield* replyAt(t, t.F, t.wren)
        const onB = yield* replyAt(t, B, t.wren)
        const frozenF = hook.freeze!(yield* hook.prepare(onF.context, undefined))
        const frozenB = hook.freeze!(yield* hook.prepare(onB.context, undefined))
        assert.isDefined((frozenF as { digest?: string }).digest, "a private address map was frozen")
        const readF = yield* onF("read_messages", { from: 1, count: 50 })
        const readB = yield* onB("read_messages", { from: 1, count: 50 })
        assert.include(readF, "DOCKSKNOWN")
        assert.include(readF, "view #", "Wren reads by private addresses after the separate join")
        yield* correct(t, B, mark.id)
        // The other branch: the identical map, read again.
        const replayF = yield* thawed(onF.context, frozenF)
        assert.strictEqual(yield* replayF("read_messages", { from: 1, count: 50 }), readF)
        // The corrected branch's earlier reply: its frozen map resolves, never reaching a newly
        // known row through an old address or number (it either matches or fails closed).
        const replayB = yield* thawed(onB.context, frozenB)
        const again = yield* replayB("read_messages", { from: 1, count: 50 })
        assert.notInclude(again, "HERONPASSWORD")
        assert.notInclude(again, "LANTERNMISSED")
        assert.isTrue(again === readB || again.includes("No earlier messages match."), again)
      })
    )
  )

  it.live("what Wren reads at the join and after it follows each branch's presence", () =>
    runStory("separate", (t) =>
      Effect.gen(function* () {
        const { mark, B } = yield* setup(t)
        const beforeF = (yield* replyAt(t, t.F, t.wren)).sent
        const beforeB = (yield* replyAt(t, B, t.wren)).sent
        assert.notInclude(beforeB, "HERONPASSWORD")
        yield* correct(t, B, mark.id)
        const afterF = (yield* replyAt(t, t.F, t.wren)).sent
        const afterB = (yield* replyAt(t, B, t.wren)).sent
        assert.strictEqual(afterF, beforeF, "the other branch's request bytes are unchanged")
        assert.include(afterB, "HERONPASSWORD")
        for (const sent of [afterF, afterB]) {
          assert.include(sent, "DOCKSKNOWN", "the join's own rows she was in")
          assert.notInclude(sent, "LANTERNMISSED", "the joined stretch she missed")
        }
      })
    )
  )
})
