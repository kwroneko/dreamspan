// Bound untrusted media work without queueing more bodies in memory. Entries expire
// after an idle minute; a caller always releases its active slot, including on abort.
interface Bucket {
  tokens: number
  at: number
  active: number
}
export const makeMediaLimits = (now: () => number = Date.now) => {
  const users = new Map<string, Bucket>()
  let active = 0
  return {
    acquire(user: string): (() => void) | null {
      const time = now()
      for (const [id, bucket] of users) if (bucket.active === 0 && time - bucket.at >= 60_000) users.delete(id)
      const bucket = users.get(user) ?? { tokens: 60, at: time, active: 0 }
      bucket.tokens = Math.min(60, bucket.tokens + Math.max(0, time - bucket.at) / 1000)
      bucket.at = time
      users.set(user, bucket)
      if (bucket.tokens < 1 || bucket.active >= 8 || active >= 32) return null
      bucket.tokens--
      bucket.active++
      active++
      let released = false
      return () => {
        if (released) return
        released = true
        bucket.active--
        active--
      }
    }
  }
}
