import { SlotOutlet } from "../../slots.tsx"
import { positionOf } from "./position.ts"
import { chatBranchControls } from "./presentation.tsx"
import { ChatCommandMenu } from "./commands.tsx"
// The open chat's header: whose chat it is (the cast's faces and a readable name, never
// ST's file name), which branch is shown with a way to switch, and the chat's actions,
// which the page passes in. The branch and actions have a second row so they do not
// crowd the title, including group names beside several portraits.
import type { Chat, PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { Branch } from "@rp/shared/chatApi.ts"
import type { ChatName } from "@rp/shared/chatName.ts"
import type { ChatGroup } from "@rp/shared/chatSetupApi.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import type { AppError } from "../../errors.ts"
import { RadioGroup } from "../../ui/Choice.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { NameDialog } from "./NameDialog.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { PinButton } from "../characters/ShellBrowser.tsx"
import { sidebarCleared, useShellForks } from "../characters/shellData.tsx"
import { Icon } from "../../ui/Icon.tsx"
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuLinkItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator
} from "../../ui/Menu.tsx"
import { Tooltip, TooltipProvider } from "../../ui/Tooltip.tsx"
import { useTitle } from "../shell.tsx"
import { ChatBadges } from "./ChatsPage.tsx"
import { chatName, formatDay } from "./chatTitle.ts"
import { FORK_SCAN_LIMIT, useForks } from "./forks.ts"
import type { ChatSession, ChatView, Outcome } from "./session.ts"

/** A branch as people read it: its name, else "Branch k". */
const branchLabel = (index: number, name: string | null | undefined) => name ?? `Branch ${index + 1}`

/** Runs a session write, keeping its pending state and error for a dialog. */
function useWrite() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const run = async <A,>(write: () => Promise<Outcome<A>>) => {
    setPending(true)
    setError(null)
    const result = await write()
    setPending(false)
    if (!result.ok) setError(result.error)
    return result
  }
  return { run, pending, error, clear: () => setError(null) }
}

/**
 * Which branch is shown, and the others at each place the path branches, by name where they
 * have one (DESIGN §3.2), with naming and deleting the branch shown at each place.
 */
export function BranchMenu({
  session,
  view,
  onBranch,
  onJump
}: {
  session: ChatSession
  view: ChatView
  onBranch: (entry: PathEntry, index: number) => void
  onJump: (slotId: SlotId) => void
}) {
  const { forks, complete } = useForks(session, view)
  // The alternates at each place, with their names: read each time the menu opens.
  const [liveForkCount, setLiveForkCount] = useState<number | null>(null)
  const [branches, setBranches] = useState<ReadonlyMap<SlotId, ReadonlyArray<Branch>>>(new Map())
  const nameOf = (fork: PathEntry) => fork.branchName
  const [naming, setNaming] = useState<PathEntry | null>(null)
  const write = useWrite()
  const deleted = useDeletedToast()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { panel?: string }
  const off = view.forkId !== null && view.chat !== null && view.forkId !== view.chat.currentForkId
  if (forks.length === 0 && !off) return null
  const last = forks.at(-1)
  const speaker = (entry: PathEntry) =>
    view.cast?.cards.find((c) => c.entityId === (entry.version.speakerEntityId ?? entry.firstSpeakerEntityId))?.name ||
    (entry.version.writer === "model" ? "Model" : "You")
  const named = last === undefined ? undefined : nameOf(last)
  const summary = last
    ? named !== undefined
      ? last.branchCount === 1
        ? named
        : `${named} (${last.branchIndex + 1} of ${last.branchCount})`
      : `Branch ${last.branchIndex + 1} of ${last.branchCount}`
    : "Another branch"
  const canSwitch = forks.some((fork) => fork.branchCount > 1) || off
  const label = `${summary}${last ? `, at message #${positionOf(last) + 1}` : ""}${off ? ", not the latest" : ""}: ${canSwitch ? "switch branch" : "branch actions"}`
  const load = async () => {
    setLiveForkCount(null)
    const live = session.call((client) => client("ListForks", { chatId: session.id }))
    const read = await Promise.all(
      forks.map(async (fork) => [fork.slotId, await session.listBranches(fork.slotId)] as const)
    )
    const listed = read.flatMap(([slotId, result]) => (result.ok ? [[slotId, result.value] as const] : []))
    setBranches(new Map(listed))
    const result = await live
    if (result.ok) setLiveForkCount(result.value.length)
  }
  // The fork shown is the one deleted, and only it (owner, 2026-10-27): forks made from it keep
  // their history, the chat opens on the one chatted in last, and Undo brings it back.
  const shownFork = view.forkId ?? view.chat?.currentForkId ?? null
  const remove = async () => {
    if (shownFork === null || liveForkCount === null || liveForkCount <= 1) return
    const result = await session.deleteFork(shownFork)
    if (!result.ok) return showToast({ title: "Couldn't delete the fork", description: result.error.message })
    deleted(result.value)
    // The old URL names the fork that went. Keep the panel, follow the current fork.
    void navigate({ to: ".", search: search.panel ? { panel: search.panel } : {}, replace: true })
  }
  return (
    <>
      <Menu
        align="end"
        label="Branches"
        onOpenChange={(open) => {
          if (open) void load()
        }}
        trigger={
          <Tooltip label={label}>
            <button
              type="button"
              aria-label={label}
              className={`inline-flex h-8 max-w-72 min-w-0 shrink-0 items-center gap-1.5 rounded-md border px-2 text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus data-popup-open:bg-surface-raised max-sm:mr-auto max-sm:max-w-[calc(100%-5.5rem)] ${
                off ? "border-warning/60 text-warning" : "border-border text-text"
              }`}
            >
              <Icon name="branch" size={14} className="shrink-0" />
              <span className="truncate max-sm:hidden">
                {summary}
                {off && <span className="text-xs"> · not the latest</span>}
              </span>
              <span className="truncate tabular-nums sm:hidden">
                {last ? (named ?? `${last.branchIndex + 1}/${last.branchCount}`) : "Another branch"}
              </span>
              <Icon name="down" size={14} className="shrink-0 text-muted max-sm:hidden" />
            </button>
          </Tooltip>
        }
      >
        {off && (
          <>
            <p className="px-2.5 py-1.5 text-xs text-muted">
              This isn&rsquo;t the current fork. Sending here makes it current.
            </p>
            <MenuLinkItem
              icon="back"
              render={
                <Link
                  to="."
                  search={{
                    ...(search.panel ? { panel: search.panel } : {})
                  }}
                />
              }
            >
              Back to the latest branch
            </MenuLinkItem>
            {forks.length > 0 && <MenuSeparator />}
          </>
        )}
        {[...forks].reverse().map((fork, i) => {
          const listed = branches.get(fork.slotId)
          const shownName = nameOf(fork)
          const shownLabel = branchLabel(fork.branchIndex, shownName)
          return (
            <MenuGroup
              key={fork.slotId}
              label={`${fork.branchCount === 1 ? "Branch" : i === 0 ? "Branches" : "Earlier"} at message #${positionOf(fork) + 1} (${speaker(fork)})`}
            >
              {fork.branchCount > 1 && (
                <MenuRadioGroup value={fork.branchIndex} onValueChange={(index: number) => onBranch(fork, index)}>
                  {Array.from({ length: fork.branchCount }, (_, index) => {
                    const branch = listed?.[index]
                    const name = index === fork.branchIndex ? shownName : (branch?.name ?? undefined)
                    return (
                      <MenuRadioItem key={index} value={index}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">
                            {branchLabel(index, name)}
                            {index === fork.branchIndex ? <span className="text-muted"> (shown)</span> : null}
                          </span>
                          {branch !== undefined && branch.preview !== "" && (
                            <span className="truncate text-xs text-muted">{branch.preview}</span>
                          )}
                        </span>
                      </MenuRadioItem>
                    )
                  })}
                </MenuRadioGroup>
              )}
              {fork.startsForkId !== undefined && (
                <MenuItem icon="edit" onClick={() => setNaming(fork)}>
                  {shownName === undefined ? `Name ${shownLabel}…` : `Rename “${shownLabel}”…`}
                </MenuItem>
              )}
              <MenuItem icon="right" onClick={() => onJump(fork.slotId)}>
                Go to message #{positionOf(fork) + 1}
              </MenuItem>
            </MenuGroup>
          )
        })}
        {(forks.length > 0 || off) && <MenuSeparator />}
        {/* The chat's forks, current and peers first, are listed where chats are (UX-REWORK §3). */}
        <MenuLinkItem
          icon="branch"
          render={
            <Link
              to="."
              search={(prev: Record<string, unknown>) => ({
                ...prev,
                ...sidebarCleared,
                forks: session.id
              })}
            />
          }
        >
          List this chat&rsquo;s forks
        </MenuLinkItem>
        {shownFork !== null && (
          <>
            <MenuItem
              icon="trash"
              tone="danger"
              disabled={liveForkCount === null || liveForkCount <= 1}
              onClick={() => void remove()}
            >
              Delete this fork
              {last !== undefined
                ? `: ${named === undefined ? branchLabel(last.branchIndex, undefined) : `“${named}”`}`
                : ""}
            </MenuItem>
            {liveForkCount === 1 && (
              <p className="px-2.5 py-1.5 text-xs text-muted">The only branch: delete the chat instead</p>
            )}
          </>
        )}
        {!complete && (
          <p className="px-2.5 py-1.5 text-xs text-muted">
            Looked for branches in the last {FORK_SCAN_LIMIT.toLocaleString()} messages.
          </p>
        )}
      </Menu>
      <NameDialog
        draftTarget={`chat:${session.id}:branch:${naming?.slotId ?? ""}`}
        open={naming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setNaming(null)
            write.clear()
          }
        }}
        title={`Name branch ${(naming?.branchIndex ?? 0) + 1} at message #${(naming ? positionOf(naming) : 0) + 1}`}
        label="Branch name"
        initial={(naming && nameOf(naming)) ?? ""}
        description="Shown instead of “Branch k” in this menu. Leave it empty to take the name off."
        maxLength={100}
        pending={write.pending}
        error={write.error}
        onSave={async (name) => {
          if (naming === null) return false
          const result = await write.run(() => session.nameFork(naming, name))
          if (!result.ok) return false
          setNaming(null)
          return true
        }}
      />
    </>
  )
}

/**
 * The chat's name, which a click renames (DESIGN §2.1). In a group, it says what renaming
 * one chat does to the group, and offers to rename the group, all its chats, instead.
 */
function ChatTitle({ session, view, name }: { session: ChatSession; view: ChatView; name: ChatName | null }) {
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState<{ group: ChatGroup; chats: ReadonlyArray<Chat> } | null>(null)
  const [scope, setScope] = useState<"chat" | "group">("chat")
  const write = useWrite()
  const shown = name?.name ?? "Chat"
  const begin = async () => {
    setGroup(null)
    setScope("chat")
    write.clear()
    const result = await session.call((client) => client("ListGroupChats", { chatId: view.chat!.id }))
    if (!result.ok && result.error.tag !== "NotFound") {
      showToast({ title: "Couldn't check this chat's group", description: result.error.message })
      return
    }
    setGroup(result.ok ? result.value : null)
    setOpen(true)
  }
  const many = group !== null && group.chats.length > 1
  return (
    <>
      <h1 className="min-w-0 text-base font-semibold sm:text-lg">
        <Tooltip label="Rename this chat">
          <button
            type="button"
            aria-description="Rename this chat"
            disabled={view.chat === null}
            onClick={() => void begin()}
            className="group/title flex max-w-full min-w-0 items-center gap-1.5 rounded-md text-left outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-focus"
          >
            <span className="line-clamp-2 [overflow-wrap:anywhere]">{shown}</span>
            <Icon name="edit" size={14} className="shrink-0 text-muted group-hover/title:text-accent" />
          </button>
        </Tooltip>
      </h1>
      <NameDialog
        draftTarget={`chat:${session.id}:rename`}
        open={open}
        onOpenChange={setOpen}
        title="Rename chat"
        label="Name"
        initial={shown}
        description={
          <>
            Leave it empty to name it after its characters.
            {name?.started ? ` It keeps the day SillyTavern started it (${formatDay(name.started)}).` : ""}
          </>
        }
        maxLength={200}
        saveLabel="Rename"
        pending={write.pending}
        error={write.error}
        onSave={async (next) => {
          const result =
            scope === "group"
              ? await write.run(() => session.renameGroup(next))
              : await write.run(() => session.rename(next))
          if (result.ok) setOpen(false)
          return result.ok
        }}
      >
        {group !== null &&
          (many ? (
            <Fieldset legend={`It's one of ${group.chats.length} chats in the group “${group.group.name}”`}>
              <RadioGroup
                value={scope}
                onValueChange={setScope}
                options={[
                  {
                    value: "chat",
                    label: "Only this chat",
                    description: `It leaves “${group.group.name}” and appears under its new name on Characters. Chats with the same name and characters share a tile.`
                  },
                  {
                    value: "group",
                    label: `The whole group (${group.chats.length} chats)`,
                    description: "Every chat of the group takes the name, and so does the group's tile."
                  }
                ]}
              />
            </Fieldset>
          ) : (
            <p className="text-sm text-muted">Its group tile on Characters takes this name too.</p>
          ))}
      </NameDialog>
    </>
  )
}

/** The characters in the chat shown, the user's own left out. */
const castCharacters = (view: ChatView) => {
  const cast = view.cast
  return (cast?.participants ?? [])
    .filter((id) => !cast!.playedByMe.includes(id))
    .flatMap((id) => cast!.cards.filter((card) => card.entityId === id))
}

/** The chat's readable name, as the header shows it (never ST's file name). */
export const chatDisplayName = (view: ChatView) =>
  view.chat ? chatName(importState(view.chat.title).title, castCharacters(view)).name : "Chat"

export function ChatHeader({
  session,
  view,
  actions,
  onBranch,
  onJump,
  onHistory
}: {
  session: ChatSession
  view: ChatView
  /** The chat's own buttons (its cast, notes, settings), at the end of the line. */
  actions: ReactNode
  onBranch: (entry: PathEntry, index: number) => void
  onHistory: () => void
  onJump: (slotId: SlotId) => void
}) {
  const characters = castCharacters(view)
  const navigate = useNavigate()
  // The shown fork's shell row, for its pin: this chat's forks only.
  const fork = useShellForks({
    entity: null,
    chat: view.chat?.id ?? null,
    chats: view.chat ? [view.chat.id] : [],
    search: "",
    sort: "recent",
    sections: [{ id: "all", limit: 1000 }]
  })
    .section("all")
    .rows.find((f) => f.chat.id === view.chat?.id && f.leaf === view.leafSlotId)
  const name = view.chat ? chatName(importState(view.chat.title).title, characters) : null
  useTitle(name?.name ?? "Chat")
  const names = characters.map((card) => card.name)
  const others = names.filter((n) => n !== name?.name)
  const about = [
    characters.some((card) => card.subtitle)
      ? characters.map((card) => `${card.name}${card.subtitle ? ` · ${card.subtitle}` : ""}`).join(", ")
      : others.length > 0
        ? others.join(", ")
        : null,
    name?.started ? `started ${formatDay(name.started)}` : null
  ].filter(Boolean)
  return (
    <TooltipProvider>
      <header className="mx-auto flex w-full max-w-3xl min-w-0 flex-wrap items-center gap-1.5 pb-2 sm:gap-3">
        <Tooltip label="All chats">
          <Link
            to="/chats"
            aria-label="Chats"
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name="back" />
          </Link>
        </Tooltip>
        <div className="flex max-w-40 gap-1 overflow-x-auto">
          {characters.map((c) => (
            <button
              key={c.entityId}
              type="button"
              aria-label={`Show ${c.label}'s card`}
              onClick={() =>
                void navigate({
                  to: ".",
                  search: (prev: Record<string, unknown>) => ({ ...prev, panel: `card:${c.entityId}` })
                })
              }
            >
              <Avatar id={c.entityId} name={c.name} mediaId={c.avatarMediaId} size="md" />
            </button>
          ))}
        </div>
        <div className="flex min-w-16 sm:min-w-24 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <ChatTitle session={session} view={view} name={name} />
            {view.chat && <ChatBadges chat={view.chat} />}
          </div>
          {about.length > 0 && <p className="truncate text-xs text-muted">{about.join(" · ")}</p>}
        </div>
        <div className="flex w-full min-w-0 items-center justify-end gap-1.5 sm:gap-3">
          {fork && <PinButton fork={fork} />}
          <ChatCommandMenu context={{ session, view, onHistory, onJump }} />
          <SlotOutlet slot={chatBranchControls} props={{ session, view, onBranch, onJump }} />
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-0.5 max-sm:[&_button]:px-1.5 max-sm:[&_button]:text-xs">
            {actions}
          </div>
        </div>
      </header>
    </TooltipProvider>
  )
}
