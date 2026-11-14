import { expect, it } from "vitest"
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
