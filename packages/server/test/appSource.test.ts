// The read-only copy of the app's source for commands and the file tools
// (spec/FILES-AND-ENVIRONMENT.md §3.6): text files of the source folders, nothing under the data
// folder and no links; one copy per version, older ones removed; and the file tools' roots,
// where /app-source reads but never writes. Synthetic folders only.
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { prepareAppSource } from "../src/files/appSource.ts"
import { resolveToolPath, toolRoots, accountEnv } from "../src/files/environment.ts"
import { FilePathRefused } from "../src/files/safePath.ts"
import { tempDir } from "./support/tempDir.ts"

const app = async () => {
  const root = tempDir("app-root")
  const put = async (path: string, text: string | Buffer) => {
    await mkdir(join(root, path, ".."), { recursive: true })
    await writeFile(join(root, path), text)
  }
  await put("packages/server/src/main.ts", "export const main = 1\n")
  await put("packages/plugin-api/src/client.ts", "export interface Activate {}\n")
  await put("packages/server/src/importer/tokenizers/big.json.gz", Buffer.alloc(64, 1))
  await put("spec/DESIGN.md", "# Design\n")
  await put("spec/shot.png", Buffer.alloc(32, 7))
  await put("ARCHITECTURE.md", "# Architecture\n")
  await put("secret.key", "not copied\n")
  await put("packages/server/src/data/settings.json", "{}\n")
  await symlink("/etc/passwd", join(root, "packages/server/src/passwd.ts"))
  return root
}

describe("the app's source copy", () => {
  it("copies text source and docs, never data, links or binaries, once per version", async () => {
    const root = await app()
    // A data folder inside a source folder is never copied.
    const dataDir = join(root, "packages/server/src/data")
    const copy = await prepareAppSource(dataDir, root)
    const has = (path: string) => existsSync(join(copy.folder, path))
    expect(has("packages/server/src/main.ts")).toBe(true)
    expect(has("packages/plugin-api/src/client.ts")).toBe(true)
    expect(has("spec/DESIGN.md")).toBe(true)
    expect(has("ARCHITECTURE.md")).toBe(true)
    expect(has("packages/server/src/importer/tokenizers/big.json.gz")).toBe(false)
    expect(has("spec/shot.png")).toBe(false)
    expect(has("secret.key")).toBe(false)
    expect(has("packages/server/src/data/settings.json")).toBe(false)
    expect(has("packages/server/src/passwd.ts")).toBe(false)
    const about = await readFile(join(copy.folder, "SOURCE.md"), "utf8")
    expect(about).toContain("read-only copy")
    expect(about).toContain(`Copy: ${copy.stamp}`)
    // The same version is the same copy; a change makes a new one and removes the old.
    expect((await prepareAppSource(dataDir, root)).folder).toBe(copy.folder)
    await writeFile(join(root, "packages/server/src/main.ts"), "export const main = 2\n")
    const next = await prepareAppSource(dataDir, root)
    expect(next.folder).not.toBe(copy.folder)
    expect(await readdir(join(dataDir, "app-source"))).toEqual([next.stamp])
    expect(await readFile(join(next.folder, "packages/server/src/main.ts"), "utf8")).toBe("export const main = 2\n")
  })

  it("is a root the file tools read, beside the account's files", () => {
    const env = accountEnv({ filesDir: "/srv/files", homesDir: "/srv/homes" }, "u1")
    const roots = toolRoots(env, "/srv/app-source/abc")
    const source = resolveToolPath("/app-source/spec/DESIGN.md", "/files", roots)
    expect(source.root.hostRoot).toBe("/srv/app-source/abc")
    expect(source.root.writable).toBe(false)
    expect(source.segments).toEqual(["spec", "DESIGN.md"])
    // Relative paths resolve from a directory in either root, and never climb out of it.
    expect(resolveToolPath("DESIGN.md", "/app-source/spec", roots).full).toBe("/app-source/spec/DESIGN.md")
    expect(resolveToolPath("x", "/tmp", roots).full).toBe("/files/x")
    expect(() => resolveToolPath("/app-source/../etc/passwd", "/files", roots)).toThrow(FilePathRefused)
    expect(() => resolveToolPath("/app-sourcex/a", "/files", roots)).toThrow(FilePathRefused)
    // Without a copy, /app-source isn't a root.
    expect(() => resolveToolPath("/app-source/SOURCE.md", "/files", toolRoots(env, null))).toThrow(FilePathRefused)
  })
})
