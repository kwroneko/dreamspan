// Continuations after a card was saved or swapped. Features own their dialogs;
// callers only provide the saved names and wait before closing/navigating.
import { useEffect, useSyncExternalStore, type ComponentType } from "react"
import type { ChatId, EntityId, ForkId } from "@rp/shared/chat.ts"
import { makeRegistry } from "../../registry.ts"

export interface CardSaved {
  readonly entityId: EntityId
  readonly oldName: string
  readonly newName: string
  readonly current?: { readonly chatId: ChatId; readonly forkId: ForkId } | undefined
  readonly onlyThis?: boolean
}
export const cardSavedContributions = makeRegistry<{
  readonly id: string
  readonly order: number
  readonly applies: (change: CardSaved) => boolean
  readonly component: ComponentType<{ change: CardSaved; onDone: (stay?: boolean) => void }>
}>()

export const cardSavedContribution = (change: CardSaved) =>
  [...cardSavedContributions.list()].sort((a, b) => a.order - b.order).find((entry) => entry.applies(change))

// A cast swap can unmount the row that started it. Its continuation belongs to
// the app, not that row. Keep each request until the registered dialog completes.
interface Continuation {
  readonly id: number
  readonly userId: string
  readonly change: CardSaved
  readonly contribution: NonNullable<ReturnType<typeof cardSavedContribution>>
  readonly onDone: (stay?: boolean) => void
}
let queue: ReadonlyArray<Continuation> = []
let sequence = 0
const listeners = new Set<() => void>()
const publish = () => listeners.forEach((listener) => listener())
export function showCardSaved(userId: string, change: CardSaved, onDone: (stay?: boolean) => void) {
  const contribution = cardSavedContribution(change)
  if (!contribution) return onDone()
  queue = [...queue, { id: ++sequence, userId, change, contribution, onDone }]
  publish()
}
export function useCardSaved(userId: string) {
  const entries = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => queue
  )
  useEffect(
    () => () => {
      queue = []
      publish()
    },
    [userId]
  )
  const request = entries.find((entry) => entry.userId === userId)
  if (!request) return null
  return {
    ...request,
    onDone: (stay?: boolean) => {
      queue = queue.filter((entry) => entry !== request)
      publish()
      request.onDone(stay)
    }
  }
}
