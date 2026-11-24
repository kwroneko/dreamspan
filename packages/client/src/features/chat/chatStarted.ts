// A new chat's page shows a pending chat (DraftChatPage.tsx): the server refuses what needs a
// started chat on it (branches, pins, the bin, threads, merges, summaries, export). Those
// controls stay where they are, disabled, saying why (owner: no layout shifts, no buttons that
// disappear), until its first turn starts it.
import type { Chat } from "@dreamspan/shared/chat.ts"
import type { DraftFor } from "@dreamspan/shared/draftChatApi.ts"

/** Why a control that needs a started chat can't be used on a pending one. */
export const NOT_STARTED = "Available once the chat is started: send a message first."

/** A new chat's, not started yet: nothing lists it, and it refuses what needs a started chat. */
export const isPendingChat = (chat: Pick<Chat, "status"> | null | undefined) => chat?.status === "pending"

/** `NOT_STARTED` on a pending chat, else null: a control's disabled reason. */
export const notStarted = (chat: Pick<Chat, "status"> | null | undefined) => (isPendingChat(chat) ? NOT_STARTED : null)

/** The entry each pending chat opened in this tab is for (DraftChatPage.tsx): a group's or not. */
const draftEntries = new Map<string, DraftFor>()
export const rememberDraftFor = (chatId: string, draftFor: DraftFor) => void draftEntries.set(chatId, draftFor)
/** The entry a pending chat opened in this tab is for, if it was opened here. */
export const draftEntryOf = (chatId: string) => draftEntries.get(chatId) ?? null
/** A group's new chat: its persona pickers have no persona lock, which is a single chat's. */
export const isGroupDraft = (chatId: string) => draftEntries.get(chatId)?.startsWith("group:") ?? false
