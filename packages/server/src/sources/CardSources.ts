// Card sources (spec/CARD-SOURCES.md): the `cardSources` registry of adapters, and the
// server's proxy to them. The browser never talks to a source: it names a source id and a
// query, card id or image key, and this service turns that into a request on the adapter's
// own hosts (guard.ts), behind the source's rate limit with identical requests shared
// (limiter.ts), through the file cache (cache.ts).
//
// Nothing here contacts a source unless the user asked for something from it: listing the
// sources, the switches and the recently viewed list are local (§5.1).
import { createHash, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  type RecentRemote,
  type RemoteSummary,
  SourceAdminSettings,
  type SourceCapabilities,
  SourceFailed,
  type SourceInfo,
  type SourcePage,
  type SourcePrefs,
  type SourceQuery
} from "@rp/shared/cardSources.ts"
import type { CredentialId } from "@rp/shared/providers.ts"
import type { User, UserId } from "@rp/shared/domain.ts"
import { Forbidden, NotFound, ServerError } from "@rp/shared/errors.ts"
import { mediaWidth } from "@rp/shared/media.ts"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { Formats } from "../importer/Formats.ts"
import { describeImage } from "../importer/images.ts"
import { Network } from "../net/Network.ts"
import { Providers } from "../providers/Providers.ts"
import { makeRegistry, type Registry } from "../registry.ts"
import { Secrets } from "../secrets.ts"
import type { AdapterSummary, CardSourceAdapter, SourceHttp } from "./adapter.ts"
import { blobPath, DEFAULT_CAP_BYTES, makeSourceCache, type SourceCache } from "./cache.ts"
import { makeSourceHttp } from "./guard.ts"
import { makeCoalescer, makeLimiter } from "./limiter.ts"

const ADMIN_KEY = "sources.admin"
const IMAGE_PURPOSE = "card-source-image"
/** Images a browser shows as images; anything else a source sends is refused. */
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

interface SourceImage {
  readonly bytes: Uint8Array
  readonly mime: string
  readonly etag: string
}

export interface CardSourcesShape {
  /** The adapters. A plugin adds, replaces or disables one for the length of a scope (PLUGINS §6). */
  readonly registry: Registry<CardSourceAdapter>
  readonly list: (user: User) => Effect.Effect<typeof import("@rp/shared/cardSources.ts").SourceList.Type, ServerError>
  readonly setEnabled: (user: User, sourceId: string, enabled: boolean) => Effect.Effect<void, NotFound | ServerError>
  readonly setAdminDisabled: (
    user: User,
    sourceId: string,
    disabled: boolean
  ) => Effect.Effect<void, NotFound | Forbidden | ServerError>
  readonly setCap: (user: User, bytes: number) => Effect.Effect<void, Forbidden | ServerError>
  readonly setKey: (user: User, sourceId: string, key: string | null) => Effect.Effect<void, NotFound | ServerError>
  readonly setRating: (
    user: User,
    sourceId: string,
    rating: string | null
  ) => Effect.Effect<void, NotFound | ServerError>
  readonly clearCache: (user: User, sourceId: string | null) => Effect.Effect<void, ServerError>
  readonly capabilities: (
    user: User,
    sourceId: string
  ) => Effect.Effect<SourceCapabilities, SourceFailed | NotFound | ServerError>
  readonly search: (
    user: User,
    sourceId: string,
    query: SourceQuery,
    page: string | null
  ) => Effect.Effect<SourcePage, SourceFailed | NotFound | ServerError>
  readonly tags: (
    user: User,
    sourceId: string,
    prefix: string
  ) => Effect.Effect<
    ReadonlyArray<{ tag: string; label?: string; count?: number }>,
    SourceFailed | NotFound | ServerError
  >
  readonly card: (
    user: User,
    sourceId: string,
    remoteId: string
  ) => Effect.Effect<
    { summary: RemoteSummary; docJson: string | null; problems: ReadonlyArray<string> },
    SourceFailed | NotFound | ServerError
  >
  /** An image a result named, by the key this server issued for this user; `width` makes a thumbnail. */
  readonly image: (
    user: User,
    sourceId: string,
    key: string,
    width: number | null
  ) => Effect.Effect<SourceImage, SourceFailed | NotFound | ServerError>
  readonly recent: (user: User, sourceId: string) => Effect.Effect<ReadonlyArray<RecentRemote>, ServerError>
  readonly clearRecent: (user: User, sourceId: string) => Effect.Effect<void, ServerError>
  /** The cache, for tests and pinning (phase 3: drafts and open tabs pin their card). */
  readonly cache: SourceCache
}

export class CardSources extends Context.Service<CardSources, CardSourcesShape>()("rp/CardSources") {}

export interface CardSourcesOptions {
  /** Adapters registered for the server's lifetime: the development entry point's fake source. */
  readonly adapters?: ReadonlyArray<CardSourceAdapter>
  /** Hears every request that leaves for a source (tests). */
  readonly onRequest?: (sourceId: string, url: URL) => void
  readonly now?: () => number
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const storage = (operation: string) => (error: unknown) =>
  Effect.logError(`card sources: ${operation} failed`, error).pipe(
    Effect.andThen(Effect.fail(new ServerError({ message: `${operation} failed` })))
  )

/** The same query in the same words, whatever order its tags and filters were chosen in. */
const queryKey = (query: SourceQuery, page: string | null) =>
  sha(
    JSON.stringify({
      text: query.text.trim(),
      tags: [...query.tags].sort(),
      excludeTags: [...query.excludeTags].sort(),
      filters: Object.fromEntries(Object.entries(query.filters).sort(([a], [b]) => a.localeCompare(b))),
      sort: query.sort,
      reverse: query.reverse,
      page
    })
  )

const make = (options: CardSourcesOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const reader = yield* Reader
    const writer = yield* Writer
    const network = yield* Network
    const secrets = yield* Secrets
    const providers = yield* Providers
    const formats = yield* Formats
    const registry = makeRegistry<CardSourceAdapter>()
    for (const adapter of options.adapters ?? []) yield* registry.register(adapter)

    const decodeAdmin = Schema.decodeUnknownOption(SourceAdminSettings)
    const storedAdmin = yield* reader.GetAppSetting({ key: ADMIN_KEY }).pipe(Effect.orDie)
    const decoded = decodeAdmin(storedAdmin ?? { disabled: {} })
    const admin: { value: SourceAdminSettings } = { value: decoded._tag === "Some" ? decoded.value : { disabled: {} } }
    const cache = makeSourceCache({
      dataDir: config.dataDir,
      capBytes: () => admin.value.capBytes ?? DEFAULT_CAP_BYTES,
      ...(options.now ? { now: options.now } : {})
    })
    yield* cache.scan
    yield* Effect.forkScoped(Effect.repeat(cache.sweep, Schedule.spaced("10 minutes")))
    const limiter = makeLimiter(options.now)
    const coalescer = makeCoalescer()
    const bypass = { entries: [] as ReadonlyArray<string> }
    const refreshBypass = network.view.pipe(Effect.map((view) => void (bypass.entries = view.bypass)))
    yield* refreshBypass

    // The account's choices, read once per user: every write to them goes through here.
    const prefsCache = new Map<UserId, SourcePrefs>()
    const prefsOf = (userId: UserId) =>
      Effect.suspend(() => {
        const known = prefsCache.get(userId)
        if (known) return Effect.succeed(known)
        return reader.GetSourcePrefs({ userId }).pipe(
          Effect.tap((prefs) => Effect.sync(() => prefsCache.set(userId, prefs))),
          Effect.catch(storage("reading card source settings"))
        )
      })
    const keep = (userId: UserId) => (prefs: SourcePrefs) => Effect.sync(() => void prefsCache.set(userId, prefs))

    const known = (sourceId: string) =>
      Effect.suspend(() => {
        const adapter = registry.get(sourceId)
        return adapter ? Effect.succeed(adapter) : Effect.fail(new NotFound({ entity: "card source", id: sourceId }))
      })

    const info = (adapter: CardSourceAdapter, prefs: SourcePrefs): SourceInfo => {
      const adminDisabled = admin.value.disabled[adapter.id] === true
      const userEnabled = prefs.enabled[adapter.id] !== false
      return {
        id: adapter.id,
        name: adapter.name,
        adminDisabled,
        userEnabled,
        enabled: !adminDisabled && userEnabled,
        key: adapter.key ?? "none",
        hasKey: prefs.keys[adapter.id] !== undefined,
        rating: prefs.rating[adapter.id] ?? null
      }
    }

    /** The adapter, when this user has it on: otherwise nothing is sent (§5.2). */
    const usable = (user: User, sourceId: string) =>
      Effect.gen(function* () {
        const adapter = yield* known(sourceId)
        const prefs = yield* prefsOf(user.id)
        if (!info(adapter, prefs).enabled)
          return yield* new SourceFailed({ sourceId, reason: "disabled", message: `${adapter.name} is turned off` })
        return { adapter, prefs }
      })

    const apiKey = (user: User, adapter: CardSourceAdapter, prefs: SourcePrefs) =>
      Effect.gen(function* () {
        const credentialId = prefs.keys[adapter.id]
        if (credentialId === undefined || (adapter.key ?? "none") === "none") return null
        const stored = yield* reader
          .ResolveCredential({ userId: user.id, credentialId: credentialId as CredentialId })
          .pipe(Effect.catch(() => Effect.succeed(null)))
        if (stored === null) return null
        return yield* secrets
          .decrypt(stored.keyEnc, `credential:${credentialId}:key`)
          .pipe(Effect.catch(() => Effect.succeed(null)))
      })

    const httpFor = (user: User, adapter: CardSourceAdapter, prefs: SourcePrefs) =>
      Effect.gen(function* () {
        yield* refreshBypass
        return makeSourceHttp(adapter, yield* apiKey(user, adapter, prefs), {
          network,
          limiter,
          bypassEntries: () => bypass.entries,
          ...(options.onRequest ? { onRequest: options.onRequest } : {})
        })
      })

    /** Asks the source once for everyone waiting on the same thing (two tabs, home and the sidebar). */
    const ask = <A>(
      user: User,
      sourceId: string,
      what: string,
      run: (http: SourceHttp) => Effect.Effect<A, SourceFailed>
    ) =>
      Effect.gen(function* () {
        const { adapter, prefs } = yield* usable(user, sourceId)
        const http = yield* httpFor(user, adapter, prefs)
        return yield* coalescer.run(`${user.id}\u0000${sourceId}\u0000${what}`, run(http))
      })

    // --- Image keys: opaque handles issued from results, so a client can't name a URL (§6.2).
    const macOf = (user: User, sourceId: string, ref: string) =>
      secrets.sign(`${user.id}\u0000${sourceId}\u0000${ref}`, IMAGE_PURPOSE).slice(0, 32)
    const issue = (user: User, sourceId: string, ref: string | undefined) =>
      ref === undefined ? undefined : `${Buffer.from(ref, "utf8").toString("base64url")}.${macOf(user, sourceId, ref)}`
    const redeem = (user: User, sourceId: string, key: string) => {
      const dot = key.lastIndexOf(".")
      if (dot <= 0) return null
      const ref = Buffer.from(key.slice(0, dot), "base64url").toString("utf8")
      const given = Buffer.from(key.slice(dot + 1))
      const expected = Buffer.from(macOf(user, sourceId, ref))
      return given.length === expected.length && timingSafeEqual(given, expected) ? ref : null
    }
    const forClient = (user: User, sourceId: string, item: AdapterSummary): RemoteSummary => {
      const { thumb, image, ...rest } = item
      const thumbKey = issue(user, sourceId, thumb)
      const imageKey = issue(user, sourceId, image)
      return { ...rest, ...(thumbKey ? { thumb: thumbKey } : {}), ...(imageKey ? { image: imageKey } : {}) }
    }

    const cacheKey = (user: User, sourceId: string, kind: "page" | "caps" | "tags" | "card" | "image", id: string) => ({
      user: user.id,
      source: sourceId,
      kind,
      id
    })

    /** From the cache while it lasts, else asked for and kept. */
    const cached = <A>(
      user: User,
      sourceId: string,
      kind: "page" | "caps" | "tags",
      id: string,
      run: (http: SourceHttp) => Effect.Effect<A, SourceFailed>
    ) =>
      Effect.gen(function* () {
        yield* usable(user, sourceId)
        const key = cacheKey(user, sourceId, kind, id)
        const hit = yield* cache.get(key)
        if (hit) return hit.value as A
        const value = yield* ask(user, sourceId, `${kind}:${id}`, run)
        yield* cache.put(key, { value })
        return value
      })

    const changePrefs = (user: User, change: Parameters<typeof writer.ChangeSourcePrefs>[0]["change"]) =>
      writer
        .ChangeSourcePrefs({ userId: user.id, change })
        .pipe(Effect.tap(keep(user.id)), Effect.catch(storage("saving card source settings")), Effect.asVoid)

    const requireAdmin = (user: User) =>
      user.role === "admin" ? Effect.void : Effect.fail(new Forbidden({ message: "only an admin can change this" }))
    const saveAdmin = (next: SourceAdminSettings) =>
      writer.SetAppSetting({ key: ADMIN_KEY, value: next }).pipe(
        Effect.tap(() => Effect.sync(() => void (admin.value = next))),
        Effect.catch(storage("saving card source settings"))
      )

    const service: CardSourcesShape = {
      registry,
      cache,
      list: (user) =>
        Effect.gen(function* () {
          const prefs = yield* prefsOf(user.id)
          return {
            sources: registry.list().map((adapter) => info(adapter, prefs)),
            ...(user.role === "admin"
              ? { cache: { capBytes: admin.value.capBytes ?? DEFAULT_CAP_BYTES, usedBytes: cache.usedBytes() } }
              : {})
          }
        }),
      setEnabled: (user, sourceId, enabled) =>
        known(sourceId).pipe(Effect.andThen(changePrefs(user, { enabled: { [sourceId]: enabled ? null : false } }))),
      setAdminDisabled: (user, sourceId, disabled) =>
        Effect.gen(function* () {
          yield* requireAdmin(user)
          yield* known(sourceId)
          const rest = Object.fromEntries(Object.entries(admin.value.disabled).filter(([id]) => id !== sourceId))
          yield* saveAdmin({ ...admin.value, disabled: disabled ? { ...rest, [sourceId]: true } : rest })
        }),
      setCap: (user, bytes) =>
        Effect.gen(function* () {
          yield* requireAdmin(user)
          yield* saveAdmin({ ...admin.value, capBytes: bytes })
          yield* cache.sweep
        }),
      setKey: (user, sourceId, key) =>
        Effect.gen(function* () {
          const adapter = yield* known(sourceId)
          const prefs = yield* prefsOf(user.id)
          const previous = prefs.keys[sourceId]
          const trimmed = key?.trim() ?? ""
          let credentialId: string | null = null
          if (trimmed !== "") {
            const scheme = adapter.scheme ?? "https"
            const credential = yield* providers
              .createCredential({
                userId: user.id,
                name: `${adapter.name} API key`,
                apiKey: trimmed,
                urls: adapter.hosts.map((host) => `${scheme}://${host}`)
              })
              .pipe(Effect.catch(storage("saving the key")))
            credentialId = credential.id
          }
          yield* changePrefs(user, { keys: { [sourceId]: credentialId } })
          if (previous !== undefined)
            yield* writer
              .DeleteCredential({ userId: user.id, credentialId: previous as CredentialId })
              .pipe(Effect.catch(() => Effect.void))
        }),
      setRating: (user, sourceId, rating) =>
        known(sourceId).pipe(Effect.andThen(changePrefs(user, { rating: { [sourceId]: rating } }))),
      clearCache: (user, sourceId) =>
        Effect.gen(function* () {
          yield* cache.clearUser(user.id, sourceId)
          const prefs = yield* writer
            .ClearRecentRemote({ userId: user.id, sourceId })
            .pipe(Effect.catch(storage("clearing recently viewed cards")))
          yield* keep(user.id)(prefs)
        }),
      capabilities: (user, sourceId) =>
        Effect.flatMap(known(sourceId), (adapter) =>
          cached(user, sourceId, "caps", "", (http) => adapter.capabilities(http))
        ),
      search: (user, sourceId, query, page) =>
        Effect.gen(function* () {
          const adapter = yield* known(sourceId)
          const result = yield* cached(user, sourceId, "page", queryKey(query, page), (http) =>
            adapter.search(http, query, page)
          )
          return {
            ...result,
            items: result.items.map((item) => forClient(user, sourceId, item))
          }
        }),
      tags: (user, sourceId, prefix) =>
        Effect.gen(function* () {
          const adapter = yield* known(sourceId)
          const suggest = adapter.tags
          if (!suggest) return []
          return yield* cached(user, sourceId, "tags", prefix.trim().toLowerCase(), (http) =>
            suggest(http, prefix.trim())
          )
        }),
      card: (user, sourceId, remoteId) =>
        Effect.gen(function* () {
          const adapter = yield* known(sourceId)
          const key = cacheKey(user, sourceId, "card", remoteId)
          let entry = yield* cache.get(key)
          if (!entry) {
            const file = yield* ask(user, sourceId, `card:${remoteId}`, (http) => adapter.card(http, remoteId))
            entry = yield* cache.put(key, {
              bytes: file.bytes,
              value: { summary: file.summary, fileName: file.fileName }
            })
          } else yield* usable(user, sourceId)
          const { summary, fileName } = entry.value as { summary: AdapterSummary; fileName: string }
          const bytes = yield* cache.readBlob(entry.blob!)
          const parsed = yield* formats
            .parse(new Uint8Array(bytes), fileName)
            .pipe(Effect.catch(storage("reading the card")))
          const card = parsed.library?.kind === "card" ? parsed.library : null
          const shown = forClient(user, sourceId, summary)
          yield* writer
            .RecordRecentRemote({
              userId: user.id,
              entry: {
                sourceId,
                remoteId,
                name: summary.name,
                ...(summary.creator ? { creator: summary.creator } : {}),
                ...(shown.thumb ? { thumb: shown.thumb } : {}),
                at: Date.now()
              }
            })
            .pipe(Effect.tap(keep(user.id)), Effect.catch(storage("recording a recently viewed card")))
          return {
            summary: shown,
            docJson: card?.docJson ?? null,
            problems: card ? [] : parsed.report.issues.filter((i) => i.level === "error").map((i) => i.message)
          }
        }),
      image: (user, sourceId, key, width) =>
        Effect.gen(function* () {
          const adapter = yield* known(sourceId)
          const ref = redeem(user, sourceId, key)
          if (ref === null) return yield* new NotFound({ entity: "image", id: key })
          const entryKey = cacheKey(user, sourceId, "image", sha(ref))
          let entry = yield* cache.get(entryKey)
          if (!entry) {
            const bytes = yield* ask(user, sourceId, `image:${ref}`, (http) => adapter.image(http, ref))
            const { mime } = describeImage(bytes)
            if (!IMAGES.has(mime))
              return yield* new SourceFailed({ sourceId, reason: "bad_response", message: "not an image" })
            entry = yield* cache.put(entryKey, { bytes, value: { mime } })
          }
          const blob = entry.blob!
          const { mime } = entry.value as { mime: string }
          if (width !== null) {
            const thumb = yield* formats
              .thumbnail({ dataDir: config.dataDir, path: blobPath(blob), width: mediaWidth(width) })
              .pipe(Effect.option)
            if (thumb._tag === "Some" && !thumb.value.original) {
              yield* cache.noteDerivative(blob, thumb.value.path)
              const bytes = yield* Effect.promise(() => readFile(join(config.dataDir, thumb.value.path)))
              return { bytes, mime: "image/webp", etag: `"${thumb.value.path.split("/").pop()!}"` }
            }
          }
          return { bytes: yield* cache.readBlob(blob), mime, etag: `"${blob}"` }
        }),
      recent: (user, sourceId) =>
        Effect.map(prefsOf(user.id), (prefs) => prefs.recent.filter((r) => r.sourceId === sourceId)),
      clearRecent: (user, sourceId) =>
        writer
          .ClearRecentRemote({ userId: user.id, sourceId })
          .pipe(Effect.tap(keep(user.id)), Effect.catch(storage("clearing recently viewed cards")), Effect.asVoid)
    }
    return service
  })

export const layerWith = (options: CardSourcesOptions = {}) => Layer.effect(CardSources, make(options))
export const layer = layerWith()
