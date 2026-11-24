// The Snippets workspace (owner, 2026-11-01): the snippets of the chat shown (every branch of it)
// and those for all chats, each edited through an editor store as every library entry is: what's
// typed saves as it's typed, with its edit history, and a revision is cut by Save. It outlives its
// panel. Text sent from an editor goes, in one click, only to a snippet open on screen (`target`);
// otherwise the sender chooses one from a menu (owner, 2026-11-02).
import type { BinItem } from "@dreamspan/shared/bin.ts"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import type { Snippet } from "@dreamspan/shared/snippetsApi.ts"
import { showToast } from "../../ui/Toast.tsx"
import { browserEnv } from "../editor/backup.ts"
import type { Caller } from "../editor/caller.ts"
import { EditorStore } from "../editor/store.ts"

interface State {
  readonly items: ReadonlyArray<Snippet>
  /** The snippet last opened, clicked or typed into. */
  readonly selected: RefId | null
  /** Those opened, clicked or typed into, the last one first: the target is the first still expanded. */
  readonly used: ReadonlyArray<RefId>
  /** Bumped by `select`, so the panel opens and shows the snippet again. */
  readonly reveal: number
  readonly error: string | null
  /** The sheet outside a chat, or where no panel can open. */
  readonly floating: boolean
  /** The chat shown, whose own snippets are listed with those for all chats; null outside one. */
  readonly chatId: ChatId | null
  /**
   * Why the chat shown can't have snippets of its own yet (a chat not started: the server refuses
   * them), or null. New snippet and the switch to this chat stay, disabled, saying so.
   */
  readonly notStarted: string | null
  /** Bumped as snippet editors mount and unmount, so what shows the target reads it again. */
  readonly editors: number
  /** Text just added to a snippet: its editor marks it briefly and scrolls to it. */
  readonly added: { readonly refId: RefId; readonly at: number; readonly length: number } | null
  /** The snippets picked from the send menu, the last one first. */
  readonly recent: ReadonlyArray<RefId>
}

const CONTENT = ["content"]

export class SnippetWorkspace {
  private state: State
  private editors = new Map<HTMLElement, RefId>()
  private listeners = new Set<() => void>()
  private stores = new Map<RefId, EditorStore>()
  private openPanel: (() => void) | null = null
  private generation = 0
  private pendingRefresh: Promise<void> | null = null
  private call: Caller
  private user: string
  constructor(call: Caller, user: string) {
    this.call = call
    this.user = user
    this.state = {
      items: [],
      selected: null,
      used: [],
      reveal: 0,
      error: null,
      floating: false,
      chatId: null,
      notStarted: null,
      editors: 0,
      added: null,
      recent: this.readRecent()
    }
  }
  private get recentKey() {
    return `dreamspan.snippetRecent.${this.user}`
  }
  private readRecent(): ReadonlyArray<RefId> {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(this.recentKey) ?? "[]")
      return Array.isArray(value) ? value.filter((id): id is RefId => typeof id === "string") : []
    } catch {
      return []
    }
  }
  private picked(refId: RefId) {
    const recent = [refId, ...this.state.recent.filter((id) => id !== refId)].slice(0, 50)
    this.update({ recent })
    try {
      localStorage.setItem(this.recentKey, JSON.stringify(recent))
    } catch {
      // Only the menu's order is lost.
    }
  }

  /** A snippet's editor on screen while mounted (it's visible only while its panel or sheet shows). */
  registerEditor = (element: HTMLElement, refId: RefId) => {
    this.editors.set(element, refId)
    this.update({ editors: this.state.editors + 1 })
    return () => {
      this.editors.delete(element)
      this.update({ editors: this.state.editors + 1 })
    }
  }
  /**
   * Where one click sends text (owner, 2026-11-02): of the snippets expanded in a shown panel or
   * sheet (scrolled away within it counts), the one opened, clicked or typed into last; one never
   * used, when none of those is expanded. None when no snippet is expanded, or Snippets isn't shown.
   */
  target = (state: State = this.state): RefId | null => {
    const visible = new Set<RefId>()
    for (const [element, refId] of this.editors)
      if (element.isConnected && element.checkVisibility({ visibilityProperty: true })) visible.add(refId)
    const used = state.used.find((id) => visible.has(id))
    if (used !== undefined) return used
    return state.items.find((item) => visible.has(item.ref.id))?.ref.id ?? null
  }
  /** The snippets to choose from, those picked last first, then as listed. */
  choices = (state: State = this.state) => {
    const rank = (item: Snippet) => {
      const at = state.recent.indexOf(item.ref.id)
      return at === -1 ? Infinity : at
    }
    return [...state.items].sort((a, b) => rank(a) - rank(b))
  }
  /** A snippet's title as shown. */
  titleOf = (refId: RefId) => {
    const store = this.stores.get(refId)
    const typed = store?.snapshot ? store.text(["title"]) : undefined
    return (typed ?? this.state.items.find((item) => item.ref.id === refId)?.title) || "Untitled snippet"
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
  setOpener(open: (() => void) | null) {
    this.openPanel = open
  }
  setNotStarted(notStarted: string | null) {
    if (notStarted !== this.state.notStarted) this.update({ notStarted })
  }
  setChat(chatId: ChatId | null) {
    if (chatId === this.state.chatId) return
    this.update({ chatId, items: [], error: null })
    void this.refresh()
  }
  open = () => {
    if (this.openPanel) this.openPanel()
    else this.update({ floating: true })
  }
  close = () => this.update({ floating: false })
  /** Makes it where Send adds, and has the panel open and show it. */
  select = (selected: RefId) =>
    this.update({
      selected,
      used: [selected, ...this.state.used.filter((id) => id !== selected)],
      reveal: this.state.reveal + 1
    })
  /** Clicked or typed into: it becomes the target, without the panel revealing it again. */
  use = (refId: RefId) => {
    if (this.state.used[0] !== refId)
      this.update({ selected: refId, used: [refId, ...this.state.used.filter((id) => id !== refId)] })
  }

  /** A snippet's editor store, made once and kept while the workspace lives. */
  store(refId: RefId) {
    let store = this.stores.get(refId)
    if (store === undefined) {
      store = new EditorStore(refId, this.user, this.call, browserEnv)
      this.stores.set(refId, store)
      void store.load()
    }
    return store
  }

  refresh = (): Promise<void> => {
    ++this.generation
    // A provider remount clears and then restores its chat in the same React commit.
    // Read the final scope once; a later write still starts a new read, even in flight.
    if (this.pendingRefresh !== null) return this.pendingRefresh
    this.pendingRefresh = Promise.resolve().then(() => {
      this.pendingRefresh = null
      return this.read(this.generation)
    })
    return this.pendingRefresh
  }

  private async read(generation: number) {
    const result = await this.call((api) => api("ListSnippets", { chatId: this.state.chatId }))
    if (generation !== this.generation) return
    if (!result.ok) return this.update({ error: result.error.message })
    const items = result.value
    const selected = items.some((item) => item.ref.id === this.state.selected) ? this.state.selected : null
    const used = this.state.used.filter((id) => items.some((item) => item.ref.id === id))
    this.update({ items, selected, used, error: null })
  }

  create = async (content = "", select = true) => {
    const result = await this.call(
      (api) => api("CreateSnippet", { chatId: this.state.chatId, title: "Untitled snippet", content }),
      ["library"]
    )
    if (!result.ok) return this.update({ error: result.error.message })
    this.update({ items: [...this.state.items, result.value], error: null })
    if (select) this.select(result.value.ref.id)
    void this.refresh()
    return result.value
  }

  private added(refId: RefId, title: string, content: string) {
    const name = title && title !== "Untitled snippet" ? title : content.trim().replace(/\s+/g, " ").slice(0, 60)
    showToast({
      title: `Added to snippet “${name || "Untitled snippet"}”`,
      actions: [
        {
          label: "Open",
          hint: "Open this snippet in Snippets",
          onClick: () => {
            this.select(refId)
            this.open()
          }
        }
      ]
    })
  }

  /**
   * Adds text to the end of a snippet. To the target on screen, it shows there; chosen from the
   * menu, the panel stays as it is and a notice says where it went.
   */
  append = async (refId: RefId, text: string, how: "target" | "chosen") => {
    if (how === "chosen") this.picked(refId)
    const store = this.store(refId)
    if (store.snapshot === null) await store.load()
    if (store.snapshot === null) return this.update({ error: "That snippet couldn't be opened." })
    const current = (store.text(CONTENT) ?? "").replace(/\n*$/, "")
    const next = current === "" ? text : `${current}\n\n${text}`
    store.setText(CONTENT, next)
    const added = { refId, at: next.length - text.length, length: text.length }
    this.update({ added })
    setTimeout(() => this.state.added === added && this.update({ added: null }), 2000)
    await store.save(textField(CONTENT))
    if (store.saveError) return this.update({ error: store.saveError.message })
    if (how === "chosen") this.added(refId, store.text(["title"]) ?? "", store.text(CONTENT) ?? text)
  }

  /** A new snippet holding the text, from the menu: the panel stays as it is. */
  appendNew = async (text: string) => {
    const made = await this.create(text, false)
    if (!made) return
    this.picked(made.ref.id)
    this.added(made.ref.id, made.title, made.content)
  }

  /** For all chats, or only the chat shown (every branch of it). */
  setGlobal = async (refId: RefId, global: boolean) => {
    const result = await this.call(
      (api) => api("SetSnippetScope", { chatId: this.state.chatId, refId, global }),
      ["library"]
    )
    if (!result.ok) return this.update({ error: result.error.message })
    this.update({
      items: this.state.items.map((item) => (item.ref.id === refId ? result.value : item)),
      error: null
    })
  }

  /** How many notes show it (another chat's, a card's, or this chat's). */
  usedBy = async (refId: RefId) => {
    const chatId = this.state.chatId
    const result = await this.call((api) =>
      api("ListSharedNotes", { refId, ...(chatId === null ? {} : { chatNote: { chatId, slotId: null } }) })
    )
    return result.ok ? (result.value[0]?.usedBy ?? 0) : 0
  }

  /** To the bin: what's typed is saved first and goes with it. */
  remove = async (refId: RefId): Promise<BinItem | null> => {
    const store = this.stores.get(refId)
    if (store) {
      await store.flush()
      if (store.isSaving()) {
        this.update({ error: "Its text isn't saved yet, so it stays until it is." })
        return null
      }
    }
    const result = await this.call((api) => api("DeleteNote", { noteRefId: refId }), ["library"])
    if (!result.ok) {
      this.update({ error: result.error.message })
      return null
    }
    this.stores.delete(refId)
    this.update({
      items: this.state.items.filter((item) => item.ref.id !== refId),
      selected: this.state.selected === refId ? null : this.state.selected,
      error: null
    })
    return result.value
  }
}
