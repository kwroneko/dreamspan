import { Authentication, CurrentUser, Unauthorized } from "@rp/shared/api.ts"
import type { User } from "@rp/shared/domain.ts"
import { Effect, Layer } from "effect"
import { AppConfig } from "./config.ts"
import { Writer } from "./db/Database.ts"

const SINGLE_USER_HANDLE = "local"

/**
 * Resolves the user for every RPC. Over the WebSocket, the headers are those of the
 * upgrade request, so a reverse proxy's identity header applies to the whole connection.
 */
export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const writer = yield* Writer
    // Users are created on first sight and never change handle, so a per-process cache
    // keeps authentication off the writer after the first request.
    const known = new Map<string, User>()

    const resolve = (handle: string) => {
      const cached = known.get(handle)
      if (cached) return Effect.succeed(cached)
      return writer.EnsureUser({ handle, displayName: handle }).pipe(
        Effect.tap((user) => Effect.sync(() => known.set(handle, user))),
        Effect.mapError((error) => new Unauthorized({ message: `could not load user: ${error.message}` }))
      )
    }

    const header = config.authProxyHeader.toLowerCase()

    return Authentication.of((effect, { headers }) => {
      const handle = config.authMode === "single" ? SINGLE_USER_HANDLE : headers[header]
      if (!handle) {
        return Effect.fail(new Unauthorized({ message: `missing ${config.authProxyHeader} header` }))
      }
      return resolve(handle).pipe(Effect.flatMap((user) => Effect.provideService(effect, CurrentUser, user)))
    })
  })
)
