// A portrait's cutout (ARCHITECTURE.md §14.5c): thumbnails made from it, named by it (so a changed
// one is another file and ETag), the default for an image without one, who may set it, and the
// round trip through our PNG export. Synthetic images only.
import { assert, layer } from "@effect/vitest"
import { ImportResult } from "@dreamspan/shared/libraryImport.ts"
import { Effect, Schema } from "effect"
import sharp from "sharp"
import { importCard } from "../src/formats/cardImport.ts"
import { cardChunk, png, stCardV2 } from "./formats/support.ts"
import { client, post, serverLayer, serverPort, testConfig } from "./support/config.ts"

const config = testConfig({ authMode: "proxy", formatWorkers: 2 })
const alice = { "Remote-User": "crop-alice" }
const bob = { "Remote-User": "crop-bob" }
const base = Effect.map(serverPort, (port) => `http://127.0.0.1:${port}`)

type Rgb = readonly [number, number, number]
const RED: Rgb = [220, 30, 30]
const BLUE: Rgb = [30, 30, 220]
const GREEN: Rgb = [30, 200, 30]

/** A PNG painted by `colour`, one pixel at a time. */
const paint = (width: number, height: number, colour: (x: number, y: number) => Rgb) => {
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(colour(x, y), (y * width + x) * 3)
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()
}

const uploadTo = (refId: string, rowVersion: number, bytes: Uint8Array, query = "") =>
  Effect.flatMap(base, (url) =>
    Effect.promise(() =>
      fetch(`${url}/library/avatar?ref=${refId}&rowVersion=${rowVersion}${query}`, {
        method: "POST",
        headers: { ...alice, "content-type": "application/octet-stream" },
        body: bytes
      })
    )
  )

const newCard = (bytes: Uint8Array, query = "", name = "Cutout") =>
  Effect.gen(function* () {
    const api = yield* client(alice)
    const card = yield* api.CreateCard({ label: name, name })
    const response = yield* uploadTo(card.id, card.rowVersion, bytes, query)
    assert.strictEqual(response.status, 200)
    const opened = yield* api.OpenEditor({ refId: card.id })
    return { api, ref: opened.ref, doc: opened.doc, mediaId: opened.doc.avatar_media_id as string }
  })

const get = (id: string, suffix: string, headers: Record<string, string> = alice) =>
  Effect.flatMap(base, (url) => Effect.promise(() => fetch(`${url}/library/media?id=${id}${suffix}`, { headers })))
const bytesOf = (response: Response) => Effect.promise(async () => Buffer.from(await response.arrayBuffer()))

/** A thumbnail's size and mean colour. */
const look = (bytes: Buffer) =>
  Effect.promise(async () => {
    const meta = await sharp(bytes).metadata()
    const stats = await sharp(bytes).stats()
    return { width: meta.width, height: meta.height, mean: stats.channels.slice(0, 3).map((c) => c.mean) }
  })
const near = (mean: ReadonlyArray<number>, colour: Rgb) =>
  assert.isTrue(
    mean.every((value, i) => Math.abs(value - colour[i]!) < 20),
    `expected about ${colour.join(",")}, got ${mean.map(Math.round).join(",")}`
  )

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("portrait cutouts", (it) => {
  it.effect(
    "an image without a chosen cutout shows the default: the top of a tall one, the middle of a wide or square one",
    () =>
      Effect.gen(function* () {
        // Tall (2:4.5): the top 2:3 is red, the rest blue.
        const tall = yield* newCard(yield* Effect.promise(() => paint(400, 900, (_x, y) => (y < 600 ? RED : BLUE))))
        assert.isUndefined(tall.doc.avatar_crop)
        const tallThumb = yield* look(yield* bytesOf(yield* get(tall.mediaId, "&w=96&crop=auto")))
        assert.deepStrictEqual([tallThumb.width, tallThumb.height], [96, 144])
        near(tallThumb.mean, RED)
        // Wide (3:1): the middle 200 px column is green.
        const wide = yield* newCard(
          yield* Effect.promise(() => paint(900, 300, (x) => (x >= 350 && x < 550 ? GREEN : RED)))
        )
        const wideThumb = yield* look(yield* bytesOf(yield* get(wide.mediaId, "&w=96&crop=auto")))
        assert.deepStrictEqual([wideThumb.width, wideThumb.height], [96, 144])
        near(wideThumb.mean, GREEN)
        // Square: the middle two thirds.
        const square = yield* newCard(
          yield* Effect.promise(() => paint(600, 600, (x) => (x >= 100 && x < 500 ? BLUE : RED)))
        )
        near((yield* look(yield* bytesOf(yield* get(square.mediaId, "&w=192&crop=auto")))).mean, BLUE)
        // The whole image is still served as it was: original, and an uncut thumbnail.
        const whole = yield* look(yield* bytesOf(yield* get(wide.mediaId, "&w=96")))
        assert.deepStrictEqual([whole.width, whole.height], [96, 32])
        // The card's portrait reads say it has no cutout of its own.
        const usage = yield* wide.api.ListCardUsage()
        assert.isUndefined(usage.find((card) => card.refId === wide.ref.id)!.avatarCrop)
      })
  )

  it.effect("the thumbnail follows the chosen cutout; a changed cutout is another file and ETag; never enlarged", () =>
    Effect.gen(function* () {
      // Left half red, right half blue; the cutout is the right half's top 2:3.
      const image = yield* Effect.promise(() => paint(600, 600, (x) => (x < 300 ? RED : BLUE)))
      const right = { x: 0.5, y: 0, width: 0.5, height: 0.75 }
      const card = yield* newCard(image, "&crop=5000_0_5000_7500")
      assert.deepStrictEqual(card.doc.avatar_crop, { media_id: card.mediaId, ...right })
      const usage = yield* card.api.ListCardUsage()
      assert.deepStrictEqual(usage.find((c) => c.refId === card.ref.id)!.avatarCrop, right)

      const chosen = yield* get(card.mediaId, "&w=192&crop=5000_0_5000_7500")
      const chosenTag = chosen.headers.get("etag")!
      const chosenLook = yield* look(yield* bytesOf(chosen))
      assert.deepStrictEqual([chosenLook.width, chosenLook.height], [192, 288])
      near(chosenLook.mean, BLUE)
      // 300 px wide: a 768 request isn't enlarged past the cutout's own pixels.
      const big = yield* look(yield* bytesOf(yield* get(card.mediaId, "&w=768&crop=5000_0_5000_7500")))
      assert.deepStrictEqual([big.width, big.height], [300, 450])

      // Chosen again: the left half. The portrait reads change, and so do the URL and ETag.
      const left = { x: 0, y: 0.25, width: 0.5, height: 0.75 }
      const saved = yield* card.api.SetCardAvatarCrop({
        refId: card.ref.id,
        crop: left,
        expectedRowVersion: card.ref.rowVersion
      })
      const again = yield* card.api.OpenEditor({ refId: card.ref.id })
      assert.deepStrictEqual(again.doc.avatar_crop, { media_id: card.mediaId, ...left })
      assert.strictEqual(again.doc.avatar_media_id, card.mediaId, "the image itself is untouched")
      const moved = yield* get(card.mediaId, "&w=192&crop=0_2500_5000_7500")
      assert.notStrictEqual(moved.headers.get("etag"), chosenTag)
      near((yield* look(yield* bytesOf(moved))).mean, RED)
      assert.strictEqual(
        (yield* get(card.mediaId, "&w=192&crop=0_2500_5000_7500", { ...alice, "If-None-Match": chosenTag })).status,
        200,
        "the old cutout's ETag doesn't validate the new one"
      )
      // A stale row version is refused.
      const stale = yield* Effect.flip(
        card.api.SetCardAvatarCrop({ refId: card.ref.id, crop: right, expectedRowVersion: card.ref.rowVersion })
      )
      assert.strictEqual(stale._tag, "StaleWrite")

      // Reset: back to the default.
      yield* card.api.SetCardAvatarCrop({ refId: card.ref.id, crop: null, expectedRowVersion: saved.ref.rowVersion })
      assert.isUndefined((yield* card.api.OpenEditor({ refId: card.ref.id })).doc.avatar_crop)

      // A new image without a cutout has the default, never the old image's.
      const opened = yield* card.api.OpenEditor({ refId: card.ref.id })
      yield* card.api.SetCardAvatarCrop({ refId: card.ref.id, crop: right, expectedRowVersion: opened.ref.rowVersion })
      const before = yield* card.api.OpenEditor({ refId: card.ref.id })
      const other = yield* Effect.promise(() => paint(400, 600, () => GREEN))
      assert.strictEqual((yield* uploadTo(card.ref.id, before.ref.rowVersion, other)).status, 200)
      assert.isUndefined((yield* card.api.OpenEditor({ refId: card.ref.id })).doc.avatar_crop)
    })
  )

  it.effect("only the owner reads or sets a cutout, and a cutout must lie inside the image", () =>
    Effect.gen(function* () {
      const card = yield* newCard(yield* Effect.promise(() => paint(400, 600, () => RED)), "", "Owned")
      assert.strictEqual((yield* get(card.mediaId, "&w=96&crop=auto", bob)).status, 404)
      const theirs = yield* client(bob)
      const refused = yield* Effect.flip(
        theirs.SetCardAvatarCrop({
          refId: card.ref.id,
          crop: { x: 0, y: 0, width: 1, height: 1 },
          expectedRowVersion: 1
        })
      )
      assert.strictEqual(refused._tag, "NotFound")
      for (const bad of ["1_2_3", "6000_0_5000_5000", "0_0_0_1000", "x"]) {
        assert.strictEqual((yield* get(card.mediaId, `&w=96&crop=${bad}`)).status, 400)
        assert.strictEqual(
          (yield* uploadTo(card.ref.id, card.ref.rowVersion, new Uint8Array(4), `&crop=${bad}`)).status,
          400
        )
      }
      // A cutout names a thumbnail: without a width there's nothing to cut.
      assert.strictEqual((yield* get(card.mediaId, "&crop=auto")).status, 400)
    })
  )

  it.effect("Picture cuts render in the viewer and PNG export, round-trip data and keep the original", () =>
    Effect.gen(function* () {
      const image = yield* Effect.promise(() => paint(600, 600, (x) => (x < 300 ? RED : BLUE)))
      const card = yield* newCard(image, "&crop=5000_0_5000_7500&picture=5000_0_5000_10000", "Picture crop")
      const opened = yield* card.api.OpenEditor({ refId: card.ref.id })
      assert.deepStrictEqual(opened.doc.avatar_crop, {
        media_id: card.mediaId,
        x: 0.5,
        y: 0,
        width: 0.5,
        height: 0.75,
        picture: { x: 0.5, y: 0, width: 0.5, height: 1 }
      })
      const list = yield* card.api.ListCards()
      assert.deepStrictEqual(list.find((c) => c.entityId === card.ref.entityId)?.avatarCrop?.picture, {
        x: 0.5,
        y: 0,
        width: 0.5,
        height: 1
      })
      const original = yield* bytesOf(yield* get(card.mediaId, ""))
      assert.deepStrictEqual(original, image)
      const viewer = yield* get(card.mediaId, "&picture=5000_0_5000_10000")
      assert.strictEqual(viewer.headers.get("content-type"), "image/png")
      const rendered = yield* look(yield* bytesOf(viewer))
      assert.deepStrictEqual([rendered.width, rendered.height], [300, 600])
      near(rendered.mean, BLUE)
      assert.strictEqual((yield* get(card.mediaId, "&picture=5000_0_5000_10000", bob)).status, 404)
      assert.strictEqual((yield* get(card.mediaId, "&picture=9000_0_5000_10000")).status, 400)
      const exported = yield* post("/library/export", { refId: card.ref.id, format: "card-png" }, alice)
      assert.strictEqual(exported.status, 200)
      const bytes = new Uint8Array(yield* Effect.promise(() => exported.arrayBuffer()))
      const parsed = yield* importCard(bytes)
      assert.strictEqual(parsed.card.name, "Picture crop")
      const meta = yield* Effect.promise(() => sharp(Buffer.from(parsed.avatar!.bytes)).metadata())
      assert.deepStrictEqual([meta.width, meta.height], [300, 600])
      assert.deepStrictEqual((parsed.card.extensions.rp_harness as { avatar_crop: unknown }).avatar_crop, {
        x: 0,
        y: 0,
        width: 1,
        height: 0.75,
        image_width: 300,
        image_height: 600
      })
      const url = yield* base
      const imported = yield* Effect.promise(() =>
        fetch(`${url}/library/import?name=picture-crop.png`, {
          method: "POST",
          headers: { ...alice, "content-type": "application/octet-stream" },
          body: bytes
        })
      )
      assert.strictEqual(imported.status, 200)
      const back = Schema.decodeUnknownSync(ImportResult)(yield* Effect.promise(() => imported.json()))
      const reopened = yield* card.api.OpenEditor({ refId: back.library!.ref.id })
      assert.deepStrictEqual(reopened.doc.avatar_crop, {
        media_id: reopened.doc.avatar_media_id,
        x: 0,
        y: 0,
        width: 1,
        height: 0.75
      })
      const reset = yield* card.api.SetCardAvatarCrop({
        refId: card.ref.id,
        expectedRowVersion: opened.ref.rowVersion,
        crop: null
      })
      assert.strictEqual((yield* card.api.OpenEditor({ refId: card.ref.id })).doc.avatar_crop, undefined)
      assert.isAbove(reset.ref.rowVersion, opened.ref.rowVersion)
    })
  )

  it.effect("our PNG export holds the whole image and the cutout, which our import keeps; ST's cards have none", () =>
    Effect.gen(function* () {
      const image = yield* Effect.promise(() => paint(600, 600, (x) => (x < 300 ? RED : BLUE)))
      const card = yield* newCard(image, "&crop=5000_0_5000_7500", "Round trip")
      const exported = yield* post("/library/export", { refId: card.ref.id, format: "card-png" }, alice)
      assert.strictEqual(exported.status, 200)
      const bytes = new Uint8Array(yield* Effect.promise(() => exported.arrayBuffer()))
      const parsed = yield* importCard(bytes)
      const ours = parsed.card.extensions.rp_harness as { avatar_crop: unknown }
      assert.deepStrictEqual(ours.avatar_crop, {
        x: 0.5,
        y: 0,
        width: 0.5,
        height: 0.75,
        image_width: 600,
        image_height: 600
      })
      // The whole original, not a cut-out one.
      const meta = yield* Effect.promise(() => sharp(Buffer.from(parsed.avatar!.bytes)).metadata())
      assert.deepStrictEqual([meta.width, meta.height], [600, 600])

      const importFile = (file: Uint8Array, name: string) =>
        Effect.gen(function* () {
          const url = yield* base
          const response = yield* Effect.promise(() =>
            fetch(`${url}/library/import?name=${name}`, {
              method: "POST",
              headers: { ...alice, "content-type": "application/octet-stream" },
              body: file
            })
          )
          assert.strictEqual(response.status, 200)
          const result = Schema.decodeUnknownSync(ImportResult)(yield* Effect.promise(() => response.json()))
          return yield* card.api.OpenEditor({ refId: result.library!.ref.id })
        })
      const back = yield* importFile(bytes, "round.png")
      assert.deepStrictEqual(back.doc.avatar_crop, {
        media_id: back.doc.avatar_media_id,
        x: 0.5,
        y: 0,
        width: 0.5,
        height: 0.75
      })
      assert.isUndefined(
        (back.doc.extensions as Record<string, unknown>).rp_harness,
        "the cutout moved out of the extension"
      )

      // An ST card has no cutout field: the default.
      const st = yield* importFile(png(cardChunk("chara", stCardV2())), "st.png")
      assert.isUndefined(st.doc.avatar_crop)
      // A cutout chosen on another image (ST cropped and resized it since): not applied.
      const card2 = stCardV2()
      const resized = png(
        cardChunk("chara", {
          ...card2,
          data: {
            ...card2.data,
            extensions: {
              rp_harness: {
                avatar_crop: { x: 0.5, y: 0, width: 0.5, height: 0.75, image_width: 600, image_height: 600 }
              }
            }
          }
        })
      )
      const other = yield* importFile(resized, "resized.png")
      assert.isUndefined(other.doc.avatar_crop)
      assert.isUndefined((other.doc.extensions as Record<string, unknown>).rp_harness)
    })
  )
})
