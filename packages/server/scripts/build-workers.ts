// Bundles the worker entry points (the database's and the format workers') into single
// tree-shaken files, and stamps them with the sources they came from. Why bundles:
// ARCHITECTURE.md §3.6.
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
      output: { file: `${outDir}/${name}.mjs`, format: "esm", minify: true, sourcemap: true },
      logLevel: "warn"
    })
    moduleIds.push(...output[0].moduleIds)
  }
  writeStamp(outDir, moduleIds)
  return outDir
}

if (import.meta.main) {
  const outDir = await buildWorkers()
  console.log(`built ${Object.keys(WORKERS).join(", ")} workers into ${outDir}`)
}
