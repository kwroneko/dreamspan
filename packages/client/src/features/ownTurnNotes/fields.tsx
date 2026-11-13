import { useAtomValue } from "@effect/atom-react"
import { Atom, AsyncResult } from "effect/reactivity"
import type { RefId } from "@rp/shared/library.ts"
import { AppClient } from "../../rpc.ts"
import { REPLACEABLE_CARD_FIELDS, type ReplaceableCardField } from "@rp/shared/docs/note.ts"
import type { NoteEntry } from "@rp/shared/editorApi.ts"
import { useCallback, useEffect, useMemo, useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { describeCause, type AppError } from "../../errors.ts"
import { useSession } from "../../session.ts"
import { chromeButton } from "../../ui/FieldFrame.tsx"
import { FieldTabs, useFieldTabs } from "../../ui/FieldTabs.tsx"
import { Button } from "../../ui/Button.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { useCaller } from "../editor/caller.ts"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { TextField } from "../editor/controls.tsx"
import type { FieldViewProps } from "../editor/fieldViews.ts"
import { EditorStore, useEditorKind, useEditorState, useLeaveGuard, useText } from "../editor/store.ts"
import { useCountMacros } from "../editor/countMacros.ts"
import { useTokenCounts } from "../editor/tokenCounts.ts"

const cardNotes = Atom.family((cardRefId: RefId) =>
  AppClient.query("ListCardNotes", { cardRefId }, { reactivityKeys: ["library"] })
)

const ST_EXPORT_NOTICE = "SillyTavern gets the original"

export function OwnTurnFieldView(props: FieldViewProps) {
  const kind = useEditorKind(props.store)
  const field = props.path.length === 1 ? props.path[0] : null
  if (kind !== "card" || !REPLACEABLE_CARD_FIELDS.includes(field as ReplaceableCardField)) return props.render()
  return <CardField {...props} field={field as ReplaceableCardField} />
}

function CardField({ store, path, label, rows, render, field }: FieldViewProps & { field: ReplaceableCardField }) {
  const call = useCaller()
  const workspace = usePresetWorkspace()
  const { user } = useSession()
  const snapshot = useEditorState(store).snapshot
  const name = useText(store, ["name"]) || "This card"
  const listed = useAtomValue(cardNotes(store.refId))
  const notes = AsyncResult.isSuccess(listed) ? listed.value : []
  const [error, setError] = useState<AppError | null>(null)
  const [lastMove, setLastMove] = useState<string | null>(null)
  const [undoNotice, setUndoNotice] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [selection, setSelection] = useState({ at: 0, length: 0 })
  const selectedRange = useCallback(
    (range: { at: number; length: number }) =>
      setSelection((previous) => (previous.at === range.at && previous.length === range.length ? previous : range)),
    []
  )
  const [tab, setTab] = useState<"replaced" | "original">("replaced")
  const ids = useFieldTabs()
  const replacement = notes.find(
    (n) => n.doc.move_group && (n.doc.replaces as { field?: string } | undefined)?.field === field
  )
  const replacementId = replacement?.ref.id
  const [stores] = useState(() => new Map<string, EditorStore>())
  let noteStore = replacementId ? (stores.get(replacementId) ?? null) : null
  if (replacementId && !noteStore) {
    noteStore = workspace?.store(replacementId) ?? new EditorStore(replacementId, user.id, call)
    stores.set(replacementId, noteStore)
  }
  useEffect(() => {
    if (noteStore) void noteStore.load()
  }, [noteStore])
  const moved = notes.filter(
    (n) =>
      replacement &&
      n.doc.move_group === replacement.doc.move_group &&
      n.doc.condition !== undefined &&
      n.doc.on_by_default === true
  )
  const move = async () => {
    if (!snapshot || selection.length === 0) return
    setPending(true)
    const source = noteStore ?? store
    await source.flush()
    if (source.state().dirty > 0) {
      const saved = await source.commit(null)
      if (!saved.ok) {
        setError(saved.error)
        setPending(false)
        return
      }
    }
    const text = source.text(noteStore ? ["content"] : path)
    const result = await call(
      (api) =>
        api("MoveToOwnTurnNote", {
          cardRefId: store.refId,
          expectedRevisionId: store.snapshot!.ref.headRevisionId,
          field,
          text,
          ...selection
        }),
      ["library"]
    )
    setPending(false)
    if (!result.ok) return setError(result.error)
    setError(null)
    setLastMove(result.value.editId)
    setUndoNotice(null)
    setSelection({ at: 0, length: 0 })
    setTab("replaced")
    if (noteStore) await noteStore.refresh()
  }
  const undo = async () => {
    if (!lastMove) return
    const result = await call((api) => api("UndoLibraryEdit", { editId: lastMove }), ["library"])
    if (!result.ok) return setError(result.error)
    setUndoNotice(
      result.value.kept.length ? result.value.kept[0]!.reason : "Move undone. The original shared text is sent again."
    )
    if (result.value.undone > 0) setLastMove(null)
    if (noteStore) await noteStore.refresh()
  }
  const action = (
    <IconButton
      icon="note"
      label="Move to an own-turn note"
      className={chromeButton}
      disabled={pending || selection.length === 0 || (replacement !== undefined && tab === "original")}
      hint="Select inner life, secrets or voice to send only on this card’s turns. Keep looks, public roles and shared relationships in the description. The original stays in the card."
      onClick={() => void move()}
    />
  )
  const tabs = (
    <FieldTabs
      label={`${label}: as replaced or original`}
      ids={ids}
      value={tab}
      onValueChange={(value) => {
        setTab(value)
        setSelection({ at: 0, length: 0 })
      }}
      tabs={[
        {
          value: "replaced",
          label: "As replaced",
          description: "The shared text after your moves. Edits change the replacement note."
        },
        { value: "original", label: "Original", description: "The card’s original text, kept for updates and exports." }
      ]}
    />
  )
  return (
    <div className="flex min-w-0 flex-col gap-1" data-own-turn-field={field}>
      {replacement && noteStore && tab === "replaced" ? (
        <GuardedField
          store={noteStore}
          path={["content"]}
          label={label}
          labelEnd={tabs}
          rows={rows ?? 4}
          replaced
          tools={action}
          onSelectionRangeChange={selectedRange}
        />
      ) : (
        render({
          tools: action,
          onSelectionRangeChange: selectedRange,
          ...(replacement ? { labelEnd: tabs, original: true } : {})
        })
      )}
      {lastMove && (
        <Button
          className="self-start"
          hint="Undo both sides of the last move. Saved moves also appear in Search and replace’s recent edits."
          onClick={() => void undo()}
        >
          Undo move
        </Button>
      )}
      {undoNotice && (
        <p role="status" className="text-xs text-muted">
          {undoNotice}
        </p>
      )}
      {replacement && noteStore && <MovedTokens store={noteStore} cardStore={store} moved={moved} name={name} />}
      <ErrorAlert error={error ?? (AsyncResult.isFailure(listed) ? describeCause(listed.cause) : null)} />
    </div>
  )
}

function GuardedField(props: Parameters<typeof TextField>[0]) {
  useLeaveGuard(props.store)
  return <TextField {...props} />
}

function MovedTokens({
  store,
  cardStore,
  moved,
  name
}: {
  store: EditorStore
  cardStore: EditorStore
  moved: ReadonlyArray<NoteEntry>
  name: string
}) {
  const shared = useText(store, ["content"])
  const expand = useCountMacros(cardStore)
  const texts = useMemo(
    () => [expand(shared), expand(moved.map((n) => String(n.sent?.content ?? n.doc.content ?? "")).join("\n\n"))],
    [shared, moved, expand]
  )
  const { counts } = useTokenCounts(texts)
  return (
    <Tooltip label="Counts the shared replacement and the moved notes. Switch the pair off in this chat to send the original again. Edit the framing and passages in Notes.">
      <p
        tabIndex={0}
        data-own-turn-tokens
        className="text-xs text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        ~{(counts[0] ?? Math.ceil(texts[0]!.length / 4)).toLocaleString()} every turn · ~
        {(counts[1] ?? Math.ceil(texts[1]!.length / 4)).toLocaleString()} only on {name}'s turns · {ST_EXPORT_NOTICE}
      </p>
    </Tooltip>
  )
}
