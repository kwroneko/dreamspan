// The file manager's HTTP routes (spec/FILES-AND-ENVIRONMENT.md §1.1, §8.1; the contract is
// `@dreamspan/shared/files.ts` FILES_ROUTES): list a folder, upload (streamed, to a temporary name, then
// renamed), serve a file's bytes (Range requests, never as the app's own content), make a folder,
// rename or move, and delete. Every access goes through the account's own tree and the no-follow
// walk (safePath.ts), never through a path as given: links and special files are listed and
// never opened. Main-thread async file I/O; SQLite only through the writer (file versions).
import { createHash, randomBytes } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, readFile, rename, rm, unlink, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { Transform, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { CurrentUser } from "@dreamspan/shared/api.ts"
import { AttachmentComposer } from "@dreamspan/shared/composerApi.ts"
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import {
  ATTACHMENT_MAX_BYTES,
  type FileEntry,
  type FileVersionEntry,
  type FolderShare,
  type RestoredVersion,
  AnswerInvitationRequest,
  type ShareInvitation,
  type UnavailableShare,
  lineEndingOf,
  normalizeLineEndings,
  SHARED_FOLDER,
  ShareRequest,
  FILES_ROUTES,
  type AttachedFile,
  FILES_TOP,
  isWithin,
  keepBothName,
  nameProblem,
  TEXT_OPEN_MAX_BYTES,
  type TextFile,
  UploadConflict,
  type FolderListing,
  type UploadOutcome
} from "@dreamspan/shared/files.ts"
import { NodeHttpServerRequest } from "@effect/platform-node"
import { ByteSize, Cause, Effect, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Accounts } from "../auth/Accounts.ts"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { MediaHolds } from "../importer/MediaHolds.ts"
import { placeStreamedMedia, storeMedia, streamToMedia } from "../importer/mediaFiles.ts"
import { Formats } from "../importer/Formats.ts"
import { describeImage } from "../importer/images.ts"
import { zipStream, type ZipStreamEntry } from "../formats/zipStream.ts"
import { isSafePath } from "../formats/zip.ts"
import { WorkshopFiles } from "./WorkshopFiles.ts"
import { BinContentGone } from "./bin.ts"
import { accountEnv, prepareAccount, resolveFilesPath } from "./environment.ts"
import {
  FilePathRefused,
  listFolder,
  openFolder,
  readRegularFile,
  renameNoReplace,
  statPath,
  writeRegularFile
} from "./safePath.ts"
import { isMediaPath } from "../db/media.ts"
import { birthOf, isSharedFolder, shareMountNames } from "./sharedFolders.ts"

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = constants

/** What a new folder takes on disk, counted until the next measurement. */
const FOLDER_BYTES = 4096

/** The largest file an upload takes (§1.1: 4 GiB, an instance setting later). */
const MAX_FILE_UPLOAD_BYTES = 4 * 1024 ** 3
/** The longest pause in an upload's body before it's dropped. */
const UPLOAD_IDLE_MS = 30_000
/**
 * Bytes of a refused upload's body still read (and dropped) before answering, so the browser
 * gets the answer rather than a reset connection. Past it the connection is dropped; the upload
 * screen checks the quota first (GetFilesUsage).
 */
const REFUSED_DRAIN_BYTES = 32 * 1024 * 1024
/** Entries a listing returns at most. */
const LIST_LIMIT = 5_000
/** Versions a file's list shows at most. */
const VERSIONS_LISTED = 200
/** Earlier content kept as a version when an upload replaces it or a delete removes it (§1.3, as for commands). */
const VERSION_MAX_BYTES = 16 * 1024 * 1024
/** Bytes a Range answer without an end sends at most, so a video player pages through a large file. */
const OPEN_RANGE_BYTES = 8 * 1024 * 1024

/** Types a viewer shows inline. HTML, SVG, XML and anything unknown are always attachments (§1.1). */
const INLINE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  json: "text/plain; charset=utf-8"
}

/** Other types an attachment's line names (§6.1); never served inline. */
const OTHER_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  xml: "application/xml",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  py: "text/x-python",
  css: "text/css",
  tsv: "text/tab-separated-values",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
  rtf: "application/rtf"
}

/** A file's type by its name, as an attachment's line names it. */
const typeOf = (name: string) =>
  (INLINE_TYPES[extension(name)] ?? OTHER_TYPES[extension(name)] ?? "application/octet-stream").replace(
    /; charset=.*$/,
    ""
  )

/** Images a model can be sent as blocks, as message images are (ARCHITECTURE §12). */
const BLOCK_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const extension = (name: string) => {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

const at = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`

/** What an entry name in a folder zip may not hold (§8.1): `\`, which Windows tools split on, and control characters. */
const UNSAFE_IN_ZIP = /[\\\u0000-\u001f\u007f]/
/** A name a folder zip takes as it is: none of the above, and not `.` or `..`. */
const zipSafeName = (name: string) => name !== "." && name !== ".." && !UNSAFE_IN_ZIP.test(name)
/** The note a folder zip ends with when it left names out. */
const ZIP_LEFT_OUT = "Left out of this zip.txt"

/** Attach copies one account makes at once, and how many more may wait for a turn. */
const ATTACH_AT_ONCE = 2
const ATTACH_WAITING = 32
/** An attached image is decoded (and can be sent as an image) up to this size, as message images are. */
const IMAGE_CHECK_BYTES = 16 * 1024 * 1024

/** Thrown when a file changes while it's copied for an attachment. */
const changedWhileCopied = () =>
  new Answer(409, "The file changed while it was being attached. Attach it again once it's saved.")

/**
 * Streams a regular file (opened without following a link) into the media folder, hashing it.
 * Refused when it isn't the file that was checked (another inode), or its size or modification
 * time changed by the end, or it gave more or fewer bytes than its size.
 */
async function copyAttachment(dataDir: string, root: string, segments: ReadonlyArray<string>, checked: Stats) {
  const dir = await openFolder(root, segments.slice(0, -1))
  let file: FileHandle
  try {
    file = await open(at(dir, segments.at(-1)!), O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } finally {
    await dir.close()
  }
  try {
    const before = await file.stat()
    if (!before.isFile() || before.ino !== checked.ino || before.size !== checked.size) throw changedWhileCopied()
    let head: Uint8Array = new Uint8Array(0)
    const chunks = (async function* () {
      let read = 0
      for await (const chunk of file.createReadStream({ autoClose: false }) as AsyncIterable<Uint8Array>) {
        read += chunk.byteLength
        if (read > before.size) throw changedWhileCopied()
        if (head.byteLength < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.byteLength)])
        yield chunk
      }
      if (read !== before.size) throw changedWhileCopied()
    })()
    const copied = await streamToMedia(dataDir, chunks)
    const after = await file.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      await rm(copied.temporary, { force: true })
      throw changedWhileCopied()
    }
    return { ...copied, head }
  } finally {
    await file.close()
  }
}

/** Entries one folder download takes at most. */
const ZIP_MAX_ENTRIES = 200_000

/** A regular file's bytes as they're read, opened without following a link; anything else is skipped. */
async function* regularFileChunks(root: string, segments: ReadonlyArray<string>): AsyncGenerator<Uint8Array> {
  const dir = await openFolder(root, segments.slice(0, -1))
  let file: FileHandle
  try {
    file = await open(at(dir, segments.at(-1)!), O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } finally {
    await dir.close()
  }
  try {
    if (!(await file.stat()).isFile()) return
    for await (const chunk of file.createReadStream({ autoClose: false }) as AsyncIterable<Uint8Array>) yield chunk
  } finally {
    await file.close()
  }
}

/** Reads and drops what's left of a refused body, up to REFUSED_DRAIN_BYTES and the idle limit. */
const drain = (message: NodeJS.ReadableStream) =>
  new Promise<void>((done) => {
    let dropped = 0
    let idle = setTimeout(() => sink.destroy(), UPLOAD_IDLE_MS)
    const sink = new Writable({
      write(chunk: Buffer, _encoding, next) {
        dropped += chunk.length
        clearTimeout(idle)
        idle = setTimeout(() => sink.destroy(), UPLOAD_IDLE_MS)
        next(dropped > REFUSED_DRAIN_BYTES ? new Error("too much to drop") : null)
      }
    })
    pipeline(message, sink)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(idle)
        done()
      })
  })

/** The answer for a refusal: the user reads `message`. */
const refuse = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ message }, { status, headers: { "cache-control": "no-store" } })

class Answer extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** What failed, from inside `Effect.try`/`tryPromise`'s wrapper. */
const unwrap = (error: unknown): unknown => (Cause.isUnknownError(error) ? error.cause : error)

/** Errors as answers: the walk's refusals and the file system's usual ones by their meaning. */
const answerOf = (error: unknown) => {
  const cause = unwrap(error)
  if (cause instanceof Answer) return Option.some(refuse(cause.status, cause.message))
  if (cause instanceof FilePathRefused) return Option.some(refuse(400, cause.message))
  if (cause instanceof BinContentGone) return Option.some(refuse(410, cause.message))
  if ((cause as { _tag?: unknown } | null)?._tag === "NotFound")
    return Option.some(refuse(404, "That isn't in the bin any more."))
  const code = (cause as NodeJS.ErrnoException | null)?.code
  if (code === "ENOENT") return Option.some(refuse(404, "Not found. It may have been moved or deleted."))
  if (code === "EEXIST" || code === "ENOTEMPTY") return Option.some(refuse(409, "That name is taken."))
  if (code === "ENOTDIR") return Option.some(refuse(400, "That isn't a folder."))
  if (code === "ENOSPC" || code === "EDQUOT") return Option.some(refuse(507, "There's no room left for files."))
  return Option.none()
}

const answering = <R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      Option.match(answerOf(error), {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.logError("a file route failed", error).pipe(Effect.as(refuse(500, "That didn't work on the server.")))
      })
    )
  )

const PathBody = Schema.Struct({ path: Schema.String.check(Schema.isMaxLength(4096)) })
const AttachBody = Schema.Struct({ ...PathBody.fields, composer: Schema.optionalKey(AttachmentComposer) })
const RestoreBody = Schema.Struct({ binItemId: Schema.String.check(Schema.isMaxLength(64)) })
const SHA256 = /^[0-9a-f]{64}$/

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const UnshareBody = Schema.Struct({ shareId: Schema.String.check(Schema.isMaxLength(64)) })

/** Invitations an account sends at most per `INVITE_WINDOW_MS` (§1.4): names can't be probed in bulk. */
const INVITES_PER_WINDOW = 20
const INVITE_WINDOW_MS = 10 * 60_000
const RestoreVersionBody = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(4096)),
  versionId: Schema.String.check(Schema.isMaxLength(64))
})

/** A share as the grantee reads it (`FileSharesGrantedTo`): accepted, by account ids, with its folder's identity. */
interface ShareWithMe {
  readonly id: string
  readonly ownerId: string
  readonly ownerHandle: string
  readonly path: string
  readonly mode: "view" | "edit"
  readonly createdAt: number
  readonly inode: number | null
  readonly device: number | null
  readonly birthMs: number | null
  readonly suspendedAt: number | null
}

/** A share in the grantee's Shared folder, by the name it has there (files/sharedFolders.ts `shareMountNames`). */
interface Mounted {
  readonly share: ShareWithMe
  readonly name: string
}

const MoveBody = Schema.Struct({
  from: Schema.String.check(Schema.isMaxLength(4096)),
  to: Schema.String.check(Schema.isMaxLength(4096))
})

export const filesRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const config = yield* AppConfig
    const writer = yield* Writer
    const reader = yield* Reader
    const formats = yield* Formats
    const holds = yield* MediaHolds
    // The account's Files quota (files/quota.ts): checked before an upload and as it streams.
    const { quota, bin, changed, recheckCommands } = yield* WorkshopFiles
    const dirs = {
      filesDir: config.filesDir || join(config.dataDir, "files"),
      homesDir: join(config.dataDir, "env-home")
    }

    const authenticated = <R>(handle: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, R>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const session = yield* Effect.option(accounts.resolve(request.headers))
        if (Option.isNone(session)) return refuse(401, "Log in first.")
        return yield* Effect.provideService(answering(handle), CurrentUser, session.value.user)
      })

    /** What is at a path of an account's own tree, or null (also for a path through a file or a link). */
    const ownStat = (userId: string, segments: ReadonlyArray<string>) =>
      Effect.promise(() => statPath(accountEnv(dirs, userId).filesRoot, segments).catch(() => null))

    /**
     * The folders other accounts share with this one, by owner segment, each by the name it has
     * there (§1.4): named by `shareMountNames` (files/sharedFolders.ts), as the file tools and
     * commands name them, so a path is the same in all three. A name the account's own
     * `Shared/<owner>` already holds is skipped, and an owner whose segment is the account's own
     * file or link there isn't offered: a share never hides the account's own files.
     */
    const ownersOf = (userId: string) =>
      Effect.gen(function* () {
        const shares = yield* reader.FileSharesGrantedTo({ userId: userId as never })
        const named = yield* Effect.promise(() =>
          shareMountNames(accountEnv(dirs, userId).filesRoot, shares).catch(() => [])
        )
        const owners = new Map<string, Array<Mounted>>()
        for (const entry of named)
          if (entry)
            owners.set(entry.owner, [...(owners.get(entry.owner) ?? []), { share: entry.share, name: entry.name }])
        return owners
      })

    /**
     * The folder a share was made on, if it's still at the share's path (§1.4): the same check
     * the file tools and commands make (`isSharedFolder`).
     */
    const sharedFolderInfo = (share: {
      readonly ownerId: string
      readonly path: string
      readonly inode: number | null
      readonly device: number | null
      readonly birthMs: number | null
      readonly suspendedAt: number | null
    }) =>
      Effect.gen(function* () {
        const base = yield* Effect.try(() => resolveFilesPath(share.path, FILES_TOP))
        const info = yield* ownStat(share.ownerId, base.segments)
        return { base, info, available: isSharedFolder(share, base.segments, info) }
      })

    /**
     * A path as the walk's components in the tree that holds it: the account's own, made on first
     * use, or, under `Shared/<owner>/<folder>`, the owner's (§1.4). `userId` is whose tree and
     * quota it is, `actorId` who acts; `full` is the path as the caller names it, `ownerFull` as
     * the owner does. A write in a folder shared to view is refused here. Paths are normalized
     * first (no `..`, `resolveFilesPath`), and the owner's tree is walked without following links.
     */
    const place = (path: string, access: "read" | "write" = "write") =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const env = accountEnv(dirs, user.id)
        yield* Effect.tryPromise(() => prepareAccount(env))
        const resolved = yield* Effect.try(() => resolveFilesPath(path, FILES_TOP))
        const own = {
          userId: user.id as string,
          actorId: user.id as string,
          root: env.filesRoot,
          full: resolved.full,
          ownerFull: resolved.full,
          segments: resolved.segments,
          share: null as ShareWithMe | null
        }
        const [top, owner, folder, ...rest] = resolved.segments
        if (top !== SHARED_FOLDER || owner === undefined) return own
        const shares = (yield* ownersOf(user.id)).get(owner)
        // No account of that name shares with you: it's your own folder of that name.
        if (!shares) return own
        // Your own folder of that name, where you have one, is yours as it always was.
        const ownFolder = yield* ownStat(user.id, [SHARED_FOLDER, owner])
        if (folder === undefined) {
          if (ownFolder) return own
          return yield* Effect.fail(new Answer(400, "Folders shared with you go here."))
        }
        const mounted = shares.find((candidate) => candidate.name === folder)
        if (!mounted) {
          if (ownFolder) return own
          return yield* Effect.fail(new Answer(404, "That folder isn't shared with you any more."))
        }
        const share = mounted.share
        const { base, available } = yield* sharedFolderInfo(share)
        if (!available)
          return yield* Effect.fail(
            new Answer(404, "Its owner moved or deleted this folder. It opens again once they share it again.")
          )
        if (access === "write" && share.mode === "view")
          return yield* Effect.fail(new Answer(403, "This folder is shared with you to view: it can't be changed."))
        return {
          userId: share.ownerId,
          actorId: user.id as string,
          root: accountEnv(dirs, share.ownerId).filesRoot,
          full: resolved.full,
          ownerFull: [share.path, ...rest].join("/"),
          segments: [...base.segments, ...rest],
          share
        }
      })

    /** Tells the open panels of both sides (§8.1): the owner's names and the caller's. */
    const changedAt = (placed: { userId: string; actorId: string; full: string; ownerFull: string }) => {
      changed(placed.userId, [placed.ownerFull])
      if (placed.actorId !== placed.userId) changed(placed.actorId, [placed.full])
    }

    /**
     * At the moment a write lands: the share it came through still lets this account change it,
     * and its folder is still the one shared (§1.4). A share stopped, made view-only or moved
     * away while an upload streamed refuses it.
     */
    const stillPlaced = (placed: { actorId: string; share: ShareWithMe | null }) =>
      Effect.gen(function* () {
        if (!placed.share) return
        const now = (yield* reader.FileSharesGrantedTo({ userId: placed.actorId as never })).find(
          (candidate) => candidate.id === placed.share!.id
        )
        if (!now || now.path !== placed.share.path)
          return yield* Effect.fail(new Answer(404, "That folder isn't shared with you any more."))
        if (now.mode !== "edit")
          return yield* Effect.fail(new Answer(403, "This folder is shared with you to view: it can't be changed."))
        if (!(yield* sharedFolderInfo(now)).available)
          return yield* Effect.fail(
            new Answer(404, "Its owner moved or deleted this folder. It opens again once they share it again.")
          )
      })

    /**
     * One change at a time to a file (§8.2): the editor's content check, the version kept and the
     * rename that lands it run under one lock per path of the tree, so two saves on the same base
     * can't both pass and the second overwrite the first unkept.
     */
    const pathLocks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>()
    const withPathLock = <A, E, R>(root: string, segments: ReadonlyArray<string>, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const key = `${root}\0${segments.join("/")}`
        const entry = pathLocks.get(key) ?? { lock: Semaphore.makeUnsafe(1), users: 0 }
        pathLocks.set(key, entry)
        entry.users++
        return entry.lock
          .withPermits(1)(effect)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (--entry.users === 0) pathLocks.delete(key)
              })
            )
          )
      })

    const queryOf = Effect.map(
      HttpServerRequest.HttpServerRequest,
      (request) => new URL(request.url, "http://files").searchParams
    )

    const jsonBody = <A>(schema: Schema.Codec<A, unknown>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!request.headers["content-type"]?.startsWith("application/json"))
          return yield* Effect.fail(new Answer(415, "Expected application/json."))
        return yield* HttpServerRequest.schemaBodyJson(schema).pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(64)),
          Effect.mapError(() => new Answer(400, "The request wasn't understood."))
        )
      })

    /** Keeps a file's content as a version before it's replaced or removed (§1.3), if it's small enough. */
    const keepVersion = (
      userId: string,
      root: string,
      segments: ReadonlyArray<string>,
      path: string,
      origin: string,
      actorId: string = userId
    ) => Effect.map(keptVersion(userId, root, segments, path, origin, actorId), (kept) => kept.bytes)

    /** As `keepVersion`, with the version's id (null when nothing was kept). */
    const keptVersion = (
      userId: string,
      root: string,
      segments: ReadonlyArray<string>,
      path: string,
      origin: string,
      actorId: string
    ) =>
      Effect.gen(function* () {
        const info = yield* Effect.tryPromise(() => statPath(root, segments))
        if (!info?.isFile() || info.size > VERSION_MAX_BYTES) return { bytes: 0, id: null }
        const { bytes } = yield* Effect.tryPromise(() => readRegularFile(root, segments, VERSION_MAX_BYTES))
        const sha256 = createHash("sha256").update(bytes).digest("hex")
        const [id] = yield* holds.holding(
          [sha256],
          Effect.andThen(
            storeMedia(config.dataDir, sha256, bytes),
            writer.RecordFileVersions({
              userId: userId as never,
              versions: [
                { path, inode: info.ino, sha256, mime: "application/octet-stream", byteSize: bytes.byteLength, origin }
              ],
              ...(actorId === userId ? {} : { actorUserId: actorId as never })
            })
          )
        )
        // The caller counts the version's bytes: a delete nets them against what it frees, an
        // upload adds them once the new file has landed (they don't take its own room).
        return { bytes: bytes.byteLength, id: id ?? null }
      })

    const entriesOf = (listed: Awaited<ReturnType<typeof listFolder>>): Array<FileEntry> =>
      listed.entries
        .filter((entry) => !entry.name.endsWith(".rp-tmp"))
        .map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          size: entry.kind === "file" ? entry.size : 0,
          mtimeMs: Math.round(entry.mtimeMs)
        }))

    const listingAnswer = (listing: FolderListing) =>
      HttpServerResponse.jsonUnsafe(listing, { headers: { "cache-control": "no-store" } })

    /** Invitations to this account (§1.4), as its listing shows them. */
    const invitationsFor = (userId: string) =>
      Effect.map(reader.ShareInvitationsReceived({ userId: userId as never }), (rows) =>
        rows.map((row): ShareInvitation => ({
          id: row.id,
          ownerHandle: row.handle,
          ownerName: row.displayName,
          folder: row.path.slice(row.path.lastIndexOf("/") + 1),
          mode: row.mode
        }))
      )

    /**
     * `Shared` and `Shared/<owner>` while other accounts share folders with this one (§1.4): the
     * owners, then their folders, with any of the account's own entries there kept beside them
     * (a share is named around them, never over them). A share whose folder its owner moved,
     * replaced or deleted is listed as unavailable. Null: not such a place.
     */
    const sharedListing = (path: string) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const resolved = yield* Effect.try(() => resolveFilesPath(path, FILES_TOP))
        const [top, owner, ...rest] = resolved.segments
        if (top !== SHARED_FOLDER || rest.length > 0) return null
        const owners = yield* ownersOf(user.id)
        const env = accountEnv(dirs, user.id)
        const ownList = (segments: ReadonlyArray<string>) =>
          Effect.promise(() => listFolder(env.filesRoot, segments, LIST_LIMIT).catch(() => null))
        if (owner === undefined) {
          const invitations = yield* invitationsFor(user.id)
          if (owners.size === 0 && invitations.length === 0) return null
          const now = Date.now()
          const own = yield* ownList([SHARED_FOLDER])
          const entries = [
            ...(own ? entriesOf(own).filter((entry) => !owners.has(entry.name)) : []),
            ...[...owners.keys()].map((name) => ({ name, kind: "folder" as const, size: 0, mtimeMs: now }))
          ]
          return {
            path: resolved.full,
            entries,
            more: own?.more ?? false,
            readOnly: false,
            bin: true,
            shared: "list" as const,
            ...(invitations.length > 0 ? { invitations } : {})
          }
        }
        const shares = owners.get(owner)
        if (!shares) return null
        const own = yield* ownList([SHARED_FOLDER, owner])
        const entries: Array<FileEntry> = own ? entriesOf(own) : []
        for (const { share, name } of shares) {
          const { info, available } = yield* sharedFolderInfo(share)
          entries.push({
            name,
            kind: "folder",
            size: 0,
            mtimeMs: Math.round(available ? info!.mtimeMs : share.createdAt),
            ...(available ? {} : { unavailable: true })
          })
        }
        // Your own folder there is yours to change; the shares beside it are reached by their names.
        return {
          path: resolved.full,
          entries,
          more: own?.more ?? false,
          readOnly: own === null,
          bin: own !== null,
          shared: "list" as const
        }
      })

    /** The owner's shares and invitations, each with whether its folder is still at its path (§1.4). */
    const ownShares = (userId: string) =>
      Effect.gen(function* () {
        const shares = yield* reader.SharedByMe({ userId: userId as never })
        const checked: Array<{ share: (typeof shares)[number]; available: boolean; folderThere: boolean }> = []
        for (const share of shares) {
          const { info, available } = yield* sharedFolderInfo({ ...share, ownerId: share.ownerUserId })
          checked.push({ share, available, folderThere: info?.isDirectory() ?? false })
        }
        const invitations = yield* reader.ShareInvitationsSent({ userId: userId as never })
        return { checked, invitations }
      })

    const list = Effect.gen(function* () {
      const query = yield* queryOf
      const path = query.get("path") ?? FILES_TOP
      const virtual = yield* sharedListing(path)
      if (virtual) return listingAnswer(virtual)
      const placed = yield* place(path, "read")
      const listed = yield* Effect.tryPromise(() => listFolder(placed.root, placed.segments, LIST_LIMIT))
      let entries = entriesOf(listed)
      const extra: { invitations?: Array<ShareInvitation>; unavailableShares?: Array<UnavailableShare> } = {}
      if (placed.share === null) {
        // Your folders shared with others (or offered) say so: only while their path holds the folder shared.
        const { checked, invitations } = yield* ownShares(placed.userId)
        const counts = new Map<string, number>()
        for (const { share, available } of checked)
          if (available) counts.set(share.path, (counts.get(share.path) ?? 0) + 1)
        for (const invitation of invitations) counts.set(invitation.path, (counts.get(invitation.path) ?? 0) + 1)
        if (counts.size > 0)
          entries = entries.map((entry) => {
            const count = entry.kind === "folder" ? counts.get(`${placed.full}/${entry.name}`) : undefined
            return count ? { ...entry, shared: count } : entry
          })
        if (placed.segments.length === 0) {
          // At the top: Shared appears once anything is shared with you or offered to you, with the offers.
          const received = yield* invitationsFor(placed.actorId)
          if (received.length > 0) extra.invitations = received
          if (!entries.some((entry) => entry.name === SHARED_FOLDER)) {
            const owners = yield* ownersOf(placed.actorId)
            if (owners.size > 0 || received.length > 0)
              entries.push({ name: SHARED_FOLDER, kind: "folder", size: 0, mtimeMs: Date.now() })
          }
          const lost = checked.filter((entry) => !entry.available)
          if (lost.length > 0)
            extra.unavailableShares = lost.map(({ share, folderThere }) => ({
              id: share.id,
              path: share.path,
              handle: share.handle,
              displayName: share.displayName,
              mode: share.mode,
              reason: share.suspendedAt !== null ? ("bin" as const) : ("moved" as const),
              folderThere
            }))
        }
      }
      return listingAnswer({
        ...extra,
        path: placed.full,
        entries,
        more: listed.more,
        // Can view: every change is refused (§1.4).
        readOnly: placed.share?.mode === "view",
        // Deleting moves to the bin, with Undo (§1.3); in a shared folder, to the owner's bin, so it asks first.
        bin: placed.share === null,
        ...(placed.share ? { shared: placed.share.mode } : {})
      })
    })

    const raw = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const query = yield* queryOf
      const { root, segments } = yield* place(query.get("path") ?? "", "read")
      if (segments.length === 0) return refuse(400, "Name a file.")
      const name = segments.at(-1)!
      const dir = yield* Effect.tryPromise(() => openFolder(root, segments.slice(0, -1)))
      const file = yield* Effect.tryPromise(() =>
        open(at(dir, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK).finally(() => dir.close())
      ).pipe(
        Effect.mapError((error) =>
          (unwrap(error) as NodeJS.ErrnoException | null)?.code === "ELOOP"
            ? new Answer(400, `“${name}” is a link. The app doesn't open links.`)
            : error
        )
      )
      const info = yield* Effect.tryPromise(() => file.stat()).pipe(
        Effect.tapError(() => Effect.promise(() => file.close()))
      )
      if (!info.isFile()) {
        yield* Effect.promise(() => file.close())
        return refuse(400, `“${name}” isn't a regular file.`)
      }
      const inline = query.get("download") === null ? INLINE_TYPES[extension(name)] : undefined
      const headers: Record<string, string> = {
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
        "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
        "accept-ranges": "bytes",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`
      }
      const size = info.size
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers["range"] ?? "")
      let start = 0
      let end = size - 1
      let status = 200
      if (range && size > 0) {
        if (range[1] === "") {
          start = Math.max(0, size - Number(range[2]))
        } else {
          start = Number(range[1])
          end =
            range[2] === "" ? Math.min(size - 1, start + OPEN_RANGE_BYTES - 1) : Math.min(size - 1, Number(range[2]))
        }
        if (start > end || start >= size) {
          yield* Effect.promise(() => file.close())
          return HttpServerResponse.empty({ status: 416, headers: { ...headers, "content-range": `bytes */${size}` } })
        }
        status = 206
        headers["content-range"] = `bytes ${start}-${end}/${size}`
      }
      const length = size === 0 ? 0 : end - start + 1
      if (length === 0) {
        yield* Effect.promise(() => file.close())
        return HttpServerResponse.uint8Array(new Uint8Array(0), {
          status,
          contentType: inline ?? "application/octet-stream",
          headers
        })
      }
      // The stream closes the handle when it ends or the client goes.
      const body = Stream.fromAsyncIterable(
        file.createReadStream({ start, end, autoClose: true }) as AsyncIterable<Uint8Array>,
        (error) => error
      )
      return HttpServerResponse.stream(body, {
        status,
        contentType: inline ?? "application/octet-stream",
        headers: { ...headers, "content-length": String(length) }
      })
    })

    /** A folder as one zip (§8.1), streamed as it's read: links and special files are left out. */
    const zip = Effect.gen(function* () {
      const query = yield* queryOf
      const { root, segments } = yield* place(query.get("path") ?? FILES_TOP, "read")
      const info = yield* Effect.tryPromise(() => statPath(root, segments))
      if (!info?.isDirectory()) return refuse(400, "That isn't a folder.")
      // The archive's own top folder: its name with what an extractor could read as a separator replaced.
      const top = (segments.at(-1) ?? "Files").replace(new RegExp(UNSAFE_IN_ZIP.source, "g"), "_")
      async function* entries(): AsyncGenerator<ZipStreamEntry> {
        // Depth first, each folder opened by the no-follow walk; names sorted for a stable archive.
        const queue: Array<ReadonlyArray<string>> = [[]]
        const topNames = new Set<string>()
        let count = 0
        /** Names an extractor could read as other paths: left out, and listed in a note. */
        const left: Array<string> = []
        while (queue.length) {
          const below = queue.pop()!
          const listed = await listFolder(root, [...segments, ...below], ZIP_MAX_ENTRIES)
          const folders: Array<ReadonlyArray<string>> = []
          for (const entry of listed.entries) {
            if (entry.name.endsWith(".rp-tmp")) continue
            if (++count > ZIP_MAX_ENTRIES) throw new Error("too many entries for one zip")
            if (entry.kind !== "folder" && entry.kind !== "file") continue
            const name = [top, ...below, entry.name].join("/")
            if (!zipSafeName(entry.name) || !isSafePath(name)) {
              left.push(JSON.stringify([...below, entry.name].join("/")))
              continue
            }
            if (below.length === 0) topNames.add(entry.name)
            if (entry.kind === "folder") folders.push([...below, entry.name])
            else yield { name, chunks: regularFileChunks(root, [...segments, ...below, entry.name]) }
          }
          queue.push(...folders.reverse())
        }
        if (left.length > 0)
          yield {
            name: `${top}/${topNames.has(ZIP_LEFT_OUT) ? keepBothName(ZIP_LEFT_OUT, topNames) : ZIP_LEFT_OUT}`,
            chunks: (async function* () {
              yield Buffer.from(
                `These names have a backslash, a control character or a ".." part, which some unzip tools treat as a path elsewhere, so they aren't in this zip. Download them one at a time.\n\n${left.join("\n")}\n`
              )
            })()
          }
      }
      const body = Stream.fromAsyncIterable(zipStream(entries()), (error) => error).pipe(
        Stream.tapError((error) => Effect.logWarning("a folder download stopped", error))
      )
      return HttpServerResponse.stream(body, {
        contentType: "application/zip",
        headers: {
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${top}.zip`)}`
        }
      })
    })

    /**
     * A text file for the editor (§8.2): its text and the hash of its bytes, which a save names
     * as `base`. Bytes that aren't UTF-8 are refused (415): the editor would change them on save.
     */
    const text = Effect.gen(function* () {
      const query = yield* queryOf
      const { root, full, segments } = yield* place(query.get("path") ?? "", "read")
      if (segments.length === 0) return refuse(400, "Name a file.")
      const info = yield* Effect.tryPromise(() => statPath(root, segments))
      if (!info) return refuse(404, "Not found. It may have been moved or deleted.")
      if (!info.isFile()) return refuse(400, "Only a file can be opened.")
      if (info.size > TEXT_OPEN_MAX_BYTES)
        return refuse(413, `Text files over ${formatByteSize(TEXT_OPEN_MAX_BYTES)} open read-only, a page at a time.`)
      const read = yield* Effect.tryPromise(() => readRegularFile(root, segments, TEXT_OPEN_MAX_BYTES))
      if (read.truncated)
        return refuse(413, `Text files over ${formatByteSize(TEXT_OPEN_MAX_BYTES)} open read-only, a page at a time.`)
      let decoded: string
      try {
        // The byte order mark is kept in the text here (`ignoreBOM`), and said apart below.
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes)
      } catch {
        return refuse(415, "This file isn't plain text, so the editor can't open it.")
      }
      // Line breaks and the byte order mark as the file has them, so a save writes them back (§8.2).
      const bom = decoded.charCodeAt(0) === 0xfeff
      const body = bom ? decoded.slice(1) : decoded
      const file: TextFile = {
        path: full,
        text: normalizeLineEndings(body),
        lineEnding: lineEndingOf(body),
        bom,
        sha256: sha256Of(read.bytes),
        size: read.bytes.byteLength,
        mtimeMs: read.info.mtimeMs
      }
      return HttpServerResponse.jsonUnsafe(file, { headers: { "cache-control": "private, no-store" } })
    })

    /** The hash of a file as it is now, or null when it isn't a regular file the editor could have opened. */
    const currentHash = (root: string, segments: ReadonlyArray<string>) =>
      Effect.tryPromise(() => readRegularFile(root, segments, TEXT_OPEN_MAX_BYTES)).pipe(
        Effect.map((read) => (read.truncated ? null : sha256Of(read.bytes))),
        Effect.catch(() => Effect.succeed(null))
      )

    const upload = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.headers["content-type"] !== "application/octet-stream")
        return refuse(415, "Expected application/octet-stream.")
      const query = yield* queryOf
      const conflict = Schema.decodeUnknownOption(UploadConflict)(query.get("conflict") ?? "ask")
      if (Option.isNone(conflict)) return refuse(400, "conflict must be ask, keep, replace or skip.")
      // An editor save (§8.2): it replaces the file only while it still is what the editor opened.
      const base = query.get("base")
      if (base !== null && (!SHA256.test(base) || conflict.value !== "replace"))
        return refuse(400, "base must be a SHA-256, with conflict=replace.")
      const declared = Number(request.headers["content-length"] ?? "0")
      if (declared > MAX_FILE_UPLOAD_BYTES)
        return refuse(413, `A file can be at most ${formatByteSize(MAX_FILE_UPLOAD_BYTES)}.`)
      const placed = yield* place(query.get("path") ?? "")
      // A shared folder's files are the owner's: their quota, their versions, the acting account recorded.
      const { userId, root, segments } = placed
      if (segments.length === 0 || (placed.share && placed.full.split("/").length <= 5))
        return refuse(400, "Name the file.")
      const problem = nameProblem(segments.at(-1)!)
      if (problem) return refuse(400, problem)
      const parent = segments.slice(0, -1)
      // As the caller names it: the answer's path, and the version's in the owner's names.
      const parentPath = placed.full.slice(0, placed.full.lastIndexOf("/"))
      const ownerParent = placed.ownerFull.slice(0, placed.ownerFull.lastIndexOf("/"))
      const message = NodeHttpServerRequest.toIncomingMessage(request)
      // Folders this upload makes take room too (counted until the next measurement).
      const made = yield* Effect.tryPromise(async () => {
        for (let i = 0; i < parent.length; i++)
          if (!(await statPath(root, parent.slice(0, i + 1)).catch(() => null))) return parent.length - i
        return 0
      })
      const dir = yield* Effect.tryPromise(() => openFolder(root, parent, { create: true }))
      quota.wrote(userId, made * FOLDER_BYTES)
      return yield* Effect.gen(function* () {
        let name = segments.at(-1)!
        const existing = yield* Effect.tryPromise(() => lstat(at(dir, name)).catch(() => null))
        let outcome: UploadOutcome["outcome"] = "written"
        let replacedBytes = 0
        /** What replacing frees for sure: a file with other links keeps its bytes. */
        let freesOnReplace = 0
        if (base !== null) {
          const now = existing?.isFile() ? yield* currentHash(root, segments) : null
          if (now !== base)
            return HttpServerResponse.jsonUnsafe(
              { changed: true, message: existing ? "It changed since you opened it." : "It isn't there any more." },
              { status: 409 }
            )
        }
        if (existing) {
          if (conflict.value === "ask") return HttpServerResponse.jsonUnsafe({ taken: true }, { status: 409 })
          if (conflict.value === "skip")
            return HttpServerResponse.jsonUnsafe({ path: `${parentPath}/${name}`, outcome: "skipped" })
          if (conflict.value === "replace") {
            if (existing.isDirectory()) return refuse(409, `“${name}” is a folder here. Choose Keep both or Skip.`)
            outcome = "replaced"
            // A file with other links keeps its bytes: nothing is replaced, nothing freed.
            replacedBytes = existing.isFile() && existing.nlink === 1 ? existing.size : 0
            freesOnReplace = replacedBytes
          } else {
            const taken = new Set(
              (yield* Effect.tryPromise(() => listFolder(root, parent, LIST_LIMIT))).entries.map((e) => e.name)
            )
            name = keepBothName(name, taken)
          }
        }
        // Over the quota, or past it with what the request says it sends, it's refused before
        // a byte is written; as it streams, each chunk takes room (uploads at once share it).
        // A replaced file's bytes are free again once it lands.
        const room = yield* quota.check(userId, Math.max(0, declared - replacedBytes), "upload files").pipe(
          Effect.catch((error) =>
            Effect.andThen(
              Effect.promise(() => drain(message)),
              Effect.fail(new Answer(507, error.message))
            )
          )
        )
        /** What the version of the replaced content takes: counted once it's kept, whatever follows. */
        let keptBytes = 0
        const digest = createHash("sha256")
        let taken = 0
        /** What the quota's room took for this upload: given back whole on failure. */
        const held = quota.hold(userId)
        let freeToken = 0
        const take = (bytes: number) => {
          const more = Math.max(0, taken + bytes - replacedBytes) - Math.max(0, taken - replacedBytes)
          if (more > 0 && !held.reserve(more, room.quotaBytes)) return false
          taken += bytes
          return true
        }
        const temporary = `.${name.slice(0, 200)}.${randomBytes(6).toString("hex")}.rp-tmp`
        yield* Effect.tryPromise(async () => {
          const handle = await open(at(dir, temporary), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)
          let received = 0
          let idle: NodeJS.Timeout | undefined
          // Out of room, the rest of the body is read and dropped (up to REFUSED_DRAIN_BYTES), so
          // the answer reaches the browser; then the file is removed and the refusal answered.
          let refused: Answer | null = null
          let dropped = 0
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              received += chunk.length
              clearTimeout(idle)
              idle = setTimeout(() => counter.destroy(new Answer(408, "The file stopped arriving.")), UPLOAD_IDLE_MS)
              if (refused) {
                dropped += chunk.length
                done(dropped > REFUSED_DRAIN_BYTES ? refused : null)
              } else if (received > MAX_FILE_UPLOAD_BYTES)
                done(new Answer(413, `A file can be at most ${formatByteSize(MAX_FILE_UPLOAD_BYTES)}.`))
              else if (!take(chunk.length)) {
                refused = new Answer(
                  507,
                  quota.overMessage(room.usedBytes + received - replacedBytes, room.quotaBytes, "upload files")
                )
                done()
              } else {
                digest.update(chunk)
                done(null, chunk)
              }
            }
          })
          idle = setTimeout(() => counter.destroy(new Answer(408, "The file stopped arriving.")), UPLOAD_IDLE_MS)
          try {
            // The write stream owns the handle: it syncs (`flush`) and closes it when done. With
            // `autoClose: false` the pipeline would wait for a close that never comes.
            await pipeline(message, counter, handle.createWriteStream({ flush: true }))
            if (refused) throw refused
          } catch (error) {
            await handle.close().catch(() => undefined)
            await unlink(at(dir, temporary)).catch(() => undefined)
            held.release()
            throw error
          } finally {
            clearTimeout(idle)
          }
        })
        // It lands under the path's lock (§8.2): the share is checked again, an editor save's base
        // is checked again just before the rename, and the content replaced is kept as a version
        // as it is at that moment. A name taken meanwhile (not replacing) is never written over.
        const target = [...parent, name]
        const landed = yield* withPathLock(
          root,
          target,
          Effect.gen(function* () {
            yield* stillPlaced(placed)
            if (base !== null && (yield* currentHash(root, target)) !== base) return false
            if (outcome === "replaced")
              keptBytes = yield* keepVersion(
                userId,
                root,
                target,
                `${ownerParent}/${name}`,
                base === null ? "upload" : "editor",
                placed.actorId
              )
            yield* Effect.tryPromise(async () => {
              // What the new file takes is already counted as it arrived; the old one's bytes are
              // freed unless a version kept them (counted in keepVersion). Lowered before the
              // old file goes, so a measurement in between can only over-count.
              freeToken = quota.freed(userId, Math.max(0, freesOnReplace - taken))
              try {
                if (outcome === "replaced") await rename(at(dir, temporary), at(dir, name))
                else await renameNoReplace(at(dir, temporary), at(dir, name))
              } catch (error) {
                quota.unfreed(userId, freeToken)
                throw error
              }
              held.landed()
            })
            return true
          })
        ).pipe(
          Effect.tapError(() =>
            Effect.promise(async () => {
              await unlink(at(dir, temporary)).catch(() => undefined)
              held.release()
            })
          ),
          Effect.ensuring(Effect.sync(() => quota.wrote(userId, keptBytes)))
        )
        if (!landed) {
          yield* Effect.promise(() => unlink(at(dir, temporary)).catch(() => undefined))
          held.release()
          return HttpServerResponse.jsonUnsafe(
            { changed: true, message: "It changed since you opened it." },
            { status: 409 }
          )
        }
        changedAt({ ...placed, full: `${parentPath}/${name}`, ownerFull: `${ownerParent}/${name}` })
        return HttpServerResponse.jsonUnsafe({
          path: `${parentPath}/${name}`,
          outcome,
          sha256: digest.digest("hex")
        } satisfies UploadOutcome)
      }).pipe(Effect.ensuring(Effect.promise(() => dir.close())))
    })

    const folder = Effect.gen(function* () {
      const body = yield* jsonBody(PathBody)
      const placed = yield* place(body.path)
      const { userId, root, full, segments } = placed
      if (segments.length === 0 || (placed.share && full.split("/").length <= 5)) return refuse(400, "Name the folder.")
      const problem = nameProblem(segments.at(-1)!)
      if (problem) return refuse(400, problem)
      const dir = yield* Effect.tryPromise(() => openFolder(root, segments.slice(0, -1)))
      yield* Effect.tryPromise(() => mkdir(at(dir, segments.at(-1)!), { mode: 0o755 })).pipe(
        Effect.ensuring(Effect.promise(() => dir.close()))
      )
      quota.wrote(userId, FOLDER_BYTES)
      changedAt(placed)
      return HttpServerResponse.jsonUnsafe({ path: full })
    })

    const move = Effect.gen(function* () {
      const body = yield* jsonBody(MoveBody)
      const from = yield* place(body.from)
      const to = yield* place(body.to)
      if (from.segments.length === 0 || to.segments.length === 0) return refuse(400, "The top folder can't be moved.")
      // Within one tree: your own, or one shared folder (the shared folder itself stays where its owner put it).
      if (from.share?.id !== to.share?.id)
        return refuse(
          400,
          "Files move only within your own files or within one shared folder. Download and upload to copy them."
        )
      if (from.share && (from.full.split("/").length <= 5 || to.full.split("/").length <= 5))
        return refuse(400, "Only its owner can move or rename a shared folder.")
      const problem = nameProblem(to.segments.at(-1)!)
      if (problem) return refuse(400, problem)
      if (to.full !== from.full && isWithin(to.full, from.full)) return refuse(400, "A folder can't go inside itself.")
      const source = yield* Effect.tryPromise(() => openFolder(from.root, from.segments.slice(0, -1)))
      return yield* Effect.gen(function* () {
        const target = yield* Effect.tryPromise(() => openFolder(to.root, to.segments.slice(0, -1)))
        return yield* Effect.gen(function* () {
          const fromName = at(source, from.segments.at(-1)!)
          const toName = at(target, to.segments.at(-1)!)
          const moving = yield* Effect.tryPromise(() => lstat(fromName))
          // Never over what's there, even something a command makes meanwhile (EEXIST: 409).
          yield* Effect.tryPromise(() => renameNoReplace(fromName, toName))
          // The working folders stored for it (and for folders in it) follow (§1 "Paths are the names").
          // In a shared folder, the owner's (by their names) as well as the caller's.
          if (moving.isDirectory())
            for (const [userId, fromPath, toPath] of [
              [from.actorId, from.full, to.full],
              ...(from.share ? [[from.userId, from.ownerFull, to.ownerFull]] : [])
            ])
              yield* writer
                .RecordFolderMove({ userId: userId as never, from: fromPath!, to: toPath! })
                .pipe(Effect.catchCause((cause) => Effect.logWarning("recording a folder move failed", cause)))
          // What names it (unsaved edits) follows it to its new path (§1.1).
          yield* writer.MoveFileReferences({ userId: from.actorId as never, from: from.full, to: to.full })
          // In a shared folder, the owner's own references (their edits, their shares) follow too.
          if (from.share)
            yield* writer.MoveFileReferences({ userId: from.userId as never, from: from.ownerFull, to: to.ownerFull })
          changedAt(from)
          changedAt(to)
          return HttpServerResponse.jsonUnsafe({ path: to.full })
        }).pipe(Effect.ensuring(Effect.promise(() => target.close())))
      }).pipe(Effect.ensuring(Effect.promise(() => source.close())))
    })

    const remove = Effect.gen(function* () {
      const body = yield* jsonBody(PathBody)
      const placed = yield* place(body.path)
      const { userId, root, segments } = placed
      if (segments.length === 0) return refuse(400, "The top folder can't be deleted.")
      if (placed.share && placed.full.split("/").length <= 5)
        return refuse(400, "Only its owner can delete a shared folder.")
      const info = yield* Effect.tryPromise(() => statPath(root, segments))
      if (!info) return refuse(404, "Not found. It may have been moved or deleted.")
      // To the bin (§1.3): its bytes stay counted, under the bin, until it's emptied. In a
      // shared folder, the owner's bin: they can restore it; the caller has no Undo.
      const user = yield* CurrentUser
      // Shares of it or of folders in it stop as it goes to the bin: their accounts' commands too.
      const stopping = placed.share
        ? []
        : (yield* reader.SharedByMe({ userId: user.id }))
            .filter((share) => isWithin(share.path, placed.ownerFull))
            .map((share) => share.granteeUserId)
      const item = yield* bin.toBin(
        userId,
        root,
        segments,
        placed.ownerFull,
        placed.share ? { userId: user.id, handle: user.handle } : undefined
      )
      changedAt(placed)
      if (stopping.length > 0) yield* recheckCommands([...new Set(stopping)])
      return HttpServerResponse.jsonUnsafe({ binItemId: placed.share ? null : item.id })
    })

    /** Attach copies running per account, with how many wait (`ATTACH_AT_ONCE`, `ATTACH_WAITING`). */
    const attaching = new Map<
      string,
      { readonly gate: Semaphore.Semaphore; readonly recording: Semaphore.Semaphore; waiting: number }
    >()

    /**
     * A file of the account's Files attached to a workshop message (§6.1): its content is kept
     * in the media store as the copy the message sends, so a later change to the file never
     * rewrites what the message showed or what a reply saw. The copy is streamed (never held
     * whole), counts in the Files quota as a version of origin `attachment` until nothing names
     * it, and is refused if the file changes while it's read. An image a model can see (checked
     * by decoding it) is marked `image`, with its size, as message images are; anything else,
     * whatever its name, is a plain file.
     */
    const attach = Effect.gen(function* () {
      const body = yield* jsonBody(AttachBody)
      // The copy as sent is the caller's, whoever's tree the file is in.
      const { actorId: userId, root, full, segments } = yield* place(body.path, "read")
      if (segments.length === 0) return refuse(400, "Name a file.")
      const name = segments.at(-1)!
      const problem = nameProblem(name)
      if (problem) return refuse(400, problem)
      const info = yield* Effect.tryPromise(() => statPath(root, segments))
      if (!info?.isFile()) return refuse(400, "Only a file can be attached.")
      if (info.size > ATTACHMENT_MAX_BYTES)
        return refuse(
          413,
          `Attachments can be at most ${formatByteSize(ATTACHMENT_MAX_BYTES)}. The assistant can still open it at ${full}.`
        )
      const slot = attaching.get(userId) ?? {
        gate: Semaphore.makeUnsafe(ATTACH_AT_ONCE),
        recording: Semaphore.makeUnsafe(1),
        waiting: 0
      }
      attaching.set(userId, slot)
      if (slot.waiting >= ATTACH_WAITING)
        return refuse(429, "Too many files are being attached. Try again in a moment.")
      slot.waiting++
      return yield* Effect.gen(function* () {
        const copied = yield* Effect.tryPromise(() => copyAttachment(config.dataDir, root, segments, info))
        return yield* Effect.gen(function* () {
          // Only a block image the image worker decodes is an image; a file that fails is a
          // plain file, never recorded with an image type (its bytes would be sent as one).
          let image: { mime: string; width: number | null; height: number | null } | null = null
          if (BLOCK_IMAGES.has(describeImage(copied.head).mime) && copied.size <= IMAGE_CHECK_BYTES) {
            const bytes = yield* Effect.tryPromise(() => readFile(copied.temporary))
            const described = describeImage(bytes)
            if (BLOCK_IMAGES.has(described.mime) && (yield* formats.validateImage(bytes))) image = described
          }
          const named = typeOf(name)
          const mime = image?.mime ?? (named.startsWith("image/") ? "application/octet-stream" : named)
          const record = (adding: number) =>
            Effect.gen(function* () {
              const usage = yield* quota
                .check(userId, adding, "attach files")
                .pipe(Effect.mapError((error) => new Answer(507, error.message)))
              const reservation = adding > 0 ? quota.hold(userId, true) : null
              let landed = false
              return yield* Effect.gen(function* () {
                if (reservation && !reservation.reserve(adding, usage.quotaBytes))
                  return yield* Effect.fail(
                    new Answer(507, quota.overMessage(usage.usedBytes + adding, usage.quotaBytes, "attach files"))
                  )
                const saved = yield* holds.holding(
                  [copied.sha256],
                  Effect.gen(function* () {
                    yield* placeStreamedMedia(config.dataDir, copied.temporary, copied.sha256, copied.size)
                    return yield* writer
                      .RecordAttachmentCopy({
                        userId: userId as never,
                        path: full,
                        inode: info.ino,
                        maxAddedBytes: adding,
                        ...(body.composer ? { composer: body.composer } : {}),
                        media: {
                          sha256: copied.sha256,
                          mime,
                          byteSize: copied.size,
                          width: image?.width ?? null,
                          height: image?.height ?? null
                        }
                      })
                      .pipe(
                        Effect.catchTag("NotFound", () =>
                          Effect.fail(new Answer(404, "That composer draft isn't available."))
                        )
                      )
                  })
                )
                if (saved?.addedBytes) {
                  reservation?.landed()
                  landed = true
                }
                return saved
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (!landed) reservation?.release()
                  })
                )
              )
            }).pipe(Effect.uninterruptible)

          // Copies may hash in parallel; charge and record them one at a time for this account.
          const recorded = yield* Effect.gen(function* () {
            const held = yield* reader.FileVersionBytes({ userId: userId as never, sha256: copied.sha256 })
            const first = yield* record(held > 0 ? 0 : copied.size)
            return first ?? (yield* record(copied.size))
          }).pipe(slot.recording.withPermits(1))
          if (recorded === null) return refuse(507, "There's no room left for files.")
          // Those bytes recorded earlier under another type (a version's) are sent as that.
          const isImage = image !== null && recorded.mime === image.mime
          const attached: AttachedFile = {
            mediaId: recorded.mediaId,
            kind: isImage ? "image" : "file",
            name,
            path: full,
            mime: recorded.mime,
            size: copied.size
          }
          return HttpServerResponse.jsonUnsafe(attached, { headers: { "cache-control": "no-store" } })
        }).pipe(Effect.ensuring(Effect.promise(() => rm(copied.temporary, { force: true }))))
      }).pipe(
        slot.gate.withPermits(1),
        Effect.ensuring(
          Effect.sync(() => {
            slot.waiting--
          })
        )
      )
    })

    /** An attachment's copy as sent (§6.1), served as `raw` serves files: never as the app's own content. */
    const attachment = Effect.gen(function* () {
      const query = yield* queryOf
      const user = yield* CurrentUser
      const file = yield* reader
        .GetMediaFile({ userId: user.id, mediaId: query.get("id") ?? "" })
        .pipe(Effect.mapError(() => new Answer(404, "That attachment isn't here any more.")))
      const name = (query.get("name") ?? "attachment").slice(0, 255) || "attachment"
      const inline = query.get("download") === null ? INLINE_TYPES[extension(name)] : undefined
      // Streamed: an attachment can be 64 MiB, and several can be downloaded at once.
      const handle = yield* Effect.tryPromise(() => open(join(config.dataDir, file.path), O_RDONLY | O_NOFOLLOW))
      const size = yield* Effect.tryPromise(() => handle.stat()).pipe(
        Effect.map((stats) => stats.size),
        Effect.tapError(() => Effect.promise(() => handle.close()))
      )
      const headers = {
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
        "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`
      }
      if (size === 0) {
        yield* Effect.promise(() => handle.close())
        return HttpServerResponse.uint8Array(new Uint8Array(0), {
          contentType: inline ?? "application/octet-stream",
          headers
        })
      }
      return HttpServerResponse.stream(
        Stream.fromAsyncIterable(handle.createReadStream({ autoClose: true }) as AsyncIterable<Uint8Array>, (e) => e),
        {
          contentType: inline ?? "application/octet-stream",
          headers: { ...headers, "content-length": String(size) }
        }
      )
    })

    /** Your own folder to share (§1.4): never the top, never one shared with you. */
    const ownFolder = (path: string) =>
      Effect.gen(function* () {
        const placed = yield* place(path)
        if (placed.share) return yield* Effect.fail(new Answer(400, "Only its owner can share this folder."))
        if (placed.segments.length === 0)
          return yield* Effect.fail(new Answer(400, "Share a folder inside your files."))
        const info = yield* Effect.tryPromise(() => statPath(placed.root, placed.segments))
        if (!info) return yield* Effect.fail(new Answer(404, "Not found. It may have been moved or deleted."))
        if (!info.isDirectory()) return yield* Effect.fail(new Answer(400, "Only a folder can be shared."))
        return { ...placed, inode: info.ino, device: info.dev, birthMs: birthOf(info) }
      })

    const toFolderShare = (
      share: { id: string; handle: string; displayName: string; mode: "view" | "edit" },
      status: FolderShare["status"]
    ) =>
      ({
        id: share.id,
        handle: share.handle,
        displayName: share.displayName,
        mode: share.mode,
        status
      }) satisfies FolderShare

    /** The folder's shares and invitations, as its owner's Share dialog lists them. */
    const shares = Effect.gen(function* () {
      const query = yield* queryOf
      const placed = yield* ownFolder(query.get("path") ?? "")
      const { checked, invitations } = yield* ownShares(placed.userId)
      return HttpServerResponse.jsonUnsafe(
        [
          ...checked
            .filter(({ share }) => share.path === placed.full)
            .map(({ share, available }) => toFolderShare(share, available ? "active" : "unavailable")),
          ...invitations
            .filter((invitation) => invitation.path === placed.full)
            .map((invitation) => toFolderShare(invitation, "invited"))
        ],
        { headers: { "cache-control": "no-store" } }
      )
    })

    /** Invitations each account sent lately (§1.4), for the rate limit. */
    const invitesSent = new Map<string, Array<number>>()
    const mayInvite = (userId: string) => {
      const now = Date.now()
      const recent = (invitesSent.get(userId) ?? []).filter((at) => at > now - INVITE_WINDOW_MS)
      if (recent.length >= INVITES_PER_WINDOW) {
        invitesSent.set(userId, recent)
        return false
      }
      recent.push(now)
      invitesSent.set(userId, recent)
      return true
    }

    /**
     * Offers the folder to the account of that name (§1.4). The answer is the same whether or not
     * there is one: an invitation listed under the name as typed, which reaches only an account
     * that has that name now. One that already accepted gets the new mode instead.
     */
    const share = Effect.gen(function* () {
      const body = yield* jsonBody(ShareRequest)
      const placed = yield* ownFolder(body.path)
      const handle = body.handle.trim()
      const user = yield* CurrentUser
      if (handle === "") return refuse(400, "Type the name of the account to share it with.")
      if (handle === user.handle) return refuse(400, "That's your own account.")
      if (!mayInvite(placed.userId)) return refuse(429, "That's a lot of sharing at once. Try again in a few minutes.")
      const made = yield* writer.InviteToFolder({
        userId: placed.userId as never,
        path: placed.full,
        inode: placed.inode,
        device: placed.device,
        birthMs: placed.birthMs,
        handle,
        mode: body.mode
      })
      if ("share" in made) {
        changed(made.share.granteeUserId, [`${FILES_TOP}/${SHARED_FOLDER}`])
        // Made view-only: their commands writing there stop now.
        if (made.share.mode === "view") yield* recheckCommands([made.share.granteeUserId])
        return HttpServerResponse.jsonUnsafe(toFolderShare(made.share, "active"))
      }
      if (made.invitation.granteeUserId !== null)
        changed(made.invitation.granteeUserId, [FILES_TOP, `${FILES_TOP}/${SHARED_FOLDER}`])
      return HttpServerResponse.jsonUnsafe(toFolderShare(made.invitation, "invited"))
    })

    /** The owner shares an unavailable share's path again: the folder there now (§1.4). */
    const shareAgain = Effect.gen(function* () {
      const body = yield* jsonBody(UnshareBody)
      const user = yield* CurrentUser
      const mine = (yield* reader.SharedByMe({ userId: user.id })).find((candidate) => candidate.id === body.shareId)
      if (!mine) return refuse(404, "That folder isn't shared any more.")
      const placed = yield* ownFolder(mine.path)
      const again = yield* writer
        .RebindFolderShare({
          userId: user.id,
          shareId: mine.id,
          inode: placed.inode,
          device: placed.device,
          birthMs: placed.birthMs
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.fail(new Answer(404, "That folder isn't shared any more."))))
      changed(again.granteeUserId, [`${FILES_TOP}/${SHARED_FOLDER}`])
      changed(user.id, [FILES_TOP, placed.full])
      return HttpServerResponse.jsonUnsafe(toFolderShare(again, "active"))
    })

    const unshare = Effect.gen(function* () {
      const body = yield* jsonBody(UnshareBody)
      const user = yield* CurrentUser
      const mine = yield* reader.SharedByMe({ userId: user.id })
      const gone = mine.find((candidate) => candidate.id === body.shareId)
      const offered = (yield* reader.ShareInvitationsSent({ userId: user.id })).find(
        (candidate) => candidate.id === body.shareId
      )
      yield* writer
        .StopSharingFolder({ userId: user.id, shareId: body.shareId })
        .pipe(Effect.catchTag("NotFound", () => Effect.fail(new Answer(404, "That folder isn't shared any more."))))
      if (gone) {
        changed(gone.granteeUserId, [`${FILES_TOP}/${SHARED_FOLDER}`])
        // Their commands using it stop now, not at the next sweep (files4afix).
        yield* recheckCommands([gone.granteeUserId])
      }
      if (offered?.granteeUserId) changed(offered.granteeUserId, [FILES_TOP, `${FILES_TOP}/${SHARED_FOLDER}`])
      return HttpServerResponse.jsonUnsafe({})
    })

    /** The invited account accepts or declines (§1.4): accepted, the folder appears under Shared. */
    const answerInvitation = Effect.gen(function* () {
      const body = yield* jsonBody(AnswerInvitationRequest)
      const user = yield* CurrentUser
      const accepted = yield* writer
        .AnswerShareInvitation({ userId: user.id, invitationId: body.invitationId, accept: body.accept })
        .pipe(Effect.catchTag("NotFound", () => Effect.fail(new Answer(404, "That invitation was taken back."))))
      changed(user.id, [FILES_TOP, `${FILES_TOP}/${SHARED_FOLDER}`])
      if (accepted) changed(accepted.ownerUserId, [accepted.path.slice(0, accepted.path.lastIndexOf("/")) || FILES_TOP])
      return HttpServerResponse.jsonUnsafe({})
    })

    /** A file's versions (§1.3), newest first; in a shared folder, the owner's record of it. */
    const versions = Effect.gen(function* () {
      const query = yield* queryOf
      const placed = yield* place(query.get("path") ?? "", "read")
      if (placed.segments.length === 0) return refuse(400, "Name a file.")
      // Through a share (§1.4): only a file there now, and only what was kept since the share
      // started; its path's history from before isn't the other account's to see.
      if (placed.share) {
        const info = yield* Effect.promise(() => statPath(placed.root, placed.segments).catch(() => null))
        if (!info?.isFile()) return refuse(404, "Not found. It may have been moved or deleted.")
      }
      const rows = yield* reader.ListFileVersions({
        userId: placed.userId as never,
        path: placed.ownerFull,
        limit: VERSIONS_LISTED,
        ...(placed.share ? { since: placed.share.createdAt } : {})
      })
      const user = yield* CurrentUser
      // The account that acted is named when it wasn't you.
      const listed: Array<FileVersionEntry> = rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        origin: row.origin,
        byteSize: row.byteSize,
        restorable: row.hasContent,
        actor: row.actor && row.actor.handle !== user.handle ? row.actor : null
      }))
      return HttpServerResponse.jsonUnsafe(listed, { headers: { "cache-control": "no-store" } })
    })

    /**
     * A version's content back at its path (§1.3). What was there is kept as a version first
     * (origin `restore`), so restoring that one undoes it.
     */
    const restoreVersion = Effect.gen(function* () {
      const body = yield* jsonBody(RestoreVersionBody)
      const placed = yield* place(body.path)
      const { userId, root, segments } = placed
      if (segments.length === 0) return refuse(400, "Name a file.")
      const version = yield* reader
        .FileVersion({ userId: userId as never, id: body.versionId })
        .pipe(Effect.catchTag("NotFound", () => Effect.fail(new Answer(404, "That version is gone."))))
      if (version.path !== placed.ownerFull) return refuse(404, "That version is of another file.")
      // Through a share, as the list: a file there now, and a version kept since the share started.
      if (placed.share && version.createdAt < placed.share.createdAt) return refuse(404, "That version is gone.")
      if (!version.mediaPath || !isMediaPath(version.mediaPath))
        return refuse(410, "That version's content isn't kept.")
      const bytes = yield* Effect.tryPromise(() => readFile(join(config.dataDir, version.mediaPath!)))
      // One change at a time to a path: what was there is kept as it was when written over.
      const kept = yield* withPathLock(
        root,
        segments,
        Effect.gen(function* () {
          yield* stillPlaced(placed)
          const current = yield* Effect.tryPromise(() => statPath(root, segments))
          if (current && !current.isFile())
            return yield* Effect.fail(new Answer(409, `“${segments.at(-1)}” isn't a file here now.`))
          if (placed.share && !current)
            return yield* Effect.fail(new Answer(404, "Not found. It may have been moved or deleted."))
          const replaced = current && current.nlink === 1 ? current.size : 0
          yield* quota
            .check(userId, Math.max(0, bytes.byteLength - replaced), "restore this version")
            .pipe(Effect.mapError((error) => new Answer(507, error.message)))
          const kept = yield* keptVersion(userId, root, segments, placed.ownerFull, "restore", placed.actorId)
          const token = quota.freed(userId, replaced)
          yield* Effect.tryPromise(() => writeRegularFile(root, segments, bytes, { createFolders: true })).pipe(
            Effect.tapError(() => Effect.sync(() => quota.unfreed(userId, token)))
          )
          quota.wrote(userId, bytes.byteLength + kept.bytes)
          return kept
        })
      )
      changedAt(placed)
      return HttpServerResponse.jsonUnsafe({ path: placed.full, keptVersionId: kept.id } satisfies RestoredVersion)
    })

    const restore = Effect.gen(function* () {
      const body = yield* jsonBody(RestoreBody)
      const { userId } = yield* place(FILES_TOP)
      const { path } = yield* bin.restore(userId, body.binItemId)
      changed(userId, [path])
      return HttpServerResponse.jsonUnsafe({ path })
    })

    return Layer.mergeAll(
      HttpRouter.add("GET", FILES_ROUTES.list, authenticated(list)),
      HttpRouter.add("GET", FILES_ROUTES.raw, authenticated(raw)),
      HttpRouter.add("GET", FILES_ROUTES.text, authenticated(text)),
      HttpRouter.add("GET", FILES_ROUTES.zip, authenticated(zip)),
      HttpRouter.add("POST", FILES_ROUTES.upload, authenticated(upload)),
      HttpRouter.add("POST", FILES_ROUTES.folder, authenticated(folder)),
      HttpRouter.add("POST", FILES_ROUTES.move, authenticated(move)),
      HttpRouter.add("POST", FILES_ROUTES.delete, authenticated(remove)),
      HttpRouter.add("POST", FILES_ROUTES.restore, authenticated(restore)),
      HttpRouter.add("POST", FILES_ROUTES.attach, authenticated(attach)),
      HttpRouter.add("GET", FILES_ROUTES.attachment, authenticated(attachment)),
      HttpRouter.add("GET", FILES_ROUTES.shares, authenticated(shares)),
      HttpRouter.add("POST", FILES_ROUTES.share, authenticated(share)),
      HttpRouter.add("POST", FILES_ROUTES.unshare, authenticated(unshare)),
      HttpRouter.add("POST", FILES_ROUTES.shareAgain, authenticated(shareAgain)),
      HttpRouter.add("POST", FILES_ROUTES.answerInvitation, authenticated(answerInvitation)),
      HttpRouter.add("GET", FILES_ROUTES.versions, authenticated(versions)),
      HttpRouter.add("POST", FILES_ROUTES.restoreVersion, authenticated(restoreVersion))
    )
  })
)
