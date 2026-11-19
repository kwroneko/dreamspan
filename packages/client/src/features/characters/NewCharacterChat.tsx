import type { EntityId } from "@dreamspan/shared/chat.ts"
import { useNavigate } from "@tanstack/react-router"
import { Icon } from "../../ui/Icon.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { sidebarCleared, useShellNavigation } from "./shellData.tsx"

export function NewCharacterChat({ entityId, label }: { entityId: EntityId; label: string }) {
  const navigate = useNavigate()
  const { picked } = useShellNavigation()
  return (
    <Tooltip label={`Starts a separate chat with ${label}.`}>
      <button
        type="button"
        className="mt-2 flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-surface px-3 py-3 text-left text-sm font-medium text-accent outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
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
        <span className="min-w-0 [overflow-wrap:anywhere]">New chat with {label}</span>
      </button>
    </Tooltip>
  )
}
