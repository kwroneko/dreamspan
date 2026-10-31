import { chatName, formatDay } from "../chat/chatTitle.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { useSession } from "../../session.ts"
import { rememberedPanel } from "../chat/ChatPanels.tsx"
import { useWide } from "../chat/ChatPanels.tsx"
import { Button } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { GroupFaces } from "./GroupFaces.tsx"
import {
  CharacterTile,
  scopeSearch,
  shellAtom,
  sidebarCleared,
  useShellNavigation,
  type ShellFork,
  type ShellLibrary
} from "./shellData.tsx"

export function PinButton({ fork }: { fork: ShellFork }) {
  const action = useAction()
  return (
    <span className="shrink-0">
      <Button
        variant="ghost"
        pending={action.pending}
        aria-label={`${fork.pinned ? "Unpin" : "Pin"} ${fork.name}`}
        aria-pressed={fork.pinned}
        className="h-8 px-2"
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
      >
        {fork.pinned ? "★" : "☆"}
      </Button>
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
        aria-label={`Open chat ${fork.name}`}
        className="flex w-full flex-1 flex-col text-left"
      >
        <span className="aspect-[2/3] w-full">
          <GroupFaces members={fork.cast} />
        </span>
        <span className="flex w-full min-w-0 flex-1 flex-col gap-1 p-2.5">
          <span className="text-sm font-medium [overflow-wrap:anywhere]">{fork.name}</span>
          <span className="text-xs text-muted [overflow-wrap:anywhere]">
            {fork.cast.map((c) => `${c.label}${c.subtitle ? ` · ${c.subtitle}` : ""}`).join(", ")}
          </span>
          <span className="mt-auto text-xs text-muted">{fork.current ? "Current fork" : "Peer fork"}</span>
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
  details = false
}: {
  fork: ShellFork
  scopeChat?: boolean
  details?: boolean
}) {
  const open = useOpenFork(fork, scopeChat)
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md border border-border p-1 hover:bg-surface-raised">
      <button
        type="button"
        onClick={open}
        aria-label={`Open chat ${fork.name}`}
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
          <span className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]" title={fork.name}>
            {fork.name}
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
            {fork.current ? "Current fork · " : ""}
            {new Date(fork.recentAt).toLocaleDateString()}
          </span>
        </span>
      </button>
      <PinButton fork={fork} />
    </div>
  )
}

export type ShellSort = "recent" | "created" | "name"
export const sortForks = (forks: ReadonlyArray<ShellFork>, sort: ShellSort) =>
  [...forks].sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : (sort === "created" ? b.createdAt - a.createdAt : b.recentAt - a.recentAt) || a.name.localeCompare(b.name)
  )
export function SortSwitch({
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
        { value: "recent", label: "Recent" },
        { value: "created", label: "Created" },
        { value: "name", label: "Name" }
      ]}
    />
  )
}
export function PinnedChats({
  data,
  forks = data.forks,
  home = false
}: {
  data: ShellLibrary
  forks?: ReadonlyArray<ShellFork>
  home?: boolean
}) {
  const [sort, setSort] = useState<ShellSort>("recent")
  const action = useAction()
  const pins = sortForks(
    forks.filter((f) => f.pinned),
    sort
  )
  if (!pins.length) return null
  return (
    <section aria-label="Pinned chats" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghost"
          aria-expanded={!home || !data.pinsCollapsed}
          onClick={() =>
            home && void action.run((c) => c("SetHomePinsCollapsed", { collapsed: !data.pinsCollapsed }), ["pins"])
          }
        >
          {home ? (data.pinsCollapsed ? "▸ " : "▾ ") : ""}Pinned chats
        </Button>
        {(!home || !data.pinsCollapsed) && <SortSwitch value={sort} onChange={setSort} label="Sort pinned chats" />}
      </div>
      {(!home || !data.pinsCollapsed) &&
        pins.map((fork) => <ForkRow key={`${fork.chat.id}/${fork.forkId}`} fork={fork} />)}
      <ErrorAlert error={action.error} />
    </section>
  )
}

function Browser({ data }: { data: ShellLibrary }) {
  const { scope, setScope, grid, setGrid } = useShellNavigation()
  const [search, setSearch] = useState("")
  const params = useParams({ strict: false }) as { chatId?: string }
  const shown = (useSearch({ strict: false }) as { fork?: string }).fork
  const card = data.cards.find((c) => c.card.entityId === scope.entity)
  const cardLabel = card
    ? `${card.card.label}${card.card.subtitle ? ` · ${card.card.subtitle}` : ""}`
    : "Character not found"
  // A chat by its current fork's name; inside it, the fork shown in the middle when that's another.
  const chatForks = data.forks.filter((f) => f.chat.id === scope.chat)
  const chat = chatForks.find((f) => f.current) ?? chatForks[0]
  const open = params.chatId === scope.chat ? chatForks.find((f) => f.forkId === shown) : undefined
  const chatLabel = !chat
    ? "Chat not found"
    : open && open.forkId !== chat.forkId && open.name !== chat.name
      ? `${chat.name} › ${open.name}`
      : chat.name
  const scoped = data.forks.filter(
    (f) => (!scope.entity || f.joined.includes(scope.entity)) && (!scope.chat || f.chat.id === scope.chat)
  )
  const needle = search.trim().toLowerCase()
  const rows = scoped.filter(
    (f) => !needle || [f.name, ...f.cast.map((c) => c.label)].some((n) => n.toLowerCase().includes(needle))
  )
  const section = (title: string, forks: ReadonlyArray<ShellFork>) =>
    forks.length > 0 && (
      <section className="flex flex-col gap-1" aria-label={title}>
        <h3 className="mt-3 truncate text-xs font-semibold text-muted" title={title}>
          {title}
        </h3>
        {forks.map((f) => (
          <ForkRow key={`${f.chat.id}/${f.forkId}`} fork={f} />
        ))}
      </section>
    )
  const peers = rows.filter((f) => f.current || f.pinned || f.named)
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {grid ? (
          <div className="grid grid-cols-2 gap-2">
            {data.cards
              .filter((c) => c.card.label.toLowerCase().includes(needle))
              .map((c) => (
                <CharacterTile key={c.card.entityId} card={c} />
              ))}
          </div>
        ) : (
          <>
            <PinnedChats data={data} forks={scoped} />
            {scope.chat ? (
              <>
                {section(
                  "Current fork",
                  rows.filter((f) => f.current)
                )}
                {section(
                  "Named and pinned peers",
                  rows.filter((f) => !f.current && (f.pinned || f.named))
                )}
                {section(
                  "Other forks",
                  rows.filter((f) => !f.current && !f.pinned && !f.named)
                )}
              </>
            ) : scope.entity ? (
              <>
                {(["just", "with", "was"] as const).map((category) => {
                  const selected = rows
                    .filter(
                      (f) =>
                        f.activity.find((a) => a.entityId === scope.entity)?.category === category ||
                        (!f.activity.some((a) => a.entityId === scope.entity) &&
                          category === (f.departed.some((id) => id === scope.entity) ? "was" : "with"))
                    )
                    .sort(
                      (a, b) =>
                        (b.activity.find((x) => x.entityId === scope.entity)?.at ?? -1) -
                        (a.activity.find((x) => x.entityId === scope.entity)?.at ?? -1)
                    )
                  return (
                    <div key={category}>
                      {section(
                        category === "just"
                          ? `Just ${card?.card.label ?? "this character"}`
                          : category === "with"
                            ? "With others"
                            : "Was in",
                        selected
                      )}
                    </div>
                  )
                })}
              </>
            ) : (
              section("Chats", peers)
            )}
            {!rows.length && <p className="p-2 text-sm text-muted">No chats here yet.</p>}
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
      <AsyncView atom={shellAtom} loading="Loading chats…">
        {(data) => <Browser data={data} />}
      </AsyncView>
    </div>
  )
}
