// The RPC transport to the reader workers (ARCHITECTURE.md §3.1). It replaces Effect's
// worker pool (RpcClient.layerProtocolWorker), which frees a worker as soon as its caller
// is interrupted and keeps routing to a crashed worker until it respawns. node:sqlite can't
// stop a running query, so both sent reads to a busy or dead reader while another idled.
// Here a reader stays busy until it answers, and a crashed reader gets nothing until it's back.
import { Cause, Deferred, Effect, Exit, Layer, Option, Result, Schedule, Schema, type Stream } from "effect"
import { type Rpc, RpcClient, RpcClientError, type RpcGroup, RpcMessage, type RpcSerialization } from "effect/rpc"
import { Worker, WorkerError } from "effect/workers"

type Transferables = Parameters<RpcClient.Protocol["Service"]["send"]>[2]

interface Job {
  readonly clientId: number
  readonly request: RpcMessage.RequestEncoded
  readonly transferables: Transferables
  /** The request already stopped a reader once. */
  readonly crashed: boolean
  /** Its caller gave up while a reader ran it. */
  interrupted: boolean
}

type ReaderWorker = Worker.Worker<RpcMessage.FromServerEncoded, RpcMessage.FromClientEncoded>

interface Reader {
  readonly id: number
  /** A new one for each thread, since Effect's keeps a message it couldn't send for its next thread. */
  worker: ReaderWorker
  ready: boolean
  job: Job | undefined
  /** The running job's deadline, when the pool has one. */
  deadline: NodeJS.Timeout | undefined
  /** The worker was stopped for running past its deadline. */
  timedOut: boolean
}

/** A job that runs past `ms` is failed, and its worker stopped with `terminate` and respawned. */
interface JobDeadline {
  readonly ms: number
  readonly terminate: (readerId: number) => void
}

const RESPAWN_MS = 1000

// As in Effect's worker protocol: messages cross by structured clone.
const codecFor = Schema.toCodecJson as RpcSerialization.CodecFor
const encodeDefect = Schema.encodeSync(codecFor(Schema.Defect()))
const encodeClientError = Schema.encodeSync(codecFor(RpcClientError.RpcClientError))
const decodeClientError = Schema.decodeUnknownOption(codecFor(RpcClientError.RpcClientError))

const dieExit = (job: Job, defect: unknown) =>
  RpcMessage.ResponseExitDieEncoded({
    requestId: RpcMessage.RequestId(job.request.id),
    encodedDefect: encodeDefect(defect)
  })

/**
 * Fails one request with `error`. It crosses as a defect, which `client` turns back into
 * the typed error: an rpc's exit can only fail with the errors it declares, and a protocol
 * error would fail every request of the client.
 */
const failExit = (job: Job, error: RpcClientError.RpcClientError) => dieExit(job, encodeClientError(error))

const restoreClientError = (defect: unknown) =>
  Option.match(decodeClientError(defect), { onNone: () => Effect.die(defect), onSome: Effect.fail })

/**
 * `RpcClient.make` over a pool: a request the pool failed fails with its typed
 * `RpcClientError`. Streaming rpcs, whose calls return a Stream, don't type-check.
 */
export const client = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs> &
    ([Extract<Rpc.Success<Rpcs>, Stream.Stream<unknown, unknown, unknown>>] extends [never] ? unknown : never)
) =>
  Effect.map(RpcClient.make(group), (calls) => {
    type Call = (...args: Array<unknown>) => Effect.Effect<unknown, unknown>
    const typed: Record<string, Call> = {}
    for (const [tag, call] of Object.entries(calls as Record<string, Call>)) {
      typed[tag] = (...args) => Effect.catchDefect(call(...args), restoreClientError)
    }
    return typed as typeof calls
  })

const clientError = (cause: Cause.Cause<WorkerError.WorkerError>) => {
  const error = Cause.findError(cause)
  if (Result.isSuccess(error)) return new RpcClientError.RpcClientError({ reason: error.success.reason })
  // A defect, e.g. the spawn refused a stale bundle.
  const defect = Cause.squash(cause)
  const message = `reader worker failed: ${defect instanceof Error ? defect.message : String(defect)}`
  return new RpcClientError.RpcClientError({ reason: new RpcClientError.RpcClientDefect({ message, cause: defect }) })
}

/**
 * Fails to build if every reader dies before any is ready. Afterwards a crashed reader is
 * respawned every second. A crash touches only the request its reader had: with
 * `retryCrashed`, that request goes to the next free reader, once, unless its caller gave
 * up on it; otherwise it fails with an `RpcClientError` (through `client`). Queued
 * requests wait for a respawn, and fail when one fails while no reader is up. With
 * `jobDeadline`, a job that runs too long is failed the same way, its worker stopped and
 * respawned. Only idempotent requests without transferables can be retried: a request's
 * transferred buffers went to the worker that crashed.
 */
export const layer = (
  size: number,
  {
    name = "database reader",
    retryCrashed = false,
    jobDeadline,
    background
  }: {
    name?: string
    retryCrashed?: boolean
    jobDeadline?: JobDeadline
    /**
     * Requests (by tag) that may hold at most `max` readers at once: with `size - 1`, one
     * reader is always left for the rest, so what a reply waits on never queues behind them.
     * Others queued behind a held-back one go first.
     */
    background?: { readonly tags: ReadonlySet<string>; readonly max: number }
  } = {}
) =>
  Layer.effect(
    RpcClient.Protocol,
    RpcClient.Protocol.make(
      Effect.fnUntraced(function* (writeResponse) {
        const platform = yield* Worker.WorkerPlatform
        const readers: Array<Reader> = []
        const queue: Array<Job> = []
        const started = Deferred.makeUnsafe<void, RpcClientError.RpcClientError>()
        const diedBeforeStart = new Set<number>()

        // Uninterruptible, so a reader is never left reserved for a request it wasn't sent.
        const dispatch: Effect.Effect<void> = Effect.uninterruptible(
          Effect.gen(function* () {
            for (let i = 0; i < readers.length && queue.length > 0;) {
              const reader = readers[i]!
              if (!reader.ready || reader.job !== undefined) {
                i++
                continue
              }
              const held =
                background !== undefined &&
                readers.filter((r) => r.job !== undefined && background.tags.has(r.job.request.tag)).length >=
                  background.max
              const next = held ? queue.findIndex((job) => !background.tags.has(job.request.tag)) : 0
              if (next === -1) break
              const job = queue.splice(next, 1)[0]!
              // Reserved before sending, so a concurrent dispatch can't pick the same reader;
              // released again if the send fails.
              reader.job = job
              const sent = yield* Effect.exit(reader.worker.send(job.request, job.transferables))
              if (Exit.isFailure(sent)) {
                reader.job = undefined
                yield* writeResponse(job.clientId, dieExit(job, Cause.squash(sent.cause)))
              } else {
                if (jobDeadline) {
                  // Stopping the thread is a crash: onCrash fails the job and the pool respawns it.
                  reader.deadline = setTimeout(() => {
                    reader.timedOut = true
                    jobDeadline.terminate(reader.id)
                  }, jobDeadline.ms)
                }
                i++
              }
            }
          })
        )

        const finish = (reader: Reader, response: RpcMessage.ResponseExitEncoded) => {
          const job = reader.job!
          reader.job = undefined
          clearTimeout(reader.deadline)
          return Effect.andThen(writeResponse(job.clientId, response), dispatch)
        }

        const onResponse =
          (reader: Reader) =>
          (response: RpcMessage.FromServerEncoded): Effect.Effect<void, WorkerError.WorkerError> => {
            const job = reader.job
            // An answer to a request the reader isn't running is dropped: nobody waits on it.
            const stray = (what: string) =>
              Effect.logWarning(`${name} ${reader.id} sent ${what} for a request it isn't running; dropped`)
            switch (response._tag) {
              case "Chunk":
              case "Exit":
                if (job === undefined || response.requestId !== job.request.id) {
                  return stray(`an answer to request ${response.requestId}`)
                }
                return response._tag === "Chunk" ? writeResponse(job.clientId, response) : finish(reader, response)
              case "Defect":
                // The workers answer a handler's defect with its request's Exit
                // (disableFatalDefects), so this is the protocol failing: a crash of the reader.
                return Effect.fail(
                  new WorkerError.WorkerError({
                    reason: new WorkerError.WorkerReceiveError({
                      message: "the worker reported a protocol defect",
                      cause: response.defect
                    })
                  })
                )
            }
            return Effect.void
          }

        const onStart = (reader: Reader) =>
          Effect.suspend(() => {
            reader.ready = true
            Deferred.doneUnsafe(started, Exit.void)
            return dispatch
          })

        const onCrash = (reader: Reader) => (cause: Cause.Cause<WorkerError.WorkerError>) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void
          const wasReady = reader.ready
          reader.ready = false
          clearTimeout(reader.deadline)
          const timedOut = reader.timedOut
          reader.timedOut = false
          const error = timedOut
            ? new RpcClientError.RpcClientError({
                reason: new RpcClientError.RpcClientDefect({
                  message: `${name} ${reader.id} ran past its ${jobDeadline?.ms} ms deadline`,
                  cause: null
                })
              })
            : clientError(cause)
          const failed: Array<Job> = []
          const job = reader.job
          reader.job = undefined
          let outcome = ""
          if (job !== undefined && retryCrashed && !job.crashed && !job.interrupted) {
            // First in line, as it was sent before everything queued.
            queue.unshift({ ...job, crashed: true })
            outcome = `; retrying its ${job.request.tag} request`
          } else if (job !== undefined) {
            failed.push(job)
            if (job.crashed) outcome = `; its ${job.request.tag} request stopped a reader before, so it fails`
          }
          // A respawn that fails while no reader is up may never succeed, so queued requests
          // fail instead of waiting on it.
          if (!wasReady && !readers.some((other) => other.ready)) failed.push(...queue.splice(0))
          if (!wasReady && !Deferred.isDoneUnsafe(started)) {
            diedBeforeStart.add(reader.id)
            if (diedBeforeStart.size === size) Deferred.doneUnsafe(started, Exit.fail(error))
          }
          const why = timedOut ? `ran past its deadline and was stopped` : "stopped"
          return Effect.logError(
            `${name} ${reader.id} ${why}; restarting it in ${RESPAWN_MS} ms${outcome}`,
            cause
          ).pipe(
            Effect.andThen(
              Effect.forEach(failed, (job) => writeResponse(job.clientId, failExit(job, error)), { discard: true })
            ),
            Effect.andThen(dispatch)
          )
        }

        for (let id = 0; id < size; id++) {
          const reader: Reader = {
            id,
            worker: yield* platform.spawn<RpcMessage.FromServerEncoded, RpcMessage.FromClientEncoded>(id),
            ready: false,
            job: undefined,
            deadline: undefined,
            timedOut: false
          }
          readers.push(reader)
          yield* Effect.suspend(() => reader.worker.run(onResponse(reader), { onSpawn: onStart(reader) })).pipe(
            Effect.tapCause(onCrash(reader)),
            // A spawn that throws, e.g. refusing a stale bundle, is a defect, which retry skips.
            Effect.catchDefect(Effect.fail),
            Effect.tapError(() =>
              Effect.map(platform.spawn<RpcMessage.FromServerEncoded, RpcMessage.FromClientEncoded>(id), (worker) => {
                reader.worker = worker
              })
            ),
            Effect.retry(Schedule.spaced(RESPAWN_MS)),
            Effect.interruptible,
            Effect.forkScoped
          )
        }
        yield* Deferred.await(started)

        const running = (clientId: number, requestId: string | number) =>
          readers.find((reader) => reader.job?.clientId === clientId && reader.job.request.id === requestId)

        const send = (
          clientId: number,
          message: RpcMessage.FromClientEncoded,
          transferables?: Transferables
        ): Effect.Effect<void> => {
          switch (message._tag) {
            case "Request":
              queue.push({
                clientId,
                request: message,
                // A buffer listed twice, e.g. one file used twice in a document, fails the send.
                transferables: transferables && [...new Set(transferables)],
                crashed: false,
                interrupted: false
              })
              return dispatch
            case "Interrupt": {
              const queued = queue.findIndex((job) => job.clientId === clientId && job.request.id === message.requestId)
              if (queued !== -1) {
                queue.splice(queued, 1)
                return Effect.void
              }
              // The reader stops at its next statement at best, and stays busy until it answers.
              const reader = running(clientId, message.requestId)
              if (reader === undefined) return Effect.void
              reader.job!.interrupted = true
              return Effect.orDie(reader.worker.send(message))
            }
            case "Ack": {
              const reader = running(clientId, message.requestId)
              return reader ? Effect.orDie(reader.worker.send(message)) : Effect.void
            }
          }
          return Effect.void
        }

        return { send, supportsAck: true, supportsTransferables: true, codecFor }
      })
    )
  )
