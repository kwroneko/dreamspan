// Runs in the bounded repository child. Sources come exclusively from this build's catalog.
import { createHash } from "node:crypto"
import { readFile, lstat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join, dirname, posix, resolve, sep } from "node:path"
import { Schema } from "effect"
import { PluginManifest, type BuiltinComparison } from "@dreamspan/shared/plugins.ts"
import { builtinCopy, type builtinCopies } from "./builtins.ts"
import { rewriteImports } from "./importPolicy.ts"
import { commitFiles, confined, pluginFolder, validPath } from "./repo.ts"
import { createAuthorRepo, resumeAuthorCreation } from "./authorRepo.ts"
import { pluginAppStamp } from "./check.ts"

const root = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "")
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
type Part = (typeof builtinCopies)[number]
class UnsupportedCopyImports extends Error {
  readonly unsupported: ReadonlyArray<string>
  constructor(unsupported: ReadonlyArray<string>) {
    super("This part needs an import adapter")
    this.unsupported = unsupported
  }
}
const readSources = async (part: Part, dataDir: string): Promise<Record<string, string>> => {
  const files: Record<string, string> = {}
  for (const path of part.files) {
    validPath(path)
    const file = join(root, path),
      data = resolve(dataDir)
    if (file === data || file.startsWith(data + sep)) throw new Error("Data is never reference source")
    await confined(root, dirname(file))
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128 * 1024)
      throw new Error("Shipped source unavailable")
    files[path] = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file))
  }
  return files
}
export const prepareBuiltinCopy = async (registry: string, id: string, pluginId: string, dataDir: string) => {
  const part = builtinCopy(registry, id)
  if (!part) throw new Error("This part does not have a copy adapter yet")
  const originals = await readSources(part, dataDir)
  const files: Record<string, string> = {}
  for (const [path, text] of Object.entries(originals)) {
    const rewritten = rewriteImports(text, path, (value) => {
      if (value === "react" && part.side === "client") return value
      if (value === "effect" && part.side !== "client") return `@dreamspan/plugin-api/${part.side}`
      if (!value.startsWith(".")) return undefined
      const target = posix.normalize(posix.join(posix.dirname(path), value))
      const api = (part.imports as Readonly<Record<string, string>>)[target]
      if (api) return api
      if (part.files.some((p) => p === target)) return "./" + posix.basename(target)
      return undefined
    })
    if (rewritten.unsupported.length) throw new UnsupportedCopyImports(rewritten.unsupported)
    files["src/part/" + posix.basename(path)] = rewritten.text
  }
  const digest = sha(originals[part.path]!)
  const app = await pluginAppStamp(dataDir)
  files["builtin-base.json"] = JSON.stringify(
    { files: originals, app, digest: sha(JSON.stringify(originals)) },
    null,
    2
  )
  files["NOTICE.md"] =
    "Editable copy of shipped Dreamspan source. The project has no declared redistribution licence. No third-party implementation is copied; React and Effect remain installed API dependencies under their own licences.\n"
  files["dreamspan-plugin.json"] = JSON.stringify(
    {
      id: pluginId,
      name: part.label + " (editable)",
      api: 1,
      client: part.side === "client" ? "src/client.tsx" : null,
      server: part.side === "server" ? "src/server.ts" : null,
      worker: part.side === "worker" ? "src/worker.ts" : null,
      surfaces: part.surfaces,
      overrides: [],
      network: false,
      replaces: [
        `${registry}:${id}`,
        ...("aliases" in part ? part.aliases.map((alias) => `${registry}:${alias}`) : [])
      ],
      base: { app, path: part.path, sha256: digest }
    },
    null,
    2
  )
  const api = `@dreamspan/plugin-api/${part.side}`
  files[`src/${part.side}.${part.side === "client" ? "tsx" : "ts"}`] =
    `import { ${part.side === "worker" ? "Effect, registerMacro, " : part.side === "server" ? "Effect, " : ""}type Activate } from "${api}"\n` +
    `import { ${part.entry} } from "./part/${posix.basename(part.path)}"\n` +
    `export const activate: Activate = (host) => ${part.side !== "client" ? "Effect.asVoid(" : "{"}${part.side === "worker" ? `registerMacro(host.registries.macros!, ${part.entry}${"macroName" in part ? `.find(p => p.name === ${JSON.stringify(part.macroName)})!` : ""})` : `host.registries.${registry}!.register(${part.entry})`}${part.side !== "client" ? ")" : ";}"}\n`
  return { files, side: part.side }
}
export const copyBuiltin = async (
  dataDir: string,
  registry: string,
  id: string,
  pluginId: string,
  owner: string,
  key: string
) => {
  const resumed = await resumeAuthorCreation(dataDir, owner, pluginId, key)
  if (resumed) return resumed
  const prepared = await prepareBuiltinCopy(registry, id, pluginId, dataDir).catch((error: unknown) => {
    if (error instanceof UnsupportedCopyImports) return { unsupported: error.unsupported }
    throw error
  })
  if ("unsupported" in prepared) return prepared
  if (prepared.side !== "client" && owner) throw new Error("Server copies are instance-wide")
  return createAuthorRepo(dataDir, owner, pluginId, prepared.files, key)
}
/** Committed text only; base.path is matched to the allowlist, never opened as a path. */
export const compareBuiltin = async (
  dataDir: string,
  owner: string,
  id: string,
  commit: string
): Promise<typeof BuiltinComparison.Type | null> => {
  const files = await commitFiles(pluginFolder(dataDir, owner, id), commit)
  const manifest = Schema.decodeUnknownSync(PluginManifest)(
    JSON.parse(Buffer.from(files.get("dreamspan-plugin.json")!).toString("utf8"))
  )
  if (!manifest.base) return null
  const unavailable = { changed: true, available: false, files: [] }
  const part = builtinCopy(...((manifest.replaces[0]?.split(":") ?? []) as [string, string]))
  if (
    !part ||
    manifest.base.path !== part.path ||
    !/^[a-f0-9]{64}$/.test(manifest.base.sha256) ||
    !/^[a-f0-9]{64}$/.test(manifest.base.app)
  )
    return unavailable
  try {
    const original = JSON.parse(Buffer.from(files.get("builtin-base.json")!).toString("utf8")) as {
      files: Record<string, string>
      app: string
      digest: string
    }
    if (
      original.app !== manifest.base.app ||
      sha(JSON.stringify(original.files)) !== original.digest ||
      Object.keys(original.files).length !== part.files.length ||
      part.files.some((p) => typeof original.files[p] !== "string") ||
      sha(original.files[part.path]!) !== manifest.base.sha256
    )
      return unavailable
    const current = await readSources(part, dataDir)
    return {
      changed: sha(JSON.stringify(current)) !== original.digest,
      available: true,
      files: part.files.map((path) => ({
        path: posix.basename(path),
        before: original.files[path]!,
        current: current[path]!
      }))
    }
  } catch {
    return unavailable
  }
}
