// One ref being edited (ARCHITECTURE.md §13): its saved document, and a draft per field the
// user changed, saved to the server as they type. Components subscribe to one field each,
// so typing in a 50 KB description re-renders that field only.
import { applyDrafts, type FieldPath, getAt, parseField, textField, valueField } from "@rp/shared/editing.ts"
import type { EditorSnapshot } from "@rp/shared/editorApi.ts"
import type { Doc, RefId } from "@rp/shared/library.ts"
import { useEffect, useSyncExternalStore } from "react"
import type { AppError } from "../../errors.ts"
import type { Caller } from "./caller.ts"

/** How long typing pauses before the text is saved. */
const SAVE_DELAY_MS = 600

interface FieldDraft {
  /** The draft's content as the server has it; null without an active draft. */
  saved: string | null
  /** The draft row's version, an ended draft's too: the next session starts from it. */
  rowVersion: number | null
  /** Changed here and not saved yet. */
  local: string | null
  timer: ReturnType<typeof setTimeout> | null
  inFlight: Promise<void> | null
}

export interface EditorState {
  readonly snapshot: EditorSnapshot | null
  readonly loadError: AppError | null
  readonly saveError: AppError | null
  /** How many fields have changes. */
  readonly dirty: number
  readonly saving: boolean
}

/** Channels besides each field's own: the documents changed, or which fields are dirty. */
const STRUCTURE = "structure"
const DRAFTS = "drafts"

export class EditorStore {
  snapshot: EditorSnapshot | null = null
  loadError: AppError | null = null
  /** The last save that failed, until one succeeds. */
  saveError: AppError | null = null
  private readonly fields = new Map<string, FieldDraft>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly versions = new Map<string, number>()
  private readonly subscribers = new Map<string, (listener: () => void) => () => void>()
  /** The head with the value drafts applied: what fields read when they have no draft of their own. */
  private valueDoc: Doc = {}

  readonly refId: RefId
  private readonly call: Caller

  constructor(refId: RefId, call: Caller) {
    this.refId = refId
    this.call = call
  }

  /** A subscription to some channels, the same function each time, as React wants. */
  subscribe = (...channels: ReadonlyArray<string>) => {
    const name = channels.join("\n")
    let subscribe = this.subscribers.get(name)
    if (subscribe === undefined) {
      subscribe = (listener) => {
        for (const channel of channels) {
          const set = this.listeners.get(channel) ?? new Set()
          set.add(listener)
          this.listeners.set(channel, set)
        }
        return () => channels.forEach((channel) => this.listeners.get(channel)?.delete(listener))
      }
      this.subscribers.set(name, subscribe)
    }
    return subscribe
  }

  private cachedState: { readonly version: number; readonly state: EditorState } | null = null

  /** The page's view of the store: a new object only when it changes. */
  state = (): EditorState => {
    const version = this.version(DRAFTS)
    if (this.cachedState?.version !== version) {
      this.cachedState = {
        version,
        state: {
          snapshot: this.snapshot,
          loadError: this.loadError,
          saveError: this.saveError,
          dirty: this.dirtyFields().length,
          saving: this.isSaving()
        }
      }
    }
    return this.cachedState.state
  }

  version = (channel: string) => this.versions.get(channel) ?? 0

  private bump(...channels: ReadonlyArray<string>) {
    for (const channel of channels) {
      this.versions.set(channel, this.version(channel) + 1)
      this.listeners.get(channel)?.forEach((listener) => listener())
    }
  }

  private bumpAll() {
    this.bump(STRUCTURE, DRAFTS, ...this.fields.keys())
  }

  private field(key: string) {
    let field = this.fields.get(key)
    if (field === undefined) {
      field = { saved: null, rowVersion: null, local: null, timer: null, inFlight: null }
      this.fields.set(key, field)
    }
    return field
  }

  private current(key: string) {
    const field = this.fields.get(key)
    return field ? (field.local ?? field.saved) : null
  }

  get head(): Doc {
    return this.snapshot?.doc ?? {}
  }

  async load() {
    const result = await this.call((client) => client("OpenEditor", { refId: this.refId }))
    if (result.ok) this.apply(result.value)
    else this.loadError = result.error
    this.bumpAll()
    return result
  }

  /** The server's state, keeping what was typed here and not saved yet. */
  private apply(snapshot: EditorSnapshot) {
    this.snapshot = snapshot
    this.loadError = null
    for (const field of this.fields.values()) {
      field.saved = null
      field.rowVersion = null
    }
    for (const draft of snapshot.drafts) {
      const field = this.field(draft.key.field)
      field.saved = draft.status === "active" ? draft.content : null
      field.rowVersion = draft.rowVersion
    }
    this.rebuild()
  }

  private rebuild() {
    const kind = this.snapshot?.ref.kind ?? "card"
    const values = [...this.fields.keys()]
      .filter((key) => key.startsWith("="))
      .flatMap((key) => {
        const content = this.current(key)
        return content === null ? [] : [{ field: key, content }]
      })
    this.valueDoc = applyDrafts(kind, this.head, values).doc
  }

  text(path: FieldPath): string {
    const own = this.current(textField(path))
    if (own !== null) return own
    const value = getAt(this.valueDoc, path)
    return typeof value === "string" ? value : ""
  }

  value(path: FieldPath): unknown {
    return getAt(this.valueDoc, path)
  }

  setText(path: FieldPath, text: string) {
    this.change(textField(path), text)
  }

  setValue(path: FieldPath, value: unknown) {
    this.change(valueField(path), JSON.stringify(value))
  }

  /** Typing re-renders the field; the page hears only when a field starts having unsaved changes. */
  private change(key: string, content: string) {
    const field = this.field(key)
    const quiet = field.local !== null
    field.local = content
    if (key.startsWith("=")) {
      this.rebuild()
      this.bump(STRUCTURE)
    }
    this.bump(key)
    if (!quiet) this.bump(DRAFTS)
    this.schedule(key)
  }

  private schedule(key: string) {
    const field = this.field(key)
    if (field.timer) clearTimeout(field.timer)
    field.timer = setTimeout(() => void this.save(key), SAVE_DELAY_MS)
  }

  /** Saves what was typed in one field now. Saves of a field run one at a time. */
  async save(key: string): Promise<void> {
    const field = this.field(key)
    if (field.timer) clearTimeout(field.timer)
    field.timer = null
    while (field.inFlight) await field.inFlight
    if (field.local === null) return
    const content = field.local
    const run = async () => {
      let result = await this.saveOnce(key, content)
      // Another tab saved this field meanwhile: its text stays in the history, and this one goes on top.
      if (!result.ok && result.error.tag === "StaleWrite") {
        await this.refresh()
        result = await this.saveOnce(key, content)
      }
      if (result.ok) {
        field.saved = result.value.content
        field.rowVersion = result.value.rowVersion
        if (field.local === content) field.local = null
        this.saveError = null
      } else {
        this.saveError = result.error
      }
      this.bump(key)
    }
    field.inFlight = run()
    await field.inFlight
    field.inFlight = null
    // Only now is the save over, as far as the page is concerned.
    this.bump(DRAFTS)
  }

  private saveOnce(key: string, content: string) {
    const field = this.field(key)
    return this.call((client) =>
      client("SaveEditorDraft", {
        refId: this.refId,
        field: key,
        content,
        expectedRowVersion: field.rowVersion,
        // A new drafting session starts from the saved version.
        baseRevisionId: field.saved === null ? (this.snapshot?.ref.headRevisionId ?? null) : null
      })
    )
  }

  /** Everything typed, saved. */
  async flush() {
    await Promise.all([...this.fields.keys()].map((key) => this.save(key)))
  }

  /** The server's drafts and head again, without losing what's typed here. */
  async refresh() {
    const result = await this.call((client) => client("OpenEditor", { refId: this.refId }))
    if (result.ok) {
      this.apply(result.value)
      this.bumpAll()
    }
  }

  isDirty(key: string) {
    const field = this.fields.get(key)
    return field !== undefined && (field.saved !== null || field.local !== null)
  }

  /** Fields with changes, saved or not. */
  dirtyFields() {
    return [...this.fields.keys()].filter((key) => this.isDirty(key))
  }

  isSaving() {
    return [...this.fields.values()].some((field) => field.local !== null || field.inFlight !== null)
  }

  /** The head with every change applied, for the diff and the search. */
  working() {
    return applyDrafts(
      this.snapshot?.ref.kind ?? "card",
      this.head,
      this.dirtyFields().map((field) => ({ field, content: this.current(field)! }))
    )
  }

  /** Commits every draft as one revision. */
  async commit(message: string | null) {
    await this.flush()
    const snapshot = this.snapshot!
    const fields = [...this.fields].flatMap(([field, draft]) =>
      draft.saved === null || draft.rowVersion === null ? [] : [{ field, expectedRowVersion: draft.rowVersion }]
    )
    const result = await this.call(
      (client) =>
        client("CommitEditorDrafts", {
          refId: this.refId,
          expectedRowVersion: snapshot.ref.rowVersion,
          fields,
          message
        }),
      ["library"]
    )
    if (result.ok || result.error.tag === "StaleWrite" || result.error.tag === "EditConflict") await this.refresh()
    return result
  }

  /** Ends one field's draft unsaved; its text goes to the bin's recovered texts. */
  async discard(key: string) {
    await this.save(key)
    const field = this.field(key)
    if (field.saved === null || field.rowVersion === null) return
    const result = await this.call((client) =>
      client("DiscardEditorDraft", { refId: this.refId, field: key, expectedRowVersion: field.rowVersion! })
    )
    if (result.ok) this.settle(key, null, result.value.rowVersion)
    return result
  }

  history(key: string, limit = 50) {
    return this.call((client) => client("EditorDraftHistory", { refId: this.refId, field: key, limit }))
  }

  async restore(key: string, seq: number) {
    await this.save(key)
    const field = this.field(key)
    const result = await this.call((client) =>
      client("RestoreEditorDraft", { refId: this.refId, field: key, seq, expectedRowVersion: field.rowVersion ?? 0 })
    )
    if (result.ok) this.settle(key, result.value.content, result.value.rowVersion)
    return result
  }

  /** One step back in a field's history. */
  async undo(key: string) {
    await this.save(key)
    const states = await this.history(key, 2)
    if (!states.ok || states.value.length < 2) return states
    return this.restore(key, states.value[1]!.seq)
  }

  /**
   * After an edit conflict: keep `content` (mine, or an edit of it) against the saved version,
   * or take the saved version by ending the draft.
   */
  async rebase(key: string, content: string | null) {
    const field = this.field(key)
    if (content === null) return this.discard(key)
    const result = await this.call((client) =>
      client("SaveEditorDraft", {
        refId: this.refId,
        field: key,
        content,
        expectedRowVersion: field.rowVersion,
        baseRevisionId: this.snapshot!.ref.headRevisionId
      })
    )
    if (result.ok) this.settle(key, result.value.content, result.value.rowVersion)
    return result
  }

  /**
   * Removes a list element, and ends the drafts of fields inside it (their text goes to the
   * recovered texts): nothing could save them any more.
   */
  async removeItem(path: FieldPath) {
    this.setValue(path, null)
    const inside = this.dirtyFields().filter((key) => {
      const field = parseField(key)?.path
      return field !== undefined && field.length > path.length && path.every((segment, at) => field[at] === segment)
    })
    await Promise.all(inside.map((key) => this.discard(key)))
  }

  /** What `beacon` last sent per field, so closing doesn't send it twice. */
  private readonly sent = new Map<string, string>()

  /**
   * As the page goes: what's typed and not saved yet, in a request that outlives the page
   * (`keepalive`, which browsers cap at 64 KB; past that, `beforeunload` has warned).
   */
  beacon() {
    const head = this.snapshot?.ref.headRevisionId ?? null
    const drafts = [...this.fields].flatMap(([field, draft]) =>
      draft.local === null || this.sent.get(field) === draft.local
        ? []
        : [
            {
              refId: this.refId,
              field,
              content: draft.local,
              expectedRowVersion: draft.rowVersion,
              baseRevisionId: draft.saved === null ? head : null
            }
          ]
    )
    if (drafts.length === 0) return
    for (const { field, content } of drafts) this.sent.set(field, content)
    void fetch("/library/drafts", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts })
    }).catch(() => undefined)
  }

  private settle(key: string, saved: string | null, rowVersion: number) {
    const field = this.field(key)
    field.saved = saved
    field.rowVersion = rowVersion
    field.local = null
    if (key.startsWith("=")) this.rebuild()
    this.bump(key, STRUCTURE, DRAFTS)
  }
}

// Components read the store only through these hooks: each returns a value that changes
// when its channel does, so neither React nor its compiler can keep a stale one.

/** A text field's current text; re-renders when it, or the document under it, changes. */
export const useText = (store: EditorStore, path: FieldPath) =>
  useSyncExternalStore(store.subscribe(textField(path), STRUCTURE), () => store.text(path))

/** A value from the document with the value drafts applied. */
export const useValue = <A>(store: EditorStore, path: FieldPath) =>
  useSyncExternalStore(store.subscribe(STRUCTURE), () => store.value(path)) as A

/** Whether a field has changes, saved as a draft or not yet. */
export const useDirty = (store: EditorStore, field: string) =>
  useSyncExternalStore(store.subscribe(field), () => store.isDirty(field))

/** What the page shows: the documents, how many fields have changes, saving or not. */
export const useEditorState = (store: EditorStore) => useSyncExternalStore(store.subscribe(DRAFTS), store.state)

/**
 * Every store on a page guards its own changes: leaving the editor saves what's typed, closing
 * or reloading the tab with a change not on the server yet asks first, and sends it as it goes.
 */
export const useLeaveGuard = (store: EditorStore) =>
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (store.isSaving()) event.preventDefault()
    }
    const leave = () => store.beacon()
    addEventListener("beforeunload", warn)
    addEventListener("pagehide", leave)
    return () => {
      removeEventListener("beforeunload", warn)
      removeEventListener("pagehide", leave)
      void store.flush()
    }
  }, [store])
