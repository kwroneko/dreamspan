// The RPC transport to the reader workers (ARCHITECTURE.md §3.1). It replaces Effect's
// worker pool (RpcClient.layerProtocolWorker), which frees a worker as soon as its caller
// is interrupted and keeps routing to a crashed worker until it respawns. node:sqlite can't
// stop a running query, so both sent reads to a busy or dead reader while another idled.
// Here a reader stays busy until it answers, and a crashed reader gets nothing until it's back.
import { Cause, Deferred, Effect, Exit, Layer, Result, Schedule, Schema } from "effect"
import { RpcClient, RpcClientError, RpcMessage, type RpcSerialization } from "effect/rpc"
import { Worker, type WorkerError } from "effect/workers"

type Transferables = Parameters<RpcClient.Protocol["Service"]["send"]>[2]

interface Job {
  readonly clientId: number
  readonly request: RpcMessage.RequestEncoded
  readonly transferables: Transferables
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

const dieExit = (job: Job, defect: unknown) =>
  RpcMessage.ResponseExitDieEncoded({
    requestId: RpcMessage.RequestId(job.request.id),
    encodedDefect: encodeDefect(defect)
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
 * respawned every second, and while no reader is up, queued reads fail instead of waiting.
 * With `isolateCrashes`, a crash fails only the request its worker had, and queued ones
 * wait for the respawn unless it fails too; the format workers use it, since one hostile
 * file mustn't fail another user's. With `jobDeadline` (format workers only), a job that
 * runs too long is failed the same way, its worker stopped and respawned.
 */
export const layer = (
  size: number,
  {
    name = "database reader",
    isolateCrashes = false,
    jobDeadline
  }: { name?: string; isolateCrashes?: boolean; jobDeadline?: JobDeadline } = {}
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
          if (reader.job !== undefined) failed.push(reader.job)
          reader.job = undefined
          // With no reader up, queued reads would wait on a respawn that may never succeed.
          // Isolated, they wait for the respawn, and fail only if it fails too.
          if (!readers.some((other) => other.ready) && (!isolateCrashes || !wasReady)) {
            failed.push(...queue.splice(0))
          }
          if (!wasReady && !Deferred.isDoneUnsafe(started)) {
            diedBeforeStart.add(reader.id)
            if (diedBeforeStart.size === size) Deferred.doneUnsafe(started, Exit.fail(error))
          }
          // A protocol error fails every request of its client; a defect, only its own.
          const fail = isolateCrashes
            ? Effect.forEach(failed, (job) => writeResponse(job.clientId, dieExit(job, error)), { discard: true })
            : Effect.forEach(
                new Set(failed.map((job) => job.clientId)),
                (clientId) => writeResponse(clientId, { _tag: "ClientProtocolError", error }),
                { discard: true }
              )
          const why = timedOut ? `ran past its deadline and was stopped` : "stopped"
          return Effect.logError(`${name} ${reader.id} ${why}; restarting it in ${RESPAWN_MS} ms`, cause).pipe(
            Effect.andThen(fail)
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
          yield* reader.worker
            .run(onResponse(reader), { onSpawn: onStart(reader) })
            .pipe(
              Effect.tapCause(onCrash(reader)),
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
              queue.push({ clientId, request: message, transferables })
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
