// A message's edit in place of its text (owner, 2026-11-23: editing must feel seamless, with
// nothing moving as it opens or closes). The edit's text box takes the rendered text's place in
// the message's body (Message.tsx `VersionBody`), as tall as the text was and with its metrics
// (styles.css `.message-edit-text`, the editor's `bare` mode), so its lines fall where the text's
// were; Save, Cancel and the edit's tools take the place of the message's actions in its footer
// row, which every message has; the thinking panels stay as they are: the edit never involves the
// thinking, which is edited on its own (editThinking.tsx). Its text is the same server draft and browser
// copy as any message edit (messageDraft.ts).
//
// The text box is the registered `messageTextEditor` (editorHistory.tsx): a surface replacing it
// gets `bare`, keeps the metrics contract (ARCHITECTURE §12, "Editing"), and grows with its text.
import type { PathEntry, Version } from "@dreamspan/shared/chat.ts"
import {
  type KeyboardEvent,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore
} from "react"
import { SlotOutlet } from "../../slots.tsx"
import { EditorTextActions } from "../../textActions.tsx"
import { Button } from "../../ui/Button.tsx"
import type { EditCaret } from "../../ui/editCaret.ts"
import { Icon } from "../../ui/Icon.tsx"
import { popupOpen } from "../../ui/openPopups.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { ReplayNotice } from "../editor/ReplayNotice.tsx"
import { tokenizerText, tokensText, useTokenCounts } from "../editor/tokenCounts.ts"
import {
  availableCommands,
  type ChatCommandContext,
  chatCommands,
  invokeChatCommand,
  runCommandShortcut
} from "./commands.tsx"
import { messageEditorTools, messageTextEditor, useMessageSaveOptions } from "./editorHistory.tsx"
import type { MessageDraft } from "./messageDraft.ts"
import type { ChatSession } from "./session.ts"

/**
 * The version an edit edits, and its text (the base its changes are against), once known: among
 * the versions shown, else read from the slot's versions. A version written by the user has
 * no source and the empty base. Once known it stays known while the version shown changes (an
 * import or another device selecting another one), so the edit stays open meanwhile.
 */
export function useEditSource(
  session: ChatSession,
  entry: PathEntry,
  draft: MessageDraft | undefined,
  known: ReadonlyArray<Version>
): { source: Version | undefined; base: string | undefined } {
  const id = draft?.target._tag === "Edit" ? draft.target.versionId : null
  const shown = id === null ? undefined : known.find((version) => version.id === id)
  const [read, setRead] = useState<Version | undefined>(shown)
  if (shown && (shown.id !== read?.id || shown.content !== read.content)) setRead(shown)
  useEffect(() => {
    if (id === null || shown) return
    let live = true
    void session.listVersions(entry.slotId).then((result) => {
      if (live && result.ok) setRead(result.value.find((version) => version.id === id))
    })
    return () => {
      live = false
    }
  }, [session, entry.slotId, id, shown])
  if (draft === undefined) return { source: undefined, base: undefined }
  if (id === null) return { source: undefined, base: "" }
  const source = shown ?? (read?.id === id ? read : undefined)
  return { source, base: source?.content }
}

/** Whether the edit's saved text is read, so its box can take the text's place. */
export const useDraftLoaded = (draft: MessageDraft | undefined) =>
  useSyncExternalStore(draft?.subscribe ?? noSubscribe, () => (draft ? !draft.snapshot().loading : false))

/** The edit's commands: Save through `message.save` (Ctrl+Enter, the Save button). */
const editCommands = (session: ChatSession, onSave: () => void): ChatCommandContext => ({
  session,
  view: session.snapshot(),
  onHistory: () => {},
  onJump: () => {},
  saveMessageEdit: onSave
})

/** Saves the edit as the registered `message.save` does. */
export const saveEdit = (session: ChatSession, onSave: () => void) =>
  invokeChatCommand("message.save", editCommands(session, onSave))

/** Whether a key was pressed in this edit rather than in an edit nested in it. */
const ownKey = (event: KeyboardEvent) =>
  !(event.target instanceof Element) || event.target.closest("[data-edit-keys]") === event.currentTarget

/**
 * The edit's keys, on what holds it: Ctrl+Enter saves, Escape cancels. A key in another edit
 * inside it (the thinking's editor in a message being edited) is that one's, not this one's.
 */
export const editKeys = (session: ChatSession, onSave: () => void, onCancel: () => void) => ({
  "data-edit-keys": "",
  onKeyDownCapture: (event: KeyboardEvent) => {
    if (!ownKey(event)) return
    // Handle Save before CodeMirror's Mod+Enter binding inserts a blank line.
    if (
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey) &&
      runCommandShortcut(event.nativeEvent, editCommands(session, onSave))
    ) {
      event.preventDefault()
      event.stopPropagation()
    }
  },
  onKeyDown: (event: KeyboardEvent) => {
    // A modal can open before its focus effect moves focus off the edit's own
    // trigger. Escape belongs to that modal, even when its target is here.
    if (
      event.key === "Escape" &&
      ownKey(event) &&
      event.currentTarget.contains(event.target as Node) &&
      !event.defaultPrevented &&
      !popupOpen()
    )
      onCancel()
  }
})

/** The selected text of an edit's box, for its text actions where its controls are. */
export interface EditSelection {
  readonly get: () => string
  readonly set: (text: string) => void
  readonly subscribe: (listener: () => void) => () => void
}
export function editSelection(): EditSelection {
  let text = ""
  const listeners = new Set<() => void>()
  return {
    get: () => text,
    set: (next) => {
      if (next === text) return
      text = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
}

/**
 * The edit's text box, in the rendered text's place. Opened from the text, it's exactly as tall
 * as the text was (`height`, measured as it opened) until the first change, scrolling inside if
 * the stored text runs longer than the rendered one (markdown marks); then at least that tall,
 * growing as the text does. Opened with the message (a reload), it's as tall as its text.
 */
export function InPlaceText({
  draft,
  base,
  height,
  caret,
  onCaretTaken,
  onCaretPlaced,
  onFirstFocus,
  onShown,
  selection,
  selectionScopeFocused
}: {
  draft: MessageDraft
  base: string
  height: number | null
  /** Where the caret opens (a double-click's place in the text, and its line's place on screen), else at the end. */
  caret: EditCaret | undefined
  onCaretTaken: () => void
  onCaretPlaced: () => void
  /** The first focus of an edit opened without a caret (Edit): its controls come into view. */
  onFirstFocus: () => void
  /** Its text is drawn, before the frame is painted: the rendered text it replaces can go. */
  onShown: () => void
  selection: EditSelection
  selectionScopeFocused: boolean
}) {
  const { text, added } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  // The editor may mount after the saved text loads: it still opens at the first caret.
  const [initialCaret] = useState(caret)
  useEffect(() => {
    if (initialCaret !== undefined) onCaretTaken()
  }, [initialCaret, onCaretTaken])
  const [opened] = useState(text)
  const [changed, setChanged] = useState(false)
  if (!changed && text !== opened) setChanged(true)
  const [focused, setFocused] = useState(initialCaret !== undefined)
  const held = height !== null && !changed
  return (
    <div
      data-message-edit-text
      // Holding the caret's line where it was clicked scrolls this box at most, never the chat (holdCaret.ts).
      data-hold-caret-within
      className="message-edit-text rounded-sm outline-1 outline-offset-2 outline-border focus-within:outline-2 focus-within:outline-focus"
      style={
        height === null
          ? undefined
          : { minHeight: height, ...(held ? { maxHeight: height, overflowY: "auto" as const } : {}) }
      }
      onFocus={() => {
        if (focused) return
        setFocused(true)
        onFirstFocus()
      }}
    >
      <Suspense fallback={null}>
        <SlotOutlet
          slot={messageTextEditor}
          props={{
            label: "Message text",
            value: text,
            base,
            bare: true,
            // Opened from the chat's other view, it leaves focus there (Composition.tsx).
            autoFocus: !draft.mirror,
            caret: initialCaret?.offset,
            caretTop: initialCaret?.top,
            onCaretPlaced,
            suspend: true,
            // Text just added to your version: marked and scrolled to, focus left where it is.
            flash: added,
            onSelectionChange: selection.set,
            selectionScopeFocused,
            onChange: (value) => draft.setText(value)
          }}
        />
        <EditorCommitted onShown={onShown} />
      </Suspense>
    </div>
  )
}

/** The registered surface has committed, including its layout effects. */
function EditorCommitted({ onShown }: { onShown: () => void }) {
  useLayoutEffect(onShown, [onShown])
  return null
}

/**
 * What an edit's text has to say beside it: its saved text still loading (with Retry when that
 * failed), a draft the server doesn't have yet, a replay over text saved elsewhere.
 */
export function EditStatus({ draft, base }: { draft: MessageDraft; base: string | undefined }) {
  const { loading, error, conflict } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  return (
    <>
      {(loading || base === undefined) && error && (
        <p role="status" className="text-sm">
          The saved edit didn’t load.{" "}
          <Button type="button" onClick={() => void draft.open()} hint="Loads the saved edit before you type.">
            Retry
          </Button>
        </p>
      )}
      {error && !loading && (
        <p role="alert" className="text-sm text-danger">
          The text isn’t saved as a draft yet: {error.message}
        </p>
      )}
      {conflict && (
        <ReplayNotice
          conflict={conflict}
          acknowledge={() => draft.acknowledgeConflict()}
          switchText={() => draft.switchConflict()}
        />
      )}
    </>
  )
}

/**
 * An edit's Save, its other save options, Cancel, its text actions and the registered editor tools.
 * `layout`: "row" under a version the user writes (Composition.tsx), wrapping as it needs;
 * "footer" in the message's footer row, as tall as the row's own buttons, the labels of Save and
 * Cancel in their explanations on a phone.
 */
export function EditControls({
  draft,
  base,
  source,
  session,
  entry,
  saveLabel,
  offerSaves,
  onSave,
  onSaveWith,
  onCancel,
  selection,
  layout
}: {
  draft: MessageDraft
  base: string | undefined
  source: Version | undefined
  session: ChatSession
  entry: PathEntry
  saveLabel: string
  /** An edit of the message's text, where the registered save options are offered. */
  offerSaves: boolean
  onSave: () => void
  /** Saves, then runs `after` with the text saved: a registered save option's (messageSaveOptions). */
  onSaveWith: (after: (text: string) => Promise<void>) => void
  onCancel: () => void
  /** The text box's selection, for its text actions; without it they're in the box's own strip. */
  selection?: EditSelection | undefined
  layout: "row" | "footer"
}) {
  const { text, imagesBusy } = useSyncExternalStore(draft.subscribe, draft.snapshot)
  const selected = useSyncExternalStore(selection?.subscribe ?? noSubscribe, selection?.get ?? noSelection)
  const commandSnapshot = useSyncExternalStore(chatCommands.subscribe, chatCommands.snapshot, chatCommands.snapshot)
  const offered = useMessageSaveOptions(entry)
  const saves = offerSaves ? offered : []
  // Beside another way to save ("Save in both"), Save says where it saves ("Save here").
  const shownSave = saves[0]?.here ?? saveLabel
  const commands = editCommands(session, onSave)
  const disabled =
    imagesBusy || !availableCommands(commands, commandSnapshot).some((command) => command.id === "message.save")
  const footer = layout === "footer"
  const label = footer ? "max-sm:sr-only" : undefined
  const tools = base !== undefined && (
    <SlotOutlet
      slot={messageEditorTools}
      props={{
        draft,
        base,
        session,
        entry,
        source,
        images: (draft.target._tag === "Edit" ? source?.images : entry.version.images) ?? []
      }}
    />
  )
  return (
    <div
      role="group"
      aria-label="Edit"
      data-message-edit-controls={footer || undefined}
      className={
        footer
          ? // As tall as the footer's own buttons: opening the edit leaves the row as it was. A
            // version's images go on a line of their own above them (images.tsx).
            // The tools after Save and Cancel are icon buttons side by side with no gap, as the
            // message's actions and versions beside them are: one square each, one spacing.
            "flex min-w-0 flex-1 flex-wrap items-center gap-y-1 [&_button:not(li_*)]:h-8"
          : "flex flex-wrap items-center gap-y-2"
      }
    >
      <div className={`flex flex-wrap items-center ${footer ? "gap-1" : "gap-2"}`}>
        <Tooltip label={`${shownSave} (Ctrl+Enter)`}>
          <Button
            type={footer ? "button" : "submit"}
            variant="primary"
            disabled={disabled}
            className={footer ? "max-sm:w-8 max-sm:px-0" : ""}
            {...(footer ? { onClick: () => saveEdit(session, onSave) } : {})}
          >
            <Icon name="check" />
            <span className={label}>{shownSave}</span>
          </Button>
        </Tooltip>
        {saves.map(({ option }) => (
          <option.component key={option.id} entry={entry} session={session} disabled={disabled} save={onSaveWith} />
        ))}
        <Button
          onClick={onCancel}
          className={footer ? "max-sm:w-8 max-sm:px-0" : ""}
          hint={
            draft.target._tag === "Write"
              ? "Closes the editor without adding a swipe."
              : "Closes the message editor without saving."
          }
        >
          <Icon name="close" />
          <span className={label}>Cancel</span>
        </Button>
      </div>
      <span className="flex-1" />
      <EditTokens text={text} session={session} />
      {selection && <EditorTextActions text={text} selection={selected} shown size="row" keepSelection />}
      {tools}
    </div>
  )
}

/**
 * The edited text's tokens with the tokenizer of this chat's model (the one its next reply uses,
 * as the composer's model chip shows: its own, else the account's), counted once typing rests,
 * as a card field's are (editor/tokenCounts.ts). Beside the editor's icon buttons, away from Save
 * and Cancel. Its width is reserved and its digits are tabular, so the row stays put as the
 * number changes; on a phone the number alone, its word in its name and explanation.
 */
function EditTokens({ text, session }: { text: string; session: ChatSession }) {
  const texts = useMemo(() => [text], [text])
  const chatModel = useSyncExternalStore(session.subscribe, () => session.snapshot().cast?.model ?? undefined)
  const { counts, tokenizer, pending } = useTokenCounts(texts, chatModel)
  const shown = tokensText(counts[0] ?? null, tokenizer, pending)
  return (
    <Tooltip label={`The tokens in this message's text. ${tokenizerText(tokenizer)}`}>
      <span
        tabIndex={0}
        data-edit-tokens
        aria-label={shown}
        aria-busy={pending || undefined}
        className="min-w-[7ch] px-1 shrink-0 rounded text-right text-xs whitespace-nowrap text-muted tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus sm:min-w-[14ch]"
      >
        {shown.replace(/ tokens$/, "")}
        <span className="max-sm:hidden"> tokens</span>
      </span>
    </Tooltip>
  )
}

const noSubscribe = () => () => {}
const noSelection = () => ""
