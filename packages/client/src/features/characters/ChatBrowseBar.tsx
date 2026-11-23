import type { ReactNode } from "react"
import { CHAT_FILTERS, CHAT_SORTS, type ChatBrowse, type ChatFilterCounts } from "@dreamspan/shared/chatBrowse.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuCheckboxItem } from "../../ui/Menu.tsx"
import { Select } from "../../ui/Select.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { defineSlot } from "../../slots.tsx"
import { SortDirection } from "./cardBrowse.tsx"

const FILTERS = {
  all: { label: "All", hint: "Shows all chats" },
  pinned: { label: "Pinned", hint: "Shows pinned chats" },
  groups: { label: "Group chats", hint: "Shows chats with two or more characters in the cast" },
  solo: { label: "One-on-one", hint: "Shows chats with one character in the cast" },
  branches: { label: "With branches", hint: "Shows chats with more than one branch" },
  workshops: {
    label: "Workshops",
    hint: "Shows only workshops. The other choices leave them out; All shows everything"
  }
} as const
const SORTS = {
  recent: { label: "Recent", hint: "Orders chats by their latest activity" },
  started: { label: "Started", hint: "Orders chats by when they started" },
  name: { label: "Name", hint: "Orders chats by name" },
  messages: { label: "Messages", hint: "Orders chats by the message count on their current branch" },
  branches: { label: "Branches", hint: "Orders chats by their number of branches" }
} as const
interface Props {
  browse: ChatBrowse
  counts: ChatFilterCounts | null
  onChange: (change: Partial<ChatBrowse>) => void
  /** In place of the chats' sort: the message search's, while the search looks through messages. */
  sort?: ReactNode
}
/** Replaceable Chats tab browse row, registered by the characters feature. */
export const sidebarChatBrowse = defineSlot<Props>("sidebar.chat-browse")
export function ChatBrowseBar({ browse, counts, onChange, sort }: Props) {
  return (
    <div
      aria-label="Chat filters and sorting"
      className="@container/chat-browse flex max-w-controls min-w-0 shrink-0 flex-wrap items-center gap-1"
    >
      <div className="min-w-max flex-1">
        <Tooltip label="Chooses which chats are shown">
          <span className="block">
            <Select
              ariaLabel="Show chats"
              className="h-8! min-w-max!"
              shown={(filter) => (
                <>
                  {FILTERS[filter].label}
                  <span className="chat-filter-count"> · {counts?.[filter].toLocaleString() ?? "…"}</span>
                </>
              )}
              value={browse.filter}
              onValueChange={(filter) => onChange({ filter })}
              items={CHAT_FILTERS.map((filter) => ({
                value: filter,
                label: `${FILTERS[filter].label} · ${counts?.[filter].toLocaleString() ?? "…"}`,
                description: FILTERS[filter].hint
              }))}
            />
          </span>
        </Tooltip>
      </div>
      {sort ?? (
        <SortControl
          noun="chats"
          sorts={SORTS}
          order={CHAT_SORTS}
          value={browse.sort}
          onChange={(sort) => onChange({ sort })}
        >
          <SortDirection
            order={
              browse.sort === "name"
                ? "name"
                : browse.sort === "messages" || browse.sort === "branches"
                  ? "count"
                  : "date"
            }
            reversed={browse.reversed}
            onToggle={() => onChange({ reversed: !browse.reversed })}
          />
        </SortControl>
      )}
    </div>
  )
}

/** A list's sort: the column picked from a menu, and its direction beside it (`children`). */
export function SortControl<S extends string>({
  noun,
  sorts,
  order,
  value,
  onChange,
  children
}: {
  /** What's sorted, as its labels say: "chats", "messages". */
  noun: string
  sorts: Record<S, { readonly label: string; readonly hint: string }>
  order: ReadonlyArray<S>
  value: S
  onChange: (sort: S) => void
  children: ReactNode
}) {
  return (
    <div data-chat-sort className="ms-auto flex shrink-0 items-center gap-1">
      <Menu
        label={`Sort ${noun}`}
        hint={`Chooses how ${noun} are ordered`}
        align="start"
        trigger={
          <Button
            hint={`Chooses how ${noun} are sorted.`}
            variant="ghost"
            className="h-8 gap-1 px-2"
            aria-label={`Sort ${noun}: ${sorts[value].label}`}
          >
            {sorts[value].label}
            <Icon name="down" />
          </Button>
        }
      >
        {order.map((sort) => (
          <MenuCheckboxItem
            key={sort}
            checked={sort === value}
            onCheckedChange={() => onChange(sort)}
            description={sorts[sort].hint}
          >
            {sorts[sort].label}
          </MenuCheckboxItem>
        ))}
      </Menu>
      {children}
    </div>
  )
}
