// Pending saves kept in this browser until the exact copy is acknowledged. Tabs own
// independent copies; a newer edit may replace only this store's unsent copy. The payload
// is the save as typed, including its base, and replay never refreshes that base. Authored
// settings and pending messages also have user_field drafts; legacy browser-only copies
// remain readable until their editor transfers them or they are explicitly deleted.
import type { DraftDisplacement } from "@dreamspan/shared/drafts.ts"
import { ComposerBeacon } from "@dreamspan/shared/composerApi.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { UserDraftSave, EditorDraftSave } from "@dreamspan/shared/editorApi.ts"
import { SummaryDraftSave } from "@dreamspan/shared/lcm.ts"
import { MessageDraftSave } from "@dreamspan/shared/chatApi.ts"
import { FileDraftSave } from "@dreamspan/shared/filesApi.ts"
import { Option, Schema } from "effect"

const PendingSave = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("userDraft"), payload: UserDraftSave }),
  Schema.Struct({ kind: Schema.Literal("editor"), payload: EditorDraftSave }),
  Schema.Struct({ kind: Schema.Literal("composer"), payload: ComposerBeacon }),
  Schema.Struct({
    kind: Schema.Literal("pendingChat"),
    payload: Schema.Struct({
      entityId: Schema.String,
      name: Schema.String,
      content: Schema.String,
      /** A new chat of a group: one of the group's chats, which names its page (`/groups/$chatId/new`). */
      groupChatId: Schema.optionalKey(Schema.String),
      /** Extra unsent text after StartChat succeeded, addressed to its saved chat. */
      chatId: Schema.optionalKey(Schema.String),
      composerBase: Schema.optionalKey(
        Schema.Struct({ draftId: Schema.String, rowVersion: Schema.Int, session: Schema.Int })
      )
    })
  }),
  Schema.Struct({ kind: Schema.Literal("summary"), payload: SummaryDraftSave }),
  Schema.Struct({ kind: Schema.Literal("message"), payload: MessageDraftSave }),
  Schema.Struct({ kind: Schema.Literal("file"), payload: FileDraftSave }),
  // Legacy account-setting copies transfer to user_field drafts when the editor opens.
  Schema.Struct({ kind: Schema.Literal("setting"), payload: Schema.Struct({ content: Schema.String }) })
])
type PendingSave = typeof PendingSave.Type

const DATABASE = "dreamspan-editor-copies"
const STORE = "copies"
export interface Copy {
  readonly key: string
  readonly userId: string
  readonly refId: string
  readonly field: string
  readonly content: string
  readonly at: number
  readonly ancestors: ReadonlyArray<string>
  readonly save: PendingSave
}

let opened: Promise<IDBDatabase | null> | null = null

const database = () => {
  opened ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: "key" })
        store.createIndex("userId", "userId")
        store.createIndex("ref", ["userId", "refId"])
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return opened
}

// Completed IndexedDB mutations refresh recovery counts here and in other tabs.
const copiesChanged = "dreamspan-browser-copies"
let copiesChannel: BroadcastChannel | null = null
const channel = () => {
  if (copiesChannel === null && typeof BroadcastChannel !== "undefined") {
    try {
      copiesChannel = new BroadcastChannel(copiesChanged)
      copiesChannel.onmessage = () => window.dispatchEvent(new Event(copiesChanged))
    } catch {
      /* Recovery still updates within this tab when broadcasting is unavailable. */
    }
  }
  return copiesChannel
}
const notifyCopies = () => {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(copiesChanged))
  channel()?.postMessage(null)
}
export const subscribeCopies = (listener: () => void) => {
  channel()
  window.addEventListener(copiesChanged, listener)
  window.addEventListener("focus", listener)
  return () => {
    window.removeEventListener(copiesChanged, listener)
    window.removeEventListener("focus", listener)
  }
}

const run = async (mode: IDBTransactionMode, apply: (store: IDBObjectStore) => void) => {
  const db = await database()
  if (db === null) return
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE, mode)
      transaction.oncomplete = () => {
        if (mode === "readwrite") notifyCopies()
        resolve()
      }
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
      apply(transaction.objectStore(STORE))
    } catch {
      // Storage full or unavailable: the copy is lost, the server save still goes ahead.
      resolve()
    }
  })
}

/** Every copy `query` finds in an index, handed to `each` with the store to act on it. */
const forEach = (
  store: IDBObjectStore,
  index: string | null,
  query: IDBValidKey | IDBKeyRange | null,
  each: (copy: Copy, store: IDBObjectStore) => void
) => {
  const source = index === null ? store : store.index(index)
  const request = source.openCursor(query)
  request.onsuccess = () => {
    const cursor = request.result
    if (cursor === null) return
    each(cursor.value as Copy, store)
    cursor.continue()
  }
}

/**
 * What the draft stores use of the page: timers, the clock and requests that outlive it.
 * The protocol tests (server test/protocol) drive them by hand.
 */
export interface PageEnv {
  readonly setTimer: (run: () => void, ms: number) => unknown
  readonly clearTimer: (timer: unknown) => void
  readonly now: () => number
  /** A JSON request that outlives the page (`fetch` with `keepalive`): whether the server took it. */
  readonly keepalive: (
    path: string,
    body: string
  ) => Promise<boolean | { readonly ok: boolean; readonly recovered: number }>
}

export const browserEnv: PageEnv = {
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  keepalive: (path, body) =>
    fetch(path, { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body }).then(
      (response) => ({ ok: response.ok, recovered: Number(response.headers.get("x-drafts-recovered") ?? 0) }),
      () => false
    )
}

export const makeCopy = (
  userId: string,
  refId: string,
  field: string,
  save: PendingSave | { readonly kind: "composer"; readonly payload: Omit<typeof ComposerBeacon.Type, "operationId"> },
  at: number,
  parents: ReadonlyArray<Copy> = []
): Copy => {
  const key = uuidv7()
  // Composer operation identities also survive a keepalive acknowledgement or a send.
  const pending =
    save.kind === "composer"
      ? {
          ...save,
          payload: { ...save.payload, operationId: key }
        }
      : save
  return {
    key,
    userId,
    refId,
    field,
    content: save.payload.content,
    save: pending,
    at,
    ancestors: [...new Set(parents.flatMap((copy) => [copy.key, ...copy.ancestors]))]
  }
}

export const keepCopy = (copy: Copy, replaced: Copy | null = null) =>
  run("readwrite", (store) => {
    store.put(copy)
    if (replaced !== null) store.delete(replaced.key)
  })

/** Acknowledgement names the copy, never reconstructed text or version metadata. */
export const dropCopy = (copy: Copy) => run("readwrite", (store) => store.delete(copy.key))

const decodeSave = Schema.decodeUnknownOption(PendingSave)

/** The complete original save, validated before replay. */
export const pendingOf = (copy: Copy): PendingSave | null => Option.getOrNull(decodeSave(copy.save))

/** The user's copies for an entry. */
export const copiesOf = async (userId: string, refId: string): Promise<ReadonlyArray<Copy>> => {
  const copies: Array<Copy> = []
  await run("readonly", (store) => forEach(store, "ref", [userId, refId], (copy) => copies.push(copy)))
  return copies
}

/** Where the first message typed in a chat with this card, not made yet, is kept. */
export const pendingChatCopy = (entityId: string) => `pending-chat:${entityId}`

/** Where the first message typed in a new chat of a group is kept: per group, its name and characters. */
export const pendingGroupChatCopy = (name: string, memberIds: ReadonlyArray<string>) =>
  `pending-group-chat:${[...memberIds].sort().join(",")}:${name}`

/** All the user's copies. */
export const copiesOfUser = async (userId: string): Promise<ReadonlyArray<Copy>> => {
  const copies: Array<Copy> = []
  await run("readonly", (store) => forEach(store, "userId", userId, (copy) => copies.push(copy)))
  return copies
}

/**
 * A copy that has no server draft to go to: a first message before its chat exists, and a
 * setting's text. It stays in this browser, for this user, until sent or saved from its
 * page or deleted, so it doesn't need the session and doesn't hold up logout.
 */
export const browserOnly = (copy: Copy) => {
  const save = pendingOf(copy)
  return save !== null && (save.kind === "pendingChat" || save.kind === "setting")
}

/**
 * Try every exact copy before logout or at the user's request. Failures stay recoverable
 * here, as do the copies that stay in this browser (`browserOnly`).
 */
export const flushCopies = async (userId: string) => {
  let recovered = 0
  for (const copy of await copiesOfUser(userId)) {
    const save = pendingOf(copy)
    if (save === null || browserOnly(copy)) continue
    const body = JSON.stringify({
      userDrafts: save.kind === "userDraft" ? [save.payload] : [],
      drafts: save.kind === "editor" ? [save.payload] : [],
      composers: save.kind === "composer" ? [save.payload] : [],
      summaries: save.kind === "summary" ? [save.payload] : [],
      messages: save.kind === "message" ? [save.payload] : [],
      files: save.kind === "file" ? [save.payload] : []
    })
    try {
      const response = await fetch("/library/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      })
      if (response.ok) {
        recovered += Number(response.headers.get("x-drafts-recovered") ?? 0)
        await dropCopy(copy)
      }
    } catch {
      /* The user can retry or delete the copy explicitly. */
    }
  }
  return { copies: await copiesOfUser(userId), recovered }
}

/** A replay conflict stays visible in its field until acknowledged or switched. */
export interface ReplayConflict extends DraftDisplacement {
  readonly typedAt: number
}
