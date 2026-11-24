import type { EntityId } from "@dreamspan/shared/chat.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { linkMenuProps } from "../../ui/linkMenuState.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { sidebarCleared, useShellNavigation } from "./shellData.tsx"

/** The Chats tab's start rows: one line of text-sm, so a row is as tall in every scope. */
const startClass =
  "flex min-w-0 items-center rounded-md border border-border bg-surface py-3 text-sm font-medium text-accent outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"

/**
 * "New Roleplay with <name>" above a character's chats (owner, 2026-11-24). Where the name doesn't
 * fit beside it, it wraps onto a clipped second line, leaving "New Roleplay"; the hover names them.
 */
export function NewCharacterChat({ entityId, label }: { entityId: EntityId; label: string }) {
  const navigate = useNavigate()
  const { picked } = useShellNavigation()
  return (
    <Tooltip label={`Start a new roleplay with ${label}.`}>
      <button
        type="button"
        className={`mt-2 w-full gap-2 px-3 text-left ${startClass}`}
        onClick={() => {
          picked()
          void navigate({
            to: "/cards/$entityId/chat",
            params: { entityId },
            search: { ...sidebarCleared, character: entityId, panel: `card:${entityId}` }
          })
        }}
      >
        <Icon name="plus" size={16} className="shrink-0" />
        <span className="flex h-5 min-w-0 flex-wrap gap-x-[0.25em] overflow-hidden">
          <span className="whitespace-nowrap">New Roleplay</span>
          <span data-start-name className="min-w-0 truncate">
            with {label}
          </span>
        </span>
      </button>
    </Tooltip>
  )
}

/**
 * One of the start buttons above All chats (`sidebarChatStarts`): a link to a chat not made yet,
 * with the app's open menu, sharing the row with the others.
 */
export function SidebarStartLink({
  to,
  icon,
  label,
  hint
}: {
  to: "/new/chat" | "/new/workshop"
  icon: IconName
  label: string
  hint: string
}) {
  const { picked } = useShellNavigation()
  return (
    <Tooltip label={hint}>
      <Link
        to={to}
        {...linkMenuProps}
        onClick={() => picked()}
        // Two share the default sidebar's row: a little tighter than the row they stand in for.
        className={`min-w-max flex-[1_1_0] justify-center gap-1.5 px-2 ${startClass}`}
      >
        <Icon name={icon} size={16} className="shrink-0" />
        <span className="whitespace-nowrap">{label}</span>
      </Link>
    </Tooltip>
  )
}

/** "New Roleplay": the chat with nobody in it yet (`/new/chat`). */
export function NewRoleplayStart() {
  return (
    <SidebarStartLink
      to="/new/chat"
      icon="plus"
      label="New Roleplay"
      hint="Start a new roleplay chat. Add characters from the Cast tab, or send with nobody in it."
    />
  )
}
