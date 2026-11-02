// The recycle bin (DESIGN §6.2): what the user deleted, newest first, to restore where it was
// or delete for good (the one place that asks first), and the text recovered from drafts.
import { SlotOutlet, defineSlot } from "../../slots.tsx"
import { RegistryContext } from "@effect/atom-react"
import type { BinBranch, BinItem, RecoveredText } from "@rp/shared/bin.ts"
import { Link } from "@tanstack/react-router"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { useContext, useEffect, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { type AppError, describeCause } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { ConfirmDialog, Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Textarea } from "../../ui/Field.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { useTitle } from "../shell.tsx"
import { readableChatTitle } from "../chat/chatTitle.ts"
import { RESTORED_KEYS, restoreItem } from "./deleted.ts"
import { binTitle, purgeTitle, recoveredSource } from "./titles.ts"

export const binSettings = defineSlot<Record<string, never>>("bin.settings")
/**
 * Inside each "delete for good" confirmation, under what it does: the branches it affects
 * (`bin.affected-branches`). The confirmation itself reads them and waits for the read.
 */
export const binPurgeBranches = defineSlot<{ branches: ReadonlyArray<BinBranch> }>("bin.purge-branches")

const PAGE = 50

const itemsAtom = AppClient.query("ListBin", { limit: PAGE, before: null }, { reactivityKeys: ["bin"] })
const textsAtom = AppClient.query("ListRecoveredTexts", { limit: PAGE, before: null }, { reactivityKeys: ["bin"] })

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

const kindLabel = (item: BinItem) => {
  switch (item.kind) {
    case "message":
      return "Message"
    case "branch":
      return typeof item.origin.forkId === "string" ? "Fork" : "Branch"
    case "version":
      return "Version"
    case "chat":
      return "Chat"
    case "connection":
      return "Connection"
    case "entity": {
      const kind = typeof item.origin.kind === "string" ? item.origin.kind : "entry"
      return kind[0]!.toUpperCase() + kind.slice(1)
    }
  }
}

/** What deleting for good does to an item of this kind (ARCHITECTURE §3.11). */
const purgeEffect = (item: BinItem) => {
  switch (item.kind) {
    case "message":
    case "version":
      return typeof item.origin.forkId === "string"
        ? "Its text is erased for good in every branch, the ones that still show it included. An empty placeholder keeps its place in the chat."
        : "Its text goes for good. An empty placeholder keeps its place in the chat."
    case "branch":
      return typeof item.origin.forkId === "string"
        ? "The branch goes for good, with the messages no other branch shows. Branches made from it keep their history."
        : "Its text goes for good. An empty placeholder keeps its place in the chat."
    case "chat":
      return "The chat goes for good, with everything in it."
    case "entity":
      return "The entry goes for good, with its versions. Messages that named it keep its name."
    case "connection":
      return "The connection goes for good, with the key typed into it. Usage records keep its name."
  }
}

/**
 * The branches deleting the items for good affects (`BinItemBranches`), which the user reads
 * before confirming (owner, 2026-10-27 and 2026-11-01): read when the dialog opens, shown by the
 * `bin.purge-branches` slot. `onReady` gets the forks that show the text, which the purge
 * confirms; until then the dialog can't confirm.
 */
function PurgeBranches({
  itemIds,
  open,
  onReady
}: {
  itemIds: ReadonlyArray<string>
  open: boolean
  onReady: (forkIds: ReadonlyArray<string> | null) => void
}) {
  const read = useAction()
  // What was read for which items: a list for other items isn't this dialog's.
  const [loaded, setRead] = useState<{ key: string; branches: ReadonlyArray<BinBranch> } | null>(null)
  const key = itemIds.join(",")
  useEffect(() => {
    if (!open || itemIds.length === 0) return
    let active = true
    void read
      .run((client) => client("BinItemBranches", { itemIds }))
      .then((result) => {
        if (active && result.ok) {
          setRead({ key, branches: result.value })
          onReady([...new Set(result.value.filter((branch) => branch.shows).map((branch) => branch.forkId))])
        }
      })
    return () => {
      active = false
    }
    // `read` is a new function each render; the items are what the list is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key, onReady])
  const branches = loaded !== null && loaded.key === key ? loaded.branches : null
  if (read.error) return <ErrorAlert error={read.error} />
  if (branches === null || read.pending) return <p role="status">Checking affected branches…</p>
  return <SlotOutlet slot={binPurgeBranches} props={{ branches }} />
}

/** Where a restored item is now, for a link to it. */
function RestoredLink({ item }: { item: BinItem }) {
  const chatId = typeof item.origin.chatId === "string" ? item.origin.chatId : null
  const slotId = typeof item.origin.slotId === "string" ? item.origin.slotId : null
  if (chatId === null) return <span className="text-sm text-success">Restored.</span>
  return (
    <span className="text-sm text-success">
      Restored.{" "}
      <Link
        to="/chats/$chatId"
        params={{ chatId }}
        search={slotId === null ? {} : { slot: slotId }}
        className="text-accent underline-offset-4 hover:underline"
      >
        Open it
      </Link>
    </span>
  )
}

function ItemRow({ item, onGone }: { item: BinItem; onGone: (item: BinItem) => void }) {
  const registry = useContext(RegistryContext)
  const purge = useAction()
  const [restoring, setRestoring] = useState(false)
  const [restored, setRestored] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [expectedForkIds, setExpectedForkIds] = useState<ReadonlyArray<string> | null>(null)
  const chatTitle = typeof item.origin.chatTitle === "string" ? readableChatTitle(item.origin.chatTitle) : null
  const title = binTitle(item)
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" aria-label={title}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{kindLabel(item)}</Badge>
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{title}</span>
      </div>
      {typeof item.origin.subtitle === "string" && item.origin.subtitle && (
        <p className="text-sm text-muted">{item.origin.subtitle}</p>
      )}
      {item.excerpt && item.kind !== "entity" && item.kind !== "connection" && (
        <p className="line-clamp-3 text-sm whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{item.excerpt}</p>
      )}
      <p className="text-xs text-muted">
        Deleted {when(item.deletedAt)}
        {chatTitle && item.kind !== "chat" && !title.includes(chatTitle) ? ` from “${chatTitle}”` : ""}
      </p>
      {restored ? (
        <RestoredLink item={item} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            pending={restoring}
            hint="Puts it back where it was deleted from."
            onClick={async () => {
              setRestoring(true)
              // The bin keeps showing it, with where it went back to, until the page reloads.
              const exit = await restoreItem(
                registry,
                item.id,
                RESTORED_KEYS.filter((key) => key !== "bin")
              )
              setRestoring(false)
              if (exit._tag === "Success") setRestored(true)
              else setError(describeCause(exit.cause))
            }}
          >
            Restore
          </Button>
          <Button
            variant="ghost"
            hint="Erases it so it can’t be restored. You see what it affects and confirm first."
            onClick={() => {
              setExpectedForkIds(null)
              setConfirming(true)
            }}
          >
            Delete for good
          </Button>
        </div>
      )}
      <ErrorAlert error={error} />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={purgeTitle(item)}
        description={`${chatTitle !== null && item.kind !== "chat" ? `From the chat “${chatTitle}”. ` : ""}${purgeEffect(item)} This can't be undone.`}
        confirmLabel="Delete for good"
        pending={purge.pending}
        confirmDisabled={expectedForkIds === null}
        onConfirm={async () => {
          if (expectedForkIds === null) return
          const result = await purge.run((client) => client("PurgeBinItem", { itemId: item.id, expectedForkIds }))
          if (result.ok) {
            setConfirming(false)
            onGone(item)
          } else if (result.error.tag === "BinChanged") {
            setExpectedForkIds(null)
          }
        }}
      >
        <PurgeBranches itemIds={[item.id]} open={confirming} onReady={setExpectedForkIds} />
        <ErrorAlert error={purge.error} />
      </ConfirmDialog>
    </li>
  )
}

function DeletedItems({ first }: { first: ReadonlyArray<BinItem> }) {
  const registry = useContext(RegistryContext)
  const action = useAction()
  const [more, setMore] = useState<ReadonlyArray<BinItem>>([])
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set())
  const [end, setEnd] = useState(first.length < PAGE)
  const [expectedForkIds, setExpectedForkIds] = useState<ReadonlyArray<string> | null>(null)
  const [emptying, setEmptying] = useState<ReadonlyArray<string> | null>(null)
  const items = [...first, ...more]
  const loadMore = async () => {
    const last = items.at(-1)!
    const result = await action.run((client) =>
      client("ListBin", { limit: PAGE, before: { deletedAt: last.deletedAt, id: last.id } })
    )
    if (!result.ok) return
    setMore([...more, ...result.value])
    setEnd(result.value.length < PAGE)
  }
  const shown = items.filter((item) => !gone.has(item.id))
  if (shown.length === 0) {
    return (
      <EmptyState title="Nothing deleted">
        <p>What you delete comes here first, to restore or delete for good.</p>
      </EmptyState>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          disabled={!end}
          hint="Deletes everything in this list for good, after you confirm. Recovered text stays."
          onClick={() => {
            setExpectedForkIds(null)
            setEmptying(shown.map((item) => item.id))
          }}
        >
          Empty the bin
        </Button>
      </div>
      {!end && <p className="text-sm text-muted">Load all deleted items before emptying the bin.</p>}
      <ul className="flex flex-col divide-y divide-border">
        {shown.map((item) => (
          <ItemRow key={item.id} item={item} onGone={(it) => setGone(new Set([...gone, it.id]))} />
        ))}
      </ul>
      {!end && (
        <Button className="self-start" pending={action.pending} onClick={loadMore}>
          Load more
        </Button>
      )}
      <ErrorAlert error={action.error} />
      <ConfirmDialog
        open={emptying !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEmptying(null)
            if (action.error?.tag === "BinChanged") registry.refresh(itemsAtom)
          }
        }}
        title="Empty the bin?"
        description={`${emptying?.length ?? 0} deleted items go for good: chats and entries entirely, messages as empty placeholders. Recovered text stays. This can't be undone.`}
        confirmLabel="Empty the bin"
        pending={action.pending}
        confirmDisabled={expectedForkIds === null}
        onConfirm={async () => {
          if (emptying === null || expectedForkIds === null) return
          const result = await action.run(
            (client) => client("EmptyBin", { itemIds: emptying, expectedForkIds }),
            RESTORED_KEYS
          )
          if (result.ok) setEmptying(null)
        }}
      >
        <PurgeBranches itemIds={emptying ?? []} open={emptying !== null} onReady={setExpectedForkIds} />
        <ErrorAlert error={action.error} />
      </ConfirmDialog>
    </div>
  )
}

function TextRow({ text, onGone }: { text: RecoveredText; onGone: (text: RecoveredText) => void }) {
  const open = useAction()
  const remove = useAction()
  const [full, setFull] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [copied, setCopied] = useState(false)
  const source = recoveredSource(text)
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" aria-label={`Recovered from ${source}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{text.reason === "discard" ? "Discarded" : "Before a big change"}</Badge>
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{source}</span>
      </div>
      <p className="line-clamp-3 text-sm whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{text.content}</p>
      <p className="text-xs text-muted">
        {when(text.createdAt)} · {text.length === 1 ? "1 character" : `${text.length} characters`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          pending={open.pending}
          hint="Read the full text and copy what you need."
          onClick={async () => {
            const result = await open.run((client) => client("GetRecoveredText", { id: text.id }))
            if (result.ok) setFull(result.value.content)
          }}
        >
          Show all
        </Button>
        <Button variant="ghost" hint="Erases this text, after you confirm." onClick={() => setConfirming(true)}>
          Delete for good
        </Button>
      </div>
      <ErrorAlert error={open.error} />
      {full !== null && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setFull(null)
              setCopied(false)
            }
          }}
          title={`Recovered from ${source}`}
          description="Copy any text you want to keep. This doesn’t restore it to its original place."
        >
          <Textarea textActions aria-label="Recovered text" readOnly rows={10} value={full} />
          <DialogActions>
            <Button onClick={() => setFull(null)}>Close</Button>
            <Button
              variant="primary"
              onClick={async () => {
                await navigator.clipboard.writeText(full).then(
                  () => setCopied(true),
                  () => setCopied(false)
                )
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </DialogActions>
        </Dialog>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this text for good?"
        description="This recovered text will be deleted permanently. This can’t be undone."
        confirmLabel="Delete for good"
        pending={remove.pending}
        onConfirm={async () => {
          const result = await remove.run((client) => client("DeleteRecoveredText", { id: text.id }))
          if (result.ok) {
            setConfirming(false)
            onGone(text)
          }
        }}
      >
        <ErrorAlert error={remove.error} />
      </ConfirmDialog>
    </li>
  )
}

function RecoveredTexts({ first }: { first: ReadonlyArray<RecoveredText> }) {
  const action = useAction()
  const [more, setMore] = useState<ReadonlyArray<RecoveredText>>([])
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set())
  const [end, setEnd] = useState(first.length < PAGE)
  const texts = [...first, ...more]
  const loadMore = async () => {
    const last = texts.at(-1)!
    const result = await action.run((client) =>
      client("ListRecoveredTexts", { limit: PAGE, before: { createdAt: last.createdAt, id: last.id } })
    )
    if (!result.ok) return
    setMore([...more, ...result.value])
    setEnd(result.value.length < PAGE)
  }
  const shown = texts.filter((text) => !gone.has(text.id))
  if (shown.length === 0) {
    return (
      <EmptyState title="No recovered text">
        <p>Find discarded drafts and text removed while writing here.</p>
      </EmptyState>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border">
        {shown.map((text) => (
          <TextRow key={text.id} text={text} onGone={(t) => setGone(new Set([...gone, t.id]))} />
        ))}
      </ul>
      {!end && (
        <Button className="self-start" pending={action.pending} onClick={loadMore}>
          Load more
        </Button>
      )}
      <ErrorAlert error={action.error} />
    </div>
  )
}

export function BinPage() {
  useTitle("Bin")
  // `?section=recovered`: where a composer or editor that put text there links to.
  const [tab, setTab] = usePlaceParam("section", "deleted", ["deleted", "recovered"])
  return (
    <Card>
      <CardHeader title="Bin" />
      <Tabs
        label="Bin sections"
        value={tab}
        onValueChange={setTab}
        tabs={[
          {
            value: "deleted",
            label: "Deleted",
            panel: (
              <AsyncView atom={itemsAtom} loading="Loading the bin…">
                {(items) => <DeletedItems key={items.map((i) => i.id).join()} first={items} />}
              </AsyncView>
            )
          },
          {
            value: "recovered",
            label: "Recovered text",
            panel: (
              <AsyncView atom={textsAtom} loading="Loading recovered text…">
                {(texts) => <RecoveredTexts key={texts.map((t) => t.id).join()} first={texts} />}
              </AsyncView>
            )
          }
        ]}
      />
      {/* Its settings (capacity) after what's in it: rarely needed. */}
      <div className="mt-6 flex flex-col gap-3 border-t border-border pt-4 empty:hidden">
        <SlotOutlet slot={binSettings} props={{}} />
      </div>
    </Card>
  )
}
