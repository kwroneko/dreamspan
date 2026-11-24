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

export const draftBaseKey = (
  user: string,
  { sourceId, remoteId }: { sourceId: string; remoteId: string }
): CacheKey => ({
  user,
  source: sourceId,
  kind: "card",
  id: remoteId
})

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

const missingFile = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"

const serializeByKey = () => {
  const pending = new Map<string, Promise<unknown>>()
  return async <A>(key: string, work: () => Promise<A>): Promise<A> => {
    const operation = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
    pending.set(key, operation)
    try {
      return await operation
    } finally {
      if (pending.get(key) === operation) pending.delete(key)
    }
  }
}

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
  const derivativeBytes = new Map<string, Map<string, number>>()
  const pins = new Map<string, number>()
  /** Entry files' own sizes, roughly: their JSON. */
  const entryBytes = new Map<string, number>()
  /** When an entry's file was last touched, so reads don't rewrite it each time. */
  const touched = new Map<string, number>()
  const withEntry = serializeByKey()
  const withBlob = serializeByKey()

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
    await withBlob(sha, async () => {
      const count = (blobRefs.get(sha) ?? 1) - 1
      if (count > 0) {
        blobRefs.set(sha, count)
        return
      }
      blobRefs.delete(sha)
      blobBytes.delete(sha)
      derivativeBytes.delete(sha)
      await removeBlobFiles(sha)
    })
  }

  const drop = (k: string, expected?: CacheEntry) =>
    withEntry(k, async () => {
      const entry = index.get(k)
      if (!entry || (expected && entry !== expected)) return
      await rm(entryFile(k), { force: true })
      index.delete(k)
      entryBytes.delete(k)
      touched.delete(k)
      await release(entry.blob)
    })

  /** Active drafts from the last sweep, plus saves the sweep may not have seen yet. */
  let keeping = new Set<string>()
  const recentDrafts = new Map<string, number>()
  let sequence = 0
  let lastSweep = 0
  const pinned = (k: string) => pins.has(k) || keeping.has(k) || recentDrafts.has(k)

  /** Expired unpinned entries go; then, past the cap, the least recently used, unpinned first. */
  const enforce = async () => {
    const t = now()
    for (const [k, entry] of [...index]) if (!pinned(k) && expired(entry, t)) await drop(k, entry)
    if (usedBytes() <= cap()) return
    const order = [...index].sort(([, a], [, b]) => a.used - b.used)
    for (const [k, entry] of order) {
      if (usedBytes() <= cap()) return
      if (!pinned(k)) await drop(k, entry)
    }
    // Pinned entries still count toward the hard cap.
    for (const [k, entry] of order) {
      if (usedBytes() <= cap()) return
      await drop(k, entry)
    }
  }

  const writeAtomically = async (path: string, data: string | Uint8Array) => {
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, data)
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  /** Reserve a reference before publishing the entry so eviction cannot remove the bytes. */
  const retainBlob = async (bytes: Uint8Array) => {
    const sha = sha256(bytes)
    await withBlob(sha, async () => {
      const dir = join(blobsDir, sha.slice(0, 2))
      await mkdir(dir, { recursive: true })
      const path = join(dir, sha)
      try {
        await stat(path)
      } catch (error) {
        if (!missingFile(error)) throw error
        await writeAtomically(path, bytes)
      }
      blobRefs.set(sha, (blobRefs.get(sha) ?? 0) + 1)
      if (!blobBytes.has(sha)) blobBytes.set(sha, bytes.byteLength)
    })
    return sha
  }

  const get = (key: CacheKey) =>
    Effect.promise(async () => {
      const k = keyString(key)
      const entry = index.get(k)
      if (!entry) return null
      if (expired(entry) && !pinned(k)) {
        await drop(k, entry)
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
      const entry = await withEntry(k, async () => {
        const t = now()
        const blob = content.bytes === undefined ? null : await retainBlob(content.bytes)
        const entry: CacheEntry = {
          key,
          value: content.value ?? null,
          blob,
          blobSize: content.bytes?.byteLength ?? 0,
          created: t,
          used: t
        }
        try {
          const json = JSON.stringify(entry)
          await mkdir(entriesDir, { recursive: true })
          await writeAtomically(entryFile(k), json)
          entryBytes.set(k, json.length)
        } catch (error) {
          await release(blob)
          throw error
        }
        const previous = index.get(k)
        index.set(k, entry)
        touched.set(k, t)
        if (previous) await release(previous.blob)
        return entry
      })
      await enforce()
      return entry
    })

  const readBlob = (sha: string) =>
    Effect.promise(async () => {
      try {
        return await readFile(join(options.dataDir, blobPath(sha)))
      } catch (error) {
        if (missingFile(error)) return null
        throw error
      }
    })

  /** A format worker can create sibling files while the entry itself is being evicted. */
  const withBlobFile = <A, E, R>(sha: string, use: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.promise(() =>
        withBlob(sha, async () => {
          const count = blobRefs.get(sha)
          if (count === undefined) return false
          blobRefs.set(sha, count + 1)
          return true
        })
      ),
      (retained) => (retained ? use : Effect.succeed(null)),
      (retained) => Effect.promise(() => (retained ? release(sha) : Promise.resolve()))
    )

  const getBlob = (key: CacheKey) =>
    Effect.gen(function* () {
      const entry = yield* get(key)
      if (!entry?.blob) return null
      const bytes = yield* readBlob(entry.blob)
      if (bytes !== null) return { entry, bytes }
      yield* Effect.promise(() => drop(keyString(key), entry))
      return null
    })

  const countDerivative = (sha: string, path: string, size: number) => {
    const total = blobBytes.get(sha)
    if (total === undefined) return
    const files = derivativeBytes.get(sha) ?? new Map<string, number>()
    const previous = files.get(path) ?? 0
    if (size === 0) files.delete(path)
    else files.set(path, size)
    if (files.size === 0) derivativeBytes.delete(sha)
    else derivativeBytes.set(sha, files)
    blobBytes.set(sha, total + size - previous)
  }

  /** A thumbnail was made beside a blob: it counts towards the cap with it. */
  const noteDerivative = (sha: string, path: string) =>
    Effect.promise(() =>
      withBlob(sha, async () => {
        const fullPath = join(options.dataDir, path)
        const size = await stat(fullPath).then(
          (s) => s.size,
          () => 0
        )
        countDerivative(sha, fullPath, size)
      })
    )

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

  /** Hold bases during a draft write, then keep those whose drafts became or stayed active. */
  const withDraftBases = <A, E, R>(
    keys: ReadonlyArray<CacheKey | undefined>,
    save: Effect.Effect<A, E, R>,
    active: (result: A, index: number) => boolean
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => keys.flatMap((key) => (key === undefined ? [] : [pin(key)]))),
      () =>
        Effect.tap(save, (result) =>
          Effect.sync(() => {
            keys.forEach((key, index) => {
              if (key && active(result, index)) recentDrafts.set(keyString(key), ++sequence)
            })
          })
        ),
      (releases) => Effect.forEach(releases, (release) => release, { discard: true })
    ).pipe(Effect.uninterruptible)

  const clearUser = (user: string, source: string | null) =>
    Effect.promise(async () => {
      for (const [k, entry] of [...index])
        if (entry.key.user === user && (source === null || entry.key.source === source)) await drop(k, entry)
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
        else if (name !== sha && !name.endsWith(".tmp")) {
          const path = join(dir, name)
          countDerivative(sha, path, (await stat(path)).size)
        } else if (name.endsWith(".tmp")) await unlink(join(dir, name)).catch(() => undefined)
      }
    }
  }
  const scan = Effect.promise(async () => {
    await rebuild()
    await enforce()
  })

  /** Reconcile draft pins from the database, keeping saves made while the read was in flight. */
  const sweepKeeping = <E, R>(read: Effect.Effect<ReadonlyArray<CacheKey>, E, R>) =>
    Effect.gen(function* () {
      const started = ++sequence
      const keys = yield* read
      if (started < lastSweep) return
      lastSweep = started
      keeping = new Set(keys.map(keyString))
      for (const [key, saved] of recentDrafts) if (saved < started) recentDrafts.delete(key)
      yield* Effect.promise(enforce)
    })

  return {
    get,
    getBlob,
    // Preview reads must not refresh timestamps, evict, or write anything, even on a miss.
    peek: (key: CacheKey) => Effect.sync(() => index.get(keyString(key)) ?? null),
    put,
    readBlob,
    withBlobFile,
    remove: (key: CacheKey, expected: CacheEntry) => Effect.promise(() => drop(keyString(key), expected)),
    noteDerivative,
    pin,
    withDraftBases,
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
