// A real memory cap for each command (part of `linux-bwrap`): a cgroup v2 of its own with
// memory.max, memory.swap.max = 0 and pids.max. A process limit (`ulimit -d`) doesn't count
// shared mappings, memfds or tmpfs pages; a cgroup counts all of them, for every process of the
// command together. Where no cgroup can be made, commands still run, under the per-process
// limits alone, and the "Run commands" row says the limits are weaker here.
//
// Registered and replaceable (`bwrapLimiters`): the first available entry is used.
// - `cgroup-delegated`: a cgroup subtree this process may write, named by COMMAND_CGROUP. The
//   image's entrypoint makes one in Docker (docker/entrypoint.sh, docker/README.md). Each command
//   gets a child folder; a small shell joins it, then becomes bubblewrap.
// - `systemd-scope`: on a host with a systemd user manager (a development server),
//   `systemd-run --user --scope` puts bubblewrap in a transient scope with the same limits. The
//   scope runs bubblewrap in place, so its parent is still this process.
import { execFile, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { access, mkdir, readFile, rmdir, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { makeRegistry } from "@dreamspan/shared/registry.ts"
import { serverEnvironment } from "../serverEnvironment.ts"
import type { Availability } from "./registry.ts"

interface CgroupLimits {
  /** All of the command's processes together, shared memory and tmpfs pages included. */
  readonly memoryBytes: number
  /** Processes and threads at once. */
  readonly processes: number
}

/** One command's group: how to start it inside, and what became of it. */
export interface CommandCgroup {
  /** The program to spawn instead of `file` with `args`, so the process starts inside the group. */
  readonly wrap: (file: string, args: ReadonlyArray<string>) => { readonly file: string; readonly args: Array<string> }
  /** The environment the wrapper itself needs (bubblewrap clears it for the command). */
  readonly env: Readonly<Record<string, string>>
  /** After the command: whether the memory cap stopped it. Removes the group. */
  readonly finish: () => Promise<{ readonly memoryCapped: boolean }>
}

export interface CgroupLimiter {
  readonly id: string
  /** For the log and the docs: what it uses. */
  readonly explanation: string
  readonly available: () => Promise<Availability>
  readonly open: (limits: CgroupLimits) => Promise<CommandCgroup>
}

const findOnPath = (name: string) =>
  (process.env.PATH ?? "/usr/bin:/bin")
    .split(delimiter)
    .map((dir) => join(dir, name))
    .find((candidate) => existsSync(candidate))

const controllersOf = async (dir: string) =>
  (await readFile(join(dir, "cgroup.subtree_control"), "utf8").catch(() => "")).trim().split(/\s+/)

/** Writes the limits into a cgroup folder; swap is absent where the kernel doesn't account it. */
const writeLimits = async (dir: string, limits: CgroupLimits) => {
  await writeFile(join(dir, "memory.max"), String(Math.max(16 * 2 ** 20, Math.floor(limits.memoryBytes))))
  await writeFile(join(dir, "pids.max"), String(Math.max(8, Math.floor(limits.processes))))
  await writeFile(join(dir, "memory.swap.max"), "0").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  // On running out, the whole command goes, not one process of it.
  await writeFile(join(dir, "memory.oom.group"), "1").catch(() => undefined)
}

const oomKills = async (dir: string) => {
  const events = await readFile(join(dir, "memory.events"), "utf8").catch(() => "")
  return Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0)
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** Kills what's left in a group and removes it (a group with processes can't be removed). */
const removeGroup = async (dir: string) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await rmdir(dir)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") return
      if (code !== "EBUSY") throw error
      await writeFile(join(dir, "cgroup.kill"), "1").catch(() => undefined)
      await sleep(50)
    }
  }
}

/** The delegated subtree, from the environment; null when none is named. */
const delegatedRoot = () => {
  const named = process.env[serverEnvironment.COMMAND_CGROUP]?.trim()
  return named ? named : null
}

const JOIN_SCRIPT = 'echo "$$" > "$0" || { echo "The sandbox couldn\'t join its limits." >&2; exit 125; }; exec "$@"'

const delegatedCgroup: CgroupLimiter = {
  id: "cgroup-delegated",
  explanation: "A cgroup v2 subtree delegated to the app (COMMAND_CGROUP): one group per command.",
  available: async () => {
    const root = delegatedRoot()
    if (!root) return { ok: false, reason: "No cgroup subtree is delegated to the app (COMMAND_CGROUP)." }
    try {
      await access(join(root, "cgroup.procs"), constants.W_OK)
      const controllers = await controllersOf(root)
      if (!controllers.includes("memory") || !controllers.includes("pids"))
        return { ok: false, reason: `${root} doesn't hand the memory and pids controllers to its groups.` }
      // A group can be made and limited here.
      const probe = join(root, `probe-${randomBytes(6).toString("hex")}`)
      await mkdir(probe)
      try {
        await writeLimits(probe, { memoryBytes: 64 * 2 ** 20, processes: 16 })
      } finally {
        await removeGroup(probe)
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `The cgroup subtree ${root} can't be used (${(error as Error).message}).` }
    }
  },
  open: async (limits) => {
    const root = delegatedRoot()
    if (!root) throw new Error("No cgroup subtree is delegated to the app.")
    const dir = join(root, `cmd-${randomBytes(8).toString("hex")}`)
    await mkdir(dir)
    try {
      await writeLimits(dir, limits)
    } catch (error) {
      await removeGroup(dir).catch(() => undefined)
      throw error
    }
    return {
      env: {},
      wrap: (file, args) => ({ file: "/bin/sh", args: ["-c", JOIN_SCRIPT, join(dir, "cgroup.procs"), file, ...args] }),
      finish: async () => {
        const memoryCapped = (await oomKills(dir)) > 0
        await removeGroup(dir).catch(() => undefined)
        return { memoryCapped }
      }
    }
  }
}

/** What systemd-run needs to reach the user manager; nothing else of the app's environment. */
const userBusEnv = (): Record<string, string> => {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`
  return {
    XDG_RUNTIME_DIR: runtime,
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {})
  }
}

const scopeArgs = (limits: CgroupLimits, unit: string, collect: boolean) => [
  "--user",
  "--scope",
  "--quiet",
  ...(collect ? ["--collect"] : []),
  `--unit=${unit}`,
  "-p",
  `MemoryMax=${Math.max(16 * 2 ** 20, Math.floor(limits.memoryBytes))}`,
  "-p",
  "MemorySwapMax=0",
  "-p",
  `TasksMax=${Math.max(8, Math.floor(limits.processes))}`,
  "--"
]

const systemdScope: CgroupLimiter = {
  id: "systemd-scope",
  explanation: "A transient systemd user scope per command (systemd-run --user --scope).",
  available: async () => {
    if (process.platform !== "linux") return { ok: false, reason: "systemd runs on Linux only." }
    const systemdRun = findOnPath("systemd-run")
    if (!systemdRun) return { ok: false, reason: "systemd-run isn't installed." }
    // The scope must really carry the limits: a user manager without the memory controller
    // delegated accepts MemoryMax and ignores it.
    const probe = spawnSync(
      systemdRun,
      [
        ...scopeArgs(
          { memoryBytes: 64 * 2 ** 20, processes: 16 },
          `dreamspan-probe-${randomBytes(6).toString("hex")}`,
          true
        ),
        "/bin/sh",
        "-c",
        'd=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); cat "$d/memory.max" "$d/pids.max"'
      ],
      { encoding: "utf8", timeout: 10_000, env: userBusEnv() }
    )
    if (probe.status !== 0)
      return {
        ok: false,
        reason: `systemd-run can't make a user scope here (${(probe.stderr || String(probe.error ?? "")).trim().slice(0, 200)}).`
      }
    const [memory, pids] = probe.stdout.trim().split("\n")
    if (memory !== String(64 * 2 ** 20) || pids !== "16")
      return { ok: false, reason: "The systemd user manager doesn't apply memory and process limits to its scopes." }
    return { ok: true }
  },
  open: async (limits) => {
    const systemdRun = findOnPath("systemd-run")
    if (!systemdRun) throw new Error("systemd-run isn't installed.")
    const unit = `dreamspan-cmd-${randomBytes(8).toString("hex")}`
    const env = userBusEnv()
    return {
      env,
      // Not collected on failure, so its result can be read after; reset below.
      wrap: (file, args) => ({ file: systemdRun, args: [...scopeArgs(limits, unit, false), file, ...args] }),
      // A scope that ran out of memory ends as failed with the result `oom-kill`; one that
      // ended normally is gone (its result reads as `success`).
      finish: async () => {
        const result = await systemctl(env, ["show", `${unit}.scope`, "-p", "Result", "--value"])
        if (result !== "success") await systemctl(env, ["reset-failed", `${unit}.scope`])
        return { memoryCapped: result === "oom-kill" }
      }
    }
  }
}

const systemctl = (env: Record<string, string>, args: ReadonlyArray<string>) =>
  new Promise<string>((done) =>
    execFile("systemctl", ["--user", ...args], { env, timeout: 5000, encoding: "utf8" }, (_error, stdout) =>
      done(String(stdout ?? "").trim())
    )
  )

/** The ways commands get a cgroup, in the order they're tried. */
export const bwrapLimiters = makeRegistry<CgroupLimiter>([delegatedCgroup, systemdScope])

let chosen: { readonly at: number; readonly value: CgroupLimiter | { readonly none: string } } | null = null

/**
 * The limiter commands use here, or why there is none (checked again each minute, like the
 * sandbox itself).
 */
export const selectLimiter = async (
  registry: { readonly list: () => ReadonlyArray<CgroupLimiter> } = bwrapLimiters
): Promise<CgroupLimiter | { readonly none: string }> => {
  if (registry === bwrapLimiters && chosen && Date.now() - chosen.at < 60_000) return chosen.value
  let value: CgroupLimiter | { readonly none: string } = { none: "No cgroup limiter is registered." }
  const reasons: Array<string> = []
  for (const limiter of registry.list()) {
    const state = await limiter.available()
    if (state.ok) {
      value = limiter
      break
    }
    reasons.push(state.reason)
  }
  if ("none" in value && reasons.length) value = { none: reasons.join(" ") }
  if (registry === bwrapLimiters) chosen = { at: Date.now(), value }
  return value
}

/** User-facing: added to the "Run commands" row where commands have no cgroup. */
export const WEAKER_LIMITS = "Commands run with weaker limits here."
