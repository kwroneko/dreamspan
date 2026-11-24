// The change view (spec/WORKSHOP-CARDS.md §7.4): what one workshop turn changed in one library
// item, in a tab of its own at `/library/<ref>/change?from=&to=`. The header names the item and
// the reply, with the row's action; the body shows only the fields that differ, in History's
// comparisons. When the item changed since, "Compared with now" sets the turn's result beside
// the item as it is.
import type { Doc, EntityKind, RefId } from "@dreamspan/shared/library.ts"
import { useAtomValue } from "@effect/atom-react"
import { Link, useLocation } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useState } from "react"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { revisionName } from "../../ui/RevisionEntry.tsx"
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
import { ItemPicture } from "./ChangeRows.tsx"
import { type ChangeReply, changeViewTarget, type ItemChange, itemChanges } from "./changeRows.ts"
import { versionEffectsAtom } from "./effects.ts"
import { ItemChangeAction } from "./ItemChangeAction.tsx"
import { type ItemChangeDetail, itemChangeAtom, itemChangeKey } from "./itemChange.ts"

type Target = NonNullable<ReturnType<typeof changeViewTarget>>

const link =
  "rounded-sm text-accent outline-none underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-focus"

/** The tab's title: "Mara Quill · changes". */
export const changeTabName = (name: string) => (name ? `${name} · changes` : "Changes")

function Comparisons({
  kind,
  before,
  after,
  changes,
  beforeLabel,
  afterLabel
}: {
  kind: EntityKind
  before: Doc
  after: Doc
  changes: ReadonlyArray<FieldChange>
  beforeLabel: string
  afterLabel: string
}) {
  if (changes.length === 0) return <p className="p-2 text-sm text-muted">No fields differ.</p>
  return (
    <div aria-label="What changed" className="flex min-w-0 flex-col gap-2">
      {changes.map((change) => (
        <FieldComparison
          key={JSON.stringify(change.path)}
          label={fieldLabel(kind, after, change.path, before)}
          change={change}
          doc={after}
          beforeLabel={beforeLabel}
          afterLabel={afterLabel}
        />
      ))}
    </div>
  )
}

/** The reply's own change of the item, from its listed changes, for the header's action. */
function ReplyAction({ reply, refId }: { reply: ChangeReply; refId: string }) {
  const result = useAtomValue(versionEffectsAtom(reply.versionId))
  const item: ItemChange | undefined = AsyncResult.isSuccess(result)
    ? itemChanges(result.value).find((i) => i.refId === refId)
    : undefined
  return item ? <ItemChangeAction item={item} /> : null
}

function Body({
  store,
  target,
  detail,
  kind
}: {
  store: EditorStore
  target: Target
  detail: ItemChangeDetail
  kind: EntityKind
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

function ChangeView({ target }: { target: Target }) {
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
  const item = { entityId: ref.entityId, kind: ref.kind, label: ref.label }
  return (
    <section aria-label={title} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <CenterHeaderContent>
        <h1 className="min-w-0 truncate text-base font-semibold">{title}</h1>
      </CenterHeaderContent>
      <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 p-3 sm:p-4">
        <header className="flex min-w-0 items-start gap-3">
          <ItemPicture item={item} />
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
              {toRevision ? ` at ${new Date(toRevision.createdAt).toLocaleTimeString([], { timeStyle: "short" })}` : ""}
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
          {target.reply && <ReplyAction reply={target.reply} refId={target.refId} />}
        </header>
        <Body store={store} target={target} detail={loaded} kind={ref.kind} />
      </div>
    </section>
  )
}

export function ChangePage() {
  const href = useLocation({ select: (location) => location.href })
  const target = changeViewTarget(new URL(href, "http://tab.invalid"))
  if (!target) return <Alert tone="warning">This link doesn’t name a change.</Alert>
  return <ChangeView key={`${target.refId}\n${target.from ?? ""}\n${target.to}`} target={target} />
}
