import type { UserId } from "@rp/shared/domain.ts"
import type { ChatId } from "@rp/shared/chat.ts"
import { makeShellMaterialization } from "./shellMaterialization.ts"
// Main-thread access to the database workers. ARCHITECTURE.md §3.1 and §3.6.
import { StateModules, stateModuleClient } from "./stateModules.ts"
import { AssemblyModules, moduleClient } from "../assembler/modules.ts"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { type ResourceLimits, Worker } from "node:worker_threads"
import { NodeWorker } from "@effect/platform-node"
import { Cause, Context, Effect, Layer, Schema, Semaphore } from "effect"
import { RpcClient, type RpcClientError } from "effect/rpc"
import { Worker as Workers } from "effect/workers"
import { type BinLimits, defaultBinLimits } from "@rp/shared/bin.ts"
import { acquireInstanceLock, checkFilesystem, databaseFile } from "./connection.ts"
import { prepareDataDirectory } from "../dataDirectory.ts"
import { ReadOps, WriteOps, type WriteOpsChat, type WriteOpsLibrary } from "./ops.ts"
import type { OpsOf } from "./opsOf.ts"
import * as ReaderPool from "./readerPool.ts"
import { stampMatches } from "./workerStamp.ts"
import { ProviderDefinitions, providerDefinitionClient } from "../providers/definitions.ts"

// Typed through `OpsOf`, never `RpcClient.FromGroup` (opsOf.ts). The writer's halves are only a
// grouping in ops.ts; a new write operation goes in either.
type OpsClient<Group> = RpcClient.RpcClient<OpsOf<Group>, RpcClientError.RpcClientError>

interface WriterClient extends OpsClient<typeof WriteOpsChat>, OpsClient<typeof WriteOpsLibrary> {}

export class Writer extends Context.Service<Writer, WriterClient>()("rp/db/Writer") {}

export class Reader extends Context.Service<Reader, OpsClient<typeof ReadOps>>()("rp/db/Reader") {}

/** Tests can advance the writer's history clock without sleeping or writing SQLite on the main thread. */
export const DraftClock = Context.Reference<SharedArrayBuffer | null>("rp/db/DraftClock", { defaultValue: () => null })

interface DatabaseOptions {
  readonly dataDir: string
  readonly readers: number
  readonly allowNetworkFs: boolean
  /** source: the worker TypeScript (development and tests). bundle: the `npm run build` bundles. */
  readonly workers: "source" | "bundle"
  /** Where the bundles are; `packages/server/dist/workers` when omitted. */
  readonly bundleDir?: string
  /** Recycle bin capacities; defaults when omitted. */
  readonly binLimits?: BinLimits
}

class WorkerBundleMissing extends Schema.TaggedError<WorkerBundleMissing>()("WorkerBundleMissing", {
  path: Schema.String
}) {
  override get message() {
    return `Database worker bundle not found at ${this.path}. Run \`npm run build\`, or set DB_WORKERS=source.`
  }
}

class WorkerBundleStale extends Schema.TaggedError<WorkerBundleStale>()("WorkerBundleStale", {
  path: Schema.String
}) {
  override get message() {
    return `The database worker bundles in ${this.path} were built from other sources than this server's. Run \`npm run build\`.`
  }
}

const defaultBundleDir = fileURLToPath(new URL("../../dist/workers", import.meta.url))

/**
 * Where bundled workers are looked for when the options name no directory. The tests point
 * it at the bundles their run built (test/support/globalSetup.ts).
 */
export const WorkerBundleDir = Context.Reference<string>("rp/db/WorkerBundleDir", {
  defaultValue: () => defaultBundleDir
})

/** A bundled worker's entry point, `<name>.mjs` in `dir`. It must exist and match the sources. */
export const bundleEntry = (dir: string, name: string) =>
  Effect.gen(function* () {
    const path = join(dir, `${name}.mjs`)
    if (!existsSync(path)) return yield* new WorkerBundleMissing({ path })
    if (!stampMatches(dir)) return yield* new WorkerBundleStale({ path: dir })
    return pathToFileURL(path)
  })

/**
 * Reads that browse, and can be slow at scale: they never hold the last free reader (readerPool.ts).
 * A pending chat's first-request preview is one: a card with a huge greeting takes minutes to build.
 */
const BACKGROUND_READS: ReadonlySet<string> = new Set([
  "ShellMaterialize",
  "ShellSummarizeStale",
  "GetSplitChats",
  "ThreadsOf",
  "ListForks",
  "ShellLibrary",
  "ShellCards",
  "ShellForks",
  "CacheWarmth",
  "AssembleDraftChat"
])

/**
 * Reads a reply waits on before its request goes out (chat/ContextGenerator.ts; the provider
 * layer's connection, model and pricing, and its cache gate): they go ahead of whatever else is
 * queued, as browsing reads the history in pages. All are small but the assembly.
 */
const REPLY_READS: ReadonlySet<string> = new Set([
  "GetSlot",
  "AssembleContext",
  "ResolveConnection",
  "GetModel",
  "GetCostSettings",
  "CachePrefixWarm"
])

/** Startup preferences/import notices must not sit behind paged history reads. */
const SHORT_READS: ReadonlySet<string> = new Set([
  "GetSessionUser",
  "GetDisplayPrefs",
  "ListStImports",
  "ShellEpoch",
  "GetSplitChatsFast",
  "ThreadsOfFast"
])

/** One production policy, also exercised with held worker requests in the liveness tests. */
export const readerScheduling = (readers: number) => ({
  background: { tags: BACKGROUND_READS, max: Math.max(1, readers - 1) },
  first: REPLY_READS,
  short: SHORT_READS
})

/** The writer's and readers' entry points. */
const workerEntries = (options: DatabaseOptions) =>
  Effect.gen(function* () {
    if (options.workers === "source") {
      return {
        writer: new URL("./writer.ts", import.meta.url),
        reader: new URL("./reader.ts", import.meta.url),
        bundleDir: undefined
      }
    }
    const dir = options.bundleDir ?? (yield* WorkerBundleDir)
    return { writer: yield* bundleEntry(dir, "writer"), reader: yield* bundleEntry(dir, "reader"), bundleDir: dir }
  })

/**
 * Spawns worker threads. With bundles, every spawn checks the stamp again (about 3 ms),
 * so a crashed worker isn't replaced by code built after this server started.
 */
export const workerThreads = (
  entry: URL,
  workerData: Record<string, unknown>,
  bundleDir?: string,
  resourceLimits?: ResourceLimits,
  /** Told of each thread spawned, by worker id, e.g. to be able to stop it. */
  onThread?: (id: number, thread: Worker) => void
) =>
  NodeWorker.layer((id) => {
    if (bundleDir !== undefined && !stampMatches(bundleDir)) throw new WorkerBundleStale({ path: bundleDir })
    const thread = new Worker(entry, {
      workerData,
      name: entry.pathname.split("/").pop(),
      ...(resourceLimits ? { resourceLimits } : {})
    })
    onThread?.(id, thread)
    return thread
  })

/**
 * The writer's protocol over `threads`: Effect's worker pool with one worker, which
 * respawns it every second without logging. Stops are logged here: the first with its
 * cause, then failed restarts as a count (after 1, 2, 4, 8, … of them), then the recovery.
 */
export const writerProtocol = (threads: Layer.Layer<Workers.WorkerPlatform | Workers.Spawner>) => {
  const LoggedStops = Layer.effect(
    Workers.WorkerPlatform,
    Effect.map(Workers.WorkerPlatform, (platform) => {
      let stops = 0
      const stopped = (cause: Cause.Cause<unknown>) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        stops++
        const failedRestarts = stops - 1
        if (failedRestarts === 0) return Effect.logError("database writer stopped; restarting it every second", cause)
        return (failedRestarts & (failedRestarts - 1)) === 0
          ? Effect.logError(`database writer still down after ${failedRestarts} failed restarts`)
          : Effect.void
      }
      const started = Effect.suspend(() => {
        const failedRestarts = stops - 1
        stops = 0
        return failedRestarts < 0
          ? Effect.void
          : Effect.logInfo(`database writer is back after ${failedRestarts} failed restarts`)
      })
      return Workers.WorkerPlatform.of({
        spawn: <O, I>(id: number) =>
          Effect.map(platform.spawn<O, I>(id), (worker): Workers.Worker<O, I> => ({
            send: worker.send,
            run: (handler, options) =>
              worker
                .run(handler, { onSpawn: Effect.andThen(started, options?.onSpawn ?? Effect.void) })
                .pipe(Effect.tapCause(stopped))
          }))
      })
    })
  )
  return RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
    Layer.provide(LoggedStops.pipe(Layer.provideMerge(threads)))
  )
}

/**
 * Stores the user's stale fork summaries part by part (`ShellSummarizeStale`, about a second of
 * a background reader each), so a library with thousands of long branches is never one read
 * that holds a reader for minutes, and what each part computed survives a write to another
 * branch or a restart. Stops when no part is left or two in a row make no progress (writes
 * keep reaching those forks); the materialization then computes what remains itself. Each part,
 * computed and stored, holds the user's `gate`, so another reader's part starts only once this
 * one is stored and never computes the same forks again.
 */
const STALLED_PARTS = 2

export const storeStaleParts = <C, E1, E2>(
  gate: Semaphore.Semaphore,
  summarize: () => Effect.Effect<{ readonly chats: ReadonlyArray<C>; readonly remaining: number }, E1>,
  store: (chats: ReadonlyArray<C>) => Effect.Effect<unknown, E2>
) =>
  Effect.gen(function* () {
    let left = Infinity
    let stalled = 0
    while (true) {
      const part = yield* gate.withPermits(1)(
        Effect.gen(function* () {
          const part = yield* summarize()
          if (part.chats.length > 0) yield* store(part.chats)
          return part
        })
      )
      if (part.chats.length === 0 || part.remaining === 0) return
      // One write can cost a part (the first write to a chat no summary was stored for yet
      // stales all its forks), so only a second part in a row without progress stops.
      stalled = part.remaining < left ? 0 : stalled + 1
      if (stalled === STALLED_PARTS) return
      left = Math.min(left, part.remaining)
    }
  }).pipe(Effect.ignore)

export const layer = (options: DatabaseOptions) => {
  const dbPath = databaseFile(options.dataDir)

  // Runs before any connection opens, and holds the instance lock for the layer's lifetime.
  const Guards = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* prepareDataDirectory(options.dataDir)
      yield* checkFilesystem(options.dataDir, options.allowNetworkFs)
      yield* acquireInstanceLock(options.dataDir)
    })
  )

  const Workers = Layer.unwrap(
    Effect.gen(function* () {
      const entries = yield* workerEntries(options)
      const draftClock = yield* DraftClock
      const modules = yield* AssemblyModules
      const stateModules = yield* StateModules
      const providers = yield* ProviderDefinitions
      const WriterLive = Layer.effect(
        Writer,
        // The union comes from `OpsOf`, not inferred against the group (TS2589 past ~400 operations).
        Effect.map(RpcClient.make<OpsOf<typeof WriteOps>>(WriteOps), (calls) =>
          providerDefinitionClient(stateModuleClient(calls, stateModules), providers)
        )
      ).pipe(
        Layer.provide(
          writerProtocol(
            workerThreads(
              entries.writer,
              { dbPath, binLimits: options.binLimits ?? defaultBinLimits, draftClock },
              entries.bundleDir
            )
          )
        )
      )
      // Readers open read-only connections, so the file must exist and be migrated first.
      const ReaderLive = Layer.unwrap(
        Effect.gen(function* () {
          const writer = yield* Writer
          yield* writer.Ready()
          return Layer.effect(
            Reader,
            Effect.gen(function* () {
              const calls = yield* ReaderPool.client(ReadOps)
              const raw = providerDefinitionClient(
                stateModuleClient(moduleClient(calls, modules), stateModules),
                providers
              )
              // One part at a time per user, whichever read asked for it (storeStaleParts).
              const gates = new Map<string, Semaphore.Semaphore>()
              const gateOf = (userId: UserId) => {
                let gate = gates.get(userId)
                if (gate === undefined) gates.set(userId, (gate = Semaphore.makeUnsafe(1)))
                return gate
              }
              const store = (userId: UserId) => (chats: Parameters<typeof writer.StoreForkSummaries>[0]["chats"]) =>
                writer.StoreForkSummaries({ userId, chats })
              // What the materialization still computed itself is stored under the same gate
              // before anyone sees it, so a branch read waiting for the gate never computes it again.
              const shared = yield* makeShellMaterialization((userId: UserId) =>
                Effect.andThen(
                  storeStaleParts(gateOf(userId), () => raw.ShellSummarizeStale({ userId }), store(userId)),
                  gateOf(userId).withPermits(1)(
                    Effect.flatMap(raw.ShellMaterialize({ userId }), (snapshot) =>
                      snapshot.fresh.length === 0
                        ? Effect.succeed(snapshot)
                        : Effect.forEach(
                            // In parts of 250 chats, as the API stores them.
                            Array.from({ length: Math.ceil(snapshot.fresh.length / 250) }, (_, n) =>
                              snapshot.fresh.slice(n * 250, n * 250 + 250)
                            ),
                            store(userId),
                            { discard: true }
                          ).pipe(
                            Effect.as({ ...snapshot, fresh: [] }),
                            // Not stored: the API stores them as before.
                            Effect.orElseSucceed(() => snapshot)
                          )
                    )
                  )
                )
              )
              // A chat's branch reads first store its stale summaries, so what they compute is
              // kept for the next read and the shell instead of computed again by each of them.
              const storeChat = (userId: UserId, chatId: ChatId) =>
                storeStaleParts(gateOf(userId), () => raw.ShellSummarizeStale({ userId, chatId }), store(userId))
              return Reader.of({
                ...raw,
                ListForks: ((payload, options) =>
                  options !== undefined
                    ? raw.ListForks(payload, options)
                    : Effect.andThen(
                        storeChat(payload.userId, payload.chatId),
                        raw.ListForks<false>(payload)
                      )) as typeof raw.ListForks,
                GetSplitChats: ((payload, options) =>
                  options !== undefined
                    ? raw.GetSplitChats(payload, options)
                    : Effect.flatMap(raw.GetSplitChatsFast<false>(payload), (answer) =>
                        answer === null
                          ? Effect.andThen(storeChat(payload.userId, payload.chatId), raw.GetSplitChats<false>(payload))
                          : Effect.succeed(answer)
                      )) as typeof raw.GetSplitChats,
                ThreadsOf: ((payload, options) =>
                  options !== undefined
                    ? raw.ThreadsOf(payload, options)
                    : Effect.flatMap(raw.ThreadsOfFast<false>(payload), (answer) =>
                        answer === null
                          ? Effect.andThen(storeChat(payload.userId, payload.chatId), raw.ThreadsOf<false>(payload))
                          : Effect.succeed(answer)
                      )) as typeof raw.ThreadsOf,
                ShellMaterialize: ((payload, options) =>
                  options !== undefined
                    ? raw.ShellMaterialize(payload, options)
                    : Effect.flatMap(raw.ShellEpoch({ userId: payload.userId }), (epoch) =>
                        shared.get(payload.userId, `${epoch}:${JSON.stringify(stateModules.list())}`)
                      )) as typeof raw.ShellMaterialize
              })
            })
          ).pipe(
            // Reads are idempotent, so one whose reader crashed can run again.
            // Reads of what the user browses (the shell's lists, cache estimates) leave one reader
            // free whenever there are two, so a reply's reads never wait behind them.
            Layer.provide(
              ReaderPool.layer(options.readers, {
                retryCrashed: true,
                ...readerScheduling(options.readers)
              })
            ),
            Layer.provide(
              workerThreads(
                entries.reader,
                { dbPath, binLimits: options.binLimits ?? defaultBinLimits },
                entries.bundleDir
              )
            )
          )
        })
      )
      return ReaderLive.pipe(Layer.provideMerge(WriterLive))
    })
  )

  return Workers.pipe(
    Layer.provide(Guards),
    Layer.provideMerge(AssemblyModules.layer),
    Layer.provideMerge(StateModules.layer),
    Layer.provideMerge(ProviderDefinitions.layer)
  )
}
