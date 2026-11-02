// Bundles the worker entry points (the database's and the format workers') into single
// tree-shaken files, and stamps them with the sources they came from. Why bundles:
// ARCHITECTURE.md §3.6.
import { cpSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "rolldown"
import { writeStamp } from "../src/db/workerStamp.ts"

const WORKERS = { writer: "db/writer.ts", reader: "db/reader.ts", formats: "importer/worker.ts" } as const

export const buildWorkers = async (outDir = fileURLToPath(new URL("../dist/workers", import.meta.url))) => {
  const moduleIds: Array<string> = []
  for (const [name, source] of Object.entries(WORKERS)) {
    const { output } = await build({
      input: fileURLToPath(new URL(`../src/${source}`, import.meta.url)),
      platform: "node",
      // Native binaries and libvips remain in production node_modules, resolved by sharp. The
      // tokenizer's ranks (several MB each) load from node_modules on a worker's first count.
      external: ["sharp", "llama3-tokenizer-js", /^tiktoken(\/|$)/],
      output: { file: `${outDir}/${name}.mjs`, format: "esm", minify: true, sourcemap: true },
      logLevel: "warn"
    })
    moduleIds.push(...output[0].moduleIds)
  }
  const data = new URL("../src/importer/tokenizers/", import.meta.url)
  cpSync(data, `${outDir}/tokenizers`, { recursive: true })
  moduleIds.push(...readdirSync(data).map((name) => fileURLToPath(new URL(name, data))))
  writeStamp(outDir, moduleIds)
  return outDir
}

if (import.meta.main) {
  const outDir = await buildWorkers()
  console.log(`built ${Object.keys(WORKERS).join(", ")} workers into ${outDir}`)
}
