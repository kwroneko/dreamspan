// The composer's text once typing pauses, for what reads it without needing every keystroke (the
// next-reply strip's context chip). Keystrokes only restart a timer: listeners hear nothing while
// keys are coming, and once when the text has rested REST_MS, the box loses focus (`flush`), or
// it's emptied (a send).

/** How long typing pauses before the text counts as rested. */
export const REST_MS = 800

export interface RestedText {
  /** Hears the rested text change; never once per keystroke. */
  readonly subscribe: (listener: () => void) => () => void
  /** The text as it last rested. */
  readonly snapshot: () => string
  /** Takes the text as it is now (the box lost focus). */
  readonly flush: () => void
}

/**
 * The rested text of a store (`read` its text, `watch` its changes). It watches the store only
 * while something listens.
 */
export const restedText = (
  watch: (listener: () => void) => () => void,
  read: () => string,
  restMs = REST_MS
): RestedText => {
  let rested = read()
  let timer: ReturnType<typeof setTimeout> | null = null
  let unwatch: (() => void) | null = null
  const listeners = new Set<() => void>()
  const settle = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    const now = read()
    if (now === rested) return
    rested = now
    for (const listener of listeners) listener()
  }
  const typed = () => {
    const now = read()
    if (now === "" && rested !== "") return settle()
    if (timer !== null) clearTimeout(timer)
    timer = now === rested ? null : setTimeout(settle, restMs)
  }
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      if (unwatch === null) {
        rested = read()
        unwatch = watch(typed)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0 || unwatch === null) return
        unwatch()
        unwatch = null
        if (timer !== null) clearTimeout(timer)
        timer = null
      }
    },
    snapshot: () => rested,
    flush: settle
  }
}
