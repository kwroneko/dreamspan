// What each user hears about wherever they are in the app (DESIGN §10.1): a reply that
// finished in any of their chats. Every open tab of the user subscribes; nobody else's
// notices ever reach it.
import type { UserId } from "@rp/shared/domain.ts"
import type { Notice } from "@rp/shared/noticeApi.ts"
import { type Cause, Context, Effect, Layer, Queue, type Scope } from "effect"

/** Notices a tab may fall behind by; past that the oldest go, which only loses a badge. */
const BACKLOG = 256

export class Notices extends Context.Service<
  Notices,
  {
    /** Queues a notice for the user's subscribers. Never blocks. */
    readonly publish: (userId: UserId, notice: Notice) => void
    /** The user's notices from now on, for as long as the scope lasts. */
    readonly subscribe: (
      userId: UserId
    ) => Effect.Effect<Queue.Dequeue<ReadonlyArray<Notice>, Cause.Done>, never, Scope.Scope>
  }
>()("rp/chat/Notices") {
  static readonly layer = Layer.sync(Notices, () => {
    const subscribers = new Map<UserId, Set<Queue.Queue<ReadonlyArray<Notice>, Cause.Done>>>()
    return Notices.of({
      publish: (userId, notice) => {
        for (const queue of subscribers.get(userId) ?? []) Queue.offerUnsafe(queue, [notice])
      },
      subscribe: (userId) =>
        Effect.acquireRelease(
          Effect.map(Queue.sliding<ReadonlyArray<Notice>, Cause.Done>(BACKLOG), (queue) => {
            const set = subscribers.get(userId) ?? new Set()
            subscribers.set(userId, set)
            set.add(queue)
            return queue
          }),
          (queue) =>
            Effect.sync(() => {
              const set = subscribers.get(userId)
              set?.delete(queue)
              if (set?.size === 0) subscribers.delete(userId)
            })
        )
    })
  })
}
