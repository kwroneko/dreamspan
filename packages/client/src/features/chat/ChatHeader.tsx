// The open chat's header: whose chat it is (the cast's faces and a readable name, never
// ST's file name), which branch is shown with a way to switch, and the chat's actions,
// which the page passes in. On a phone it's one line: the name truncates and the names of
// the cast go.
import type { Chat, PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { Branch } from "@rp/shared/chatApi.ts"
import type { ChatName } from "@rp/shared/chatName.ts"
import type { ChatGroup } from "@rp/shared/chatSetupApi.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Link } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import type { AppError } from "../../errors.ts"
import { RadioGroup } from "../../ui/Choice.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { NameDialog } from "./NameDialog.tsx"
import { AvatarStack } from "../../ui/Avatar.tsx"
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
function BranchMenu({
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
  const [branches, setBranches] = useState<ReadonlyMap<SlotId, ReadonlyArray<Branch>>>(new Map())
  // Names read or given here since the path was scanned, by the message that starts each
  // branch: a fork found by the scan above what's loaded isn't kept current by the session.
  const [names, setNames] = useState<ReadonlyMap<SlotId, string | null>>(new Map())
  const nameOf = (fork: PathEntry) => {
    const known = names.get(fork.slotId)
    return known === undefined ? fork.branchName : (known ?? undefined)
  }
  const [naming, setNaming] = useState<PathEntry | null>(null)
  const write = useWrite()
  const deleted = useDeletedToast()
  const off = view.leafSlotId !== null && view.chat !== null && view.leafSlotId !== view.chat.activeLeafSlotId
  if (forks.length === 0 && !off) return null
  const last = forks.at(-1)
  const speaker = (entry: PathEntry) =>
    view.cast?.cards.find((c) => c.entityId === (entry.version.speakerEntityId ?? entry.firstSpeakerEntityId))?.name ||
    (entry.version.writer === "model" ? "Model" : "You")
  const named = last === undefined ? undefined : nameOf(last)
  const summary = last
    ? named !== undefined
      ? `${named} (${last.branchIndex + 1} of ${last.branchCount})`
      : `Branch ${last.branchIndex + 1} of ${last.branchCount}`
    : "Another branch"
  const label = `${summary}${last ? `, at message #${last.depth + 1}` : ""}${off ? ", not the latest" : ""}: switch branch`
  const load = async () => {
    const read = await Promise.all(
      forks.map(async (fork) => [fork.slotId, await session.listBranches(fork.slotId)] as const)
    )
    const listed = read.flatMap(([slotId, result]) => (result.ok ? [[slotId, result.value] as const] : []))
    setBranches(new Map(listed))
    setNames(new Map(listed.flatMap(([, all]) => all.map((branch) => [branch.slotId, branch.name] as const))))
  }
  const remove = async (fork: PathEntry) => {
    const result = await session.deleteBranch(fork.slotId)
    if (!result.ok) return showToast({ title: "Couldn't delete the branch", description: result.error.message })
    deleted(result.value)
    // The branch before it shows in its place (the next one, for the first); Undo brings it back.
    if (fork.branchCount > 1) onBranch(fork, Math.max(0, fork.branchIndex - 1))
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
              className={`inline-flex h-8 max-w-72 min-w-0 shrink-0 items-center gap-1.5 rounded-md border px-2 text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus data-popup-open:bg-surface-raised max-sm:max-w-28 ${
                off ? "border-warning/60 text-warning" : "border-border text-text"
              }`}
            >
              <Icon name="branch" size={14} className="shrink-0" />
              <span className="truncate max-sm:hidden">
                {summary}
                {off && <span className="text-xs"> · not the latest</span>}
              </span>
              {last && (
                <span className="truncate tabular-nums sm:hidden">
                  {named ?? `${last.branchIndex + 1}/${last.branchCount}`}
                </span>
              )}
              <Icon name="down" size={14} className="shrink-0 text-muted max-sm:hidden" />
            </button>
          </Tooltip>
        }
      >
        {off && (
          <>
            <p className="px-2.5 py-1.5 text-xs text-muted">
              This isn&rsquo;t the branch the chat continues on: sending here makes it the latest.
            </p>
            <MenuLinkItem icon="back" render={<Link to="." search={{}} />}>
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
              label={`${i === 0 ? "Branches" : "Earlier"} at message #${fork.depth + 1} (${speaker(fork)})`}
            >
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
              <MenuItem icon="edit" onClick={() => setNaming(fork)}>
                {shownName === undefined ? `Name ${shownLabel}…` : `Rename “${shownLabel}”…`}
              </MenuItem>
              <MenuItem icon="trash" tone="danger" onClick={() => void remove(fork)}>
                Delete {shownName === undefined ? shownLabel : `“${shownLabel}”`}
              </MenuItem>
              <MenuItem icon="right" onClick={() => onJump(fork.slotId)}>
                Go to message #{fork.depth + 1}
              </MenuItem>
            </MenuGroup>
          )
        })}
        {!complete && (
          <p className="px-2.5 py-1.5 text-xs text-muted">
            Looked for branches in the last {FORK_SCAN_LIMIT.toLocaleString()} messages.
          </p>
        )}
      </Menu>
      <NameDialog
        open={naming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setNaming(null)
            write.clear()
          }
        }}
        title={`Name branch ${(naming?.branchIndex ?? 0) + 1} at message #${(naming?.depth ?? 0) + 1}`}
        label="Branch name"
        initial={(naming && nameOf(naming)) ?? ""}
        description="Shown instead of “Branch k” in this menu. Leave it empty to take the name off."
        maxLength={100}
        pending={write.pending}
        error={write.error}
        onSave={async (name) => {
          if (naming === null) return
          const result = await write.run(() => session.nameBranch(naming.slotId, name))
          if (!result.ok) return
          setNames((current) => new Map(current).set(naming.slotId, result.value.branchName ?? null))
          setNaming(null)
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
    setOpen(true)
    const result = await session.call((client) => client("ListGroupChats", { chatId: view.chat!.id }))
    setGroup(result.ok ? result.value : null)
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
            <span className="truncate">{shown}</span>
            <Icon
              name="edit"
              size={14}
              className="shrink-0 text-muted group-hover/title:text-accent"
            />
          </button>
        </Tooltip>
      </h1>
      <NameDialog
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
                    description: `It leaves “${group.group.name}” and gets a tile of its own on Characters.`
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
  onJump
}: {
  session: ChatSession
  view: ChatView
  /** The chat's own buttons (its cast, notes, settings), at the end of the line. */
  actions: ReactNode
  onBranch: (entry: PathEntry, index: number) => void
  onJump: (slotId: SlotId) => void
}) {
  const characters = castCharacters(view)
  const name = view.chat ? chatName(importState(view.chat.title).title, characters) : null
  useTitle(name?.name ?? "Chat")
  const names = characters.map((card) => card.name)
  const others = names.filter((n) => n !== name?.name)
  const about = [
    others.length > 0 ? others.join(", ") : null,
    name?.started ? `started ${formatDay(name.started)}` : null
  ].filter(Boolean)
  return (
    <TooltipProvider>
      <header className="mx-auto flex w-full max-w-3xl min-w-0 items-center gap-1.5 pb-2 sm:gap-3">
        <Tooltip label="All chats">
          <Link
            to="/chats"
            aria-label="Chats"
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name="back" />
          </Link>
        </Tooltip>
        {characters.length > 0 && (
          <Tooltip label={names.join(", ")}>
            <span
              tabIndex={0}
              className="relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <AvatarStack
                size="md"
                faces={characters.map((card) => ({ id: card.entityId, name: card.name, mediaId: card.avatarMediaId }))}
              />
              {characters.length > 1 && (
                <span className="absolute -right-1 -bottom-1 rounded-full border border-canvas bg-surface-raised px-1 text-[0.625rem] leading-4 font-medium text-muted tabular-nums sm:hidden">
                  {characters.length}
                </span>
              )}
              <span className="sr-only">{names.join(", ")}</span>
            </span>
          </Tooltip>
        )}
        <div className="flex min-w-16 sm:min-w-24 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <ChatTitle session={session} view={view} name={name} />
            {view.chat && <ChatBadges chat={view.chat} />}
          </div>
          {about.length > 0 && <p className="truncate text-xs text-muted max-sm:hidden">{about.join(" · ")}</p>}
        </div>
        <BranchMenu session={session} view={view} onBranch={onBranch} onJump={onJump} />
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-0.5 max-sm:[&_button]:px-1.5 max-sm:[&_button]:text-xs">
          {actions}
        </div>
      </header>
    </TooltipProvider>
  )
}
