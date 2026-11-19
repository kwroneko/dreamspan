// Per-account Files quotas (spec/FILES-AND-ENVIRONMENT.md §1.2) and version retention (§1.3).
//
// Usage is the account's Files, its home folder for commands and the bytes its file versions
// hold. It is measured by walking both folders (no links followed, each inode once, a file's
// own size: a sparse file counts its full size, and a compressing filesystem such as ZFS
// doesn't make files look smaller, nor do blocks it hasn't allocated yet) after each command, every 10
// minutes for accounts in use, and when nothing newer is known. App-side writes and uploads
// check before writing; commands can't be stopped mid-write without filesystem quotas, so they
// are checked before they start and measured after. Over the quota, versions older than 7 days
// are trimmed first; then new writes, uploads and commands are refused with how much to free.
// Reads and deleting still work.
//
// Retention: versions older than 30 days are removed every hour (the writer's
// PruneFileVersions, in batches); the media sweep removes their bytes later, outside any
// transaction.
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import type { Reader, Writer } from "../db/Database.ts"

/** Bytes from `10G`, `512M`, `2T`, `1.5G`, `1048576` (binary units); null when unreadable. */
export const parseByteSize = (text: string): number | null => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?\s*$/i.exec(text)
  if (!match) return null
  const power = ["", "K", "M", "G", "T"].indexOf(match[2]!.toUpperCase())
  const bytes = Math.floor(Number(match[1]) * 1024 ** power)
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null
}

/** The app setting holding admins' per-account quotas: `{ [userId]: bytes }`. */
const QUOTAS_SETTING = "files.quotas"
const Quotas = Schema.Record(Schema.String, Schema.Int)

const VERSION_DAYS = 30
/** Under quota pressure, versions older than this go first. */
const PRESSURE_DAYS = 7
const DAY = 86_400_000
const MEASURE_EVERY = 10 * 60_000
/** Accounts whose usage was asked for within this are measured again in the background. */
const ACTIVE_FOR = DAY
/** A walk's limits: an account with more than this many entries is counted as far as it got. */
const WALK_MAX_ENTRIES = 2_000_000
const WALK_MAX_MS = 60_000

export interface Usage {
  readonly filesBytes: number
  readonly homeBytes: number
  readonly binBytes: number
  readonly versionsBytes: number
  readonly usedBytes: number
  readonly quotaBytes: number
  readonly measuredAt: number
  /** The walk stopped at its limits: the real usage is higher. */
  readonly partial: boolean
}

const PARTIAL_TEXT = (what: string) =>
  `Your files are too many to count. Delete files you don't need and empty the bin to ${what} again.`

export class QuotaExceeded extends Error {
  override readonly name = "QuotaExceeded"
}

/**
 * Bytes under `root`, links not followed (a link counts itself), each inode once. Missing:
 * 0. Each folder is read by name below the one before, so a folder swapped for a link mid-walk
 * is seen as the link.
 */
export const measureTree = async (
  root: string,
  maxEntries = WALK_MAX_ENTRIES,
  maxMs = WALK_MAX_MS,
  /** Count only what deleting `root` would free for sure: a file with other links frees nothing. */
  soleOwnerOnly = false,
  /** Inodes already counted, shared by the trees of one walk: a file linked into two counts once. */
  seen = new Set<string>()
) => {
  const deadline = Date.now() + maxMs
  let bytes = 0
  let entries = 0
  const stack = [root]
  while (stack.length) {
    const path = stack.pop()!
    const info = await lstat(path, { bigint: false }).catch(() => null)
    if (!info) continue
    const key = `${info.dev}:${info.ino}`
    if (seen.has(key)) continue
    seen.add(key)
    // Files and links by size; folders by the blocks their entries take.
    bytes += info.isDirectory() ? info.blocks * 512 : soleOwnerOnly && info.nlink > 1 ? 0 : info.size
    if (++entries >= maxEntries || Date.now() > deadline) return { bytes, entries, partial: true }
    if (info.isDirectory()) {
      const names = await readdir(path).catch(() => [] as Array<string>)
      for (const name of names) stack.push(join(path, name))
    }
  }
  return { bytes, entries, partial: false }
}

/**
 * What the bin's items take (`<bin>/<itemId>/<name>`): each item's content, measured as
 * `measureTree` does, without the bin's own folders, which the app makes and removes itself and
 * which would otherwise make a delete look like it took space. `bin` may be a single item's folder
 * (`items: false`): then only its content.
 */
export const measureBin = async (
  bin: string,
  maxEntries = WALK_MAX_ENTRIES,
  maxMs = WALK_MAX_MS,
  soleOwnerOnly = false,
  seen = new Set<string>(),
  items = true
) => {
  const deadline = Date.now() + maxMs
  const holders = items ? await readdir(bin).catch(() => [] as Array<string>) : [""]
  let bytes = 0
  let entries = 0
  for (const holder of holders) {
    const folder = holder === "" ? bin : join(bin, holder)
    for (const name of await readdir(folder).catch(() => [] as Array<string>)) {
      const left = Math.max(1, maxEntries - entries)
      const measured = await measureTree(
        join(folder, name),
        left,
        Math.max(0, deadline - Date.now()),
        soleOwnerOnly,
        seen
      )
      bytes += measured.bytes
      entries += measured.entries
      if (measured.partial || entries >= maxEntries || Date.now() > deadline) return { bytes, partial: true }
    }
  }
  return { bytes, partial: false }
}

export interface QuotaDeps {
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  /** The account's Files, home folder and bin on the host. */
  readonly folders: (userId: string) => {
    readonly filesRoot: string
    readonly home: string
    readonly bin?: string
  }
  readonly defaultBytes: number
  /** A walk's entry limit; the default outside tests. */
  readonly walkMaxEntries?: number
  /** A test seam: called once a walk has read the folders, with the account's pending entries. */
  readonly afterRead?: (pending: Map<number, number> | undefined) => void
}

export const makeFilesQuota = (deps: QuotaDeps) => {
  const usages = new Map<string, Usage>()
  /**
   * Bytes app-side writes added since the last measurement, so checks between walks add up, as
   * entries: one for each streaming upload (it grows as chunks arrive and is given back whole),
   * and one per account for everything else (`wrote`). An entry only grows or is removed. A walk
   * takes off exactly what each entry held when it began, so a give-back during a walk and
   * a write after it can't be subtracted twice or wiped.
   */
  const pending = new Map<string, Map<number, number>>()
  /** Bytes app-side deletes and smaller replacements freed since the last measurement, by token. */
  const frees = new Map<string, Map<number, number>>()
  /** Uploads that landed (were renamed into place) while the account's walk ran. */
  const landing = new Map<string, Set<number>>()
  let nextId = 1
  const ambient = new Map<string, number>()
  const total = (entries: Map<number, number> | undefined) => {
    let sum = 0
    if (entries) for (const bytes of entries.values()) sum += bytes
    return sum
  }
  const grow = (userId: string, id: number, bytes: number) => {
    const entries = pending.get(userId) ?? new Map<number, number>()
    entries.set(id, (entries.get(id) ?? 0) + bytes)
    pending.set(userId, entries)
  }
  const asked = new Map<string, number>()
  const measuring = new Map<string, Promise<Usage>>()

  const quotaOf = (userId: string) =>
    deps.reader.GetAppSetting({ key: QUOTAS_SETTING }).pipe(
      Effect.map((raw) => {
        const quotas = Schema.decodeUnknownOption(Quotas)(raw ?? {})
        return quotas._tag === "Some" && quotas.value[userId] !== undefined ? quotas.value[userId] : deps.defaultBytes
      }),
      Effect.orElseSucceed(() => deps.defaultBytes)
    )

  const walk = (userId: string): Effect.Effect<Usage> =>
    Effect.gen(function* () {
      const started = Date.now()
      // What each entry held before this walk began may or may not be in what it reads, and is
      // taken off when the walk ends; what lands during the walk stays (over-counting at worst,
      // never missing it). Frees go the other way: they are applied before the removal, so a walk
      // that ends later either counted the file (clearing the free over-counts) or reached it
      // after (clearing is exact); keeping it could subtract bytes the walk never counted.
      const heldBefore = new Map(pending.get(userId))
      const landedDuring = new Set<number>()
      landing.set(userId, landedDuring)
      const { filesRoot, home, bin } = deps.folders(userId)
      // Files and the bin share their inodes: a file deleted while linked elsewhere counts once.
      const seen = new Set<string>()
      const [files, homeUse, binUse] = yield* Effect.promise(() =>
        Promise.all([
          measureTree(filesRoot, deps.walkMaxEntries, undefined, false, seen),
          measureTree(home, deps.walkMaxEntries),
          bin === undefined
            ? Promise.resolve({ bytes: 0, partial: false })
            : measureBin(bin, deps.walkMaxEntries, undefined, false, seen)
        ])
      )
      const versionsBytes = yield* deps.reader
        .FileVersionBytes({ userId: userId as never })
        .pipe(Effect.orElseSucceed(() => 0))
      const quotaBytes = yield* quotaOf(userId)
      const usage: Usage = {
        filesBytes: files.bytes,
        homeBytes: homeUse.bytes,
        binBytes: binUse.bytes,
        versionsBytes,
        usedBytes: files.bytes + homeUse.bytes + binUse.bytes + versionsBytes,
        quotaBytes,
        measuredAt: started,
        partial: files.partial || homeUse.partial || binUse.partial
      }
      landing.delete(userId)
      deps.afterRead?.(pending.get(userId))
      usages.set(userId, usage)
      const entries = pending.get(userId)
      const shrunk: Array<string> = []
      for (const [id, was] of heldBefore) {
        const now = entries?.get(id)
        if (now === undefined) continue
        // An upload renamed into place during the walk may have been listed as its temporary
        // name and gone before it was read: the walk may not hold it at all, so its entry stays
        // (over-counting until the next walk, never missing it).
        if (landedDuring.has(id)) continue
        // An entry only grows or goes, so a smaller one is a bug: say so, and take off what is
        // left of it rather than fail the call that asked for a figure.
        if (now < was) shrunk.push(`files quota: pending entry ${id} shrank from ${was} to ${now}`)
        if (now <= was) entries!.delete(id)
        else entries!.set(id, now - was)
      }
      frees.delete(userId)
      for (const warning of shrunk) yield* Effect.logWarning(warning)
      return usage
    })

  /**
   * Measures now; a measurement already running for the account is shared, unless
   * `startedAfterNow`: then it is waited out and one that began after this call answers
   * (a command's output must be in the walk that reports on it).
   */
  const measure = (userId: string, startedAfterNow = false): Effect.Effect<Usage> =>
    Effect.suspend(() => {
      const running = measuring.get(userId)
      if (running && startedAfterNow)
        return Effect.promise(() => running.catch(() => undefined)).pipe(Effect.andThen(measure(userId)))
      if (running) return Effect.promise(() => running)
      const promise = Effect.runPromise(walk(userId)).finally(() => measuring.delete(userId))
      measuring.set(userId, promise)
      return Effect.promise(() => promise)
    })

  /** The last measurement (with what app-side writes added since), or a new one when none is known. */
  const usage = (userId: string): Effect.Effect<Usage> =>
    Effect.gen(function* () {
      asked.set(userId, Date.now())
      const measured = usages.get(userId) ?? (yield* measure(userId))
      const quotaBytes = yield* quotaOf(userId)
      // Read together, with nothing between them: a walk ending in between would pair the new
      // figure with the old pending bytes (or the reverse).
      const known = usages.get(userId) ?? measured
      const extra = total(pending.get(userId)) - total(frees.get(userId))
      return { ...known, quotaBytes, usedBytes: Math.max(0, known.usedBytes + extra) }
    })

  const overText = (used: number, quota: number, what: string) =>
    `Your files use ${formatByteSize(used)} of ${formatByteSize(quota)}. Delete files you don't need and empty the bin to ${what} again.`

  /** Removes one account's versions made before `before`, in batches. */
  const prune = (userId: string | undefined, before: number) =>
    Effect.gen(function* () {
      let versions = 0
      for (;;) {
        const done = yield* deps.writer.PruneFileVersions({
          ...(userId === undefined ? {} : { userId: userId as never }),
          before,
          limit: 2000
        })
        versions += done.versions
        if (done.versions < 2000) return versions
      }
    })

  /**
   * Refuses (QuotaExceeded) when the account is over its quota, or would be after `adding`
   * bytes. Over it, versions older than 7 days are trimmed and usage measured again first.
   * `what` ends the message: "write files", "run commands", "upload".
   */
  const check = (userId: string, adding: number, what: string): Effect.Effect<Usage, QuotaExceeded> =>
    Effect.gen(function* () {
      let now = yield* usage(userId)
      // A walk that stopped at its limits counted only part of the files: what it didn't reach
      // could hold any amount (millions of empty files first, large ones after), so it isn't room.
      if (!now.partial && now.usedBytes + adding <= now.quotaBytes) return now
      const trimmed = yield* prune(userId, Date.now() - PRESSURE_DAYS * DAY).pipe(Effect.orElseSucceed(() => 0))
      if (trimmed > 0 || now.partial || Date.now() - now.measuredAt > 60_000) {
        yield* measure(userId)
        // With what landed while it walked, which its figure doesn't hold.
        now = yield* usage(userId)
      }
      if (now.partial) return yield* Effect.fail(new QuotaExceeded(PARTIAL_TEXT(what)))
      if (now.usedBytes + adding <= now.quotaBytes) return now
      return yield* Effect.fail(new QuotaExceeded(overText(now.usedBytes + adding, now.quotaBytes, what)))
    })

  /**
   * For a write that streams (an upload): one hold for the upload, taking `bytes` more of the
   * room as they arrive, so uploads running at once share it. `reserve` is false, taking
   * nothing, when they'd go past `quotaBytes`. What a hold took counts until the next
   * measurement, which sees the file itself. `release` (a write that didn't land) returns
   * exactly what the hold still counts, whatever walks came between.
   */
  const hold = (userId: string) => {
    const id = nextId++
    let released = false
    return {
      reserve: (bytes: number, quotaBytes: number) => {
        if (released) return false
        const known = usages.get(userId)?.usedBytes ?? 0
        if (known + total(pending.get(userId)) - total(frees.get(userId)) + bytes > quotaBytes) return false
        grow(userId, id, bytes)
        return true
      },
      /** The file is in place: a walk running now may not have seen it, so its entry stays. */
      landed: () => {
        landing.get(userId)?.add(id)
      },
      release: () => {
        released = true
        pending.get(userId)?.delete(id)
      }
    }
  }

  /** The refusal for a streaming write that ran out of room. */
  const overMessage = (used: number, quotaBytes: number, what: string) => overText(used, quotaBytes, what)

  /** An app-side write landed: its bytes count until the next measurement. */
  const wrote = (userId: string, bytes: number) => {
    if (bytes <= 0) return
    let id = ambient.get(userId)
    if (id === undefined) ambient.set(userId, (id = nextId++))
    grow(userId, id, bytes)
  }

  /**
   * An app-side delete or smaller replacement freed `bytes` for sure (the caller counts only
   * what nothing else still holds). It lowers the figure until the next measurement, which
   * sees the folder as it is. Apply it just before the file goes, and give it back with
   * `unfreed(token)` if the removal fails: a measurement that lands in between can then only
   * over-count, never subtract the same bytes twice; one that already ended took the free
   * off, and `unfreed` finds nothing to return.
   */
  const freed = (userId: string, bytes: number) => {
    if (bytes <= 0) return 0
    const id = nextId++
    const entries = frees.get(userId) ?? new Map<number, number>()
    entries.set(id, bytes)
    frees.set(userId, entries)
    return id
  }

  /** Takes back what `freed` lowered, for a removal that didn't happen. */
  const unfreed = (userId: string, token: number) => {
    frees.get(userId)?.delete(token)
  }

  /**
   * After a command: measured again. Returns the message when it left the account over its
   * quota, so the result can say so; null otherwise.
   */
  const afterCommand = (userId: string) =>
    measure(userId, true).pipe(
      Effect.andThen(usage(userId)),
      Effect.map((now) =>
        now.partial
          ? PARTIAL_TEXT("write files or run commands")
          : now.usedBytes > now.quotaBytes
            ? overText(now.usedBytes, now.quotaBytes, "write files or run commands")
            : null
      )
    )

  /** Every hour: versions past retention. Every 10 minutes: accounts in use, measured again. */
  const sweepVersions = Effect.suspend(() => prune(undefined, Date.now() - VERSION_DAYS * DAY))
  const remeasureActive = Effect.gen(function* () {
    const since = Date.now() - ACTIVE_FOR
    for (const [userId, at] of asked)
      if (at < since) {
        asked.delete(userId)
        usages.delete(userId)
      } else
        // One account's failure doesn't stop the others.
        yield* measure(userId).pipe(
          Effect.catchCause((cause) => Effect.logWarning(`measuring ${userId}'s Files usage failed`, cause))
        )
  })

  /** An admin's quota for one account; null returns it to the instance default. */
  const setQuota = (userId: string, bytes: number | null) =>
    Effect.gen(function* () {
      const raw = yield* deps.reader.GetAppSetting({ key: QUOTAS_SETTING })
      const decoded = Schema.decodeUnknownOption(Quotas)(raw ?? {})
      const quotas: Record<string, number> = { ...(decoded._tag === "Some" ? decoded.value : {}) }
      if (bytes === null) delete quotas[userId]
      else quotas[userId] = bytes
      yield* deps.writer.SetAppSetting({ key: QUOTAS_SETTING, value: quotas })
      return yield* usage(userId)
    })

  return {
    usage,
    measure,
    check,
    wrote,
    freed,
    unfreed,
    hold,
    overMessage,
    afterCommand,
    setQuota,
    sweepVersions,
    remeasureActive,
    intervals: { measureMs: MEASURE_EVERY, retentionMs: 60 * 60_000 }
  }
}

export type FilesQuota = ReturnType<typeof makeFilesQuota>
