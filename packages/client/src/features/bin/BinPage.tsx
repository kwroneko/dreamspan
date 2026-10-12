// The recycle bin (DESIGN §6.2): what the user deleted, newest first, to restore where it was
// or delete for good (the one place that asks first), and the text recovered from drafts.
import { RegistryContext } from "@effect/atom-react"
import type { BinItem, RecoveredText } from "@rp/shared/bin.ts"
import { Link, useSearch } from "@tanstack/react-router"
import { useContext, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { type AppError, describeCause } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { ConfirmDialog, Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Textarea } from "../../ui/Field.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { useTitle } from "../shell.tsx"
import { RESTORED_KEYS, restoreItem } from "./deleted.ts"

const PAGE = 50

const itemsAtom = AppClient.query("ListBin", { limit: PAGE, before: null }, { reactivityKeys: ["bin"] })
const textsAtom = AppClient.query("ListRecoveredTexts", { limit: PAGE, before: null }, { reactivityKeys: ["bin"] })

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

const kindLabel = (item: BinItem) => {
  switch (item.kind) {
    case "message":
      return "Message"
    case "branch":
      return "Branch"
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
    case "branch":
    case "version":
      return "Its text goes for good. An empty placeholder keeps its place in the chat."
    case "chat":
      return "The chat goes for good, with everything in it."
    case "entity":
      return "The entry goes for good, with its versions. Messages that named it keep its name."
    case "connection":
      return "The connection goes for good, with the key typed into it. Usage records keep its name."
  }
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
  const chatTitle = typeof item.origin.chatTitle === "string" ? item.origin.chatTitle : null
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" aria-label={item.title}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{kindLabel(item)}</Badge>
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{item.title}</span>
      </div>
      {item.excerpt && item.kind !== "entity" && item.kind !== "connection" && (
        <p className="line-clamp-3 text-sm whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{item.excerpt}</p>
      )}
      <p className="text-xs text-muted">
        Deleted {when(item.deletedAt)}
        {chatTitle && item.kind !== "chat" ? ` from “${chatTitle}”` : ""}
      </p>
      {restored ? (
        <RestoredLink item={item} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            pending={restoring}
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
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            Delete for good
          </Button>
        </div>
      )}
      <ErrorAlert error={error} />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete “${item.title}” for good?`}
        description={`${purgeEffect(item)} This can't be undone.`}
        confirmLabel="Delete for good"
        pending={purge.pending}
        onConfirm={async () => {
          const result = await purge.run((client) => client("PurgeBinItem", { itemId: item.id }))
          if (result.ok) {
            setConfirming(false)
            onGone(item)
          }
        }}
      >
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
        <Button variant="ghost" disabled={!end} onClick={() => setEmptying(shown.map((item) => item.id))}>
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
        onConfirm={async () => {
          if (emptying === null) return
          const result = await action.run((client) => client("EmptyBin", { itemIds: emptying }), RESTORED_KEYS)
          if (result.ok) setEmptying(null)
        }}
      >
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
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" aria-label={`Recovered from ${text.sourceLabel}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{text.reason === "discard" ? "Discarded" : "Before a big change"}</Badge>
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{text.sourceLabel}</span>
      </div>
      <p className="line-clamp-3 text-sm whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{text.content}</p>
      <p className="text-xs text-muted">
        {when(text.createdAt)} · {text.length === 1 ? "1 character" : `${text.length} characters`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          pending={open.pending}
          onClick={async () => {
            const result = await open.run((client) => client("GetRecoveredText", { id: text.id }))
            if (result.ok) setFull(result.value.content)
          }}
        >
          Show all
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(true)}>
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
          title={`Recovered from ${text.sourceLabel}`}
          description="Copy what you need: it isn't put back anywhere by itself."
        >
          <Textarea aria-label="Recovered text" readOnly rows={10} value={full} />
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
        description="It was kept because it would otherwise have been lost. This can't be undone."
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
        <p>Text you wiped while writing, then sent or saved, and drafts you discarded, are kept here.</p>
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
  const search = useSearch({ strict: false }) as { section?: unknown }
  const [tab, setTab] = useState<"deleted" | "recovered">(search.section === "recovered" ? "recovered" : "deleted")
  return (
    <Card>
      <CardHeader title="Bin" description="Deleted things wait here, newest first: restore them where they were." />
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
    </Card>
  )
}
