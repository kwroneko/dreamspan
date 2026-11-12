// The card sources' cache (spec/CARD-SOURCES.md §4.1, §5.5): files under
// `DATA_DIR/cache/sources/`, never SQLite, so a search per keystroke never queues behind the
// one writer. An in-memory index, rebuilt by a scan at startup, keyed per user: one user's
// views never show in another's results. Bytes are content-addressed (sha256), so identical
// files are stored once; thumbnails made from them sit beside them (§14.5b's derivatives).
//
// Lifetimes: search pages 10 minutes after they were fetched; capabilities and tag
// suggestions 24 hours; opened cards, pictures and image keys 7 days after they were last
// used. A pinned entry (a draft exists, a tab shows it) outlives its age. Past the instance
// cap (1 GiB unless the admin sets another), the least recently used go first, unpinned
// before pinned.
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"

type CacheKind = "page" | "caps" | "tags" | "card" | "image" | "response"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** How long an entry lives, and whether it's counted from when it was fetched or last used. */
const LIFETIMES: Record<CacheKind, { readonly ms: number; readonly from: "created" | "used" }> = {
  page: { ms: 10 * MINUTE, from: "created" },
  caps: { ms: DAY, from: "created" },
  tags: { ms: DAY, from: "created" },
  card: { ms: 7 * DAY, from: "used" },
  image: { ms: 7 * DAY, from: "used" },
  response: { ms: 30 * DAY, from: "used" }
}
export const DEFAULT_CAP_BYTES = 1024 ** 3

export interface CacheKey {
  readonly user: string
  readonly source: string
  readonly kind: CacheKind
  readonly id: string
}

export interface CacheEntry {
  readonly key: CacheKey
  /** Small JSON values live in the entry itself; bytes in a blob. */
  readonly value: unknown
  readonly blob: string | null
  readonly blobSize: number
  readonly created: number
  used: number
}

const keyString = (key: CacheKey) => [key.user, key.source, key.kind, key.id].join("\u0000")
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")
const BLOB = /^[0-9a-f]{64}$/

/** A blob's path relative to the data folder, as the thumbnail workers take it. */
export const blobPath = (sha: string) => `cache/sources/blobs/${sha.slice(0, 2)}/${sha}`

export interface SourceCacheOptions {
  readonly dataDir: string
  readonly now?: () => number
  readonly capBytes?: () => number
}

export const makeSourceCache = (options: SourceCacheOptions) => {
  const now = options.now ?? Date.now
  const cap = options.capBytes ?? (() => DEFAULT_CAP_BYTES)
  const root = join(options.dataDir, "cache", "sources")
  const entriesDir = join(root, "entries")
  const blobsDir = join(root, "blobs")
  const index = new Map<string, CacheEntry>()
  /** How many entries name each blob, and the bytes of the blob with its derivatives. */
  const blobRefs = new Map<string, number>()
  const blobBytes = new Map<string, number>()
  const pins = new Map<string, number>()
  /** Entry files' own sizes, roughly: their JSON. */
  const entryBytes = new Map<string, number>()
  /** When an entry's file was last touched, so reads don't rewrite it each time. */
  const touched = new Map<string, number>()

  const entryFile = (k: string) => join(entriesDir, `${sha256(k)}.json`)

  const expired = (entry: CacheEntry, t = now()) => {
    const life = LIFETIMES[entry.key.kind]
    return t - (life.from === "created" ? entry.created : entry.used) > life.ms
  }

  const usedBytes = () => {
    let total = 0
    for (const size of blobBytes.values()) total += size
    for (const size of entryBytes.values()) total += size
    return total
  }

  const removeBlobFiles = async (sha: string) => {
    const dir = join(blobsDir, sha.slice(0, 2))
    const names = await readdir(dir).catch(() => [] as Array<string>)
    await Promise.all(names.filter((name) => name.startsWith(sha)).map((name) => rm(join(dir, name), { force: true })))
  }

  const release = async (sha: string | null) => {
    if (sha === null) return
    const count = (blobRefs.get(sha) ?? 1) - 1
    if (count > 0) {
      blobRefs.set(sha, count)
      return
    }
    blobRefs.delete(sha)
    blobBytes.delete(sha)
    await removeBlobFiles(sha)
  }

  const drop = async (k: string) => {
    const entry = index.get(k)
    if (!entry) return
    index.delete(k)
    entryBytes.delete(k)
    touched.delete(k)
    await rm(entryFile(k), { force: true })
    await release(entry.blob)
  }

  /** Entries the last `sweepKeeping` named (cards with unsaved edits): pinned until the next. */
  let keeping: ReadonlySet<string> = new Set()

  /** Expired unpinned entries go; then, past the cap, the least recently used, unpinned first. */
  const enforce = async () => {
    const t = now()
    const pinned = (k: string) => pins.has(k) || keeping.has(k)
    for (const [k, entry] of [...index]) if (!pinned(k) && expired(entry, t)) await drop(k)
    if (usedBytes() <= cap()) return
    const order = [...index].sort(([ka, a], [kb, b]) => Number(pinned(ka)) - Number(pinned(kb)) || a.used - b.used)
    for (const [k] of order) {
      if (usedBytes() <= cap()) break
      await drop(k)
    }
  }

  const writeAtomically = async (path: string, data: string | Uint8Array) => {
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, data)
    await rename(temp, path)
  }

  const storeBlob = async (bytes: Uint8Array) => {
    const sha = sha256(bytes)
    const dir = join(blobsDir, sha.slice(0, 2))
    await mkdir(dir, { recursive: true })
    const path = join(dir, sha)
    const present = await stat(path).then(
      () => true,
      () => false
    )
    if (!present) await writeAtomically(path, bytes)
    return sha
  }

  const get = (key: CacheKey) =>
    Effect.promise(async () => {
      const k = keyString(key)
      const entry = index.get(k)
      if (!entry) return null
      if (expired(entry) && !pins.has(k) && !keeping.has(k)) {
        await drop(k)
        return null
      }
      const t = now()
      entry.used = t
      // A day's resolution is enough for "7 days after last used" across a restart.
      if (t - (touched.get(k) ?? 0) > MINUTE) {
        touched.set(k, t)
        const seconds = t / 1000
        await utimes(entryFile(k), seconds, seconds).catch(() => undefined)
      }
      return entry
    })

  const put = (key: CacheKey, content: { readonly value?: unknown; readonly bytes?: Uint8Array }) =>
    Effect.promise(async () => {
      const k = keyString(key)
      const t = now()
      const blob = content.bytes === undefined ? null : await storeBlob(content.bytes)
      const entry: CacheEntry = {
        key,
        value: content.value ?? null,
        blob,
        blobSize: content.bytes?.byteLength ?? 0,
        created: t,
        used: t
      }
      const json = JSON.stringify(entry)
      await mkdir(entriesDir, { recursive: true })
      await writeAtomically(entryFile(k), json)
      const previous = index.get(k)
      index.set(k, entry)
      entryBytes.set(k, json.length)
      touched.set(k, t)
      if (blob !== null) {
        blobRefs.set(blob, (blobRefs.get(blob) ?? 0) + 1)
        if (!blobBytes.has(blob)) blobBytes.set(blob, entry.blobSize)
      }
      if (previous) await release(previous.blob)
      await enforce()
      return entry
    })

  const readBlob = (sha: string) => Effect.promise(() => readFile(join(options.dataDir, blobPath(sha))))

  /** A thumbnail was made beside a blob: it counts towards the cap with it. */
  const noteDerivative = (sha: string, path: string) =>
    Effect.promise(async () => {
      const size = await stat(join(options.dataDir, path)).then(
        (s) => s.size,
        () => 0
      )
      if (blobBytes.has(sha)) blobBytes.set(sha, blobBytes.get(sha)! + size)
    })

  /** Keeps an entry past its age while held; the returned effect lets go. */
  const pin = (key: CacheKey) => {
    const k = keyString(key)
    pins.set(k, (pins.get(k) ?? 0) + 1)
    return Effect.sync(() => {
      const count = (pins.get(k) ?? 1) - 1
      if (count > 0) pins.set(k, count)
      else pins.delete(k)
    })
  }

  const clearUser = (user: string, source: string | null) =>
    Effect.promise(async () => {
      for (const [k, entry] of [...index])
        if (entry.key.user === user && (source === null || entry.key.source === source)) await drop(k)
    })

  /** Rebuilds the index from the entry files, and removes blobs no entry names and stray temporary files. */
  const rebuild = async () => {
    await mkdir(entriesDir, { recursive: true })
    await mkdir(blobsDir, { recursive: true })
    for (const name of await readdir(entriesDir)) {
      const path = join(entriesDir, name)
      if (!name.endsWith(".json")) {
        await rm(path, { force: true })
        continue
      }
      try {
        const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)])
        const entry = JSON.parse(text) as CacheEntry
        const k = keyString(entry.key)
        if (`${sha256(k)}.json` !== name || (entry.blob !== null && !BLOB.test(entry.blob))) throw new Error()
        entry.used = Math.max(entry.used, info.mtimeMs)
        index.set(k, entry)
        entryBytes.set(k, text.length)
        if (entry.blob !== null) {
          blobRefs.set(entry.blob, (blobRefs.get(entry.blob) ?? 0) + 1)
          blobBytes.set(entry.blob, entry.blobSize)
        }
      } catch {
        await rm(path, { force: true })
      }
    }
    for (const prefix of await readdir(blobsDir)) {
      const dir = join(blobsDir, prefix)
      for (const name of await readdir(dir).catch(() => [] as Array<string>)) {
        const sha = name.slice(0, 64)
        if (!BLOB.test(sha) || !blobRefs.has(sha)) await unlink(join(dir, name)).catch(() => undefined)
        else if (name !== sha && !name.endsWith(".tmp"))
          blobBytes.set(sha, (blobBytes.get(sha) ?? 0) + (await stat(join(dir, name))).size)
        else if (name.endsWith(".tmp")) await unlink(join(dir, name)).catch(() => undefined)
      }
    }
  }
  const scan = Effect.promise(async () => {
    await rebuild()
    await enforce()
  })

  /** A sweep that keeps `keys` as if pinned, and keeps them so until the next such sweep. */
  const sweepKeeping = (keys: ReadonlyArray<CacheKey>) =>
    Effect.promise(() => {
      keeping = new Set(keys.map(keyString))
      return enforce()
    })

  return {
    get,
    put,
    readBlob,
    remove: (key: CacheKey) => Effect.promise(() => drop(keyString(key))),
    noteDerivative,
    pin,
    clearUser,
    scan,
    /** The index rebuilt as `scan` does, with no sweep: the caller sweeps, keeping what it must. */
    load: Effect.promise(rebuild),
    sweep: Effect.promise(() => enforce()),
    sweepKeeping,
    usedBytes,
    size: () => index.size,
    has: (key: CacheKey) => index.has(keyString(key))
  }
}

export type SourceCache = ReturnType<typeof makeSourceCache>
