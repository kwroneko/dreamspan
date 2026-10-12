// The last resort for text typed and not yet on the server: a copy in this browser
// (IndexedDB), written as the user types and removed once the server has the text. A page
// that closes before its save and its keepalive request (capped at 64 KB) leaves the copy,
// and the editor brings it back on the next open. A chat's composer keeps its copies here
// too (chat/composerDraft.ts), filed under `composer:<chat>` with the branch tip as the field.
//
// It's a recovery copy, not a secure store: it's plain text in the browser profile, so
// anyone with that profile can read what a user typed and didn't send while the copy lasts.
// So copies belong to their user, are never restored to another, and go when the user logs
// out, when another user's session starts here, when their entry is deleted, after a week,
// and oldest first past a total size. Anything failing here only loses the copy.

const DATABASE = "rp-editor-copies"
const STORE = "copies"
/** How long an unsent copy is kept. */
const COPY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** The most all of a user's copies may hold, in characters; the oldest go first. */
const COPY_LIMIT_CHARS = 8 * 1024 * 1024

interface Copy {
  readonly key: string
  readonly userId: string
  readonly refId: string
  readonly field: string
  readonly content: string
  readonly at: number
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

const keyOf = (userId: string, refId: string, field: string) => `${userId}\n${refId}\n${field}`

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

export const keepCopy = (userId: string, refId: string, field: string, content: string) =>
  run("readwrite", (store) =>
    store.put({ key: keyOf(userId, refId, field), userId, refId, field, content, at: Date.now() } satisfies Copy)
  )

/** Drops a copy once the server holds `content` (a newer copy stays). */
export const dropCopy = (userId: string, refId: string, field: string, content: string) =>
  run("readwrite", (store) => {
    const key = keyOf(userId, refId, field)
    const request = store.get(key)
    request.onsuccess = () => {
      if ((request.result as Copy | undefined)?.content === content) store.delete(key)
    }
  })

/** The user's copies for an entry. */
export const copiesOf = async (userId: string, refId: string): Promise<ReadonlyArray<Copy>> => {
  const copies: Array<Copy> = []
  await run("readonly", (store) => forEach(store, "ref", [userId, refId], (copy) => copies.push(copy)))
  return copies
}

/** The copies of an entry that's gone: deleted, or no longer the user's to open. */
export const dropCopiesOf = (userId: string, refId: string) =>
  run("readwrite", (store) => forEach(store, "ref", [userId, refId], (copy, s) => s.delete(copy.key)))

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
export const pruneCopies = (userId: string, now = Date.now()) =>
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
