import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { completeFixture, fixtureSql, summaryJob } from "./support/lcmFixtures.ts"

it.live(
  "inconsistent same-chat lineage retains the good prefix and unrelated originals",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client(),
        user = yield* api.Whoami(),
        writer = yield* Writer,
        reader = yield* Reader
      const chat = yield* writer.CreateChat({
        userId: user.id,
        kind: "rp",
        status: "active",
        title: "Synthetic lineage",
        participants: [],
        greeting: null
      })
      const append = (parentSlotId: SlotId | null, content: string, branch = false) =>
        writer.AppendMessage({
          userId: user.id,
          chatId: chat.id,
          parentSlotId,
          branch,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "human",
            content,
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          })
        })
      const root = yield* append(null, "root"),
        middle = yield* append(root.slotId, "main middle"),
        end = yield* append(middle.slotId, "main end"),
        target = yield* append(end.slotId, "main target"),
        fork = yield* append(root.slotId, "other branch", true)
      const input = (v: typeof root) => ({ slotId: v.slotId, versionId: v.version.id, amendCount: 0 })
      const good = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [input(root)])
      const job = yield* summaryJob(config.dataDir, chat.id, middle.slotId, end.slotId)
      const bad = yield* writer.CompleteSummary({
        userId: user.id,
        ...job,
        inputs: [input(middle), input(end)],
        children: [],
        status: "complete",
        content: "OFF PATH SUMMARY"
      })
      // Simulate old or corrupted storage, independently of the write-time guards.
      yield* fixtureSql(config.dataDir, [
        { sql: "DROP TRIGGER summaries_immutable" },
        { sql: "UPDATE summaries SET first_slot_id=? WHERE id=?", params: [fork.slotId, bad.id] }
      ])
      const check = () =>
        Effect.gen(function* () {
          const assembled = yield* reader.AssembleContext({
            userId: user.id,
            chatId: chat.id,
            slotId: target.slotId,
            versionId: target.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null
          })
          const snapshot = JSON.parse(assembled.snapshot) as ContextSnapshot
          assert.deepStrictEqual(
            snapshot.lcm!.selected.map((s) => s.id),
            [good.id]
          )
          assert.isFalse(snapshot.request.messages.some((m) => m.content.includes("OFF PATH SUMMARY")))
          assert.isTrue(snapshot.request.messages.some((m) => m.content.includes("main middle")))
          assert.isTrue(snapshot.request.messages.some((m) => m.content.includes("main end")))
        })
      yield* check()
      yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE summaries SET first_slot_id=? WHERE id=?", params: [middle.slotId, bad.id] },
        { sql: "DROP TRIGGER summary_inputs_immutable" },
        {
          sql: "UPDATE summary_inputs SET slot_id=?,version_id=? WHERE summary_id=? AND ordinal=0",
          params: [fork.slotId, fork.version.id, bad.id]
        }
      ])
      yield* check()
      yield* fixtureSql(config.dataDir, [
        {
          sql: "UPDATE summary_inputs SET slot_id=?,version_id=? WHERE summary_id=? AND ordinal=0",
          params: [middle.slotId, middle.version.id, bad.id]
        },
        { sql: "DROP TRIGGER summary_parents_chain" },
        { sql: "DROP TRIGGER summary_parents_closed" },
        {
          sql: "INSERT INTO summary_parents(summary_id,parent_id,ordinal,parent_revision_id) VALUES(?,?,0,?)",
          params: [bad.id, bad.id, bad.revisionId]
        }
      ])
      yield* check()
    }).pipe(Effect.provide(serverLayer(config)))
  },
  90000
)
