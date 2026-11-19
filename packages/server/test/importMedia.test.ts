// Media files on disk and refused imports (ARCHITECTURE.md §11.1, §11.4): an import that's
// refused leaves no file behind, and the sweep deletes the files no row names.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { ImportResult } from "@dreamspan/shared/libraryImport.ts"
import { Effect, Schedule, Schema } from "effect"
import { mediaPath } from "../src/db/media.ts"
import { storeMedia, sweepMedia } from "../src/importer/mediaFiles.ts"
import { cardChunk, png, stCardV2 } from "./formats/support.ts"
import { serverPort, testConfig, withServer } from "./support/config.ts"
import { tempDir } from "./support/tempDir.ts"

const presetFile = readFileSync(new URL("./fixtures/presets/default.json", import.meta.url))
const cardFile = () => png(cardChunk("chara", stCardV2()))

/** An upload to the enclosing test server. */
const upload = (bytes: Uint8Array, into?: string) =>
  Effect.flatMap(serverPort, (port) =>
    Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}/library/import?name=f${into ? `&into=${into}` : ""}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
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
      const missing = yield* upload(cardFile(), uuidv7())
      assert.strictEqual(missing.status, 404)
      assert.deepStrictEqual(mediaFiles(config.dataDir), [])

      const preset = Schema.decodeUnknownSync(ImportResult)(
        yield* Effect.flatMap(upload(presetFile), (response) => Effect.promise(() => response.json()))
      )
      const wrongKind = yield* upload(cardFile(), preset.library!.ref.id)
      assert.strictEqual(wrongKind.status, 409)
      assert.deepStrictEqual(mediaFiles(config.dataDir), [])
    }).pipe(withServer(config))
  })

  it.live("the sweep deletes old files no row names, and keeps recorded and recent ones", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* upload(cardFile()).pipe(withServer(config))
      const [recorded] = mediaFiles(config.dataDir)
      assert.isDefined(recorded)
      const derivative = `${recorded!}.thumb-v1-192.webp`
      writeFileSync(derivative, "synthetic derivative")
      utimesSync(derivative, twoHoursAgo(), twoHoursAgo())
      const fallback = `${recorded!}.original-v1`
      writeFileSync(fallback, "")
      utimesSync(fallback, twoHoursAgo(), twoHoursAgo())
      const folder = join(config.dataDir, "media", "ab")
      mkdirSync(folder, { recursive: true })
      const orphan = join(folder, "ab".padEnd(64, "0"))
      const leftover = join(folder, `${"ab".padEnd(64, "1")}.1234.tmp`)
      const recent = join(folder, "ab".padEnd(64, "2"))
      const orphanDerivative = `${orphan}.thumb-v1-192.webp`
      writeFileSync(orphanDerivative, "synthetic orphan derivative")
      utimesSync(orphanDerivative, twoHoursAgo(), twoHoursAgo())
      const orphanFallback = `${orphan}.original-v1`
      writeFileSync(orphanFallback, "")
      utimesSync(orphanFallback, twoHoursAgo(), twoHoursAgo())
      for (const file of [orphan, leftover, recent]) writeFileSync(file, "x")
      for (const file of [orphan, leftover, recorded!]) utimesSync(file, twoHoursAgo(), twoHoursAgo())

      // The next start sweeps.
      yield* Effect.sync(() => existsSync(orphan)).pipe(
        // Up to 30 s: a busy host can take over 10 s to start the server and sweep.
        Effect.repeat({ until: (exists) => !exists, schedule: Schedule.spaced("200 millis"), times: 150 }),
        withServer(config)
      )
      assert.isFalse(existsSync(orphan))
      assert.isFalse(existsSync(leftover))
      assert.isFalse(existsSync(orphanDerivative))
      assert.isFalse(existsSync(orphanFallback))
      assert.isTrue(existsSync(derivative))
      assert.isTrue(existsSync(fallback))
      assert.isTrue(existsSync(recent))
      assert.isTrue(existsSync(recorded!))
    })
  })
})

describe("the sweep, against an import in progress and links", () => {
  const HOUR = 60 * 60 * 1000
  const fresh = () => tempDir("sweep")
  const old = (path: string) => utimesSync(path, twoHoursAgo(), twoHoursAgo())
  const sha = "ab".padEnd(64, "c")
  const bytes = new Uint8Array([1, 2, 3])
  const options = {
    graceMs: HOUR,
    pending: { has: () => false },
    isRecorded: () => Effect.succeed(false)
  }

  it.live("a file an import reuses is fresh again, so it waits for the import's commit", () =>
    Effect.gen(function* () {
      const dir = fresh()
      yield* storeMedia(dir, sha, bytes) // an import that failed
      old(join(dir, mediaPath(sha)))
      yield* storeMedia(dir, sha, bytes) // the next import of the same bytes, before its commit
      assert.strictEqual(yield* sweepMedia(dir, new Set(), options), 0)
      assert.isTrue(existsSync(join(dir, mediaPath(sha))))
    })
  )

  it.live("a file an import in progress holds stays, however old", () =>
    Effect.gen(function* () {
      const dir = fresh()
      yield* storeMedia(dir, sha, bytes)
      old(join(dir, mediaPath(sha)))
      const pending = { has: (hash: string) => hash === sha }
      assert.strictEqual(yield* sweepMedia(dir, new Set(), { ...options, pending }), 0)
      assert.isTrue(existsSync(join(dir, mediaPath(sha))))
    })
  )

  it.live("a file recorded after the sweep listed the recorded ones stays", () =>
    Effect.gen(function* () {
      const dir = fresh()
      yield* storeMedia(dir, sha, bytes)
      old(join(dir, mediaPath(sha)))
      // The commit lands between the sweep's listing and its deleting.
      let committed = false
      const deleted = yield* sweepMedia(dir, new Set(), {
        ...options,
        isRecorded: () => Effect.sync(() => committed),
        between: (step) =>
          Effect.sync(() => {
            if (step === "checked") committed = true
          })
      })
      assert.strictEqual(deleted, 0)
      assert.isTrue(existsSync(join(dir, mediaPath(sha))))
      // Without the commit, it goes.
      assert.strictEqual(yield* sweepMedia(dir, new Set(), options), 1)
    })
  )

  it.live("a file recorded after the sweep moved it aside is moved back", () =>
    Effect.gen(function* () {
      const dir = fresh()
      yield* storeMedia(dir, sha, bytes)
      old(join(dir, mediaPath(sha)))
      let committed = false
      const deleted = yield* sweepMedia(dir, new Set(), {
        ...options,
        isRecorded: () => Effect.sync(() => committed),
        between: (step) =>
          Effect.sync(() => {
            if (step === "moved aside") committed = true
          })
      })
      assert.strictEqual(deleted, 0)
      assert.isTrue(existsSync(join(dir, mediaPath(sha))))
      assert.deepStrictEqual(mediaFiles(dir), [join(dir, mediaPath(sha))])
    })
  )

  it.live("after a crash between moving a file aside and deleting it, a recorded file comes back", () =>
    Effect.gen(function* () {
      const dir = fresh()
      const kept = "ab".padEnd(64, "1")
      const twice = "ab".padEnd(64, "2")
      const gone = "ab".padEnd(64, "3")
      for (const hash of [kept, twice, gone]) yield* storeMedia(dir, hash, bytes)
      const folder = join(dir, "media", "ab")
      // Each moved aside, as a sweep does; the server stops before the sweep deletes them.
      const aside = (hash: string) => join(folder, `${hash}.${uuidv7()}.swept`)
      const keptAside = aside(kept)
      const goneAside = aside(gone)
      renameSync(join(folder, kept), keptAside)
      copyFileSync(join(folder, twice), aside(twice))
      renameSync(join(folder, gone), goneAside)
      // Recorded: kept and twice. Twice's own file is still there; gone isn't recorded.
      const recorded = new Set([kept, twice])
      yield* sweepMedia(dir, recorded, { ...options, isRecorded: (hash) => Effect.succeed(recorded.has(hash)) })
      assert.deepStrictEqual(mediaFiles(dir).sort(), [join(folder, kept), join(folder, twice)])
    })
  )

  it.live("links are never followed, so nothing outside the media folder is deleted", () =>
    Effect.gen(function* () {
      const outside = fresh()
      const precious = join(outside, "ab".padEnd(64, "d"))
      writeFileSync(precious, "x")
      old(precious)
      // A linked folder, and a linked file in a real folder.
      const dir = fresh()
      mkdirSync(join(dir, "media", "cd"), { recursive: true })
      symlinkSync(outside, join(dir, "media", "ab"))
      symlinkSync(precious, join(dir, "media", "cd", "cd".padEnd(64, "e")))
      yield* sweepMedia(dir, new Set(), options)
      // The media folder itself a link.
      const linked = fresh()
      symlinkSync(outside, join(linked, "media"))
      yield* sweepMedia(linked, new Set(), options)
      assert.isTrue(existsSync(precious))
    })
  )
})
