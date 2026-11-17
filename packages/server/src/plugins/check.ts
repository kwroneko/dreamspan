import { randomUUID, createHash } from "node:crypto"
import { readFile, readdir, rename, rm, lstat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { type PluginReport, PluginManifest } from "@rp/shared/plugins.ts"
import { runPluginChild } from "./process.ts"
import { confined, pluginFolder } from "./repo.ts"

/**
 * Approved-build repo verifies done by this process, keyed by build folder. The value is a
 * fingerprint of the attested report text plus the lstat identity (inode, mode, links, size,
 * mtime and ctime in nanoseconds) of every entry under the plugin's `.git` and build folders.
 * Any write, rename, link or rebuild changes ctime or inode, so the next read verifies again.
 */
const verifiedBuilds = new Map<string, string>()
const stampTree = async (dir: string, hash: ReturnType<typeof createHash>): Promise<void> => {
  const info = await lstat(dir, { bigint: true })
  hash.update(`${dir}\0${info.ino}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeNs}:${info.ctimeNs}\n`)
  if (!info.isDirectory()) return
  for (const name of (await readdir(dir)).sort()) await stampTree(join(dir, name), hash)
}
const buildStamp = async (dataDir: string, owner: string, id: string, folder: string, report: string) => {
  const hash = createHash("sha256").update(report).update("\0")
  await stampTree(await confined(dataDir, join(pluginFolder(dataDir, owner, id), ".git")), hash)
  await stampTree(folder, hash)
  return hash.digest("hex")
}

const root = fileURLToPath(new URL("../../../../", import.meta.url))
/** Hash the installed source/API closure as well as dependencies and generated worker stamp. */
export const pluginAppStamp = async (dataDir: string) => {
  const hash = createHash("sha256")
  const dataRoot = resolve(dataDir)
  const visit = async (dir: string) => {
    if (dir === dataRoot || dir.startsWith(dataRoot + "/")) return
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(dir, entry.name)
      if (file === dataRoot || file.startsWith(dataRoot + "/")) continue
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) hash.update(file.slice(root.length)).update(await readFile(file))
    }
  }
  for (const path of ["packages/server/src", "packages/shared/src", "packages/plugin-api/src", "packages/client/src"])
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
  const appStamp = await pluginAppStamp(dataDir)
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
  const file = join(folder, "rp-plugin.json")
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 524288)
    throw new Error("Invalid manifest")
  const manifest = Schema.decodeUnknownSync(PluginManifest)(JSON.parse(await readFile(file, "utf8")))
  return { folder, manifest }
}

/** Capture executable bytes once; worker respawns never reopen mutable build paths. */
export const readRuntimeBuild = async (dataDir: string, owner: string, id: string, commit: string) => {
  const { manifest, artifacts } = await readApprovedBuild(dataDir, owner, id, commit)
  const moduleUrl = (bytes: Buffer) => `data:text/javascript;base64,${bytes.toString("base64")}#${commit}`
  const server = manifest.server ? moduleUrl(artifacts.get("server.mjs")!) : undefined
  const worker = manifest.worker
    ? moduleUrl(
        Buffer.from(
          `import { installWorkerState, installWorkerAssembly } from ${JSON.stringify(new URL("./workerHost.ts", import.meta.url).href)};
import { activate } from ${JSON.stringify(moduleUrl(artifacts.get("worker.mjs")!))};
const manifest = ${JSON.stringify(manifest)};
export const state = installWorkerState(manifest,activate);
export const assembly = installWorkerAssembly(manifest,activate);
`
        )
      )
    : undefined
  return { manifest, server, worker }
}

const readApprovedBuild = async (dataDir: string, owner: string, id: string, commit: string) => {
  const { folder, manifest } = await readBuild(dataDir, owner, id, commit)
  const reportFile = join(folder, "check.json")
  const info = await lstat(reportFile)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 524288)
    throw new Error("Invalid report")
  const encoded = await readFile(reportFile, "utf8")
  if (checkedReports.get(folder) !== createHash("sha256").update(encoded).digest("hex"))
    throw new Error("Unattested plugin build")
  const report = JSON.parse(encoded) as PluginReport & { artifacts: Record<string, string> }
  if (!report.ok || report.commit !== commit) throw new Error("Unchecked entry")
  // Taken before the verify: a change during it gives a different stamp on the next read.
  const stamp = await buildStamp(dataDir, owner, id, folder, encoded)
  if (verifiedBuilds.get(folder) !== stamp) {
    verifiedBuilds.delete(folder)
    const { repoTask } = await import("./repoTask.ts")
    await repoTask(dataDir, { op: "verify", owner, id, commit, approved: true })
    verifiedBuilds.set(folder, stamp)
  }
  const artifacts = new Map<string, Buffer>()
  for (const name of Object.keys(report.artifacts)) {
    if (!/^(?:server|worker|client|worker-bridge|test-[0-9]+)\.mjs$/.test(name)) throw new Error("Invalid artifact")
    const file = join(folder, name)
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)
      throw new Error("Invalid artifact")
    const bytes = await readFile(file)
    if (createHash("sha256").update(bytes).digest("hex") !== report.artifacts[name])
      throw new Error("Changed plugin artifact")
    if (["server.mjs", "worker.mjs", "client.mjs"].includes(name)) artifacts.set(name, bytes)
  }
  for (const side of ["server", "worker", "client"] as const)
    if (manifest[side] && !artifacts.has(`${side}.mjs`)) throw new Error("Missing plugin artifact")
  return { manifest, artifacts }
}

/** Read only a generated browser entry attested by this process, after checking its source again. */
export const readClientBuild = async (dataDir: string, owner: string, id: string, commit: string) => {
  const { manifest, artifacts } = await readApprovedBuild(dataDir, owner, id, commit)
  if (!manifest.client) throw new Error("Unchecked client entry")
  return { manifest, bytes: artifacts.get("client.mjs")! }
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
