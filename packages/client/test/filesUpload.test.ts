// Uploads into Files (spec/FILES-AND-ENVIRONMENT.md §1.1): one question for the whole batch when
// names are taken, folders kept, and what Undo may take back. Synthetic files only.
import { describe, expect, it } from "vitest"
import type { UploadConflict, UploadUndoEntry } from "@dreamspan/shared/files.ts"
import { NameTaken } from "../src/features/files/source.ts"
import { itemsFromInput, uploadAll, type UploadItem } from "../src/features/files/upload.ts"

const file = (relative: string, text = "x"): UploadItem => ({
  kind: "file",
  relative,
  file: new File([text], relative.split("/").at(-1)!)
})

const entry = (path: string, kind: UploadUndoEntry["kind"] = "file"): UploadUndoEntry => ({
  path,
  kind,
  device: 1,
  inode: 2,
  birth: 3,
  changed: kind === "file" ? 4 : null
})

const fakeSource = (taken: ReadonlySet<string>) => {
  const calls: Array<{ path: string; conflict: UploadConflict }> = []
  const folders: Array<string> = []
  return {
    calls,
    folders,
    source: {
      upload: async (path: string, _file: Blob, conflict: UploadConflict) => {
        calls.push({ path, conflict })
        if (!taken.has(path)) return { path, outcome: "written" as const, created: [entry(path)] }
        if (conflict === "ask") throw new NameTaken("That name is taken.")
        if (conflict === "skip") return { path, outcome: "skipped" as const }
        if (conflict === "replace") return { path, outcome: "replaced" as const }
        const copy = path.replace(/(\.[^.]+)$/, " (2)$1")
        return { path: copy, outcome: "written" as const, created: [entry(copy)] }
      },
      createFolder: async (path: string) => {
        folders.push(path)
        return { path, created: [entry(path, "folder")] }
      }
    }
  }
}

describe("uploads", () => {
  it("asks once for the batch, then applies the answer to every taken name", async () => {
    const fake = fakeSource(new Set(["/files/a.txt", "/files/c.txt"]))
    let asked = 0
    const report = await uploadAll(fake.source, "/files", [file("a.txt"), file("b.txt"), file("c.txt")], async () => {
      asked++
      return "keep"
    })
    expect(asked).toBe(1)
    expect(fake.calls.map((c) => `${c.path}:${c.conflict}`)).toEqual([
      "/files/a.txt:ask",
      "/files/a.txt:keep",
      "/files/b.txt:keep",
      "/files/c.txt:keep"
    ])
    expect(report.written).toEqual(["/files/a (2).txt", "/files/b.txt", "/files/c (2).txt"])
    expect(report.made).toEqual(report.written.map((path) => entry(path)))
  })

  it("stops where the user stopped, and counts what it skipped", async () => {
    const stopped = await uploadAll(
      fakeSource(new Set(["/files/a.txt"])).source,
      "/files",
      [file("a.txt"), file("b.txt")],
      async () => null
    )
    expect(stopped.written).toEqual([])
    const skipped = await uploadAll(
      fakeSource(new Set(["/files/a.txt"])).source,
      "/files",
      [file("a.txt"), file("b.txt")],
      async () => "skip"
    )
    expect(skipped).toMatchObject({ written: ["/files/b.txt"], skipped: 1 })
  })

  it("keeps a folder's subfolders, makes its empty ones, and offers Undo only for what it added", async () => {
    const fake = fakeSource(new Set(["/files/site/index.html"]))
    const report = await uploadAll(
      fake.source,
      "/files",
      [file("site/index.html"), file("site/css/main.css"), { kind: "folder", relative: "site/empty" }],
      async () => "replace"
    )
    expect(fake.folders).toEqual(["/files/site/empty"])
    expect(report.written).toEqual(["/files/site/index.html", "/files/site/css/main.css"])
    expect(report.made).toEqual([entry("/files/site/css/main.css"), entry("/files/site/empty", "folder")])
  })

  it("reports a failure per file and goes on", async () => {
    const report = await uploadAll(
      {
        upload: async (path) => {
          if (path.endsWith("bad.txt")) throw new Error("Over the quota.")
          return { path, outcome: "written" }
        },
        createFolder: async (path) => ({ path })
      },
      "/files/x",
      [file("bad.txt"), file("good.txt")],
      async () => "keep"
    )
    expect(report.failed).toEqual([{ relative: "bad.txt", message: "Over the quota." }])
    expect(report.written).toEqual(["/files/x/good.txt"])
  })

  it("takes a picked folder's relative paths", () => {
    const picked = new File(["x"], "a.txt")
    Object.defineProperty(picked, "webkitRelativePath", { value: "sources/deep/a.txt" })
    expect(itemsFromInput([picked]).map((i) => i.relative)).toEqual(["sources/deep/a.txt"])
  })
})
