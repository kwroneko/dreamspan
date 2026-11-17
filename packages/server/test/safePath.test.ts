// The no-follow walk the app uses on account files (spec/FILES-AND-ENVIRONMENT.md §1.1): links,
// FIFOs, `..` and links swapped in for folders are refused; writes replace a link, never its target.
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, lstatSync, renameSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  FilePathRefused,
  listFolder,
  openFolder,
  readRegularFile,
  segmentsOf,
  statPath,
  writeRegularFile
} from "../src/files/safePath.ts"
import { diffScans, resolveFilesPath, scanTree } from "../src/files/environment.ts"
import { globToRegExp } from "../src/agent/tools/files.ts"
import { tempDir } from "./support/tempDir.ts"

const setup = () => {
  const base = tempDir("safepath")
  const root = join(base, "files")
  mkdirSync(join(root, "a", "b"), { recursive: true })
  writeFileSync(join(base, "secret.key"), "SECRET")
  writeFileSync(join(root, "a", "b", "note.txt"), "hello")
  return { base, root }
}

describe("safePath", () => {
  it("reads and writes plain files below the root", async () => {
    const { root } = setup()
    const read = await readRegularFile(root, ["a", "b", "note.txt"], 100)
    expect(read.bytes.toString()).toBe("hello")
    await writeRegularFile(root, ["new", "deep", "x.txt"], Buffer.from("made"), { createFolders: true })
    expect(readFileSync(join(root, "new", "deep", "x.txt"), "utf8")).toBe("made")
  })

  it("refuses ., .. and NUL in paths", () => {
    expect(() => segmentsOf("a/../b")).toThrow(FilePathRefused)
    expect(() => segmentsOf("./a")).toThrow(FilePathRefused)
    expect(() => segmentsOf("a\0b")).toThrow(FilePathRefused)
    expect(segmentsOf("/a//b/")).toEqual(["a", "b"])
  })

  it("never climbs above /files when resolving a tool's path", () => {
    expect(() => resolveFilesPath("../../etc/passwd", "/files/a")).toThrow(FilePathRefused)
    expect(() => resolveFilesPath("/files/../data/secret.key", "/files")).toThrow(FilePathRefused)
    expect(() => resolveFilesPath("~/x", "/files")).toThrow(FilePathRefused)
    expect(resolveFilesPath("b/c.txt", "/files/a")).toEqual({ full: "/files/a/b/c.txt", segments: ["a", "b", "c.txt"] })
    // A directory outside /files (a command's cd to /tmp) doesn't become the base.
    expect(resolveFilesPath("x", "/tmp").full).toBe("/files/x")
  })

  it("refuses links, as the file and as a folder on the way", async () => {
    const { base, root } = setup()
    symlinkSync(join(base, "secret.key"), join(root, "leak"))
    symlinkSync(base, join(root, "up"))
    symlinkSync("../../secret.key", join(root, "a", "rel"))
    await expect(readRegularFile(root, ["leak"], 100)).rejects.toBeInstanceOf(FilePathRefused)
    await expect(readRegularFile(root, ["up", "secret.key"], 100)).rejects.toBeInstanceOf(FilePathRefused)
    await expect(readRegularFile(root, ["a", "rel"], 100)).rejects.toBeInstanceOf(FilePathRefused)
    await expect(writeRegularFile(root, ["up", "planted"], Buffer.from("x"))).rejects.toBeInstanceOf(FilePathRefused)
    await expect(listFolder(root, ["up"], 10)).rejects.toBeInstanceOf(FilePathRefused)
    expect((await statPath(root, ["leak"]))?.isSymbolicLink()).toBe(true)
    const kinds = Object.fromEntries((await listFolder(root, [], 10)).entries.map((e) => [e.name, e.kind]))
    expect(kinds).toMatchObject({ leak: "link", up: "link", a: "folder" })
  })

  it("replaces a link it writes over, leaving the target alone", async () => {
    const { base, root } = setup()
    symlinkSync(join(base, "secret.key"), join(root, "leak"))
    await writeRegularFile(root, ["leak"], Buffer.from("mine"))
    expect(readFileSync(join(base, "secret.key"), "utf8")).toBe("SECRET")
    expect(lstatSync(join(root, "leak")).isFile()).toBe(true)
  })

  it("refuses FIFOs and other special files without blocking", async () => {
    const { root } = setup()
    execFileSync("mkfifo", [join(root, "pipe")])
    const started = Date.now()
    await expect(readRegularFile(root, ["pipe"], 100)).rejects.toBeInstanceOf(FilePathRefused)
    expect(Date.now() - started).toBeLessThan(2000)
    expect((await listFolder(root, [], 10)).entries.find((e) => e.name === "pipe")?.kind).toBe("other")
  })

  it("keeps working in the folder it opened when a parent is swapped for a link", async () => {
    const { base, root } = setup()
    const dir = await openFolder(root, ["a", "b"])
    try {
      renameSync(join(root, "a"), join(root, "moved"))
      symlinkSync(base, join(root, "a"))
      // The open folder is still the real one, now at moved/b.
      await expect(readRegularFile(root, ["a", "b", "note.txt"], 100)).rejects.toBeInstanceOf(FilePathRefused)
      expect((await readRegularFile(root, ["moved", "b", "note.txt"], 100)).bytes.toString()).toBe("hello")
    } finally {
      await dir.close()
    }
  })

  it("lists what a command changed, without following links", async () => {
    const { base, root } = setup()
    const before = await scanTree(root)
    writeFileSync(join(root, "a", "b", "note.txt"), "changed!")
    writeFileSync(join(root, "a", "made.txt"), "new")
    symlinkSync(base, join(root, "escape"))
    mkdirSync(join(root, "node_modules", "x"), { recursive: true })
    writeFileSync(join(root, "node_modules", "x", "skip.js"), "")
    const after = await scanTree(root)
    const changes = diffScans(before, after)
    expect(changes.changed).toEqual(["a/b/note.txt"])
    expect([...changes.created].sort()).toEqual(["a/made.txt", "escape"])
    expect([...after.entries.keys()].some((p) => p.startsWith("escape/"))).toBe(false)
  })

  it("matches globs", () => {
    expect(globToRegExp("**/*.md").test("a/b/c.md")).toBe(true)
    expect(globToRegExp("**/*.md").test("c.md")).toBe(true)
    expect(globToRegExp("*.{ts,js}").test("x.js")).toBe(true)
    expect(globToRegExp("*.ts").test("a/x.ts")).toBe(false)
  })
})
