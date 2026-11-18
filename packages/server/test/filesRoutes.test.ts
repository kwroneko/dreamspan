// The file manager's HTTP routes (spec/FILES-AND-ENVIRONMENT.md §1.1, §8.1; `@rp/shared/files.ts`) at
// the real boundary: upload with the batch's conflict answers, listing, Range reads, folders,
// renames, deletion, and links planted in the tree listed but never followed. Synthetic files only.
import { assert, describe, it } from "@effect/vitest"
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { FolderListing } from "@rp/shared/files.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"

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
  it.live("refuses paths, links and origins that would leave the account's tree", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* upload("/files/a.txt", "Synthetic.")
      const filesDir = join(config.dataDir, "files")
      const account = join(filesDir, readdirSync(filesDir)[0]!)
      // Traversal in every spelling: decoded once, resolved, refused or kept as a literal name inside.
      for (const path of ["/files/../..", "/files/%2e%2e/%2e%2e", "/etc/passwd", "/files/a\0b", "../files", "~/x"]) {
        const response = yield* call(`/files/raw?${new URLSearchParams({ path })}`)
        assert.include([400, 404], response.status, path)
      }
      assert.strictEqual((yield* call("/files/raw?path=%2Ffiles%2F%00x")).status, 400)
      assert.strictEqual((yield* call("/files/raw?path=%2Ffiles%2F%252e%252e%2Fa.txt")).status, 404)
      assert.strictEqual((yield* upload("/files/../../escape.txt", "x")).status, 400)
      assert.strictEqual((yield* upload("/files/sub/../../../escape.txt", "x")).status, 400)
      assert.isFalse(existsSync(join(config.dataDir, "escape.txt")))
      assert.strictEqual(
        (yield* json("/files/move", { from: "/files/a.txt", to: "/files/../../moved.txt" })).status,
        400
      )
      assert.strictEqual((yield* json("/files/move", { from: "/files/../../x", to: "/files/b.txt" })).status, 400)
      assert.strictEqual((yield* json("/files/move", { from: "/files/a.txt", to: "/files" })).status, 400)
      assert.strictEqual((yield* json("/files/delete", { path: "/files/.." })).status, 400)
      assert.strictEqual((yield* json("/files/delete", { path: "/" })).status, 400)

      // Moving into, or uploading through, a linked folder is refused.
      const outside = join(config.dataDir, "outside")
      mkdirSync(outside)
      writeFileSync(join(outside, "keep.txt"), "Outside the tree.")
      symlinkSync(outside, join(account, "out"))
      assert.strictEqual((yield* json("/files/move", { from: "/files/a.txt", to: "/files/out/a.txt" })).status, 400)
      assert.strictEqual((yield* upload("/files/out/x.txt", "x")).status, 400)

      // A recursive delete removes a link inside the folder, never what it points at.
      yield* upload("/files/doomed/inner/f.txt", "x")
      symlinkSync(outside, join(account, "doomed", "inner", "link"))
      assert.strictEqual((yield* json("/files/delete", { path: "/files/doomed" })).status, 200)
      assert.isTrue(existsSync(join(outside, "keep.txt")))
      assert.isFalse(existsSync(join(account, "doomed")))

      // SVG and XML are attachments, never the app's own content.
      for (const name of ["x.svg", "x.xml", "x.xhtml", "x.htm"]) {
        yield* upload(`/files/${name}`, "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>")
        const response = yield* call(`/files/raw?${new URLSearchParams({ path: `/files/${name}` })}`)
        assert.match(response.headers.get("content-disposition") ?? "", /^attachment/, name)
        assert.strictEqual(response.headers.get("content-type"), "application/octet-stream", name)
        assert.match(response.headers.get("content-security-policy") ?? "", /^sandbox/, name)
      }

      // Ranges past the end are refused; a suffix reads the tail.
      const tail = yield* call("/files/raw?path=%2Ffiles%2Fa.txt", { headers: { range: "bytes=-4" } })
      assert.strictEqual(yield* body(tail), "tic.")
      const past = yield* call("/files/raw?path=%2Ffiles%2Fa.txt", { headers: { range: "bytes=99-" } })
      assert.strictEqual(past.status, 416)

      // A cross-site page can't change files.
      const cross = yield* call("/files/delete", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ path: "/files/a.txt" })
      })
      assert.strictEqual(cross.status, 403)
      assert.strictEqual(
        (yield* list("/files")).entries.some((e) => e.name === "a.txt"),
        true
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })

  it.live("uploads count against the account's Files quota, declared or streamed", () => {
    const config = testConfig({ filesQuota: "1M" })
    const bytes = (size: number) => "x".repeat(size)
    // A body of unknown length, in chunks: only the streaming check can stop it.
    const streamed = (path: string, size: number) =>
      Effect.gen(function* () {
        const port = yield* serverPort
        return yield* Effect.promise(async () => {
          const chunk = new Uint8Array(64 * 1024).fill(120)
          let sent = 0
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent >= size) return controller.close()
              sent += chunk.byteLength
              controller.enqueue(chunk)
            }
          })
          const response = await fetch(`http://127.0.0.1:${port}/files/upload?${new URLSearchParams({ path })}`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body,
            duplex: "half"
          } as RequestInit)
          return { status: response.status, text: await response.text() }
        })
      })
    return Effect.gen(function* () {
      assert.strictEqual((yield* upload("/files/a.bin", bytes(600_000))).status, 200)
      // Declared past the quota: refused before a byte is written.
      const declared = yield* upload("/files/b.bin", bytes(600_000))
      assert.strictEqual(declared.status, 507)
      assert.match(
        yield* body(declared),
        /Your files use .* of .*\. Delete files you don't need to upload files again\./
      )
      // Streamed with no length: stopped once it runs out of room, answered (the rest of the
      // body is read and dropped, not a reset connection), and nothing is left behind.
      const stream = yield* streamed("/files/c.bin", 900_000)
      assert.strictEqual(stream.status, 507)
      assert.match(stream.text, /upload files again/)
      const names = (yield* list("/files")).entries.map((e) => e.name)
      assert.deepStrictEqual(names, ["a.bin"])
      const raw = readdirSync(join(config.dataDir, "files"), { recursive: true }).map(String)
      assert.isFalse(
        raw.some((name) => name.endsWith(".rp-tmp")),
        raw.join(", ")
      )
      // Replacing a file counts only what it adds.
      const replaced = yield* upload("/files/a.bin", bytes(700_000), "replace")
      assert.strictEqual(replaced.status, 200, yield* body(replaced))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })

  it.live("deleting a folder gives its room back without a new walk; a deleted file's version still counts", () => {
    const config = testConfig({ filesQuota: "1M" })
    const bytes = (size: number) => "x".repeat(size)
    return Effect.gen(function* () {
      assert.strictEqual((yield* upload("/files/a.bin", bytes(500_000))).status, 200)
      for (const name of ["x", "y", "z"]) assert.strictEqual((yield* upload(`/files/dir/${name}.bin`, bytes(150_000))).status, 200)
      assert.strictEqual((yield* upload("/files/more.bin", bytes(200_000))).status, 507)
      // A folder's files aren't versioned: all they hold comes off the figure at once.
      assert.strictEqual((yield* json("/files/delete", { path: "/files/dir" })).status, 200)
      assert.strictEqual((yield* upload("/files/b.bin", bytes(400_000))).status, 200)
      // A deleted file's kept version holds its bytes: no room comes back (and none is claimed).
      assert.strictEqual((yield* json("/files/delete", { path: "/files/b.bin" })).status, 200)
      assert.strictEqual((yield* upload("/files/c.bin", bytes(200_000))).status, 507)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })

  it.live("the cached figure follows replaces, folders and refused uploads, and a refresh walks nothing", () => {
    const config = testConfig({ filesQuota: "2M" })
    const bytes = (size: number) => "x".repeat(size)
    const streamed = (path: string, size: number) =>
      Effect.gen(function* () {
        const port = yield* serverPort
        return yield* Effect.promise(async () => {
          const chunk = new Uint8Array(64 * 1024).fill(120)
          let sent = 0
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent >= size) return controller.close()
              sent += chunk.byteLength
              controller.enqueue(chunk)
            }
          })
          const response = await fetch(`http://127.0.0.1:${port}/files/upload?${new URLSearchParams({ path })}`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: stream,
            duplex: "half"
          } as RequestInit)
          return response.status
        })
      })
    return Effect.gen(function* () {
      const api = yield* client()
      const cached = api.GetFilesUsage({})
      const walked = api.GetFilesUsage({ fresh: true })
      /** The cached figure is the walk's, to the byte (a version counts once, as in the walk). */
      const agrees = Effect.gen(function* () {
        const figure = yield* cached
        const truth = yield* walked
        assert.strictEqual(figure.usedBytes, truth.usedBytes)
      })
      // The account's folders are made by its first request; the baseline walk comes after.
      assert.strictEqual((yield* upload("/files/warm.bin", "w")).status, 200)
      yield* walked
      assert.strictEqual((yield* upload("/files/r.bin", bytes(300_000))).status, 200)
      yield* agrees
      // Replaced by a smaller file, then a larger one.
      assert.strictEqual((yield* upload("/files/r.bin", bytes(100_000), "replace")).status, 200)
      yield* agrees
      assert.strictEqual((yield* upload("/files/r.bin", bytes(250_000), "replace")).status, 200)
      yield* agrees
      // A plain refresh and a delete read the figure without walking.
      const first = yield* cached
      assert.strictEqual((yield* json("/files/delete", { path: "/files/r.bin" })).status, 200)
      const second = yield* cached
      assert.strictEqual((yield* cached).measuredAt, first.measuredAt)
      assert.strictEqual(second.measuredAt, first.measuredAt)
      yield* agrees
      // New folders (made directly, or as an upload's parents) count, never under.
      const beforeFolders = yield* cached
      assert.strictEqual((yield* json("/files/folder", { path: "/files/one" })).status, 200)
      assert.strictEqual((yield* upload("/files/two/three/f.bin", bytes(1_000))).status, 200)
      const withFolders = yield* cached
      assert.isAbove(withFolders.usedBytes, beforeFolders.usedBytes + 1_000)
      assert.isAtLeast(withFolders.usedBytes, (yield* walked).usedBytes)
      // A refused upload leaves the figure where it was.
      assert.strictEqual((yield* upload("/files/a.bin", bytes(1_000_000))).status, 200)
      const beforeRefused = yield* cached
      assert.strictEqual(yield* streamed("/files/c.bin", 1_500_000), 507)
      assert.strictEqual((yield* cached).usedBytes, beforeRefused.usedBytes)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })

  it.live("hard-linked files: a replace frees nothing, a delete keeps the version's bytes counted", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const cached = api.GetFilesUsage({})
      const walked = api.GetFilesUsage({ fresh: true })
      const agrees = Effect.gen(function* () {
        const figure = yield* cached
        assert.strictEqual(figure.usedBytes, (yield* walked).usedBytes)
      })
      assert.strictEqual((yield* upload("/files/warm.bin", "w")).status, 200)
      const filesDir = join(config.dataDir, "files")
      const account = join(filesDir, readdirSync(filesDir)[0]!)
      assert.strictEqual((yield* upload("/files/h.bin", "h".repeat(200_000))).status, 200)
      linkSync(join(account, "h.bin"), join(account, "h2.bin"))
      yield* walked
      // The other link keeps the bytes; the version of what was deleted counts.
      assert.strictEqual((yield* json("/files/delete", { path: "/files/h.bin" })).status, 200)
      yield* agrees
      assert.strictEqual((yield* upload("/files/r.bin", "r".repeat(100_000))).status, 200)
      linkSync(join(account, "r.bin"), join(account, "r2.bin"))
      yield* walked
      // Replaced while linked: the old file stays (the link holds it), the new one and the version are added.
      assert.strictEqual((yield* upload("/files/r.bin", "s".repeat(150_000), "replace")).status, 200)
      yield* agrees
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })

  it.live("a delete that fails gives its bytes back", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      assert.strictEqual((yield* upload("/files/ro/sub/f.bin", "f".repeat(200_000))).status, 200)
      const filesDir = join(config.dataDir, "files")
      const sub = join(filesDir, readdirSync(filesDir)[0]!, "ro", "sub")
      yield* api.GetFilesUsage({ fresh: true })
      const before = yield* api.GetFilesUsage({})
      // A folder that can't be emptied: its parent is read-only.
      chmodSync(sub, 0o555)
      try {
        const refused = yield* json("/files/delete", { path: "/files/ro" })
        assert.isAtLeast(refused.status, 400)
      } finally {
        chmodSync(sub, 0o755)
      }
      const after = yield* api.GetFilesUsage({})
      assert.strictEqual(after.usedBytes, before.usedBytes)
      assert.strictEqual((yield* api.GetFilesUsage({ fresh: true })).usedBytes, before.usedBytes)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })
})
