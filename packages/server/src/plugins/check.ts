import { randomUUID, createHash } from "node:crypto"
import { readFile, readdir, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { type PluginReport, PluginManifest } from "@rp/shared/plugins.ts"
import { runPluginChild } from "./process.ts"
import { confined, pluginFolder } from "./repo.ts"

const root = fileURLToPath(new URL("../../../../", import.meta.url))
/** Hash the installed source/API closure as well as dependencies and generated worker stamp. */
const pluginAppStamp = async () => {
  const hash = createHash("sha256")
  const visit = async (dir: string) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) hash.update(file.slice(root.length)).update(await readFile(file))
    }
  }
  for (const path of ["packages/server/src", "packages/shared/src", "packages/plugin-api/src"])
    await visit(join(root, path))
  hash.update(await readFile(join(root, "package-lock.json")))
  hash.update(await readFile(join(root, "packages/server/dist/workers/stamp.json")).catch(() => Buffer.from("source")))
  return hash.digest("hex")
}
// Only this process can attest a previous check report. Restarts recheck from source.
const checkedReports = new Map<string, string>()
const buildFolder = (dataDir: string, owner: string, id: string, commit: string) =>
  join(resolve(dataDir), "plugins", ".builds", owner || "instance", id, commit)
export const checkPlugin = async (
  dataDir: string,
  owner: string,
  id: string,
  commit: string
): Promise<PluginReport> => {
  const appStamp = await pluginAppStamp()
  const report: PluginReport = {
    commit,
    appStamp,
    ok: false,
    step: "snapshot",
    message: "Plugin check failed",
    at: Date.now()
  }
  let staging: string | undefined
  try {
    await confined(dataDir, pluginFolder(dataDir, owner, id))
    const build = buildFolder(dataDir, owner, id, commit)
    // Always compare the on-disk tree, even for a cached build. Cache is not consent.
    const parent = join(build, "..")
    await confined(dataDir, parent, true)
    staging = join(parent, `.check-${randomUUID()}`)
    const child = await runPluginChild(new URL("./checkChild.ts", import.meta.url), [
      dataDir,
      owner,
      id,
      commit,
      staging,
      appStamp,
      build,
      checkedReports.get(build) ?? ""
    ])
    if (!child.ok) return report
    const checked = JSON.parse(await readFile(join(staging, "check.json"), "utf8")) as PluginReport
    if (!checked.ok) return checked
    // Never reuse mutable compiled output: publish only a freshly checked staging tree.
    await rm(build, { recursive: true, force: true })
    await rename(staging, build)
    staging = undefined
    checkedReports.set(
      build,
      createHash("sha256")
        .update(await readFile(join(build, "check.json")))
        .digest("hex")
    )
    return checked
  } catch {
    return report
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
  }
}
export const readBuild = async (dataDir: string, owner: string, id: string, commit: string) => {
  const folder = await confined(dataDir, buildFolder(dataDir, owner, id, commit))
  const manifest = Schema.decodeUnknownSync(PluginManifest)(
    JSON.parse(await readFile(join(folder, "rp-plugin.json"), "utf8"))
  )
  return { folder, manifest }
}
