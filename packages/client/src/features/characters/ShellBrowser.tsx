import { chatName, formatDay, formatWhen } from "../chat/chatTitle.ts"
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { useNavigate, useParams, useRouter, useSearch } from "@tanstack/react-router"
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
import { Icon } from "../../ui/Icon.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { forkLabel, formatMoment, OPENS_HERE_HINT } from "../chat/forks.ts"
import { rowActionInsetClass } from "../../ui/rowSpacing.ts"
import { Badge } from "../../ui/Surface.tsx"
import { browseCards, useCardBrowse } from "./cardBrowse.tsx"
import { CardBrowseBar } from "./CardBrowseBar.tsx"
import { GroupGrid } from "./GroupGrid.tsx"
import { GroupFaces } from "./GroupFaces.tsx"
import { sidebarFoot } from "./homeSlots.ts"
import { SlotOutlet } from "../../slots.tsx"
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

export function PinButton({ fork, className = "" }: { fork: ShellFork; className?: string }) {
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
        className={`${fork.pinned ? "text-text!" : ""} ${className}`}
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
  // Read at the click: subscribing would re-render every row with each switch of the chat panel's tab.
  const router = useRouter()
  const navigation = useShellNavigation()
  const userId = useSession().user.id
  const wide = useWide()
  const open = () => {
    navigation.picked()
    // A list changes only the middle. Keep a character tab while that character is in the
    // chat, played by the model or by the user; else This chat.
    const inUrl = (router.state.location.search as { panel?: unknown }).panel
    const previous = (typeof inUrl === "string" ? inUrl : undefined) ?? (wide ? rememberedPanel(userId) : null)
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
    <div className="tile-toggle-surface relative flex flex-col overflow-hidden rounded-lg border border-border bg-surface">
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
      <span className="absolute right-1 top-1">
        <PinButton fork={fork} className="tile-toggle bg-surface" />
      </span>
    </div>
  )
}
/** A shell row as `forkLabel` reads it. */
const shellBranchLabel = (fork: ShellFork) =>
  forkLabel({
    name: fork.named ? fork.name : null,
    original: fork.original,
    split: fork.split,
    createdAt: fork.createdAt
  })

/**
 * "⑂ 12" at a chat row's end (owner, 2026-11-01): replaces the panel's list with the chat's
 * branches, opening nothing in the middle.
 */
function BranchesButton({ fork, entity = null }: { fork: ShellFork; entity?: EntityId | null }) {
  const { setScope } = useShellNavigation()
  if (fork.branches < 2) return null
  return (
    <Tooltip label={`Lists this chat's ${fork.branches} branches here, without opening one.`}>
      <button
        type="button"
        aria-label={`${fork.branches} branches of ${fork.chatName}: list them`}
        data-branches-button
        onClick={() => setScope({ entity, chat: fork.chat.id })}
        className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs text-muted tabular-nums outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Icon name="branch" size={14} />
        {fork.branches.toLocaleString()}
      </button>
    </Tooltip>
  )
}

export function ForkRow({
  fork,
  scopeChat = false,
  details = false,
  here = false,
  perFork = false,
  branchOnly = false,
  entity = null
}: {
  fork: ShellFork
  scopeChat?: boolean
  details?: boolean
  /** The row is this fork (a chat's branches, pins), not its chat (a list of chats). */
  perFork?: boolean
  /** Among its chat's branches only: the branch's own label, without the chat's name or faces. */
  branchOnly?: boolean
  /** The fork open in the middle: marked, so the list says where you are. */
  here?: boolean
  /** The character the list is scoped to, kept when "⑂ 12" lists a chat's branches. */
  entity?: EntityId | null
}) {
  const open = useOpenFork(fork, scopeChat)
  const label = shellBranchLabel(fork)
  // A row for a chat shows its name; one among its chat's branches, the branch's label. Where
  // rows of several chats mix, as pins do, the chat's name, with a named branch's name after it
  // and an unnamed one's label under it once the chat has more than one.
  const title = branchOnly ? label : perFork && fork.named ? `${fork.chatName} › ${fork.name}` : fork.chatName
  const branchLine = !branchOnly && perFork && !fork.named && fork.branches > 1 ? label : null
  const last = perFork ? (fork.endAt ?? fork.createdAt) : fork.chatRecentAt
  // The branch its chat opens on, among several, as the header's list marks it.
  const opensHere = perFork && fork.current && fork.branches > 1
  return (
    <div
      className={`flex w-full max-w-controls min-w-0 items-center gap-1 rounded-md border py-1 ps-1 ${rowActionInsetClass} hover:bg-surface-raised ${here ? "border-accent bg-surface-raised" : "border-border"}`}
    >
      <Tooltip
        label={
          perFork
            ? `Opens this branch${here ? ", shown now" : ""}.${opensHere ? ` ${OPENS_HERE_HINT}` : ""}`
            : "Opens the chat on the branch you last used."
        }
      >
        <button
          type="button"
          onClick={open}
          aria-label={`Open ${branchOnly ? "branch" : "chat"} ${title}`}
          aria-current={here ? "page" : undefined}
          data-chat-id={fork.chat.id}
          data-fork-id={fork.forkId}
          className="flex min-w-0 flex-1 items-center gap-2 rounded p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {!branchOnly && (
            <span className="flex shrink-0 gap-0.5">
              {fork.cast.slice(0, 2).map((c) => (
                <Avatar
                  key={c.entityId}
                  id={c.entityId}
                  name={c.name}
                  mediaId={c.avatarMediaId}
                  crop={c.avatarCrop}
                  size="md"
                />
              ))}
            </span>
          )}
          <span className="flex min-w-0 flex-col">
            {/* Two lines: beside the portraits one line leaves imported names unrecognizable. */}
            <span className="text-sm [overflow-wrap:anywhere]">
              <span className="font-medium">{title}</span>
              {opensHere && (
                <>
                  {" "}
                  <Badge>opens here</Badge>
                </>
              )}
            </span>
            {branchLine !== null && <span className="text-xs [overflow-wrap:anywhere]">{branchLine}</span>}
            {details && fork.cast.length > 1 && (
              <span className="line-clamp-2 text-xs text-muted [overflow-wrap:anywhere]">
                with {fork.cast.map((c) => c.label).join(", ")}
              </span>
            )}
            {details && (
              <span data-chat-meta className="text-xs text-muted [overflow-wrap:anywhere]">
                started{" "}
                {formatDay(
                  chatName(importState(fork.chat.title).title, fork.cast, fork.chat.createdAt ?? null).started ??
                    new Date(fork.createdAt)
                )}{" "}
                · {fork.messages} messages
              </span>
            )}
            {fork.preview && (
              <span className="line-clamp-2 text-xs text-muted [overflow-wrap:anywhere]">{fork.preview}</span>
            )}
            <span data-row-when className="text-xs text-muted">
              {perFork ? "Last message " : ""}
              {perFork ? formatMoment(last) : formatWhen(last)}
            </span>
          </span>
        </button>
      </Tooltip>
      {!perFork && <BranchesButton fork={fork} entity={entity} />}
      <PinButton fork={fork} />
    </div>
  )
}

const OPEN_BRANCHES_KEY = (userId: string) => `rp.openChatBranches.${userId}`

/**
 * The open chat's branches at the bottom of the left panel, below whatever it lists (owner,
 * 2026-11-01): switch branches without leaving the list above; its header lists them as the
 * panel's list instead. Collapsed or expanded per device.
 */
export function OpenChatBranches() {
  const params = useParams({ strict: false }) as { chatId?: string }
  const shown = useSearch({ strict: false, select: (s: { fork?: string }) => s.fork })
  const { scope, setScope, grid } = useShellNavigation()
  const userId = useSession().user.id
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(OPEN_BRANCHES_KEY(userId)) !== "collapsed"
    } catch {
      return true
    }
  })
  const chatId = (params.chatId ?? null) as ChatId | null
  const forks = useShellForks({
    entity: null,
    chat: chatId,
    search: "",
    sort: "recent",
    sections: [
      { id: "peers", limit: 5000 },
      { id: "other", limit: 5000 }
    ]
  })
  if (chatId === null || grid || scope.chat === chatId) return null
  const rows = [...forks.section("peers").rows, ...forks.section("other").rows]
  if (rows.length < 2) return null
  const toggle = () => {
    setExpanded(!expanded)
    try {
      localStorage.setItem(OPEN_BRANCHES_KEY(userId), expanded ? "collapsed" : "open")
    } catch {
      // Remembered only where the browser keeps it.
    }
  }
  const chatLabel = rows[0]!.chatName
  return (
    <section
      aria-label="Branches of the open chat"
      className="flex max-h-[45%] min-h-0 shrink-0 flex-col gap-1 border-t border-border pt-2"
    >
      <div className="flex max-w-controls min-w-0 items-center gap-1">
        <Tooltip label={expanded ? "Hides the open chat's branches." : "Shows the open chat's branches here."}>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={toggle}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-semibold text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name={expanded ? "down" : "right"} size={14} className="shrink-0" />
            <span className="truncate">
              Branches of {chatLabel} ({rows.length.toLocaleString()})
            </span>
          </button>
        </Tooltip>
        <IconButton
          label="List these branches in the panel"
          hint="Shows these branches as the panel's list, with a way back to all chats."
          icon="expand"
          onClick={() => setScope({ entity: null, chat: chatId })}
        />
      </div>
      {expanded && (
        <div className="-mr-1 flex min-h-0 flex-col gap-1 overflow-y-auto pr-1.5 [scrollbar-gutter:stable]">
          {rows.map((f) => (
            <ForkRow key={f.forkId} fork={f} perFork branchOnly here={shown ? f.forkId === shown : f.current} />
          ))}
        </div>
      )}
    </section>
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
  home = false,
  sortBy,
  onSortChange
}: {
  pinsCollapsed: boolean
  entity?: EntityId | null
  chat?: ChatId | null
  home?: boolean
  sortBy?: ShellSort
  onSortChange?: (sort: ShellSort) => void
}) {
  const [localSort, setSort] = useState<ShellSort>("recent")
  const sort = sortBy ?? localSort
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
        {open && <SortSwitch value={sort} onChange={onSortChange ?? setSort} label="Sort pinned chats" />}
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
  // Named and pinned first, then the rest, each by last message; the one the chat opens on is
  // marked where it is (owner, 2026-11-01).
  chat: [
    ["peers", "Named and pinned"],
    ["other", "Branches"]
  ]
} as const satisfies Record<string, ReadonlyArray<readonly [ShellSection, string]>>

function Browser({ data }: { data: ShellLibrary }) {
  const { scope, setScope, grid, setGrid } = useShellNavigation()
  const [search, setSearch] = useState("")
  // The characters grid's own filter and sort, apart from the home page's (cardBrowse.tsx).
  const [browse, setBrowse] = useCardBrowse("sidebar")
  const params = useParams({ strict: false }) as { chatId?: string }
  const shown = useSearch({ strict: false, select: (s: { fork?: string }) => s.fork })
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
  // The chat by its name, which all its branches share.
  const chatRows = scope.chat ? sections.flatMap(([id]) => forks.section(id).rows) : []
  const chat = chatRows[0]
  const chatLabel = !chat ? (forks.loading ? "…" : "Chat not found") : chat.chatName
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
              branchOnly={kind === "chat"}
              entity={scope.entity}
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
          <Tooltip label="Back to the list of all your chats.">
            <button
              type="button"
              className="shrink-0 text-accent hover:underline"
              onClick={() => setScope({ entity: null, chat: null })}
            >
              All chats
            </button>
          </Tooltip>
          {scope.entity && (
            <>
              <span aria-hidden className="shrink-0 text-muted">
                ›
              </span>
              {scope.chat ? (
                <Tooltip label={`Back to ${cardLabel}'s chats.`}>
                  <button
                    type="button"
                    className="min-w-0 truncate text-accent hover:underline"
                    onClick={() => setScope({ entity: scope.entity, chat: null })}
                  >
                    {cardLabel}
                  </button>
                </Tooltip>
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
        className="max-w-controls"
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
          // One column of rows; dragged wide, a row stays a row's width, its pin beside its text.
          <div className="max-w-controls">
            {/* A chat's own pins are among its named and pinned branches. */}
            {kind !== "chat" && <PinnedChats pinsCollapsed={data.pinsCollapsed} entity={scope.entity} />}
            {sections.map(([id, title]) =>
              section(id, id === "just" ? `Just ${card?.card.label ?? "this character"}` : title)
            )}
            {forks.loading && !forks.failure && <Loading label="Still loading your chats…" />}
            <ListFailure forks={forks} />
            {none && <p className="p-2 text-sm text-muted">No chats here yet.</p>}
          </div>
        )}
      </div>
      <SlotOutlet slot={sidebarFoot} props={{}} />
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
