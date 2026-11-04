// Importing and exporting files at the real boundary (ARCHITECTURE.md §11): a real server
// with its database and format workers, files uploaded over HTTP, and the library rows,
// files on disk and reports checked. Cross-user probes are in isolation.test.ts.
import sharp from "sharp"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { request } from "node:http"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { assert, describe, layer } from "@effect/vitest"
import type { LegacyPresetDoc as PresetDoc } from "@rp/shared/docs/preset.ts"
import { ImportResult } from "@rp/shared/libraryImport.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect, Option, Redacted, Schema } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { readChunks } from "../src/formats/png.ts"
import { defaultLimits } from "../src/formats/safety.ts"
import { cardChunk, chunk, json, png, run, stCardV2, worldInfo, zip } from "./formats/support.ts"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"

const config = testConfig()
/** The test server's address; its port is the one the kernel picked. */
const base = Effect.map(serverPort, (port) => `http://127.0.0.1:${port}`)

const upload = (bytes: Uint8Array, name: string, into?: RefId, headers: Record<string, string> = {}) =>
  Effect.flatMap(base, (url) =>
    Effect.promise(() =>
      fetch(`${url}/library/import?name=${encodeURIComponent(name)}${into ? `&into=${into}` : ""}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...headers },
        body: bytes
      })
    )
  )

const imported = (bytes: Uint8Array, name: string, into?: RefId) =>
  Effect.gen(function* () {
    const response = yield* upload(bytes, name, into)
    assert.strictEqual(response.status, 200, yield* Effect.promise(() => response.clone().text()))
    return Schema.decodeUnknownSync(ImportResult)(yield* Effect.promise(() => response.json()))
  })

const exported = (refId: RefId, format: string) =>
  Effect.flatMap(base, (url) =>
    Effect.promise(async () => {
      const response = await fetch(`${url}/library/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refId, format })
      })
      return { status: response.status, response, bytes: new Uint8Array(await response.arrayBuffer()) }
    })
  )

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const presetFile = (main: string) => {
  const preset = JSON.parse(readFileSync(new URL("./fixtures/presets/default.json", import.meta.url), "utf8"))
  preset.prompts.find((p: { identifier: string }) => p.identifier === "main").content = main
  return json(preset)
}

const mainPrompt = (doc: unknown) => (doc as PresetDoc).prompts.find((p) => p.identifier === "main")!.content

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("library import", (it) => {
  it.effect("a card PNG becomes a library card with its avatar, its note and its lorebook", () =>
    Effect.gen(function* () {
      const file = png(cardChunk("chara", stCardV2()))
      const result = yield* imported(file, "wren.png")
      assert.strictEqual(result.report.format, "card-v2-png")
      const library = result.library!
      assert.isTrue(library.created)
      assert.strictEqual(library.ref.label, "Wren")
      assert.strictEqual(library.note?.kind, "note")

      const api = yield* client()
      assert.include(
        (yield* api.ListLibrary({ kind: "card" })).map((ref) => ref.id),
        library.ref.id
      )

      const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
      const ref = db.prepare("SELECT source_path, source_hash FROM entity_refs WHERE id = ?").get(library.ref.id)
      assert.deepStrictEqual({ ...ref }, { source_path: "wren.png", source_hash: sha256(file) })
      const revision = db
        .prepare("SELECT origin, doc_json FROM entity_revisions WHERE id = ?")
        .get(library.ref.headRevisionId)
      assert.strictEqual(revision!.origin, "import")
      const doc = JSON.parse(revision!.doc_json as string)
      assert.strictEqual(doc.character_book.name, "Hollowmere")
      assert.notProperty(doc.extensions, "depth_prompt")
      const media = db
        .prepare("SELECT sha256, path, mime, width FROM media_assets WHERE id = ?")
        .get(doc.avatar_media_id)
      db.close()
      const avatar = readFileSync(join(config.dataDir, media!.path as string))
      assert.strictEqual(media!.sha256, sha256(avatar))
      assert.deepStrictEqual([media!.mime, media!.width], ["image/png", 1])
      // The stored avatar is the image without its card chunks.
      assert.isFalse(readChunks(avatar, defaultLimits).some((chunk) => chunk.type === "tEXt"))
    })
  )

  it.effect("a card exports in every format, its note back as ST's Character's Note", () =>
    Effect.gen(function* () {
      const { library } = yield* imported(png(cardChunk("chara", stCardV2())), "wren.png")
      const refId = library!.ref.id
      for (const format of ["card-png", "card-v2-json", "card-v3-json", "card-charx"]) {
        const { status, response, bytes } = yield* exported(refId, format)
        assert.strictEqual(status, 200, format)
        assert.include(response.headers.get("content-disposition"), 'filename="Wren.')
        assert.strictEqual(response.headers.get("x-content-type-options"), "nosniff")
        const back = run(importCard(bytes))
        assert.deepStrictEqual(back.card.extensions.depth_prompt, {
          prompt: "Wren smells of oil.",
          depth: 4,
          role: "system"
        })
        assert.strictEqual(back.card.character_book?.entries.length, 2)
        if (format === "card-png" || format === "card-charx") assert.isNotNull(back.avatar, format)
      }
      assert.strictEqual((yield* exported(refId, "st-preset")).status, 400)
    })
  )

  it.effect("a new version without an avatar keeps the card's avatar, and says so", () =>
    Effect.gen(function* () {
      const avatar = png()
      const first = yield* imported(png(cardChunk("chara", stCardV2())), "wren.png")
      const second = yield* imported(json(stCardV2()), "wren.json", first.library!.ref.id)
      assert.include(
        second.report.issues.map((issue) => issue.code),
        "card.avatar_kept"
      )
      assert.isTrue(second.library!.keptAvatar)
      const { bytes } = yield* exported(second.library!.ref.id, "card-png")
      // The exported PNG is the card's own image, not the placeholder.
      const decoded = (image: Uint8Array) => sharp(image).raw().toBuffer()
      assert.deepStrictEqual(
        yield* Effect.promise(() => decoded(run(importCard(bytes)).avatar!.bytes)),
        yield* Effect.promise(() => decoded(avatar))
      )
    })
  )

  it.effect("a card without a PNG avatar still exports as a PNG", () =>
    Effect.gen(function* () {
      const { library } = yield* imported(json(stCardV2()), "wren.json")
      const { status, bytes } = yield* exported(library!.ref.id, "card-png")
      assert.strictEqual(status, 200)
      assert.strictEqual(run(importCard(bytes)).card.name, "Wren")
    })
  )

  it.effect("a card with an invalid image refuses PNG rendering and retains its CHARX export", () =>
    Effect.gen(function* () {
      const webp = Buffer.concat([Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1"), Buffer.alloc(8)])
      const card = {
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: { ...stCardV2().data, assets: [{ type: "icon", uri: "embeded://icon.webp", name: "main", ext: "webp" }] }
      }
      const archive = zip([
        { name: "card.json", data: json(card) },
        { name: "icon.webp", data: webp, method: 0 }
      ])
      const { library } = yield* imported(archive, "wren.charx")
      const refused = yield* exported(library!.ref.id, "card-png")
      assert.strictEqual(refused.status, 422)
      assert.include(new TextDecoder().decode(refused.bytes), "rendered as PNG")
      assert.strictEqual((yield* exported(library!.ref.id, "card-charx")).status, 200)
    })
  )

  it.effect("a CHARX whose assets share one file exports with each of them", () =>
    Effect.gen(function* () {
      // The same bytes under two names are one stored file, read once for the export.
      const image = png()
      const card = {
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: {
          ...stCardV2().data,
          assets: [
            { type: "icon", uri: "embeded://main.png", name: "main", ext: "png" },
            { type: "other", uri: "embeded://a.png", name: "a", ext: "png" },
            { type: "other", uri: "embeded://b.png", name: "b", ext: "png" }
          ]
        }
      }
      const archive = zip([
        { name: "card.json", data: json(card) },
        { name: "main.png", data: image, method: 0 },
        { name: "a.png", data: image, method: 0 },
        { name: "b.png", data: image, method: 0 }
      ])
      const { library } = yield* imported(archive, "wren.charx")
      const { status, bytes } = yield* exported(library!.ref.id, "card-charx")
      assert.strictEqual(status, 200)
      const back = run(importCard(bytes))
      assert.strictEqual(sha256(back.avatar!.bytes), sha256(image))
      assert.deepStrictEqual(
        back.assets.map((asset) => sha256(asset.bytes)),
        [sha256(image), sha256(image)]
      )
    })
  )

  it.effect("an export's files are capped in total, however many times a document names them", () =>
    Effect.gen(function* () {
      const writer = yield* Writer
      const reader = yield* Reader
      // A 1 MiB avatar, which the edited card then names 200 times as an asset.
      const big = png(chunk("ruMb", Buffer.alloc(1024 * 1024)), cardChunk("chara", stCardV2()))
      const { library } = yield* imported(big, "wren.png")
      const userId = (yield* (yield* client()).Whoami()).id
      const current = yield* reader.GetRef({ userId, refId: library!.ref.id })
      const uris = Array.from({ length: 200 }, (_, i) => `embeded://assets/copy${i}.png`)
      yield* writer.EditRef({
        userId,
        refId: library!.ref.id,
        doc: {
          ...current.doc,
          assets: uris.map((uri, i) => ({ type: "other", uri, name: `copy${i}`, ext: "png" })),
          asset_media_ids: Object.fromEntries(uris.map((uri) => [uri, current.doc.avatar_media_id]))
        },
        expectedRowVersion: current.ref.rowVersion,
        message: null,
        commitDraft: null
      })
      const charx = yield* exported(library!.ref.id, "card-charx")
      assert.strictEqual(charx.status, 422)
      assert.include(new TextDecoder().decode(charx.bytes), "more than an export can hold")
      // A format without the files reads none of them.
      assert.strictEqual((yield* exported(library!.ref.id, "card-v2-json")).status, 200)
    })
  )

  it.effect("a CHARX card's assets are stored and go back out", () =>
    Effect.gen(function* () {
      const icon = png()
      const extra = Buffer.concat([png(), Buffer.from([0])])
      const card = {
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: {
          ...stCardV2().data,
          assets: [
            { type: "icon", uri: "embeded://assets/icon/main.png", name: "main", ext: "png" },
            { type: "emotion", uri: "embeded://assets/emotion/happy.png", name: "happy", ext: "png" }
          ]
        }
      }
      const archive = zip([
        { name: "card.json", data: json(card) },
        { name: "assets/icon/main.png", data: icon, method: 0 },
        { name: "assets/emotion/happy.png", data: extra, method: 0 }
      ])
      const { library } = yield* imported(archive, "wren.charx")
      const exportsBoth = Effect.gen(function* () {
        const { bytes } = yield* exported(library!.ref.id, "card-charx")
        const back = run(importCard(bytes))
        assert.deepStrictEqual(
          back.assets.map((asset) => [asset.uri, sha256(asset.bytes)]),
          [["embeded://assets/emotion/happy.png", sha256(extra)]]
        )
        assert.strictEqual(sha256(back.avatar!.bytes), sha256(icon))
      })
      yield* exportsBoth

      // Its card.json alone as the new version: the files it names but doesn't hold stay.
      const json3 = yield* imported(json(card), "wren.json", library!.ref.id)
      assert.includeMembers(
        json3.report.issues.map((issue) => issue.code),
        ["card.avatar_kept", "card.assets_kept"]
      )
      assert.strictEqual(json3.library!.keptAssets, 1)
      yield* exportsBoth
    })
  )

  it.effect("a lorebook and a preset import and export as ST files", () =>
    Effect.gen(function* () {
      const book = yield* imported(json(worldInfo()), "harbor.json")
      assert.strictEqual(book.library!.ref.kind, "lorebook")
      const bookOut = yield* exported(book.library!.ref.id, "st-world-info")
      assert.strictEqual(
        JSON.parse(new TextDecoder().decode(bookOut.bytes)).entries["3"].content,
        worldInfo().entries["3"].content
      )

      const preset = yield* imported(presetFile("Write vivid prose."), "Narrator.json")
      assert.strictEqual(preset.library!.ref.label, "Narrator")
      const presetOut = yield* exported(preset.library!.ref.id, "st-preset")
      assert.strictEqual(presetOut.status, 200)
      const file = JSON.parse(new TextDecoder().decode(presetOut.bytes))
      assert.strictEqual(
        file.prompts.find((p: { identifier: string }) => p.identifier === "main").content,
        "Write vivid prose."
      )
      assert.notProperty(file, "proxy_password")
      assert.notProperty(file, "temperature")
      assert.notProperty(file, "openai_max_context")
      assert.notProperty(file, "names_behavior")
    })
  )

  it.effect("a re-import offers an explicit merge into an edited fork", () =>
    Effect.gen(function* () {
      const writer = yield* Writer
      const reader = yield* Reader
      const first = yield* imported(presetFile("Write vivid prose. Do not speak for {{user}}."), "Narrator.json")
      const upstream = first.library!.ref
      const userId = (yield* (yield* client()).Whoami()).id
      const variant = yield* writer.ForkRef({ userId, refId: upstream.id, label: "Narrator", subtitle: "mine" })
      const current = yield* reader.GetRef({ userId, refId: variant.id })
      const doc = current.doc as PresetDoc
      // The hash the format worker worked out is the writer's own: an edit that changes
      // nothing makes no revision.
      const unchanged = yield* writer.EditRef({
        userId,
        refId: variant.id,
        doc,
        expectedRowVersion: current.ref.rowVersion,
        message: null,
        commitDraft: null
      })
      assert.strictEqual(unchanged.ref.headRevisionId, current.ref.headRevisionId)
      yield* writer.EditRef({
        userId,
        refId: variant.id,
        doc: {
          ...doc,
          prompts: doc.prompts.map((p) =>
            p.identifier === "main"
              ? { ...p, content: "Write vivid prose. Avoid speaking for {{user}} unless asked." }
              : p
          )
        },
        expectedRowVersion: current.ref.rowVersion,
        message: null,
        commitDraft: null
      })

      const second = yield* imported(
        presetFile("Write vivid, sensory prose. Do not speak for {{user}}."),
        "Narrator v2.json",
        upstream.id
      )
      assert.isFalse(second.library!.created)
      assert.strictEqual(second.library!.outcome, "fast_forward")
      assert.deepStrictEqual(second.library!.followers, [])
      assert.strictEqual(
        mainPrompt((yield* reader.GetRef({ userId, refId: variant.id })).doc),
        "Write vivid prose. Avoid speaking for {{user}} unless asked."
      )
      yield* writer.MergeFollowed({ userId, refId: variant.id })
      assert.strictEqual(
        mainPrompt((yield* reader.GetRef({ userId, refId: variant.id })).doc),
        "Write vivid, sensory prose. Avoid speaking for {{user}} unless asked."
      )
      // The same file again changes nothing.
      const again = yield* imported(
        presetFile("Write vivid, sensory prose. Do not speak for {{user}}."),
        "x.json",
        upstream.id
      )
      assert.strictEqual(again.library!.outcome, "up_to_date")
      // A file of another kind doesn't go into a preset.
      assert.strictEqual((yield* upload(json(worldInfo()), "harbor.json", upstream.id)).status, 409)
    })
  )

  it.effect("a file nothing recognizes is a report with an error, and nothing is stored", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const before = (yield* api.ListLibrary({ kind: "card" })).length
      const result = yield* imported(json({ hello: "world" }), "card.png")
      assert.isNull(result.library)
      assert.strictEqual(result.report.issues[0]!.level, "error")
      const broken = yield* imported(png(cardChunk("chara", "%%%")), "broken.png")
      assert.isNull(broken.library)
      assert.strictEqual((yield* api.ListLibrary({ kind: "card" })).length, before)
    })
  )

  it.effect("uploads need the binary content type, this site's origin and a size within the cap", () =>
    Effect.gen(function* () {
      const file = png(cardChunk("chara", stCardV2()))
      assert.strictEqual((yield* upload(file, "x.png", undefined, { "content-type": "text/plain" })).status, 415)
      assert.strictEqual((yield* upload(file, "x.png", undefined, { origin: "https://evil.example" })).status, 403)
      const url = yield* base
      const declared = yield* Effect.promise(() => sendRaw(url, String(defaultLimits.maxFileBytes + 1), 1))
      assert.strictEqual(declared, 413)
      // A body that keeps coming without a length is cut off once it passes the cap.
      const streamed = yield* Effect.promise(() => sendRaw(url, undefined, defaultLimits.maxFileBytes + 1024 * 1024))
      assert.notStrictEqual(streamed, 200)
      const health = yield* Effect.promise(() => fetch(`${url}/healthz`))
      assert.strictEqual(health.status, 200)
    })
  )
})

/**
 * A raw upload of `size` zero bytes, with `length` as its Content-Length (chunked when
 * undefined). Resolves to the status, or "reset" when the server cuts the connection.
 */
const sendRaw = (base: string, length: string | undefined, size: number) =>
  new Promise<number | "reset">((resolve) => {
    const req = request(`${base}/library/import?name=big.json`, {
      method: "POST",
      // A connection of its own: a body cut short would leave a shared one unusable.
      agent: false,
      headers: { "content-type": "application/octet-stream", ...(length ? { "content-length": length } : {}) }
    })
    req.on("response", (response) => {
      response.resume()
      resolve(response.statusCode!)
    })
    req.on("error", () => resolve("reset"))
    const chunk = Buffer.alloc(1024 * 1024)
    let sent = 0
    const pump = () => {
      while (sent < size) {
        const part = chunk.subarray(0, Math.min(chunk.length, size - sent))
        sent += part.length
        if (!req.write(part)) return void req.once("drain", pump)
      }
      req.end()
    }
    if (length === undefined) pump()
    else req.end(Buffer.alloc(Math.min(size, 1)))
  })

describe("with login required", () => {
  const locked = testConfig({ adminPassword: Option.some(Redacted.make("admin-password-1")) })
  layer(serverLayer(locked), { excludeTestServices: true, timeout: "60 seconds" })("library import", (it) => {
    it.effect("an upload or export without a session is refused", () =>
      Effect.gen(function* () {
        const url = yield* base
        const response = yield* Effect.promise(() =>
          fetch(`${url}/library/import?name=x.png`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: png(cardChunk("chara", stCardV2()))
          })
        )
        assert.strictEqual(response.status, 401)
        assert.isFalse(existsSync(join(locked.dataDir, "media")))
        const exportResponse = yield* Effect.promise(() =>
          fetch(`${url}/library/export`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refId: "x", format: "st-preset" })
          })
        )
        assert.strictEqual(exportResponse.status, 401)
      })
    )
  })
})
