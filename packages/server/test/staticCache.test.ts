// The client build's caching: pages revalidate on every load, hashed assets are kept.
import { mkdirSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { serverPort, testConfig, withServer } from "./support/config.ts"
import { tempDir } from "./support/tempDir.ts"

interface Reply {
  readonly status: number
  readonly cacheControl: unknown
  readonly etag: unknown
  readonly body: string
}

const get = (path: string, headers: Record<string, string> = {}) =>
  Effect.flatMap(serverPort, (port) =>
    Effect.callback<Reply, Error>((resume) => {
      const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => (body += chunk))
        res.on("end", () =>
          resume(
            Effect.succeed({
              status: res.statusCode ?? 0,
              cacheControl: res.headers["cache-control"],
              etag: res.headers["etag"],
              body
            })
          )
        )
      })
      req.on("error", (error) => resume(Effect.fail(error)))
      req.end()
    })
  )

const IMMUTABLE = "public, max-age=31536000, immutable"

describe("static file caching", () => {
  it.live("pages and unhashed files revalidate; hashed assets are immutable", () => {
    const clientDist = tempDir("client")
    mkdirSync(join(clientDist, "assets"), { recursive: true })
    writeFileSync(join(clientDist, "index.html"), "<!doctype html><title>t</title>")
    writeFileSync(join(clientDist, "assets", "index-AbC123de.js"), "/* app */")
    writeFileSync(join(clientDist, "favicon.svg"), "<svg/>")
    const config = testConfig({ clientDist })
    return Effect.gen(function* () {
      const html = { Accept: "text/html" }
      for (const path of ["/", "/chats/some-chat/branch/abc"]) {
        const page = yield* get(path, html)
        assert.strictEqual(page.status, 200, path)
        assert.include(page.body, "<title>t</title>", path)
        assert.strictEqual(page.cacheControl, "no-cache", path)
        // Revalidation is cheap: the ETag answers a 304 that keeps the policy.
        assert.isString(page.etag, path)
        const again = yield* get(path, { ...html, "If-None-Match": String(page.etag) })
        assert.strictEqual(again.status, 304, path)
        assert.strictEqual(again.cacheControl, "no-cache", path)
      }

      const asset = yield* get("/assets/index-AbC123de.js")
      assert.strictEqual(asset.status, 200)
      assert.strictEqual(asset.cacheControl, IMMUTABLE)
      const revalidated = yield* get("/assets/index-AbC123de.js", { "If-None-Match": String(asset.etag) })
      assert.strictEqual(revalidated.status, 304)
      assert.strictEqual(revalidated.cacheControl, IMMUTABLE)

      assert.strictEqual((yield* get("/favicon.svg")).cacheControl, "no-cache")
      // A path that only climbs out of /assets/ is the page, not an immutable asset.
      const climbed = yield* get("/assets/..%2findex.html")
      assert.notStrictEqual(climbed.cacheControl, IMMUTABLE)
      // A missing asset is a 404 with no long-lived caching, and never the SPA page.
      const missing = yield* get("/assets/gone", html)
      assert.strictEqual(missing.status, 404)
      assert.notStrictEqual(missing.cacheControl, IMMUTABLE)
    }).pipe(withServer(config))
  })
})
