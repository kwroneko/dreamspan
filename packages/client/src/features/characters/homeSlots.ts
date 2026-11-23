import type { CardBrowse } from "./cardBrowse.tsx"
import { defineSlot } from "../../slots.tsx"
import type { ShellLibrary } from "./shellData.tsx"
import type { EntityId } from "@dreamspan/shared/chat.ts"

/** Above the home screen's characters: getting started, announcements. */
export const homeIntro = defineSlot<{ data: ShellLibrary }>("home.intro")

/**
 * The left panel's foot, below its list of chats (owner, 2026-11-01): the open chat's branches
 * (`OpenChatBranches`), registered by the characters feature as a plugin would register a part.
 */
export const sidebarFoot = defineSlot<Record<string, never>>("sidebar.foot")

/** Actions above a single character's chats, outside group and branch scopes. */
export const characterChatActions = defineSlot<{ entityId: EntityId; label: string }>("sidebar.character-chat-actions")

/**
 * Actions for the explicit Archived view, shared by Home and the sidebar. `place` names the host
 * ("home", "sidebar"): both can show at once, so what one opens must not open in the other too.
 */
export const archivedCardActions = defineSlot<{ place: string }>("cards.archived-actions")

/** Results offered after an ordinary local card search. */
export const cardSearchExtras = defineSlot<{
  data: ShellLibrary
  browse: CardBrowse
  search: string
  className: string
}>("cards.search-extras")
