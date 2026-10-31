import type { ExportFormatInfo } from "@rp/shared/libraryImport.ts"
import * as StParsers from "./stParserRegistry.ts"
import type { StSettingsImport } from "@rp/shared/modelSettings.ts"
// Main-thread access to the format workers (ARCHITECTURE.md §11.3). The pool is the
// database readers' (db/readerPool.ts): a worker is busy until it answers, a crashed one
// fails only the request it was running and is respawned, and requests beyond the pool's
// size queue in order.
import { Context, Effect, Layer, Schema } from "effect"
import type { Worker } from "node:worker_threads"
import { RpcClientError } from "effect/rpc"
import { bundleEntry, WorkerBundleDir, workerThreads } from "../db/Database.ts"
import * as ReaderPool from "../db/readerPool.ts"
import type { ImportReport } from "@rp/shared/importReport.ts"
import type { EntityKind } from "@rp/shared/library.ts"
import {
  type ExportInput,
  type ExportRefused,
  FormatOps,
  ownBuffer,
  type ParsedFile,
  type StChatPart,
  type StGroup,
  type StLibraryFile,
  type StPersona,
  type StSettings
} from "./ops.ts"
import type { ThumbnailFailed, ThumbnailResult } from "./ops.ts"
import type { MEDIA_WIDTHS } from "@rp/shared/media.ts"

/**
 * The format worker failed while it had the file: it crashed, ran out of memory, ran past
 * its deadline, or couldn't start. Files the parsers can't read are reports, not this, so
 * the message doesn't blame the file.
 */
export class FormatWorkerFailed extends Schema.TaggedError<FormatWorkerFailed>()("FormatWorkerFailed", {}) {
  override get message() {
    return "The import failed on the server; try again."
  }
}

export class Formats extends Context.Service<
  Formats,
  {
    readonly listExports: Effect.Effect<ReadonlyArray<ExportFormatInfo>, FormatWorkerFailed>
    readonly previewStSettings: (
      text: string,
      surface: "model" | "connection"
    ) => Effect.Effect<StSettingsImport, FormatWorkerFailed>
    readonly thumbnail: (input: {
      readonly dataDir: string
      readonly path: string
      readonly width: (typeof MEDIA_WIDTHS)[number]
    }) => Effect.Effect<ThumbnailResult, ThumbnailFailed | FormatWorkerFailed>
    /** Parses a file in a worker. A buffer of its own is transferred, and unusable here afterwards. */
    readonly parse: (bytes: Uint8Array, fileName: string) => Effect.Effect<ParsedFile, FormatWorkerFailed>
    /** Writes a document as a file in a worker. Files' buffers of their own are transferred. */
    readonly export: (input: ExportInput) => Effect.Effect<Uint8Array, ExportRefused | FormatWorkerFailed>
    /** The ST data folder's files (ARCHITECTURE.md §13), each in a worker like any upload. */
    readonly st: {
      readonly chatPart: (input: {
        readonly bytes: Uint8Array
        readonly first: boolean
        readonly firstIndex: number
        readonly carryAt: number | null
      }) => Effect.Effect<StChatPart, FormatWorkerFailed>
      readonly settings: (
        bytes: Uint8Array
      ) => Effect.Effect<{ readonly report: ImportReport; readonly settings: StSettings | null }, FormatWorkerFailed>
      readonly group: (
        bytes: Uint8Array,
        fileName: string
      ) => Effect.Effect<{ readonly report: ImportReport; readonly group: StGroup | null }, FormatWorkerFailed>
      readonly libraryFile: (
        bytes: Uint8Array,
        fileName: string,
        expect: EntityKind,
        textSwitches?: StSettings["textSwitches"]
      ) => Effect.Effect<StLibraryFile, FormatWorkerFailed>
      readonly persona: (
        bytes: Uint8Array,
        fileName: string,
        persona: StPersona | null
      ) => Effect.Effect<ParsedFile, FormatWorkerFailed>
    }
  }
>()("rp/importer/Formats") {}

interface FormatsOptions {
  /** The worker entry point: from source, or the `npm run build` bundle. */
  readonly workers: "source" | "bundle"
  /** How many files are parsed or written at once. */
  readonly size: number
  readonly bundleDir?: string
  /** A test's own worker script. */
  readonly entry?: URL
  /** How long a parse or an export may run before its worker is stopped; 30 s by default. */
  readonly jobDeadlineMs?: number
}

/**
 * A worker's heap limit. The worst file within the caps took 80 MB (ARCHITECTURE.md §8),
 * and a worker from source needs about 85 MB for its modules. Past this, the worker dies
 * and its request fails, instead of the whole server running out of memory.
 */
const MAX_HEAP_MB = 512

/**
 * The worst file within the caps parses in about a second, unloaded (ARCHITECTURE.md §8);
 * a job past this is a parser that will never return.
 */
const JOB_DEADLINE_MS = 30_000

const failed = (error: unknown) =>
  Effect.logError("a format worker failed", error).pipe(Effect.andThen(Effect.fail(new FormatWorkerFailed())))

/** A crash reaches its request as an RpcClientError, a failed send as a defect. */
const workerFailures = <A, E>(effect: Effect.Effect<A, E | RpcClientError.RpcClientError>) =>
  Effect.catchIf(
    effect,
    (error): error is RpcClientError.RpcClientError => error instanceof RpcClientError.RpcClientError,
    failed
  ).pipe(Effect.catchDefect(failed))

export const layer = (options: FormatsOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      // The newest thread of each worker id, so a job past its deadline can be stopped.
      const threads = new Map<number, Worker>()
      const parsers = yield* StParsers.StParserRegistry
      const parser = (id: Parameters<typeof parsers.get>[0]) => parsers.get(id) ?? null
      const bundleDir = options.workers === "bundle" ? (options.bundleDir ?? (yield* WorkerBundleDir)) : undefined
      const entry =
        options.entry ??
        (bundleDir === undefined ? new URL("./worker.ts", import.meta.url) : yield* bundleEntry(bundleDir, "formats"))
      return Layer.effect(
        Formats,
        Effect.map(ReaderPool.client(FormatOps), (client) =>
          Formats.of({
            listExports: workerFailures(client.ListExportFormats()),
            previewStSettings: (text, surface) => workerFailures(client.PreviewStSettings({ text, surface })),
            thumbnail: (input) => workerFailures(client.Thumbnail(input)),
            parse: (bytes, fileName) => workerFailures(client.Parse({ bytes: ownBuffer(bytes), fileName })),
            export: (input) =>
              workerFailures(
                client.Export({
                  ...input,
                  avatar: input.avatar && { ...input.avatar, bytes: ownBuffer(input.avatar.bytes) },
                  assets: input.assets.map((asset) => ({ ...asset, bytes: ownBuffer(asset.bytes) }))
                })
              ),
            st: {
              chatPart: (input) =>
                Effect.suspend(() =>
                  workerFailures(
                    client.ParseStChatPart({ ...input, bytes: ownBuffer(input.bytes), parser: parser("chat-part") })
                  )
                ),
              settings: (bytes) =>
                Effect.suspend(() =>
                  workerFailures(client.ParseStSettings({ bytes: ownBuffer(bytes), parser: parser("settings") }))
                ),
              group: (bytes, fileName) =>
                Effect.suspend(() =>
                  workerFailures(client.ParseStGroup({ bytes: ownBuffer(bytes), fileName, parser: parser("group") }))
                ),
              libraryFile: (bytes, fileName, expect, textSwitches) =>
                Effect.suspend(() =>
                  workerFailures(
                    client.ParseStLibraryFile({
                      bytes: ownBuffer(bytes),
                      fileName,
                      expect,
                      ...(textSwitches ? { textSwitches } : {}),
                      parser: parser("library-file")
                    })
                  )
                ),
              persona: (bytes, fileName, persona) =>
                Effect.suspend(() =>
                  workerFailures(
                    client.BuildStPersona({ bytes: ownBuffer(bytes), fileName, persona, parser: parser("persona") })
                  )
                )
            }
          })
        )
      ).pipe(
        Layer.provide(
          ReaderPool.layer(options.size, {
            name: "format worker",
            // No retryCrashed: a file that stopped one worker would stop the next, and its
            // bytes went with the first.
            jobDeadline: {
              ms: options.jobDeadlineMs ?? JOB_DEADLINE_MS,
              terminate: (id) => void threads.get(id)?.terminate()
            }
          })
        ),
        Layer.provide(
          workerThreads(entry, {}, bundleDir, { maxOldGenerationSizeMb: MAX_HEAP_MB }, (id, thread) =>
            threads.set(id, thread)
          )
        )
      )
    })
  ).pipe(Layer.provideMerge(StParsers.layer))
