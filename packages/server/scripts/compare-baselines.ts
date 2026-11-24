// Compare two JSON arrays of DDL statements, on fresh databases, in a worker.
import { deepStrictEqual } from "node:assert/strict"
import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { isMainThread, Worker, workerData } from "node:worker_threads"

const normalizeSql = (sql: string) => {
  // ALTER TABLE can quote the table name in its declaration and in foreign keys.
  // Elsewhere double quotes can enclose a string, so keep all quoted tokens intact.
  const declaration = sql.replace(/^(CREATE TABLE )"([a-z_][a-z0-9_]*)"(?!")/i, "$1$2")
  const tokens =
    /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|[ \t\r\n\f]*[(),][ \t\r\n\f]*|[ \t\r\n\f]+|[\w$\u0080-\uFFFF]+|./g
  let tableReference = false
  return declaration
    .replace(tokens, (token) => {
      if (/^[ \t\r\n\f]+$/.test(token)) return " "
      const normalized = tableReference ? token.replace(/^"([a-z_][a-z0-9_]*)"$/i, "$1") : token
      tableReference = token.toUpperCase() === "REFERENCES"
      return /^[ \t\r\n\f]*[(),][ \t\r\n\f]*$/.test(token) ? token.trim() : normalized
    })
    .replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g, "")
}

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
          sql: normalizeSql(String(row.sql))
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
