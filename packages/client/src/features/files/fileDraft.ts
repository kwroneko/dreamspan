// The text of a file being edited (spec/FILES-AND-ENVIRONMENT.md §8.2; ARCHITECTURE §3.10): typed
// into a server draft (`file`, by path) whose base is the hash of the file's bytes it was typed
// on, and written to the file only when the user saves. The rules are the other editors': a save
// names the draft this tab last saw (id, row version, session); the base changes only with the
// text shown, or when the server answers a save with exactly the text sent; text not on the server
// yet is copied into this browser (`editor/backup.ts`) and replayed when the file opens again.
//
// Saving to the file names the hash the text was typed on; when the file changed since (a command,
// the assistant, another tab), nothing is written and the edit shows the conflict instead.
import { type Draft, deletedSince, type ObservedDeletion } from "@dreamspan/shared/drafts.ts"
import type { FileDraftSave } from "@dreamspan/shared/filesApi.ts"
import { encodeText, type TextFile } from "@dreamspan/shared/files.ts"
import type { Effect } from "effect"
import type { ActionResult } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import type { AppClient } from "../../rpc.ts"
import { type Copy, copiesOf, dropCopy, keepCopy, makeCopy, pendingOf } from "../editor/backup.ts"
import { FileChanged, type FilesSource } from "./source.ts"

/** How long typing pauses before the text is saved as a draft. */
const SAVE_DELAY_MS = 600

export type Run = <A, E>(call: (client: AppClient["Service"]) => Effect.Effect<A, E>) => Promise<ActionResult<A>>

export interface FileDraftView {
  readonly loading: boolean
  /** What the box shows. */
  readonly text: string
  /** The text differs from the file. */
  readonly changed: boolean
  /** Typed text not kept on the server yet. */
  readonly unsaved: boolean
  /** The text was typed on content the file no longer has (changed on disk since). */
  readonly conflict: boolean
  readonly error: AppError | null
  /** Another tab's text this tab's draft save went over: kept one step back in its history. */
  readonly displaced: string | null
  /** How many earlier texts ending the edit sent to the recovered texts. */
  readonly recovered: number
}

/** What the text a draft save sends was typed on: the draft as the tab had it, and the file's hash. */
interface Base {
  readonly draftId: string | null
  readonly rowVersion: number | null
  readonly session: number | null
  /** The file's hash the text was typed on; null: the file as shown now. */
  readonly sha256: string | null
}
const baseOf = (draft: Draft | null): Base => ({
  draftId: draft?.id ?? null,
  rowVersion: draft?.rowVersion ?? null,
  session: draft?.session ?? null,
  sha256: draft?.status === "active" ? draft.baseRevision : null
})

/** The browser copies of a file's edit. */
const fileCopyId = (path: string) => `file:${path}`

const failed = (message: string): AppError => ({ tag: "NotSaved", message, problems: [], reason: null })

export class FileDraft {
  private view: FileDraftView = {
    loading: true,
    text: "",
    changed: false,
    unsaved: false,
    conflict: false,
    error: null,
    displaced: null,
    recovered: 0
  }
  private readonly listeners = new Set<() => void>()
  private draft: Draft | null = null
  private base: Base = baseOf(null)
  private observedDeletion: ObservedDeletion | null = null
  /** Typed here and not kept on the server yet. */
  private local: string | null = null
  private edits = 0
  private pending: Copy | null = null
  private readonly sending = new Set<Copy>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  private readonly backupId: string
  private readonly run: Run
  private readonly source: FilesSource
  private readonly userId: string
  readonly path: string
  private file: TextFile

  constructor(run: Run, source: FilesSource, userId: string, path: string, file: TextFile) {
    this.run = run
    this.source = source
    this.userId = userId
    this.path = path
    this.file = file
    this.backupId = fileCopyId(path)
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  readonly snapshot = () => this.view

  /** The file as last read. */
  get current() {
    return this.file
  }

  private set(change: Partial<FileDraftView>) {
    this.view = { ...this.view, ...change }
    for (const listener of this.listeners) listener()
  }

  private serial<A>(task: () => Promise<A>): Promise<A> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private cancelTimer() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private shown() {
    return this.local ?? (this.draft?.status === "active" ? this.draft.content : this.file.text)
  }

  /** The hash the text shown was typed on: the edit's base, else the file as it is. */
  private typedOn() {
    return this.base.sha256 ?? this.file.sha256
  }

  private refresh(extra: Partial<FileDraftView> = {}) {
    const text = this.shown()
    const editing = this.local !== null || this.draft?.status === "active"
    this.set({
      text,
      changed: text !== this.file.text,
      unsaved: this.local !== null,
      // Typed on older content, and not already the same text: a conflict to resolve.
      conflict: editing && this.typedOn() !== this.file.sha256 && text !== this.file.text,
      ...extra
    })
  }

  /** The file was read again (live refresh, after a save): the box keeps what the user typed. */
  update(file: TextFile) {
    this.file = file
    this.refresh()
  }

  async open() {
    const edits = this.edits
    const hadLocal = this.local !== null
    const result = await this.run((client) => client("GetFileDraft", { path: this.path }))
    if (this.disposed) return
    if (result.ok) {
      this.draft = result.value
      if (this.local === null) this.base = baseOf(result.value)
    }
    const copies = [...(await copiesOf(this.userId, this.backupId))].sort((a, b) => a.at - b.at)
    await this.serial(async () => {
      let error = result.ok ? null : result.error
      let displaced = this.view.displaced
      for (const copy of copies) {
        const save = pendingOf(copy)
        if (save?.kind !== "file" || deletedSince(this.draft, save.payload)) continue
        this.sending.add(copy)
        const replayed = await this.run((client) => client("SaveFileDraft", save.payload))
        this.sending.delete(copy)
        if (replayed.ok) {
          this.draft = replayed.value
          if (this.local === null) {
            this.base = baseOf(replayed.value)
            this.observedDeletion = null
          }
          displaced = replayed.value.displaced?.content ?? displaced
          void dropCopy(copy)
        } else {
          if (this.pending === null && this.edits === edits && !hadLocal) {
            this.local = copy.content
            this.pending = copy
            this.observedDeletion = save.payload.observedDeletion ?? null
            this.base = {
              draftId: save.payload.draftId,
              rowVersion: save.payload.expectedRowVersion,
              session: save.payload.expectedSession,
              sha256: save.payload.baseSha256
            }
          }
          error = replayed.error
        }
      }
      if (this.disposed) return
      this.refresh({ loading: false, error, displaced })
    })
  }

  private payload(content: string): FileDraftSave {
    const base = this.base
    return {
      path: this.path,
      ...(this.observedDeletion === null ? {} : { observedDeletion: this.observedDeletion }),
      draftId: base.draftId,
      content,
      expectedRowVersion: base.rowVersion,
      expectedSession: base.session,
      baseSha256: this.typedOn()
    }
  }

  private keep(content: string) {
    const previous = this.pending
    const replaces = previous !== null && !this.sending.has(previous)
    const copy = makeCopy(
      this.userId,
      this.backupId,
      "",
      { kind: "file", payload: this.payload(content) },
      Date.now(),
      previous === null ? [] : [previous]
    )
    this.pending = copy
    void keepCopy(copy, replaces ? previous : null)
  }

  private forget() {
    if (this.pending !== null) void dropCopy(this.pending)
    this.pending = null
  }

  setText(text: string) {
    this.edits++
    // The first keystroke fixes what it was typed on, before another tab or a command changes the file.
    if (this.base.sha256 === null) this.base = { ...this.base, sha256: this.file.sha256 }
    this.local = text
    this.keep(text)
    this.refresh()
    this.cancelTimer()
    this.timer = setTimeout(() => void this.saveDraft(), SAVE_DELAY_MS)
  }

  /** Keeps what was typed as the draft now. Saves run one at a time, after a replay. */
  saveDraft(): Promise<void> {
    this.cancelTimer()
    return this.serial(async () => {
      const sent = this.local
      if (sent === null) return
      const payload = this.payload(sent)
      const copy = this.pending
      if (copy !== null) this.sending.add(copy)
      const result = await this.run((client) => client("SaveFileDraft", payload))
      if (copy !== null) this.sending.delete(copy)
      if (!result.ok) {
        if (copy !== null && this.pending !== copy && this.pending?.ancestors.includes(copy.key)) void dropCopy(copy)
        if (!this.disposed) this.refresh({ error: result.error })
        return
      }
      this.draft = result.value
      const exact = result.value.status === "active" && result.value.content === sent
      if (exact || this.local === sent) {
        this.base = baseOf(result.value)
        this.observedDeletion = null
      }
      if (copy !== null) void dropCopy(copy)
      if (this.local === sent) {
        this.local = null
        if (this.pending === copy) this.pending = null
      } else if (exact && this.local !== null && this.pending !== null && !this.sending.has(this.pending)) {
        this.keep(this.local)
      }
      if (this.disposed) return
      this.refresh({
        error: exact ? null : failed("This text was ended elsewhere. Find your copy in recovered texts."),
        recovered: this.view.recovered + result.value.recovered,
        displaced: result.value.displaced?.content ?? this.view.displaced
      })
    })
  }

  /** Everything typed, on the server as the draft. */
  async flush() {
    await this.saveDraft()
    while (this.local !== null && this.view.error === null) await this.saveDraft()
  }

  /** Ends the draft once its text is the file's (saved, or the same text). */
  private async end(outcome: "committed" | "discarded") {
    const draft = this.draft
    if (draft === null || draft.status !== "active") return true
    const result = await this.run((client) =>
      client("EndFileDraft", { path: this.path, draftId: draft.id, expectedRowVersion: draft.rowVersion, outcome })
    )
    if (!result.ok) {
      this.refresh({ error: result.error })
      return false
    }
    this.draft = result.value
    this.set({ recovered: this.view.recovered + result.value.recovered })
    return true
  }

  /**
   * Writes the text to the file, if the file is still what it was typed on. Returns what it held
   * before (for Undo), `changed` when the file changed since (the edit stays, as a conflict), or
   * null when it failed (the error shows).
   */
  async save(): Promise<{ readonly before: TextFile; readonly after: TextFile } | "changed" | null> {
    await this.flush()
    if (this.local !== null) return null
    const before = this.file
    const content = this.shown()
    const base = this.typedOn()
    let outcome
    try {
      outcome = await this.source.saveText(this.path, content, base, this.file)
    } catch (error) {
      if (error instanceof FileChanged) {
        this.refresh({ conflict: true, error: null })
        return "changed"
      }
      this.refresh({ error: failed(error instanceof Error ? error.message : String(error)) })
      return null
    }
    const size = encodeText(content, this.file.lineEnding, this.file.bom).byteLength
    this.file = { ...this.file, text: content, sha256: outcome.sha256 ?? base, size, mtimeMs: Date.now() }
    if (this.local === null) {
      // The draft's text is the file's now: its session ends as committed.
      if (this.draft?.status === "active" && this.draft.content === content) await this.end("committed")
      this.base = baseOf(this.draft?.status === "active" ? this.draft : null)
      this.forget()
    }
    this.refresh({ error: null })
    return { before, after: this.file }
  }

  /**
   * Throws the edit away: the text goes one step back to the recovered texts, and the box shows
   * the file (`latest`, when it was read again for Load the latest).
   */
  async discard(latest?: TextFile): Promise<boolean> {
    await this.flush()
    if (this.local !== null) return false
    if (!(await this.end("discarded"))) return false
    if (latest) this.file = latest
    this.base = baseOf(null)
    this.observedDeletion = null
    this.forget()
    this.refresh({ error: null, conflict: false })
    return true
  }

  /** Uploads the text shown now and commits that edit if it is still current. */
  async saveCopy<A>(upload: (text: string) => Promise<A>): Promise<A> {
    const edits = this.edits
    const text = this.shown()
    const uploaded = await upload(text)
    if (this.edits !== edits) return uploaded
    await this.flush()
    await this.serial(async () => {
      if (this.edits !== edits || this.local !== null || this.shown() !== text) return
      if (!(await this.end("committed"))) return
      this.observedDeletion = null
      if (this.local !== null) {
        // Text typed while the end was on its way starts a new session on the same file hash.
        this.base = { ...baseOf(this.draft), sha256: this.typedOn() }
        this.keep(this.local)
      } else {
        this.base = baseOf(this.draft)
        this.forget()
      }
      this.refresh({ error: null })
    })
    return uploaded
  }

  dispose() {
    this.cancelTimer()
    void this.saveDraft()
    this.disposed = true
  }
}
