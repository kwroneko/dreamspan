import { spawn } from "node:child_process"
import { once } from "node:events"
import { constants } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"

export async function runChild(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: "inherit" })
  let interrupted = false
  const forward = (signal) => {
    if (interrupted) return
    interrupted = true
    // Windows delivers console Ctrl+C to both processes. Sending SIGINT with
    // child.kill there would terminate the child before its cleanup ran.
    if (process.platform !== "win32" || signal !== "SIGINT") child.kill(signal)
  }
  process.on("SIGINT", forward)
  process.on("SIGTERM", forward)
  try {
    const [code, signal] = await once(child, "close")
    return { code, signal, interrupted }
  } finally {
    process.off("SIGINT", forward)
    process.off("SIGTERM", forward)
  }
}

export function runNpm(args, options) {
  // npm.cmd needs a shell on Windows. Use the JS CLI shipped with Node for
  // direct launches, including when the install directory contains spaces.
  const cli =
    process.env.npm_execpath ||
    (process.platform === "win32" ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : null)
  return cli ? runChild(process.execPath, [cli, ...args], options) : runChild("npm", args, options)
}

export function setExitStatus({ code, signal }) {
  process.exitCode = signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1)
  if (signal && process.platform !== "win32") process.kill(process.pid, signal)
}
