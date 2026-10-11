// Main-thread access to the format workers (ARCHITECTURE.md §10.3). The pool is the
// database readers' (db/readerPool.ts): a worker is busy until it answers, a crashed one
// fails the request it was running and is respawned, and requests beyond the pool's size
// queue in order.
import { Context, Effect, Layer, Schema } from "effect"
import { RpcClient } from "effect/rpc"
import { bundleEntry, defaultBundleDir, workerThreads } from "../db/Database.ts"
import * as ReaderPool from "../db/readerPool.ts"
import { type ExportRefused, FormatOps, ownBuffer, type ParsedFile } from "./ops.ts"

/** The format worker stopped (it crashed or ran out of memory) while it had the file. */
export class FormatWorkerFailed extends Schema.TaggedError<FormatWorkerFailed>()("FormatWorkerFailed", {}) {}

type ExportInput = Parameters<RpcClient.FromGroup<typeof FormatOps>["Export"]>[0]

export class Formats extends Context.Service<
  Formats,
  {
    /** Parses a file in a worker. A buffer of its own is transferred, and unusable here afterwards. */
    readonly parse: (bytes: Uint8Array, fileName: string) => Effect.Effect<ParsedFile, FormatWorkerFailed>
    /** Writes a document as a file in a worker. Files' buffers of their own are transferred. */
    readonly export: (input: ExportInput) => Effect.Effect<Uint8Array, ExportRefused | FormatWorkerFailed>
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
}

/**
 * A worker's heap limit. The worst file within the caps took 80 MB (ARCHITECTURE.md §8),
 * and a worker from source needs about 85 MB for its modules. Past this, the worker dies
 * and its request fails, instead of the whole server running out of memory.
 */
const MAX_HEAP_MB = 512

const failed = (error: unknown) =>
  Effect.logError("a format worker failed", error).pipe(Effect.andThen(Effect.fail(new FormatWorkerFailed())))

export const layer = (options: FormatsOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const bundleDir = options.workers === "bundle" ? (options.bundleDir ?? defaultBundleDir) : undefined
      const entry =
        options.entry ??
        (bundleDir === undefined ? new URL("./worker.ts", import.meta.url) : yield* bundleEntry(bundleDir, "formats"))
      return Layer.effect(
        Formats,
        Effect.map(RpcClient.make(FormatOps), (client) =>
          Formats.of({
            parse: (bytes, fileName) =>
              client.Parse({ bytes: ownBuffer(bytes), fileName }).pipe(Effect.catchTag("RpcClientError", failed)),
            export: (input) =>
              client
                .Export({
                  ...input,
                  avatar: input.avatar && { ...input.avatar, bytes: ownBuffer(input.avatar.bytes) },
                  assets: input.assets.map((asset) => ({ ...asset, bytes: ownBuffer(asset.bytes) }))
                })
                .pipe(Effect.catchTag("RpcClientError", failed))
          })
        )
      ).pipe(
        Layer.provide(ReaderPool.layer(options.size, "format worker")),
        Layer.provide(workerThreads(entry, {}, bundleDir, { maxOldGenerationSizeMb: MAX_HEAP_MB }))
      )
    })
  )
