// The part of IndexedDB the client's pending copies use (client features/editor/backup.ts),
// in memory, for the draft protocol's model test. Requests complete asynchronously as in a
// browser, and each transaction reports what it put and deleted when it completes, so the
// test can check every deletion of a copy against the copy rule (ARCHITECTURE §3.10).

type Value = Record<string, unknown> & { readonly key: string }
type KeyPath = string | ReadonlyArray<string>

export interface Completed {
  readonly put: ReadonlyArray<Value>
  /** What each deletion removed (only deletions that found something). */
  readonly deleted: ReadonlyArray<Value>
}

const keyOf = (value: Value, path: KeyPath): unknown =>
  typeof path === "string" ? value[path] : path.map((part) => value[part])

const sameKey = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

class Request<A> {
  result: A | null = null
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  onupgradeneeded: (() => void) | null = null
}

class Transaction {
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  private open = 0
  readonly put: Array<Value> = []
  readonly deleted: Array<Value> = []
  private readonly store: ObjectStore
  private readonly db: FakeIndexedDb

  constructor(db: FakeIndexedDb, rows: Map<string, Value>) {
    this.db = db
    this.store = new ObjectStore(this, rows)
    db.pending++
    // A transaction completes once its requests have, after the code that made them.
    this.begin()
    setImmediate(() => this.end())
  }

  objectStore() {
    return this.store
  }

  begin() {
    this.open++
  }

  end() {
    if (--this.open > 0) return
    setImmediate(() => {
      this.db.pending--
      this.db.completed({ put: this.put, deleted: this.deleted })
      this.oncomplete?.()
    })
  }
}

class Cursor {
  readonly value: Value
  private readonly step: () => void
  private readonly remove: () => void

  constructor(value: Value, step: () => void, remove: () => void) {
    this.value = value
    this.step = step
    this.remove = remove
  }
  continue() {
    this.step()
  }
  delete() {
    this.remove()
  }
}

class ObjectStore {
  private readonly transaction: Transaction
  private readonly rows: Map<string, Value>

  constructor(transaction: Transaction, rows: Map<string, Value>) {
    this.transaction = transaction
    this.rows = rows
  }

  createIndex() {}

  put(value: Value) {
    const copy = structuredClone(value)
    this.rows.set(copy.key, copy)
    this.transaction.put.push(copy)
  }

  delete(key: string) {
    const value = this.rows.get(key)
    if (value === undefined) return
    this.rows.delete(key)
    this.transaction.deleted.push(value)
  }

  index(name: string) {
    const path = INDEXES.get(name)
    if (path === undefined) throw new Error(`no index ${name}`)
    return { openCursor: (query: unknown) => this.cursor(path, query) }
  }

  openCursor(query: unknown) {
    return this.cursor(null, query)
  }

  /** Walks the matching rows in key order, one step per `continue`, as a browser does. */
  private cursor(path: KeyPath | null, query: unknown) {
    const request = new Request<Cursor>()
    const keys = [...this.rows.values()]
      .filter((row) => query === null || query === undefined || (path !== null && sameKey(keyOf(row, path), query)))
      .map((row) => row.key)
      .sort()
    let at = 0
    this.transaction.begin()
    const next = () => {
      queueMicrotask(() => {
        while (at < keys.length && !this.rows.has(keys[at]!)) at++
        if (at >= keys.length) {
          request.result = null
          request.onsuccess?.()
          this.transaction.end()
          return
        }
        const key = keys[at++]!
        let stepped = false
        request.result = new Cursor(
          this.rows.get(key)!,
          () => {
            stepped = true
            next()
          },
          () => this.delete(key)
        )
        request.onsuccess?.()
        if (!stepped) this.transaction.end()
      })
    }
    next()
    return request
  }
}

/** The indexes backup.ts creates, by name; the fake keeps one database. */
const INDEXES = new Map<string, KeyPath>([
  ["userId", "userId"],
  ["ref", ["userId", "refId"]]
])

export class FakeIndexedDb {
  private readonly rows = new Map<string, Value>()
  private opened = false
  /** Transactions not complete yet. */
  pending = 0
  /** Called as each transaction completes. */
  onComplete: (completed: Completed) => void = () => undefined

  get busy() {
    return this.pending > 0
  }

  open() {
    const request = new Request<unknown>()
    setImmediate(() => {
      const db = {
        createObjectStore: () => new ObjectStore(undefined as never, this.rows),
        transaction: () => new Transaction(this, this.rows)
      }
      request.result = db
      if (!this.opened) {
        this.opened = true
        request.onupgradeneeded?.()
      }
      request.onsuccess?.()
    })
    return request
  }

  completed(completed: Completed) {
    this.onComplete(completed)
  }

  values(): ReadonlyArray<Value> {
    return [...this.rows.values()]
  }

  clear() {
    this.rows.clear()
  }
}
