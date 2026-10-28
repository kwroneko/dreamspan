// The ST folder import's registered parts (PLUGINS §8): a plugin registers a folder handler
// and a worker parser in a scope as it would, they take effect, and the built-ins are back
// when the scope closes.
import { assert, describe, it, layer } from "@effect/vitest"
import { StFileResult } from "@rp/shared/stImportApi.ts"
import { Effect, Exit, Scope } from "effect"
import { StImports } from "../src/importer/StImports.ts"
import * as Importers from "../src/importer/importers.ts"
import * as StParse from "../src/importer/stParse.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { sendStFile } from "./support/stUpload.ts"

const settings = new TextEncoder().encode(JSON.stringify({ power_user: {} }))

describe("the ST worker parsers", () => {
  it.effect("a registered chat-part parser replaces the built-in until its scope closes", () =>
    Effect.gen(function* () {
      const parsers = yield* StParse.StParserRegistry
      const input = { bytes: new TextEncoder().encode(""), first: true, firstIndex: 0, carryAt: null }
      const read = () => StParse.stParser(parsers, "chat-part")!(input).pipe(Effect.provide(Importers.layer))
      assert.notStrictEqual((yield* read()).messages, 7)
      const scope = yield* Scope.make()
      yield* parsers
        .register({
          id: "chat-part",
          run: (i) => Effect.map(StParse.parseChatPart(i), (part) => Object.assign(part, { messages: 7 }))
        })
        .pipe(Scope.provide(scope))
      assert.strictEqual((yield* read()).messages, 7)
      yield* parsers.disable("settings").pipe(Scope.provide(scope))
      assert.strictEqual(parsers.get("settings"), undefined)
      yield* Scope.close(scope, Exit.void)
      assert.notStrictEqual((yield* read()).messages, 7)
      assert.notStrictEqual(parsers.get("settings"), undefined)
    }).pipe(Effect.provide(StParse.layer))
  )
})

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "60 seconds" })("ST folder handlers", (it) => {
  it.effect("a registered folder handler takes a file kind over, and the built-in is back after the scope", () =>
    Effect.gen(function* () {
      const imports = yield* StImports
      const { importId } = yield* (yield* client()).StartStImport({ unsupported: [] })
      const scope = yield* Scope.make()
      yield* imports.handlers
        .register({
          id: "settings",
          run: () => Effect.succeed(new StFileResult({ outcome: "skipped", message: "plugin" }))
        })
        .pipe(Scope.provide(scope))
      assert.strictEqual((yield* sendStFile(importId, "settings.json", settings)).message, "plugin")
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual((yield* sendStFile(importId, "settings.json", settings)).outcome, "added")
    })
  )
})
