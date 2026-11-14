import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { runMergeStory, sentText } from "./support/mergeOrigin.ts"

it.live(
  "re-merges, inheriting forks, branch merges and later presence changes retain separate knowledge",
  () =>
    runMergeStory((t) =>
      Effect.gen(function* () {
        const kai = yield* t.card("Kai")
        const source = yield* t.chat("Docks", [kai])
        yield* t.say(source, kai, "SRCFIRST")
        yield* t.say(t.ledger, t.mira, "HOMEFIRST")
        const first = yield* t.merge(t.ledger, source, "separate")
        const child = {
          chatId: t.ledger.chatId,
          forkId: (yield* t.writer.CreateFork({
            userId: t.userId,
            chatId: t.ledger.chatId,
            fromForkId: t.ledger.forkId,
            atSlotId: first.slotId
          })).fork.id
        }
        yield* t.say(source, kai, "SRCSECOND")
        const second = yield* t.merge(t.ledger, source, "separate")
        const kaiText = sentText(yield* t.requestFor(t.ledger, kai))
        assert.strictEqual(kaiText.match(/SRCFIRST/g)?.length, 1)
        assert.strictEqual(kaiText.match(/SRCSECOND/g)?.length, 1)
        assert.notInclude(kaiText, "HOMEFIRST")
        assert.notInclude(sentText(yield* t.requestFor(t.ledger, t.mira)), "SRCFIRST")
        assert.notInclude(sentText(yield* t.requestFor(t.ledger, t.mira)), "SRCSECOND")
        assert.notInclude(sentText(yield* t.requestFor(child, kai)), "SRCSECOND")
        yield* t.away(t.ledger, kai, true)
        assert.notInclude(sentText(yield* t.requestFor(t.ledger, kai)), "HOMEFIRST")
        yield* t.away(t.ledger, kai, false)
        yield* t.writer.DeleteMessage({ userId: t.userId, slotId: second.slotId, forkId: t.ledger.forkId })
        assert.include(sentText(yield* t.requestFor(t.ledger, kai)), "SRCFIRST")
        assert.notInclude(sentText(yield* t.requestFor(t.ledger, kai)), "SRCSECOND")
        yield* t.say(t.ledger, t.mira, "MAINONLY")
        yield* t.away(child, t.mira, true)
        yield* t.say(child, kai, "CHILDPRIVATE")
        assert.notInclude(sentText(yield* t.requestFor(t.ledger, kai)), "CHILDPRIVATE")
        assert.notInclude(sentText(yield* t.requestFor(child, kai)), "MAINONLY")
        yield* t.merge(t.ledger, child, "separate")
        assert.include(sentText(yield* t.requestFor(t.ledger, kai)), "CHILDPRIVATE")
        assert.notInclude(sentText(yield* t.requestFor(t.ledger, t.mira)), "CHILDPRIVATE")
        assert.notInclude(sentText(yield* t.requestFor(t.ledger, kai)), "HOMEFIRST")
        yield* t.mark(t.ledger, { key: "participant.leave", value: { entity: kai } })
        const remaining = sentText(yield* t.requestFor(t.ledger, t.mira))
        assert.notInclude(remaining, "SRCFIRST")
        assert.notInclude(remaining, "SRCSECOND")
        assert.notInclude(remaining, "CHILDPRIVATE")
        assert.include(remaining, "MAINONLY")
        assert.include(sentText(yield* t.requestFor(source, kai)), "SRCSECOND")
      })
    ),
  { timeout: 120_000 }
)
