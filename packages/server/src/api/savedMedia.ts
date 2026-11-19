// Saved card media (spec/SAVED-MEDIA.md) on the main thread: the task that lists queued
// revisions' media (in a reader worker) and downloads approved addresses between writer
// transactions, never inside one; the RPCs; and `GET /media/saved/<id>`. The fetcher is the
// external media one, with the saved types, the approved sites checked on every hop.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { CurrentUser } from "@dreamspan/shared/api.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { makeRegistry } from "@dreamspan/shared/registry.ts"
import { hostApproved, isHostName, normalizeHost, SavedMediaApi } from "@dreamspan/shared/savedMedia.ts"
import { Context, Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Accounts } from "../auth/Accounts.ts"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import type { SavedMediaDownload } from "../db/ops.ts"
import { isMediaPath } from "../db/media.ts"
import { MediaHolds } from "../importer/MediaHolds.ts"
import { storeMedia } from "../importer/mediaFiles.ts"
import { ExternalMediaRefused, makeExternalFetcher, SAVED_MEDIA_TYPES } from "../net/externalMedia.ts"
import { Network, RedirectRefused } from "../net/Network.ts"
import { internal } from "./internal.ts"

const MiB = 1024 * 1024
/** Per entry revision: what its downloads may take together (§3.3). */
const REVISION_BYTES = 128 * MiB
const REVISION_MS = 3 * 60_000
const SERVER_DOWNLOADS = 4
const USER_DOWNLOADS = 2
const IDLE_MS = 3_000

type SavedMediaFetch = ReturnType<typeof makeExternalFetcher>
export const makeSavedMediaFetcher = (
  network: Parameters<typeof makeExternalFetcher>[0],
  limits: Parameters<typeof makeExternalFetcher>[1] = {}
) =>
  makeExternalFetcher(network, {
    types: SAVED_MEDIA_TYPES,
    declaredType: false,
    maxBytes: 16 * MiB,
    maxBytesFor: (mime) => (mime.startsWith("font/") ? 4 * MiB : 16 * MiB),
    ...limits
  })

/** Why a download failed, as the entry's Saved media section says it. */
const failureReason = (error: unknown): string => {
  if (error instanceof RedirectRefused) return "It moved to a site you haven't approved."
  if (!(error instanceof ExternalMediaRefused)) return "The site couldn't be reached."
  const message = error.message
  if (message.startsWith("It moved") || message.startsWith("This entry")) return message
  if (/not public|Only public/.test(message)) return "Its address isn't a public web address."
  if (/too large|size limit/.test(message)) return "The file is too large."
  if (/too long/.test(message)) return "The site took too long to answer."
  if (/did not return/.test(message)) return "The site didn't send a file."
  return "It isn't an image, sound, video or font this app keeps."
}

interface SavedMediaShape {
  /** The download transport, replaceable or disableable (`media.saved`). */
  readonly fetchers: ReturnType<typeof makeRegistry<{ readonly id: string; readonly fetch: SavedMediaFetch }>>
  /** Lists queued revisions' media now: these refs' heads, or the user's whole queue. */
  readonly scan: (userId: UserId, refIds: ReadonlyArray<RefId> | null) => Effect.Effect<void, unknown>
  /** Wakes the task: new approvals or retries. */
  readonly kick: () => void
  /** Every queued scan listed and every download finished (tests). */
  readonly settle: Effect.Effect<void, unknown>
}

export class SavedMedia extends Context.Service<SavedMedia, SavedMediaShape>()("rp/SavedMedia") {
  static readonly layer = Layer.effect(
    SavedMedia,
    Effect.gen(function* () {
      const reader = yield* Reader
      const writer = yield* Writer
      const network = yield* Network
      const config = yield* AppConfig
      const holds = yield* MediaHolds
      const scope = yield* Effect.scope
      const fetchers = makeRegistry([{ id: "media.saved", fetch: makeSavedMediaFetcher(network) }])
      const active = new Set<number>()
      const perUser = new Map<string, number>()
      const budgets = new Map<string, { bytes: number; ms: number }>()
      let wake: (() => void) | null = null
      const kick = () => {
        const resume = wake
        wake = null
        resume?.()
      }

      const scanRound = (userId: UserId | null, refIds: ReadonlyArray<RefId> | null) =>
        Effect.gen(function* () {
          const scans = yield* reader.ReadSavedMediaScans({ userId, refIds, limit: 100 })
          if (scans.length === 0) return false
          yield* writer.RecordSavedMediaScans({ scans, at: Date.now() })
          return true
        })
      const scan = (userId: UserId, refIds: ReadonlyArray<RefId> | null) =>
        Effect.gen(function* () {
          for (let round = 0; round < 100 && (yield* scanRound(userId, refIds)); round++);
          kick()
        })

      const budgetOf = (download: SavedMediaDownload) => {
        const key = download.revisionId ?? `media:${download.id}`
        let budget = budgets.get(key)
        if (!budget) {
          if (budgets.size >= 2000) budgets.delete(budgets.keys().next().value!)
          budgets.set(key, (budget = { bytes: 0, ms: 0 }))
        }
        return budget
      }
      const record = (id: number, outcome: { saved?: { sha256: string; mime: string; byteSize: number } } | string) =>
        writer.RecordSavedMediaResult({
          id,
          at: Date.now(),
          saved: typeof outcome === "string" ? null : (outcome.saved ?? null),
          failure: typeof outcome === "string" ? outcome : null
        })

      const download = (item: SavedMediaDownload) =>
        Effect.gen(function* () {
          const budget = budgetOf(item)
          if (budget.bytes >= REVISION_BYTES || budget.ms >= REVISION_MS)
            return yield* record(item.id, "This entry's media limit was reached.")
          // Approved by the account's list, or for these files only (that host alone).
          const allowHost = async (host: string) => {
            const hosts = await Effect.runPromise(reader.GetMediaHosts({ userId: item.ownerUserId }))
            return hostApproved(hosts, host) || (item.once && normalizeHost(host) === item.host)
          }
          if (!(yield* Effect.tryPromise(() => allowHost(item.host))))
            return yield* record(item.id, "Its site isn't approved any more.")
          const fetcher = fetchers.get("media.saved")
          if (!fetcher) return yield* record(item.id, "Saving media is turned off.")
          const started = Date.now()
          const result = yield* Effect.acquireUseRelease(
            Effect.tryPromise({
              try: (signal) =>
                fetcher.fetch(item.url, signal, {
                  allowHost,
                  timeoutMs: Math.max(1, REVISION_MS - budget.ms),
                  onBytes: (bytes) => {
                    budget.bytes += bytes
                    if (budget.bytes > REVISION_BYTES || budget.ms + Date.now() - started >= REVISION_MS)
                      throw new ExternalMediaRefused("This entry's media limit was reached.")
                  }
                }),
              catch: (e) => e
            }),
            (file) =>
              Effect.gen(function* () {
                const bytes = yield* Effect.tryPromise(() => readFile(file.path))
                const sha256 = createHash("sha256").update(bytes).digest("hex")
                return yield* holds.holding(
                  [sha256],
                  storeMedia(config.dataDir, sha256, bytes).pipe(
                    Effect.andThen(record(item.id, { saved: { sha256, mime: file.mime, byteSize: bytes.byteLength } }))
                  )
                )
              }),
            (file) => Effect.promise(file.dispose)
          ).pipe(Effect.result)
          budget.ms += Date.now() - started
          if (result._tag === "Failure") yield* record(item.id, failureReason(result.failure))
        }).pipe(
          Effect.catch((error) => Effect.logWarning("saving a media file failed", error)),
          Effect.ensuring(
            Effect.sync(() => {
              active.delete(item.id)
              perUser.set(item.ownerUserId, (perUser.get(item.ownerUserId) ?? 1) - 1)
              kick()
            })
          )
        )

      /** Starts the downloads there's room for; whether any work was found. */
      const startDownloads = Effect.gen(function* () {
        if (active.size >= SERVER_DOWNLOADS) return false
        const next = yield* reader.NextSavedMediaDownloads({ limit: 32, skip: [...active] })
        let started = false
        for (const item of next) {
          if (active.size >= SERVER_DOWNLOADS) break
          if ((perUser.get(item.ownerUserId) ?? 0) >= USER_DOWNLOADS) continue
          active.add(item.id)
          perUser.set(item.ownerUserId, (perUser.get(item.ownerUserId) ?? 0) + 1)
          yield* Effect.forkIn(download(item), scope)
          started = true
        }
        return started
      })

      const step = Effect.gen(function* () {
        const scanned = yield* scanRound(null, null)
        const started = yield* startDownloads
        return scanned || started
      })
      const idle = Effect.race(
        Effect.sleep(IDLE_MS),
        Effect.callback<void>((resume) => {
          wake = () => resume(Effect.void)
        })
      )
      yield* Effect.forkIn(
        Effect.forever(
          step.pipe(
            Effect.catch((error) => Effect.logWarning("saved media task", error).pipe(Effect.as(false))),
            Effect.flatMap((busy) => (busy ? Effect.yieldNow : idle))
          )
        ),
        scope
      )

      const settle = Effect.gen(function* () {
        for (let round = 0; round < 10_000; round++) {
          const scanned = yield* scanRound(null, null)
          const started = yield* startDownloads
          if (!scanned && !started && active.size === 0) {
            const left = yield* reader.NextSavedMediaDownloads({ limit: 1, skip: [] })
            if (left.length === 0) return
          }
          yield* Effect.sleep(5)
        }
      })

      return SavedMedia.of({ fetchers, scan, kick, settle })
    })
  )
}

export const makeSavedMediaHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  const saved = yield* SavedMedia
  return {
    LookupSavedMedia: ({ urls }) =>
      Effect.flatMap(CurrentUser, (user) => reader.LookupSavedMedia({ userId: user.id, urls })).pipe(
        internal("looking up saved media")
      ),
    GetSavedMediaStatus: ({ refId }) =>
      Effect.flatMap(CurrentUser, (user) =>
        saved.scan(user.id, [refId]).pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.andThen(reader.GetSavedMediaStatus({ userId: user.id, refId }))
        )
      ).pipe(internal("reading saved media")),
    RetrySavedMedia: ({ refId }) =>
      Effect.flatMap(CurrentUser, (user) => writer.RetrySavedMedia({ userId: user.id, refId, at: Date.now() })).pipe(
        Effect.tap(() => Effect.sync(saved.kick)),
        internal("retrying saved media")
      ),
    ListMediaApproval: ({ refIds }) =>
      Effect.flatMap(CurrentUser, (user) =>
        saved.scan(user.id, refIds).pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.andThen(reader.ListMediaApproval({ userId: user.id, refIds }))
        )
      ).pipe(internal("listing media to approve")),
    DecideMediaApproval: ({ refIds, decisions }) =>
      Effect.flatMap(CurrentUser, (user) =>
        writer.DecideMediaApproval({
          userId: user.id,
          refIds,
          decisions: decisions.filter((decision) => isHostName(normalizeHost(decision.host))),
          at: Date.now()
        })
      ).pipe(
        Effect.tap(() => Effect.sync(saved.kick)),
        internal("approving media sites")
      ),
    GetMediaHosts: () =>
      Effect.flatMap(CurrentUser, (user) => reader.GetMediaHosts({ userId: user.id })).pipe(
        internal("reading media sites")
      ),
    ChangeMediaHosts: ({ add, remove }) =>
      Effect.flatMap(CurrentUser, (user) =>
        writer.ChangeMediaHosts({
          userId: user.id,
          ...(add && isHostName(normalizeHost(add.host))
            ? { add: { host: normalizeHost(add.host), subdomains: add.subdomains } }
            : {}),
          ...(remove === undefined ? {} : { remove }),
          at: Date.now()
        })
      ).pipe(
        Effect.tap(() => Effect.sync(saved.kick)),
        internal("changing media sites")
      )
  } satisfies Parameters<typeof SavedMediaApi.of>[0]
})

const notFound = () =>
  HttpServerResponse.text("Not found", {
    status: 404,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" }
  })

/**
 * A saved file, for the account whose addresses name it. Never a page: only the saved types,
 * as an attachment, sandboxed, same-origin only, `nosniff`.
 */
export const savedMediaRoute = Layer.unwrap(
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const reader = yield* Reader
    const config = yield* AppConfig
    return HttpRouter.add(
      "GET",
      "/media/saved/:id",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const session = yield* Effect.option(accounts.resolve(request.headers))
        if (Option.isNone(session))
          return HttpServerResponse.text("Login required", { status: 401, headers: { "cache-control": "no-store" } })
        const id = (yield* HttpRouter.params).id ?? ""
        if (id === "" || id.length > 100) return notFound()
        const file = yield* reader.GetSavedMediaFile({ userId: session.value.user.id, mediaId: id })
        if (file === null || !isMediaPath(file.path) || !SAVED_MEDIA_TYPES.has(file.mime)) return notFound()
        const headers = {
          "cache-control": "private, no-store",
          vary: `Cookie, ${config.authProxyHeader}`,
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
          "content-disposition": "attachment",
          "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
          etag: `"${id}"`
        }
        if (request.headers["if-none-match"]?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === `"${id}"`))
          return HttpServerResponse.empty({ status: 304, headers })
        return yield* HttpServerResponse.file(join(config.dataDir, file.path), {
          contentType: file.mime,
          chunkSize: 64 * 1024,
          headers
        }).pipe(Effect.orElseSucceed(notFound))
      }).pipe(Effect.catchTag("StorageError", () => Effect.succeed(notFound())))
    )
  })
)
