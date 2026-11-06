import { useSplitChats } from "../chat/splitChats.ts"
import { requestSplitReveal, useSplitReveal } from "../chat/splitReveal.ts"
import type { ChatBrowse } from "@rp/shared/chatBrowse.ts"
import { useChatBrowse } from "./useChatBrowse.ts"
import { sidebarChatBrowse } from "./ChatBrowseBar.tsx"
import { chatName, formatDay, formatWhen } from "../chat/chatTitle.ts"
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Link, useNavigate, useParams, useRouter, useSearch } from "@tanstack/react-router"
import { OpenBesideButton } from "../workbench/OpenBeside.tsx"
import { openOnPlainClick } from "../../ui/links.ts"
import { useAtomRefresh } from "@effect/atom-react"
import type { ShellSection } from "@rp/shared/chatSetupApi.ts"
import { useMemo, useRef, useState } from "react"
import { AsyncView, ErrorAlert, FailureView, useAction } from "../../actions.tsx"
import type { ForkId } from "@rp/shared/chat.ts"
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
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { forkLabel, formatMoment, OPENS_HERE_HINT } from "../chat/forks.ts"
import { Badge } from "../../ui/Surface.tsx"
import { rowActionInsetClass } from "../../ui/rowSpacing.ts"
import { browseCards, mixesPersonas } from "./cardBrowse.tsx"
import { useSidebarBrowse } from "./useSidebarBrowse.ts"
import { CardBrowseBar } from "./CardBrowseBar.tsx"
import { GroupGrid } from "./GroupGrid.tsx"
import { GroupFaces } from "./GroupFaces.tsx"
import { characterChatActions, sidebarFoot } from "./homeSlots.ts"
import { SlotOutlet } from "../../slots.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { ResizeHandle } from "../../ui/ResizeHandle.tsx"
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
  type ShellFork,
  type ShellLibrary
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
          data-layout-audit-ignore="inset: Whole group tile is the open control"
          aria-label={`Open chat ${fork.chatName}`}
          className="flex w-full flex-1 flex-col text-left"
        >
          <span className="aspect-[2/3] w-full">
            <GroupFaces members={fork.cast} />
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
  const [open, setOpen] = useState(false)
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
function BranchListRow({ fork, here, open }: { fork: ShellFork; here: boolean; open: () => void }) {
  const action = useAction()
  const [renaming, setRenaming] = useState(false)
  const label = shellBranchLabel(fork)
  const addedNames = `Added characters: ${fork.added.map((c) => c.name).join(", ")}`
  return (
    <div
      data-fork-row
      onClick={(event) => {
        // A dialog opened from the row is portalled elsewhere; its clicks still bubble here.
        const target = event.target as HTMLElement
        if (event.currentTarget.contains(target) && !target.closest("button, input, [data-added-portraits]")) open()
      }}
      className={`fork-row branch-list-row @container/fork-row relative grid w-full shrink-0 max-w-controls min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border p-2 ${here ? "border-accent bg-surface-raised" : "border-border hover:bg-surface-raised"}`}
    >
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
          {here ? (
            <InlineRename
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
              <span data-chat-title className="min-w-0 truncate font-medium">
                {label}
              </span>
            </InlineRename>
          ) : (
            <span data-chat-title className="min-w-0 flex-1 truncate font-medium">
              {label}
            </span>
          )}
          {/* While renaming, the field takes the whole title line (owner, 2026-11-05). */}
          {fork.current && fork.branches > 1 && !renaming && (
            <span data-opens-here className="flex shrink-0">
              <Badge>opens here</Badge>
            </span>
          )}
        </div>
        <Tooltip
          label={`Opens this branch${here ? ", shown now" : ""}.${fork.current && fork.branches > 1 ? ` ${OPENS_HERE_HINT}` : ""}`}
        >
          <button
            type="button"
            onClick={open}
            aria-label={`Open branch ${label}`}
            aria-current={here ? "page" : undefined}
            data-chat-id={fork.chat.id}
            data-fork-id={fork.forkId}
            className="block w-full min-w-0 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <span className="line-clamp-2 min-h-8 text-xs text-muted [overflow-wrap:anywhere]">
              {fork.preview || "No messages yet"}
            </span>
            <span data-row-when className="block text-xs text-muted [overflow-wrap:anywhere]">
              Last message {formatMoment(fork.endAt ?? fork.createdAt)}
            </span>
          </button>
        </Tooltip>
      </div>
      {/* The corners of a chat row (owner, 2026-11-05): the pin at the top; at the bottom, where a
          chat row lists its branches, Split off, on the selected branch only. */}
      <div
        data-row-actions
        data-layout-overlay="Corner actions share the full-width open control in narrow branch rows"
        className="flex shrink-0 flex-col items-end justify-between self-stretch"
      >
        <PinButton fork={fork} branch />
        {here && !fork.original && <SplitBranchButton fork={fork} label={label} />}
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
  if (branchOnly) return <BranchListRow fork={fork} here={here} open={open} />
  const label = shellBranchLabel(fork)
  // A row for a chat shows its name; one among its chat's branches, the branch's label. Where
  // rows of several chats mix, the chat's name, with a named branch's name after it
  // and an unnamed one's label under it once the chat has more than one.
  const title = branchOnly ? label : perFork && fork.named ? `${fork.chatName} › ${fork.name}` : fork.chatName
  const branchLine = !branchOnly && perFork && !fork.named && fork.branches > 1 ? label : null
  const last = perFork ? (fork.endAt ?? fork.createdAt) : fork.chatRecentAt
  // The branch its chat opens on, among several, as the header's list marks it.
  const opensHere = perFork && fork.current && fork.branches > 1
  return (
    <div
      data-fork-row
      className={`fork-row @container/fork-row relative flex w-full shrink-0 max-w-controls min-w-0 items-center gap-1 rounded-md border py-2 ps-2 ${rowActionInsetClass} hover:bg-surface-raised ${here ? "border-accent bg-surface-raised" : "border-border"}`}
    >
      <Tooltip
        label={`${title}. ${
          perFork
            ? `Opens this branch${here ? ", shown now" : ""}.${opensHere ? ` ${OPENS_HERE_HINT}` : ""}`
            : "Opens the chat on the branch you last used."
        }`}
      >
        <Link
          {...forkLink(fork)}
          onClick={openOnPlainClick(open)}
          aria-label={`Open ${branchOnly ? "branch" : "chat"} ${title}`}
          aria-current={here ? "page" : undefined}
          data-chat-id={fork.chat.id}
          data-fork-id={fork.forkId}
          className="fork-row-open flex min-w-0 flex-1 items-center self-stretch gap-2 rounded p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {!branchOnly && (
            <Tooltip label={`Characters: ${fork.cast.map((c) => c.name).join(", ")}`}>
              <span
                tabIndex={0}
                aria-label={`Characters: ${fork.cast.map((c) => c.name).join(", ")}`}
                data-row-portraits
                data-layout-audit-ignore="overlap: The count tile sits partly behind the last fully visible portrait; gap: Portraits have a positive gap while the count tile intentionally overlaps the last portrait"
                className="relative flex w-fit shrink-0 gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
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
                <PortraitOverflow remaining={fork.cast.length - 2} className="fork-row-overflow" />
              </span>
            </Tooltip>
          )}
          <span data-row-text className="flex min-w-0 flex-1 flex-col self-stretch">
            {/* Two lines: beside the portraits one line leaves imported names unrecognizable. */}
            <span data-chat-title className="line-clamp-2 text-sm text-ellipsis break-normal [overflow-wrap:normal]">
              <span className="font-medium">{title}</span>
              {opensHere && (
                <>
                  {" "}
                  <Badge>opens here</Badge>
                </>
              )}
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
            {details && (
              <span data-chat-meta className="text-xs text-muted [overflow-wrap:anywhere]">
                started{" "}
                {formatDay(
                  chatName(importState(fork.chat.title).title, fork.cast, fork.chat.createdAt ?? null).started ??
                    new Date(fork.createdAt)
                )}{" "}
                · {fork.messages.toLocaleString()} {fork.messages === 1 ? "message" : "messages"}
              </span>
            )}
            <span className="line-clamp-2 min-h-8 text-xs text-muted [overflow-wrap:anywhere]">
              {fork.preview || "No messages yet"}
            </span>
            {relation !== null && (
              <span data-row-relation className="text-xs text-muted">
                {/* Wraps only between its two parts. */}
                <span className="whitespace-nowrap">{relation[0]}</span> ·{" "}
                <span className="whitespace-nowrap">{relation[1]}</span>
              </span>
            )}
            <span data-row-when className="mt-auto text-xs text-muted">
              {perFork ? "Last message " : ""}
              {perFork ? formatMoment(last) : formatWhen(last)}
            </span>
          </span>
        </Link>
      </Tooltip>
      <div
        data-row-actions
        data-layout-overlay="Corner actions share the full-width open control in narrow chat rows"
        className="my-1 flex shrink-0 flex-col items-end justify-between self-stretch"
      >
        <span className="flex items-center gap-0.5">
          <OpenBesideButton href={besideHref} name={title} className="fork-row-beside" />
          <PinButton fork={fork} branch={perFork} />
        </span>
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
export function OpenChatBranches() {
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
      { id: "pinnedBranches", limit: 5000 },
      { id: "peers", limit: 5000 },
      { id: "other", limit: 5000 }
    ]
  })
  const pinned = forks.section("pinnedBranches").rows
  const peers = forks.section("peers").rows
  const other = forks.section("other").rows
  const nextRows = useMemo(() => [...pinned, ...peers, ...other], [pinned, peers, other])
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
  if (!visible) return null
  const chatLabel = rows[0]!.chatName
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
              Branches of {chatLabel} ({rows.length.toLocaleString()})
            </span>
          </button>
        </Tooltip>
        <IconButton
          label="List these branches in the panel"
          hint="Show these branches in the sidebar"
          icon="expand"
          onClick={() => setScope({ entity: null, chat: displayedChat ?? null })}
        />
      </div>
      <div
        data-foot-body
        inert={!open}
        aria-hidden={!open}
        style={open ? undefined : { height: 0, maxHeight: 0, visibility: "hidden" }}
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 [scrollbar-gutter:stable]"
      >
        {rows.map((f) => (
          <ForkRow
            key={f.forkId}
            fork={f}
            perFork
            branchOnly
            here={displayedFork ? f.forkId === displayedFork : f.current}
          />
        ))}
      </div>
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
    ["pinnedBranches", "Pinned branches"],
    ["peers", "Named branches"],
    ["other", "Branches"]
  ]
} as const satisfies Record<string, ReadonlyArray<readonly [ShellSection, string]>>

function Browser({ data }: { data: ShellLibrary }) {
  const { scope, setScope, grid, setGrid } = useShellNavigation()
  const [browse, setBrowse] = useSidebarBrowse()
  const [chatBrowse, setChatBrowse] = useChatBrowse()
  const search = browse.search
  const setSearch = (search: string) => setBrowse({ search })
  const params = useParams({ strict: false }) as { chatId?: string }
  const shown = useSearch({ strict: false, select: (s: { fork?: string }) => s.fork })
  const selected = useSplitChats((params.chatId ?? null) as ChatId | null, shown)?.group.id ?? params.chatId
  const listRef = useRef<HTMLDivElement>(null)
  useSplitReveal(listRef, selected)
  const card = [...data.cards, ...data.personas].find((c) => c.card.entityId === scope.entity)
  const cardLabel = card ? card.card.label : "Character not found"
  const needle = search.trim().toLowerCase()
  const kind = scope.chat ? "chat" : scope.entity ? "character" : "all"
  const sections = SECTIONS[kind]
  // Each list's length, by scope and search: another scope or search starts from its first page.
  const listKey = `${scope.entity}/${scope.chat}/${needle}/${JSON.stringify(chatBrowse)}`
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
    ...(!grid && kind !== "chat" ? { browse: chatBrowse } : {}),
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
              here={f.chat.id === selected && (kind !== "chat" || (shown ? f.forkId === shown : f.current))}
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
          <Input
            aria-label={grid ? "Find a character" : "Find a chat"}
            placeholder="Find by name"
            className="min-w-0"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </div>
      </div>
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
      {!grid && kind !== "chat" && (
        <SlotOutlet
          slot={sidebarChatBrowse}
          props={{ browse: chatBrowse, counts: forks.filterCounts, onChange: setChatBrowse }}
        />
      )}
      {grid && <CardBrowseBar data={data} browse={browse} onChange={setBrowse} groups includePersonas />}
      {/* The gutter is kept whether or not it scrolls, so the list never shifts, with a gap before the bar. */}
      <div
        ref={listRef}
        data-shell-list
        className="@container min-h-0 flex-1 overflow-y-auto px-2 [scrollbar-gutter:stable]"
      >
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
              cards={browseCards(browsable(data), browse, needle)}
              sort={browse.sort}
              markPersonas={mixesPersonas(browse)}
              className="grid grid-cols-2 gap-2 @sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]"
            />
          )
        ) : (
          // One column of rows; dragged wide, a row stays a row's width, its pin beside its text.
          <div className="max-w-controls">
            {kind === "character" && card && (
              <SlotOutlet slot={characterChatActions} props={{ entityId: card.card.entityId, label: cardLabel }} />
            )}
            {/* A chat's own pins are among its named and pinned branches. */}
            {kind !== "chat" && (
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
            {none && <p className="p-2 text-sm text-muted">No chats here yet.</p>}
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
      <AsyncView atom={shellAtom} loading="Loading chats…" still="Still loading your chats…">
        {(data) => <Browser data={data} />}
      </AsyncView>
    </div>
  )
}
