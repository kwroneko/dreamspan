// The no-follow walk the app uses on account files (spec/FILES-AND-ENVIRONMENT.md §1.1): links,
// FIFOs, `..` and links swapped in for folders are refused; writes replace a link, never its target.
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, lstatSync, renameSync } from "node:fs"
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

  // Review (review-sandbox1): a command in the same folder swaps a folder for a link to the
  // outside, as fast as it can, while the app reads and writes through it.
  it("never reads or writes through a folder swapped for a link mid-walk", async () => {
    const { base, root } = setup()
    mkdirSync(join(base, "outside", "b"), { recursive: true })
    writeFileSync(join(base, "outside", "b", "note.txt"), "SECRET")
    symlinkSync(join(base, "outside"), join(root, "link"))
    const swapper = spawn(
      "/bin/bash",
      ["-c", "while :; do mv -T a a.real; mv -T link a; mv -T a link; mv -T a.real a; done"],
      { cwd: root, stdio: "ignore" }
    )
    const seen = new Set<string>()
    try {
      const until = Date.now() + 2000
      let i = 0
      while (Date.now() < until) {
        i++
        await readRegularFile(root, ["a", "b", "note.txt"], 100)
          .then((read) => seen.add(read.bytes.toString()))
          .catch((error) => seen.add(error instanceof FilePathRefused ? "refused" : String(error.code)))
        await writeRegularFile(root, ["a", "b", `w${i % 4}.txt`], Buffer.from("written")).catch(() => undefined)
      }
    } finally {
      swapper.kill("SIGKILL")
    }
    expect(seen.has("SECRET")).toBe(false)
    expect(seen.has("hello")).toBe(true)
    expect(readFileSync(join(base, "outside", "b", "note.txt"), "utf8")).toBe("SECRET")
    expect(readdirSync(join(base, "outside", "b"))).toEqual(["note.txt"])
  })

  it("handles long, unicode and case-different names as distinct plain names", async () => {
    const { root } = setup()
    expect(() => segmentsOf("x".repeat(256))).toThrow(FilePathRefused)
    expect(() => segmentsOf(`${"é".repeat(128)}`)).toThrow(FilePathRefused)
    expect(() => segmentsOf(`a/${"x".repeat(4100)}`)).toThrow(FilePathRefused)
    expect(() => segmentsOf("a/\0/b")).toThrow(FilePathRefused)
    expect(() => resolveFilesPath("/files/a/\0b", "/files")).toThrow(FilePathRefused)
    // NFC and NFD spellings, and case, are different names on Linux; each stays below the root.
    const nfc = "café.txt"
    const nfd = "café.txt"
    await writeRegularFile(root, [nfc], Buffer.from("nfc"))
    await writeRegularFile(root, [nfd], Buffer.from("nfd"))
    await writeRegularFile(root, ["Case.txt"], Buffer.from("upper"))
    await writeRegularFile(root, ["case.txt"], Buffer.from("lower"))
    expect((await readRegularFile(root, [nfc], 10)).bytes.toString()).toBe("nfc")
    expect((await readRegularFile(root, [nfd], 10)).bytes.toString()).toBe("nfd")
    expect((await readRegularFile(root, ["Case.txt"], 10)).bytes.toString()).toBe("upper")
    // A name that is only dots and spaces, or looks like a path, is still one name or refused.
    expect(segmentsOf("a/ ../b")).toEqual(["a", " ..", "b"])
    expect(resolveFilesPath("/files/%2e%2e/x", "/files").full).toBe("/files/%2e%2e/x")
  })

  it("matches globs", () => {
    expect(globToRegExp("**/*.md").test("a/b/c.md")).toBe(true)
    expect(globToRegExp("**/*.md").test("c.md")).toBe(true)
    expect(globToRegExp("*.{ts,js}").test("x.js")).toBe(true)
    expect(globToRegExp("*.ts").test("a/x.ts")).toBe(false)
  })
})
