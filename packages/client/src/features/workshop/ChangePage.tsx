// The change view (spec/WORKSHOP-CARDS.md §7.4, §8.1): what one workshop turn changed in one
// library item, in a tab of its own at `/library/<ref>/change?from=&to=`. The header names the item
// and the reply, with the row's action; the body shows only the fields that differ, in History's
// comparisons, each with Revert this field (Redo once reverted). When the item changed since,
// "Compared with now" sets the turn's result beside the item as it is. A revert that conflicts
// (or `resolve=1` in the URL) shows the conflicting fields as they are now and as they were before
// the change, with Keep now / Take before for each, then Revert the rest.
import { unitPath } from "@dreamspan/shared/changeReversal.ts"
import type { Doc, EntityKind, RefId } from "@dreamspan/shared/library.ts"
import type { ReversalOutcome } from "@dreamspan/shared/workshopApi.ts"
import { useAtomValue } from "@effect/atom-react"
import { Link, useLocation } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useState } from "react"
import { useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { revisionName } from "../../ui/RevisionEntry.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { linkMenuProps } from "../../ui/linkMenuState.ts"
import { FieldComparison } from "../editor/CardRevisionBrowser.tsx"
import { changedFields, fieldLabel, type FieldChange } from "../editor/fields.ts"
import { useSharedEditorStore } from "../editor/sharedStore.ts"
import { useEditorState, useWorkingDoc, type EditorStore } from "../editor/store.ts"
import { useTitle } from "../shell.tsx"
import { openNearProps } from "../workbench/kinds.ts"
import { cardFileHref, ItemPicture } from "./ChangeRows.tsx"
import {
  cardFileChangeTarget,
  type ChangeReply,
  changeViewTarget,
  type ItemChange,
  itemChanges,
  itemReverted,
  itemUndone,
  liveKeys,
  revertedFieldsOf,
  standingReverts,
  unitOfPath
} from "./changeRows.ts"
import { versionEffectsAtom } from "./effects.ts"
import { CHANGE_KEYS, ItemChangeAction, revertMessage } from "./ItemChangeAction.tsx"
import { type ItemChangeDetail, itemChangeAtom, itemChangeKey } from "./itemChange.ts"

type Target = NonNullable<ReturnType<typeof changeViewTarget>>
type Conflicts = ReversalOutcome["conflicts"]

const link =
  "rounded-sm text-accent outline-none underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-focus"

/** The tab's title: "Mara Quill · changes". */
export const changeTabName = (name: string) => (name ? `${name} · changes` : "Changes")

/** A field's Revert this field, or once reverted, "Reverted" and Redo (spec/WORKSHOP-CARDS.md §7.4). */
function FieldAction({
  item,
  unit,
  onConflicts
}: {
  item: ItemChange
  unit: string
  onConflicts: (outcome: ReversalOutcome, fields: ReadonlyArray<string>, reversalId?: string) => void
}) {
  const action = useAction()
  if (item.created || itemUndone(item)) return null
  const reverted = revertedFieldsOf(item).has(unit)
  const revert = async () => {
    const result = await action.run(
      (client) => client("RevertChange", { effects: liveKeys(item), fields: [unit], message: revertMessage(item) }),
      CHANGE_KEYS
    )
    if (result.ok && result.value.conflicts.length > 0) onConflicts(result.value, [unit])
  }
  const redo = async () => {
    for (const reversalId of standingReverts(item)) {
      const result = await action.run((client) => client("RedoChange", { reversalId, fields: [unit] }), CHANGE_KEYS)
      if (!result.ok) return
      if (result.value.conflicts.length > 0) {
        onConflicts(result.value, [unit], reversalId)
        return
      }
    }
  }
  return (
    <>
      {action.error && (
        <span role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">
          {action.error.message}
        </span>
      )}
      {reverted ? (
        <>
          <span className="text-xs text-muted" data-field-reverted>
            Reverted
          </span>
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            pending={action.pending}
            hint="Puts the assistant's change of this field back, keeping edits made since, as a new revision."
            onClick={() => void redo()}
            data-field-redo
          >
            Redo
          </Button>
        </>
      ) : (
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs"
          pending={action.pending}
          hint="Puts this field back as it was before this change, as a new revision."
          onClick={() => void revert()}
          data-field-revert
        >
          Revert this field
        </Button>
      )}
    </>
  )
}

function Comparisons({
  kind,
  before,
  after,
  changes,
  beforeLabel,
  afterLabel,
  actions
}: {
  kind: EntityKind
  before: Doc
  after: Doc
  changes: ReadonlyArray<FieldChange>
  beforeLabel: string
  afterLabel: string
  /** A field's buttons, on the first of its comparisons. */
  actions?: ((unit: string) => ReactNode) | undefined
}) {
  if (changes.length === 0) return <p className="p-2 text-sm text-muted">No fields differ.</p>
  const shown = new Set<string>()
  return (
    <div aria-label="What changed" className="flex min-w-0 flex-col gap-2">
      {changes.map((change) => {
        const unit = unitOfPath(change.path)
        const first = !shown.has(unit)
        shown.add(unit)
        return (
          <FieldComparison
            key={JSON.stringify(change.path)}
            label={fieldLabel(kind, after, change.path, before)}
            change={change}
            doc={after}
            beforeLabel={beforeLabel}
            afterLabel={afterLabel}
            actions={first && actions ? actions(unit) : undefined}
          />
        )
      })}
    </div>
  )
}

/**
 * The fields a revert left because they changed since: each as it is now and as it was before
 * the change, Keep now (the default) or Take before, then Revert the rest.
 */
function Resolve({
  item,
  kind,
  conflicts,
  head,
  fields,
  reversalId,
  onDone
}: {
  item: ItemChange
  kind: EntityKind
  conflicts: Conflicts
  head: string
  fields: ReadonlyArray<string> | undefined
  reversalId: string | undefined
  onDone: () => void
}) {
  const action = useAction()
  const [choices, setChoices] = useState<Record<string, "now" | "before">>(() =>
    Object.fromEntries(conflicts.map((c) => [c.field, "now"]))
  )
  const [preview, setPreview] = useState({ head, conflicts })
  const left = preview.conflicts
  const redo = reversalId !== undefined
  const resolveConflicts = async () => {
    const options = { choices, expectedHead: preview.head, ...(fields ? { fields } : {}) }
    const result = await action.run(
      (client) =>
        redo
          ? client("RedoChange", { reversalId, ...options })
          : client("RevertChange", { effects: liveKeys(item), message: revertMessage(item), ...options }),
      CHANGE_KEYS
    )
    if (!result.ok) return
    if (result.value.head !== preview.head || result.value.conflicts.length > 0) {
      setPreview({ head: result.value.head, conflicts: result.value.conflicts })
      setChoices(Object.fromEntries(result.value.conflicts.map((c) => [c.field, "now"])))
    } else onDone()
  }
  return (
    <section
      aria-label="Changed since"
      data-change-conflicts
      className="flex min-w-0 flex-col gap-2 rounded-md border border-warning p-2"
    >
      <h2 className="text-sm font-semibold">Changed since</h2>
      <p className="text-xs text-muted">
        {left.length === 0
          ? "The item changed again. Review its current state before continuing."
          : `${left.length === 1 ? "This field was" : "These fields were"} changed since the ${redo ? "revert" : "reply"}. Choose what to keep in each field, then ${redo ? "redo" : "revert"} the rest.`}
      </p>
      {left.map((conflict) => {
        const path = unitPath(conflict.field)
        return (
          <div key={conflict.field} className="flex min-w-0 flex-col gap-2" data-conflict={conflict.field}>
            <FieldComparison
              label={fieldLabel(kind, {}, path)}
              change={{ path, before: conflict.now, after: conflict.before }}
              doc={{}}
              beforeLabel="Now"
              afterLabel={redo ? "Before this revert" : "Before this change"}
              defaultOpen
            />
            <Segmented
              label={`What to do with ${fieldLabel(kind, {}, path)}`}
              value={choices[conflict.field] ?? "now"}
              onValueChange={(value) => setChoices((all) => ({ ...all, [conflict.field]: value }))}
              options={[
                { value: "now", label: "Keep now", description: "Leaves this field as it is now." },
                {
                  value: "before",
                  label: "Take before",
                  description: `Puts this field back as it was before this ${redo ? "revert" : "change"}, dropping the edits made since.`
                }
              ]}
            />
          </div>
        )
      })}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {action.error && (
          <span role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">
            Not {redo ? "redone" : "reverted"}: {action.error.message}
          </span>
        )}
        <Button hint="Leaves everything as it is now." onClick={onDone}>
          Cancel
        </Button>
        <Button
          variant="primary"
          pending={action.pending}
          hint={
            redo
              ? "Puts the change back in the other fields and applies your choices here."
              : "Takes the change out of the other fields, and does what you chose for these, as a new revision."
          }
          onClick={() => void resolveConflicts()}
          data-revert-rest
        >
          {redo ? "Redo the rest" : "Revert the rest"}
        </Button>
      </div>
    </section>
  )
}

/** The reply's own change of the item, from its listed changes. */
const useReplyItem = (reply: ChangeReply, match: (item: ItemChange) => boolean) => {
  const result = useAtomValue(versionEffectsAtom(reply.versionId))
  return {
    item: AsyncResult.isSuccess(result) ? itemChanges(result.value).find(match) : undefined,
    gone: AsyncResult.isFailure(result) || AsyncResult.isSuccess(result)
  }
}

/** What a revert that conflicts shows: its conflicts, and the fields it was for. */
type Resolving = {
  readonly conflicts: Conflicts
  readonly head: string
  readonly fields: ReadonlyArray<string> | undefined
  readonly reversalId?: string | undefined
} | null

/** The conflicts to show: those a revert found, or on `resolve=1`, a dry run's. */
const useResolving = (item: ItemChange | undefined, asked: boolean) => {
  const [resolving, setResolving] = useState<Resolving>(null)
  const action = useAction()
  const ready = item !== undefined && !item.created && !itemReverted(item)
  useEffect(() => {
    if (!asked || !ready) return
    void action
      .run((client) => client("RevertChange", { effects: liveKeys(item), dryRun: true }), [])
      .then((result) => {
        if (result.ok && result.value.conflicts.length > 0)
          setResolving({ conflicts: result.value.conflicts, head: result.value.head, fields: undefined })
      })
    // Once per open: the item's later changes don't ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, ready])
  return [resolving, setResolving] as const
}

function Body({
  store,
  target,
  detail,
  kind,
  actions
}: {
  store: EditorStore
  target: Target
  detail: ItemChangeDetail
  kind: EntityKind
  actions?: ((unit: string) => ReactNode) | undefined
}) {
  const now = useWorkingDoc(store)
  const [mode, setMode] = useState<"turn" | "now">("turn")
  const numberOf = (id: string | null) => (id === null ? undefined : detail.revisions.find((r) => r.id === id)?.number)
  const toName = revisionName(numberOf(target.to))
  const turn = (
    <Comparisons
      kind={kind}
      before={detail.before}
      after={detail.after}
      changes={detail.changes}
      beforeLabel={target.from === null ? "Empty" : revisionName(numberOf(target.from))}
      afterLabel={toName}
      actions={actions}
    />
  )
  const at = detail.revisions.findIndex((r) => r.id === target.to)
  const later = (at < 0 ? detail.revisions : detail.revisions.slice(0, at)).filter((r) => r.origin !== "generation")
  if (later.length === 0) return turn
  const laterNames = later
    .map((r) => revisionName(r.number))
    .reverse()
    .join(", ")
  return (
    <Tabs
      wrap
      label="Comparison"
      value={mode}
      onValueChange={setMode}
      tabs={[
        {
          value: "turn",
          label: "This reply’s changes",
          description: "Shows what the assistant changed in this reply",
          panel: turn
        },
        {
          value: "now",
          label: "Compared with now",
          description: `Shows what changed after this reply: ${laterNames}`,
          panel:
            mode === "now" ? (
              <div className="flex min-w-0 flex-col gap-2">
                <p className="text-xs text-muted">Changed since in {laterNames}.</p>
                <Comparisons
                  kind={kind}
                  before={detail.after}
                  after={now}
                  changes={changedFields(detail.after, now)}
                  beforeLabel={toName}
                  afterLabel="Current state"
                />
              </div>
            ) : null
        }
      ]}
    />
  )
}

/** The header action, the field actions and the conflicts, once the reply's change of the item is read. */
function WithReply({
  reply,
  match,
  asked,
  kind,
  children
}: {
  reply: ChangeReply | null
  match: (item: ItemChange) => boolean
  asked: boolean
  kind: EntityKind
  children: (parts: {
    readonly item: ItemChange | undefined
    readonly gone: boolean
    readonly action: ReactNode
    readonly conflicts: ReactNode
    readonly actions: ((unit: string) => ReactNode) | undefined
  }) => ReactNode
}) {
  if (!reply) return children({ item: undefined, gone: false, action: null, conflicts: null, actions: undefined })
  return (
    <ReplyParts reply={reply} match={match} asked={asked} kind={kind}>
      {children}
    </ReplyParts>
  )
}

function ReplyParts({
  reply,
  match,
  asked,
  kind,
  children
}: {
  reply: ChangeReply
  match: (item: ItemChange) => boolean
  asked: boolean
  kind: EntityKind
  children: Parameters<typeof WithReply>[0]["children"]
}) {
  const { item, gone } = useReplyItem(reply, match)
  const [resolving, setResolving] = useResolving(item, asked)
  const show = (outcome: ReversalOutcome, fields?: ReadonlyArray<string>, reversalId?: string) =>
    setResolving({ conflicts: outcome.conflicts, head: outcome.head, fields, reversalId })
  return children({
    item,
    gone: gone && !item,
    action: item ? (
      <ItemChangeAction item={item} reply={reply} onConflicts={(o, id) => show(o, undefined, id)} />
    ) : null,
    conflicts:
      item && resolving ? (
        <Resolve
          key={JSON.stringify(resolving)}
          item={item}
          kind={kind}
          conflicts={resolving.conflicts}
          head={resolving.head}
          fields={resolving.fields}
          reversalId={resolving.reversalId}
          onDone={() => setResolving(null)}
        />
      ) : null,
    actions: item ? (unit) => <FieldAction item={item} unit={unit} onConflicts={show} /> : undefined
  })
}

function ChangeView({ target, asked }: { target: Target; asked: boolean }) {
  const store = useSharedEditorStore(target.refId as RefId)
  const state = useEditorState(store)
  useEffect(() => {
    if (store.snapshot === null) void store.load()
  }, [store])
  const detail = useAtomValue(itemChangeAtom(itemChangeKey(target.refId, target.from, target.to)))
  const ref = state.snapshot?.ref
  const title = changeTabName(ref?.label ?? "")
  useTitle(title)
  if (state.loadError?.tag === "NotFound" || (AsyncResult.isFailure(detail) && !ref))
    return (
      <Alert tone="warning">
        <p>This item was deleted or never existed.</p>
      </Alert>
    )
  if (!ref || !AsyncResult.isSuccess(detail))
    return <Loading label="Reading the changes…" onRetry={() => void store.load()} />
  const loaded = detail.value
  const toRevision = loaded.revisions.find((r) => r.id === target.to)
  const fromNumber = loaded.revisions.find((r) => r.id === target.from)?.number
  const messages = loaded.revisions.slice(loaded.revisions.findIndex((r) => r.id === target.to)).filter((r, i, all) => {
    const end = all.findIndex((x) => x.id === target.from)
    return (end < 0 || i < end) && r.message
  })
  const face = { entityId: ref.entityId, kind: ref.kind, label: ref.label }
  return (
    <WithReply reply={target.reply} match={(i) => i.refId === target.refId} asked={asked} kind={ref.kind}>
      {({ action, conflicts, actions }) => (
        <section aria-label={title} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <CenterHeaderContent>
            <h1 className="min-w-0 truncate text-base font-semibold">{title}</h1>
          </CenterHeaderContent>
          <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 p-3 sm:p-4">
            <header className="flex min-w-0 items-start gap-3">
              <ItemPicture item={face} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Tooltip label={`Opens ${ref.label} as it is now.`}>
                  <a
                    href={`/library/${encodeURIComponent(ref.id)}`}
                    className={`${link} w-fit text-base font-semibold [overflow-wrap:anywhere]`}
                    {...openNearProps("library.editor")}
                    {...linkMenuProps}
                  >
                    {ref.label}
                  </a>
                </Tooltip>
                <p className="text-xs text-muted [overflow-wrap:anywhere]">
                  {target.from === null ? "Made" : "Changed"} by the assistant in{" "}
                  {target.reply ? (
                    <Tooltip label="Opens the workshop at the reply that made this change.">
                      <Link
                        to="/chats/$chatId"
                        params={{ chatId: target.reply.chatId }}
                        search={{ slot: target.reply.slotId } as never}
                        className={link}
                        {...linkMenuProps}
                      >
                        a workshop reply
                      </Link>
                    </Tooltip>
                  ) : (
                    "a workshop reply"
                  )}
                  {toRevision
                    ? ` at ${new Date(toRevision.createdAt).toLocaleTimeString([], { timeStyle: "short" })}`
                    : ""}
                  {target.from === null ? (
                    toRevision?.number !== undefined && (
                      <span className="whitespace-nowrap"> · {revisionName(toRevision.number)}</span>
                    )
                  ) : fromNumber !== undefined && toRevision?.number !== undefined ? (
                    <span className="whitespace-nowrap">
                      {" "}
                      · revision {fromNumber} → {toRevision.number}
                    </span>
                  ) : null}
                </p>
                {messages.map((r) => (
                  <p key={r.id} className="text-xs [overflow-wrap:anywhere]">
                    {r.message}
                  </p>
                ))}
              </div>
              {action}
            </header>
            {conflicts}
            <Body store={store} target={target} detail={loaded} kind={ref.kind} actions={actions} />
          </div>
        </section>
      )}
    </WithReply>
  )
}

/**
 * A card file's change view (spec/WORKSHOP-CARDS.md §4.5): what one reply's edits changed in a
 * card file in Files, field by field, from the fields its edits kept; the header links the file,
 * the reply, and has the row's Revert.
 */
function CardFileChangeView({
  target,
  asked
}: {
  target: NonNullable<ReturnType<typeof cardFileChangeTarget>>
  asked: boolean
}) {
  return (
    <WithReply
      reply={target.reply}
      match={(i) => i.file?.path === target.path && i.to === target.to}
      asked={asked}
      kind="card"
    >
      {(parts) => <CardFileChangeBody target={target} {...parts} />}
    </WithReply>
  )
}

function CardFileChangeBody({
  target,
  item,
  gone,
  action,
  conflicts,
  actions
}: {
  target: NonNullable<ReturnType<typeof cardFileChangeTarget>>
  item: ItemChange | undefined
  gone: boolean
  action: ReactNode
  conflicts: ReactNode
  actions: ((unit: string) => ReactNode) | undefined
}) {
  const title = changeTabName(item?.label ?? "")
  useTitle(title)
  if (gone || (item && !item.file))
    return (
      <Alert tone="warning">
        <p>This change isn’t there any more.</p>
      </Alert>
    )
  if (!item?.file) return <Loading label="Reading the changes…" />
  const { file } = item
  const changes = changedFields(file.before, file.after)
  const at = item.effects.at(0)?.createdAt
  return (
    <section aria-label={title} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <CenterHeaderContent>
        <h1 className="min-w-0 truncate text-base font-semibold">{title}</h1>
      </CenterHeaderContent>
      <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 p-3 sm:p-4">
        <header className="flex min-w-0 items-start gap-3">
          <ItemPicture item={item} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Tooltip label="Opens the card file in Files, as it is now.">
              <a
                href={cardFileHref(file.path)}
                className={`${link} w-fit text-base font-semibold [overflow-wrap:anywhere]`}
                {...linkMenuProps}
              >
                {item.label}
              </a>
            </Tooltip>
            <p className="text-xs text-muted [overflow-wrap:anywhere]">
              Card file {file.path}, changed by the assistant in{" "}
              <Tooltip label="Opens the workshop at the reply that made this change.">
                <Link
                  to="/chats/$chatId"
                  params={{ chatId: target.reply.chatId }}
                  search={{ slot: target.reply.slotId } as never}
                  className={link}
                  {...linkMenuProps}
                >
                  a workshop reply
                </Link>
              </Tooltip>
              {at ? ` at ${new Date(at).toLocaleTimeString([], { timeStyle: "short" })}` : ""}
            </p>
          </div>
          {action}
        </header>
        {conflicts}
        <Comparisons
          kind="card"
          before={file.before}
          after={file.after}
          changes={changes}
          beforeLabel="Before this reply"
          afterLabel="After this reply"
          actions={actions}
        />
      </div>
    </section>
  )
}

export function CardFileChangePage() {
  const href = useLocation({ select: (location) => location.href })
  const url = new URL(href, "http://tab.invalid")
  const target = cardFileChangeTarget(url)
  if (!target) return <Alert tone="warning">This link doesn’t name a change.</Alert>
  return (
    <CardFileChangeView
      key={`${target.path}\n${target.to}`}
      target={target}
      asked={url.searchParams.get("resolve") === "1"}
    />
  )
}

export function ChangePage() {
  const href = useLocation({ select: (location) => location.href })
  const url = new URL(href, "http://tab.invalid")
  const target = changeViewTarget(url)
  if (!target) return <Alert tone="warning">This link doesn’t name a change.</Alert>
  return (
    <ChangeView
      key={`${target.refId}\n${target.from ?? ""}\n${target.to}`}
      target={target}
      asked={url.searchParams.get("resolve") === "1"}
    />
  )
}
