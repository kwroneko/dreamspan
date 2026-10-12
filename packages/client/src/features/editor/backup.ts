// Pending saves kept in this browser until the exact copy is acknowledged. Tabs own
// independent copies; a newer edit may replace only this store's unsent copy. The payload
// is the save as typed, including its base, and replay never refreshes that base.
import { ComposerBeacon } from "@rp/shared/composerApi.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { EditorDraftSave } from "@rp/shared/editorApi.ts"
import { Option, Schema } from "effect"

const PendingSave = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("editor"), draftId: Schema.NullOr(Schema.String), payload: EditorDraftSave }),
  Schema.Struct({ kind: Schema.Literal("composer"), payload: ComposerBeacon })
])
type PendingSave = typeof PendingSave.Type

const DATABASE = "rp-editor-copies"
const STORE = "copies"
/** How long an unsent copy is kept. */
const COPY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** The most all of a user's copies may hold, in characters; the oldest go first. */
const COPY_LIMIT_CHARS = 8 * 1024 * 1024

export interface Copy {
  readonly key: string
  readonly userId: string
  readonly refId: string
  readonly field: string
  readonly content: string
  readonly at: number
  readonly save?: PendingSave
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

const run = async (mode: IDBTransactionMode, apply: (store: IDBObjectStore) => void) => {
  const db = await database()
  if (db === null) return
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE, mode)
      transaction.oncomplete = () => resolve()
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
  readonly keepalive: (path: string, body: string) => Promise<boolean>
}

export const browserEnv: PageEnv = {
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  keepalive: (path, body) =>
    fetch(path, { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body }).then(
      (response) => response.ok,
      () => false
    )
}

export const makeCopy = (userId: string, refId: string, field: string, save: PendingSave, at: number): Copy => {
  const key = uuidv7()
  // Composer operation identities also survive a keepalive acknowledgement or a send.
  const pending =
    save.kind === "composer"
      ? {
          ...save,
          payload: { ...save.payload, operationId: key }
        }
      : save
  return { key, userId, refId, field, content: save.payload.content, save: pending, at }
}

export const keepCopy = (copy: Copy, replaced: Copy | null = null) =>
  run("readwrite", (store) => {
    store.put(copy)
    if (replaced !== null) store.delete(replaced.key)
  })

/** Acknowledgement names the copy, never reconstructed text or version metadata. */
export const dropCopy = (copy: Copy) => run("readwrite", (store) => store.delete(copy.key))

const decodeSave = Schema.decodeUnknownOption(PendingSave)

/** Old releases kept composer payloads in `content`; preserve their original base too. */
export const pendingOf = (copy: Copy): PendingSave | null => {
  if (copy.save !== undefined) return Option.getOrNull(decodeSave(copy.save))
  if (!copy.refId.startsWith("composer:")) return null
  try {
    const old = JSON.parse(copy.content) as unknown
    const decoded = Schema.decodeUnknownOption(
      Schema.Struct({
        text: Schema.String,
        rowVersion: Schema.Int,
        session: Schema.Int,
        next: Schema.Boolean
      })
    )(old)
    if (Option.isNone(decoded)) return null
    return Option.getOrNull(
      decodeSave({
        kind: "composer",
        payload: {
          chatId: copy.refId.slice("composer:".length),
          draftId: copy.field.split(" ")[0],
          rowVersion: decoded.value.rowVersion,
          session: decoded.value.session,
          next: decoded.value.next,
          content: decoded.value.text,
          operationId: copy.key
        }
      })
    )
  } catch {
    return null
  }
}

/** The user's copies for an entry. */
export const copiesOf = async (userId: string, refId: string): Promise<ReadonlyArray<Copy>> => {
  const copies: Array<Copy> = []
  await run("readonly", (store) => forEach(store, "ref", [userId, refId], (copy) => copies.push(copy)))
  return copies
}

/** All the user's copies. */
export const copiesOfUser = async (userId: string): Promise<ReadonlyArray<Copy>> => {
  const copies: Array<Copy> = []
  await run("readonly", (store) => forEach(store, "userId", userId, (copy) => copies.push(copy)))
  return copies
}

/** Logging out: the user's copies go. */
export const clearCopies = (userId: string) =>
  run("readwrite", (store) => forEach(store, "userId", userId, (copy, s) => s.delete(copy.key)))

/** A session starts here: every other user's copies go, so nobody reads another's. */
export const clearOtherUsers = (userId: string) =>
  run("readwrite", (store) =>
    forEach(store, null, null, (copy, s) => {
      if (copy.userId !== userId) s.delete(copy.key)
    })
  )

/** Copies past the retention period go, then the oldest, until the rest fit the limit. */
export const pruneCopies = (userId: string, now: number) =>
  run("readwrite", (store) => {
    const kept: Array<Copy> = []
    const request = store.index("userId").openCursor(userId)
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor !== null) {
        const copy = cursor.value as Copy
        if (now - copy.at > COPY_RETENTION_MS) cursor.delete()
        else kept.push(copy)
        cursor.continue()
        return
      }
      let total = kept.reduce((sum, copy) => sum + copy.content.length, 0)
      for (const copy of kept.sort((a, b) => a.at - b.at)) {
        if (total <= COPY_LIMIT_CHARS) break
        store.delete(copy.key)
        total -= copy.content.length
      }
    }
  })
