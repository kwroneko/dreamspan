import { describe, expect, it } from "vitest"
import { writeFile, symlink, link, mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { authorRepo, createAuthorRepo } from "../src/plugins/authorRepo.ts"
import { saveFiles, pluginFolder, limits } from "../src/plugins/repo.ts"
import { tempDir } from "./support/tempDir.ts"

const setup = async () => {
  const dir = tempDir("plugin-author"),
    folder = pluginFolder(dir, "", "fixture")
  await saveFiles(
    dir,
    "",
    "fixture",
    {
      "a.ts": "one\ntwo\n",
      "dreamspan-plugin.json": JSON.stringify({
        id: "fixture",
        name: "Fixture",
        api: 1,
        server: null,
        worker: null,
        client: null,
        surfaces: [],
        overrides: [],
        replaces: [],
        base: null,
        network: false
      })
    },
    true,
    "Start"
  )
  return { dir, folder }
}
describe("confined workshop authoring", () => {
  for (const path of [
    "../data",
    "/tmp/app.ts",
    "a/../../other",
    ".git/config",
    ".git/hooks/run",
    "../other/a.ts",
    "C:/app.ts",
    "a\\b",
    "e\u0301.ts",
    "\ud800.ts",
    "__proto__",
    "constructor/file.ts",
    "a/./b"
  ])
    it(`refuses ${path}`, async () => {
      const { dir } = await setup()
      await expect(
        authorRepo(dir, "", "fixture", { action: "write", path, content: "bad", key: "write" })
      ).rejects.toThrow()
    })
  for (const kind of ["symbolic", "hard"] as const)
    it(`refuses ${kind} links for reads and writes`, async () => {
      const { dir, folder } = await setup()
      const outside = join(dir, "outside")
      await writeFile(outside, "synthetic-secret")
      if (kind === "symbolic") await symlink(outside, join(folder, "escape"))
      else await link(outside, join(folder, "escape"))
      for (const action of ["read", "write"] as const)
        await expect(
          authorRepo(dir, "", "fixture", { action, path: "escape", content: "changed", key: "x" })
        ).rejects.toThrow()
      expect(await readFile(outside, "utf8")).toBe("synthetic-secret")
    })
  it("rejects collisions, binaries, aggregate count/size and excessive depth before a write", async () => {
    const { dir, folder } = await setup()
    for (const [path, content] of [
      ["A.ts", "collision"],
      ["binary", "x\0y"],
      ["huge", "x".repeat(limits.file + 1)],
      [Array(25).fill("a").join("/"), "deep"],
      ["a.ts/x", "file-dir"]
    ] as Array<[string, string]>)
      await expect(authorRepo(dir, "", "fixture", { action: "write", path, content, key: path! })).rejects.toThrow()
    for (let i = 0; i < limits.files - 2; i++) await writeFile(join(folder, `f${i}.ts`), "")
    await expect(
      authorRepo(dir, "", "fixture", { action: "write", path: "extra", content: "", key: "count" })
    ).rejects.toThrow()
    expect(await readFile(join(folder, "a.ts"), "utf8")).toBe("one\ntwo\n")
  })
  it("applies edits all-or-nothing, recovers a receipt gap, leaves checks uncommitted, and reverts versions", async () => {
    const { dir, folder } = await setup()
    await expect(
      authorRepo(dir, "", "fixture", {
        action: "edit",
        path: "a.ts",
        edits: [
          { old_str: "one", new_str: "first" },
          { old_str: "absent", new_str: "bad" }
        ],
        key: "bad"
      })
    ).rejects.toThrow()
    expect(await readFile(join(folder, "a.ts"), "utf8")).toBe("one\ntwo\n")
    const request = { action: "write" as const, path: "a.ts", content: "changed", key: "call" },
      saved = await authorRepo(dir, "", "fixture", request)
    expect(await authorRepo(dir, "", "fixture", request)).toEqual(saved)
    const check = await authorRepo(dir, "", "fixture", { action: "checkpoint" })
    expect(check.commit).toMatch(/^[a-f0-9]{40}$/)
    const beforeHead = await readFile(join(folder, ".git/refs/heads/main"), "utf8")
    const committed = await authorRepo(dir, "", "fixture", { action: "commit", message: "Save", key: "commit" })
    expect(committed.commit).not.toBe(beforeHead.trim())
    expect(await authorRepo(dir, "", "fixture", { action: "commit", message: "Save", key: "commit" })).toEqual(
      committed
    )
    await authorRepo(dir, "", "fixture", { action: "undo", undo: committed.journal!, key: "undo" })
    expect(await readFile(join(folder, "a.ts"), "utf8")).toBe("one\ntwo\n")
  })
  it("refuses Git metadata links, another plugin and symlink parents", async () => {
    const { dir, folder } = await setup()
    await mkdir(join(folder, "src"))
    await symlink(join(dir, "outside"), join(folder, "src/link"))
    await expect(
      authorRepo(dir, "", "fixture", { action: "write", path: "src/link/a", content: "bad", key: "x" })
    ).rejects.toThrow()
  })
})
it("recovers interrupted file and commit journals without duplicating a version", async () => {
  const { dir, folder } = await setup()
  const request = { action: "write" as const, path: "a.ts", content: "recovered", key: "crash-write" }
  const first = await authorRepo(dir, "", "fixture", request)
  const journal = join(folder, ".git/rp-workshop", first.journal + ".json")
  const pending = JSON.parse(await readFile(journal, "utf8"))
  delete pending.result
  await writeFile(journal, JSON.stringify(pending))
  await writeFile(join(folder, "a.ts"), "one\ntwo\n")
  await authorRepo(dir, "", "fixture", { ...request, preview: true })
  expect(await readFile(join(folder, "a.ts"), "utf8")).toBe("one\ntwo\n")
  expect(await authorRepo(dir, "", "fixture", request)).toEqual(first)
  expect((await authorRepo(dir, "", "fixture", { ...request, preview: true })).recovered).toBe(true)
  const commitRequest = { action: "commit" as const, message: "Recovered commit", key: "crash-commit" }
  const committed = await authorRepo(dir, "", "fixture", commitRequest)
  const commitJournal = join(folder, ".git/rp-workshop", committed.journal + ".json"),
    data = JSON.parse(await readFile(commitJournal, "utf8"))
  delete data.result
  await writeFile(commitJournal, JSON.stringify(data))
  expect((await authorRepo(dir, "", "fixture", commitRequest)).commit).toBe(committed.commit)
})

it("recovers creation after its intent but before Git initialization", async () => {
  const dir = tempDir("plugin-create-gap")
  const files = { "a.ts": "synthetic source" }
  const first = await createAuthorRepo(dir, "", "new-plugin", files, "same-call")
  const folder = pluginFolder(dir, "", "new-plugin")
  const marker = join(folder, ".git/rp-create")
  const pending = JSON.parse(await readFile(marker, "utf8"))
  delete pending.commit
  await writeFile(marker, JSON.stringify(pending))
  for (const path of [".git/HEAD", ".git/config", ".git/refs", "a.ts"])
    await rm(join(folder, path), { recursive: true, force: true })
  expect((await createAuthorRepo(dir, "", "new-plugin", files, "same-call")).commit).toBe(first.commit)
  expect((await authorRepo(dir, "", "new-plugin", { action: "checkpoint" })).head).toBe(first.commit)
})
