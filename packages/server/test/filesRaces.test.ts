// Restore and Move never replace what's at the target, even something that appears between the
// app's check and its rename (review files23 finding 6): a command running beside the file
// manager can make a file there at any moment. The race is made deterministic by hooking the
// file system calls on the target name: a check of it sees nothing and then the file appears;
// a call that would create it finds the file already there. Synthetic files only.
import { assert, describe, it } from "@effect/vitest"
import { appendFileSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { vi } from "vitest"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { serverLayer, serverPort, testConfig } from "./support/config.ts"

/** Where a command makes a file mid-operation: a folder (real path) and a name in it. */
const intruder: { at: string | null; content: string; done: boolean } = { at: null, content: "", done: false }

/** `/proc/self/fd/<fd>/<name>` (or a plain path) as a real path, when it can be read. */
const resolved = (path: unknown) => {
  if (typeof path !== "string") return null
  try {
    const dir = dirname(path)
    return join(dir.startsWith("/proc/self/fd/") ? readlinkSync(dir) : realpathSync(dir), basename(path))
  } catch {
    return null
  }
}

const intrude = (path: unknown) => {
  if (intruder.done || intruder.at === null || resolved(path) !== intruder.at) return
  intruder.done = true
  writeFileSync(intruder.at, intruder.content)
}

/** Runs once when the app opens this file (a real path): a command writing to it meanwhile. */
const onOpen: { at: string | null; run: () => void } = { at: null, run: () => undefined }

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>()
  type Fn = (...args: Array<never>) => Promise<unknown>
  // A check of the name sees it free, and then the file appears.
  const after =
    <F extends Fn>(fn: F) =>
    async (...args: Parameters<F>) => {
      try {
        return await fn(...args)
      } finally {
        intrude(args[0])
      }
    }
  // A call that would create the name finds the file already there.
  const before =
    <F extends Fn>(fn: F, target: 0 | 1) =>
    async (...args: Parameters<F>) => {
      intrude(args[target])
      return fn(...args)
    }
  return {
    ...real,
    lstat: after(real.lstat as Fn),
    stat: after(real.stat as Fn),
    access: after(real.access as Fn),
    rename: before(real.rename as Fn, 1),
    link: before(real.link as Fn, 1),
    mkdir: before(real.mkdir as Fn, 0),
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      if (onOpen.at !== null && resolved(args[0]) === onOpen.at) {
        onOpen.at = null
        onOpen.run()
      }
      return handle
    }
  }
})

const call = (path: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const port = yield* serverPort
    return yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}${path}`, init))
  })

const json = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const upload = (path: string, text: string) =>
  call(`/files/upload?${new URLSearchParams({ path, conflict: "ask" })}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: text
  })

describe("restore and move against a file made meanwhile", () => {
  it.live("neither replaces it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const filesDir = join(config.dataDir, "files")
      assert.strictEqual((yield* upload("/files/thesis/notes.md", "Binned notes.")).status, 200)
      assert.strictEqual((yield* upload("/files/thesis/draft.md", "The draft.")).status, 200)
      const account = readdirSync(filesDir).find((name) => name !== ".bin")!
      const thesis = realpathSync(join(filesDir, account, "thesis"))

      // Restore: the name is free when looked at, then a command makes the file.
      const deleted = yield* json("/files/delete", { path: "/files/thesis/notes.md" })
      const { binItemId } = (yield* Effect.promise(() => deleted.json())) as { binItemId: string }
      Object.assign(intruder, { at: join(thesis, "notes.md"), content: "Made by a command.", done: false })
      const restored = yield* json("/files/restore", { binItemId })
      assert.isTrue(intruder.done)
      assert.strictEqual(restored.status, 200)
      assert.deepStrictEqual(yield* Effect.promise(() => restored.json()), {
        path: "/files/thesis/notes (restored).md"
      })
      assert.strictEqual(readFileSync(join(thesis, "notes.md"), "utf8"), "Made by a command.")
      assert.strictEqual(readFileSync(join(thesis, "notes (restored).md"), "utf8"), "Binned notes.")

      // Move: the target is free when looked at, then a command makes it.
      Object.assign(intruder, { at: join(thesis, "final.md"), content: "Also a command's.", done: false })
      const moved = yield* json("/files/move", { from: "/files/thesis/draft.md", to: "/files/thesis/final.md" })
      assert.isTrue(intruder.done)
      assert.strictEqual(moved.status, 409)
      assert.strictEqual(readFileSync(join(thesis, "final.md"), "utf8"), "Also a command's.")
      assert.strictEqual(readFileSync(join(thesis, "draft.md"), "utf8"), "The draft.")
      intruder.at = null
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })

  it.live("a restore finds a free name however many are taken", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      assert.strictEqual((yield* upload("/files/a/n.txt", "Binned.")).status, 200)
      const deleted = yield* json("/files/delete", { path: "/files/a/n.txt" })
      const { binItemId } = (yield* Effect.promise(() => deleted.json())) as { binItemId: string }
      for (const name of ["n.txt", "n (restored).txt", "n (restored) (2).txt", "n (restored) (3).txt"])
        assert.strictEqual((yield* upload(`/files/a/${name}`, "Taken.")).status, 200)
      const restored = yield* json("/files/restore", { binItemId })
      assert.deepStrictEqual(yield* Effect.promise(() => restored.json()), { path: "/files/a/n (restored) (4).txt" })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })

  it.live("an attachment is refused when its file changes while it's copied", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const filesDir = join(config.dataDir, "files")
      // Just under the attachment limit; it grows past it as the copy starts.
      const size = 64 * 1024 * 1024 - 10
      const uploaded = yield* call(`/files/upload?${new URLSearchParams({ path: "/files/log.txt" })}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(size)
      })
      assert.strictEqual(uploaded.status, 200)
      const account = readdirSync(filesDir).find((name) => name !== ".bin")!
      const log = join(realpathSync(join(filesDir, account)), "log.txt")
      Object.assign(onOpen, { at: log, run: () => appendFileSync(log, "x".repeat(100)) })
      const attached = yield* json("/files/attach", { path: "/files/log.txt" })
      assert.isNull(onOpen.at)
      // Before, the copy was cut at 64 MiB and attached with a size that looked right.
      assert.strictEqual(attached.status, 409, yield* Effect.promise(() => attached.text()))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })
})
