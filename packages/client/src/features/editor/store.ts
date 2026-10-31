import { Effect } from "effect"
import { checkCardNames } from "./checkCardNames.ts"
import { cardNames } from "@rp/shared/cardNames.ts"
// One ref being edited (ARCHITECTURE.md §14): its saved document, and a draft per field the
// user changed, saved to the server as they type. Components subscribe to one field each,
// so typing in a 50 KB description re-renders that field only.
//
// The rules that keep it lossless are ARCHITECTURE §3.10's invariants, as in the composer
// (features/chat/composerDraft.ts): a field's base (its draft's id, row version and session)
// changes only together with its text, or when the server answers with exactly the text
// this tab sent; every save names that draft; a copy in this browser goes only once the
// server acknowledged it, or a newer copy of the field typed from it replaces it.
import {
  applyDrafts,
  canonicalJson,
  type FieldPath,
  getAt,
  parseField,
  textField,
  valueField
} from "@rp/shared/editing.ts"
import type { Draft } from "@rp/shared/drafts.ts"
import type { ChatNotePosition, EditorSnapshot } from "@rp/shared/editorApi.ts"
import type { Doc, RefId, RevisionId } from "@rp/shared/library.ts"
import { useEffect, useMemo, useSyncExternalStore } from "react"
import type { AppError } from "../../errors.ts"
import { browserEnv, type Copy, copiesOf, dropCopy, keepCopy, makeCopy, type PageEnv, pendingOf } from "./backup.ts"
import type { ReplayConflict } from "./backup.ts"
import type { Caller } from "./caller.ts"
import { changedFields, type FieldChange } from "./fields.ts"

/** How long typing pauses before the text is saved. */
const SAVE_DELAY_MS = 600

/** A field's base and what's typed on it. */
interface FieldDraft {
  conflict: ReplayConflict | null
  replayedAt: number | null
  /** The draft's content as the server has it; null without an active draft. */
  saved: string | null
  draftId: string | null
  baseRevision: RevisionId | null
  /** This tab's copy of `local` not sent to the server yet. */
  pending: Copy | null
  /** The draft row's version, an ended draft's too: the next session starts from it. */
  rowVersion: number | null
  /** The draft's session, so the server knows which one the text was typed in. */
  session: number | null
  /** Changed here and not saved yet. */
  local: string | null
  timer: unknown
  inFlight: Promise<void> | null
}

export interface EditorState {
  readonly snapshot: EditorSnapshot | null
  readonly loadError: AppError | null
  readonly saveError: AppError | null
  /** How many fields have changes. */
  readonly dirty: number
  readonly saving: boolean
  /** Changes the last open brought back from this browser's copies. */
  readonly restored: number
  /** Earlier texts this page's saves sent to the bin's recovered texts, until dismissed. */
  readonly recovered: number
  /** The fields those texts were known to come from (a revision's save doesn't say). */
  readonly recoveredFields: ReadonlyArray<string>
}

/** The most a `keepalive` request may carry, in bytes, in the browsers that cap it. */
const KEEPALIVE_LIMIT = 64 * 1024

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
  private readonly revisionDocs = new Map<RevisionId, Doc>()
  private readonly revisionReads = new Map<RevisionId, Promise<Doc>>()

  readonly refId: RefId
  /** The signed-in user, whose copies in this browser (backup.ts) are the only ones read. */
  private readonly userId: string
  private readonly call: Caller
  private readonly env: PageEnv
  private readonly chatNote: ChatNotePosition | undefined

  constructor(refId: RefId, userId: string, call: Caller, env: PageEnv = browserEnv, chatNote?: ChatNotePosition) {
    this.userId = userId
    this.refId = refId
    this.call = call
    this.env = env
    this.chatNote = chatNote
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
          saving: this.isSaving(),
          restored: this.restored,
          recovered: this.recovered,
          recoveredFields: [...this.recoveredFields]
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
    this.versions.set("working", this.version("working") + 1)
    this.listeners.get("working")?.forEach((listener) => listener())
  }

  private bumpAll() {
    this.bump(STRUCTURE, DRAFTS, ...this.fields.keys())
  }

  private field(key: string) {
    let field = this.fields.get(key)
    if (field === undefined) {
      field = {
        conflict: null,
        replayedAt: null,
        saved: null,
        draftId: null,
        baseRevision: null,
        pending: null,
        rowVersion: null,
        session: null,
        local: null,
        timer: null,
        inFlight: null
      }
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
    const result = await this.call((client) =>
      client("OpenEditor", { refId: this.refId, ...(this.chatNote ? { chatNote: this.chatNote } : {}) })
    )
    if (result.ok) this.apply(result.value)
    else this.loadError = result.error
    this.bumpAll()
    // An entry that can't be opened (in the bin, say) keeps its copies here until it can.
    if (result.ok) await this.restoreCopies()
    return result
  }

  /** How many changes the last open brought back from this browser's copies. */
  restored = 0
  /** Earlier texts this page's saves sent to the recovered texts. */
  recovered = 0
  private readonly recoveredFields = new Set<string>()

  private noteRecovered(count: number, key?: string) {
    if (count <= 0) return
    this.recovered += count
    if (key !== undefined) this.recoveredFields.add(key)
  }

  /** The notice about recovered texts read: it goes until a save sends more. */
  dismissRecovered() {
    this.recovered = 0
    this.recoveredFields.clear()
    this.bump(DRAFTS)
  }

  /** Replay every copy with its original base: only the writer decides a stale save. */
  private async restoreCopies() {
    for (const copy of [...(await copiesOf(this.userId, this.refId))].sort((a, b) => a.at - b.at)) {
      const pending = pendingOf(copy)
      if (pending?.kind !== "editor") continue
      const payload = pending.payload
      const replay = copy
      const field = this.field(copy.field)
      const captured = {
        pending: field.pending,
        local: field.local,
        saved: field.saved,
        draftId: field.draftId,
        rowVersion: field.rowVersion,
        session: field.session,
        baseRevision: field.baseRevision
      }
      this.sendingCopies.add(replay)
      const result = await this.call((client) => client("SaveEditorDraft", payload))
      this.sendingCopies.delete(replay)
      const unchanged =
        field.pending === captured.pending &&
        field.local === captured.local &&
        field.rowVersion === captured.rowVersion &&
        field.draftId === captured.draftId &&
        field.session === captured.session &&
        field.baseRevision === captured.baseRevision &&
        field.saved === captured.saved &&
        (captured.local === null || captured.pending?.key === copy.key)
      field.replayedAt = copy.at
      if (result.ok) {
        if (result.value.displaced !== null) field.conflict = { ...result.value.displaced, typedAt: copy.at }
        if (unchanged) this.hold(field, result.value, copy.field)
        else this.noteRecovered(result.value.recovered, copy.field)
        field.replayedAt = null
        await dropCopy(copy)
      } else {
        if (unchanged) {
          field.local = payload.content
          field.pending = replay
          field.draftId = payload.draftId ?? null
          field.rowVersion = payload.expectedRowVersion
          field.session = payload.expectedSession ?? null
          field.baseRevision = payload.baseRevisionId
        }
        this.saveError = result.error
      }
      this.restored++
    }
    this.rebuild()
    this.bumpAll()
  }

  /**
   * The server's state, keeping what was typed here and not saved yet on the base it was
   * typed on: its save goes on top of any newer text, which stays one step back.
   */
  private apply(snapshot: EditorSnapshot) {
    this.snapshot = snapshot
    this.revisionDocs.set(snapshot.ref.headRevisionId, snapshot.doc)
    this.loadError = null
    for (const field of this.fields.values()) {
      if (field.local !== null) continue
      field.saved = null
      field.draftId = null
      field.baseRevision = null
      field.rowVersion = null
      field.session = null
    }
    for (const draft of snapshot.drafts) {
      const field = this.field(draft.key.field)
      if (field.local === null) this.hold(field, draft)
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

  /** The immutable revision the visible text was typed on, even after a stale refresh. */
  comparisonRevision(key: string): RevisionId | null {
    const field = this.fields.get(key)
    return (this.isDirty(key) ? field?.baseRevision : null) ?? this.snapshot?.ref.headRevisionId ?? null
  }

  async revisionDoc(id: RevisionId): Promise<Doc> {
    const cached = this.revisionDocs.get(id)
    if (cached) return cached
    const pending = this.revisionReads.get(id)
    if (pending) return pending
    const reading = this.call((client) => client("GetRevision", { refId: this.refId, revisionId: id })).then(
      (result) => {
        this.revisionReads.delete(id)
        if (!result.ok) throw result.error
        this.revisionDocs.set(id, result.value)
        return result.value
      }
    )
    this.revisionReads.set(id, reading)
    return reading
  }

  /** Each draft can have its own revision base; a concurrent save doesn't rewrite it. */
  async comparisonChanges(): Promise<ReadonlyArray<FieldChange>> {
    const working = this.working().doc
    const keys = this.dirtyFields()
    const based = await Promise.all(
      keys.map(async (field) => {
        const parsed = parseField(field)!
        const id = this.comparisonRevision(field)
        const base = id === null ? this.head : await this.revisionDoc(id)
        return { path: parsed.path, before: getAt(base, parsed.path), after: getAt(working, parsed.path) }
      })
    )
    // Deep drafts override their enclosing value draft's comparison where both exist.
    const changes = new Map<string, FieldChange>()
    for (const field of based.sort((a, b) => a.path.length - b.path.length)) {
      const key = JSON.stringify(field.path)
      if (
        [...changes.values()].some(
          (change) =>
            change.path.length < field.path.length && change.path.every((part, index) => part === field.path[index])
        )
      )
        continue
      changes.delete(key)
      for (const change of changedFields(field.before, field.after, field.path))
        changes.set(JSON.stringify(change.path), change)
    }
    return [...changes.values()]
  }

  setText(path: FieldPath, text: string) {
    this.change(textField(path), text)
  }

  setValue(path: FieldPath, value: unknown) {
    this.change(valueField(path), JSON.stringify(value) ?? "undefined")
  }

  /** Typing re-renders the field; the page hears only when a field starts having unsaved changes. */
  private change(key: string, content: string) {
    const field = this.field(key)
    this.keep(key, field, content)
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

  /**
   * Keeps `content` in this browser as a save of the field, made as it was typed. The
   * previous copy goes only if it's not on its way to the server: this text was typed from
   * it, so it names the same base. Otherwise it names the field's base (`rebase`: the server
   * confirmed the text this was typed from at that base).
   */
  private keep(key: string, field: FieldDraft, content: string, rebase = false) {
    const previous = field.pending
    const replaces = previous !== null && !this.sendingCopies.has(previous)
    const before = replaces && !rebase ? pendingOf(previous) : null
    const payload =
      before?.kind === "editor"
        ? { ...before.payload, content }
        : {
            refId: this.refId,
            field: key,
            draftId: field.draftId,
            content,
            ...this.base(field),
            baseRevisionId:
              field.saved === null && field.local === null && previous === null
                ? (this.snapshot?.ref.headRevisionId ?? null)
                : field.baseRevision
          }
    if (previous === null && field.local === null) field.baseRevision = payload.baseRevisionId
    const copy = makeCopy(
      this.userId,
      this.refId,
      key,
      { kind: "editor", payload },
      this.env.now(),
      previous === null ? [] : [previous]
    )
    field.pending = copy
    void keepCopy(copy, replaces ? previous : null)
  }

  private schedule(key: string) {
    const field = this.field(key)
    if (field.timer !== null) this.env.clearTimer(field.timer)
    field.timer = this.env.setTimer(() => void this.save(key), SAVE_DELAY_MS)
  }

  /** Saves what was typed in one field now. Saves of a field run one at a time. */
  async save(key: string): Promise<void> {
    const field = this.field(key)
    if (field.timer !== null) this.env.clearTimer(field.timer)
    field.timer = null
    while (field.inFlight) await field.inFlight
    if (field.local === null) return
    const copy = field.pending!
    const pending = pendingOf(copy)!
    if (pending.kind !== "editor") return
    const run = async () => {
      this.sendingCopies.add(copy)
      // Another tab saved this field meanwhile: the server puts this on top, theirs kept.
      const result = await this.call((client) => client("SaveEditorDraft", pending.payload))
      this.sendingCopies.delete(copy)
      if (result.ok) {
        if (field.replayedAt !== null && result.value.displaced !== null)
          field.conflict = { ...result.value.displaced, typedAt: field.replayedAt }
        field.replayedAt = null
        // The draft holds exactly this text: it's the field's base now.
        const descendant = field.pending?.ancestors.includes(copy.key) === true
        if (field.pending === copy || descendant) this.hold(field, result.value, key)
        else this.noteRecovered(result.value.recovered, key)
        if (field.pending === copy) {
          field.local = null
          field.pending = null
        } else if (descendant && field.pending !== null && !this.sendingCopies.has(field.pending)) {
          // What's typed since was typed from this text.
          this.keep(key, field, field.local!, true)
        }
        void dropCopy(copy)
        this.saveError = null
      } else {
        this.saveError = result.error
        // A newer copy typed from this one replaces it.
        if (field.pending?.ancestors.includes(copy.key)) void dropCopy(copy)
      }
      this.bump(key)
    }
    field.inFlight = run()
    await field.inFlight
    field.inFlight = null
    // Only now is the save over, as far as the page is concerned.
    this.bump(DRAFTS)
  }

  /** The draft as this tab last had it, for a save to name. */
  private base(field: FieldDraft) {
    return {
      expectedRowVersion: field.rowVersion,
      expectedSession: field.session
    }
  }

  /** The draft as the server returned it. */
  private hold(field: FieldDraft, draft: Draft, key?: string) {
    this.noteRecovered(draft.recovered, key)
    field.draftId = draft.id
    field.baseRevision = draft.baseRevision as RevisionId | null
    field.saved = draft.status === "active" ? draft.content : null
    field.rowVersion = draft.rowVersion
    field.session = draft.session
  }

  /** Everything typed, saved. */
  async flush() {
    await Promise.all([...this.fields.keys()].map((key) => this.save(key)))
  }

  /** The server's drafts and head again, without losing what's typed here. */
  async refresh() {
    const result = await this.call((client) =>
      client("OpenEditor", { refId: this.refId, ...(this.chatNote ? { chatNote: this.chatNote } : {}) })
    )
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

  /**
   * Commits every draft as one revision: each named by its id and the row version this tab
   * saved it at, so the revision holds exactly the text shown here. Nothing is committed while
   * a change isn't on the server. `only` commits those fields' drafts and leaves the others
   * as they are: an entry copied into another lorebook, without that book's own drafts.
   */
  async commit(message: string | null, only?: ReadonlyArray<string>) {
    await this.flush()
    if (this.unsavedFields().length > 0) return this.notSaved()
    const snapshot = this.snapshot!
    const fields = [...this.fields].flatMap(([field, draft]) =>
      (only && !only.includes(field)) || draft.saved === null || draft.rowVersion === null || draft.draftId === null
        ? []
        : [{ field, draftId: draft.draftId, expectedRowVersion: draft.rowVersion }]
    )
    const workingDoc = this.working().doc
    const refId = this.refId
    const chatNote = this.chatNote
    const result = await this.call(
      (client) =>
        Effect.gen(function* () {
          if (snapshot.ref.kind === "card") {
            const names = cardNames(workingDoc)
            yield* checkCardNames(client, names.displayName, names.version, snapshot.ref)
          }
          return yield* client("CommitEditorDrafts", {
            refId,
            expectedRowVersion: snapshot.ref.rowVersion,
            ...(chatNote ? { chatNote } : {}),
            fields,
            message
          })
        }),
      ["library"]
    )
    if (result.ok) {
      const fields = result.value.recoveredFields ?? []
      this.noteRecovered(result.value.recovered - fields.length)
      for (const field of fields) this.noteRecovered(1, field)
    }
    if (result.ok || result.error.tag === "StaleWrite" || result.error.tag === "EditConflict") await this.refresh()
    return result
  }

  private unsavedFields() {
    return [...this.fields.keys()].filter((key) => this.fields.get(key)!.local !== null)
  }

  /** A change isn't on the server: what would replace or commit the field waits for it. */
  private notSaved() {
    const error = this.saveError ?? NOT_SAVED
    return { ok: false as const, error, cause: error }
  }

  /** Ends one field's draft unsaved; its text goes to the bin's recovered texts. */
  async discard(key: string) {
    const picked = this.current(key)
    await this.save(key)
    const field = this.field(key)
    if (field.local !== null) return this.notSaved()
    if (this.current(key) !== picked) return changed()
    if (field.saved === null || field.rowVersion === null || field.draftId === null) return
    const { draftId, rowVersion } = field
    const result = await this.call((client) =>
      client("DiscardEditorDraft", { refId: this.refId, field: key, draftId, expectedRowVersion: rowVersion })
    )
    if (result.ok) await this.settle(key, result.value)
    return result
  }

  conflict(key: string) {
    return this.field(key).conflict
  }

  acknowledgeConflict(key: string) {
    this.field(key).conflict = null
    this.bump(key)
  }

  async switchConflict(key: string) {
    const field = this.field(key)
    const conflict = field.conflict
    if (conflict === null) return
    const result = await this.restore(key, 0, conflict.content)
    if (!result.ok) {
      this.saveError = result.error
      this.bump(DRAFTS)
    }
    if (result.ok && field.local === null && field.saved === conflict.content && field.conflict === conflict)
      this.acknowledgeConflict(key)
  }

  history(key: string, limit = 50) {
    return this.call((client) => client("EditorDraftHistory", { refId: this.refId, field: key, limit }))
  }

  async restore(key: string, seq: number, content?: string) {
    const picked = this.current(key)
    await this.save(key)
    const field = this.field(key)
    if (field.local !== null) return this.notSaved()
    if (this.current(key) !== picked) return changed()
    const { draftId, rowVersion } = field
    const result = await this.call((client) =>
      client("RestoreEditorDraft", {
        refId: this.refId,
        field: key,
        draftId: draftId ?? "",
        seq,
        ...(content === undefined ? {} : { content }),
        expectedRowVersion: rowVersion ?? 0
      })
    )
    if (result.ok) await this.settle(key, result.value)
    return result
  }

  /** One step back in a field's history. */
  async undo(key: string) {
    await this.save(key)
    const states = await this.history(key, 2)
    if (!states.ok) return states
    const previous = states.value[1]
    // The first save creates a draft at its typed value. A reopened session starts
    // from empty storage. In either case undoing that first edit means the revision's
    // value, not an empty string (which is invalid for a JSON value draft).
    if (previous === undefined || (previous.kind === "initial" && previous.length === 0)) {
      const picked = this.current(key)
      const parsed = parseField(key)!
      const revision = this.comparisonRevision(key)
      let doc = this.head
      if (revision !== null) {
        const cached = this.revisionDocs.get(revision)
        if (cached) doc = cached
        else {
          const result = await this.call((client) => client("GetRevision", { refId: this.refId, revisionId: revision }))
          if (!result.ok) return result
          this.revisionDocs.set(revision, result.value)
          doc = result.value
        }
      }
      if (this.current(key) !== picked) return changed()
      const value = getAt(doc, parsed.path)
      return this.restore(
        key,
        previous?.seq ?? 0,
        parsed.kind === "value" ? canonicalJson(value) : typeof value === "string" ? value : ""
      )
    }
    return this.restore(key, previous.seq)
  }

  /**
   * After an edit conflict: keep `content` (mine, or an edit of it) against the saved version,
   * or take the saved version by ending the draft.
   */
  async rebase(key: string, content: string | null) {
    const field = this.field(key)
    if (content === null) return this.discard(key)
    const picked = this.current(key)
    await this.save(key)
    if (field.local !== null) return this.notSaved()
    if (this.current(key) !== picked) return changed()
    const result = await this.call((client) =>
      client("SaveEditorDraft", {
        refId: this.refId,
        field: key,
        draftId: field.draftId,
        content,
        ...this.base(field),
        baseRevisionId: this.snapshot!.ref.headRevisionId
      })
    )
    if (result.ok) await this.settle(key, result.value)
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

  /** What the server confirmed `beacon` sent, per field, so closing doesn't send it twice. */
  private readonly sent = new WeakSet<Copy>()
  private readonly sendingCopies = new WeakSet<Copy>()

  /**
   * As the page goes: what's typed and not saved yet, in a request that outlives the page.
   * Browsers cap such a request at 64 KB; past that only the copy in this browser keeps the
   * text (backup.ts), after `beforeunload` has asked. A send counts once the server answers.
   */
  beacon() {
    const copies = [...this.fields.values()].flatMap((field) =>
      field.pending === null || this.sent.has(field.pending) ? [] : [field.pending]
    )
    const drafts = copies.flatMap((copy) => {
      const save = pendingOf(copy)
      return save?.kind === "editor" ? [save.payload] : []
    })
    const body = JSON.stringify({ drafts })
    if (drafts.length === 0 || new Blob([body]).size > KEEPALIVE_LIMIT) return
    for (const copy of copies) this.sendingCopies.add(copy)
    void this.env.keepalive("/library/drafts", body).then((ok) => {
      if (!(typeof ok === "boolean" ? ok : ok.ok)) return
      if (typeof ok !== "boolean") {
        this.noteRecovered(ok.recovered)
        this.bump(DRAFTS)
      }
      for (const copy of copies) {
        this.sent.add(copy)
        void dropCopy(copy)
      }
    })
  }

  /**
   * The draft after a restore, discard or rebase, made over exactly the text the user picked
   * it with. What was typed while it was on its way stays, on the base it was typed on, and
   * its save goes on top.
   */
  private async settle(key: string, draft: Draft): Promise<void> {
    if (this.field(key).local !== null) this.noteRecovered(draft.recovered, key)
    const field = this.field(key)
    if (field.local === null) this.hold(field, draft, key)
    else this.schedule(key)
    if (key.startsWith("=")) this.rebuild()
    this.bump(key, STRUCTURE, DRAFTS)
    // Undoing or reverting an added object can remove the home of its field drafts.
    // Recover those texts just as removing a list entry does; hidden orphan drafts
    // would otherwise block every later revision save. Keep descendants that still fit.
    const changed = parseField(key)
    if (changed?.kind !== "value") return
    const orphans = this.working().problems.filter(({ field, orphan }) => {
      const path = parseField(field)?.path
      return (
        orphan &&
        path !== undefined &&
        path.length > changed.path.length &&
        changed.path.every((segment, at) => path[at] === segment)
      )
    })
    for (const { field } of orphans) {
      const result = await this.discard(field)
      if (result && !result.ok) {
        this.saveError = result.error
        this.bump(DRAFTS)
      }
    }
  }
}

/** The field changed between the pick and the call: what would replace it isn't made. */
const changed = () => {
  const error: AppError = {
    tag: "Changed",
    message: "The field changed before this could be done, so it wasn't. Try again if you still want it.",
    problems: [],
    reason: null
  }
  return { ok: false as const, error, cause: error }
}

const NOT_SAVED: AppError = {
  tag: "NotSaved",
  message: "A change isn't on the server yet. Wait for it to be kept, then try again.",
  problems: [],
  reason: null
}

// Components read the store only through these hooks: each returns a value that changes
// when its channel does, so neither React nor its compiler can keep a stale one.

/** A text field's current text; re-renders when it, or the document under it, changes. */
export const useText = (store: EditorStore, path: FieldPath) =>
  useSyncExternalStore(store.subscribe(textField(path), STRUCTURE), () => store.text(path))

/** A value from the document with the value drafts applied. */
export const useValue = <A>(store: EditorStore, path: FieldPath) =>
  useSyncExternalStore(store.subscribe(STRUCTURE), () => store.value(path)) as A

export const useComparisonRevision = (store: EditorStore, field: string) =>
  useSyncExternalStore(store.subscribe(field, STRUCTURE), () => store.comparisonRevision(field))

export const useEditorKind = (store: EditorStore) =>
  useSyncExternalStore(store.subscribe(STRUCTURE), () => store.snapshot?.ref.kind)

export const useWorkingDoc = (store: EditorStore) => {
  const version = useSyncExternalStore(store.subscribe("working"), () => store.version("working"))
  // The version is the snapshot of all fields, including typing within a dirty field.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => store.working().doc, [store, version])
}

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
      if (!store.isSaving()) return
      event.preventDefault()
      // What older browsers need to ask.
      event.returnValue = ""
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
