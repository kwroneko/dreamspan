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
import { type Copy, dropCopy, keepCopy, makeCopy, pendingOf, type ReplayConflict } from "../editor/backup.ts"
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
  /** A replay of this browser's text went over text saved elsewhere: kept until acknowledged or switched. */
  readonly conflict: ReplayConflict | null
}

/** What the text a save sends was typed on (§3.10, "a field's base"): the draft as the tab had it. */
interface Base {
  readonly draftId: string | null
  readonly rowVersion: number | null
  readonly session: number | null
}
const baseOf = (draft: Draft | null): Base => ({
  draftId: draft?.id ?? null,
  rowVersion: draft?.rowVersion ?? null,
  session: draft?.session ?? null
})

/** The text a commit took, from `ready()`. */
export interface Submission {
  readonly text: string
  readonly draft: { readonly draftId: string; readonly session: number } | null
}

export class MessageDraft {
  readonly target: MessageDraftTarget
  private view: MessageDraftView
  private readonly listeners = new Set<() => void>()
  /** The draft as the server last answered with it. */
  private draft: Draft | null
  /**
   * What the text shown was typed on, which its saves name. It changes only with the text
   * shown, or when the server answers a save with exactly the text sent: text restored from
   * a copy keeps the copy's base until the server has it, whatever the server holds now.
   */
  private base: Base
  /** Typed here and not saved yet. */
  private local: string | null = null
  /** The browser copy of `local`. */
  private pending: Copy | null = null
  /** Copies on their way to the server, which a newer one mustn't replace. */
  private readonly sending = new Set<Copy>()
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Replays and saves run one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve()
  /** When the copy shown was typed, while its replay hasn't reached the server. */
  private replayedAt: number | null = null
  private readonly session: ChatSession
  private readonly userId: string

  constructor(session: ChatSession, userId: string, target: MessageDraftTarget, initial: string, draft: Draft | null) {
    this.session = session
    this.userId = userId
    this.target = target
    this.draft = draft
    this.base = baseOf(draft)
    this.view = {
      text: draft?.status === "active" ? draft.content : initial,
      unsaved: false,
      error: null,
      conflict: null
    }
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

  private serial<A>(task: () => Promise<A>): Promise<A> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * Sends this browser's copies of the editor's text that never reached the server, oldest
   * first, each onto the draft it was typed on (another tab's newer text stays one step back
   * in the draft's history, and the editor says so). One the server still doesn't take is
   * shown, and kept, on the base it was typed on.
   */
  restore(copies: ReadonlyArray<Copy>) {
    return this.serial(async () => {
      let error: AppError | null = null
      let conflict = this.view.conflict
      for (const copy of [...copies].sort((a, b) => a.at - b.at)) {
        const save = pendingOf(copy)
        if (save?.kind !== "message") continue
        this.sending.add(copy)
        const replayed = await this.session.call((client) => client("SaveMessageDraft", save.payload))
        this.sending.delete(copy)
        if (replayed.ok) {
          this.draft = replayed.value
          // The text it holds is shown, unless something was typed here meanwhile.
          if (this.local === null) this.base = baseOf(replayed.value)
          if (replayed.value.displaced !== null) conflict = { ...replayed.value.displaced, typedAt: copy.at }
          void dropCopy(copy)
        } else {
          // Still not on the server: the box shows it, on the base it was typed on.
          if (this.pending !== null && this.pending.at < copy.at) this.pending = null
          if (this.pending === null) {
            this.local = copy.content
            this.pending = copy
            this.base = {
              draftId: save.payload.draftId,
              rowVersion: save.payload.expectedRowVersion,
              session: save.payload.expectedSession
            }
            this.replayedAt = copy.at
          }
          error = replayed.error
        }
      }
      const draft = this.draft
      this.set({
        text: this.local ?? (draft?.status === "active" ? draft.content : this.view.text),
        unsaved: this.local !== null,
        error,
        conflict
      })
    })
  }

  /** The save of `content` as typed on the base of the text shown. */
  private payload(content: string) {
    const base = this.base
    return {
      target: this.target,
      draftId: base.draftId,
      content,
      expectedRowVersion: base.rowVersion,
      expectedSession: base.session
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

  private cancelTimer() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  setText(text: string) {
    this.local = text
    this.keep(text)
    this.set({ text, unsaved: true })
    this.cancelTimer()
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS)
  }

  /** Saves what was typed now. Saves run one at a time, after a replay. */
  save(): Promise<void> {
    this.cancelTimer()
    return this.serial(async () => {
      const sent = this.local
      if (sent === null) return
      const payload = this.payload(sent)
      const copy = this.pending
      if (copy !== null) this.sending.add(copy)
      const result = await this.session.call((client) => client("SaveMessageDraft", payload))
      if (copy !== null) this.sending.delete(copy)
      if (!result.ok) {
        // A newer copy, typed from this one, has everything this one has.
        if (copy !== null && this.pending !== copy && this.pending?.ancestors.includes(copy.key)) void dropCopy(copy)
        return this.set({ error: result.error })
      }
      // The server has exactly the text sent: what's typed from it is on the draft as it is now.
      this.draft = result.value
      this.base = baseOf(result.value)
      if (copy !== null) void dropCopy(copy)
      if (this.local === sent) {
        this.local = null
        if (this.pending === copy) this.pending = null
      } else if (this.local !== null && this.pending !== null && !this.sending.has(this.pending)) {
        // More typed since: its copy now names the draft as the server has it.
        this.keep(this.local)
      }
      // The first save of text replayed from this browser can go over text saved elsewhere too.
      const conflict =
        this.replayedAt !== null && result.value.displaced !== null
          ? { ...result.value.displaced, typedAt: this.replayedAt }
          : this.view.conflict
      this.replayedAt = null
      this.set({ error: null, unsaved: this.local !== null, conflict })
    })
  }

  /**
   * Everything typed, on the server; then the text to commit, the text shown, and the draft
   * to commit with it if it holds exactly that text (otherwise the text is saved without
   * naming it).
   */
  async ready(): Promise<Submission> {
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

  /**
   * The submitted text is saved as a version: no copy of it is needed any more. Whether the
   * edit is done: text typed while the version was being saved stays in the box, with its
   * copy, its pending save and its base, and the editor stays open with it.
   */
  committed(submitted: Submission): boolean {
    if (this.view.text !== submitted.text) return false
    this.cancelTimer()
    this.local = null
    this.forget()
    return true
  }

  async history() {
    await this.save()
    return this.session.call((client) => client("MessageDraftHistory", { target: this.target, limit: 1000 }))
  }

  async restoreState(seq: number, content?: string): Promise<boolean> {
    const picked = this.view.text
    await this.save()
    return this.serial(async () => {
      if (this.local !== null || this.draft === null || this.view.text !== picked) return false
      const result = await this.session.call((client) =>
        client("RestoreMessageDraft", {
          target: this.target,
          draftId: this.draft!.id,
          seq,
          expectedRowVersion: this.draft!.rowVersion,
          ...(content === undefined ? {} : { content })
        })
      )
      if (!result.ok) {
        this.set({ error: result.error })
        return false
      }
      this.draft = result.value
      this.base = baseOf(result.value)
      // Typing during the restore stays in the box, with its browser copy on the new base.
      if (this.local !== null) this.keep(this.local)
      this.set({ text: this.local ?? result.value.content, unsaved: this.local !== null, error: null })
      return true
    })
  }

  async switchConflict() {
    const conflict = this.view.conflict
    if (
      conflict &&
      (await this.restoreState(0, conflict.content)) &&
      !this.view.unsaved &&
      this.view.text === conflict.content &&
      this.view.conflict === conflict
    )
      this.acknowledgeConflict()
  }

  acknowledgeConflict() {
    this.set({ conflict: null })
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
    if (result.ok) {
      this.draft = result.value
      // Typed while the discard was out: that text wasn't discarded, so the editor stays open
      // with it, its copy and the base it was typed on.
      if (this.local !== null) {
        this.set({ error: typedDuringCancel })
        return { ok: false, error: typedDuringCancel }
      }
      this.base = baseOf(result.value)
    } else this.set({ error: result.error })
    return result
  }
}

const typedDuringCancel: AppError = {
  tag: "NotSaved",
  message: "You typed more while this was being cancelled, so it stays open with that text.",
  problems: [],
  reason: null
}

const notSaved: AppError = {
  tag: "NotSaved",
  message: "The text isn't on the server yet. Wait for it to be kept, then try again.",
  problems: [],
  reason: null
}
