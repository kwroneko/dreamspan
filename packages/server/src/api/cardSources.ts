// The card-source RPCs (spec/CARD-SOURCES.md §6.1), the image route (§3.4) and the newer
// file's route (§3.8): authenticated and owner-scoped like every RPC. The source is reached
// only through the CardSources service.
import { CurrentUser } from "@rp/shared/api.ts"
import { type CardSourcesApi, REMOTE_VERSION_HEADER, SOURCE_LINK_HEADER } from "@rp/shared/cardSources.ts"
import { Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Accounts } from "../auth/Accounts.ts"
import { CardSources } from "../sources/CardSources.ts"

export const makeCardSourceHandlers = Effect.gen(function* () {
  const sources = yield* CardSources
  const withUser = <A, E, R>(run: (user: typeof CurrentUser.Service) => Effect.Effect<A, E, R>) =>
    Effect.flatMap(CurrentUser, run)
  const listed = withUser((user) => sources.list(user))
  return {
    ListCardSources: () => listed,
    SetCardSourceEnabled: ({ sourceId, enabled }) =>
      withUser((user) => sources.setEnabled(user, sourceId, enabled)).pipe(Effect.andThen(listed)),
    SetCardSourceAdminDisabled: ({ sourceId, disabled }) =>
      withUser((user) => sources.setAdminDisabled(user, sourceId, disabled)).pipe(Effect.andThen(listed)),
    SetSourceCacheCap: ({ bytes }) => withUser((user) => sources.setCap(user, bytes)).pipe(Effect.andThen(listed)),
    SetCardSourceKey: ({ sourceId, key }) =>
      withUser((user) => sources.setKey(user, sourceId, key)).pipe(Effect.andThen(listed)),
    SetCardSourceRating: ({ sourceId, rating }) => withUser((user) => sources.setRating(user, sourceId, rating)),
    ClearSourceCache: ({ sourceId }) => withUser((user) => sources.clearCache(user, sourceId)),
    SourceCapabilities: ({ sourceId }) => withUser((user) => sources.capabilities(user, sourceId)),
    SourceSearch: ({ sourceId, query, page }) => withUser((user) => sources.search(user, sourceId, query, page)),
    SourceTags: ({ sourceId, prefix }) => withUser((user) => sources.tags(user, sourceId, prefix)),
    SourceSuggestions: ({ sourceId, kind, prefix, page }) =>
      withUser((user) => sources.suggestions(user, sourceId, kind, prefix, page)),
    SourceCard: ({ sourceId, remoteId }) => withUser((user) => sources.card(user, sourceId, remoteId)),
    SourceCardForChat: ({ sourceId, remoteId }) => withUser((user) => sources.forChat(user, sourceId, remoteId)),
    AdoptRemoteCard: ({ sourceId, remoteId }) => withUser((user) => sources.adopt(user, sourceId, remoteId)),
    CardOrigin: ({ entityId }) => withUser((user) => sources.origin(user, entityId)),
    CheckRemoteVersion: ({ entityId }) => withUser((user) => sources.checkVersion(user, entityId)),
    TakeRemoteVersion: ({ entityId, version }) => withUser((user) => sources.takeVersion(user, entityId, version)),
    AddRemoteVersionAsCard: ({ entityId }) => withUser((user) => sources.addVersionAsCard(user, entityId)),
    SourceCreator: ({ sourceId, creator }) => withUser((user) => sources.creator(user, sourceId, creator)),
    SourceFamily: ({ sourceId, remoteId }) => withUser((user) => sources.family(user, sourceId, remoteId)),
    ListRecentRemote: ({ sourceId }) => withUser((user) => sources.recent(user, sourceId)),
    ClearRecentRemote: ({ sourceId }) => withUser((user) => sources.clearRecent(user, sourceId))
  } satisfies Parameters<typeof CardSourcesApi.of>[0]
})

const jsonError = (status: number, message: string) => HttpServerResponse.jsonUnsafe({ error: message }, { status })

const sourceStatus = (reason: string) =>
  reason === "region_unavailable"
    ? 451
    : reason === "rate_limited"
      ? 429
      : reason === "disabled"
        ? 403
        : reason === "not_found"
          ? 404
          : 502

/**
 * `GET /sources/held/<entityId>/file`: the newest file the source has of a card the user added
 * from it (§3.8), for Review and merge and the new-version dialog, which take it as they take
 * a file from disk. Its version is in `x-remote-version`, and the card's link back to its page
 * in `x-source-link`, for the import route's `link`. Fetched only when the user opens the update.
 */
export const newerFileRoute = Layer.unwrap(
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const sources = yield* CardSources
    return HttpRouter.add(
      "GET",
      "/sources/held/:entityId/file",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const session = yield* Effect.option(accounts.resolve(request.headers))
        if (Option.isNone(session)) return jsonError(401, "login required")
        const params = yield* HttpRouter.params
        const entityId = params.entityId ?? ""
        if (entityId === "" || entityId.length > 100) return jsonError(400, "not a card id")
        const file = yield* sources.newerFile(session.value.user, entityId)
        return HttpServerResponse.uint8Array(file.bytes, {
          contentType: "application/octet-stream",
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
            [REMOTE_VERSION_HEADER]: encodeURIComponent(file.version),
            [SOURCE_LINK_HEADER]: encodeURIComponent(file.link)
          }
        })
      }).pipe(
        Effect.catchTags({
          NotFound: () => Effect.succeed(jsonError(404, "there's no such card from a card source")),
          SourceFailed: (error) => Effect.succeed(jsonError(sourceStatus(error.reason), error.message)),
          ServerError: (error) => Effect.succeed(jsonError(500, error.message))
        })
      )
    )
  })
)

/**
 * `GET /sources/<id>/image?k=<key>&w=<px>`: a picture a result named, by the opaque key this
 * server issued for this user, so `img-src 'self'` holds and the browser never contacts the
 * source. Fetched, checked by its magic bytes, cached, and resized in the thumbnail lane.
 */
export const imageRoute = Layer.unwrap(
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const sources = yield* CardSources
    return HttpRouter.add(
      "GET",
      "/sources/:sourceId/image",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const session = yield* Effect.option(accounts.resolve(request.headers))
        if (Option.isNone(session)) return jsonError(401, "login required")
        const params = yield* HttpRouter.params
        // The key is in the query: it holds the source's whole ref, longer than a path segment may be.
        const search = new URL(request.url, "http://image").searchParams
        const key = search.get("k")
        if (key === null || key.length > 8192) return jsonError(400, "k must be an image key this server issued")
        const width = search.get("w")
        const pixels = width === null ? null : Number(width)
        if (pixels !== null && (!Number.isInteger(pixels) || pixels <= 0))
          return jsonError(400, "w must be a positive pixel width")
        const image = yield* sources.image(session.value.user, params.sourceId ?? "", key, pixels)
        const headers = {
          "cache-control": "private, max-age=86400",
          "x-content-type-options": "nosniff",
          etag: image.etag
        }
        if (request.headers["if-none-match"]?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === image.etag))
          return HttpServerResponse.empty({ status: 304, headers })
        return HttpServerResponse.uint8Array(image.bytes, { contentType: image.mime, headers })
      }).pipe(
        Effect.catchTags({
          NotFound: () => Effect.succeed(jsonError(404, "there's no such image")),
          SourceFailed: (error) =>
            Effect.succeed(jsonError(error.reason === "not_found" ? 502 : sourceStatus(error.reason), error.message)),
          ServerError: (error) => Effect.succeed(jsonError(500, error.message))
        })
      )
    )
  })
)
