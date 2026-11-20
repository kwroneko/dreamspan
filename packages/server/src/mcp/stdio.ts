// Local programs (spec/MCP.md §2.2, M6): an MCP server the app starts itself and talks to over
// its stdin and stdout. Admins only, and only where MCP_LOCAL_PROGRAMS=on. Delta from the spec:
// the program runs in the command sandbox (ARCHITECTURE §18), not with the app's own access. It
// sees its own folder as /home/user, the system's programs read-only, and the internet through
// the sandbox's proxy; never the app's data, other accounts' files or the server's processes.
//
// One process per (connection, user): the kept client of McpConnections owns it, so it starts
// with the first call that needs it and stops when that client closes (5 idle minutes, an edit,
// a share change, shutdown), always by the group of the PID `spawn` returned.
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { requestSecrets } from "../providers/Providers.ts"
import { sandboxPath } from "../sandbox/linuxBwrap.ts"
import { commandSandboxes, selectSandbox, type SandboxProcess, type SpawnSpec } from "../sandbox/registry.ts"

/** What the instance switch says when it is off (spec/MCP.md §2.2). */
export const LOCAL_PROGRAMS_OFF = "Turned off for this server. An admin can allow local programs when starting the app."

/** The longest program, argument and argument list a connection may store. */
export const PROGRAM_LIMITS = { command: 1024, argument: 4096, arguments: 64 } as const

/** The folder a program sees as its home, inside the sandbox. */
const PROGRAM_HOME = "/home/user"

/**
 * A program's limits: as a workshop command's, without the time limit, and with the same disk
 * reserve (agent/tools/files.ts), so a program can't fill the filesystem the database shares.
 * One object the sandbox reads while the program runs: tests raise the reserve to cross it.
 */
export const programLimits: { -readonly [K in keyof SpawnSpec["limits"]]-?: NonNullable<SpawnSpec["limits"][K]> } = {
  processes: 512,
  memoryBytes: 4 * 2 ** 30,
  fileBytes: 4 * 2 ** 30,
  openFiles: 4096,
  tmpBytes: 2 ** 30,
  reserve: { bytes: 2 * 2 ** 30, inodes: 100_000 }
}

/**
 * The longest message a program may send on one line. A longer one stops the program and ends
 * the call it was for; the app never holds more of one message than this.
 */
export const PROGRAM_MESSAGE_LIMIT = 8 * 2 ** 20

/** A program's stderr, kept per (connection, user): the last 64 KiB. */
const OUTPUT_KEEP_BYTES = 64 * 1024

/** What a program wrote to stderr, kept this long after it stopped and nothing read it. */
const OUTPUT_KEEP_MS = 60 * 60 * 1000

/**
 * Variables a program's owner can't set: they change how the sandbox's shell, the dynamic
 * linker or a language runtime starts, so they would run the owner's code before the program
 * itself, or turn the program into another one. PATH, HOME and LANG are the app's own.
 */
const RESERVED_ENV = new Set(["PATH", "HOME", "LANG"])
const STARTUP_ENV = new Set([
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "IFS",
  "CDPATH",
  "GLOBIGNORE",
  "SHLVL",
  "EUID",
  "UID",
  "PPID",
  "NODE_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "PYTHONWARNINGS",
  "PERL5OPT",
  "PERL5DB",
  "PERLIO",
  "RUBYOPT",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "GCONV_PATH",
  "GETCONF_DIR",
  "HOSTALIASES",
  "LOCPATH",
  "MALLOC_TRACE",
  "NLSPATH",
  "RESOLV_HOST_CONF"
])
const STARTUP_ENV_PREFIXES = ["BASH_", "LD_", "DYLD_", "DREAMSPAN_", "__RP"]

/** Why a program's own variable can't have this name; null when it can. */
export const programEnvProblem = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) return `"${name}" isn't a valid variable name.`
  if (RESERVED_ENV.has(name)) return `${name} is set by the app.`
  const upper = name.toUpperCase()
  if (STARTUP_ENV.has(upper) || STARTUP_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix)))
    return `${name} changes how programs start, so it can't be set here.`
  return null
}

export class OutputRing {
  private chunks: Array<Buffer> = []
  private bytes = 0
  running = false
  /** When it last changed or was read. */
  touchedAt = Date.now()
  /**
   * The values of the owner's variables every copy written here was started with: removed from
   * what is shown, whoever reads it, including values the owner has since replaced.
   */
  private secrets = requestSecrets()
  keepSecrets(env: Readonly<Record<string, string>>) {
    this.secrets.variables(env)
  }
  push(chunk: Buffer) {
    this.touchedAt = Date.now()
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.chunks.length > 1 && this.bytes - this.chunks[0]!.length >= OUTPUT_KEEP_BYTES)
      this.bytes -= this.chunks.shift()!.length
  }
  line(text: string) {
    this.push(Buffer.from(`${text}\n`))
  }
  /** The last 64 KiB, from its first whole line, secrets scrubbed. */
  text() {
    this.touchedAt = Date.now()
    const joined = Buffer.concat(this.chunks)
    let kept = joined.subarray(Math.max(0, joined.length - OUTPUT_KEEP_BYTES))
    // A cut line could start with the end of a secret, which no scrub would recognise.
    if (kept.length < joined.length) {
      const newline = kept.indexOf(10)
      kept = newline < 0 ? Buffer.alloc(0) : kept.subarray(newline + 1)
    }
    return this.secrets.scrub(kept.toString("utf8"))
  }
}

/**
 * A program's stdout split into lines, never holding more than `limit` bytes of one: a longer
 * line throws `MessageTooLong`, and what came of it is dropped.
 */
export class LineBuffer {
  private parts: Array<Buffer> = []
  private bytes = 0
  private readonly limit: number
  constructor(limit: number) {
    this.limit = limit
  }
  push(chunk: Buffer): Array<string> {
    const lines: Array<string> = []
    let start = 0
    for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, start)) {
      this.take(chunk.subarray(start, newline))
      const line = Buffer.concat(this.parts).toString("utf8")
      this.clear()
      lines.push(line.endsWith("\r") ? line.slice(0, -1) : line)
      start = newline + 1
    }
    if (start < chunk.length) this.take(chunk.subarray(start))
    return lines
  }
  private take(part: Buffer) {
    if (this.bytes + part.length > this.limit) {
      this.clear()
      throw new MessageTooLong(this.limit)
    }
    if (part.length > 0) this.parts.push(part)
    this.bytes += part.length
  }
  clear() {
    this.parts = []
    this.bytes = 0
  }
}

export class MessageTooLong extends Error {
  override readonly name = "MessageTooLong"
  constructor(limit: number) {
    super(`the program sent a message longer than ${Math.round(limit / 2 ** 20)} MB, so it was stopped`)
  }
}

/** A plain id: a path segment that can't climb out of the programs' folder. */
const plainId = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Unexpected id.")
  return id
}

export interface ProgramStart {
  readonly connectionId: string
  readonly userId: string
  /** The program and its arguments. */
  readonly argv: ReadonlyArray<string>
  /** The connection's own variables. */
  readonly env: Readonly<Record<string, string>>
}

/** Starts programs for one server instance: its data folder and its choice of sandbox. */
export const makeProgramStarter = (options: { readonly dataDir: string; readonly sandboxId: string }) => {
  const outputs = new Map<string, OutputRing>()
  /** Rings of programs that stopped and weren't read for an hour go. */
  const sweep = (now: number) => {
    for (const [key, ring] of outputs) if (!ring.running && now - ring.touchedAt > OUTPUT_KEEP_MS) outputs.delete(key)
  }
  const outputOf = (connectionId: string, userId: string) => {
    sweep(Date.now())
    const key = `${connectionId}\u0000${userId}`
    let ring = outputs.get(key)
    if (!ring) outputs.set(key, (ring = new OutputRing()))
    return ring
  }
  /** Forgets a connection's output (its environment changed, it was deleted, a share ended). */
  const forget = (connectionId: string, userId?: string) => {
    for (const [key, ring] of outputs)
      if (key === `${connectionId}\u0000${userId}` || (userId === undefined && key.startsWith(`${connectionId}\u0000`)))
        if (!ring.running) outputs.delete(key)
  }
  /** Where local programs can't run here, why; null when they can. */
  const unavailable = async () => {
    const selected = await selectSandbox(commandSandboxes, options.sandboxId || undefined)
    if ("unavailable" in selected) return `Local programs can't run here: ${selected.unavailable}`
    if (!selected.sandbox.spawn) return "Local programs can't run in this server's sandbox."
    return null
  }
  const start = async (program: ProgramStart): Promise<SandboxProcess> => {
    const selected = await selectSandbox(commandSandboxes, options.sandboxId || undefined)
    if ("unavailable" in selected) throw new Error(`Local programs can't run here: ${selected.unavailable}`)
    if (!selected.sandbox.spawn) throw new Error("Local programs can't run in this server's sandbox.")
    // Checked again here, whatever was stored: nothing that changes how programs start.
    for (const name of Object.keys(program.env)) {
      const problem = programEnvProblem(name)
      if (problem !== null) throw new Error(problem)
    }
    // Its own folder, made on first start, owner-only (spec/MCP.md §2.2).
    const home = join(options.dataDir, "mcp", plainId(program.connectionId), plainId(program.userId))
    await mkdir(home, { recursive: true, mode: 0o700 })
    return selected.sandbox.spawn({
      argv: program.argv,
      cwd: PROGRAM_HOME,
      mounts: [{ source: home, target: PROGRAM_HOME, writable: true }],
      // Only these: nothing of the app's own environment (no secret key, no DATA_DIR). The
      // program's own variables reach only the program, once the sandbox's limits are set.
      env: { PATH: sandboxPath(), HOME: PROGRAM_HOME, LANG: "C.UTF-8" },
      programEnv: program.env,
      network: "public",
      limits: programLimits
    })
  }
  return { start, unavailable, outputOf, forget, size: () => outputs.size }
}

/** Raised to the client when the program ends while a request waits on it. */
export class ProgramEnded extends Error {
  override readonly name = "ProgramEnded"
  readonly exitCode: number | null
  constructor(message: string, exitCode: number | null = null) {
    super(message)
    this.exitCode = exitCode
  }
  static of(end: { readonly exitCode: number | null; readonly memoryCapped: boolean; readonly diskLow?: boolean }) {
    return new ProgramEnded(
      end.diskLow
        ? "the disk the app keeps its data on is nearly full, so the program was stopped"
        : end.memoryCapped
          ? "the program used more memory than it may and was stopped"
          : `the program stopped${end.exitCode === null ? "" : ` (exit code ${end.exitCode})`}`,
      end.exitCode
    )
  }
}

/**
 * The SDK transport over a sandboxed program's stdin and stdout: one JSON-RPC message per line,
 * at most PROGRAM_MESSAGE_LIMIT bytes each. stderr goes to the connection's output ring.
 * Closing stops the program by its PID's group. Nothing a program sends can throw out of the
 * stream listeners: a message too long stops the program, which ends the call waiting on it.
 */
export class ProgramTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private process: SandboxProcess | null = null
  /** Set once the program has ended, or the app stopped it. */
  ended: ProgramEnded | null = null
  private readonly lines = new LineBuffer(PROGRAM_MESSAGE_LIMIT)
  private readonly launch: () => Promise<SandboxProcess>
  private readonly output: OutputRing
  constructor(launch: () => Promise<SandboxProcess>, output: OutputRing) {
    this.launch = launch
    this.output = output
  }
  /** The program's PID, once started. */
  get pid() {
    return this.process?.pid ?? null
  }
  private report(error: unknown) {
    try {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)))
    } catch {
      /* A handler's own failure isn't the program's. */
    }
  }
  /** Stops the program for `reason`: the call waiting on it ends with it. */
  private stop(reason: ProgramEnded) {
    if (this.ended !== null) return
    this.ended = reason
    this.lines.clear()
    this.output.line(`— ${reason.message} —`)
    this.process?.kill()
  }
  private read(chunk: Buffer) {
    if (this.ended !== null) return
    let lines: Array<string>
    try {
      lines = this.lines.push(chunk)
    } catch (error) {
      this.stop(new ProgramEnded(error instanceof Error ? error.message : String(error)))
      return
    }
    for (const line of lines) {
      if (this.ended !== null) return
      if (line.trim() === "") continue
      let message: JSONRPCMessage
      try {
        message = deserializeMessage(line)
      } catch (error) {
        this.report(error)
        continue
      }
      try {
        this.onmessage?.(message)
      } catch (error) {
        this.report(error)
      }
    }
  }
  async start() {
    if (this.process) throw new Error("Already started.")
    const child = await this.launch()
    this.process = child
    this.output.running = true
    this.output.line(`— started (pid ${child.pid}) —`)
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.read(chunk)
      } catch (error) {
        this.report(error)
      }
    })
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        this.output.push(chunk)
      } catch {
        /* Output is best effort. */
      }
    })
    // A stream's own error is the program ending, which `exited` reports.
    child.stdout.on("error", () => undefined)
    child.stderr.on("error", () => undefined)
    void child.exited.then((end) => {
      try {
        const ended = ProgramEnded.of(end)
        if (this.ended === null) {
          this.ended = ended
          this.output.line(`— ${ended.message} —`)
        }
        this.output.running = false
        this.lines.clear()
        this.onclose?.()
      } catch (error) {
        this.report(error)
      }
    })
  }
  send(message: JSONRPCMessage) {
    return new Promise<void>((resolve, reject) => {
      const child = this.process
      if (!child) return reject(new Error("The program hasn't started."))
      if (this.ended) return reject(this.ended)
      if (child.stdin.write(serializeMessage(message))) resolve()
      else child.stdin.once("drain", () => resolve())
    })
  }
  async close() {
    const child = this.process
    if (!child) return
    child.kill()
    await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 5000))])
  }
}
