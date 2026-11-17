// The file manager's HTTP routes (spec/FILES-AND-ENVIRONMENT.md §1.1, §8.1; the contract is
// `@rp/shared/files.ts` FILES_ROUTES): list a folder, upload (streamed, to a temporary name, then
// renamed), serve a file's bytes (Range requests, never as the app's own content), make a folder,
// rename or move, and delete. Every access goes through the account's own tree and the no-follow
// walk (safePath.ts), never through a path as given: links and special files are listed and
// never opened. Main-thread async file I/O; SQLite only through the writer (file versions).
import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, rm, unlink, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { CurrentUser } from "@rp/shared/api.ts"
import { formatByteSize } from "@rp/shared/byteSize.ts"
import {
  FILES_ROUTES,
  FILES_TOP,
  isWithin,
  keepBothName,
  nameProblem,
  UploadConflict,
  type FolderListing,
  type UploadOutcome
} from "@rp/shared/files.ts"
import { NodeHttpServerRequest } from "@effect/platform-node"
import { ByteSize, Cause, Effect, Layer, Option, Schema, Stream } from "effect"
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Accounts } from "../auth/Accounts.ts"
import { AppConfig } from "../config.ts"
import { Writer } from "../db/Database.ts"
import { MediaHolds } from "../importer/MediaHolds.ts"
import { storeMedia } from "../importer/mediaFiles.ts"
import { accountEnv, prepareAccount, resolveFilesPath } from "./environment.ts"
import { FilePathRefused, listFolder, openFolder, readRegularFile, statPath } from "./safePath.ts"

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = constants

/** The largest file an upload takes (§1.1: 4 GiB, an instance setting later). */
const MAX_FILE_UPLOAD_BYTES = 4 * 1024 ** 3
/** The longest pause in an upload's body before it's dropped. */
const UPLOAD_IDLE_MS = 30_000
/** Entries a listing returns at most. */
const LIST_LIMIT = 5_000
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

const extension = (name: string) => {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

const at = (dir: FileHandle, name: string) => `/proc/self/fd/${dir.fd}/${name}`

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
const MoveBody = Schema.Struct({
  from: Schema.String.check(Schema.isMaxLength(4096)),
  to: Schema.String.check(Schema.isMaxLength(4096))
})

export const filesRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const config = yield* AppConfig
    const writer = yield* Writer
    const holds = yield* MediaHolds
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

    /** The account's tree, made on first use, and a path in it as the walk's components. */
    const place = (path: string) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const env = accountEnv(dirs, user.id)
        yield* Effect.tryPromise(() => prepareAccount(env))
        const resolved = yield* Effect.try(() => resolveFilesPath(path, FILES_TOP))
        return { userId: user.id, root: env.filesRoot, full: resolved.full, segments: resolved.segments }
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
    const keepVersion = (userId: string, root: string, segments: ReadonlyArray<string>, path: string, origin: string) =>
      Effect.gen(function* () {
        const info = yield* Effect.tryPromise(() => statPath(root, segments))
        if (!info?.isFile() || info.size > VERSION_MAX_BYTES) return
        const { bytes } = yield* Effect.tryPromise(() => readRegularFile(root, segments, VERSION_MAX_BYTES))
        const sha256 = createHash("sha256").update(bytes).digest("hex")
        yield* holds.holding(
          [sha256],
          Effect.andThen(
            storeMedia(config.dataDir, sha256, bytes),
            writer.RecordFileVersions({
              userId: userId as never,
              versions: [
                { path, inode: info.ino, sha256, mime: "application/octet-stream", byteSize: bytes.byteLength, origin }
              ]
            })
          )
        )
      })

    const list = Effect.gen(function* () {
      const query = yield* queryOf
      const { root, full, segments } = yield* place(query.get("path") ?? FILES_TOP)
      const listed = yield* Effect.tryPromise(() => listFolder(root, segments, LIST_LIMIT))
      const listing: FolderListing = {
        path: full,
        entries: listed.entries
          .filter((entry) => !entry.name.endsWith(".rp-tmp"))
          .map((entry) => ({
            name: entry.name,
            kind: entry.kind,
            size: entry.kind === "file" ? entry.size : 0,
            mtimeMs: Math.round(entry.mtimeMs)
          })),
        more: listed.more,
        readOnly: false,
        // The bin doesn't hold files yet (§1.3, bin kind `file`): deleting here asks first.
        bin: false
      }
      return HttpServerResponse.jsonUnsafe(listing, { headers: { "cache-control": "no-store" } })
    })

    const raw = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const query = yield* queryOf
      const { root, segments } = yield* place(query.get("path") ?? "")
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

    const upload = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.headers["content-type"] !== "application/octet-stream")
        return refuse(415, "Expected application/octet-stream.")
      const query = yield* queryOf
      const conflict = Schema.decodeUnknownOption(UploadConflict)(query.get("conflict") ?? "ask")
      if (Option.isNone(conflict)) return refuse(400, "conflict must be ask, keep, replace or skip.")
      const declared = Number(request.headers["content-length"] ?? "0")
      if (declared > MAX_FILE_UPLOAD_BYTES)
        return refuse(413, `A file can be at most ${formatByteSize(MAX_FILE_UPLOAD_BYTES)}.`)
      const { userId, root, segments } = yield* place(query.get("path") ?? "")
      if (segments.length === 0) return refuse(400, "Name the file.")
      const problem = nameProblem(segments.at(-1)!)
      if (problem) return refuse(400, problem)
      const parent = segments.slice(0, -1)
      const parentPath = `${FILES_TOP}/${parent.join("/")}`.replace(/\/$/, "")
      const message = NodeHttpServerRequest.toIncomingMessage(request)
      const dir = yield* Effect.tryPromise(() => openFolder(root, parent, { create: true }))
      return yield* Effect.gen(function* () {
        let name = segments.at(-1)!
        const existing = yield* Effect.tryPromise(() => lstat(at(dir, name)).catch(() => null))
        let outcome: UploadOutcome["outcome"] = "written"
        if (existing) {
          if (conflict.value === "ask") return HttpServerResponse.jsonUnsafe({ taken: true }, { status: 409 })
          if (conflict.value === "skip")
            return HttpServerResponse.jsonUnsafe({ path: `${parentPath}/${name}`, outcome: "skipped" })
          if (conflict.value === "replace") {
            if (existing.isDirectory()) return refuse(409, `“${name}” is a folder here. Choose Keep both or Skip.`)
            outcome = "replaced"
            yield* keepVersion(userId, root, segments, `${parentPath}/${name}`, "upload")
          } else {
            const taken = new Set(
              (yield* Effect.tryPromise(() => listFolder(root, parent, LIST_LIMIT))).entries.map((e) => e.name)
            )
            name = keepBothName(name, taken)
          }
        }
        const temporary = `.${name.slice(0, 200)}.${randomBytes(6).toString("hex")}.rp-tmp`
        yield* Effect.tryPromise(async () => {
          const handle = await open(at(dir, temporary), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)
          let received = 0
          let idle: NodeJS.Timeout | undefined
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              received += chunk.length
              clearTimeout(idle)
              idle = setTimeout(() => counter.destroy(new Answer(408, "The file stopped arriving.")), UPLOAD_IDLE_MS)
              if (received > MAX_FILE_UPLOAD_BYTES)
                done(new Answer(413, `A file can be at most ${formatByteSize(MAX_FILE_UPLOAD_BYTES)}.`))
              else done(null, chunk)
            }
          })
          idle = setTimeout(() => counter.destroy(new Answer(408, "The file stopped arriving.")), UPLOAD_IDLE_MS)
          try {
            // The write stream owns the handle: it syncs (`flush`) and closes it when done. With
            // `autoClose: false` the pipeline would wait for a close that never comes.
            await pipeline(message, counter, handle.createWriteStream({ flush: true }))
          } catch (error) {
            await handle.close().catch(() => undefined)
            await unlink(at(dir, temporary)).catch(() => undefined)
            throw error
          } finally {
            clearTimeout(idle)
          }
          try {
            await rename(at(dir, temporary), at(dir, name))
          } catch (error) {
            await unlink(at(dir, temporary)).catch(() => undefined)
            throw error
          }
        })
        return HttpServerResponse.jsonUnsafe({ path: `${parentPath}/${name}`, outcome } satisfies UploadOutcome)
      }).pipe(Effect.ensuring(Effect.promise(() => dir.close())))
    })

    const folder = Effect.gen(function* () {
      const body = yield* jsonBody(PathBody)
      const { root, full, segments } = yield* place(body.path)
      if (segments.length === 0) return refuse(400, "Name the folder.")
      const problem = nameProblem(segments.at(-1)!)
      if (problem) return refuse(400, problem)
      const dir = yield* Effect.tryPromise(() => openFolder(root, segments.slice(0, -1)))
      yield* Effect.tryPromise(() => mkdir(at(dir, segments.at(-1)!), { mode: 0o755 })).pipe(
        Effect.ensuring(Effect.promise(() => dir.close()))
      )
      return HttpServerResponse.jsonUnsafe({ path: full })
    })

    const move = Effect.gen(function* () {
      const body = yield* jsonBody(MoveBody)
      const from = yield* place(body.from)
      const to = yield* place(body.to)
      if (from.segments.length === 0 || to.segments.length === 0) return refuse(400, "The top folder can't be moved.")
      const problem = nameProblem(to.segments.at(-1)!)
      if (problem) return refuse(400, problem)
      if (to.full !== from.full && isWithin(to.full, from.full)) return refuse(400, "A folder can't go inside itself.")
      const source = yield* Effect.tryPromise(() => openFolder(from.root, from.segments.slice(0, -1)))
      return yield* Effect.gen(function* () {
        const target = yield* Effect.tryPromise(() => openFolder(to.root, to.segments.slice(0, -1)))
        return yield* Effect.gen(function* () {
          const fromName = at(source, from.segments.at(-1)!)
          const toName = at(target, to.segments.at(-1)!)
          yield* Effect.tryPromise(() => lstat(fromName))
          const taken = yield* Effect.tryPromise(() => lstat(toName).catch(() => null))
          if (taken) return refuse(409, "That name is taken.")
          yield* Effect.tryPromise(() => rename(fromName, toName))
          return HttpServerResponse.jsonUnsafe({ path: to.full })
        }).pipe(Effect.ensuring(Effect.promise(() => target.close())))
      }).pipe(Effect.ensuring(Effect.promise(() => source.close())))
    })

    const remove = Effect.gen(function* () {
      const body = yield* jsonBody(PathBody)
      const { userId, root, full, segments } = yield* place(body.path)
      if (segments.length === 0) return refuse(400, "The top folder can't be deleted.")
      const info = yield* Effect.tryPromise(() => statPath(root, segments))
      if (!info) return refuse(404, "Not found. It may have been moved or deleted.")
      if (info.isFile()) yield* keepVersion(userId, root, segments, full, "delete")
      const dir = yield* Effect.tryPromise(() => openFolder(root, segments.slice(0, -1)))
      // A link or special file is removed itself, never what it points at; `rm` doesn't follow links.
      yield* Effect.tryPromise(() =>
        info.isDirectory() ? rm(at(dir, segments.at(-1)!), { recursive: true }) : unlink(at(dir, segments.at(-1)!))
      ).pipe(Effect.ensuring(Effect.promise(() => dir.close())))
      return HttpServerResponse.jsonUnsafe({ binItemId: null })
    })

    return Layer.mergeAll(
      HttpRouter.add("GET", FILES_ROUTES.list, authenticated(list)),
      HttpRouter.add("GET", FILES_ROUTES.raw, authenticated(raw)),
      HttpRouter.add("POST", FILES_ROUTES.upload, authenticated(upload)),
      HttpRouter.add("POST", FILES_ROUTES.folder, authenticated(folder)),
      HttpRouter.add("POST", FILES_ROUTES.move, authenticated(move)),
      HttpRouter.add("POST", FILES_ROUTES.delete, authenticated(remove))
    )
  })
)
