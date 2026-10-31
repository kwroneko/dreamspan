// The performance harness's server: the real one, built, with bundled database workers and
// the fake generator, on a random loopback port and a data directory prepared beforehand.
// No account has a password, so loopback is the local admin: the harness's RPCs need no login.
import { type ChildProcess, spawn } from "node:child_process"
import { resolve } from "node:path"
import { AppApi, type AppRpcs } from "@rp/shared/api.ts"
import { Effect, Exit, Layer } from "effect"
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"

const root = resolve(import.meta.dirname, "../../..")

export interface PerfServer {
  readonly url: string
  readonly pid: number
  readonly stop: () => Promise<void>
}

const exited = (child: ChildProcess) =>
  new Promise<void>((done) =>
    child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", () => done())
  )

export const startServer = async (dataDir: string, env: Record<string, string> = {}): Promise<PerfServer> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 12_000)
    const child = spawn(process.execPath, ["packages/server/src/dev/main.ts"], {
      cwd: root,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        DATA_DIR: dataDir,
        DB_READERS: "2",
        DB_WORKERS: "bundle",
        CLIENT_DIST: resolve(root, "packages/client/dist"),
        FAKE_GENERATOR_TPS: "300",
        // Twenty seconds a stream: every streaming scenario ends while they still run.
        FAKE_GENERATOR_TOKENS: "6000",
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    child.stdout!.on("data", (chunk) => (output += chunk))
    child.stderr!.on("data", (chunk) => (output += chunk))
    const kill = () => child.kill("SIGKILL")
    process.once("exit", kill)
    const stop = async () => {
      process.off("exit", kill)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      await exited(child)
    }
    const url = `http://127.0.0.1:${port}`
    for (let i = 0; i < 300 && child.exitCode === null; i++) {
      const healthy = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) }).then(
        (response) => response.ok,
        () => false
      )
      if (healthy) return { url, pid: child.pid!, stop }
      await new Promise((done) => setTimeout(done, 100))
    }
    await stop()
    if (!output.includes("EADDRINUSE")) throw new Error(`the server didn't start:\n${output}`)
  }
  throw new Error("no free port after 5 attempts")
}

type Client = RpcClient.RpcClient<AppRpcs, RpcClientError.RpcClientError>

/** Runs `use` with an RPC client acting as the local user, as another tab would. */
export const withClient = async <A>(server: PerfServer, use: (client: Client) => Effect.Effect<A, unknown>) => {
  const program = Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`${server.url.replace(/^http/, "ws")}/rpc`)),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
        Layer.provide(RpcSerialization.layerJson)
      )
    )
    return yield* use(yield* RpcClient.make(AppApi).pipe(Effect.provide(protocol)))
  })
  const exit = await Effect.runPromiseExit(Effect.scoped(program))
  if (Exit.isFailure(exit)) throw new Error(`RPC failed: ${String(exit.cause)}`)
  return exit.value
}
