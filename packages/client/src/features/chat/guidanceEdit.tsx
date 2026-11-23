// Guidance on swipes (DESIGN §2.2, owner 2026-10-29). The guidance under a reply has a
// pencil (Edit this guidance) button (a reply without any has "New version with guidance…" in its menu):
// it puts that guidance in the composer's box, with a bar above the composer naming the reply.
// Neither changes the version shown: only a new version uses the text (owner, 2026-11-01). While the bar is up, any
// submit makes a new version of that reply with the box's text, and the text stays for the
// next one; that reply's swipes use the box as it is. ✕ gives the box back to new turns. The box's
// text is always the composer draft's (one box, one draft: owner 2026-11-21), so a reload keeps it.
import type { EntityId, ForkId, PathEntry, SlotId } from "@dreamspan/shared/chat.ts"
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { Icon } from "../../ui/Icon.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { focusComposer } from "./composerFocus.ts"
import { nameOf, useCast } from "./cast.ts"
import { composerControls, type ComposerControlContext } from "./composerControls.tsx"
import { messageActions, viewOf } from "./messageActions.tsx"
import { messageDirections } from "./presentation.tsx"
import { composerChoice } from "./speaker.ts"
import type { ChatSession, ChatView, GuidanceRequest } from "./session.ts"

/**
 * The reply the composer's text is aimed at while its guidance is written (DESIGN §2.2). The
 * text itself is the composer draft's (one box, one draft: owner 2026-11-21), saved and backed
 * up like any typing; the reply is a choice kept with that draft on the server
 * (`ComposerChoice.guidanceSlotId`, speaker.ts), so a reload, another tab or another device
 * reopens the mode. The composer follows the choice into this editor (`follow`).
 */
export interface GuidanceEdit {
  readonly slotId: SlotId
  /** The fork it was opened in; showing another closes the bar. */
  readonly forkId: ForkId | null
  readonly speakerEntityId: EntityId | null
}

const speakerOf = (entry: PathEntry) => entry.version.speakerEntityId ?? entry.firstSpeakerEntityId

export class GuidanceEditor {
  private edit: GuidanceEdit | null = null
  /** Guidance the reply had, for the composer to put in its draft when opened. */
  private pending: string | null = null
  private readonly listeners = new Set<() => void>()
  /** Keeps the reply chosen with the composer's draft (null: none). */
  private readonly persist: (slotId: SlotId | null) => void

  constructor(persist: (slotId: SlotId | null) => void = () => {}) {
    this.persist = persist
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  readonly snapshot = () => this.edit

  private set(edit: GuidanceEdit | null) {
    this.edit = edit
    for (const listener of this.listeners) listener()
  }

  /**
   * Shows the reply the draft's choice names (a reload, another tab), without writing it back.
   * A reply not on the path shown leaves the bar closed.
   */
  follow(slotId: SlotId | null, view: Pick<ChatView, "forkId" | "entries">) {
    if ((this.edit?.slotId ?? null) === slotId) return
    const entry = slotId === null ? undefined : view.entries.find((e) => e.slotId === slotId)
    this.pending = null
    this.set(
      entry === undefined ? null : { slotId: entry.slotId, forkId: view.forkId, speakerEntityId: speakerOf(entry) }
    )
  }

  /** Aims the composer at new versions of this reply; its guidance (if any) goes into the draft. */
  open(entry: PathEntry, forkId: ForkId | null) {
    const { version } = entry
    const direction = version.writer === "model" ? (version.direction ?? "") : ""
    this.pending = direction === "" ? null : direction
    this.set({ slotId: entry.slotId, forkId, speakerEntityId: speakerOf(entry) })
    this.persist(entry.slotId)
  }

  /** The reply's guidance to put in the draft, once. */
  takePending(): string | null {
    const pending = this.pending
    this.pending = null
    return pending
  }

  close() {
    this.pending = null
    if (this.edit === null) return
    this.set(null)
    this.persist(null)
  }

  /**
   * The guidance a new version or Continue of `slotId` is asked with: the box's text for the
   * reply being edited; none for Continue of another; undefined (the re-rolled version's own)
   * for a new version of any other reply.
   */
  guidanceFor(slotId: SlotId, kind: "version" | "continue", boxText: string): string | undefined {
    if (this.edit?.slotId === slotId) return boxText
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
    if (editor.snapshot() !== null) return editor.guidanceFor(slotId, kind, boxText())
    return kind === "continue" && toggleOn() ? boxText() : undefined
  }

/** Whether the bar stays up: its reply is still on the path shown, in the fork it was opened in. */
export const editStillShown = (edit: GuidanceEdit, view: Pick<ChatView, "forkId" | "entries">) =>
  view.forkId === edit.forkId && view.entries.some((entry) => entry.slotId === edit.slotId)

const editors = new WeakMap<ChatSession, GuidanceEditor>()

/** The chat's guidance editor; a chat opened again reopens it from the draft's choice. */
export const guidanceEditor = (session: ChatSession): GuidanceEditor => {
  let editor = editors.get(session)
  if (editor === undefined) {
    editor = new GuidanceEditor((slotId) => void composerChoice(session).change({ guidanceSlot: slotId }))
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
  focusComposer()
}

/** The guidance a reply was written with, under it, with an edit button to write another version with it changed. */
export function MessageDirection({ entry, session }: { entry: PathEntry; session: ChatSession }) {
  const { version } = entry
  if (version.writer !== "model" || !version.direction) return null
  return <GuidanceLine text={version.direction} onEdit={() => editGuidance(session, entry)} />
}

/**
 * Long guidance folds to three lines, with Show more/Show less only when it doesn't fit; the
 * edit button stays beside it either way. Measured again when its width changes; open or not
 * lasts while the message is shown.
 */
function GuidanceLine({ text, onEdit }: { text: string; onEdit: () => void }) {
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  const body = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    const element = body.current
    if (!element || open) return
    const measure = () => setLong(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, open])
  return (
    <div data-testid="message-direction" className="flex items-start gap-1 text-xs text-muted">
      <div className="flex min-w-0 flex-1 flex-col items-start pt-2">
        <p ref={body} className={`w-full wrap-break-word ${open ? "" : "line-clamp-3"}`}>
          <span className="font-medium">Guidance:</span> {text}
        </p>
        {(long || open) && (
          <Tooltip label={open ? "Fold this guidance back to three lines." : "Show all of this guidance."}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="mt-1 rounded text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
            >
              {open ? "Show less" : "Show more"}
              <span className="sr-only"> of this guidance</span>
            </button>
          </Tooltip>
        )}
      </div>
      <IconButton
        label="Edit this guidance"
        hint="Edit this guidance and generate a new swipe with it. This swipe will not be affected."
        icon="edit"
        onClick={onEdit}
      />
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
        Guidance for a new swipe of {name ? `${name}'s` : "this"} reply
      </span>
      <IconButton
        label="Close: back to new messages"
        hint="Back to writing new messages, with the text you had before."
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
    available: ({ entry }) => entry.version.writer === "model" && !entry.version.direction,
    disabled: ({ generating }) => (generating ? "Wait for this reply to finish before adding guidance." : null),
    describe: viewOf(({ session, entry }) => ({
      label: "New swipe with guidance…",
      icon: "guidance",
      hint: "Guide a new swipe of this reply from the composer.",
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
