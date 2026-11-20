// A disk cache for the React Compiler's Babel pass (vite.config.ts), the slow part of the client
// build: Babel runs file by file on one thread, ~30–40 s for the whole client. A file's output is
// kept under a key of everything that decides it (the lockfile, which pins Babel and the compiler;
// vite.config.ts and this file, which set the options; the environment, module type, path and
// source), so a build after a UI change compiles only the files that changed. A successful build
// drops the entries it didn't use, so the cache holds one build's worth. Any cache failure falls
// back to compiling. RP_BABEL_CACHE=off turns it off; RP_BABEL_CACHE=<dir> moves it (the image
// build keeps it in a BuildKit cache mount, Dockerfile).
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

type Handler = (this: unknown, code: string, id: string, options?: { moduleType?: string }) => Promise<unknown>

const DEFAULT_DIR = fileURLToPath(new URL("../node_modules/.cache/babel-react-compiler/", import.meta.url))
const SALT_FILES = ["../../../package-lock.json", "../vite.config.ts", "./babelCache.ts"]

export function babelCache(plugin: Plugin): Plugin {
  const setting = process.env.RP_BABEL_CACHE
  const transform = plugin.transform as { handler: Handler } | undefined
  if (setting === "off" || transform === undefined) return plugin
  const dir = setting === undefined || setting === "" ? DEFAULT_DIR : setting
  const salt = createHash("sha256")
  for (const file of SALT_FILES) salt.update(readFileSync(new URL(file, import.meta.url))).update("\0")
  salt.update(process.env.NODE_ENV ?? "")
  const prefix = salt.digest("hex")
  const compile = transform.handler
  const used = new Set<string>()
  let failed = false
  let isBuild = false

  transform.handler = async function (code, id, options) {
    const environment = (this as { environment?: { name?: string } }).environment?.name ?? ""
    const key = createHash("sha256")
      .update([prefix, environment, options?.moduleType ?? "", id, code].join("\0"))
      .digest("hex")
    const file = join(dir, `${key}.json`)
    used.add(`${key}.json`)
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as { result: unknown }
      return cached.result ?? undefined
    } catch {
      // Not cached (or unreadable): compile.
    }
    const result = await compile.call(this, code, id, options)
    try {
      mkdirSync(dir, { recursive: true })
      const temporary = join(dir, `.${randomUUID()}.tmp`)
      writeFileSync(temporary, JSON.stringify({ result: result ?? null }))
      renameSync(temporary, file)
    } catch {
      // A cache that can't be written only costs the next build time.
    }
    return result
  }

  const inherited = plugin.configResolved
  const configResolved = typeof inherited === "function" ? inherited : inherited?.handler
  return {
    ...plugin,
    configResolved(config) {
      isBuild = config.command === "build"
      return configResolved?.call(this, config)
    },
    buildEnd(error) {
      if (error !== undefined) failed = true
    },
    closeBundle() {
      if (!isBuild || failed || used.size === 0) return
      try {
        for (const name of readdirSync(dir)) if (!used.has(name)) rmSync(join(dir, name), { force: true })
      } catch {
        // Pruning is best effort.
      }
    }
  }
}
