/** The measured capacity stays current even while all the pinned actions fit. */
export class MessageActionFit {
  private capacity = Number.POSITIVE_INFINITY
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  visible(pinned: number) {
    return Math.min(pinned, this.capacity)
  }

  setCapacity(capacity: number) {
    if (capacity === this.capacity) return
    this.capacity = capacity
    for (const listener of this.listeners) listener()
  }
}
