// Guidance on swipes (DESIGN §2.2, owner 2026-10-29). The guidance under a reply has a
// "New version…" button (a reply without any has "New version with guidance…" in its menu):
// it puts that guidance in the composer's box, with a bar above the composer naming the reply.
// Neither changes the version shown: only a new version uses the text (owner, 2026-11-01). While the bar is up, any
// submit makes a new version of that reply with the box's text, and the text stays for the
// next one; that reply's swipes use the box as it is. ✕ gives the box back to new turns, with
// the draft it held before. The composer's own draft is never written meanwhile (Composer.tsx).
import type { EntityId, ForkId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import { useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { nameOf, useCast } from "./cast.ts"
import { composerControls, type ComposerControlContext } from "./composerControls.tsx"
import { messageActions, viewOf } from "./messageActions.tsx"
import { messageDirections } from "./presentation.tsx"
import type { ChatSession, ChatView, GuidanceRequest } from "./session.ts"

/** The reply whose guidance the composer's box holds, and the box's text. */
export interface GuidanceEdit {
  readonly slotId: SlotId
  /** The fork it was opened in; showing another closes the bar. */
  readonly forkId: ForkId | null
  readonly speakerEntityId: EntityId | null
  readonly text: string
}

export class GuidanceEditor {
  private edit: GuidanceEdit | null = null
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  readonly snapshot = () => this.edit

  private set(edit: GuidanceEdit | null) {
    this.edit = edit
    for (const listener of this.listeners) listener()
  }

  /** Puts the guidance of the version shown in the box, for new versions of its reply. */
  open(entry: PathEntry, forkId: ForkId | null) {
    const { version } = entry
    this.set({
      slotId: entry.slotId,
      forkId,
      speakerEntityId: version.speakerEntityId ?? entry.firstSpeakerEntityId,
      text: version.writer === "model" ? (version.direction ?? "") : ""
    })
  }

  type(text: string) {
    if (this.edit !== null && this.edit.text !== text) this.set({ ...this.edit, text })
  }

  close() {
    if (this.edit !== null) this.set(null)
  }

  /**
   * The guidance a new version or Continue of `slotId` is asked with: the box's text for the
   * reply being edited; none for Continue of another; undefined (the re-rolled version's own)
   * for a new version of any other reply.
   */
  guidanceFor(slotId: SlotId, kind: "version" | "continue"): string | undefined {
    if (this.edit?.slotId === slotId) return this.edit.text
    return kind === "continue" && this.edit !== null ? "" : undefined
  }
}

/**
 * What the composer answers a new version or Continue (ChatSession.provideGuidance): while a
 * reply's guidance is edited, the editor's answer; otherwise a new version reuses its reply's
 * own guidance, never the box's, and Continue takes the box's text with the toggle on.
 */
export const composerGuidance =
  (editor: GuidanceEditor, toggleOn: () => boolean, boxText: () => string) =>
  ({ slotId, kind }: GuidanceRequest): string | undefined => {
    if (editor.snapshot() !== null) return editor.guidanceFor(slotId, kind)
    return kind === "continue" && toggleOn() ? boxText() : undefined
  }

/** Whether the bar stays up: its reply is still on the path shown, in the fork it was opened in. */
export const editStillShown = (edit: GuidanceEdit, view: Pick<ChatView, "forkId" | "entries">) =>
  view.forkId === edit.forkId && view.entries.some((entry) => entry.slotId === edit.slotId)

const editors = new WeakMap<ChatSession, GuidanceEditor>()

/** The chat's guidance editor; a chat opened again starts without one open. */
export const guidanceEditor = (session: ChatSession): GuidanceEditor => {
  let editor = editors.get(session)
  if (editor === undefined) {
    editor = new GuidanceEditor()
    editors.set(session, editor)
  }
  return editor
}

export const useGuidanceEdit = (session: ChatSession) => {
  const editor = guidanceEditor(session)
  return useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot)
}

const editGuidance = (session: ChatSession, entry: PathEntry) => {
  guidanceEditor(session).open(entry, session.snapshot().forkId)
  document.getElementById("composer")?.focus()
}

/** The guidance a reply was written with, under it, with New version… to write another with it changed. */
export function MessageDirection({ entry, session }: { entry: PathEntry; session: ChatSession }) {
  const { version } = entry
  if (version.writer !== "model" || !version.direction) return null
  return (
    <div className="flex items-start gap-1 text-xs text-muted">
      <p className="min-w-0 flex-1 pt-1.5 wrap-break-word">
        <span className="font-medium">Guidance:</span> {version.direction}
      </p>
      <Tooltip label="Puts this guidance in the composer to change it: sending writes a new version of this reply with it. This version and its guidance stay as they are.">
        <Button
          variant="ghost"
          className="h-7! shrink-0 px-2! text-xs"
          aria-label="New version with this guidance"
          onClick={() => editGuidance(session, entry)}
        >
          New version…
        </Button>
      </Tooltip>
    </div>
  )
}

/** The box's header line while it holds a reply's guidance (the composer's `banner`). */
function GuidanceEditBar({ session }: ComposerControlContext) {
  const edit = useGuidanceEdit(session)
  const castView = useCast()
  if (edit === null) return null
  const name = nameOf(castView, edit.speakerEntityId)
  return (
    <div
      role="status"
      data-testid="guidance-edit-bar"
      className="flex items-center gap-2 py-0 pr-0 pl-1.5 text-sm text-guidance"
    >
      <Icon name="guidance" size={16} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium">
        Guidance for a new version of {name ? `${name}'s` : "this"} reply
      </span>
      <IconButton
        label="Close: back to new messages"
        hint="Close: the composer writes new messages again, with the text it had before. The new versions made stay."
        icon="close"
        onClick={() => guidanceEditor(session).close()}
      />
    </div>
  )
}

export const registerGuidanceEdit = () => [
  messageDirections.register({ id: "message.direction", order: 10, component: MessageDirection }),
  messageActions.register({
    id: "message.add-guidance",
    order: 40,
    group: "change",
    available: ({ entry, generating }) => !generating && entry.version.writer === "model" && !entry.version.direction,
    describe: viewOf(({ session, entry }) => ({
      label: "New version with guidance…",
      icon: "guidance",
      hint: "Write guidance in the composer for a new version of this reply: sending writes the new version, and this one stays as it is.",
      onSelect: () => editGuidance(session, entry)
    }))
  }),
  composerControls.register({
    id: "composer.guidance-edit",
    order: 10,
    placement: "banner",
    component: GuidanceEditBar
  })
]
