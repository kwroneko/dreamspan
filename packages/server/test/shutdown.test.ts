// Stopping the server with a tab open: the WebSocket is told the server is going away,
// and the process exits on its own, with the database workers closed cleanly.
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { assert, describe, it } from "@effect/vitest"

const serverDir = resolve(import.meta.dirname, "..")

describe("shutdown", () => {
  it("SIGTERM with an open WebSocket exits within seconds and leaves no WAL behind", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rp-shutdown-"))
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
    try {
      for (let attempt = 0; attempt < 300; attempt++) {
        const healthy = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }).then(
          (response) => response.ok,
          () => false
        )
        if (healthy) break
        await new Promise((done) => setTimeout(done, 100))
      }
      const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`)
      await new Promise((done, fail) => {
        socket.onopen = done
        socket.onerror = fail
      })
      const closed = new Promise<number>((done) => (socket.onclose = (event) => done(event.code)))

      const started = Date.now()
      child.kill("SIGTERM")
      const timeout = new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 8000))
      const outcome = await Promise.race([exited, timeout])
      assert.notStrictEqual(outcome, "timeout", "the server was still running 8 s after SIGTERM")
      assert.isBelow(Date.now() - started, 5000)
      assert.deepStrictEqual(outcome, { code: 130, signal: null })
      assert.strictEqual(await closed, 1001)
      // A clean close of the database checkpoints and removes the WAL.
      assert.isFalse(existsSync(join(dataDir, "rp-harness.db-wal")))
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exited
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
