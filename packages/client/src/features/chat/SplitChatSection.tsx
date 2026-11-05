import type { ChatId, ForkSplit } from "@rp/shared/chat.ts"
import type { SplitChatLink } from "@rp/shared/splitChat.ts"
import { Link, useParams, useSearch } from "@tanstack/react-router"
import { useState } from "react"
import { AboutHint } from "../../ui/AboutHint.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { ResizeHandle } from "../../ui/ResizeHandle.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { ForkRow } from "../characters/ShellBrowser.tsx"
import { useBranchHeight } from "../characters/useBranchHeight.tsx"
import { sidebarCleared, useShellForks, useShellNavigation } from "../characters/shellData.tsx"
import { formatMoment } from "./forks.ts"
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

/** ["Shares messages #1–14", "split 4 Nov, 19:13"]: what a related chat has in common with this one. */
export const splitRelation = (split: ForkSplit | null | undefined, now = Date.now()) => {
  if (!split) return null
  const shared =
    split.after === 0
      ? "Shares no messages"
      : split.after === 1
        ? "Shares message #1"
        : `Shares messages #1–${split.after}`
  return [shared, `split ${formatMoment(split.at, now)}`] as const
}

/**
 * Related chats (splitsection, 2026-11-05): the chat this one was split from and the chats split
 * off from it, each under its own caption, as ordinary chat rows with a line saying what they share.
 */
export function SplitChatSection() {
  const params = useParams({ strict: false }) as { chatId?: string }
  const shown = useSearch({ strict: false, select: (s: { fork?: string }) => s.fork })
  const nextSplit = useSplitChats((params.chatId ?? null) as ChatId | null, shown)
  const forks = useShellForks({
    entity: null,
    chat: null,
    chats: nextSplit
      ? [...(nextSplit.parent ? [nextSplit.parent.id] : []), ...nextSplit.children.map((c) => c.id)]
      : [],
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
  const parentRow = split?.parent ? rows.find((r) => r.chat.id === split.parent!.id) : undefined
  const childRows = split ? rows.filter((r) => split.children.some((c) => c.id === r.chat.id)) : []
  const count = (parentRow ? 1 : 0) + childRows.length
  const visible = params.chatId !== undefined && !!split && (split.parent !== null || split.children.length > 0)
  const { height, min, max, change, reset, collapsed, expanded, toggle } = useBranchHeight("split")
  const open = expanded && !collapsed && count > 0
  if (!visible || !split) return null
  const caption = "px-1 pt-1 text-xs font-semibold text-muted"
  return (
    <section
      inert={!ready}
      aria-busy={!ready}
      aria-label="Related chats"
      data-foot-section="split"
      data-foot-list={count > 0}
      data-foot-wanted={expanded && count > 0}
      style={open ? { maxHeight: height } : undefined}
      className={`relative flex min-h-0 shrink-0 flex-col border-t border-border pt-2 ${open ? "gap-1" : ""}`}
    >
      {open && (
        <div className="absolute inset-x-0 top-0">
          <ResizeHandle
            label="Resize related chats"
            axis="y"
            direction={-1}
            width={height}
            min={min}
            max={max}
            onChange={change}
            onReset={reset}
            hint="Drag to resize the related chats list, or use the arrow keys. Double-click resets."
          />
        </div>
      )}
      <div
        data-foot-header
        className="flex h-8 max-w-controls min-w-0 shrink-0 items-center gap-1 px-2 text-xs font-semibold"
      >
        <Tooltip label={open ? "Click to hide related chats." : "Click to show related chats."}>
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className="flex shrink-0 items-center gap-1 rounded px-1 py-1 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name={open ? "down" : "right"} size={14} />
            Related chats ({count})
          </button>
        </Tooltip>
        <AboutHint heading="Related chats">
          Chats that share their beginning with this one, because a branch was made into its own chat.
        </AboutHint>
      </div>
      {count > 0 && (
        <div
          data-foot-body
          inert={!open}
          aria-hidden={!open}
          style={open ? undefined : { height: 0, maxHeight: 0, visibility: "hidden" }}
          className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 [scrollbar-gutter:stable]"
        >
          {parentRow && (
            <div role="group" aria-label="This chat was split from" className="flex flex-col gap-1">
              <p data-related-caption className={caption}>
                This chat was split from
              </p>
              <ForkRow fork={parentRow} splitNavigation relation={splitRelation(split.group.split)} />
            </div>
          )}
          {childRows.length > 0 && (
            <div role="group" aria-label="Split off from this chat" className="flex flex-col gap-1">
              <p data-related-caption className={caption}>
                Split off from this chat
              </p>
              {childRows.map((fork) => (
                <ForkRow
                  key={fork.chat.id}
                  fork={fork}
                  splitNavigation
                  relation={splitRelation(split.children.find((c) => c.id === fork.chat.id)?.split ?? null)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
