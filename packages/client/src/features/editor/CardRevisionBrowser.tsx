import { Tooltip } from "../../ui/Tooltip.tsx"
import { usePlaceParam, usePlaceNotice } from "../../usePlaceParam.ts"
import { cardNames } from "@dreamspan/shared/cardNames.ts"
import { Effect } from "effect"
import { checkCardNames } from "./checkCardNames.ts"
import { useCardNameCheck } from "./cardNameCheck.ts"
// Compare immutable revisions with their first parent or the live working document. A fork's
// History runs on through the revisions it was forked from, as a git branch's log does (owner,
// 2026-11-06), with where it was forked marked between.
import { type Doc, Revision, type RevisionEntry as InheritedFrom } from "@dreamspan/shared/library.ts"
import type { PresetPrompt, PromptOrderEntry } from "@dreamspan/shared/docs/preset.ts"
import { Link } from "@tanstack/react-router"
import { readableChatTitle } from "../chat/chatTitle.ts"
import { ReadableDiff, readableLines } from "../../ui/ReadableDiff.tsx"
import { RevisionEntry, revisionName } from "../../ui/RevisionEntry.tsx"
import { promptLabel } from "./promptLabel.ts"
import { type ReactNode, useContext, useEffect, useState } from "react"
import { PanelVariantNavigation } from "./panelActions.tsx"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Tabs } from "../../ui/Tabs.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { revisionActions } from "./editorSlots.ts"
import type { Caller } from "./caller.ts"
import { ValueDiff } from "./diff.tsx"
import { changedFields, fieldLabel, type FieldChange } from "./fields.ts"
import { type EditorStore, useEditorState, useWorkingDoc } from "./store.ts"

/** Text compares as text; a setting (a number, a switch, the prompt order) reads in words, never JSON. */
const isText = (value: unknown) => value === undefined || typeof value === "string"

/** A preset's order, by its prompts' names: "3. Main Prompt · on". */
const orderLines = (doc: Doc) => (value: unknown) => {
  if (!Array.isArray(value)) return readableLines(value)
  const prompts = new Map(
    ((doc.prompts as ReadonlyArray<PresetPrompt> | undefined) ?? []).map((p) => [
      p.identifier,
      p.marker ? p.name : promptLabel(p.name, p.content).text
    ])
  )
  return (value as ReadonlyArray<PromptOrderEntry>).map(
    (entry, index) =>
      `${index + 1}. ${prompts.get(entry.identifier) ?? entry.identifier} · ${entry.enabled ? "on" : "off"}`
  )
}

/**
 * How a kind's settings read in History, by their path (a note's position, say), where the
 * generic reading of a value wouldn't say it well; undefined keeps that one.
 */
export type SettingLines = (
  path: ReadonlyArray<string | number>
) => ((value: unknown) => ReadonlyArray<string>) | undefined

export function FieldComparison({
  label,
  change,
  doc,
  settingLines,
  beforeLabel,
  afterLabel,
  actions,
  defaultOpen = false
}: {
  label: string
  change: FieldChange
  beforeLabel: string
  afterLabel: string
  doc: Doc
  settingLines?: SettingLines | undefined
  /** Buttons on the field's line (a change view's Revert this field); clicking them doesn't fold it. */
  actions?: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const text = isText(change.before) && isText(change.after)
  const order = change.path.length === 1 && change.path[0] === "order"
  const lines = order ? orderLines(doc) : settingLines?.(change.path)
  return (
    <details
      className="min-w-0 rounded-md border border-border p-2"
      open={defaultOpen || undefined}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <Tooltip label="Shows the changes to this field.">
        <summary
          className="flex cursor-pointer list-none items-center gap-1 text-sm font-medium [overflow-wrap:anywhere] [&::-webkit-details-marker]:hidden"
          title={`Show or hide changes to ${label}`}
        >
          <Icon name={open ? "down" : "right"} size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">{label}</span>
          {actions && (
            // A click on a button here is the button's, not the summary's.
            <span
              className="flex shrink-0 flex-wrap items-center justify-end gap-1 font-normal"
              onClick={(event) => event.preventDefault()}
            >
              {actions}
            </span>
          )}
        </summary>
      </Tooltip>
      {open && (
        <div className="mt-2">
          {text ? (
            <ValueDiff
              before={change.before}
              after={change.after}
              beforeLabel={beforeLabel}
              afterLabel={afterLabel}
              rich
            />
          ) : (
            <ReadableDiff before={change.before} after={change.after} {...(lines ? { lines } : {})} />
          )}
        </div>
      )}
    </details>
  )
}

/** Linked usage and branch context stay on lines; ordinary origins are header badges. */
function RevisionTitle({ revision }: { revision: Revision }) {
  const use = revision.usedBy
  // A chat's own note: where the change took effect (owner, 2026-11-01).
  const where = revision.changedAt
    ?.map(
      (at) =>
        `${at.message === null ? "Changed before the first message" : `Changed at message ${at.message}`}, ${at.thisBranch ? "this branch" : "another branch"}`
    )
    .join("; ")
  if (revision.origin === "generation" && use)
    return (
      <>
        {use.summary ? "Used by a summary" : "Used by a reply"} ·{" "}
        <Tooltip label="Opens the chat using this revision.">
          <Link
            to="/chats/$chatId"
            params={{ chatId: use.chatId }}
            search={use.forkId ? { fork: use.forkId, slot: use.slotId } : { slot: use.slotId }}
            className="text-accent underline-offset-4 hover:underline"
            title="Opens the chat at the reply that used this revision"
          >
            {use.chatTitle ? readableChatTitle(use.chatTitle) : "a chat"}
          </Link>
        </Tooltip>{" "}
        · {use.summary ? `messages ${use.summary.from}–${use.summary.to}` : `message ${use.message}`}
        {where && <span className="block text-muted">{where}</span>}
      </>
    )
  return (
    <>
      {revision.origin === "generation" && "Used by a reply"}
      {where && <span className="block text-muted">{where}</span>}
    </>
  )
}

const entryName = (entry: InheritedFrom) =>
  `${entry.label || "a deleted entry"}${entry.subtitle ? ` · ${entry.subtitle}` : ""}`

/** An entry a fork was forked from, a link to it while it's in the library. */
function EntryName({ entry, onOpen }: { entry: InheritedFrom; onOpen?: (() => void) | undefined }) {
  const select = useContext(PanelVariantNavigation)
  const name = entryName(entry)
  if (entry.refId === null) return <span className="[overflow-wrap:anywhere]">{name}</span>
  return (
    <Tooltip label={`Opens ${name} for editing.`}>
      <Link
        to="/library/$refId"
        params={{ refId: entry.refId }}
        className="text-accent underline-offset-4 hover:underline [overflow-wrap:anywhere]"
        onClick={(event) => {
          // A plain click; a new tab or window keeps this open.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
          // A side panel's editor shows the other entry in place.
          if (select) {
            event.preventDefault()
            select(entry.refId!)
          }
          onOpen?.()
        }}
      >
        {name}
      </Link>
    </Tooltip>
  )
}

/** The revision before this one down its line: its first parent, or what a fork was forked from. */
const previousRevision = (revision: Revision) => revision.parents[0] ?? revision.forkedFrom?.revisionId

const originBadges: Partial<Record<Revision["origin"], string>> = {
  import: "Imported",
  merge: "Updated",
  agent: "Agent edit",
  changeset: "Changed"
}

function RevisionComparison({
  store,
  revision,
  settingLines
}: {
  store: EditorStore
  revision: Revision
  settingLines?: SettingLines | undefined
}) {
  const [mode, setMode] = useState<"parent" | "current">("parent")
  const [docs, setDocs] = useState<{ doc: Doc; parent: Doc } | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  // Subscribe to every draft so an external restore/recovery updates an open comparison.
  const state = useEditorState(store)
  useEffect(() => {
    let live = true
    void Promise.all([
      store.revisionDoc(revision.id),
      previousRevision(revision) ? store.revisionDoc(previousRevision(revision)!) : Promise.resolve({})
    ]).then(
      ([doc, parent]) => {
        if (live) setDocs({ doc, parent })
      },
      (error: AppError) => {
        if (live) setError(error)
      }
    )
    return () => {
      live = false
    }
  }, [store, revision])
  const current = useWorkingDoc(store)
  const before = mode === "parent" ? docs?.parent : docs?.doc
  const after = mode === "parent" ? docs?.doc : current
  const selectedName = revisionName(revision.number)
  const beforeLabel =
    mode === "current"
      ? selectedName
      : previousRevision(revision) === undefined
        ? "Empty"
        : revisionName(revision.number === undefined ? undefined : revision.number - 1)
  const afterLabel = mode === "parent" ? selectedName : "Current state"
  const changes = docs === null ? null : changedFields(before!, after!)
  const comparison =
    changes === null ? (
      <p className="text-sm text-muted">Loading comparison…</p>
    ) : changes.length === 0 ? (
      <p className="flex items-center gap-1 border border-transparent p-2 text-sm text-muted">
        <span aria-hidden="true" className="size-4 shrink-0" />
        <span>No fields differ.</span>
      </p>
    ) : (
      <div aria-label="Revision changes" className="flex min-w-0 flex-col gap-2">
        {changes.map((change) => (
          <FieldComparison
            key={JSON.stringify(change.path)}
            label={fieldLabel(state.snapshot!.ref.kind, after!, change.path, before!)}
            change={change}
            doc={after!}
            beforeLabel={beforeLabel}
            afterLabel={afterLabel}
            settingLines={settingLines}
          />
        ))}
      </div>
    )

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ErrorAlert error={error} />
      <div className="min-w-0">
        <Tabs
          wrap
          label="Revision comparison mode"
          value={mode}
          onValueChange={setMode}
          tabs={[
            {
              value: "parent",
              label: "Changes from previous revision",
              description:
                previousRevision(revision) === undefined
                  ? "Shows this first revision's changes from an empty document"
                  : "Shows this revision's changes from the previous revision",
              panel: comparison
            },
            {
              value: "current",
              label: "Changes from current state",
              description: "Shows this revision's changes from the current text and settings",
              panel: comparison
            }
          ]}
        />
      </div>
    </div>
  )
}

export function CardRevisionBrowser({
  store,
  call,
  settingLines,
  onOpenEntry
}: {
  store: EditorStore
  call: Caller
  /** How the kind's settings read (a note's position), past the generic reading. */
  settingLines?: SettingLines | undefined
  /** A link to an entry this was forked from was followed (a dialog closes). */
  onOpenEntry?: (() => void) | undefined
}) {
  // A chat's own note: its line as the branch shown has it, and where each change took effect.
  const chatNote = store.chatNote ? { chatNote: store.chatNote } : {}
  const [revisions, setRevisions] = useState<ReadonlyArray<Revision>>([])
  const [selectedId, setSelectedId] = usePlaceParam(`revision:${store.refId}`, "")
  const selected = revisions.find((r) => r.id === selectedId) ?? null
  const setSelected = (revision: Revision | null) => setSelectedId(revision?.id ?? "")
  const [error, setError] = useState<AppError | null>(null)
  const [pending, setPending] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  usePlaceNotice(selectedId && loaded && !selected && !hasMore ? "This revision is no longer available." : null)
  useEffect(() => {
    if (!selectedId || selected || !loaded || !hasMore) return
    let live = true
    const at = store.chatNote ? { chatNote: store.chatNote } : {}
    void call((client) =>
      client("ListRevisions", { refId: store.refId, limit: 50, before: revisions.at(-1)!.id, ...at })
    ).then((result) => {
      if (!live) return
      if (result.ok) {
        setRevisions((previous) => [...previous, ...result.value])
        setHasMore(result.value.length === 50)
      } else {
        setError(result.error)
        setHasMore(false)
      }
    })
    return () => {
      live = false
    }
  }, [selectedId, selected, loaded, hasMore, revisions, store, call])
  const state = useEditorState(store)
  const head = state.snapshot!.ref.headRevisionId
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [restoreDoc, setRestoreDoc] = useState<{ id: string; doc: Doc } | null>(null)
  useEffect(() => {
    if (!selected) return
    let live = true
    void store.revisionDoc(selected.id).then(
      (doc) => {
        if (live) setRestoreDoc({ id: selected.id, doc })
      },
      (error: AppError) => {
        if (live) setError(error)
      }
    )
    return () => {
      live = false
    }
  }, [store, selected])
  const selectedDoc = restoreDoc?.id === selected?.id ? restoreDoc?.doc : undefined
  const names = cardNames(selectedDoc ?? {})
  const nameCheck = useCardNameCheck(names.displayName, names.version, state.snapshot!.ref)
  // An inherited revision restores with the fork's own names (the server keeps them).
  const card = state.snapshot!.ref.kind === "card"
  const clash = selectedDoc && card && !selected?.entry ? nameCheck : null
  useEffect(() => {
    let live = true
    const at = store.chatNote ? { chatNote: store.chatNote } : {}
    void call((client) => client("ListRevisions", { refId: store.refId, limit: 50, ...at })).then((result) => {
      if (!live) return
      if (result.ok) {
        setRevisions(result.value)
        setLoaded(true)
        setHasMore(result.value.length === 50)
      } else setError(result.error)
    })
    return () => {
      live = false
    }
  }, [store, call, head])
  const more = async () => {
    setPending(true)
    const result = await call((client) =>
      client("ListRevisions", { refId: store.refId, limit: 50, before: revisions.at(-1)!.id, ...chatNote })
    )
    setPending(false)
    if (result.ok) setRevisions([...revisions, ...result.value])
    else setError(result.error)
  }
  const restore = async (revision: Revision) => {
    if (restoringId || revision.id === head) return
    setRestoringId(revision.id)
    try {
      const doc = await store.revisionDoc(revision.id)
      const names = cardNames(doc)
      const result = await call(
        (client) =>
          Effect.gen(function* () {
            if (card && !revision.entry)
              yield* checkCardNames(client, names.displayName, names.version, state.snapshot!.ref)
            return yield* client("RestoreRevision", {
              refId: store.refId,
              revisionId: revision.id,
              expectedRowVersion: state.snapshot!.ref.rowVersion,
              ...(store.chatNote ? { chatNote: store.chatNote } : {})
            })
          }),
        ["library"]
      )
      if (result.ok) await store.refresh()
      else setError(result.error)
    } catch (error) {
      setError(error as AppError)
    } finally {
      setRestoringId(null)
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ErrorAlert error={error} />
      <ol aria-label="Revisions" className="flex min-w-0 flex-col gap-3">
        {revisions.map((revision) => {
          const box = `min-w-0 rounded-lg border bg-surface-raised p-3 ${selected?.id === revision.id ? "border-accent" : "border-border"}`
          const content = (
            <>
              <RevisionEntry
                place={`revision:${revision.id}`}
                number={revision.number}
                createdAt={revision.createdAt}
                title={
                  revision.entry || revision.origin === "generation" || revision.changedAt?.length ? (
                    <>
                      {revision.entry && (
                        <span className="block text-muted">
                          From <EntryName entry={revision.entry} onOpen={onOpenEntry} />
                        </span>
                      )}
                      <RevisionTitle revision={revision} />
                    </>
                  ) : null
                }
                originLabel={originBadges[revision.origin]}
                restore={
                  <>
                    <Button
                      className="h-8 px-2"
                      disabled={
                        revision.id === head ||
                        restoringId !== null ||
                        (selected?.id === revision.id && (!selectedDoc || clash !== null))
                      }
                      focusableWhenDisabled
                      hint={
                        revision.id === head
                          ? "This is the latest revision"
                          : restoringId
                            ? "A revision is being restored"
                            : selected?.id === revision.id && clash
                              ? clash
                              : revision.entry
                                ? `Restores the content of ${revisionName(revision.number).toLowerCase()} here, as a new revision; ${entryName(revision.entry)} doesn't change`
                                : `Restores the content of ${revisionName(revision.number).toLowerCase()}`
                      }
                      onClick={() => void restore(revision)}
                    >
                      Restore to {revisionName(revision.number).toLowerCase()}
                    </Button>
                    <SlotOutlet slot={revisionActions} props={{ store, revision }} />
                  </>
                }
                message={revision.message}
                current={revision.id === head}
                selected={selected?.id === revision.id}
                onSelect={() => setSelected(selected?.id === revision.id ? null : revision)}
                // An inherited revision's message is its original's to edit.
                onMessage={
                  revision.entry
                    ? undefined
                    : async (message) => {
                        const result = await call(
                          (client) =>
                            client("SetRevisionMessage", { refId: store.refId, revisionId: revision.id, message }),
                          ["library"]
                        )
                        if (!result.ok) {
                          setError(result.error)
                          return false
                        }
                        setRevisions((list) =>
                          list.map((r) =>
                            r.id === revision.id ? new Revision({ ...r, message: message === "" ? null : message }) : r
                          )
                        )
                        return true
                      }
                }
              />
              {selected?.id === revision.id && (
                <section aria-label={`Comparison of revision ${revision.number}`} className="min-w-0 pt-2">
                  {clash && (
                    <p role="status" className="mb-2 text-sm text-muted">
                      {clash}
                    </p>
                  )}
                  <RevisionComparison key={selected.id} store={store} revision={selected} settingLines={settingLines} />
                </section>
              )}
            </>
          )
          // A fork's first revision: where it was forked, between it and the revision it came from.
          return revision.forkedFrom ? (
            <li key={revision.id} className="flex min-w-0 flex-col gap-3">
              <div className={box}>{content}</div>
              <p data-fork-point className="flex min-w-0 items-center gap-2 px-1 text-sm text-muted">
                <Icon name="branch" size={16} className="shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  Forked here from <EntryName entry={revision.forkedFrom} onOpen={onOpenEntry} />
                </span>
              </p>
            </li>
          ) : (
            <li key={revision.id} className={box}>
              {content}
            </li>
          )
        })}
      </ol>
      {revisions.length > 0 && previousRevision(revisions.at(-1)!) !== undefined && (
        <Button pending={pending} hint="Loads earlier revisions" onClick={() => void more()}>
          Earlier revisions
        </Button>
      )}
    </div>
  )
}
