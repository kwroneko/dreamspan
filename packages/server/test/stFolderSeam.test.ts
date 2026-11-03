// The ST folder import's registered parts (PLUGINS §8): a plugin registers a folder handler
// and a worker parser in a scope as it would, they take effect, and the built-ins are back
// when the scope closes.
import { assert, describe, it, layer } from "@effect/vitest"
import { StFileResult } from "@rp/shared/stImportApi.ts"
import { Effect, Exit, Scope } from "effect"
import { inject } from "vitest"
import { StImports, type StFolderCall } from "../src/importer/StImports.ts"
import * as Formats from "../src/importer/Formats.ts"
import { StParserRegistry } from "../src/importer/stParserRegistry.ts"
import type * as Plugin from "./support/stParserPlugin.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { sendStFile } from "./support/stUpload.ts"

const settings = new TextEncoder().encode(JSON.stringify({ power_user: {} }))
const source = (exportName: keyof typeof Plugin) => ({
  module: new URL("./support/stParserPlugin.ts", import.meta.url).href,
  exportName
})

for (const workers of ["source", "bundle"] as const) {
  describe(`the ST parsers in ${workers} workers`, () => {
    it.effect(
      "scoped registrations and disablement reach every worker and restore the built-in",
      () =>
        Effect.gen(function* () {
          const parsers = yield* StParserRegistry
          const formats = yield* Formats.Formats
          const read = () => formats.st.chatPart({ bytes: new Uint8Array(), first: true, firstIndex: 0, carryAt: null })
          assert.strictEqual((yield* read()).messages, 0)
          // The entry is resolved when a job runs, even if its Effect was created earlier.
          const pending = read()
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* parsers.register({ id: "chat-part", ...source("chatPart") })
              assert.strictEqual(parsers.get("chat-part")?.module, source("chatPart").module)
              assert.strictEqual((yield* pending).messages, 7)
              const parts = yield* Effect.all([read(), read(), read(), read()], { concurrency: 4 })
              assert.deepStrictEqual(
                parts.map((p) => p.messages),
                [7, 7, 7, 7]
              )
              yield* Effect.scoped(
                Effect.gen(function* () {
                  yield* parsers.register({ id: "chat-part", ...source("crash") })
                  const crashed = yield* Effect.exit(read())
                  assert.isTrue(Exit.isFailure(crashed) && crashed.cause.toString().includes("FormatWorkerFailed"))
                })
              )
              // The replacement worker sees the still-active plugin, not only its built-ins.
              assert.strictEqual((yield* read()).messages, 7)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  yield* parsers.disable("chat-part")
                  const disabled = yield* read()
                  assert.strictEqual(disabled.messages, 0)
                  assert.strictEqual(disabled.report.issues[0]?.code, "st.parser_disabled")
                })
              )
              assert.strictEqual((yield* read()).messages, 7)
            })
          )
          assert.strictEqual((yield* read()).messages, 0)
          yield* Effect.scoped(
            Effect.gen(function* () {
              for (const id of ["settings", "group", "library-file", "persona"] as const) yield* parsers.disable(id)
              const results = [
                (yield* formats.st.settings(new Uint8Array())).report,
                (yield* formats.st.group(new Uint8Array(), "group.json")).report,
                (yield* formats.st.libraryFile(new Uint8Array(), "card.json", "card")).parsed.report,
                (yield* formats.st.persona(new Uint8Array(), "avatar.png", null)).report
              ]
              assert.deepStrictEqual(
                results.map((r) => r.issues[0]?.code),
                Array(4).fill("st.parser_disabled")
              )
            })
          )
        }).pipe(
          Effect.provide(
            Formats.layer({ workers, size: 2, ...(workers === "bundle" ? { bundleDir: inject("bundleDir") } : {}) })
          )
        ),
      60_000
    )
  })
}

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "60 seconds" })("ST folder handlers", (it) => {
  it.effect("a parser registered on the server changes uploads until its scope closes", () =>
    Effect.gen(function* () {
      const parsers = yield* StParserRegistry
      const api = yield* client()
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* parsers.register({ id: "settings", ...source("settings") })
          const { importId } = yield* api.StartStImport({ unsupported: [] })
          assert.strictEqual((yield* sendStFile(importId, "settings.json", settings)).outcome, "added")
          const report = yield* api.GetStImportReport({ importId })
          assert.isFalse(report.issues.some((i) => i.code === "st.preset_missing"))
          yield* parsers.disable("settings")
          assert.strictEqual((yield* sendStFile(importId, "settings.json", settings)).outcome, "failed")
          assert.isTrue(
            (yield* api.GetStImportReport({ importId })).issues.some((i) => i.code === "st.parser_disabled")
          )
          yield* api.FinishStImport({ importId, notSent: [] })
          assert.isTrue(
            (yield* api.GetStImportReport({ importId })).issues.some(
              (i) => i.code === "st.preset_missing" && i.message.includes("Plugin preset")
            )
          )
        })
      )
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      assert.strictEqual((yield* sendStFile(importId, "settings.json", settings)).outcome, "added")
      assert.isFalse(
        (yield* api.GetStImportReport({ importId })).issues.some((i) => i.message.includes("Plugin preset"))
      )
    })
  )

  it.effect("a registered folder handler takes a file kind over, and the built-in is back after the scope", () =>
    Effect.gen(function* () {
      const imports = yield* StImports
      const { importId } = yield* (yield* client()).StartStImport({ unsupported: [] })
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      yield* imports.handlers
        .register({
          id: "settings",
          run: (_call: StFolderCall) => Effect.succeed(new StFileResult({ outcome: "skipped", message: "plugin" }))
        })
        .pipe(Scope.provide(scope))
      assert.strictEqual((yield* sendStFile(importId, "settings.json", settings)).message, "plugin")
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual((yield* sendStFile(importId, "settings.json", settings)).outcome, "added")
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* imports.handlers.disable("settings")
          const disabled = yield* sendStFile(importId, "settings.json", settings)
          assert.strictEqual(disabled.outcome, "failed")
          assert.match(disabled.message, /settings.*disabled/)
          const report = yield* (yield* client()).GetStImportReport({ importId })
          assert.isTrue(report.issues.some((i) => i.code === "st.handler_disabled"))
        })
      )
      assert.strictEqual((yield* sendStFile(importId, "settings.json", settings)).outcome, "added")
    })
  )
})
