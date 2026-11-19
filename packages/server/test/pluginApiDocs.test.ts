import { expect, it } from "vitest"
import ts from "typescript"
import { fileURLToPath } from "node:url"
import { pluginDocumentation } from "../../plugin-api/src/docs.ts"
import { saveFiles } from "../src/plugins/repo.ts"
import { checkPlugin } from "../src/plugins/check.ts"
import { tempDir } from "./support/tempDir.ts"
// Each published recipe is type-checked/bundled against the installed API, including restricted probes.
for (const doc of pluginDocumentation)
  it(`checks the published ${doc.topic} recipe`, { timeout: 30000, tags: ["slow"] }, async () => {
    const dir = tempDir("plugin-docs"),
      side = doc.side === "common" ? "server" : doc.side
    const entry = side === "client" ? "client.tsx" : side + ".ts"
    const files = {
      "rp-plugin.json": JSON.stringify({
        id: "example",
        name: "Example",
        api: 1,
        server: side === "server" ? entry : null,
        worker: side === "worker" ? entry : null,
        client: side === "client" ? entry : null,
        surfaces: "surfaces" in doc ? doc.surfaces : [side + ":" + doc.topic],
        overrides: [],
        replaces: "replaces" in doc ? doc.replaces : [],
        base: null,
        network: false
      }),
      [entry]: doc.example
    }
    const commit = await saveFiles(dir, "", "example", files, true, "Docs recipe")
    expect(await checkPlugin(dir, "", "example", commit)).toMatchObject({ ok: true, step: "ready" })
  })

it("browser declarations do not pull Effect, app renderers or server/schema implementations into every check", () => {
  const client = fileURLToPath(new URL("../../plugin-api/src/client.ts", import.meta.url))
  const program = ts.createProgram([client], {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.ReactJSX,
    types: ["node"]
  })
  const implementations = program
    .getSourceFiles()
    .map((file) => file.fileName.replaceAll("\\", "/"))
    .filter((file) => /packages\/(?:client|server|shared)\/src\/|node_modules\/effect\//.test(file))
  expect(implementations).toEqual([])
})

// A display rule can never come with server code or page controls: that is what keeps it out
// of everything a model is sent and out of the page's own realm (review-adapters2).
for (const [name, change] of [
  ["page controls", { surfaces: ["client:displayTransforms", "client:composerControls"] }],
  ["server code", { surfaces: ["client:displayTransforms", "server:rolloutTools"], server: "server.ts" }],
  ["assembly code", { surfaces: ["client:timelineTransforms", "worker:macros"], worker: "worker.ts" }]
] as const)
  it(`refuses a display plugin that also carries ${name}`, async () => {
    const dir = tempDir("plugin-display-mixed")
    const files = {
      "rp-plugin.json": JSON.stringify({
        id: "example",
        name: "Example",
        api: 1,
        server: null,
        worker: null,
        client: "client.tsx",
        overrides: [],
        replaces: [],
        base: null,
        network: false,
        ...change
      }),
      "client.tsx": `import type {Activate} from "@dreamspan/plugin-api/client"\nexport const activate:Activate=()=>{}`,
      "server.ts": `export const activate=()=>{}`,
      "worker.ts": `export const activate=()=>{}`
    }
    const commit = await saveFiles(dir, "", "example", files, true, "Mixed display plugin")
    const report = await checkPlugin(dir, "", "example", commit)
    expect(report.ok).toBe(false)
    expect(report.message).toBe("Display rules run only in the browser and need a separate plugin from page controls.")
  }, 30000)
