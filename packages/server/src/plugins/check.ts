import { randomUUID, createHash } from "node:crypto"
import { readFile, readdir, rename, rm, lstat } from "node:fs/promises"
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
  commit: string,
  authoring?: {
    readonly working: boolean
    readonly admin: boolean
    readonly historical?: boolean
    readonly approved?: boolean
  }
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
    // Approval checks compare HEAD and working files. Runtime checks compare the approved
    // Git objects and checked build; newer repository work cannot replace approved code.
    if (authoring?.approved) {
      const { repoTask } = await import("./repoTask.ts")
      await repoTask(dataDir, { op: "verify", owner, id, commit, approved: true })
      await verifyArtifacts(build, commit)
    }
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
      authoring ? "" : (checkedReports.get(build) ?? ""),
      authoring?.historical ? "historical" : authoring?.working ? "working" : "commit",
      authoring?.admin === false ? "regular" : "admin"
    ])
    if (!child.ok) return report
    const checked = JSON.parse(await readFile(join(staging, "check.json"), "utf8")) as PluginReport
    if (!checked.ok) return checked
    // Never reuse mutable compiled output: publish only a freshly checked staging tree.
    await rm(build, { recursive: true, force: true })
    await rename(staging, build)
    staging = undefined
    if (authoring?.admin !== false)
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

/** Read only a generated browser entry attested by this process, after checking its source again. */
export const readClientBuild = async (dataDir: string, owner: string, id: string, commit: string) => {
  const { folder, manifest } = await readBuild(dataDir, owner, id, commit)
  const encoded = await readFile(join(folder, "check.json"), "utf8")
  if (checkedReports.get(folder) !== createHash("sha256").update(encoded).digest("hex"))
    throw new Error("Unattested plugin build")
  const report = JSON.parse(encoded) as PluginReport & { artifacts: Record<string, string> }
  if (!report.ok || report.commit !== commit || !manifest.client) throw new Error("Unchecked client entry")
  const { repoTask } = await import("./repoTask.ts")
  await repoTask(dataDir, { op: "verify", owner, id, commit, approved: true })
  const file = join(folder, "client.mjs")
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)
    throw new Error("Invalid client artifact")
  const bytes = await readFile(file)
  if (createHash("sha256").update(bytes).digest("hex") !== report.artifacts["client.mjs"])
    throw new Error("Changed plugin artifact")
  return { manifest, bytes }
}

/** Stored checksums remain operator-trusted across restarts; any altered approved output is a fault. */
const verifyArtifacts = async (folder: string, commit: string) => {
  const info = await lstat(join(folder, "check.json"))
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 524288)
    throw new Error("Invalid report")
  const report = JSON.parse(await readFile(join(folder, "check.json"), "utf8")) as PluginReport & {
    artifacts: Record<string, string>
  }
  if (!report.ok || report.commit !== commit || !report.artifacts) throw new Error("Invalid report")
  for (const [name, hash] of Object.entries(report.artifacts)) {
    if (!/^(?:server|worker|client|worker-bridge|test-[0-9]+)\.mjs$/.test(name)) throw new Error("Invalid artifact")
    const file = join(folder, name),
      info = await lstat(file)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 16 * 1024 * 1024 ||
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex") !== hash
    )
      throw new Error("Changed plugin artifact")
  }
}
