// Authenticated, owner-scoped media proxy. Consent is checked on every read; no browser,
// shared or disk cache can outlive its revocation. The transport is a replaceable part.
import { CurrentUser } from "@rp/shared/api.ts"
import { ExternalMediaApi } from "@rp/shared/externalMedia.ts"
import { ChatId, EntityId } from "@rp/shared/chat.ts"
import { makeRegistry } from "@rp/shared/registry.ts"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Accounts } from "../auth/Accounts.ts"
import { Reader, Writer } from "../db/Database.ts"
import { internal } from "./internal.ts"
import { Network } from "../net/Network.ts"
import { makeExternalFetcher } from "../net/externalMedia.ts"

export class ExternalMedia extends Context.Service<
  ExternalMedia,
  {
    readonly fetchers: ReturnType<
      typeof makeRegistry<{ readonly id: string; readonly fetch: ReturnType<typeof makeExternalFetcher> }>
    >
  }
>()("rp/ExternalMedia") {
  static readonly layer = Layer.effect(
    ExternalMedia,
    Effect.gen(function* () {
      const network = yield* Network
      return { fetchers: makeRegistry([{ id: "media.external", fetch: makeExternalFetcher(network) }]) }
    })
  )
}
export const makeExternalMediaHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const writer = yield* Writer
  return {
    GetExternalMediaPrefs: () =>
      Effect.flatMap(CurrentUser, (user) => reader.GetExternalMediaPrefs({ userId: user.id })).pipe(
        internal("external media consent")
      ),
    SetExternalMedia: (input) =>
      Effect.flatMap(CurrentUser, (user) => writer.SetExternalMedia({ userId: user.id, ...input })).pipe(
        internal("external media consent")
      )
  } satisfies Parameters<typeof ExternalMediaApi.of>[0]
})
const error = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: message },
    {
      status,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" }
    }
  )
export const externalMediaRoute = Layer.unwrap(
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const reader = yield* Reader
    const media = yield* ExternalMedia
    return HttpRouter.add(
      "GET",
      "/media/external",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const session = yield* Effect.option(accounts.resolve(request.headers))
        if (Option.isNone(session)) return error(401, "Login required")
        const params = new URL(request.url, "http://media").searchParams
        const url = params.get("url")
        const chatId = params.get("chat")
        const cardId = params.get("card")
        if (
          !url ||
          url.length > 8192 ||
          (chatId === null && cardId === null) ||
          (chatId !== null && !Schema.is(ChatId)(chatId)) ||
          (cardId !== null && !Schema.is(EntityId)(cardId))
        )
          return error(400, "A media address and its card or chat are required")
        const allowed = yield* reader.CheckExternalMedia({
          userId: session.value.user.id,
          chatId: chatId as typeof ChatId.Type | null,
          cardId: cardId as typeof EntityId.Type | null
        })
        if (!allowed) return error(403, "Images from other sites are blocked")
        const fetcher = media.fetchers.get("media.external")
        if (!fetcher) return error(403, "External media is disabled")
        const result = yield* Effect.tryPromise({
          try: (signal) => fetcher.fetch(url, signal),
          catch: () => new Error("Media refused")
        }).pipe(Effect.option)
        if (Option.isNone(result)) return error(502, "This media could not be loaded safely")
        // Check again after I/O: revoking consent while a slow download runs takes effect too.
        if (
          !(yield* reader.CheckExternalMedia({
            userId: session.value.user.id,
            chatId: chatId as typeof ChatId.Type | null,
            cardId: cardId as typeof EntityId.Type | null
          }))
        )
          return error(403, "Images from other sites are blocked")
        return HttpServerResponse.uint8Array(result.value.bytes, {
          contentType: result.value.mime,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "cross-origin-resource-policy": "same-origin"
          }
        })
      }).pipe(
        Effect.catchTags({
          NotFound: () => Effect.succeed(error(404, "No such card or chat")),
          StorageError: () => Effect.succeed(error(500, "Could not read media consent"))
        })
      )
    )
  })
)
