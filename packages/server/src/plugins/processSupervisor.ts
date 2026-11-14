// A separate event loop owns the checked PID, even when the server/compiler is SIGKILLed.
import { readFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"
const [target, encoded] = process.argv.slice(2) as [string, string]
const { args, options } = JSON.parse(encoded) as {
  args: string[]
  options: { timeout?: number; memory?: number; permissions?: string[]; networkFilter?: string }
}
const finish = (result: { ok: boolean; output: string }) => {
  if (process.connected) process.send?.({ result }, () => process.disconnect())
}
const child = spawn(
  options.networkFilter ? "/usr/bin/setpriv" : process.execPath,
  [
    ...(options.networkFilter ? ["--no-new-privs", "--seccomp-filter", options.networkFilter, process.execPath] : []),
    `--max-old-space-size=${options.memory ?? 768}`,
    "--disable-warning=ExperimentalWarning",
    ...(options.permissions ?? []),
    fileURLToPath(target),
    ...args
  ],
  {
    env: { LANG: "C", NODE_ENV: "production" },
    cwd: dirname(fileURLToPath(target)),
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  }
)
if (child.pid) process.send?.({ pluginChild: child.pid })
let output = "",
  killed = false
const stop = () => {
  killed = true
  child.kill("SIGKILL")
}
process.once("disconnect", stop)
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
  finish({ ok: false, output: "Child could not start" })
})
child.once("close", (code) => {
  if (child.pid) process.send?.({ pluginChildDone: child.pid })
  clearTimeout(timer)
  clearInterval(rss)
  finish({ ok: code === 0 && !killed, output: output.slice(0, 16_384) })
})
