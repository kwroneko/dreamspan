// `linux-bwrap` (spec/FILES-AND-ENVIRONMENT.md §3.2): each command is a fresh bubblewrap
// process with new user, mount, PID, IPC, UTS, cgroup and network namespaces. It sees only
// what is bound in: the system's program folders read-only, the mounts the caller names (an
// account's Files and home folder), a private /tmp and a synthetic /etc/passwd. The app's data
// folder, the host's home folders and the server's processes aren't there at all. The network
// namespace has no route out: the proxy's Unix socket (network.ts) is the only way, and a small
// bridge inside listens on loopback for the proxy variables.
//
// Delta from the spec: bubblewrap is driven directly, not through sandbox-runtime. Its Linux
// mode binds the whole host read-only and hides a deny list, at the host's own paths, from one
// process-wide configuration; here each command needs its own allow list, mounted at /files
// and /home/user. Its proxy's public-address rule is the same shape as network.ts.
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { BRIDGE_SOURCE, sandboxNetworks, type SandboxProxy } from "./network.ts"
import type { Availability, CommandSandbox, RunResult, RunSpec } from "./registry.ts"

/** Kept of a command's output: its start and its end (the tool shows less of each). */
const KEEP_HEAD = 1 << 20
const KEEP_TAIL = 1 << 20
/**
 * A command that writes more than this is stopped: reading a pipe costs the server's main
 * thread, so output can't be unbounded for the whole timeout.
 */
const OUTPUT_MAX_BYTES = 256 * 2 ** 20
/** Where the proxy's socket and the bridge live inside the sandbox. */
const RUNTIME = "/run/rp"
const PROXY_PORT = 3128
/** Unix socket paths are limited to 108 bytes. */
const SOCKET_PATH_MAX = 100

const findOnPath = (name: string) =>
  (process.env.PATH ?? "/usr/bin:/bin")
    .split(delimiter)
    .map((dir) => join(dir, name))
    .find((candidate) => existsSync(candidate))

const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"]
const ETC_ENTRIES = [
  "ssl",
  "ca-certificates",
  "ca-certificates.conf",
  "alternatives",
  "ld.so.cache",
  "ld.so.conf",
  "ld.so.conf.d",
  "localtime",
  "mime.types",
  "protocols",
  "services",
  "os-release",
  "gitconfig",
  "inputrc",
  "pki"
]

/** The program folders, read-only, with merged-/usr links kept as links. */
const systemArgs = () => {
  const args: Array<string> = []
  for (const dir of SYSTEM_DIRS) {
    const info = (() => {
      try {
        return lstatSync(dir)
      } catch {
        return null
      }
    })()
    if (!info) continue
    if (info.isSymbolicLink()) args.push("--symlink", readlinkSync(dir), dir)
    else if (info.isDirectory()) args.push("--ro-bind", dir, dir)
  }
  const etc = (() => {
    try {
      return readdirSync("/etc")
    } catch {
      return []
    }
  })()
  for (const name of [...ETC_ENTRIES, ...etc.filter((n) => /^python3(\.\d+)?$/.test(n))])
    if (existsSync(join("/etc", name))) args.push("--ro-bind-try", join("/etc", name), join("/etc", name))
  return args
}

/** Node's install folder, when it isn't under /usr (a version manager's, in development). */
const nodePrefix = () => {
  const prefix = dirname(dirname(process.execPath))
  return prefix === "/usr" || prefix.startsWith("/usr/") ? null : prefix
}

/** The PATH commands see: the toolchain first, then the system's folders. */
export const sandboxPath = () =>
  [
    ...(nodePrefix() ? [join(nodePrefix()!, "bin")] : []),
    "/home/user/.local/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/local/sbin",
    "/usr/sbin",
    "/sbin"
  ].join(":")

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * The sandbox's first shell: limits that can't be raised again, then the bridge to the proxy,
 * then the command, with the directory it ended in after a random marker.
 */
const prelude = (spec: RunSpec, marker: string) => {
  const kib = (bytes: number) => Math.max(1, Math.floor(bytes / 1024))
  const limit = (flag: string, value: number) =>
    `ulimit ${flag} ${value} || { echo "The sandbox couldn't set its limits." >&2; exit 125; }`
  return [
    limit("-u", spec.limits.processes),
    limit("-d", kib(spec.limits.memoryBytes)),
    limit("-f", kib(spec.limits.fileBytes)),
    limit("-n", spec.limits.openFiles),
    "exec 2>&1 </dev/null",
    spec.network === "public"
      ? `exec 3< <(${shellQuote(process.execPath)} ${RUNTIME}/bridge.mjs ${RUNTIME}/proxy.sock ${PROXY_PORT} 2>/dev/null); read -r -t 10 __rp_ready <&3; exec 3<&-; unset __rp_ready`
      : ":",
    `trap 'printf "\\n%s %s\\n" ${shellQuote(marker)} "$PWD"' EXIT`,
    `cd -- ${shellQuote(spec.cwd)} || exit 1`,
    'eval "$1"'
  ].join("\n")
}

const proxyEnv = (network: RunSpec["network"]): Record<string, string> => {
  if (network !== "public") return {}
  const url = `http://127.0.0.1:${PROXY_PORT}`
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    ALL_PROXY: url,
    all_proxy: url,
    NO_PROXY: "",
    no_proxy: ""
  }
}

/** The arguments to bubblewrap for one command, given its runtime folder. */
const bwrapArgs = (spec: RunSpec, runDir: string) => {
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--unshare-cgroup-try",
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--hostname",
    "sandbox",
    ...systemArgs(),
    ...(nodePrefix() ? ["--ro-bind", nodePrefix()!, nodePrefix()!] : []),
    "--ro-bind",
    join(runDir, "passwd"),
    "/etc/passwd",
    "--ro-bind",
    join(runDir, "group"),
    "/etc/group",
    "--ro-bind",
    join(runDir, "hosts"),
    "/etc/hosts",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    join(runDir, "rp"),
    RUNTIME
  ]
  for (const mount of spec.mounts) args.push(mount.writable ? "--bind" : "--ro-bind", mount.source, mount.target)
  args.push("--remount-ro", "/", "--chdir", "/", "--clearenv")
  const env = { ...spec.env, ...proxyEnv(spec.network) }
  for (const [key, value] of Object.entries(env)) args.push("--setenv", key, value)
  return args
}

let availability: { readonly at: number; readonly value: Availability } | null = null

const checkAvailable = async (): Promise<Availability> => {
  if (process.platform !== "linux") return { ok: false, reason: "This sandbox runs on Linux only." }
  if (availability && Date.now() - availability.at < 60_000) return availability.value
  const bwrap = findOnPath("bwrap")
  let value: Availability
  if (!bwrap)
    value = {
      ok: false,
      reason: "Commands need bubblewrap, which isn't installed.",
      fix: "Install the bubblewrap package."
    }
  else {
    const probe = spawnSync(
      bwrap,
      [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--disable-userns",
        "--die-with-parent",
        ...systemArgs(),
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "/bin/sh",
        "-c",
        "exit 0"
      ],
      { encoding: "utf8", timeout: 10_000, env: {} }
    )
    value =
      probe.status === 0
        ? { ok: true }
        : {
            ok: false,
            reason: `This system doesn't let the app start its sandbox (${(probe.stderr || String(probe.error ?? "")).trim().slice(0, 200)}).`,
            fix: "It needs unprivileged user namespaces. In Docker, run the server with the seccomp and AppArmor settings in docker/README.md."
          }
  }
  availability = { at: Date.now(), value }
  return value
}

/** Where each command's runtime folder goes: short, for the socket path limit. */
const runtimeRoot = () => process.env.RP_SANDBOX_RUNTIME ?? tmpdir()

const runOnce = async (spec: RunSpec, signal: AbortSignal): Promise<RunResult> => {
  const bwrap = findOnPath("bwrap")
  if (!bwrap) throw new Error("bubblewrap isn't installed")
  const runDir = await mkdtemp(join(runtimeRoot(), "rp-sbx-"))
  let proxy: SandboxProxy | null = null
  const started = Date.now()
  try {
    await mkdir(join(runDir, "rp"), { mode: 0o700 })
    const uid = process.getuid?.() ?? 1000
    const gid = process.getgid?.() ?? 1000
    await writeFile(join(runDir, "passwd"), `user:x:${uid}:${gid}:user:/home/user:/bin/bash\n`)
    await writeFile(join(runDir, "group"), `user:x:${gid}:\n`)
    await writeFile(join(runDir, "hosts"), "127.0.0.1 localhost sandbox\n::1 localhost\n")
    await writeFile(join(runDir, "rp", "bridge.mjs"), BRIDGE_SOURCE)
    if (spec.network === "public") {
      const socketPath = join(runDir, "rp", "proxy.sock")
      if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX)
        throw new Error("The sandbox's runtime folder path is too long.")
      const network = sandboxNetworks.get("public")
      if (!network) throw new Error("No network policy is registered for commands.")
      proxy = await network.open(socketPath)
      await chmod(socketPath, 0o600)
    }
    const marker = `__rp_cwd_${randomBytes(12).toString("hex")}__`
    const child = spawn(
      bwrap,
      [...bwrapArgs(spec, runDir), "/bin/bash", "-c", prelude(spec, marker), "rp-sandbox", spec.command],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: {}
      }
    )
    // The head fills once; the tail is a list of chunks trimmed from the front, so each chunk
    // is copied once however long the output runs.
    const headChunks: Array<Buffer> = []
    let headBytes = 0
    const tailChunks: Array<Buffer> = []
    let tailBytes = 0
    let total = 0
    let outputCapped = false
    const take = (chunk: Buffer) => {
      if (outputCapped) return
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
    child.stdout.on("data", take)
    child.stderr.on("data", take)
    let timedOut = false
    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return
      // The whole group: bubblewrap's init dies with it, and with the init its PID namespace,
      // which takes every process the command started, daemons included.
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }
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
    const head = Buffer.concat(headChunks)
    const joined = Buffer.concat(tailChunks)
    const tail = joined.subarray(Math.max(0, joined.length - KEEP_TAIL))
    // Strip the marker line the shell printed last.
    let text = tail.length ? tail.toString("utf8") : head.toString("utf8")
    let cwd: string | null = null
    const at = text.lastIndexOf(`\n${marker} `)
    if (at >= 0) {
      const end = text.indexOf("\n", at + 1 + marker.length)
      cwd = text.slice(at + 2 + marker.length, end < 0 ? undefined : end)
      text = text.slice(0, at) + (end < 0 ? "" : text.slice(end + 1))
      total -= Buffer.byteLength(`\n${marker} ${cwd}\n`)
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
  } finally {
    await proxy?.close().catch(() => undefined)
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export const linuxBwrap: CommandSandbox = {
  id: "linux-bwrap",
  label: "Linux sandbox",
  explanation: "Commands run in a sandbox: they see only your files and the internet.",
  platforms: ["linux"],
  available: checkAvailable,
  run: runOnce
}
