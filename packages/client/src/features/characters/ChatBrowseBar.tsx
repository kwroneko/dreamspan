import { CHAT_FILTERS, CHAT_SORTS, type ChatBrowse, type ChatFilterCounts } from "@rp/shared/chatBrowse.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Menu, MenuCheckboxItem } from "../../ui/Menu.tsx"
import { Select } from "../../ui/Select.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { defineSlot } from "../../slots.tsx"
import { SortDirection } from "./cardBrowse.tsx"

const FILTERS = {
  all: { label: "All", hint: "Shows all chats" },
  pinned: { label: "Pinned", hint: "Shows chats with a pinned branch" },
  groups: { label: "Group chats", hint: "Shows chats with two or more characters in the cast" },
  solo: { label: "One-on-one", hint: "Shows chats with one character in the cast" },
  branches: { label: "With branches", hint: "Shows chats with more than one branch" }
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
}
/** Replaceable Chats tab browse row, registered by the characters feature. */
export const sidebarChatBrowse = defineSlot<Props>("sidebar.chat-browse")
export function ChatBrowseBar({ browse, counts, onChange }: Props) {
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
      <div data-chat-sort className="ms-auto flex shrink-0 items-center gap-1">
        <Menu
          label="Sort chats"
          hint="Chooses how chats are ordered"
          align="start"
          trigger={
            <Button
              hint="Chooses how chats are sorted."
              variant="ghost"
              className="h-8 gap-1 px-2"
              aria-label={`Sort chats: ${SORTS[browse.sort].label}`}
            >
              {SORTS[browse.sort].label}
              <Icon name="down" />
            </Button>
          }
        >
          {CHAT_SORTS.map((sort) => (
            <MenuCheckboxItem
              key={sort}
              checked={sort === browse.sort}
              onCheckedChange={() => onChange({ sort })}
              description={SORTS[sort].hint}
            >
              {SORTS[sort].label}
            </MenuCheckboxItem>
          ))}
        </Menu>
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
      </div>
    </div>
  )
}
