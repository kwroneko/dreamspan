import { assert, layer } from "@effect/vitest"
import { CardDoc } from "@dreamspan/shared/docs/card.ts"
import { ImportResult } from "@dreamspan/shared/libraryImport.ts"
import { galleryAssets } from "@dreamspan/shared/gallery.ts"
import { Effect, Schema } from "effect"
import { importCard } from "../src/formats/cardImport.ts"
import { cardV3, json, png, zip, textChunk } from "./formats/support.ts"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { importStFolder } from "./support/stUpload.ts"

const config = testConfig()
const send = (path: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    assert.strictEqual(response.status, 200, yield* Effect.promise(() => response.clone().text()))
    return yield* Effect.promise(() => response.json())
  })
const imported = (bytes: Uint8Array, name = "card.charx") =>
  Effect.map(
    send(`/library/import?name=${name}`, bytes),
    (value) => Schema.decodeUnknownSync(ImportResult)(value).library!.ref
  )
const asset = (type: string, name: string) => ({ type, name, ext: "png", uri: `embeded://assets/${type}/${name}.png` })
const fixtures = [
  asset("icon", "main"),
  asset("icon", "Coat"),
  asset("emotion", "Happy"),
  asset("background", "Harbor"),
  asset("user_icon", "You"),
  asset("other", "Map")
]
const archive = zip([
  { name: "card.json", data: json({ ...cardV3(), data: { ...cardV3().data, assets: fixtures } }) },
  ...fixtures.map((a, index) => ({
    name: a.uri.slice("embeded://".length),
    data: png(textChunk("fixture", String(index)))
  }))
])

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("card gallery", (it) => {
  it.effect("keeps asset names, kinds, bytes and order across CHARX export and import", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ref = yield* imported(archive)
      const doc = Schema.decodeUnknownSync(CardDoc)((yield* api.OpenEditor({ refId: ref.id })).doc)
      assert.deepStrictEqual(
        galleryAssets(doc).map((a) => [a.type, a.name]),
        fixtures.slice(1).map((a) => [a.type, a.name])
      )
      const port = yield* serverPort
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/library/export`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refId: ref.id, format: "card-charx" })
        })
      )
      assert.strictEqual(response.status, 200)
      const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
      const parsed = yield* importCard(bytes)
      assert.deepStrictEqual(
        parsed.card.assets?.map((a) => [a.type, a.name]),
        fixtures.map((a) => [a.type, a.name])
      )
      assert.deepStrictEqual(
        parsed.assets.map((a) => a.bytes),
        fixtures.slice(1).map((_, i) => png(textChunk("fixture", String(i + 1))))
      )
      const again = yield* imported(bytes)
      assert.strictEqual((yield* api.GetCardGallery({ refId: again.id })).images.length, 5)
    })
  )
  it.effect("adds, renames, changes kind, swaps portraits and restores an image from the bin", () =>
    Effect.gen(function* () {
      const api = yield* client()
      let ref = yield* imported(archive)
      const before = (yield* api.OpenEditor({ refId: ref.id })).doc
      yield* send(`/library/gallery?ref=${ref.id}&rowVersion=${ref.rowVersion}&name=Added`, png())
      const added = yield* api.OpenEditor({ refId: ref.id })
      ref = added.ref
      let doc = Schema.decodeUnknownSync(CardDoc)(added.doc)
      const uri = galleryAssets(doc).at(-1)!.uri
      ref = (yield* api.ChangeCardAsset({
        refId: ref.id,
        uri,
        expectedRowVersion: ref.rowVersion,
        change: { action: "rename", name: "Night map" }
      })).ref
      ref = (yield* api.ChangeCardAsset({
        refId: ref.id,
        uri,
        expectedRowVersion: ref.rowVersion,
        change: { action: "kind", kind: "background" }
      })).ref
      const stale = yield* Effect.flip(
        api.ChangeCardAsset({ refId: ref.id, uri, expectedRowVersion: 1, change: { action: "remove" } })
      )
      assert.strictEqual(stale._tag, "StaleWrite")
      ref = (yield* api.ChangeCardAsset({
        refId: ref.id,
        uri: fixtures[1]!.uri,
        expectedRowVersion: ref.rowVersion,
        change: { action: "portrait" }
      })).ref
      doc = Schema.decodeUnknownSync(CardDoc)((yield* api.OpenEditor({ refId: ref.id })).doc)
      assert.notStrictEqual(doc.avatar_media_id, before.avatar_media_id)
      assert.deepStrictEqual(
        galleryAssets(doc).map((a) => a.name),
        [...fixtures.slice(1).map((a) => a.name), "Night map"]
      )
      assert.strictEqual(
        doc.asset_media_ids?.[galleryAssets(doc).find((a) => a.name === "Coat")!.uri],
        before.avatar_media_id
      )
      ref = (yield* api.ChangeCardAsset({
        refId: ref.id,
        uri,
        expectedRowVersion: ref.rowVersion,
        change: { action: "remove" }
      })).ref
      assert.isFalse((yield* api.GetCardGallery({ refId: ref.id })).images.some((a) => a.uri === uri))
      const item = (yield* api.ListBin({ limit: 50, before: null })).find(
        (i) => i.kind === "card_asset" && i.title === "Night map"
      )!
      assert.isDefined(item)
      ref = yield* api.RenameRef({
        refId: ref.id,
        label: "Updated gallery card",
        subtitle: "",
        expectedRowVersion: ref.rowVersion
      })
      yield* api.RestoreBinItem({ itemId: item.id })
      doc = Schema.decodeUnknownSync(CardDoc)((yield* api.OpenEditor({ refId: ref.id })).doc)
      assert.strictEqual(doc.name, "Updated gallery card")
      assert.deepStrictEqual(galleryAssets(doc).at(-1)?.name, "Night map")
      assert.strictEqual(galleryAssets(doc).at(-1)?.type, "background")
      assert.isFalse((yield* api.ListBin({ limit: 50, before: null })).some((i) => i.id === item.id))
    })
  )
  it.effect("imports only fresh cards' gallery folders using display names and per-avatar overrides", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const files = new Map<string, Uint8Array>([
        [
          "settings.json",
          json({ extension_settings: { gallery: { folders: { "renamed.json": "Custom: folder?" } } } })
        ],
        ["characters/display.json", json({ ...cardV3(), data: { ...cardV3().data, name: "Display: name?" } })],
        ["characters/renamed.json", json({ ...cardV3(), data: { ...cardV3().data, name: "Another card" } })],
        ["user/images/Display name/Forest.png", png()],
        ["user/images/Custom folder/Beach.png", png()],
        ["user/images/display/Wrong folder.png", png()]
      ])
      const first = yield* importStFolder(files)
      assert.strictEqual(first.answers.get("user/images/Display name/Forest.png")?.outcome, "added")
      assert.strictEqual(first.answers.get("user/images/Custom folder/Beach.png")?.outcome, "added")
      const cards = yield* api.ListLibrary({ kind: "card", archived: false })
      const target = cards.find((r) => r.label === "Display: name?")!
      assert.deepStrictEqual(
        (yield* api.GetCardGallery({ refId: target.id })).images.map((a) => a.name),
        ["Forest"]
      )
      files.set("user/images/Display name/New.png", png())
      const second = yield* importStFolder(files)
      assert.strictEqual(second.answers.get("user/images/Display name/New.png")?.outcome, "skipped")
      assert.deepStrictEqual(
        (yield* api.GetCardGallery({ refId: target.id })).images.map((a) => a.name),
        ["Forest"]
      )
    })
  )
})
