import { cardNames } from "@rp/shared/cardNames.ts"
import { Effect } from "effect"
import { useCardNameCheck } from "./cardNameCheck.ts"
import { checkCardNames } from "./checkCardNames.ts"
// Compare immutable revisions with their first parent or the live working document.
import { type Doc, Revision } from "@rp/shared/library.ts"
import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import { Link } from "@tanstack/react-router"
import { readableChatTitle } from "../chat/chatTitle.ts"
import { ReadableDiff, readableLines } from "../../ui/ReadableDiff.tsx"
import { RevisionEntry } from "../../ui/RevisionEntry.tsx"
import { promptLabel } from "./promptLabel.ts"
import { useEffect, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import { RadioGroup } from "../../ui/Choice.tsx"
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

function FieldComparison({ label, change, doc }: { label: string; change: FieldChange; doc: Doc }) {
  const [open, setOpen] = useState(false)
  const text = isText(change.before) && isText(change.after)
  const order = change.path.length === 1 && change.path[0] === "order"
  return (
    <details
      className="min-w-0 rounded-md border border-border p-2"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium [overflow-wrap:anywhere]">{label}</summary>
      {open && (
        <div className="mt-2">
          {text ? (
            <ValueDiff before={change.before} after={change.after} rich />
          ) : (
            <ReadableDiff before={change.before} after={change.after} {...(order ? { lines: orderLines(doc) } : {})} />
          )}
        </div>
      )}
    </details>
  )
}

/** What made a revision, in words: the reply that used its text (linked), a Save, an import. */
function RevisionTitle({ revision }: { revision: Revision }) {
  const use = revision.usedBy
  if (revision.origin === "generation" && use)
    return (
      <>
        Used by a reply ·{" "}
        <Link
          to="/chats/$chatId"
          params={{ chatId: use.chatId }}
          search={use.forkId ? { fork: use.forkId, slot: use.slotId } : { slot: use.slotId }}
          className="text-accent underline-offset-4 hover:underline"
        >
          {use.chatTitle ? readableChatTitle(use.chatTitle) : "a chat"}
        </Link>{" "}
        · message {use.message}
      </>
    )
  const origins: Record<Revision["origin"], string> = {
    user: "Saved",
    generation: "Used by a reply",
    import: "Imported",
    merge: "Took an update",
    agent: "Changed by the agent",
    changeset: "Changed"
  }
  return <>{origins[revision.origin]}</>
}

function RevisionComparison({ store, call, revision }: { store: EditorStore; call: Caller; revision: Revision }) {
  const [mode, setMode] = useState<"parent" | "current">("parent")
  const [docs, setDocs] = useState<{ doc: Doc; parent: Doc } | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  // Subscribe to every draft so an external restore/recovery updates an open comparison.
  const state = useEditorState(store)
  useEffect(() => {
    let live = true
    void Promise.all([
      store.revisionDoc(revision.id),
      revision.parents[0] ? store.revisionDoc(revision.parents[0]) : Promise.resolve({})
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
  const names = cardNames(docs?.doc ?? {})
  const nameCheck = useCardNameCheck(names.displayName, names.version, state.snapshot!.ref)
  const clash = state.snapshot!.ref.kind === "card" ? nameCheck : null
  const restore = async () => {
    if (!docs || clash) return
    const result = await call(
      (client) =>
        Effect.gen(function* () {
          if (state.snapshot!.ref.kind === "card")
            yield* checkCardNames(client, names.displayName, names.version, state.snapshot!.ref)
          return yield* client("RestoreRevision", {
            refId: store.refId,
            revisionId: revision.id,
            expectedRowVersion: state.snapshot!.ref.rowVersion
          })
        }),
      ["library"]
    )
    if (result.ok) await store.refresh()
    else setError(result.error)
  }
  const current = useWorkingDoc(store)
  const changes =
    docs === null ? null : mode === "parent" ? changedFields(docs.parent, docs.doc) : changedFields(docs.doc, current)
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <RadioGroup
        aria-label="Compare revision against"
        value={mode}
        onValueChange={setMode}
        options={[
          { value: "parent", label: "Parent revision" },
          { value: "current", label: "As it is now" }
        ]}
      />
      <p className="text-xs text-muted">
        {mode === "parent"
          ? revision.parents.length === 0
            ? "First revision, compared with an empty document."
            : "Before: first parent. After: selected revision."
          : "Before: selected revision. After: the text as it is now, which replies use."}
      </p>
      <ErrorAlert error={error} />
      {changes === null ? (
        <p className="text-sm text-muted">Loading comparison…</p>
      ) : changes.length === 0 ? (
        <p className="text-sm text-muted">No fields differ.</p>
      ) : (
        <div aria-label="Revision changes" className="flex min-w-0 flex-col gap-2">
          {changes.map((change) => {
            const label = fieldLabel(
              state.snapshot!.ref.kind,
              mode === "parent" ? docs!.doc : current,
              change.path,
              mode === "parent" ? docs!.parent : docs!.doc
            )
            return (
              <FieldComparison
                key={JSON.stringify(change.path)}
                label={label}
                change={change}
                doc={mode === "parent" ? docs!.doc : current}
              />
            )
          })}
        </div>
      )}
      {(revision.id !== state.snapshot!.ref.headRevisionId || state.dirty > 0) && (
        <div>
          <Button
            disabled={!docs || clash !== null}
            hint={
              revision.id === state.snapshot!.ref.headRevisionId
                ? "Puts every field back to this revision. What you typed since stays in each field's edit history."
                : "Saves this revision's content as a new revision, and the fields take it. Nothing in between is lost."
            }
            onClick={() => void restore()}
          >
            Restore
          </Button>
          {docs && clash && (
            <p role="status" className="text-sm text-muted">
              {clash}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function CardRevisionBrowser({ store, call }: { store: EditorStore; call: Caller }) {
  const [revisions, setRevisions] = useState<ReadonlyArray<Revision>>([])
  const [selected, setSelected] = useState<Revision | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [pending, setPending] = useState(false)
  const head = useEditorState(store).snapshot!.ref.headRevisionId
  useEffect(() => {
    let live = true
    void call((client) => client("ListRevisions", { refId: store.refId, limit: 50 })).then((result) => {
      if (!live) return
      if (result.ok) setRevisions(result.value)
      else setError(result.error)
    })
    return () => {
      live = false
    }
  }, [store, call, head])
  const more = async () => {
    setPending(true)
    const result = await call((client) =>
      client("ListRevisions", { refId: store.refId, limit: 50, before: revisions.at(-1)!.id })
    )
    setPending(false)
    if (result.ok) setRevisions([...revisions, ...result.value])
    else setError(result.error)
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ErrorAlert error={error} />
      <ol aria-label="Revisions" className="flex flex-col divide-y divide-border">
        {revisions.map((revision) => (
          <li key={revision.id} className="py-2">
            <RevisionEntry
              number={revision.number}
              createdAt={revision.createdAt}
              title={<RevisionTitle revision={revision} />}
              message={revision.message}
              current={revision.id === head}
              selected={selected?.id === revision.id}
              onSelect={() => setSelected(revision)}
              onMessage={async (message) => {
                const result = await call(
                  (client) => client("SetRevisionMessage", { refId: store.refId, revisionId: revision.id, message }),
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
              }}
            />
          </li>
        ))}
      </ol>
      {(revisions.at(-1)?.parents.length ?? 0) > 0 && (
        <Button pending={pending} onClick={() => void more()}>
          Earlier revisions
        </Button>
      )}
      {selected !== null && <RevisionComparison key={selected.id} store={store} call={call} revision={selected} />}
    </div>
  )
}
