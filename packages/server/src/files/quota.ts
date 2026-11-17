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
import { formatByteSize } from "@rp/shared/byteSize.ts"
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
  readonly versionsBytes: number
  readonly usedBytes: number
  readonly quotaBytes: number
  readonly measuredAt: number
  /** The walk stopped at its limits: the real usage is higher. */
  readonly partial: boolean
}

export class QuotaExceeded extends Error {
  override readonly name = "QuotaExceeded"
}

/**
 * Bytes under `root`, links not followed (a link counts itself), each inode once. Missing:
 * 0. Each folder is read by name below the one before, so a folder swapped for a link mid-walk
 * is seen as the link.
 */
export const measureTree = async (root: string, maxEntries = WALK_MAX_ENTRIES, maxMs = WALK_MAX_MS) => {
  const seen = new Set<string>()
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
    bytes += info.isDirectory() ? info.blocks * 512 : info.size
    if (++entries >= maxEntries || Date.now() > deadline) return { bytes, partial: true }
    if (info.isDirectory()) {
      const names = await readdir(path).catch(() => [] as Array<string>)
      for (const name of names) stack.push(join(path, name))
    }
  }
  return { bytes, partial: false }
}

export interface QuotaDeps {
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  /** The account's Files and home folder on the host. */
  readonly folders: (userId: string) => { readonly filesRoot: string; readonly home: string }
  readonly defaultBytes: number
}

export const makeFilesQuota = (deps: QuotaDeps) => {
  const usages = new Map<string, Usage>()
  /** Bytes app-side writes added since the last measurement, so checks between walks add up. */
  const added = new Map<string, number>()
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
      const { filesRoot, home } = deps.folders(userId)
      const [files, homeUse] = yield* Effect.promise(() => Promise.all([measureTree(filesRoot), measureTree(home)]))
      const versionsBytes = yield* deps.reader
        .FileVersionBytes({ userId: userId as never })
        .pipe(Effect.orElseSucceed(() => 0))
      const quotaBytes = yield* quotaOf(userId)
      const usage: Usage = {
        filesBytes: files.bytes,
        homeBytes: homeUse.bytes,
        versionsBytes,
        usedBytes: files.bytes + homeUse.bytes + versionsBytes,
        quotaBytes,
        measuredAt: started,
        partial: files.partial || homeUse.partial
      }
      usages.set(userId, usage)
      added.delete(userId)
      return usage
    })

  /** Measures now; a measurement already running for the account is shared. */
  const measure = (userId: string): Effect.Effect<Usage> =>
    Effect.suspend(() => {
      const running = measuring.get(userId)
      if (running) return Effect.promise(() => running)
      const promise = Effect.runPromise(walk(userId)).finally(() => measuring.delete(userId))
      measuring.set(userId, promise)
      return Effect.promise(() => promise)
    })

  /** The last measurement (with what app-side writes added since), or a new one when none is known. */
  const usage = (userId: string): Effect.Effect<Usage> =>
    Effect.gen(function* () {
      asked.set(userId, Date.now())
      const known = usages.get(userId) ?? (yield* measure(userId))
      const quotaBytes = yield* quotaOf(userId)
      const extra = added.get(userId) ?? 0
      return { ...known, quotaBytes, usedBytes: known.usedBytes + extra }
    })

  const overText = (used: number, quota: number, what: string) =>
    `Your files use ${formatByteSize(used)} of ${formatByteSize(quota)}. Delete files you don't need to ${what} again.`

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
      if (now.usedBytes + adding <= now.quotaBytes) return now
      const trimmed = yield* prune(userId, Date.now() - PRESSURE_DAYS * DAY).pipe(Effect.orElseSucceed(() => 0))
      if (trimmed > 0 || Date.now() - now.measuredAt > 60_000) now = yield* measure(userId)
      if (now.usedBytes + adding <= now.quotaBytes) return now
      return yield* Effect.fail(new QuotaExceeded(overText(now.usedBytes + adding, now.quotaBytes, what)))
    })

  /**
   * For a write that streams (an upload): takes `bytes` more of the room as they arrive, so
   * uploads running at once share it. False, taking nothing, when they'd go past `quotaBytes`.
   * What was taken counts until the next measurement, which sees the file itself.
   */
  const reserve = (userId: string, bytes: number, quotaBytes: number) => {
    const known = usages.get(userId)?.usedBytes ?? 0
    const extra = added.get(userId) ?? 0
    if (known + extra + bytes > quotaBytes) return false
    added.set(userId, extra + bytes)
    return true
  }

  /** Gives back what `reserve` took for a write that didn't land. */
  const release = (userId: string, bytes: number) => {
    const extra = added.get(userId)
    if (extra !== undefined) added.set(userId, Math.max(0, extra - bytes))
  }

  /** The refusal for a streaming write that ran out of room. */
  const overMessage = (used: number, quotaBytes: number, what: string) => overText(used, quotaBytes, what)

  /** An app-side write landed: its bytes count until the next measurement. */
  const wrote = (userId: string, bytes: number) => {
    if (bytes > 0) added.set(userId, (added.get(userId) ?? 0) + bytes)
  }

  /**
   * After a command: measured again. Returns the message when it left the account over its
   * quota, so the result can say so; null otherwise.
   */
  const afterCommand = (userId: string) =>
    measure(userId).pipe(
      Effect.map((now) =>
        now.usedBytes > now.quotaBytes ? overText(now.usedBytes, now.quotaBytes, "write files or run commands") : null
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
      } else yield* measure(userId)
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
    reserve,
    release,
    overMessage,
    afterCommand,
    setQuota,
    sweepVersions,
    remeasureActive,
    intervals: { measureMs: MEASURE_EVERY, retentionMs: 60 * 60_000 }
  }
}

export type FilesQuota = ReturnType<typeof makeFilesQuota>
