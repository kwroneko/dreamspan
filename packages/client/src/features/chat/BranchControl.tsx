// The header's branch control (DESIGN §3.2; registered as `chat.branches` in
// `chatBranchControls`): "Branch: From #14 ▾" whenever the chat has more than one branch. It
// lists every branch (its name, its last message's first words, when it was last chatted in),
// the one shown marked, and switches, renames and deletes them. The UI says "branch" for what
// the data model calls a fork. A popover on a wide screen, a sheet on a phone; the chat's ⋯
// menu opens the same list (`requestBranches`), in a dialog while the header shows no control.
import type { Fork, SlotId } from "@rp/shared/chat.ts"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { type FormEvent, useEffect, useState } from "react"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
import { Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { sidebarCleared } from "../characters/shellData.tsx"
import { formatWhen } from "./chatTitle.ts"
import { branchActivity, branchLabel, useBranchesRequest, forksChanged, useChatForks } from "./forks.ts"
import type { ChatSession, ChatView } from "./session.ts"
import { useNarrow } from "./VersionPicker.tsx"

export interface BranchControlProps {
  readonly session: ChatSession
  readonly view: ChatView
  /** Opens the chat at a message of the fork shown. */
  readonly onJump: (slotId: SlotId) => void
}

/** One branch in the list: switch to it by its row; rename it in place; delete it. */
function BranchRow({
  fork,
  label,
  shown,
  only,
  onSwitch,
  onRename,
  onDelete
}: {
  fork: Fork
  label: string
  shown: boolean
  only: boolean
  onSwitch: () => void
  onRename: (name: string) => Promise<AppError | null>
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)
  const [error, setError] = useState<AppError | null>(null)
  const [pending, setPending] = useState(false)
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    setPending(true)
    const failed = await onRename(draft)
    setPending(false)
    setError(failed)
    if (failed === null) setEditing(false)
  }
  if (editing)
    return (
      <li className="rounded-md border border-focus p-2">
        <form className="flex flex-col gap-2" onSubmit={(event) => void save(event)}>
          <Input
            aria-label={`Name of branch ${label}`}
            value={draft}
            maxLength={100}
            autoFocus
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation()
                setEditing(false)
              }
            }}
          />
          {error && <p className="text-xs text-danger">{error.message}</p>}
          <p className="text-xs text-muted">Leave it empty to take the name off.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="h-8" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" className="h-8" pending={pending}>
              Rename
            </Button>
          </div>
        </form>
      </li>
    )
  return (
    <li
      data-fork={fork.id}
      className={`flex items-start gap-1 rounded-md border ${shown ? "border-accent bg-accent/5" : "border-transparent hover:bg-surface-raised"}`}
    >
      <button
        type="button"
        aria-current={shown || undefined}
        aria-label={`${label}${shown ? ", shown" : ""}${fork.current ? ", latest" : ""}: ${fork.tipExcerpt.slice(0, 80) || "no messages"}`}
        onClick={onSwitch}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
          <span className="min-w-0 truncate font-medium">{label}</span>
          {shown && <span className="text-xs font-medium text-accent">shown</span>}
          {fork.current && (
            <Badge tone="neutral">
              <span title="The chat opens on it; sending in another branch makes that one the latest">latest</span>
            </Badge>
          )}
          <span className="ml-auto text-xs text-muted tabular-nums">{formatWhen(branchActivity(fork))}</span>
        </span>
        <span className="line-clamp-2 text-xs text-muted [overflow-wrap:anywhere]">
          {fork.tipExcerpt || "No messages yet"}
        </span>
      </button>
      <div className="flex shrink-0 items-center py-0.5 pr-0.5">
        <IconButton
          label={`Rename ${label}`}
          icon="edit"
          onClick={() => {
            setDraft(fork.name ?? "")
            setError(null)
            setEditing(true)
          }}
        />
        <IconButton
          label={`Delete ${label}`}
          hint={only ? "The only branch: delete the chat instead" : `Delete ${label}`}
          icon="trash"
          tone="danger"
          disabled={only}
          focusableWhenDisabled
          onClick={onDelete}
        />
      </div>
    </li>
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
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { panel?: string }
  const deleted = useDeletedToast()
  const keepPanel = search.panel ? { panel: search.panel } : {}
  if (forks === null) return <p className="px-1 py-2 text-sm text-muted">Loading the branches…</p>
  const live = forks.length
  const open = (fork: Fork) => {
    onDone()
    if (fork.id === shown?.id) return
    void navigate({
      to: ".",
      search: fork.id === view.chat?.currentForkId ? keepPanel : { ...keepPanel, fork: fork.id }
    })
  }
  const rename = async (fork: Fork, name: string) => {
    const result = await session.call((client) => client("NameFork", { forkId: fork.id, name }))
    if (!result.ok) return result.error
    forksChanged(session.id)
    return null
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
    // The old URL names the branch that went: keep the panel, follow the latest branch.
    if (isShown) void navigate({ to: ".", search: keepPanel, replace: true })
  }
  const start = shown?.baseSlotId ?? null
  const latest = forks.find((f) => f.current)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <ol aria-label="Branches" className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
        {forks.map((fork) => (
          <BranchRow
            key={fork.id}
            fork={fork}
            label={branchLabel(fork, forks)}
            shown={fork.id === shown?.id}
            only={live <= 1}
            onSwitch={() => open(fork)}
            onRename={(name) => rename(fork, name)}
            onDelete={() => void remove(fork)}
          />
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2 text-sm">
        {latest !== undefined && shown !== undefined && latest.id !== shown.id && (
          <button type="button" className="text-accent hover:underline" onClick={() => open(latest)}>
            Back to the latest branch
          </button>
        )}
        {start !== null && (
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => {
              onDone()
              onJump(start)
            }}
          >
            Go to where this branch starts
          </button>
        )}
        <Link
          to="."
          className="text-accent hover:underline"
          onClick={onDone}
          search={(prev: Record<string, unknown>) => ({ ...prev, ...sidebarCleared, forks: session.id })}
        >
          Show in the left panel
        </Link>
      </div>
      <p className="text-xs text-muted">
        {live <= 1 ? "The only branch: delete the chat instead. " : ""}To start another, choose Branch from here in a
        message&rsquo;s menu.
      </p>
    </div>
  )
}

/** The control: the trigger once the chat has two branches, and the list it opens. */
export function BranchControl(props: BranchControlProps) {
  const { session, view } = props
  const { forks, shown, reload } = useChatForks(session, view)
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
  const many = forks !== null && forks.length > 1
  const label = shown ? branchLabel(shown, forks ?? []) : "Branch"
  // Sending in a branch that isn't the latest makes it the latest; the header says which it is.
  const off = shown !== undefined && !shown.current
  const place = `${shown && forks ? `${forks.indexOf(shown) + 1} of ${forks.length}` : ""}${off ? ", not the latest" : ""}`
  const title = "Branches of this chat"
  const body = <BranchList {...props} forks={forks} shown={shown} onDone={() => setOpen(false)} />
  if (narrow || !many)
    return (
      <>
        {many && (
          <button
            type="button"
            aria-label={`Branch: ${label}, ${place}: switch branch`}
            onClick={() => setOpen(true)}
            className="inline-flex h-8 max-w-24 min-w-0 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name="branch" size={16} />
            <span className="truncate">{label}</span>
          </button>
        )}
        {narrow ? (
          <Sheet open={open} onOpenChange={setOpen} title={title}>
            <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3">{body}</div>
          </Sheet>
        ) : (
          <Dialog open={open} onOpenChange={setOpen} title={title}>
            {body}
          </Dialog>
        )}
      </>
    )
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <>
          <Icon name="branch" size={14} className="shrink-0" />
          <span className="truncate">
            <span className="text-muted">Branch:</span> {label}
            {off && <span className="text-xs text-muted"> · not the latest</span>}
          </span>
          <Icon name="down" size={14} className="shrink-0 text-muted" />
        </>
      }
      triggerLabel={`Branch: ${label}, ${place}: switch branch`}
      triggerClassName="inline-flex h-8 max-w-72 min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-sm text-text outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus data-popup-open:bg-surface-raised"
      title={title}
      side="bottom"
      align="end"
      wide
    >
      {body}
    </Popover>
  )
}
