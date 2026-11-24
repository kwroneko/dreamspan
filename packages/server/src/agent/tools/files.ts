// The workshop's file tools and commands (spec/FILES-AND-ENVIRONMENT.md §5.1, §5.2): registered
// by the files host (files/WorkshopFiles.ts), offered in standalone workshops. The file tools run
// in the app through the no-follow walk (files/safePath.ts) and reach /files only; `bash` runs in
// the selected command sandbox (sandbox/registry.ts). Every write and edit keeps the earlier
// content as a version and records a `file.*` effect with Undo; every command records a
// `shell.run` effect listing the files it changed, with no Undo. A call cut off without its
// receipt is never run again silently: the permit asks (agent/approvals.ts).
import { locateFolder } from "../../files/workingFolder.ts"
import { createHash } from "node:crypto"
import { isUtf8 } from "node:buffer"
import type { Stats } from "node:fs"
import { lstat, readFile, readdir, rmdir, statfs, type FileHandle } from "node:fs/promises"
import { join, posix } from "node:path"
import { Type } from "@earendil-works/pi-ai"
import { Effect, Exit, Scope, Semaphore } from "effect"
import { lockFileTrees, withFileTree } from "../../files/treeLocks.ts"
import type { User } from "@dreamspan/shared/domain.ts"
import { ATTACHMENT_COPY_ROOT } from "@dreamspan/shared/files.ts"
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
import { OUTPUT_KEEP_MS } from "../../files/commandOutput.ts"
import { folderShareRefusal } from "../../files/pluginCopies.ts"
import { isSharedFolder, shareMountNames } from "../../files/sharedFolders.ts"
import { sandboxPath } from "../../sandbox/linuxBwrap.ts"
import { CommandRefused } from "../../sandbox/refused.ts"
import type { SubagentCopyRecord } from "../../db/subagents.ts"
import {
  COMMANDS_NETWORK,
  COMMANDS_UNSANDBOXED,
  consentTarget,
  resolveMode,
  type CapabilityRegistries
} from "../capabilities.ts"
import { forkStart } from "../messages.ts"
import { ToolInputRefused, type RolloutTool, type ToolContext, type ToolOutput } from "../tools.ts"
import type { Formats } from "../../importer/Formats.ts"
import { CARD_FILE_BYTES, makeCardFileTools } from "./cardFiles.ts"
import { visibleDoc } from "../libraryView.ts"
import {
  type ConflictChoice,
  matchesReversalHead,
  planGroupedReversal,
  type ReversalPatch,
  type ReversalPlan,
  unitPath
} from "@dreamspan/shared/changeReversal.ts"

/** Where subagents' isolated copies go, under /files (spec/SUBAGENTS.md §3.3). */
const COPIES = ".subagents"

/**
 * Subagents' working folders (spec/SUBAGENTS.md §3.3), as the files host provides them: the
 * reply's folder now, and isolated copies made, made again and removed when unchanged.
 */
/**
 * Asks the user whether a copy may be made (spec/SUBAGENTS.md §3.3): where Change your files or
 * Run commands is Ask first. It names what's copied, where to, and whether on a new git branch.
 */
export type ApproveCopy = (copy: {
  readonly path: string
  readonly from: string
  readonly branch?: string
  readonly again?: boolean
}) => Effect.Effect<boolean>

export interface SubagentWorkspaces {
  readonly id: string
  readonly folderOf: (ctx: ToolContext) => Effect.Effect<string, unknown>
  readonly makeCopy: (
    ctx: ToolContext,
    name: string,
    from: string,
    approve?: ApproveCopy
  ) => Effect.Effect<{ readonly copy: SubagentCopyRecord; readonly start: string }, unknown>
  readonly ensureCopy: (
    ctx: ToolContext,
    copy: SubagentCopyRecord,
    approve?: ApproveCopy,
    start?: string
  ) => Effect.Effect<{ readonly copy: SubagentCopyRecord; readonly start: string }, unknown>
  /** Whether the copy stays (it has changes, or couldn't be checked). */
  readonly finishCopy: (userId: string, copy: SubagentCopyRecord) => Effect.Effect<boolean>
}

export const FILE_TOOLS = [
  "read_file",
  "list_files",
  "search_files",
  "write_file",
  "edit_file",
  // A character card attached as a file (spec/WORKSHOP-CARDS.md §4.5, cardFiles.ts).
  "read_card_file",
  "edit_card_file",
  "import_card_file",
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
  /** Background commands (§3.6): per account, per instance, and how long one may run. */
  readonly backgroundPerAccount: number
  readonly backgroundPerInstance: number
  readonly backgroundMs: number
  readonly run: Omit<RunLimits, "timeoutMs">
}

/** Free space commands, their kept output and versions leave on the data folder's disk. */
export const DISK_RESERVE_BYTES = 2 * 2 ** 30

const defaultFileToolLimits: FileToolLimits = {
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  perAccount: 4,
  perInstance: 16,
  backgroundPerAccount: 4,
  backgroundPerInstance: 16,
  backgroundMs: 2 * 3600_000,
  run: {
    processes: 512,
    memoryBytes: 4 * 2 ** 30,
    fileBytes: 4 * 2 ** 30,
    openFiles: 4096,
    tmpBytes: 2 ** 30,
    // Until per-account quotas (§1.2): the disk the database shares is never filled by commands.
    reserve: { bytes: DISK_RESERVE_BYTES, inodes: 100_000 }
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
  /** The format worker, for the card file tools; absent: they refuse. */
  readonly formats?: Formats["Service"]
}

const READ_MAX_BYTES = 10 * 2 ** 20
const READ_LINES = 2000
const LINE_CHARS = 2000
const RESULT_CHARS = 30_000
const LIST_MAX = 500
const SEARCH_CHARS = 15_000
const VERSION_MAX_BYTES = 16 * 2 ** 20
const VERSIONS_PER_COMMAND = 256 * 2 ** 20
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
    Effect.gen(function* () {
      const shares = yield* deps.reader
        .FileSharesGrantedTo({ userId: userId as never })
        .pipe(Effect.orElseSucceed(() => []))
      // Named as the Files routes name them (files/sharedFolders.ts).
      const named = yield* Effect.promise(() =>
        shareMountNames(accountEnv(deps, userId).filesRoot, shares).catch(() => [])
      )
      return named.flatMap((entry) => {
        if (!entry) return []
        let segments: ReadonlyArray<string>
        try {
          segments = segmentsOf(entry.share.path.replace(/^\/files(?=\/|$)/, ""))
        } catch {
          return []
        }
        // Never the whole Files, nor the server plugins' working copies (§5.3).
        if (folderShareRefusal(segments) !== null) return []
        return [
          {
            share: entry.share,
            segments,
            target: `${SHARED_MOUNT}/${entry.owner}/${entry.name}`,
            ownerRoot: accountEnv(deps, entry.share.ownerId).filesRoot
          }
        ]
      })
    })
  /**
   * The shared folders as they are now: each opened by the no-follow walk from its owner's
   * Files and kept only when it's the folder that was shared (its inode); a share without a
   * recorded inode is left out. Commands bind `dir`; the file tools check and close it. The
   * caller closes every `dir`.
   */
  const openShares = (userId: string) =>
    Effect.gen(function* () {
      const opened: Array<Effect.Success<ReturnType<typeof sharesOf>>[number] & { readonly dir: FileHandle }> = []
      for (const found of yield* sharesOf(userId)) {
        if (found.share.inode === null) continue
        const dir = yield* Effect.promise(() => openFolder(found.ownerRoot, found.segments).catch(() => null))
        if (!dir) continue
        const info = yield* Effect.promise(() => dir.stat().catch(() => null))
        if (!isSharedFolder(found.share, found.segments, info)) {
          yield* Effect.promise(() => dir.close().catch(() => undefined))
          continue
        }
        opened.push({ ...found, dir })
      }
      return opened
    })
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
      // The same identity check as commands' binds: only the folder that was shared.
      const opened = yield* openShares(env.userId)
      yield* Effect.promise(() => Promise.all(opened.map(({ dir }) => dir.close().catch(() => undefined))))
      const shares = opened
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
  const proof = (ctx: ToolContext, capability: string, cardFileImport?: true) =>
    Effect.gen(function* () {
      const actor = yield* deps.reader.AuthorizePluginTool({
        userId: ctx.userId,
        rolloutId: ctx.rolloutId,
        toolCallId: ctx.toolCallId,
        capability,
        requireApproval: cardFileImport === true,
        ...(cardFileImport ? { requireFiles: true as const } : {}),
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
  const resolveIn = (ctx: ToolContext, input: string, cwd: string, roots: ReadonlyArray<ToolRoot>, write = false) => {
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
      // Only this run's own commands: before a fork's task is its parent's conversation, whose
      // last `cd` is the reply's folder, never a subagent's (spec/SUBAGENTS.md §2.3, §3.3).
      const own = forkStart(transcript)
      const root = ctx.workspace?.root
      for (let i = transcript.length - 1; i >= own; i--) {
        const message = transcript[i] as { role?: string; toolName?: string; content?: unknown }
        if (message.role !== "toolResult" || message.toolName !== "bash" || !Array.isArray(message.content)) continue
        const text = message.content.map((part: { text?: string }) => part.text ?? "").join("")
        const found = [...text.matchAll(CWD_LINE)].at(-1)?.[1]
        // A subagent in a copy starts in its copy: a folder outside it found here isn't where it works.
        if (found && root !== undefined && found !== root && !found.startsWith(`${root}/`)) break
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
    origin: string,
    /** The account that acted, when not `userId` (a command through a folder shared to edit). */
    actorUserId?: string
  ) =>
    Effect.gen(function* () {
      const hash = content ? sha256(content.bytes) : null
      if (hash && content) yield* attempt(() => Effect.runPromise(storeMedia(deps.dataDir, hash, content.bytes)))
      const [id] = yield* deps.holding(
        hash ? [hash] : [],
        deps.writer.RecordFileVersions({
          userId: userId as never,
          ...(actorUserId && actorUserId !== userId ? { actorUserId: actorUserId as never } : {}),
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
      ) => Effect.Effect<ToolOutput, unknown>,
      cardFileImport?: true
    ) =>
    (ctx: ToolContext, args: Record<string, unknown>): Effect.Effect<ToolOutput> =>
      proof(ctx, capability, cardFileImport).pipe(
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

  /** A copy as sent is addressed by id, with the account's attachment hold checked in the reader. */
  const readPlace = (ctx: ToolContext, env: AccountEnv, input: string) =>
    Effect.gen(function* () {
      const full = input.trim()
      if (full.startsWith(`${ATTACHMENT_COPY_ROOT}/`)) {
        const mediaId = full.slice(ATTACHMENT_COPY_ROOT.length + 1)
        const copy = yield* deps.reader
          .GetMediaFile({ userId: ctx.userId, mediaId, attachmentOnly: true })
          .pipe(Effect.mapError(() => new FilePathRefused("That attachment copy isn't available.")))
        return { full, hostRoot: join(deps.dataDir, "media"), segments: copy.path.split("/").slice(1), mime: copy.mime }
      }
      const cwd = yield* currentDir(ctx, env)
      const file = resolveIn(ctx, input, cwd, yield* rootsOf(env, ctx))
      return { full: file.full, hostRoot: file.root.hostRoot, segments: file.segments, mime: null }
    })

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
      "Read a file in your files (/files), the app's source (/app-source, read-only), or a message attachment (/attachments, read-only), with line numbers. Paths are absolute (/files/...) or relative to the working directory. offset and limit are lines (default: the first 2000). Images come back as images when the model can see them; other binary files are described. Read a file before you change it with write_file or edit_file.",
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
        const { full, hostRoot, segments, mime } = yield* readPlace(ctx, env, String(args.path))
        const { bytes, info, truncated } = yield* attempt(() => readRegularFile(hostRoot, segments, READ_MAX_BYTES))
        if (!truncated && mime === null) ctx.cache.set(readKey(full), sha256(bytes))
        const extension = posix.extname(full).toLowerCase()
        const image = mime === null ? IMAGE_TYPES[extension] : Object.values(IMAGE_TYPES).includes(mime) ? mime : null
        if (image && !truncated && bytes.byteLength <= 5 * 2 ** 20)
          return ctx.vision
            ? {
                text: `${full}: ${image}, ${info.size.toLocaleString("en-US")} bytes.`,
                images: [{ data: bytes.toString("base64"), mimeType: image }]
              }
            : { text: `${full}: ${image}, ${info.size.toLocaleString("en-US")} bytes. This model can't see images.` }
        if (isBinary(bytes))
          return {
            text: `${full}: a binary file (${mime ?? (extension || "no extension")}), ${info.size.toLocaleString("en-US")} bytes.${mime === null ? " Use bash to work with it." : ""}`
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
          // A command like any other: Reset waits for it (§3.6).
          enter(env.userId)
          const result = yield* Effect.gen(function* () {
            const setup = yield* commandSetup(ctx, env)
            return yield* attempt((signal) =>
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
          }).pipe(Effect.ensuring(Effect.sync(() => leave(env.userId))))
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
        const glob = typeof args.glob === "string" ? args.glob.replace(/^!/, "") : null
        const exclude = typeof args.glob === "string" && args.glob.startsWith("!")
        const matchesGlob = (below: ReadonlyArray<string>, name: string) =>
          glob === null ||
          posix.matchesGlob(glob.includes("/") ? [...below, name].join("/") : name, glob.replace(/^\//, "")) !== exclude
        const matches: Array<string> = []
        const visit = async (below: ReadonlyArray<string>, budget: { files: number }): Promise<void> => {
          const listed = await listFolder(root.hostRoot, [...segments, ...below], 2000).catch(() => null)
          for (const entry of listed?.entries ?? []) {
            if (matches.length >= 30 || budget.files <= 0) return
            if (entry.kind === "folder") await visit([...below, entry.name], budget)
            else if (entry.kind === "file" && entry.size <= 2 ** 20 && matchesGlob(below, entry.name)) {
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

  type PreviousFile = { bytes: Buffer; info: Stats; sha256: string; byteSize: number }

  /** Keeps the prior version and lands its replacement under the caller's file-tree lock. */
  const writeWithVersion = (
    userId: string,
    full: string,
    top: string,
    segments: ReadonlyArray<string>,
    host: boolean,
    before: PreviousFile | null,
    content: Buffer,
    origin: "agent" | "restore",
    receipt: { readonly rolloutId: string; readonly toolCallId: string } | null
  ) =>
    Effect.gen(function* () {
      // Host folders keep versions, and their live files are outside account quota.
      const expected = before?.info ?? null
      const quota = host ? undefined : deps.quota
      const reservation = quota
        ? yield* quota.replacement(userId, expected, before, content.byteLength, "write files")
        : null
      let keptBytes = 0
      let committed = false
      const replacement = yield* Effect.gen(function* () {
        if (reservation && !reservation.reserve(content.byteLength))
          return yield* Effect.fail(new QuotaExceeded(reservation.over(content.byteLength)))
        let versionId: string | null = null
        if (before) {
          if (reservation) {
            const { sha256: hash, byteSize, info, bytes } = before
            const saved = yield* deps.holding(
              [hash],
              Effect.andThen(
                storeMedia(deps.dataDir, hash, bytes),
                reservation.keep(content.byteLength, byteSize, (maxAddedBytes) =>
                  deps.writer.RecordReplacementVersion({
                    userId: userId as never,
                    maxAddedBytes,
                    version: {
                      path: full,
                      inode: info.ino,
                      sha256: hash,
                      byteSize,
                      mime: "application/octet-stream",
                      origin,
                      ...receipt
                    }
                  })
                )
              )
            )
            keptBytes = saved.addedBytes
            versionId = saved.id
          } else
            versionId = yield* keepVersion(
              receipt,
              userId,
              full,
              { bytes: before.bytes, inode: before.info.ino },
              origin
            )
        }
        const written = yield* attempt(() =>
          writeRegularFile(top, segments, content, {
            createFolders: before === null,
            expected,
            ...(reservation
              ? {
                  stage: reservation.stage,
                  committing: () => reservation.committing(content.byteLength, keptBytes),
                  landed: (file) => {
                    reservation.landed(file)
                    committed = true
                  }
                }
              : {})
          })
        )
        return { written, versionId }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!committed) {
              reservation?.release()
              quota?.wrote(userId, keptBytes)
            }
          })
        ),
        Effect.uninterruptible
      )
      deps.onChanged?.(userId, [full])
      return replacement
    })

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
    withFileTree(
      env.userId,
      Effect.gen(function* () {
        const top = root.hostRoot
        const info = yield* attempt(() => statPath(top, segments))
        if (info && !info.isFile()) throw new FilePathRefused(`${full} isn't a regular file.`)
        let before: PreviousFile | null = null
        if (info) {
          const read = yield* attempt(() => readRegularFile(top, segments, VERSION_MAX_BYTES + 1))
          if (read.truncated) throw new FilePathRefused(`${full} is too large to change with the file tools. Use bash.`)
          const seen = ctx.cache.get(readKey(full))
          if (seen === undefined) throw new FilePathRefused(`Read ${full} with read_file before changing it.`)
          const hash = sha256(read.bytes)
          if (seen !== hash)
            throw new FilePathRefused(`${full} changed since you read it. Read it again before changing it.`)
          before = { bytes: read.bytes, info: read.info, sha256: hash, byteSize: read.bytes.byteLength }
        } else if (kind === "edit") throw new FilePathRefused(`${full} doesn't exist. Create it with write_file.`)
        const content = next(before?.bytes ?? null)
        const { written, versionId } = yield* writeWithVersion(
          env.userId,
          full,
          top,
          segments,
          root.host === true,
          before,
          content,
          "agent",
          {
            rolloutId: ctx.rolloutId,
            toolCallId: ctx.toolCallId
          }
        )
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
            if (!isUtf8(before!)) throw new FilePathRefused(`${full} isn't valid UTF-8 and can't be edited as text.`)
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

  // --- read_card_file, edit_card_file, import_card_file
  const cardFileTools = makeCardFileTools({
    formats: () => deps.formats,
    dataDir: deps.dataDir,
    writer: () => deps.writer,
    quota: deps.quota,
    holding: deps.holding,
    wrap: (capability, run, cardFileImport) =>
      wrap(capability, (ctx, args, env) => run(ctx, args, env as never), cardFileImport),
    readPlace: (ctx, env, path) => readPlace(ctx, env as AccountEnv, path),
    markRead: (ctx, full, bytes) => ctx.cache.set(readKey(full), sha256(Buffer.from(bytes))),
    wasRead: (ctx, full) => ctx.cache.get(readKey(full)) !== undefined,
    replace: (ctx, env, path, next) =>
      Effect.gen(function* () {
        const account = env as AccountEnv
        const cwd = yield* currentDir(ctx, account)
        const { full, root, segments } = resolveIn(ctx, path, cwd, yield* rootsOf(account, ctx), true)
        const done = yield* replaceFile(ctx, account, full, root, segments, next, "edit")
        return { full, effects: done.effects }
      })
  })

  /**
   * A tree whose changes a command's scan lists (§7.2): the account's Files, a host folder, or a
   * folder another account shared with it to edit (§1.4), whose changes are its owner's: kept
   * as the owner's versions, with the acting account recorded, and told to the owner's open file
   * managers.
   */
  interface ScanPlace {
    readonly root: string
    /** How the agent names its top: /files, a host folder's real path, /files/Shared/<owner>/<folder>. */
    readonly prefix: string
    /** Where its files are read from by the no-follow walk, when not `root`: a top and the components. */
    readonly walk?: { readonly root: string; readonly base: ReadonlyArray<string> }
    /** A shared folder's owner, and the folder's path in the owner's Files (/files/…). */
    readonly owner?: { readonly userId: string; readonly handle: string; readonly prefix: string }
  }
  interface PlaceChanges {
    readonly place: ScanPlace
    readonly changes: TreeChanges
  }
  const scanPlaces = (places: ReadonlyArray<ScanPlace>) =>
    Effect.forEach(places, (place) =>
      attempt(() =>
        place.walk ? scanTree(place.walk.root, undefined, undefined, place.walk.base) : scanTree(place.root)
      ).pipe(Effect.map((scan) => ({ place, scan })))
    )
  const diffPlaces = (
    before: ReadonlyArray<{ place: ScanPlace; scan: Scan }>,
    after: ReadonlyArray<{ place: ScanPlace; scan: Scan }>
  ): ReadonlyArray<PlaceChanges> =>
    before.map((b, i) => ({ place: b.place, changes: diffScans(b.scan, after[i]!.scan) }))
  const allChanges = (found: ReadonlyArray<PlaceChanges>, named: (place: ScanPlace) => string = (p) => p.prefix) => {
    const full = (place: ScanPlace, paths: ReadonlyArray<string>) => paths.map((p) => `${named(place)}/${p}`)
    return {
      changed: found.flatMap(({ place, changes }) => full(place, changes.changed)),
      created: found.flatMap(({ place, changes }) => full(place, changes.created)),
      deleted: found.flatMap(({ place, changes }) => full(place, changes.deleted)),
      partial: found.some(({ changes }) => changes.partial)
    }
  }

  /**
   * Stores the new content of what a command changed (§7.2), within the per-command budget,
   * under `userId` (a shared folder's owner), recording `actorUserId` when another account acted.
   */
  const keepCommandVersions = (
    call: { readonly rolloutId: string; readonly toolCallId: string } | null,
    userId: string,
    found: ReadonlyArray<PlaceChanges>,
    budget: { left: number },
    actorUserId?: string
  ) =>
    Effect.gen(function* () {
      for (const { place, changes } of found) {
        const named = place.owner?.prefix ?? place.prefix
        for (const path of [...changes.changed, ...changes.created]) {
          const read = yield* attempt(() =>
            readRegularFile(
              place.walk?.root ?? place.root,
              [...(place.walk?.base ?? []), ...path.split("/")],
              VERSION_MAX_BYTES + 1
            )
          ).pipe(Effect.orElseSucceed(() => null))
          if (!read || read.truncated || read.bytes.byteLength > budget.left) continue
          budget.left -= read.bytes.byteLength
          yield* keepVersion(
            call,
            userId,
            `${named}/${path}`,
            { bytes: read.bytes, inode: read.info.ino },
            "command",
            actorUserId
          ).pipe(Effect.ignore)
        }
        for (const path of changes.deleted)
          yield* keepVersion(call, userId, `${named}/${path}`, null, "command", actorUserId).pipe(Effect.ignore)
      }
    })

  /**
   * Commands running per account (foreground and background, `search_files` and the app's own
   * quiet commands too), so Reset waits for none. Counted from the call's start.
   */
  const running = new Map<string, number>()
  /** Accounts whose home folder is being emptied: no command starts meanwhile. */
  const resetting = new Set<string>()
  /** Accounts whose Shared mount point a command made, to be removed when none runs. */
  const madeShared = new Set<string>()
  const homeBusy = () => new FilePathRefused("The home folder for commands is being reset. Try again in a moment.")
  /** Counts a command of the account from now; refused while its home folder is being reset. */
  const enter = (userId: string) => {
    if (resetting.has(userId)) throw homeBusy()
    running.set(userId, (running.get(userId) ?? 0) + 1)
  }
  /** The command ended: once none of the account's runs, the Shared mount point it made goes. */
  const leave = (userId: string) => {
    const next = (running.get(userId) ?? 0) - 1
    if (next > 0) {
      running.set(userId, next)
      return
    }
    running.delete(userId)
    if (madeShared.delete(userId))
      // rmdir refuses a folder with anything in it, and a link.
      void rmdir(join(accountEnv(deps, userId).filesRoot, "Shared")).catch(() => undefined)
  }

  /**
   * Folders other accounts shared with this one (§1.4), each opened by the no-follow walk from
   * its owner's Files, checked by its inode and bound by that descriptor at
   * /files/Shared/<owner>/<folder>: read-only for Can view, writable for Can edit while the
   * owner's Files are within their quota. A folder shared to edit is also a place the command's
   * scan covers, as its owner's. `close` frees the descriptors after the run.
   */
  const sharedPlaces = (userId: string) =>
    Effect.gen(function* () {
      const opened = yield* openShares(userId)
      const mounts: Array<SandboxMount> = []
      const places: Array<ScanPlace> = []
      const bound: Array<BoundShare> = []
      const readOnly: Array<string> = []
      const close = () => Promise.all(opened.map(({ dir }) => dir.close().catch(() => undefined))).then(() => undefined)
      // A Files top whose `Shared` isn't a real folder: refused, never left to the sandbox.
      const root = accountEnv(deps, userId).filesRoot
      if (opened.length > 0) {
        const top = yield* Effect.promise(() => lstat(join(root, "Shared")).catch(() => null))
        if (top && (!top.isDirectory() || top.isSymbolicLink())) {
          yield* Effect.promise(close)
          return yield* Effect.fail(
            new FilePathRefused(
              `${SHARED_MOUNT} in your files isn't a folder, but folders other accounts share with you appear there. Rename or move it, then run the command again.`
            )
          )
        }
        if (!top) madeShared.add(userId)
      }
      const overQuota = new Map<string, boolean>()
      for (const { share, segments, target, ownerRoot, dir } of opened) {
        let writable = share.mode === "edit"
        if (writable && deps.quota) {
          // The owner's quota pays for what commands write there: over it, the folder is read-only.
          if (!overQuota.has(share.ownerId))
            overQuota.set(
              share.ownerId,
              yield* deps.quota.check(share.ownerId, 0, "run commands").pipe(
                Effect.as(false),
                Effect.orElseSucceed(() => true)
              )
            )
          if (overQuota.get(share.ownerId)) {
            writable = false
            readOnly.push(target)
          }
        }
        mounts.push({ source: "", target, writable, fd: dir.fd })
        bound.push({ id: share.id, mode: writable ? "edit" : "view", inode: share.inode!, birthMs: share.birthMs })
        if (writable)
          places.push({
            root: ownerRoot,
            prefix: target,
            walk: { root: ownerRoot, base: segments },
            owner: { userId: share.ownerId, handle: share.ownerHandle, prefix: `${FILES_MOUNT}/${segments.join("/")}` }
          })
      }
      // The shared folders sit in a small empty folder of their own. Its mount point is the only
      // thing made in Files, and it goes again once no command of the account runs.
      if (mounts.length) mounts.unshift({ source: "", target: SHARED_MOUNT, writable: false, empty: true })
      return { mounts: mounts as ReadonlyArray<SandboxMount>, places, bound, readOnly, close }
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

  /**
   * What the app does after any command: tell open file managers, keep versions, measure, count
   * the internet. A shared folder's changes are its owner's: their file managers are told, the
   * versions are theirs (the acting account recorded), and their quota is measured.
   */
  const afterCommand = (
    call: { readonly rolloutId: string; readonly toolCallId: string },
    userId: string,
    result: RunResult,
    found: ReadonlyArray<PlaceChanges>
  ) =>
    Effect.gen(function* () {
      const changes = allChanges(found)
      const own = found.filter(({ place }) => !place.owner)
      const mine = allChanges(own)
      deps.onChanged?.(userId, [...mine.changed, ...mine.created, ...mine.deleted], mine.partial)
      // Versions go to the media store on the data folder's disk: none past its reserve either.
      const reserve = limits.run.reserve
      const free = reserve
        ? yield* attempt(() => statfs(deps.dataDir)).pipe(
            Effect.map((fs) => fs.bavail * fs.bsize - reserve.bytes),
            Effect.orElseSucceed(() => 0)
          )
        : Infinity
      const budget = { left: Math.min(VERSIONS_PER_COMMAND, Math.max(0, free)) }
      yield* keepCommandVersions(call, userId, own, budget)
      const owners = new Map<string, { handle: string; found: Array<PlaceChanges> }>()
      for (const entry of found)
        if (entry.place.owner) {
          const owner = owners.get(entry.place.owner.userId) ?? { handle: entry.place.owner.handle, found: [] }
          owner.found.push(entry)
          owners.set(entry.place.owner.userId, owner)
        }
      const notes: Array<string> = []
      for (const [ownerId, owner] of owners) {
        const theirs = allChanges(owner.found, (place) => place.owner!.prefix)
        const paths = [...theirs.changed, ...theirs.created, ...theirs.deleted]
        if (paths.length === 0 && !theirs.partial) continue
        deps.onChanged?.(ownerId, paths, theirs.partial)
        // The owner's versions aren't tied to this account's run: its run isn't theirs to open.
        yield* keepCommandVersions(null, ownerId, owner.found, budget, userId)
        const over = deps.quota ? yield* deps.quota.afterCommand(ownerId).pipe(Effect.orElseSucceed(() => null)) : null
        if (over)
          notes.push(
            `${owner.handle}'s files are now over their storage limit, so commands can only read the folders ${owner.handle} shared until space is freed.`
          )
      }
      if (result.networkBytes) deps.onNetwork?.(userId, result.networkBytes)
      // Commands can't be stopped mid-write by a quota: measured after, and the next refused.
      const overQuota = deps.quota
        ? yield* deps.quota.afterCommand(userId).pipe(Effect.orElseSucceed(() => null))
        : null
      return { changes, overQuota: [overQuota, ...notes].filter(Boolean).join("\n") || null }
    })

  /**
   * Whether the workshop's grant turned the sandbox off (§3.7), with the consent the server
   * recorded for the consent text as it is now; a grant without it doesn't count.
   */
  const unsandboxedGranted = (userId: string, chatId: string) =>
    Effect.gen(function* () {
      const consent = consentTarget(deps.registries, COMMANDS_UNSANDBOXED)
      const [grants, consented] = yield* Effect.all([
        deps.reader.WorkshopGrants({ userId: userId as never, chatId: chatId as never, now: Date.now() }),
        consent
          ? deps.reader.WorkshopGrants({
              userId: userId as never,
              chatId: chatId as never,
              now: Date.now(),
              target: consent
            })
          : Effect.succeed([])
      ])
      if (!consented.some((g) => g.capability === COMMANDS_UNSANDBOXED && g.mode === "allow")) return false
      const modes = new Map(grants.map((g) => [g.capability, g.mode]))
      return resolveMode(deps.registries, modes, COMMANDS_UNSANDBOXED, "outside") === "allow"
    })
  /**
   * Without a sandbox (§3.7): checked at every command, whatever the grant says: the server
   * allows it (ALLOW_UNSANDBOXED_COMMANDS), the account is an admin, the workshop turned it on
   * with the recorded consent, and the `none` sandbox is registered.
   */
  const unsandboxedFor = (ctx: ToolContext) =>
    Effect.gen(function* () {
      const actor = ctx.cache.get(ACTOR_KEY) as User | undefined
      if (deps.allowUnsandboxed !== true || actor?.role !== "admin") return null
      if (!(yield* unsandboxedGranted(ctx.userId, ctx.chatId))) return null
      return deps.sandboxes.list().find((sandbox) => sandbox.unsandboxed) ?? null
    })
  /** Everything a command runs with for this account: its folders, shared folders and the app's source. */
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
            : []),
          ...shared.places
        ] as ReadonlyArray<ScanPlace>,
        /** What the command was given, checked again while it runs (`recheck`). */
        bound: {
          host: hostMount.length ? { path: host!.path, inode: hostInfo!.ino } : null,
          shares: shared.bound
        },
        readOnly: shared.readOnly,
        close: async () => {
          await hostDir?.close().catch(() => undefined)
          await shared.close()
        }
      }
    })

  // Commands running now (§3.6, §3.7, §1.4), foreground and background: what each was given, so
  // taking it away stops it at once (`recheck`): Run commands or the sandbox's grant turned off,
  // the account disabled or no longer an admin, a host folder no longer allowed, a shared folder
  // unshared. Each is checked again every few seconds too, whatever took it away.
  interface BoundShare {
    readonly id: string
    readonly mode: "view" | "edit"
    readonly inode: number
    readonly birthMs: number | null
  }
  interface Live {
    readonly userId: string
    /** Its workshop; null for the app's own commands for a subagent's copy outside a call. */
    readonly chatId: string | null
    readonly unsandboxed: boolean
    /** Whether it was given the internet (Internet from commands). */
    readonly network: "public" | "none"
    readonly host: { readonly path: string; readonly inode: number } | null
    readonly shares: ReadonlyArray<BoundShare>
    readonly controller: AbortController
    /** Why the app stopped it, once it did. */
    stopped: string | null
  }
  const live = new Set<Live>()

  /**
   * Why a running command may no longer run; null: it may. When storage fails, the account
   * counts as not an admin and the no-sandbox grant as not given (logged), so what only an admin
   * or that grant allows stops; the rest is checked again at the next sweep.
   */
  const revoked = (entry: Live) =>
    Effect.gen(function* () {
      const account = yield* deps.reader
        .GetPasswordHash({ userId: entry.userId as never })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Commands: the account ${entry.userId} couldn't be read; counted as not an admin`,
              error
            ).pipe(Effect.as("unknown" as const))
          )
        )
      if (account === null) return "the account was turned off"
      const grants =
        entry.chatId === null
          ? undefined
          : yield* deps.reader
              .WorkshopGrants({ userId: entry.userId as never, chatId: entry.chatId as never, now: Date.now() })
              .pipe(
                Effect.map((rows) => new Map(rows.map((g) => [g.capability, g.mode]))),
                Effect.catchTag("NotFound", () => Effect.succeed(null)),
                Effect.orElseSucceed(() => undefined)
              )
      if (grants === null) return "its workshop is gone"
      if (grants && resolveMode(deps.registries, grants, "commands", "outside") === "off")
        return "Run commands was turned off in its workshop"
      if (
        grants &&
        entry.network === "public" &&
        resolveMode(deps.registries, grants, COMMANDS_NETWORK, "outside") !== "allow"
      )
        return "Internet from commands was turned off in its workshop"
      const admin = account !== "unknown" && account.user.role === "admin"
      if (entry.unsandboxed) {
        if (!admin || deps.allowUnsandboxed !== true) return "running commands without a sandbox isn't allowed now"
        const granted = yield* unsandboxedGranted(entry.userId, entry.chatId!).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Commands: the no-sandbox grant of ${entry.userId} couldn't be read; counted as not given`,
              error
            ).pipe(Effect.as(false))
          )
        )
        if (!granted) return "running without a sandbox was turned off in its workshop"
      }
      if (entry.host) {
        if (!admin) return "its folder on the server isn't available to the account now"
        const now = deps.hostFolders
          ? yield* Effect.promise(() => deps.hostFolders!.check(entry.host!.path).catch(() => null))
          : null
        if (!now || now.inode !== entry.host.inode) return "its folder on the server isn't available now"
      }
      if (entry.shares.length) {
        const current = yield* sharesOf(entry.userId).pipe(Effect.orElseSucceed(() => undefined))
        if (current)
          for (const bound of entry.shares) {
            const now = current.find(({ share }) => share.id === bound.id)
            if (!now || now.share.inode !== bound.inode || now.share.birthMs !== bound.birthMs)
              return "a folder it used is no longer shared with the account"
            if (bound.mode === "edit" && now.share.mode !== "edit")
              return "a folder it changed is no longer shared with the account to edit"
          }
      }
      return null
    })

  /**
   * Checks the running commands (of `userIds`, else all) again, and stops at once those whose
   * account, workshop grant, host folder or shared folders no longer allow them. Answers how many
   * were stopped.
   */
  const recheck = (userIds?: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      let stopped = 0
      for (const entry of [...live]) {
        if (entry.stopped !== null || (userIds && !userIds.includes(entry.userId))) continue
        const why = yield* revoked(entry)
        if (why && entry.stopped === null) {
          entry.stopped = why
          entry.controller.abort()
          stopped++
        }
      }
      return stopped
    })

  // Background commands (§3.6, §5.1): children of the app, stopped after 2 hours, by bash_stop,
  // with the app, or when what they were given is taken away. Their output is read from the kept
  // output as they run. An ended one is remembered as long as its output is kept.
  interface Job {
    readonly id: string
    readonly userId: string
    readonly command: string
    readonly cwd: string
    readonly startedAt: number
    /** The Changes rows' target kind: `command`, or `command.unsandboxed`. */
    readonly kind: string
    readonly live: Live
    /** Stopped with bash_stop. */
    stoppedByTool: boolean
    /** Bytes of its output already given to the agent. */
    cursor: number
    /** The end, once it ended. */
    ended: { readonly at: number; readonly text: string; readonly failed: boolean } | null
    readonly done: Promise<void>
  }
  const jobs = new Map<string, Job>()
  /** Background slots taken by calls still starting (between the limit's check and the job). */
  const starting = new Map<string, number>()
  const startingTotal = () => [...starting.values()].reduce((sum, n) => sum + n, 0)
  const jobsOf = (userId: string) => [...jobs.values()].filter((job) => job.userId === userId && job.ended === null)
  const runningJobs = () => [...jobs.values()].filter((job) => job.ended === null)
  /** Forgets ended jobs whose output is no longer kept. */
  const pruneJobs = (now = Date.now()) => {
    for (const [id, job] of jobs) if (job.ended && now - job.ended.at > OUTPUT_KEEP_MS) jobs.delete(id)
  }
  /**
   * Takes a background slot of the account and of the instance at once, before any wait, so
   * calls starting together can't pass the limits; a refusal's text otherwise. `release` gives
   * the slot back (the job then counts itself, or it never started).
   */
  const takeSlot = (userId: string): { readonly release: () => void } | string => {
    if (jobsOf(userId).length + (starting.get(userId) ?? 0) >= limits.backgroundPerAccount)
      return `${limits.backgroundPerAccount} commands are already running in the background. Stop one with bash_stop first.`
    if (runningJobs().length + startingTotal() >= limits.backgroundPerInstance)
      return "This server is running as many background commands as it can. Try again later."
    starting.set(userId, (starting.get(userId) ?? 0) + 1)
    let held = true
    return {
      release: () => {
        if (!held) return
        held = false
        const left = (starting.get(userId) ?? 1) - 1
        if (left > 0) starting.set(userId, left)
        else starting.delete(userId)
      }
    }
  }

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
        pruneJobs()
        const none = yield* unsandboxedFor(ctx)
        const selected = none ?? (yield* sandboxFor())
        if (typeof selected === "string")
          return { isError: true, text: `Commands can't run here: ${selected} The file tools still work.` }
        // The Changes row marks a command run without a sandbox.
        const commandKind = none ? "command.unsandboxed" : "command"
        const background = args.run_in_background === true
        if (background && !deps.outputs)
          return { isError: true, text: "Commands can't run in the background here. Run it in the foreground." }
        // Without a sandbox, a background command must be held together so it can be stopped.
        if (background && none) {
          const contained = none.containment ? yield* attempt(() => none.containment!()) : null
          if (!contained?.ok)
            return {
              isError: true,
              text: `Commands without a sandbox can't run in the background on this server: ${contained && !contained.ok ? contained.reason : "nothing here can stop everything such a command starts."} Run it in the foreground.`
            }
        }
        // The slot is taken now, before any wait; given back unless a job takes it over.
        const slot = background ? takeSlot(env.userId) : null
        if (typeof slot === "string") return { isError: true, text: slot }
        // Counted from here, so Reset can't empty the home folder under it.
        enter(env.userId)
        let handedOver = false
        const treeScope = Scope.makeUnsafe()
        return yield* Effect.gen(function* () {
          const start = yield* currentDir(ctx, env)
          const cwd =
            typeof args.cwd === "string" && args.cwd.trim() !== "" ? posix.resolve(start, args.cwd.trim()) : start
          const timeoutMs = background
            ? limits.backgroundMs
            : Math.min(Number(args.timeout_ms ?? limits.defaultTimeoutMs), limits.maxTimeoutMs)
          if (deps.quota) yield* deps.quota.check(env.userId, 0, "run commands")
          const setup = yield* commandSetup(ctx, env)
          const entry: Live = {
            userId: env.userId,
            chatId: ctx.chatId,
            unsandboxed: none !== null,
            network: setup.network,
            host: setup.bound.host,
            shares: setup.bound.shares,
            controller: new AbortController(),
            stopped: null
          }
          const call = { rolloutId: ctx.rolloutId, toolCallId: ctx.toolCallId }
          const sink = deps.outputs
            ? yield* attempt(() => deps.outputs!.open(env.userId)).pipe(
                Effect.tapError(() => Effect.promise(() => setup.close()))
              )
            : null
          const spec = (signal: AbortSignal) =>
            selected.run(
              {
                command: String(args.command),
                cwd,
                mounts: setup.mounts,
                env: commandEnv(),
                network: setup.network,
                limits: { ...limits.run, timeoutMs },
                ...(sink ? { onOutput: sink.write } : {}),
                // Without a sandbox, a background command must be held together to be stopped.
                ...(background ? { requireContainment: true } : {})
              },
              signal
            )
          const short = String(args.command).split("\n")[0]!.slice(0, 80)
          const readOnlyText = setup.readOnly.length
            ? `Read-only in this command, as their owner's files are over their storage limit: ${setup.readOnly.join(", ")}\n`
            : ""
          // Register before checking the grants again so an immediate recheck can stop this
          // command even while the final check is reading storage.
          const checkStart = Effect.gen(function* () {
            live.add(entry)
            const why = yield* revoked(entry)
            return entry.stopped ?? why ?? (entry.controller.signal.aborted ? "it was stopped" : null)
          })
          const endOutput = (bytes: number) =>
            Effect.promise(async () => void (await sink?.end(bytes).catch(() => undefined)))
          const notStarted = (why: string) => ({ isError: true, text: `Not started: ${why}.` })
          const lockTrees = lockFileTrees([
            env.userId,
            ...setup.places.flatMap(({ owner }) => (owner ? [owner.userId] : []))
          ]).pipe(Effect.provideService(Scope.Scope, treeScope))

          if (background) {
            const { before, why } = yield* lockTrees.pipe(
              Effect.andThen(scanPlaces(setup.places)),
              Effect.flatMap((before) => Effect.map(checkStart, (why) => ({ before, why }))),
              Effect.onExit((exit) =>
                exit._tag === "Success" && exit.value.why === null
                  ? Effect.void
                  : Effect.promise(async () => {
                      live.delete(entry)
                      await setup.close()
                      await sink?.end(0).catch(() => undefined)
                    })
              )
            )
            if (why !== null) return notStarted(why)
            const job: Job = {
              id: sink!.id,
              userId: env.userId,
              command: String(args.command),
              cwd,
              startedAt: Date.now(),
              kind: commandKind,
              live: entry,
              stoppedByTool: false,
              cursor: 0,
              ended: null,
              done: spec(entry.controller.signal)
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
                      `${entry.stopped ? `stopped: ${entry.stopped}` : job.stoppedByTool ? "stopped with bash_stop" : result.timedOut ? "stopped after 2 hours" : statusOf(result, timeoutMs)}\nDirectory after: ${result.cwd ?? cwd}\n` +
                      changesText(changes) +
                      (overQuota ? `${overQuota}\n` : "")
                  }
                })
                .catch(async (error: unknown) => {
                  await sink!.end(sink!.kept()).catch(() => undefined)
                  job.ended = {
                    at: Date.now(),
                    failed: true,
                    text:
                      error instanceof CommandRefused
                        ? `The command didn't start: ${error.message} Run it in the foreground.\n`
                        : "The command couldn't run.\n"
                  }
                })
                .finally(async () => {
                  live.delete(entry)
                  try {
                    await setup.close()
                  } finally {
                    leave(env.userId)
                    await Effect.runPromise(Scope.close(treeScope, Exit.void))
                  }
                })
            }
            jobs.set(job.id, job)
            // The job counts itself from now, and leaves when it ends.
            handedOver = true
            slot?.release()
            return {
              text: `Started in the background as ${job.id}, in ${cwd}. Read what it writes with bash_output (id: ${job.id}); stop it with bash_stop. It's stopped after 2 hours.${setup.network === "none" ? "\nInternet from commands is off in this workshop." : ""}${readOnlyText ? `\n${readOnlyText.trimEnd()}` : ""}`,
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
            const why = yield* checkStart
            if (why !== null) return { notStarted: why } as const
            let runningCommand: Promise<RunResult> | undefined
            const result = yield* attempt((signal) => {
              // Stopping the call (Stop) or taking away what it was given stops the command.
              signal.addEventListener("abort", () => entry.controller.abort(), { once: true })
              if (signal.aborted) entry.controller.abort()
              return entry.controller.signal.aborted
                ? Promise.resolve(null)
                : (runningCommand = spec(entry.controller.signal))
            }).pipe(Effect.ensuring(Effect.promise(async () => void (await runningCommand?.catch(() => undefined)))))
            live.delete(entry)
            if (result === null) return { notStarted: entry.stopped ?? "it was stopped" } as const
            const after = yield* scanPlaces(setup.places)
            return { result, found: diffPlaces(before, after) }
          })
          const ran = yield* lockTrees.pipe(
            Effect.andThen(Semaphore.withPermit(instance)(Semaphore.withPermit(accountPermits(env.userId))(run))),
            Effect.onExit((exit) =>
              Effect.promise(async () => {
                live.delete(entry)
                await setup.close()
                if (exit._tag !== "Success") await sink?.end(sink.kept()).catch(() => undefined)
              })
            )
          )
          if ("notStarted" in ran) {
            yield* endOutput(0)
            return notStarted(ran.notStarted)
          }
          const { result, found } = ran
          yield* endOutput(result.outputBytes)
          if (result.cwd) ctx.cache.set(CWD_KEY, result.cwd)
          const { changes, overQuota } = yield* afterCommand(call, env.userId, result, found)
          const output = result.tail === "" ? result.head : `${result.head}\n…\n${result.tail}`
          const shown = headTail(output)
          const cut = result.tail !== "" || shown.length < output.length
          const counts = countsOf(changes)
          const text =
            `${entry.stopped ? `stopped: ${entry.stopped}` : statusOf(result, timeoutMs)}\nDirectory after: ${result.cwd ?? cwd}\n` +
            changesText(changes) +
            readOnlyText +
            (none
              ? `No sandbox: this ran directly on the server. /files is ${env.filesRoot} and /home/user is ${env.home} here.\n`
              : setup.network === "none"
                ? "Internet from commands is off in this workshop.\n"
                : "") +
            (overQuota ? `${overQuota}\n` : "") +
            `Output (${result.outputBytes.toLocaleString("en-US")} bytes${cut && sink ? `; the whole output is kept: bash_output id ${sink.id}` : ""}):\n${shown}`
          return {
            text,
            isError: entry.stopped !== null || failed(result),
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
        }).pipe(
          Effect.onExit((exit) => (handedOver ? Effect.void : Scope.close(treeScope, exit))),
          Effect.ensuring(
            Effect.sync(() => {
              slot?.release()
              if (!handedOver) leave(env.userId)
            })
          )
        )
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
        const stateOf = (job: Job) =>
          job.ended
            ? `ended ${Math.round((job.ended.at - job.startedAt) / 1000)} s after it started: ${job.ended.text.trimEnd()}`
            : `still running (for ${Math.round((Date.now() - job.startedAt) / 1000)} s)`
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
              `${id}: ${stateOf(own)}\n` +
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
            `${id}${own ? `: ${stateOf(own)}` : ""}\nLines ${page.lines.length ? `${page.from}–${last}` : "none"} of ${page.totalLines.toLocaleString("en-US")}${page.cut ? " (the output was longer: only its first 16 MiB are kept)" : ""}:\n` +
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
        job.stoppedByTool = true
        job.live.controller.abort()
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

  const recordedFilePlace = (actor: User, path: string, host: boolean) =>
    Effect.gen(function* () {
      const env = accountEnv(deps, actor.id)
      // A recorded host path still requires admin access and a current allowlist match.
      if (host) {
        const allowed =
          actor.role === "admin" &&
          deps.hostFolders !== undefined &&
          (yield* Effect.promise(() => deps.hostFolders!.allows(path).catch(() => false)))
        if (!allowed) return yield* new EffectUndoRefused({ message: "That folder on the server isn't available now." })
      }
      return {
        env,
        top: host ? "/" : env.filesRoot,
        segments: host ? path.split("/").filter(Boolean) : resolveFilesPath(path, FILES_MOUNT).segments
      }
    })

  /** Puts a file back as it was before the agent's write or edit (§7.1), if it's still as the agent left it. */
  const undoEffect = (actor: User, effect: RolloutEffect) =>
    Effect.gen(function* () {
      if (effect.undoneAt !== null) return effect
      const recipe = effect.undo as { path?: unknown; before?: unknown; after?: unknown; host?: unknown } | null
      if (!recipe || typeof recipe.path !== "string" || typeof recipe.after !== "string")
        return yield* new EffectUndoRefused({ message: "This change cannot be undone." })
      const host = recipe.host === true
      const { env, top, segments } = yield* recordedFilePlace(actor, recipe.path, host)
      return yield* withFileTree(
        env.userId,
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
          // The kept version counts until the next measurement, even if Undo fails later.
          const quota = host ? undefined : deps.quota
          quota?.wrote(env.userId, current.bytes.byteLength)
          let restored: Buffer | null = null
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
            restored = yield* attempt(() => readFile(join(deps.dataDir, version.mediaPath!)))
          }
          // The live bytes go away only when this path held the inode's last link.
          yield* attempt(async () => {
            const free = quota?.freed(env.userId, current.info.nlink === 1 ? current.info.size : 0)
            try {
              if (restored === null) await removeFile(top, segments)
              else await writeRegularFile(top, segments, restored)
            } catch (error) {
              if (free !== undefined) quota?.unfreed(env.userId, free)
              throw error
            }
            if (restored !== null) quota?.wrote(env.userId, restored.byteLength)
          })
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

  /**
   * Takes selected changes back newest first in a card file (spec/WORKSHOP-CARDS.md §8.1). The file
   * as it is now is read with the format worker, the fields are planned three-way, and the result
   * is written in the file's own format, the file as it was kept as a version. A conflict or a dry
   * run writes nothing. `record` stores the reversal (one writer transaction) once written.
   */
  const reverseCardFile = (
    actor: User,
    input: {
      readonly path: string
      readonly host: boolean
      readonly patches: ReadonlyArray<ReversalPatch>
      readonly choices?: Readonly<Record<string, ConflictChoice>> | undefined
      readonly expectedHead?: string | undefined
      readonly dryRun?: boolean | undefined
      readonly record: (written: {
        readonly before: string
        readonly after: string
        readonly name: string
        readonly plan: ReversalPlan
      }) => Effect.Effect<string, unknown>
    }
  ) =>
    Effect.gen(function* () {
      const formats = deps.formats
      if (!formats) return yield* new EffectUndoRefused({ message: "Card files can't be read on this server." })
      const { env, top, segments } = yield* recordedFilePlace(actor, input.path, input.host)
      return yield* withFileTree(
        env.userId,
        Effect.gen(function* () {
          const current = yield* attempt(() => readRegularFile(top, segments, CARD_FILE_BYTES + 1)).pipe(
            Effect.orElseSucceed(() => null)
          )
          if (!current || current.truncated)
            return yield* new EffectUndoRefused({ message: "The card file isn't there any more." })
          const info = yield* formats.readCardFile(current.bytes).pipe(Effect.orElseSucceed(() => null))
          if (!info) return yield* new EffectUndoRefused({ message: "The file isn't a card file any more." })
          const beforeHash = sha256(current.bytes)
          const matches = matchesReversalHead(beforeHash, input)
          const plan = planGroupedReversal(
            input.patches,
            visibleDoc("card", info.doc) as Record<string, unknown>,
            matches ? input.choices : undefined
          )
          const outcome = (reversalId: string | null) => ({
            reversalId,
            head: beforeHash,
            fields: plan.fields,
            conflicts: plan.conflicts.map((c) => ({
              field: c.field,
              ...(c.now === undefined ? {} : { now: c.now }),
              ...(c.before === undefined ? {} : { before: c.before })
            }))
          })
          if (plan.doc === null || input.dryRun === true || plan.fields.length === 0 || !matches) return outcome(null)
          const doc = plan.doc
          const tops = [...new Set(plan.fields.map((f) => unitPath(f)[0]).filter((f) => f !== undefined))]
          const changes = tops.map((field) =>
            field === "alternate_greetings"
              ? { field, items: (Array.isArray(doc[field]) ? doc[field] : []) as Array<string> }
              : { field, text: typeof doc[field] === "string" ? doc[field] : "" }
          )
          const edited = yield* formats
            .editCardFile(current.bytes, changes)
            .pipe(Effect.mapError(() => new EffectUndoRefused({ message: "The card file couldn't be changed." })))
          if ("error" in edited) return yield* new EffectUndoRefused({ message: edited.error })
          const next = Buffer.from(edited.bytes)
          yield* writeWithVersion(
            env.userId,
            input.path,
            top,
            segments,
            input.host,
            { ...current, sha256: beforeHash, byteSize: current.bytes.byteLength },
            next,
            "restore",
            null
          ).pipe(
            Effect.mapError((error) =>
              error instanceof QuotaExceeded ? new EffectUndoRefused({ message: error.message }) : error
            )
          )
          const id = yield* input.record({
            before: beforeHash,
            after: sha256(next),
            name: edited.after.name,
            plan
          })
          return outcome(id)
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
  // that the copy it hands the subagent is a folder of the user's Files. Nothing a repository's
  // settings name runs: no hooks, no fsmonitor, no submodules, no automatic gc, and no filter
  // drivers (`safe_git`: every driver the repository's settings name is emptied, and the system
  // and global settings aren't read), so checkout and status only copy and compare bytes.
  const GIT =
    "git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false -c gc.auto=0 -c maintenance.auto=false"
  /** Defines `safe_git <folder>`: run once per script before git touches that folder's repository. */
  const SAFE_GIT = [
    "export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null",
    "safe_git() {",
    `  drivers=$(${GIT} -C "$1" config --name-only --get-regexp '^filter[.]' 2>/dev/null | sed 's/^filter[.]//; s/[.][^.]*$//' | sort -u)`,
    "  n=0",
    "  while IFS= read -r d; do",
    '    [ -n "$d" ] || continue',
    '    for k in smudge clean process; do eval "export GIT_CONFIG_KEY_$n=\\"filter.\\$d.\\$k\\" GIT_CONFIG_VALUE_$n="; n=$((n + 1)); done',
    '    eval "export GIT_CONFIG_KEY_$n=\\"filter.\\$d.required\\" GIT_CONFIG_VALUE_$n=false"; n=$((n + 1))',
    "  done <<EOF",
    "$drivers",
    "EOF",
    "  export GIT_CONFIG_COUNT=$n",
    "}"
  ].join("\n")

  /**
   * Runs one of the copies' scripts in the sandbox: its output lines; a failure says why. It is a
   * running command like any other (files4afix): Reset waits for it, and it stops with the app or
   * when the account, or the workshop's Run commands (`chatId`), is taken away.
   */
  const copyScript = (env: AccountEnv, script: string, timeoutMs: number, chatId: string | null) =>
    Effect.gen(function* () {
      const selected = yield* sandboxFor()
      if (typeof selected === "string")
        return yield* Effect.fail(new ToolInputRefused(`Copies need commands, which can't run here: ${selected}`))
      yield* Effect.try({ try: () => enter(env.userId), catch: (error) => error })
      const entry: Live = {
        userId: env.userId,
        chatId,
        unsandboxed: false,
        network: "none",
        host: null,
        shares: [],
        controller: new AbortController(),
        stopped: null
      }
      const result = yield* withFileTree(
        env.userId,
        Semaphore.withPermit(instance)(
          Semaphore.withPermit(accountPermits(env.userId))(
            Effect.suspend(() => {
              live.add(entry)
              let runningCommand: Promise<RunResult> | undefined
              return attempt((signal) => {
                signal.addEventListener("abort", () => entry.controller.abort(), { once: true })
                if (signal.aborted) entry.controller.abort()
                return (runningCommand = selected.run(
                  {
                    command: script,
                    cwd: FILES_MOUNT,
                    mounts: accountMounts(env),
                    env: commandEnv(),
                    network: "none",
                    limits: { ...limits.run, timeoutMs }
                  },
                  entry.controller.signal
                ))
              }).pipe(Effect.ensuring(Effect.promise(async () => void (await runningCommand?.catch(() => undefined)))))
            })
          )
        )
      ).pipe(Effect.ensuring(Effect.sync(() => (live.delete(entry), leave(env.userId)))))
      if (entry.stopped !== null) return { ok: false, lines: [] as Array<string> }
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

  /**
   * Whether the workshop lets the app make a copy: its files and commands aren't Off. Where
   * either is Ask first, making it asks the user (`approve`), saying what's copied and where.
   */
  const copyMode = (ctx: ToolContext) =>
    Effect.gen(function* () {
      const grants = new Map(
        (yield* deps.reader.WorkshopGrants({ userId: ctx.userId, chatId: ctx.chatId, now: Date.now() })).map((g) => [
          g.capability,
          g.mode
        ])
      )
      const modes = ["files", "commands"].map((capability) =>
        resolveMode(deps.registries, grants, capability, "outside")
      )
      if (modes.includes("off"))
        return yield* Effect.fail(
          new ToolInputRefused("Copies need Change your files and Run commands, and one of them is off here.")
        )
      return modes.every((mode) => mode === "allow") ? ("allow" as const) : ("ask" as const)
    })
  const allowedCopy = (mode: "allow" | "ask", approve: ApproveCopy | undefined, copy: Parameters<ApproveCopy>[0]) =>
    Effect.gen(function* () {
      if (mode === "allow") return
      if (!approve || !(yield* approve(copy)))
        return yield* Effect.fail(new ToolInputRefused("The user didn't allow making the copy."))
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

  /** Keep the reply's relative directory even when Git didn't track it at the base commit. */
  const copyStart = (env: AccountEnv, path: string, wanted: string) =>
    Effect.promise(async () => {
      if (!wanted.startsWith(`${path}/`)) return path
      try {
        const { full, segments } = resolveFilesPath(wanted, FILES_MOUNT)
        if (!full.startsWith(`${path}/`)) return path
        const dir = await openFolder(env.filesRoot, segments, { create: true })
        await dir.close()
        return full
      } catch {
        // The requested path may have been a file or link at the checked-out commit.
        return path
      }
    })

  /** Digest of the copied tree's names, bytes, types and modes, ignoring times and ownership. */
  const copyFingerprint = (path: string) =>
    `( cd -- ${q(path)} || exit 1; sockets=$(find . -type s -print -quit) || exit 1; [ -z "$sockets" ] || exit 1; LC_ALL=C tar --sort=name --format=gnu --mtime=@0 --owner=0 --group=0 -cf - . ) | sha256sum`

  /** A git repository's files at a commit, in bytes: what a worktree of it takes. */
  const treeBytes = (rev: string) =>
    `${GIT} -C "$top" ls-tree -r -l ${rev} | awk '{ if ($4 ~ /^[0-9]+$/) s += $4 } END { print s + 0 }'`

  /**
   * A copy of `from` for a subagent at /files/.subagents/<name>: a git worktree on the new branch
   * subagent/<name> when `from` is in a repository with a commit, else a file copy (the copies
   * folder left out). Within the Files quota, checked before it's made; under Ask first, only
   * once the user allows it. A branch of that name that's already there is the user's: refused,
   * never touched.
   */
  const makeCopy = (ctx: ToolContext, name: string, from: string, approve?: ApproveCopy) =>
    Effect.gen(function* () {
      if (!/^[a-z0-9][a-z0-9_-]{0,80}$/.test(name)) return yield* Effect.fail(new ToolInputRefused("Bad copy name."))
      const mode = yield* copyMode(ctx)
      const env = accountEnv(deps, ctx.userId)
      yield* attempt(() => prepareAccount(env))
      const source = yield* folderAt(env, from)
      const path = `${FILES_MOUNT}/${COPIES}/${name}`
      const branch = `subagent/${name}`
      const probe = yield* copyScript(
        env,
        [
          SAFE_GIT,
          `from=${q(source)}; dest=${q(path)}; branch=${q(branch)}`,
          `if [ -L ${q(`${FILES_MOUNT}/${COPIES}`)} ]; then echo link; exit 0; fi`,
          `if [ -e "$dest" ] || [ -L "$dest" ]; then echo taken; exit 0; fi`,
          `if top=$(${GIT} -C "$from" rev-parse --show-toplevel 2>/dev/null) && base=$(${GIT} -C "$from" rev-parse --verify -q HEAD); then`,
          `  safe_git "$top"`,
          `  if ${GIT} -C "$top" rev-parse --verify -q "refs/heads/$branch" >/dev/null; then echo taken; exit 0; fi`,
          `  echo git; echo "$top"; echo "p:$(${GIT} -C "$from" rev-parse --show-prefix)"; echo "$base"`,
          `  ${treeBytes("HEAD")}`,
          `else echo files; du -sb --exclude=${COPIES} "$from" | cut -f1; fi`
        ].join("\n"),
        120_000,
        ctx.chatId
      )
      const [kind, ...rest] = probe.lines.filter((line) => line !== "")
      if (!probe.ok || (kind !== "git" && kind !== "files"))
        return yield* Effect.fail(
          new ToolInputRefused(
            kind === "taken"
              ? `${path} or its branch ${branch} is already there.`
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
      yield* allowedCopy(mode, approve, { path, from: source, ...(isGit ? { branch } : {}) })
      const made = yield* copyScript(
        env,
        isGit
          ? [
              SAFE_GIT,
              `top=${q(top)}; branch=${q(branch)}`,
              `safe_git "$top"`,
              // Made only now, so a branch made meanwhile is never taken over (or removed below).
              `if ${GIT} -C "$top" rev-parse --verify -q "refs/heads/$branch" >/dev/null; then echo taken; exit 1; fi`,
              `mkdir -p ${q(`${FILES_MOUNT}/${COPIES}`)} && ${GIT} -C "$top" worktree add --quiet -b "$branch" ${q(path)} ${q(base)}`
            ].join("\n")
          : [
              "set -o pipefail",
              `mkdir -p ${q(path)} && tar -C ${q(source)} --exclude=./${COPIES} -cf - . | tar -C ${q(path)} -xf - || exit 1`,
              `fingerprint=$(${copyFingerprint(path)}) && printf 'fingerprint:%s\\n' "\${fingerprint%% *}" || :`
            ].join("\n"),
        600_000,
        ctx.chatId
      )
      if (!made.ok) {
        // The branch goes only where this made it: one that was there before is the user's.
        const ours = !made.lines.includes("taken")
        yield* removeCopy(env, {
          path,
          from: source,
          kind: isGit ? "git" : "files",
          ...(isGit ? { top, ...(ours ? { branch } : {}) } : {})
        })
        return yield* Effect.fail(new ToolInputRefused("The copy couldn't be made."))
      }
      const fingerprint = made.lines.find((line) => /^fingerprint:[0-9a-f]{64}$/.test(line))?.slice(12)
      const copy: SubagentCopyRecord = isGit
        ? { path, from: source, kind: "git", top, branch, base }
        : { path, from: source, kind: "files", ...(fingerprint ? { fingerprint } : {}) }
      yield* madeCopy(env, copy)
      // It starts where the reply is, inside the copy.
      const start = yield* copyStart(env, path, posix.join(path, prefix).replace(/\/$/, ""))
      return { copy, start }
    })

  /** Removes a copy outright (a worktree, and its branch where the record names one), in the sandbox; true when it's gone. */
  const removeCopy = (env: AccountEnv, copy: SubagentCopyRecord) =>
    copyScript(
      env,
      [
        SAFE_GIT,
        `dest=${q(copy.path)}`,
        copy.kind === "git" && copy.top
          ? `safe_git ${q(copy.top)}; ${GIT} -C ${q(copy.top)} worktree remove --force "$dest" 2>/dev/null; ${GIT} -C ${q(copy.top)} worktree prune${copy.branch ? `; ${GIT} -C ${q(copy.top)} branch -D -q ${q(copy.branch)} 2>/dev/null` : ""}`
          : "",
        `rm -rf -- "$dest"; rmdir ${q(`${FILES_MOUNT}/${COPIES}`)} 2>/dev/null; [ ! -e "$dest" ] && echo removed`
      ].join("\n"),
      120_000,
      null
    ).pipe(Effect.map((out) => out.lines.includes("removed")))

  /**
   * At a subagent's end: a copy with no changes is removed (a worktree whose status, ignored
   * files included, is clean and whose branch didn't move; a file copy the same as when it was made);
   * one with changes stays. Returns whether it stays. A copy that can't be checked stays.
   */
  const finishCopy = (userId: string, copy: SubagentCopyRecord) =>
    Effect.gen(function* () {
      const env = accountEnv(deps, userId)
      const check = yield* copyScript(
        env,
        [
          SAFE_GIT,
          `dest=${q(copy.path)}`,
          `if [ ! -d "$dest" ] || [ -L "$dest" ]; then echo gone; exit 0; fi`,
          copy.kind === "git"
            ? // Ignored files count: a fresh worktree has none, so any is the subagent's output.
              `safe_git "$dest"\nst=$(${GIT} -C "$dest" status --porcelain --untracked-files=all --ignored) || { echo changed; exit 0; }\nhead=$(${GIT} -C "$dest" rev-parse HEAD) || { echo changed; exit 0; }\nif [ -z "$st" ] && [ "$head" = ${q(copy.base ?? "")} ]; then echo same; else echo changed; fi`
            : copy.fingerprint === undefined
              ? "echo changed"
              : `set -o pipefail\nfingerprint=$(${copyFingerprint(copy.path)}) || exit 1\nif [ "$fingerprint" = ${q(`${copy.fingerprint}  -`)} ]; then echo same; else echo changed; fi`
        ].join("\n"),
        300_000,
        null
      )
      if (check.lines.includes("gone")) return false
      if (!check.ok || !check.lines.includes("same")) return true
      const removed = yield* removeCopy(env, copy)
      if (deps.quota) yield* deps.quota.afterCommand(env.userId).pipe(Effect.ignore)
      return !removed
    }).pipe(Effect.orElseSucceed(() => true))

  /**
   * A copy for a run that carries a subagent on: the same folder when it's still there, else made
   * again at the same place (a worktree on its branch when that's still there, keeping its commits),
   * within the quota and, under Ask first, once the user allows it.
   */
  const ensureCopy = (ctx: ToolContext, copy: SubagentCopyRecord, approve?: ApproveCopy, start = copy.path) =>
    Effect.gen(function* () {
      const env = accountEnv(deps, ctx.userId)
      yield* attempt(() => prepareAccount(env))
      const there = yield* folderAt(env, copy.path).pipe(Effect.option)
      if (there._tag === "Some") {
        const { kept: _kept, ...rest } = copy
        return { copy: rest, start: yield* copyStart(env, copy.path, start) }
      }
      if (copy.kind === "files" || !copy.top || !copy.branch) {
        const name = copy.path.slice(`${FILES_MOUNT}/${COPIES}/`.length)
        return yield* makeCopy(ctx, name, copy.from, approve)
      }
      const mode = yield* copyMode(ctx)
      // What it takes: its branch's files where the branch is still there, else its base's.
      const size = yield* copyScript(
        env,
        [
          SAFE_GIT,
          `top=${q(copy.top)}; branch=${q(copy.branch)}`,
          `safe_git "$top"`,
          `if ${GIT} -C "$top" rev-parse --verify -q "refs/heads/$branch" >/dev/null; then ${treeBytes('"refs/heads/$branch"')}; else ${treeBytes(q(copy.base ?? "HEAD"))}; fi`
        ].join("\n"),
        120_000,
        ctx.chatId
      )
      const bytes = Number(size.lines.find((line) => line !== ""))
      if (!size.ok || !Number.isFinite(bytes))
        return yield* Effect.fail(new ToolInputRefused("The copy couldn't be made again."))
      if (deps.quota) yield* deps.quota.check(env.userId, bytes, "copy a folder for a subagent")
      yield* allowedCopy(mode, approve, { path: copy.path, from: copy.from, branch: copy.branch, again: true })
      const made = yield* copyScript(
        env,
        [
          SAFE_GIT,
          `top=${q(copy.top)}; dest=${q(copy.path)}; branch=${q(copy.branch)}`,
          `safe_git "$top"`,
          `mkdir -p ${q(`${FILES_MOUNT}/${COPIES}`)} && ${GIT} -C "$top" worktree prune || exit 1`,
          `if ${GIT} -C "$top" rev-parse --verify -q "refs/heads/$branch" >/dev/null; then ${GIT} -C "$top" worktree add --quiet "$dest" "$branch" || exit 1; echo kept`,
          `else ${GIT} -C "$top" worktree add --quiet -b "$branch" "$dest" ${q(copy.base ?? "HEAD")} || exit 1; echo made; fi`
        ].join("\n"),
        600_000,
        ctx.chatId
      )
      if (!made.ok || !made.lines.some((line) => line === "kept" || line === "made"))
        return yield* Effect.fail(new ToolInputRefused("The copy couldn't be made again."))
      const { kept: _kept, ...again } = copy
      yield* madeCopy(env, again)
      return { copy: again, start: yield* copyStart(env, copy.path, start) }
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
    // Counted like any command: Reset waits for it, and it waits for Reset.
    enter(userId)
    try {
      await prepareAccount(env)
      const source = deps.appSource ? await deps.appSource().catch(() => null) : null
      return await selected.sandbox.run(
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
    } finally {
      leave(userId)
    }
  }

  return {
    workspaces,
    keepVersion,
    runQuiet,
    /**
     * Empties the account's home folder for commands (§3.6 Reset); refused while one of its
     * commands runs (any kind, counted from the call's start), and no command starts until it's
     * done. Its files stay.
     */
    resetHome: (userId: string) =>
      Effect.suspend(() => {
        // Checked and marked together, with nothing in between.
        if ((running.get(userId) ?? 0) > 0 || resetting.has(userId))
          return Effect.fail(new FilePathRefused("Commands are running. Wait for them, or stop them, first."))
        resetting.add(userId)
        const env = accountEnv(deps, userId)
        return Effect.gen(function* () {
          yield* attempt(() => prepareAccount(env))
          yield* attempt(async () => {
            const dir = await openFolder(env.home, [])
            try {
              for (const name of await readdir(`/proc/self/fd/${dir.fd}`)) await removeTreeAt(dir, name)
            } finally {
              await dir.close()
            }
          })
        }).pipe(Effect.ensuring(Effect.sync(() => resetting.delete(userId))))
      }),
    /** Stops every background command (the app is stopping). */
    stopAll: () => {
      for (const job of runningJobs()) job.live.controller.abort()
      // Foreground commands and the app's own for subagents' copies too.
      for (const entry of live) entry.controller.abort()
    },
    /**
     * Checks running commands (of these accounts, else all) again and stops those whose account,
     * workshop grant, host folder or shared folders no longer allow them; forgets ended
     * background commands whose output is gone. Answers how many were stopped.
     */
    recheckCommands: (userIds?: ReadonlyArray<string>, now = Date.now()) =>
      Effect.sync(() => pruneJobs(now)).pipe(Effect.andThen(live.size ? recheck(userIds) : Effect.succeed(0))),
    /** Background commands the app remembers, running or ended (for tests and the log). */
    jobCount: () => jobs.size,
    tools: [
      readTool,
      listTool,
      searchTool,
      writeTool,
      editTool,
      ...cardFileTools,
      bashTool,
      outputTool,
      stopTool
    ] as unknown as ReadonlyArray<RolloutTool<never>>,
    undoEffect,
    reverseCardFile,
    commandsUnavailable,
    commandsNote
  }
}
