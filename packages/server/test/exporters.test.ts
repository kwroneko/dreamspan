import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { ExportFormatInfo, ImportResult } from "@rp/shared/libraryImport.ts"
import { AppConfig } from "../src/config.ts"
import { PasswordCost } from "../src/auth/passwords.ts"
import * as ContextGenerator from "../src/chat/ContextGenerator.ts"
import * as Formats from "../src/importer/Formats.ts"
import { Summarizer } from "../src/lcm/Summarizer.ts"
import { serverWith } from "../src/server.ts"
import { client, post, serverPort, testConfig } from "./support/config.ts"
import { json, stCardV2 } from "./formats/support.ts"

const config = testConfig()
const server = serverWith(
  ContextGenerator.layer,
  Summarizer.layer,
  Formats.layer({
    workers: "source",
    size: 1,
    entry: new URL("./support/exportPluginWorker.ts", import.meta.url)
  })
).pipe(Layer.provide([Layer.succeed(AppConfig)(config), Layer.succeed(PasswordCost)({ n: 2 ** 10, r: 8, p: 1 })]))

const text = (response: Response) => Effect.promise(() => response.text())

describe("exporter registration end to end", () => {
  it.live(
    "offers and accepts a new format, runs an override, and restores built-ins when its scope closes",
    () =>
      Effect.gen(function* () {
        const port = yield* serverPort
        const api = yield* client()
        const catalog = yield* api.ListExportFormats()
        // This is the catalog the library client renders; only data crosses the worker/RPC boundaries.
        Schema.decodeUnknownSync(Schema.Array(ExportFormatInfo))(catalog)
        assert.deepStrictEqual(
          catalog.filter((entry) => entry.id === "synthetic-text"),
          [
            {
              id: "synthetic-text",
              kind: "card",
              label: "Synthetic text",
              mime: "text/plain",
              extension: "txt",
              media: "none"
            }
          ]
        )
        assert.isFalse(catalog.some((entry) => entry.id === "card-png"))
        const upload = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${port}/library/import?name=synthetic.json`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: json(stCardV2())
          })
        )
        assert.strictEqual(upload.status, 200)
        const imported = Schema.decodeUnknownSync(ImportResult)(yield* Effect.promise(() => upload.json()))
        const refId = imported.library!.ref.id
        const extra = yield* post("/library/export", { refId, format: "synthetic-text" })
        assert.strictEqual(extra.status, 200)
        assert.include(extra.headers.get("content-type"), "text/plain")
        assert.include(extra.headers.get("content-disposition"), 'filename="Wren.txt"')
        assert.strictEqual(extra.headers.get("x-content-type-options"), "nosniff")
        assert.strictEqual(extra.headers.get("cache-control"), "no-store")
        assert.strictEqual(yield* text(extra), "synthetic alternative")
        for (const format of ["card-png", "unknown", "st-preset"]) {
          assert.strictEqual((yield* post("/library/export", { refId, format })).status, 400)
        }
        const override = yield* post("/library/export", { refId, format: "card-v2-json" })
        assert.strictEqual(override.status, 200)
        assert.include(override.headers.get("content-disposition"), 'filename="Wren.txt"')
        assert.strictEqual(yield* text(override), "overridden, then scope closed")
        const restored = yield* api.ListExportFormats()
        assert.isFalse(restored.some((entry) => entry.id === "synthetic-text"))
        assert.deepStrictEqual(
          restored.map((entry) => entry.id),
          ["card-png", "card-v2-json", "card-v3-json", "card-charx", "st-world-info", "st-preset"]
        )
        assert.strictEqual((yield* post("/library/export", { refId, format: "synthetic-text" })).status, 400)
        const original = yield* post("/library/export", { refId, format: "card-v2-json" })
        assert.strictEqual(original.status, 200)
        assert.include(original.headers.get("content-type"), "application/json")
        assert.include(original.headers.get("content-disposition"), 'filename="Wren.json"')
        assert.strictEqual(JSON.parse(yield* text(original)).data.name, "Wren")
        const png = yield* post("/library/export", { refId, format: "card-png" })
        assert.strictEqual(png.status, 200)
        assert.include(png.headers.get("content-type"), "image/png")
      }).pipe(Effect.scoped, Effect.provide(server)),
    120_000
  )
})
