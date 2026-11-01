import { chatName, formatDay } from "../chat/chatTitle.ts"
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { useAtomRefresh } from "@effect/atom-react"
import type { ShellSection } from "@rp/shared/chatSetupApi.ts"
import { useState } from "react"
import { AsyncView, ErrorAlert, FailureView, useAction } from "../../actions.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { useSession } from "../../session.ts"
import { rememberedPanel } from "../chat/ChatPanels.tsx"
import { useWide } from "../chat/ChatPanels.tsx"
import { Button } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { browseCards, useCardBrowse } from "./cardBrowse.tsx"
import { CardBrowseBar } from "./CardBrowseBar.tsx"
import { GroupGrid } from "./GroupGrid.tsx"
import { GroupFaces } from "./GroupFaces.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import {
  CharacterGrid,
  PAGE_ROWS,
  scopeSearch,
  shellAtom,
  sidebarCleared,
  useShellForks,
  useShellNavigation,
  type ShellFork,
  type ShellLibrary
} from "./shellData.tsx"

export function PinButton({ fork }: { fork: ShellFork }) {
  const action = useAction()
  return (
    <span className="shrink-0">
      {/* A pin, filled when pinned: the star is a favourite character's (cardBrowse.tsx). */}
      <IconButton
        label={`${fork.pinned ? "Unpin" : "Pin"} ${fork.name}`}
        icon="pin"
        filled={fork.pinned}
        aria-pressed={fork.pinned}
        hint={fork.pinned ? "Takes it out of Pinned chats." : "Keeps this branch in Pinned chats, above the rest."}
        disabled={action.pending}
        className={fork.pinned ? "text-text!" : ""}
        onClick={() =>
          void action.run(
            (client) =>
              client("SetChatPin", {
                chatId: fork.chat.id,
                leaf: fork.leaf,
                forkId: fork.forkId,
                pinned: !fork.pinned
              }),
            ["pins"]
          )
        }
      />
      <ErrorAlert error={action.error} />
    </span>
  )
}

/**
 * Opens a fork in the middle. A pick in the left panel keeps the panel where it is (its scope
 * travels in the URL); `scopeChat` scopes it to the fork's chat, as a group tile does.
 */
function useOpenFork(fork: ShellFork, scopeChat: boolean) {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { panel?: string }
  const navigation = useShellNavigation()
  const userId = useSession().user.id
  const wide = useWide()
  const open = () => {
    navigation.picked()
    // A list changes only the middle. Keep a character tab while that character is in the
    // chat, played by the model or by the user; else This chat.
    const previous = search.panel ?? (wide ? rememberedPanel(userId) : null)
    const id = previous?.startsWith("card:") ? (previous.slice(5) as EntityId) : null
    const panel = id !== null && (!fork.joined.includes(id) || fork.departed.includes(id)) ? "chat" : previous
    void navigate({
      to: "/chats/$chatId",
      params: { chatId: fork.chat.id },
      search: {
        ...sidebarCleared,
        ...scopeSearch(scopeChat ? { entity: null, chat: fork.chat.id } : navigation.scope),
        ...(navigation.grid && !scopeChat ? { side: "characters" } : {}),
        fork: fork.forkId,
        ...(fork.leaf ? { leaf: fork.leaf } : {}),
        ...(panel ? { panel } : {})
      }
    })
  }
  return open
}
export function GroupTile({ fork }: { fork: ShellFork }) {
  const open = useOpenFork(fork, true)
  return (
    <div className="relative flex flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={open}
        aria-label={`Open chat ${fork.chatName}`}
        className="flex w-full flex-1 flex-col text-left"
      >
        <span className="aspect-[2/3] w-full">
          <GroupFaces members={fork.cast} />
        </span>
        <span className="flex w-full min-w-0 flex-1 flex-col gap-1 p-2.5">
          <span className="text-sm font-medium [overflow-wrap:anywhere]">{fork.chatName}</span>
          {/* The faces show who; the names with their versions are in the tooltip. */}
          <span
            className="text-xs text-muted"
            title={fork.cast.map((c) => `${c.label}${c.subtitle ? ` · ${c.subtitle}` : ""}`).join(", ")}
          >
            {fork.cast.length} {fork.cast.length === 1 ? "member" : "members"}
          </span>
          {fork.branches > 1 && <span className="mt-auto text-xs text-muted">{fork.branches} branches</span>}
        </span>
      </button>
      <span className="absolute right-1 top-1 rounded bg-surface">
        <PinButton fork={fork} />
      </span>
    </div>
  )
}
export function ForkRow({
  fork,
  scopeChat = false,
  details = false,
  here = false,
  perFork = false
}: {
  fork: ShellFork
  scopeChat?: boolean
  details?: boolean
  /** The row is this fork (a chat's branches, pins), not its chat (a list of chats). */
  perFork?: boolean
  /** The fork open in the middle: marked, so the list says where you are. */
  here?: boolean
}) {
  const open = useOpenFork(fork, scopeChat)
  // A row for a chat shows its name; one for a fork, the branch's name after it.
  const title = perFork && fork.named ? `${fork.chatName} › ${fork.name}` : fork.chatName
  return (
    <div
      className={`flex min-w-0 items-center gap-1 rounded-md border p-1 hover:bg-surface-raised ${here ? "border-accent bg-surface-raised" : "border-border"}`}
    >
      <button
        type="button"
        onClick={open}
        aria-label={`Open chat ${title}`}
        aria-current={here ? "page" : undefined}
        data-chat-id={fork.chat.id}
        className="flex min-w-0 flex-1 items-center gap-2 p-1 text-left"
      >
        <span className="flex shrink-0 gap-0.5">
          {fork.cast.slice(0, 2).map((c) => (
            <Avatar key={c.entityId} id={c.entityId} name={c.name} mediaId={c.avatarMediaId} size="md" />
          ))}
        </span>
        <span className="flex min-w-0 flex-col">
          {/* Two lines: beside the portraits one line leaves imported names unrecognizable. */}
          <span className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]" title={title}>
            {title}
          </span>
          {details && fork.cast.length > 1 && (
            <span className="line-clamp-2 text-xs text-muted [overflow-wrap:anywhere]">
              with {fork.cast.map((c) => c.label).join(", ")}
            </span>
          )}
          {details && (
            <span data-chat-meta className="text-xs text-muted [overflow-wrap:anywhere]">
              started{" "}
              {formatDay(chatName(importState(fork.chat.title).title, fork.cast).started ?? new Date(fork.createdAt))} ·{" "}
              {fork.messages} messages
            </span>
          )}
          {fork.preview && (
            <span className="line-clamp-2 text-xs text-muted [overflow-wrap:anywhere]">{fork.preview}</span>
          )}
          <span className="text-xs text-muted">
            {perFork
              ? fork.current && fork.branches > 1
                ? "Latest branch · "
                : ""
              : fork.branches > 1
                ? `${fork.branches} branches · `
                : ""}
            {new Date(perFork ? fork.recentAt : fork.chatRecentAt).toLocaleDateString()}
          </span>
        </span>
      </button>
      <PinButton fork={fork} />
    </div>
  )
}

type ShellSort = "recent" | "created" | "name"
function SortSwitch({
  value,
  onChange,
  label = "Sort by"
}: {
  value: ShellSort
  onChange: (sort: ShellSort) => void
  label?: string
}) {
  return (
    <Segmented
      label={label}
      value={value}
      onValueChange={onChange}
      options={[
        { value: "recent", label: "Recent", description: "Latest activity first." },
        { value: "created", label: "Created", description: "Newest first." },
        { value: "name", label: "Name" }
      ]}
    />
  )
}
/** "Show N more of M", for a list read a page at a time. */
export function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  const rest = total - shown
  if (rest <= 0) return null
  return (
    <button type="button" onClick={onMore} className="mt-1 self-start px-2 py-1 text-xs text-accent">
      Show {Math.min(rest, PAGE_ROWS).toLocaleString()} more of {rest.toLocaleString()}
    </button>
  )
}

/** A read's failure in a list, with a retry. */
function ListFailure({ forks }: { forks: ReturnType<typeof useShellForks> }) {
  const refresh = useAtomRefresh(forks.atom)
  return forks.failure ? (
    <FailureView cause={forks.failure.cause} onRetry={refresh} still="Still loading your chats…" />
  ) : null
}

export function PinnedChats({
  pinsCollapsed,
  entity = null,
  chat = null,
  home = false
}: {
  pinsCollapsed: boolean
  entity?: EntityId | null
  chat?: ChatId | null
  home?: boolean
}) {
  const [sort, setSort] = useState<ShellSort>("recent")
  const [limit, setLimit] = useState(PAGE_ROWS)
  const action = useAction()
  const open = !home || !pinsCollapsed
  const forks = useShellForks({ entity, chat, search: "", sort, sections: [{ id: "pinned", limit }] })
  const pins = forks.section("pinned")
  if (!pins.total) return null
  return (
    <section aria-label="Pinned chats" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghost"
          aria-expanded={open}
          onClick={() =>
            home && void action.run((c) => c("SetHomePinsCollapsed", { collapsed: !pinsCollapsed }), ["pins"])
          }
        >
          {home ? (pinsCollapsed ? "▸ " : "▾ ") : ""}Pinned chats
        </Button>
        {open && <SortSwitch value={sort} onChange={setSort} label="Sort pinned chats" />}
      </div>
      {open && (
        <>
          {pins.rows.map((fork) => (
            <ForkRow key={`${fork.chat.id}/${fork.forkId}`} fork={fork} perFork />
          ))}
          <ShowMore shown={pins.rows.length} total={pins.total} onMore={() => setLimit((n) => n + PAGE_ROWS)} />
        </>
      )}
      <ErrorAlert error={action.error} />
    </section>
  )
}

/** The sections the left panel lists for each scope, under their headings. */
const SECTIONS = {
  all: [["chats", "Chats"]],
  character: [
    ["just", "Just"],
    ["with", "With others"],
    ["was", "Was in"]
  ],
  chat: [
    ["current", "Latest branch"],
    ["peers", "Named and pinned branches"],
    ["other", "Other branches"]
  ]
} as const satisfies Record<string, ReadonlyArray<readonly [ShellSection, string]>>

function Browser({ data }: { data: ShellLibrary }) {
  const { scope, setScope, grid, setGrid } = useShellNavigation()
  const [search, setSearch] = useState("")
  // The characters grid's own filter and sort, apart from the home page's (cardBrowse.tsx).
  const [browse, setBrowse] = useCardBrowse("sidebar")
  const params = useParams({ strict: false }) as { chatId?: string }
  const shown = (useSearch({ strict: false }) as { fork?: string }).fork
  const card = data.cards.find((c) => c.card.entityId === scope.entity)
  const cardLabel = card
    ? `${card.card.label}${card.card.subtitle ? ` · ${card.card.subtitle}` : ""}`
    : "Character not found"
  const needle = search.trim().toLowerCase()
  const kind = scope.chat ? "chat" : scope.entity ? "character" : "all"
  const sections = SECTIONS[kind]
  // Each list's length, by scope and search: another scope or search starts from its first page.
  const listKey = `${scope.entity}/${scope.chat}/${needle}`
  const [limits, setLimits] = useState<{ key: string; limits: Partial<Record<ShellSection, number>> }>({
    key: listKey,
    limits: {}
  })
  const limitOf = (id: ShellSection) => (limits.key === listKey ? (limits.limits[id] ?? PAGE_ROWS) : PAGE_ROWS)
  const more = (id: ShellSection) =>
    setLimits({
      key: listKey,
      limits: { ...(limits.key === listKey ? limits.limits : {}), [id]: limitOf(id) + PAGE_ROWS }
    })
  const forks = useShellForks({
    entity: scope.entity,
    chat: scope.chat as ChatId | null,
    search: needle,
    sort: "recent",
    sections: sections.map(([id]) => ({ id, limit: limitOf(id) }))
  })
  // A chat by its current fork's name; inside it, the fork shown in the middle when that's another.
  const chatRows = scope.chat ? sections.flatMap(([id]) => forks.section(id).rows) : []
  const chat = forks.section("current").rows[0] ?? chatRows[0]
  const open = params.chatId === scope.chat ? chatRows.find((f) => f.forkId === shown) : undefined
  const chatLabel = !chat
    ? forks.loading
      ? "…"
      : "Chat not found"
    : open && open.forkId !== chat.forkId && open.name !== chat.chatName
      ? `${chat.chatName} › ${open.name}`
      : chat.chatName
  const section = (id: ShellSection, title: string) => {
    const { rows, total } = forks.section(id)
    return (
      rows.length > 0 && (
        <section key={id} className="flex flex-col gap-1" aria-label={title}>
          <h3 className="mt-3 truncate text-xs font-semibold text-muted" title={title}>
            {title}
          </h3>
          {rows.map((f) => (
            <ForkRow
              key={`${f.chat.id}/${f.forkId}`}
              fork={f}
              perFork={kind === "chat"}
              here={f.chat.id === params.chatId && (kind !== "chat" || (shown ? f.forkId === shown : f.current))}
            />
          ))}
          <ShowMore shown={rows.length} total={total} onMore={() => more(id)} />
        </section>
      )
    )
  }
  const none = !forks.loading && sections.every(([id]) => forks.section(id).total === 0)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Segmented
        label="Left panel"
        value={grid ? "characters" : "chats"}
        onValueChange={(v) => setGrid(v === "characters")}
        options={[
          { value: "chats", label: "Chats" },
          { value: "characters", label: "Characters" }
        ]}
      />
      {!grid && (scope.entity || scope.chat) && (
        <nav aria-label="Chat breadcrumbs" className="flex min-w-0 items-center gap-1 text-sm">
          <button
            type="button"
            className="shrink-0 text-accent hover:underline"
            onClick={() => setScope({ entity: null, chat: null })}
          >
            All chats
          </button>
          {scope.entity && (
            <>
              <span aria-hidden className="shrink-0 text-muted">
                ›
              </span>
              {scope.chat ? (
                <button
                  type="button"
                  title={cardLabel}
                  className="min-w-0 truncate text-accent hover:underline"
                  onClick={() => setScope({ entity: scope.entity, chat: null })}
                >
                  {cardLabel}
                </button>
              ) : (
                <span aria-current="location" className="min-w-0 truncate font-medium" title={cardLabel}>
                  {cardLabel}
                </span>
              )}
            </>
          )}
          {scope.chat && (
            <>
              <span aria-hidden className="shrink-0 text-muted">
                ›
              </span>
              <span aria-current="location" className="min-w-0 truncate font-medium" title={chatLabel}>
                {chatLabel}
              </span>
            </>
          )}
        </nav>
      )}
      <Input
        aria-label={grid ? "Find a character" : "Find a chat"}
        placeholder="Find by name"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      {grid && <CardBrowseBar data={data} browse={browse} onChange={setBrowse} groups />}
      {/* The gutter is kept whether or not it scrolls, so the list never shifts, with a gap before the bar. */}
      <div className="@container -mr-1 min-h-0 flex-1 overflow-y-auto pr-1.5 [scrollbar-gutter:stable]">
        {grid ? (
          // Two tiles a row at the sidebar's usual width, more as it widens (8.5rem each at least).
          browse.filter === "groups" ? (
            <GroupGrid
              needle={needle}
              sort={browse.sort}
              reversed={browse.reversed}
              className="grid grid-cols-2 gap-2 @sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]"
            />
          ) : (
            <CharacterGrid
              cards={browseCards(data.cards, browse, needle)}
              sort={browse.sort}
              className="grid grid-cols-2 gap-2 @sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]"
            />
          )
        ) : (
          <>
            <PinnedChats pinsCollapsed={data.pinsCollapsed} entity={scope.entity} chat={scope.chat as ChatId | null} />
            {sections.map(([id, title]) =>
              section(id, id === "just" ? `Just ${card?.card.label ?? "this character"}` : title)
            )}
            {forks.loading && !forks.failure && <Loading label="Still loading your chats…" />}
            <ListFailure forks={forks} />
            {none && <p className="p-2 text-sm text-muted">No chats here yet.</p>}
          </>
        )}
      </div>
    </div>
  )
}
export function ShellBrowser() {
  // Holds the panel's height while loading too, so the navigation below doesn't jump.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AsyncView atom={shellAtom} loading="Loading chats…" still="Still loading your chats…">
        {(data) => <Browser data={data} />}
      </AsyncView>
    </div>
  )
}
