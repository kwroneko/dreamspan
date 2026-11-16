// Which messages are ticked, while the user picks several to delete together (job msgactions1).
// One store per open chat, in the tab only: a selection is a moment's work, gone on reload, as a
// confirmation is. Each row reads only its own tick (`ticked`), so ticking or a range of 500
// re-renders the rows whose ticks change, never the message list. Hide and Show (selecthide1) use it too.
import type { ForkId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import { MULTI_DELETE_LIMIT } from "@rp/shared/bin.ts"
import type { ChatSession } from "../session.ts"
import { positionOf } from "../position.ts"

/** What the confirmation says of a ticked message, kept while it's scrolled out of the window. */
export interface Ticked {
  readonly slotId: SlotId
  readonly position: number
  readonly versions: number
  /** Hidden from the model in this fork. */
  readonly hidden: boolean
  readonly copies: ReadonlyArray<{ readonly slotId: SlotId; readonly forkId: ForkId }>
}

export interface SelectionState {
  /** Picking: the ticks show on every message. */
  readonly active: boolean
  /** The fork the ticks are in; picking ends when the chat shows another. */
  readonly forkId: ForkId | null
  readonly ticked: ReadonlyMap<SlotId, Ticked>
  /** The last message ticked or unticked, where a range starts. */
  readonly anchor: SlotId | null
  /** The next tick selects every message from the anchor to it ("Select range"). */
  readonly range: boolean
  /** The range or limit that couldn't be applied, said in the bar. */
  readonly notice: string | null
}

const IDLE: SelectionState = {
  active: false,
  forkId: null,
  ticked: new Map(),
  anchor: null,
  range: false,
  notice: null
}

/** A message that can't be ticked now, and why: the one still being written. */
export const untickable = (entry: PathEntry) =>
  entry.version.status === "generating" ? "This message is still being written. Stop it or wait to select it." : null

const tickedOf = (entry: PathEntry): Ticked => ({
  slotId: entry.slotId,
  position: positionOf(entry),
  versions: entry.versionCount,
  hidden: entry.contextExcluded,
  copies: entry.copies ?? []
})

export class MessageSelection {
  private state: SelectionState = IDLE
  private revision: number | undefined
  private readonly listeners = new Set<() => void>()

  private readonly session: ChatSession

  constructor(session: ChatSession) {
    this.session = session
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  readonly snapshot = () => this.state

  private set(next: Partial<SelectionState>) {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }

  /** Starts picking with `entry` ticked (Select messages on a message's menu). */
  start(entry: PathEntry) {
    const { forkId, pathRevision } = this.session.snapshot()
    this.revision = pathRevision
    const ticked = new Map<SlotId, Ticked>()
    if (untickable(entry) === null) ticked.set(entry.slotId, tickedOf(entry))
    this.set({ active: true, forkId, ticked, anchor: entry.slotId, range: false, notice: null })
  }

  stop() {
    if (this.state.active) this.state = IDLE
    for (const listener of this.listeners) listener()
  }

  setRange(range: boolean) {
    this.set({ range, notice: null })
  }

  /**
   * Ticks or unticks `entry`. With Shift held or Select range on, and a message ticked before,
   * every message shown between them takes the new state; the range mode then ends.
   */
  toggle(entry: PathEntry, checked: boolean, shift: boolean) {
    const { ticked, anchor, range } = this.state
    const next = new Map(ticked)
    const entries = this.session.snapshot().entries
    const to = entries.findIndex((e) => e.slotId === entry.slotId)
    const from = anchor === null ? -1 : entries.findIndex((e) => e.slotId === anchor)
    let notice: string | null = null
    if ((shift || range) && anchor !== null && from >= 0 && to >= 0) {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      for (const e of entries.slice(lo, hi + 1)) {
        if (!checked) next.delete(e.slotId)
        else if (untickable(e) === null) next.set(e.slotId, tickedOf(e))
      }
    } else {
      if ((shift || range) && anchor !== null && from < 0)
        notice = "The message the range starts from is no longer loaded: ticked this one only."
      if (checked) next.set(entry.slotId, tickedOf(entry))
      else next.delete(entry.slotId)
    }
    if (next.size > MULTI_DELETE_LIMIT) {
      notice = `At most ${MULTI_DELETE_LIMIT.toLocaleString()} messages can be selected at once.`
      return this.set({ notice, range: false })
    }
    this.set({ ticked: next, anchor: entry.slotId, range: false, notice })
  }

  /** A history reload invalidates the choice, including selections outside the loaded window. */
  reconcile() {
    if (!this.state.active) return
    const view = this.session.snapshot()
    if (view.forkId !== this.state.forkId || view.pathRevision !== this.revision) return this.stop()
    const next = new Map(this.state.ticked)
    let changed = false
    for (const entry of view.entries) {
      const previous = next.get(entry.slotId)
      if (!previous) continue
      if (untickable(entry) !== null) {
        next.delete(entry.slotId)
        changed = true
      } else {
        const current = tickedOf(entry)
        if (JSON.stringify(previous) !== JSON.stringify(current)) {
          next.set(entry.slotId, current)
          changed = true
        }
      }
    }
    if (changed) this.set({ ticked: next })
  }

  /** The ticked messages in the path's order, top down: the order they're deleted and restored in. */
  ordered(): ReadonlyArray<Ticked> {
    return orderedOf(this.state.ticked)
  }
}

/**
 * `ticked` in the path's order, top down. Components call this with the snapshot's `ticked`, not
 * `store.ordered()`: the React Compiler would keep the first answer for the (stable) store.
 */
export const orderedOf = (ticked: SelectionState["ticked"]): ReadonlyArray<Ticked> =>
  [...ticked.values()].sort((a, b) => a.position - b.position)

const stores = new WeakMap<ChatSession, MessageSelection>()

/** The selection of an open chat. */
export const selectionOf = (session: ChatSession) => {
  let store = stores.get(session)
  if (!store) {
    store = new MessageSelection(session)
    stores.set(session, store)
  }
  return store
}
