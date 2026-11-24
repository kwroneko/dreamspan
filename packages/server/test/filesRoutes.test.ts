// The file manager's HTTP routes (spec/FILES-AND-ENVIRONMENT.md §1.1, §8.1; `@dreamspan/shared/files.ts`) at
// the real boundary: upload with the batch's conflict answers, listing, Range reads, folders,
// renames, deletion, and links planted in the tree listed but never followed. Synthetic files only.
import { assert, describe, it } from "@effect/vitest"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  encodeText,
  type FolderListing,
  type TextFile,
  type UploadOutcome,
  type UploadUndoEntry
} from "@dreamspan/shared/files.ts"
import { Effect, Fiber } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { eventually } from "./support/generation.ts"

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

/** A zip's central directory entry signature. */
const CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02])

const body = (response: Response) => Effect.promise(() => response.text())

/** The one account's folder under FILES_DIR (the bin's `.bin` sits beside it). */
const accountOf = (filesDir: string) => readdirSync(filesDir).find((name) => name !== ".bin")!

describe("file routes", () => {
  it.live("Keep both checks numbered names past the listing limit", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* upload("/files/report.txt", "original")
      yield* upload("/files/report (2).txt", "first copy")
      const files = join(config.dataDir, "files")
      const root = join(files, accountOf(files))
      for (let n = 0; n < 5_000; n++) writeFileSync(join(root, `earlier-${n}`), "")
      const listing = yield* list("/files")
      assert.strictEqual(listing.entries.length, 5_000)
      assert.isFalse(listing.entries.some(({ name }) => name === "report (2).txt"))
      const uploaded = yield* upload("/files/report.txt", "second copy", "keep")
      assert.strictEqual(uploaded.status, 200)
      assert.deepInclude((yield* Effect.promise(() => uploaded.json())) as object, { path: "/files/report (3).txt" })
      assert.strictEqual(yield* body(yield* call("/files/raw?path=/files/report%20(2).txt")), "first copy")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })

  it.live("upload Undo removes only the created entries while they still match", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* upload("/files/existing/keep.txt", "prior content")
      const added = yield* upload("/files/existing/new/nested/added.txt", "uploaded content")
      const receipt = ((yield* Effect.promise(() => added.json())) as UploadOutcome).created!
      assert.deepStrictEqual(
        receipt.map(({ path, kind }) => [path, kind]),
        [
          ["/files/existing/new", "folder"],
          ["/files/existing/new/nested", "folder"],
          ["/files/existing/new/nested/added.txt", "file"]
        ]
      )
      const edited = yield* upload("/files/existing/new/edited.txt", "uploaded content")
      const editedReceipt = ((yield* Effect.promise(() => edited.json())) as UploadOutcome).created![0]!
      yield* upload(editedReceipt.path, "changed content", "replace")
      const undo = (entry: UploadUndoEntry) => json("/files/delete", { path: entry.path, upload: entry })
      assert.strictEqual((yield* undo(editedReceipt)).status, 200)
      for (const entry of receipt.toReversed()) assert.strictEqual((yield* undo(entry)).status, 200)
      assert.deepStrictEqual(
        (yield* list("/files/existing")).entries.map(({ name }) => name),
        ["keep.txt", "new"]
      )
      assert.deepStrictEqual(
        (yield* list("/files/existing/new")).entries.map(({ name }) => name),
        ["edited.txt"]
      )

      const empty = yield* json("/files/folder", { path: "/files/existing/empty/nested", upload: true })
      const emptyReceipt = (yield* Effect.promise(() => empty.json())) as { created: Array<UploadUndoEntry> }
      assert.deepStrictEqual(
        emptyReceipt.created.map(({ path }) => path),
        ["/files/existing/empty", "/files/existing/empty/nested"]
      )
      for (const entry of emptyReceipt.created.toReversed()) assert.strictEqual((yield* undo(entry)).status, 200)
      assert.deepStrictEqual(
        (yield* list("/files/existing")).entries.map(({ name }) => name),
        ["keep.txt", "new"]
      )
      const api = yield* client()
      const me = yield* api.Whoami()
      yield* api.SetFilesQuota({ userId: me.id, quotaBytes: 1 })
      assert.strictEqual((yield* upload("/files/refused/empty/upload.txt", "refused")).status, 507)
      assert.deepStrictEqual(
        (yield* list("/files")).entries.map(({ name }) => name),
        ["existing"]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })

  it.live("upload, list, read, rename, make folders and delete", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      assert.deepStrictEqual((yield* list("/files")).entries, [])

      const first = yield* upload("/files/thesis/notes.md", "Synthetic notes.")
      assert.deepInclude((yield* Effect.promise(() => first.json())) as object, {
        path: "/files/thesis/notes.md",
        outcome: "written"
      })
      // A taken name asks, then takes the batch's answer.
      assert.strictEqual((yield* upload("/files/thesis/notes.md", "Again.")).status, 409)
      const kept = yield* upload("/files/thesis/notes.md", "Again.", "keep")
      assert.deepInclude((yield* Effect.promise(() => kept.json())) as object, {
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
      assert.strictEqual(top.bin, true)
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

      // Delete: a file, then a folder with what's in it, each to the bin (§1.3).
      const gone = yield* json("/files/delete", { path: "/files/thesis/notes.md" })
      const { binItemId: fileItem } = (yield* Effect.promise(() => gone.json())) as { binItemId: string }
      assert.isString(fileItem)
      const folderGone = yield* json("/files/delete", { path: "/files/thesis" })
      const { binItemId: folderItem } = (yield* Effect.promise(() => folderGone.json())) as { binItemId: string }
      assert.deepStrictEqual(
        (yield* list("/files")).entries.map((e) => e.name),
        ["page.html"]
      )
      const api = yield* client()
      const binned = yield* api.ListBin({ limit: 50, before: null })
      assert.deepStrictEqual(
        binned.map((item) => [item.kind, item.title, item.excerpt, item.origin.entryKind]),
        [
          ["file", "thesis", "/files/thesis", "folder"],
          ["file", "notes.md", "/files/thesis/notes.md", "file"]
        ]
      )
      // The bin's content is outside the tree commands see.
      assert.isTrue(existsSync(join(config.dataDir, "files", ".bin")))
      // Restore: the folder comes back at its path; the file then finds its folder there.
      const back = yield* json("/files/restore", { binItemId: folderItem })
      assert.deepStrictEqual(yield* Effect.promise(() => back.json()), { path: "/files/thesis" })
      assert.deepStrictEqual(
        (yield* list("/files/thesis")).entries.map((e) => e.name),
        ["figures"]
      )
      // Its name taken by then: it comes back as "(restored)".
      assert.strictEqual((yield* upload("/files/thesis/notes.md", "Newer notes.")).status, 200)
      const second = yield* json("/files/restore", { binItemId: fileItem })
      assert.deepStrictEqual(yield* Effect.promise(() => second.json()), { path: "/files/thesis/notes (restored).md" })
      const restored = yield* call("/files/raw?path=%2Ffiles%2Fthesis%2Fnotes%20(restored).md")
      assert.strictEqual(yield* body(restored), "Replaced notes.")
      // Restoring twice: it isn't in the bin any more.
      assert.strictEqual((yield* json("/files/restore", { binItemId: fileItem })).status, 404)
      assert.deepStrictEqual(yield* api.ListBin({ limit: 50, before: null }), [])
      // Delete again and empty the bin: the content goes from disk.
      assert.strictEqual((yield* json("/files/delete", { path: "/files/thesis" })).status, 200)
      const items = yield* api.ListBin({ limit: 50, before: null })
      assert.deepStrictEqual(yield* api.EmptyBin({ itemIds: items.map((item) => item.id) }), { purged: 1 })
      const binDir = join(config.dataDir, "files", ".bin")
      assert.deepStrictEqual(readdirSync(join(binDir, readdirSync(binDir)[0]!)), [])
      assert.deepStrictEqual(
        (yield* list("/files")).entries.map((e) => e.name),
        ["page.html"]
      )
      assert.strictEqual((yield* json("/files/delete", { path: "/files" })).status, 400)
      assert.strictEqual((yield* call("/files/list?path=%2Ffiles%2F..%2F..")).status, 400)

      // A link planted by a command: listed as a link, never read through.
      const filesDir = join(config.dataDir, "files")
      const account = join(filesDir, accountOf(filesDir))
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
  it.live("a folder zip leaves out names an extractor could read as paths elsewhere", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* upload("/files/out/keep.txt", "Kept.")
      yield* upload("/files/out/Left out of this zip.txt", "My file.")
      const filesDir = join(config.dataDir, "files")
      const out = join(filesDir, accountOf(filesDir), "out")
      mkdirSync(join(out, "empty"))
      // Names a command (or a prompt-injected assistant) can make: a backslash path, a folder of one.
      writeFileSync(join(out, "..\\..\\AppData\\x.bat"), "Synthetic.")
      mkdirSync(join(out, "a\\b"))
      writeFileSync(join(out, "a\\b", "inner.txt"), "Synthetic.")
      writeFileSync(join(out, "bell\u0007.txt"), "Synthetic.")
      const response = yield* call(`/files/zip?${new URLSearchParams({ path: "/files/out" })}`)
      assert.strictEqual(response.status, 200)
      const bytes = Buffer.from(yield* Effect.promise(() => response.arrayBuffer()))
      // The central directory's names.
      const names: Array<string> = []
      for (let at = bytes.indexOf(CENTRAL); at !== -1; at = bytes.indexOf(CENTRAL, at + 4)) {
        const length = bytes.readUInt16LE(at + 28)
        const name = bytes.subarray(at + 46, at + 46 + length).toString("utf8")
        names.push(name)
        if (name.endsWith("/")) assert.strictEqual(bytes.readUInt32LE(at + 38) & 0x10, 0x10)
      }
      assert.deepStrictEqual(names.sort(), [
        "out/",
        "out/Left out of this zip (2).txt",
        "out/Left out of this zip.txt",
        "out/empty/",
        "out/keep.txt"
      ])
      for (const name of names) assert.notInclude(name, "\\")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })
  it.live("two saves on the same base: one lands, the other is told it changed, and nothing is lost unkept", () => {
    // review files4b finding 3: both passed the check before their bodies arrived, and the second
    // rename overwrote the first save with no version holding it.
    const hash = (text: string) => createHash("sha256").update(text).digest("hex")
    return Effect.gen(function* () {
      const port = yield* serverPort
      yield* upload("/files/race/plan.md", "Original.")
      let open!: () => void
      const gate = new Promise<void>((resolve) => (open = resolve))
      const slowSave = (text: string) =>
        fetch(
          `http://127.0.0.1:${port}/files/upload?${new URLSearchParams({ path: "/files/race/plan.md", conflict: "replace", base: hash("Original.") })}`,
          {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            duplex: "half",
            body: new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode(text.slice(0, 1)))
                await gate
                controller.enqueue(new TextEncoder().encode(text.slice(1)))
                controller.close()
              }
            })
          } as RequestInit
        )
      const both = Promise.all([slowSave("From the first tab."), slowSave("From the second tab.")])
      // Both have passed the check made as they start; then their bodies end together.
      yield* Effect.sleep("400 millis")
      open()
      const answers = yield* Effect.promise(() => both)
      assert.deepStrictEqual(answers.map((answer) => answer.status).sort(), [200, 409])
      const won = answers[0]!.status === 200 ? "From the first tab." : "From the second tab."
      assert.deepInclude((yield* Effect.promise(() => answers.find((a) => a.status === 409)!.json())) as object, {
        changed: true
      })
      assert.strictEqual(yield* body(yield* call("/files/raw?path=%2Ffiles%2Frace%2Fplan.md")), won)
      const versions = (yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/files/versions?path=%2Ffiles%2Frace%2Fplan.md`).then((r) => r.json())
      )) as Array<{ origin: string; byteSize: number }>
      assert.deepStrictEqual(
        versions.map((version) => [version.origin, version.byteSize]),
        [["editor", "Original.".length]]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  })
  it.live("the editor keeps a file's line breaks and byte order mark", () => {
    // review files4b finding 4: a CRLF file with a BOM came back LF and without it after one edit.
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
    return Effect.gen(function* () {
      const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("one\r\ntwo\r\nthree\n")])
      yield* call(`/files/upload?${new URLSearchParams({ path: "/files/eol/win.csv", conflict: "ask" })}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
      const read = yield* call("/files/text?path=%2Ffiles%2Feol%2Fwin.csv")
      const opened = (yield* Effect.promise(() => read.json())) as TextFile
      // Mixed: two CRLF and one LF, so CRLF; the text as the editor holds it.
      assert.deepInclude(opened, { text: "one\ntwo\nthree\n", lineEnding: "crlf", bom: true, sha256: hash(bytes) })
      const edited = encodeText(opened.text.replace("two", "TWO"), opened.lineEnding, opened.bom)
      const saved = yield* call(
        `/files/upload?${new URLSearchParams({ path: "/files/eol/win.csv", conflict: "replace", base: opened.sha256 })}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: edited }
      )
      assert.strictEqual(saved.status, 200)
      const served = yield* call("/files/raw?path=%2Ffiles%2Feol%2Fwin.csv")
      const raw = new Uint8Array(yield* Effect.promise(() => served.arrayBuffer()))
      assert.deepStrictEqual([...raw], [0xef, 0xbb, 0xbf, ...new TextEncoder().encode("one\r\nTWO\r\nthree\r\n")])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  })
  it.live(
    "the editor: a text file with its hash, a save only onto what it opened, and drafts that follow a move",
    () => {
      const config = testConfig()
      const hash = (text: string) => createHash("sha256").update(text).digest("hex")
      const save = (path: string, text: string, base: string) =>
        call(`/files/upload?${new URLSearchParams({ path, conflict: "replace", base })}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: text
        })
      return Effect.gen(function* () {
        const api = yield* client()
        yield* upload("/files/draft/notes.md", "First text.")
        const opened = yield* call("/files/text?path=%2Ffiles%2Fdraft%2Fnotes.md")
        assert.strictEqual(opened.status, 200)
        const file = (yield* Effect.promise(() => opened.json())) as { text: string; sha256: string; size: number }
        assert.deepInclude(file, { text: "First text.", sha256: hash("First text."), size: 11 })

        // A save names the hash it was typed on; the earlier content is kept as an editor version.
        const saved = yield* save("/files/draft/notes.md", "Second text.", file.sha256)
        assert.strictEqual(saved.status, 200)
        assert.deepInclude((yield* Effect.promise(() => saved.json())) as object, {
          outcome: "replaced",
          sha256: hash("Second text.")
        })
        // The same base again: the file changed since, so nothing is written.
        const stale = yield* save("/files/draft/notes.md", "Lost?", file.sha256)
        assert.strictEqual(stale.status, 409)
        assert.deepInclude((yield* Effect.promise(() => stale.json())) as object, { changed: true })
        assert.strictEqual(yield* body(yield* call("/files/raw?path=%2Ffiles%2Fdraft%2Fnotes.md")), "Second text.")
        // A base names a file that is there: a missing one isn't made by a save.
        assert.strictEqual((yield* save("/files/draft/none.md", "x", file.sha256)).status, 409)
        assert.strictEqual((yield* save("/files/draft/notes.md", "x", "nothex")).status, 400)

        // Bytes that aren't UTF-8 aren't opened as text; a missing file is 404.
        yield* call(`/files/upload?${new URLSearchParams({ path: "/files/draft/blob.txt", conflict: "ask" })}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array([0xff, 0xfe, 0x00, 0xc3])
        })
        assert.strictEqual((yield* call("/files/text?path=%2Ffiles%2Fdraft%2Fblob.txt")).status, 415)
        assert.strictEqual((yield* call("/files/text?path=%2Ffiles%2Fdraft%2Fgone.txt")).status, 404)
        assert.strictEqual((yield* call("/files/text?path=%2Fetc%2Fpasswd")).status, 400)

        // An unsaved edit is a draft of its path; moving the folder in the app takes it along.
        const draft = yield* api.SaveFileDraft({
          path: "/files/draft/notes.md",
          draftId: null,
          content: "Unsaved text.",
          expectedRowVersion: null,
          expectedSession: null,
          baseSha256: hash("Second text.")
        })
        assert.strictEqual(draft.baseRevision, hash("Second text."))
        assert.strictEqual((yield* json("/files/move", { from: "/files/draft", to: "/files/moved" })).status, 200)
        assert.isNull(yield* api.GetFileDraft({ path: "/files/draft/notes.md" }))
        const moved = yield* api.GetFileDraft({ path: "/files/moved/notes.md" })
        assert.strictEqual(moved?.content, "Unsaved text.")
        // Paths outside the user's Files name nothing.
        const outside = yield* Effect.flip(api.GetFileDraft({ path: "/files/../etc/passwd" }))
        assert.strictEqual(outside._tag, "NotFound")
        const ended = yield* api.EndFileDraft({
          path: "/files/moved/notes.md",
          draftId: moved!.id,
          expectedRowVersion: moved!.rowVersion,
          outcome: "committed"
        })
        assert.strictEqual(ended.status, "committed")
      }).pipe(Effect.provide(serverLayer(config)))
    }
  )

  it.live("refuses paths, links and origins that would leave the account's tree", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      yield* upload("/files/a.txt", "Synthetic.")
      const filesDir = join(config.dataDir, "files")
      const account = join(filesDir, accountOf(filesDir))
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
      // Emptying the bin removes the link in it, never what it points at.
      const doomed = yield* (yield* client()).ListBin({ limit: 50, before: null })
      yield* (yield* client()).EmptyBin({ itemIds: doomed.map((item) => item.id) })
      assert.isTrue(existsSync(join(outside, "keep.txt")))

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
        /Your files use .* of .*\. Delete files you don't need and empty the bin to upload files again\./
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

  it.live("the bin keeps counting a deleted folder; emptying it gives the room back without a new walk", () => {
    const config = testConfig({ filesQuota: "1M" })
    const bytes = (size: number) => "x".repeat(size)
    return Effect.gen(function* () {
      const api = yield* client()
      assert.strictEqual((yield* upload("/files/a.bin", bytes(500_000))).status, 200)
      for (const name of ["x", "y", "z"])
        assert.strictEqual((yield* upload(`/files/dir/${name}.bin`, bytes(150_000))).status, 200)
      assert.strictEqual((yield* upload("/files/more.bin", bytes(200_000))).status, 507)
      // In the bin, its bytes still count (§1.2).
      assert.strictEqual((yield* json("/files/delete", { path: "/files/dir" })).status, 200)
      assert.strictEqual((yield* upload("/files/b.bin", bytes(400_000))).status, 507)
      const walked = yield* api.GetFilesUsage({ fresh: true })
      assert.isAtLeast(walked.binBytes, 450_000)
      // Emptied: the room comes back at once.
      const before = yield* api.GetFilesUsage({})
      const items = yield* api.ListBin({ limit: 50, before: null })
      yield* api.EmptyBin({ itemIds: items.map((item) => item.id) })
      assert.strictEqual((yield* api.GetFilesUsage({})).measuredAt, before.measuredAt)
      assert.strictEqual((yield* upload("/files/b.bin", bytes(400_000))).status, 200)
      // A large deleted file never pushes other deleted items out: its bytes aren't the bin's limit's.
      assert.strictEqual((yield* json("/files/delete", { path: "/files/a.bin" })).status, 200)
      assert.strictEqual((yield* api.ListBin({ limit: 50, before: null })).length, 1)
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

  it.live("concurrent replacements credit only the files they actually replace", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const file = "/files/race.bin"
      assert.strictEqual((yield* upload(file, "x".repeat(100_000))).status, 200)
      yield* api.GetFilesUsage({ fresh: true })
      const root = join(config.dataDir, "files", (yield* api.Whoami()).id)
      const start = (byte: number) => {
        const stream = new TransformStream<Uint8Array>()
        const writer = stream.writable.getWriter()
        const send = call(`/files/upload?${new URLSearchParams({ path: file, conflict: "replace" })}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: stream.readable,
          duplex: "half"
        } as RequestInit)
        return { send, writer, chunk: new Uint8Array(20_000).fill(byte) }
      }
      const a = start(65)
      const b = start(66)
      const first = yield* Effect.forkChild(a.send)
      const second = yield* Effect.forkChild(b.send)
      yield* Effect.promise(() => Promise.all([a.writer.write(a.chunk), b.writer.write(b.chunk)]))
      // Both requests have already checked the original file when both staging files exist.
      yield* eventually(() => readdirSync(root).filter((name) => name.endsWith(".rp-tmp")).length === 2)
      yield* Effect.promise(() => a.writer.close())
      assert.strictEqual((yield* Fiber.join(first)).status, 200)
      yield* Effect.promise(() => b.writer.close())
      assert.strictEqual((yield* Fiber.join(second)).status, 200)
      const cached = yield* api.GetFilesUsage({})
      const measured = yield* api.GetFilesUsage({ fresh: true })
      assert.strictEqual(cached.usedBytes, measured.usedBytes)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })

  it.live("a quota walk counts a staged upload only until the request is abandoned", () => {
    const config = testConfig({ filesQuota: "1M" })
    return Effect.gen(function* () {
      const api = yield* client()
      assert.strictEqual((yield* upload("/files/warm.bin", "warm")).status, 200)
      const root = join(config.dataDir, "files", (yield* api.Whoami()).id)
      writeFileSync(join(root, ".ordinary.rp-tmp"), Buffer.alloc(10_000))
      const baseline = yield* api.GetFilesUsage({ fresh: true })
      assert.isAtLeast(baseline.filesBytes, 10_004)

      const stop = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => stop.abort()))
      const stream = new TransformStream<Uint8Array>()
      const writer = stream.writable.getWriter()
      const request = yield* Effect.forkChild(
        Effect.exit(
          call("/files/upload?path=/files/stalled.bin", {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: stream.readable,
            duplex: "half",
            signal: stop.signal
          } as RequestInit)
        )
      )
      const staged = () => readdirSync(root).find((name) => name.startsWith(".stalled.bin."))
      const bytes = 600_000
      yield* Effect.promise(() => writer.write(new Uint8Array(bytes)))
      yield* eventually(() => {
        const name = staged()
        return name !== undefined && statSync(join(root, name)).size === bytes
      })

      const walked = yield* api.GetFilesUsage({ fresh: true })
      assert.isBelow(walked.filesBytes, baseline.filesBytes + 4096)
      const during = yield* api.GetFilesUsage({})
      assert.strictEqual(during.usedBytes, walked.usedBytes + bytes)
      stop.abort()
      yield* Fiber.join(request)
      yield* eventually(() => staged() === undefined)
      const after = yield* api.GetFilesUsage({})
      assert.strictEqual(after.usedBytes, during.usedBytes - bytes)
      assert.strictEqual(after.measuredAt, during.measuredAt)
      assert.strictEqual((yield* upload("/files/next.bin", "x".repeat(500_000))).status, 200)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })

  it.live("hard-linked files: a replace frees nothing, a delete to the bin keeps the bytes counted", () => {
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
      const account = join(filesDir, accountOf(filesDir))
      assert.strictEqual((yield* upload("/files/h.bin", "h".repeat(200_000))).status, 200)
      linkSync(join(account, "h.bin"), join(account, "h2.bin"))
      yield* walked
      // The other link and the bin keep the bytes, counted once.
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

  it.live("a delete that fails leaves nothing in the bin and the figure as it was", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      assert.strictEqual((yield* upload("/files/ro/sub/f.bin", "f".repeat(200_000))).status, 200)
      const filesDir = join(config.dataDir, "files")
      const ro = join(filesDir, accountOf(filesDir), "ro")
      yield* api.GetFilesUsage({ fresh: true })
      const before = yield* api.GetFilesUsage({})
      // A folder that can't be moved out: the folder holding it is read-only.
      chmodSync(ro, 0o555)
      try {
        const refused = yield* json("/files/delete", { path: "/files/ro/sub" })
        assert.isAtLeast(refused.status, 400)
      } finally {
        chmodSync(ro, 0o755)
      }
      assert.deepStrictEqual(yield* api.ListBin({ limit: 50, before: null }), [])
      const after = yield* api.GetFilesUsage({})
      assert.strictEqual(after.usedBytes, before.usedBytes)
      assert.strictEqual((yield* api.GetFilesUsage({ fresh: true })).usedBytes, before.usedBytes)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })
})
