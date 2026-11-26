import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { tempDir } from "./support/tempDir.ts"

function fixture(server: string, built = true) {
  const root = join(tempDir("launcher"), "Dreamspan checkout")
  mkdirSync(join(root, "scripts"), { recursive: true })
  for (const file of ["start.mjs", "build.mjs", "child-process.mjs"]) {
    copyFileSync(new URL(`../../../scripts/${file}`, import.meta.url), join(root, "scripts", file))
  }
  const main = join(root, "packages/server/src/main.ts")
  mkdirSync(dirname(main), { recursive: true })
  writeFileSync(main, server)
  if (built) {
    mkdirSync(join(root, "node_modules"))
    for (const file of ["packages/client/dist/index.html", "packages/server/dist/workers/stamp.json"]) {
      const destination = join(root, file)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, "")
    }
  }
  return root
}

function run(root: string, script: "start" | "build", overrides?: NodeJS.ProcessEnv) {
  const env = { ...process.env }
  delete env.NODE_ENV
  delete env.NODE_OPTIONS
  return spawnSync(process.execPath, [join(root, "scripts", `${script}.mjs`)], {
    encoding: "utf8",
    env: { ...env, ...overrides },
    timeout: 10_000,
    killSignal: "SIGKILL"
  })
}

const mockNpm = (root: string) => {
  const cli = join(root, "mock npm.cjs")
  writeFileSync(
    cli,
    `const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs")
const { dirname } = require("node:path")
const args = process.argv.slice(2)
appendFileSync("build-log", JSON.stringify([args, process.env.MIMALLOC_ALLOW_THP, process.env.LAUNCHER_TEST]) + "\\n")
if (args[0] === "ci") mkdirSync("node_modules")
else {
  if (process.env.LAUNCHER_TEST === "fail") process.exit(19)
  const output = args[3] === "@dreamspan/client" ? "packages/client/dist/index.html" : "packages/server/dist/workers/stamp.json"
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, "")
}`
  )
  return cli
}

const buildCalls = (root: string) =>
  readFileSync(join(root, "build-log"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line))

describe("source launcher", () => {
  it("restarts on exit 75, keeps supervision and production mode, then exits on 0", () => {
    const root = fixture(`const { existsSync, writeFileSync } = require("node:fs")
console.log(process.env.DREAMSPAN_SUPERVISED, process.env.NODE_ENV)
if (!existsSync("restarted")) {
  writeFileSync("restarted", "")
  process.exit(75)
}`)
    const result = run(root, "start")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(["1 production", "Restarting Dreamspan...", "1 production"])
  })

  it("keeps an explicit NODE_ENV and passes through a failure without restarting", () => {
    const root = fixture("console.log(process.env.NODE_ENV); process.exit(1)")
    const result = run(root, "start", { NODE_ENV: "development" })
    expect(result.status, result.stderr).toBe(1)
    expect(result.stdout.trim()).toBe("development")
  })

  it("installs dependencies and builds both workspaces before launching from a fresh checkout", () => {
    const root = fixture('console.log("Server started")', false)
    const result = run(root, "start", { npm_execpath: mockNpm(root), NODE_ENV: "production", MIMALLOC_ALLOW_THP: "1" })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split(/\r?\n/)).toEqual([
      "Installing Dreamspan dependencies...",
      "Building Dreamspan...",
      "Server started"
    ])
    expect(buildCalls(root)).toEqual([
      [["ci", "--include=dev"], "1", null],
      [["run", "build", "-w", "@dreamspan/client"], "0", null],
      [["run", "build", "-w", "@dreamspan/server"], "0", null]
    ])
  })

  it("reports missing SQLite support before installing anything", () => {
    const root = fixture("", false)
    const result = run(root, "start", { NODE_OPTIONS: "--no-experimental-sqlite", npm_execpath: mockNpm(root) })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Dreamspan needs Node.js with SQLite FTS5 enabled.")
    expect(result.stdout).toBe("")
  })

  it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)(
    "forwards %s and suppresses a restart during shutdown",
    async (signal) => {
      const root = fixture(`process.once(${JSON.stringify(signal)}, () => {
  console.log("Server stopped")
  process.exitCode = 75
  clearInterval(keepAlive)
})
const keepAlive = setInterval(() => {}, 1_000)
console.log("Server ready")`)
      const launcher = spawn(process.execPath, [join(root, "scripts/start.mjs")], {
        stdio: ["ignore", "pipe", "inherit"],
        signal: AbortSignal.timeout(10_000)
      })
      let output = ""
      launcher.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        const ready = output.includes("Server ready")
        output += chunk
        if (!ready && output.includes("Server ready")) launcher.kill(signal)
      })
      expect(await once(launcher, "close")).toEqual([75, null])
      expect(output.trim().split(/\r?\n/)).toEqual(["Server ready", "Server stopped"])
    }
  )
})

describe("workspace build launcher", () => {
  it.each([
    { marker: "keep this", code: 0, workspaces: ["@dreamspan/client", "@dreamspan/server"] },
    { marker: "fail", code: 19, workspaces: ["@dreamspan/client"] }
  ])("passes the build environment and propagates exit status $code", ({ marker, code, workspaces }) => {
    const root = fixture("", false)
    const result = run(root, "build", {
      npm_execpath: mockNpm(root),
      MIMALLOC_ALLOW_THP: "1",
      LAUNCHER_TEST: marker
    })
    expect(result.status, result.stderr).toBe(code)
    expect(buildCalls(root)).toEqual(workspaces.map((workspace) => [["run", "build", "-w", workspace], "0", marker]))
  })
})
