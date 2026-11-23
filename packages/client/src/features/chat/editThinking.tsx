// A message's thinking, edited on its own (SillyTavern's reasoning block edit, "Add reasoning
// block" and its removal; owner, 2026-11-23: editing the message never involves its thinking).
// The thinking panel's Edit (its header's row, beside Copy reasoning) opens an editor in the
// panel's place, its Save, Cancel and Delete and its token count in the strip inside its box
// (as a note's or a card field's), and a double-click on the thinking opens it there with
// the caret where it landed (Message.tsx); a reply without thinking gets one from the
// message's Add thinking action, where the panel would be. Its text is a server draft of its own
// (`EditThinking`, the version's `version_edit` draft with field `reasoning`), so it outlives the
// row and a reload. Save makes a new version with the thinking typed and the text as it is, or
// changes the user's own version in place with the earlier thinking in its history, as an edit
// does (`ChatSession.edit`). Saved thinking is plain text: the edited version has no provider
// signature, so no request ever replays it as the model's own. Without reasoning the editor
// holds the reply's tagged thinking (its sections: an imported ST chat's reasoning, or what the
// auto-parse took out of a reply), which stays tagged thinking, and opens in that panel.
//
// The parts are registered (Edit in `reasoningActions`, Add thinking in `messageActions`), so
// a plugin can replace or remove either.
import type { PathEntry, Version } from "@dreamspan/shared/chat.ts"
import { editableThinking, thinkingInSections } from "@dreamspan/shared/replySections.ts"
import { useCallback, useState, useSyncExternalStore } from "react"
import { SlotOutlet } from "../../slots.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import type { EditCaret } from "../../ui/editCaret.ts"
import { chromeButton } from "../../ui/FieldFrame.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { TokenCount } from "../editor/TokenCount.tsx"
import { messageTextEditor } from "./editorHistory.tsx"
import { editKeys } from "./InPlaceEdit.tsx"
import { invokeMessageAction, messageActions, viewOf } from "./messageActions.tsx"
import type { MessageDraft, MessageEditorKey } from "./messageDraft.ts"
import { type ReasoningActionProps, reasoningActions } from "./presentation.tsx"
import type { ChatSession } from "./session.ts"

export const thinkingKey = (versionId: string): MessageEditorKey => `think:${versionId}`

/** The panel a version's editable thinking shows in: its tagged sections when it has no reasoning. */
export const thinkingPanel = (version: Version): "reasoning" | "sections" =>
  thinkingInSections(version) ? "sections" : "reasoning"

/** The open editor of a version's thinking, if any. */
export const useThinkingEditor = (session: ChatSession, versionId: string) =>
  useSyncExternalStore(session.subscribeEditors, () => session.editor(thinkingKey(versionId)))

/** Editors opened by a click, which take focus when they show. */
const focusNext = new Set<MessageEditorKey>()
/** Where a double-click on the thinking puts the caret of the editor it opens. */
const caretNext = new Map<MessageEditorKey, EditCaret>()

/**
 * Opens the editor of the message's thinking, with its thinking (none: empty), focused: with
 * the caret at `caret` (a double-click on the thinking, Message.tsx), else at the end.
 */
export const openThinking = (session: ChatSession, entry: PathEntry, caret?: EditCaret) => {
  const key = thinkingKey(entry.version.id)
  focusNext.add(key)
  if (caret) caretNext.set(key, caret)
  else caretNext.delete(key)
  session.openEditor(
    { _tag: "EditThinking", versionId: entry.version.id },
    editableThinking(entry.version),
    entry.slotId
  )
}

const entryOf = (session: ChatSession, version: Version) =>
  session.snapshot().entries.find((entry) => entry.version.id === version.id)

const useText = (editor: MessageDraft) =>
  useSyncExternalStore(
    useCallback((listener: () => void) => editor.subscribe(listener), [editor]),
    () => editor.snapshot()
  )

const ABOUT =
  "Saved as plain text, without the provider's signature, as a new swipe (your own message changes in place), so it isn't sent back to the model."

/** The thinking's editor, in its panel's place, at the panel's text size. */
export function ThinkingEditor({
  session,
  version,
  editor
}: {
  session: ChatSession
  version: Version
  editor: MessageDraft
}) {
  const view = useText(editor)
  const key = thinkingKey(version.id)
  // How a click opened it (taken once): focused, with the caret where a double-click landed.
  const [opening] = useState(() => {
    const caret = caretNext.get(key)
    caretNext.delete(key)
    return { focus: focusNext.delete(key), caret }
  })
  const chatModel = useSyncExternalStore(session.subscribe, () => session.snapshot().cast?.model ?? undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const base = editableThinking(version)

  const save = async () => {
    if (busy) return
    const entry = entryOf(session, version)
    if (!entry) return setError("This swipe isn't shown any more.")
    setBusy(true)
    setError(null)
    // Its revision must be fresh: another tab may have changed the version since it was read.
    const listed = await session.listVersions(entry.slotId)
    const source = listed.ok ? listed.value.find((candidate) => candidate.id === version.id) : undefined
    const thought = await editor.ready()
    if (source === undefined) {
      setBusy(false)
      return setError(listed.ok ? "This swipe isn't there any more." : listed.error.message)
    }
    // Unchanged: nothing to save, no version made.
    if (thought.text === editableThinking(source)) {
      const ended = await editor.discard()
      setBusy(false)
      if (!ended.ok) return setError(ended.error.message)
      return session.closeEditor(editor)
    }
    const outcome = await session.edit({ ...entry, version: source }, source.content, null, undefined, {
      text: thought.text,
      draft: thought.draft
    })
    setBusy(false)
    if (!outcome.ok) return setError(outcome.error.message)
    // Text typed while it was being saved stays in the editor, which stays open.
    if (!editor.committed(thought)) return
    if (thought.draft === null) await editor.discard()
    session.closeEditor(editor)
  }
  const cancel = async () => {
    // Its text goes to the bin's recovered texts, never nowhere (DESIGN §6.2).
    const outcome = await editor.discard()
    if (!outcome.ok) return setError(outcome.error.message)
    session.closeEditor(editor)
  }
  // Ctrl+Enter and Escape save and cancel this editor only, not a message edit around it.
  const keys = editKeys(
    session,
    () => void save(),
    () => void cancel()
  )

  return (
    <div className="flex flex-col gap-2 text-sm" data-thinking-edit {...keys}>
      {view.loading ? (
        <p role="status">
          Loading saved thinking…{" "}
          {view.error && (
            <Button type="button" onClick={() => void editor.open()} hint="Loads the saved thinking before you type.">
              Retry
            </Button>
          )}
        </p>
      ) : (
        <SlotOutlet
          slot={messageTextEditor}
          props={{
            label: "Thinking",
            value: view.text,
            base,
            autoFocus: opening.focus,
            caret: opening.caret?.offset,
            caretTop: opening.caret?.top,
            quietMarkers: true,
            rows: 3,
            // The strip inside the box, as a note's or a card field's (ui/FieldFrame.tsx): its
            // token count at the start, its buttons over the box's lower right corner.
            status: (
              <span data-field-reveal>
                <TokenCount text={view.text} about="The tokens in this thinking." model={chatModel} />
              </span>
            ),
            tools: (
              <>
                <IconButton
                  icon="trash"
                  label="Delete thinking"
                  hint="Empties the box: saving then takes the thinking off this message."
                  className={chromeButton}
                  onClick={() => editor.setText("")}
                />
                <IconButton
                  icon="close"
                  label="Cancel"
                  hint="Closes the thinking editor without saving (Escape)."
                  className={chromeButton}
                  onClick={() => void cancel()}
                />
                <IconButton
                  icon="check"
                  label="Save thinking"
                  hint={`Saves the thinking (Ctrl+Enter). ${ABOUT}`}
                  className={chromeButton}
                  disabled={busy}
                  onClick={() => void save()}
                />
              </>
            ),
            onChange: (value) => editor.setText(value)
          }}
        />
      )}
      {!view.loading && view.error && (
        <p role="alert" className="text-danger">
          The thinking isn’t saved as a draft yet: {view.error.message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-danger">
          The thinking wasn’t saved: {error}
        </p>
      )}
    </div>
  )
}

const actionClass =
  "flex items-center rounded-md px-1 py-0.5 text-xs text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"

/** Edit, in the thinking panel's row: the panel the version's editable thinking is in, once written. */
function EditThinkingAction({ version, kind, streaming, session }: ReasoningActionProps) {
  const editor = useThinkingEditor(session, version.id)
  if (streaming || editor !== undefined || kind !== thinkingPanel(version)) return null
  return (
    <Tooltip label="Edit this thinking in its place, apart from the message's text. Saved as plain text.">
      <button
        type="button"
        aria-label="Edit thinking"
        className={actionClass}
        onClick={() => {
          const entry = entryOf(session, version)
          if (entry) openThinking(session, entry)
        }}
      >
        <Icon name="edit" size={14} />
      </button>
    </Tooltip>
  )
}

export const registerEditThinking = () => [
  reasoningActions.register({ id: "reasoning.edit", order: 5, component: EditThinkingAction }),
  messageActions.register({
    id: "message.add-thinking",
    order: 45,
    group: "change",
    available: ({ entry }) => editableThinking(entry.version) === "",
    disabled: ({ generating }) => (generating ? "Wait for this reply to finish before adding thinking." : null),
    run: ({ session, entry }) => openThinking(session, entry),
    describe: viewOf((context) => ({
      label: "Add thinking",
      icon: "reasoning",
      hint: "Adds thinking to this message, shown folded above its text. Saved as plain text.",
      onSelect: () => invokeMessageAction("message.add-thinking", context, "button")
    }))
  })
]
