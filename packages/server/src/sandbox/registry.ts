// The command sandbox seam (spec/FILES-AND-ENVIRONMENT.md §3.3): one registered, replaceable
// entry per platform mechanism. The app picks the first available one for its platform unless
// the instance names one; a missing sandbox is shown, never skipped, and commands are then not
// offered. `linux-bwrap` is the only built-in so far; macOS and Windows register here later.
import { makeRegistry } from "@rp/shared/registry.ts"
import { linuxBwrap } from "./linuxBwrap.ts"

/** A host folder seen inside the sandbox at `target`. */
export interface SandboxMount {
  readonly source: string
  readonly target: string
  readonly writable: boolean
}

export interface RunLimits {
  /** Wall time; then the whole process tree is killed. */
  readonly timeoutMs: number
  /** Processes and threads inside the sandbox at once (a fork bomb stops here). */
  readonly processes: number
  /** Each process's writable data (heap and private mappings). */
  readonly memoryBytes: number
  /** The largest file a command can write. */
  readonly fileBytes: number
  readonly openFiles: number
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
}

export interface RunResult {
  /** null: ended by a signal, or killed at the timeout or a stop. */
  readonly exitCode: number | null
  readonly timedOut: boolean
  /** Stopped for writing more output than the sandbox reads (`OUTPUT_MAX_BYTES`). */
  readonly outputCapped: boolean
  /** Combined output: the start and the end when it was longer than what's kept. */
  readonly head: string
  readonly tail: string
  readonly outputBytes: number
  /** The shell's directory when the command ended; null when it didn't say. */
  readonly cwd: string | null
  readonly durationMs: number
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
}

export const commandSandboxes = makeRegistry<CommandSandbox>([linuxBwrap])

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
  const candidates = named
    ? [registry.get(named)].filter((s): s is CommandSandbox => s !== undefined)
    : registry.list().filter((s) => s.platforms.includes(process.platform))
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
