// The file manager's HTTP routes (spec/FILES-AND-ENVIRONMENT.md §1.1, §8.1; `@rp/shared/files.ts`) at
// the real boundary: upload with the batch's conflict answers, listing, Range reads, folders,
// renames, deletion, and links planted in the tree listed but never followed. Synthetic files only.
import { assert, describe, it } from "@effect/vitest"
import { readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { FolderListing } from "@rp/shared/files.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { serverLayer, serverPort, testConfig } from "./support/config.ts"

const call = (path: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    return yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}${path}`, init))
  })

const json = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const upload = (path: string, text: string, conflict = "ask") =>
  call(`/files/upload?${new URLSearchParams({ path, conflict })}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: text
  })

const list = (path: string) =>
  Effect.gen(function* () {
    const response = yield* call(`/files/list?${new URLSearchParams({ path })}`)
    assert.strictEqual(response.status, 200)
    return (yield* Effect.promise(() => response.json())) as FolderListing
  })

const body = (response: Response) => Effect.promise(() => response.text())

describe("file routes", () => {
  it.live("upload, list, read, rename, make folders and delete", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      assert.deepStrictEqual((yield* list("/files")).entries, [])

      const first = yield* upload("/files/thesis/notes.md", "Synthetic notes.")
      assert.deepStrictEqual(yield* Effect.promise(() => first.json()), {
        path: "/files/thesis/notes.md",
        outcome: "written"
      })
      // A taken name asks, then takes the batch's answer.
      assert.strictEqual((yield* upload("/files/thesis/notes.md", "Again.")).status, 409)
      const kept = yield* upload("/files/thesis/notes.md", "Again.", "keep")
      assert.deepStrictEqual(yield* Effect.promise(() => kept.json()), {
        path: "/files/thesis/notes (2).md",
        outcome: "written"
      })
      const skipped = yield* upload("/files/thesis/notes.md", "Never.", "skip")
      assert.strictEqual(((yield* Effect.promise(() => skipped.json())) as { outcome: string }).outcome, "skipped")
      const replaced = yield* upload("/files/thesis/notes.md", "Replaced notes.", "replace")
      assert.strictEqual(((yield* Effect.promise(() => replaced.json())) as { outcome: string }).outcome, "replaced")

      const top = yield* list("/files")
      assert.deepStrictEqual(
        top.entries.map((e) => [e.name, e.kind]),
        [["thesis", "folder"]]
      )
      assert.strictEqual(top.bin, false)
      const thesis = yield* list("/files/thesis")
      assert.deepStrictEqual(
        thesis.entries.map((e) => [e.name, e.size]),
        [
          ["notes (2).md", 6],
          ["notes.md", 15]
        ]
      )

      // Bytes, inline for a known type and with Range; an attachment on request.
      const raw = yield* call("/files/raw?path=%2Ffiles%2Fthesis%2Fnotes.md")
      assert.strictEqual(raw.status, 200)
      assert.strictEqual(yield* body(raw), "Replaced notes.")
      assert.strictEqual(raw.headers.get("x-content-type-options"), "nosniff")
      assert.match(raw.headers.get("content-security-policy") ?? "", /sandbox/)
      const part = yield* call("/files/raw?path=%2Ffiles%2Fthesis%2Fnotes.md", { headers: { range: "bytes=0-7" } })
      assert.strictEqual(part.status, 206)
      assert.strictEqual(part.headers.get("content-range"), "bytes 0-7/15")
      assert.strictEqual(yield* body(part), "Replaced")
      const asFile = yield* call("/files/raw?path=%2Ffiles%2Fthesis%2Fnotes.md&download=1")
      assert.match(asFile.headers.get("content-disposition") ?? "", /^attachment/)
      yield* upload("/files/page.html", "<script>alert(1)</script>")
      const html = yield* call("/files/raw?path=%2Ffiles%2Fpage.html")
      assert.match(html.headers.get("content-disposition") ?? "", /^attachment/)
      assert.strictEqual(html.headers.get("content-type"), "application/octet-stream")

      // Folders, renames and moves.
      assert.strictEqual((yield* json("/files/folder", { path: "/files/thesis/figures" })).status, 200)
      assert.strictEqual((yield* json("/files/folder", { path: "/files/thesis/figures" })).status, 409)
      assert.strictEqual(
        (yield* json("/files/move", { from: "/files/thesis/notes (2).md", to: "/files/thesis/figures/old.md" })).status,
        200
      )
      assert.strictEqual(
        (yield* json("/files/move", { from: "/files/thesis/notes.md", to: "/files/thesis/figures/old.md" })).status,
        409
      )
      assert.strictEqual(
        (yield* json("/files/move", { from: "/files/thesis", to: "/files/thesis/figures/x" })).status,
        400
      )
      assert.deepStrictEqual(
        (yield* list("/files/thesis/figures")).entries.map((e) => e.name),
        ["old.md"]
      )

      // Delete: a file, then a folder with what's in it.
      const gone = yield* json("/files/delete", { path: "/files/thesis/notes.md" })
      assert.deepStrictEqual(yield* Effect.promise(() => gone.json()), { binItemId: null })
      assert.strictEqual((yield* json("/files/delete", { path: "/files/thesis" })).status, 200)
      assert.deepStrictEqual(
        (yield* list("/files")).entries.map((e) => e.name),
        ["page.html"]
      )
      assert.strictEqual((yield* json("/files/delete", { path: "/files" })).status, 400)
      assert.strictEqual((yield* call("/files/list?path=%2Ffiles%2F..%2F..")).status, 400)

      // A link planted by a command: listed as a link, never read through.
      const filesDir = join(config.dataDir, "files")
      const account = join(filesDir, readdirSync(filesDir)[0]!)
      writeFileSync(join(config.dataDir, "outside.txt"), "Not for the browser.")
      symlinkSync(join(config.dataDir, "outside.txt"), join(account, "leak.txt"))
      symlinkSync(config.dataDir, join(account, "data"))
      const linked = yield* list("/files")
      assert.deepStrictEqual(
        linked.entries.map((e) => [e.name, e.kind]),
        [
          ["data", "link"],
          ["leak.txt", "link"],
          ["page.html", "file"]
        ]
      )
      assert.strictEqual((yield* call("/files/raw?path=%2Ffiles%2Fleak.txt")).status, 400)
      assert.strictEqual((yield* call("/files/list?path=%2Ffiles%2Fdata")).status, 400)
      assert.strictEqual((yield* upload("/files/data/x.txt", "x")).status, 400)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })
})
