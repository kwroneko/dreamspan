// Which insertion editors are open in a chat's tab. Their text is a server draft held by the
// session (messageDraft.ts, target `Insert`), which outlives this: Cancel closes the editor and
// keeps the draft, so opening it again at the same message finds the text; a draft with text
// read as the chat opens (a reload, another tab) opens its editor again, unless cancelled here.
import type { MessageDraftTarget } from "@rp/shared/chatApi.ts"
import { useSyncExternalStore } from "react"
import { editorKey, type MessageEditorKey } from "../messageDraft.ts"
import type { ChatSession } from "../session.ts"

export type InsertTarget = Extract<MessageDraftTarget, { readonly _tag: "Insert" }>

class OpenEditors {
  private readonly open = new Set<MessageEditorKey>()
  private readonly cancelled = new Set<MessageEditorKey>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  readonly snapshot = () => this.version

  private changed() {
    this.version++
    for (const listener of this.listeners) listener()
  }

  show(target: InsertTarget) {
    const key = editorKey(target)
    this.cancelled.delete(key)
    this.open.add(key)
    this.changed()
  }

  hide(target: InsertTarget, cancelled: boolean) {
    const key = editorKey(target)
    this.open.delete(key)
    if (cancelled) this.cancelled.add(key)
    this.changed()
  }

  /** Whether the editor at `target` shows: opened here, or holding text from a draft not cancelled here. */
  shows(session: ChatSession, target: InsertTarget) {
    const key = editorKey(target)
    if (this.open.has(key)) return true
    if (this.cancelled.has(key)) return false
    const editor = session.editor(key)
    return editor !== undefined && editor.snapshot().text !== ""
  }
}

const stores = new WeakMap<ChatSession, OpenEditors>()

export const openEditors = (session: ChatSession) => {
  let store = stores.get(session)
  if (store === undefined) {
    store = new OpenEditors()
    stores.set(session, store)
  }
  return store
}

/** The insertion target below `anchor` (null: above the first message) in the fork shown, if it's known yet. */
export const insertTarget = (session: ChatSession, anchor: string | null): InsertTarget | null => {
  const view = session.snapshot()
  const forkId = view.forkId ?? view.chat?.currentForkId ?? null
  return forkId === null
    ? null
    : { _tag: "Insert", chatId: session.id, forkId, anchor: anchor as InsertTarget["anchor"] }
}

/**
 * The editor open at `target` (null: none, or not known yet), re-read when editors open or close
 * here or the session's editors change. Read in the snapshot, so the compiler can't keep a stale one.
 */
export const useOpenEditor = (session: ChatSession, target: InsertTarget | null) => {
  const store = openEditors(session)
  const subscribe = (listener: () => void) => {
    const closeStore = store.subscribe(listener)
    const closeEditors = session.subscribeEditors(listener)
    return () => {
      closeStore()
      closeEditors()
    }
  }
  const read = () =>
    target !== null && store.shows(session, target) ? (session.editor(editorKey(target)) ?? null) : null
  return useSyncExternalStore(subscribe, read, read)
}
