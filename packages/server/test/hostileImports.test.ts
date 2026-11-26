import { Effect } from "effect"
import { assert, describe, it } from "@effect/vitest"
import { importCard } from "../src/formats/cardImport.ts"
import { defaultLimits, FormatError } from "../src/formats/safety.ts"
import { cardChunk, cardV3, json, png, textChunk, zip } from "./formats/support.ts"
import { client, testConfig, withServer } from "./support/config.ts"
import { sendFile, sendStFile } from "./support/stUpload.ts"

const deepArrays = "[".repeat(4_096) + "0" + "]".repeat(4_096)
const deepObjects = '{"next":'.repeat(4_096) + "0" + "}".repeat(4_096)
const nestedJson = (value: string) => Buffer.from(`{"name":"Fixture","nested":${value}}`)

const rejects = <A>(effect: Effect.Effect<A, FormatError>, code: string) => {
  const error = Effect.runSync(Effect.flip(effect))
  assert.instanceOf(error, FormatError)
  assert.strictEqual(error.code, code)
  assert.isAtMost(error.message.length, 256)
}

describe("hostile imports", () => {
  it.each([
    ["arrays", deepArrays],
    ["objects", deepObjects]
  ])("rejects deeply nested card JSON (%s)", (_, nested) => {
    rejects(importCard(nestedJson(nested)), "json.too_deep")
  })

  it.each(["chara", "ccv3"])("rejects a %s payload before base64 decoding past the card limit", (keyword) => {
    const bytes = Buffer.from(JSON.stringify({ name: "Fixture", description: "x".repeat(32_768) }))
    const file = png(textChunk(keyword, bytes.toString("base64")))
    rejects(importCard(file, { ...defaultLimits, maxCardJsonBytes: 1024 }), "png.card_too_large")

    // Both limits allow the same final base64 quartet, so the decoded length still needs checking.
    const small = Buffer.from(json({ name: "Fixture" }))
    const capped = { ...defaultLimits, maxCardJsonBytes: small.byteLength - 1 }
    const smallPng = png(textChunk(keyword, small.toString("base64")))
    rejects(importCard(smallPng, capped), "json.too_large")
    assert.strictEqual(
      Effect.runSync(importCard(smallPng, { ...capped, maxCardJsonBytes: small.byteLength })).card.name,
      "Fixture"
    )
  })

  it.each(["tEXt", "iTXt", "zTXt"])("bounds the size and checks the framing of %s chunks", (type) => {
    const valid = png(cardChunk("ccv3", cardV3()))
    const header = Buffer.alloc(12)
    header.write(type, 4, "ascii")
    const prefix = valid.subarray(0, valid.length - 12)
    header.writeUInt32BE(defaultLimits.maxPngChunkBytes + 1)
    rejects(importCard(Buffer.concat([prefix, header])), "png.chunk_too_large")
    header.writeUInt32BE(1)
    rejects(importCard(Buffer.concat([prefix, header])), "png.truncated")
  })

  it("rejects a compressed CHARX card at both the uncompressed size and ratio limits", () => {
    const card = cardV3()
    const data = json({ ...card, data: { ...card.data, description: "x".repeat(2 * 1024 * 1024) } })
    const bytes = zip([{ name: "card.json", data }])
    assert.isBelow(bytes.byteLength, 10 * 1024)
    rejects(importCard(bytes, { ...defaultLimits, maxZipEntryBytes: data.byteLength - 1 }), "zip.entry_too_large")
    rejects(importCard(bytes), "zip.ratio")
  })

  it.each(["../../etc/passwd", "/outside/card.json"])("rejects the unsafe CHARX entry %s", (name) => {
    const bytes = zip([
      { name: "card.json", data: json(cardV3()) },
      { name, data: Buffer.from("fixture") }
    ])
    rejects(importCard(bytes), "zip.unsafe_path")
  })
})

it.live("refuses hostile SillyTavern folder uploads and continues with a valid card", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const { importId } = yield* api.StartStImport({ unsupported: [] })
    const card = json(cardV3())
    const unsafeArchive = zip([
      { name: "card.json", data: card },
      { name: "../outside.png", data: png() }
    ])

    for (const path of ["../../settings.json", "/settings.json", "ST-folder.zip"]) {
      const response = yield* sendFile(importId, path, unsafeArchive)
      assert.strictEqual(response.status, 400)
      const body = yield* Effect.promise(() => response.text())
      assert.include(body, "isn't a file the import reads")
    }
    const settings = yield* sendStFile(importId, "settings.json", nestedJson(deepObjects))
    assert.strictEqual(settings.outcome, "failed")
    const rejectedCard = yield* sendStFile(importId, "characters/Unsafe.charx", unsafeArchive)
    assert.strictEqual(rejectedCard.outcome, "failed")
    const accepted = yield* sendStFile(importId, "characters/Moss.json", card)
    assert.strictEqual(accepted.outcome, "added")
    yield* api.FinishStImport({ importId, notSent: [] })
    const { report } = yield* api.GetStImport({ importId })
    assert.sameDeepMembers(
      report!.issues.filter(({ level }) => level === "error").map(({ path, code }) => [path, code]),
      [
        ["settings.json", "json.too_deep"],
        ["characters/Unsafe.charx", "zip.unsafe_path"]
      ]
    )
  }).pipe(withServer(testConfig()))
)
