// A message's thinking in its edit (SillyTavern's reasoning block edit, "Add reasoning block"
// and its removal): a second field of the message's editor, above its text, as the thinking
// panel sits above the reply, opened by Edit thinking so the edit opens with the panels as
// they were (InPlaceEdit.tsx: nothing moves). Its text is a server draft of its own (`EditThinking`, the edit's
// `version_edit` draft with field `reasoning`), so it outlives the row and a reload as the text
// does, and Save commits both together: a new version, or the user's own version changed in
// place with the earlier thinking in its history. Saved thinking is plain text: the edited
// version has no provider signature, so no request ever replays it as the model's own.
// Without reasoning the field holds the reply's tagged thinking (its sections: an imported ST
// chat's reasoning, or what the auto-parse took out of a reply), which stays tagged thinking.
//
// Both parts are registered (the field in `messageEditorThinking`, Add thinking among the
// editor's tools), so a plugin can replace or remove either.
import type { PathEntry, Version } from "@dreamspan/shared/chat.ts"
import { editableThinking, thinkingInSections } from "@dreamspan/shared/replySections.ts"
import { useCallback, useEffect, useSyncExternalStore } from "react"
import { defineSlot, SlotOutlet } from "../../slots.tsx"
import { AboutHint } from "../../ui/AboutHint.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { messageEditorTools, messageTextEditor } from "./editorHistory.tsx"
import type { MessageDraft, MessageEditorKey } from "./messageDraft.ts"
import type { ChatSession } from "./session.ts"

export interface EditThinkingProps {
  readonly session: ChatSession
  readonly entry: PathEntry
  /** The edit's text editor. */
  readonly draft: MessageDraft
  /** The version edited, once read. */
  readonly source: Version | undefined
}

/** The edit's thinking field, above its text. */
export const messageEditorThinking = defineSlot<EditThinkingProps>("message.editor.thinking")

export const thinkingKey = (versionId: string): MessageEditorKey => `think:${versionId}`

/**
 * What the editor shows of an empty thinking field, per edit: shown though empty (Add thinking
 * was just pressed), and the text a Remove took, which Add thinking brings back.
 */
interface Shown {
  readonly added: boolean
  readonly focus: boolean
  readonly removed: string | null
}
const NONE: Shown = { added: false, focus: false, removed: null }
const shown = new Map<MessageEditorKey, Shown>()
const listeners = new Set<() => void>()
const setShown = (key: MessageEditorKey, next: Shown) => {
  shown.set(key, next)
  for (const listener of listeners) listener()
}
const subscribeShown = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
const useShown = (key: MessageEditorKey) => useSyncExternalStore(subscribeShown, () => shown.get(key) ?? NONE)

/** The edit's thinking editor, opened with the version's thinking when the edit has none yet. */
const useThinkingEditor = ({ session, entry, draft, source }: EditThinkingProps) => {
  const versionId = draft.target._tag === "Edit" ? draft.target.versionId : null
  const key = versionId === null ? null : thinkingKey(versionId)
  const editor = useSyncExternalStore(session.subscribeEditors, () => (key === null ? undefined : session.editor(key)))
  useEffect(() => {
    if (versionId === null || source === undefined || source.id !== versionId) return
    if (session.editor(thinkingKey(versionId)) === undefined)
      session.openEditor({ _tag: "EditThinking", versionId: source.id }, editableThinking(source), entry.slotId)
  }, [session, entry.slotId, versionId, source])
  return { key, editor }
}

const useText = (editor: MessageDraft | undefined) =>
  useSyncExternalStore(
    useCallback((listener: () => void) => editor?.subscribe(listener) ?? (() => {}), [editor]),
    () => editor?.snapshot()
  )

const ABOUT =
  "The reasoning shown folded above the reply. What you write here is saved as plain text, without the provider's signature. Plain chats never send thinking to the model."
/** The thinking is the reply's own tagged thinking (an imported chat's, or parsed from a reply). */
const ABOUT_IN_REPLY =
  "The thinking in the reply, shown folded above it. The model sees it again only if the preset sends thinking back for the last replies."

/**
 * Whether the field stands in for the version's thinking panels: opened (Add or Edit thinking),
 * or its text changed or removed (a reload reopens it so). Until then the edit opens with the
 * panels as they were, so nothing above the text moves (InPlaceEdit.tsx).
 */
const fieldOpen = (state: Shown, text: string, source: Version) => state.added || text !== editableThinking(source)

/** Whether the edit's thinking field stands in for the thinking panels now (Message.tsx hides them). */
export function useThinkingOpen(
  session: ChatSession,
  draft: MessageDraft | undefined,
  source: Version | undefined
): boolean {
  const versionId = draft?.target._tag === "Edit" ? draft.target.versionId : null
  const key = versionId === null ? null : thinkingKey(versionId)
  const editor = useSyncExternalStore(session.subscribeEditors, () => (key === null ? undefined : session.editor(key)))
  const view = useText(editor)
  const state = useShown(key ?? "think:")
  if (view === undefined || view.loading || source === undefined || source.id !== versionId) return false
  return fieldOpen(state, view.text, source)
}

function ThinkingField(props: EditThinkingProps) {
  const { source, draft } = props
  const { key, editor } = useThinkingEditor(props)
  const view = useText(editor)
  const state = useShown(key ?? "think:")
  if (key === null || editor === undefined || view === undefined || source === undefined) return null
  if (view.loading) return null
  if (view.text === "" ? !state.added : !fieldOpen(state, view.text, source)) return null
  return (
    <div className="flex flex-col gap-1" data-edit-thinking>
      <div className="flex items-center gap-1 text-sm text-muted">
        <span>Thinking</span>
        <AboutHint heading="Thinking">{thinkingInSections(source) ? ABOUT_IN_REPLY : ABOUT}</AboutHint>
      </div>
      <SlotOutlet
        slot={messageTextEditor}
        props={{
          label: "Thinking",
          value: view.text,
          base: editableThinking(source),
          autoFocus: state.focus,
          quietMarkers: true,
          expand: false,
          rows: 3,
          tools: (
            <IconButton
              icon="trash"
              label="Remove thinking"
              hint="Takes the thinking off this message when you save. Add thinking brings it back."
              onClick={() => {
                setShown(key, { added: false, focus: false, removed: view.text })
                editor.setText("")
                draft.keepOpen()
              }}
            />
          ),
          onChange: (value) => {
            editor.setText(value)
            // The edit opens again after a reload when only its thinking was changed.
            draft.keepOpen()
          }
        }}
      />
      {view.error && (
        <p role="alert" className="text-sm text-danger">
          The thinking isn’t saved as a draft yet: {view.error.message}
        </p>
      )}
    </div>
  )
}

/** Add thinking, among the editor's tools while the field isn't shown. */
function AddThinking({
  session,
  entry,
  draft,
  source
}: {
  session: ChatSession
  entry: PathEntry
  draft: MessageDraft
  source?: Version | undefined
}) {
  const { key, editor } = useThinkingEditor({ session, entry, draft, source })
  const view = useText(editor)
  const state = useShown(key ?? "think:")
  if (key === null || editor === undefined || view === undefined || view.loading || source === undefined) return null
  if (state.added) return null
  // The thinking it has, shown folded above the text until this opens it for editing.
  if (view.text !== "")
    return fieldOpen(state, view.text, source) ? null : (
      <IconButton
        icon="reasoning"
        label="Edit thinking"
        hint="Opens this message's thinking for editing, in place of its folded thinking. Saved as plain text."
        onClick={() => setShown(key, { added: true, focus: true, removed: null })}
      />
    )
  return (
    <IconButton
      icon="reasoning"
      label="Add thinking"
      hint="Adds thinking to this message, shown folded above its text. Saved as plain text."
      onClick={() => {
        setShown(key, { added: true, focus: true, removed: null })
        if (state.removed) editor.setText(state.removed)
      }}
    />
  )
}

/** Forgets what the editor showed of an edit's thinking: the edit was saved or cancelled. */
export const forgetThinking = (versionId: string) => {
  if (shown.delete(thinkingKey(versionId))) for (const listener of listeners) listener()
}

export const registerEditThinking = () => [
  messageEditorThinking.register({ id: "message.editor-thinking", order: 10, component: ThinkingField }),
  messageEditorTools.register({ id: "message.editor-add-thinking", order: 3, component: AddThinking })
]
