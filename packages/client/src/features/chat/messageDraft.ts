// The text of a message editor (DESIGN §6.2): an edit of a version, or a version of a
// message the user is writing. Typed into a server draft like a summary's (summaryDraft.ts),
// keyed by the version edited or the slot written to, so it outlives the row (the message
// list unmounts rows scrolled away) and a reload, which opens the editor again with it.
// Saving names the draft, which the server commits with the version only if it holds
// exactly the text saved; cancelling discards it to the bin's recovered texts.
//
// As for summaries, no copy of unsent text is kept in this browser: text that never
// reached the server (typed in the last moment before the page closed) is only in the box.
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
import type { MessageDraftTarget } from "@rp/shared/chatApi.ts"
import type { Draft } from "@rp/shared/drafts.ts"
import type { AppError } from "../../errors.ts"
import type { ChatSession, Outcome } from "./session.ts"

/** How long typing pauses before the text is saved. */
const SAVE_DELAY_MS = 400

export type MessageEditorKey = `edit:${string}` | `write:${string}`

export const editorKey = (target: MessageDraftTarget): MessageEditorKey =>
  target._tag === "Edit" ? `edit:${target.versionId}` : `write:${target.slotId}`

/** Which message editor a server draft is the text of, if it's one's. */
export const targetOf = (draft: Draft): MessageDraftTarget | null =>
  draft.key.targetKind === "version_edit"
    ? { _tag: "Edit", versionId: draft.key.targetId as VersionId }
    : draft.key.targetKind === "scratchpad"
      ? { _tag: "Write", slotId: draft.key.targetId as SlotId }
      : null

export interface MessageDraftView {
  /** What the box shows. */
  readonly text: string
  /** Typed text not on the server yet. */
  readonly unsaved: boolean
  readonly error: AppError | null
}

export class MessageDraft {
  readonly target: MessageDraftTarget
  private view: MessageDraftView
  private readonly listeners = new Set<() => void>()
  private draft: Draft | null
  /** Typed here and not saved yet. */
  private local: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private readonly session: ChatSession

  constructor(session: ChatSession, target: MessageDraftTarget, initial: string, draft: Draft | null) {
    this.session = session
    this.target = target
    this.draft = draft
    this.view = { text: draft?.status === "active" ? draft.content : initial, unsaved: false, error: null }
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  readonly snapshot = () => this.view

  private set(change: Partial<MessageDraftView>) {
    this.view = { ...this.view, ...change }
    for (const listener of this.listeners) listener()
  }

  setText(text: string) {
    this.local = text
    this.set({ text, unsaved: true })
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS)
  }

  /** Saves what was typed now. Saves run one at a time. */
  async save(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    while (this.inFlight) await this.inFlight
    const sent = this.local
    if (sent === null) return
    const base = this.draft
    const run = async () => {
      const result = await this.session.call((client) =>
        client("SaveMessageDraft", {
          target: this.target,
          draftId: base?.id ?? null,
          content: sent,
          expectedRowVersion: base?.rowVersion ?? null,
          expectedSession: base?.session ?? null
        })
      )
      if (!result.ok) return this.set({ error: result.error })
      this.draft = result.value
      // More typed since: it goes on top of this save, on the draft as the server now has it.
      if (this.local === sent) this.local = null
      this.set({ error: null, unsaved: this.local !== null })
    }
    this.inFlight = run()
    await this.inFlight
    this.inFlight = null
  }

  /**
   * Everything typed, on the server; then the draft to commit with the text shown, if it
   * holds exactly that text (otherwise the text is saved without naming it).
   */
  async ready(): Promise<{ readonly text: string; readonly draft: { draftId: string; session: number } | null }> {
    await this.save()
    const text = this.view.text
    const draft = this.draft
    return {
      text,
      draft:
        this.local === null && draft?.status === "active" && draft.content === text
          ? { draftId: draft.id, session: draft.session }
          : null
    }
  }

  /** Ends the edit unsaved; its text goes to the bin's recovered texts. */
  async discard(): Promise<Outcome<unknown>> {
    await this.save()
    const draft = this.draft
    if (draft === null || draft.status !== "active") return { ok: true, value: null }
    const result = await this.session.call((client) =>
      client("DiscardMessageDraft", { target: this.target, draftId: draft.id, expectedRowVersion: draft.rowVersion })
    )
    if (result.ok) this.draft = result.value
    else this.set({ error: result.error })
    return result
  }
}
