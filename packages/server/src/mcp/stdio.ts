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
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { sandboxPath } from "../sandbox/linuxBwrap.ts"
import { commandSandboxes, selectSandbox, type SandboxProcess, type SpawnSpec } from "../sandbox/registry.ts"

/** What the instance switch says when it is off (spec/MCP.md §2.2). */
export const LOCAL_PROGRAMS_OFF = "Turned off for this server. An admin can allow local programs when starting the app."

/** The longest program, argument and argument list a connection may store. */
export const PROGRAM_LIMITS = { command: 1024, argument: 4096, arguments: 64 } as const

/** The folder a program sees as its home, inside the sandbox. */
const PROGRAM_HOME = "/home/user"

/** A program's limits: as a workshop command's, without the time limit. */
const PROGRAM_LIMITS_RUN: SpawnSpec["limits"] = {
  processes: 512,
  memoryBytes: 4 * 2 ** 30,
  fileBytes: 4 * 2 ** 30,
  openFiles: 4096
}

/** A program's stderr, kept per (connection, user): the last 64 KiB. */
const OUTPUT_KEEP_BYTES = 64 * 1024

export class OutputRing {
  private chunks: Array<Buffer> = []
  private bytes = 0
  running = false
  push(chunk: Buffer) {
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.chunks.length > 1 && this.bytes - this.chunks[0]!.length >= OUTPUT_KEEP_BYTES)
      this.bytes -= this.chunks.shift()!.length
  }
  line(text: string) {
    this.push(Buffer.from(`${text}\n`))
  }
  text() {
    const joined = Buffer.concat(this.chunks)
    return joined.subarray(Math.max(0, joined.length - OUTPUT_KEEP_BYTES)).toString("utf8")
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
  const outputOf = (connectionId: string, userId: string) => {
    const key = `${connectionId}\u0000${userId}`
    let ring = outputs.get(key)
    if (!ring) outputs.set(key, (ring = new OutputRing()))
    return ring
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
    // Its own folder, made on first start, owner-only (spec/MCP.md §2.2).
    const home = join(options.dataDir, "mcp", plainId(program.connectionId), plainId(program.userId))
    await mkdir(home, { recursive: true, mode: 0o700 })
    return selected.sandbox.spawn({
      argv: program.argv,
      cwd: PROGRAM_HOME,
      mounts: [{ source: home, target: PROGRAM_HOME, writable: true }],
      // Only these: nothing of the app's own environment (no secret key, no DATA_DIR).
      env: { ...program.env, PATH: sandboxPath(), HOME: PROGRAM_HOME, LANG: "C.UTF-8" },
      network: "public",
      limits: PROGRAM_LIMITS_RUN
    })
  }
  return { start, unavailable, outputOf }
}

/** Raised to the client when the program ends while a request waits on it. */
export class ProgramEnded extends Error {
  override readonly name = "ProgramEnded"
  readonly exitCode: number | null
  constructor(exitCode: number | null, memoryCapped: boolean) {
    super(
      memoryCapped
        ? "the program used more memory than it may and was stopped"
        : `the program stopped${exitCode === null ? "" : ` (exit code ${exitCode})`}`
    )
    this.exitCode = exitCode
  }
}

/**
 * The SDK transport over a sandboxed program's stdin and stdout: one JSON-RPC message per line.
 * stderr goes to the connection's output ring. Closing stops the program by its PID's group.
 */
export class ProgramTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private process: SandboxProcess | null = null
  /** Set once the program has ended. */
  ended: ProgramEnded | null = null
  private readonly buffer = new ReadBuffer()
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
  async start() {
    if (this.process) throw new Error("Already started.")
    const child = await this.launch()
    this.process = child
    this.output.running = true
    this.output.line(`— started (pid ${child.pid}) —`)
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer.append(chunk)
      for (;;) {
        let message: JSONRPCMessage | null
        try {
          message = this.buffer.readMessage()
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)))
          continue
        }
        if (message === null) break
        this.onmessage?.(message)
      }
    })
    child.stderr.on("data", (chunk: Buffer) => this.output.push(chunk))
    void child.exited.then(({ exitCode, memoryCapped }) => {
      this.ended = new ProgramEnded(exitCode, memoryCapped)
      this.output.running = false
      this.output.line(`— ${this.ended.message} —`)
      this.buffer.clear()
      this.onclose?.()
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
