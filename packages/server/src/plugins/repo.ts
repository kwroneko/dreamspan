import { createHash } from "node:crypto"
// JavaScript git only: no git executable, hooks, filters, package manager or lifecycle scripts.
import fs from "node:fs"
import { lstat, mkdir, readdir, readFile, realpath, writeFile, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import git from "isomorphic-git"
import { Schema } from "effect"
import { PluginCommit, PluginId, PluginManifest } from "@rp/shared/plugins.ts"

export const limits = { file: 512 * 1024, bytes: 8 * 1024 * 1024, files: 256 }
export const validPath = (path: string) => {
  if (
    !path ||
    path.length > 240 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git") ||
    /[:\x00-\x1f]/.test(path)
  )
    throw new Error("Invalid plugin path")
  return path
}
export const pluginFolder = (dataDir: string, owner: string, id: string) => {
  Schema.decodeUnknownSync(PluginId)(id)
  if (owner && !/^[a-zA-Z0-9-]{1,80}$/.test(owner)) throw new Error("Invalid plugin owner")
  return join(resolve(dataDir), "plugins", ...(owner ? ["users", owner] : ["instance"]), id)
}
/** Reject symbolic links in every parent, including DATA_DIR/plugins and .git. */
export const confined = async (base: string, path: string, create = false) => {
  const root = resolve(base)
  const target = resolve(path)
  if (!target.startsWith(root + sep) && target !== root) throw new Error("Invalid plugin path")
  if ((await realpath(root)) !== root) throw new Error("Plugin root must not be a symbolic link")
  const parts = target.slice(root.length).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    if (create) await mkdir(current, { recursive: true })
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Plugin directory must be a real directory")
  }
  return target
}

export const diskFiles = async (folder: string): Promise<Map<string, Uint8Array>> => {
  const files = new Map<string, Uint8Array>()
  const portable = new Set<string>()
  let total = 0,
    directories = 0
  const visit = async (dir: string, prefix: string) => {
    if (++directories > 512 || prefix.split("/").length > 24) throw new Error("Plugin directory limit exceeded")
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (prefix === "" && entry.name === ".git") {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Invalid git directory")
        continue
      }
      const path = validPath(prefix + entry.name)
      const folded = path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC")
      if (portable.has(folded)) throw new Error("Plugin path collision")
      portable.add(folded)
      if (entry.isSymbolicLink()) throw new Error("Plugin symbolic links are refused")
      if (entry.isDirectory()) {
        await visit(join(dir, entry.name), path + "/")
        continue
      }
      const stat = await lstat(join(dir, entry.name))
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > limits.file ||
        total + stat.size > limits.bytes ||
        files.size >= limits.files
      )
        throw new Error("Plugin size limit exceeded")
      total += stat.size
      files.set(path, await readFile(join(dir, entry.name)))
    }
  }
  await visit(folder, "")
  if (files.has(".gitmodules")) throw new Error("Plugin submodules are refused")
  return files
}
const safeGit = async (folder: string) => {
  const metadata = await lstat(join(folder, ".git"))
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Git metadata links are refused")
  let count = 0,
    bytes = 0
  const visit = async (dir: string, depth: number) => {
    if (depth > 16 || ++count > 4096) throw new Error("Git metadata limit exceeded")
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (++count > 4096) throw new Error("Git metadata limit exceeded")
      if (entry.isSymbolicLink()) throw new Error("Git metadata links are refused")
      if (entry.isDirectory()) await visit(path, depth + 1)
      else {
        const info = await lstat(path)
        bytes += info.size
        if (!info.isFile() || info.nlink !== 1 || info.size > 32 * 1024 * 1024 || bytes > 128 * 1024 * 1024)
          throw new Error("Git metadata size limit exceeded")
      }
    }
  }
  await visit(join(folder, ".git"), 0)
}
const verifyObject = async (folder: string, oid: string) => {
  const raw = await git.readObject({ fs, dir: folder, oid, format: "content" })
  if (raw.format !== "content" || !(raw.object instanceof Uint8Array)) throw new Error("Invalid Git object")
  const hash = createHash("sha1").update(`${raw.type} ${raw.object.length}\0`).update(raw.object).digest("hex")
  if (hash !== oid) throw new Error("Git object differs from its pinned hash")
}
export const commitFiles = async (folder: string, commit: string) => {
  await safeGit(folder)
  Schema.decodeUnknownSync(PluginCommit)(commit)
  await verifyObject(folder, commit)
  const { commit: object } = await git.readCommit({ fs, dir: folder, oid: commit })
  const files = new Map<string, Uint8Array>()
  let total = 0,
    directories = 0
  const portable = new Set<string>()
  const visit = async (oid: string, prefix: string) => {
    if (++directories > 512 || prefix.split("/").length > 24) throw new Error("Plugin directory limit exceeded")
    await verifyObject(folder, oid)
    const { tree } = await git.readTree({ fs, dir: folder, oid })
    for (const item of tree) {
      if (item.path.includes("/")) throw new Error("Invalid Git tree component")
      const path = validPath(prefix + item.path)
      const folded = path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC")
      if (portable.has(folded)) throw new Error("Plugin path collision")
      portable.add(folded)
      if (item.type === "tree") {
        await visit(item.oid, path + "/")
        continue
      }
      if (item.type !== "blob" || !["100644", "100755"].includes(item.mode))
        throw new Error("Plugin links and submodules are refused")
      // loose/packed blob expansion happens in the bounded check child, never the HTTP thread.
      await verifyObject(folder, item.oid)
      const { blob } = await git.readBlob({ fs, dir: folder, oid: item.oid })
      total += blob.length
      if (blob.length > limits.file || total > limits.bytes || files.size >= limits.files)
        throw new Error("Plugin size limit exceeded")
      files.set(path, blob)
    }
  }
  await visit(object.tree, "")
  if (files.has(".gitmodules")) throw new Error("Plugin submodules are refused")
  return files
}
export const sameTree = (a: Map<string, Uint8Array>, b: Map<string, Uint8Array>) =>
  a.size === b.size &&
  [...a].every(([key, value]) => {
    const other = b.get(key)
    return other !== undefined && Buffer.from(value).equals(other)
  })

export const snapshot = async (dataDir: string, owner: string, id: string, commit: string, build: string) => {
  const folder = await confined(dataDir, pluginFolder(dataDir, owner, id))
  await safeGit(folder)
  if ((await git.resolveRef({ fs, dir: folder, ref: "HEAD" })) !== commit)
    throw new Error("Plugin HEAD differs from pinned commit")
  const tree = await commitFiles(folder, commit)
  if (!sameTree(tree, await diskFiles(folder))) throw new Error("Plugin working tree differs from pinned commit")
  await confined(dataDir, build, true)
  for (const [path, contents] of tree) {
    await mkdir(join(build, path, ".."), { recursive: true })
    await writeFile(join(build, path), contents, { flag: "wx" })
  }
  for (const reserved of ["server.mjs", "worker.mjs", "client.mjs", "worker-bridge.mjs", "check.json"])
    if (tree.has(reserved)) throw new Error("Reserved plugin build filename")
  const raw = tree.get("rp-plugin.json")
  if (!raw) throw new Error("Missing plugin manifest")
  const manifest = Schema.decodeUnknownSync(PluginManifest)(JSON.parse(Buffer.from(raw).toString("utf8")))
  if (manifest.id !== id) throw new Error("Plugin id does not match folder")
  for (const entry of [manifest.server, manifest.worker, manifest.client])
    if (entry && !tree.has(validPath(entry))) throw new Error("Missing plugin entry")
  return manifest
}
export const saveFiles = async (
  dataDir: string,
  owner: string,
  id: string,
  files: Readonly<Record<string, string>>,
  initial: boolean,
  message: string
) => {
  const folder = await confined(dataDir, pluginFolder(dataDir, owner, id), initial)
  if (initial) {
    if ((await readdir(folder)).length) throw new Error("Plugin already exists")
    await git.init({ fs, dir: folder, defaultBranch: "main" })
  }
  let total = 0
  if (Object.keys(files).length > limits.files) throw new Error("Plugin size limit exceeded")
  for (const [path, content] of Object.entries(files)) {
    validPath(path)
    total += Buffer.byteLength(content)
    if (Buffer.byteLength(content) > limits.file || total > limits.bytes) throw new Error("Plugin size limit exceeded")
    await confined(dataDir, join(folder, path, ".."), true)
    const target = join(folder, path)
    const stat = await lstat(target).catch(() => null)
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
      throw new Error("Plugin symbolic links are refused")
    await writeFile(target, content)
  }
  await safeGit(folder)
  const tree = await diskFiles(folder)
  for (const path of tree.keys()) await git.add({ fs, dir: folder, filepath: path })
  return git.commit({
    fs,
    dir: folder,
    message: message.slice(0, 1000),
    author: { name: "Plugin author", email: "plugin@localhost" }
  })
}
export const repoLog = async (folder: string) => {
  await safeGit(folder)
  return (await git.log({ fs, dir: folder, depth: 50 })).map((entry) => ({
    commit: entry.oid,
    message: entry.commit.message.slice(0, 1000)
  }))
}
export const repoDiff = async (folder: string, before: string, after: string) => {
  const a = await commitFiles(folder, before),
    b = await commitFiles(folder, after)
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((key) => !a.has(key) || !b.has(key) || !Buffer.from(a.get(key)!).equals(b.get(key)!))
    .sort()
}

/** Explicit rollback/update only. Preserve every commit under a branch before moving HEAD. */
export const checkoutCommit = async (dataDir: string, owner: string, id: string, commit: string) => {
  const folder = await confined(dataDir, pluginFolder(dataDir, owner, id))
  await safeGit(folder)
  const head = await git.resolveRef({ fs, dir: folder, ref: "HEAD" })
  const current = await diskFiles(folder)
  if (!sameTree(current, await commitFiles(folder, head))) throw new Error("Commit local changes before going back")
  const wanted = await commitFiles(folder, commit)
  await git.writeRef({ fs, dir: folder, ref: `refs/heads/saved-${head}`, value: head, force: true })
  for (const path of current.keys()) await rm(join(folder, path))
  for (const [path, bytes] of wanted) {
    await confined(dataDir, join(folder, path, ".."), true)
    await writeFile(join(folder, path), bytes, { flag: "wx" })
  }
  const branch = `refs/heads/enabled-${commit}`
  await git.writeRef({ fs, dir: folder, ref: branch, value: commit, force: true })
  await git.writeRef({ fs, dir: folder, ref: "HEAD", value: branch, symbolic: true, force: true })
}

export const readManifest = async (dataDir: string, folder: string) => {
  await confined(dataDir, folder)
  const file = join(folder, "rp-plugin.json"),
    info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limits.file) throw new Error("Invalid plugin manifest")
  return Schema.decodeUnknownSync(PluginManifest)(JSON.parse(await readFile(file, "utf8")))
}
