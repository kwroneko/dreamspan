// Per-account Files quotas (spec/FILES-AND-ENVIRONMENT.md §1.2) and version retention (§1.3).
//
// Usage is the account's Files, its home folder for commands, its commands' kept output
// (files/commandOutput.ts) and the bytes its file versions hold. It is measured by walking both folders (no links followed, each inode once, a file's
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
import type { Stats } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
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
  /** Commands' kept output (a day, at most 200 per account). */
  readonly outputBytes: number
  readonly binBytes: number
  readonly versionsBytes: number
  readonly usedBytes: number
  readonly quotaBytes: number
  readonly measuredAt: number
  /** The walk was incomplete: some usage may be uncounted. */
  readonly partial: boolean
}

const PARTIAL_TEXT = (what: string) =>
  `Your files couldn't be fully counted. Check that the folders are accessible, or delete files and empty the bin to ${what} again.`

export class QuotaExceeded extends Error {
  override readonly name = "QuotaExceeded"
}

type Inode = Pick<Stats, "dev" | "ino">
const inodeKey = (info: Inode) => `${info.dev}:${info.ino}`

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
  /** Counted bytes by inode, shared by the trees of one walk. */
  seen = new Map<string, number>(),
  /** Active upload files have their own quota holds until they land. */
  skip?: (path: string) => boolean
) => {
  const deadline = Date.now() + maxMs
  let bytes = 0
  let entries = 0
  let partial = false
  const missing = (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") partial = true
    return null
  }
  const stack = [root]
  while (stack.length) {
    const path = stack.pop()!
    if (skip?.(path)) continue
    const info = await lstat(path, { bigint: false }).catch(missing)
    if (!info) continue
    const key = inodeKey(info)
    if (seen.has(key)) continue
    // Files and links by size; folders by the blocks their entries take.
    const size = info.isDirectory() ? info.blocks * 512 : soleOwnerOnly && info.nlink > 1 ? 0 : info.size
    seen.set(key, size)
    bytes += size
    if (++entries >= maxEntries || Date.now() > deadline) return { bytes, entries, partial: true }
    if (info.isDirectory()) {
      const names = await readdir(path).catch(missing)
      for (const name of names ?? []) stack.push(join(path, name))
    }
  }
  return { bytes, entries, partial }
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
  seen = new Map<string, number>(),
  items = true
) => {
  const deadline = Date.now() + maxMs
  let partial = false
  const missing = (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") partial = true
    return []
  }
  const holders = items ? await readdir(bin).catch(missing) : [""]
  let bytes = 0
  let entries = 0
  for (const holder of holders) {
    const folder = holder === "" ? bin : join(bin, holder)
    for (const name of await readdir(folder).catch(missing)) {
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
  return { bytes, partial }
}

export interface QuotaDeps {
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  /** The account's Files, home folder and bin on the host. */
  readonly folders: (userId: string) => {
    readonly filesRoot: string
    readonly home: string
    readonly bin?: string
    /** Where its commands' whole output is kept. */
    readonly output?: string
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
   * normally takes off exactly what each entry held when it began, so a give-back during a
   * walk and a write after it can't be subtracted twice or wiped.
   */
  const pending = new Map<string, Map<number, number>>()
  /** A staged upload or copy is accounted for only by its hold until it lands. */
  const stagingHolds = new Set<number>()
  const stagingNames = new Map<string, Set<string>>()
  /** Bytes app-side deletes and smaller replacements freed since the last measurement, by token. */
  const frees = new Map<string, Map<number, number>>()
  /** Uploads and copies that landed while the account's walk ran. */
  const landing = new Map<string, Map<number, { readonly inode: string; readonly reserved: number } | null>>()
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
      // Take off the bytes each entry held when the walk began, except for staged uploads and
      // copies. A landing upload is reconciled against what the walk saw of its inode. Frees
      // go the other way: they are applied before the removal, so a walk
      // that ends later either counted the file (clearing the free over-counts) or reached it
      // after (clearing is exact); keeping it could subtract bytes the walk never counted.
      const heldBefore = new Map(pending.get(userId))
      for (const id of heldBefore.keys()) if (stagingHolds.has(id)) heldBefore.delete(id)
      const landedDuring = new Map<number, { readonly inode: string; readonly reserved: number } | null>()
      landing.set(userId, landedDuring)
      const { filesRoot, home, bin, output } = deps.folders(userId)
      // Files and the bin share their inodes: a file deleted while linked elsewhere counts once.
      const seen = new Map<string, number>()
      const skipStaged = (path: string) => stagingNames.get(userId)?.has(basename(path)) === true
      const [files, homeUse, binUse, outputUse] = yield* Effect.promise(() =>
        Promise.all([
          measureTree(filesRoot, deps.walkMaxEntries, undefined, false, seen, skipStaged),
          measureTree(home, deps.walkMaxEntries),
          bin === undefined
            ? Promise.resolve({ bytes: 0, partial: false })
            : measureBin(bin, deps.walkMaxEntries, undefined, false, seen),
          output === undefined
            ? Promise.resolve({ bytes: 0, partial: false })
            : measureTree(output, deps.walkMaxEntries)
        ])
      )
      const versionsBytes = yield* deps.reader
        .FileVersionBytes({ userId: userId as never })
        .pipe(Effect.orElseSucceed(() => 0))
      const quotaBytes = yield* quotaOf(userId)
      const usage: Usage = {
        filesBytes: files.bytes,
        homeBytes: homeUse.bytes,
        outputBytes: outputUse.bytes,
        binBytes: binUse.bytes,
        versionsBytes,
        usedBytes: files.bytes + homeUse.bytes + outputUse.bytes + binUse.bytes + versionsBytes,
        quotaBytes,
        measuredAt: started,
        partial: files.partial || homeUse.partial || binUse.partial || outputUse.partial
      }
      landing.delete(userId)
      deps.afterRead?.(pending.get(userId))
      usages.set(userId, usage)
      const entries = pending.get(userId)
      const shrunk: Array<string> = []
      for (const [id, was] of heldBefore) {
        const now = entries?.get(id)
        if (now === undefined) continue
        // A renamed upload is handled below. A copy outside Files has no measured inode and
        // keeps its pending bytes until the next walk, which sees its database row.
        if (landedDuring.has(id)) continue
        // An entry only grows or goes, so a smaller one is a bug: say so, and take off what is
        // left of it rather than fail the call that asked for a figure.
        if (now < was) shrunk.push(`files quota: pending entry ${id} shrank from ${was} to ${now}`)
        if (now <= was) entries!.delete(id)
        else entries!.set(id, now - was)
      }
      for (const [id, upload] of landedDuring) {
        if (upload === null) continue
        // The walk may have seen the file at either name, while it was still growing, or
        // missed it across the rename. Retain only the reservation the walk didn't count.
        const remaining = upload.reserved - (seen.get(upload.inode) ?? 0)
        pending.get(userId)?.delete(id)
        if (remaining > 0) grow(userId, id, remaining)
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
      if (!now.partial && now.usedBytes + adding <= now.quotaBytes) return now
      if (now.partial || Date.now() - now.measuredAt > 60_000) {
        yield* measure(userId, true)
        now = yield* usage(userId)
      }
      // An incomplete walk can justify pressure retention only from bytes it actually saw.
      const counted = now.partial ? (usages.get(userId)?.usedBytes ?? 0) - total(frees.get(userId)) : now.usedBytes
      if (counted + adding > now.quotaBytes) {
        const trimmed = yield* prune(userId, Date.now() - PRESSURE_DAYS * DAY).pipe(Effect.orElseSucceed(() => 0))
        if (trimmed > 0) {
          yield* measure(userId, true)
          now = yield* usage(userId)
        }
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
  const hold = (userId: string, stage?: "outside-files" | { readonly temporaryName: string }) => {
    const id = nextId++
    if (stage !== undefined) stagingHolds.add(id)
    if (typeof stage === "object") {
      const names = stagingNames.get(userId) ?? new Set<string>()
      names.add(stage.temporaryName)
      stagingNames.set(userId, names)
    }
    const unstage = () => {
      stagingHolds.delete(id)
      if (typeof stage !== "object") return
      const names = stagingNames.get(userId)
      names?.delete(stage.temporaryName)
      if (names?.size === 0) stagingNames.delete(userId)
    }
    let released = false
    let reserved = 0
    return {
      reserve: (bytes: number, quotaBytes: number) => {
        if (released) return false
        const known = usages.get(userId)?.usedBytes ?? 0
        if (known + total(pending.get(userId)) - total(frees.get(userId)) + bytes > quotaBytes) return false
        reserved += bytes
        grow(userId, id, bytes)
        return true
      },
      /** The file is in place. Give the walk its inode to account for a read under either name. */
      landed: (file?: Inode) => {
        unstage()
        landing.get(userId)?.set(id, file === undefined ? null : { inode: inodeKey(file), reserved })
      },
      release: () => {
        released = true
        unstage()
        landing.get(userId)?.delete(id)
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
      yield* deps.writer.SetAccountFilesQuota({ userId: userId as never, bytes })
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
