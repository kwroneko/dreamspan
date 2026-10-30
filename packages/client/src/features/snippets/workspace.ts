import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import type { Snippet } from "@rp/shared/snippetsApi.ts"
import type { BinItem } from "@rp/shared/bin.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { Caller } from "../editor/caller.ts"

interface Scope {
  chatId: ChatId | null
  forkId: ForkId | null
}
interface State {
  readonly items: ReadonlyArray<Snippet>
  readonly selected: RefId | null
  readonly error: string | null
  readonly saving: boolean
  readonly floating: boolean
  readonly deleting: RefId | null
}
/** The workspace outlives its panel: switching tabs never cancels pending text. */
export class SnippetWorkspace {
  private state: State = { items: [], selected: null, error: null, saving: false, floating: false, deleting: null }
  private listeners = new Set<() => void>()
  private scope: Scope = { chatId: null, forkId: null }
  private openPanel: (() => void) | null = null
  private serial: Promise<void> = Promise.resolve()
  private generation = 0
  private dirty = new Set<RefId>()
  private call: Caller
  private user: string
  constructor(call: Caller, user: string) {
    this.call = call
    this.user = user
  }
  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(next: Partial<State>) {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }
  private key(ref: RefId) {
    return `rp.snippet.${this.user}.${ref}.${this.scope.forkId ?? "global"}`
  }
  private backup(item: Snippet) {
    try {
      localStorage.setItem(this.key(item.ref.id), JSON.stringify({ title: item.title, content: item.content }))
    } catch {
      /* The server still saves it. */
    }
  }
  private enqueue(task: () => Promise<void>) {
    this.serial = this.serial.then(task).catch((error: unknown) => this.update({ error: String(error) }))
    return this.serial
  }
  setOpener(open: (() => void) | null) {
    this.openPanel = open
  }
  setScope(scope: Scope) {
    void this.enqueue(async () => {
      this.scope = scope
      this.generation++
      this.dirty.clear()
      this.update({ items: [], selected: null, error: null })
      await this.readSnapshot()
    })
  }
  open = () => {
    if (this.openPanel) this.openPanel()
    else this.update({ floating: true })
  }
  close = () => this.update({ floating: false })
  select = (selected: RefId) => this.update({ selected })
  refresh = () => this.enqueue(() => this.readSnapshot())
  private readSnapshot = async () => {
    const generation = this.generation
    const result = await this.call((api) => api("ListSnippets", this.scope))
    if (generation !== this.generation) return
    if (!result.ok) {
      this.update({ error: result.error.message })
      return
    }
    let recovered = false
    const items = result.value.map((item) => {
      const local = this.state.items.find((i) => i.ref.id === item.ref.id)
      if (local && this.dirty.has(item.ref.id)) return local
      let restored: { title: string; content: string } | null = null
      try {
        restored = JSON.parse(localStorage.getItem(this.key(item.ref.id)) ?? "null") as {
          title: string
          content: string
        } | null
      } catch {
        /* Nothing to restore. */
      }
      if (restored && (restored.title !== item.title || restored.content !== item.content)) {
        this.dirty.add(item.ref.id)
        recovered = true
        return { ...item, ...restored }
      }
      return item
    })
    this.update({
      ...(recovered
        ? { error: "Recovered unsaved snippet text from this browser. Edit it to save, or save it as a new snippet." }
        : {}),
      items,
      selected: items.some((i) => i.ref.id === this.state.selected) ? this.state.selected : (items[0]?.ref.id ?? null)
    })
    // Recovered browser copies remain local until the user explicitly retries them.
  }
  create = (content = "") => this.enqueue(() => this.createNow(content))
  private createNow = async (content: string) => {
    const result = await this.call(
      (api) => api("CreateSnippet", { ...this.scope, title: "Untitled snippet", content }),
      ["library"]
    )
    if (!result.ok) {
      this.update({ error: result.error.message })
      return
    }
    this.update({ items: [...this.state.items, result.value], selected: result.value.ref.id, error: null })
  }
  change = (ref: RefId, fields: { title?: string; content?: string }) => {
    if (this.edit(ref, fields)) void this.save(ref)
  }
  private edit(ref: RefId, fields: { title?: string; content?: string }) {
    if (this.state.deleting === ref) return false
    const item = this.state.items.find((i) => i.ref.id === ref)
    if (!item) return false
    const next = { ...item, ...fields }
    this.dirty.add(ref)
    this.backup(next)
    this.update({ items: this.state.items.map((i) => (i.ref.id === ref ? next : i)) })
    return true
  }
  save = (ref: RefId) => this.enqueue(() => this.saveNow(ref))
  private saveNow = async (ref: RefId) => {
    if (!this.dirty.has(ref)) return
    const item = this.state.items.find((i) => i.ref.id === ref)
    if (!item) return
    this.update({ saving: true })
    const result = await this.call(
      (api) =>
        api("SaveSnippet", {
          ...this.scope,
          refId: ref,
          title: item.title,
          content: item.content,
          expectedRevision: item.revision
        }),
      ["library"]
    )
    if (!result.ok) {
      this.update({
        saving: false,
        error: `${result.error.message} Your text is kept here. Copy it or save it as a new snippet.`
      })
      return
    }
    const latest = this.state.items.find((i) => i.ref.id === ref)!
    const unchanged = latest.title === item.title && latest.content === item.content
    if (unchanged) {
      this.dirty.delete(ref)
      try {
        localStorage.removeItem(this.key(ref))
      } catch {
        /* Server copy is safe. */
      }
    }
    this.update({
      saving: false,
      error: null,
      items: this.state.items.map((i) =>
        i.ref.id !== ref
          ? i
          : unchanged
            ? result.value
            : { ...result.value, title: latest.title, content: latest.content }
      )
    })
  }
  /** The snippet's earlier texts on the server, newest first; pending typing is saved first. */
  history = (ref: RefId, limit = 50) =>
    this.enqueue(() => this.saveNow(ref)).then(() =>
      this.call((api) => api("SnippetHistory", { ...this.scope, refId: ref, limit }))
    )
  /** Restores state `seq` of the text history as the snippet's text. */
  restore = (ref: RefId, seq: number) => this.enqueue(() => this.restoreNow(ref, seq))
  /** One step back in the server's text history, so it works after a reload too. */
  undo = (ref: RefId) =>
    this.enqueue(async () => {
      await this.saveNow(ref)
      if (this.dirty.has(ref)) return
      const result = await this.call((api) => api("SnippetHistory", { ...this.scope, refId: ref, limit: 2 }))
      if (!result.ok) return this.update({ error: result.error.message })
      const earlier = result.value[1]
      if (earlier === undefined) return this.update({ error: "There's no earlier text to go back to." })
      await this.restoreNow(ref, earlier.seq)
    })
  private restoreNow = async (ref: RefId, seq: number) => {
    await this.saveNow(ref)
    const item = this.state.items.find((i) => i.ref.id === ref)
    if (!item || this.dirty.has(ref)) return
    const result = await this.call(
      (api) => api("RestoreSnippet", { ...this.scope, refId: ref, seq, expectedRevision: item.revision }),
      ["library"]
    )
    if (!result.ok) return this.update({ error: result.error.message })
    // Typing can continue while the restore is on its way. Keep it on the acknowledged
    // revision so its queued save does not replace it with the restored response.
    const latest = this.state.items.find((i) => i.ref.id === ref)
    this.update({
      error: null,
      items: this.state.items.map((i) =>
        i.ref.id !== ref
          ? i
          : latest && this.dirty.has(ref)
            ? { ...result.value, title: latest.title, content: latest.content }
            : result.value
      )
    })
  }
  /** How many notes in cards and chats show the snippet, which deleting it leaves showing nothing. */
  usedBy = async (ref: RefId) => {
    const { chatId, forkId } = this.scope
    const result = await this.call((api) =>
      api("ListSharedNotes", { refId: ref, ...(chatId === null ? {} : { chatNote: { chatId, forkId, slotId: null } }) })
    )
    return result.ok ? (result.value[0]?.usedBy ?? 0) : 0
  }
  /** Deletes the snippet to the bin, its pending text first, so Undo brings back what was typed. */
  remove = async (ref: RefId) => {
    let deleted: BinItem | null = null
    this.update({ deleting: ref })
    try {
      await this.enqueue(async () => {
        await this.saveNow(ref)
        if (this.dirty.has(ref)) return
        const result = await this.call((api) => api("DeleteNote", { noteRefId: ref }), ["library"])
        if (!result.ok) return this.update({ error: result.error.message })
        this.dirty.delete(ref)
        try {
          localStorage.removeItem(this.key(ref))
        } catch {
          /* The bin has its text. */
        }
        const items = this.state.items.filter((i) => i.ref.id !== ref)
        this.update({
          error: null,
          items,
          selected: this.state.selected === ref ? (items[0]?.ref.id ?? null) : this.state.selected
        })
        deleted = result.value
      })
    } finally {
      this.update({ deleting: null })
    }
    return deleted
  }
  send = (text: string) => {
    this.open()
    void this.enqueue(async () => {
      const item = this.state.items.find((i) => i.ref.id === this.state.selected)
      // Finish this transfer in the same queue entry, before another send or scope change.
      if (item) {
        this.edit(item.ref.id, { content: `${item.content}${item.content ? "\n" : ""}${text}` })
        await this.saveNow(item.ref.id)
      } else await this.createNow(text)
    })
  }
  makeGlobal = (ref: RefId) => {
    void this.save(ref)
    return this.enqueue(async () => {
      if (this.dirty.has(ref)) return
      const item = this.state.items.find((i) => i.ref.id === ref)!
      const result = await this.call(
        (api) => api("MakeSnippetGlobal", { ...this.scope, refId: ref, expectedRevision: item.revision }),
        ["library"]
      )
      if (!result.ok) {
        this.update({ error: result.error.message })
        return
      }
      this.update({ items: this.state.items.map((i) => (i.ref.id === ref ? result.value : i)) })
    })
  }
}
