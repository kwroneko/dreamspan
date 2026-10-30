// What each user hears about wherever they are in the app (DESIGN §10.1): a reply that
// finished in any of their chats. Every open tab of the user subscribes; nobody else's
// notices ever reach it.
import type { UserId } from "@rp/shared/domain.ts"
import type { Notice } from "@rp/shared/noticeApi.ts"
import { type Cause, Context, Effect, Layer, Queue, type Scope } from "effect"

/** Batches a tab may lag behind; overflow requests a draft refresh and keeps the newest notice. */
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
        for (const queue of subscribers.get(userId) ?? []) {
          if (!Queue.offerUnsafe(queue, [notice])) {
            while (Queue.sizeUnsafe(queue) > 0) Queue.takeUnsafe(queue)
            Queue.offerUnsafe(queue, [{ _tag: "UserDraftSync" }, notice])
          }
        }
      },
      subscribe: (userId) =>
        Effect.acquireRelease(
          Effect.map(Queue.bounded<ReadonlyArray<Notice>, Cause.Done>(BACKLOG), (queue) => {
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
