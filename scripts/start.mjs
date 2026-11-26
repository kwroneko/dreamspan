import { once } from "node:events"
import { existsSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { runChild, runNpm, setExitStatus } from "./child-process.mjs"

const RESTART_EXIT_CODE = 75
const cwd = fileURLToPath(new URL("../", import.meta.url))
const installed = () => existsSync(join(cwd, "node_modules"))
const built = () =>
  existsSync(join(cwd, "packages/client/dist/index.html")) &&
  existsSync(join(cwd, "packages/server/dist/workers/stamp.json"))

async function checkRuntime() {
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (major < 24 || (major === 24 && minor < 11)) {
    throw new Error(
      `Dreamspan needs Node.js 24.11 or later (found ${process.version}). Install it from https://nodejs.org/.`
    )
  }
  try {
    const probe = new Worker(
      `const { DatabaseSync } = require("node:sqlite")
       const db = new DatabaseSync(":memory:")
       try {
         db.exec("CREATE VIRTUAL TABLE probe USING fts5(text)")
       } finally {
         db.close()
       }`,
      { eval: true, stderr: true }
    )
    const [code] = await once(probe, "exit")
    if (code !== 0) throw new Error(`SQLite probe exited with code ${code}`)
  } catch (error) {
    throw new Error(
      `Dreamspan needs Node.js with SQLite FTS5 enabled. Install the official Node.js build from https://nodejs.org/.\n${error.message}`
    )
  }
}

async function start() {
  await checkRuntime()
  if (!installed()) {
    console.log("Installing Dreamspan dependencies...")
    const result = await runNpm(["ci", "--include=dev"], { cwd })
    if (result.code !== 0 || result.interrupted) return result
  }
  if (!built()) {
    console.log("Building Dreamspan...")
    const result = await runChild(process.execPath, ["scripts/build.mjs"], { cwd })
    if (result.code !== 0 || result.interrupted) return result
  }
  const env = { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "production", DREAMSPAN_SUPERVISED: "1" }
  while (true) {
    const result = await runChild(process.execPath, ["packages/server/src/main.ts", ...process.argv.slice(2)], {
      cwd,
      env
    })
    if (result.code !== RESTART_EXIT_CODE || result.interrupted) return result
    console.log("Restarting Dreamspan...")
  }
}

try {
  setExitStatus(await start())
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
