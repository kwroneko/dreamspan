// Shipped source only; no caller-selected root, filesystem search, config, data or environment.
import { readFile, readdir, lstat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join, resolve, sep } from "node:path"
import { pluginDocumentation } from "../../../plugin-api/src/docs.ts"
import { budgetResult } from "../agent/tools.ts"
import { confined, validPath } from "./repo.ts"
import { builtinCopies } from "./builtins.ts"
const root = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "")
const sourceRoots = ["packages/server/src/agent", "packages/server/src/plugins", "packages/plugin-api/src"]
const sourceFiles = [
  ...builtinCopies.filter((p) => p.side === "client").flatMap((p) => p.files),
  "packages/shared/src/registry.ts",
  "packages/shared/src/pluginClient.ts",
  "packages/shared/src/pluginConsent.ts"
]
const safeSource = (p: string) =>
  /\.(?:ts|tsx)$/.test(p) && !/(?:config|secret|credential|environment|\.test\.)/i.test(p)
export const appSource = async (
  input: { path?: string; query?: string; from?: number; count?: number },
  dataDir?: string
) => {
  const dataRoot = dataDir ? resolve(dataDir) : undefined
  const inData = (p: string) => dataRoot !== undefined && (p === dataRoot || p.startsWith(dataRoot + sep))
  const files = sourceFiles.filter((p) => !inData(join(root, p)))
  const visit = async (p: string, depth: number) => {
    if (inData(join(root, p))) return
    if (depth > 8 || files.length > 256) throw new Error("Source index limit exceeded")
    await confined(root, join(root, p))
    for (const e of await readdir(join(root, p), { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue
      const path = p + "/" + e.name
      if (inData(join(root, path))) continue
      if (e.isDirectory()) await visit(path, depth + 1)
      else if (e.isFile() && safeSource(path)) {
        if (files.length >= 256) throw new Error("Source index limit exceeded")
        files.push(path)
      }
    }
  }
  for (const p of sourceRoots) await visit(p, 0)
  const read = async (p: string) => {
    await confined(root, join(root, p, ".."))
    const stat = await lstat(join(root, p))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024)
      throw new Error("Source unavailable or too large")
    return readFile(join(root, p), "utf8")
  }
  const scope =
    "Read-only shipped reference: server agent/plugins, plugin-api, shared registry/pluginClient/pluginConsent and the copyable client parts. No data, configuration, environment or secrets. At most 256 files, 128 KiB/file, 200 lines or 30 matches, 12000 characters/result."
  if (input.path) {
    validPath(input.path)
    if (!files.includes(input.path)) throw new Error("Path is outside shipped reference sources")
    const from = Math.max(1, input.from ?? 1),
      count = Math.min(200, Math.max(1, input.count ?? 100))
    return budgetResult(
      JSON.stringify({
        scope,
        path: input.path,
        from,
        lines: (await read(input.path))
          .split("\n")
          .slice(from - 1, from - 1 + count)
          .map((s, n) => `${from + n}: ${s}`)
      }),
      12000
    )
  }
  if (!input.query) return budgetResult(JSON.stringify({ scope, paths: files.sort() }), 12000)
  if (input.query.length > 200) throw new Error("Use a short literal query")
  const matches: Array<{ path: string; line: number; text: string }> = []
  for (const p of files.sort())
    for (const [i, line] of (await read(p)).split("\n").entries())
      if (line.includes(input.query)) {
        matches.push({ path: p, line: i + 1, text: line.slice(0, 240) })
        if (matches.length >= 30) return budgetResult(JSON.stringify({ scope, matches, limited: true }), 12000)
      }
  return budgetResult(JSON.stringify({ scope, matches }), 12000)
}
/** Declarations and their comments are read from the installed API package, never a parallel schema. */
export const pluginApiDocs = async (topic?: string) => {
  if (!topic)
    return JSON.stringify({
      api: 1,
      topics: pluginDocumentation.map(({ topic, description }) => ({ topic, description })),
      unsupported:
        "Other structural descriptors, full provider/reply transports, internal overrides are not supported authoring contracts. Only built-ins listed by plugin_copy_builtin are copyable."
    })
  const doc = pluginDocumentation.find((d) => d.topic === topic)
  if (!doc) throw new Error("Unknown API topic; read the index")
  const source = await readFile(join(root, "packages/plugin-api/src", doc.side + ".ts"), "utf8")
  let types = doc.types
    .map((name) => {
      const start = source.indexOf("interface " + name)
      if (start < 0) return ""
      const open = source.indexOf("{", start)
      let depth = 1,
        end = open + 1
      for (; end < source.length && depth; end++) {
        if (source[end] === "{") depth++
        if (source[end] === "}") depth--
      }
      return source.slice(start, end)
    })
    .join("\n")
  if (topic === "stateKeys" || topic === "macros") {
    const extra = await readFile(
      join(root, topic === "stateKeys" ? "packages/shared/src/state.ts" : "packages/shared/src/macros/registry.ts"),
      "utf8"
    )
    for (const name of topic === "stateKeys" ? ["PluginStateKey"] : ["MacroSpec", "MacroEntry", "DataMacroSpec"]) {
      const start = extra.indexOf("export interface " + name),
        open = extra.indexOf("{", start)
      let depth = 1,
        end = open + 1
      for (; end < extra.length && depth; end++) {
        if (extra[end] === "{") depth++
        if (extra[end] === "}") depth--
      }
      types += "\n" + extra.slice(start, end)
    }
  }
  return budgetResult(
    JSON.stringify({ api: 1, topic, description: doc.description, types, example: doc.example }),
    12000
  )
}
