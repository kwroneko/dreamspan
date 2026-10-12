// Stopping the server (SIGTERM, docker stop) with clients connected: replies in flight go
// out first, WebSockets are told the server is going away, the database workers close
// cleanly, and the process exits 0 on its own.
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { assert, describe, it } from "@effect/vitest"
import { AppApi } from "@rp/shared/api.ts"
import { Effect, Layer } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { tempDir } from "./support/tempDir.ts"

const serverDir = resolve(import.meta.dirname, "..")

interface Running {
  readonly child: ChildProcess
  readonly port: number
  readonly dataDir: string
  readonly exited: Promise<{ code: number | null; signal: string | null }>
}

const start = async (): Promise<Running> => {
  const dataDir = tempDir("shutdown")
  const port = 20_000 + Math.floor(Math.random() * 12_000)
  const child = spawn(process.execPath, ["--no-wasm-code-gc", "src/main.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      DB_READERS: "1",
      DB_WORKERS: "source"
    },
    stdio: "ignore"
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
    child.once("exit", (code, signal) => done({ code, signal }))
  )
  for (let attempt = 0; attempt < 300; attempt++) {
    const healthy = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }).then(
      (response) => response.ok,
      () => false
    )
    if (healthy) break
    await new Promise((done) => setTimeout(done, 100))
  }
  return { child, port, dataDir, exited }
}

/** SIGTERM, then the exit, or "timeout" if the process is still running after 8 s. */
const stop = async (running: Running) => {
  running.child.kill("SIGTERM")
  const started = Date.now()
  const timeout = new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 8000))
  const outcome = await Promise.race([running.exited, timeout])
  return { outcome, ms: Date.now() - started }
}

const cleanUp = async (running: Running) => {
  if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL")
  await running.exited
  rmSync(running.dataDir, { recursive: true, force: true })
}

describe("shutdown", () => {
  it("SIGTERM with an open WebSocket exits 0 within seconds and leaves no WAL behind", async () => {
    const running = await start()
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${running.port}/rpc`)
      await new Promise((done, fail) => {
        socket.onopen = done
        socket.onerror = fail
      })
      const closed = new Promise<number>((done) => (socket.onclose = (event) => done(event.code)))
      const { outcome, ms } = await stop(running)
      assert.notStrictEqual(outcome, "timeout", "the server was still running 8 s after SIGTERM")
      assert.isBelow(ms, 5000)
      assert.deepStrictEqual(outcome, { code: 0, signal: null })
      assert.strictEqual(await closed, 1001)
      // A clean close of the database checkpoints and removes the WAL.
      assert.isFalse(existsSync(join(running.dataDir, "rp-harness.db-wal")))
    } finally {
      await cleanUp(running)
    }
  })

  it("SIGTERM during a burst of writes: every committed write is acknowledged", async () => {
    const running = await start()
    try {
      let acknowledged = 0
      const burst = Effect.gen(function* () {
        const client = yield* RpcClient.make(AppApi)
        const writes = Array.from({ length: 400 }, (_, i) =>
          client
            .CreateCredential({ name: `k${i}`, apiKey: `sk-burst-key-${i}-xxxxxxxx`, urls: ["http://127.0.0.1:9"] })
            .pipe(Effect.match({ onSuccess: () => acknowledged++, onFailure: () => undefined }))
        )
        yield* Effect.forkDetach(Effect.all(writes, { concurrency: 20 }))
        yield* Effect.sleep("150 millis")
        const { outcome } = yield* Effect.promise(() => stop(running))
        assert.deepStrictEqual(outcome, { code: 0, signal: null })
      }).pipe(
        Effect.provide(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${running.port}/rpc`)),
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
            Layer.provide(RpcSerialization.layerJson)
          )
        ),
        Effect.scoped
      )
      await Effect.runPromise(burst)
      const db = new DatabaseSync(join(running.dataDir, "rp-harness.db"))
      const { n } = db.prepare("SELECT count(*) AS n FROM credentials").get() as { n: number }
      db.close()
      assert.isAbove(acknowledged, 0)
      assert.strictEqual(n, acknowledged, "writes committed but never acknowledged")
    } finally {
      await cleanUp(running)
    }
  })
})
