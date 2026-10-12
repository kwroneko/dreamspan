// A real server for browser tests: `node packages/server/src/main.ts` with a fresh data
// directory and a random loopback port, serving the client build. Stopped by PID. A file
// that asks for the fake generator gets the development entry point, which has it.
import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type APIRequestContext, test } from "@playwright/test"

const root = resolve(import.meta.dirname, "../../../..")

export interface TestServer {
  readonly url: string
  readonly port: number
  readonly stop: () => Promise<void>
}

// Below Linux's ephemeral range (32768+), random per worker, sequential within it.
let port = 20_000 + Math.floor(Math.random() * 12_000)
const nextPort = () => (port = port >= 32_000 ? 20_000 : port + 1)

const waitForExit = (child: ChildProcess) =>
  new Promise<void>((done) =>
    child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", () => done())
  )

const startOnce = async (env: Record<string, string>): Promise<TestServer | null> => {
  const dataDir = mkdtempSync(join(tmpdir(), "rp-browser-"))
  const serverPort = nextPort()
  const entry = env.FAKE_GENERATOR_TPS === undefined ? "packages/server/src/main.ts" : "packages/server/src/dev/main.ts"
  const child = spawn(process.execPath, ["--no-wasm-code-gc", entry], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(serverPort),
      DATA_DIR: dataDir,
      DB_READERS: "1",
      DB_WORKERS: "source",
      CLIENT_DIST: join(root, "packages/client/dist"),
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  // A worker torn down after a timeout skips afterAll: the server mustn't outlive it.
  const orphaned = () => {
    child.kill("SIGKILL")
    rmSync(dataDir, { recursive: true, force: true })
  }
  process.once("exit", orphaned)
  child.once("exit", () => process.off("exit", orphaned))
  let output = ""
  child.stdout!.on("data", (chunk) => (output += chunk))
  child.stderr!.on("data", (chunk) => (output += chunk))
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      // No SIGKILL fallback: a server that doesn't stop with a page open is a bug to see.
      child.kill("SIGTERM")
      await waitForExit(child)
    }
    rmSync(dataDir, { recursive: true, force: true })
  }
  const url = `http://127.0.0.1:${serverPort}`
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) {
      await stop()
      // Someone else holds the port: try the next one. Anything else is a real failure.
      if (output.includes("EADDRINUSE")) return null
      throw new Error(`the server exited:\n${output}`)
    }
    // Bounded, in case something else holds the port and never answers.
    const healthy = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) }).then(
      (response) => response.ok,
      () => false
    )
    if (healthy) return { url, port: serverPort, stop }
    await new Promise((done) => setTimeout(done, 100))
  }
  await stop()
  throw new Error(`the server didn't become healthy:\n${output}`)
}

const startServer = async (env: Record<string, string> = {}): Promise<TestServer> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const server = await startOnce(env)
    if (server) return server
  }
  throw new Error("no free port after 5 attempts")
}

/** A server for every test in the file, started once and stopped after the last test. */
export const serverPerFile = (env: Record<string, string> = {}) => {
  let server: TestServer | undefined
  test.beforeAll(async () => {
    server = await startServer(env)
  })
  test.afterAll(async () => {
    await server?.stop()
  })
  return () => {
    if (!server) throw new Error("the server isn't running")
    return server
  }
}

export const ADMIN = { handle: "admin", password: "admin-password-1" }

/** The environment for a server whose admin already has a password, so login is required. */
export const withAdmin = { ADMIN_USER: ADMIN.handle, ADMIN_PASSWORD: ADMIN.password }

/** Logs a browser context in through the HTTP endpoint, as the login form would. */
export const apiLogin = async (request: APIRequestContext, server: TestServer, handle: string, password: string) => {
  const response = await request.post(`${server.url}/auth/login`, {
    data: { handle, password },
    headers: { origin: server.url }
  })
  if (response.status() !== 204) throw new Error(`login as ${handle} failed: ${response.status()}`)
}
