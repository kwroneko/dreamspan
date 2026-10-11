// Bundles the database worker entry points into single tree-shaken files, and stamps
// them with the sources they came from. Why bundles: ARCHITECTURE.md §3.6.
import { fileURLToPath } from "node:url"
import { build } from "rolldown"
import { writeStamp } from "../src/db/workerStamp.ts"

const WORKERS = ["writer", "reader"] as const

export const buildWorkers = async (outDir = fileURLToPath(new URL("../dist/workers", import.meta.url))) => {
  const moduleIds: Array<string> = []
  for (const name of WORKERS) {
    const { output } = await build({
      input: fileURLToPath(new URL(`../src/db/${name}.ts`, import.meta.url)),
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
  console.log(`built ${WORKERS.join(", ")} workers into ${outDir}`)
}
