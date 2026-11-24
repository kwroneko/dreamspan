import { useOpenPlace } from "../editor/durable.tsx"
import { archivedCardActions, cardSearchExtras } from "./homeSlots.ts"
import { MessageSortControl, sidebarMessageResults, sidebarSearchTools, useMessageSearch } from "./MessageSearch.tsx"
import { useSplitChats } from "../chat/splitChats.ts"
import { requestSplitReveal, useSplitReveal, useSplitRevealRequest } from "../chat/splitReveal.ts"
import type { ChatBrowse } from "@dreamspan/shared/chatBrowse.ts"
import { useChatBrowse } from "./useChatBrowse.ts"
import { sidebarChatBrowse } from "./ChatBrowseBar.tsx"
import { chatName, formatDay, formatWhen } from "../chat/chatTitle.ts"
import type { ChatId, EntityId } from "@dreamspan/shared/chat.ts"
import { branchMatches } from "@dreamspan/shared/branchNaming.ts"
import { importState } from "@dreamspan/shared/stImportApi.ts"
import { Link, useNavigate, useParams, useRouter, useSearch } from "@tanstack/react-router"
import { OPEN_BESIDE_HINT, openBeside, useCanOpenBeside } from "../workbench/OpenBeside.tsx"
import { openOnPlainClick } from "../../ui/links.ts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { SHELL_SECTION_LIMIT, type ShellSection } from "@dreamspan/shared/chatSetupApi.ts"
import { useMemo, useRef, useState } from "react"
import { carryLink, CHAT_DRAG } from "../../ui/appDrags.ts"
import { ContextMenu, MenuItem } from "../../ui/Menu.tsx"
import { AsyncView, ErrorAlert, FailureView, useAction } from "../../actions.tsx"
import type { ForkId } from "@dreamspan/shared/chat.ts"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { forksChanged } from "../chat/forks.ts"
import { SplitChatDialog } from "../chat/SplitChatDialog.tsx"
import { Avatar, PortraitOverflow } from "../../ui/Avatar.tsx"
import { useSession } from "../../session.ts"
import { rememberedPanel } from "../chat/ChatPanels.tsx"
import { useWide } from "../chat/ChatPanels.tsx"
import { Button } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { IconButton, PICTURE_TOGGLE, Tooltip } from "../../ui/Tooltip.tsx"
import { forkLabel, formatMoment, OPENS_HERE_HINT } from "../chat/forks.ts"
import { Badge } from "../../ui/Surface.tsx"
import { rowActionInsetClass } from "../../ui/rowSpacing.ts"
import { browseCards, mixesPersonas, useGroupedFamilies } from "./cardBrowse.tsx"
import { useSidebarBrowse } from "./useSidebarBrowse.ts"
import { CardBrowseBar } from "./CardBrowseBar.tsx"
import { CardGridEmpty } from "./CardGridEmpty.tsx"
import { SourceResults, useSourceBrowse } from "../cardSources/browse.tsx"
import { SourceChips, SourceFiltersPanel } from "../cardSources/filters.tsx"
import { GroupGrid, useGroupsSwitch } from "./GroupGrid.tsx"
import { GroupFaces } from "./GroupFaces.tsx"
import { characterChatActions, sidebarChatStarts, sidebarFoot } from "./homeSlots.ts"
import { StartRow } from "./NewCharacterChat.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { Loading, LoadingProgress, PlaceholderBar } from "../../ui/Spinner.tsx"
import { ResizeHandle } from "../../ui/ResizeHandle.tsx"
import { WindowedList } from "../../ui/WindowedList.tsx"
import { listNames } from "../chat/cast.ts"
import { chatRowAbout } from "../chat/presentation.tsx"
import { KindBadge } from "../chat/KindBadge.tsx"
import { TextThenBadges } from "../chat/RowBadges.tsx"
import { kindRowProps, useChatKindLook } from "../chat/kindLooks.ts"
import { SidebarFeet, useBranchHeight } from "./useBranchHeight.tsx"
import {
  CharacterGrid,
  PAGE_ROWS,
  scopeSearch,
  browsable,
  shellAtom,
  sidebarCleared,
  useShellForks,
  useShellNavigation,
  type ShellFork
} from "./shellData.tsx"

export function PinButton({
  fork,
  branch = false,
  className = ""
}: {
  fork: ShellFork
  branch?: boolean
  className?: string
}) {
  const action = useAction()
  const pinned = branch ? fork.pinned : fork.chatPinned
  return (
    <span className="shrink-0">
      {/* A pin, filled when pinned: the star is a favourite character's (cardBrowse.tsx). */}
      <IconButton
        label={`${pinned ? "Unpin" : "Pin"} ${branch ? fork.name : fork.chatName}`}
        icon="pin"
        filled={pinned}
        aria-pressed={pinned}
        hint={
          branch
            ? pinned
              ? "Click to unpin this branch within this chat"
              : "Click to pin this branch above the other branches in this chat"
            : pinned
              ? "Click to remove this chat from Pinned"
              : "Click to add this chat to Pinned"
        }
        disabled={action.pending}
        className={`${pinned ? "text-text!" : ""} ${className}`}
        onClick={() =>
          void action.run(
            (client) =>
              branch
                ? client("PinFork", { forkId: fork.forkId as ForkId, pinned: !pinned })
                : client("SetChatPin", { chatId: fork.chat.id, leaf: null, pinned: !pinned }),
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
function useOpenFork(fork: ShellFork, scopeChat: boolean, splitNavigation = false) {
  const navigate = useNavigate()
  // Read at the click: subscribing would re-render every row with each switch of the chat panel's tab.
  const router = useRouter()
  const navigation = useShellNavigation()
  const userId = useSession().user.id
  const wide = useWide()
  const open = () => {
    navigation.picked()
    if (splitNavigation) requestSplitReveal(fork.chat.id)
    // A list changes only the middle. Keep a character tab while that character is in the
    // chat, played by the model or by the user; else This chat.
    const inUrl = (router.state.location.search as { panel?: unknown }).panel
    const previous = (typeof inUrl === "string" ? inUrl : undefined) ?? (wide ? rememberedPanel(userId) : null)
    const id = previous?.startsWith("card:") ? (previous.slice(5) as EntityId) : null
    const panel = id !== null && (!fork.joined.includes(id) || fork.departed.includes(id)) ? "chat" : previous
    void navigate({
      to: "/chats/$chatId",
      params: { chatId: fork.sourceChatId ?? fork.chat.id },
      search: {
        ...sidebarCleared,
        ...scopeSearch(
          splitNavigation
            ? { entity: null, chat: null }
            : scopeChat
              ? { entity: null, chat: fork.chat.id }
              : navigation.scope
        ),
        ...(navigation.grid && !scopeChat ? { side: "characters" } : {}),
        fork: fork.forkId,
        ...(panel ? { panel } : {})
      }
    })
  }
  return open
}
/** A chat's row dragged out: dropped on a frame, the chat opens there on the row's branch, as a click does. */
const carryChat = carryLink(CHAT_DRAG.id)
/** Where a fork's row links: the chat on that fork (a plain click opens it with the panel's place). */
const forkLink = (fork: ShellFork) => ({
  to: "/chats/$chatId" as const,
  params: { chatId: fork.sourceChatId ?? fork.chat.id },
  search: { fork: fork.forkId }
})

export function GroupTile({ fork }: { fork: ShellFork }) {
  const open = useOpenFork(fork, true)
  return (
    <div className="tile-toggle-surface relative flex flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <Tooltip label="Opens this chat.">
        <Link
          {...forkLink(fork)}
          onClick={openOnPlainClick(open)}
          onDragStart={carryChat}
          data-layout-audit-ignore="inset: Whole group tile is the open control"
          aria-label={`Open chat ${fork.chatName}`}
          className="flex w-full flex-1 flex-col text-left"
        >
          <span className="aspect-[2/3] w-full">
            {fork.chat.picture ? (
              <Avatar id={fork.chat.id} name={fork.chatName} mediaId={fork.chat.picture} size="fill" />
            ) : (
              <GroupFaces members={fork.cast} />
            )}
          </span>
          <span className="flex w-full min-w-0 flex-1 flex-col gap-1 p-2.5">
            <span
              className="line-clamp-2 text-sm font-medium text-ellipsis break-normal [overflow-wrap:normal]"
              title={fork.chatName}
            >
              {fork.chatName}
            </span>
            {/* The faces show who; their names are in the tooltip. */}
            <span className="text-xs text-muted" title={fork.cast.map((c) => c.label).join(", ")}>
              {fork.cast.length} {fork.cast.length === 1 ? "member" : "members"}
            </span>
            {fork.branches > 1 && <span className="mt-auto text-xs text-muted">{fork.branches} branches</span>}
          </span>
        </Link>
      </Tooltip>
      <span data-layout-overlay="Pin action sits over the group portrait" className="absolute right-2 top-2">
        <PinButton fork={fork} className={PICTURE_TOGGLE} />
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

/** Branch lists longer than this get a filter field (the branch menu's too). */
const BRANCH_FILTER_FROM = 6
/** What a branch filter looks through: the row's name (a thread's, else the branch's) and its last message. */
const shellBranchTexts = (fork: ShellFork) => [
  fork.thread ? shellThreadLabel(fork.thread) : shellBranchLabel(fork),
  fork.preview
]

/**
 * "⑂ 12" at a chat row's end (owner, 2026-11-01): replaces the panel's list with the chat's
 * branches, opening nothing in the middle.
 */
function BranchesButton({ fork, entity = null }: { fork: ShellFork; entity?: EntityId | null }) {
  const { setScope } = useShellNavigation()
  if (fork.branches < 2) return null
  return (
    <Tooltip label={`Show this chat's ${fork.branches} branches`}>
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

/** Makes the selected branch its own chat, after the explanatory confirmation (owner, 2026-11-05). */
function SplitBranchButton({ fork, label }: { fork: ShellFork; label: string }) {
  // A URL place (editor/durable.tsx): a reload opens the dialog again, with the name as typed.
  const [open, setOpen] = useOpenPlace(`split-chat:${fork.forkId}`)
  return (
    <>
      <IconButton
        label={`Make ${label} its own chat`}
        hint="Moves this branch and the branches made from it into a chat of their own."
        icon="split"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      />
      {open && (
        <SplitChatDialog
          chatId={fork.sourceChatId ?? fork.chat.id}
          forkId={fork.forkId as ForkId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** Branch-list content shares the row's open target without nesting rename controls in it. */
/**
 * A row of the Threads group (spec/THREADS.md §13.6): its thread's name, else its characters'
 * names. Renamed where its threads are listed in the header, never as a branch here.
 */
const shellThreadLabel = (thread: NonNullable<ShellFork["thread"]>) =>
  thread.name ?? (listNames(thread.cast.map((card) => card.name)) || "Thread")

function BranchListRow({ fork, here, open }: { fork: ShellFork; here: boolean; open: () => void }) {
  const action = useAction()
  const [renaming, setRenaming] = useState(false)
  const [menu, setMenu] = useState(false)
  const href = useRouter().buildLocation(forkLink(fork)).href
  const canBeside = useCanOpenBeside()
  const thread = fork.thread
  const kindLook = useChatKindLook(fork.chat.kind)
  const kindLabel = kindLook?.badge ? `, ${kindLook.badge.label}` : ""
  const label = thread ? shellThreadLabel(thread) : shellBranchLabel(fork)
  const kind = thread ? "thread" : "branch"
  const addedNames = `Added characters: ${fork.added.map((c) => c.name).join(", ")}`
  // Not read yet (a cold library's first pass): its name if it has one, quiet bars for the
  // rest, in the lines' own boxes, so the row keeps its height as it fills in.
  const pending = fork.pending === true
  // Keep the boxes a cold row reserved until it unmounts. Its added characters
  // are unknown until the pass reaches it; revealing them must not move the list.
  const [reserveAdded, setReserveAdded] = useState(pending)
  if (pending && !reserveAdded) setReserveAdded(true)
  const nameless = pending && !fork.named && !fork.original
  const title = nameless ? <PlaceholderBar className="inline-block w-28 align-middle" /> : label
  const openLabel = nameless ? `Open ${kind}, still loading` : `Open ${kind} ${label}${kindLabel}`
  const body = pending ? (
    <>
      <span className="block min-h-8 pt-1">
        <PlaceholderBar className="w-full" />
        <PlaceholderBar className="mt-2 w-2/3" />
      </span>
      <span data-row-when className="block min-h-4 pt-1">
        <PlaceholderBar className="w-24" />
      </span>
    </>
  ) : (
    <>
      <span className="line-clamp-2 min-h-8 text-xs text-muted [overflow-wrap:anywhere]">
        {fork.preview || "No messages yet"}
      </span>
      {/* A workshop's badge right after the date, never in the title's line (owner, 2026-11-18). */}
      <span data-row-when className="block text-xs text-muted [overflow-wrap:anywhere]">
        <TextThenBadges text={`Last message ${formatMoment(fork.endAt ?? fork.createdAt)}`}>
          <KindBadge kind={fork.chat.kind} size="sm" />
        </TextThenBadges>
      </span>
    </>
  )
  return (
    <div
      data-fork-row
      data-fork-pending={pending || undefined}
      data-reserve-added={reserveAdded || undefined}
      {...kindRowProps(kindLook)}
      onClick={(event) => {
        // A dialog opened from the row is portalled elsewhere; its clicks still bubble here.
        const target = event.target as HTMLElement
        if (event.currentTarget.contains(target) && !target.closest("button, input, a, [data-added-portraits]")) open()
      }}
      className={`fork-row branch-list-row @container/fork-row relative grid w-full shrink-0 max-w-controls min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border p-2 ${here ? "border-accent bg-surface-raised" : "border-border hover:bg-surface-raised"}`}
    >
      {reserveAdded && fork.added.length === 0 && (
        <span aria-hidden="true" data-added-space className="pointer-events-none block h-7.5 w-24" />
      )}
      {fork.added.length > 0 && (
        <Tooltip label={addedNames}>
          <span
            data-added-portraits
            data-row-portraits
            tabIndex={0}
            aria-label={addedNames}
            data-layout-audit-ignore="overlap: The overflow count is tucked behind the second full portrait; gap: The count tile intentionally overlaps the second portrait"
            className="relative flex shrink-0 items-center gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <span aria-hidden="true" className="text-xs text-muted">
              +
            </span>
            {fork.added.slice(0, 2).map((c) => (
              <Avatar
                key={c.entityId}
                id={c.entityId}
                name={c.name}
                mediaId={c.avatarMediaId}
                crop={c.avatarCrop}
                size="xs"
              />
            ))}
            <PortraitOverflow remaining={fork.added.length - 2} size="xs" className="branch-added-overflow" />
          </span>
        </Tooltip>
      )}
      <div data-row-text className="min-w-0">
        <div data-branch-title-line className="flex h-5 min-w-0 items-center gap-x-1 text-sm">
          {here && !thread ? (
            <InlineRename
              place={`branch-list:${fork.forkId}`}
              compact
              value={fork.named ? fork.name : ""}
              label={`branch ${label}`}
              hint="Renames this branch."
              allowEmpty
              maxLength={100}
              className={renaming ? "min-w-0 flex-1" : "min-w-0"}
              onEditingChange={setRenaming}
              placeholder="Branch name"
              onRename={async (name) => {
                const result = await action.run(
                  (client) => client("NameFork", { forkId: fork.forkId as ForkId, name }),
                  ["chats"]
                )
                if (result.ok) forksChanged(fork.sourceChatId ?? fork.chat.id)
                return result.ok
              }}
            >
              <span data-chat-title data-layout-name className="min-w-0 truncate font-medium">
                {title}
              </span>
            </InlineRename>
          ) : (
            <span data-chat-title data-layout-name className="min-w-0 flex-1 truncate font-medium">
              {title}
            </span>
          )}
          {!renaming && <SlotOutlet slot={chatRowAbout} props={{ chat: fork.chat }} />}
          {/* While renaming, the field takes the whole title line (owner, 2026-11-05). */}
          {fork.current && fork.branches > 1 && !renaming && (
            <span data-opens-here className="flex shrink-0">
              <Badge>opens here</Badge>
            </span>
          )}
        </div>
        <ContextMenu
          label={nameless ? `Actions for this ${kind}` : `Actions for ${kind} ${label}`}
          open={menu}
          onOpenChange={setMenu}
          trigger={
            <Tooltip
              label={`Opens this ${kind}${here ? ", shown now" : ""}.${fork.current && fork.branches > 1 ? ` ${OPENS_HERE_HINT}` : ""}${pending ? " Its last message is still loading." : ""}`}
            >
              {thread ? (
                <Link
                  {...forkLink(fork)}
                  onClick={openOnPlainClick(open)}
                  aria-label={openLabel}
                  aria-current={here ? "page" : undefined}
                  aria-busy={pending || undefined}
                  data-chat-id={fork.chat.id}
                  data-fork-id={fork.forkId}
                  className="block w-full min-w-0 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {body}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={open}
                  aria-label={openLabel}
                  aria-current={here ? "page" : undefined}
                  aria-busy={pending || undefined}
                  data-chat-id={fork.chat.id}
                  data-fork-id={fork.forkId}
                  className="block w-full min-w-0 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {body}
                </button>
              )}
            </Tooltip>
          }
        >
          <MenuItem icon={thread ? "threads" : "branch"} description="Opens it here, as a click does." onClick={open}>
            Open
          </MenuItem>
          {canBeside && (
            <MenuItem icon="split-right" description={OPEN_BESIDE_HINT} onClick={() => openBeside(href)}>
              Open beside
            </MenuItem>
          )}
          <MenuItem
            icon="external"
            description="Opens it in a new browser tab."
            onClick={() => window.open(href, "_blank", "noopener")}
          >
            Open in a new browser tab
          </MenuItem>
        </ContextMenu>
      </div>
      {/* The corners of a chat row (owner, 2026-11-05): the pin at the top; at the bottom, where a
          chat row lists its branches, Split off, on the selected branch only. */}
      <div
        data-row-actions
        data-layout-overlay="Corner actions share the full-width open control in narrow branch rows"
        className="flex shrink-0 flex-col items-end justify-between self-stretch"
      >
        <PinButton fork={fork} branch />
        {here && !fork.original && !thread && <SplitBranchButton fork={fork} label={label} />}
      </div>
      {action.error && (
        <span
          role="alert"
          className="absolute inset-x-2 top-full z-10 rounded border border-danger bg-surface p-1 text-xs text-danger"
        >
          {action.error.message}
        </span>
      )}
    </div>
  )
}

/**
 * A chat row's portraits while it is pending, and after, until it unmounts: two portrait boxes
 * and the count tile's sliver, whatever the cast turns out to be, so reading it moves nothing
 * (the tile is one width for every count).
 * The chat's own picture is known at once and fills the first box; read faces fill both; a box
 * left over stays empty. Pending boxes without a picture are quiet bars.
 */
function ReservedPortraits({ fork, pending }: { fork: ShellFork; pending: boolean }) {
  const picture = fork.chat.picture
  const faces = picture ? [] : fork.cast.slice(0, 2)
  const remaining = fork.cast.length - 2
  const count = !picture && remaining > 0
  const names = `Characters: ${fork.cast.map((c) => c.name).join(", ")}`
  return (
    <Tooltip label={names} enabled={!pending}>
      <span
        tabIndex={pending ? undefined : 0}
        aria-hidden={pending || undefined}
        aria-label={pending ? undefined : names}
        data-row-portraits
        data-reserved-portraits
        data-layout-audit-ignore="overlap: The count tile sits partly behind the last fully visible portrait; gap: Portraits have a positive gap while the count tile intentionally overlaps the last portrait"
        className="relative flex w-fit shrink-0 gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {[0, 1].map((i) => {
          const face = faces[i]
          return (
            <span key={i} data-portrait-slot className="h-12 w-8 shrink-0">
              {i === 0 && picture ? (
                <Avatar id={fork.chat.id} name={fork.chatName} mediaId={picture} size="md" />
              ) : face ? (
                <Avatar
                  id={face.entityId}
                  name={face.name}
                  mediaId={face.avatarMediaId}
                  crop={face.avatarCrop}
                  size="md"
                />
              ) : pending && !picture ? (
                <span className="block h-full w-full rounded-sm bg-border" />
              ) : null}
            </span>
          )
        })}
        <PortraitOverflow
          remaining={count ? remaining : 1}
          fixedWidth
          className={`fork-row-overflow${count ? "" : " invisible"}`}
        />
      </span>
    </Tooltip>
  )
}

export function ForkRow({
  fork,
  scopeChat = false,
  splitNavigation = false,
  details = false,
  here = false,
  perFork = false,
  branchOnly = false,
  entity = null,
  relation = null
}: {
  fork: ShellFork
  /** One line under the preview saying how this chat relates to the open one (Related chats). */
  relation?: readonly [string, string] | null
  scopeChat?: boolean
  splitNavigation?: boolean
  details?: boolean
  /** The row is this fork (a chat's branches), not its chat (a list of chats). */
  perFork?: boolean
  /** Among its chat's branches only: the branch's own label, without the chat's name or faces. */
  branchOnly?: boolean
  /** The fork open in the middle: marked, so the list says where you are. */
  here?: boolean
  /** The character the list is scoped to, kept when "⑂ 12" lists a chat's branches. */
  entity?: EntityId | null
}) {
  const open = useOpenFork(fork, scopeChat, splitNavigation)
  const besideHref = useRouter().buildLocation(forkLink(fork)).href
  const canBeside = useCanOpenBeside()
  const [menu, setMenu] = useState(false)
  const kindLook = useChatKindLook(fork.chat.kind)
  const kindBadge = kindLook?.badge
  // A row that was pending keeps the boxes it reserved (two portraits and the count's sliver)
  // until it unmounts: its cast is unknown until the pass reaches it, and arriving must move
  // neither the row nor its text. A picture is known at once and shows in the first box.
  const [reservePortraits, setReservePortraits] = useState(fork.pending === true)
  if (fork.pending === true && !reservePortraits) setReservePortraits(true)
  if (branchOnly) return <BranchListRow fork={fork} here={here} open={open} />
  const label = fork.thread ? `Thread: ${shellThreadLabel(fork.thread)}` : shellBranchLabel(fork)
  // Not read yet (a cold library's first pass): its chat's name when that doesn't come from
  // its cast (the server sends none then), quiet bars for the rest, in the lines' own boxes.
  const pending = fork.pending === true
  // A row for a chat shows its name; one among its chat's branches, the branch's label. Where
  // rows of several chats mix, the chat's name, with a named branch's name after it
  // and an unnamed one's label under it once the chat has more than one.
  const title = branchOnly
    ? label
    : perFork && (fork.thread || fork.named)
      ? `${fork.chatName} › ${label}`
      : fork.chatName
  const nameless = pending && fork.chatName === ""
  const shownTitle = nameless ? "this chat" : title
  const branchLine = !branchOnly && perFork && !fork.thread && !fork.named && fork.branches > 1 ? label : null
  const last = perFork ? (fork.endAt ?? fork.createdAt) : fork.chatRecentAt
  // The branch its chat opens on, among several, as the header's list marks it.
  const opensHere = perFork && fork.current && fork.branches > 1
  return (
    <div
      data-fork-row
      data-fork-pending={pending || undefined}
      {...kindRowProps(kindLook)}
      className={`fork-row @container/fork-row relative flex w-full shrink-0 max-w-controls min-w-0 items-center gap-1 rounded-md border py-2 ps-2 ${rowActionInsetClass} hover:bg-surface-raised ${here ? "border-accent bg-surface-raised" : "border-border"}`}
    >
      <ContextMenu
        label={`Actions for ${shownTitle}`}
        open={menu}
        onOpenChange={setMenu}
        trigger={
          <Tooltip
            label={
              <span className="[overflow-wrap:anywhere]">
                {`${nameless ? "Still loading" : title}. ${
                  perFork
                    ? `Opens this ${fork.thread ? "thread" : "branch"}${here ? ", shown now" : ""}.${opensHere ? ` ${OPENS_HERE_HINT}` : ""}`
                    : "Opens the chat on the branch you last used."
                }${canBeside ? " Right-click to open it beside." : ""}`}
              </span>
            }
          >
            <Link
              {...forkLink(fork)}
              onClick={openOnPlainClick(open)}
              onDragStart={carryChat}
              aria-label={
                nameless
                  ? `Open ${branchOnly ? "branch" : "chat"}, still loading`
                  : `Open ${branchOnly ? "branch" : "chat"} ${title}${kindBadge ? `, ${kindBadge.label}` : ""}`
              }
              aria-current={here ? "page" : undefined}
              aria-busy={pending || undefined}
              data-chat-id={fork.chat.id}
              data-fork-id={fork.forkId}
              className="fork-row-open flex min-w-0 flex-1 items-center self-stretch gap-2 rounded p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {!branchOnly && reservePortraits && <ReservedPortraits fork={fork} pending={pending} />}
              {!branchOnly && !reservePortraits && (
                <Tooltip label={`Characters: ${fork.cast.map((c) => c.name).join(", ")}`}>
                  <span
                    tabIndex={0}
                    aria-label={`Characters: ${fork.cast.map((c) => c.name).join(", ")}`}
                    data-row-portraits
                    data-layout-audit-ignore="overlap: The count tile sits partly behind the last fully visible portrait; gap: Portraits have a positive gap while the count tile intentionally overlaps the last portrait"
                    className="relative flex w-fit shrink-0 gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {fork.chat.picture ? (
                      // Keep the same reserved slots at every container breakpoint. Only the
                      // first holds the picture, so its portrait cutout keeps its shape.
                      <>
                        {Array.from({ length: Math.max(1, Math.min(2, fork.cast.length)) }, (_, i) => (
                          <span key={i} data-portrait-slot className="h-12 w-8 shrink-0">
                            {i === 0 && (
                              <Avatar
                                id={fork.chat.id}
                                name={fork.chatName}
                                mediaId={fork.chat.picture ?? null}
                                size="md"
                              />
                            )}
                          </span>
                        ))}
                        <PortraitOverflow
                          remaining={fork.cast.length - 2}
                          fixedWidth
                          className="fork-row-overflow invisible"
                        />
                      </>
                    ) : (
                      <>
                        {fork.cast.length === 0 && <span data-portrait-slot className="h-12 w-8 shrink-0" />}
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
                        <PortraitOverflow remaining={fork.cast.length - 2} fixedWidth className="fork-row-overflow" />
                      </>
                    )}
                  </span>
                </Tooltip>
              )}
              <span data-row-text className="flex min-w-0 flex-1 flex-col self-stretch">
                {/* Two lines: beside the portraits one line leaves imported names unrecognizable. */}
                <span
                  data-chat-title
                  className="line-clamp-2 text-sm text-ellipsis break-normal [overflow-wrap:normal]"
                >
                  <span className="font-medium">
                    {nameless ? <PlaceholderBar className="inline-block w-32 align-middle" /> : title}
                  </span>
                </span>
                {branchLine !== null && (
                  <span
                    className="line-clamp-2 text-xs text-ellipsis break-normal [overflow-wrap:normal]"
                    title={branchLine}
                  >
                    {branchLine}
                  </span>
                )}
                {details && fork.cast.length > 1 && (
                  <span className="line-clamp-2 text-xs text-muted [overflow-wrap:anywhere]">
                    with {fork.cast.map((c) => c.label).join(", ")}
                  </span>
                )}
                {details && !pending && (
                  <span data-chat-meta className="text-xs text-muted [overflow-wrap:anywhere]">
                    started{" "}
                    {formatDay(
                      chatName(importState(fork.chat.title).title, fork.cast, fork.chat.createdAt ?? null).started ??
                        new Date(fork.createdAt)
                    )}{" "}
                    · {fork.messages.toLocaleString()} {fork.messages === 1 ? "message" : "messages"}
                  </span>
                )}
                {details && pending && (
                  <span data-chat-meta className="block min-h-4 pt-1">
                    <PlaceholderBar className="w-36" />
                  </span>
                )}
                {pending ? (
                  <span className="block min-h-8 pt-1">
                    <PlaceholderBar className="w-full" />
                    <PlaceholderBar className="mt-2 w-2/3" />
                  </span>
                ) : (
                  <span className="line-clamp-2 min-h-8 text-xs text-muted [overflow-wrap:anywhere]">
                    {fork.preview || "No messages yet"}
                  </span>
                )}
                {relation !== null && (
                  <span data-row-relation className="text-xs text-muted">
                    {/* Wraps only between its two parts. */}
                    <span className="whitespace-nowrap">{relation[0]}</span> ·{" "}
                    <span className="whitespace-nowrap">{relation[1]}</span>
                  </span>
                )}
                {pending ? (
                  <span data-row-when className="mt-auto block min-h-4 pt-1">
                    <PlaceholderBar className="w-24" />
                  </span>
                ) : (
                  // The badges (Workshop, opens here) right after the date, out of the title's flow, so
                  // the title wraps and clamps as any other's and the row is no taller (owner, 2026-11-18).
                  <span data-row-when className="mt-auto block text-xs text-muted">
                    <TextThenBadges text={perFork ? `Last message ${formatMoment(last)}` : formatWhen(last)}>
                      <KindBadge kind={fork.chat.kind} inLink size="sm" />
                      {opensHere && (
                        <span data-opens-here className="inline-flex align-top">
                          <Badge size="sm">opens here</Badge>
                        </span>
                      )}
                    </TextThenBadges>
                  </span>
                )}
              </span>
            </Link>
          </Tooltip>
        }
      >
        <MenuItem icon="chat" description="Opens it here, as a click does." onClick={open}>
          Open
        </MenuItem>
        {canBeside && (
          <MenuItem icon="split-right" description={OPEN_BESIDE_HINT} onClick={() => openBeside(besideHref)}>
            Open beside
          </MenuItem>
        )}
        <MenuItem
          icon="external"
          description="Opens it in a new tab of the browser."
          onClick={() => window.open(besideHref, "_blank", "noopener")}
        >
          Open in a new browser tab
        </MenuItem>
      </ContextMenu>
      <div
        data-row-actions
        data-layout-overlay="Corner actions share the full-width open control in narrow chat rows"
        className="my-1 flex shrink-0 flex-col items-end justify-between self-stretch"
      >
        <PinButton fork={fork} branch={perFork} />
        {!perFork && <BranchesButton fork={fork} entity={entity} />}
      </div>
    </div>
  )
}

/**
 * The open chat's branches at the bottom of the left panel, below whatever it lists (owner,
 * 2026-11-01): switch branches without leaving the list above; its header lists them as the
 * panel's list instead. Collapsed or expanded per device.
 */
const shellForkKey = (fork: ShellFork) => fork.forkId

export function OpenChatBranches() {
  const scrollOffset = useRef(0)
  const params = useParams({ strict: false }) as { chatId?: string }
  const shown = useSearch({ strict: false, select: (s: { fork?: string }) => s.fork })
  const { scope, setScope, grid } = useShellNavigation()
  const split = useSplitChats((params.chatId ?? null) as ChatId | null, shown)
  const chatId = split?.group.id ?? ((params.chatId ?? null) as ChatId | null)
  const forks = useShellForks({
    entity: null,
    chat: chatId,
    search: "",
    sort: "recent",
    sections: [
      { id: "threads", limit: 5000 },
      { id: "pinnedBranches", limit: 5000 },
      { id: "peers", limit: 5000 },
      { id: "other", limit: 5000 }
    ]
  })
  // Threads first, under a heading of their own, then the branches (spec/THREADS.md §13.6).
  const threads = forks.section("threads").rows
  const pinned = forks.section("pinnedBranches").rows
  const peers = forks.section("peers").rows
  const other = forks.section("other").rows
  const nextRows = useMemo(() => [...threads, ...pinned, ...peers, ...other], [threads, pinned, peers, other])
  // Uncached per-chat reads used to remove the section, stretching the list above it.
  // Commit split metadata and branch rows together; keep the outgoing section meanwhile.
  const [last, setLast] = useState<{
    chatId: ChatId
    rows: typeof nextRows
    split: typeof split
    shown: typeof shown
  } | null>(null)
  const ready = split !== null && !forks.loading
  if (
    ready &&
    chatId !== null &&
    (last?.chatId !== chatId || last.split !== split || last.rows !== nextRows || last.shown !== shown)
  )
    setLast({ chatId, rows: nextRows, split, shown })
  const rows = ready ? nextRows : (last?.rows ?? [])
  const displayedChat = ready ? chatId : last?.chatId
  const displayedFork = ready ? shown : last?.shown
  const waiting = !ready
  const visible = params.chatId !== undefined && !grid && scope.chat !== displayedChat && rows.length > 0
  const { height, min, max, change, reset, collapsed, expanded, toggle } = useBranchHeight("branch")
  const open = expanded && !collapsed
  // Every branch is read already (limit 5000 a section), so the filter asks the server nothing.
  // Kept for one chat: another chat's branches start unfiltered.
  const [typed, setTyped] = useState<{ chatId: ChatId | null | undefined; text: string }>({ chatId: null, text: "" })
  const query = typed.chatId === displayedChat ? typed.text : ""
  const setQuery = (text: string) => setTyped({ chatId: displayedChat, text })
  const filterable = rows.length > BRANCH_FILTER_FROM
  const shownRows = useMemo(
    () => (filterable && query.trim() !== "" ? rows.filter((f) => branchMatches(query, shellBranchTexts(f))) : rows),
    [rows, filterable, query]
  )
  if (!visible) return null
  // Empty while its name waits for a fork's cast the first pass hasn't read (shellReads.ts).
  const chatLabel = rows[0]!.chatName || "this chat"
  return (
    <section
      inert={waiting}
      aria-busy={waiting}
      aria-label="Branches of the open chat"
      data-foot-section="branch"
      data-foot-list="true"
      data-foot-wanted={expanded}
      style={open ? { height } : undefined}
      className={`relative flex min-h-0 shrink-0 flex-col border-t border-border pt-2 ${open ? "gap-1" : ""}`}
    >
      {open && (
        <div className="absolute inset-x-0 top-0">
          <ResizeHandle
            label="Resize chats and branches"
            axis="y"
            direction={-1}
            width={height}
            min={min}
            max={max}
            onChange={change}
            onReset={reset}
            hint="Drag to resize the chat list and branch viewer, or use the up and down arrow keys (Shift for bigger steps), Home and End. Double-click resets."
          />
        </div>
      )}
      {/* The same 8 px gutters as the list above (layoutlint), so these rows line up with its rows. */}
      <div data-foot-header className="flex max-w-controls min-w-0 shrink-0 items-center gap-1 px-2">
        <Tooltip
          label={open ? "Click to hide the open chat's branches." : "Click to show the open chat's branches here."}
        >
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-semibold text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name={open ? "down" : "right"} size={14} className="shrink-0" />
            <span className="truncate">
              {rows[0]!.thread ? "Threads and branches" : "Branches"} of {chatLabel} ({rows.length.toLocaleString()})
            </span>
          </button>
        </Tooltip>
        {/* In the header's own line, so the rows don't move when it goes. */}
        {ready && forks.progress && (
          <LoadingProgress
            noun="branches"
            ready={forks.progress.ready}
            total={forks.progress.total}
            className="shrink-0"
          />
        )}
        <IconButton
          label="List these branches in the panel"
          hint="Show these branches in the sidebar"
          icon="expand"
          onClick={() => setScope({ entity: null, chat: displayedChat ?? null })}
        />
      </div>
      {open && filterable && (
        <div className="max-w-controls shrink-0 px-2">
          <Tooltip label="Shows the branches whose name or last message has these words.">
            <Input
              type="search"
              aria-label="Find a branch"
              placeholder="Find a branch"
              className="h-8 w-full min-w-0"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </Tooltip>
        </div>
      )}
      {open && shownRows.length === 0 && <p className="px-3 py-1 text-xs text-muted">No branch has those words.</p>}
      {open ? (
        <WindowedList
          data-foot-body
          items={shownRows}
          itemKey={shellForkKey}
          initialOffset={() => scrollOffset.current}
          onScroll={(event) => {
            scrollOffset.current = event.currentTarget.scrollTop
          }}
          className="min-h-0 flex-1 overflow-y-auto px-2 [scrollbar-gutter:stable]"
          renderItem={(f, i) => {
            // With threads listed, each group has its heading.
            const grouped = shownRows[0]?.thread !== undefined
            const heading =
              grouped && (i === 0 || (shownRows[i - 1]!.thread !== undefined) !== (f.thread !== undefined))
                ? f.thread
                  ? "Threads"
                  : "Branches"
                : null
            return (
              <>
                {heading && (
                  <h3 className={`mb-1 truncate px-1 text-xs font-semibold text-muted ${i === 0 ? "" : "pt-2"}`}>
                    {heading}
                  </h3>
                )}
                <ForkRow
                  key={f.forkId}
                  fork={f}
                  perFork
                  branchOnly
                  here={displayedFork ? f.forkId === displayedFork : f.current}
                />
              </>
            )
          }}
        />
      ) : (
        <div data-foot-body inert aria-hidden style={{ height: 0, maxHeight: 0, visibility: "hidden" }} />
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
    <Tooltip label="Loads more chats.">
      <button type="button" onClick={onMore} className="mt-1 self-start px-2 py-1 text-xs text-accent">
        Show {Math.min(rest, PAGE_ROWS).toLocaleString()} more of {rest.toLocaleString()}
      </button>
    </Tooltip>
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
  browse,
  onSortChange
}: {
  pinsCollapsed: boolean
  entity?: EntityId | null
  chat?: ChatId | null
  home?: boolean
  browse?: ChatBrowse | undefined
  sortBy?: ShellSort
  onSortChange?: (sort: ShellSort) => void
}) {
  const [localSort, setSort] = useState<ShellSort>("recent")
  const params = useParams({ strict: false }) as { chatId?: string }
  const shown = useSearch({ strict: false, select: (s: { fork?: string }) => s.fork })
  const selected = useSplitChats((params.chatId ?? null) as ChatId | null, shown)?.group.id ?? params.chatId
  const sort = sortBy ?? localSort
  const [limit, setLimit] = useState(PAGE_ROWS)
  const action = useAction()
  const open = !home || !pinsCollapsed
  const forks = useShellForks({
    entity,
    chat,
    search: "",
    sort,
    ...(browse ? { browse } : {}),
    sections: [{ id: "pinned", limit }]
  })
  const pins = forks.section("pinned")
  if (!pins.total) return null
  return (
    <section aria-label="Pinned chats" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          hint={
            home
              ? pinsCollapsed
                ? "Click to show pinned chats."
                : "Click to hide pinned chats."
              : "Opens pinned chats."
          }
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
            <ForkRow key={`${fork.chat.id}/${fork.forkId}`} fork={fork} here={fork.chat.id === selected} />
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
  // Pinned, named, then the rest, each by last message; the one the chat opens on is
  // marked where it is (owner, 2026-11-01).
  chat: [
    ["threads", "Threads"],
    ["pinnedBranches", "Pinned branches"],

    ["peers", "Named branches"],
    ["other", "Branches"]
  ]
} as const satisfies Record<string, ReadonlyArray<readonly [ShellSection, string]>>

function Browser() {
  const result = useAtomValue(shellAtom)
  const data = AsyncResult.isSuccess(result) ? result.value : undefined
  const { scope, setScope, grid, setGrid } = useShellNavigation()
  const [browse, setBrowse] = useSidebarBrowse()
  const [chatBrowse, setChatBrowse] = useChatBrowse()
  const search = browse.search
  // Switching to Groups, the tab before stays until the groups are read (useGroupsSwitch).
  const tabs = useGroupsSwitch(browse)
  const grouped = useGroupedFamilies(tabs.shown, search)
  const setSearch = (search: string) => setBrowse({ search })
  // A card source shown in the character grid; asked nothing unless it's shown (§5.1).
  const sources = useSourceBrowse(grid ? tabs.shown.source : null, tabs.shown.remote, (remote, options) =>
    setBrowse({ remote }, options)
  )
  const source = grid ? sources.info : null
  const params = useParams({ strict: false }) as { chatId?: string }
  const shown = useSearch({ strict: false, select: (s: { fork?: string }) => s.fork })
  const selected = useSplitChats((params.chatId ?? null) as ChatId | null, shown)?.group.id ?? params.chatId
  const listRef = useRef<HTMLDivElement>(null)
  const card = data && [...data.cards, ...data.personas].find((c) => c.card.entityId === scope.entity)
  const cardLabel = card ? card.card.label : data ? "Character not found" : "…"
  const needle = search.trim().toLowerCase()
  const kind = scope.chat ? "chat" : scope.entity ? "character" : "all"
  // The search looks through message text (MessageSearch.tsx): in the list of all chats or a character's.
  const [inMessages] = useMessageSearch()
  const messages = inMessages && !grid && kind !== "chat"
  const sections = SECTIONS[kind]
  // A chat's branches have a filter of their own, kept for that chat: the words that found the
  // chat by its name would match none of its branches.
  const [branchTyped, setBranchTyped] = useState<{ chat: string | null; text: string }>({ chat: null, text: "" })
  const branching = kind === "chat" && !grid
  const branchText = branchTyped.chat === scope.chat ? branchTyped.text : ""
  const fieldValue = branching ? branchText : search
  const setField = branching ? (text: string) => setBranchTyped({ chat: scope.chat, text }) : setSearch
  const listNeedle = branching ? branchText.trim().toLowerCase() : needle
  // Each list's length, by scope and search: another scope or search starts from its first page.
  const listKey = `${scope.entity}/${scope.chat}/${listNeedle}/${JSON.stringify(chatBrowse)}`
  const [limits, setLimits] = useState<{ key: string; limits: Partial<Record<ShellSection, number>> }>({
    key: listKey,
    limits: {}
  })
  const limitOf = (id: ShellSection) => (limits.key === listKey ? (limits.limits[id] ?? PAGE_ROWS) : PAGE_ROWS)
  const setLimit = (id: ShellSection, limit: number) =>
    setLimits({
      key: listKey,
      limits: { ...(limits.key === listKey ? limits.limits : {}), [id]: limit }
    })
  const reveal = useSplitRevealRequest(selected)
  const through = kind === "all" && !grid && !messages ? (reveal?.id as ChatId | undefined) : undefined
  const forks = useShellForks({
    entity: scope.entity,
    chat: scope.chat as ChatId | null,
    search: messages ? "" : listNeedle,
    sort: "recent",
    ...(!grid && kind !== "chat" ? { browse: chatBrowse } : {}),
    sections: sections.map(([id]) => ({
      id,
      limit: limitOf(id),
      ...(id === "chats" && through !== undefined ? { through } : {})
    }))
  })
  const revealedRows = forks.section("chats").rows
  if (through && !forks.waiting && revealedRows.length > limitOf("chats")) setLimit("chats", revealedRows.length)
  // The chat by its name, which all its branches share; kept while a filter lists none of them.
  const chatRows = scope.chat ? sections.flatMap(([id]) => forks.section(id).rows) : []
  const chat = chatRows[0]
  const [knownChat, setKnownChat] = useState<{ id: string; name: string } | null>(null)
  if (chat && (knownChat?.id !== chat.chat.id || knownChat.name !== chat.chatName))
    setKnownChat({ id: chat.chat.id, name: chat.chatName })
  // The lists show once their rows are read: a cold library's cards wait for every fork's
  // walk, which the rows don't (they fill in as it goes).
  useSplitReveal(listRef, forks.loading ? null : reveal)
  // Subscribe to rows alongside cards, before displaying either. Waiting for cards
  // first can put the rows in another epoch behind unrelated browsing work.
  if (!data && grid)
    return (
      <AsyncView atom={shellAtom} loading="Loading chats…" still="Still loading your chats…">
        {() => null}
      </AsyncView>
    )
  const filteredOut = branching && listNeedle !== ""
  const chatLabel = chat
    ? chat.chatName || "…"
    : filteredOut && knownChat?.id === scope.chat
      ? knownChat.name
      : forks.loading
        ? "…"
        : "Chat not found"
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
              here={f.chat.id === selected && (kind !== "chat" || (shown ? f.forkId === shown : f.current))}
            />
          ))}
          <ShowMore
            shown={rows.length}
            total={Math.min(total, SHELL_SECTION_LIMIT)}
            onMore={() => setLimit(id, Math.min(SHELL_SECTION_LIMIT, rows.length + PAGE_ROWS))}
          />
        </section>
      )
    )
  }
  const none = !forks.loading && sections.every(([id]) => forks.section(id).total === 0)
  const sideCards = grid && data && !source ? browseCards(browsable(data), tabs.shown, needle) : []
  const archivedView = grid && !source && tabs.shown.filter === "archived"
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="@container/leftsearch max-w-controls">
        <div className="grid items-center gap-2 @min-[26rem]/leftsearch:grid-cols-[11rem_minmax(14rem,1fr)]">
          <Segmented
            label="Left panel"
            className="w-full! [&>button]:min-w-0 [&>button]:flex-1 [&>button]:basis-0 [&>button]:justify-center"
            value={grid ? "characters" : "chats"}
            onValueChange={(v) => setGrid(v === "characters")}
            options={[
              { value: "chats", label: "Chats" },
              { value: "characters", label: "Characters" }
            ]}
          />
          {source ? (
            <Input
              type="search"
              aria-label={`Search ${source.name}`}
              placeholder={`Search ${source.name}`}
              className="min-w-0"
              value={sources.remote.text}
              onChange={(e) => sources.change({ text: e.currentTarget.value })}
            />
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <Input
                aria-label={
                  grid
                    ? "Find a character"
                    : messages
                      ? "Find in messages"
                      : kind === "chat"
                        ? "Find a branch"
                        : "Find a chat"
                }
                placeholder={
                  messages ? "Find in messages" : kind === "chat" && !grid ? "Find a branch" : "Find by name"
                }
                clearable
                frameClassName="min-w-0 flex-1"
                value={fieldValue}
                onChange={(e) => setField(e.currentTarget.value)}
              />
              {kind !== "chat" && <SlotOutlet slot={sidebarSearchTools} props={{ grid }} />}
            </div>
          )}
        </div>
      </div>
      {!grid && listNeedle !== "" && forks.progress && (
        <p role="note" className="text-xs text-muted">
          Until every {kind === "chat" ? "branch" : "chat"} has loaded, the ones still loading are found by name only.
        </p>
      )}
      {!grid && kind !== "chat" && (
        <SlotOutlet
          slot={sidebarChatBrowse}
          props={{
            browse: chatBrowse,
            counts: forks.progress ? null : forks.filterCounts,
            onChange: setChatBrowse,
            ...(messages ? { sort: <MessageSortControl /> } : {})
          }}
        />
      )}
      {grid && data && (
        <CardBrowseBar
          data={data}
          browse={browse}
          onChange={setBrowse}
          groups
          includePersonas
          families
          sources={sources}
          onSource={(id) => setBrowse({ source: id })}
          filtersId="side-source-filters"
        />
      )}
      {/* Below every filter row, directly above the list it navigates. In All chats too, as where
          you are, so the list starts at the same height in every scope (owner, 2026-11-24). */}
      {!grid && (
        <nav aria-label="Chat breadcrumbs" className="flex min-w-0 items-center gap-1 text-sm">
          {kind === "all" ? (
            <span aria-current="location" className="shrink-0 font-medium">
              All chats
            </span>
          ) : (
            <Tooltip label="Back to the list of all your chats.">
              <button
                type="button"
                className="shrink-0 text-accent hover:underline"
                onClick={() => setScope({ entity: null, chat: null })}
              >
                All chats
              </button>
            </Tooltip>
          )}
          {scope.entity && (
            <>
              <span aria-hidden className="shrink-0 text-muted">
                ›
              </span>
              {scope.chat ? (
                <Tooltip label={`Back to ${cardLabel}'s chats.`}>
                  <button
                    type="button"
                    data-layout-name
                    className="min-w-0 truncate text-accent hover:underline"
                    onClick={() => setScope({ entity: scope.entity, chat: null })}
                  >
                    {cardLabel}
                  </button>
                </Tooltip>
              ) : (
                <span
                  aria-current="location"
                  data-layout-name
                  className="min-w-0 truncate font-medium"
                  title={cardLabel}
                >
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
              <span aria-current="location" data-layout-name className="min-w-0 truncate font-medium" title={chatLabel}>
                {chatLabel}
              </span>
            </>
          )}
          {/* On the breadcrumbs' own line, so the rows don't move when it goes. */}
          {forks.progress && kind !== "all" && (
            <LoadingProgress
              noun={kind === "chat" ? "branches" : "chats"}
              ready={forks.progress.ready}
              total={forks.progress.total}
              className="ms-auto shrink-0"
            />
          )}
        </nav>
      )}
      {/* The gutter is kept whether or not it scrolls, so the list never shifts, with a gap before the bar. */}
      <div
        ref={listRef}
        data-shell-list
        className={`@container min-h-0 flex-1 overflow-y-auto px-2 [scrollbar-gutter:stable] ${grid && !source ? "-mt-2 pt-2 scroll-py-2" : ""}`}
      >
        {grid && tabs.groups && (
          <GroupGrid
            needle={needle}
            sort={browse.sort}
            reversed={browse.reversed}
            className="grid grid-cols-2 gap-2 @sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]"
            {...tabs.groups}
          />
        )}
        {grid && source ? (
          // The source's cards only: never mixed with the user's (spec/CARD-SOURCES.md §3.2).
          <div className="flex min-w-0 flex-col gap-2 py-2">
            <SourceFiltersPanel browse={sources} id="side-source-filters" sidebar />
            <SourceChips browse={sources} />
            <SourceResults
              browse={sources}
              className="grid grid-cols-2 gap-2 @sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]"
            />
          </div>
        ) : grid && data ? (
          // Two tiles a row at the sidebar's usual width, more as it widens (8.5rem each at least).
          <>
            {tabs.characters && (
              <>
                <CharacterGrid
                  cards={sideCards}
                  sort={tabs.shown.sort}
                  markPersonas={mixesPersonas(tabs.shown)}
                  families={
                    grouped ? { expanded: tabs.shown.family, onToggle: (family) => setBrowse({ family }) } : undefined
                  }
                  className="grid grid-cols-2 gap-2 @sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]"
                >
                  {!sideCards.length && <CardGridEmpty filter={tabs.shown.filter} needle={needle} place="sidebar" />}
                </CharacterGrid>
                {/* With archived cards shown, their actions follow the last tile: no row above the grid. */}
                {archivedView && sideCards.length > 0 && (
                  <div className="pt-3">
                    <SlotOutlet slot={archivedCardActions} props={{ place: "sidebar" }} />
                  </div>
                )}
                <SlotOutlet
                  slot={cardSearchExtras}
                  props={{ data, browse: tabs.shown, search: needle, className: "grid grid-cols-2 gap-2" }}
                />
              </>
            )}
          </>
        ) : messages ? (
          <div className="max-w-controls pt-2 pb-2">
            <SlotOutlet
              slot={sidebarMessageResults}
              props={{ text: search, filter: chatBrowse.filter, entity: scope.entity }}
            />
          </div>
        ) : (
          // One column of rows; dragged wide, a row stays a row's width, its pin beside its text.
          <div className="max-w-controls">
            {kind === "character" && card && (
              <StartRow characterLabel={cardLabel}>
                <SlotOutlet slot={characterChatActions} props={{ entityId: card.card.entityId, label: cardLabel }} />
              </StartRow>
            )}
            {/* In the slot a character's New Roleplay has, as tall: side by side, stacked where they don't fit. */}
            {kind === "all" && (
              <StartRow>
                <SlotOutlet slot={sidebarChatStarts} props={{}} />
              </StartRow>
            )}
            {/* A chat's own pins are among its named and pinned branches. */}
            {kind !== "chat" && data && (
              <PinnedChats
                pinsCollapsed={data.pinsCollapsed}
                browse={chatBrowse}
                entity={scope.entity}
                sortBy={browse.pinsSort}
                onSortChange={(pinsSort) => setBrowse({ pinsSort })}
              />
            )}
            {sections.map(([id, title]) =>
              section(id, id === "just" ? `Just ${card?.card.label ?? "this character"}` : title)
            )}
            {forks.loading && !forks.failure && <Loading label="Still loading your chats…" />}
            <ListFailure forks={forks} />
            {none && (
              <p className="p-2 text-sm text-muted">
                {filteredOut ? "No branch has those words." : "No chats here yet."}
              </p>
            )}
          </div>
        )}
      </div>
      <SidebarFeet>
        <SlotOutlet slot={sidebarFoot} props={{}} />
      </SidebarFeet>
    </div>
  )
}
export function ShellBrowser() {
  // Holds the panel's height while loading too, so the navigation below doesn't jump.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Browser />
    </div>
  )
}
