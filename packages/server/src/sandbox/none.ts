// The `none` sandbox (spec/FILES-AND-ENVIRONMENT.md §3.7): commands run directly as the app's
// user, with the timeout, output limits and process-group kill only. Registered like the others,
// so it's visible and replaceable, but flagged `unsandboxed`: selectSandbox never picks it, and
// the file tools use it only for an admin, with ALLOW_UNSANDBOXED_COMMANDS, in a workshop whose
// owner turned the sandbox off after the consent. The sandbox's paths (/files, /home/user, the
// app's source) are turned into the host's own for the working directory and back for the
// result; the command itself sees the host's file system.
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import type { CommandSandbox, RunResult, RunSpec } from "./registry.ts"

const KEEP_HEAD = 1 << 20
const KEEP_TAIL = 1 << 20
const OUTPUT_MAX_BYTES = 256 * 2 ** 20

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`)
/** A path under one of the mounts, as the host has it, and back. */
const translate = (path: string, pairs: ReadonlyArray<readonly [string, string]>) => {
  // The deepest first, so /files/Shared/x wins over /files.
  for (const [from, to] of [...pairs].sort((a, b) => b[0].length - a[0].length))
    if (within(path, from)) return to + path.slice(from.length)
  return path
}
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

const hostPathOf = (spec: Pick<RunSpec, "mounts">, path: string) =>
  translate(
    path,
    spec.mounts.filter((m) => m.source !== "" && !m.empty).map((m) => [m.target, m.source] as const)
  )

const run = async (spec: RunSpec, signal: AbortSignal): Promise<RunResult> => {
  const started = Date.now()
  const marker = `__rp_cwd_${randomBytes(12).toString("hex")}__`
  const toSandbox = spec.mounts.filter((m) => m.source !== "" && !m.empty).map((m) => [m.source, m.target] as const)
  const home = hostPathOf(spec, spec.env.HOME ?? "/")
  const env: Record<string, string> = {
    ...spec.env,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    npm_config_prefix: `${home}/.local`,
    RP_END: marker
  }
  const script = [
    "exec 2>&1 </dev/null",
    `trap "printf '\\n%s %s\\n' $RP_END \\"\\$PWD\\"" EXIT`,
    "unset RP_END",
    `cd -- ${shellQuote(hostPathOf(spec, spec.cwd))} || exit 1`,
    'eval "$1"'
  ].join("\n")
  const child = spawn("/bin/bash", ["-c", script, "dreamspan-command", spec.command], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env
  })
  const headChunks: Array<Buffer> = []
  let headBytes = 0
  const tailChunks: Array<Buffer> = []
  let tailBytes = 0
  let total = 0
  let outputCapped = false
  let timedOut = false
  const kill = () => {
    if (child.pid === undefined || child.exitCode !== null) return
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }
  const take = (chunk: Buffer) => {
    if (outputCapped) return
    spec.onOutput?.(chunk)
    total += chunk.length
    if (headBytes < KEEP_HEAD) {
      const part = chunk.subarray(0, KEEP_HEAD - headBytes)
      headChunks.push(part)
      headBytes += part.length
      chunk = chunk.subarray(part.length)
    }
    if (chunk.length) {
      tailChunks.push(chunk)
      tailBytes += chunk.length
      while (tailChunks.length > 1 && tailBytes - tailChunks[0]!.length >= KEEP_TAIL)
        tailBytes -= tailChunks.shift()!.length
    }
    if (total > OUTPUT_MAX_BYTES) {
      outputCapped = true
      kill()
    }
  }
  child.stdout!.on("data", take)
  child.stderr!.on("data", take)
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, spec.limits.timeoutMs)
  const onAbort = () => kill()
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) kill()
  const exitCode = await new Promise<number | null>((done) => {
    child.once("error", () => done(null))
    child.once("close", (code) => done(code))
  })
  clearTimeout(timer)
  signal.removeEventListener("abort", onAbort)
  // What it started in the background goes with it.
  if (child.pid !== undefined)
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      // The group is gone already.
    }
  const head = Buffer.concat(headChunks)
  const joined = Buffer.concat(tailChunks)
  const tail = joined.subarray(Math.max(0, joined.length - KEEP_TAIL))
  let text = tail.length ? tail.toString("utf8") : head.toString("utf8")
  let cwd: string | null = null
  const at = text.lastIndexOf(`\n${marker} `)
  if (at >= 0) {
    const end = text.indexOf("\n", at + 1 + marker.length)
    const hostCwd = text.slice(at + 2 + marker.length, end < 0 ? undefined : end)
    total -= Buffer.byteLength(`\n${marker} ${hostCwd}\n`)
    cwd = translate(hostCwd, toSandbox)
    text = text.slice(0, at) + (end < 0 ? "" : text.slice(end + 1))
  }
  const fromHead = tail.length === 0
  return {
    exitCode: timedOut || outputCapped || signal.aborted ? null : exitCode,
    timedOut,
    outputCapped,
    head: fromHead ? text : head.toString("utf8"),
    tail: fromHead ? "" : text,
    outputBytes: Math.max(0, total),
    cwd,
    durationMs: Date.now() - started
  }
}

export const noSandbox: CommandSandbox = {
  id: "none",
  label: "No sandbox",
  explanation: "Commands run directly on the server as the app, with timeouts and output limits only.",
  platforms: ["linux", "darwin"],
  unsandboxed: true,
  available: async () => ({ ok: true }),
  run
}
