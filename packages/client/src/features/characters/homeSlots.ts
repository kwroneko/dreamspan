import type { CardBrowse } from "./cardBrowse.tsx"
import { defineSlot } from "../../slots.tsx"
import type { ShellLibrary } from "./shellData.tsx"
import type { EntityId } from "@dreamspan/shared/chat.ts"

/** Above the home screen's characters: getting started, announcements. */
export const homeIntro = defineSlot<{ data: ShellLibrary }>("home.intro")

/**
 * The Characters page's header, just after its title (owner, 2026-11-24: "anchored to
 * 'characters'"): the editor feature's New card, so a card is made from Home without a visit to
 * the library.
 */
export const homeHeaderTitleActions = defineSlot<Record<string, never>>("home.header-title-actions")

/** The Characters page's header, right-aligned before its end controls. Nothing registers here. */
export const homeHeaderActions = defineSlot<Record<string, never>>("home.header-actions")

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
