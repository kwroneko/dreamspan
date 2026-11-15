// Only checked generated modules for an enabled exact commit are executable assets.
import { Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Accounts } from "../auth/Accounts.ts"
import { AppConfig } from "../config.ts"
import { PluginHost } from "./Host.ts"

const headers = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin"
}
const missing = () => HttpServerResponse.empty({ status: 404, headers })
export const pluginRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const host = yield* PluginHost
    const config = yield* AppConfig
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const session = yield* Effect.option(accounts.resolve(request.headers))
      if (Option.isNone(session)) return HttpServerResponse.empty({ status: 401, headers })
      // A persistent worker could answer later navigations without consulting
      // the current pin or account. These routes serve page modules only.
      if (request.headers["service-worker"] !== undefined) return missing()
      // Never decode asset paths: percent escapes and any noncanonical spelling fail closed.
      const path = request.url.split("?")[0]!
      if (path === "/plugins/client.json") {
        const plugins = yield* host.clients(session.value.user)
        return HttpServerResponse.jsonUnsafe(plugins, { headers })
      }
      if (path === "/plugin-host.mjs" || path === "/plugin-display.mjs") {
        const body = yield* Effect.tryPromise(async () => {
          const manifest = JSON.parse(
            await readFile(
              join(
                config.clientDist,
                path === "/plugin-display.mjs" ? ".vite/display-manifest.json" : ".vite/manifest.json"
              ),
              "utf8"
            )
          ) as Record<string, { file: string }>
          const display = path === "/plugin-display.mjs"
          const file = manifest[display ? "src/pluginDisplay.ts" : "src/pluginHost.ts"]?.file
          if (!file || !/^assets\/[a-zA-Z0-9_-]+\.js$/.test(file)) throw new Error("Missing host")
          return `export * from "/${file}";${display ? "" : ` export { default } from "/${file}";`}`
        }).pipe(Effect.option)
        return Option.isSome(body)
          ? HttpServerResponse.text(body.value, { headers, contentType: "text/javascript" })
          : missing()
      }
      const match = /^\/plugins\/(instance|user)\/([a-z][a-z0-9-]{0,63})\/([a-f0-9]{40})\/client\.mjs$/.exec(path)
      if (!match) return missing()
      const bytes = yield* host
        .clientAsset(session.value.user, { scope: match[1] as "instance" | "user", id: match[2]!, commit: match[3]! })
        .pipe(Effect.option)
      return Option.isSome(bytes)
        ? HttpServerResponse.uint8Array(bytes.value, { headers, contentType: "text/javascript" })
        : missing()
    }).pipe(Effect.catchCause(() => Effect.succeed(missing())))
    return Layer.mergeAll(
      HttpRouter.add("GET", "/plugin-host.mjs", handler),
      HttpRouter.add("GET", "/plugin-display.mjs", handler),
      HttpRouter.add("GET", "/plugins/*", handler)
    )
  })
)
