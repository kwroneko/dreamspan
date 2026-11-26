import { RefusalJudge } from "../src/decision/RefusalJudge.ts"
import { Summarizer } from "../src/lcm/Summarizer.ts"
// Generations' side of the send queue: queue events leave in the order the writer committed
// them, even when the reply a queue posted ends at once and publishes the next queue while
// the first is still publishing what it posted.
import { assert, describe, it } from "@effect/vitest"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Deferred, Effect, Layer, Option, Stream } from "effect"
import { ChatHub } from "../src/chat/ChatHub.ts"
import { Generations } from "../src/chat/Generations.ts"
import { Generator } from "../src/chat/Generator.ts"
import { Notices } from "../src/chat/Notices.ts"
import { Reader, Writer } from "../src/db/Database.ts"

describe("Generations and the send queue", () => {
  it.live("never publishes an older queue after a newer one", () =>
    Effect.gen(function* () {
      const events: Array<ChatEvent> = []
      // Reading what the first queue posted waits until the posted reply's own end has published.
      const nextPublished = yield* Deferred.make<void>()
      const fakes = Layer.mergeAll(
        Notices.layer,
        Layer.succeed(Summarizer)({
          afterReply: () => Effect.void,
          beforeReply: () => Effect.succeed(false),
          runJob: () => Effect.void,
          planNow: () => Effect.succeed([])
        }),
        Layer.succeed(RefusalJudge)({ judge: () => Effect.succeed("unjudged") }),
        Layer.succeed(Writer)({
          InterruptGenerations: () => Effect.succeed({ interrupted: 0, queued: 0 }),
          SettleWorkshopSwipe: () => Effect.succeed({ restored: 0, files: [] }),
          // The posted reply ends, and the queue behind it is empty now.
          FinishGeneration: () =>
            Effect.succeed({
              version: { id: "v-next", status: "complete" },
              chatId: "chat",
              posted: [],
              next: null,
              withdrawn: 0,
              queueChanged: true,
              queue: []
            })
        } as unknown as Writer["Service"]),
        Layer.succeed(Reader)({
          GetSlot: () => Deferred.await(nextPublished).pipe(Effect.as({ entry: { slotId: "next" } })),
          GetChat: () => Effect.succeed({ id: "chat" }),
          // No story beside this chat (WORKSHOP-BRANCHES.md §2.2), so no story position.
          WorkshopStoryPosition: () => Effect.succeed(null)
        } as unknown as Reader["Service"]),
        // A reply that ends as soon as it starts.
        Layer.succeed(Generator)(Option.some({ generate: () => Stream.make("An instant reply.") })),
        Layer.succeed(ChatHub)({
          publish: (_chatId: string, event: ChatEvent) => {
            events.push(event)
            if (event._tag === "Queue" && event.queue.length === 0) Deferred.doneUnsafe(nextPublished, Effect.void)
          }
        } as unknown as ChatHub["Service"])
      )
      yield* Effect.gen(function* () {
        const generations = yield* Generations
        yield* generations.continueQueue(
          "user" as never,
          {
            chatId: "chat",
            posted: ["next"],
            next: { slotId: "next", versionId: "v-next" },
            withdrawn: 0,
            queueChanged: true,
            queue: [{ id: "remaining", replySlotId: "next" }]
          } as never
        )
      }).pipe(Effect.provide(Generations.layer.pipe(Layer.provide(fakes))))
      const queues = events.flatMap((event) => (event._tag === "Queue" ? [event.queue.length] : []))
      assert.deepStrictEqual(queues, [1, 0])
    }).pipe(Effect.scoped)
  )
})
