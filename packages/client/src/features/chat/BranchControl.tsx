// The header's branch control (DESIGN §3.2; registered as `chat.branches` in
// `chatBranchControls`): "Branch: From #14 ▾" whenever the chat has more than one branch. It
// lists every branch (its name, its last message's first words, when it was last chatted in),
// the one shown marked, and switches, renames, pins and deletes them. The UI says "branch" for
// what the data model calls a fork. A popover on a wide screen, a sheet on a phone; the chat's ⋯
// menu opens the same list (`requestBranches`), in a dialog while the header shows no control.
// Its rows are the left panel's branch rows (ShellBrowser `BranchListRow`): the same box, title
// line, preview, time and corner actions, grouped as the panel groups them (branchmenu).
import { branchMatches } from "@rp/shared/branchNaming.ts"
import type { Fork, SlotId } from "@rp/shared/chat.ts"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import { useAction } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { openOnPlainClick } from "../../ui/links.ts"
import { WindowedList } from "../../ui/WindowedList.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { type BranchControlContext, useBranchParts } from "./branchParts.ts"
import { sidebarCleared } from "../characters/shellData.tsx"
import {
  type BranchGroup,
  branchGroup,
  branchLabel,
  branchLastAt,
  formatMoment,
  OPENS_HERE_HINT,
  orderBranches,
  useBranchesRequest,
  forksChanged,
  useChatForks
} from "./forks.ts"
import type { ChatSession, ChatView } from "./session.ts"
import { useNarrow } from "./VersionPicker.tsx"

export interface BranchControlProps {
  readonly session: ChatSession
  readonly view: ChatView
  /** Opens the chat at a message of the fork shown. */
  readonly onJump: (slotId: SlotId) => void
}

/** The left panel's headings for the same groups. */
const GROUP_TITLES: Record<BranchGroup, string> = {
  pinned: "Pinned branches",
  named: "Named branches",
  other: "Branches"
}
const forkKey = (fork: Fork) => fork.id
/** Lists longer than this get a filter field. */
const BRANCH_FILTER_FROM = 6

/**
 * One branch: the row opens it; the pencil after its name renames it in place; the corners pin
 * it (top) and delete it (bottom), as the left panel's rows have their actions.
 */
function BranchRow({
  fork,
  label,
  shown,
  only,
  link,
  onSwitch,
  onRename,
  onPin,
  onDelete
}: {
  fork: Fork
  label: string
  shown: boolean
  only: boolean
  /** Where the row's link goes: a middle or modified click opens the branch in a new tab. */
  link: { readonly chatId: string; readonly search: Readonly<Record<string, string>> }
  onSwitch: () => void
  onRename: (name: string) => Promise<boolean>
  onPin: () => void
  onDelete: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const pinned = fork.pinnedAt !== null
  return (
    <div
      data-fork={fork.id}
      data-branch-row
      onClick={(event) => {
        // The title line isn't inside the open link (its pencil is a button of its own).
        const target = event.target as HTMLElement
        if (event.currentTarget.contains(target) && !target.closest("button, input, a")) onSwitch()
      }}
      className={`relative grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border p-2 ${shown ? "border-accent bg-surface-raised" : "border-border hover:bg-surface-raised"}`}
    >
      <div data-row-text className="min-w-0">
        <div data-branch-title-line className="flex h-5 min-w-0 items-center gap-x-1 text-sm">
          <InlineRename
            compact
            value={fork.name ?? ""}
            label={label}
            fieldLabel={`Name of branch ${label}`}
            hint="Renames this branch."
            allowEmpty
            maxLength={100}
            placeholder="Branch name"
            className={renaming ? "min-w-0 flex-1" : "min-w-0"}
            onEditingChange={setRenaming}
            onRename={onRename}
          >
            <span className="min-w-0 truncate font-medium">{label}</span>
          </InlineRename>
          {fork.current && !renaming && (
            <Tooltip label={OPENS_HERE_HINT}>
              <span
                data-opens-here
                tabIndex={0}
                className="ms-auto flex shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Badge>opens here</Badge>
              </span>
            </Tooltip>
          )}
        </div>
        <Tooltip label={`Opens this branch${shown ? ", shown now" : ""}.`}>
          <Link
            to="/chats/$chatId"
            params={{ chatId: link.chatId }}
            search={link.search}
            // Marked current only when it is the branch shown, not whenever the chat's path matches.
            activeOptions={{ exact: true, includeSearch: true }}
            aria-current={shown || undefined}
            aria-label={`${label}${shown ? ", shown" : ""}${fork.current ? ", the chat opens here" : ""}${pinned ? ", pinned" : ""}: ${fork.tipExcerpt.slice(0, 80) || "no messages"}`}
            onClick={openOnPlainClick(onSwitch)}
            className="block w-full min-w-0 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <span className="line-clamp-2 min-h-8 text-xs text-muted [overflow-wrap:anywhere]">
              {fork.tipExcerpt || "No messages yet"}
            </span>
            <span data-row-when className="block text-xs text-muted tabular-nums">
              Last message {formatMoment(branchLastAt(fork))}
            </span>
          </Link>
        </Tooltip>
      </div>
      <div
        data-row-actions
        data-layout-overlay="Corner actions share the row's open area"
        className="flex shrink-0 flex-col items-end justify-between self-stretch"
      >
        <IconButton
          label={`${pinned ? "Unpin" : "Pin"} ${label}`}
          hint={
            pinned
              ? "Click to unpin this branch within this chat"
              : "Click to pin this branch above the other branches in this chat"
          }
          icon="pin"
          filled={pinned}
          aria-pressed={pinned}
          className={pinned ? "text-text!" : ""}
          onClick={onPin}
        />
        <IconButton
          label={`Delete ${label}`}
          hint={
            only
              ? "The only branch: delete the chat instead"
              : "Moves this branch to the bin, from which it can be restored later."
          }
          icon="trash"
          tone="danger"
          disabled={only}
          focusableWhenDisabled
          onClick={onDelete}
        />
      </div>
    </div>
  )
}

/** A footer action: one row each, icon first, as a menu's items. Unavailable ones stay, greyed. */
function FooterAction({
  icon,
  hint,
  disabled = false,
  onClick,
  children
}: {
  icon: IconName
  hint: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      variant="ghost"
      hint={hint}
      disabled={disabled}
      focusableWhenDisabled
      onClick={onClick}
      className="h-8 w-full min-w-0 justify-start! gap-2! px-2! font-normal!"
    >
      <Icon name={icon} size={16} className="shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </Button>
  )
}

/** The list itself, wherever it's shown. */
function BranchList({
  session,
  view,
  forks,
  shown,
  onJump,
  onDone
}: BranchControlProps & {
  forks: ReadonlyArray<Fork> | null
  shown: Fork | undefined
  onDone: () => void
}) {
  const parts = useBranchParts()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { panel?: string }
  const deleted = useDeletedToast()
  const pins = useAction()
  const [failure, setFailure] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const keepPanel = search.panel ? { panel: search.panel } : {}
  if (forks === null) return <p className="px-1 py-2 text-sm text-muted">Loading the branches…</p>
  const live = forks.length
  // A part may list some forks apart (another thread's, spec/THREADS.md §13.2): never as branches.
  const context: BranchControlContext = { session, view, forks, shown }
  const sections = parts.flatMap((part) => (part.Section ? [{ id: part.id, Section: part.Section }] : []))
  const listed = orderBranches(
    forks.filter((fork) => fork.id === shown?.id || parts.every((part) => part.listed?.(fork, context) ?? true))
  )
  // The list is already read whole (ListForks), so filtering it asks the server nothing.
  const filterable = listed.length > BRANCH_FILTER_FROM
  const ordered = filterable
    ? listed.filter((fork) => branchMatches(query, [branchLabel(fork), fork.tipExcerpt]))
    : listed
  const groups = new Set(ordered.map(branchGroup))
  // The URL names a branch only while it isn't the one the chat opens on.
  const linkSearch = (fork: Fork) =>
    fork.id === view.chat?.currentForkId ? keepPanel : { ...keepPanel, fork: fork.id }
  const open = (fork: Fork) => {
    onDone()
    if (fork.id === shown?.id) return
    void navigate({
      to: ".",
      search: linkSearch(fork)
    })
  }
  const rename = async (fork: Fork, name: string) => {
    const result = await session.call((client) => client("NameFork", { forkId: fork.id, name }))
    setFailure(result.ok ? null : result.error.message)
    if (!result.ok) return false
    forksChanged(session.id)
    return true
  }
  const pin = async (fork: Fork) => {
    const result = await pins.run(
      (client) => client("PinFork", { forkId: fork.id, pinned: fork.pinnedAt === null }),
      ["pins"]
    )
    setFailure(result.ok ? null : result.error.message)
    if (result.ok) forksChanged(session.id)
  }
  const remove = async (fork: Fork) => {
    const isShown = fork.id === shown?.id
    // The fork shown is the one deleted, and only it (owner, 2026-10-27): forks made from it keep
    // their history, the chat opens on the one chatted in last, and Undo brings it back.
    const result = isShown
      ? await session.deleteFork(fork.id)
      : await session.call((client) => client("DeleteFork", { forkId: fork.id }))
    if (!result.ok) return showToast({ title: "Couldn't delete the branch", description: result.error.message })
    deleted(result.value, () => forksChanged(session.id))
    forksChanged(session.id)
    // With one branch left the header has no control to anchor the list: it closes.
    if (live <= 2) onDone()
    // The old URL names the branch that went: keep the panel, follow the latest branch.
    if (isShown) void navigate({ to: ".", search: keepPanel, replace: true })
  }
  const start = shown?.startSlotId ?? shown?.baseSlotId ?? null
  const latest = forks.find((f) => f.current)
  // ST's "Back to parent chat": the branch this one was made from, while it's live.
  const parent = shown?.parentForkId ? forks.find((f) => f.id === shown.parentForkId) : undefined
  const atLatest = latest === undefined || latest.id === shown?.id
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sections.map(({ id, Section }) => (
        <Section key={id} {...context} onDone={onDone} />
      ))}
      {filterable && (
        <Tooltip label="Shows the branches whose name or last message has these words.">
          <Input
            type="search"
            aria-label="Find a branch"
            placeholder="Find a branch"
            className="mb-1 h-8 min-w-0 shrink-0"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </Tooltip>
      )}
      {ordered.length === 0 && <p className="px-1 py-2 text-sm text-muted">No branch has those words.</p>}
      {/* The rows' 8 px gutter is inside the scrollport, so focus rings and borders aren't cut. */}
      <WindowedList
        items={ordered}
        itemKey={forkKey}
        initialIndex={Math.max(
          0,
          ordered.findIndex((fork) => fork.id === shown?.id)
        )}
        listLabel="Branches"
        data-branch-scroll
        className="-mx-3 min-h-0 flex-1 overflow-y-auto px-3 py-1"
        renderItem={(fork, i) => {
          const group = branchGroup(fork)
          // Under a section of a part's, the list is titled even with one group.
          const heading =
            (groups.size > 1 || sections.length > 0) && (i === 0 || branchGroup(ordered[i - 1]!) !== group)
          const label = branchLabel(fork)
          return (
            <>
              {heading && (
                <h3 className={`mb-1 truncate px-1 text-xs font-semibold text-muted ${i === 0 ? "" : "pt-2"}`}>
                  {GROUP_TITLES[group]}
                </h3>
              )}
              <BranchRow
                key={fork.id}
                fork={fork}
                label={label}
                shown={fork.id === shown?.id}
                only={live <= 1}
                link={{ chatId: session.id, search: linkSearch(fork) }}
                onSwitch={() => open(fork)}
                onRename={(name) => rename(fork, name)}
                onPin={() => void pin(fork)}
                onDelete={() => void remove(fork)}
              />
            </>
          )
        }}
      />
      {failure !== null && (
        <p role="alert" className="pt-2 text-xs text-danger">
          {failure}
        </p>
      )}
      <div className="-mx-3 mt-2 flex flex-col gap-0.5 border-t border-border px-3 pt-2">
        <FooterAction
          icon="home"
          hint={atLatest ? "This is the branch the chat opens on." : OPENS_HERE_HINT}
          disabled={atLatest}
          onClick={() => latest && open(latest)}
        >
          Back to the branch the chat opens on
        </FooterAction>
        <FooterAction
          icon="back"
          hint={
            parent ? "The branch this one was made from." : "This branch wasn't made from another that's still here."
          }
          disabled={parent === undefined}
          onClick={() => parent && open(parent)}
        >
          {parent ? <>Back to “{branchLabel(parent)}”</> : "Back to the branch this one was made from"}
        </FooterAction>
        <FooterAction
          icon="branch"
          hint={
            start !== null
              ? "Shows the message this branch was made at."
              : "This branch starts at the chat's first message."
          }
          disabled={start === null}
          onClick={() => {
            if (start === null) return
            onDone()
            onJump(start)
          }}
        >
          Go to where this branch starts
        </FooterAction>
        <Tooltip label="Show this chat's branches in the sidebar.">
          <Link
            to="."
            className={`${buttonClass("ghost")} h-8 w-full min-w-0 justify-start! gap-2! px-2! font-normal!`}
            onClick={onDone}
            search={(prev: Record<string, unknown>) => ({ ...prev, ...sidebarCleared, forks: session.id })}
          >
            <Icon name="sidebar" size={16} className="shrink-0" />
            <span className="min-w-0 truncate">Show in the left panel</span>
          </Link>
        </Tooltip>
        <p className="px-2 pt-1 text-xs text-muted">
          {live <= 1 ? "The only branch: delete the chat instead. " : ""}To start another, choose Branch from here in a
          message&rsquo;s menu.
        </p>
      </div>
    </div>
  )
}

/** The branch trigger stays disabled before a second branch exists; the menu can still open its list. */
export function BranchControl(props: BranchControlProps) {
  const { session, view } = props
  const { forks, shown, reload } = useChatForks(session, view)
  const parts = useBranchParts()
  const narrow = useNarrow()
  const [open, setOpen] = useState(false)
  const request = useBranchesRequest()
  const [answered, setAnswered] = useState(request)
  if (request !== answered) {
    setAnswered(request)
    if (request?.chatId === session.id) setOpen(true)
  }
  useEffect(() => {
    if (open) reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again each time it opens
  }, [open])
  // A part may name what's shown otherwise: "Thread: At the docks".
  const context: BranchControlContext | null = forks === null ? null : { session, view, forks, shown }
  const ready = context !== null && parts.every((part) => part.ready?.(context) ?? true)
  const many = ready && forks !== null && forks.length > 1
  const named = !ready ? null : (parts.map((part) => part.trigger?.(context) ?? null).find(Boolean) ?? null)
  const kind = named?.kind ?? "Branch"
  const icon = named?.icon ?? "branch"
  const label = !ready ? "Loading…" : (named?.label ?? (shown ? branchLabel(shown) : "Branch"))
  // Sending in a branch that isn't the one the chat opens on makes it that; the header says which it is.
  const off = shown !== undefined && !shown.current
  // Its place in the list as the list orders it.
  const ordered = forks === null ? [] : orderBranches(forks)
  const place = `${shown && forks ? `${ordered.indexOf(shown) + 1} of ${forks.length}` : ""}${off ? ", not the one the chat opens on" : ""}`
  const title = "Branches of this chat"
  const body = <BranchList {...props} forks={forks} shown={shown} onDone={() => setOpen(false)} />
  if (narrow)
    return (
      <>
        <Button
          variant="ghost"
          disabled={!many}
          focusableWhenDisabled
          hint={
            named
              ? named.hint
              : many
                ? "Switches between this chat’s branches."
                : !ready
                  ? "Loading…"
                  : "No other branches yet."
          }
          type="button"
          aria-label={!ready ? "Loading…" : `${kind}: ${label}, ${place}: switch ${kind.toLowerCase()}`}
          onClick={() => setOpen(true)}
          className="inline-flex h-8 max-w-32 min-w-7 shrink! items-center gap-1 rounded-md px-1.5 text-sm text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Icon name={icon} size={16} />
          <span className="truncate">{label}</span>
        </Button>
        <Sheet open={open} onOpenChange={setOpen} title={title}>
          <div className="flex min-h-0 flex-1 flex-col px-3 py-3">{body}</div>
        </Sheet>
      </>
    )
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <>
          <Icon name={icon} size={14} className="shrink-0" />
          {/* A narrow header (a split frame) keeps the icon, the name moving to the explanation:
              never a name cut to a letter or two. */}
          <span className="min-w-16 truncate @max-[32rem]/header:hidden">
            {ready && <span className="text-muted @max-[40rem]/header:hidden">{kind}: </span>}
            {label}
            {off && <span className="text-xs text-muted"> · not where it opens</span>}
          </span>
          <Icon name="down" size={14} className="shrink-0 text-muted" />
        </>
      }
      triggerLabel={!ready ? "Loading…" : `${kind}: ${label}, ${place}: switch ${kind.toLowerCase()}`}
      triggerDisabled={!many}
      hint={
        !ready
          ? "Loading…"
          : named
            ? named.hint
            : `Branch “${label}”${off ? " (not where the chat opens)" : ""}. ${many ? "Switch to another of this chat’s branches, or rename or delete them." : "No other branches yet."}`
      }

      hintSide="bottom"
      triggerClassName="inline-flex h-8 max-w-72 min-w-0 shrink! items-center gap-1.5 rounded-md border border-border px-2 text-sm text-text outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus data-popup-open:bg-surface-raised"
      title={title}
      side="bottom"
      align="end"
      wide
      tall
    >
      {body}
    </Popover>
  )
}
