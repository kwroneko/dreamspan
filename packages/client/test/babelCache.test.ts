// The build's Babel cache (scripts/babelCache.ts): a file compiles once per content, a change
// compiles again, a cache failure compiles, and a successful build drops unused entries.
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "vite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { babelCache } from "../scripts/babelCache.ts"

type Handler = (this: unknown, code: string, id: string, options?: { moduleType?: string }) => Promise<unknown>

let dir: string
let saved: string | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "babel-cache-test-"))
  saved = process.env.RP_BABEL_CACHE
  process.env.RP_BABEL_CACHE = dir
})
afterEach(() => {
  if (saved === undefined) delete process.env.RP_BABEL_CACHE
  else process.env.RP_BABEL_CACHE = saved
  chmodSync(dir, 0o700)
  rmSync(dir, { recursive: true, force: true })
})

function fakePlugin() {
  const calls: string[] = []
  const plugin = {
    name: "fake-babel",
    configResolved() {},
    transform: {
      filter: undefined,
      handler: async (code: string, id: string) => {
        calls.push(id)
        return code.includes("skip") ? undefined : { code: `compiled(${code})`, map: { mappings: "AAAA" } }
      }
    }
  } as unknown as Plugin
  return { plugin: babelCache(plugin), calls }
}
const run = (plugin: Plugin, code: string, id: string) =>
  (plugin.transform as unknown as { handler: Handler }).handler.call({ environment: { name: "client" } }, code, id, {
    moduleType: "tsx"
  })
const build = (plugin: Plugin) => {
  ;(plugin.configResolved as (config: unknown) => void)({ command: "build" })
  return {
    end: (error?: Error) => {
      ;(plugin.buildEnd as (error?: Error) => void)(error)
      ;(plugin.closeBundle as () => void)()
    }
  }
}

describe("babelCache", () => {
  it("compiles a file once per content, and again when it changes", async () => {
    const first = fakePlugin()
    expect(await run(first.plugin, "a", "/src/A.tsx")).toEqual({ code: "compiled(a)", map: { mappings: "AAAA" } })
    expect(await run(first.plugin, "skip", "/src/B.tsx")).toBeUndefined()
    const second = fakePlugin()
    expect(await run(second.plugin, "a", "/src/A.tsx")).toEqual({ code: "compiled(a)", map: { mappings: "AAAA" } })
    expect(await run(second.plugin, "skip", "/src/B.tsx")).toBeUndefined()
    expect(second.calls).toEqual([])
    expect(await run(second.plugin, "a2", "/src/A.tsx")).toEqual({ code: "compiled(a2)", map: { mappings: "AAAA" } })
    expect(await run(second.plugin, "a", "/src/Other.tsx")).toEqual({ code: "compiled(a)", map: { mappings: "AAAA" } })
    expect(second.calls).toEqual(["/src/A.tsx", "/src/Other.tsx"])
  })

  it("drops unused entries after a successful build only", async () => {
    const first = fakePlugin()
    const one = build(first.plugin)
    await run(first.plugin, "a", "/src/A.tsx")
    await run(first.plugin, "b", "/src/B.tsx")
    one.end()
    expect(readdirSync(dir)).toHaveLength(2)
    const failed = fakePlugin()
    const two = build(failed.plugin)
    await run(failed.plugin, "a", "/src/A.tsx")
    two.end(new Error("build failed"))
    expect(readdirSync(dir)).toHaveLength(2)
    const next = fakePlugin()
    const three = build(next.plugin)
    await run(next.plugin, "a", "/src/A.tsx")
    three.end()
    expect(readdirSync(dir)).toHaveLength(1)
    expect(next.calls).toEqual([])
  })

  it("compiles when the cache can't be written", async () => {
    chmodSync(dir, 0o500)
    const first = fakePlugin()
    expect(await run(first.plugin, "a", "/src/A.tsx")).toEqual({ code: "compiled(a)", map: { mappings: "AAAA" } })
    const second = fakePlugin()
    expect(await run(second.plugin, "a", "/src/A.tsx")).toEqual({ code: "compiled(a)", map: { mappings: "AAAA" } })
    expect(second.calls).toEqual(["/src/A.tsx"])
  })

  it("is off with RP_BABEL_CACHE=off", async () => {
    process.env.RP_BABEL_CACHE = "off"
    const first = fakePlugin()
    await run(first.plugin, "a", "/src/A.tsx")
    const second = fakePlugin()
    await run(second.plugin, "a", "/src/A.tsx")
    expect(second.calls).toEqual(["/src/A.tsx"])
    expect(readdirSync(dir)).toEqual([])
  })
})
