// A per-user computation shared within a writer invalidation epoch. SQLite and
// folding remain in the reader worker; publication never waits for persistence.
import { Deferred, Effect, Exit } from "effect"
import type { UserId } from "@rp/shared/domain.ts"

const MAX_COMPLETED = 16

export const makeShellMaterialization = <A, E>(read: (userId: UserId) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    type Read = { epoch: string | undefined; complete: boolean; readonly answer: Deferred.Deferred<A, E> }
    const pending = new Map<UserId, Read>()
    const running = new Set<UserId>()
    const queued = new Map<UserId, Read>()
    const trim = () => {
      let completed = [...pending.values()].filter((read) => read.complete).length
      for (const [id, read] of pending) {
        if (completed <= MAX_COMPLETED) break
        if (read.complete) {
          pending.delete(id)
          completed--
        }
      }
    }
    const get = (userId: UserId, epoch?: string): Effect.Effect<A, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const known = pending.get(userId)
          if (known && known.epoch === epoch) {
            pending.delete(userId)
            pending.set(userId, known)
            return restore(Deferred.await(known.answer))
          }
          const waiting = queued.get(userId)
          if (waiting) {
            // This read has not started. All of its waiters can observe the latest
            // epoch when it does, without queuing every intermediate snapshot.
            waiting.epoch = epoch
            pending.set(userId, waiting)
            return restore(Deferred.await(waiting.answer))
          }
          const next: Read = { epoch, complete: false, answer: Deferred.makeUnsafe<A, E>() }
          pending.set(userId, next)
          if (running.has(userId)) {
            queued.set(userId, next)
            return restore(Deferred.await(next.answer))
          }
          running.add(userId)
          const work = Effect.gen(function* () {
            let current: Read | undefined = next
            while (current) {
              const exit = yield* Effect.exit(read(userId))
              if (Exit.isFailure(exit) && pending.get(userId) === current) pending.delete(userId)
              current.complete = true
              trim()
              Deferred.doneUnsafe(current.answer, exit)
              current = queued.get(userId)
              queued.delete(userId)
            }
            running.delete(userId)
          }).pipe(Effect.interruptible)
          // A navigation can drop all waiters while SQLite is still executing. Keep
          // the result for its replacement page; the server scope owns this work.
          return work.pipe(Effect.forkIn(scope), Effect.andThen(restore(Deferred.await(next.answer))))
        })
      )
    return { get, invalidate: Effect.sync(() => pending.clear()) }
  })
