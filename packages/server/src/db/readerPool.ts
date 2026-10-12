// The RPC transport to the reader workers (ARCHITECTURE.md §3.1). It replaces Effect's
// worker pool (RpcClient.layerProtocolWorker), which frees a worker as soon as its caller
// is interrupted and keeps routing to a crashed worker until it respawns. node:sqlite can't
// stop a running query, so both sent reads to a busy or dead reader while another idled.
// Here a reader stays busy until it answers, and a crashed reader gets nothing until it's back.
import { Cause, Deferred, Effect, Exit, Layer, Option, Result, Schedule, Schema } from "effect"
import { type Rpc, RpcClient, RpcClientError, type RpcGroup, RpcMessage, type RpcSerialization } from "effect/rpc"
import { Worker, type WorkerError } from "effect/workers"

type Transferables = Parameters<RpcClient.Protocol["Service"]["send"]>[2]

interface Job {
  readonly clientId: number
  readonly request: RpcMessage.RequestEncoded
  readonly transferables: Transferables
  /** The request already stopped a reader once. */
  readonly crashed: boolean
}

interface Reader {
  readonly id: number
  readonly worker: Worker.Worker<RpcMessage.FromServerEncoded, RpcMessage.FromClientEncoded>
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
 * `RpcClient.make` over a pool, for a group without streaming rpcs: a request the pool
 * failed fails with its typed `RpcClientError`.
 */
export const client = <Rpcs extends Rpc.Any>(group: RpcGroup.RpcGroup<Rpcs>) =>
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
 * `retryCrashed`, that request goes to the next free reader, once; without, or when it
 * stops a reader again, it fails with an `RpcClientError` (through `client`). Queued
 * requests wait for a respawn, and fail when one fails while no reader is up. With
 * `jobDeadline`, a job that runs too long is failed the same way, its worker stopped and
 * respawned. Only idempotent requests without transferables can be retried: a request's
 * transferred buffers went to the worker that crashed.
 */
export const layer = (
  size: number,
  {
    name = "database reader",
    retryCrashed = true,
    jobDeadline
  }: { name?: string; retryCrashed?: boolean; jobDeadline?: JobDeadline } = {}
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
              const job = queue.shift()!
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
          (response: RpcMessage.FromServerEncoded): Effect.Effect<void> => {
            const job = reader.job
            // Answers to a request the reader no longer runs, e.g. an interrupt that
            // arrived after the request finished, are dropped.
            if (job === undefined) return Effect.void
            switch (response._tag) {
              case "Chunk":
                return response.requestId === job.request.id ? writeResponse(job.clientId, response) : Effect.void
              case "Exit":
                return response.requestId === job.request.id ? finish(reader, response) : Effect.void
              case "Defect":
                // A reader runs one request at a time, so the defect is that request's alone.
                return finish(
                  reader,
                  RpcMessage.ResponseExitDieEncoded({
                    requestId: RpcMessage.RequestId(job.request.id),
                    encodedDefect: response.defect
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
          if (job !== undefined && retryCrashed && !job.crashed) {
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
          yield* reader.worker.run(onResponse(reader), { onSpawn: onStart(reader) }).pipe(
            Effect.tapCause(onCrash(reader)),
            // A spawn that throws, e.g. refusing a stale bundle, is a defect, which retry skips.
            Effect.catchDefect(Effect.fail),
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
              queue.push({ clientId, request: message, transferables, crashed: false })
              return dispatch
            case "Interrupt": {
              const queued = queue.findIndex((job) => job.clientId === clientId && job.request.id === message.requestId)
              if (queued !== -1) {
                queue.splice(queued, 1)
                return Effect.void
              }
              // The reader stops at its next statement at best, and stays busy until it answers.
              const reader = running(clientId, message.requestId)
              return reader ? Effect.orDie(reader.worker.send(message)) : Effect.void
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
