import { spawn } from "node:child_process"
import { chmodSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { assert, it } from "@effect/vitest"
import { tempDir } from "./support/tempDir.ts"

for (const secretKey of [undefined, "synthetic-server-secret"]) {
  for (const kind of ["missing", "file", "unwritable"] as const) {
    it(`refuses ${kind} DATA_DIR promptly (${secretKey ? "configured" : "generated"} secret)`, async () => {
      const fixture = tempDir("startup")
      const dataDir = kind === "missing" ? "/proc/nope" : join(fixture, kind)
      if (kind === "file") writeFileSync(dataDir, "synthetic fixture")
      if (kind === "unwritable") chmodSync(fixture, 0o500)
      const directory = kind === "unwritable" ? fixture : dataDir
      const child = spawn(process.execPath, ["--no-wasm-code-gc", "src/main.ts"], {
        cwd: resolve(import.meta.dirname, ".."),
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: "0",
          DATA_DIR: directory,
          DB_WORKERS: "source",
          SECRET_KEY: secretKey,
          SECRET_KEY_FILE: undefined
        },
        stdio: ["ignore", "pipe", "pipe"]
      })
      let output = ""
      child.stdout.on("data", (chunk) => (output += chunk))
      child.stderr.on("data", (chunk) => (output += chunk))
      const exited = new Promise<{ code: number | null; signal: string | null }>((done, fail) => {
        child.once("exit", (code, signal) => done({ code, signal }))
        child.once("error", fail)
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race([
          exited,
          new Promise<"timeout">((done) => (timer = setTimeout(() => done("timeout"), 5000)))
        ])
        assert.notStrictEqual(outcome, "timeout", `startup hung for 5 seconds:\n${output}`)
        assert.isObject(outcome)
        if (outcome === "timeout") return
        assert.isNull(outcome.signal)
        assert.isNumber(outcome.code)
        assert.notStrictEqual(outcome.code, 0)
        assert.include(output, `Cannot use DATA_DIR ${directory}:`)
        assert.match(output, kind === "missing" ? /ENOENT/ : kind === "file" ? /not a directory/ : /EACCES/)
        assert.notInclude(output, "Listening on")
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await exited
        chmodSync(fixture, 0o700)
      }
    })
  }
}
