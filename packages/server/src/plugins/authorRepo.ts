// Authoring never evaluates source. All paths and Git objects stay in this bounded repository child.
import fs from "node:fs"
import { createHash } from "node:crypto"
import { readFile, writeFile, rename, rm, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import git from "isomorphic-git"
import { commitFiles, diskFiles, limits, validPath, confined, pluginFolder, safeGit } from "./repo.ts"

export interface AuthorRequest {
  readonly action: "read" | "search" | "diff" | "write" | "edit" | "commit" | "checkpoint" | "undo"
  readonly commit?: string
  readonly path?: string
  readonly content?: string
  readonly edits?: ReadonlyArray<{ readonly old_str: string; readonly new_str: string }>
  readonly query?: string
  readonly from?: number
  readonly count?: number
  readonly message?: string
  /** Server-created idempotency key. Never a model-selected filesystem path. */
  readonly key?: string
  readonly preview?: boolean
  readonly undo?: string
}
export interface AuthorResult {
  readonly text: string
  readonly commit?: string
  readonly recovered?: true
  readonly head?: string
  readonly tree?: string
  readonly journal?: string
}
interface Journal {
  digest: string
  before: Record<string, string>
  after: Record<string, string>
  parent: string
  timestamp: number
  commitUndo?: boolean
  result?: AuthorResult
}
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex")
const decode = (bytes: Uint8Array) => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error("Only UTF-8 text files are supported")
  return text
}
const filesText = (files: Map<string, Uint8Array>) => Object.fromEntries([...files].map(([p, b]) => [p, decode(b)]))
const treeHash = (files: Record<string, string>) => hash(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
const bound = (files: Record<string, string>) => {
  if (Object.keys(files).length > limits.files) throw new Error("Plugin file count exceeded")
  let total = 0
  for (const [path, text] of Object.entries(files)) {
    validPath(path)
    if (
      path.split("/").length > 24 ||
      path.split("/").some((p) => ["__proto__", "constructor", "prototype"].includes(p)) ||
      path === ".gitmodules" ||
      /^(?:server|worker|client|worker-bridge)\.mjs$|^check\.json$/.test(path)
    )
      throw new Error("Reserved or excessively deep plugin path")
    decode(Buffer.from(text))
    total += Buffer.byteLength(text)
    if (Buffer.byteLength(text) > limits.file || total > limits.bytes) throw new Error("Plugin size limit exceeded")
  }
  const paths = Object.keys(files)
  for (const p of paths)
    for (const q of paths) {
      if (p === q) continue
      const a = p.split("/"),
        b = q.split("/")
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i]!.toUpperCase().toLowerCase().normalize("NFC") !== b[i]!.toUpperCase().toLowerCase().normalize("NFC"))
          break
        if (a[i] !== b[i] || i === a.length - 1) throw new Error("Plugin path collision")
      }
    }
}
const replaceTree = async (
  dataDir: string,
  folder: string,
  before: Record<string, string>,
  after: Record<string, string>
) => {
  // Each rename is atomic. The durable intent admits only before/after states on recovery.
  const current = filesText(await diskFiles(folder))
  for (const p of new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(current)]))
    if (current[p] !== before[p] && current[p] !== after[p]) throw new Error("Plugin changed since; read it again")
  for (const p of Object.keys(current)) if (!Object.hasOwn(after, p)) await rm(join(folder, p))
  for (const [p, text] of Object.entries(after)) {
    if (current[p] === text) continue
    await confined(dataDir, join(folder, p, ".."), true)
    const temporary = join(folder, ".git", `rp-write-${hash(p)}`)
    await writeFile(temporary, text, { flag: "w", mode: 0o600 })
    await rename(temporary, join(folder, p))
  }
}
export const authorRepo = async (
  dataDir: string,
  owner: string,
  id: string,
  request: AuthorRequest
): Promise<AuthorResult> => {
  const folder = await confined(dataDir, pluginFolder(dataDir, owner, id))
  // Object validation also validates all Git metadata, including hooks/config links.
  const parent = await git.resolveRef({ fs, dir: folder, ref: "HEAD" })
  const saved = await commitFiles(folder, parent)
  const current = filesText(await diskFiles(folder))
  if (request.path !== undefined) bound({ [request.path]: "" })
  bound(current)
  if (request.action === "read") {
    const text = current[request.path!]
    if (text === undefined) throw new Error("Plugin file not found")
    const from = Math.max(1, Math.floor(request.from ?? 1)),
      count = Math.min(200, Math.max(1, Math.floor(request.count ?? 100)))
    return {
      text: JSON.stringify({
        path: request.path,
        from,
        lines: text
          .split("\n")
          .slice(from - 1, from - 1 + count)
          .map((t, n) => `${from + n}: ${t}`)
      })
    }
  }
  if (request.action === "search") {
    if (!request.query || request.query.length > 200) throw new Error("Use a short literal search")
    const matches: Array<{ path: string; line: number; text: string }> = []
    for (const [path, text] of Object.entries(current)) {
      if (request.path && path !== request.path && !path.startsWith(request.path + "/")) continue
      for (const [n, line] of text.split("\n").entries())
        if (line.includes(request.query)) {
          matches.push({ path, line: n + 1, text: line.slice(0, 300) })
          if (matches.length >= 30) return { text: JSON.stringify({ matches, limited: true }) }
        }
    }
    return { text: JSON.stringify({ matches }) }
  }
  if (request.action === "diff") {
    const before = filesText(saved)
    return {
      text: JSON.stringify({
        files: [...new Set([...Object.keys(before), ...Object.keys(current)])]
          .filter((p) => before[p] !== current[p])
          .map((p) => ({ path: p, before: before[p] ?? null, after: current[p] ?? null }))
      })
    }
  }
  if (request.action === "checkpoint" && request.commit) {
    const selected = filesText(await commitFiles(folder, request.commit))
    bound(selected)
    return {
      text: "Read the saved version for checking.",
      commit: request.commit,
      head: parent,
      tree: treeHash(selected)
    }
  }
  if (request.action === "checkpoint") {
    for (const path of Object.keys(current)) await git.add({ fs, dir: folder, filepath: path })
    const commit = await git.commit({
      fs,
      dir: folder,
      noUpdateBranch: true,
      message: "Working check snapshot",
      author: { name: "Plugin author", email: "plugin@localhost" }
    })
    return {
      text: "Working tree captured for checking; no version was applied.",
      commit,
      head: parent,
      tree: treeHash(current)
    }
  }
  if (!request.key) throw new Error("Missing operation identity")
  const journalId = hash(request.key)
  const journals = join(folder, ".git/rp-workshop")
  await mkdir(journals, { recursive: true })
  const file = join(journals, journalId + ".json")
  const digest = hash({ ...request, preview: undefined })
  let journal: Journal | undefined = await readFile(file, "utf8")
    .then((t) => JSON.parse(t) as Journal)
    .catch(() => undefined)
  if (journal && journal.digest !== digest) throw new Error("Operation identity changed")
  if (journal?.result) return request.preview ? { ...journal.result, recovered: true } : journal.result
  if (!journal) {
    const after = { ...current }
    let commitUndo = false
    if (request.action === "write") after[request.path!] = request.content ?? ""
    if (request.action === "edit") {
      let text = after[request.path!]
      if (text === undefined || !request.edits?.length || request.edits.length > 32)
        throw new Error("Read a file before editing it")
      for (const edit of request.edits) {
        if (!edit.old_str || text.split(edit.old_str).length !== 2) throw new Error("Each edit must match exactly once")
        text = text.replace(edit.old_str, () => edit.new_str)
      }
      after[request.path!] = text
    }
    if (request.action === "undo") {
      if (!/^[a-f0-9]{64}$/.test(request.undo ?? "")) throw new Error("Invalid undo")
      const prior = JSON.parse(await readFile(join(journals, request.undo + ".json"), "utf8")) as Journal
      if (!prior.result || treeHash(current) !== treeHash(prior.after))
        throw new Error("Plugin changed since; undo newer edits first")
      commitUndo = !!prior.result.commit
      for (const p of Object.keys(after)) delete after[p]
      Object.assign(after, prior.before)
    }
    bound(after)
    if (request.preview) return { text: "Files validated", tree: treeHash(after) }
    journal = {
      digest,
      before: request.action === "commit" ? filesText(saved) : current,
      after,
      parent,
      commitUndo,
      timestamp: Math.floor(Date.now() / 1000)
    }
    await writeFile(file, JSON.stringify(journal), { flag: "wx", mode: 0o600 })
  }
  if (request.preview) {
    bound(journal.after)
    for (const p of new Set([...Object.keys(journal.before), ...Object.keys(journal.after), ...Object.keys(current)]))
      if (current[p] !== journal.before[p] && current[p] !== journal.after[p])
        throw new Error("Plugin changed since; read it again")
    return { text: "Files validated", tree: treeHash(journal.after) }
  }
  await replaceTree(dataDir, folder, journal.before, journal.after)
  let commit: string | undefined
  if (request.action === "commit" || (request.action === "undo" && journal.commitUndo)) {
    // Stable parent and timestamp mean an interrupted commit is recreated with the same id.
    const head = await git.resolveRef({ fs, dir: folder, ref: "HEAD" })
    for (const path of await git.listFiles({ fs, dir: folder }))
      if (!Object.hasOwn(journal.after, path)) await git.remove({ fs, dir: folder, filepath: path })
    for (const path of Object.keys(journal.after)) await git.add({ fs, dir: folder, filepath: path })
    commit = await git.commit({
      fs,
      dir: folder,
      noUpdateBranch: true,
      parent: [journal.parent],
      message: (request.message ?? "Undo workshop change").slice(0, 1000),
      author: { name: "Plugin author", email: "plugin@localhost", timestamp: journal.timestamp, timezoneOffset: 0 }
    })
    if (head !== journal.parent && head !== commit) throw new Error("Plugin version changed since")
    const ref = await git.currentBranch({ fs, dir: folder, fullname: true })
    if (!ref) throw new Error("Missing plugin branch")
    await git.writeRef({ fs, dir: folder, ref, value: commit, force: true })
  }
  const result: AuthorResult = {
    text: commit ? `Saved version ${commit}. Nothing was enabled.` : `Saved ${request.path}. Nothing was enabled.`,
    ...(commit ? { commit } : {}),
    tree: treeHash(journal.after),
    journal: journalId
  }
  journal.result = result
  const temporary = file + ".tmp"
  await writeFile(temporary, JSON.stringify(journal), { mode: 0o600 })
  await rename(temporary, file)
  return result
}

/** A durable creation intent precedes files/HEAD. A crash resumes the same deterministic first commit. */
/** Recover this application's own creation key; no journal from the copied source is imported. */
export const resumeAuthorCreation = async (
  dataDir: string,
  owner: string,
  id: string,
  key: string
): Promise<AuthorResult | null> => {
  const folder = pluginFolder(dataDir, owner, id)
  try {
    await confined(dataDir, folder)
  } catch {
    return null
  }
  if ((await readdir(folder)).length === 0) return null
  await safeGit(folder)
  const marker = join(folder, ".git/rp-create")
  const intent = await readFile(marker, "utf8")
    .then((t) => JSON.parse(t) as { key: string; digest: string; commit?: string; paths?: Array<string> })
    .catch(() => null)
  if (!intent || intent.key !== key) return null
  const tree = intent.commit ? await commitFiles(folder, intent.commit) : await diskFiles(folder)
  const paths = intent.paths ?? [...tree.keys()]
  if (paths.length !== tree.size || new Set(paths).size !== tree.size || paths.some((p) => !tree.has(p))) return null
  const files = Object.fromEntries(paths.map((path) => [path, decode(tree.get(path)!)]))
  if (hash(files) !== intent.digest) return null
  return createAuthorRepo(dataDir, owner, id, files, key)
}
export const createAuthorRepo = async (
  dataDir: string,
  owner: string,
  id: string,
  files: Record<string, string>,
  key: string
): Promise<AuthorResult> => {
  bound(files)
  const folder = await confined(dataDir, pluginFolder(dataDir, owner, id), true)
  const marker = join(folder, ".git/rp-create")
  let intent = await readFile(marker, "utf8")
    .then(
      (t) => JSON.parse(t) as { key: string; digest: string; timestamp: number; commit?: string; paths?: Array<string> }
    )
    .catch(() => undefined)
  if (!intent) {
    const entries = await readdir(folder)
    // An empty metadata directory is the only state before the creation intent.
    if (
      entries.length &&
      !(entries.length === 1 && entries[0] === ".git" && !(await readdir(join(folder, ".git"))).length)
    )
      throw new Error("Plugin already exists")
    await confined(dataDir, join(folder, ".git"), true)
    intent = { key, digest: hash(files), timestamp: Math.floor(Date.now() / 1000), paths: Object.keys(files) }
    await writeFile(marker, JSON.stringify(intent), { flag: "wx", mode: 0o600 })
  }
  await safeGit(folder)
  if (intent.key !== key || intent.digest !== hash(files)) throw new Error("Plugin already exists")
  if (intent.commit) return { text: `Created ${id} at ${intent.commit}. Nothing was enabled.`, commit: intent.commit }
  // Initialization is idempotent. The intent must survive a crash before HEAD/config exist.
  await git.init({ fs, dir: folder, defaultBranch: "main" })
  await replaceTree(dataDir, folder, {}, files)
  for (const path of Object.keys(files)) await git.add({ fs, dir: folder, filepath: path })
  const commit = await git.commit({
    fs,
    dir: folder,
    noUpdateBranch: true,
    parent: [],
    message: "Start plugin",
    author: { name: "Plugin author", email: "plugin@localhost", timestamp: intent.timestamp, timezoneOffset: 0 }
  })
  await git.writeRef({ fs, dir: folder, ref: "refs/heads/main", value: commit, force: true })
  const temporary = marker + ".tmp"
  await writeFile(temporary, JSON.stringify({ ...intent, commit }), { mode: 0o600 })
  await rename(temporary, marker)
  return { text: `Created ${id} at ${commit}. Nothing was enabled.`, commit }
}
