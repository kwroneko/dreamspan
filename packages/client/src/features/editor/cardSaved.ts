// Continuations when a card's nickname changes: where its name is confirmed (the name
// header, `CardNameHeader.tsx`), or after a fork or swap renamed what the chat uses. Features
// own their dialogs; callers only provide the names and wait for the answer.
import { useEffect, useSyncExternalStore, type ComponentType } from "react"
import type { ChatId, EntityId, ForkId } from "@rp/shared/chat.ts"
import { makeRegistry } from "../../registry.ts"

export interface CardSaved {
  readonly entityId: EntityId
  readonly oldName: string
  readonly newName: string
  readonly current?: { readonly chatId: ChatId; readonly forkId: ForkId } | undefined
  readonly onlyThis?: boolean
  /**
   * Asked where the name is confirmed, before it changes: closing the dialog cancels the
   * rename (`cancel`), and the answer says what to write.
   */
  readonly atConfirm?: boolean
  /**
   * The display name changed while there's no nickname (`renameQuestion`'s `display`): also
   * offer keeping the old name in chats (it becomes the nickname) or just changing it.
   */
  readonly display?: boolean
}

/**
 * How a name question was answered: `cancel` (closed: no rename), `keep` (the old name stays
 * the nickname, as the nickname), `plain` (renamed from now on), `no` (renamed, past messages
 * kept), `replaced` (renamed and replaced in past messages), `failed` (renamed; the replacement
 * failed and can be resumed). None: no question was registered, so the rename just goes ahead.
 */
export type RenameAnswer = "cancel" | "keep" | "plain" | "no" | "replaced" | "failed"
export type CardSavedDone = (stay?: boolean, answer?: RenameAnswer) => void
export const cardSavedContributions = makeRegistry<{
  readonly id: string
  readonly order: number
  readonly applies: (change: CardSaved) => boolean
  readonly component: ComponentType<{ change: CardSaved; onDone: CardSavedDone }>
}>()

export const cardSavedContribution = (change: CardSaved) =>
  [...cardSavedContributions.list()].sort((a, b) => a.order - b.order).find((entry) => entry.applies(change))

// A cast swap can unmount the row that started it. Its continuation belongs to
// the app, not that row. Keep each request until the registered dialog completes.
interface Continuation {
  readonly id: number
  readonly userId: string
  readonly change: CardSaved
  readonly onDone: CardSavedDone
}
let queue: ReadonlyArray<Continuation> = []
let sequence = 0
const listeners = new Set<() => void>()
const publish = () => listeners.forEach((listener) => listener())
export function showCardSaved(userId: string, change: CardSaved, onDone: CardSavedDone) {
  const contribution = cardSavedContribution(change)
  if (!contribution) return onDone()
  queue = [...queue, { id: ++sequence, userId, change, onDone }]
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
    onDone: (stay?: boolean, answer?: RenameAnswer) => {
      if (!queue.includes(request)) return
      queue = queue.filter((entry) => entry !== request)
      publish()
      request.onDone(stay, answer)
    }
  }
}
