import { Effect, Semaphore } from "effect"

const locks = new Map<string, Semaphore.Semaphore>()

const treeLock = (userId: string) => {
  const existing = locks.get(userId)
  if (existing) return existing
  const lock = Semaphore.makeUnsafe(1)
  locks.set(userId, lock)
  return lock
}

/** A command may write into other accounts' shared folders. Acquire all owners in one order. */
export const lockFileTrees = (userIds: ReadonlyArray<string>) =>
  Effect.forEach(
    [...new Set(userIds)].sort(),
    (userId) => {
      const lock = treeLock(userId)
      return Effect.acquireRelease(lock.take(1), () => lock.release(1), { interruptible: true })
    },
    { discard: true }
  )

export const withFileTree = <A, E, R>(userId: string, effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => treeLock(userId).withPermit(effect))
