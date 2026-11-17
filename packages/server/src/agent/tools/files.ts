// The workshop's file tools and commands (spec/FILES-AND-ENVIRONMENT.md §5.1, §5.2): registered
// by the files host (files/WorkshopFiles.ts), offered in standalone workshops. The file tools run
// in the app through the no-follow walk (files/safePath.ts) and reach /files only; `bash` runs in
// the selected command sandbox (sandbox/registry.ts). Every write and edit keeps the earlier
// content as a version and records a `file.*` effect with Undo; every command records a
// `shell.run` effect listing the files it changed, with no Undo. A call cut off without its
// receipt is never run again silently: the permit asks (agent/approvals.ts).
import { createHash } from "node:crypto"
import { readFile, statfs } from "node:fs/promises"
import { join, posix } from "node:path"
import { Type } from "@earendil-works/pi-ai"
import { Effect, Semaphore } from "effect"
import type { User } from "@rp/shared/domain.ts"
import type { RolloutEffect, RolloutEffectRecord } from "@rp/shared/workshopApi.ts"
import { foldState } from "@rp/shared/state.ts"
import { EffectUndoRefused } from "@rp/shared/workshopApi.ts"
import type { Reader, Writer } from "../../db/Database.ts"
import { isMediaPath } from "../../db/media.ts"
import { storeMedia } from "../../importer/mediaFiles.ts"
import {
  FilePathRefused,
  listFolder,
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
  scanTree,
  type AccountEnv
} from "../../files/environment.ts"
import { selectSandbox, type CommandSandbox, type RunLimits } from "../../sandbox/registry.ts"
import { QuotaExceeded, type FilesQuota } from "../../files/quota.ts"
import { sandboxPath } from "../../sandbox/linuxBwrap.ts"
import { COMMANDS_NETWORK, resolveMode, type CapabilityRegistries } from "../capabilities.ts"
import { ToolInputRefused, type RolloutTool, type ToolContext, type ToolOutput } from "../tools.ts"

export const FILE_TOOLS = ["read_file", "list_files", "search_files", "write_file", "edit_file", "bash"] as const

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
}

const READ_MAX_BYTES = 10 * 2 ** 20
const READ_LINES = 2000
const LINE_CHARS = 2000
const RESULT_CHARS = 30_000
const LIST_MAX = 500
const SEARCH_CHARS = 15_000
const VERSION_MAX_BYTES = 16 * 2 ** 20
const VERSIONS_PER_COMMAND = 256 * 2 ** 20
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
      const events = yield* deps.reader
        .StateEventsAt({ userId: ctx.userId, chatId: ctx.chatId, slotId: ctx.leafSlotId, forkId: ctx.forkId })
        .pipe(Effect.orElseSucceed(() => []))
      const folder = foldState(events).workshopFolder
      let start = FILES_MOUNT
      if (folder) {
        try {
          const { full, segments } = resolveFilesPath(folder.path, FILES_MOUNT)
          const info = yield* attempt(() => statPath(env.filesRoot, segments))
          if (info?.isDirectory()) start = full
        } catch {
          // A folder that's gone: the top of Files (§2.2).
        }
      }
      ctx.cache.set(CWD_KEY, start)
      return start
    })

  /** Stores bytes as a file version: the media file first, then its row, held from the sweep. */
  const keepVersion = (
    ctx: ToolContext | null,
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
        Effect.flatMap(({ actor, env }) => run(ctx, args, env, actor)),
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
    id: "read_file",
    label: "Read a file",
    capability: "files",
    effect: "read",
    replyTool: false,
    storyRead: "account",
    titleField: "path",
    description:
      "Read a file in your files (/files), with line numbers. Paths are absolute (/files/...) or relative to the working directory. offset and limit are lines (default: the first 2000). Images come back as images when the model can see them; other binary files are described. Read a file before you change it with write_file or edit_file.",
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
        const { full, segments } = resolveFilesPath(String(args.path), cwd)
        const { bytes, info, truncated } = yield* attempt(() =>
          readRegularFile(env.filesRoot, segments, READ_MAX_BYTES)
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
    id: "list_files",
    label: "Listed files",
    capability: "files",
    effect: "read",
    replyTool: false,
    storyRead: "account",
    titleField: "path",
    description:
      "List a folder in your files (/files): names, kinds, sizes and times, folders first. depth goes into subfolders (default 1, at most 6); glob filters by path relative to the folder (for example **/*.md). At most 500 entries. Links are shown, not followed.",
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
        const { full, segments } = resolveFilesPath(String(args.path ?? "."), cwd)
        const depth = Number(args.depth ?? 1)
        const pattern = typeof args.glob === "string" ? globToRegExp(args.glob) : null
        const found: Array<{ path: string; entry: Entry }> = []
        let more = false
        const walk = async (below: ReadonlyArray<string>, level: number): Promise<void> => {
          const listed = await listFolder(env.filesRoot, [...segments, ...below], LIST_MAX * 4)
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
    id: "search_files",
    label: "Searched files",
    capability: "files",
    effect: "read",
    replyTool: false,
    storyRead: "account",
    titleField: "pattern",
    description:
      "Search the text of your files (/files) with ripgrep: pattern is a regular expression. path narrows it to a folder or file, glob to file names (for example *.py), case: false ignores case, context adds lines around each match. At most 15000 characters.",
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
        const { full, segments } = resolveFilesPath(String(args.path ?? "."), cwd)
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
          const result = yield* attempt((signal) =>
            selected.run(
              {
                command,
                cwd: FILES_MOUNT,
                mounts: accountMounts(env),
                env: commandEnv(),
                network: "none",
                limits: { ...limits.run, timeoutMs: 60_000 }
              },
              signal
            )
          )
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
          const listed = await listFolder(env.filesRoot, [...segments, ...below], 2000).catch(() => null)
          for (const entry of listed?.entries ?? []) {
            if (matches.length >= 30 || budget.files <= 0) return
            if (entry.kind === "folder") await visit([...below, entry.name], budget)
            else if (entry.kind === "file" && entry.size <= 2 ** 20) {
              budget.files--
              const read = await readRegularFile(env.filesRoot, [...segments, ...below, entry.name], 2 ** 20).catch(
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
        const info = yield* attempt(() => statPath(env.filesRoot, segments))
        if (info?.isFile()) {
          const read = yield* attempt(() => readRegularFile(env.filesRoot, segments, 2 ** 20))
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
    segments: ReadonlyArray<string>,
    next: (before: Buffer | null) => Buffer,
    kind: "write" | "edit"
  ) =>
    Semaphore.withPermit(writeLock(env.userId))(
      Effect.gen(function* () {
        const info = yield* attempt(() => statPath(env.filesRoot, segments))
        if (info && !info.isFile()) throw new FilePathRefused(`${full} isn't a regular file.`)
        let before: { bytes: Buffer; inode: number } | null = null
        if (info) {
          const read = yield* attempt(() => readRegularFile(env.filesRoot, segments, VERSION_MAX_BYTES + 1))
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
        if (deps.quota) yield* deps.quota.check(env.userId, adding, "write files")
        const versionId = before ? yield* keepVersion(ctx, env.userId, full, before, "agent") : null
        const written = yield* attempt(() =>
          writeRegularFile(env.filesRoot, segments, content, { createFolders: true })
        )
        deps.quota?.wrote(env.userId, adding)
        const after = sha256(content)
        ctx.cache.set(readKey(full), after)
        const effectKind = before ? (kind === "edit" ? "file.edit" : "file.write") : "file.create"
        const effects: Array<RolloutEffectRecord> = [
          {
            kind: effectKind,
            targetKind: "file",
            targetId: full,
            title: `${before ? (kind === "edit" ? "Edited" : "Replaced") : "Created"} ${full}`,
            undo: { path: full, before: versionId, after, inode: written.ino }
          }
        ]
        return { before, written, effects }
      })
    )

  // --- write_file
  const writeTool: RolloutTool<Record<string, unknown>> = {
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
        const { full, segments } = resolveFilesPath(String(args.path), cwd)
        const content = Buffer.from(String(args.content), "utf8")
        const done = yield* replaceFile(ctx, env, full, segments, () => content, "write")
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
        const { full, segments } = resolveFilesPath(String(args.path), cwd)
        let replaced = 0
        const done = yield* replaceFile(
          ctx,
          env,
          full,
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

  /** Stores the new content of what a command changed (§7.2), within the per-command budget. */
  const keepCommandVersions = (
    ctx: ToolContext,
    env: AccountEnv,
    paths: ReadonlyArray<string>,
    deleted: ReadonlyArray<string>
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
      for (const path of paths) {
        const segments = path.split("/")
        const read = yield* attempt(() => readRegularFile(env.filesRoot, segments, VERSION_MAX_BYTES + 1)).pipe(
          Effect.orElseSucceed(() => null)
        )
        if (!read || read.truncated || read.bytes.byteLength > budget) continue
        budget -= read.bytes.byteLength
        yield* keepVersion(
          ctx,
          env.userId,
          `${FILES_MOUNT}/${path}`,
          { bytes: read.bytes, inode: read.info.ino },
          "command"
        ).pipe(Effect.ignore)
      }
      for (const path of deleted)
        yield* keepVersion(ctx, env.userId, `${FILES_MOUNT}/${path}`, null, "command").pipe(Effect.ignore)
    })

  // --- bash
  const bashTool: RolloutTool<Record<string, unknown>> = {
    id: "bash",
    label: "Ran a command",
    capability: "commands",
    effect: "outside",
    replyTool: false,
    storyRead: "account",
    titleField: "description",
    description: [
      "Run a bash command in a sandbox. It sees your files at /files (read and write), its own home folder at /home/user (kept between runs: pip install --user and npm install -g go there) and a private /tmp. Nothing else of the server is there.",
      "Available: bash and the usual command-line tools, git, python3, node and npm, and rg where the server has them; no system package manager (apt) and no root.",
      "The working directory carries over between calls in this run (cd works); each new message starts in the working folder. timeout_ms defaults to 120000 (at most 600000); then the command and everything it started are stopped.",
      "Network: when Internet from commands is on, HTTP and HTTPS reach public internet addresses through a proxy (curl, git clone https://…, pip, npm work); this server, the local network and other machines can't be reached, and raw TCP, UDP and SSH don't work.",
      "The result has the exit code, the directory after the call and the output (long output keeps its start and end). Files the command changed are listed; they can't be undone, so be careful with rm."
    ].join(" "),
    parameters: Type.Object(
      {
        command: Type.String({ minLength: 1, maxLength: 100_000 }),
        description: Type.Optional(Type.String({ maxLength: 200 })),
        timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600_000 })),
        cwd: Type.Optional(Type.String({ maxLength: 4096 }))
      },
      { additionalProperties: false }
    ),
    summarize: (args) => String(args.description ?? args.command ?? "").slice(0, 120),
    describe: (_ctx, args) =>
      Effect.succeed({
        title: "Run this command?",
        rows: [
          { label: "Command", value: String(args.command ?? "") },
          ...(args.cwd ? [{ label: "In", value: String(args.cwd) }] : [])
        ]
      }),
    execute: wrap("commands", (ctx, args, env) =>
      Effect.gen(function* () {
        const selected = yield* sandboxFor()
        if (typeof selected === "string")
          return { isError: true, text: `Commands can't run here: ${selected} The file tools still work.` }
        const grants = new Map(
          (yield* deps.reader.WorkshopGrants({ userId: ctx.userId, chatId: ctx.chatId, now: Date.now() })).map((g) => [
            g.capability,
            g.mode
          ])
        )
        const network =
          resolveMode(deps.registries, grants, COMMANDS_NETWORK, "outside") === "allow" ? "public" : "none"
        const start = yield* currentDir(ctx, env)
        const cwd =
          typeof args.cwd === "string" && args.cwd.trim() !== "" ? posix.resolve(start, args.cwd.trim()) : start
        const timeoutMs = Math.min(Number(args.timeout_ms ?? limits.defaultTimeoutMs), limits.maxTimeoutMs)
        if (deps.quota) yield* deps.quota.check(env.userId, 0, "run commands")
        const run = Effect.gen(function* () {
          const before = yield* attempt(() => scanTree(env.filesRoot))
          const result = yield* attempt((signal) =>
            selected.run(
              {
                command: String(args.command),
                cwd,
                mounts: accountMounts(env),
                env: commandEnv(),
                network,
                limits: { ...limits.run, timeoutMs }
              },
              signal
            )
          )
          const after = yield* attempt(() => scanTree(env.filesRoot))
          return { result, changes: diffScans(before, after) }
        })
        const { result, changes } = yield* Semaphore.withPermit(instance)(
          Semaphore.withPermit(accountPermits(env.userId))(run)
        )
        if (result.cwd) ctx.cache.set(CWD_KEY, result.cwd)
        yield* keepCommandVersions(ctx, env, [...changes.changed, ...changes.created], changes.deleted)
        // Commands can't be stopped mid-write by a quota: measured after, and the next refused.
        const overQuota = deps.quota
          ? yield* deps.quota.afterCommand(env.userId).pipe(Effect.orElseSucceed(() => null))
          : null
        const output = result.tail === "" ? result.head : `${result.head}\n…\n${result.tail}`
        const counts = [
          changes.changed.length ? `${changes.changed.length} changed` : "",
          changes.deleted.length ? `${changes.deleted.length} deleted` : "",
          changes.created.length ? `${changes.created.length} created` : ""
        ].filter(Boolean)
        const listed = [
          ...changes.changed.map((p) => `changed ${FILES_MOUNT}/${p}`),
          ...changes.created.map((p) => `created ${FILES_MOUNT}/${p}`),
          ...changes.deleted.map((p) => `deleted ${FILES_MOUNT}/${p}`)
        ]
        const status = result.diskLow
          ? "stopped: the server's disk is almost full, so commands can't write more now. Delete files you don't need, or ask the server's admin."
          : result.memoryCapped
            ? `stopped: the command used more than ${limits.run.memoryBytes / 2 ** 30} GiB of memory`
            : result.timedOut
              ? `stopped after ${timeoutMs} ms (timeout)`
              : result.outputCapped
                ? "stopped: the command wrote more than 256 MiB of output (redirect it to a file instead)"
                : `exit: ${result.exitCode === null ? "killed" : result.exitCode}`
        const text =
          `${status}\nDirectory after: ${result.cwd ?? cwd}\n` +
          (listed.length
            ? `Files changed: ${counts.join(", ")}${changes.partial ? " (many files changed; not all are listed)" : ""}\n${listed.slice(0, 50).join("\n")}${listed.length > 50 ? `\n… ${listed.length - 50} more` : ""}\n`
            : "") +
          (network === "none" ? "Internet from commands is off in this workshop.\n" : "") +
          (overQuota ? `${overQuota}\n` : "") +
          `Output (${result.outputBytes.toLocaleString("en-US")} bytes):\n${headTail(output)}`
        const short = String(args.command).split("\n")[0]!.slice(0, 80)
        return {
          text,
          isError:
            result.timedOut ||
            result.outputCapped ||
            result.diskLow === true ||
            result.memoryCapped === true ||
            result.exitCode !== 0,
          effects: [
            {
              kind: "shell.run",
              targetKind: "command",
              targetId: cwd,
              title: `Ran \`${short}\` in ${cwd}${counts.length ? `: ${counts.join(", ")}` : ""}`,
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
      const recipe = effect.undo as { path?: unknown; before?: unknown; after?: unknown } | null
      if (!recipe || typeof recipe.path !== "string" || typeof recipe.after !== "string")
        return yield* new EffectUndoRefused({ message: "This change cannot be undone." })
      const env = accountEnv(deps, actor.id)
      const { segments } = resolveFilesPath(recipe.path, FILES_MOUNT)
      return yield* Semaphore.withPermit(writeLock(env.userId))(
        Effect.gen(function* () {
          const current = yield* attempt(() => readRegularFile(env.filesRoot, segments, VERSION_MAX_BYTES + 1)).pipe(
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
            yield* attempt(() => writeRegularFile(env.filesRoot, segments, bytes))
          } else yield* attempt(() => removeFile(env.filesRoot, segments))
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

  return {
    tools: [readTool, listTool, searchTool, writeTool, editTool, bashTool] as unknown as ReadonlyArray<
      RolloutTool<never>
    >,
    undoEffect,
    commandsUnavailable,
    commandsNote
  }
}
