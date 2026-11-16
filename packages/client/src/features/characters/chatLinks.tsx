// Entry points share the sidebar's existing URL scope; they never open another chat.
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { useSyncExternalStore } from "react"
import { useSession } from "../../session.ts"
import { MenuItem } from "../../ui/Menu.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { CardSurfaceContext } from "../cardForks/surfaces.tsx"
import { useWide } from "../chat/ChatPanels.tsx"
import type { ChatSession } from "../chat/session.ts"
import { showAppNavigation } from "../shell.tsx"
import { useShellForks, sidebarCleared } from "./shellData.tsx"

const hint = (name: string) => `Shows every chat with ${name} in the left column.`

function useCardChats(entityId: EntityId) {
  const navigate = useNavigate()
  const userId = useSession().user.id
  const wide = useWide()
  const search = (prev: Record<string, unknown>) => ({
    ...prev,
    ...sidebarCleared,
    character: entityId,
    sideQ: undefined,
    ...(!wide ? { panel: undefined, editor: undefined } : {})
  })
  const open = () =>
    void navigate({
      to: ".",
      search,
      state: (prev) => ({ ...prev, ...(!wide ? { chatPanel: true } : {}) }),
      resetScroll: false
    }).then(() => showAppNavigation(userId))
  return { search, open }
}

/** Registered on every card header; the count is over chats, independent of the viewed branch. */
export function CardChatsLink({ entityId, label }: CardSurfaceContext) {
  const { search, open } = useCardChats(entityId)
  // The card list's total deduplicates chats and includes recorded participation on any
  // branch, without transferring its rows; ShellCard.card.chats (the tiles) counts the same.
  const count = useShellForks({
    entity: entityId,
    chat: null,
    search: "",
    sort: "recent",
    sections: [{ id: "card", limit: 0 }]
  }).section("card").total
  if (count === 0) return null
  return (
    <Tooltip label={hint(label ?? "this card")}>
      <Link
        to="."
        search={search}
        className="w-fit rounded text-xs leading-4 text-muted tabular-nums outline-none hover:text-text hover:underline focus-visible:ring-2 focus-visible:ring-focus"
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          event.preventDefault()
          open()
        }}
      >
        {count.toLocaleString()} {count === 1 ? "chat" : "chats"}
      </Link>
    </Tooltip>
  )
}

/** The wording follows who the user plays in this chat, independent of the persona folder. */
export function CastChatsLink({ session, card }: { session: ChatSession; card: CastCard }) {
  const persona = useSyncExternalStore(session.subscribe, () =>
    session.snapshot().cast?.playedByMe.includes(card.entityId)
  )
  const { open } = useCardChats(card.entityId)
  return (
    <MenuItem description={hint(card.name)} onClick={open}>
      Chats {persona ? "as" : "with"} {card.name}
    </MenuItem>
  )
}
