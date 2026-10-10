// Bundles the database worker entry points into single tree-shaken files.
// Each worker thread is its own V8 isolate, and loading Effect's module graph from
// source costs ~85 MB per worker; a bundle costs ~22 MB (ARCHITECTURE.md §3.7).
import { fileURLToPath } from "node:url"
import { build } from "rolldown"

export const WORKERS = ["writer", "reader"] as const

export const buildWorkers = async (outDir = fileURLToPath(new URL("../dist/workers", import.meta.url))) => {
  for (const name of WORKERS) {
    await build({
      input: fileURLToPath(new URL(`../src/db/${name}.ts`, import.meta.url)),
      platform: "node",
      output: { file: `${outDir}/${name}.mjs`, format: "esm", minify: true, sourcemap: true },
      logLevel: "warn"
    })
  }
  return outDir
}

if (import.meta.main) {
  const outDir = await buildWorkers()
  console.log(`built ${WORKERS.join(", ")} workers into ${outDir}`)
}
