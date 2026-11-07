// The side panel once its chat is closed and no other chat is open (owner, 2026-11-07: "I
// don't want unexpected layout shifts just because chats close"): the same place and width,
// saying what shows there, until a chat opens again or the user hides it.
import { useSession } from "../../session.ts"
import { EmptyState } from "../../ui/Surface.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { rememberPanel } from "./ChatPanels.tsx"

export function PanelPlaceholder({ width, onHide }: { width: number; onHide: () => void }) {
  const userId = useSession().user.id
  return (
    <aside
      aria-label="Chat panel"
      data-panel-placeholder
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-border bg-surface"
    >
      <div className="flex h-shell-header shrink-0 items-center justify-end border-b border-border px-2">
        <IconButton
          label="Hide panel"
          icon="close"
          hint="Hide the chat panel. It shows again when you open it from a chat."
          onClick={() => {
            rememberPanel(userId, null)
            onHide()
          }}
        />
      </div>
      <div className="p-4">
        <EmptyState title="Open a chat to see its settings here." />
      </div>
    </aside>
  )
}
