// Card sources (spec/CARD-SOURCES.md): the `cardSources` registry of adapters, and the
// server's proxy to them. The browser never talks to a source: it names a source id and a
// query, card id or image key, and this service turns that into a request on the adapter's
// own hosts (guard.ts), behind the source's rate limit with identical requests shared
// (limiter.ts), through the file cache (cache.ts).
//
// Nothing here contacts a source unless the user asked for something from it: listing the
// sources, the switches and the recently viewed list are local (§5.1).
//
// Updates (§3.8): a page of results, or a card's file, fetched from the source reports the
// versions of the cards the user added from it, recorded as each origin's `seen_version` (a
// page read from the cache reports nothing, so an older page can't undo a newer version).
// Check for a newer version asks the source for one card's version; the newer file is fetched
// only when the user opens the update.
import { createHash, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  type CardOrigin,
  type RecentRemote,
  type RemoteCreator,
  type RemoteRelative,
  remoteEntityId,
  remoteMediaId,
  type RemoteSummary,
  SourceAdminSettings,
  type SourceCapabilities,
  SourceFailed,
  type SourceInfo,
  type SourcePage,
  type SourcePrefs,
  type SourceQuery,
  type SourceSuggestions
} from "@rp/shared/cardSources.ts"
import { CastCard, type EntityId } from "@rp/shared/chat.ts"
import { CardForChat } from "@rp/shared/chatSetupApi.ts"
import type { CredentialId } from "@rp/shared/providers.ts"
import type { User, UserId } from "@rp/shared/domain.ts"
import { Forbidden, NotFound, ServerError } from "@rp/shared/errors.ts"
import { mediaWidth } from "@rp/shared/media.ts"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { AppConfig } from "../config.ts"
import { cardTextOfDoc } from "../db/cards.ts"
import { Reader, Writer } from "../db/Database.ts"
import { Formats } from "../importer/Formats.ts"
import { MediaHolds } from "../importer/MediaHolds.ts"
import { storeMedia } from "../importer/mediaFiles.ts"
import { withSourceLink } from "../importer/sourceLink.ts"
import { prepareAvatarThumbnails } from "../importer/prepareThumbnails.ts"
import { describeImage } from "../importer/images.ts"
import { Network } from "../net/Network.ts"
import { Providers } from "../providers/Providers.ts"
import { makeRegistry, type Registry } from "../registry.ts"
import { Secrets } from "../secrets.ts"
import type { AdapterSummary, CardSourceAdapter, SourceHttp } from "./adapter.ts"
import { blobPath, DEFAULT_CAP_BYTES, makeSourceCache, type SourceCache } from "./cache.ts"
import { makeSourceHttp } from "./guard.ts"
import { withConditionalGets } from "./httpCache.ts"
import { makeCoalescer, makeLimiter } from "./limiter.ts"

const ADMIN_KEY = "sources.admin"
const IMAGE_PURPOSE = "card-source-image"
/** Images a browser shows as images; anything else a source sends is refused. */
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/** A source's card as the writer's `AdoptRemoteCard` takes it. */
type AdoptPayload = Parameters<Writer["Service"]["AdoptRemoteCard"]>[0]

/** A source's card ready to add: its writer payload, and the media files it brings. */
interface PreparedAdoption {
  readonly name: string
  readonly payload: AdoptPayload
  readonly media: ReadonlyArray<{
    readonly role: "avatar" | "asset"
    readonly sha256: string
    readonly bytes: Uint8Array
  }>
}

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
  readonly suggestions: (
    user: User,
    sourceId: string,
    kind: "tags" | "creators",
    prefix: string,
    page: string | null
  ) => Effect.Effect<SourceSuggestions, SourceFailed | NotFound | ServerError>
  readonly card: (
    user: User,
    sourceId: string,
    remoteId: string
  ) => Effect.Effect<
    { summary: RemoteSummary; docJson: string | null; problems: ReadonlyArray<string> },
    SourceFailed | NotFound | ServerError
  >
  /**
   * Adds a remote card to the user's cards (§4.5, Add to my cards): its cached file, fetched
   * again if evicted, stored as an import of it is, with its origin; a card the user already
   * has from there is answered instead, with `existing`.
   */
  readonly adopt: (
    user: User,
    sourceId: string,
    remoteId: string
  ) => Effect.Effect<
    { entityId: string; refId: string; name: string; existing: boolean },
    SourceFailed | NotFound | ServerError
  >
  /**
   * A remote card as a pending chat shows it (§4.2), under its placeholder id
   * (`remoteEntityId`), its picture by its image key; recorded as recently viewed.
   */
  readonly forChat: (
    user: User,
    sourceId: string,
    remoteId: string
  ) => Effect.Effect<{ card: CardForChat; summary: RemoteSummary }, SourceFailed | NotFound | ServerError>
  /** A remote card's file made ready to add (§4.5): parsed, its page on the source in its `source`. */
  readonly prepareAdoption: (
    user: User,
    sourceId: string,
    remoteId: string
  ) => Effect.Effect<PreparedAdoption, SourceFailed | NotFound | ServerError>
  /**
   * Runs `write`, the transaction that adds `prepared`, with their media files written first
   * and held from the sweep while it runs, as an import's are; then makes the avatars'
   * thumbnails of the cards `added` says are new (by position in `prepared`).
   */
  readonly storingAdoptions: <A, E, R>(
    prepared: ReadonlyArray<PreparedAdoption>,
    write: Effect.Effect<A, E, R>,
    added: (result: A) => ReadonlyArray<boolean>
  ) => Effect.Effect<A, E | ServerError, R>
  /** An image a result named, by the key this server issued for this user; `width` makes a thumbnail. */
  readonly image: (
    user: User,
    sourceId: string,
    key: string,
    width: number | null
  ) => Effect.Effect<SourceImage, SourceFailed | NotFound | ServerError>
  /** The card's origin when it was added from a source that's on for this user (§3.8); local. */
  readonly origin: (user: User, entityId: string) => Effect.Effect<CardOrigin | null, ServerError>
  /** Check for a newer version: the source's current version of the card, recorded. */
  readonly checkVersion: (
    user: User,
    entityId: string
  ) => Effect.Effect<CardOrigin, SourceFailed | NotFound | ServerError>
  /** The version the user took into the card (Review and merge, Replace); local. */
  readonly takeVersion: (
    user: User,
    entityId: string,
    version: string
  ) => Effect.Effect<CardOrigin, SourceFailed | NotFound | ServerError>
  /**
   * The source's newest file of the card (the reported version, fetched again when the cache has
   * another), with the card's link back to its page, which a new version taken from it keeps (§4.5).
   */
  readonly newerFile: (
    user: User,
    entityId: string
  ) => Effect.Effect<
    { bytes: Uint8Array; fileName: string; version: string; link: string },
    SourceFailed | NotFound | ServerError
  >
  /** Add as a separate card: the source's newest file as a new card, that version taken on this one. */
  readonly addVersionAsCard: (
    user: User,
    entityId: string
  ) => Effect.Effect<{ entityId: string; refId: string; name: string }, SourceFailed | NotFound | ServerError>
  /** A card's family on the source, the user's own among it marked; a page's lifetime in the cache. */
  readonly family: (
    user: User,
    sourceId: string,
    remoteId: string
  ) => Effect.Effect<{ items: ReadonlyArray<RemoteRelative>; more: boolean }, SourceFailed | NotFound | ServerError>
  /** A creator's public profile, its avatar by an image key; a page's lifetime in the cache. */
  readonly creator: (
    user: User,
    sourceId: string,
    query: string
  ) => Effect.Effect<RemoteCreator, SourceFailed | NotFound | ServerError>
  readonly recent: (user: User, sourceId: string) => Effect.Effect<ReadonlyArray<RecentRemote>, ServerError>
  readonly clearRecent: (user: User, sourceId: string) => Effect.Effect<void, ServerError>
  /**
   * The registered sources' cards an imported card names among its links (§3.7), so the import
   * records it as theirs (`recognized`). Local: nothing is sent to a source.
   */
  readonly recognize: (
    links: ReadonlyArray<string>
  ) => ReadonlyArray<{ readonly sourceId: string; readonly remoteId: string }>
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

/** A card's link back to its page on the source (§4.5): the page it named, else `<source>:<remoteId>`. */
const linkOf = (sourceId: string, remoteId: string, summary: { readonly url?: string | undefined }) =>
  summary.url ?? `${sourceId}:${remoteId}`
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
    const { holding } = yield* MediaHolds
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
    yield* cache.load
    // A card with unsaved edits keeps its cached file while they wait (§4.1): the edits are a
    // diff from it. If the drafts can't be read, the sweep waits for the next round.
    const sweep = reader.EditedRemoteCards().pipe(
      Effect.flatMap((edited) =>
        cache.sweepKeeping(
          edited.map(({ userId, sourceId, remoteId }) => ({
            user: userId,
            source: sourceId,
            kind: "card",
            id: remoteId
          }))
        )
      ),
      Effect.catch((error) => Effect.logWarning("card source cache sweep skipped", error))
    )
    yield* sweep
    yield* Effect.forkScoped(Effect.repeat(sweep, Schedule.spaced("10 minutes")))
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
        const http = makeSourceHttp(adapter, yield* apiKey(user, adapter, prefs), {
          network,
          limiter,
          bypassEntries: () => bypass.entries,
          ...(options.onRequest ? { onRequest: options.onRequest } : {})
        })
        return withConditionalGets(http, cache, user.id, adapter.id)
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
      run: (http: SourceHttp) => Effect.Effect<A, SourceFailed>,
      keep: (value: A) => boolean = () => true
    ) =>
      Effect.gen(function* () {
        yield* usable(user, sourceId)
        const key = cacheKey(user, sourceId, kind, id)
        const hit = yield* cache.get(key)
        if (hit && keep(hit.value as A)) return hit.value as A
        const value = yield* ask(user, sourceId, `${kind}:${id}`, run)
        if (keep(value)) yield* cache.put(key, { value })
        return value
      })

    /**
     * A remote card's file, unparsed: from the cache while it lasts, else fetched and kept (the
     * user asked for it); `fresh` fetches it again. `fetched` says it came from the source just now.
     */
    const cardBytes = (user: User, sourceId: string, remoteId: string, fresh = false) =>
      Effect.gen(function* () {
        const adapter = yield* known(sourceId)
        const key = cacheKey(user, sourceId, "card", remoteId)
        let entry = fresh ? undefined : yield* cache.get(key)
        let bytes: Uint8Array
        const fetched = !entry
        if (!entry) {
          const file = yield* ask(user, sourceId, `card:${remoteId}`, (http) => adapter.card(http, remoteId))
          // Admission may evict this very file when it exceeds the cache cap. The active
          // request already owns its bytes and must not depend on retaining that blob.
          bytes = new Uint8Array(file.bytes)
          entry = yield* cache.put(key, {
            bytes: file.bytes,
            value: { summary: file.summary, fileName: file.fileName }
          })
        } else {
          yield* usable(user, sourceId)
          bytes = new Uint8Array(yield* cache.readBlob(entry.blob!))
        }
        const { summary, fileName } = entry.value as { summary: AdapterSummary; fileName: string }
        return { summary, fileName, bytes, fetched }
      })

    /** The card's file, parsed. Parsing transfers its bytes to a worker: they aren't returned. */
    const cardFile = (user: User, sourceId: string, remoteId: string) =>
      Effect.gen(function* () {
        const { bytes, ...file } = yield* cardBytes(user, sourceId, remoteId)
        const parsed = yield* formats.parse(bytes, file.fileName).pipe(Effect.catch(storage("reading the card")))
        // JSON downloads (notably CHARX originals) have no embedded portrait. Fetch it
        // while opening the card, through the same guarded image cache the browser uses,
        // so adding the already-opened card retains its face without another request.
        const image = file.summary.image
        if (parsed.library?.kind === "card" && !parsed.media.some((m) => m.role === "avatar") && image) {
          const portrait = yield* service
            .image(user, sourceId, issue(user, sourceId, image)!, null)
            .pipe(Effect.catch(() => Effect.succeed(null)))
          if (portrait) {
            const media = {
              role: "avatar" as const,
              uri: "ccdefault:",
              bytes: portrait.bytes,
              sha256: createHash("sha256").update(portrait.bytes).digest("hex"),
              byteSize: portrait.bytes.byteLength,
              ...describeImage(portrait.bytes)
            }
            return { ...file, parsed: { ...parsed, media: [...parsed.media, media] } }
          }
        }
        return { ...file, parsed }
      })

    /** Versions the source just reported for cards the user added from it (§3.8). */
    const noteVersions = (
      user: User,
      sourceId: string,
      items: ReadonlyArray<{ readonly remoteId: string; readonly version: string }>
    ) =>
      items.length === 0
        ? Effect.void
        : writer
            .NoteRemoteVersions({ userId: user.id, sourceId, items })
            .pipe(Effect.catch(storage("recording the source's versions")), Effect.asVoid)

    /**
     * The user's own cards among `items` (§3.7), marked on each; nothing is sent to the source.
     * `reported`: the items came from the source just now, so their versions are recorded (§3.8).
     */
    const withHeld = (user: User, sourceId: string, items: ReadonlyArray<RemoteSummary>, reported = false) =>
      Effect.gen(function* () {
        if (items.length === 0) return items
        const held = yield* reader
          .HeldRemoteCards({
            userId: user.id,
            sourceId,
            items: items.map((item) => ({
              remoteId: item.remoteId,
              sha256: /^[0-9a-f]{64}$/.test(item.version.id) ? item.version.id : null
            }))
          })
          .pipe(Effect.catch(storage("finding your cards among the results")))
        if (held.length === 0) return items
        const byId = new Map(held.map((card) => [card.remoteId, card]))
        if (reported)
          yield* noteVersions(
            user,
            sourceId,
            items.flatMap((item) => {
              const card = byId.get(item.remoteId)
              const version = item.version.id
              return card?.tracked && version !== "" && (card.seenVersion ?? card.remoteVersion) !== version
                ? [{ remoteId: item.remoteId, version }]
                : []
            })
          )
        return items.map((item): RemoteSummary => {
          const card = byId.get(item.remoteId)
          if (!card) return item
          // Just reported, the item's version decides; from the cache, the recorded one does.
          const newest = reported && item.version.id !== "" ? item.version.id : (card.seenVersion ?? card.remoteVersion)
          return {
            ...item,
            held: {
              entityId: card.entityId,
              refId: card.refId,
              archived: card.archived,
              update: card.tracked && newest !== null && newest !== card.remoteVersion
            }
          }
        })
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

    // --- Updates (§3.8): a card's origin row, as the editor shows it.
    const originRow = (user: User, entityId: string) =>
      reader
        .CardOrigin({ userId: user.id, entityId: entityId as EntityId })
        .pipe(Effect.catch(storage("reading where the card came from")))
    type OriginRow = NonNullable<Effect.Success<ReturnType<typeof originRow>>>
    const originOf = (entityId: string, adapter: CardSourceAdapter, row: OriginRow): CardOrigin => ({
      entityId,
      sourceId: row.sourceId,
      sourceName: adapter.name,
      remoteId: row.remoteId,
      remoteVersion: row.remoteVersion,
      newerVersion: row.seenVersion !== null && row.seenVersion !== row.remoteVersion ? row.seenVersion : null,
      ...(row.recognized ? { recognized: true } : {})
    })
    const noOrigin = (entityId: string) => new NotFound({ entity: "card from a card source", id: entityId })
    /** The card's origin, on a source that's on for this user: else NotFound, or `disabled`. */
    const heldOrigin = (user: User, entityId: string) =>
      Effect.gen(function* () {
        const row = yield* originRow(user, entityId)
        if (row === null) return yield* noOrigin(entityId)
        const { adapter } = yield* usable(user, row.sourceId)
        return { row, adapter }
      })
    const originAgain = (user: User, entityId: string, adapter: CardSourceAdapter) =>
      Effect.gen(function* () {
        const row = yield* originRow(user, entityId)
        if (row === null) return yield* noOrigin(entityId)
        return originOf(entityId, adapter, row)
      })

    const service: CardSourcesShape = {
      registry,
      cache,
      recognize: (links) =>
        links.length === 0
          ? []
          : registry
              .list()
              .flatMap((adapter) =>
                (adapter.recognize?.(links) ?? []).slice(0, 20).map((remoteId) => ({ sourceId: adapter.id, remoteId }))
              ),
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
          yield* sweep
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
          let reported = false
          const result = yield* cached(
            user,
            sourceId,
            "page",
            queryKey(query, page),
            (http) =>
              adapter.search(http, query, page).pipe(Effect.tap(() => Effect.sync(() => void (reported = true)))),
            (result) => result.notice === undefined
          )
          return {
            ...result,
            items: yield* withHeld(
              user,
              sourceId,
              result.items.map((item) => forClient(user, sourceId, item)),
              reported
            )
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
      suggestions: (user, sourceId, kind, prefix, page) =>
        Effect.gen(function* () {
          const { adapter } = yield* usable(user, sourceId)
          const suggest = adapter.suggestions
          if (!suggest) {
            const tags = kind === "tags" && page === null ? yield* service.tags(user, sourceId, prefix) : []
            return {
              items: tags.map((tag) => ({
                value: tag.tag,
                label: tag.label ?? tag.tag,
                ...(tag.count === undefined ? {} : { count: tag.count })
              })),
              next: null
            }
          }
          return yield* cached(user, sourceId, "tags", JSON.stringify([kind, prefix.trim(), page]), (http) =>
            suggest(http, kind, prefix.trim(), page)
          )
        }),
      card: (user, sourceId, remoteId) =>
        Effect.gen(function* () {
          const { summary, parsed, fetched } = yield* cardFile(user, sourceId, remoteId)
          const card = parsed.library?.kind === "card" ? parsed.library : null
          const [shown] = yield* withHeld(user, sourceId, [forClient(user, sourceId, summary)], fetched)
          yield* writer
            .RecordRecentRemote({
              userId: user.id,
              entry: {
                sourceId,
                remoteId,
                name: summary.name,
                ...(summary.creator ? { creator: summary.creator } : {}),
                ...(shown!.thumb ? { thumb: shown!.thumb } : {}),
                at: Date.now()
              }
            })
            .pipe(Effect.tap(keep(user.id)), Effect.catch(storage("recording a recently viewed card")))
          return {
            summary: shown!,
            docJson: card?.docJson ?? null,
            problems: card ? [] : parsed.report.issues.filter((i) => i.level === "error").map((i) => i.message)
          }
        }),
      forChat: (user, sourceId, remoteId) =>
        Effect.gen(function* () {
          const { summary, docJson, problems } = yield* service.card(user, sourceId, remoteId)
          if (docJson === null)
            return yield* new SourceFailed({
              sourceId,
              reason: "bad_response",
              message: problems[0] ?? "This card couldn't be read."
            })
          const text = cardTextOfDoc(remoteEntityId(sourceId, remoteId), docJson)
          const { avatarCrop: _, ...card } = text.card
          return {
            summary,
            card: new CardForChat({
              card: new CastCard({
                ...card,
                avatarMediaId: summary.image ? remoteMediaId(sourceId, summary.image) : null
              }),
              greetings: text.greetings,
              groupGreetings: text.groupGreetings,
              description: text.description,
              personality: text.personality,
              scenario: text.scenario
            })
          }
        }),
      prepareAdoption: (user, sourceId, remoteId) =>
        Effect.gen(function* () {
          const { summary, fileName, parsed } = yield* cardFile(user, sourceId, remoteId)
          const card = parsed.library?.kind === "card" ? parsed.library : null
          if (card === null)
            return yield* new SourceFailed({
              sourceId,
              reason: "bad_response",
              message: `This card couldn't be read, so it can't be added.`
            })
          // The card's page on the source joins its `source` list, as its link back (§4.5).
          const stored = withSourceLink(card, linkOf(sourceId, remoteId, summary))
          return {
            name: summary.name,
            media: parsed.media,
            payload: {
              userId: user.id,
              sourceId,
              remoteId,
              remoteVersion: summary.version.id,
              file: {
                label: card.label,
                docJson: stored.docJson,
                docHash: stored.docHash,
                searchText: stored.searchText,
                schemaVersion: card.schemaVersion,
                sourceName: fileName,
                sourceHash: parsed.sha256,
                media: parsed.media.map(({ bytes: _, ...file }) => file),
                noteDocJson: card.noteDocJson,
                ...(card.notesDocJson ? { notesDocJson: card.notesDocJson } : {})
              }
            }
          }
        }),
      storingAdoptions: (prepared, write, added) =>
        Effect.gen(function* () {
          const media = prepared.flatMap((card) => card.media)
          const result = yield* holding(
            media.map((file) => file.sha256),
            Effect.gen(function* () {
              yield* Effect.forEach(media, (file) => storeMedia(config.dataDir, file.sha256, file.bytes), {
                discard: true
              }).pipe(Effect.catch(storage("storing the card's pictures")))
              return yield* write
            })
          )
          const fresh = added(result)
          yield* Effect.forEach(
            prepared,
            (card, at) => (fresh[at] ? prepareAvatarThumbnails(formats, config.dataDir, card.media) : Effect.void),
            { discard: true }
          )
          return result
        }),
      adopt: (user, sourceId, remoteId) =>
        Effect.gen(function* () {
          const prepared = yield* service.prepareAdoption(user, sourceId, remoteId)
          const added = yield* service.storingAdoptions(
            [prepared],
            writer.AdoptRemoteCard(prepared.payload).pipe(Effect.catch(storage("adding the card"))),
            (result) => [!result.existing]
          )
          return { entityId: added.entityId, refId: added.refId, name: prepared.name, existing: added.existing }
        }),
      image: (user, sourceId, key, width) =>
        Effect.gen(function* () {
          const adapter = yield* known(sourceId)
          const ref = redeem(user, sourceId, key)
          if (ref === null) return yield* new NotFound({ entity: "image", id: key })
          const entryKey = cacheKey(user, sourceId, "image", sha(ref))
          let entry = yield* cache.get(entryKey)
          let bytes: Uint8Array
          if (!entry) {
            bytes = yield* ask(user, sourceId, `image:${ref}`, (http) => adapter.image(http, ref))
            const { mime } = describeImage(bytes)
            if (!IMAGES.has(mime))
              return yield* new SourceFailed({ sourceId, reason: "bad_response", message: "not an image" })
            entry = yield* cache.put(entryKey, { bytes, value: { mime } })
          } else bytes = yield* cache.readBlob(entry.blob!)
          const blob = entry.blob!
          const { mime } = entry.value as { mime: string }
          if (width !== null) {
            const thumb = yield* formats
              .thumbnail({ dataDir: config.dataDir, path: blobPath(blob), width: mediaWidth(width) })
              .pipe(Effect.option)
            if (thumb._tag === "Some" && !thumb.value.original) {
              yield* cache.noteDerivative(blob, thumb.value.path)
              const thumbnail = yield* Effect.promise(() => readFile(join(config.dataDir, thumb.value.path)))
              return { bytes: thumbnail, mime: "image/webp", etag: `"${thumb.value.path.split("/").pop()!}"` }
            }
          }
          return { bytes, mime, etag: `"${blob}"` }
        }),
      origin: (user, entityId) =>
        Effect.gen(function* () {
          const row = yield* originRow(user, entityId)
          const adapter = row === null ? undefined : registry.get(row.sourceId)
          if (row === null || !adapter) return null
          if (!info(adapter, yield* prefsOf(user.id)).enabled) return null
          return originOf(entityId, adapter, row)
        }),
      checkVersion: (user, entityId) =>
        Effect.gen(function* () {
          const { row, adapter } = yield* heldOrigin(user, entityId)
          const versions = adapter.versions
          const version = versions
            ? (yield* ask(user, row.sourceId, `versions:${row.remoteId}`, (http) =>
                versions(http, [row.remoteId])
              )).find((item) => item.remoteId === row.remoteId)?.version.id
            : (yield* cardBytes(user, row.sourceId, row.remoteId, true)).summary.version.id
          if (!version)
            return yield* new SourceFailed({
              sourceId: row.sourceId,
              reason: "not_found",
              message: `${adapter.name} no longer has this card.`
            })
          yield* noteVersions(user, row.sourceId, [{ remoteId: row.remoteId, version }])
          return yield* originAgain(user, entityId, adapter)
        }),
      takeVersion: (user, entityId, version) =>
        Effect.gen(function* () {
          const { adapter } = yield* heldOrigin(user, entityId)
          yield* writer
            .TakeRemoteVersion({ userId: user.id, entityId: entityId as EntityId, version })
            .pipe(Effect.catchIf((error) => error._tag !== "NotFound", storage("recording the version taken")))
          return yield* originAgain(user, entityId, adapter)
        }),
      newerFile: (user, entityId) =>
        Effect.gen(function* () {
          const { row } = yield* heldOrigin(user, entityId)
          const wanted = row.seenVersion ?? row.remoteVersion
          const cachedFile = yield* cardBytes(user, row.sourceId, row.remoteId)
          const file =
            cachedFile.summary.version.id === wanted
              ? cachedFile
              : yield* cardBytes(user, row.sourceId, row.remoteId, true)
          const version = file.summary.version.id
          // The source may have moved on again since it was checked.
          if (version !== "" && version !== wanted)
            yield* noteVersions(user, row.sourceId, [{ remoteId: row.remoteId, version }])
          return {
            bytes: file.bytes,
            fileName: file.fileName,
            version: version || wanted,
            link: linkOf(row.sourceId, row.remoteId, file.summary)
          }
        }),
      addVersionAsCard: (user, entityId) =>
        Effect.gen(function* () {
          const { row } = yield* heldOrigin(user, entityId)
          // The newest file into the cache, then made ready as an adoption is.
          yield* service.newerFile(user, entityId)
          const prepared = yield* service.prepareAdoption(user, row.sourceId, row.remoteId)
          const added = yield* service.storingAdoptions(
            [prepared],
            writer
              .AdoptRemoteVersionAsCard({
                userId: user.id,
                entityId: entityId as EntityId,
                version: prepared.payload.remoteVersion,
                file: prepared.payload.file
              })
              .pipe(Effect.catchIf((error) => error._tag !== "NotFound", storage("adding the new version"))),
            () => [true]
          )
          return { entityId: added.entityId, refId: added.refId, name: prepared.name }
        }),
      family: (user, sourceId, remoteId) =>
        Effect.gen(function* () {
          const adapter = yield* known(sourceId)
          const list = adapter.family
          if (!list) return yield* new NotFound({ entity: "card family", id: remoteId })
          const found = yield* cached(user, sourceId, "page", `family:${remoteId}`, (http) => list(http, remoteId))
          const held =
            found.items.length === 0
              ? []
              : yield* reader
                  .HeldRemoteCards({
                    userId: user.id,
                    sourceId,
                    items: found.items.map((item) => ({ remoteId: item.remoteId, sha256: null }))
                  })
                  .pipe(Effect.catch(storage("finding your cards in the family")))
          const byId = new Map(held.map((card) => [card.remoteId, card]))
          return {
            more: found.more,
            items: found.items.map(({ thumb, held: _, ...item }): RemoteRelative => {
              const key = issue(user, sourceId, thumb)
              const mine = byId.get(item.remoteId)
              return {
                ...item,
                ...(key ? { thumb: key } : {}),
                ...(mine ? { held: { entityId: mine.entityId, archived: mine.archived } } : {})
              }
            })
          }
        }),
      creator: (user, sourceId, query) =>
        Effect.gen(function* () {
          const adapter = yield* known(sourceId)
          const profile = adapter.creator
          if (!profile) return yield* new NotFound({ entity: "creator profile", id: query })
          const found = yield* cached(user, sourceId, "page", `creator:${query}`, (http) => profile(http, query))
          const { avatar, ...rest } = found
          const key = issue(user, sourceId, avatar)
          return { ...rest, ...(key ? { avatar: key } : {}) }
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
