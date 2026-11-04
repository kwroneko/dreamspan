import { defineSlot } from "../../slots.tsx"
import type { ShellLibrary } from "./shellData.tsx"
import type { EntityId } from "@rp/shared/chat.ts"

/** Above the home screen's characters: getting started, announcements. */
export const homeIntro = defineSlot<{ data: ShellLibrary }>("home.intro")

/**
 * The left panel's foot, below its list of chats (owner, 2026-11-01): the open chat's branches
 * (`OpenChatBranches`), registered by the characters feature as a plugin would register a part.
 */
export const sidebarFoot = defineSlot<Record<string, never>>("sidebar.foot")

/** Actions above a single character's chats, outside group and branch scopes. */
export const characterChatActions = defineSlot<{ entityId: EntityId; label: string }>("sidebar.character-chat-actions")
