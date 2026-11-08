// Card sources (spec/CARD-SOURCES.md): places cards can be browsed from that aren't the
// user's library, such as cardex, a third-party public archive. The server talks to the
// source (packages/server/src/sources/); the browser only talks to the server. These are the
// shapes that cross to the client, and the RPCs, in a group of their own (AppCoreApi is at
// TypeScript's instantiation depth, TS2589).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Forbidden, NotFound, ServerError } from "./errors.ts"
import type { EntityId } from "./chat.ts"
import { CardForChat } from "./chatSetupApi.ts"

/** A source's id: lowercase, safe in URLs and keys (`show=src.<id>`). */
const SourceId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/))

/** One criterion the source can filter by (§2.3). The filter bar is generated from these. */
const SourceFilter = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    kind: Schema.Literal("choice"),
    options: Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String })),
    multi: Schema.Boolean,
    about: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    kind: Schema.Literal("range"),
    unit: Schema.optionalKey(Schema.String),
    min: Schema.optionalKey(Schema.Number),
    max: Schema.optionalKey(Schema.Number),
    about: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    kind: Schema.Literal("toggle"),
    about: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    kind: Schema.Literal("text"),
    about: Schema.optionalKey(Schema.String)
  })
])
export type SourceFilter = typeof SourceFilter.Type

export const SourceCapabilities = Schema.Struct({
  text: Schema.Boolean,
  tags: Schema.Struct({ include: Schema.Boolean, exclude: Schema.Boolean, suggest: Schema.Boolean }),
  filters: Schema.Array(SourceFilter),
  sorts: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, reversible: Schema.Boolean })),
  /** Which filter is the content rating, and the source's own anonymous default for it (§5.3). */
  ratings: Schema.optionalKey(Schema.Struct({ filterId: Schema.String, default: Schema.NullOr(Schema.String) })),
  paging: Schema.Literals(["cursor", "page"]),
  /** Labels for the numbers in a summary's `stats`, by key; the first is the main one. */
  stats: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })))
})
export type SourceCapabilities = typeof SourceCapabilities.Type

/** A range filter's bounds; either may be left open. */
const SourceRange = Schema.Struct({
  min: Schema.optionalKey(Schema.Number),
  max: Schema.optionalKey(Schema.Number)
})
/** A filter's value by its kind: a choice (or several), a range, a toggle, a text. */
export const SourceFilterValue = Schema.Union([Schema.String, Schema.Array(Schema.String), Schema.Boolean, SourceRange])
export type SourceFilterValue = typeof SourceFilterValue.Type

/** What the user asked the source for: only what they chose (§5.3). */
export const SourceQuery = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(500)),
  tags: Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(Schema.isMaxLength(50)),
  excludeTags: Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(Schema.isMaxLength(50)),
  filters: Schema.Record(Schema.String, SourceFilterValue),
  sort: Schema.NullOr(Schema.String),
  reverse: Schema.Boolean
})
export type SourceQuery = typeof SourceQuery.Type

export const emptySourceQuery: SourceQuery = {
  text: "",
  tags: [],
  excludeTags: [],
  filters: {},
  sort: null,
  reverse: false
}

/** A card's version on the source: its id (cardex: the file's SHA-256), and its successor. */
const RemoteVersion = Schema.Struct({
  id: Schema.String,
  updatedAt: Schema.optionalKey(Schema.Number),
  supersededBy: Schema.optionalKey(Schema.String)
})

/** A card as the source lists it. `thumb` and `image` are keys this server issued, never URLs. */
export const RemoteSummary = Schema.Struct({
  remoteId: Schema.String,
  name: Schema.String,
  creator: Schema.optionalKey(Schema.String),
  /** The creator as the source's creator filter takes it (cardex: `site/handle`), when it isn't the name. */
  creatorQuery: Schema.optionalKey(Schema.String),
  tagline: Schema.optionalKey(Schema.String),
  tags: Schema.Array(Schema.String),
  /** Its content rating, as the source words it; only when it isn't the source's default (safe) one. */
  rating: Schema.optionalKey(Schema.String),
  tokens: Schema.optionalKey(Schema.Number),
  thumb: Schema.optionalKey(Schema.String),
  image: Schema.optionalKey(Schema.String),
  version: RemoteVersion,
  url: Schema.optionalKey(Schema.String),
  stats: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  /** The user's own card for it (§3.7), when they have one. Never sent to the source. */
  held: Schema.optionalKey(
    Schema.Struct({
      entityId: Schema.String,
      refId: Schema.String,
      archived: Schema.Boolean,
      /** The source has a version other than the one added (§3.8). */
      update: Schema.Boolean
    })
  )
})
export type RemoteSummary = typeof RemoteSummary.Type

export const SourcePage = Schema.Struct({
  items: Schema.Array(RemoteSummary),
  next: Schema.NullOr(Schema.String),
  total: Schema.optionalKey(Schema.Number),
  /** The total is the source's estimate, not an exact count. */
  totalEstimated: Schema.optionalKey(Schema.Boolean)
})
export type SourcePage = typeof SourcePage.Type

export const SourceTag = Schema.Struct({
  tag: Schema.String,
  label: Schema.optionalKey(Schema.String),
  count: Schema.optionalKey(Schema.Number)
})

/** Why a request to a source failed, so the UI can word each case (§5.4). */
export const SourceFailure = Schema.Literals([
  "unreachable",
  "rate_limited",
  "unauthorized",
  "not_found",
  "bad_response",
  "disabled",
  /** The source won't give this card: cardex lists no download for it, or an anonymous source answered 401/403. */
  "refused"
])
export type SourceFailure = typeof SourceFailure.Type

export class SourceFailed extends Schema.TaggedError<SourceFailed>()("SourceFailed", {
  sourceId: Schema.String,
  reason: SourceFailure,
  /** For `rate_limited`: when to try again. */
  retryAfterMs: Schema.optionalKey(Schema.Number),
  /** For a refused request (`bad_response` from a 400): the source's own error code, when its answer named one. */
  code: Schema.optionalKey(Schema.String),
  message: Schema.String
}) {}

/** A source as this user has it: whether it's offered, and whether its key is set. */
export const SourceInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Turned off for every account by an admin: the user's switch is hidden. */
  adminDisabled: Schema.Boolean,
  /** The user's own switch ("Show cardex"), on by default (§9 D1). */
  userEnabled: Schema.Boolean,
  /** Offered in Show: neither switch is off. */
  enabled: Schema.Boolean,
  key: Schema.Literals(["none", "optional", "required"]),
  hasKey: Schema.Boolean,
  /** The content rating chosen last, for the next first search (§5.3); null: the source's default. */
  rating: Schema.NullOr(Schema.String)
})
export type SourceInfo = typeof SourceInfo.Type

export const SourceList = Schema.Struct({
  sources: Schema.Array(SourceInfo),
  /** Admins only: the instance's cache cap and what's used of it. */
  cache: Schema.optionalKey(Schema.Struct({ capBytes: Schema.Number, usedBytes: Schema.Number }))
})
export type SourceList = typeof SourceList.Type

/** A remote card the user opened, for "Recently viewed" (§4.1). No definitions. */
export const RecentRemote = Schema.Struct({
  sourceId: Schema.String,
  remoteId: Schema.String,
  name: Schema.String,
  creator: Schema.optionalKey(Schema.String),
  thumb: Schema.optionalKey(Schema.String),
  at: Schema.Number
})
export type RecentRemote = typeof RecentRemote.Type

/** A remote card opened: its parsed document as the importer reads it, and what the source said. */
const RemoteCard = Schema.Struct({
  summary: RemoteSummary,
  /** The card document as JSON text (`@rp/shared/docs/card.ts`), or null when it couldn't be read. */
  docJson: Schema.NullOr(Schema.String),
  /** The parser's report lines, for a card that couldn't be read. */
  problems: Schema.Array(Schema.String)
})

/** At most this many recently viewed cards are kept, newest first (§4.1). */
export const RECENT_REMOTE_MAX = 50

const SOURCE_ID = "[a-z0-9][a-z0-9-]{0,39}"
const REMOTE_ENTITY = new RegExp(`^src:(${SOURCE_ID}):([\\s\\S]+)$`)
const REMOTE_MEDIA = new RegExp(`^srcimg:(${SOURCE_ID}):([\\s\\S]+)$`)

/**
 * The id a card on a source has in a chat not made yet (§4.2), until it's added: a cast,
 * the side panel and the first send name it by this. The first send's `StartChat` adds the
 * card and puts the new card's id in its place.
 */
export const remoteEntityId = (sourceId: string, remoteId: string) => `src:${sourceId}:${remoteId}` as EntityId

/** The source and remote id under a placeholder id; null for any other id. */
export const remoteOf = (id: string): { readonly sourceId: string; readonly remoteId: string } | null => {
  const match = REMOTE_ENTITY.exec(id)
  return match ? { sourceId: match[1]!, remoteId: match[2]! } : null
}

/** A source card's picture as a media id (`avatarMediaId`): served by the source's image route, by the key the server issued. */
export const remoteMediaId = (sourceId: string, key: string) => `srcimg:${sourceId}:${key}`

export const remoteMediaOf = (id: string): { readonly sourceId: string; readonly key: string } | null => {
  const match = REMOTE_MEDIA.exec(id)
  return match ? { sourceId: match[1]!, key: match[2]! } : null
}

/** The sites cardex finds cards on, by its API v1 name (its `source` filter), as people call them. */
export const CARDEX_SITE_LABELS: Readonly<Record<string, string>> = {
  chub: "Chub",
  char_tavern: "Character Tavern",
  risuai: "RisuRealm",
  janitorai: "JanitorAI",
  venusai: "VenusAI",
  nyaime: "Nyai.me",
  booru: "Booru",
  webring: "Webring",
  catbox: "Catbox",
  generic: "Other sites",
  botbooru: "BotBooru",
  pygmalion: "Pygmalion",
  aicc: "AI Character Cards",
  backyard: "Backyard AI",
  wyvern: "Wyvern",
  pephop: "PepHop"
}

/** The account's card-source choices: user `settings` key `sources`. */
export const SourcePrefs = Schema.Struct({
  /** Turned off by the user, by source; a source not named here is on (§9 D1). */
  enabled: Schema.Record(Schema.String, Schema.Boolean),
  /** The credential holding each source's API key. */
  keys: Schema.Record(Schema.String, Schema.String),
  rating: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  recent: Schema.Array(RecentRemote)
})
export type SourcePrefs = typeof SourcePrefs.Type
export const DEFAULT_SOURCE_PREFS: SourcePrefs = { enabled: {}, keys: {}, rating: {}, recent: [] }

/** The instance's: app `settings` key `sources.admin`. */
export const SourceAdminSettings = Schema.Struct({
  disabled: Schema.Record(Schema.String, Schema.Boolean),
  capBytes: Schema.optionalKey(Schema.Number)
})
export type SourceAdminSettings = typeof SourceAdminSettings.Type

const sourceErrors = Schema.Union([SourceFailed, NotFound, ServerError])

/**
 * A card added from a card source, as its editor shows it (§3.8): which source card it is,
 * the version the user has, and the newer one the source reported, if any.
 */
export const CardOrigin = Schema.Struct({
  entityId: Schema.String,
  sourceId: Schema.String,
  sourceName: Schema.String,
  remoteId: Schema.String,
  /** The source's version the user has: the one added, or one taken since. */
  remoteVersion: Schema.String,
  /** The newest version the source reported, when it isn't that one: an update is waiting. */
  newerVersion: Schema.NullOr(Schema.String)
})
export type CardOrigin = typeof CardOrigin.Type

/** The header on the newer file's response (`GET /sources/held/<entityId>/file`): the version it is. */
export const REMOTE_VERSION_HEADER = "x-remote-version"
/**
 * The header on the newer file's response: the card's link back to its page on the source, which
 * the import route adds to the new version's `source` list when it's sent as `link` (§4.5).
 */
export const SOURCE_LINK_HEADER = "x-source-link"

export class CardSourcesApi extends RpcGroup.make(
  /** The registered sources as this user has them. Never contacts a source. */
  Rpc.make("ListCardSources", { success: SourceList, error: ServerError }),
  Rpc.make("SetCardSourceEnabled", {
    payload: { sourceId: SourceId, enabled: Schema.Boolean },
    success: SourceList,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Admins: turns a source off for every account. */
  Rpc.make("SetCardSourceAdminDisabled", {
    payload: { sourceId: SourceId, disabled: Schema.Boolean },
    success: SourceList,
    error: Schema.Union([NotFound, Forbidden, ServerError])
  }),
  /** Admins: the instance's cache cap. */
  Rpc.make("SetSourceCacheCap", {
    payload: { bytes: Schema.Int.check(Schema.isBetween({ minimum: 16 * 1024 * 1024, maximum: 1024 ** 4 })) },
    success: SourceList,
    error: Schema.Union([Forbidden, ServerError])
  }),
  /** The source's API key, write-only; null removes it. */
  Rpc.make("SetCardSourceKey", {
    payload: { sourceId: SourceId, key: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))) },
    success: SourceList,
    error: Schema.Union([NotFound, ServerError])
  }),
  Rpc.make("SetCardSourceRating", {
    payload: { sourceId: SourceId, rating: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))) },
    success: Schema.Void,
    error: Schema.Union([NotFound, ServerError])
  }),
  /** Clears this user's cached cards, pages and pictures and the recently viewed list. */
  Rpc.make("ClearSourceCache", {
    payload: { sourceId: Schema.NullOr(SourceId) },
    success: Schema.Void,
    error: ServerError
  }),
  Rpc.make("SourceCapabilities", { payload: { sourceId: SourceId }, success: SourceCapabilities, error: sourceErrors }),
  Rpc.make("SourceSearch", {
    payload: {
      sourceId: SourceId,
      query: SourceQuery,
      page: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000)))
    },
    success: SourcePage,
    error: sourceErrors
  }),
  Rpc.make("SourceTags", {
    payload: { sourceId: SourceId, prefix: Schema.String.check(Schema.isMaxLength(100)) },
    success: Schema.Array(SourceTag),
    error: sourceErrors
  }),
  /** Opens a remote card: fetched (or read from the cache) and parsed; recorded as recently viewed. */
  Rpc.make("SourceCard", {
    payload: { sourceId: SourceId, remoteId: Schema.String.check(Schema.isMaxLength(500)) },
    success: RemoteCard,
    error: sourceErrors
  }),
  /**
   * A remote card as the pending chat shows it (§4.2), under its placeholder id
   * (`remoteEntityId`), with its summary (`held` when the user has it already). Opening it
   * records it as recently viewed, as `SourceCard` does.
   */
  Rpc.make("SourceCardForChat", {
    payload: { sourceId: SourceId, remoteId: Schema.String.check(Schema.isMaxLength(500)) },
    success: Schema.Struct({ card: CardForChat, summary: RemoteSummary }),
    error: sourceErrors
  }),
  /**
   * Adds a remote card to the user's cards (§4.5, Add to my cards): the cached file (fetched
   * again if it was evicted), stored as an import of it is, with its origin. A card the user
   * already has from there is answered instead (`existing`), never added twice.
   */
  Rpc.make("AdoptRemoteCard", {
    payload: { sourceId: SourceId, remoteId: Schema.String.check(Schema.isMaxLength(500)) },
    success: Schema.Struct({
      entityId: Schema.String,
      refId: Schema.String,
      name: Schema.String,
      existing: Schema.Boolean
    }),
    error: sourceErrors
  }),
  /**
   * The card's origin when the user added it from a source that's on for them, else null.
   * Never contacts a source.
   */
  Rpc.make("CardOrigin", {
    payload: { entityId: Schema.String.check(Schema.isMaxLength(100)) },
    success: Schema.NullOr(CardOrigin),
    error: ServerError
  }),
  /** Check for a newer version (§3.8): asks the source for the card's current version. */
  Rpc.make("CheckRemoteVersion", {
    payload: { entityId: Schema.String.check(Schema.isMaxLength(100)) },
    success: CardOrigin,
    error: sourceErrors
  }),
  /**
   * The source's version the user took into the card, by Review and merge (once its file is
   * staged) or Replace: the update is no longer waiting. Never contacts a source.
   */
  Rpc.make("TakeRemoteVersion", {
    payload: {
      entityId: Schema.String.check(Schema.isMaxLength(100)),
      version: Schema.String.check(Schema.isMaxLength(500))
    },
    success: CardOrigin,
    error: sourceErrors
  }),
  /** Add as a separate card (§3.8): the source's newer version as a new card; the first card takes that version. */
  Rpc.make("AddRemoteVersionAsCard", {
    payload: { entityId: Schema.String.check(Schema.isMaxLength(100)) },
    success: Schema.Struct({ entityId: Schema.String, refId: Schema.String, name: Schema.String }),
    error: sourceErrors
  }),
  /** Never contacts a source. */
  Rpc.make("ListRecentRemote", {
    payload: { sourceId: SourceId },
    success: Schema.Array(RecentRemote),
    error: ServerError
  }),
  Rpc.make("ClearRecentRemote", { payload: { sourceId: SourceId }, success: Schema.Void, error: ServerError })
) {}
