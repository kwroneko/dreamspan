// Who the user plays when a new chat starts (DESIGN §2.2). A persona locked to the character
// (owner, 2026-11-18: "an explicit lock per-character") starts that character's new single
// chats; otherwise, and in every group chat, the account default does. Either only while its
// card is still a live persona. Started chats never change (owner, 2026-11-03).
export interface StartingPersona<Id> {
  /** One character's chat: the lock applies. A group's, or one with no character: never. */
  readonly single: boolean
  /** The persona locked to that character, if any. */
  readonly lock: Id | null
  /** The account default persona, if any. */
  readonly defaultPersona: Id | null
  /** A card that can still be played: live, unarchived and in the persona folder. */
  readonly live: (id: Id) => boolean
}

export const startingPersona = <Id>({ single, lock, defaultPersona, live }: StartingPersona<Id>): Id | null => {
  if (single && lock !== null && live(lock)) return lock
  return defaultPersona !== null && live(defaultPersona) ? defaultPersona : null
}
