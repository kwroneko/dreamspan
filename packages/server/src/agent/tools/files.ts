// The workshop's file tools and commands (spec/FILES-AND-ENVIRONMENT.md §5.1, §5.2): registered
// by the files host (files/WorkshopFiles.ts), offered in standalone workshops. The file tools run
// in the app through the no-follow walk (files/safePath.ts) and reach /files only; `bash` runs in
// the selected command sandbox (sandbox/registry.ts). Every write and edit keeps the earlier
// content as a version and records a `file.*` effect with Undo; every command records a
// `shell.run` effect listing the files it changed, with no Undo. A call cut off without its
// receipt is never run again silently: the permit asks (agent/approvals.ts).
import { locateFolder } from "../../files/workingFolder.ts"
import { createHash } from "node:crypto"
import { readFile, readdir, rmdir, statfs, type FileHandle } from "node:fs/promises"
import { join, posix } from "node:path"
import { Type } from "@earendil-works/pi-ai"
import { Effect, Semaphore } from "effect"
import type { User } from "@dreamspan/shared/domain.ts"
import type { RolloutEffect, RolloutEffectRecord } from "@dreamspan/shared/workshopApi.ts"
import { foldState, type ChatState } from "@dreamspan/shared/state.ts"
import { EffectUndoRefused } from "@dreamspan/shared/workshopApi.ts"
import type { Reader, Writer } from "../../db/Database.ts"
import { isMediaPath } from "../../db/media.ts"
import { storeMedia } from "../../importer/mediaFiles.ts"
import {
  FilePathRefused,
  listFolder,
  openFolder,
  removeTreeAt,
  segmentsOf,
  readRegularFile,
  removeFile,
  statPath,
  writeRegularFile,
  type Entry
} from "../../files/safePath.ts"
import {
  accountEnv,
  accountMounts,
  diffScans,
  FILES_MOUNT,
  HOME_MOUNT,
  prepareAccount,
  resolveFilesPath,
  resolveToolPath,
  scanTree,
  SHARED_MOUNT,
  toolRoots,
  type AccountEnv,
  type Scan,
  type ToolRoot,
  type TreeChanges
} from "../../files/environment.ts"
import {
  selectSandbox,
  type CommandSandbox,
  type RunLimits,
  type RunResult,
  type SandboxMount
} from "../../sandbox/registry.ts"
import type { CommandOutputs } from "../../files/commandOutput.ts"
import type { HostFolders } from "../../files/hostFolders.ts"
import { QuotaExceeded, type FilesQuota } from "../../files/quota.ts"
import { sandboxPath } from "../../sandbox/linuxBwrap.ts"
import type { SubagentCopyRecord } from "../../db/subagents.ts"
import { COMMANDS_NETWORK, COMMANDS_UNSANDBOXED, resolveMode, type CapabilityRegistries } from "../capabilities.ts"
import { ToolInputRefused, type RolloutTool, type ToolContext, type ToolOutput } from "../tools.ts"

/** Where subagents' isolated copies go, under /files (spec/SUBAGENTS.md §3.3). */
const COPIES = ".subagents"

/**
 * Subagents' working folders (spec/SUBAGENTS.md §3.3), as the files host provides them: the
 * reply's folder now, and isolated copies made, made again and removed when unchanged.
 */
export interface SubagentWorkspaces {
  readonly id: string
  readonly folderOf: (ctx: ToolContext) => Effect.Effect<string, unknown>
  readonly makeCopy: (
    ctx: ToolContext,
    name: string,
    from: string
  ) => Effect.Effect<{ readonly copy: SubagentCopyRecord; readonly start: string }, unknown>
  readonly ensureCopy: (ctx: ToolContext, copy: SubagentCopyRecord) => Effect.Effect<SubagentCopyRecord, unknown>
  /** Whether the copy stays (it has changes, or couldn't be checked). */
  readonly finishCopy: (userId: string, copy: SubagentCopyRecord) => Effect.Effect<boolean>
}

export const FILE_TOOLS = [
  "read_file",
  "list_files",
  "search_files",
  "write_file",
  "edit_file",
  "bash",
  "bash_output",
  "bash_stop"
] as const

interface FileToolLimits {
  /** A foreground command's default and longest time (§5.1). */
  readonly defaultTimeoutMs: number
  readonly maxTimeoutMs: number
  readonly perAccount: number
  readonly perInstance: number
  readonly run: Omit<RunLimits, "timeoutMs">
}

const defaultFileToolLimits: FileToolLimits = {
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  perAccount: 4,
  perInstance: 16,
  run: {
    processes: 512,
    memoryBytes: 4 * 2 ** 30,
    fileBytes: 4 * 2 ** 30,
    openFiles: 4096,
    tmpBytes: 2 ** 30,
    // Until per-account quotas (§1.2): the disk the database shares is never filled by commands.
    reserve: { bytes: 2 * 2 ** 30, inodes: 100_000 }
  }
}

export interface FileToolDeps {
  readonly dataDir: string
  readonly filesDir: string
  readonly homesDir: string
  readonly reader: Reader["Service"]
  readonly writer: Writer["Service"]
  readonly registries: CapabilityRegistries
  readonly sandboxes: {
    readonly list: () => ReadonlyArray<CommandSandbox>
    readonly get: (id: string) => CommandSandbox | undefined
  }
  /** The instance's choice of sandbox (COMMAND_SANDBOX); absent: the first available. */
  readonly sandboxId?: string
  /** The account's Files quota (files/quota.ts); absent: none is enforced. */
  readonly quota?: FilesQuota
  /** Bytes held from the media sweep until their rows commit. */
  readonly holding: <A, E, R>(hashes: ReadonlyArray<string>, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly limits?: FileToolLimits
  /** The account's files changed (paths under /files), for open file managers; `all`: maybe any. */
  readonly onChanged?: (userId: string, paths: ReadonlyArray<string>, all?: boolean) => void
  /** The read-only copy of the app's source (files/appSource.ts), made on first use; null: none. */
  readonly appSource?: () => Promise<string | null>
  /** Folders on the server outside Files an admin may work in (files/hostFolders.ts, §3.7). */
  readonly hostFolders?: HostFolders
  /** ALLOW_UNSANDBOXED_COMMANDS: an admin's workshop may turn the sandbox off (§3.7). */
  readonly allowUnsandboxed?: boolean
  /** Where commands' whole output is kept (files/commandOutput.ts); absent: only the head and tail. */
  readonly outputs?: CommandOutputs
  /** Bytes a command moved over the internet, for the account's usage display. */
  readonly onNetwork?: (userId: string, bytes: number) => void
}

const READ_MAX_BYTES = 10 * 2 ** 20
const READ_LINES = 2000
const LINE_CHARS = 2000
const RESULT_CHARS = 30_000
const LIST_MAX = 500
const SEARCH_CHARS = 15_000
const VERSION_MAX_BYTES = 16 * 2 ** 20
const VERSIONS_PER_COMMAND = 256 * 2 ** 20
/** Background commands (§3.6): per account, per instance, and how long one may run. */
const BACKGROUND_PER_ACCOUNT = 4
const BACKGROUND_PER_INSTANCE = 16
const BACKGROUND_MS = 2 * 3600_000
/** What one bash_output call gives of a background command's new output. */
const SINCE_BYTES = 64 * 1024
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const isBinary = (bytes: Buffer) => bytes.subarray(0, 8192).includes(0)
const readKey = (full: string) => `files:read:${full}`
const CWD_KEY = "files:cwd"
/** The call's account, kept in the run's cache by `wrap` for the checks that need its role. */
const ACTOR_KEY = "files:actor"
const STORED_KEY = "files:stored"
type WorkshopFolderState = NonNullable<ChatState["workshopFolder"]>

const CWD_LINE = /\nDirectory after: (\/[^\n]*)/g

/** Head and tail of a long text, with what was left out between them. */
const headTail = (text: string, limit = RESULT_CHARS) => {
  if (text.length <= limit) return text
  const head = text.slice(0, Math.floor(limit / 2))
  const tail = text.slice(text.length - Math.floor(limit / 2))
  const left = text.slice(head.length, text.length - tail.length).split("\n").length - 1
  return `${head}\n… ${left.toLocaleString("en-US")} lines left out …\n${tail}`
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** A small glob: `*`, `**`, `?` and `{a,b}`, matched against a path relative to the listed folder. */
export const globToRegExp = (glob: string) => {
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"
        i += glob[i + 2] === "/" ? 2 : 1
      } else out += "[^/]*"
    } else if (c === "?") out += "[^/]"
    else if (c === "{") {
      const end = glob.indexOf("}", i)
      if (end < 0) out += "\\{"
      else {
        out += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((part) => part.replace(/[.+^${}()|[\]\\*?]/g, "\\$&"))
          .join("|")})`
        i = end
      }
    } else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${out}$`)
}

const refusedText = (error: unknown) =>
  error instanceof FilePathRefused || error instanceof ToolInputRefused || error instanceof QuotaExceeded
    ? error.message
    : (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "There's no such file or folder."
      : (error as NodeJS.ErrnoException)?.code === "EACCES"
        ? "The app can't open that."
        : "The file operation failed."

export const makeFileTools = (deps: FileToolDeps) => {
  const limits = deps.limits ?? defaultFileToolLimits
  const instance = Semaphore.makeUnsafe(limits.perInstance)
  const accounts = new Map<string, Semaphore.Semaphore>()
  const accountPermits = (userId: string) => {
    let semaphore = accounts.get(userId)
    if (!semaphore) accounts.set(userId, (semaphore = Semaphore.makeUnsafe(limits.perAccount)))
    return semaphore
  }
  // App-side writes and Undo of one account run one at a time, so a hash check holds until the write.
  const writeLocks = new Map<string, Semaphore.Semaphore>()
  const writeLock = (userId: string) => {
    let semaphore = writeLocks.get(userId)
    if (!semaphore) writeLocks.set(userId, (semaphore = Semaphore.makeUnsafe(1)))
    return semaphore
  }

  const attempt = <A>(f: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: f, catch: (error) => error })

  /** The app's source copy, when there is one (made on first use); never fails a tool. */
  const appSourceOf = () =>
    deps.appSource ? Effect.promise(() => deps.appSource!().catch(() => null)) : Effect.succeed(null)
  /**
   * Folders other accounts shared with this one, each with where it appears
   * (/files/Shared/<owner>/<folder>, " (2)" for a second of the same name) and its components in
   * its owner's Files. Shares whose owner name or path can't be a path are left out.
   */
  const sharesOf = (userId: string) =>
    deps.reader.FileSharesGrantedTo({ userId: userId as never }).pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((shares) => {
        const taken = new Set<string>()
        return shares.flatMap((share) => {
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(share.ownerHandle) || /^\.+$/.test(share.ownerHandle)) return []
          let segments: ReadonlyArray<string>
          try {
            segments = segmentsOf(share.path.replace(/^\/files(?=\/|$)/, ""))
          } catch {
            return []
          }
          if (segments.length === 0) return []
          const name = segments.at(-1)!
          let target = `${SHARED_MOUNT}/${share.ownerHandle}/${name}`
          for (let n = 2; taken.has(target); n++) target = `${SHARED_MOUNT}/${share.ownerHandle}/${name} (${n})`
          taken.add(target)
          return [{ share, segments, target, ownerRoot: accountEnv(deps, share.ownerId).filesRoot }]
        })
      })
    )
  /** The branch's stored working folder (`workshop.folder`), read once per run. */
  const storedFolder = (ctx: ToolContext) =>
    Effect.gen(function* () {
      if (ctx.cache.has(STORED_KEY)) return ctx.cache.get(STORED_KEY) as WorkshopFolderState | null
      const events = yield* deps.reader
        .StateEventsAt({ userId: ctx.userId, chatId: ctx.chatId, slotId: ctx.leafSlotId, forkId: ctx.forkId })
        .pipe(Effect.orElseSucceed(() => []))
      const folder = foldState(events).workshopFolder ?? null
      ctx.cache.set(STORED_KEY, folder)
      return folder
    })
  /**
   * The workshop's host folder (§3.7), checked again at every call: the account is an admin, the
   * folder is still under HOST_FOLDERS, its path has no link, and it's the folder chosen (its
   * inode). Null otherwise: the tools then work in Files only.
   */
  const hostPlace = (ctx: ToolContext) =>
    Effect.gen(function* () {
      const actor = ctx.cache.get(ACTOR_KEY) as User | undefined
      if (!deps.hostFolders || actor?.role !== "admin") return null
      const stored = yield* storedFolder(ctx)
      if (!stored?.host) return null
      const checked = yield* Effect.promise(() => deps.hostFolders!.check(stored.path).catch(() => null))
      if (!checked || (stored.inode !== null && checked.inode !== stored.inode)) return null
      return { path: checked.path, segments: checked.path.split("/").filter(Boolean) }
    })
  /** The file tools' roots: the account's Files, the app's source, shared folders (read-only), a host folder. */
  const rootsOf = (env: AccountEnv, ctx: ToolContext) =>
    Effect.gen(function* () {
      const source = yield* appSourceOf()
      const shares = yield* sharesOf(env.userId)
      const host = yield* hostPlace(ctx)
      return [
        ...toolRoots(env, source),
        ...(host
          ? [{ mount: host.path, hostRoot: "/", base: host.segments, writable: true, host: true } as ToolRoot]
          : []),
        ...shares.map(({ target, ownerRoot, segments }): ToolRoot => ({
          mount: target,
          hostRoot: ownerRoot,
          base: segments,
          writable: false
        }))
      ]
    })
  /** A path the file tools may change: in a writable root (the app's source is read-only). */
  const writablePath = (input: string, cwd: string, roots: ReadonlyArray<ToolRoot>) => {
    const resolved = resolveToolPath(input, cwd, roots)
    if (resolved.root.mount.startsWith(`${SHARED_MOUNT}/`))
      throw new FilePathRefused(
        `${resolved.root.mount} is shared with you by another account: the file tools only read it. Change it with bash if it's shared with you to edit.`
      )
    if (!resolved.root.writable)
      throw new FilePathRefused(`${resolved.root.mount} is read-only. Write your changes under ${FILES_MOUNT}.`)
    if (resolved.root.mount !== FILES_MOUNT && !resolved.root.host)
      throw new FilePathRefused(`${resolved.full} can't be changed here.`)
    return resolved
  }

  /** The capability's standing, checked again at the call; the account; its folders made. */
  const proof = (ctx: ToolContext, capability: string) =>
    Effect.gen(function* () {
      const actor = yield* deps.reader.AuthorizePluginTool({
        userId: ctx.userId,
        rolloutId: ctx.rolloutId,
        toolCallId: ctx.toolCallId,
        capability,
        requireApproval: false,
        ...(ctx.approvalDigest ? { digest: ctx.approvalDigest } : {})
      })
      const env = accountEnv(deps, actor.id)
      yield* attempt(() => prepareAccount(env))
      return { actor, env }
    })

  /**
   * A folder of the account's Files, by its /files path: resolved by name (never above /files)
   * and checked with the no-follow walk, so a link anywhere on the way is refused.
   */
  const folderAt = (env: AccountEnv, path: string) =>
    Effect.gen(function* () {
      const { full, segments } = yield* Effect.try({ try: () => resolveFilesPath(path, FILES_MOUNT), catch: (e) => e })
      const info = yield* attempt(() => statPath(env.filesRoot, segments))
      if (!info?.isDirectory()) return yield* Effect.fail(new FilePathRefused(`${full} isn't a folder any more.`))
      return full
    })

  /**
   * A file tool's path, by the same roots as the workshop's (spec/SUBAGENTS.md §3.3): a subagent
   * working in a copy writes only inside it, and of the account's own Files reads only it; the
   * other roots (the app's source, folders shared with the account, a host folder) it reads as
   * the workshop does.
   */
  const resolveIn = (
    ctx: ToolContext,
    input: string,
    cwd: string,
    roots: ReadonlyArray<ToolRoot>,
    write = false
  ) => {
    const resolved = write ? writablePath(input, cwd, roots) : resolveToolPath(input, cwd, roots)
    const root = ctx.workspace?.root
    if (
      root !== undefined &&
      (write || resolved.root.mount === FILES_MOUNT) &&
      resolved.full !== root &&
      !resolved.full.startsWith(`${root}/`)
    )
      throw new FilePathRefused(`${resolved.full} is outside your copy (${root}). Work on the files there.`)
    return resolved
  }

  /**
   * Where this call starts: the directory the run's last command ended in (kept in the run, and
   * read back from the transcript after a Resume), else the branch's working folder.
   */
  const currentDir = (ctx: ToolContext, env: AccountEnv) =>
    Effect.gen(function* () {
      const kept = ctx.cache.get(CWD_KEY)
      if (typeof kept === "string") return kept
      const transcript = ctx.transcript?.() ?? []
      for (let i = transcript.length - 1; i >= 0; i--) {
        const message = transcript[i] as { role?: string; toolName?: string; content?: unknown }
        if (message.role !== "toolResult" || message.toolName !== "bash" || !Array.isArray(message.content)) continue
        const text = message.content.map((part: { text?: string }) => part.text ?? "").join("")
        const found = [...text.matchAll(CWD_LINE)].at(-1)?.[1]
        if (found) {
          ctx.cache.set(CWD_KEY, found)
          return found
        }
      }
      // A subagent starts in its working folder (spec/SUBAGENTS.md §3.3): its copy, which must
      // still be a folder of the user's Files (no link on the way), or the reply's folder.
      const workspace = ctx.workspace
      if (workspace) {
        if (workspace.root !== undefined) yield* folderAt(env, workspace.root)
        const start = yield* folderAt(env, workspace.start).pipe(
          Effect.catch((error) => (workspace.root === undefined ? Effect.succeed(null) : Effect.fail(error)))
        )
        if (start !== null) {
          ctx.cache.set(CWD_KEY, start)
          return start
        }
      }
      const folder = yield* storedFolder(ctx)
      // A host folder still allowed (§3.7); one of Files found again after a move or rename
      // (workingFolder.ts); a folder that's gone: the top of Files (§2.2).
      const host = folder?.host ? yield* hostPlace(ctx) : null
      const moves =
        folder && !folder.host
          ? (yield* deps.reader
              .WorkshopFolderMemory({ userId: ctx.userId, cardId: null })
              .pipe(Effect.orElseSucceed(() => ({ moves: [] })))).moves
          : []
      const start = folder?.host
        ? (host?.path ?? FILES_MOUNT)
        : folder
          ? ((yield* Effect.promise(() => locateFolder(env.filesRoot, folder, moves).catch(() => null))) ?? FILES_MOUNT)
          : FILES_MOUNT
      ctx.cache.set(CWD_KEY, start)
      return start
    })

  /** Stores bytes as a file version: the media file first, then its row, held from the sweep. */
  const keepVersion = (
    ctx: { readonly rolloutId: string; readonly toolCallId: string } | null,
    userId: string,
    path: string,
    content: { readonly bytes: Uint8Array; readonly inode: number | null } | null,
    origin: string
  ) =>
    Effect.gen(function* () {
      const hash = content ? sha256(content.bytes) : null
      if (hash && content) yield* attempt(() => Effect.runPromise(storeMedia(deps.dataDir, hash, content.bytes)))
      const [id] = yield* deps.holding(
        hash ? [hash] : [],
        deps.writer.RecordFileVersions({
          userId: userId as never,
          versions: [
            {
              path,
              inode: content?.inode ?? null,
              sha256: hash,
              mime: "application/octet-stream",
              byteSize: content?.bytes.byteLength ?? 0,
              origin,
              ...(ctx ? { rolloutId: ctx.rolloutId, toolCallId: ctx.toolCallId } : {})
            }
          ]
        })
      )
      return id!
    })

  const wrap =
    (
      capability: string,
      run: (
        ctx: ToolContext,
        args: Record<string, unknown>,
        env: AccountEnv,
        actor: User
      ) => Effect.Effect<ToolOutput, unknown>
    ) =>
    (ctx: ToolContext, args: Record<string, unknown>): Effect.Effect<ToolOutput> =>
      proof(ctx, capability).pipe(
        Effect.flatMap(({ actor, env }) => {
          ctx.cache.set(ACTOR_KEY, actor)
          return run(ctx, args, env, actor)
        }),
        Effect.catchCause((cause) => {
          const reason = cause.reasons.find((r) => r._tag === "Fail" || r._tag === "Die")
          const value = reason?._tag === "Fail" ? reason.error : reason?._tag === "Die" ? reason.defect : undefined
          const tagged = value as { _tag?: string; message?: string } | undefined
          const text = tagged?._tag === "ApprovalRefused" ? String(tagged.message) : refusedText(value)
          return Effect.succeed<ToolOutput>({ isError: true, text })
        })
      )

  // --- read_file
  const readTool: RolloutTool<Record<string, unknown>> = {
    source: import.meta.url,
    id: "read_file",
    label: "Read a file",
    capability: "files",
    effect: "read",
    replyTool: false,
    storyRead: "account",
    titleField: "path",
    description:
      "Read a file in your files (/files), or in the app's source (/app-source, read-only), with line numbers. Paths are absolute (/files/...) or relative to the working directory. offset and limit are lines (default: the first 2000). Images come back as images when the model can see them; other binary files are described. Read a file before you change it with write_file or edit_file.",
    parameters: Type.Object(
      {
        path: Type.String({ maxLength: 4096 }),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20_000 }))
      },
      { additionalProperties: false }
    ),
    summarize: (args) => String(args.path ?? ""),
    execute: wrap("files", (ctx, args, env) =>
      Effect.gen(function* () {
        const cwd = yield* currentDir(ctx, env)
        const { full, root, segments } = resolveIn(ctx, String(args.path), cwd, yield* rootsOf(env, ctx))
        const { bytes, info, truncated } = yield* attempt(() =>
          readRegularFile(root.hostRoot, segments, READ_MAX_BYTES)
        )
        if (!truncated) ctx.cache.set(readKey(full), sha256(bytes))
        const extension = posix.extname(full).toLowerCase()
        const image = IMAGE_TYPES[extension]
        if (image && !truncated && bytes.byteLength <= 5 * 2 ** 20)
          return ctx.vision
            ? {
                text: `${full}: ${image}, ${info.size.toLocaleString("en-US")} bytes.`,
                images: [{ data: bytes.toString("base64"), mimeType: image }]
              }
            : { text: `${full}: ${image}, ${info.size.toLocaleString("en-US")} bytes. This model can't see images.` }
        if (isBinary(bytes))
          return {
            text: `${full}: a binary file (${extension || "no extension"}), ${info.size.toLocaleString("en-US")} bytes. Use bash to work with it.`
          }
        const lines = bytes.toString("utf8").split("\n")
        const from = Number(args.offset ?? 1)
        const count = Number(args.limit ?? READ_LINES)
        const shown = lines.slice(from - 1, from - 1 + count)
        const body = shown
          .map(
            (line, i) =>
              `${String(from + i).padStart(6)}\t${line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line}`
          )
          .join("\n")
        const rest = lines.length - (from - 1 + shown.length)
        return {
          text: headTail(
            `${full} (${lines.length.toLocaleString("en-US")} lines${truncated ? `, first ${READ_MAX_BYTES / 2 ** 20} MiB` : ""})\n${body}` +
              (rest > 0
                ? `\n[${rest.toLocaleString("en-US")} more lines: read on with offset=${from + shown.length}.]`
                : "")
          )
        }
      })
    )
  }

  // --- list_files
  const listTool: RolloutTool<Record<string, unknown>> = {
    source: import.meta.url,
    id: "list_files",
    label: "Listed files",
    capability: "files",
    effect: "read",
    replyTool: false,
    storyRead: "account",
    titleField: "path",
    description:
      "List a folder in your files (/files) or the app's source (/app-source): names, kinds, sizes and times, folders first. depth goes into subfolders (default 1, at most 6); glob filters by path relative to the folder (for example **/*.md). At most 500 entries. Links are shown, not followed.",
    parameters: Type.Object(
      {
        path: Type.Optional(Type.String({ maxLength: 4096 })),
        glob: Type.Optional(Type.String({ maxLength: 500 })),
        depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 }))
      },
      { additionalProperties: false }
    ),
    summarize: (args) => String(args.path ?? "."),
    execute: wrap("files", (ctx, args, env) =>
      Effect.gen(function* () {
        const cwd = yield* currentDir(ctx, env)
        const { full, root, segments } = resolveIn(ctx, String(args.path ?? "."), cwd, yield* rootsOf(env, ctx))
        const depth = Number(args.depth ?? 1)
        const pattern = typeof args.glob === "string" ? globToRegExp(args.glob) : null
        const found: Array<{ path: string; entry: Entry }> = []
        let more = false
        const walk = async (below: ReadonlyArray<string>, level: number): Promise<void> => {
          const listed = await listFolder(root.hostRoot, [...segments, ...below], LIST_MAX * 4)
          more ||= listed.more
          const sorted = [...listed.entries].sort(
            (a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name)
          )
          for (const entry of sorted) {
            if (found.length >= LIST_MAX) {
              more = true
              return
            }
            const path = [...below, entry.name].join("/")
            if (!pattern || pattern.test(path)) found.push({ path, entry })
            if (entry.kind === "folder" && level < depth) await walk([...below, entry.name], level + 1)
          }
        }
        yield* attempt(() => walk([], 1))
        const rows = found.map(
          ({ path, entry }) =>
            `${entry.kind === "folder" ? `${path}/` : path}\t${entry.kind}\t${entry.kind === "file" ? entry.size : ""}\t${new Date(entry.mtimeMs).toISOString()}`
        )
        return {
          text:
            `${full}${found.length === 0 ? ": nothing here" : ""}\n${rows.join("\n")}` +
            (more ? `\n[More entries than shown: narrow with path or glob.]` : "")
        }
      })
    )
  }

  /** The sandbox commands run in here, or why there is none. */
  const sandboxFor = (): Effect.Effect<CommandSandbox | string, unknown> =>
    attempt(() => selectSandbox(deps.sandboxes, deps.sandboxId)).pipe(
      Effect.map((selected) => ("sandbox" in selected ? selected.sandbox : selected.unavailable))
    )

  const commandEnv = (): Record<string, string> => ({
    PATH: sandboxPath(),
    HOME: HOME_MOUNT,
    USER: "user",
    LOGNAME: "user",
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    TERM: "dumb",
    TMPDIR: "/tmp",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_prefix: `${HOME_MOUNT}/.local`,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    PIP_DISABLE_PIP_VERSION_CHECK: "1"
  })

  // --- search_files
  const searchTool: RolloutTool<Record<string, unknown>> = {
    source: import.meta.url,
    id: "search_files",
    label: "Searched files",
    capability: "files",
    effect: "read",
    replyTool: false,
    storyRead: "account",
    titleField: "pattern",
    description:
      "Search the text of your files (/files) or the app's source (/app-source) with ripgrep: pattern is a regular expression. path narrows it to a folder or file, glob to file names (for example *.py), case: false ignores case, context adds lines around each match. At most 15000 characters.",
    parameters: Type.Object(
      {
        pattern: Type.String({ minLength: 1, maxLength: 1000 }),
        path: Type.Optional(Type.String({ maxLength: 4096 })),
        glob: Type.Optional(Type.String({ maxLength: 500 })),
        case: Type.Optional(Type.Boolean()),
        context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 }))
      },
      { additionalProperties: false }
    ),
    summarize: (args) => String(args.pattern ?? ""),
    execute: wrap("files", (ctx, args, env) =>
      Effect.gen(function* () {
        const cwd = yield* currentDir(ctx, env)
        const { full, root, segments } = resolveIn(ctx, String(args.path ?? "."), cwd, yield* rootsOf(env, ctx))
        const pattern = String(args.pattern)
        const selected = yield* sandboxFor()
        if (typeof selected !== "string") {
          const command = [
            "rg --line-number --no-heading --color never --max-columns 500 --max-count 100",
            args.case === false ? "-i" : "",
            args.context ? `-C ${Number(args.context)}` : "",
            typeof args.glob === "string" ? `-g ${shellQuote(args.glob)}` : "",
            `-e ${shellQuote(pattern)} -- ${shellQuote(full)}`
          ]
            .filter(Boolean)
            .join(" ")
          const setup = yield* commandSetup(ctx, env)
          const result = yield* attempt((signal) =>
            selected.run(
              {
                command,
                cwd: FILES_MOUNT,
                mounts: setup.mounts,
                env: commandEnv(),
                network: "none",
                limits: { ...limits.run, timeoutMs: 60_000 }
              },
              signal
            )
          ).pipe(Effect.ensuring(Effect.promise(() => setup.close())))
          if (result.exitCode === 0 || result.exitCode === 1) {
            const text = (result.head + result.tail).trim()
            return {
              text:
                text === ""
                  ? `No matches for ${pattern} in ${full}.`
                  : text.length > SEARCH_CHARS
                    ? `${text.slice(0, SEARCH_CHARS)}\n[Results cut at ${SEARCH_CHARS} characters: narrow the search.]`
                    : text
            }
          }
          if (result.exitCode !== 127)
            return { isError: true, text: headTail((result.head + result.tail).trim(), 2000) }
        }
        // Without ripgrep: a bounded literal search in the app.
        const needle = args.case === false ? pattern.toLowerCase() : pattern
        const matches: Array<string> = []
        const visit = async (below: ReadonlyArray<string>, budget: { files: number }): Promise<void> => {
          const listed = await listFolder(root.hostRoot, [...segments, ...below], 2000).catch(() => null)
          for (const entry of listed?.entries ?? []) {
            if (matches.length >= 30 || budget.files <= 0) return
            if (entry.kind === "folder") await visit([...below, entry.name], budget)
            else if (entry.kind === "file" && entry.size <= 2 ** 20) {
              budget.files--
              const read = await readRegularFile(root.hostRoot, [...segments, ...below, entry.name], 2 ** 20).catch(
                () => null
              )
              if (!read || isBinary(read.bytes)) continue
              read.bytes
                .toString("utf8")
                .split("\n")
                .forEach((line, i) => {
                  if (matches.length < 30 && (args.case === false ? line.toLowerCase() : line).includes(needle))
                    matches.push(`${posix.join(full, ...below, entry.name)}:${i + 1}:${line.slice(0, 500)}`)
                })
            }
          }
        }
        const info = yield* attempt(() => statPath(root.hostRoot, segments))
        if (info?.isFile()) {
          const read = yield* attempt(() => readRegularFile(root.hostRoot, segments, 2 ** 20))
          read.bytes
            .toString("utf8")
            .split("\n")
            .forEach((line, i) => {
              if (matches.length < 30 && (args.case === false ? line.toLowerCase() : line).includes(needle))
                matches.push(`${full}:${i + 1}:${line.slice(0, 500)}`)
            })
        } else yield* attempt(() => visit([], { files: 5000 }))
        return {
          text:
            matches.length === 0
              ? `No matches for the text ${pattern} in ${full} (searched as plain text: commands aren't available).`
              : `${matches.join("\n").slice(0, SEARCH_CHARS)}${matches.length >= 30 ? "\n[30 matches shown: narrow the search.]" : ""}`
        }
      })
    )
  }

  /** Writes `next` over a file read in this run (or a new one), keeping the earlier content. */
  const replaceFile = (
    ctx: ToolContext,
    env: AccountEnv,
    full: string,
    root: ToolRoot,
    segments: ReadonlyArray<string>,
    next: (before: Buffer | null) => Buffer,
    kind: "write" | "edit"
  ) =>
    Semaphore.withPermit(writeLock(env.userId))(
      Effect.gen(function* () {
        // A host folder (§3.7) has no quota; its changes are still versioned.
        const counted = root.host !== true
        const top = root.hostRoot
        const info = yield* attempt(() => statPath(top, segments))
        if (info && !info.isFile()) throw new FilePathRefused(`${full} isn't a regular file.`)
        let before: { bytes: Buffer; inode: number } | null = null
        if (info) {
          const read = yield* attempt(() => readRegularFile(top, segments, VERSION_MAX_BYTES + 1))
          if (read.truncated) throw new FilePathRefused(`${full} is too large to change with the file tools. Use bash.`)
          const seen = ctx.cache.get(readKey(full))
          if (seen === undefined) throw new FilePathRefused(`Read ${full} with read_file before changing it.`)
          if (seen !== sha256(read.bytes))
            throw new FilePathRefused(`${full} changed since you read it. Read it again before changing it.`)
          before = { bytes: read.bytes, inode: read.info.ino }
        } else if (kind === "edit") throw new FilePathRefused(`${full} doesn't exist. Create it with write_file.`)
        const content = next(before?.bytes ?? null)
        // The new content and the kept version both count against the quota.
        const adding = content.byteLength + (before?.bytes.byteLength ?? 0)
        if (deps.quota && counted) yield* deps.quota.check(env.userId, adding, "write files")
        const versionId = before ? yield* keepVersion(ctx, env.userId, full, before, "agent") : null
        const written = yield* attempt(() => writeRegularFile(top, segments, content, { createFolders: true }))
        if (counted) deps.quota?.wrote(env.userId, adding)
        deps.onChanged?.(env.userId, [full])
        const after = sha256(content)
        ctx.cache.set(readKey(full), after)
        const effectKind = before ? (kind === "edit" ? "file.edit" : "file.write") : "file.create"
        const effects: Array<RolloutEffectRecord> = [
          {
            kind: effectKind,
            targetKind: "file",
            targetId: full,
            title: `${before ? (kind === "edit" ? "Edited" : "Replaced") : "Created"} ${full}`,
            undo: { path: full, before: versionId, after, inode: written.ino, ...(root.host ? { host: true } : {}) }
          }
        ]
        return { before, written, effects }
      })
    )

  // --- write_file
  const writeTool: RolloutTool<Record<string, unknown>> = {
    source: import.meta.url,
    id: "write_file",
    label: "Wrote a file",
    capability: "files",
    effect: "files",
    replyTool: false,
    storyRead: "account",
    titleField: "path",
    description:
      "Create a file in your files (/files), or replace one you read in this run with read_file (it's refused if it changed since). Missing folders are made. Each change can be undone by the user. For small changes to an existing file, use edit_file.",
    parameters: Type.Object(
      { path: Type.String({ maxLength: 4096 }), content: Type.String({ maxLength: 8 * 2 ** 20 }) },
      { additionalProperties: false }
    ),
    summarize: (args) => String(args.path ?? ""),
    execute: wrap("files", (ctx, args, env) =>
      Effect.gen(function* () {
        const cwd = yield* currentDir(ctx, env)
        const { full, root, segments } = resolveIn(ctx, String(args.path), cwd, yield* rootsOf(env, ctx), true)
        const content = Buffer.from(String(args.content), "utf8")
        const done = yield* replaceFile(ctx, env, full, root, segments, () => content, "write")
        return {
          text: `${done.before ? "Replaced" : "Created"} ${full} (${content.byteLength.toLocaleString("en-US")} bytes).`,
          effects: done.effects
        }
      })
    )
  }

  // --- edit_file
  const editSchema = Type.Object(
    {
      old_string: Type.String({ maxLength: 2 ** 20 }),
      new_string: Type.String({ maxLength: 2 ** 20 }),
      replace_all: Type.Optional(Type.Boolean())
    },
    { additionalProperties: false }
  )
  const editTool: RolloutTool<Record<string, unknown>> = {
    source: import.meta.url,
    id: "edit_file",
    label: "Edited a file",
    capability: "files",
    effect: "files",
    replyTool: false,
    storyRead: "account",
    titleField: "path",
    description:
      "Change a file you read in this run with read_file: each old_string must match exactly once (or every time with replace_all) and is replaced by new_string. Give one edit, or several in edits; all apply or none do. Each change can be undone by the user.",
    parameters: Type.Object(
      {
        path: Type.String({ maxLength: 4096 }),
        old_string: Type.Optional(Type.String({ maxLength: 2 ** 20 })),
        new_string: Type.Optional(Type.String({ maxLength: 2 ** 20 })),
        replace_all: Type.Optional(Type.Boolean()),
        edits: Type.Optional(Type.Array(editSchema, { minItems: 1, maxItems: 64 }))
      },
      { additionalProperties: false }
    ),
    summarize: (args) => String(args.path ?? ""),
    execute: wrap("files", (ctx, args, env) =>
      Effect.gen(function* () {
        const single = typeof args.old_string === "string" && typeof args.new_string === "string"
        if (Array.isArray(args.edits) === single)
          throw new ToolInputRefused("Give old_string and new_string, or edits, not both.")
        const edits = (
          single
            ? [{ old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all }]
            : args.edits
        ) as ReadonlyArray<{ old_string: string; new_string: string; replace_all?: boolean }>
        const cwd = yield* currentDir(ctx, env)
        const { full, root, segments } = resolveIn(ctx, String(args.path), cwd, yield* rootsOf(env, ctx), true)
        let replaced = 0
        const done = yield* replaceFile(
          ctx,
          env,
          full,
          root,
          segments,
          (before) => {
            let text = before!.toString("utf8")
            for (const [index, edit] of edits.entries()) {
              const label = edits.length > 1 ? `Edit ${index + 1}: ` : ""
              if (edit.old_string === "") throw new FilePathRefused(`${label}old_string is empty.`)
              const count = text.split(edit.old_string).length - 1
              if (count === 0) {
                const crlf =
                  text.includes("\r\n") && edit.old_string.includes("\n") && !edit.old_string.includes("\r\n")
                throw new FilePathRefused(
                  `${label}old_string isn't in ${full}; nothing was changed.${crlf ? " The file uses CRLF line endings: include \\r\\n." : ""}`
                )
              }
              if (count > 1 && !edit.replace_all)
                throw new FilePathRefused(
                  `${label}old_string matches ${count} times in ${full}; add context to make it unique, or set replace_all. Nothing was changed.`
                )
              text = edit.replace_all
                ? text.split(edit.old_string).join(edit.new_string)
                : text.replace(edit.old_string, () => edit.new_string)
              replaced += edit.replace_all ? count : 1
            }
            return Buffer.from(text, "utf8")
          },
          "edit"
        )
        return { text: `Edited ${full}: ${replaced} replacement${replaced === 1 ? "" : "s"}.`, effects: done.effects }
      })
    )
  }

  /** A tree whose changes a command's scan lists (§7.2): the account's Files. */
  interface ScanPlace {
    readonly root: string
    /** How the agent names its top: /files, or a host folder's real path. */
    readonly prefix: string
    /** Where its files are read from by the no-follow walk, when not `root`: "/" and the components. */
    readonly walk?: { readonly root: string; readonly base: ReadonlyArray<string> }
  }
  interface PlaceChanges {
    readonly place: ScanPlace
    readonly changes: TreeChanges
  }
  const scanPlaces = (places: ReadonlyArray<ScanPlace>) =>
    Effect.forEach(places, (place) => attempt(() => scanTree(place.root)).pipe(Effect.map((scan) => ({ place, scan }))))
  const diffPlaces = (
    before: ReadonlyArray<{ place: ScanPlace; scan: Scan }>,
    after: ReadonlyArray<{ place: ScanPlace; scan: Scan }>
  ): ReadonlyArray<PlaceChanges> =>
    before.map((b, i) => ({ place: b.place, changes: diffScans(b.scan, after[i]!.scan) }))
  const allChanges = (found: ReadonlyArray<PlaceChanges>) => {
    const full = (place: ScanPlace, paths: ReadonlyArray<string>) => paths.map((p) => `${place.prefix}/${p}`)
    return {
      changed: found.flatMap(({ place, changes }) => full(place, changes.changed)),
      created: found.flatMap(({ place, changes }) => full(place, changes.created)),
      deleted: found.flatMap(({ place, changes }) => full(place, changes.deleted)),
      partial: found.some(({ changes }) => changes.partial)
    }
  }

  /** Stores the new content of what a command changed (§7.2), within the per-command budget. */
  const keepCommandVersions = (
    call: { readonly rolloutId: string; readonly toolCallId: string },
    userId: string,
    found: ReadonlyArray<PlaceChanges>
  ) =>
    Effect.gen(function* () {
      // Versions go to the media store on the data folder's disk: none past its reserve either.
      const reserve = limits.run.reserve
      const free = reserve
        ? yield* attempt(() => statfs(deps.dataDir)).pipe(
            Effect.map((fs) => fs.bavail * fs.bsize - reserve.bytes),
            Effect.orElseSucceed(() => 0)
          )
        : Infinity
      let budget = Math.min(VERSIONS_PER_COMMAND, Math.max(0, free))
      for (const { place, changes } of found) {
        for (const path of [...changes.changed, ...changes.created]) {
          const read = yield* attempt(() =>
            readRegularFile(
              place.walk?.root ?? place.root,
              [...(place.walk?.base ?? []), ...path.split("/")],
              VERSION_MAX_BYTES + 1
            )
          ).pipe(Effect.orElseSucceed(() => null))
          if (!read || read.truncated || read.bytes.byteLength > budget) continue
          budget -= read.bytes.byteLength
          yield* keepVersion(
            call,
            userId,
            `${place.prefix}/${path}`,
            { bytes: read.bytes, inode: read.info.ino },
            "command"
          ).pipe(Effect.ignore)
        }
        for (const path of changes.deleted)
          yield* keepVersion(call, userId, `${place.prefix}/${path}`, null, "command").pipe(Effect.ignore)
      }
    })

  /** Commands running per account (foreground and background), so Reset waits for none. */
  const running = new Map<string, number>()
  const busy = (userId: string, by: 1 | -1) => {
    const next = (running.get(userId) ?? 0) + by
    if (next <= 0) running.delete(userId)
    else running.set(userId, next)
  }

  /**
   * Folders other accounts shared with this one (§1.4), each opened by the no-follow walk from its
   * owner's Files and bound by that descriptor at /files/Shared/<owner>/<folder>: read-only for
   * Can view, writable for Can edit. A share whose folder is gone, or was swapped for another
   * (its inode differs), is left out. `close` frees the descriptors after the run.
   */
  /** Accounts whose Shared mount point a command made, to be removed when none runs. */
  const madeShared = new Set<string>()
  const sharedPlaces = (userId: string) =>
    Effect.gen(function* () {
      const handles: Array<FileHandle> = []
      const mounts: Array<SandboxMount> = []
      for (const { share, segments, target, ownerRoot } of yield* sharesOf(userId)) {
        const dir = yield* Effect.promise(() => openFolder(ownerRoot, segments).catch(() => null))
        if (!dir) continue
        const info = yield* Effect.promise(() => dir.stat().catch(() => null))
        if (!info || (share.inode !== null && info.ino !== share.inode)) {
          yield* Effect.promise(() => dir.close().catch(() => undefined))
          continue
        }
        handles.push(dir)
        mounts.push({ source: "", target, writable: share.mode === "edit", fd: dir.fd })
      }
      // The shared folders sit in a small empty folder of their own. Its mount point is the only
      // thing made in Files, and it goes again once no command of the account runs.
      const root = accountEnv(deps, userId).filesRoot
      if (mounts.length > 0 && !(yield* Effect.promise(() => statPath(root, ["Shared"]).catch(() => null))))
        madeShared.add(userId)
      if (mounts.length) mounts.unshift({ source: "", target: SHARED_MOUNT, writable: false, empty: true })
      return {
        mounts: mounts as ReadonlyArray<SandboxMount>,
        close: async () => {
          await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)))
          // rmdir refuses a folder with anything in it, and a link.
          if (madeShared.has(userId) && (running.get(userId) ?? 0) === 0) {
            madeShared.delete(userId)
            await rmdir(join(root, "Shared")).catch(() => undefined)
          }
        }
      }
    })

  /** The outcome line of a command's result. */
  const statusOf = (result: RunResult, timeoutMs: number) =>
    result.diskLow
      ? "stopped: the server's disk is almost full, so commands can't write more now. Delete files you don't need, or ask the server's admin."
      : result.memoryCapped
        ? `stopped: the command used more than ${limits.run.memoryBytes / 2 ** 30} GiB of memory`
        : result.timedOut
          ? `stopped after ${timeoutMs} ms (timeout)`
          : result.outputCapped
            ? "stopped: the command wrote more than 256 MiB of output (redirect it to a file instead)"
            : `exit: ${result.exitCode === null ? "killed" : result.exitCode}`
  const failed = (result: RunResult) =>
    result.timedOut ||
    result.outputCapped ||
    result.diskLow === true ||
    result.memoryCapped === true ||
    result.exitCode !== 0
  const countsOf = (changes: ReturnType<typeof allChanges>) =>
    [
      changes.changed.length ? `${changes.changed.length} changed` : "",
      changes.deleted.length ? `${changes.deleted.length} deleted` : "",
      changes.created.length ? `${changes.created.length} created` : ""
    ].filter(Boolean)
  const changesText = (changes: ReturnType<typeof allChanges>) => {
    const listed = [
      ...changes.changed.map((p) => `changed ${p}`),
      ...changes.created.map((p) => `created ${p}`),
      ...changes.deleted.map((p) => `deleted ${p}`)
    ]
    return listed.length
      ? `Files changed: ${countsOf(changes).join(", ")}${changes.partial ? " (many files changed; not all are listed)" : ""}\n${listed.slice(0, 50).join("\n")}${listed.length > 50 ? `\n… ${listed.length - 50} more` : ""}\n`
      : ""
  }

  /** What the app does after any command: tell open file managers, keep versions, measure, count the internet. */
  const afterCommand = (
    call: { readonly rolloutId: string; readonly toolCallId: string },
    userId: string,
    result: RunResult,
    found: ReadonlyArray<PlaceChanges>
  ) =>
    Effect.gen(function* () {
      const changes = allChanges(found)
      deps.onChanged?.(userId, [...changes.changed, ...changes.created, ...changes.deleted], changes.partial)
      yield* keepCommandVersions(call, userId, found)
      if (result.networkBytes) deps.onNetwork?.(userId, result.networkBytes)
      // Commands can't be stopped mid-write by a quota: measured after, and the next refused.
      const overQuota = deps.quota
        ? yield* deps.quota.afterCommand(userId).pipe(Effect.orElseSucceed(() => null))
        : null
      return { changes, overQuota }
    })

  /** Everything a command runs with for this account: its folders, shared folders and the app's source. */
  /**
   * Without a sandbox (§3.7): checked at every command, whatever the grant says: the server
   * allows it (ALLOW_UNSANDBOXED_COMMANDS), the account is an admin, the workshop turned it on,
   * and the `none` sandbox is registered.
   */
  const unsandboxedFor = (ctx: ToolContext) =>
    Effect.gen(function* () {
      const actor = ctx.cache.get(ACTOR_KEY) as User | undefined
      if (deps.allowUnsandboxed !== true || actor?.role !== "admin") return null
      const grants = new Map(
        (yield* deps.reader.WorkshopGrants({ userId: ctx.userId, chatId: ctx.chatId, now: Date.now() })).map((g) => [
          g.capability,
          g.mode
        ])
      )
      if (resolveMode(deps.registries, grants, COMMANDS_UNSANDBOXED, "outside") !== "allow") return null
      return deps.sandboxes.list().find((sandbox) => sandbox.unsandboxed) ?? null
    })
  const commandSetup = (ctx: ToolContext, env: AccountEnv) =>
    Effect.gen(function* () {
      const grants = new Map(
        (yield* deps.reader.WorkshopGrants({ userId: ctx.userId, chatId: ctx.chatId, now: Date.now() })).map((g) => [
          g.capability,
          g.mode
        ])
      )
      const network: "public" | "none" =
        resolveMode(deps.registries, grants, COMMANDS_NETWORK, "outside") === "allow" ? "public" : "none"
      const source = yield* appSourceOf()
      const shared = yield* sharedPlaces(env.userId)
      // The workshop's host folder (§3.7): opened by the no-follow walk, checked by its inode,
      // bound by that descriptor at its real path, writable.
      const host = yield* hostPlace(ctx)
      const hostDir = host ? yield* Effect.promise(() => openFolder("/", host.segments).catch(() => null)) : null
      const hostInfo = hostDir ? yield* Effect.promise(() => hostDir.stat().catch(() => null)) : null
      const hostMount: ReadonlyArray<SandboxMount> =
        host && hostDir && hostInfo ? [{ source: host.path, target: host.path, writable: true, fd: hostDir.fd }] : []
      return {
        network,
        mounts: [...accountMounts(env, source), ...shared.mounts, ...hostMount],
        places: [
          { root: env.filesRoot, prefix: FILES_MOUNT },
          ...(hostMount.length
            ? [{ root: host!.path, prefix: host!.path, walk: { root: "/", base: host!.segments } }]
            : [])
        ] as ReadonlyArray<ScanPlace>,
        close: async () => {
          await hostDir?.close().catch(() => undefined)
          await shared.close()
        }
      }
    })

  // Background commands (§3.6, §5.1): children of the app, stopped after 2 hours, by bash_stop,
  // or with the app. Their output is read from the kept output as they run.
  interface Job {
    readonly id: string
    readonly userId: string
    readonly command: string
    readonly cwd: string
    readonly startedAt: number
    /** The Changes rows' target kind: `command`, or `command.unsandboxed`. */
    readonly kind: string
    readonly controller: AbortController
    /** Bytes of its output already given to the agent. */
    cursor: number
    /** The end, once it ended. */
    ended: { readonly at: number; readonly text: string; readonly failed: boolean } | null
    readonly done: Promise<void>
  }
  const jobs = new Map<string, Job>()
  const jobsOf = (userId: string) => [...jobs.values()].filter((job) => job.userId === userId && job.ended === null)
  const runningJobs = () => [...jobs.values()].filter((job) => job.ended === null)

  // --- bash
  const bashTool: RolloutTool<Record<string, unknown>> = {
    source: import.meta.url,
    id: "bash",
    label: "Ran a command",
    capability: "commands",
    effect: "outside",
    replyTool: false,
    storyRead: "account",
    titleField: "description",
    description: [
      "Run a bash command in a sandbox. It sees your files at /files (read and write), its own home folder at /home/user (kept between runs: pip install --user and npm install -g go there), a private /tmp, and the app's source for this version at /app-source (read-only: SOURCE.md says what it holds). Folders other accounts shared with you are at /files/Shared/<owner>/<folder> (read-only unless shared to edit). Nothing else of the server is there.",
      "Available: bash and the usual command-line tools, git, python3, node and npm, and rg where the server has them; no system package manager (apt) and no root.",
      "The working directory carries over between calls in this run (cd works); each new message starts in the working folder. timeout_ms defaults to 120000 (at most 600000); then the command and everything it started are stopped.",
      "run_in_background: true starts it and returns at once with its id; read what it writes with bash_output and stop it with bash_stop (it's stopped after 2 hours). Use it for servers, watchers and long builds. At most 4 run in the background at once.",
      "Network: when Internet from commands is on, HTTP and HTTPS reach public internet addresses through a proxy (curl, git clone https://…, pip, npm work); this server, the local network and other machines can't be reached, and raw TCP, UDP and SSH don't work.",
      "The result has the exit code, the directory after the call and the output (long output keeps its start and end; the whole output is kept, and bash_output pages through it). Files the command changed are listed; they can't be undone, so be careful with rm."
    ].join(" "),
    parameters: Type.Object(
      {
        command: Type.String({ minLength: 1, maxLength: 100_000 }),
        description: Type.Optional(Type.String({ maxLength: 200 })),
        timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600_000 })),
        cwd: Type.Optional(Type.String({ maxLength: 4096 })),
        run_in_background: Type.Optional(Type.Boolean())
      },
      { additionalProperties: false }
    ),
    summarize: (args) => String(args.description ?? args.command ?? "").slice(0, 120),
    describe: (_ctx, args) =>
      Effect.succeed({
        title: args.run_in_background === true ? "Start this command in the background?" : "Run this command?",
        rows: [
          { label: "Command", value: String(args.command ?? "") },
          ...(args.cwd ? [{ label: "In", value: String(args.cwd) }] : [])
        ]
      }),
    execute: wrap("commands", (ctx, args, env) =>
      Effect.gen(function* () {
        const none = yield* unsandboxedFor(ctx)
        const selected = none ?? (yield* sandboxFor())
        if (typeof selected === "string")
          return { isError: true, text: `Commands can't run here: ${selected} The file tools still work.` }
        // The Changes row marks a command run without a sandbox.
        const commandKind = none ? "command.unsandboxed" : "command"
        const background = args.run_in_background === true
        if (background && !deps.outputs)
          return { isError: true, text: "Commands can't run in the background here. Run it in the foreground." }
        if (background && jobsOf(env.userId).length >= BACKGROUND_PER_ACCOUNT)
          return {
            isError: true,
            text: `${BACKGROUND_PER_ACCOUNT} commands are already running in the background. Stop one with bash_stop first.`
          }
        if (background && runningJobs().length >= BACKGROUND_PER_INSTANCE)
          return {
            isError: true,
            text: "This server is running as many background commands as it can. Try again later."
          }
        const start = yield* currentDir(ctx, env)
        const cwd =
          typeof args.cwd === "string" && args.cwd.trim() !== "" ? posix.resolve(start, args.cwd.trim()) : start
        const timeoutMs = background
          ? BACKGROUND_MS
          : Math.min(Number(args.timeout_ms ?? limits.defaultTimeoutMs), limits.maxTimeoutMs)
        if (deps.quota) yield* deps.quota.check(env.userId, 0, "run commands")
        const setup = yield* commandSetup(ctx, env)
        const call = { rolloutId: ctx.rolloutId, toolCallId: ctx.toolCallId }
        const sink = deps.outputs ? yield* attempt(() => deps.outputs!.open(env.userId)) : null
        const spec = (signal: AbortSignal) =>
          selected.run(
            {
              command: String(args.command),
              cwd,
              mounts: setup.mounts,
              env: commandEnv(),
              network: setup.network,
              limits: { ...limits.run, timeoutMs },
              ...(sink ? { onOutput: sink.write } : {})
            },
            signal
          )
        const short = String(args.command).split("\n")[0]!.slice(0, 80)

        if (background) {
          const before = yield* scanPlaces(setup.places)
          const controller = new AbortController()
          busy(env.userId, 1)
          const job: Job = {
            id: sink!.id,
            userId: env.userId,
            command: String(args.command),
            cwd,
            startedAt: Date.now(),
            kind: commandKind,
            controller,
            cursor: 0,
            ended: null,
            done: spec(controller.signal)
              .then(async (result) => {
                await sink!.end(result.outputBytes)
                const after = await Effect.runPromise(scanPlaces(setup.places))
                const { changes, overQuota } = await Effect.runPromise(
                  afterCommand(call, env.userId, result, diffPlaces(before, after))
                )
                job.ended = {
                  at: Date.now(),
                  failed: failed(result),
                  text:
                    `${controller.signal.aborted ? "stopped with bash_stop" : result.timedOut ? "stopped after 2 hours" : statusOf(result, timeoutMs)}\nDirectory after: ${result.cwd ?? cwd}\n` +
                    changesText(changes) +
                    (overQuota ? `${overQuota}\n` : "")
                }
              })
              .catch(async () => {
                await sink!.end(sink!.kept()).catch(() => undefined)
                job.ended = { at: Date.now(), failed: true, text: "The command couldn't run.\n" }
              })
              .finally(() => {
                busy(env.userId, -1)
                void setup.close()
              })
          }
          jobs.set(job.id, job)
          return {
            text: `Started in the background as ${job.id}, in ${cwd}. Read what it writes with bash_output (id: ${job.id}); stop it with bash_stop. It's stopped after 2 hours.${setup.network === "none" ? "\nInternet from commands is off in this workshop." : ""}`,
            effects: [
              {
                kind: "shell.run",
                targetKind: commandKind,
                targetId: cwd,
                title: `Started \`${short}\` in the background in ${cwd}`,
                undo: null
              }
            ]
          }
        }

        const run = Effect.gen(function* () {
          const before = yield* scanPlaces(setup.places)
          busy(env.userId, 1)
          const result = yield* attempt((signal) => spec(signal)).pipe(
            Effect.ensuring(Effect.sync(() => busy(env.userId, -1)))
          )
          const after = yield* scanPlaces(setup.places)
          return { result, found: diffPlaces(before, after) }
        })
        const { result, found } = yield* Semaphore.withPermit(instance)(
          Semaphore.withPermit(accountPermits(env.userId))(run)
        ).pipe(Effect.ensuring(Effect.promise(() => setup.close())))
        if (sink) yield* Effect.promise(() => sink.end(result.outputBytes).catch(() => undefined))
        if (result.cwd) ctx.cache.set(CWD_KEY, result.cwd)
        const { changes, overQuota } = yield* afterCommand(call, env.userId, result, found)
        const output = result.tail === "" ? result.head : `${result.head}\n…\n${result.tail}`
        const shown = headTail(output)
        const cut = result.tail !== "" || shown.length < output.length
        const counts = countsOf(changes)
        const text =
          `${statusOf(result, timeoutMs)}\nDirectory after: ${result.cwd ?? cwd}\n` +
          changesText(changes) +
          (none
            ? `No sandbox: this ran directly on the server. /files is ${env.filesRoot} and /home/user is ${env.home} here.\n`
            : setup.network === "none"
              ? "Internet from commands is off in this workshop.\n"
              : "") +
          (overQuota ? `${overQuota}\n` : "") +
          `Output (${result.outputBytes.toLocaleString("en-US")} bytes${cut && sink ? `; the whole output is kept: bash_output id ${sink.id}` : ""}):\n${shown}`
        return {
          text,
          isError: failed(result),
          effects: [
            {
              kind: "shell.run",
              targetKind: commandKind,
              targetId: cwd,
              title: `Ran \`${short}\` in ${cwd}${counts.length ? `: ${counts.join(", ")}` : ""}`,
              undo: null
            }
          ]
        }
      })
    )
  }

  // --- bash_output
  const outputTool: RolloutTool<Record<string, unknown>> = {
    source: import.meta.url,
    id: "bash_output",
    label: "Read a command's output",
    capability: "commands",
    effect: "read",
    replyTool: false,
    storyRead: "account",
    titleField: "id",
    description:
      "Read a command's kept output by its id (from bash). For a background command, without offset: what it wrote since the last read, and whether it's still running (when it ended: its exit code and the files it changed). With offset (a line number, from 1) and limit (lines, default 400): that page of the whole output.",
    parameters: Type.Object(
      {
        id: Type.String({ maxLength: 64 }),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 }))
      },
      { additionalProperties: false }
    ),
    summarize: (args) => String(args.id ?? ""),
    execute: wrap("commands", (_ctx, args, env) =>
      Effect.gen(function* () {
        if (!deps.outputs) return { isError: true, text: "No output is kept here." }
        const id = String(args.id)
        const job = jobs.get(id)
        const own = job && job.userId === env.userId ? job : null
        const limit = Number(args.limit ?? 400)
        const state = own
          ? own.ended
            ? `ended ${Math.round((own.ended.at - own.startedAt) / 1000)} s after it started: ${own.ended.text.trimEnd()}`
            : `still running (for ${Math.round((Date.now() - own.startedAt) / 1000)} s)`
          : null
        if (own && args.offset === undefined) {
          // The rest only once it ended, so the end comes with its last output.
          if (own.ended === null)
            yield* Effect.promise(() => Promise.race([own.done, new Promise((r) => setTimeout(r, 1000))]))
          const read = yield* attempt(() => deps.outputs!.since(env.userId, id, own.cursor, SINCE_BYTES))
          if (read) own.cursor = read.next
          const text = read?.text ?? ""
          const more = read && read.next < read.size
          return {
            text:
              `${id}: ${state}\n` +
              (text === "" ? "No new output.\n" : `New output:\n${headTail(text)}${text.endsWith("\n") ? "" : "\n"}`) +
              (more ? "[More output follows: call bash_output again.]" : ""),
            isError: own.ended?.failed === true
          }
        }
        const page = yield* attempt(() => deps.outputs!.page(env.userId, id, Number(args.offset ?? 1), limit))
        if (!page) return { isError: true, text: `There's no kept output with the id ${id}. Output is kept for a day.` }
        const last = page.from + page.lines.length - 1
        return {
          text:
            `${id}${state ? `: ${state}` : ""}\nLines ${page.lines.length ? `${page.from}–${last}` : "none"} of ${page.totalLines.toLocaleString("en-US")}${page.cut ? " (the output was longer: only its first 16 MiB are kept)" : ""}:\n` +
            headTail(page.lines.join("\n")) +
            (last < page.totalLines ? `\n[Read on with offset=${last + 1}.]` : "")
        }
      })
    )
  }

  // --- bash_stop
  const stopTool: RolloutTool<Record<string, unknown>> = {
    source: import.meta.url,
    id: "bash_stop",
    label: "Stopped a command",
    capability: "commands",
    effect: "outside",
    replyTool: false,
    storyRead: "account",
    titleField: "id",
    description: "Stop a background command (from bash with run_in_background) by its id, with everything it started.",
    parameters: Type.Object({ id: Type.String({ maxLength: 64 }) }, { additionalProperties: false }),
    summarize: (args) => String(args.id ?? ""),
    describe: (_ctx, args) =>
      Effect.succeed({
        title: "Stop this background command?",
        rows: [{ label: "Command", value: String(args.id ?? "") }]
      }),
    execute: wrap("commands", (_ctx, args, env) =>
      Effect.gen(function* () {
        const id = String(args.id)
        const job = jobs.get(id)
        if (!job || job.userId !== env.userId)
          return {
            isError: true,
            text: `No background command has the id ${id}. Background commands end when the app restarts.`
          }
        if (job.ended) return { text: `${id} had already ended: ${job.ended.text.trimEnd()}` }
        job.controller.abort()
        yield* Effect.promise(() => Promise.race([job.done, new Promise((r) => setTimeout(r, 10_000))]))
        return {
          text: `Stopped ${id}.${job.ended ? `\n${(job.ended as { text: string }).text.trimEnd()}` : ""}`,
          effects: [
            {
              kind: "shell.run",
              targetKind: job.kind,
              targetId: job.cwd,
              title: `Stopped \`${job.command.split("\n")[0]!.slice(0, 80)}\``,
              undo: null
            }
          ]
        }
      })
    )
  }

  /** Puts a file back as it was before the agent's write or edit (§7.1), if it's still as the agent left it. */
  const undoEffect = (actor: User, effect: RolloutEffect) =>
    Effect.gen(function* () {
      if (effect.undoneAt !== null) return effect
      const recipe = effect.undo as { path?: unknown; before?: unknown; after?: unknown; host?: unknown } | null
      if (!recipe || typeof recipe.path !== "string" || typeof recipe.after !== "string")
        return yield* new EffectUndoRefused({ message: "This change cannot be undone." })
      const env = accountEnv(deps, actor.id)
      // A host folder's file (§3.7): only while the account is an admin and the folder is still
      // allowed; reached by the no-follow walk from "/".
      const host = recipe.host === true
      if (host) {
        const path = recipe.path
        const allowed =
          actor.role === "admin" &&
          deps.hostFolders !== undefined &&
          (yield* Effect.promise(() => deps.hostFolders!.allows(path).catch(() => false)))
        if (!allowed) return yield* new EffectUndoRefused({ message: "That folder on the server isn't available now." })
      }
      const top = host ? "/" : env.filesRoot
      const segments = host
        ? recipe.path.split("/").filter(Boolean)
        : resolveFilesPath(recipe.path, FILES_MOUNT).segments
      return yield* Semaphore.withPermit(writeLock(env.userId))(
        Effect.gen(function* () {
          const current = yield* attempt(() => readRegularFile(top, segments, VERSION_MAX_BYTES + 1)).pipe(
            Effect.orElseSucceed(() => null)
          )
          if (!current || current.truncated || sha256(current.bytes) !== recipe.after)
            return yield* new EffectUndoRefused({ message: "Changed since. Open its versions." })
          const replaced = yield* keepVersion(
            null,
            env.userId,
            recipe.path as string,
            { bytes: current.bytes, inode: current.info.ino },
            "restore"
          )
          // The kept version and the restored content count until the next measurement.
          if (!host) deps.quota?.wrote(env.userId, current.bytes.byteLength)
          if (typeof recipe.before === "string") {
            // A version past retention (30 days) is gone with its content.
            const version = yield* deps.reader
              .FileVersion({ userId: actor.id, id: recipe.before })
              .pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.fail(new EffectUndoRefused({ message: "Its earlier content is gone." }))
                )
              )
            if (!version.mediaPath || !isMediaPath(version.mediaPath))
              return yield* new EffectUndoRefused({ message: "Its earlier content is gone." })
            const bytes = yield* attempt(() => readFile(join(deps.dataDir, version.mediaPath!)))
            yield* attempt(() => writeRegularFile(top, segments, bytes))
            if (!host) deps.quota?.wrote(env.userId, bytes.byteLength)
          } else yield* attempt(() => removeFile(top, segments))
          deps.onChanged?.(env.userId, [recipe.path as string])
          return yield* deps.writer.CompleteFileUndo({
            userId: actor.id,
            rolloutId: effect.rolloutId,
            toolCallId: effect.toolCallId,
            seq: effect.seq,
            result: { restored: typeof recipe.before === "string" ? recipe.before : null, replaced }
          })
        })
      )
    })

  /** Why commands can't run here, for the capability row; null: they can. */
  const commandsUnavailable = () =>
    sandboxFor().pipe(
      Effect.map((selected) => (typeof selected === "string" ? selected : null)),
      Effect.orElseSucceed(() => "Commands can't run on this system yet.")
    )

  /** What the capability row adds where commands run with weaker limits; null: nothing. */
  const commandsNote = () =>
    sandboxFor().pipe(
      Effect.flatMap((selected) =>
        typeof selected === "string" || !selected.note ? Effect.succeed(null) : attempt(() => selected.note!())
      ),
      Effect.orElseSucceed(() => null)
    )

  // --- subagents' working folders (spec/SUBAGENTS.md §3.3). Copies are made, checked and removed
  // by commands in the sandbox, seeing the account's Files as commands do, so the app never walks
  // a tree a command could have planted links in; the app only checks, with the no-follow walk,
  // that the copy it hands the subagent is a folder of the user's Files. Hooks don't run.
  const GIT = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false"

  /** Runs one of the copies' scripts in the sandbox: its output lines; a failure says why. */
  const copyScript = (env: AccountEnv, script: string, timeoutMs: number) =>
    Effect.gen(function* () {
      const selected = yield* sandboxFor()
      if (typeof selected === "string")
        return yield* Effect.fail(new ToolInputRefused(`Copies need commands, which can't run here: ${selected}`))
      const result = yield* Semaphore.withPermit(instance)(
        Semaphore.withPermit(accountPermits(env.userId))(
          attempt((signal) =>
            selected.run(
              {
                command: script,
                cwd: FILES_MOUNT,
                mounts: accountMounts(env),
                env: commandEnv(),
                network: "none",
                limits: { ...limits.run, timeoutMs }
              },
              signal
            )
          )
        )
      )
      const lines = `${result.head}${result.tail}`.split("\n").map((line) => line.trim())
      return { ok: result.exitCode === 0 && !result.timedOut, lines }
    })

  const q = shellQuote

  /** The folder a subagent of this reply works in: the reply's own directory now (its last `cd`, else the working folder). */
  const folderOf = (ctx: ToolContext) =>
    Effect.gen(function* () {
      const env = accountEnv(deps, ctx.userId)
      yield* attempt(() => prepareAccount(env))
      return yield* currentDir(ctx, env)
    })

  /** Whether the workshop lets the app make a copy: its files and commands aren't Off. */
  const copiesAllowed = (ctx: ToolContext) =>
    Effect.gen(function* () {
      const grants = new Map(
        (yield* deps.reader.WorkshopGrants({ userId: ctx.userId, chatId: ctx.chatId, now: Date.now() })).map((g) => [
          g.capability,
          g.mode
        ])
      )
      for (const capability of ["files", "commands"])
        if (resolveMode(deps.registries, grants, capability, "outside") === "off")
          return yield* Effect.fail(
            new ToolInputRefused("Copies need Change your files and Run commands, and one of them is off here.")
          )
    })

  /** The copy made: checked to be a folder of the user's Files, and its bytes measured. */
  const madeCopy = (env: AccountEnv, copy: SubagentCopyRecord) =>
    Effect.gen(function* () {
      yield* folderAt(env, copy.path).pipe(
        Effect.mapError(() => new ToolInputRefused("The copy couldn't be made: its folder isn't there."))
      )
      if (deps.quota) yield* deps.quota.afterCommand(env.userId).pipe(Effect.ignore)
      return copy
    })

  /**
   * A copy of `from` for a subagent at /files/.subagents/<name>: a git worktree on the new branch
   * subagent/<name> when `from` is in a repository with a commit, else a file copy (the copies
   * folder left out). Within the Files quota, checked before it's made.
   */
  const makeCopy = (ctx: ToolContext, name: string, from: string) =>
    Effect.gen(function* () {
      if (!/^[a-z0-9][a-z0-9_-]{0,80}$/.test(name)) return yield* Effect.fail(new ToolInputRefused("Bad copy name."))
      yield* copiesAllowed(ctx)
      const env = accountEnv(deps, ctx.userId)
      yield* attempt(() => prepareAccount(env))
      const source = yield* folderAt(env, from)
      const path = `${FILES_MOUNT}/${COPIES}/${name}`
      const branch = `subagent/${name}`
      const probe = yield* copyScript(
        env,
        [
          `from=${q(source)}; dest=${q(path)}`,
          `if [ -L ${q(`${FILES_MOUNT}/${COPIES}`)} ]; then echo link; exit 0; fi`,
          `if [ -e "$dest" ] || [ -L "$dest" ]; then echo taken; exit 0; fi`,
          `if top=$(${GIT} -C "$from" rev-parse --show-toplevel 2>/dev/null) && base=$(${GIT} -C "$from" rev-parse --verify -q HEAD); then`,
          `  echo git; echo "$top"; echo "p:$(${GIT} -C "$from" rev-parse --show-prefix)"; echo "$base"`,
          `  ${GIT} -C "$top" ls-tree -r -l HEAD | awk '{ if ($4 ~ /^[0-9]+$/) s += $4 } END { print s + 0 }'`,
          `else echo files; du -sb --exclude=${COPIES} "$from" | cut -f1; fi`
        ].join("\n"),
        120_000
      )
      const [kind, ...rest] = probe.lines.filter((line) => line !== "")
      if (!probe.ok || (kind !== "git" && kind !== "files"))
        return yield* Effect.fail(
          new ToolInputRefused(
            kind === "taken"
              ? `${path} is already there.`
              : kind === "link"
                ? `${FILES_MOUNT}/${COPIES} is a link, so no copy goes there. Remove the link, then try again.`
                : "The copy couldn't be made."
          )
        )
      const isGit = kind === "git"
      const [top = "", marked = "", base = ""] = isGit ? rest : []
      const prefix = marked.replace(/^p:/, "")
      const bytes = Number(isGit ? rest[3] : rest[0])
      if (isGit && top !== FILES_MOUNT && !top.startsWith(`${FILES_MOUNT}/`))
        return yield* Effect.fail(
          new ToolInputRefused("The copy couldn't be made: its repository isn't in your files.")
        )
      if (deps.quota && Number.isFinite(bytes))
        yield* deps.quota.check(env.userId, bytes, "copy a folder for a subagent")
      const made = yield* copyScript(
        env,
        isGit
          ? `mkdir -p ${q(`${FILES_MOUNT}/${COPIES}`)} && ${GIT} -C ${q(top)} worktree add --quiet -b ${q(branch)} ${q(path)} ${q(base)}`
          : `mkdir -p ${q(path)} && tar -C ${q(source)} --exclude=./${COPIES} -cf - . | tar -C ${q(path)} -xf -`,
        600_000
      )
      if (!made.ok) {
        yield* removeCopy(env, { path, from: source, kind: isGit ? "git" : "files", ...(isGit ? { top, branch } : {}) })
        return yield* Effect.fail(new ToolInputRefused("The copy couldn't be made."))
      }
      const copy: SubagentCopyRecord = isGit
        ? { path, from: source, kind: "git", top, branch, base }
        : { path, from: source, kind: "files" }
      yield* madeCopy(env, copy)
      // It starts where the reply is, inside the copy.
      const start = isGit ? posix.join(path, prefix) : path
      return { copy, start: start.replace(/\/$/, "") }
    })

  /** Removes a copy outright (a git worktree with its branch), in the sandbox; true when it's gone. */
  const removeCopy = (env: AccountEnv, copy: SubagentCopyRecord) =>
    copyScript(
      env,
      [
        `dest=${q(copy.path)}`,
        copy.kind === "git" && copy.top && copy.branch
          ? `${GIT} -C ${q(copy.top)} worktree remove --force "$dest" 2>/dev/null; ${GIT} -C ${q(copy.top)} worktree prune; ${GIT} -C ${q(copy.top)} branch -D -q ${q(copy.branch)} 2>/dev/null`
          : "",
        `rm -rf -- "$dest"; rmdir ${q(`${FILES_MOUNT}/${COPIES}`)} 2>/dev/null; [ ! -e "$dest" ] && echo removed`
      ].join("\n"),
      120_000
    ).pipe(Effect.map((out) => out.lines.includes("removed")))

  /**
   * At a subagent's end: a copy with no changes is removed (a worktree whose status is clean and
   * whose branch didn't move; a file copy the same as its source); one with changes stays.
   * Returns whether it stays. A copy that can't be checked stays.
   */
  const finishCopy = (userId: string, copy: SubagentCopyRecord) =>
    Effect.gen(function* () {
      const env = accountEnv(deps, userId)
      const check = yield* copyScript(
        env,
        [
          `dest=${q(copy.path)}`,
          `if [ ! -d "$dest" ] || [ -L "$dest" ]; then echo gone; exit 0; fi`,
          copy.kind === "git"
            ? `st=$(${GIT} -C "$dest" status --porcelain --untracked-files=all) || { echo changed; exit 0; }\nhead=$(${GIT} -C "$dest" rev-parse HEAD) || { echo changed; exit 0; }\nif [ -z "$st" ] && [ "$head" = ${q(copy.base ?? "")} ]; then echo same; else echo changed; fi`
            : `if diff -rq --no-dereference -x ${COPIES} ${q(copy.from)} "$dest" >/dev/null 2>&1; then echo same; else echo changed; fi`
        ].join("\n"),
        300_000
      )
      if (check.lines.includes("gone")) return false
      if (!check.ok || !check.lines.includes("same")) return true
      const removed = yield* removeCopy(env, copy)
      if (deps.quota) yield* deps.quota.afterCommand(env.userId).pipe(Effect.ignore)
      return !removed
    }).pipe(Effect.orElseSucceed(() => true))

  /**
   * A copy for a run that carries a subagent on: the same folder when it's still there, else made
   * again at the same place (a worktree on its branch when that's still there, keeping its commits).
   */
  const ensureCopy = (ctx: ToolContext, copy: SubagentCopyRecord) =>
    Effect.gen(function* () {
      const env = accountEnv(deps, ctx.userId)
      yield* attempt(() => prepareAccount(env))
      const there = yield* folderAt(env, copy.path).pipe(Effect.option)
      if (there._tag === "Some") {
        const { kept: _kept, ...rest } = copy
        return rest
      }
      yield* copiesAllowed(ctx)
      if (copy.kind === "files" || !copy.top || !copy.branch) {
        const name = copy.path.slice(`${FILES_MOUNT}/${COPIES}/`.length)
        return (yield* makeCopy(ctx, name, copy.from)).copy
      }
      const made = yield* copyScript(
        env,
        [
          `top=${q(copy.top)}; dest=${q(copy.path)}; branch=${q(copy.branch)}`,
          `mkdir -p ${q(`${FILES_MOUNT}/${COPIES}`)} && ${GIT} -C "$top" worktree prune || exit 1`,
          `if ${GIT} -C "$top" rev-parse --verify -q "refs/heads/$branch" >/dev/null; then ${GIT} -C "$top" worktree add --quiet "$dest" "$branch" || exit 1; echo kept`,
          `else ${GIT} -C "$top" worktree add --quiet -b "$branch" "$dest" ${q(copy.base ?? "HEAD")} || exit 1; echo made; fi`
        ].join("\n"),
        600_000
      )
      if (!made.ok || !made.lines.some((line) => line === "kept" || line === "made"))
        return yield* Effect.fail(new ToolInputRefused("The copy couldn't be made again."))
      const { kept: _kept, ...again } = copy
      return yield* madeCopy(env, again)
    })

  const workspaces: SubagentWorkspaces = {
    id: "files",
    folderOf,
    makeCopy,
    ensureCopy,
    finishCopy
  }

  /**
   * A command of the app's own in the account's sandbox, offline and short (a new plugin working
   * copy's `git init`); without a sandbox, nothing runs.
   */
  const runQuiet = async (userId: string, command: string, cwd: string) => {
    const selected = await selectSandbox(deps.sandboxes, deps.sandboxId)
    if (!("sandbox" in selected)) return null
    const env = accountEnv(deps, userId)
    await prepareAccount(env)
    const source = deps.appSource ? await deps.appSource().catch(() => null) : null
    return selected.sandbox.run(
      {
        command,
        cwd,
        mounts: accountMounts(env, source),
        env: commandEnv(),
        network: "none",
        limits: { ...limits.run, timeoutMs: 60_000 }
      },
      AbortSignal.timeout(70_000)
    )
  }

  return {
    workspaces,
    keepVersion,
    runQuiet,
    /**
     * Empties the account's home folder for commands (§3.6 Reset); refused while one of its
     * commands runs. Its files stay.
     */
    resetHome: (userId: string) =>
      Effect.gen(function* () {
        if ((running.get(userId) ?? 0) > 0)
          return yield* Effect.fail(new FilePathRefused("Commands are running. Wait for them, or stop them, first."))
        const env = accountEnv(deps, userId)
        yield* attempt(() => prepareAccount(env))
        yield* attempt(async () => {
          const dir = await openFolder(env.home, [])
          try {
            for (const name of await readdir(`/proc/self/fd/${dir.fd}`)) await removeTreeAt(dir, name)
          } finally {
            await dir.close()
          }
        })
      }),
    /** Stops every background command (the app is stopping). */
    stopAll: () => {
      for (const job of runningJobs()) job.controller.abort()
    },
    tools: [
      readTool,
      listTool,
      searchTool,
      writeTool,
      editTool,
      bashTool,
      outputTool,
      stopTool
    ] as unknown as ReadonlyArray<RolloutTool<never>>,
    undoEffect,
    commandsUnavailable,
    commandsNote
  }
}
