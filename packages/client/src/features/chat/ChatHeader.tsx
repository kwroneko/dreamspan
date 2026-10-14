// The open chat's header: whose chat it is (the cast's faces and a readable name, never
// ST's file name), which branch is shown with a way to switch, and the chat's actions,
// which the page passes in. On a phone it's one line: the name truncates and the names of
// the cast go.
import type { PathEntry, SlotId } from "@rp/shared/chat.ts"
import { importState } from "@rp/shared/stImportApi.ts"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
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
import type { ChatSession, ChatView } from "./session.ts"

/** Which branch is shown, and the others at each place the path branches. */
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
  const off = view.leafSlotId !== null && view.chat !== null && view.leafSlotId !== view.chat.activeLeafSlotId
  if (forks.length === 0 && !off) return null
  const last = forks.at(-1)
  const speaker = (entry: PathEntry) =>
    (entry.version.speakerEntityId &&
      view.cast?.cards.find((c) => c.entityId === entry.version.speakerEntityId)?.name) ||
    (entry.version.writer === "model" ? "Model" : "You")
  const summary = last ? `Branch ${last.branchIndex + 1} of ${last.branchCount}` : "Another branch"
  const label = `${summary}${last ? `, at message #${last.depth + 1}` : ""}${off ? ", not the latest" : ""}: switch branch`
  return (
    <Menu
      align="end"
      label="Branches"
      trigger={
        <Tooltip label={label}>
          <button
            type="button"
            aria-label={label}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2 text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus data-popup-open:bg-surface-raised ${
              off ? "border-warning/60 text-warning" : "border-border text-text"
            }`}
          >
            <Icon name="branch" size={14} />
            <span className="max-sm:hidden">
              {summary}
              {off && <span className="text-xs"> · not the latest</span>}
            </span>
            {last && (
              <span className="tabular-nums sm:hidden">
                {last.branchIndex + 1}/{last.branchCount}
              </span>
            )}
            <Icon name="down" size={14} className="text-muted max-sm:hidden" />
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
      {[...forks].reverse().map((fork, i) => (
        <MenuGroup
          key={fork.slotId}
          label={`${i === 0 ? "Branches" : "Earlier"} at message #${fork.depth + 1} (${speaker(fork)})`}
        >
          <MenuRadioGroup value={fork.branchIndex} onValueChange={(index: number) => onBranch(fork, index)}>
            {Array.from({ length: fork.branchCount }, (_, index) => (
              <MenuRadioItem key={index} value={index}>
                Branch {index + 1}
                {index === fork.branchIndex ? <span className="text-muted"> (shown)</span> : null}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuItem icon="right" onClick={() => onJump(fork.slotId)}>
            Go to message #{fork.depth + 1}
          </MenuItem>
        </MenuGroup>
      ))}
      {!complete && (
        <p className="px-2.5 py-1.5 text-xs text-muted">
          Looked for branches in the last {FORK_SCAN_LIMIT.toLocaleString()} messages.
        </p>
      )}
    </Menu>
  )
}

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
  const cast = view.cast
  const characters = (cast?.participants ?? [])
    .filter((id) => !cast!.playedByMe.includes(id))
    .flatMap((id) => cast!.cards.filter((card) => card.entityId === id))
  const title = view.chat ? importState(view.chat.title).title : ""
  const name = view.chat ? chatName(title, characters) : null
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
            <h1 className="min-w-0 truncate text-base font-semibold sm:text-lg">{name?.name ?? "Chat"}</h1>
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
