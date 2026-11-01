import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import sharp from "sharp"
import { existsSync, readdirSync, rmSync, statSync, writeFileSync, watch } from "node:fs"
import { basename, dirname, join } from "node:path"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { largeImagePng, oversizedPortraitPng } from "./support/stLargeImages.ts"
import { chunk } from "./formats/support.ts"
import { Reader } from "../src/db/Database.ts"

const config = testConfig({ authMode: "proxy", formatWorkers: 2 })
const base = Effect.map(serverPort, (port) => `http://127.0.0.1:${port}`)
const alice = { "Remote-User": "thumb-alice" }
const upload = (bytes: Uint8Array, name = "Avatar") =>
  Effect.gen(function* () {
    const api = yield* client(alice)
    const card = yield* api.CreateCard({ label: name, name })
    const url = yield* base
    const response = yield* Effect.promise(() =>
      fetch(`${url}/library/avatar?ref=${card.id}&rowVersion=${card.rowVersion}`, {
        method: "POST",
        headers: { ...alice, "content-type": "application/octet-stream" },
        body: bytes
      })
    )
    assert.strictEqual(response.status, 200)
    const opened = yield* api.OpenEditor({ refId: card.id })
    return { id: opened.doc.avatar_media_id as string, card: opened.ref, api }
  })
const get = (id: string, suffix = "", headers: Record<string, string> = alice) =>
  Effect.flatMap(base, (url) => Effect.promise(() => fetch(`${url}/library/media?id=${id}${suffix}`, { headers })))
/** Removes the thumbnails an upload made ahead, to test making them on request. */
const unprepare = (path: string) => {
  for (const width of [96, 192, 384, 768])
    rmSync(join(config.dataDir, `${path}.thumb-v1-${width}.webp`), { force: true })
}
const bytesOf = (response: Response) => Effect.promise(async () => Buffer.from(await response.arrayBuffer()))

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("image thumbnails", (it) => {
  it.effect("review: accepted large valid PNG avatars remain displayable through sized URLs", () =>
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(oversizedPortraitPng)
      const { id } = yield* upload(bytes, "Review 48MP")
      assert.strictEqual((yield* get(id)).status, 200)
      assert.strictEqual(
        (yield* get(id, "&w=192")).status,
        200,
        "a valid avatar accepted by upload must remain visible in the grid"
      )
      const reader = yield* Reader
      const api = yield* client(alice)
      const user = yield* api.Whoami()
      const source = yield* reader.GetMediaFile({ userId: user.id, mediaId: id })
      const marker = join(config.dataDir, `${source.path}.original-v1`)
      const modified = statSync(marker).mtimeMs
      const original = yield* get(id)
      yield* bytesOf(original)
      for (const width of [96, 192, 384, 768]) {
        const response = yield* get(id, `&w=${width}`)
        assert.strictEqual(response.status, 200)
        assert.strictEqual(response.headers.get("content-type"), "image/png")
        assert.strictEqual(response.headers.get("etag"), original.headers.get("etag"))
        assert.strictEqual(response.headers.get("cache-control"), "private, max-age=31536000, immutable")
        assert.deepStrictEqual(yield* bytesOf(response), bytes)
        assert.strictEqual(statSync(marker).mtimeMs, modified)
      }
      assert.strictEqual(
        (yield* get(id, "&w=96", { ...alice, "If-None-Match": original.headers.get("etag")! })).status,
        304
      )
      assert.strictEqual((yield* get(id, "&w=96", { "Remote-User": "thumb-bob" })).status, 404)
    })
  )

  it.effect("an uploaded avatar has its grid and list thumbnails, of its cutout, before the browser asks", () =>
    Effect.gen(function* () {
      // Taller than 2:3: the default cutout (§14.5c) is the full width from the top.
      const { id } = yield* upload(largeImagePng(7, 900, 1500), "Prepared")
      const reader = yield* Reader
      const api = yield* client(alice)
      const user = yield* api.Whoami()
      const source = yield* reader.GetMediaFile({ userId: user.id, mediaId: id })
      // 768 is made on its first request (PREPARED_WIDTHS).
      assert.isFalse(existsSync(join(config.dataDir, `${source.path}.thumb-v1-768-cauto.webp`)))
      for (const width of [96, 192, 384]) {
        const file = join(config.dataDir, `${source.path}.thumb-v1-${width}-cauto.webp`)
        const made = statSync(file).mtimeMs
        const meta = yield* Effect.promise(() => sharp(file).metadata())
        assert.strictEqual(meta.width, width)
        assert.strictEqual(meta.height, width * 1.5)
        // Served from disk: the request doesn't make it again.
        const response = yield* get(id, `&w=${width}&crop=auto`)
        assert.strictEqual(response.status, 200)
        assert.strictEqual(response.headers.get("content-type"), "image/webp")
        assert.strictEqual(statSync(file).mtimeMs, made)
      }
    })
  )

  it.effect("snaps up, outputs WebP, keeps aspect ratio, never enlarges, and keeps originals", () =>
    Effect.gen(function* () {
      const original = largeImagePng(42, 1000, 500)
      const { id } = yield* upload(original)
      for (const [asked, width] of [
        [1, 96],
        [96, 96],
        [97, 192],
        [193, 384],
        [385, 768],
        [99999, 768]
      ]) {
        const response = yield* get(id, `&w=${asked}`)
        assert.strictEqual(response.status, 200)
        assert.strictEqual(response.headers.get("content-type"), "image/webp")
        const bytes = yield* bytesOf(response)
        const metadata = yield* Effect.promise(() => sharp(bytes).metadata())
        assert.strictEqual(metadata.width, width)
        assert.strictEqual(metadata.height, width! / 2)
        assert.isBelow(bytes.length, original.length / 10)
      }
      const small = yield* upload(largeImagePng(43, 40, 20), "Small")
      const smallBytes = yield* bytesOf(yield* get(small.id, "&w=768"))
      assert.strictEqual((yield* Effect.promise(() => sharp(smallBytes).metadata())).width, 40)
      assert.deepStrictEqual(yield* bytesOf(yield* get(id)), original)
      for (const invalid of ["0", "-1", "abc", "1.5", "", "Infinity"])
        assert.strictEqual((yield* get(id, `&w=${invalid}`)).status, 400)
    })
  )

  it.effect("serves immutable private cache headers, 304s and owner checks before conditional responses", () =>
    Effect.gen(function* () {
      const { id } = yield* upload(largeImagePng(44, 400, 200))
      for (const suffix of ["", "&w=192"]) {
        const response = yield* get(id, suffix)
        const etag = response.headers.get("etag")!
        assert.isNotNull(etag)
        assert.strictEqual(response.headers.get("cache-control"), "private, max-age=31536000, immutable")
        assert.strictEqual(response.headers.get("x-content-type-options"), "nosniff")
        yield* bytesOf(response)
        const cached = yield* get(id, suffix, { ...alice, "If-None-Match": `"other", W/${etag}` })
        assert.strictEqual(cached.status, 304)
        assert.strictEqual((yield* bytesOf(cached)).length, 0)
        assert.strictEqual(cached.headers.get("etag"), etag)
        assert.strictEqual((yield* get(id, suffix, { "Remote-User": "thumb-bob", "If-None-Match": etag })).status, 404)
      }
      assert.strictEqual((yield* get(id, "&w=96", {} as typeof alice)).status, 401)
    })
  )

  it.effect("coalesces cold requests and reuses the disk derivative", () =>
    Effect.gen(function* () {
      const { id } = yield* upload(largeImagePng(45, 600, 400))
      const reader = yield* Reader
      const api = yield* client(alice)
      const user = yield* api.Whoami()
      const source = yield* reader.GetMediaFile({ userId: user.id, mediaId: id })
      unprepare(source.path)
      const target = join(config.dataDir, `${source.path}.thumb-v1-384.webp`)
      let installs = 0
      const watcher = yield* Effect.acquireRelease(
        Effect.sync(() =>
          watch(dirname(target), (event, name) => {
            if (event === "rename" && name === basename(target)) installs++
          })
        ),
        (watcher) => Effect.sync(() => watcher.close())
      )
      const responses = yield* Effect.all(
        Array.from({ length: 20 }, () => get(id, "&w=193")),
        { concurrency: "unbounded" }
      )
      assert.isTrue(responses.every((r) => r.status === 200))
      const outputs = yield* Effect.forEach(responses, bytesOf)
      assert.isTrue(outputs.every((b) => b.equals(outputs[0]!)))
      watcher.close()
      assert.strictEqual(installs, 1, "two workers must install only one derivative for simultaneous callers")
      const files = readdirSync(join(config.dataDir, "media"), { recursive: true }).filter((p) =>
        String(p).includes("thumb-v1-384.webp")
      )
      // Previous tests may have their own derivative; this one's ETag names its file.
      const filename = responses[0]!.headers.get("etag")!.replaceAll('"', "")
      const file = files.find((p) => String(p).endsWith(filename))!
      const path = join(config.dataDir, "media", String(file))
      const modified = statSync(path).mtimeMs
      yield* bytesOf(yield* get(id, "&w=384"))
      assert.strictEqual(statSync(path).mtimeMs, modified)
      assert.isFalse(
        readdirSync(join(config.dataDir, "media"), { recursive: true }).some((p) => String(p).endsWith(".tmp"))
      )
    })
  )

  it.effect("returns 404 for corrupt or missing files and preserves APNG animation", () =>
    Effect.gen(function* () {
      const broken = yield* upload(largeImagePng(46, 100, 50))
      const reader = yield* Reader
      const api = broken.api
      const user = yield* api.Whoami()
      const file = yield* reader.GetMediaFile({ userId: user.id, mediaId: broken.id })
      unprepare(file.path)
      writeFileSync(join(config.dataDir, file.path), "broken")
      assert.strictEqual((yield* get(broken.id, "&w=96")).status, 404)
      rmSync(join(config.dataDir, file.path))
      assert.strictEqual((yield* get(broken.id, "&w=96")).status, 404)
      const png = largeImagePng(47, 100, 50)
      const animation = Buffer.concat([
        png.subarray(0, 33),
        chunk("acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])),
        png.subarray(33)
      ])
      const animated = yield* upload(animation, "APNG")
      const response = yield* get(animated.id, "&w=96")
      assert.strictEqual(response.headers.get("content-type"), "image/png")
      assert.deepStrictEqual(yield* bytesOf(response), animation)
    })
  )

  it.effect("serves animated GIF and WebP originals without dropping frames", () =>
    Effect.gen(function* () {
      const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0])
      for (const format of ["gif", "webp"] as const) {
        const bytes = yield* Effect.promise(() =>
          sharp(pixels, {
            raw: { width: 2, height: 2, channels: 3, pageHeight: 1 }
          })
            .toFormat(format, { loop: 0, delay: [100, 100] })
            .toBuffer()
        )
        assert.strictEqual((yield* Effect.promise(() => sharp(bytes).metadata())).pages, 2)
        const { id } = yield* upload(bytes, `Animated ${format}`)
        for (let repeat = 0; repeat < 2; repeat++) {
          const response = yield* get(id, "&w=192")
          assert.strictEqual(response.headers.get("content-type"), `image/${format}`)
          assert.deepStrictEqual(yield* bytesOf(response), bytes)
        }
      }
    })
  )
})
