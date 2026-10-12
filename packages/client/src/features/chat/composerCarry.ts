// Composer text carried into a chat that's just been made (StartChatPage → ChatPage): what
// was typed while the first send was on its way is in the new chat's composer, not lost
// with the page it was typed on.
const carried = new Map<string, string>()

/** Leaves `text` for the composer of `chatId`, which takes it when it mounts. */
export const carryComposerText = (chatId: string, text: string) => {
  if (text !== "") carried.set(chatId, text)
}

/** The text left for `chatId`'s composer; reading twice (React's strict mode) gets the same. */
export const carriedComposerText = (chatId: string) => carried.get(chatId) ?? ""

/** Once the composer has it, it's no longer carried. */
export const dropCarriedComposerText = (chatId: string) => {
  carried.delete(chatId)
}
