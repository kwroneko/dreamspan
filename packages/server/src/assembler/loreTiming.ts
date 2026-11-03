import { createHash } from "node:crypto"
import type { LorebookEntry } from "@rp/shared/docs/lorebook.ts"

export const loreEntryKey = (book: string, entry: Pick<LorebookEntry, "uid">) => JSON.stringify([book, entry.uid])

/** The unresolved entry, as in ST's entry hash: an edit invalidates its old effects. */
export const loreIdentity = (book: string, entry: LorebookEntry) =>
  createHash("sha256")
    .update(JSON.stringify([book, entry]))
    .digest("hex")

export interface LoreReceipt {
  readonly key: string
  readonly sticky: number
  readonly cooldown: number
}

export interface LoreTimingState {
  readonly count: number
  readonly effects: ReadonlyArray<{ readonly key: string; readonly sticky: boolean; readonly cooldown: boolean }>
}

export interface LoreTimeline {
  readonly count: number
  readonly activations: ReadonlyArray<{
    readonly id: string
    /** Number of eligible messages before this selected version. */
    readonly at: number
    readonly entries: ReadonlyArray<LoreReceipt>
  }>
}

interface Interval {
  readonly start: number
  readonly end: number
  readonly protected?: boolean
}
interface Timers {
  readonly cooldownLength: number
  sticky?: Interval
  cooldown?: Interval
}
type State = ReadonlyMap<string, Timers>

/** Immutable prefix checkpoints shared by branches; bounded and local to each reader worker. */
const checkpoints = new Map<string, State>()
const advance = (previous: State, count: number) => {
  const state = new Map<string, Timers>()
  for (const [key, timers] of previous) {
    let { sticky, cooldown } = timers
    if (sticky && count <= sticky.start) sticky = undefined
    else if (sticky && count >= sticky.end) {
      sticky = undefined
      if (timers.cooldownLength > 0) cooldown = { start: count, end: count + timers.cooldownLength, protected: true }
    }
    if (cooldown && ((!cooldown.protected && count <= cooldown.start) || count >= cooldown.end)) cooldown = undefined
    if (sticky || cooldown)
      state.set(key, {
        cooldownLength: timers.cooldownLength,
        ...(sticky ? { sticky } : {}),
        ...(cooldown ? { cooldown } : {})
      })
  }
  return state
}

/** Fold actual admissions, never guessed keyword matches or previews, on this path only. */
export const loreEffectsAt = (timeline: LoreTimeline) => {
  let state: State = new Map()
  let prefix = ""
  const prefixes = timeline.activations.map((activation) => {
    prefix = createHash("sha256").update(prefix).update(JSON.stringify(activation)).digest("hex")
    return prefix
  })
  let from = 0
  // Search before adding checkpoints: a cold prefix must not evict the warm suffix.
  for (let i = prefixes.length - 1; i >= 0; i--) {
    const cached = checkpoints.get(prefixes[i]!)
    if (!cached) continue
    state = cached
    from = i + 1
    break
  }
  for (let i = from; i < timeline.activations.length; i++) {
    const activation = timeline.activations[i]!
    const next = advance(state, activation.at)
    for (const entry of activation.entries) {
      const timers = next.get(entry.key) ?? { cooldownLength: entry.cooldown }
      next.set(entry.key, {
        cooldownLength: entry.cooldown,
        ...(timers.sticky
          ? { sticky: timers.sticky }
          : entry.sticky > 0
            ? { sticky: { start: activation.at, end: activation.at + entry.sticky } }
            : {}),
        ...(timers.cooldown
          ? { cooldown: timers.cooldown }
          : entry.cooldown > 0
            ? { cooldown: { start: activation.at, end: activation.at + entry.cooldown } }
            : {})
      })
    }
    state = next
    if (i % 32 === 31 || i === timeline.activations.length - 1) {
      checkpoints.set(prefixes[i]!, state)
      if (checkpoints.size > 512) checkpoints.delete(checkpoints.keys().next().value!)
    }
  }
  return new Map(
    [...advance(state, timeline.count)].map(([key, timers]) => [
      key,
      { sticky: !!timers.sticky, cooldown: !!timers.cooldown }
    ])
  )
}
