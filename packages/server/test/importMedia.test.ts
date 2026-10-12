// Media files on disk and refused imports (ARCHITECTURE.md §11.1, §11.4): an import that's
// refused leaves no file behind, and the sweep deletes the files no row names.
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { uuidv7 } from "@rp/shared/id.ts"
import { ImportResult } from "@rp/shared/libraryImport.ts"
import { Effect, Schedule, Schema } from "effect"
import { cardChunk, png, stCardV2 } from "./formats/support.ts"
import { testConfig, withServer } from "./support/config.ts"

const presetFile = readFileSync(new URL("./fixtures/presets/default.json", import.meta.url))
const cardFile = () => png(cardChunk("chara", stCardV2()))

const upload = (port: number, bytes: Uint8Array, into?: string) =>
  Effect.promise(() =>
    fetch(`http://127.0.0.1:${port}/library/import?name=f${into ? `&into=${into}` : ""}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes
    })
  )

/** Every file under the media folder. */
const mediaFiles = (dataDir: string) => {
  const root = join(dataDir, "media")
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((folder) => readdirSync(join(root, folder)).map((name) => join(root, folder, name)))
}

const twoHoursAgo = () => (Date.now() - 2 * 60 * 60 * 1000) / 1000

describe("media files", () => {
  it.live("a refused import, into a ref that isn't there or of another kind, stores no file", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const missing = yield* upload(config.port, cardFile(), uuidv7())
      assert.strictEqual(missing.status, 404)
      assert.deepStrictEqual(mediaFiles(config.dataDir), [])

      const preset = Schema.decodeUnknownSync(ImportResult)(
        yield* Effect.promise(() => Effect.runPromise(upload(config.port, presetFile)).then((r) => r.json()))
      )
      const wrongKind = yield* upload(config.port, cardFile(), preset.library!.ref.id)
      assert.strictEqual(wrongKind.status, 409)
      assert.deepStrictEqual(mediaFiles(config.dataDir), [])
    }).pipe(withServer(config))
  })

  it.live("the sweep deletes old files no row names, and keeps recorded and recent ones", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* upload(config.port, cardFile()).pipe(withServer(config))
      const [recorded] = mediaFiles(config.dataDir)
      assert.isDefined(recorded)
      const folder = join(config.dataDir, "media", "ab")
      mkdirSync(folder, { recursive: true })
      const orphan = join(folder, "ab".padEnd(64, "0"))
      const leftover = join(folder, `${"ab".padEnd(64, "1")}.1234.tmp`)
      const recent = join(folder, "ab".padEnd(64, "2"))
      for (const file of [orphan, leftover, recent]) writeFileSync(file, "x")
      for (const file of [orphan, leftover, recorded!]) utimesSync(file, twoHoursAgo(), twoHoursAgo())

      // The next start sweeps.
      yield* Effect.sync(() => existsSync(orphan)).pipe(
        Effect.repeat({ until: (exists) => !exists, schedule: Schedule.spaced("200 millis"), times: 50 }),
        withServer(config)
      )
      assert.isFalse(existsSync(orphan))
      assert.isFalse(existsSync(leftover))
      assert.isTrue(existsSync(recent))
      assert.isTrue(existsSync(recorded!))
    })
  })
})
