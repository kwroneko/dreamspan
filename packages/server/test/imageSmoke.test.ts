import { describe, expect, it } from "vitest"
import sharp from "sharp"
import { Effect } from "effect"
import manifest from "../../../package.json" with { type: "json" }
import {
  bundleExternals,
  IMAGE_SMOKE_FLAGS,
  syntheticCard,
  syntheticPng,
  checkRefusal
} from "../../../scripts/image-smoke.ts"
import { readChunks, decodeText } from "../src/formats/png.ts"
import { defaultLimits } from "../src/formats/safety.ts"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import * as FakeGenerator from "../src/dev/fakeGenerator.ts"

describe("final image smoke", () => {
  it("finds bundle externals without mistaking SQL or prose for imports", () => {
    const code = `import sharp from "sharp"; export {x} from "node:fs";
      const sql = 'SELECT imported_from "not-a-module"';
      const prose = 'from "also-not-a-module"';
      async function load() { return import("tiktoken") }
      const local = import("./reader.mjs"); const dynamic = import(variable);
      const llama = require("llama3-tokenizer-js");`
    expect(bundleExternals(code)).toEqual(["llama3-tokenizer-js", "node:fs", "sharp", "tiktoken"])
  })
  it("generates a decodable PNG carrying exactly the synthetic card", async () => {
    const card = syntheticCard("Synthetic smoke")
    const png = syntheticPng(card)
    const text = readChunks(png, defaultLimits).find((c) => c.type === "tEXt")!
    const decoded = decodeText(text.data)
    expect(decoded.keyword).toBe("chara")
    expect(JSON.parse(Buffer.from(decoded.text, "base64").toString())).toEqual(card)
    expect(await sharp(png).raw().toBuffer()).toEqual(Buffer.from([128, 128, 128]))
  })
  it("accepts only a plain application refusal, rejecting Docker errors, success, stacks and paths", () => {
    const plain =
      "Error: FAKE_CARD_SOURCE=fake needs the development files (src/dev), which this build doesn't include."
    expect(() => checkRefusal(1, plain, "FAKE_CARD_SOURCE")).not.toThrow()
    for (const code of [0, 125, 126, 127]) expect(() => checkRefusal(code, plain, "FAKE_CARD_SOURCE")).toThrow()
    for (const suffix of [
      "\n at run (/app/src/main.ts:1:1)",
      "\n at loader:1:1",
      "\n/app/src/dev/fake.ts",
      "\nERR_MODULE_NOT_FOUND",
      "\nListening on 8080"
    ]) {
      expect(() => checkRefusal(1, plain + suffix, "FAKE_CARD_SOURCE")).toThrow()
    }
    expect(() => checkRefusal(1, "docker failed", "FAKE_CARD_SOURCE")).toThrow()
  })
  for (const fake of [false, true]) {
    it(`health reports the installed ${fake ? "fake" : "provider"} generator with dev flags set`, async () => {
      const config = testConfig()
      const program = Effect.gen(function* () {
        const api = yield* client()
        const health = yield* api.Health()
        const port = yield* serverPort
        const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/healthz`))
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.text())).toBe("ok")
        expect(response.headers.get("cache-control")).toBe("no-store")
        expect(response.headers.get("x-app-version")).toBe(manifest.version)
        expect(health.version).toBe(manifest.version)
        expect(response.headers.get("x-generator-kind")).toBe(fake ? "fake" : "provider")
      })
      const previous = Object.fromEntries(Object.keys(IMAGE_SMOKE_FLAGS).map((key) => [key, process.env[key]]))
      Object.assign(process.env, IMAGE_SMOKE_FLAGS)
      try {
        await Effect.runPromise(
          program.pipe(
            Effect.scoped,
            Effect.provide(
              serverLayer(config, fake ? FakeGenerator.layer({ tokensPerSecond: 100, tokens: 10 }) : undefined)
            )
          )
        )
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    })
  }
})
