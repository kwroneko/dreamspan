// The RPC transport to the reader workers (ARCHITECTURE.md §3.1). It replaces Effect's
// worker pool (RpcClient.layerProtocolWorker), which frees a worker as soon as its caller
// is interrupted and keeps routing to a crashed worker until it respawns. node:sqlite can't
// stop a running query, so both sent reads to a busy or dead reader while another idled.
// Here a reader stays busy until it answers, and a crashed reader gets nothing until it's back.
import { Cause, Effect, Layer, Result, Schedule, Schema } from "effect"
import { RpcClient, RpcClientError, RpcMessage, type RpcSerialization } from "effect/rpc"
import { Worker, type WorkerError } from "effect/workers"

type Transferables = Parameters<RpcClient.Protocol["Service"]["send"]>[2]

interface Job {
  readonly clientId: number
  readonly request: RpcMessage.RequestEncoded
  readonly transferables: Transferables
}

interface Reader {
  readonly worker: Worker.Worker<RpcMessage.FromServerEncoded, RpcMessage.FromClientEncoded>
  ready: boolean
  job: Job | undefined
}

export const layer = (size: number) =>
  Layer.effect(
    RpcClient.Protocol,
    RpcClient.Protocol.make(
      Effect.fnUntraced(function* (writeResponse) {
        const platform = yield* Worker.WorkerPlatform
        const readers: Array<Reader> = []
        const queue: Array<Job> = []

        // Uninterruptible, so a reader is never marked busy with a request it wasn't sent.
        const dispatch = Effect.uninterruptible(
          Effect.suspend(() => {
            const sends: Array<Effect.Effect<void, unknown>> = []
            for (const reader of readers) {
              if (queue.length === 0) break
              if (!reader.ready || reader.job !== undefined) continue
              const job = queue.shift()!
              reader.job = job
              sends.push(reader.worker.send(job.request, job.transferables))
            }
            return Effect.orDie(Effect.all(sends, { discard: true }))
          })
        )

        const finish = (reader: Reader, response: RpcMessage.ResponseExitEncoded) => {
          const job = reader.job!
          reader.job = undefined
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

        const onCrash = (reader: Reader) => (cause: Cause.Cause<WorkerError.WorkerError>) => {
          reader.ready = false
          const job = reader.job
          reader.job = undefined
          if (job === undefined) return Effect.void
          const error = Cause.findError(cause)
          return writeResponse(job.clientId, {
            _tag: "ClientProtocolError",
            error: new RpcClientError.RpcClientError({
              reason: Result.isSuccess(error)
                ? error.success.reason
                : new RpcClientError.RpcClientDefect({ message: "reader worker failed", cause: Cause.squash(cause) })
            })
          })
        }

        for (let id = 0; id < size; id++) {
          const reader: Reader = {
            worker: yield* platform.spawn<RpcMessage.FromServerEncoded, RpcMessage.FromClientEncoded>(id),
            ready: false,
            job: undefined
          }
          readers.push(reader)
          yield* reader.worker
            .run(onResponse(reader), {
              onSpawn: Effect.suspend(() => {
                reader.ready = true
                return dispatch
              })
            })
            .pipe(
              Effect.tapCause(onCrash(reader)),
              Effect.retry(Schedule.spaced(1000)),
              Effect.interruptible,
              Effect.forkScoped
            )
        }

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
              const running = readers.find(
                (reader) => reader.job?.clientId === clientId && reader.job.request.id === message.requestId
              )
              return running ? Effect.orDie(running.worker.send(message)) : Effect.void
            }
            case "Ack": {
              const running = readers.find(
                (reader) => reader.job?.clientId === clientId && reader.job.request.id === message.requestId
              )
              return running ? Effect.orDie(running.worker.send(message)) : Effect.void
            }
          }
          return Effect.void
        }

        return {
          send,
          supportsAck: true,
          supportsTransferables: true,
          // As in Effect's worker protocol: messages cross by structured clone.
          codecFor: Schema.toCodecJson as RpcSerialization.CodecFor
        }
      })
    )
  )
