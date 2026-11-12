import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"

describe("workshop policies", () => {
  it.live("refuses workshops as merge sources and destinations", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const workshop = yield* api.CreateWorkshop({})
      const story = yield* api.CreateChat({ title: "Synthetic story" })
      const sent = yield* posted(
        api.SendMessage({ chatId: story.id, parentSlotId: null, branch: false, content: "Story text." })
      )
      for (const [destination, source, at] of [
        [story, workshop, sent.entry.slotId],
        [workshop, story, workshop.activeLeafSlotId!]
      ] as const) {
        assert.strictEqual(
          yield* outcome(
            api.PreviewChatMerge({
              chatId: destination.id,
              forkId: destination.currentForkId!,
              at,
              source: { chatId: source.id, forkId: source.currentForkId! },
              includeLeftOut: false
            })
          ),
          "MergeRefused"
        )
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("refuses enabling workshop summaries through every state write path", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const workshop = yield* api.CreateWorkshop({})
      assert.strictEqual(yield* outcome(api.SetLcmEnabled({ chatId: workshop.id, enabled: true })), "NotFound")
      assert.strictEqual(
        yield* outcome(api.ChangeLcmSettings({ chatId: workshop.id, change: { enabled: true } })),
        "NotFound"
      )
      const user = yield* api.Whoami()
      const writer = yield* Writer
      assert.strictEqual(
        yield* outcome(
          writer.AddStateEvent({
            userId: user.id,
            chatId: workshop.id,
            slotId: null,
            versionId: null,
            scope: null,
            data: { key: "lcm.settings", value: { enabled: true } }
          })
        ),
        "NotFound"
      )
      const plan = yield* (yield* Reader).PlanSummaries({
        userId: user.id,
        chatId: workshop.id,
        leafSlotId: workshop.activeLeafSlotId!,
        reason: "reply"
      })
      assert.strictEqual(
        yield* outcome(
          (yield* Reader).EstimateBackfill({
            userId: user.id,
            chatId: workshop.id,
            leafSlotId: workshop.activeLeafSlotId!
          })
        ),
        "NotFound"
      )
      assert.strictEqual(
        yield* outcome(
          writer.EnqueueSummaries({
            userId: user.id,
            chatId: workshop.id,
            leafSlotId: workshop.activeLeafSlotId!,
            chunks: [],
            requestClass: "interactive"
          })
        ),
        "NotFound"
      )
      assert.isFalse(plan.enabled)
      assert.isEmpty(plan.chunks)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("refuses importing SillyTavern history into a workshop", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const user = yield* api.Whoami()
      const workshop = yield* api.CreateWorkshop({})
      const writer = yield* Writer
      yield* writer.StImportBegin({ userId: user.id, importId: "synthetic-workshop-import" })
      assert.strictEqual(
        yield* outcome(
          writer.StImportStartChat({
            userId: user.id,
            source: "chats/synthetic.jsonl",
            title: "Synthetic",
            createdAt: 1,
            chatId: workshop.id,
            lease: "synthetic-workshop-import"
          })
        ),
        "NotFound"
      )
      assert.strictEqual((yield* api.GetChat({ chatId: workshop.id })).activeLeafSlotId, workshop.activeLeafSlotId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
