// The last resort for text typed and not yet on the server: a copy in this browser
// (IndexedDB), written as the user types and removed once the server has the text. A page
// that closes before its save and its keepalive request (capped at 64 KB) leaves the copy,
// and the editor brings it back on the next open. Anything failing here only loses the copy.

const DATABASE = "rp-editor"
const STORE = "unsaved"

interface Entry {
  readonly key: string
  readonly refId: string
  readonly field: string
  readonly content: string
}

let opened: Promise<IDBDatabase | null> | null = null

const database = () => {
  opened ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: "key" }).createIndex("refId", "refId")
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return opened
}

const keyOf = (refId: string, field: string) => `${refId}\n${field}`

const run = async (mode: IDBTransactionMode, apply: (store: IDBObjectStore) => void) => {
  const db = await database()
  if (db === null) return
  try {
    apply(db.transaction(STORE, mode).objectStore(STORE))
  } catch {
    // Storage full or unavailable: the copy is lost, the server save still goes ahead.
  }
}

export const keepCopy = (refId: string, field: string, content: string) =>
  run("readwrite", (store) => store.put({ key: keyOf(refId, field), refId, field, content } satisfies Entry))

/** Drops the copy once the server holds `content` (a newer copy stays). */
export const dropCopy = (refId: string, field: string, content: string | null) =>
  run("readwrite", (store) => {
    const key = keyOf(refId, field)
    const request = store.get(key)
    request.onsuccess = () => {
      const entry = request.result as Entry | undefined
      if (entry && (content === null || entry.content === content)) store.delete(key)
    }
  })

export const copiesOf = async (refId: string): Promise<ReadonlyArray<Entry>> => {
  const db = await database()
  if (db === null) return []
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE).objectStore(STORE).index("refId").getAll(refId)
      request.onsuccess = () => resolve(request.result as Array<Entry>)
      request.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}
