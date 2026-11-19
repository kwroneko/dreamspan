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
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm, statfs, writeFile, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { bwrapLimiters, selectLimiter, WEAKER_LIMITS, type CommandCgroup } from "./cgroupLimits.ts"
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
/** The private /tmp's default size, and /dev/shm's largest. */
const TMP_BYTES = 2 ** 30
const SHM_BYTES = 256 * 2 ** 20
/** How often the reserve on the writable mounts' filesystems is checked while a command runs. */
const RESERVE_CHECK_MS = 500

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
 * then the command, with the directory it ended in after a random marker. The marker comes in
 * the environment (`RP_END`, set through bubblewrap's argument descriptor), not on a command
 * line, so /proc/1/cmdline doesn't show it. The command shares this shell and could still read
 * it (`trap -p`), which only lets it choose its own next directory, inside the sandbox.
 */
const prelude = (spec: RunSpec) => {
  const kib = (bytes: number) => Math.max(1, Math.floor(bytes / 1024))
  const limit = (flag: string, value: number) =>
    `ulimit ${flag} ${value} || { echo "The sandbox couldn't set its limits." >&2; exit 125; }`
  return [
    // Out of memory, the kernel picks a command before the server (a command can lower it back
    // to the server's own value, never below).
    "echo 1000 > /proc/self/oom_score_adj 2>/dev/null",
    limit("-u", spec.limits.processes),
    limit("-d", kib(spec.limits.memoryBytes)),
    limit("-f", kib(spec.limits.fileBytes)),
    limit("-n", spec.limits.openFiles),
    "exec 2>&1 </dev/null",
    spec.network === "public"
      ? `exec 3< <(${shellQuote(process.execPath)} ${RUNTIME}/bridge.mjs ${RUNTIME}/proxy.sock ${PROXY_PORT} 2>/dev/null); read -r -t 10 __rp_ready <&3; exec 3<&-; unset __rp_ready`
      : ":",
    `trap "printf '\\n%s %s\\n' $RP_END \\"\\$PWD\\"" EXIT`,
    "unset RP_END",
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

const tmpBytes = (spec: RunSpec) => Math.max(2 ** 20, Math.floor(spec.limits.tmpBytes ?? TMP_BYTES))

/** Whether a filesystem has gone below the reserve; an unreadable one counts as below. */
const belowReserve = async (path: string, reserve: NonNullable<RunSpec["limits"]["reserve"]>) => {
  try {
    const fs = await statfs(path)
    // Filesystems without an inode table report 0 files.
    return fs.bavail * fs.bsize < reserve.bytes || (fs.files > 0 && fs.ffree < reserve.inodes)
  } catch {
    return true
  }
}

const anyBelowReserve = async (spec: RunSpec) => {
  const reserve = spec.limits.reserve
  if (!reserve) return false
  const checks = await Promise.all(spec.mounts.filter((m) => m.writable).map((m) => belowReserve(m.source, reserve)))
  return checks.some(Boolean)
}

/**
 * Kernel calls a command never needs and that are the usual way into the kernel from an
 * unprivileged process: io_uring, keyrings, userfaultfd, BPF, perf events, file handles, and
 * mounting, namespaces and module or system calls (most need a capability the command doesn't
 * have; they are refused before the kernel looks). Docker's default filter refuses these too,
 * but a server outside Docker (a development server) has none. Refused with EPERM, as Docker does.
 * Numbers for x86_64 and for aarch64 (the generic table, which has no `uselib`); other
 * architectures get no filter.
 */
const DENIED_X86_64: Readonly<Record<string, number>> = {
  io_uring_setup: 425,
  io_uring_enter: 426,
  io_uring_register: 427,
  add_key: 248,
  request_key: 249,
  keyctl: 250,
  userfaultfd: 323,
  bpf: 321,
  perf_event_open: 298,
  fanotify_init: 300,
  name_to_handle_at: 303,
  open_by_handle_at: 304,
  mount: 165,
  umount2: 166,
  pivot_root: 155,
  chroot: 161,
  open_tree: 428,
  move_mount: 429,
  fsopen: 430,
  fsmount: 432,
  fspick: 433,
  mount_setattr: 442,
  open_tree_attr: 467,
  unshare: 272,
  setns: 308,
  kexec_load: 246,
  kexec_file_load: 320,
  init_module: 175,
  delete_module: 176,
  finit_module: 313,
  acct: 163,
  swapon: 167,
  swapoff: 168,
  reboot: 169,
  quotactl: 179,
  lookup_dcookie: 212,
  syslog: 103,
  uselib: 134
}

/** include/uapi/asm-generic/unistd.h (aarch64), checked against a Linux host's headers. */
const DENIED_AARCH64: Readonly<Record<string, number>> = {
  io_uring_setup: 425,
  io_uring_enter: 426,
  io_uring_register: 427,
  add_key: 217,
  request_key: 218,
  keyctl: 219,
  userfaultfd: 282,
  bpf: 280,
  perf_event_open: 241,
  fanotify_init: 262,
  name_to_handle_at: 264,
  open_by_handle_at: 265,
  mount: 40,
  umount2: 39,
  pivot_root: 41,
  chroot: 51,
  open_tree: 428,
  move_mount: 429,
  fsopen: 430,
  fsmount: 432,
  fspick: 433,
  mount_setattr: 442,
  open_tree_attr: 467,
  unshare: 97,
  setns: 268,
  kexec_load: 104,
  kexec_file_load: 294,
  init_module: 105,
  delete_module: 106,
  finit_module: 273,
  acct: 89,
  swapon: 224,
  swapoff: 225,
  reboot: 142,
  quotactl: 60,
  lookup_dcookie: 18,
  syslog: 116
}

/** The kernel calls refused on an architecture; empty where no filter is made. */
export const deniedCalls = (arch: NodeJS.Architecture = process.arch): Readonly<Record<string, number>> =>
  arch === "x64" ? DENIED_X86_64 : arch === "arm64" ? DENIED_AARCH64 : {}

/** A classic BPF seccomp program refusing `deniedCalls`; null on other architectures. */
export const seccompFilter = (arch: NodeJS.Architecture = process.arch): Buffer | null => {
  if (arch !== "x64" && arch !== "arm64") return null
  const insn = (code: number, jt: number, jf: number, k: number) => {
    const b = Buffer.alloc(8)
    b.writeUInt16LE(code, 0)
    b.writeUInt8(jt, 2)
    b.writeUInt8(jf, 3)
    b.writeUInt32LE(k >>> 0, 4)
    return b
  }
  const LD_ABS = 0x20
  const JEQ = 0x15
  const JGE = 0x35
  const RET = 0x06
  const ALLOW = 0x7fff0000
  const EPERM = 0x00050000 | 1
  const KILL_PROCESS = 0x80000000
  const AUDIT_ARCH = arch === "x64" ? 0xc000003e : 0xc00000b7
  const X32_BIT = 0x40000000
  const program: Array<Buffer> = [
    insn(LD_ABS, 0, 0, 4), // arch
    insn(JEQ, 1, 0, AUDIT_ARCH),
    insn(RET, 0, 0, KILL_PROCESS),
    insn(LD_ABS, 0, 0, 0) // nr
  ]
  // On x86_64 the x32 ABI's numbers are refused outright; then each denied number jumps to the
  // refusal.
  const denied = Object.values(deniedCalls(arch))
  const x32 = arch === "x64" ? 1 : 0
  const denyAt = program.length + x32 + denied.length + 1
  if (x32) program.push(insn(JGE, denyAt - program.length - 1, 0, X32_BIT))
  for (const nr of denied) program.push(insn(JEQ, denyAt - program.length - 1, 0, nr))
  program.push(insn(RET, 0, 0, ALLOW))
  program.push(insn(RET, 0, 0, EPERM))
  return Buffer.concat(program)
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
    // Memory-backed folders are sized: their pages aren't counted by any process limit, and
    // killing a process doesn't free them. /dev itself is made read-only after.
    "--dev",
    "/dev",
    "--size",
    String(Math.min(tmpBytes(spec), SHM_BYTES)),
    "--tmpfs",
    "/dev/shm",
    "--remount-ro",
    "/dev",
    "--size",
    String(tmpBytes(spec)),
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
const runtimeRoot = () => process.env.DREAMSPAN_SANDBOX_RUNTIME ?? tmpdir()

/** A run folder's name carries the server's process id, so a later start knows whose it was. */
const RUN_PREFIX = "dreamspan-sbx-"
const RUN_FOLDER = /^dreamspan-sbx-(?:(\d+)-)?[A-Za-z0-9]{6}$/

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Removes run folders a server left when it was killed outright (its bridge and proxy socket).
 * Only folders of a process that is gone: a test run or a second server sharing the temporary
 * folder keeps its own. Folders named before the process id was added go after a day.
 */
export const sweepRunFolders = async (root: string = runtimeRoot()) => {
  let removed = 0
  const names = await readdir(root).catch(() => [] as Array<string>)
  for (const name of names) {
    const found = RUN_FOLDER.exec(name)
    if (!found) continue
    const path = join(root, name)
    const info = await lstat(path).catch(() => null)
    if (!info?.isDirectory() || info.uid !== (process.getuid?.() ?? info.uid)) continue
    const pid = found[1] === undefined ? null : Number(found[1])
    const stale = pid === null ? Date.now() - info.mtimeMs > 86_400_000 : pid !== process.pid && !alive(pid)
    if (!stale) continue
    await rm(path, { recursive: true, force: true }).then(
      () => removed++,
      () => undefined
    )
  }
  return removed
}

/**
 * Writes bubblewrap's arguments as one NUL-separated file it reads from a descriptor (`--args`),
 * so the sandbox's /proc/1/cmdline shows `bwrap --args N`, not the host's folders or the end
 * marker.
 */
const argsFile = async (runDir: string, args: ReadonlyArray<string>) => {
  const path = join(runDir, "args")
  await writeFile(path, args.map((arg) => `${arg}\0`).join(""), { mode: 0o600 })
  return open(path, "r")
}

const runOnce = async (spec: RunSpec, signal: AbortSignal): Promise<RunResult> => {
  const bwrap = findOnPath("bwrap")
  if (!bwrap) throw new Error("bubblewrap isn't installed")
  const started = Date.now()
  if (await anyBelowReserve(spec))
    return {
      exitCode: null,
      timedOut: false,
      outputCapped: false,
      diskLow: true,
      head: "",
      tail: "",
      outputBytes: 0,
      cwd: null,
      durationMs: 0
    }
  const runDir = await mkdtemp(join(runtimeRoot(), `${RUN_PREFIX}${process.pid}-`))
  let proxy: SandboxProxy | null = null
  let group: CommandCgroup | null = null
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
    // The filter goes to bubblewrap as descriptor 3 and its arguments as the next one; it reads
    // and closes both before the command.
    const filter = seccompFilter()
    let filterFile: FileHandle | null = null
    if (filter) {
      await writeFile(join(runDir, "seccomp.bpf"), filter)
      filterFile = await open(join(runDir, "seccomp.bpf"), "r")
    }
    const argsFd = filterFile ? 4 : 3
    // Options only: bubblewrap takes the command itself from its command line.
    const args = await argsFile(runDir, [
      ...(filterFile ? ["--seccomp", "3"] : []),
      ...bwrapArgs(spec, runDir),
      "--setenv",
      "RP_END",
      marker
    ])
    const argv = ["--args", String(argsFd), "/bin/bash", "-c", prelude(spec), "dreamspan-sandbox", spec.command]
    // The command's own cgroup, where one can be made: a real memory cap for all its processes.
    const limiter = await selectLimiter(bwrapLimiters)
    if (!("none" in limiter))
      group = await limiter.open({ memoryBytes: spec.limits.memoryBytes, processes: spec.limits.processes })
    const start = group ? group.wrap(bwrap, argv) : { file: bwrap, args: argv }
    const child = (() => {
      try {
        return spawn(start.file, start.args, {
          stdio: ["ignore", "pipe", "pipe", ...(filterFile ? [filterFile.fd] : []), args.fd],
          detached: true,
          env: { ...group?.env }
        })
      } finally {
        void filterFile?.close()
        void args.close()
      }
    })()
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
    child.stdout!.on("data", take)
    child.stderr!.on("data", take)
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
    let diskLow = false
    let checking = false
    const watch = spec.limits.reserve
      ? setInterval(() => {
          if (checking) return
          checking = true
          void anyBelowReserve(spec).then((low) => {
            checking = false
            if (low && !diskLow) {
              diskLow = true
              kill()
            }
          })
        }, RESERVE_CHECK_MS)
      : null
    const onAbort = () => kill()
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) kill()
    const exitCode = await new Promise<number | null>((done) => {
      child.once("error", () => done(null))
      child.once("close", (code) => done(code))
    })
    clearTimeout(timer)
    if (watch) clearInterval(watch)
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
    const ended = group ? await group.finish().catch(() => ({ memoryCapped: false })) : { memoryCapped: false }
    group = null
    const memoryCapped = ended.memoryCapped && !timedOut && !outputCapped && !diskLow && !signal.aborted
    return {
      exitCode: timedOut || outputCapped || diskLow || memoryCapped || signal.aborted ? null : exitCode,
      timedOut,
      outputCapped,
      ...(diskLow ? { diskLow } : {}),
      ...(memoryCapped ? { memoryCapped } : {}),
      head: fromHead ? text : head.toString("utf8"),
      tail: fromHead ? "" : text,
      outputBytes: Math.max(0, total),
      cwd,
      durationMs: Date.now() - started
    }
  } finally {
    await group?.finish().catch(() => undefined)
    await proxy?.close().catch(() => undefined)
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Where commands have no cgroup of their own: the row says the limits are weaker. */
const limitsNote = async () => {
  const limiter = await selectLimiter(bwrapLimiters)
  return "none" in limiter ? WEAKER_LIMITS : null
}

export const linuxBwrap: CommandSandbox = {
  id: "linux-bwrap",
  label: "Linux sandbox",
  explanation: "Commands run in a sandbox: they see only your files and the internet.",
  platforms: ["linux"],
  available: checkAvailable,
  run: runOnce,
  note: limitsNote,
  start: async () => {
    const removed = await sweepRunFolders()
    const limiter = await selectLimiter(bwrapLimiters)
    return [
      ...(removed ? [`removed ${removed} run folders left by a stopped server`] : []),
      "none" in limiter
        ? `commands have no cgroup of their own, so only per-process limits apply: ${limiter.none}`
        : `commands get a cgroup each (${limiter.id})`
    ]
  }
}
