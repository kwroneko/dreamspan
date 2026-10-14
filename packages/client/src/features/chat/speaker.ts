// Who the composer speaks as, picked in the composer's switcher or with "Write as" in the
// Cast tab (DESIGN §2.2). One per open chat, so both read and change the same choice; until
// one is picked, the composer speaks as the first card the user plays.
import type { EntityId } from "@rp/shared/chat.ts"
import { useSyncExternalStore } from "react"
import type { ChatSession } from "./session.ts"

/** `undefined`: nothing picked yet; `null`: the user as themselves. */
type Picked = EntityId | null | undefined

class SpeakerChoice {
  private picked: Picked = undefined
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly snapshot = (): Picked => this.picked

  set(next: EntityId | null) {
    if (next === this.picked) return
    this.picked = next
    for (const listener of this.listeners) listener()
  }
}

const choices = new WeakMap<ChatSession, SpeakerChoice>()

export const speakerChoice = (session: ChatSession): SpeakerChoice => {
  let choice = choices.get(session)
  if (choice === undefined) {
    choice = new SpeakerChoice()
    choices.set(session, choice)
  }
  return choice
}

/** The speaker picked for this chat's composer; `undefined` until one is. */
export const usePickedSpeaker = (session: ChatSession): Picked => {
  const choice = speakerChoice(session)
  return useSyncExternalStore(choice.subscribe, choice.snapshot)
}

/** Makes `id` the composer's speaker and puts the cursor in the composer ("Write as"). */
export const writeAs = (session: ChatSession, id: EntityId) => {
  speakerChoice(session).set(id)
  document.getElementById("composer")?.focus({ preventScroll: true })
}
