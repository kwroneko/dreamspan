// Files into and out of the library over plain HTTP (ARCHITECTURE.md §10.4). RPC messages
// are JSON, so a file would cross as base64: a third larger, and decoded whole on the main
// thread. Both routes act as the user the session names, behind the same cross-site guard
// as every request (server.ts), and refuse content types a cross-site form can send.
import { CurrentUser } from "@rp/shared/api.ts"
import {
  type ExportFormat,
  ExportFormat as ExportFormatSchema,
  exportFormats,
  ImportResult
} from "@rp/shared/libraryImport.ts"
import { RefId } from "@rp/shared/library.ts"
import { ByteSize, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Accounts } from "../auth/Accounts.ts"
import { AppConfig } from "../config.ts"
import { Reader, Writer } from "../db/Database.ts"
import { defaultLimits } from "../formats/safety.ts"
import { Formats } from "./Formats.ts"
import { readMedia, storeMedia } from "./mediaFiles.ts"

/** The largest upload: the parsers' own cap on any file (ARCHITECTURE.md §8). */
const MAX_UPLOAD_BYTES = defaultLimits.maxFileBytes

/** A file name as given, without folders or control characters, bounded. */
const fileNameFrom = (raw: string | null) =>
  (raw ?? "")
    .replace(/\p{Cc}+/gu, "")
    .split(/[/\\]/)
    .pop()!
    .slice(0, 255)

const jsonError = (status: number, message: string) => HttpServerResponse.jsonUnsafe({ error: message }, { status })

/** The user the request's session names, as for an RPC (auth/Accounts.ts). */
const authenticated = <A, E, R>(accounts: Accounts["Service"], handle: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const session = yield* Effect.option(accounts.resolve(request.headers))
    if (Option.isNone(session)) return jsonError(401, "login required")
    return yield* Effect.provideService(handle, CurrentUser, session.value.user)
  })

const ExportRequest = Schema.Struct({ refId: RefId, format: ExportFormatSchema })

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
    // Uploads past this many wait before their body is read, so at most this many are held
    // in memory: the rest stay in the socket, where TCP holds the sender back.
    const uploads = Semaphore.makeUnsafe(config.formatWorkers * 2)

    const importFile = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const user = yield* CurrentUser
      // A cross-site form can't send this type, on top of the Origin check.
      if (request.headers["content-type"] !== "application/octet-stream") {
        return jsonError(415, "expected application/octet-stream")
      }
      if (Number(request.headers["content-length"]) > MAX_UPLOAD_BYTES) {
        return jsonError(413, `files can be at most ${MAX_UPLOAD_BYTES} bytes`)
      }
      const query = new URL(request.url, "http://upload").searchParams
      const fileName = fileNameFrom(query.get("name"))
      const into = query.get("into")
      if (into !== null && !Schema.is(RefId)(into)) return jsonError(400, "into must name a ref")

      return yield* uploads.withPermits(1)(
        Effect.gen(function* () {
          // The cap applies as the body arrives: past it, reading stops and the connection closes.
          const body = yield* request.arrayBuffer.pipe(
            Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_UPLOAD_BYTES)),
            Effect.option
          )
          if (Option.isNone(body)) return jsonError(400, "the file didn't arrive whole")
          const parsed = yield* formats.parse(new Uint8Array(body.value), fileName)
          if (parsed.library === null) {
            return yield* HttpServerResponse.schemaJson(ImportResult)(
              new ImportResult({ report: parsed.report, library: null })
            )
          }
          yield* Effect.forEach(parsed.media, (file) => storeMedia(config.dataDir, file.sha256, file.bytes), {
            discard: true
          })
          const library = yield* writer.ImportFile({
            userId: user.id,
            intoRefId: into,
            ...parsed.library,
            sourceName: fileName,
            sourceHash: parsed.sha256,
            media: parsed.media.map(({ bytes: _, ...file }) => file)
          })
          return yield* HttpServerResponse.schemaJson(ImportResult)(
            new ImportResult({ report: parsed.report, library })
          )
        })
      )
    }).pipe(
      Effect.catchTags({
        NotFound: () => Effect.succeed(jsonError(404, "there's no such ref")),
        RefOperationRefused: (error) => Effect.succeed(jsonError(409, error.reason)),
        FormatWorkerFailed: () =>
          Effect.succeed(jsonError(500, "The importer stopped while reading this file. The file may be malformed."))
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
      const read = (file: { path: string; mime: string }) =>
        Effect.map(readMedia(config.dataDir, file.path), (bytes) => bytes && { bytes, mime: file.mime })
      const avatar = source.avatar && (yield* read(source.avatar))
      const assets = yield* Effect.forEach(source.assets, (asset) =>
        Effect.map(read(asset), (file) => (file ? [{ ...file, uri: asset.uri }] : []))
      )
      const bytes = yield* formats.export({
        format,
        docJson: source.docJson,
        noteDocJson: source.noteDocJson,
        avatar: avatar ?? null,
        assets: assets.flat()
      })
      const [mime, extension] = CONTENT_TYPES[format]
      return HttpServerResponse.uint8Array(bytes, {
        contentType: mime,
        headers: {
          "content-disposition": disposition(source.label, extension),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        }
      })
    }).pipe(
      Effect.catchTags({
        NotFound: () => Effect.succeed(jsonError(404, "there's no such ref")),
        ExportRefused: (error) => Effect.succeed(jsonError(422, error.message))
      }),
      Effect.catch((error) =>
        Effect.logError("an export failed", error).pipe(Effect.as(jsonError(500, "the export failed")))
      )
    )

    return Layer.mergeAll(
      HttpRouter.add("POST", "/library/import", authenticated(accounts, importFile)),
      HttpRouter.add("POST", "/library/export", authenticated(accounts, exportFile))
    )
  })
)
