// Files into and out of the library over plain HTTP (ARCHITECTURE.md §11.4). RPC messages
// are JSON, so a file would cross as base64: a third larger, and decoded whole on the main
// thread. Both routes act as the user the session names, behind the same cross-site guard
// as every request (server.ts), and refuse content types a cross-site form can send.
import { formatByteSize } from "@dreamspan/shared/byteSize.ts"
import { createHash, randomUUID } from "node:crypto"
import { CurrentUser } from "@dreamspan/shared/api.ts"
import { SavedRef } from "@dreamspan/shared/editorApi.ts"
import { ImportIssue, ImportReport } from "@dreamspan/shared/importReport.ts"
import { ExportFormat as ExportFormatSchema, ImportResult } from "@dreamspan/shared/libraryImport.ts"
import { CardReplacePreview } from "@dreamspan/shared/cardReplace.ts"
import { RefId } from "@dreamspan/shared/library.ts"
import { DraftKey, entityDraftTarget, fileDraftKey } from "@dreamspan/shared/drafts.ts"
import { FILES_TOP } from "@dreamspan/shared/files.ts"
import { FileDraftSave } from "@dreamspan/shared/filesApi.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import { resolveFilesPath } from "../files/environment.ts"
import { remoteOf } from "@dreamspan/shared/cardSources.ts"
import { EditorDraftSave } from "@dreamspan/shared/editorApi.ts"
import { ComposerBeacon } from "@dreamspan/shared/composerApi.ts"
import { Notices } from "../chat/Notices.ts"
import { UserDraftSave } from "@dreamspan/shared/editorApi.ts"
import { SummaryDraftSave } from "@dreamspan/shared/lcm.ts"
import { MessageDraftSave, messageDraftKey } from "@dreamspan/shared/chatApi.ts"
import { parseField } from "@dreamspan/shared/editing.ts"
import { ByteSize, Effect, Exit, Layer, Option, Schedule, Schema, Semaphore, Stream } from "effect"
import { ChatId, ForkId } from "@dreamspan/shared/chatPosition.ts"
import { chatExport } from "./chatExport.ts"
import { libraryArchive, type RenderRef } from "./libraryArchive.ts"
import { zipStream } from "../formats/zipStream.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { NodeHttpServerRequest } from "@effect/platform-node"
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Accounts } from "../auth/Accounts.ts"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { CardSources } from "../sources/CardSources.ts"
import { type CacheKey, draftBaseKey } from "../sources/cache.ts"
import { defaultLimits } from "../formats/safety.ts"
import { BodyRefused, firstBytes, readBody } from "./body.ts"
import { Formats } from "./Formats.ts"
import { MediaHolds } from "./MediaHolds.ts"
import { StImportJobs } from "./StImportJobs.ts"
import { StImports } from "./StImports.ts"
import { StImportPlans } from "./StImportPlans.ts"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { classifyStPath, ST_CHAT_PART_BYTES } from "@dreamspan/shared/stFolder.ts"
import { StFileResult } from "@dreamspan/shared/stImportApi.ts"
import { describeImage } from "./images.ts"
import { readMedia, storeMedia, sweepMedia } from "./mediaFiles.ts"
import { prepareAvatarThumbnails } from "./prepareThumbnails.ts"
import { withSourceLink } from "./sourceLink.ts"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { type AvatarCrop, cropKey, mediaWidth, parseCropKey } from "@dreamspan/shared/media.ts"

/** The largest upload: the parsers' own cap on any file (ARCHITECTURE.md §8). */
const MAX_UPLOAD_BYTES = defaultLimits.maxFileBytes

/**
 * How fast an upload must arrive (ARCHITECTURE.md §11.4). A slow phone uplink of 1 Mbit/s,
 * about 120 KiB/s, sends a 30 MB card in about four minutes. The deadline gives a full
 * 64 MiB file 15 minutes, about 73 KiB/s, and the minimum rate, 32 KiB/s averaged over each
 * 10 s, leaves such a link a margin of almost four times; a 0.5 Mbit/s one still passes. A
 * trickle that keeps under the pause limit is dropped after its first 10 s window.
 */
const BODY_DEADLINE_MS = 15 * 60_000
const BODY_MIN_BYTES_PER_SECOND = 32 * 1024
const BODY_RATE_WINDOW_MS = 10_000
/** The longest pause in an upload's body, or before its first bytes, before it's dropped. */
const BODY_IDLE_MS = 10_000

/** The most a card's files may add up to in an export: the CHARX reader's own total (§8). */
const MAX_EXPORT_FILE_BYTES = defaultLimits.maxZipTotalBytes

/** How old a media file no row names must be before the sweep deletes it: older than any import. */
const MEDIA_GRACE_MS = 60 * 60 * 1000

const BODY_REFUSALS: Record<BodyRefused["reason"], readonly [status: number, message: string]> = {
  too_large: [413, `files can be at most ${formatByteSize(MAX_UPLOAD_BYTES)}`],
  stalled: [408, "the file stopped arriving"],
  trickling: [408, "the file arrived too slowly"],
  too_slow: [408, "the file took too long to arrive"],
  aborted: [400, "the file didn't arrive whole"]
}

/** A file name as given, without folders or control characters, bounded. */
const fileNameFrom = (raw: string | null) =>
  (raw ?? "")
    .replace(/\p{Cc}+/gu, "")
    .split(/[/\\]/)
    .pop()!
    .slice(0, 255)

/** The largest avatar: far more than a portrait needs, a quarter of the import cap. */
const MAX_AVATAR_BYTES = 16 * 1024 * 1024

/** Images served back to the browser, and the only types an avatar upload takes. */
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const WidthQuery = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))

const jsonError = (status: number, message: string) => HttpServerResponse.jsonUnsafe({ error: message }, { status })

/**
 * Runs `effect` holding one of `semaphore`'s permits, waiting at most `waitMs` for it.
 * None when the wait ran out.
 */
const withPermitWithin = <A, E, R>(semaphore: Semaphore.Semaphore, waitMs: number, effect: Effect.Effect<A, E, R>) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(restore(Effect.timeoutOption(semaphore.take(1), Math.max(0, waitMs))), (taken) =>
      Option.isNone(taken)
        ? Effect.succeed(Option.none<A>())
        : restore(effect).pipe(Effect.map(Option.some), Effect.ensuring(semaphore.release(1)))
    )
  )

/** The user the request's session names, as for an RPC (auth/Accounts.ts). */
const authenticated = <A, E, R>(accounts: Accounts["Service"], handle: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const session = yield* Effect.option(accounts.resolve(request.headers))
    if (Option.isNone(session)) return jsonError(401, "login required")
    return yield* Effect.provideService(handle, CurrentUser, session.value.user)
  })

const ExportRequest = Schema.Struct({ refId: RefId, format: ExportFormatSchema })

const ChatExportRequest = Schema.Struct({
  chatId: ChatId,
  /** The branch to export; null: the one the chat opens on. */
  forkId: Schema.NullOr(ForkId),
  scope: Schema.Literals(["branch", "all"]),
  format: Schema.Literals(["jsonl", "txt"])
})

const LeavingDrafts = Schema.Struct({
  drafts: Schema.Array(EditorDraftSave).check(Schema.isMaxLength(500)),
  /** Chats' composers (DESIGN §6.2): one per open chat at most, in practice. */
  composers: Schema.optionalKey(Schema.Array(ComposerBeacon).check(Schema.isMaxLength(50))),
  /** Summaries' edits, from this browser's copies (`summaryDraft.ts`). */
  userDrafts: Schema.optionalKey(Schema.Array(UserDraftSave).check(Schema.isMaxLength(50))),
  summaries: Schema.optionalKey(Schema.Array(SummaryDraftSave).check(Schema.isMaxLength(50))),
  /** Message editors' text, from this browser's copies (`messageDraft.ts`). */
  messages: Schema.optionalKey(Schema.Array(MessageDraftSave).check(Schema.isMaxLength(50))),
  /** Edits of files of the user's Files, from this browser's copies (`files/fileDraft.ts`). */
  files: Schema.optionalKey(Schema.Array(FileDraftSave).check(Schema.isMaxLength(20)))
})

/** `attachment` with an ASCII fallback name and the real one percent-encoded (RFC 6266). */
const disposition = (label: string, extension: string) => {
  const name = `${label}.${extension}`
  const ascii = name.replace(/[^\w .-]/g, "_")
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const accounts = yield* Accounts
    const formats = yield* Formats
    // Only pending jobs live in memory; completed bytes live on disk. An abandoned HTTP
    // request doesn't cancel a native job and let its replacement generate it twice.
    const thumbnails = new Map<string, ReturnType<typeof formats.thumbnail>>()
    const thumbnail = Effect.fnUntraced(function* (
      path: string,
      width: 0 | ReturnType<typeof mediaWidth>,
      // undefined: the whole image; null: the default cutout; else the chosen one.
      crop: AvatarCrop | null | undefined
    ) {
      const key = `${path}:${width}:${crop === undefined ? "" : cropKey(crop)}`
      let job = thumbnails.get(key)
      if (!job) {
        job = yield* Effect.cached(
          formats
            .thumbnail({ dataDir: config.dataDir, path, width, ...(crop === undefined ? {} : { crop }) })
            .pipe(Effect.ensuring(Effect.sync(() => thumbnails.delete(key))), Effect.uninterruptible)
        )
        thumbnails.set(key, job)
      }
      return yield* job
    })
    const reader = yield* Reader
    const writer = yield* Writer
    const sources = yield* CardSources
    const notices = yield* Notices
    // Media an import has written and not yet recorded, which the sweep leaves alone.
    const { pending, holding } = yield* MediaHolds
    // Files held in memory at once. An upload takes a permit once its first bytes arrive, so
    // one that sends nothing holds none; the rest wait in their sockets, where TCP holds the
    // sender back. Exports have permits of their own, so stalled uploads can't hold them up.
    const uploads = Semaphore.makeUnsafe(config.formatWorkers * 2)
    const exports = Semaphore.makeUnsafe(config.formatWorkers * 2)
    // One transfer per user at a time: another waits its turn, for as long as an upload may
    // take, so no user holds more than one permit.
    const users = new Map<string, { readonly semaphore: Semaphore.Semaphore; waiting: number }>()
    const oneAtATime = <E, R>(
      userId: string,
      transfer: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
    ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const slot = users.get(userId) ?? { semaphore: Semaphore.makeUnsafe(1), waiting: 0 }
          slot.waiting++
          users.set(userId, slot)
          return slot
        }),
        (slot) =>
          Effect.map(withPermitWithin(slot.semaphore, BODY_DEADLINE_MS, transfer), (response) =>
            Option.getOrElse(response, () =>
              jsonError(503, "another of your files is still being transferred; try again once it's done")
            )
          ),
        (slot) =>
          Effect.sync(() => {
            if (--slot.waiting === 0) users.delete(userId)
          })
      )

    const importFile = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      if (request.headers["content-type"] !== "application/octet-stream") {
        return jsonError(415, "expected application/octet-stream")
      }
      if (Number(request.headers["content-length"]) > MAX_UPLOAD_BYTES) {
        return jsonError(413, BODY_REFUSALS.too_large[1])
      }
      const query = new URL(request.url, "http://upload").searchParams
      const fileName = fileNameFrom(query.get("name"))
      const into = query.get("into")
      if (into !== null && !Schema.is(RefId)(into)) return jsonError(400, "into must name a ref")
      // "Import a new version…" of a card (§11.1): `preview` parses the file and stores nothing;
      // `replace` makes the file's content the card's next revision, if its head is still `head`.
      const mode = query.get("mode")
      const head = query.get("head")
      if (mode !== null && mode !== "preview" && mode !== "replace" && mode !== "merge")
        return jsonError(400, "mode must be preview, replace or merge")
      if (mode !== null && into === null) return jsonError(400, "a new version needs the card it's for (into)")
      if (mode === "replace" && (head === null || head.length > 100))
        return jsonError(400, "replace needs the head the preview showed")
      // A new version from the card source the card came from keeps the card's link back to its
      // page there (spec/CARD-SOURCES.md §3.8, §4.5): the file doesn't name it.
      const link = query.get("link")
      if (link !== null && (mode === null || link === "" || link.length > 2048))
        return jsonError(400, "link names the page of a new version of a card, up to 2,048 characters")
      // Before the body is read: a refused import reads, parses and stores nothing.
      const target = into === null ? null : yield* reader.GetLibraryRef({ userId: user.id, refId: into })
      if (target !== null && target.kind !== "card" && target.parentEntityId !== null) {
        return jsonError(409, "a variant takes new versions by merging from its original")
      }
      if (mode !== null && target?.kind !== "card" && !(mode === "merge" && target?.kind === "lorebook"))
        return jsonError(409, "only a card takes a new version in place")

      const message = NodeHttpServerRequest.toIncomingMessage(request)
      const limits = {
        maxBytes: MAX_UPLOAD_BYTES,
        idleMs: BODY_IDLE_MS,
        deadline: Date.now() + BODY_DEADLINE_MS,
        minBytesPerSecond: BODY_MIN_BYTES_PER_SECOND,
        rateWindowMs: BODY_RATE_WINDOW_MS
      }
      return yield* oneAtATime(
        user.id,
        Effect.gen(function* () {
          yield* firstBytes(message, limits)
          const taken = yield* withPermitWithin(
            uploads,
            limits.deadline - Date.now(),
            Effect.gen(function* () {
              // The cap applies as the body arrives: past it, after a pause or past the deadline,
              // reading stops, and the answer closes the connection.
              const body = yield* readBody(message, limits)
              const read = yield* formats.parse(body, fileName)
              const parsed =
                link !== null && read.library?.kind === "card"
                  ? { ...read, library: withSourceLink(read.library, link) }
                  : read
              if (mode === "preview") {
                if (parsed.library === null)
                  return yield* HttpServerResponse.schemaJson(CardReplacePreview)(
                    new CardReplacePreview({
                      report: parsed.report,
                      docJson: null,
                      noteDocJson: null,
                      otherNotes: 0,
                      avatar: null,
                      assets: 0,
                      card: null
                    })
                  )
                if (parsed.library.kind !== "card")
                  return jsonError(409, `This file is a ${parsed.library.kind}, not a card.`)
                // Nothing is stored and no file written: the document goes back as the format
                // worker encoded it, and the picture as a data URL, so the dialog can show it.
                const avatar = parsed.media.find((file) => file.role === "avatar")
                return yield* HttpServerResponse.schemaJson(CardReplacePreview)(
                  new CardReplacePreview({
                    report: parsed.report,
                    docJson: parsed.library.docJson,
                    noteDocJson: parsed.library.noteDocJson,
                    otherNotes: parsed.library.notesDocJson?.length ?? 0,
                    avatar: avatar
                      ? {
                          sha256: avatar.sha256,
                          mime: avatar.mime,
                          base64:
                            INLINE_IMAGES.has(avatar.mime) && avatar.bytes.byteLength <= MAX_AVATAR_BYTES
                              ? Buffer.from(avatar.bytes).toString("base64")
                              : null
                        }
                      : null,
                    assets: parsed.media.filter((file) => file.role !== "avatar").length,
                    card: yield* reader.CardReplaceSource({ userId: user.id, refId: into! })
                  })
                )
              }
              if (parsed.library === null) {
                return yield* HttpServerResponse.schemaJson(ImportResult)(
                  new ImportResult({ report: parsed.report, library: null })
                )
              }
              if (target !== null && target.kind !== parsed.library.kind) {
                return jsonError(409, `This file is a ${parsed.library.kind}, not a ${target.kind}.`)
              }
              const library = yield* holding(
                parsed.media.map((file) => file.sha256),
                Effect.gen(function* () {
                  yield* Effect.forEach(parsed.media, (file) => storeMedia(config.dataDir, file.sha256, file.bytes), {
                    discard: true
                  })
                  const { links, ...library } = parsed.library!
                  const recognized = links ? sources.recognize(links) : []
                  return yield* writer.ImportFile({
                    userId: user.id,
                    intoRefId: into,
                    ...library,
                    ...(recognized.length ? { recognized } : {}),
                    sourceName: fileName,
                    sourceHash: parsed.sha256,
                    media: parsed.media.map(({ bytes: _, ...file }) => file),
                    ...(mode === "merge" ? { stageMerge: true } : {}),
                    ...(mode === "replace" ? { replace: { expectedHeadRevisionId: head! } } : {})
                  })
                })
              )
              yield* prepareAvatarThumbnails(formats, config.dataDir, parsed.media)
              const kept = [
                ...(library.keptAvatar
                  ? [
                      new ImportIssue({
                        level: "info",
                        code: "card.avatar_kept",
                        message: "This file has no avatar, so the card keeps the one it had."
                      })
                    ]
                  : []),
                ...(library.keptAssets > 0
                  ? [
                      new ImportIssue({
                        level: "info",
                        code: "card.assets_kept",
                        message: `This file doesn't hold ${library.keptAssets === 1 ? "one of the card's embedded files" : `${library.keptAssets} of the card's embedded files`} that it still names, so the card keeps the ones it had.`
                      })
                    ]
                  : [])
              ]
              const report = new ImportReport({
                format: parsed.report.format,
                issues: [...parsed.report.issues, ...kept]
              })
              return yield* HttpServerResponse.schemaJson(ImportResult)(new ImportResult({ report, library }))
            })
          )
          return Option.getOrElse(taken, () => jsonError(503, "the server is busy with other files; try again"))
        }).pipe(
          Effect.catchTag("BodyRefused", ({ reason }) => {
            const [status, text] = BODY_REFUSALS[reason]
            return Effect.succeed(jsonError(status, text).pipe(HttpServerResponse.setHeader("connection", "close")))
          })
        )
      )
    }).pipe(
      Effect.catchTags({
        NotFound: () => Effect.succeed(jsonError(404, "there's no such ref")),
        RefOperationRefused: (error) => Effect.succeed(jsonError(409, error.reason)),
        FormatWorkerFailed: (error) => Effect.succeed(jsonError(500, error.message))
      }),
      Effect.catch((error) =>
        Effect.logError("an import failed", error).pipe(Effect.as(jsonError(500, "the import failed")))
      )
    )

    const exportFile = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        return jsonError(415, "expected application/json")
      }
      const input = yield* HttpServerRequest.schemaBodyJson(ExportRequest).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)),
        Effect.option
      )
      if (Option.isNone(input)) return jsonError(400, "expected a refId and a format")
      const { refId, format } = input.value
      const source = yield* reader.ExportSource({ userId: user.id, refId })
      const exporter = (yield* formats.listExports).find((entry) => entry.id === format)
      if (!exporter || exporter.kind !== source.kind) {
        return jsonError(400, `a ${source.kind} can't be exported as ${format}`)
      }
      // Only the files the format holds: the avatar for a PNG, every file for a CHARX. A
      // document can name any number of them, the same one many times over, so their total
      // is capped before anything is read, and each is read once.
      const files = exporter.media === "all" ? [source.avatar, ...source.assets] : [source.avatar]
      const wanted = exporter.media !== "none" ? files.filter((file) => file !== null) : []
      const total = wanted.reduce((sum, file) => sum + file.byteSize, 0)
      if (total > MAX_EXPORT_FILE_BYTES) {
        return jsonError(
          422,
          `This card's files add up to ${formatByteSize(total)}, more than an export can hold (${formatByteSize(MAX_EXPORT_FILE_BYTES)}).`
        )
      }
      const cache = new Map<string, Effect.Success<ReturnType<typeof readMedia>>>()
      const read = (file: { path: string; mime: string }) =>
        Effect.gen(function* () {
          if (!cache.has(file.path)) cache.set(file.path, yield* readMedia(config.dataDir, file.path))
          const bytes = cache.get(file.path)
          return bytes && { bytes, mime: file.mime }
        })
      const { mime, extension } = exporter
      return yield* oneAtATime(
        user.id,
        exports.withPermits(1)(
          Effect.gen(function* () {
            const avatar = source.avatar && wanted.length > 0 ? yield* read(source.avatar) : undefined
            const assets =
              exporter.media === "all"
                ? yield* Effect.forEach(source.assets, (asset) =>
                    Effect.map(read(asset), (file) => (file ? [{ ...file, uri: asset.uri }] : []))
                  )
                : []
            const bytes = yield* formats.export({
              format,
              expectedFormat: exporter,
              docJson: source.docJson,
              noteDocJson: source.noteDocJson,
              notesDocJson: source.notesDocJson,
              avatar: avatar ?? null,
              assets: assets.flat()
            })
            return HttpServerResponse.uint8Array(bytes, {
              contentType: mime,
              headers: {
                "content-disposition": disposition(source.label, extension),
                "cache-control": "no-store",
                "x-content-type-options": "nosniff"
              }
            })
          })
        )
      )
    }).pipe(
      Effect.catchTags({
        NotFound: () => Effect.succeed(jsonError(404, "there's no such ref")),
        ExportRefused: (error) => Effect.succeed(jsonError(422, error.message)),
        FormatWorkerFailed: (error) => Effect.succeed(jsonError(500, error.message))
      }),
      Effect.catch((error) =>
        Effect.logError("an export failed", error).pipe(Effect.as(jsonError(500, "the export failed")))
      )
    )

    // "Export this chat" (ARCHITECTURE.md §13b): written as it's read, so it holds no permit
    // of the file routes'; one at a time per user, from its first byte to its last.
    const chatExports = new Set<string>()
    type DownloadFile = { fileName: string; contentType: string; files: number; body: AsyncIterable<Uint8Array> }
    type Download = {
      userId: string
      file: DownloadFile
      bytes: number
      started: boolean
      done: boolean
      cancelled: boolean
      stop: AbortController
      error: string | null
    }
    const downloads = new Map<string, Download>()
    const expire = (key: string) => {
      const timer = setTimeout(() => downloads.delete(key), 60_000)
      timer.unref()
    }
    /** Native browser downloads keep archive bytes out of the page's JavaScript heap. */
    const streamed = (userId: string, file: DownloadFile, ticket?: Download, key?: string) => {
      async function* chunks() {
        for await (const chunk of file.body) {
          if (ticket?.cancelled) throw new Error("export stopped")
          if (ticket) ticket.bytes += chunk.byteLength
          yield chunk
        }
        if (ticket) ticket.done = true
      }
      const body = Stream.fromAsyncIterable(chunks(), (error) => error).pipe(
        Stream.interruptWhen(
          ticket
            ? Effect.callback<void>((resume) => {
                if (ticket.cancelled) {
                  resume(Effect.void)
                  return
                }
                const stop = () => resume(Effect.void)
                ticket.stop.signal.addEventListener("abort", stop, { once: true })
                return Effect.sync(() => ticket.stop.signal.removeEventListener("abort", stop))
              })
            : Effect.never
        ),
        Stream.tapError((error) => {
          if (ticket) ticket.error = "The export stopped before it was done. Try again."
          return ticket?.cancelled ? Effect.void : Effect.logError("an export failed while it was sent", error)
        }),
        Stream.ensuring(
          Effect.sync(() => {
            chatExports.delete(userId)
            if (key) expire(key)
            if (ticket && !ticket.done) {
              ticket.done = true
              ticket.error ??= "The download stopped before it was done. Try again."
            }
          })
        )
      )
      const dot = file.fileName.lastIndexOf(".")
      return HttpServerResponse.stream(body, {
        contentType: file.contentType,
        headers: {
          "content-disposition": disposition(file.fileName.slice(0, dot), file.fileName.slice(dot + 1)),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-export-files": String(file.files)
        }
      })
    }
    const prepareDownload = <E>(userId: string, native: boolean, prepare: Effect.Effect<DownloadFile, E>) =>
      Effect.suspend(() => {
        if (chatExports.has(userId))
          return Effect.succeed(jsonError(503, "another of your exports is still running; try again once it's done"))
        // Reserve before the first reader request: two preparations must not race.
        chatExports.add(userId)
        return Effect.gen(function* () {
          const file = yield* prepare
          if (!native) return streamed(userId, file)
          const key = randomUUID()
          const ticket: Download = {
            userId,
            file,
            bytes: 0,
            started: false,
            done: false,
            cancelled: false,
            stop: new AbortController(),
            error: null
          }
          downloads.set(key, ticket)
          const timer = setTimeout(() => {
            if (!ticket.started && downloads.get(key) === ticket) {
              downloads.delete(key)
              chatExports.delete(userId)
            }
          }, 60_000)
          timer.unref()
          return HttpServerResponse.jsonUnsafe({ key }, { headers: { "cache-control": "no-store" } })
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit)) chatExports.delete(userId)
            })
          )
        )
      })

    const downloadRequest = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      const key = new URL(request.url, "http://download").searchParams.get("key") ?? ""
      const ticket = downloads.get(key)
      return { request, key, ticket: ticket?.userId === user.id ? ticket : undefined }
    })
    const downloadFile = Effect.gen(function* () {
      const { key, ticket } = yield* downloadRequest
      if (!ticket || ticket.started || ticket.cancelled) return jsonError(404, "there's no such download")
      ticket.started = true
      // Retain progress until completion, then briefly for the page's last poll.
      return streamed(ticket.userId, ticket.file, ticket, key)
    })
    const downloadStatus = Effect.gen(function* () {
      const { key, ticket } = yield* downloadRequest
      if (!ticket) return jsonError(404, "there's no such download")
      if (ticket.done) {
        downloads.delete(key)
      }
      return HttpServerResponse.jsonUnsafe(
        { bytes: ticket.bytes, done: ticket.done, error: ticket.error },
        {
          headers: { "cache-control": "no-store" }
        }
      )
    })
    const stopDownload = Effect.gen(function* () {
      const { request, key, ticket } = yield* downloadRequest
      if (!request.headers["content-type"]?.startsWith("application/json"))
        return jsonError(415, "expected application/json")
      if (!ticket) return jsonError(404, "there's no such download")
      ticket.cancelled = true
      ticket.stop.abort()
      if (!ticket.started) {
        downloads.delete(key)
        chatExports.delete(ticket.userId)
      }
      return HttpServerResponse.jsonUnsafe({ stopped: true }, { headers: { "cache-control": "no-store" } })
    })
    const exportChat = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        return jsonError(415, "expected application/json")
      }
      const input = yield* HttpServerRequest.schemaBodyJson(ChatExportRequest).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)),
        Effect.option
      )
      if (Option.isNone(input)) return jsonError(400, "expected a chatId, a forkId, a scope and a format")
      return yield* prepareDownload(
        user.id,
        request.headers["x-export-download"] === "native",
        chatExport(reader, user.id, input.value)
      )
    }).pipe(
      Effect.catchTags({
        NotFound: () => Effect.succeed(jsonError(404, "there's no such chat")),
        ExportNotOffered: () => Effect.succeed(jsonError(400, "this chat can't be exported in that format"))
      }),
      Effect.catch((error) =>
        Effect.logError("a chat export failed", error).pipe(Effect.as(jsonError(500, "the export failed")))
      )
    )

    /**
     * One library entry as an archive's file: a card as a PNG with its avatar (no embedded
     * assets), a lorebook or preset as ST's JSON. Null, logged, when it can't be written.
     */
    const renderRef =
      (userId: UserId): RenderRef =>
      (refId, format, worldNames) =>
        Effect.gen(function* () {
          const source = yield* reader.ExportSource({ userId, refId })
          const exporter = (yield* formats.listExports).find((entry) => entry.id === format)
          if (!exporter || exporter.kind !== source.kind) return null
          const avatar =
            exporter.media !== "none" && source.avatar && source.avatar.byteSize <= MAX_EXPORT_FILE_BYTES
              ? source.avatar
              : null
          const bytes = avatar ? yield* readMedia(config.dataDir, avatar.path) : undefined
          return yield* exports.withPermits(1)(
            formats.export({
              format,
              expectedFormat: exporter,
              docJson: source.docJson,
              ...(worldNames === undefined ? {} : { worldNames }),
              noteDocJson: source.noteDocJson,
              notesDocJson: source.notesDocJson,
              avatar: avatar && bytes ? { bytes, mime: avatar.mime } : null,
              assets: []
            })
          )
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("a library entry was left out of the archive", error).pipe(Effect.as(null))
          )
        )

    // The whole library in ST's folder layout (ARCHITECTURE.md §13b), as the chat export.
    const exportLibrary = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        return jsonError(415, "expected application/json")
      }
      return yield* prepareDownload(
        user.id,
        request.headers["x-export-download"] === "native",
        Effect.gen(function* () {
          const archive = yield* libraryArchive(reader, user.id, renderRef(user.id))
          return {
            fileName: `Library ${new Date().toISOString().slice(0, 10)}.zip`,
            contentType: "application/zip",
            files: archive.counts.cards + archive.counts.personas + archive.counts.lorebooks + archive.counts.presets,
            body: zipStream(archive.entries())
          }
        })
      )
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("a library export failed", error).pipe(Effect.as(jsonError(500, "the export failed")))
      )
    )

    // At startup and every hour: media files no row names, which a failed import can leave.
    const sweep = Effect.gen(function* () {
      // Saved card media no revision names any more goes first, so its files are swept now.
      const pruned = yield* writer
        .PruneSavedMedia()
        .pipe(Effect.catch((error) => Effect.logWarning("pruning saved media failed", error).pipe(Effect.as(0))))
      if (pruned > 0) yield* Effect.logInfo(`removed ${pruned} saved media addresses no library entry names`)
      const recorded = new Set(yield* reader.ListMediaHashes())
      const deleted = yield* sweepMedia(config.dataDir, recorded, {
        graceMs: MEDIA_GRACE_MS,
        pending,
        isRecorded: (sha256) => reader.IsMediaRecorded({ sha256 })
      })
      if (deleted > 0) yield* Effect.logInfo(`deleted ${deleted} media files that no library entry names`)
    }).pipe(Effect.catch((error) => Effect.logWarning("the media sweep failed", error)))

    // --- ST data folder import (ARCHITECTURE.md §13): one file of the folder, or one part
    // of a chat file, through the same limits as a library upload.
    const stImports = yield* StImports
    const stImportJobs = yield* StImportJobs
    const stImportPlans = yield* StImportPlans
    const stImportFile = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      if (request.headers["content-type"] !== "application/octet-stream") {
        return jsonError(415, "expected application/octet-stream")
      }
      const query = new URL(request.url, "http://upload").searchParams
      const importId = query.get("import") ?? ""
      const path = query.get("path") ?? ""
      const file = classifyStPath(path)
      if (file === null || file.kind === "unsupported") return jsonError(400, "that isn't a file the import reads")
      const chat = file.kind === "chat" || file.kind === "group_chat"
      const part = chat ? Number(query.get("part") ?? "0") : 0
      if (!Number.isSafeInteger(part) || part < 0 || part > 100_000)
        return jsonError(400, "part must be a part's number")
      const card = query.get("card")
      if (card !== null && card !== "none" && !/^[0-9a-f-]{36}$/.test(card))
        return jsonError(400, "card must name a card")
      const modified = query.get("modifiedAt")
      const modifiedAt = modified === null || modified.trim() === "" ? undefined : Number(modified)
      const maxBytes = chat ? ST_CHAT_PART_BYTES : MAX_UPLOAD_BYTES
      if (Number(request.headers["content-length"]) > maxBytes)
        return jsonError(413, `at most ${formatByteSize(maxBytes)}`)
      // Before the body is read: another user's import, or none, reads nothing.
      if (!stImports.exists(user, importId)) return jsonError(404, "there's no such import")

      const message = NodeHttpServerRequest.toIncomingMessage(request)
      const limits = {
        maxBytes,
        idleMs: BODY_IDLE_MS,
        deadline: Date.now() + BODY_DEADLINE_MS,
        minBytesPerSecond: BODY_MIN_BYTES_PER_SECOND,
        rateWindowMs: BODY_RATE_WINDOW_MS
      }
      return yield* oneAtATime(
        user.id,
        Effect.gen(function* () {
          yield* firstBytes(message, limits)
          const taken = yield* withPermitWithin(
            uploads,
            limits.deadline - Date.now(),
            Effect.gen(function* () {
              const body = yield* readBody(message, limits)
              const answer = yield* stImports.file(
                user,
                importId,
                path,
                body,
                {
                  part,
                  ...(modifiedAt === undefined ? {} : { modifiedAt }),
                  last: query.get("last") !== "0",
                  card: card as EntityId | "none" | null,
                  orphan: query.get("orphan") === "1"
                },
                (outcome) => stImportJobs.arrived(user, importId, path, body.byteLength, outcome)
              )
              return yield* HttpServerResponse.schemaJson(StFileResult)(answer)
            })
          )
          return Option.getOrElse(taken, () => jsonError(503, "the server is busy with other files; try again"))
        }).pipe(
          Effect.catchTag("BodyRefused", ({ reason }) => {
            const [status, text] = BODY_REFUSALS[reason]
            return Effect.succeed(jsonError(status, text).pipe(HttpServerResponse.setHeader("connection", "close")))
          })
        )
      )
    }).pipe(
      Effect.catchTags({
        NotFound: () => Effect.succeed(jsonError(404, "there's no such import")),
        StImportFailed: (error) => Effect.succeed(jsonError(500, error.message))
      }),
      Effect.catch((error) =>
        Effect.logError("an ST import failed", error).pipe(Effect.as(jsonError(500, "the import failed")))
      )
    )

    // --- The re-import preview's files from a browser (StImportPlans): a chat file part the
    // preview asked for, through the same body reader, limits, permits and one transfer per
    // user as an import's. Nothing is stored.
    const stImportPlanFile = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      if (request.headers["content-type"] !== "application/octet-stream") {
        return jsonError(415, "expected application/octet-stream")
      }
      const query = new URL(request.url, "http://upload").searchParams
      const planId = query.get("plan") ?? ""
      const path = query.get("path") ?? ""
      const file = classifyStPath(path)
      if (file === null || (file.kind !== "chat" && file.kind !== "group_chat"))
        return jsonError(400, "that isn't a chat file the import reads")
      const part = Number(query.get("part") ?? "0")
      if (!Number.isSafeInteger(part) || part < 0 || part > 100_000)
        return jsonError(400, "part must be a part's number")
      if (Number(request.headers["content-length"]) > ST_CHAT_PART_BYTES)
        return jsonError(413, `at most ${formatByteSize(ST_CHAT_PART_BYTES)}`)
      // Before the body is read: another user's preview, or none, reads nothing.
      if (!stImportPlans.exists(user, planId)) return jsonError(404, "there's no such check")
      const message = NodeHttpServerRequest.toIncomingMessage(request)
      const limits = {
        maxBytes: ST_CHAT_PART_BYTES,
        idleMs: BODY_IDLE_MS,
        deadline: Date.now() + BODY_DEADLINE_MS,
        minBytesPerSecond: BODY_MIN_BYTES_PER_SECOND,
        rateWindowMs: BODY_RATE_WINDOW_MS
      }
      return yield* oneAtATime(
        user.id,
        Effect.gen(function* () {
          yield* firstBytes(message, limits)
          const taken = yield* withPermitWithin(
            uploads,
            limits.deadline - Date.now(),
            Effect.gen(function* () {
              const body = yield* readBody(message, limits)
              const outcome = yield* stImportPlans.file(user, planId, path, body, part, query.get("last") !== "0")
              return yield* HttpServerResponse.json({ outcome })
            })
          )
          return Option.getOrElse(taken, () => jsonError(503, "the server is busy with other files; try again"))
        }).pipe(
          Effect.catchTag("BodyRefused", ({ reason }) => {
            const [status, text] = BODY_REFUSALS[reason]
            return Effect.succeed(jsonError(status, text).pipe(HttpServerResponse.setHeader("connection", "close")))
          })
        )
      )
    }).pipe(
      Effect.catchTags({ NotFound: () => Effect.succeed(jsonError(404, "there's no such check")) }),
      Effect.catch((error) =>
        Effect.logError("an ST re-import check failed", error).pipe(Effect.as(jsonError(500, "the check failed")))
      )
    )

    // --- The card editor's avatar, and stored images back out (ARCHITECTURE.md "Editing the
    // library"). An avatar upload is an upload like an import: the same permits and limits.
    const uploadAvatar = (gallery = false) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const user = yield* CurrentUser
        if (request.headers["content-type"] !== "application/octet-stream") {
          return jsonError(415, "expected application/octet-stream")
        }
        if (Number(request.headers["content-length"]) > MAX_AVATAR_BYTES) {
          return jsonError(413, `an image can be at most ${formatByteSize(MAX_AVATAR_BYTES)}`)
        }
        const query = new URL(request.url, "http://upload").searchParams
        const assetName = (query.get("name") ?? "Image").slice(0, 255)
        const refId = query.get("ref")
        const rowVersion = Number(query.get("rowVersion"))
        if (!Schema.is(RefId)(refId) || !Number.isSafeInteger(rowVersion)) {
          return jsonError(400, "expected a ref and its row version")
        }
        // The cutout chosen for the new image (§14.5c), as a thumbnail URL names one; none: the default.
        const cropQuery = query.get("crop")
        const portrait = cropQuery === null ? null : parseCropKey(cropQuery)
        const pictureQuery = query.get("picture")
        const picture = pictureQuery === null ? null : parseCropKey(pictureQuery)
        if (pictureQuery !== null && !picture) return jsonError(400, "picture must name a crop")
        const crop = portrait && picture ? { ...portrait, picture } : portrait
        if (crop === undefined) return jsonError(400, "crop must name a cutout inside the image")
        // Before the body is read: a refused upload reads and stores nothing.
        const target = yield* reader.GetLibraryRef({ userId: user.id, refId })
        if (target.kind !== "card") return jsonError(409, "only cards have avatars")
        const message = NodeHttpServerRequest.toIncomingMessage(request)
        const limits = {
          maxBytes: MAX_AVATAR_BYTES,
          idleMs: BODY_IDLE_MS,
          deadline: Date.now() + BODY_DEADLINE_MS,
          minBytesPerSecond: BODY_MIN_BYTES_PER_SECOND,
          rateWindowMs: BODY_RATE_WINDOW_MS
        }
        return yield* oneAtATime(
          user.id,
          Effect.gen(function* () {
            yield* firstBytes(message, limits)
            const taken = yield* withPermitWithin(
              uploads,
              limits.deadline - Date.now(),
              Effect.gen(function* () {
                const body = yield* readBody(message, limits)
                const image = describeImage(body)
                if (!INLINE_IMAGES.has(image.mime)) {
                  return jsonError(415, "an image must be a PNG, JPEG, GIF or WebP image")
                }
                const sha256 = createHash("sha256").update(body).digest("hex")
                const change = yield* holding(
                  [sha256],
                  Effect.andThen(
                    storeMedia(config.dataDir, sha256, body),
                    gallery
                      ? writer.AddCardAsset({
                          userId: user.id,
                          refId,
                          expectedRowVersion: rowVersion,
                          name: assetName,
                          media: { role: "asset", uri: "", sha256, byteSize: body.byteLength, ...image }
                        })
                      : writer.SetCardAvatar({
                          userId: user.id,
                          refId,
                          expectedRowVersion: rowVersion,
                          media: { role: "avatar", uri: "", sha256, byteSize: body.byteLength, ...image },
                          ...(crop === null ? {} : { crop })
                        })
                  )
                )
                yield* prepareAvatarThumbnails(formats, config.dataDir, [{ role: "avatar", sha256 }], crop)
                return yield* HttpServerResponse.schemaJson(SavedRef)(
                  new SavedRef({
                    ref: change.ref,
                    followers: change.followers.map(({ refId, outcome }) => ({ refId, outcome })),
                    setAside: [],
                    recovered: 0
                  })
                )
              })
            )
            return Option.getOrElse(taken, () => jsonError(503, "the server is busy with other files; try again"))
          }).pipe(
            Effect.catchTag("BodyRefused", ({ reason }) => {
              const [status, text] = BODY_REFUSALS[reason]
              return Effect.succeed(jsonError(status, text).pipe(HttpServerResponse.setHeader("connection", "close")))
            })
          )
        )
      }).pipe(
        Effect.catchTags({
          NotFound: () => Effect.succeed(jsonError(404, "there's no such card")),
          StaleWrite: () => Effect.succeed(jsonError(409, "the card changed since you opened it; reload it")),
          RefOperationRefused: (error) => Effect.succeed(jsonError(409, error.reason))
        }),
        Effect.catch((error) =>
          Effect.logError("an avatar upload failed", error).pipe(Effect.as(jsonError(500, "the upload failed")))
        )
      )

    const uploadMessageImage = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      if (request.headers["content-type"] !== "application/octet-stream") {
        return jsonError(415, "expected application/octet-stream")
      }
      if (Number(request.headers["content-length"]) > MAX_AVATAR_BYTES) {
        return jsonError(413, `an image can be at most ${formatByteSize(MAX_AVATAR_BYTES)}`)
      }
      const message = NodeHttpServerRequest.toIncomingMessage(request)
      const limits = {
        maxBytes: MAX_AVATAR_BYTES,
        idleMs: BODY_IDLE_MS,
        deadline: Date.now() + BODY_DEADLINE_MS,
        minBytesPerSecond: BODY_MIN_BYTES_PER_SECOND,
        rateWindowMs: BODY_RATE_WINDOW_MS
      }
      return yield* oneAtATime(
        user.id,
        Effect.gen(function* () {
          yield* firstBytes(message, limits)
          const taken = yield* withPermitWithin(
            uploads,
            limits.deadline - Date.now(),
            Effect.gen(function* () {
              const body = yield* readBody(message, limits)
              const image = describeImage(body)
              if (!INLINE_IMAGES.has(image.mime)) {
                return jsonError(415, "an image must be a PNG, JPEG, GIF or WebP image")
              }
              if (!(yield* formats.validateImage(body))) {
                return jsonError(
                  415,
                  "The image couldn’t be read. Choose a complete PNG, JPEG, GIF or WebP up to 40 million pixels."
                )
              }
              const sha256 = createHash("sha256").update(body).digest("hex")
              const change = yield* holding(
                [sha256],
                Effect.andThen(
                  storeMedia(config.dataDir, sha256, body),
                  writer.RecordMessageImage({
                    userId: user.id,
                    media: { sha256, byteSize: body.byteLength, ...image }
                  })
                )
              )
              return HttpServerResponse.jsonUnsafe({ mediaId: change })
            })
          )
          return Option.getOrElse(taken, () => jsonError(503, "the server is busy with other files; try again"))
        }).pipe(
          Effect.catchTag("BodyRefused", ({ reason }) => {
            const [status, text] = BODY_REFUSALS[reason]
            return Effect.succeed(jsonError(status, text).pipe(HttpServerResponse.setHeader("connection", "close")))
          })
        )
      )
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("an image upload failed", error).pipe(Effect.as(jsonError(500, "the upload failed")))
      )
    )

    /** A stored image the user holds a reference to, for an `<img>` on this site only. */
    const mediaFile = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      const query = new URL(request.url, "http://media").searchParams
      const mediaId = query.get("id") ?? ""
      const file = yield* reader.GetMediaFile({ userId: user.id, mediaId, includeStaged: true })
      // Only images a browser shows as images; anything else stored is never served inline.
      if (!INLINE_IMAGES.has(file.mime)) return jsonError(404, "there's no such image")
      const requested = query.get("w")
      const width = requested === null ? Option.none<number>() : Schema.decodeUnknownOption(WidthQuery)(requested)
      if (requested !== null && Option.isNone(width)) {
        return jsonError(400, "w must be a positive pixel width")
      }
      // A portrait's cutout (§14.5c): `auto` (the default) or the chosen one, as `cropKey` names it.
      const cropQuery = query.get("crop")
      const crop = cropQuery === null ? undefined : parseCropKey(cropQuery)
      if (cropQuery !== null && (crop === undefined || Option.isNone(width))) {
        return jsonError(400, "crop must name a cutout inside the image, with a width")
      }
      const pictureQuery = query.get("picture")
      const picture = pictureQuery === null ? null : parseCropKey(pictureQuery)
      if (pictureQuery !== null && !picture) return jsonError(400, "picture must name a crop")
      const derivative = picture
        ? yield* thumbnail(file.path, 0, picture)
        : Option.isNone(width)
          ? null
          : yield* thumbnail(file.path, mediaWidth(width.value), crop)
      const path = derivative?.path ?? file.path
      const original = derivative === null || derivative.original
      const headers = {
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        etag: `"${path.split("/").pop()!}"`
      }
      const exists = yield* Effect.promise(() =>
        stat(join(config.dataDir, path)).then(
          () => true,
          () => false
        )
      )
      if (!exists) return jsonError(404, "there's no such image")
      if (
        request.headers["if-none-match"]
          ?.split(",")
          .some((tag) => tag.trim().replace(/^W\//, "") === headers.etag || tag.trim() === "*")
      ) {
        return HttpServerResponse.empty({ status: 304, headers })
      }
      const bytes = yield* Effect.tryPromise(() => readFile(join(config.dataDir, path)))
      return HttpServerResponse.uint8Array(bytes, {
        contentType: original ? file.mime : picture ? "image/png" : "image/webp",
        headers
      })
    }).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(jsonError(404, "there's no such image"))),
      Effect.catchTag("ThumbnailFailed", () => Effect.succeed(jsonError(404, "there's no such image"))),
      Effect.catch((error) =>
        Effect.logError("reading a media file failed", error).pipe(Effect.as(jsonError(500, "the file can't be read")))
      )
    )

    /**
     * Editor and composer drafts a page sends as it closes (`fetch` with `keepalive`), since its
     * WebSocket goes with it, and the browser copies Browser recovery retries (summaries' and
     * message editors' too). Each is saved as its own RPC (`SaveEditorDraft`, `SaveComposer`,
     * `SaveSummaryDraft`, `SaveMessageDraft`, `SaveFileDraft`) would: the
     * writer decides a conflict with another tab's save in the same transaction (drafts.ts).
     */
    const leavingDrafts = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        return jsonError(415, "expected application/json")
      }
      const input = yield* HttpServerRequest.schemaBodyJson(LeavingDrafts).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(4)),
        Effect.option
      )
      if (Option.isNone(input)) return jsonError(400, "expected drafts")
      // Everything is checked first and then saved in one transaction: a batch is saved whole or not at all.
      type Entry = Parameters<typeof writer.SaveDraftBatch>[0]["entries"][number]
      const entries: Array<Entry> = []
      const userDraftAt = new Set<number>()
      const remoteBases: Array<CacheKey | undefined> = []
      for (const draft of input.value.drafts) {
        if (parseField(draft.field) === null) return jsonError(400, "that isn't a field of a document")
        // The writer resolves the source card to the user's local ref if it has been added.
        const from = remoteOf(draft.refId)
        if (from !== null) remoteBases[entries.length] = draftBaseKey(user.id, from)
        entries.push({
          _tag: "draft",
          key:
            from !== null
              ? new DraftKey({
                  targetKind: "remote_card",
                  targetId: `${from.sourceId}:${from.remoteId}`,
                  field: draft.field
                })
              : new DraftKey({
                  targetKind: "entity_field",
                  targetId: entityDraftTarget(draft.refId, draft.scope),
                  field: draft.field
                }),
          draftId: draft.draftId,
          content: draft.content,
          expectedRowVersion: draft.expectedRowVersion,
          expectedSession: draft.expectedSession,
          baseRevision: draft.baseRevisionId
        })
      }
      for (const { ownerId, targetId, field, ...save } of input.value.userDrafts ?? []) {
        if (ownerId !== user.id) return jsonError(404, "there is no such draft owner")
        userDraftAt.add(entries.length)
        entries.push({
          _tag: "draft",
          key: new DraftKey({ targetKind: "user_field", targetId, field }),
          ...save,
          baseRevision: null
        })
      }
      for (const summary of input.value.summaries ?? []) {
        entries.push({
          _tag: "draft",
          key: new DraftKey({ targetKind: "summary_edit", targetId: summary.summaryId, field: summary.forkId ?? "" }),
          draftId: summary.draftId,
          ...(summary.observedDeletion === undefined ? {} : { observedDeletion: summary.observedDeletion }),
          content: summary.content,
          expectedRowVersion: summary.expectedRowVersion,
          expectedSession: summary.expectedSession,
          baseRevision: summary.baseRevisionId
        })
      }
      for (const message of input.value.messages ?? []) {
        entries.push({
          _tag: "draft",
          key: messageDraftKey(message.target),
          draftId: message.draftId,
          ...(message.observedDeletion === undefined ? {} : { observedDeletion: message.observedDeletion }),
          content: message.content,
          ...(message.images === undefined ? {} : { images: message.images }),
          expectedRowVersion: message.expectedRowVersion,
          expectedSession: message.expectedSession,
          baseRevision: message.target._tag === "Queue" ? String(message.target.rowVersion) : null
        })
      }
      for (const { path, baseSha256, ...save } of input.value.files ?? []) {
        const full = yield* Effect.try({
          try: () => resolveFilesPath(path, FILES_TOP).full,
          catch: () => new NotFound({ entity: "file", id: path })
        })
        if (full !== path || full === FILES_TOP) return jsonError(404, "there's no such file")
        entries.push({ _tag: "draft", key: fileDraftKey(full), ...save, baseRevision: baseSha256 })
      }
      for (const composer of input.value.composers ?? []) {
        entries.push({ _tag: "composer", ...composer })
      }
      const save = writer.SaveDraftBatch({ userId: user.id, entries })
      const saved =
        entries.length === 0
          ? []
          : yield* remoteBases.length === 0
              ? save
              : sources.cache.withDraftBases(remoteBases, save, (results, index) => {
                  const draft = results[index]?.draft
                  return draft?.status === "active" && draft.key.targetKind === "remote_card"
                })
      let recovered = 0
      saved.forEach((result, at) => {
        recovered += result.recovered
        if (userDraftAt.has(at) && result.draft)
          notices.publish(user.id, { _tag: "UserDraftChanged", draft: result.draft })
      })
      return HttpServerResponse.empty({ status: 204, headers: { "x-drafts-recovered": String(recovered) } })
    }).pipe(
      Effect.catchTags({
        NotFound: () => Effect.succeed(jsonError(404, "there's no such entry")),
        DraftTooLarge: () => Effect.succeed(jsonError(413, "a draft is too long"))
      }),
      Effect.catch((error) =>
        Effect.logError("saving drafts on leaving failed", error).pipe(
          Effect.as(jsonError(500, "the drafts weren't saved"))
        )
      )
    )

    return Layer.mergeAll(
      HttpRouter.add("POST", "/library/drafts", authenticated(accounts, leavingDrafts)),
      HttpRouter.add("POST", "/chat/image", authenticated(accounts, uploadMessageImage)),
      HttpRouter.add("POST", "/library/avatar", authenticated(accounts, uploadAvatar())),
      HttpRouter.add("POST", "/library/gallery", authenticated(accounts, uploadAvatar(true))),
      HttpRouter.add("GET", "/library/media", authenticated(accounts, mediaFile)),
      HttpRouter.add("POST", "/library/import", authenticated(accounts, importFile)),
      HttpRouter.add("POST", "/library/export", authenticated(accounts, exportFile)),
      HttpRouter.add("POST", "/library/chat-export", authenticated(accounts, exportChat)),
      HttpRouter.add("POST", "/library/archive", authenticated(accounts, exportLibrary)),
      HttpRouter.add("GET", "/library/download", authenticated(accounts, downloadFile)),
      HttpRouter.add("GET", "/library/download-status", authenticated(accounts, downloadStatus)),
      HttpRouter.add("POST", "/library/download-stop", authenticated(accounts, stopDownload)),
      HttpRouter.add("POST", "/st-import/file", authenticated(accounts, stImportFile)),
      HttpRouter.add("POST", "/st-import/plan-file", authenticated(accounts, stImportPlanFile)),
      Layer.effectDiscard(Effect.forkScoped(Effect.repeat(sweep, Schedule.spaced("1 hour"))))
    )
  })
)
