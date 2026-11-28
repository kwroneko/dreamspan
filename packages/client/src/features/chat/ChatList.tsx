// The chat list (DESIGN §2.1): every chat, most recent message first, each with its cast's
// faces, a readable name (the group's or the character's, never ST's file name), when it
// started, how long it is and how it ends. It's the sidebar on wide screens, the chats page
// on phones, a card's chats on its page and a group's on its own. It reads a page at a time, with Load more for
// older chats; finding a chat asks the server, so it finds chats not loaded yet.
import { useAtomValue } from "@effect/atom-react"
import type { CastCard, Chat, ChatId, ForkId } from "@dreamspan/shared/chat.ts"
import { SHELL_SECTION_LIMIT } from "@dreamspan/shared/chatSetupApi.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import { importState } from "@dreamspan/shared/stImportApi.ts"
import { Link, useParams, useSearch } from "@tanstack/react-router"
import { Effect } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type MouseEvent, useEffect, useMemo, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { carryLink, CHAT_DRAG } from "../../ui/appDrags.ts"
import { Avatar, AvatarStack } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"
import { Spinner } from "../../ui/Spinner.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { useUnseen } from "../notices.tsx"
import { type ShellFork, useShellForks } from "../characters/shellData.tsx"
import { PinButton } from "../characters/ShellBrowser.tsx"
import { chatName, formatDay, formatWhen } from "./chatTitle.ts"
import { chatRowAbout } from "./presentation.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { KindBadge } from "./KindBadge.tsx"
import { TextThenBadges } from "./RowBadges.tsx"
import { kindRowProps, useChatKindLook } from "./kindLooks.ts"
import { useSplitChats } from "./splitChats.ts"

const PAGE = 50

/** Shows a clipped text in full on hover. */
const titleIfClipped = (text: string) => (event: MouseEvent<HTMLElement>) => {
  const element = event.currentTarget
  element.title = element.scrollWidth > element.clientWidth ? text : ""
}

const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`

function Row({
  chat,
  createdAt,
  lastAt,
  characters,
  picture,
  messages,
  preview,
  speaker,
  fork,
  group,
  active,
  onDelete
}: {
  chat: Pick<Chat, "id" | "kind" | "title">
  createdAt: number
  lastAt: number | null
  characters: ReadonlyArray<CastCard>
  picture: string | null
  messages: number | undefined
  preview: string | undefined
  speaker?: string | undefined
  /** Its current fork's shell row, for the pin. */
  fork?: ShellFork | undefined
  /** The visible chat group when this row comes from the shell list. */
  group?: ShellFork
  active: boolean
  onDelete: () => void
}) {
  const unseen = useUnseen(chat.id)
  const kindLook = useChatKindLook(chat.kind)
  const search = useSearch({ strict: false }) as { panel?: string }
  const { title, unfinished } = importState(chat.title)
  const baseName = chatName(title, characters, createdAt)
  const name = group
    ? { name: group.chatName || "…", started: chat.id === group.chat.id ? baseName.started : null }
    : baseName
  const pin = group ?? fork
  const others = characters.filter((card) => card.name !== name.name).map((card) => card.name)
  return (
    <li {...kindRowProps(kindLook)} className="tile-toggle-surface group relative rounded-lg">
      <Tooltip label="Opens this chat.">
        <Link
          to="/chats/$chatId"
          params={{ chatId: chat.id }}
          search={{ ...(search.panel ? { panel: search.panel } : {}), ...(group ? { fork: group.forkId } : {}) }}
          // Dropped on a frame, the chat opens there, as a click does (owner, 2026-11-07).
          onDragStart={carryLink(CHAT_DRAG.id)}
          data-chat-id={group?.chat.id ?? chat.id}
          aria-current={active ? "page" : undefined}
          className={`flex gap-3 rounded-lg px-2.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:pr-16 ${
            active ? "bg-surface-raised" : "hover:bg-surface-raised/60"
          }`}
        >
          {picture ? (
            <Avatar id={group?.chat.id ?? chat.id} name={name.name} mediaId={picture} size="lg" />
          ) : (
            <AvatarStack
              faces={characters.map((card) => ({
                id: card.entityId,
                name: card.name,
                mediaId: card.avatarMediaId,
                crop: card.avatarCrop
              }))}
            />
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span
                data-layout-name
                className={`truncate ${unseen > 0 ? "font-semibold" : "font-medium"}`}
                onMouseEnter={titleIfClipped(name.name)}
              >
                {name.name}
              </span>
              <SlotOutlet slot={chatRowAbout} props={{ chat }} />
              <span className="ml-auto shrink-0 text-xs text-muted">{formatWhen(lastAt ?? createdAt)}</span>
            </span>
            {/* What tells two chats of the same cast apart, on a line of its own so it's never cut off. */}
            {/* A workshop's badge beside it, out of the title's line (owner, 2026-11-18). */}
            <span data-chat-meta className="block text-xs text-muted">
              {messages !== undefined ? (
                <>
                  <span>started {formatDay(name.started ?? new Date(createdAt))}</span>
                  {" · "}
                  <TextThenBadges text={plural(messages, "message")} whole>
                    <KindBadge kind={chat.kind} inLink size="sm" />
                  </TextThenBadges>
                </>
              ) : (
                <TextThenBadges text={`started ${formatDay(name.started ?? new Date(createdAt))}`}>
                  <KindBadge kind={chat.kind} inLink size="sm" />
                </TextThenBadges>
              )}
            </span>
            {others.length > 0 && (
              <span
                data-layout-name
                className="truncate text-xs text-muted"
                onMouseEnter={titleIfClipped(others.join(", "))}
              >
                with {others.join(", ")}
              </span>
            )}
            <span className="line-clamp-2 min-h-10 text-sm text-muted">
              {speaker ? <span className="text-text">{speaker}: </span> : null}
              {preview?.replace(/\s+/g, " ") || (group?.pending ? "…" : "No messages yet")}
            </span>
            {(unseen > 0 || unfinished) && (
              <span className="mt-0.5 flex gap-1.5 text-xs">
                {unseen > 0 && (
                  <span className="rounded-full bg-accent px-1.5 text-accent-contrast">
                    {unseen === 1 ? "1 new reply" : `${unseen} new replies`}
                  </span>
                )}
                {unfinished && <span className="text-warning">import unfinished</span>}
              </span>
            )}
          </span>
        </Link>
      </Tooltip>
      {pin && (
        <span data-layout-overlay="Pin action sits over the chat row" className="absolute right-2.5 bottom-2">
          <PinButton fork={pin} className="tile-toggle" />
        </span>
      )}
      <Tooltip label="Moves this chat and all its branches to the bin, from which it can be restored later.">
        <button
          type="button"
          onClick={onDelete}
          data-layout-overlay="Delete action sits over the chat row"
          aria-label={`Delete ${name.name}${name.started ? `, started ${formatDay(name.started)}` : ""}`}
          className="absolute top-2 right-2.5 hidden rounded bg-surface-raised px-1.5 py-0.5 text-xs text-muted outline-none group-focus-within:block group-hover:block hover:text-danger focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:block"
        >
          Delete
        </button>
      </Tooltip>
    </li>
  )
}

/** Chats as the list shows them, each with its cast, length and last message, a page at a time. */
function Rows({ chats, onDelete }: { chats: ReadonlyArray<Chat>; onDelete: (chat: Chat) => void }) {
  // Keyed by the ids, not the array, which is new on every read.
  const key = chats.map((chat) => chat.id).join()
  const summariesAtom = useMemo(
    () =>
      AppClient.query(
        "ListChatSummaries",
        { chatIds: key === "" ? [] : (key.split(",") as Array<ChatId>) },
        { reactivityKeys: ["chats", "chat-lists", "library"] }
      ),
    [key]
  )
  const summaries = useAtomValue(summariesAtom)
  const byId = new Map(
    (AsyncResult.isSuccess(summaries) ? summaries.value : []).map((summary) => [summary.chatId as string, summary])
  )
  // The page's chats' current forks, for their pins: one read for the page.
  const forks = useShellForks({
    entity: null,
    chat: null,
    chats: chats.map((chat) => chat.id),
    search: "",
    sort: "recent",
    sections: [{ id: "current", limit: chats.length }]
  }).section("current").rows
  const { chatId: selected } = useParams({ strict: false }) as { chatId?: string }
  return chats.map((chat) => {
    const summary = byId.get(chat.id)
    return (
      <Row
        key={chat.id}
        chat={chat}
        createdAt={chat.createdAt}
        lastAt={chat.lastMessageAt}
        characters={(summary?.cast ?? []).filter((card) => !card.persona)}
        picture={chat.pictureMediaId ?? null}
        messages={summary?.messages}
        preview={summary?.last?.text}
        speaker={summary?.cast.find((card) => card.entityId === summary.last?.speaker)?.name}
        fork={forks.find((f) => f.chat.id === chat.id)}
        active={chat.id === selected}
        onDelete={() => onDelete(chat)}
      />
    )
  })
}

/** One row per live chat group, from the same list as the sidebar. */
function Pages({ search, offset = 0 }: { search: string; offset?: number }) {
  const [limit, setLimit] = useState(PAGE)
  const [next, setNext] = useState(false)
  const forks = useShellForks({
    entity: null,
    chat: null,
    search,
    sort: "recent",
    sections: [{ id: "chats", limit, ...(offset ? { offset } : {}) }]
  })
  const { rows, total } = forks.section("chats")
  const { chatId: selected } = useParams({ strict: false }) as { chatId?: ChatId }
  const { fork: shown } = useSearch({ strict: false }) as { fork?: ForkId }
  const selectedGroup = useSplitChats(selected ?? null, shown)?.group.id ?? selected
  const [gone, setGone] = useState<ReadonlyMap<string, ReadonlyArray<ShellFork>>>(new Map())
  const action = useAction()
  const deleted = useDeletedToast()
  const remove = async (row: ShellFork) => {
    const chatId = row.sourceChatId ?? row.chat.id
    const forkId = row.forkId as ForkId
    const result = await action.run(
      (client) =>
        Effect.gen(function* () {
          const split = yield* client("GetSplitChats", { chatId, forkId })
          if (split.group.id !== row.chat.id) return yield* new NotFound({ entity: "chat group", id: row.chat.id })
          if (!split.hasSplits && split.group.id === chatId) return yield* client("DeleteChat", { chatId })
          const removed = yield* client("DeleteChatGroup", { chatId, forkId, expectedForkIds: split.forkIds })
          return removed.item
        }),
      ["chats", "pins", "bin"]
    )
    if (!result.ok) return
    setGone((current) => new Map(current).set(row.chat.id, rows))
    deleted(result.value)
  }
  if (forks.loading && forks.failure) return <p className="px-2 text-sm text-danger">The chats couldn't be loaded.</p>
  if (forks.loading) return <Spinner />
  const visible = rows.filter((row) => gone.get(row.chat.id) !== rows)
  return (
    <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
      {visible.length === 0 && offset === 0 ? (
        <p className="px-2 py-4 text-sm text-muted">
          {search ? `No chat's title or characters have “${search}”.` : "No chats yet. Pick a character to start one."}
        </p>
      ) : (
        <ul aria-label={offset === 0 ? "Chats" : "More chats"} className="flex flex-col gap-0.5">
          {visible.map((row) => (
            <Row
              key={row.chat.id}
              chat={{ ...row.chat, id: row.sourceChatId ?? row.chat.id }}
              createdAt={row.chat.createdAt ?? row.createdAt}
              lastAt={row.endAt}
              characters={row.cast}
              picture={row.chat.picture ?? null}
              messages={row.pending ? undefined : row.messages}
              preview={row.preview}
              group={row}
              active={row.chat.id === selectedGroup}
              onDelete={() => void remove(row)}
            />
          ))}
        </ul>
      )}
      {next ? (
        <Pages search={search} offset={offset + SHELL_SECTION_LIMIT} />
      ) : (
        offset + rows.length < total && (
          <Button
            hint="Loads more chats."
            variant="ghost"
            className="self-center"
            pending={forks.waiting}
            onClick={() => {
              if (limit === SHELL_SECTION_LIMIT) setNext(true)
              else setLimit(Math.min(SHELL_SECTION_LIMIT, limit + PAGE))
            }}
          >
            Load more
          </Button>
        )
      )}
      <ErrorAlert error={action.error} />
    </div>
  )
}

/**
 * A list given whole, as a group's chats are: its pages' summaries are read as the full
 * list's are. A chat deleted here stays hidden until the list is read again.
 */
function Given({ chats, onDeleted }: { chats: ReadonlyArray<Chat>; onDeleted?: ((chat: Chat) => void) | undefined }) {
  const [gone, setGone] = useState<ReadonlyMap<string, ReadonlyArray<Chat>>>(new Map())
  const action = useAction()
  const deleted = useDeletedToast()
  const shown = chats.filter((chat) => gone.get(chat.id) !== chats)
  const remove = async (chat: Chat) => {
    const result = await action.run((client) => client("DeleteChat", { chatId: chat.id }), ["chats"])
    if (!result.ok) return
    setGone(new Map([...gone, [chat.id, chats]]))
    deleted(result.value)
    onDeleted?.(chat)
  }
  const pages = Array.from({ length: Math.ceil(shown.length / PAGE) }, (_, i) => shown.slice(i * PAGE, (i + 1) * PAGE))
  return (
    <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
      {shown.length === 0 ? (
        <p className="px-2 py-4 text-sm text-muted">No chats left.</p>
      ) : (
        <ul aria-label="Chats" className="flex flex-col gap-0.5">
          {pages.map((page, i) => (
            <Rows key={i} chats={page} onDelete={(chat) => void remove(chat)} />
          ))}
        </ul>
      )}
      <ErrorAlert error={action.error} />
    </div>
  )
}

/** What's typed, once typing pauses. */
const useSettled = (value: string, ms: number) => {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/**
 * A list of chats: all of them, or those given (`chats`, a group's,
 * with `onDeleted` told of each deleted here). `findable` adds a box to find one by title or
 * character, among all of them, loaded or not.
 */
export function ChatList({
  chats,
  onDeleted,
  findable = true
}: {
  chats?: ReadonlyArray<Chat>
  onDeleted?: (chat: Chat) => void
  findable?: boolean
}) {
  const [filter, setFilter] = useState("")
  const search = useSettled(filter.trim().slice(0, 200), 250)
  if (chats !== undefined) return <Given chats={chats} onDeleted={onDeleted} />
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {findable && (
        <Input
          aria-label="Find a chat"
          placeholder="Find a chat or character"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      )}
      <Pages key={search} search={search} />
    </div>
  )
}
