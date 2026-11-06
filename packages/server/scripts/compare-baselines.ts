// Compare two JSON arrays of DDL statements, on fresh databases, in a worker.
// Schemaclean inputs and output: <work>/artifacts/schemaclean/.
import { deepStrictEqual } from "node:assert/strict"
import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { isMainThread, Worker, workerData } from "node:worker_threads"

if (isMainThread) {
  const files = process.argv.slice(2)
  if (files.length !== 2) throw new Error("Usage: node compare-baselines.ts old-statements.json folded-statements.json")
  const worker = new Worker(new URL(import.meta.url), { workerData: files })
  worker.on("error", (error) => {
    console.error(error)
    process.exitCode = 1
  })
  worker.on("exit", (code) => {
    process.exitCode = code
  })
} else {
  const schema = (file: string) => {
    const db = new DatabaseSync(":memory:")
    try {
      for (const statement of JSON.parse(readFileSync(file, "utf8")) as ReadonlyArray<string>) db.exec(statement)
      return db
        .prepare(
          `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> 'effect_sql_migrations'
        ORDER BY type, name`
        )
        .all()
        .map((row) => ({
          ...row,
          // ALTER TABLE quotes its renamed identifier and formats added columns differently.
          sql: String(row.sql)
            .replaceAll('"', "")
            .replace(/\s+/g, " ")
            .replace(/\s*([(),])\s*/g, "$1")
            .trim()
        }))
    } finally {
      db.close()
    }
  }
  const [oldFile, foldedFile] = workerData as [string, string]
  const old = schema(oldFile)
  deepStrictEqual(schema(foldedFile), old)
  console.log(`Equivalent sqlite_master: ${old.length} objects (excluding migration ledger).`)
}
