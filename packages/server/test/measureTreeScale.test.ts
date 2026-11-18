// What one walk of an account's whole Files tree costs (spec/FILES-AND-ENVIRONMENT.md §1.2,
// `measureTree` in files/quota.ts): the usage line and every quota check are answered from the
// last walk plus what the app wrote since, so a fresh figure (`GetFilesUsage({ fresh: true })`)
// pays this. 20,000 files in 2,000 folders under TMPDIR, built, timed, and removed again.
// Synthetic files only.
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { measureTree } from "../src/files/quota.ts"
import { tempDir } from "./support/tempDir.ts"

const FOLDERS = 2_000
const FILES = 20_000
/** Ten files of this many bytes in each folder. */
const CONTENT = Buffer.alloc(128, 120)

it("walks 20,000 files in 2,000 folders within one walk's budget", async () => {
  const root = tempDir("walk-scale")
  try {
    const building = Date.now()
    // The tree is built folder by folder, twenty folders at a time, so the writes overlap.
    for (let start = 0; start < FOLDERS; start += 20) {
      const folders = Array.from({ length: Math.min(20, FOLDERS - start) }, (_, i) => {
        const folder = join(root, `folder-${String(start + i).padStart(4, "0")}`)
        return mkdir(folder).then(() =>
          Promise.all(
            Array.from({ length: FILES / FOLDERS }, (_, j) => writeFile(join(folder, `file-${j}.bin`), CONTENT))
          )
        )
      })
      await Promise.all(folders)
    }
    const builtMs = Date.now() - building

    const walking = Date.now()
    const measured = await measureTree(root)
    const walkedMs = Date.now() - walking

    // The walk's own limits are 2,000,000 entries and 60 s (WALK_MAX_ENTRIES, WALK_MAX_MS):
    // `partial` says it stopped at one of them, which for a real account means the figure is low.
    assert.isFalse(measured.partial)
    assert.isAtLeast(measured.bytes, FILES * CONTENT.length)
    console.log(
      `measureTree: ${FILES} files in ${FOLDERS} folders — built in ${builtMs} ms, walked in ${walkedMs} ms, ${measured.bytes} bytes`
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
