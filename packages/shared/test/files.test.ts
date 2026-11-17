// The file manager's path rules (spec/FILES-AND-ENVIRONMENT.md §1.1, §8): synthetic names only.
import { describe, expect, it } from "vitest"
import {
  crumbsOf,
  FILES_TOP,
  isWithin,
  joinPath,
  keepBothName,
  nameOf,
  nameProblem,
  normalizePath,
  parentOf,
  sortEntries,
  viewOf,
  type FileEntry
} from "../src/files.ts"

const entry = (name: string, kind: FileEntry["kind"], size = 0, mtimeMs = 0): FileEntry => ({
  name,
  kind,
  size,
  mtimeMs
})

describe("file paths", () => {
  it("keeps every path under the top, with one slash between names", () => {
    expect(normalizePath("/files//thesis/")).toBe("/files/thesis")
    expect(normalizePath("/elsewhere/x")).toBe(FILES_TOP)
    expect(normalizePath("")).toBe(FILES_TOP)
    expect(joinPath("/files/thesis", "notes/a.md")).toBe("/files/thesis/notes/a.md")
    expect(joinPath(FILES_TOP, "a.md")).toBe("/files/a.md")
  })

  it("names parents, names and breadcrumbs", () => {
    expect(parentOf("/files/thesis/a.md")).toBe("/files/thesis")
    expect(parentOf("/files/a.md")).toBe(FILES_TOP)
    expect(parentOf(FILES_TOP)).toBe(FILES_TOP)
    expect(nameOf(FILES_TOP)).toBe("Files")
    expect(nameOf("/files/thesis/a.md")).toBe("a.md")
    expect(crumbsOf("/files/thesis/notes")).toEqual([
      { name: "Files", path: "/files" },
      { name: "thesis", path: "/files/thesis" },
      { name: "notes", path: "/files/thesis/notes" }
    ])
    expect(isWithin("/files/thesis/a.md", "/files/thesis")).toBe(true)
    expect(isWithin("/files/thesis2", "/files/thesis")).toBe(false)
  })

  it("refuses names the server's walk refuses", () => {
    expect(nameProblem("report.pdf")).toBeNull()
    expect(nameProblem("  ")).not.toBeNull()
    expect(nameProblem("..")).not.toBeNull()
    expect(nameProblem("a/b")).not.toBeNull()
    expect(nameProblem("x".repeat(256))).not.toBeNull()
  })

  it("numbers a taken name as Keep both does", () => {
    expect(keepBothName("report.pdf", new Set(["report.pdf"]))).toBe("report (2).pdf")
    expect(keepBothName("report.pdf", new Set(["report.pdf", "report (2).pdf"]))).toBe("report (3).pdf")
    expect(keepBothName("notes", new Set(["notes"]))).toBe("notes (2)")
    expect(keepBothName(".env", new Set([".env"]))).toBe(".env (2)")
  })

  it("lists folders first, then by the chosen key", () => {
    const entries = [
      entry("b.txt", "file", 10, 3),
      entry("Zeta", "folder"),
      entry("a10.txt", "file", 30, 1),
      entry("a2.txt", "file", 20, 2),
      entry("alpha", "folder")
    ]
    expect(sortEntries(entries, "name").map((e) => e.name)).toEqual(["alpha", "Zeta", "a2.txt", "a10.txt", "b.txt"])
    expect(sortEntries(entries, "size").map((e) => e.name)).toEqual(["alpha", "Zeta", "a10.txt", "a2.txt", "b.txt"])
    expect(sortEntries(entries, "date").map((e) => e.name)).toEqual(["alpha", "Zeta", "b.txt", "a2.txt", "a10.txt"])
  })

  it("picks a viewer by the name, downloading what it doesn't know", () => {
    expect(viewOf("notes.MD")).toBe("text")
    expect(viewOf("Makefile")).toBe("text")
    expect(viewOf("photo.webp")).toBe("image")
    expect(viewOf("clip.mp4")).toBe("video")
    expect(viewOf("song.mp3")).toBe("audio")
    expect(viewOf("paper.pdf")).toBe("pdf")
    expect(viewOf("archive.zip")).toBe("download")
    expect(viewOf("README")).toBe("download")
  })
})
