import { spawn } from "node:child_process"
import { cpSync, symlinkSync, chmodSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { assert, expect, it } from "@effect/vitest"
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
          // No card source: a server started from main.ts would otherwise register cardex.
          FAKE_CARD_SOURCE: "off",
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

for (const entry of ["src/main.ts", "src/dev/main.ts"]) {
  it(`scrubs SDK configuration before ${entry} starts and keeps server configuration`, async () => {
    const fixture = tempDir("startup-scrub")
    const probe = join(fixture, "probe.mjs")
    writeFileSync(
      probe,
      `process.once('SIGTERM', () => {
      const keys = ['OPENAI_FUTURE_OPTION','ANTHROPIC_API_KEY','GOOGLE_GENAI_USE_VERTEXAI','http_proxy','NODE_USE_ENV_PROXY'];
      console.log('scrub-result:' + JSON.stringify({removed:keys.every(k=>process.env[k]===undefined),
        server:process.env.SECRET_KEY==='synthetic-server-secret' && process.env.PORT==='0' && process.env.HOST==='127.0.0.1'}));
    });`
    )
    const child = spawn(process.execPath, ["--no-wasm-code-gc", "--import", probe, entry], {
      cwd: resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        // No card source: a server started from main.ts would otherwise register cardex.
        FAKE_CARD_SOURCE: "off",
        HOST: "127.0.0.1",
        PORT: "0",
        DATA_DIR: fixture,
        DB_WORKERS: "source",
        SECRET_KEY: "synthetic-server-secret",
        SECRET_KEY_FILE: undefined,
        NODE_ENV: "test",
        OPENAI_FUTURE_OPTION: "synthetic",
        ANTHROPIC_API_KEY: "synthetic",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        http_proxy: "http://127.0.0.1:9",
        NODE_USE_ENV_PROXY: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = "",
      stopping = false
    child.stdout.on("data", (chunk) => {
      output += chunk
      if (output.includes("Listening on") && !stopping) {
        stopping = true
        child.kill("SIGTERM")
      }
    })
    child.stderr.on("data", (chunk) => (output += chunk))
    const exited = new Promise<number | null>((done, fail) => {
      child.once("exit", done)
      child.once("error", fail)
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000)
    try {
      assert.equal(await exited, 0, output)
      assert.include(output, 'scrub-result:{"removed":true,"server":true}')
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exited
    }
  })
}

for (const setting of ["FAKE_CARD_SOURCE", "FAKE_SAVED_MEDIA"] as const) {
  it(`refuses ${setting} plainly when development files are absent`, async () => {
    const fixture = tempDir("production-imports")
    const root = resolve(import.meta.dirname, "../../..")
    // Keep the shipped workspace layout: built-in editable tools import the sibling
    // plugin API. Omitting that runtime dependency fails before either guarded loader.
    const server = join(fixture, "packages/server")
    cpSync(join(root, "packages/server/src"), join(server, "src"), {
      recursive: true,
      filter: (source) => source !== join(root, "packages/server/src/dev")
    })
    cpSync(join(root, "packages/plugin-api/src"), join(fixture, "packages/plugin-api/src"), {
      recursive: true
    })
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }))
    symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"))
    const child = spawn(process.execPath, ["--no-wasm-code-gc", "src/main.ts"], {
      cwd: server,
      env: {
        ...process.env,
        FAKE_CARD_SOURCE: "off",
        FAKE_SAVED_MEDIA: "off",
        [setting]: setting === "FAKE_CARD_SOURCE" ? "synthetic-secret-/private/fixture" : "on",
        DATA_DIR: join(fixture, "data"),
        PORT: "0",
        HOST: "127.0.0.1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    child.stdout.on("data", (chunk) => (output += chunk))
    child.stderr.on("data", (chunk) => (output += chunk))
    const exited = new Promise<number | null>((done, fail) => {
      child.once("exit", done)
      child.once("error", fail)
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
    try {
      expect(await exited).not.toBe(0)
      expect(output).toContain(`${setting}=`)
      expect(output).toContain("needs the development files")
      expect(output).not.toContain("ERR_MODULE_NOT_FOUND")
      expect(output).not.toMatch(/file:\/\/|^\s*at\s/m)
      expect(output).not.toContain("synthetic-secret-/private/fixture")
      expect(output).not.toContain(join(server, "src/dev"))
      expect(output).not.toContain("Listening on")
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exited
    }
  })
}
