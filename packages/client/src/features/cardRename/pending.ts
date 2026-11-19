// A saved card and a failed history action are separate outcomes. Keep the latter
// per account in this browser so closing/reloading the dialog doesn't lose its names.
import { Schema } from "effect"
import { ChatId, EntityId, ForkId } from "@dreamspan/shared/chat.ts"
import { useSyncExternalStore } from "react"
import type { CardSaved } from "../editor/cardSaved.ts"

const Pending = Schema.Struct({
  entityId: EntityId,
  oldName: Schema.String,
  newName: Schema.String,
  current: Schema.optionalKey(Schema.Struct({ chatId: ChatId, forkId: ForkId })),
  onlyThis: Schema.optionalKey(Schema.Boolean)
})
const PendingList = Schema.Array(Pending)
const listeners = new Set<() => void>()
const key = (user: string, entity: string) => `dreamspan.rename-history:${user}:${entity}`
const emit = () => listeners.forEach((listener) => listener())
const read = (user: string, entity: string) => {
  try {
    return localStorage.getItem(key(user, entity))
  } catch {
    return null
  }
}
const decode = (raw: string | null): ReadonlyArray<CardSaved> => {
  try {
    const decoded = Schema.decodeUnknownOption(PendingList)(JSON.parse(raw ?? "[]"))
    return decoded._tag === "Some" ? decoded.value : []
  } catch {
    return []
  }
}
const same = (a: CardSaved, b: CardSaved) =>
  a.oldName === b.oldName &&
  a.newName === b.newName &&
  a.current?.forkId === b.current?.forkId &&
  a.onlyThis === b.onlyThis
export const keepPending = (user: string, change: CardSaved) => {
  try {
    const existing = decode(read(user, change.entityId))
    if (existing.some((item) => same(item, change))) return
    localStorage.setItem(key(user, change.entityId), JSON.stringify([...existing, change]))
    emit()
  } catch {
    /* The open dialog still offers retry. */
  }
}
export const dropPending = (user: string, change: CardSaved) => {
  try {
    const remaining = decode(read(user, change.entityId)).filter((item) => !same(item, change))
    if (remaining.length) localStorage.setItem(key(user, change.entityId), JSON.stringify(remaining))
    else localStorage.removeItem(key(user, change.entityId))
    emit()
  } catch {
    /* Storage may be unavailable. */
  }
}
export function usePending(user: string, entity: string): CardSaved | null {
  const raw = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      window.addEventListener("storage", listener)
      return () => {
        listeners.delete(listener)
        window.removeEventListener("storage", listener)
      }
    },
    () => read(user, entity)
  )
  return decode(raw)[0] ?? null
}
