import type { ChatId } from "@rp/shared/chat.ts"
import type { SplitChatLink } from "@rp/shared/splitChat.ts"
import { Link, useParams, useSearch } from "@tanstack/react-router"
import { useState } from "react"
import { Icon } from "../../ui/Icon.tsx"
import { ResizeHandle } from "../../ui/ResizeHandle.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { ForkRow } from "../characters/ShellBrowser.tsx"
import { useBranchHeight } from "../characters/useBranchHeight.tsx"
import { sidebarCleared, useShellForks, useShellNavigation } from "../characters/shellData.tsx"
import { useSplitChats } from "./splitChats.ts"
import { requestSplitReveal } from "./splitReveal.ts"

export function SplitLink({
  group,
  children,
  hint
}: {
  group: SplitChatLink
  children: React.ReactNode
  hint: string
}) {
  const navigation = useShellNavigation()
  return (
    <Tooltip label={hint}>
      <Link
        to="/chats/$chatId"
        params={{ chatId: group.chatId }}
        search={{ ...sidebarCleared, fork: group.forkId }}
        onClick={() => {
          requestSplitReveal(group.id)
          navigation.picked()
        }}
        className="min-w-0 truncate rounded text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
      >
        {children}
      </Link>
    </Tooltip>
  )
}

export function SplitChatSection() {
  const params = useParams({ strict: false }) as { chatId?: string }
  const shown = useSearch({ strict: false, select: (s: { fork?: string }) => s.fork })
  const nextSplit = useSplitChats((params.chatId ?? null) as ChatId | null, shown)
  const forks = useShellForks({
    entity: null,
    chat: null,
    chats: nextSplit?.children.map((c) => c.id) ?? [],
    search: "",
    sort: "recent",
    sections: [{ id: "chats", limit: 5000 }]
  })
  const nextRows = forks.section("chats").rows
  const [last, setLast] = useState<{ split: typeof nextSplit; rows: typeof nextRows } | null>(null)
  const ready = nextSplit !== null && !forks.loading
  if (ready && (last?.split !== nextSplit || last?.rows !== nextRows)) setLast({ split: nextSplit, rows: nextRows })
  const split = ready ? nextSplit : last?.split
  const rows = ready ? nextRows : (last?.rows ?? [])
  const visible = params.chatId !== undefined && !!split && (split.parent !== null || split.children.length > 0)
  const { height, min, max, change, reset, collapsed, expanded, toggle } = useBranchHeight("split")
  const open = expanded && !collapsed && rows.length > 0
  if (!visible || !split) return null
  return (
    <section
      inert={!ready}
      aria-busy={!ready}
      aria-label="Split chats"
      data-foot-section="split"
      data-foot-wanted={expanded && rows.length > 0}
      style={open ? { height } : undefined}
      className={`relative flex min-h-0 shrink-0 flex-col border-t border-border pt-2 ${open ? "gap-1" : ""}`}
    >
      {open && (
        <div className="absolute inset-x-0 top-0">
          <ResizeHandle
            label="Resize split chats"
            axis="y"
            direction={-1}
            width={height}
            min={min}
            max={max}
            onChange={change}
            onReset={reset}
            hint="Drag to resize the split chat list, or use the arrow keys. Double-click resets."
          />
        </div>
      )}
      <div
        data-foot-header
        className="flex h-8 max-w-controls min-w-0 shrink-0 items-center gap-2 px-2 text-xs font-semibold"
      >
        {split.children.length > 0 && (
          <Tooltip
            label={
              expanded && collapsed
                ? "More height is needed to show a complete split chat row."
                : open
                  ? "Click to hide split chats."
                  : "Click to show split chats."
            }
          >
            <button
              type="button"
              aria-expanded={open}
              disabled={expanded && collapsed}
              onClick={toggle}
              className="flex shrink-0 items-center gap-1 rounded px-1 py-1 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Icon name={open ? "down" : "right"} size={14} />
              Split off ({split.children.length})
            </button>
          </Tooltip>
        )}
        {split.parent && (
          <SplitLink group={split.parent} hint={`Opens ${split.parent.title}, the chat this branch came from.`}>
            From “{split.parent.title}”
          </SplitLink>
        )}
      </div>
      {rows.length > 0 && (
        <div
          data-foot-body
          inert={!open}
          aria-hidden={!open}
          style={open ? undefined : { height: 0, maxHeight: 0, visibility: "hidden" }}
          className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 [scrollbar-gutter:stable]"
        >
          {rows.map((fork) => (
            <ForkRow key={fork.chat.id} fork={fork} splitNavigation />
          ))}
        </div>
      )}
    </section>
  )
}
