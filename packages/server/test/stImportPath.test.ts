// The ST data folder import from a folder's path (ARCHITECTURE.md §13): a synthetic ST folder
// (support/stFolder.ts) written to disk and imported by the server as a job
// (StartStPathImport), a large chat in several parts. The browser upload's tests
// (stImport.test.ts) cover what the import does with the files; this checks that the same
// folder read from disk gives the same import. The job itself (persisted, listed, cancelled,
// interrupted) is stImportJobs.test.ts; non-admins are refused in isolation.test.ts.
import { appendFileSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { assert, it as plain, layer } from "@effect/vitest"
import { Effect, Option } from "effect"
import { readStFolderFile } from "../src/importer/stFolderDisk.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { largeChat, stFolder } from "./support/stFolder.ts"
import { importStPath } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

// Where the folder browser starts (IMPORT_START_DIR), with an ST data folder in it.
const startDir = tempDir("st-start")
mkdirSync(join(startDir, "st-data/default-user"), { recursive: true })
mkdirSync(join(startDir, "notes"))
const config = { ...testConfig(), importStartDir: Option.some(startDir) }
const folder = new Map(stFolder("ST/data/default-user/"))
// More than one 8 MiB part.
const LARGE = "ST/data/default-user/chats/Bob/Bob - very long.jsonl"
folder.set(LARGE, largeChat(9_000))

/** The files in a new temporary folder. */
const onDisk = (files: ReadonlyMap<string, Uint8Array>) => {
  const root = tempDir("st-path")
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  return root
}

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("ST folder import by path", (it) => {
  it.effect(
    "imports a folder read from its path, a large chat in parts, as the upload does",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const root = onDisk(folder)
        const { job, report, notSent } = yield* importStPath(api, root, "ST/data/default-user/")
        assert.strictEqual(job.status, "complete")
        assert.strictEqual(job.mode, "path")
        assert.strictEqual(job.source, `${realpathSync(root)}/ST/data/default-user`)
        assert.deepStrictEqual(notSent, [])
        // The same counts as the upload of this folder (stImport.test.ts), plus the large chat.
        assert.deepStrictEqual(
          { ...report!.counts.card },
          { added: 6, updated: 0, unchanged: 0, skipped: 0, failed: 0 }
        )
        assert.strictEqual(report!.counts.persona?.added, 2)
        assert.strictEqual(report!.counts.lorebook?.added, 1)
        assert.strictEqual(report!.counts.preset?.added, 1)
        assert.deepStrictEqual(
          { ...report!.counts.chat },
          { added: 5, updated: 1, unchanged: 0, skipped: 1, failed: 0 }
        )
        assert.strictEqual(report!.counts.group_chat?.added, 1)
        assert.strictEqual(report!.greetingOnly, 1)
        assert.deepStrictEqual(
          report!.links.map((choice) => choice.path),
          ["chats/Twin/Twin - who.jsonl"]
        )
        assert.strictEqual(job.filesDone, job.filesTotal)
        assert.strictEqual(job.bytesDone, job.bytesTotal)
        // The large chat went in whole: every message of it.
        assert.isAtLeast(report!.messages, 9_000)

        // Choosing the card for the chat the import couldn't link reads it from disk again.
        const [choice] = report!.links
        const linked = yield* api.LinkStImportChat({
          importId: job.id,
          path: choice!.path,
          card: choice!.candidates[0]!.entityId
        })
        assert.strictEqual(linked.outcome, "added")
        const after = yield* api.GetStImport({ importId: job.id })
        assert.lengthOf(after.report!.links, 0)
        assert.strictEqual(after.report!.counts.chat?.added, 6)
        // A chat that isn't waiting for a card, and a path outside the folder, are refused.
        for (const path of [choice!.path, "../secret.key", "chats/Twin/../../secret.key"]) {
          const error = yield* Effect.flip(api.LinkStImportChat({ importId: job.id, path, card: "none" }))
          assert.strictEqual(error._tag, "StFolderUnreadable")
        }
      }),
    // Over 9,000 messages through the server and its workers: well past 30 s on a loaded host.
    180_000
  )

  it.effect("links a chat after the import's run is gone, knowing the folder again", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const root = onDisk(stFolder())
      const { job, report } = yield* importStPath(api, root)
      const [choice] = report!.links
      // Another import ends that run: the link reads what the chat needs from the folder again.
      const other = yield* api.StartStImport({ unsupported: [] })
      yield* api.FinishStImport({ importId: other.importId, notSent: [] })
      const linked = yield* api.LinkStImportChat({
        importId: job.id,
        path: choice!.path,
        card: choice!.candidates[1]!.entityId
      })
      // The first test linked the same file already, so it may be found as it is.
      assert.include(["added", "updated", "unchanged"], linked.outcome)
      const after = yield* api.GetStImport({ importId: job.id })
      assert.lengthOf(after.report!.links, 0)
      assert.strictEqual(after.job.status, "complete")
    })
  )

  it.effect("the folder browser starts at IMPORT_START_DIR and marks ST's data folder", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const listing = yield* api.ListFolder({ path: null })
      assert.strictEqual(listing.path, realpathSync(startDir))
      assert.deepStrictEqual(listing.folders, [
        { name: "notes", st: false },
        { name: "st-data", st: true }
      ])
      assert.strictEqual(listing.parent, realpathSync(join(startDir, "..")))
      const error = yield* Effect.flip(api.ListFolder({ path: "relative" }))
      assert.strictEqual(error._tag, "StFolderUnreadable")
    })
  )

  it.effect("refuses a relative path, a missing folder and an ST user that isn't in the folder", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const refused = <A, E extends { readonly _tag: string }>(call: Effect.Effect<A, E>) =>
        Effect.map(Effect.flip(call), (error) => error._tag)
      assert.strictEqual(yield* refused(api.ScanStFolder({ path: "ST/data" })), "StFolderUnreadable")
      assert.strictEqual(
        yield* refused(api.ScanStFolder({ path: join(tmpdir(), "rp-no-such-folder") })),
        "StFolderUnreadable"
      )
      assert.strictEqual(yield* refused(api.StartStPathImport({ path: "ST/data", prefix: "" })), "StFolderUnreadable")
      const root = onDisk(
        new Map([
          ["secret.key", new Uint8Array([1])],
          ["user/settings.json", new TextEncoder().encode("{}")]
        ])
      )
      // Only the prefixes the scan found: never one that climbs out of the folder.
      for (const prefix of ["../", "elsewhere/", "user"]) {
        assert.strictEqual(yield* refused(api.StartStPathImport({ path: root, prefix })), "StFolderUnreadable")
      }
      const { job } = yield* importStPath(api, root, "user/")
      assert.strictEqual(job.status, "complete")
      assert.strictEqual(job.filesTotal, 1)
    })
  )
})

plain.effect("a chat that changed after the scan is refused instead of mixing its versions", () =>
  Effect.gen(function* () {
    const root = onDisk(new Map([[LARGE, folder.get(LARGE)!]]))
    const userRoot = join(root, "ST/data/default-user")
    const path = "chats/Bob/Bob - very long.jsonl"
    const { size, mtimeMs } = statSync(join(userRoot, path))
    const first = yield* readStFolderFile(userRoot, path, { size, modifiedMs: mtimeMs }, 0, true)
    assert.isFalse(first.last)
    // ST writes a new message to the chat between two parts.
    appendFileSync(join(userRoot, path), "\n{}")
    const error = yield* Effect.flip(readStFolderFile(userRoot, path, { size, modifiedMs: mtimeMs }, first.next, true))
    assert.strictEqual(error._tag, "StFolderUnreadable")
    // A root relative to wherever the app was started.
    const relative = yield* Effect.flip(readStFolderFile("user", path, { size, modifiedMs: mtimeMs }, 0, true))
    assert.strictEqual(relative._tag, "StFolderUnreadable")
  })
)
