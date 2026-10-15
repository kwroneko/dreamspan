import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import sharp from "sharp"
import { readdirSync, statSync, writeFileSync, watch } from "node:fs"
import { basename, dirname, join } from "node:path"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { largeImagePng } from "./support/stLargeImages.ts"
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
const bytesOf = (response: Response) => Effect.promise(async () => Buffer.from(await response.arrayBuffer()))

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("image thumbnails", (it) => {
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

  it.effect("returns a controlled error for corrupt pixels and preserves APNG animation", () =>
    Effect.gen(function* () {
      const broken = yield* upload(largeImagePng(46, 100, 50))
      const reader = yield* Reader
      const api = broken.api
      const user = yield* api.Whoami()
      const file = yield* reader.GetMediaFile({ userId: user.id, mediaId: broken.id })
      writeFileSync(join(config.dataDir, file.path), "broken")
      assert.strictEqual((yield* get(broken.id, "&w=96")).status, 422)
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
