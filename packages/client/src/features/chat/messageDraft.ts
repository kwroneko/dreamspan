// The text of a message editor (DESIGN §6.2): an edit of a version, or a version of a
// message the user is writing. Typed into a server draft like a summary's (summaryDraft.ts),
// keyed by the version edited or the slot written to, so it outlives the row (the message
// list unmounts rows scrolled away) and a reload, which opens the editor again with it.
// Saving names the draft, which the server commits with the version only if it holds
// exactly the text saved; cancelling discards it to the bin's recovered texts.
//
// As for summaries, text typed is copied into this browser (`editor/backup.ts`) until the
// server has it: a save that fails, a closed tab or a reload leaves the copy, filed under
// the chat, which opening the chat again replays, with the draft it was typed on.
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
import type { MessageDraftTarget } from "@rp/shared/chatApi.ts"
import type { Draft } from "@rp/shared/drafts.ts"
import type { AppError } from "../../errors.ts"
import { type Copy, dropCopy, keepCopy, makeCopy, pendingOf } from "../editor/backup.ts"
import type { ChatSession, Outcome } from "./session.ts"

/** How long typing pauses before the text is saved. */
const SAVE_DELAY_MS = 400

export type MessageEditorKey = `edit:${string}` | `write:${string}`

export const editorKey = (target: MessageDraftTarget): MessageEditorKey =>
  target._tag === "Edit" ? `edit:${target.versionId}` : `write:${target.slotId}`

/** What this browser's copies (backup.ts) file a chat's message editors under. */
export const messageCopies = (chatId: string) => `messages:${chatId}`

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
  /** The browser copy of `local`. */
  private pending: Copy | null = null
  /** Copies on their way to the server, which a newer one mustn't replace. */
  private readonly sending = new Set<Copy>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private readonly session: ChatSession
  private readonly userId: string

  constructor(session: ChatSession, userId: string, target: MessageDraftTarget, initial: string, draft: Draft | null) {
    this.session = session
    this.userId = userId
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

  /**
   * Sends this browser's copies of the editor's text that never reached the server, oldest
   * first, each onto the draft it was typed on (another tab's newer text stays one step back
   * in the draft's history). One the server still doesn't take is shown, and kept.
   */
  async restore(copies: ReadonlyArray<Copy>) {
    let error: AppError | null = null
    for (const copy of [...copies].sort((a, b) => a.at - b.at)) {
      const save = pendingOf(copy)
      if (save?.kind !== "message") continue
      this.sending.add(copy)
      const replayed = await this.session.call((client) => client("SaveMessageDraft", save.payload))
      this.sending.delete(copy)
      if (replayed.ok) {
        if (this.local === null) this.draft = replayed.value
        void dropCopy(copy)
      } else {
        if (this.pending !== null && this.pending.at < copy.at) this.pending = null
        if (this.pending === null) {
          this.local = copy.content
          this.pending = copy
        }
        error = replayed.error
      }
    }
    const draft = this.draft
    this.set({
      text: this.local ?? (draft?.status === "active" ? draft.content : this.view.text),
      unsaved: this.local !== null,
      error
    })
  }

  /** The save of `content` as typed on the draft this tab has now. */
  private payload(content: string) {
    const base = this.draft
    return {
      target: this.target,
      draftId: base?.id ?? null,
      content,
      expectedRowVersion: base?.rowVersion ?? null,
      expectedSession: base?.session ?? null
    }
  }

  /** Copies `content` into this browser, in place of the last copy unless that one is being sent. */
  private keep(content: string) {
    const previous = this.pending
    const replaces = previous !== null && !this.sending.has(previous)
    const copy = makeCopy(
      this.userId,
      messageCopies(this.session.id),
      editorKey(this.target),
      { kind: "message", payload: this.payload(content) },
      Date.now(),
      previous === null ? [] : [previous]
    )
    this.pending = copy
    void keepCopy(copy, replaces ? previous : null)
  }

  /** The copy, once the text it holds is on the server or thrown away on purpose. */
  private forget() {
    if (this.pending !== null) void dropCopy(this.pending)
    this.pending = null
  }

  setText(text: string) {
    this.local = text
    this.keep(text)
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
    const payload = this.payload(sent)
    const copy = this.pending
    const run = async () => {
      if (copy !== null) this.sending.add(copy)
      const result = await this.session.call((client) => client("SaveMessageDraft", payload))
      if (copy !== null) this.sending.delete(copy)
      if (!result.ok) {
        // A newer copy, typed from this one, has everything this one has.
        if (copy !== null && this.pending !== copy && this.pending?.ancestors.includes(copy.key)) void dropCopy(copy)
        return this.set({ error: result.error })
      }
      this.draft = result.value
      if (copy !== null) void dropCopy(copy)
      if (this.local === sent) {
        this.local = null
        if (this.pending === copy) this.pending = null
      } else if (this.local !== null && this.pending !== null && !this.sending.has(this.pending)) {
        // More typed since: its copy now names the draft as the server has it.
        this.keep(this.local)
      }
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

  /** The text shown is saved as a version: no copy of it is needed any more. */
  saved() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.local = null
    this.forget()
  }

  /**
   * Ends the edit unsaved; its text goes to the bin's recovered texts. Text the server
   * doesn't have yet has nowhere to go: the edit stays open, with its copy.
   */
  async discard(): Promise<Outcome<unknown>> {
    await this.save()
    if (this.local !== null) return { ok: false, error: this.view.error ?? notSaved }
    this.forget()
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

const notSaved: AppError = {
  tag: "NotSaved",
  message: "The text isn't on the server yet. Wait for it to be kept, then try again.",
  problems: [],
  reason: null
}
