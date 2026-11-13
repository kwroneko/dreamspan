import { readFile } from "node:fs/promises"
import { Predicate } from "effect"
// Child identity comes only from spawn(). No process discovery or pattern-based killing.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
export interface ChildResult {
  readonly ok: boolean
  readonly output: string
}
export const runPluginChild = (
  file: URL,
  args: ReadonlyArray<string>,
  options: {
    readonly timeout?: number
    readonly memory?: number
    readonly permissions?: ReadonlyArray<string>
    readonly trackChildren?: boolean
  } = {}
): Promise<ChildResult> =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${options.memory ?? 768}`,
        "--disable-warning=ExperimentalWarning",
        ...(options.permissions ?? []),
        fileURLToPath(file),
        ...args
      ],
      { env: { LANG: "C", NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe", "ipc"] }
    )
    const descendants = new Set<number>()
    if (child.pid) process.send?.({ pluginChild: child.pid })
    if (options.trackChildren)
      child.on("message", (message: unknown) => {
        if (Predicate.isObject(message) && typeof message.pluginChildDone === "number")
          descendants.delete(message.pluginChildDone)
        if (
          Predicate.isObject(message) &&
          typeof message.pluginChild === "number" &&
          Number.isSafeInteger(message.pluginChild) &&
          message.pluginChild > 1
        )
          descendants.add(message.pluginChild)
      })
    const killDescendants = () => {
      for (const pid of descendants) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          /* Already exited. */
        }
      }
    }
    let output = "",
      killed = false
    const stop = () => {
      killed = true
      killDescendants()
      child.kill("SIGKILL")
    }
    const timer = setTimeout(stop, options.timeout ?? 60_000)
    // V8's heap cap excludes buffers/native allocations. On Linux, also bound sampled RSS.
    let reading = false
    const rss = setInterval(() => {
      if (reading || !child.pid || process.platform !== "linux") return
      reading = true
      void readFile(`/proc/${child.pid}/status`, "utf8")
        .then((status) => {
          const kb = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0)
          if (kb > ((options.memory ?? 768) + 128) * 1024) stop()
        })
        .catch(() => undefined)
        .finally(() => {
          reading = false
        })
    }, 50)
    const collect = (data: Buffer) => {
      output += data.toString()
      if (output.length > 16_384) stop()
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    child.once("error", () => {
      clearTimeout(timer)
      clearInterval(rss)
      resolve({ ok: false, output: "Child could not start" })
    })
    child.once("close", (code) => {
      if (child.pid) process.send?.({ pluginChildDone: child.pid })
      if (killed) killDescendants()
      clearTimeout(timer)
      clearInterval(rss)
      resolve({ ok: code === 0 && !killed, output: output.slice(0, 16_384) })
    })
  })
