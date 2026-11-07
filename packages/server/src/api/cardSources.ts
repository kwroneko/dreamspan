// The card-source RPCs (spec/CARD-SOURCES.md §6.1) and the image route (§3.4): authenticated
// and owner-scoped like every RPC. The source is reached only through the CardSources service.
import { CurrentUser } from "@rp/shared/api.ts"
import type { CardSourcesApi } from "@rp/shared/cardSources.ts"
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
    SourceCard: ({ sourceId, remoteId }) => withUser((user) => sources.card(user, sourceId, remoteId)),
    SourceCardForChat: ({ sourceId, remoteId }) => withUser((user) => sources.forChat(user, sourceId, remoteId)),
    AdoptRemoteCard: ({ sourceId, remoteId }) => withUser((user) => sources.adopt(user, sourceId, remoteId)),
    ListRecentRemote: ({ sourceId }) => withUser((user) => sources.recent(user, sourceId)),
    ClearRecentRemote: ({ sourceId }) => withUser((user) => sources.clearRecent(user, sourceId))
  } satisfies Parameters<typeof CardSourcesApi.of>[0]
})

const jsonError = (status: number, message: string) => HttpServerResponse.jsonUnsafe({ error: message }, { status })

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
            Effect.succeed(
              jsonError(error.reason === "rate_limited" ? 429 : error.reason === "disabled" ? 403 : 502, error.message)
            ),
          ServerError: (error) => Effect.succeed(jsonError(500, error.message))
        })
      )
    )
  })
)
