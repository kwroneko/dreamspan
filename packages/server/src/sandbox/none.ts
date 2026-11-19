// The `none` sandbox (spec/FILES-AND-ENVIRONMENT.md §3.7): commands run directly as the app's
// user, with the timeout and output limits. Each command's processes are held together so a stop,
// the timeout or the app's end reaches every one of them, even those that left its process group
// (`setsid prog &`): in a cgroup or systemd scope of its own (sandbox/cgroupLimits.ts, which also
// caps its memory and processes), else in a PID namespace of its own (`unshare`), whose processes
// the kernel ends with its first. Without either, only the process group is killed, and the file
// tools refuse background commands without a sandbox (`containment`). Registered like the others,
// so it's visible and replaceable, but flagged `unsandboxed`: selectSandbox never picks it, and
// the file tools use it only for an admin, with ALLOW_UNSANDBOXED_COMMANDS, in a workshop whose
// owner turned the sandbox off after the consent. The sandbox's paths (/files, /home/user, the
// app's source) are turned into the host's own for the working directory and back for the
// result; the command itself sees the host's file system.
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"
import { bwrapLimiters, selectLimiter, type CgroupLimiter, type CommandCgroup } from "./cgroupLimits.ts"
import type { CommandSandbox, RunResult, RunSpec } from "./registry.ts"

type Containment =
  | { readonly kind: "cgroup"; readonly limiter: CgroupLimiter }
  | { readonly kind: "pidns"; readonly unshare: string }
  | { readonly kind: "none"; readonly reason: string }

const UNSHARE_ARGS = ["--user", "--map-current-user", "--pid", "--fork", "--kill-child", "--"]
/** The cgroup limiters `none` may use (the bwrap sandbox's, by default). */
type Limiters = { readonly list: () => ReadonlyArray<CgroupLimiter> }

/** How commands are held together here, checked again each minute (like the limiter itself). */
const containmentOf = (limiters: Limiters) => {
  let chosen: { readonly at: number; readonly value: Containment } | null = null
  return async (): Promise<Containment> => {
    if (chosen && Date.now() - chosen.at < 60_000) return chosen.value
    let value: Containment
    const limiter = await selectLimiter(limiters)
    if (!("none" in limiter)) value = { kind: "cgroup", limiter }
    else {
      const unshare = (process.env.PATH ?? "/usr/bin:/bin")
        .split(delimiter)
        .map((dir) => join(dir, "unshare"))
        .find((candidate) => existsSync(candidate))
      const probe = unshare
        ? spawnSync(unshare, [...UNSHARE_ARGS, "/bin/sh", "-c", "exit 0"], { timeout: 10_000 })
        : null
      value =
        unshare && probe?.status === 0
          ? { kind: "pidns", unshare }
          : {
              kind: "none",
              reason: `Commands without a sandbox can't be held together here: no cgroup (${limiter.none}) and no PID namespace (${unshare ? "unshare refused" : "unshare isn't installed"}).`
            }
    }
    chosen = { at: Date.now(), value }
    return value
  }
}

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

const runWith =
  (selectContainment: () => Promise<Containment>) =>
  async (spec: RunSpec, signal: AbortSignal): Promise<RunResult> => {
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
    const containment = await selectContainment()
    let file = "/bin/bash"
    let args = ["-c", script, "dreamspan-command", spec.command]
    let group: CommandCgroup | null = null
    if (containment.kind === "cgroup") {
      group = await containment.limiter
        .open({ memoryBytes: spec.limits.memoryBytes, processes: spec.limits.processes })
        .catch(() => null)
      if (group) {
        ;({ file, args } = group.wrap(file, args))
        Object.assign(env, group.env)
      }
    }
    if (!group && containment.kind === "pidns") {
      args = [...UNSHARE_ARGS, file, ...args]
      file = containment.unshare
    }
    const child = spawn(file, args, {
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
      void group?.kill()
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
    // What it started in the background goes with it: its process group, and its cgroup (a PID
    // namespace's processes went with its first).
    if (child.pid !== undefined)
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        // The group is gone already.
      }
    let memoryCapped = false
    if (group) {
      await group.kill()
      memoryCapped = (await group.finish().catch(() => ({ memoryCapped: false }))).memoryCapped
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
      exitCode: timedOut || outputCapped || signal.aborted || memoryCapped ? null : exitCode,
      timedOut,
      outputCapped,
      ...(memoryCapped ? { memoryCapped } : {}),
      head: fromHead ? text : head.toString("utf8"),
      tail: fromHead ? "" : text,
      outputBytes: Math.max(0, total),
      cwd,
      durationMs: Date.now() - started
    }
  }

/** The `none` sandbox, holding commands together with `limiters`' cgroups, else a PID namespace. */
export const makeNoSandbox = (limiters: Limiters = bwrapLimiters): CommandSandbox => {
  const selectContainment = containmentOf(limiters)
  return {
    id: "none",
    label: "No sandbox",
    explanation:
      "Commands run directly on the server as the app, with timeouts, output limits and (where the server allows) a memory cap.",
    platforms: ["linux", "darwin"],
    unsandboxed: true,
    available: async () => ({ ok: true }),
    containment: async () => {
      const containment = await selectContainment()
      return containment.kind === "none"
        ? { ok: false, reason: containment.reason }
        : { ok: true, how: containment.kind === "cgroup" ? containment.limiter.id : "pid-namespace" }
    },
    run: runWith(selectContainment)
  }
}

export const noSandbox = makeNoSandbox()
