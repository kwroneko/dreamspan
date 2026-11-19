import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Writer } from "../src/db/Database.ts"
import { Generator } from "../src/chat/Generator.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"

it.live("hiding makes covering L1 and L2 summaries stale, unhiding makes them fresh, and no jobs start", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client(),
      writer = yield* Writer,
      user = yield* api.Whoami()
    const chat = yield* api.CreateChat({ title: "Summary visibility review" })
    let parent = null as import("@dreamspan/shared/chat.ts").SlotId | null
    const entries: import("@dreamspan/shared/chat.ts").PathEntry[] = []
    for (let i = 0; i < 6; i++) {
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: parent,
        branch: false,
        content: `Review message ${i}`
      })
      if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
      entries.push(sent.entry)
      parent = sent.entry.slotId
    }
    const input = (n: number) => ({ slotId: entries[n]!.slotId, versionId: entries[n]!.version.id, amendCount: 0 })
    const a = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [input(0), input(1)])
    const b = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [input(2), input(3)])
    const top = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [], [a, b])
    const state = () => api.GetLcmState({ chatId: chat.id, leafSlotId: parent! })
    assert.isTrue((yield* state()).layer[0]!.fresh)
    yield* api.SetMessageHidden({ slotId: entries[1]!.slotId, hidden: true })
    assert.isFalse((yield* api.GetSummary({ summaryId: a.id })).fresh)
    assert.isFalse((yield* api.GetSummary({ summaryId: top.id })).fresh)
    assert.isFalse((yield* state()).layer[0]!.fresh)
    assert.lengthOf((yield* state()).jobs, 0)
    yield* api.SetMessageHidden({ slotId: entries[1]!.slotId, hidden: false })
    assert.isTrue((yield* state()).layer[0]!.fresh)
    // The same operation under the staged-unhide overlay must really hide the slot
    // even though its raw context_excluded flag was already 1.
    yield* fixtureSql(config.dataDir, [
      // A message hidden before forks, which the database freezes now (a fork hides with an override).
      { sql: "DROP TRIGGER slots_hide_frozen" },
      { sql: "UPDATE slots SET context_excluded=1 WHERE id=?", params: [entries[1]!.slotId] },
      {
        sql: "INSERT INTO lcm_enable_runs(id,chat_id,payload_json,phase,published) VALUES('review-overlay',?,'{}','done',1)",
        params: [chat.id]
      },
      {
        sql: "INSERT INTO lcm_enable_slots(run_id,ordinal,slot_id,version_id,amend_count,shown) VALUES('review-overlay',1,?,?,0,1)",
        params: [entries[1]!.slotId, entries[1]!.version.id]
      },
      {
        sql: "UPDATE chats SET state_seq = state_seq + 1 WHERE id = ?",
        params: [chat.id]
      },
      {
        sql: "INSERT INTO fork_overrides (id,chat_id,fork_id,seq,kind,target_id,flag) SELECT 'review-overlay-choice',id,current_fork_id,state_seq,'hide_range','review-overlay',0 FROM chats WHERE id = ?",
        params: [chat.id]
      }
    ])
    assert.isTrue((yield* state()).layer[0]!.fresh)
    const hidden = yield* api.SetMessageHidden({ slotId: entries[1]!.slotId, hidden: true })
    assert.isTrue(hidden.hiddenByUser)
    assert.isFalse((yield* state()).layer[0]!.fresh)
    yield* api.SetMessageHidden({ slotId: entries[1]!.slotId, hidden: false })
    assert.isTrue((yield* state()).layer[0]!.fresh)
    assert.lengthOf((yield* state()).jobs, 0)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
})
