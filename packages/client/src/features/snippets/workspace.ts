// The Snippets workspace (owner, 2026-11-01): the snippets of the chat shown (every branch of it)
// and those for all chats, each edited through an editor store as every library entry is: what's
// typed saves as it's typed, with its edit history, and a revision is cut by Save. It outlives its
// panel, so text sent here with the panel closed goes to the snippet open last.
import type { BinItem } from "@rp/shared/bin.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import { textField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { Snippet } from "@rp/shared/snippetsApi.ts"
import { browserEnv } from "../editor/backup.ts"
import type { Caller } from "../editor/caller.ts"
import { EditorStore } from "../editor/store.ts"

interface State {
  readonly items: ReadonlyArray<Snippet>
  /** Where Send text to snippet adds: the snippet opened or created last. */
  readonly selected: RefId | null
  /** Bumped by `select`, so the panel opens and shows the snippet again. */
  readonly reveal: number
  readonly error: string | null
  /** The sheet outside a chat, or where no panel can open. */
  readonly floating: boolean
  /** The chat shown, whose own snippets are listed with those for all chats; null outside one. */
  readonly chatId: ChatId | null
}

const CONTENT = ["content"]

export class SnippetWorkspace {
  private state: State = { items: [], selected: null, reveal: 0, error: null, floating: false, chatId: null }
  private listeners = new Set<() => void>()
  private stores = new Map<RefId, EditorStore>()
  private openPanel: (() => void) | null = null
  private generation = 0
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
  setOpener(open: (() => void) | null) {
    this.openPanel = open
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
  select = (selected: RefId) => this.update({ selected, reveal: this.state.reveal + 1 })

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

  refresh = async () => {
    const generation = ++this.generation
    const result = await this.call((api) => api("ListSnippets", { chatId: this.state.chatId }))
    if (generation !== this.generation) return
    if (!result.ok) return this.update({ error: result.error.message })
    const items = result.value
    const selected = items.some((item) => item.ref.id === this.state.selected) ? this.state.selected : null
    this.update({ items, selected, error: null })
  }

  create = async (content = "") => {
    const result = await this.call(
      (api) => api("CreateSnippet", { chatId: this.state.chatId, title: "Untitled snippet", content }),
      ["library"]
    )
    if (!result.ok) return this.update({ error: result.error.message })
    this.update({ items: [...this.state.items, result.value], error: null })
    this.select(result.value.ref.id)
    void this.refresh()
  }

  /** Adds text to the end of the snippet open last, or to a new one. */
  send = async (text: string) => {
    this.open()
    const target = this.state.selected
    if (target === null) return this.create(text)
    const store = this.store(target)
    if (store.snapshot === null) await store.load()
    if (store.snapshot === null) return this.create(text)
    const current = store.text(CONTENT) ?? ""
    store.setText(CONTENT, current === "" ? text : `${current.replace(/\n*$/, "")}\n\n${text}`)
    await store.save(textField(CONTENT))
    this.select(target)
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
