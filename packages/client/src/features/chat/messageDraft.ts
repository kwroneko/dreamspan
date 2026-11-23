import { deletedSince, observeDeletion, type ObservedDeletion } from "@dreamspan/shared/drafts.ts"
import type { MessageImages } from "@dreamspan/shared/chat.ts"
// The text of a message editor (DESIGN §6.2): an edit of a version, or a version of a
// message the user is writing. Typed into a server draft like a summary's (summaryDraft.ts),
// keyed by the version edited or the slot written to, so it outlives the row (the message
// list unmounts rows scrolled away) and a reload, which opens the editor again with it.
// Saving names the draft, which the server commits with the version only if it holds
// exactly the text and images saved; cancelling an edit puts the saved text back as a state of its history, which outlives saves.
//
// As for summaries, text typed is copied into this browser (`editor/backup.ts`) until the
// server has it: a save that fails, a closed tab or a reload leaves the copy, filed under
// the chat, which opening the chat again replays, with the draft it was typed on.
import type { ChatId, ForkId, SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import { EDIT_THINKING_FIELD, type MessageDraftSave, type MessageDraftTarget } from "@dreamspan/shared/chatApi.ts"
import { type Draft, DraftHistoryPolicy } from "@dreamspan/shared/drafts.ts"
import type { AppError } from "../../errors.ts"
import { type Copy, dropCopy, keepCopy, makeCopy, pendingOf, type ReplayConflict } from "../editor/backup.ts"
import type { ChatSession, Outcome } from "./session.ts"
import { appended } from "./composition.ts"

/** How long typing pauses before the text is saved. */
const SAVE_DELAY_MS = 400

export type MessageEditorKey =
  `edit:${string}` | `think:${string}` | `write:${string}` | `queue:${string}` | `insert:${string}`

export const editorKey = (target: MessageDraftTarget): MessageEditorKey =>
  target._tag === "Edit"
    ? `edit:${target.versionId}`
    : target._tag === "EditThinking"
      ? `think:${target.versionId}`
      : target._tag === "Write"
        ? `write:${target.slotId}`
        : target._tag === "Queue"
          ? `queue:${target.queuedId}`
          : `insert:${target.forkId}:${target.anchor ?? ""}`

/** What this browser's copies (backup.ts) file a chat's message editors under. */
export const messageCopies = (chatId: string) => `messages:${chatId}`

/** Which message editor a server draft is the text of, if it's one's. */
export const targetOf = (draft: Draft): MessageDraftTarget | null =>
  draft.key.targetKind === "version_edit"
    ? draft.key.field === EDIT_THINKING_FIELD
      ? { _tag: "EditThinking", versionId: draft.key.targetId as VersionId }
      : { _tag: "Edit", versionId: draft.key.targetId as VersionId }
    : draft.key.targetKind === "scratchpad"
      ? { _tag: "Write", slotId: draft.key.targetId as SlotId }
      : draft.key.targetKind === "queue_edit"
        ? {
            _tag: "Queue",
            chatId: draft.key.targetId as ChatId,
            queuedId: draft.key.field,
            rowVersion: Number(draft.baseRevision ?? 0)
          }
        : draft.key.targetKind === "insert"
          ? {
              _tag: "Insert",
              chatId: draft.key.targetId as ChatId,
              forkId: draft.key.field.split(":")[0] as ForkId,
              anchor: (draft.key.field.split(":")[1] || null) as SlotId | null
            }
          : null

export interface MessageDraftView {
  /** What the box shows. */
  readonly text: string
  /** A fresh editor loads its causal base before taking keystrokes. */
  readonly loading: boolean
  /** Typed text not on the server yet. */
  readonly unsaved: boolean
  readonly error: AppError | null
  /** A replay of this browser's text went over text saved elsewhere: kept until acknowledged or switched. */
  readonly conflict: ReplayConflict | null
  /**
   * The images the saved version will have, once the editor changed them; absent: its
   * source's. Saved with the text in the server draft and browser recovery copy.
   */
  readonly images?: MessageImages | undefined
  readonly imagesBusy?: boolean
  /** Text just added to the end (`append`): the box marks it briefly and scrolls to it. */
  readonly added?: { readonly at: number; readonly length: number } | undefined
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
  readonly images?: MessageImages | undefined
  readonly draft: { readonly draftId: string; readonly session: number } | null
}

export class MessageDraft {
  readonly target: MessageDraftTarget
  private view: MessageDraftView
  private readonly listeners = new Set<() => void>()
  /** The draft as the server last answered with it. */
  private draft: Draft | null
  private readonly initialText: string
  /**
   * What the text shown was typed on, which its saves name. It changes only with the text
   * shown, or when the server answers a save with exactly the text sent: text restored from
   * a copy keeps the copy's base until the server has it, whatever the server holds now.
   */
  private base: Base
  private observedDeletion: ObservedDeletion | null = null
  /** Typed here and not saved yet. */
  private local: string | null = null
  private edits = 0
  private opened: boolean
  private opening: Promise<void> | null = null
  /** The browser copy of `local`. */
  private pending: Copy | null = null
  /** Copies on their way to the server, which a newer one mustn't replace. */
  private readonly sending = new Set<Copy>()
  private imageUploads: Promise<void> = Promise.resolve()
  private uploads = 0
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
    this.opened = draft !== null
    this.base = baseOf(draft)
    this.view = {
      loading: draft === null,
      text: draft?.status === "active" ? draft.content : initial,
      images: draft?.status === "active" ? draft.images : undefined,
      unsaved: false,
      error: null,
      conflict: null
    }
    this.initialText = this.view.text
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

  /** Opening a fresh field establishes its base before the UI permits its first key. */
  open(): Promise<void> {
    if (this.opened) return Promise.resolve()
    if (this.opening !== null) return this.opening
    this.opening = this.serial(async () => {
      if (this.opened) return
      const read = await this.session.call((client) => client("GetMessageDraft", { target: this.target }))
      if (!read.ok && read.error.tag !== "NotFound") {
        this.set({ error: read.error })
        return
      }
      this.opened = true
      this.draft = read.ok ? read.value : null
      if (this.local === null) {
        this.base = baseOf(this.draft)
        this.set({
          text: this.draft?.status === "active" ? this.draft.content : this.initialText,
          images: this.draft?.status === "active" ? this.draft.images : this.view.images
        })
      } else if (this.draft?.status !== "active" && this.draft?.content === this.initialText) {
        // A programmatic edit begun during opening is kept too; UI input waits for this read.
        this.observedDeletion = observeDeletion(this.draft)
        this.keep(this.local)
      }
      this.set({ loading: false, error: null })
    }).finally(() => {
      this.opening = null
    })
    return this.opening
  }

  /**
   * Sends this browser's copies of the editor's text that never reached the server, oldest
   * first, each onto the draft it was typed on (another tab's newer text stays one step back
   * in the draft's history, and the editor says so). One the server still doesn't take is
   * shown, and kept, on the base it was typed on.
   */
  restore(copies: ReadonlyArray<Copy>) {
    return this.serial(async () => {
      const edits = this.edits
      const hadLocal = this.local !== null
      // Active-only lists omit Cancel tombstones. Read the resting row before replay.
      if (this.draft === null) {
        const read = await this.session.call((client) => client("GetMessageDraft", { target: this.target }))
        if (read.ok) {
          this.draft = read.value
          this.opened = true
          if (this.local === null) this.base = baseOf(read.value)
        }
      }
      let error: AppError | null = null
      let conflict = this.view.conflict
      for (const copy of [...copies].sort((a, b) => a.at - b.at)) {
        const save = pendingOf(copy)
        if (save?.kind !== "message" || deletedSince(this.draft, save.payload)) continue
        // A safe local copy is the editor's text before its network replay finishes.
        // Keep its own causal tuple; the opening read never authorizes an old copy.
        if (this.edits === edits && !hadLocal) {
          this.local = copy.content
          this.pending = copy
          this.base = {
            draftId: save.payload.draftId,
            rowVersion: save.payload.expectedRowVersion,
            session: save.payload.expectedSession
          }
          this.observedDeletion = save.payload.observedDeletion ?? null
          this.replayedAt = copy.at
          this.set({ text: copy.content, images: save.payload.images, loading: false, unsaved: true })
        }
        this.sending.add(copy)
        const replayed = await this.session.call((client) => client("SaveMessageDraft", save.payload))
        this.sending.delete(copy)
        if (replayed.ok) {
          this.draft = replayed.value
          this.share(replayed.value)
          this.opened = true
          await this.acknowledgeBase(copy, save.payload, replayed.value)
          if (this.pending === copy && this.local === copy.content) {
            this.local = null
            this.pending = null
            this.replayedAt = null
            this.set({ text: replayed.value.content, images: replayed.value.images, unsaved: false })
          }
          // The text it holds is shown, unless something was typed here meanwhile.
          if (this.local === null) {
            this.base = baseOf(replayed.value)
            this.observedDeletion = null
          }
          if (replayed.value.displaced !== null) conflict = { ...replayed.value.displaced, typedAt: copy.at }
          void dropCopy(copy)
        } else {
          // Still not on the server: the box shows it, on the base it was typed on.
          if (this.edits === edits && !hadLocal) {
            if (this.pending !== null && this.pending.at < copy.at) this.pending = null
          }
          if (this.pending === null && this.edits === edits && !hadLocal) {
            this.local = copy.content
            this.set({ images: save.payload.images })
            this.pending = copy
            this.base = {
              draftId: save.payload.draftId,
              rowVersion: save.payload.expectedRowVersion,
              session: save.payload.expectedSession
            }
            this.observedDeletion = save.payload.observedDeletion ?? null
            this.replayedAt = copy.at
          }
          error = replayed.error
        }
      }
      const draft = this.draft
      this.set({
        loading: false,
        text: this.local ?? (draft?.status === "active" ? draft.content : this.view.text),
        images: this.local === null ? draft?.images : this.view.images,
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
      ...(this.observedDeletion === null ? {} : { observedDeletion: this.observedDeletion }),
      draftId: base.draftId,
      content,
      ...(this.view.images === undefined ? {} : { images: this.view.images }),
      expectedRowVersion: base.rowVersion,
      expectedSession: base.session
    }
  }

  /** Only an exact save can advance copies actually typed from its displayed text. */
  private async acknowledgeBase(copy: Copy | null, sent: typeof MessageDraftSave.Type, draft: Draft) {
    const images = draft.images ?? []
    const exact =
      draft.status === "active" &&
      draft.content === sent.content &&
      (sent.images === undefined ||
        (images.length === sent.images.length &&
          sent.images.every(
            (image, index) => image.mediaId === images[index]?.mediaId && image.altText === images[index]?.altText
          )))
    const descended =
      copy !== null &&
      this.pending !== null &&
      (this.pending === copy || this.pending.ancestors.includes(copy.key)) &&
      this.base.draftId === sent.draftId &&
      this.base.rowVersion === sent.expectedRowVersion &&
      this.base.session === sent.expectedSession
    if (exact && descended) {
      this.base = baseOf(draft)
      this.observedDeletion = null
      if (this.pending !== copy && this.local !== null) await this.keep(this.local)
    }
    return exact
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
    return keepCopy(copy, replaces ? previous : null)
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

  /** An upload belongs to this editor even while its Save/Cancel waits for it. */
  uploadImages(task: () => Promise<void>): Promise<void> {
    this.uploads++
    this.set({ imagesBusy: true })
    const run = this.imageUploads.then(task, task)
    this.imageUploads = run.catch(() => undefined)
    return run.finally(() => {
      this.uploads--
      this.set({ imagesBusy: this.uploads > 0 })
    })
  }

  /** The images the saved version will have (the editor's attachment controls). */
  setImages(images: MessageImages) {
    this.set({ images })
    this.setText(this.view.text)
  }

  setText(text: string) {
    this.edits++
    this.local = text
    this.keep(text)
    this.set({ text, unsaved: true })
    this.cancelTimer()
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY_MS)
  }

  /**
   * Adds text to the end, after a blank line (the composition, composition.ts): once the saved
   * text is read, so it's added to what's there. Saved as typing is.
   */
  async append(text: string) {
    await this.open()
    if (!this.opened) return
    const { next, at, length } = appended(this.view.text, text)
    this.setText(next)
    this.set({ added: { at, length } })
  }

  /**
   * The draft as another view of the same chat in this tab saved it (the workbench's two
   * frames, session.ts `shareDraft`): shown here unless text typed here isn't saved yet,
   * whose own save then meets it as any other tab's text.
   */
  adopt(draft: Draft) {
    if (this.local !== null || this.pending !== null) return
    if (this.draft !== null && this.draft.id === draft.id && this.draft.rowVersion >= draft.rowVersion) return
    this.draft = draft
    this.opened = true
    this.base = baseOf(draft)
    this.observedDeletion = null
    this.set({
      loading: false,
      text: draft.status === "active" ? draft.content : this.view.text,
      images: draft.status === "active" ? draft.images : this.view.images
    })
  }

  /** The server's answer, for the chat's other views (a session without them: none to tell). */
  private share(draft: Draft) {
    this.session.shareDraft?.(this.target, draft)
  }

  /** Opened because another view of the chat opened it: it doesn't take focus here. */
  mirror = false

  /** Nothing typed here waits for the server. */
  get settled() {
    return this.local === null && this.pending === null
  }

  /** Saves what was typed now. Saves run one at a time, after a replay. */
  async save(): Promise<void> {
    this.cancelTimer()
    if (!this.opened) {
      await this.open()
      if (!this.opened) return
    }
    return this.serial(async () => {
      if (this.local === null) return
      // Take the text and its copy together after the read: typing during it is newer.
      const sent = this.local
      if (sent === null) return
      const sentImages = this.view.images
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
      this.share(result.value)
      const exact = await this.acknowledgeBase(copy, payload, result.value)
      if (this.local === sent && this.view.images === sentImages) {
        this.base = baseOf(result.value)
        this.observedDeletion = null
      }
      if (copy !== null) void dropCopy(copy)
      if (this.local === sent && this.view.images === sentImages) {
        this.local = null
        if (this.pending === copy) this.pending = null
        if (!exact) this.set({ text: result.value.content, images: result.value.images })
      }
      // The first save of text replayed from this browser can go over text saved elsewhere too.
      const conflict =
        this.replayedAt !== null && result.value.displaced !== null
          ? { ...result.value.displaced, typedAt: this.replayedAt }
          : this.view.conflict
      this.replayedAt = null
      this.set({ error: exact ? null : deletedElsewhere, unsaved: this.local !== null, conflict })
    })
  }

  /**
   * Everything typed, on the server; then the text to commit, the text shown, and the draft
   * to commit with it if it holds exactly that text (otherwise the text is saved without
   * naming it).
   */
  async ready(): Promise<Submission> {
    await this.imageUploads
    await this.save()
    const text = this.view.text
    const draft = this.draft
    return {
      text,
      ...(this.view.images === undefined ? {} : { images: this.view.images }),
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
    if (this.view.text !== submitted.text || this.view.images !== submitted.images) return false
    this.cancelTimer()
    this.local = null
    this.forget()
    return true
  }

  /** A page of the edit's states, newest first; `before` pages on past a seq. */
  async history(before?: number, limit = DraftHistoryPolicy.maxEntries + 1) {
    await this.save()
    if (this.local !== null) return { ok: false as const, error: this.view.error ?? notSaved }
    if (this.draft === null && this.opened) return { ok: true as const, value: [] }
    if (this.draft === null) {
      // A reopened edit has a resting draft from its earlier saves: its states are listed too.
      const read = await this.session.call((client) => client("GetMessageDraft", { target: this.target }))
      if (!read.ok) return read.error.tag === "NotFound" ? { ok: true as const, value: [] } : read
      this.draft ??= read.value
      if (this.draft === null) return { ok: true as const, value: [] }
    }
    return this.session.call((client) =>
      client("MessageDraftHistory", { target: this.target, limit, ...(before === undefined ? {} : { before }) })
    )
  }

  async restoreState(seq: number, content?: string, images?: MessageImages): Promise<boolean> {
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
          ...(content === undefined ? {} : { content, ...(images === undefined ? {} : { images }) })
        })
      )
      if (!result.ok) {
        this.set({ error: result.error })
        return false
      }
      this.draft = result.value
      this.share(result.value)
      this.base = baseOf(result.value)
      // Typing during the restore stays in the box, with its browser copy on the new base.
      if (this.local !== null) this.keep(this.local)
      this.set({
        text: this.local ?? result.value.content,
        images: this.local === null ? result.value.images : this.view.images,
        unsaved: this.local !== null,
        error: null
      })
      return true
    })
  }

  async switchConflict() {
    const conflict = this.view.conflict
    if (
      conflict &&
      (await this.restoreState(0, conflict.content, conflict.images)) &&
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
   * Ends the edit unsaved: an edit goes back to the saved text, the text cancelled one step back in its history (owner, 2026-11-02); a written version's text goes to the bin. Text the server
   * doesn't have yet has nowhere to go: the edit stays open, with its copy.
   */
  async discard(): Promise<Outcome<unknown>> {
    await this.imageUploads
    // Nothing was typed or shown yet: closing a pending read cannot discard unseen text.
    if (this.view.loading && this.local === null) return { ok: true, value: null }
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
      this.share(result.value)
      // Our own acknowledged Cancel precedes this later typing. Refile it on that
      // acknowledged deletion, so recovery never confuses it with the cancelled text.
      if (this.local !== null) {
        this.observedDeletion = observeDeletion(result.value)
        this.keep(this.local)
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

const deletedElsewhere: AppError = {
  tag: "NotSaved",
  message: "This text was deleted elsewhere. Find your copy in recovered texts.",
  problems: [],
  reason: null
}
