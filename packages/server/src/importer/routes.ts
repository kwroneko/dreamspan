// Files into and out of the library over plain HTTP (ARCHITECTURE.md §11.4). RPC messages
// are JSON, so a file would cross as base64: a third larger, and decoded whole on the main
// thread. Both routes act as the user the session names, behind the same cross-site guard
// as every request (server.ts), and refuse content types a cross-site form can send.
import { createHash } from "node:crypto"
import { CurrentUser } from "@rp/shared/api.ts"
import { SavedRef } from "@rp/shared/editorApi.ts"
import { ImportIssue, ImportReport } from "@rp/shared/importReport.ts"
import {
  type ExportFormat,
  ExportFormat as ExportFormatSchema,
  exportFormats,
  ImportResult
} from "@rp/shared/libraryImport.ts"
import { RefId } from "@rp/shared/library.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import { EditorDraftSave } from "@rp/shared/editorApi.ts"
import { ComposerBeacon } from "@rp/shared/composerApi.ts"
import { SummaryDraftSave } from "@rp/shared/lcm.ts"
import { MessageDraftSave, messageDraftKey } from "@rp/shared/chatApi.ts"
import { parseField } from "@rp/shared/editing.ts"
import { ByteSize, Effect, Layer, Option, Schedule, Schema, Semaphore } from "effect"
import { NodeHttpServerRequest } from "@effect/platform-node"
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Accounts } from "../auth/Accounts.ts"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { defaultLimits } from "../formats/safety.ts"
import { BodyRefused, firstBytes, readBody } from "./body.ts"
import { Formats } from "./Formats.ts"
import { MediaHolds } from "./MediaHolds.ts"
import { StImports } from "./StImports.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import { classifyStPath, ST_CHAT_PART_BYTES } from "@rp/shared/stFolder.ts"
import { StFileResult } from "@rp/shared/stImportApi.ts"
import { describeImage } from "./images.ts"
import { readMedia, storeMedia, sweepMedia } from "./mediaFiles.ts"

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
  too_large: [413, `files can be at most ${MAX_UPLOAD_BYTES} bytes`],
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

const LeavingDrafts = Schema.Struct({
  drafts: Schema.Array(EditorDraftSave).check(Schema.isMaxLength(500)),
  /** Chats' composers (DESIGN §6.2): one per open chat at most, in practice. */
  composers: Schema.optionalKey(Schema.Array(ComposerBeacon).check(Schema.isMaxLength(50))),
  /** Summaries' edits, from this browser's copies (`summaryDraft.ts`). */
  summaries: Schema.optionalKey(Schema.Array(SummaryDraftSave).check(Schema.isMaxLength(50))),
  /** Message editors' text, from this browser's copies (`messageDraft.ts`). */
  messages: Schema.optionalKey(Schema.Array(MessageDraftSave).check(Schema.isMaxLength(50)))
})

const CONTENT_TYPES: Record<ExportFormat, readonly [mime: string, extension: string]> = {
  "card-v2-json": ["application/json", "json"],
  "card-v3-json": ["application/json", "json"],
  "card-png": ["image/png", "png"],
  "card-charx": ["application/zip", "charx"],
  "st-world-info": ["application/json", "json"],
  "st-preset": ["application/json", "json"]
}

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
    const reader = yield* Reader
    const writer = yield* Writer
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
      // Before the body is read: a refused import reads, parses and stores nothing.
      const target = into === null ? null : yield* reader.GetLibraryRef({ userId: user.id, refId: into })
      if (target !== null && target.refKind !== "upstream") {
        return jsonError(409, "only a library entry's original takes a new version of its file")
      }

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
              const parsed = yield* formats.parse(body, fileName)
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
                  return yield* writer.ImportFile({
                    userId: user.id,
                    intoRefId: into,
                    ...parsed.library!,
                    sourceName: fileName,
                    sourceHash: parsed.sha256,
                    media: parsed.media.map(({ bytes: _, ...file }) => file)
                  })
                })
              )
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
      if (!exportFormats[source.kind]?.includes(format)) {
        return jsonError(400, `a ${source.kind} can't be exported as ${format}`)
      }
      // Only the files the format holds: the avatar for a PNG, every file for a CHARX. A
      // document can name any number of them, the same one many times over, so their total
      // is capped before anything is read, and each is read once.
      const files = format === "card-charx" ? [source.avatar, ...source.assets] : [source.avatar]
      const wanted = format === "card-png" || format === "card-charx" ? files.filter((file) => file !== null) : []
      const total = wanted.reduce((sum, file) => sum + file.byteSize, 0)
      if (total > MAX_EXPORT_FILE_BYTES) {
        return jsonError(
          422,
          `This card's files add up to ${Math.ceil(total / 1024 / 1024)} MB, more than an export can hold (${MAX_EXPORT_FILE_BYTES / 1024 / 1024} MB).`
        )
      }
      const cache = new Map<string, Effect.Success<ReturnType<typeof readMedia>>>()
      const read = (file: { path: string; mime: string }) =>
        Effect.gen(function* () {
          if (!cache.has(file.path)) cache.set(file.path, yield* readMedia(config.dataDir, file.path))
          const bytes = cache.get(file.path)
          return bytes && { bytes, mime: file.mime }
        })
      const [mime, extension] = CONTENT_TYPES[format]
      return yield* oneAtATime(
        user.id,
        exports.withPermits(1)(
          Effect.gen(function* () {
            const avatar = source.avatar && wanted.length > 0 ? yield* read(source.avatar) : undefined
            const assets =
              format === "card-charx"
                ? yield* Effect.forEach(source.assets, (asset) =>
                    Effect.map(read(asset), (file) => (file ? [{ ...file, uri: asset.uri }] : []))
                  )
                : []
            const bytes = yield* formats.export({
              format,
              docJson: source.docJson,
              noteDocJson: source.noteDocJson,
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

    // At startup and every hour: media files no row names, which a failed import can leave.
    const sweep = Effect.gen(function* () {
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
      const maxBytes = chat ? ST_CHAT_PART_BYTES : MAX_UPLOAD_BYTES
      if (Number(request.headers["content-length"]) > maxBytes) return jsonError(413, `at most ${maxBytes} bytes`)
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
              const answer = yield* stImports.file(user, importId, path, body, {
                part,
                last: query.get("last") !== "0",
                card: card as EntityId | "none" | null,
                orphan: query.get("orphan") === "1"
              })
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

    // --- The card editor's avatar, and stored images back out (ARCHITECTURE.md "Editing the
    // library"). An avatar upload is an upload like an import: the same permits and limits.
    const uploadAvatar = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      if (request.headers["content-type"] !== "application/octet-stream") {
        return jsonError(415, "expected application/octet-stream")
      }
      if (Number(request.headers["content-length"]) > MAX_AVATAR_BYTES) {
        return jsonError(413, `an avatar can be at most ${MAX_AVATAR_BYTES / 1024 / 1024} MB`)
      }
      const query = new URL(request.url, "http://upload").searchParams
      const refId = query.get("ref")
      const rowVersion = Number(query.get("rowVersion"))
      if (!Schema.is(RefId)(refId) || !Number.isSafeInteger(rowVersion)) {
        return jsonError(400, "expected a ref and its row version")
      }
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
                return jsonError(415, "an avatar must be a PNG, JPEG, GIF or WebP image")
              }
              const sha256 = createHash("sha256").update(body).digest("hex")
              const change = yield* holding(
                [sha256],
                Effect.andThen(
                  storeMedia(config.dataDir, sha256, body),
                  writer.SetCardAvatar({
                    userId: user.id,
                    refId,
                    expectedRowVersion: rowVersion,
                    media: { role: "avatar", uri: "", sha256, byteSize: body.byteLength, ...image }
                  })
                )
              )
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

    /** A stored image the user holds a reference to, for an `<img>` on this site only. */
    const mediaFile = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      const mediaId = new URL(request.url, "http://media").searchParams.get("id") ?? ""
      const file = yield* reader.GetMediaFile({ userId: user.id, mediaId })
      // Only images a browser shows as images; anything else stored is never served inline.
      if (!INLINE_IMAGES.has(file.mime)) return jsonError(404, "there's no such image")
      const bytes = yield* readMedia(config.dataDir, file.path)
      if (bytes === undefined) return jsonError(404, "there's no such image")
      return HttpServerResponse.uint8Array(bytes, {
        contentType: file.mime,
        headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
      })
    }).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(jsonError(404, "there's no such image"))),
      Effect.catch((error) =>
        Effect.logError("reading a media file failed", error).pipe(Effect.as(jsonError(500, "the file can't be read")))
      )
    )

    /**
     * Editor and composer drafts a page sends as it closes (`fetch` with `keepalive`), since its
     * WebSocket goes with it, and the browser copies Browser recovery retries (summaries' and
     * message editors' too). Each is saved as its own RPC (`SaveEditorDraft`, `SaveComposer`,
     * `SaveSummaryDraft`, `SaveMessageDraft`) would: the
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
      let recovered = 0
      for (const draft of input.value.drafts) {
        if (parseField(draft.field) === null) return jsonError(400, "that isn't a field of a document")
        const saved = yield* writer.SaveDraft({
          userId: user.id,
          key: new DraftKey({ targetKind: "entity_field", targetId: draft.refId, field: draft.field }),
          draftId: draft.draftId,
          content: draft.content,
          expectedRowVersion: draft.expectedRowVersion,
          expectedSession: draft.expectedSession,
          baseRevision: draft.baseRevisionId
        })
        recovered += saved.recovered
      }
      for (const summary of input.value.summaries ?? []) {
        const saved = yield* writer.SaveDraft({
          userId: user.id,
          key: new DraftKey({ targetKind: "summary_edit", targetId: summary.summaryId, field: "" }),
          draftId: summary.draftId,
          content: summary.content,
          expectedRowVersion: summary.expectedRowVersion,
          expectedSession: summary.expectedSession,
          baseRevision: summary.baseRevisionId
        })
        recovered += saved.recovered
      }
      for (const message of input.value.messages ?? []) {
        const saved = yield* writer.SaveDraft({
          userId: user.id,
          key: messageDraftKey(message.target),
          draftId: message.draftId,
          content: message.content,
          expectedRowVersion: message.expectedRowVersion,
          expectedSession: message.expectedSession,
          baseRevision: null
        })
        recovered += saved.recovered
      }
      for (const composer of input.value.composers ?? []) {
        const saved = yield* writer.SaveComposer({ userId: user.id, ...composer })
        recovered += Math.max(saved.draft?.recovered ?? 0, saved.recovered ? 1 : 0)
      }
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
      HttpRouter.add("POST", "/library/avatar", authenticated(accounts, uploadAvatar)),
      HttpRouter.add("GET", "/library/media", authenticated(accounts, mediaFile)),
      HttpRouter.add("POST", "/library/import", authenticated(accounts, importFile)),
      HttpRouter.add("POST", "/library/export", authenticated(accounts, exportFile)),
      HttpRouter.add("POST", "/st-import/file", authenticated(accounts, stImportFile)),
      Layer.effectDiscard(Effect.forkScoped(Effect.repeat(sweep, Schedule.spaced("1 hour"))))
    )
  })
)
