// The timeline's away rows (spec/CHARACTER-CONTEXT.md §5, §9.2 unit CU3): "Wren left · scene
// check" or "Wren is back · you" under the message where a character's away mark changed, with
// Undo on the scene check's, whether it said someone left or came back. The server lists every away mark on the branch's path in order
// (`GetAwayMarks`); only the changes become rows, so a mark that repeats what holds already (the
// user's own "back" an Undo writes in place of the scene check's, say) shows nothing. One read a
// branch, leaf and state change, shared by every row on screen.
import type { EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import type { AwayMark } from "@rp/shared/contextsApi.ts"
import type { ChatSession } from "./session.ts"

export interface AwayRow {
  readonly eventId: string
  readonly slotId: SlotId
  readonly entityId: EntityId
  /** True: they left here; false: they're back. */
  readonly away: boolean
  readonly by: AwayMark["by"]
  /** The reply whose own tool set it (`by: "character"`): its speaker. */
  readonly setBy?: EntityId
  /** Only the scene check's marks, "left" and "back", can be undone (writer `CorrectPresence`). */
  readonly undoable: boolean
}

/** The changes among the marks, in order: where someone left or came back, and who said so. */
export const awayTransitions = (
  marks: ReadonlyArray<AwayMark>,
  /** Narrators are never in or out of the scene: their marks show nothing. */
  narrators: ReadonlySet<string> = new Set()
): Array<AwayRow> => {
  const away = new Set<string>()
  const rows: Array<AwayRow> = []
  for (const mark of marks) {
    if (narrators.has(mark.entityId)) continue
    if (away.has(mark.entityId) === mark.away) continue
    if (mark.away) away.add(mark.entityId)
    else away.delete(mark.entityId)
    rows.push({
      eventId: mark.eventId,
      slotId: mark.slotId,
      entityId: mark.entityId,
      away: mark.away,
      by: mark.by,
      ...(mark.setBy ? { setBy: mark.setBy } : {}),
      undoable: mark.by === "decision"
    })
  }
  return rows
}

/** The row's short label: "Wren left · scene check". */
export const awayLabel = (row: AwayRow, name: (id: EntityId) => string) => {
  const who = name(row.entityId)
  const what = row.away ? `${who} left` : `${who} is back`
  const by =
    row.by === "decision"
      ? "scene check"
      : row.by === "user"
        ? "you"
        : row.setBy === undefined || row.setBy === row.entityId
          ? "own reply"
          : `${name(row.setBy)}'s reply`
  return `${what} · ${by}`
}

/** What Undo does, on hover: the opposite of what the scene check said. */
export const undoExplanation = (row: AwayRow, name: (id: EntityId) => string) => {
  const who = name(row.entityId)
  return row.away
    ? `${who} was there after all: counted present from here, so ${who}'s replies see the messages written since.`
    : `${who} hadn't come back: counted away from here, so ${who} isn't picked to reply, and with separate contexts ${who}'s replies leave out the messages written since.`
}

/** What the row means, on hover: who decided, and what follows from it. */
export const awayExplanation = (row: AwayRow, name: (id: EntityId) => string) => {
  const who = name(row.entityId)
  const since = row.away
    ? `From here, ${who} isn't picked to reply, and with separate contexts ${who}'s replies leave out what's said until ${who} is back.`
    : `From here, ${who} can be picked to reply again, and with separate contexts sees what's said.`
  const said =
    row.by === "decision"
      ? `A decision model judged that ${who} ${row.away ? "left" : "was back"} at the end of this message.`
      : row.by === "user"
        ? `You marked ${who} ${row.away ? "away" : "back"} here, in the Cast tab.`
        : `${row.setBy === undefined || row.setBy === row.entityId ? `${who}'s own reply` : `${name(row.setBy)}'s reply`} marked ${who} ${row.away ? "away" : "back"}; a new version of that reply takes it back.`
  return `${said} ${since}`
}

type Key = { readonly forkId: ForkId; readonly leaf: SlotId | null; readonly generation: number }

/** One session's rows: read again when the branch, its leaf or the chat's state changes. */
class AwayRowsStore {
  private rows: ReadonlyMap<string, ReadonlyArray<AwayRow>> = new Map()
  private key: Key | null = null
  private generation = 0
  private readonly listeners = new Set<() => void>()
  private unsubscribe: Array<() => void> = []

  private readonly session: ChatSession
  constructor(session: ChatSession) {
    this.session = session
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      // State may have changed while no timeline was listening, without moving its leaf.
      this.generation++
      this.unsubscribe = [
        this.session.subscribe(() => this.check()),
        // A state change (an Undo, a scene check's answer, the Cast tab) forgets positions.
        this.session.subscribePositions(() => {
          this.generation++
          this.check()
        })
      ]
      this.check()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) for (const stop of this.unsubscribe.splice(0)) stop()
    }
  }

  readonly at = (slotId: SlotId) => this.rows.get(slotId) ?? EMPTY

  /** Read again now, after an Undo. */
  refresh() {
    this.generation++
    this.check()
  }

  private check() {
    const view = this.session.snapshot()
    if (view.forkId === null || view.loading) return
    const key: Key = { forkId: view.forkId, leaf: view.leafSlotId, generation: this.generation }
    if (
      this.key &&
      this.key.forkId === key.forkId &&
      this.key.leaf === key.leaf &&
      this.key.generation === key.generation
    )
      return
    this.key = key
    void this.read(key)
  }

  private async read(key: Key) {
    const result = await this.session.call((client) =>
      client("GetAwayMarks", { chatId: this.session.id, forkId: key.forkId, slotId: key.leaf })
    )
    if (this.key !== key || !result.ok) return
    const narrators = new Set(
      Object.entries(this.session.snapshot().cast?.roles ?? {}).flatMap(([id, role]) =>
        role === "narrator" ? [id] : []
      )
    )
    const bySlot = new Map<string, Array<AwayRow>>()
    for (const row of awayTransitions(result.value, narrators)) {
      const list = bySlot.get(row.slotId) ?? []
      list.push(row)
      bySlot.set(row.slotId, list)
    }
    this.rows = bySlot
    for (const listener of this.listeners) listener()
  }
}

const EMPTY: ReadonlyArray<AwayRow> = []
const stores = new WeakMap<ChatSession, AwayRowsStore>()

export const awayRowsOf = (session: ChatSession) => {
  let store = stores.get(session)
  if (!store) {
    store = new AwayRowsStore(session)
    stores.set(session, store)
  }
  return store
}
