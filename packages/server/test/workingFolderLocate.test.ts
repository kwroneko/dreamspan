// Finding a stored working folder again (files/workingFolder.ts `locateFolder`; spec
// /FILES-AND-ENVIRONMENT.md §1 "Paths are the names", §2.2), on a synthetic tree: the path wins
// while it's a folder (one deleted and made again, or replaced by a clone, is still the one
// meant); the app's own moves are followed; a rename by a command is found by inode only when the
// folder kept its name or its (non-top) parent, so a reused inode number never lands commands in
// an unrelated folder.
import { assert, describe, it } from "vitest"
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { locateFolder } from "../src/files/workingFolder.ts"
import { tempDir } from "./support/tempDir.ts"

const tree = () => {
  const root = tempDir("locate")
  return { root, ino: (relative: string) => statSync(join(root, relative)).ino }
}

describe("locateFolder", () => {
  it("trusts the stored path while it's a folder, even one made again with a new inode", async () => {
    const { root, ino } = tree()
    mkdirSync(join(root, "out"))
    const stored = { path: "/files/out", inode: ino("out") }
    // `rm -rf out && mkdir out`, with something holding the old inode number elsewhere.
    renameSync(join(root, "out"), join(root, "old-out"))
    mkdirSync(join(root, "out"))
    assert.notStrictEqual(ino("out"), stored.inode)
    assert.strictEqual(await locateFolder(root, stored), "/files/out")
  })

  it("never takes a folder with another name in another place that has the stored inode", async () => {
    const { root, ino } = tree()
    mkdirSync(join(root, "thesis/chapters"), { recursive: true })
    mkdirSync(join(root, "build"))
    // As if `thesis/drafts` was deleted and the file system gave its number to `build`.
    const reused = { path: "/files/thesis/drafts", inode: ino("build") }
    assert.isNull(await locateFolder(root, reused))
    // At the top every folder shares the parent, so a new name there isn't trusted either.
    assert.isNull(await locateFolder(root, { path: "/files/site", inode: ino("build") }))
  })

  it("finds a folder a command renamed in its folder, or moved keeping its name", async () => {
    const { root, ino } = tree()
    mkdirSync(join(root, "thesis/drafts"), { recursive: true })
    mkdirSync(join(root, "archive"))
    const stored = { path: "/files/thesis/drafts", inode: ino("thesis/drafts") }
    renameSync(join(root, "thesis/drafts"), join(root, "thesis/old drafts"))
    assert.strictEqual(await locateFolder(root, stored), "/files/thesis/old drafts")
    renameSync(join(root, "thesis/old drafts"), join(root, "thesis/drafts"))
    renameSync(join(root, "thesis/drafts"), join(root, "archive/drafts"))
    assert.strictEqual(await locateFolder(root, stored), "/files/archive/drafts")
  })

  it("follows the app's own moves, a parent's too, when the inode there matches", async () => {
    const { root, ino } = tree()
    mkdirSync(join(root, "thesis/drafts"), { recursive: true })
    const stored = { path: "/files/thesis/drafts", inode: ino("thesis/drafts") }
    // Renamed and moved in one step, then its parent renamed: no name or parent kept.
    mkdirSync(join(root, "paper"))
    renameSync(join(root, "thesis/drafts"), join(root, "paper/notes"))
    rmSync(join(root, "thesis"), { recursive: true })
    renameSync(join(root, "paper"), join(root, "journal"))
    const moves = [
      { from: "/files/thesis/drafts", to: "/files/paper/notes" },
      { from: "/files/paper", to: "/files/journal" }
    ]
    assert.isNull(await locateFolder(root, stored))
    assert.strictEqual(await locateFolder(root, stored, moves), "/files/journal/notes")
    // A move that ends at a different folder (another inode) isn't followed.
    assert.isNull(await locateFolder(root, { ...stored, inode: ino("journal") }, moves))
  })

  it("follows the later move when the original path was reused", async () => {
    const { root, ino } = tree()
    mkdirSync(join(root, "A"))
    renameSync(join(root, "A"), join(root, "B"))
    mkdirSync(join(root, "A"))
    const stored = { path: "/files/A", inode: ino("A") }
    renameSync(join(root, "A"), join(root, "C"))
    const moves = [
      { from: "/files/A", to: "/files/B" },
      { from: "/files/A", to: "/files/C" }
    ]
    assert.strictEqual(await locateFolder(root, stored, moves), "/files/C")
  })
})
