// A card field or preset prompt a note replaces in the open chat (DESIGN §4.2; owner,
// 2026-11-05; spec/NOTE-OVERRIDES.md §2.1): two tabs at the end of the field's label row, "This
// chat" first, its box glowing blue and its edits going to the note, which is named and linked
// under it; "Original", the card's or preset's own text, edited as usual. A field no note
// replaces has "Edit for this chat only" in its box's strip, shown on hover and focus.
import type { NoteReplacementView, PresetContext } from "@dreamspan/shared/inspectorApi.ts"
import { useState } from "react"
import { ErrorAlert } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { ConfirmDialog } from "../../ui/Dialog.tsx"
import { chromeButton } from "../../ui/FieldFrame.tsx"
import { FieldTabs, useFieldTabs } from "../../ui/FieldTabs.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { useCaller } from "../editor/caller.ts"
import { TextField } from "../editor/controls.tsx"
import type { FieldViewProps } from "../editor/fieldViews.ts"
import { type FieldTarget, fieldTarget, storedTarget, targetLabel, useNoteTargetNames } from "../editor/noteTargets.ts"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { useEditorKind, useEditorState } from "../editor/store.ts"
import { NOTE_FOCUS } from "../editor/workspaceViews.ts"
import { otherReplacing, type ReplaceChat, useChatNotes, useReplaceChat, useReplacement } from "./chat.tsx"
import { unlinkNote } from "./unlink.ts"

type Tab = "replaced" | "original"

/** The registered field view (`note-overrides.field`). */
export function ReplacedFieldView(props: FieldViewProps) {
  const chat = useReplaceChat()
  const workspace = usePresetWorkspace()
  const kind = useEditorKind(props.store)
  const entity = useEditorState(props.store).snapshot?.ref.entityId
  const target = fieldTarget(kind, entity, props.path)
  const replacement = useReplacement(target)
  // A note just made here shows at once, before the next estimate names it.
  const [made, setMade] = useState<{
    note: string
    title: string
    context: PresetContext | null | undefined
  } | null>(null)
  if (!chat || !target || props.original) return props.render()
  const shownNote: NoteReplacementView | null =
    replacement ??
    (made && made.context === workspace?.context
      ? {
          note: made.note as never,
          title: made.title,
          card: null,
          target,
          ownPosition: false,
          status: "replaced"
        }
      : null)
  if (!shownNote)
    return props.render({
      tools: (
        <ReplaceButton
          chat={chat}
          target={target}
          {...props}
          onMade={(note) => setMade({ ...note, context: workspace?.context })}
        />
      )
    })
  return <Replaced {...props} chat={chat} target={target} replacement={shownNote} />
}

function Replaced({
  label,
  render,
  rows,
  chat,
  target,
  replacement
}: FieldViewProps & { chat: ReplaceChat; target: FieldTarget; replacement: NoteReplacementView }) {
  const workspace = usePresetWorkspace()!
  const [tab, setTab] = useState<Tab>("replaced")
  const ids = useFieldTabs()
  const names = useNoteTargetNames()
  const noteStore = workspace.store(replacement.note, replacement.card === null ? chat.position : undefined)
  if (noteStore.snapshot === null) void noteStore.load()
  const whose = target.kind === "preset_prompt" ? "the preset's" : `${names?.card(target.card) ?? "the card"}'s`
  const everywhere = target.kind === "preset_prompt" ? "every chat using the preset" : "every chat with the card"
  const source = target.kind === "preset_prompt" ? "the preset" : "the card"
  const tabs = (
    <FieldTabs
      label={`${label}: this chat or original`}
      ids={ids}
      value={tab}
      onValueChange={setTab}
      tabs={[
        {
          value: "replaced",
          label: "This chat",
          description: `Your version, sent in this chat only. Edits change it here, not ${source}.`
        },
        {
          value: "original",
          label: "Original",
          description: `${whose.charAt(0).toUpperCase()}${whose.slice(1)} own text. Edits change it in ${everywhere}.`
        }
      ]}
    />
  )
  const line = (
    <>
      {replacement.status === "own_position"
        ? "Left out in this chat; the note "
        : "This chat's version is kept in the note "}
      <Tooltip label="Opens the note.">
        <button
          type="button"
          className="text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => workspace.open(replacement.note, NOTE_FOCUS)}
        >
          {replacement.title}
        </button>
      </Tooltip>
      {replacement.status === "own_position"
        ? " is sent at its own position instead."
        : replacement.status === "not_due"
          ? ", used on the turns it applies to."
          : "."}
    </>
  )
  return (
    <div role="tabpanel" id={ids.panelId} aria-labelledby={ids.tabId(tab)} data-note-replaced={tab} className="min-w-0">
      {tab === "replaced" ? (
        <TextField
          store={noteStore}
          path={["content"]}
          label={label}
          labelEnd={tabs}
          replaced
          description={line}
          rows={rows ?? 4}
        />
      ) : (
        render({ labelEnd: tabs })
      )}
    </div>
  )
}

/** "Edit for this chat only": a note of the chat's own, with this text, on from here. */
function ReplaceButton({
  chat,
  target,
  store,
  path,
  label,
  onMade
}: FieldViewProps & {
  chat: ReplaceChat
  target: FieldTarget
  onMade: (made: { note: string; title: string }) => void
}) {
  const call = useCaller()
  const workspace = usePresetWorkspace()
  const names = useNoteTargetNames()
  const notes = useChatNotes(chat)
  const [asking, setAsking] = useState<ReturnType<typeof otherReplacing> | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const what = targetLabel(target, names)
  const fail = (failure: AppError) => {
    setError(failure)
    if (asking === null) showToast({ title: "Couldn't make this chat's version", description: failure.message })
  }
  const make = async () => {
    setPending(true)
    const text = store.text(path)
    const made = await call(
      (client) =>
        client("CreateChatNote", {
          chatId: chat.session.id,
          forkId: chat.view.forkId,
          title: what,
          replaces: storedTarget(target, null),
          content: text
        }),
      ["library"]
    )
    if (!made.ok) {
      setPending(false)
      return fail(made.error)
    }
    const on = await chat.session.changeCast({ _tag: "Note", entityId: made.value.entityId, active: true })
    setPending(false)
    if (!on.ok) return fail(on.error)
    setError(null)
    onMade({ note: made.value.id, title: what })
  }
  const start = () => {
    const others = otherReplacing(notes, target)
    if (others.length > 0) setAsking(others)
    else void make()
  }
  return (
    <>
      <IconButton
        label="Edit for this chat only"
        hint={`Edit ${what} for this chat only. The ${target.kind === "preset_prompt" ? "preset" : "card"} stays as it is; this chat sends your version instead.`}
        icon="note"
        className={chromeButton}
        disabled={pending}
        onClick={start}
      />
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title={`${what} already has a version for this chat`}
        description={`This chat already sends the note ${anyTitles(asking)} in its place, and only one can. Unlinked, it stays an ordinary note.`}
        confirmLabel={`Unlink ${anyTitles(asking)} and start a new version`}
        pending={pending}
        onConfirm={() => {
          const others = asking ?? []
          setAsking(null)
          void Promise.all(others.map((note) => unlinkNote(workspace!, chat, note))).then(() => make())
        }}
      >
        <ErrorAlert error={error} />
      </ConfirmDialog>
    </>
  )
}

const anyTitles = (
  notes: ReadonlyArray<{ readonly doc: Record<string, unknown>; readonly ref: { label: string } }> | null
) =>
  (notes ?? []).map((note) => (note.doc["title"] as string | undefined) || note.ref.label).join(", ") || "Another note"
