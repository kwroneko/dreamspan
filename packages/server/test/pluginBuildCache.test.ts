import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { PluginHost } from "../src/plugins/Host.ts"
import { checkPlugin, readClientBuild } from "../src/plugins/check.ts"
import { saveFiles } from "../src/plugins/repo.ts"
import { tempDir } from "./support/tempDir.ts"

const verifies = vi.hoisted(() => ({ count: 0 }))
vi.mock("../src/plugins/repoTask.ts", async (original) => {
  const actual = await original<typeof import("../src/plugins/repoTask.ts")>()
  return {
    ...actual,
    repoTask: (dataDir: string, request: Parameters<typeof actual.repoTask>[1]) => {
      if (request.op === "verify" && "approved" in request && request.approved) verifies.count++
      return actual.repoTask(dataDir, request)
    }
  }
})

const files = (id: string, source = "export const activate = () => {}") => ({
  "dreamspan-plugin.json": JSON.stringify({
    id,
    name: "Synthetic",
    api: 1,
    client: "client.ts",
    server: null,
    worker: null,
    surfaces: [],
    overrides: [],
    replaces: [],
    network: false,
    base: null
  }),
  "client.ts": source
})

it("verifies an approved build once and verifies again after any file, commit or approval change", async () => {
  const data = tempDir("plugin-build-cache")
  const id = "build-cache"
  const commit = await saveFiles(data, "", id, files(id), true, "Synthetic")
  expect(await checkPlugin(data, "", id, commit)).toMatchObject({ ok: true })
  const folder = join(data, "plugins/.builds/instance", id, commit)
  const start = verifies.count
  const bytes = (await readClientBuild(data, "", id, commit)).bytes
  await readClientBuild(data, "", id, commit)
  await readClientBuild(data, "", id, commit)
  expect(verifies.count - start).toBe(1)

  // A changed approved source file in the build is refused, even with identical length.
  const source = join(folder, "client.ts")
  const original = await readFile(source, "utf8")
  await writeFile(source, original.replace("{}", "{ }").slice(0, original.length))
  await expect(readClientBuild(data, "", id, commit)).rejects.toThrow()
  await writeFile(source, original)
  expect((await readClientBuild(data, "", id, commit)).bytes).toEqual(bytes)
  const afterFile = verifies.count

  // Rewriting the same bytes still changes ctime, so the next read verifies again.
  await writeFile(source, original)
  await readClientBuild(data, "", id, commit)
  expect(verifies.count).toBe(afterFile + 1)

  // Changed output is refused on every read regardless of the cache.
  const artifact = join(folder, "client.mjs")
  await writeFile(artifact, Buffer.concat([bytes, Buffer.from("\n// changed")]))
  await expect(readClientBuild(data, "", id, commit)).rejects.toThrow("artifact")
  await writeFile(artifact, bytes)

  // A new approval (recheck) attests a new report and build: verify again.
  expect(await checkPlugin(data, "", id, commit)).toMatchObject({ ok: true })
  const rechecked = verifies.count
  await readClientBuild(data, "", id, commit)
  await readClientBuild(data, "", id, commit)
  expect(verifies.count).toBe(rechecked + 1)

  // A new commit writes repository objects: verify again.
  const before = verifies.count
  await saveFiles(data, "", id, files(id, "export const activate = () => { void 0 }"), false, "Later work")
  expect((await readClientBuild(data, "", id, commit)).bytes).toEqual(bytes)
  expect(verifies.count).toBe(before + 1)

  const metadata = join(data, "plugins/instance", id, ".git", "extra")
  await mkdir(join(metadata, ...Array(16).fill("nested")), { recursive: true })
  const beforeLimits = verifies.count
  await expect(readClientBuild(data, "", id, commit)).rejects.toThrow("Git metadata limit exceeded")
  expect(verifies.count).toBe(beforeLimits)
  await rm(metadata, { recursive: true })

  const extra = join(folder, "extra")
  await mkdir(extra)
  for (let index = 0; index < 1040; index++) await writeFile(join(extra, String(index)), "")
  await expect(readClientBuild(data, "", id, commit)).rejects.toThrow("Plugin build directory limit exceeded")
  expect(verifies.count).toBe(beforeLimits)
}, 90_000)

it(
  "refuses a client module on the first request after its approval is revoked or repinned",
  { timeout: 120_000, tags: ["slow"] },
  async () => {
    const config = testConfig()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const api = yield* client(),
            actor = yield* api.Whoami(),
            host = yield* PluginHost
          const target = { scope: "instance" as const, id: "revoked-build" }
          const first = yield* api.CreatePlugin({ ...target, files: files(target.id) })
          expect((yield* api.EnablePlugin({ ...target, commit: first, consent: true })).ok).toBe(true)
          const start = verifies.count
          yield* host.clientAsset(actor, { ...target, commit: first })
          yield* host.clientAsset(actor, { ...target, commit: first })
          expect(verifies.count - start).toBeLessThanOrEqual(1)

          yield* api.DisablePlugin(target)
          expect((yield* host.clientAsset(actor, { ...target, commit: first }).pipe(Effect.exit))._tag).toBe("Failure")

          expect((yield* api.EnablePlugin({ ...target, commit: first, consent: true })).ok).toBe(true)
          yield* host.clientAsset(actor, { ...target, commit: first })
          const second = yield* api.CommitPlugin({
            ...target,
            files: files(target.id, "export const activate = () => { void 1 }"),
            message: "Second"
          })
          expect((yield* api.EnablePlugin({ ...target, commit: second, consent: true })).ok).toBe(true)
          expect((yield* host.clientAsset(actor, { ...target, commit: first }).pipe(Effect.exit))._tag).toBe("Failure")
          yield* host.clientAsset(actor, { ...target, commit: second })
        })
      ).pipe(Effect.provide(serverLayer(config)))
    )
  }
)
