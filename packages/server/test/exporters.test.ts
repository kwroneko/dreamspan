import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { ExportFormatInfo, ImportResult } from "@rp/shared/libraryImport.ts"
import { AppConfig } from "../src/config.ts"
import { PasswordCost } from "../src/auth/passwords.ts"
import * as ContextGenerator from "../src/chat/ContextGenerator.ts"
import * as Formats from "../src/importer/Formats.ts"
import { Summarizer } from "../src/lcm/Summarizer.ts"
import { Reader } from "../src/db/Database.ts"
import { serverWith } from "../src/server.ts"
import { testBundles } from "./support/bundles.ts"
import { client, post, serverPort, testConfig } from "./support/config.ts"
import { json, stCardV2 } from "./formats/support.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { tempDir } from "./support/tempDir.ts"
import { stalls } from "./support/liveness.ts"

const config = testConfig()
const server = serverWith(
  ContextGenerator.layer,
  Summarizer.layer,
  Formats.layer({
    workers: "source",
    size: 1,
    entry: new URL("./support/exportPluginWorker.ts", import.meta.url)
  })
).pipe(
  Layer.provide([
    Layer.succeed(AppConfig)(config),
    Layer.succeed(PasswordCost)({ n: 2 ** 10, r: 8, p: 1 }),
    testBundles
  ])
)

const text = (response: Response) => Effect.promise(() => response.text())

describe("exporter registration end to end", () => {
  it.live(
    "every pool worker and respawn installs the plugin; closing both scopes restores built-ins",
    () =>
      Effect.gen(function* () {
        const formats = yield* Formats.Formats
        const metadata = (yield* formats.listExports).find((entry) => entry.id === "card-v2-json")!
        assert.strictEqual(metadata.mime, "text/plain")
        assert.isFalse((yield* formats.listExports).some((entry) => entry.id === "card-png"))
        const round = (action: string) => {
          const directory = tempDir("export-barrier")
          return Effect.all(
            Array.from({ length: 2 }, () =>
              formats
                .export({
                  format: metadata.id,
                  expectedFormat: metadata,
                  docJson: JSON.stringify({ directory, action }),
                  noteDocJson: null,
                  notesDocJson: [],
                  avatar: null,
                  assets: []
                })
                .pipe(Effect.result)
            ),
            { concurrency: 2 }
          ).pipe(stalls(`export worker barrier: ${action}`))
        }
        const ids = (results: Effect.Success<ReturnType<typeof round>>) =>
          results.map((result) => {
            assert.strictEqual(result._tag, "Success")
            if (result._tag !== "Success") throw new Error("export failed")
            return new TextDecoder().decode(result.success)
          })
        const original = ids(yield* round("run"))
        assert.strictEqual(new Set(original).size, 2)
        for (const result of yield* round("crash")) {
          assert.strictEqual(result._tag, "Failure")
          if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "FormatWorkerFailed")
        }
        const replacements = ids(yield* round("run"))
        assert.strictEqual(new Set(replacements).size, 2)
        assert.isTrue(replacements.every((id) => !original.includes(id)))
        assert.deepStrictEqual(new Set(ids(yield* round("close"))), new Set(replacements))
        const restored = yield* formats.listExports
        assert.isTrue(restored.some((entry) => entry.id === "card-png"))
        assert.strictEqual(restored.find((entry) => entry.id === "card-v2-json")!.mime, "application/json")
        const card = yield* importCard(json(stCardV2()))
        const bytes = yield* formats.export({
          format: "card-v2-json",
          docJson: JSON.stringify(card.card),
          noteDocJson: null,
          notesDocJson: [],
          avatar: null,
          assets: []
        })
        assert.strictEqual(JSON.parse(new TextDecoder().decode(bytes)).data.name, "Wren")
      }).pipe(
        Effect.provide(
          Formats.layer({
            workers: "source",
            size: 2,
            entry: new URL("./support/exportPoolWorker.ts", import.meta.url)
          })
        )
      ),
    60_000
  )

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
        // A queued export may run after its catalog's plugin scope closed, including
        // on another worker. It must refuse stale metadata instead of mislabelling bytes.
        const formats = yield* Formats.Formats
        const reader = yield* Reader
        const user = yield* api.Whoami()
        const source = yield* reader.ExportSource({ userId: user.id, refId })
        const stale = {
          format: "card-v2-json",
          expectedFormat: catalog.find((entry) => entry.id === "card-v2-json")!,
          docJson: source.docJson,
          noteDocJson: null,
          notesDocJson: [],
          avatar: null,
          assets: []
        }
        const changed = yield* formats.export(stale).pipe(Effect.flip)
        assert.strictEqual(changed._tag, "ExportRefused")
        assert.include(changed.message, "changed")
        const png = yield* post("/library/export", { refId, format: "card-png" })
        assert.strictEqual(png.status, 200)
        assert.include(png.headers.get("content-type"), "image/png")
      }).pipe(Effect.scoped, Effect.provide(server)),
    120_000
  )
})
