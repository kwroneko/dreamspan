// The command sandbox seam (spec/FILES-AND-ENVIRONMENT.md §3.3): one registered, replaceable
// entry per platform mechanism. The app picks the first available one for its platform unless
// the instance names one; a missing sandbox is shown, never skipped, and commands are then not
// offered. `linux-bwrap` is the only built-in so far; macOS and Windows register here later.
import { makeRegistry } from "@dreamspan/shared/registry.ts"
import { linuxBwrap } from "./linuxBwrap.ts"
import { noSandbox } from "./none.ts"

/** A host folder seen inside the sandbox at `target`. */
export interface SandboxMount {
  readonly source: string
  readonly target: string
  readonly writable: boolean
  /**
   * An open descriptor of the folder (in this process), bound in place of `source`: a folder
   * found by the no-follow walk, so a link swapped in for it after the check is never followed.
   */
  readonly fd?: number
  /** An empty, small, memory-backed folder at `target` (`source` unused), to hold other mounts. */
  readonly empty?: boolean
}

export interface RunLimits {
  /** Wall time; then the whole process tree is killed. */
  readonly timeoutMs: number
  /** Processes and threads inside the sandbox at once (a fork bomb stops here). */
  readonly processes: number
  /**
   * The command's memory. With a cgroup (sandbox/cgroupLimits.ts): all its processes together,
   * shared mappings, memfds and /tmp included. Without one, only each process's writable data
   * (heap and private mappings) is capped, at this size.
   */
  readonly memoryBytes: number
  /** The largest file a command can write. */
  readonly fileBytes: number
  readonly openFiles: number
  /**
   * The private /tmp's size (memory-backed: a process limit doesn't count it, and the kernel
   * can't reclaim it by killing a process). Default 1 GiB; /dev/shm gets at most 256 MiB.
   */
  readonly tmpBytes?: number
  /**
   * Free space and inodes kept on the filesystems of the writable mounts: a command doesn't
   * start below them and is stopped when it goes below, so one account can't fill the disk the
   * app's database shares. Absent: not watched.
   */
  readonly reserve?: { readonly bytes: number; readonly inodes: number }
}

export interface RunSpec {
  /** Shell text, run by the sandbox's shell in `cwd`. */
  readonly command: string
  /** A directory inside the sandbox. */
  readonly cwd: string
  readonly mounts: ReadonlyArray<SandboxMount>
  /** The whole environment: nothing of the app's own is passed on. */
  readonly env: Readonly<Record<string, string>>
  readonly network: "public" | "none"
  readonly limits: RunLimits
  /** Each chunk of output (stdout and stderr together) as it comes, for keeping the whole output. */
  readonly onOutput?: (chunk: Buffer) => void
}

export interface RunResult {
  /** null: ended by a signal, or killed at the timeout or a stop. */
  readonly exitCode: number | null
  readonly timedOut: boolean
  /** Stopped for writing more output than the sandbox reads (`OUTPUT_MAX_BYTES`). */
  readonly outputCapped: boolean
  /** Not started, or stopped, because a writable mount's filesystem went below the reserve. */
  readonly diskLow?: boolean
  /** Stopped because its processes together used more memory than `limits.memoryBytes`. */
  readonly memoryCapped?: boolean
  /** Combined output: the start and the end when it was longer than what's kept. */
  readonly head: string
  readonly tail: string
  readonly outputBytes: number
  /** The shell's directory when the command ended; null when it didn't say. */
  readonly cwd: string | null
  readonly durationMs: number
  /** Bytes the command sent and received over the internet, where the sandbox counts them. */
  readonly networkBytes?: number
}

/**
 * A long-running program started with pipes (an MCP server, spec/MCP.md §2.2): the same
 * sandbox as a command, with its own stdin, stdout and stderr, no time limit and no shell.
 */
export interface SpawnSpec {
  /** The program and its arguments, as given: never interpreted by a shell. */
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly mounts: ReadonlyArray<SandboxMount>
  /** The sandbox's environment, from its first shell on: nothing of the app's own is passed on. */
  readonly env: Readonly<Record<string, string>>
  /**
   * The program's own variables: given to the program only, after the limits are set, so none
   * of them changes how the sandbox's shell or its proxy bridge start. They never override
   * `env` or the proxy's variables.
   */
  readonly programEnv?: Readonly<Record<string, string>>
  readonly network: "public" | "none"
  /** The reserve is checked before it starts and while it runs: below it, it is stopped. */
  readonly limits: Omit<RunLimits, "timeoutMs">
}

export interface SandboxProcess {
  /** The process `spawn` returned; its group is what `kill` stops. */
  readonly pid: number
  readonly stdin: NodeJS.WritableStream
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  /** Settles once it has ended and the sandbox is cleaned up. */
  readonly exited: Promise<{
    readonly exitCode: number | null
    readonly memoryCapped: boolean
    /** Stopped because a writable mount's filesystem went below the reserve. */
    readonly diskLow?: boolean
  }>
  /** Stops its whole process tree, by the group of the PID `spawn` returned. */
  readonly kill: () => void
}

export type Availability =
  { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly fix?: string }

export interface CommandSandbox {
  readonly id: string
  /** User-facing. */
  readonly label: string
  readonly explanation: string
  readonly platforms: ReadonlyArray<NodeJS.Platform>
  readonly available: () => Promise<Availability>
  /** Runs one command; aborting `signal` kills its whole process tree. */
  readonly run: (spec: RunSpec, signal: AbortSignal) => Promise<RunResult>
  /** Starts a long-running program with pipes; absent where the sandbox can't. */
  readonly spawn?: (spec: SpawnSpec) => Promise<SandboxProcess>
  /** User-facing, for the "Run commands" row when it is available but limited; null: nothing to say. */
  readonly note?: () => Promise<string | null>
  /** At server start: cleanup and what it found, for the log. */
  readonly start?: () => Promise<ReadonlyArray<string>>
  /**
   * Runs commands without isolation (`none`, spec/FILES-AND-ENVIRONMENT.md §3.7): never chosen
   * by `selectSandbox`, named or not; only the file tools' own check for an admin's workshop
   * uses it.
   */
  readonly unsandboxed?: true
}

export const commandSandboxes = makeRegistry<CommandSandbox>([linuxBwrap, noSandbox])

/**
 * The sandbox commands run in: the named one, else the first available for this platform.
 * Unavailable: why, for the capability row and the tool result.
 */
export const selectSandbox = async (
  registry: {
    readonly list: () => ReadonlyArray<CommandSandbox>
    readonly get: (id: string) => CommandSandbox | undefined
  },
  named?: string
): Promise<{ readonly sandbox: CommandSandbox } | { readonly unavailable: string }> => {
  const candidates = (
    named
      ? [registry.get(named)].filter((s): s is CommandSandbox => s !== undefined)
      : registry.list().filter((s) => s.platforms.includes(process.platform))
  ).filter((s) => !s.unsandboxed)
  if (candidates.length === 0)
    return { unavailable: named ? `The sandbox “${named}” isn't installed.` : "Commands can't run on this system yet." }
  let reason = ""
  for (const sandbox of candidates) {
    const state = await sandbox.available()
    if (state.ok) return { sandbox }
    reason ||= state.reason + (state.fix ? ` ${state.fix}` : "")
  }
  return { unavailable: reason }
}
